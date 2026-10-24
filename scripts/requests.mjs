#!/usr/bin/env node
/**
 * 玩家提交链路消费器（方案 §3.2 / 决策 #4、#5）。
 *
 * ## 流程
 *
 *   GET <WORKER_URL>/queue（X-Internal-Token）
 *     → 每条：URL → platform+slug（shared/quest-links 解析，slug 规范化小写）
 *     → groupId（research/pack-identity.json；不在任何组 → 平台:slug 自成一组）
 *     → 判版本（决策 #5：CF 比 fileId；MR 比 fileName 版本串；**解析不出一律重翻**）
 *         库里已有（research/source-versions.json 或 patches/<slug>/.source.json）
 *           与源站最新一致 → skipped-same-version（KV 回写「已在库」+ 当前版本）
 *         不一致 / 新包 → 待翻
 *     → 待翻的执行：
 *         node scripts/prepare-pack.mjs --ids <slug>
 *         node scripts/translate-local.mjs --slug <slug> --lanes 96 --redo-done
 *         node scripts/translate-fill.mjs --slug <slug> --lanes 96   （补漏译，失败只告警）
 *     → 回写 KV（POST /status）+ 追加 research/submissions.jsonl
 *
 * ## 护栏
 *
 * - 同实体 7 天冷却：research/requests-state.json 记录上次重翻时间，7 天内不自动重翻
 *   （--force 跳过）。新包（不在库）不受冷却限制。
 * - 不自动跑 publish：翻完只打印「收批请跑 npm run publish」。
 * - 环境缺 WORKER_URL / INTERNAL_STATUS_TOKEN 时直接退出（不造数据、不冒充成功）；
 *   缺翻译凭据（CF_KEY / LLM_* / FREE_TIER_*）时只打印将执行的命令，绝不伪造「已翻完」。
 * - 首次运行自动把 KV 现有记录导出为 research/submissions.jsonl（含历史英文状态映射）。
 *
 * 用法：
 *   npm run requests                # 正式跑
 *   npm run requests -- --dry-run   # 只打印判定结果（要翻/跳过/原因）
 *   npm run requests -- --only=<slug>
 *   npm run requests -- --force     # 跳过 7 天冷却
 *
 * 环境变量：
 *   WORKER_URL INTERNAL_STATUS_TOKEN  队列读取与状态回写（必填，缺失即退出）
 *   CF_KEY                            CF 包「查最新版本 / 下载」用；缺则 CF 包按需重翻处理
 *   LLM_BASE_URL LLM_API_KEY LLM_MODELS FREE_TIER_*   翻译凭据，缺则只打印命令不执行
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  parseCurseforgeModpackSlug,
  parseModrinthModpackSlug,
} from '../shared/quest-links.mjs'
import { STATUS, toStatusValue } from '../shared/quest-status.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IDENTITY_FILE = join(ROOT, 'research/pack-identity.json')
const VERSIONS_FILE = join(ROOT, 'research/source-versions.json')
const PATCHES_DIR = join(ROOT, 'patches')
const SUBMISSIONS_FILE = join(ROOT, 'research/submissions.jsonl')
const STATE_FILE = join(ROOT, 'research/requests-state.json')

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
const MR_API = 'https://api.modrinth.com/v2'
const CF_API = 'https://api.curseforge.com/v1'
const UA = 'quest-i18n-requests/0.1.0'
const CF_GAME_ID_MINECRAFT = 432

// ---------- 纯函数（单测覆盖） ----------

/**
 * 提交 URL → {platform, slug}（slug 规范化小写）。
 * platform 用内部短名 cf / mr（与 .source.json 一致）。
 * 解析不出返回 null（绝不抛）。
 * @param {string} url
 */
export function extractTarget(url) {
  const cf = parseCurseforgeModpackSlug(url)
  if (cf) return { platform: 'cf', slug: cf.toLowerCase() }
  const mr = parseModrinthModpackSlug(url)
  if (mr) return { platform: 'mr', slug: mr.toLowerCase() }
  return null
}

