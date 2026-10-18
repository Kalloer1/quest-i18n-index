/**
 * Cloudflare Worker：整合包任务书汉化提交入口 + 翻译队列。
 *
 * 职责（本工单只做前三个端点）：
 * 1. POST /        玩家提交整合包链接（CurseForge / Modrinth）→ 解析并校验 → 写 KV（权威）
 * 2. GET  /queue   返回全部队列条目（公开字段），供站点轮询
 * 3. POST /status  流水线回写单条状态（内部 token）→ 更新 KV
 * 4. POST /translate 维护者口令门禁 → 取「待翻译」（可选含「失败」）→ GitHub workflow_dispatch → 置「翻译中」
 * 5. POST /verify-passphrase 仅校验口令，供管理区门禁渲染模型多选
 * 6. GET  /models  代理网关 /models，返回实时模型 id 列表（公开；不含任何秘密）
 *
 * 状态权威源是 KV；腾讯文档类镜像由后续工单接入，任何失败都不阻断主流程。
 *
 * 差异点（相对光影站）：
 * - 提交的是整合包链接：CF 的 /minecraft/modpacks/<slug>、Modrinth 的 /modpack/<slug>。
 * - CurseForge 提交时**不**调 CF API 校验（避免给 Worker 加 CF key），只做路径解析，
 *   项目名交由流水线补全；Modrinth 提交时调 API 校验项目存在且 project_type 是 modpack。
 *
 * 环境变量（Worker Secrets / vars）：
 * - INTERNAL_STATUS_TOKEN   /status 内部 token（兼作 IP 限流哈希盐）
 * - GITHUB_REPO             "owner/repo"（wrangler.worker.toml [vars]）
 * - GITHUB_WORKFLOW_FILE    workflow 文件名（wrangler.worker.toml [vars]）
 * - SUBMIT_LIMIT_PER_DAY    每 IP 每天「新增提交」上限（wrangler.worker.toml [vars]，缺失回退 3）
 * - LLM_BASE_URL            网关地址（wrangler.worker.toml [vars]，后续触发工单使用）
 *
 * KV binding: TRANSLATION_QUEUE
 */
import { STATUS, STATUS_VALUES, SOURCE } from '../shared/quest-status.mjs'
import {
  parseCurseforgeModpackSlug,
  parseModrinthModpackSlug,
} from '../shared/quest-links.mjs'
import {
  DEFAULT_SUBMIT_LIMIT_PER_DAY,
  SUBMIT_LIMIT_TTL_SECONDS,
  parseSubmitLimit,
  submitLimit,
  shouldCountSubmit,
  submitDayKey,
  clientIp,
} from '../shared/submit-limit.mjs'
import { verifyPassphrase, parseModelsInput } from '../shared/gate.mjs'

const MODRINTH_API = 'https://api.modrinth.com/v2'
const UA = 'quest-i18n-index/0.1.0 (submit worker)'

// 网关地址是公开值（wrangler.worker.toml [vars]）；LLM_API_KEY 是 secret，只存在 Worker 里。
const DEFAULT_LLM_BASE_URL = 'https://api.888424.xyz/v1'

const INDEX_KEY = 'queue:index'
const QUEUE_PREFIX = 'queue:'
const MAX_INDEX = 500

// CORS 白名单：生产域 + Pages 生产域 + 本地开发 + Pages 预览域
// （预览域名形如 <hash>.quest-i18n-index.pages.dev）。
const ALLOWED_ORIGINS_EXACT = [
  'https://quest.mccnp.top',
  'https://quest-i18n-index.pages.dev',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]
const ALLOWED_ORIGIN_PATTERNS = [/^https:\/\/[a-z0-9-]+\.quest-i18n-index\.pages\.dev$/]

function isAllowedOrigin(origin) {
  if (!origin) return false
  if (ALLOWED_ORIGINS_EXACT.includes(origin)) return true
  return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin))
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Passphrase, X-Internal-Token',
    Vary: 'Origin',
  }
  if (isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  })
}

// ---------- KV 队列 ----------

