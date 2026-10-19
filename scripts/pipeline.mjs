#!/usr/bin/env node
/**
 * 翻译流水线（工单 02）：筛候选 → 站点术语记忆精确命中 → LLM 分块翻译 → 回退率闸门 → 产出写出。
 *
 * - `--ids a,b` 与 `--top N` 互斥；同时给出直接报错退出（exit 2）。
 * - 分块默认 30 行/块（CHUNK_LINES，可用 --chunk-lines 覆盖）。
 *   实测免费层阈值（2026-10-19，连续调用）：5 条 1.1s / 15 条 2.7s / 30 条 7.9s 全过，
 *   **60 条 30.6s 必然 HTTP 504**。旧值 60 正好踩在超时线上，是「CI 上免费层 504」的真因之一。
 * - 单块回退率 > 10% 时整块重试，最多 3 次；整体回退率 > 30% 判失败，不写文件、不回写成功。
 * - 每条整合包独立超时（默认 5 分钟，--timeout-ms 可配）：超时只让该条失败，其余继续。
 * - 失败原因回写队列状态：配置 WORKER_URL + INTERNAL_STATUS_TOKEN 时调 `POST /status`
 *   （带 `X-Internal-Token` 头）；未配置时只打日志，不影响主流程。
 * - LLM 可注入：核心流程 `runPipeline()` 的 `translate` 参数是
 *   `async (texts: string[]) => string[]`，测试用桩替换，不联网。
 * - 产出文件头部标注「AI 初翻，未人工校对」；英文↔中文对照合并式回写 glossary.json（不抹历史条目）。
 *
 * CLI 数据来源（离线）：
 *   - 记录：research/index-dataset.json 的 `packs`（build-index.mjs 产出）
 *   - 整合包内文件：research/packs/<slug>/ 下的 .snbt（调用方事先解包）
 *   - 产出：patches/<slug>/ 下，路径与整合包内路径一致（pack-patch.mjs 直接打包该目录）
 *
 * 用法：
 *   node scripts/pipeline.mjs --ids a,b
 *   node scripts/pipeline.mjs --top 5
 *   node scripts/pipeline.mjs --ids a --dry-run   不写文件，只打印结果
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { screenCandidates, skipReason, SKIP, SKIP_LABEL, LAYOUT } from './lib/candidates.mjs'
import { extractPack, buildOutputs, sourceFileNames } from './lib/quest-files.mjs'
import {
  stripSkeleton, isUsableMemory, shouldRememberMemory, mergeGlossary, isSourceEcho,
} from './lib/glossary.mjs'
import { mergeByQuestId } from './snbt.mjs'
import { shieldColorCodes, unshieldColorCodes } from './lib/format-codes.mjs'
import { toStatusValue } from '../shared/quest-status.mjs'
import { defaultReportStatus } from './lib/report-status.mjs'
import {
  freeTierEnabled, callFreeTier, freeTierModel, FREE_TIER_FAILURE_THRESHOLD, FREE_TIER_MIN_INTERVAL_MS,
} from './lib/free-tier.mjs'

export { defaultReportStatus } from './lib/report-status.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATASET_FILE = join(ROOT, 'research/index-dataset.json')
const PACKS_DIR = join(ROOT, 'research/packs')
const PATCHES_DIR = join(ROOT, 'patches')
const GLOSSARY_FILE = join(ROOT, 'glossary.json')

export const CHUNK_LINES = 30
export const CHUNK_RETRY_THRESHOLD = 0.1
export const CHUNK_MAX_RETRIES = 3
export const OVERALL_FALLBACK_THRESHOLD = 0.3
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
export const HEADER_LINE = '# AI 初翻，未人工校对'

/**
 * 从数据集 JSON 里取整合包记录。
 * 数据集字段是 `dataset`（build-index.mjs 产出）；兼容旧的 `packs` 写法。
 * 单独导出便于测试守护这个键名——曾因只读 `packs` 导致 CLI 全量空跑（--ids/--top 都找不到记录）。
 */