/** CF fileId 归一：数字或数字字符串 → Number，其余（含 undefined/null）→ null。 */
export function normalizeFileId(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** MR 版本串：取 fileName（去扩展名）做比对键；空/非字符串 → null（视为解析不出）。 */
export function mrVersionKey(fileName) {
  if (typeof fileName !== 'string') return null
  const trimmed = fileName.trim().replace(/\.mrpack$/i, '')
  return trimmed ? trimmed.toLowerCase() : null
}

/**
 * 判版本（决策 #5）：一致返回 true。
 * CF 比 fileId，MR 比 fileName 版本串；任一侧解析不出 → false（一律重翻）。
 * @param {string} platform 'cf' | 'mr'
 * @param {{fileId?: number, fileName?: string}|null} lib 库内记录
 * @param {{fileId?: number, fileName?: string}|null} latest 源站最新
 */
export function isSameVersion(platform, lib, latest) {
  if (platform === 'cf') {
    const a = normalizeFileId(lib?.fileId)
    const b = normalizeFileId(latest?.fileId)
    return a !== null && b !== null && a === b
  }
  if (platform === 'mr') {
    const a = mrVersionKey(lib?.fileName)
    const b = mrVersionKey(latest?.fileName)
    return a !== null && b !== null && a === b
  }
  return false
}

/**
 * 7 天冷却判定：上次重翻时间距今不足 7 天 → false。
 * lastIso 缺失/非法 → true（没翻过不冷却）。
 */
export function cooldownAllowed(lastIso, now = new Date(), cooldownMs = COOLDOWN_MS) {
  if (!lastIso) return true
  const last = new Date(lastIso).getTime()
  if (!Number.isFinite(last)) return true
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime()
  if (!Number.isFinite(nowMs)) return true
  return nowMs - last >= cooldownMs
}

/**
 * 历史英文状态 → 现行中文枚举。未知值原样返回（不猜）。
 */
export function mapLegacyStatus(s) {
  const map = {
    done: STATUS.DONE,
    failed: STATUS.FAILED,
    queued: STATUS.PENDING,
    translating: STATUS.TRANSLATING,
    'skipped-same-version': STATUS.SKIPPED_SAME_VERSION,
  }
  return map[s] ?? s
}

/**
 * 组装 submissions.jsonl 一行记录（字段名固定，见方案 §3.7）。
 */
export function buildRecord({ entry, platform, slug, groupId, versionAtSubmit, status, requestedAt, processedAt, note }) {
  return {
    id: entry?.id ?? null,
    url: entry?.url ?? null,
    platform: platform ?? null,
    slug: slug ?? null,
    groupId: groupId ?? null,
    versionAtSubmit: versionAtSubmit ?? null,
    status: status ?? null,
    requestedAt: requestedAt ?? entry?.submittedAt ?? null,
    processedAt: processedAt ?? null,
    note: note ?? '',
  }
}

/**
 * pack-identity.json → slug→groupId 映射（纯函数）。组的 id 即主 slug。
 */
export function identityMapFrom(identityDoc) {
  const map = {}
  for (const g of identityDoc?.groups ?? []) {
    for (const m of g.members ?? []) map[m.slug] = g.id
  }
  return map
}

// ---------- 网络（可注入，测试打桩） ----------

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** MR 匿名查最新版本：取首个（最新）version 的主文件名。失败返回 null（按需重翻处理）。 */
export async function fetchLatestMr(slug, { fetchJson: fj = fetchJson } = {}) {
  try {
    const list = await fj(`${MR_API}/project/${encodeURIComponent(slug)}/version`)
    const latest = Array.isArray(list) ? list[0] : null
    const file = latest?.files?.find((f) => f?.primary) ?? latest?.files?.[0]
    return file?.filename ?? null
  } catch {
    return null
  }
}

/** CF 查最新 mainFileId（需 CF_KEY）。无 key / 失败返回 null（按需重翻处理）。 */
export async function fetchLatestCf(slug, { apiKey = process.env.CF_KEY, fetchJson: fj = fetchJson } = {}) {
  if (!apiKey) return null
  try {
    const data = await fj(
      `${CF_API}/mods/search?gameId=${CF_GAME_ID_MINECRAFT}&slug=${encodeURIComponent(slug)}`,
      { 'x-api-key': apiKey },
    )
    const mod = Array.isArray(data?.data) ? data.data[0] : null
    return mod?.mainFileId ?? mod?.id ?? null
  } catch {
    return null
  }
}

// ---------- 主流程 ----------

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const FORCE = argv.includes('--force')
const ONLY = (() => {
  const i = argv.findIndex((a) => a.startsWith('--only='))
  return i >= 0 ? argv[i].slice('--only='.length).trim() : null
})()

function loadJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 库内版本：source-versions.json 优先，patches/<slug>/.source.json 兜底（两者等价）。 */
function libraryVersion(slug, versions) {
  if (versions[slug]) return versions[slug]
  const local = loadJson(join(PATCHES_DIR, slug, '.source.json'), null)
  return local && local.slug ? local : null
}

function appendSubmission(record) {
  appendFileSync(SUBMISSIONS_FILE, JSON.stringify(record) + '\n')
}

/** 首次运行：把队列现状整体导出为 submissions.jsonl（含历史英文状态映射）。 */
function exportExistingOnce(entries, identityMap, versions) {
  if (existsSync(SUBMISSIONS_FILE)) return false
  const now = new Date().toISOString()
  const lines = entries.map((e) => {
    const t = extractTarget(e.url) ?? (e.platform === 'modrinth' || e.platform === 'mr'
      ? { platform: 'mr', slug: String(e.id ?? '').toLowerCase() }
      : { platform: 'cf', slug: String(e.id ?? '').toLowerCase() })
    const lib = libraryVersion(t.slug, versions)
    return JSON.stringify(buildRecord({
      entry: e,
      platform: t.platform,
      slug: t.slug,
      groupId: identityMap[t.slug] ?? `${t.platform}:${t.slug}`,
      versionAtSubmit: lib?.fileName ?? null,
      status: mapLegacyStatus(e.status),
      requestedAt: e.submittedAt ?? null,
      processedAt: e.updatedAt ?? now,
      note: '历史记录首次导出',
    }))
  })
  writeFileSync(SUBMISSIONS_FILE, lines.length ? lines.join('\n') + '\n' : '')
  console.log(`已导出 ${lines.length} 条历史记录 → research/submissions.jsonl`)
  return true
}

async function main() {
  const WORKER_URL = process.env.WORKER_URL
  const TOKEN = process.env.INTERNAL_STATUS_TOKEN
  if (!WORKER_URL || !TOKEN) {
    console.error('✘ 缺少 WORKER_URL / INTERNAL_STATUS_TOKEN 环境变量：无法读取队列、无法回写。')
    console.error('  按约定本机不造数据、不冒充成功，请配置后重试（或用 --dry-run 前先配好）。')
    process.exit(1)
  }

  const identityMap = identityMapFrom(loadJson(IDENTITY_FILE, null))
  const versions = loadJson(VERSIONS_FILE, {})?.versions ?? {}
  const state = loadJson(STATE_FILE, {})

  // /queue 是公开端点，带上内部 token 纯属习惯（Worker 忽略多余头）。
  let entries
  try {
    const data = await fetchJson(`${WORKER_URL.replace(/\/+$/, '')}/queue`, { 'X-Internal-Token': TOKEN })
    entries = Array.isArray(data?.entries) ? data.entries : []
  } catch (err) {
    console.error(`✘ 读取队列失败：${err.message}`)
    process.exit(1)
  }
  console.log(`队列 ${entries.length} 条`)

  // 首次导出有写盘副作用：--dry-run 只判定不落盘，跳过。
  if (!DRY) exportExistingOnce(entries, identityMap, versions)

  const stateDirty = {}
  let ranTranslate = 0
  const now = () => new Date().toISOString()

  for (const entry of entries) {
    if (ONLY && entry.id !== ONLY) continue
    const t = extractTarget(entry.url)
      ?? (entry.platform === 'modrinth' ? { platform: 'mr', slug: String(entry.id).toLowerCase() }
        : entry.platform === 'curseforge' ? { platform: 'cf', slug: String(entry.id).toLowerCase() }
        : null)
    if (!t) {
      console.log(`- ${entry.id}: ✘ 链接解析不出平台/slug，人工处理（url=${entry.url}）`)
      // dry-run 必须零副作用：审核（phase3-review）发现这里漏了闸，解析失败的分支会写 jsonl
      if (!DRY) appendSubmission(buildRecord({ entry, status: mapLegacyStatus(entry.status), requestedAt: entry.submittedAt, processedAt: now(), note: 'URL 解析失败' }))
      continue
    }
    const { platform, slug } = t
    const groupId = identityMap[slug] ?? `${platform}:${slug}`
    const lib = libraryVersion(slug, versions)
    const versionAtSubmit = lib?.fileName ?? null

    // 判版本（决策 #5）
    let latest = null
    let latestErr = null
    if (lib) {
      latest = platform === 'mr'
        ? await fetchLatestMr(slug)
        : await fetchLatestCf(slug)
      if (latest === null) latestErr = '无法确认源站最新版本'
    }
    const same = lib ? isSameVersion(platform, lib, latest === null ? null : latest) : false
    const action = !lib ? 'translate' : same ? 'skip' : 'translate'
    const reason = !lib
      ? '新包（不在库）'
      : same
        ? `同版本：${lib.fileName}`
        : latestErr
          ? `${latestErr}，按决策 #5 一律视为需要重翻`
          : `版本已更新（库内 ${lib.fileName}）`

    if (action === 'skip') {
      console.log(`- ${slug}: 跳过（${reason}）`)
      const record = buildRecord({ entry, platform, slug, groupId, versionAtSubmit, status: STATUS.SKIPPED_SAME_VERSION, requestedAt: entry.submittedAt, processedAt: now(), note: reason })
      if (!DRY) {
        await postStatus(WORKER_URL, TOKEN, slug, { status: STATUS.SKIPPED_SAME_VERSION, note: `已在库，当前版本 ${lib.fileName}` })
        appendSubmission(record)
      }
      continue
    }

    // 待翻：7 天冷却只约束「重翻已有实体」，新包不受限。
    if (lib && !FORCE && !cooldownAllowed(state[groupId])) {
      console.log(`- ${slug}: 冷却中（groupId=${groupId} 7 天内已重翻过），跳过。需要强跑加 --force`)
      if (!DRY) appendSubmission(buildRecord({ entry, platform, slug, groupId, versionAtSubmit, status: mapLegacyStatus(entry.status), requestedAt: entry.submittedAt, processedAt: now(), note: '7 天冷却中，未自动重翻' }))
      continue
    }

    if (DRY) {
      console.log(`- ${slug}: 要翻（${reason}；groupId=${groupId}，platform=${platform}）`)
      continue
    }

    // 执行前凭据自检：缺什么就明说，绝不伪造成功。
    const missing = []
    if (platform === 'cf' && !process.env.CF_KEY) missing.push('CF_KEY')
    if (!process.env.LLM_API_KEY && process.env.FREE_TIER_ENABLED === undefined) missing.push('LLM_API_KEY 或 FREE_TIER_ENABLED')
    if (missing.length) {
      console.log(`- ${slug}: 待翻但缺凭据（${missing.join('、')}），本次不执行。将执行：`)
      printCommands(slug)
      appendSubmission(buildRecord({ entry, platform, slug, groupId, versionAtSubmit, status: mapLegacyStatus(entry.status), requestedAt: entry.submittedAt, processedAt: now(), note: `缺凭据未执行（${missing.join('、')}）` }))
      continue
    }

    console.log(`- ${slug}: 开始翻译（${reason}）`)
    const ok = runTranslate(slug)
    if (ok) {
      stateDirty[groupId] = now()
      ranTranslate++
      await postStatus(WORKER_URL, TOKEN, slug, { status: STATUS.DONE, note: 'requests 消费器翻译完成' })
    } else {
      await postStatus(WORKER_URL, TOKEN, slug, { status: STATUS.FAILED, error: 'requests 消费器翻译失败，详见本机日志' })
    }
    appendSubmission(buildRecord({
      entry, platform, slug, groupId, versionAtSubmit,
      status: ok ? STATUS.DONE : STATUS.FAILED,
      requestedAt: entry.submittedAt, processedAt: now(),
      note: ok ? 'translate-local 96 路 + translate-fill 补漏译' : '翻译失败',
    }))
  }

  if (Object.keys(stateDirty).length) {
    const merged = { ...state, ...stateDirty }
    writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2) + '\n')
  }

  if (ranTranslate > 0) {
    console.log(`\n翻完了 ${ranTranslate} 个。收批请跑 npm run publish（不自动发布）。`)
  } else if (!DRY) {
    console.log('\n本轮没有执行翻译。翻完包后收批请跑 npm run publish。')
  }
}