async function readIndex(env) {
  const raw = await env.TRANSLATION_QUEUE.get(INDEX_KEY, 'json')
  return Array.isArray(raw) ? raw : []
}

async function writeIndex(env, ids) {
  await env.TRANSLATION_QUEUE.put(INDEX_KEY, JSON.stringify(ids.slice(0, MAX_INDEX)))
}

async function readEntry(env, id) {
  return env.TRANSLATION_QUEUE.get(QUEUE_PREFIX + id, 'json')
}

async function writeEntry(env, entry) {
  await env.TRANSLATION_QUEUE.put(QUEUE_PREFIX + entry.id, JSON.stringify(entry))
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------- Modrinth 解析 ----------

/**
 * 用 Modrinth API 解析 slug → 项目信息，并校验项目类型是 modpack。
 * 提交时即校验，非法链接当场 400，避免污染队列。
 * CurseForge 没有对应函数：提交时不调 CF API（见文件头差异点）。
 */
async function resolveModrinthProject(slug) {
  const res = await fetch(`${MODRINTH_API}/project/${encodeURIComponent(slug)}`, {
    headers: { 'User-Agent': UA },
  })
  if (res.status === 404) return { error: 'not_found' }
  if (!res.ok) return { error: 'upstream', status: res.status }
  const project = await res.json()
  if (project?.project_type && project.project_type !== 'modpack') {
    return { error: 'not_modpack', projectType: project.project_type }
  }
  return {
    project: {
      id: project.slug ?? slug,
      projectId: project.id,
      title: project.title ?? slug,
      pageUrl: `https://modrinth.com/modpack/${project.slug ?? slug}`,
    },
  }
}

// ---------- 路由处理 ----------

/** POST / —— 玩家提交翻译请求 */
async function handleSubmit(request, env, origin) {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return json({ error: '请求体不是合法 JSON' }, 400, origin)
  }

  const { url, contact, note } = body
  if (!url) {
    return json({ error: '整合包链接为必填' }, 400, origin)
  }

  // 先按 Modrinth 解析（提交时调 API 校验项目存在且是 modpack）；失败再试 CurseForge。
  // CF 侧不在提交时调 CF API 校验：那需要给 Worker 加 CF key（增加维护面），
  // 项目名与合法性交由 pipeline 的 CF 分支处理，这里只做路径解析。
  const modrinthSlug = parseModrinthModpackSlug(url)
  let target
  if (modrinthSlug) {
    const resolved = await resolveModrinthProject(modrinthSlug)
    if (resolved.error === 'not_found') {
      return json({ error: 'Modrinth 上找不到该项目，请检查链接' }, 400, origin)
    }
    if (resolved.error === 'not_modpack') {
      return json({ error: `该链接是 ${resolved.projectType}，不是整合包` }, 400, origin)
    }
    if (resolved.error === 'upstream') {
      return json({ error: 'Modrinth 暂时不可用，请稍后重试' }, 502, origin)
    }
    target = {
      id: resolved.project.id,
      projectId: resolved.project.projectId,
      name: resolved.project.title,
      url: resolved.project.pageUrl,
      platform: 'modrinth',
    }
  } else {
    const cfSlug = parseCurseforgeModpackSlug(url)
    if (!cfSlug) {
      return json({ error: '请填写有效的整合包链接（CurseForge 或 Modrinth）' }, 400, origin)
    }
    // id 与 name 都用 slug：name 留待 pipeline 从 CF 取回项目名后补全。
    target = { id: cfSlug, name: cfSlug, url, platform: 'curseforge' }
  }

  const now = new Date().toISOString()
  const existing = await readEntry(env, target.id)

  // 每 IP 每天「新增提交」限流：只统计新增（同一 id 已入队 → 重复提交不计数）。
  // 只存 IP 哈希（sha256(INTERNAL_STATUS_TOKEN + '|' + ip)），绝不存原始 IP；
  // 无 IP / 缺盐时降级为不限流。上限见 SUBMIT_LIMIT_PER_DAY，缺失/解析失败回退 3。
  let remainingToday = null
  let limitKey = null
  let usedToday = 0
  let limitPerDay = DEFAULT_SUBMIT_LIMIT_PER_DAY
  if (shouldCountSubmit(existing)) {
    const { ip } = clientIp(request)
    if (ip) {
      const salt = env.INTERNAL_STATUS_TOKEN
      if (!salt) {
        console.warn('::warning:: 缺少 INTERNAL_STATUS_TOKEN，本次提交跳过 IP 限流')
      } else {
        const hash = await sha256Hex(`${salt}|${ip}`)
        limitKey = submitDayKey(new Date(), hash)
        usedToday = Number((await env.TRANSLATION_QUEUE.get(limitKey)) || 0)
        limitPerDay = parseSubmitLimit(env.SUBMIT_LIMIT_PER_DAY)
        const decision = submitLimit(usedToday, limitPerDay)
        if (!decision.allowed) {
          return json({ error: `今日提交次数已达上限（${limitPerDay} 次/天），请明天再试` }, 429, origin)
        }
      }
    } else {
      console.warn('::warning:: 无法获取客户端 IP，本次提交不限流')
    }
  }

  // 去重：同一整合包已入队则只更新时间，不重复登记。
  const entry = existing
    ? { ...existing, updatedAt: now, name: target.name, url: target.url, platform: target.platform }
    : {
        id: target.id,
        ...(target.projectId ? { projectId: target.projectId } : {}),
        name: target.name,
        url: target.url,
        platform: target.platform,
        source: SOURCE.PLAYER,
        status: STATUS.PENDING,
        submittedAt: now,
        updatedAt: now,
        attempts: 0,
        error: '',
        contact: contact || '',
        note: note || '',
      }

  await writeEntry(env, entry)

  if (!existing) {
    const index = await readIndex(env)
    if (!index.includes(entry.id)) {
      index.unshift(entry.id)
      await writeIndex(env, index)
    }
  }

  // 新增提交成功写入后才计数（写库失败不会消耗当日额度）
  if (limitKey) {
    const nextUsed = usedToday + 1
    await env.TRANSLATION_QUEUE.put(limitKey, String(nextUsed), { expirationTtl: SUBMIT_LIMIT_TTL_SECONDS })
    remainingToday = Math.max(0, limitPerDay - nextUsed)
  }

  return json(
    {
      success: true,
      message: existing ? '该整合包已在翻译队列中，我们已更新你的请求。' : '提交成功！我们会尽快处理你的请求。',
      id: entry.id,
      status: entry.status,
      remainingToday,
    },
    200,
    origin,
  )
}