/**
 * 解析模型列表：`LLM_MODELS`（逗号分隔，管理区多选）优先，回退到单数 `LLM_MODEL`。
 * 去空、去重、保持顺序。
 *
 * **都没有时返回空数组，不兜底任何默认模型**（2026-10-19 用户决定）：
 * 管理区「不选模型」是合法选择，含义是「只走免费层」。
 * 旧行为兜底 `gpt-4o-mini`，而该模型在中转站上并不存在（实测 503 `model_not_found`），
 * 免费层一熔断就会去试一个死模型，白等几个 503 再判整包失败。
 *
 * 为何要导出：管理区多选曾完全不生效——workflow 传 `LLM_MODELS`，脚本只读 `LLM_MODEL`。
 * 这个函数是那个契约的唯一定义处，测试直接守它。
 * @param {string|undefined} modelsCsv
 * @param {string|undefined} single
 * @param {string} [fallback] 显式兜底；缺省为空（不兜底）
 * @returns {string[]} 可能为空数组
 */
export function parseModels(modelsCsv, single, fallback = '') {
  const raw = String(modelsCsv ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const list = raw.length ? raw : [String(single ?? '').trim()].filter(Boolean)
  const out = []
  for (const m of list) if (!out.includes(m)) out.push(m)
  if (out.length) return out
  const fb = String(fallback ?? '').trim()
  return fb ? [fb] : []
}

/**
 * 归一化网关地址：允许只给到 `/v1`（或任意前缀），自动补 `/chat/completions`。
 *
 * 为什么必须有：`LLM_BASE_URL` 这个名字在本仓库**有两个含义**——
 * `worker/index.js` 当它是**基址**（自己补 `/models`），`pipeline.mjs` 当它是**完整端点**。
 * 2026-10-19 实跑时按 Worker 的口径把 GitHub secret 设成了 `https://api.888424.xyz/v1`，
 * 流水线于是 POST 到 `/v1` 拿到 404（`Invalid URL (POST /v1)`）。
 * 与 `free-tier.mjs` 的 `freeTierUrl()` 同口径，两种写法都吃。
 * @param {string|undefined} raw
 * @returns {string}
 */
export function normalizeGatewayUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return 'https://api.openai.com/v1/chat/completions'
  return /\/chat\/completions$/.test(s) ? s : `${s.replace(/\/+$/, '')}/chat/completions`
}

/**
 * 调一次 OpenAI 兼容 chat/completions。失败抛错，由调用方决定换下一个模型。
 * @param {string} url
 * @param {string} key
 * @param {string} model
 * @param {string[]} texts
 * @returns {Promise<string[]>}
 */
