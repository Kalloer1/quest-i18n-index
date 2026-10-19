#!/usr/bin/env node
/**
 * 免费层真实翻译压测：拿真实整合包的任务书，按 pipeline 的分块逻辑连续翻译，
 * 直到免费层开始失败为止。
 *
 * 与「发假文本探测限速」的区别（这是本脚本存在的唯一理由）：
 *   - 假文本只换来一个数字，额度全白烧；
 *   - 真实文本**本身就是产出**：跑完这块，该整合包就真的多了一段中文译文，
 *     可以直接落进 `patches/<slug>/`，也可以用来估「单包真实耗时」。
 *
 * 所以本脚本不做「N 次调用测阈值」这种纯探测，而是**边翻边记**：
 *   每个分块翻译成功就立刻落盘（`research/probe-out/<slug>/<chunk>.txt`），
 *   中断了也不丢；失败只记事件，不判整包失败。
 *
 * 判定口径：
 *   - 连续 CONSECUTIVE_LIMIT 次失败才判「已被限速」并停止；
 *   - 单次失败只降级该分块（留英文），继续下一块 —— 与 pipeline 的真实行为一致。
 *
 * 用法：
 *   node scripts/translate-probe.mjs --slug fantasy-rpg-with-quests --chunks 20
 *   node scripts/translate-probe.mjs --slug fantasy-rpg-with-quests --chunks 200 --interval 200
 *
 * 环境变量：
 *   FREE_TIER_BASE_URL / FREE_TIER_MODEL  与 pipeline 同一套
 *   PROBE_OUT                              产出目录，默认 research/probe-out
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { freeTierUrl, freeTierModel, callFreeTier, FREE_TIER_MIN_INTERVAL_MS } from './lib/free-tier.mjs'
import { extractPack, sourceFileNames } from './lib/quest-files.mjs'
import { shieldColorCodes, unshieldColorCodes } from './lib/format-codes.mjs'
import { LAYOUT } from './lib/candidates.mjs'
import { CHUNK_LINES } from './pipeline.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKS_DIR = join(ROOT, 'research/packs')
const OUT_DIR = process.env.PROBE_OUT || join(ROOT, 'research/probe-out')

/** 连续失败多少次判「已被限速」。 */
export const CONSECUTIVE_LIMIT = 3

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return /^-?\d+$/.test(v) ? Number(v) : v
}

/** 递归列 .snbt（相对路径）。 */
function listSnbt(dir, base = dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listSnbt(full, base))
    else if (/\.snbt$/i.test(name)) out.push(full.slice(base.length + 1).replace(/\\/g, '/'))
  }
  return out
}

/**
 * 从整合包目录读出待译单元，顺序稳定（按文件名 + SNBT 路径排序），
 * 这样同一 slug 多次跑的分块边界一致，落盘的分块可续。
 *
 * 布局判定必须用与 pipeline 同一套 sourceFileNames()：
 * 早先手拼 files 把 `chapters/*.snbt` 也当待译源，导致 `id`/`filename`/`group`
 * 这类结构字段被送进翻译接口（实测漏译 2 条、且真翻出来会写坏任务书）。
 */