/**
 * 选取本次要触发的条目（纯函数，便于直接单测）。
 *
 * - 默认只取「待翻译」。**不**默认重跑「失败」条目：否则每次点「开始翻译」
 *   都会把历史失败项再烧一遍翻译额度，必须由调用方显式要求。
 * - retryFailed 为 true 时，额外取「失败」条目。
 * - 「翻译中」永不入选：可能真有 workflow 在跑，重复触发会并发烧预算。
 *
 * @param {Array<{ id: string, status: string }>} entries
 * @param {{ retryFailed?: boolean }} [options]
 * @returns {Array<{ id: string, status: string }>}
 */
export function selectTranslateTargets(entries, { retryFailed = false } = {}) {
  return entries.filter(
    (e) => e.status === STATUS.PENDING || (retryFailed && e.status === STATUS.FAILED),
  )
}

// ---------- 网关模型列表（实时拉取） ----------
// 模型列表来自网关（OpenAI 兼容 /models），不是写死的策展清单：
// 管理员会实时增删模型，写死列表必然过时。Worker 用 LLM_BASE_URL / LLM_API_KEY
// 代理该请求，浏览器端永远接触不到网关 key。

async function fetchGatewayModels(env) {
  const base = (env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL).replace(/\/+$/, '')
  const key = env.LLM_API_KEY
  if (!key) return { error: '缺少 LLM_API_KEY（服务配置错误）' }
  let res
  try {
    res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA },
    })
  } catch (err) {
    console.error('gateway /models fetch failed:', err?.message ?? err)
    return { error: '模型网关不可达' }
  }
  if (!res.ok) {
    return { error: `模型网关返回 ${res.status}` }
  }
  const data = await res.json().catch(() => null)
  const models = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : []
  return { models }
}