async function callOnce(url, key, model, texts) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是 Minecraft 整合包任务书翻译。逐条翻译为简体中文，保留色码（&7 等）与占位符，返回 JSON 数组，顺序与输入一致。' },
        { role: 'user', content: JSON.stringify(texts) },
      ],
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`)
  const parsed = JSON.parse((await res.json()).choices[0].message.content)
  const arr = Array.isArray(parsed) ? parsed : (parsed.translations ?? parsed.result)
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('LLM 返回条数不符')
  return arr.map((s) => String(s))
}

export function readRecords(dataset) {
  return dataset?.dataset ?? dataset?.packs ?? []
}

// ---------- 分块翻译（纯逻辑，注入 translate） ----------

/**
 * 翻译一批待译单元：
 *   1. 按英文骨架查 glossary，全命中时一次 LLM 都不调；
 *   2. 未命中的按 chunkLines 分块，逐块调 LLM；
 *   3. 单块回退率（译文 === 原文）> CHUNK_RETRY_THRESHOLD 时整块重试，最多 CHUNK_MAX_RETRIES 次；
 *   4. 整体回退率 > OVERALL_FALLBACK_THRESHOLD 抛错（调用方判失败，不写文件）。
 *
 * @param {Array<{key: string, text: string}>} units
 * @param {(texts: string[], signal?: AbortSignal) => Promise<string[]>} translate 可注入的 LLM
 * @param {{glossary?: Record<string,string>, chunkLines?: number, signal?: AbortSignal}} options
 * @returns {Promise<{map: Map<string,string>, fallback: number, llmCalls: number, glossaryHits: number, additions: Record<string,string>}>}
 */
export async function translateUnits(units, translate, { glossary = {}, chunkLines = CHUNK_LINES, signal } = {}) {
  const map = new Map()
  const additions = {}
  let llmCalls = 0
  let glossaryHits = 0

  const unmatched = []
  for (const u of units) {
    const skeleton = stripSkeleton(u.text)
    const hit = skeleton ? glossary[skeleton] : undefined
    if (isUsableMemory(hit, u.text)) {
      map.set(u.key, hit)
      glossaryHits++
    } else {
      unmatched.push(u)
    }
  }

  if (unmatched.length === 0) {
    return { map, fallback: 0, llmCalls: 0, glossaryHits, additions }
  }

  let fallback = 0
  const chunks = []
  for (let i = 0; i < unmatched.length; i += chunkLines) chunks.push(unmatched.slice(i, i + chunkLines))

  for (const chunk of chunks) {
    if (signal?.aborted) throw new Error('处理超时')
    let attempt = 0
    let texts = []
    for (;;) {
      attempt++
      texts = await translate(chunk.map((u) => u.text), signal)
      llmCalls++
      const echoes = chunk.filter((u, i) => isSourceEcho(texts[i], u.text)).length
      if (echoes / chunk.length <= CHUNK_RETRY_THRESHOLD) break
      if (attempt >= CHUNK_MAX_RETRIES) break
    }
    chunk.forEach((u, i) => {
      const zh = texts[i]
      map.set(u.key, zh)
      if (isSourceEcho(zh, u.text)) fallback++
      else {
        // 写入端守卫：回显不进记忆；已存在的骨架不覆盖（历史优先，合并式回写在 mergeGlossary）。
        const skeleton = stripSkeleton(u.text)
        if (shouldRememberMemory(skeleton, zh, u.text, glossary[skeleton])) additions[skeleton] = zh
      }
    })
  }

  if (fallback > units.length * OVERALL_FALLBACK_THRESHOLD) {
    throw new Error(`翻译回退率过高（${fallback}/${units.length}）`)
  }
  return { map, fallback, llmCalls, glossaryHits, additions }
}

// ---------- 单条整合包处理 ----------

/**
 * 处理单条整合包记录：筛候选 → 抽取 → 翻译 → 产出。
 * @param {object} record 候选记录（slug/layout/...）
 * @param {{files: Array<{name: string, text: string}>}} pack 整合包内文件
 * @param {{translate: Function, glossary?: Record<string,string>, chunkLines?: number, signal?: AbortSignal,
 *   mergeFiles?: Array<{name: string, text: string}>|null}} options
 *   mergeFiles：上游最新章节文件（同路径）。内嵌布局提供时启用「按 quest ID 合并」产出
 *   （工单 03 可选增强）：只改写译文、保留上游新增任务；上游已删除的章节不再产出。
 * @returns {Promise<{status: 'done'|'skipped'|'failed', error?: string, note?: string, outputs?: Array<{name: string, text: string}>, additions?: Record<string,string>}>}
 */
export async function processPack(record, pack, { translate, glossary = {}, chunkLines, signal, mergeFiles = null } = {}) {
  const reason = skipReason(record)
  if (reason) {
    return { status: 'skipped', error: reason, note: SKIP_LABEL[reason] ?? reason }
  }
  const sourceNames = sourceFileNames(pack.files.map((f) => f.name), record.layout)
  if (sourceNames.length === 0) {
    return { status: 'failed', error: SKIP.NO_EN_SOURCE }
  }
  const files = pack.files.filter((f) => sourceNames.includes(f.name))
  const extracted = extractPack({ files, layout: record.layout })
  const { map, additions } = await translateUnits(extracted.units, translate, { glossary, chunkLines, signal })
  const outputs = buildOutputs(extracted, map, { header: `${HEADER_LINE}\n` })
  if (record.layout === LAYOUT.EMBEDDED && mergeFiles) {
    const upstream = new Map(mergeFiles.map((f) => [f.name, f.text]))
    const merged = []
    const notes = []
    for (const out of outputs) {
      const upstreamText = upstream.get(out.name)
      if (upstreamText === undefined) {
        // 上游已删除该章节：旧译文不再产出，避免把已移除的内容覆盖回去。
        notes.push(`上游已删除 ${out.name}，跳过产出`)
        continue
      }
      merged.push({ name: out.name, text: mergeByQuestId(upstreamText, out.text) })
    }
    return { status: 'done', outputs: merged, additions, ...(notes.length ? { note: notes.join('; ') } : {}) }
  }
  return { status: 'done', outputs, additions }
}

// ---------- 批处理（含独立超时与状态回写） ----------

/**
 * 跑一批整合包。每条独立超时：超时/抛错只让该条失败，其余继续。
 *
 * @param {{
 *   records: object[],
 *   loadPack: (slug: string) => Promise<{files: Array<{name: string, text: string}>}> | {files: Array<{name: string, text: string}>},
 *   loadMergePack?: (slug: string) => Array<{name: string, text: string}> | null | Promise<...>,
 *   translate: (texts: string[], signal?: AbortSignal) => Promise<string[]>,
 *   glossary?: Record<string,string>,
 *   chunkLines?: number,
 *   timeoutMs?: number,
 *   writeOutput?: (slug: string, name: string, text: string) => void,
 *   reportStatus?: (id: string, payload: object) => Promise<void>,
 * }} options
 */
export async function runPipeline(options) {
  const {
    records, loadPack, translate, glossary = {}, chunkLines = CHUNK_LINES,
    timeoutMs = DEFAULT_TIMEOUT_MS, writeOutput = () => {}, reportStatus = defaultReportStatus,
    loadMergePack = null,
  } = options
  const { candidates, skipped } = screenCandidates(records)
  const results = []

  for (const row of skipped) {
    const result = { slug: row.slug, status: 'skipped', error: row.reason, note: SKIP_LABEL[row.reason] ?? row.reason }
    results.push(result)
    await reportStatus(row.slug, { status: toStatusValue('skipped'), error: row.reason, note: result.note })
  }

  for (const record of candidates) {
    const slug = record.slug
    let result
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`处理超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs)
    try {
      const pack = await loadPack(slug)
      const mergeFiles = loadMergePack ? await loadMergePack(slug) : null
      result = await withTimeout(
        processPack(record, pack, { translate, glossary, chunkLines, signal: controller.signal, mergeFiles }),
        timeoutMs,
        controller,
      )
    } catch (err) {
      const message = String(err?.message ?? err?.reason ?? err).slice(0, 200)
      console.log(`[${slug}] 失败: ${message}`)
      result = { slug, status: 'failed', error: message }
      await reportStatus(slug, { status: toStatusValue('failed'), error: message })
      results.push(result)
      continue
    } finally {
      clearTimeout(timer)
    }
    result = { slug, ...result }
    if (result.status === 'done') {
      for (const out of result.outputs) writeOutput(slug, out.name, out.text)
    }
    const payload = result.status === 'done'
      ? { status: toStatusValue('done'), error: '', ...(record.title ? { name: record.title } : {}) }
      : { status: toStatusValue(result.status), error: result.error, note: result.note }
    await reportStatus(slug, payload)
    results.push(result)
  }
  return results
}