function printCommands(slug) {
  console.log(`    node scripts/prepare-pack.mjs --ids ${slug}`)
  console.log(`    node scripts/translate-local.mjs --slug ${slug} --lanes 96 --redo-done`)
  console.log(`    node scripts/translate-fill.mjs --slug ${slug} --lanes 96`)
}

/**
 * 顺序执行 prepare → translate-local → translate-fill。
 * translate-fill 只补漏译，失败不致命（打警告）；前两步失败判整体失败。
 */
function runTranslate(slug) {
  const base = { cwd: ROOT, stdio: 'inherit', env: { ...process.env, BATCH_PUSH_EVERY: '0' } }
  const steps = [
    ['node', ['scripts/prepare-pack.mjs', '--ids', slug]],
    ['node', ['scripts/translate-local.mjs', '--slug', slug, '--lanes', '96', '--redo-done']],
    ['node', ['scripts/translate-fill.mjs', '--slug', slug, '--lanes', '96']],
  ]
  for (const [i, [cmd, args]] of steps.entries()) {
    const fatal = i < 2
    const r = spawnSync(cmd, args, base)
    if (r.status !== 0) {
      const msg = `${cmd} ${args.join(' ')} 退出码 ${r.status ?? r.error?.code}`
      if (fatal) { console.error(`✘ ${msg}`); return false }
      console.warn(`⚠ ${msg}（translate-fill 只补漏译，失败不阻断）`)
    }
  }
  return true
}

async function postStatus(workerUrl, token, id, payload) {
  try {
    const res = await fetch(`${workerUrl.replace(/\/+$/, '')}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
      body: JSON.stringify({ id, ...payload }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`⚠ /status 回写失败 HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
  } catch (err) {
    console.warn(`⚠ /status 回写异常：${String(err?.message ?? err).slice(0, 120)}`)
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main().catch((err) => { console.error(err); process.exit(1) })
