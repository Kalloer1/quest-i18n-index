#!/usr/bin/env node
/**
 * 并行翻译：把整合包的待译文本切成块，多路并发调免费层，最后合并写回。
 *
 * ## 为什么可以并行（实测推翻了之前的结论）
 *
 * 早先观察到「零间隔串行连发第 3 次就 504」，据此定下 8 秒强制间隔。
 * 但并发探测（`probe-concurrency.mjs`，515 次真实调用）显示：
 *
 * | 并发 | 成功/总 | 吞吐 |
 * | 5   | 15/15   | 1.60 块/秒 |
 * | 12  | 36/36   | 3.94 块/秒 |
 * | 32  | 96/96   | 7.93 块/秒 |
 * | 64  | 128/128 | 13.67 块/秒 |
 *
 * **零失败，延迟只从 3.0s 升到 4.6s。**
 * 所以真正的变量不是「频度」而是「同一连接上的连续请求」——
 * 多路并发反而天然形成了间隔。
 *
 * ## 与 pipeline.mjs 的关系
 *
 * `pipeline.mjs` 是串行版（单包跑完再下一个），适合 CI 与调试。
 * 本脚本是并行版，只替换「翻译」这一段：解包、打包、状态回写仍复用原有脚本。
 *
 * ## 为什么产物写盘而不是直接出补丁
 *
 * 并行下多个包同时写 `glossary.json` 必然损坏（它是跨包累积的资产）。
 * 故本脚本只产出「每块译文」到 `research/par-out/<slug>/`，
 * 由调用方（或后续的合并步骤）串行写回 glossary 与 patches。
 *
 * 用法：
 *   node scripts/translate-parallel.mjs --slug a,b,c --lanes 12
 *   node scripts/translate-parallel.mjs --platform cf --limit 20 --lanes 16
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { callFreeTier, FREE_TIER_MIN_INTERVAL_MS } from './lib/free-tier.mjs'
import { shieldColorCodes, unshieldColorCodes } from './lib/format-codes.mjs'
import { extractPack, sourceFileNames } from './lib/quest-files.mjs'
import { LAYOUT } from './lib/candidates.mjs'
import { CHUNK_LINES } from './pipeline.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKS_DIR = join(ROOT, 'research/packs')
const OUT_DIR = process.env.PAR_OUT || join(ROOT, 'research/par-out')
const DATASET = join(ROOT, 'research/index-dataset.json')

/** 默认并发。实测 12 路是吞吐/延迟的甜点（3.94 块/秒，p50 仍 < 3s）。 */
export const DEFAULT_LANES = 12

/** 单块失败重试次数（并发下偶发 5xx 很常见，重试成本低）。 */
export const MAX_RETRIES = 2

/**
 * 漏译行的补翻轮数。
 *
 * 为何必须有这一层（实测 2026-10-19，aoc 同一批 30 条重复 5 次）：
 *   漏译数在 `11, 0, 17, 0, 14` 之间剧烈波动 ——
 *   这是免费层的**随机丢行**，不是占位符、不是分块、不是长文本。
 *
 * 但丢行是随机的，所以**重试几乎必然成功**：
 *   实测三轮：首轮漏 14/20/15 条，经 2~4 轮「只重试漏掉的行」后
 *   **最终全部补回，漏译 0**。
 *
 * 成本极低：只发漏掉的那几条，不是重发整块。
 */
export const MAX_MISSING_ROUNDS = 8

/**
 * 单块字符预算。
 *
 * 为何按字符而不按条数分块（实测 2026-10-19，aoc 948 条）：
 *   - 按「30 条」分块时漏译率 42%，且**分布极不均**：
 *     全是 title 的块漏 0 条，含 9 个 quest_desc + 11 个 subtitle 的块漏 27 条。
 *   - 根因：任务书文本长度差 10 倍以上（p50 27 字符，max 415；
 *     最长 30 条合计 7513 字符，最短 30 条合计 0）。
 *     长文本块会把输出撞到 `max_tokens: 8192` 上限，后面几行被截断。
 *
 * 按字符预算分块后，每块的输出量大致恒定，不会再出现「某块全丢」。
 */
export const CHUNK_CHAR_BUDGET = 1200