/** GET /models —— 公开返回网关当前模型 id 列表（不含任何秘密） */
async function handleModels(env, origin) {
  const { models, error } = await fetchGatewayModels(env)
  if (error) return json({ success: false, error }, 502, origin)
  return json({ success: true, models }, 200, origin)
}

/** POST /verify-passphrase —— 仅校验口令，供管理区门禁渲染模型多选 */
async function handleVerifyPassphrase(request, env, origin) {
  const verdict = verifyPassphrase(request.headers.get('X-Passphrase') || '', env.TRANSLATE_PASSPHRASE)
  if (verdict === 'missing-config') {
    return json({ error: '服务配置错误：缺少 TRANSLATE_PASSPHRASE' }, 500, origin)
  }
  if (verdict !== 'ok') return json({ error: '口令不正确' }, 401, origin)
  return json({ success: true }, 200, origin)
}

/**
 * POST /translate —— 口令门禁后触发 GitHub Actions workflow_dispatch。
 *
 * - 默认只取「待翻译」条目；body.retryFailed === true 时额外含「失败」条目。
 * - 「翻译中」永不入选；没有可触发条目时返回 { success, triggered: false }，不调 GitHub。
 * - body.models 必须命中网关实时列表（白名单），任意字符串不透传进 workflow；
 *   网关不可达时宁可 400 拒绝，也不能跳过校验。
 * - dispatch 成功后立即把条目置「翻译中」，避免重复点击重复触发。
 */
async function handleTranslate(request, env, origin) {
  const verdict = verifyPassphrase(request.headers.get('X-Passphrase') || '', env.TRANSLATE_PASSPHRASE)
  if (verdict === 'missing-config') {
    return json({ error: '服务配置错误：缺少 TRANSLATE_PASSPHRASE' }, 500, origin)
  }
  if (verdict !== 'ok') return json({ error: '口令不正确' }, 401, origin)

  const body = await request.json().catch(() => null)

  // 可选 models：管理区模型多选（口令门禁后才渲染）。必须命中网关实时列表。
  const candidate = parseModelsInput(body?.models)
  let modelsInput = ''
  if (candidate.length) {
    const { models: available, error } = await fetchGatewayModels(env)
    if (error) {
      return json({ error: `无法校验模型列表：${error}` }, 400, origin)
    }
    const invalid = candidate.filter((m) => !available.includes(m))
    if (invalid.length) {
      return json({ error: `以下模型不在网关列表中：${invalid.join(', ')}` }, 400, origin)
    }
    modelsInput = candidate.join(',')
  }

  // 必须是显式布尔 true —— 缺省不重跑失败项，避免每次点击都重复消耗翻译额度。
  const retryFailed = body?.retryFailed === true

  const index = await readIndex(env)
  const entries = (await Promise.all(index.map((id) => readEntry(env, id)))).filter(Boolean)
  const targets = selectTranslateTargets(entries, { retryFailed })

  if (!targets.length) {
    return json(
      {
        success: true,
        triggered: false,
        message: retryFailed ? '没有待翻译或失败的条目' : '没有待翻译的条目',
        ids: [],
      },
      200,
      origin,
    )
  }

  const ids = targets.map((e) => e.id)

  if (!env.GITHUB_PAT) {
    return json({ error: '服务配置错误：缺少 GITHUB_PAT' }, 500, origin)
  }
  if (!env.GITHUB_REPO || !env.GITHUB_WORKFLOW_FILE) {
    return json({ error: '服务配置错误：缺少 GITHUB_REPO / GITHUB_WORKFLOW_FILE' }, 500, origin)
  }

  const inputs = { ids: ids.join(',') }
  if (modelsInput) inputs.models = modelsInput

  const dispatch = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': UA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs }),
    },
  )

  if (!dispatch.ok) {
    const detail = (await dispatch.text()).slice(0, 300)
    console.error('workflow_dispatch failed:', dispatch.status, detail)
    return json({ error: '触发翻译失败，请稍后重试', detail }, 502, origin)
  }

  // dispatch 已成功，立即置「翻译中」，避免重复点击导致重复触发
  const now = new Date().toISOString()
  await Promise.all(
    targets.map((e) => writeEntry(env, { ...e, status: STATUS.TRANSLATING, updatedAt: now, error: '' })),
  )

  return json({ success: true, triggered: true, ids, count: ids.length }, 200, origin)
}