/** 独立超时：到时 reject，只影响该条（同时用 controller.abort 通知进行中的 translate）。 */
function withTimeout(promise, ms, controller) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort(new Error(`处理超时（${Math.round(ms / 1000)}s）`))
      reject(new Error(`处理超时（${Math.round(ms / 1000)}s）`))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ---------- CLI ----------

/** 解析 CLI 参数：--ids 与 --top 互斥。 */
export function parseArgs(argv) {
  const args = { ids: null, top: null, chunkLines: CHUNK_LINES, timeoutMs: DEFAULT_TIMEOUT_MS, dryRun: false, mergeDir: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--ids') args.ids = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--top') args.top = Number(argv[++i])
    else if (a === '--chunk-lines') args.chunkLines = Number(argv[++i])
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i])
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--merge-dir') args.mergeDir = argv[++i]
    else throw new Error(`未知参数：${a}`)
  }
  if (args.ids && args.top != null) throw new Error('--ids 与 --top 互斥，只能给一个')
  if (!args.ids && args.top == null) throw new Error('必须给 --ids a,b 或 --top N')
  return args
}

/** 递归列目录下的 .snbt 文件（相对路径，/ 分隔）。 */
function listSnbt(dir, base = dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listSnbt(full, base))
    else if (/\.snbt$/i.test(name)) out.push(relative(base, full).replace(/\\/g, '/'))
  }
  return out
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`✘ ${err.message}`)
    console.error('用法: node scripts/pipeline.mjs --ids <slug,slug> | --top N [--chunk-lines 60] [--timeout-ms 300000] [--merge-dir <上游最新章节根目录>] [--dry-run]')
    process.exit(2)
  }

  if (!existsSync(DATASET_FILE)) {
    console.error(`✘ 找不到 ${DATASET_FILE}，先跑 npm run build:data 生成整合包记录`)
    process.exit(1)
  }
  const dataset = JSON.parse(readFileSync(DATASET_FILE, 'utf8'))
  const records = readRecords(dataset)
  const bySlug = new Map(records.map((r) => [r.slug, r]))

  let worklist
  if (args.ids) {
    worklist = args.ids.map((id) => bySlug.get(id)).filter(Boolean)
    const missing = args.ids.filter((id) => !bySlug.has(id))
    for (const id of missing) console.log(`[${id}] 记录不存在，跳过`)
  } else {
    worklist = screenCandidates(records).candidates.slice(0, args.top)
  }
  console.log(`本次处理 ${worklist.length} 条\n`)

  let glossary = {}
  try { glossary = JSON.parse(readFileSync(GLOSSARY_FILE, 'utf8')) } catch { /* 从头构建 */ }

  // 翻译提供方分两层（ADR-0007 已决：免费层优先，失败落自建网关模型池）。
  //
  // 第一层 · 免费层：bilibili Index-Translate 公开 API，**无需 API key**。
  //   行式协议（合成键 L1..Ln），漏行按行回退不判整块失败；
  //   连续 FREE_TIER_FAILURE_THRESHOLD 次失败才熔断本轮，之后直走网关，不再浪费超时。
  //
  // **调用节奏是硬约束（实测 2026-10-19）**：
  //   免费层不看分块大小，看**调用间隔**。30 条 + 8s 间隔连跑 6 次全过；
  //   而 30 条背靠背连发时第 3 次就 504，60 条单发也要 30.6s 后 504。
  //   旧代码零间隔，是「免费层在 CI 上 504」的真因（ADR-0009 的 D7 归因于「runner 在美国」是错的）。
  //   故每次免费层调用前强制间隔 FREE_TIER_MIN_INTERVAL_MS。
  //
  // 第二层 · 网关池：`LLM_MODELS`（逗号分隔，来自管理区多选）优先，回退单数 `LLM_MODEL`，
  //   按顺序尝试，某个模型失败就换下一个。曾经这里只读单数 `LLM_MODEL`，
  //   导致 workflow 传的 `LLM_MODELS` 被完全忽略。
  //
  // 两层都不可用时才报错；只有免费层可用时以「免费层单跑」模式跑。
  const MODELS = parseModels(process.env.LLM_MODELS, process.env.LLM_MODEL)
  const USE_FREE_TIER = freeTierEnabled()
  let freeTierFailures = 0
  // 上一次免费层调用结束时刻。免费层对连发敏感，用它保证最小间隔（见上方注释）。
  let lastFreeTierCallAt = 0

  if (USE_FREE_TIER) {
    console.log(`翻译主路：免费层 ${freeTierModel()}（无需 key）`)
  } else {
    console.log('翻译主路：免费层已关闭（FREE_TIER_ENABLED=0）')
  }
  const hasGateway = Boolean(process.env.LLM_API_KEY)
  if (!hasGateway) {
    if (!USE_FREE_TIER) throw new Error('免费层已关闭且未配置 LLM_API_KEY：没有任何可用的翻译提供方')
    console.log('未配置 LLM_API_KEY：以「免费层单跑」模式运行（失败即判该条失败）')
  }

  const translate = async (texts, signal) => {
    const errors = []

    // ① 免费层（熔断后跳过）
    if (USE_FREE_TIER && freeTierFailures < FREE_TIER_FAILURE_THRESHOLD) {
      try {
        // 色码先遮蔽成 <<Cn>> 占位符再送模型：
        // 实测免费层会把 `&credstone` 翻成 `&红石`、把 `&ritem` 吃掉 `&r`，
        // 而 `&` 后面跟中文是畸形色码，游戏里直接显示成字面量。
        const shielded = texts.map((t) => shieldColorCodes(t))
        // 强制调用间隔：免费层对「背靠背连发」敏感，实测零间隔第 3 次必 504。
        const wait = FREE_TIER_MIN_INTERVAL_MS - (Date.now() - lastFreeTierCallAt)
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        const arr = await callFreeTier(shielded.map((s) => s.text), { signal })
        lastFreeTierCallAt = Date.now()
        const missing = arr.filter((x) => x === null).length
        if (missing) console.log(`  [免费层] ${missing}/${texts.length} 条漏译，按行回退`)
        freeTierFailures = 0
        // 漏译位置回填原文（留英文比留空好，由回退率阀门把关整体质量）。
        return arr.map((zh, i) => (zh === null ? texts[i] : unshieldColorCodes(zh, shielded[i].codes)))
      } catch (err) {
        freeTierFailures++
        const msg = String(err?.message ?? err).slice(0, 120)
        errors.push(`免费层: ${msg}`)
        console.log(`  [免费层] 失败（${freeTierFailures}/${FREE_TIER_FAILURE_THRESHOLD}）：${msg}`)
        if (freeTierFailures >= FREE_TIER_FAILURE_THRESHOLD) {
          console.log('  [免费层] 已熔断，本轮剩余分块直接走网关')
        }
      }
    }

    // ② 网关回退池
    const key = process.env.LLM_API_KEY
    if (!key || !MODELS.length) {
      throw new Error(
        `免费层不可用且${key ? '未选择任何网关模型（管理区不勾模型 = 只走免费层）' : '未配置 LLM_API_KEY'}`
        + `（${errors.join(' | ') || '免费层已熔断'}）`,
      )
    }
    const url = normalizeGatewayUrl(process.env.LLM_BASE_URL)
    for (const model of MODELS) {
      try {
        return await callOnce(url, key, model, texts)
      } catch (err) {
        errors.push(`${model}: ${String(err?.message ?? err).slice(0, 120)}`)
        console.log(`  [网关] ${model} 失败，换下一个`)
      }
    }
    throw new Error(`全部提供方均失败（网关尝试过 ${MODELS.join(', ')}）：${errors.join(' | ')}`)
  }

  const loadPack = async (slug) => {
    const dir = join(PACKS_DIR, slug)
    const names = listSnbt(dir)
    if (!names.length) throw new Error(`找不到整合包文件：research/packs/${slug}/（先解包 .snbt 到该目录）`)
    return { files: names.map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') })) }
  }

  const writeOutput = (slug, name, text) => {
    if (args.dryRun) return
    const path = join(PATCHES_DIR, slug, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    console.log(`[${slug}] → ${relative(ROOT, path).replace(/\\/g, '/')}`)
  }

  // 可选：按 quest ID 合并模式（内嵌布局）。--merge-dir 指向上游最新章节根目录，
  // 子目录结构与 research/packs/<slug>/ 一致；未给出时不合并，产出为整体覆盖式。
  const loadMergePack = args.mergeDir
    ? (slug) => {
        const dir = join(args.mergeDir, slug)
        const names = listSnbt(dir)
        return names.length ? names.map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') })) : null
      }
    : null

  const results = await runPipeline({ records: worklist, loadPack, translate, glossary, chunkLines: args.chunkLines, timeoutMs: args.timeoutMs, writeOutput, loadMergePack, reportStatus: args.dryRun ? async () => {} : defaultReportStatus })

  // 合并式回写 glossary.json：只补新键，不抹历史条目。
  const additions = {}
  for (const r of results) if (r.additions) Object.assign(additions, r.additions)
  if (Object.keys(additions).length && !args.dryRun) {
    const merged = mergeGlossary(glossary, additions)
    writeFileSync(GLOSSARY_FILE, JSON.stringify(merged, null, 2) + '\n')
    console.log(`\n术语记忆 +${Object.keys(additions).length} 条（共 ${Object.keys(merged).length}）`)
  }

  const failed = results.filter((r) => r.status === 'failed').length
  console.log(`\n完成：done ${results.filter((r) => r.status === 'done').length}，skipped ${results.filter((r) => r.status === 'skipped').length}，failed ${failed}`)
  process.exit(failed ? 1 : 0)
}