/** 单块条数上限（避免全是空串/极短文本时切出上千条一块）。 */
export const CHUNK_MAX_ITEMS = 40

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) return true
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
 * 按字符预算切块。
 *
 * 同时受两个上限约束：字符总量与条数。
 * 空串/极短文本不占预算但计数，故必须有条数上限兜底。
 *
 * @param {Array<{key:string,text:string}>} units
 * @param {{charBudget?: number, maxItems?: number}} [opts]
 * @returns {Array<Array<{key:string,text:string}>>}
 */
export function chunkByChars(units, { charBudget = CHUNK_CHAR_BUDGET, maxItems = CHUNK_MAX_ITEMS } = {}) {
  const chunks = []
  let cur = []
  let used = 0
  for (const u of units) {
    const len = (u.text ?? '').length
    // 单条就超预算时独占一块（不能无限堆积）。
    if (cur.length && (used + len > charBudget || cur.length >= maxItems)) {
      chunks.push(cur)
      cur = []
      used = 0
    }
    cur.push(u)
    used += len
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

/**
 * 读一个整合包的待译单元。布局判定与 pipeline 同一套 sourceFileNames。
 * @param {string} slug
 * @returns {{units: Array<{key:string,text:string}>, layout: string}|null}
 */
export function loadPackUnits(slug, packsDir = PACKS_DIR) {
  const dir = join(packsDir, slug)
  if (!existsSync(dir)) return null
  const names = listSnbt(dir).sort()
  if (!names.length) return null
  const all = names.map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
  const layout = names.some((n) => /lang\/en_us\//i.test(n)) ? LAYOUT.SEPARATE_DIR
    : names.some((n) => /lang\/en_us\.snbt$/i.test(n)) ? LAYOUT.SEPARATE_SINGLE
      : LAYOUT.EMBEDDED
  const sourceNames = sourceFileNames(names, layout)
  const files = all.filter((f) => sourceNames.includes(f.name))
  if (!files.length) return null
  const extracted = extractPack({ files, layout })
  return { units: extracted.units.map((u) => ({ key: u.key, text: u.text })), layout }
}

/**
 * 把一个整合包的所有块并发翻译。
 *
 * 每块成功后立刻落盘，中断不丢已完成的部分。
 *
 * @param {string} slug
 * @param {{lanes?: number, charBudget?: number, maxChunkItems?: number, outDir?: string, packsDir?: string, callFn?: Function}} [opts]
 * @returns {Promise<{slug:string, layout:string, chunks:number, ok:number, failed:number, missing:number}>}
 */
export async function translatePackParallel(slug, {
  lanes = DEFAULT_LANES,
  charBudget = CHUNK_CHAR_BUDGET,
  maxChunkItems = CHUNK_MAX_ITEMS,
  outDir = OUT_DIR,
  packsDir = PACKS_DIR,
  callFn = callFreeTier,
} = {}) {
  const loaded = loadPackUnits(slug, packsDir)
  if (!loaded) throw new Error(`${slug}：research/packs/${slug} 不存在或没有任务书文件`)
  const { units, layout } = loaded

  // 按字符预算切块（不按条数：长文本会把输出撞到 max_tokens 上限）。
  const chunks = chunkByChars(units, { charBudget, maxItems: maxChunkItems })

  const dir = join(outDir, slug)
  mkdirSync(dir, { recursive: true })

  let ok = 0
  let failed = 0
  let missing = 0
  let next = 0

  // N 路 worker 共享一个游标队列 —— 这就是真实并行的形态。
  const worker = async () => {
    while (true) {
      const i = next++
      if (i >= chunks.length) return
      const chunk = chunks[i]
      const shielded = chunk.map((u) => shieldColorCodes(u.text))
      const texts = shielded.map((s) => s.text)
      let lastErr = null
      let succeeded = false
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          let outs = await callFn(texts)

          // 漏译行单独补翻：免费层会随机丢行（实测同一批在 0~20 条之间波动），
          // 但丢行是随机的，只重发漏掉的那几条几乎必然补回。
          // 不补的话，内嵌/长文本包的漏译率可达 35%，产出就是中英混杂。
          for (let round = 0; round < MAX_MISSING_ROUNDS; round++) {
            const missIdx = outs.map((o, j) => (o == null ? j : -1)).filter((j) => j >= 0)
            if (!missIdx.length) break
            const retry = await callFn(missIdx.map((j) => texts[j]))
            retry.forEach((o, k) => { if (o != null) outs[missIdx[k]] = o })
          }

          const miss = outs.filter((x) => x == null).length
          missing += miss
          // 立刻落盘：中断不丢已翻好的块。
          writeFileSync(
            join(dir, `chunk-${String(i).padStart(4, '0')}.json`),
            JSON.stringify({
              slug,
              chunk: i,
              keys: chunk.map((u) => u.key),
              outs: outs.map((o, j) => (o == null ? null : unshieldColorCodes(o, shielded[j].codes))),
            }, null, 1) + '\n',
          )
          ok++
          succeeded = true
          break
        } catch (e) {
          lastErr = e
          // 并发下 5xx 很常见，短暂退避后重试；退避时间随尝试次数增长。
          if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        }
      }
      if (!succeeded) {
        failed++
        writeFileSync(
          join(dir, `chunk-${String(i).padStart(4, '0')}.failed.json`),
          JSON.stringify({ slug, chunk: i, error: String(lastErr?.message ?? lastErr).slice(0, 200) }, null, 1) + '\n',
        )
      }
      // 注意：这里不能 return —— 一个 worker 要一直取下一块直到队列空。
      // 早先写成成功即 return，导致 12 路 worker 各只干一块就退出（21 块只做了 12 块）。
    }
  }

  await Promise.all(Array.from({ length: Math.min(lanes, chunks.length) }, worker))
  return { slug, layout, chunks: chunks.length, ok, failed, missing }
}

/**
 * 从数据集里取可翻译的 slug 列表（按下载量顺序，TSV 原序）。
 * @param {{platform?: string, layout?: string}} [filter]
 * @returns {string[]}
 */
export function listTranslatable({ platform, layout } = {}) {
  const ds = JSON.parse(readFileSync(DATASET, 'utf8'))
  const rows = ds.dataset ?? []
  const PRODUCIBLE = new Set([LAYOUT.SEPARATE_DIR, LAYOUT.SEPARATE_SINGLE, LAYOUT.EMBEDDED])
  return rows
    .filter((r) => PRODUCIBLE.has(r.layout))
    .filter((r) => (platform ? r.platform === platform : true))
    .filter((r) => (layout ? r.layout === layout : true))
    .filter((r) => (r.zhFiles ?? 0) === 0)
    .map((r) => r.slug)
}

async function main() {
  const slugArg = arg('slug', '')
  const lanes = arg('lanes', DEFAULT_LANES)
  const limit = arg('limit', 0)
  const platform = arg('platform', '')
  const layout = arg('layout', '')

  let slugs = []
  if (typeof slugArg === 'string' && slugArg) {
    slugs = slugArg.split(',').map((s) => s.trim()).filter(Boolean)
  } else {
    slugs = listTranslatable({ platform: platform || undefined, layout: layout || undefined })
  }
  if (limit > 0) slugs = slugs.slice(0, limit)

  console.log(`待翻译 ${slugs.length} 个整合包，${lanes} 路并发`)
  if (!slugs.length) { console.log('没有可翻译的包'); return }

  const t0 = Date.now()
  const results = []
  // 包之间串行、包内并行：术语记忆与产物写回仍是串行的，
  // 包内并发已经能吃掉绝大部分等待时间。
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i]
    const started = Date.now()
    try {
      const r = await translatePackParallel(slug, { lanes })
      results.push(r)
      console.log(`[${i + 1}/${slugs.length}] ${slug} (${r.layout}) 块 ${r.ok}/${r.chunks} 失败 ${r.failed} 漏译 ${r.missing} · ${Math.round((Date.now() - started) / 1000)}s`)
    } catch (e) {
      console.log(`[${i + 1}/${slugs.length}] ${slug} FAILED: ${String(e?.message ?? e).slice(0, 120)}`)
      results.push({ slug, failed: 1, ok: 0, chunks: 0, missing: 0, error: String(e?.message ?? e) })
    }
  }

  const totalOk = results.reduce((a, r) => a + (r.ok ?? 0), 0)
  const totalChunks = results.reduce((a, r) => a + (r.chunks ?? 0), 0)
  const totalMissing = results.reduce((a, r) => a + (r.missing ?? 0), 0)
  const secs = Math.round((Date.now() - t0) / 1000)
  console.log(`\n=== 完成：${results.length} 个包 / ${totalOk}/${totalChunks} 块 / 漏译 ${totalMissing} 条 / 耗时 ${secs}s ===`)
  console.log(`吞吐 ${(totalOk / Math.max(1, secs)).toFixed(2)} 块/秒`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