export function loadUnits(slug, packsDir = PACKS_DIR) {
  const dir = join(packsDir, slug)
  const names = listSnbt(dir).sort()
  const allFiles = names.map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
  const layout = names.some((n) => /lang\/en_us\//i.test(n)) ? LAYOUT.SEPARATE_DIR
    : names.some((n) => /lang\/en_us\.snbt$/i.test(n)) ? LAYOUT.SEPARATE_SINGLE
      : LAYOUT.EMBEDDED
  // 只保留该布局的英文源文件；分离布局下 chapters/*.snbt 不是待译源。
  const sourceNames = sourceFileNames(names, layout)
  const files = allFiles.filter((f) => sourceNames.includes(f.name))
  const extracted = extractPack({ files, layout })
  return { units: extracted.units, layout, fileCount: names.length, sourceFileCount: files.length }
}

/** 把 units 切成 pipeline 同款分块（CHUNK_LINES 条一块）。 */
export function chunkUnits(units, chunkLines = CHUNK_LINES) {
  const chunks = []
  for (let i = 0; i < units.length; i += chunkLines) chunks.push(units.slice(i, i + chunkLines))
  return chunks
}

async function main() {
  const slug = arg('slug', '')
  if (!slug) { console.error('必须给 --slug <整合包 slug>'); process.exit(2) }
  const maxChunks = arg('chunks', 20)
  const interval = arg('interval', FREE_TIER_MIN_INTERVAL_MS)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const { units, layout, fileCount, sourceFileCount } = loadUnits(slug)
  const chunks = chunkUnits(units)
  console.log(`整合包 ${slug}：${fileCount} 个 .snbt，其中 ${sourceFileCount} 个是待译源，${units.length} 条待译文本，布局 ${layout}`)
  console.log(`分块 ${chunks.length}（每块 ${CHUNK_LINES} 条），本次最多跑 ${maxChunks} 块`)
  console.log(`端点 ${freeTierUrl()} · 模型 ${freeTierModel()}\n`)

  const outDir = join(OUT_DIR, slug)
  mkdirSync(outDir, { recursive: true })

  const events = []
  let consecutive = 0
  let done = 0
  let failed = 0
  let verdict = 'no-limit-observed'

  for (let i = 0; i < Math.min(chunks.length, maxChunks); i++) {
    const chunk = chunks[i]
    const texts = chunk.map((u) => shieldColorCodes(u.text))
    const started = Date.now()
    try {
      // shieldColorCodes 返回 {text, codes}，色码还原必须用同一块的 codes 表（与 pipeline 一致）。
      const outs = await callFreeTier(texts.map((t) => t.text))
      const ms = Date.now() - started
      const missing = outs.filter((o) => o == null).length
      // 立刻落盘：中断也不丢已翻好的内容。
      writeFileSync(
        join(outDir, `chunk-${String(i).padStart(4, '0')}.json`),
        JSON.stringify({
          slug,
          chunk: i,
          keys: chunk.map((u) => u.key),
          outs: outs.map((o, j) => (o == null ? null : unshieldColorCodes(o, texts[j].codes))),
          ms,
        }, null, 1) + '\n',
      )
      done++
      consecutive = 0
      events.push({ chunk: i, ok: true, ms, missing, n: chunk.length })
      console.log(`[${String(i + 1).padStart(4)}/${chunks.length}] ok ${ms}ms ${chunk.length} 条${missing ? `（漏译 ${missing}）` : ''}`)
    } catch (e) {
      failed++
      consecutive++
      const msg = String(e?.message ?? e).slice(0, 160)
      events.push({ chunk: i, ok: false, ms: Date.now() - started, error: msg })
      console.log(`[${String(i + 1).padStart(4)}/${chunks.length}] FAIL ${msg}`)
      if (consecutive >= CONSECUTIVE_LIMIT) {
        verdict = 'limited'
        console.log(`\n连续 ${consecutive} 次失败 → 判定已被限速，停止`)
        break
      }
    }
    if (interval > 0) await sleep(interval)
  }

  const okMs = events.filter((e) => e.ok).map((e) => e.ms).sort((a, b) => a - b)
  const pct = (p) => (okMs.length ? okMs[Math.min(okMs.length - 1, Math.floor(okMs.length * p))] : null)
  const report = {
    probedAt: new Date().toISOString(),
    slug,
    layout,
    totalUnits: units.length,
    totalChunks: chunks.length,
    ranChunks: events.length,
    ok: done,
    failed,
    verdict,
    chunkMs: { p50: pct(0.5), p95: pct(0.95), max: okMs.at(-1) ?? null },
    // 单包总耗时外推：这是决定「2000 个包要跑多久」的关键数字。
    projectedPackMs: okMs.length ? Math.round((okMs.reduce((a, b) => a + b, 0) / okMs.length) * chunks.length) : null,
    events,
  }
  writeFileSync(join(outDir, '_report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`\n=== ${verdict} ===  成功 ${done} 块 / 失败 ${failed} 块`)
  console.log(`分块耗时 p50=${report.chunkMs.p50}ms p95=${report.chunkMs.p95}ms`)
  console.log(`单包（${chunks.length} 块）外推耗时 ≈ ${report.projectedPackMs}ms ≈ ${(report.projectedPackMs / 60000).toFixed(1)} 分钟`)
  console.log(`产出 → ${outDir}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