/** GET /queue —— 队列全量（供站点轮询）；公开字段，绝不泄露 contact 明文 */
async function handleQueue(env, origin) {
  const index = await readIndex(env)
  const entries = await Promise.all(index.map((id) => readEntry(env, id)))
  const list = entries.filter(Boolean)
  const PUBLIC = ({ contact: _dropped, ...rest }) => rest
  return json({ success: true, count: list.length, entries: list.map(PUBLIC) }, 200, origin)
}

/** POST /status —— 流水线回写单条状态（内部 token） */
async function handleStatus(request, env, origin) {
  const token = request.headers.get('X-Internal-Token') || ''
  if (!env.INTERNAL_STATUS_TOKEN) {
    return json({ error: '服务配置错误：缺少 INTERNAL_STATUS_TOKEN' }, 500, origin)
  }
  if (token !== env.INTERNAL_STATUS_TOKEN) {
    return json({ error: '未授权' }, 401, origin)
  }

  const body = await request.json().catch(() => null)
  if (!body || !body.id || !body.status) {
    return json({ error: 'id 与 status 为必填' }, 400, origin)
  }

  if (!STATUS_VALUES.includes(body.status)) {
    return json({ error: `status 必须是 ${STATUS_VALUES.join(' / ')} 之一` }, 400, origin)
  }

  const existing = await readEntry(env, body.id)
  if (!existing) {
    return json({ error: `队列中没有 ${body.id}` }, 404, origin)
  }

  const entry = {
    ...existing,
    status: body.status,
    updatedAt: new Date().toISOString(),
    attempts: Number.isFinite(body.attempts) ? body.attempts : existing.attempts,
    error: typeof body.error === 'string' ? body.error.slice(0, 500) : existing.error,
    note: typeof body.note === 'string' ? body.note.slice(0, 500) : existing.note,
    // CurseForge 提交时 name 暂用 slug（提交不调 CF API）；流水线取回真实项目名后经此回写补全。
    name: typeof body.name === 'string' && body.name ? body.name.slice(0, 200) : existing.name,
  }

  await writeEntry(env, entry)

  return json({ success: true, id: entry.id, status: entry.status }, 200, origin)
}

// ---------- 入口 ----------

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ''

    // 非白名单 origin 一律拒绝（含预检）。无 Origin 的请求（curl / 服务端）放行。
    if (origin && !isAllowedOrigin(origin)) {
      return new Response(JSON.stringify({ error: 'Origin 不在白名单' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin' },
      })
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    if (!env.TRANSLATION_QUEUE) {
      return json({ error: '服务配置错误：缺少 TRANSLATION_QUEUE KV 绑定' }, 500, origin)
    }

    const { pathname } = new URL(request.url)

    try {
      if (pathname === '/' || pathname === '') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin)
        return await handleSubmit(request, env, origin)
      }

      if (pathname === '/queue') {
        if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, origin)
        return await handleQueue(env, origin)
      }

      if (pathname === '/status') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin)
        return await handleStatus(request, env, origin)
      }

      if (pathname === '/models') {
        if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, origin)
        return await handleModels(env, origin)
      }

      if (pathname === '/verify-passphrase') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin)
        return await handleVerifyPassphrase(request, env, origin)
      }

      if (pathname === '/translate') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin)
        return await handleTranslate(request, env, origin)
      }

      return json({ error: 'Not found' }, 404, origin)
    } catch (err) {
      console.error('Worker error:', err)
      return json({ error: '服务器内部错误' }, 500, origin)
    }
  },
}
