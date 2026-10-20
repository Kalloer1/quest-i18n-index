#!/usr/bin/env node
/**
 * 并行翻译：把一个整合包的待译文本**一条一条**并发送免费层，再按组分片落盘。
 *
 * ## 为什么不再分块 / 不再补翻漏译行（实测 2026-10-20）
 *
 * 换到 `index-mt-9b-syllable` 之后，分块这件事直接失效：
 * 给它多条 `L<n>=` 行，**它只回第一行**，3/3 次复现 —— 30 条一块只出 1 条。
 * 于是「按字符预算切块」「漏译行单独补翻（MAX_MISSING_ROUNDS=8）」全部失去意义：
 * 一次一条没有行可丢，缺的就换一套更重的占位符措辞补扫一轮，仍缺就留英文。
 *
 * 吞吐不是问题：lanes=24/32/48 实测吞吐完全一样（19.7 req/s），零 HTTP 错误，
 * 瓶颈在服务端而不在我们这边。24 路够用，且在途请求最少。
 * 最长文本 1251 字符、最坏延迟 8.7s；短文本 p50 约 0.5s。
 *
 * ## 与 pipeline.mjs 的关系
 *
 * `pipeline.mjs` 是串行版（35B 批量模式，30 条一块），适合 CI 与调试。
 * 本脚本是并行版，只替换「翻译」这一段，解包/打包/状态回写仍复用原有脚本。
 *
 * ## 为什么产物写盘而不是直接出补丁
 *
 * 并行下多个包同时写 `glossary.json` 必然损坏（它是跨包累积的资产）。
 * 故本脚本只产出译文分片到 `research/par-out/<slug>/`，
 * 由调用方（`translate-local.mjs`）串行写回 glossary 与 patches。
 *
 * 用法：
 *   node scripts/translate-parallel.mjs --slug a,b,c --lanes 24
 *   node scripts/translate-parallel.mjs --platform cf --limit 20 --lanes 24
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractPack, sourceFileNames } from './lib/quest-files.mjs'
import { LAYOUT, classifyLayout } from './lib/candidates.mjs'
import { translateTexts, translateText, DEFAULT_LANES } from './lib/line-translator.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKS_DIR = join(ROOT, 'research/packs')
const OUT_DIR = process.env.PAR_OUT || join(ROOT, 'research/par-out')
const DATASET = join(ROOT, 'research/index-dataset.json')

export { DEFAULT_LANES }

/**
 * 每个分片的条数。
 *
 * 这个数字现在**只影响落盘粒度**（中断损失、`translate-local` 读盘的内存），
 * 不影响请求形态 —— 请求永远是一条文本一个。200 条一组：450 条的包出 3 个文件，
 * 单文件既不至于小到上千个句柄，也不至于中断一次丢太多。
 */
export const SHARD_SIZE = 200

/** 汉字判定（3400-9FFF 与 F900-FAFF）。用来把「模型原样回英文」的条目单独计数，模组名不算失败。 */
const CJK = /[㐀-鿿豈-﫿]/

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
 * 读一个整合包的待译单元。布局判定与 pipeline 同一套 sourceFileNames。
 *
 * **布局判定只走 `classifyLayout`，本函数不再自己写一份。**
 * 旧实现内联了同序同义的三行判定（lang/en_us/ → separate-dir；lang/en_us.snbt →
 * separate-single；否则 embedded），与 `lib/candidates.mjs` 分居两处，改一处不会带动另一处。
 * 实测（2026-10-20，`research/packs/` 下 34 个包逐一对齐）：0 处分歧，故收敛为单一事实来源。
 * `scripts/translate-parallel.test.mjs` 里有一条结构性断言锁住「不得再内联」。
 *
 * @param {string} slug
 * @returns {{units: Array<{key:string,text:string}>, layout: string}|null}
 */
export function loadPackUnits(slug, packsDir = PACKS_DIR) {
  const dir = join(packsDir, slug)
  if (!existsSync(dir)) return null
  const names = listSnbt(dir).sort()
  if (!names.length) return null
  const all = names.map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
  const layout = classifyLayout(names).layout
  const sourceNames = sourceFileNames(names, layout)
  const files = all.filter((f) => sourceNames.includes(f.name))
  if (!files.length) return null
  const extracted = extractPack({ files, layout })
  return { units: extracted.units.map((u) => ({ key: u.key, text: u.text })), layout }
}

/**
 * 把一个整合包的所有单元逐条并发翻译。
 *
 * @param {string} slug
 * @param {{
 *   lanes?: number, outDir?: string, packsDir?: string,
 *   callFn?: (text: string, opts: {emphasizeCodes: boolean}) => Promise<string|null>,
 * }} [opts]
 * @returns {Promise<{
 *   slug: string, layout: string, total: number, ok: number, missing: number,
 *   untranslated: number, skipped: number, directives: number,
 * }>}
 */
export async function translatePackParallel(slug, {
  lanes = DEFAULT_LANES,
  outDir = OUT_DIR,
  packsDir = PACKS_DIR,
  runId,
  callFn,
} = {}) {
  const loaded = loadPackUnits(slug, packsDir)
  if (!loaded) throw new Error(`${slug}：research/packs/${slug} 不存在或没有任务书文件`)
  const { units, layout } = loaded

  const translateFn = callFn ?? ((text, opts) => translateText(text, opts))
  const outs = await translateTexts(units.map((u) => u.text), { lanes, translateFn })

  const dir = join(outDir, slug)
  mkdirSync(dir, { recursive: true })

  // 按单元原序切成固定大小的分片。
  //
  // 形状 `{slug, chunk, runId, keys, outs}` 是 `translate-local.mjs` 的读盘契约。
  // `runId` 是 ADR-0009 D11 的修法：文件名与内容都带上本轮标识，
  // `mergeShards` 只合并同 runId 的分片，上一轮遗留的普通分片不会被静默混入。
  // 不传 `runId` 时退回旧的无标识文件名（保持向后兼容，便于手工调试）。
  const effectiveRunId = runId ?? null
  const shardName = (n) => effectiveRunId
    ? `chunk-${String(n).padStart(4, '0')}.${effectiveRunId}.json`
    : `chunk-${String(n).padStart(4, '0')}.json`
  for (let start = 0, n = 0; start < units.length; start += SHARD_SIZE, n++) {
    const part = units.slice(start, start + SHARD_SIZE)
    writeFileSync(
      join(dir, shardName(n)),
      JSON.stringify({
        slug,
        chunk: n,
        ...(effectiveRunId ? { runId: effectiveRunId } : {}),
        keys: part.map((u) => u.key),
        outs: outs.slice(start, start + SHARD_SIZE),
      }, null, 1) + '\n',
    )
  }

  let ok = 0
  let missing = 0
  let untranslated = 0
  let skipped = 0
  let directives = 0
  units.forEach((u, i) => {
    const src = String(u.text ?? '')
    if (src.trim() === '') { skipped++; return }
    if (/^\{[\s\S]*\}$/.test(src.trim())) { directives++; return }
    const out = outs[i]
    if (out == null) { missing++; return }
    ok++
    // 模组名（Mekanism、XyCraft）、`AllRightsReserved` 这类占位垃圾原样回来是正常的，
    // 实测 14/240。计数观察即可，判失败只会把好包打成坏包。
    if (!CJK.test(out)) untranslated++
  })

  return { slug, layout, total: units.length, ok, missing, untranslated, skipped, directives }
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

  console.log(`待翻译 ${slugs.length} 个整合包，${lanes} 路并发（一条文本一个请求）`)
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
      console.log(
        `[${i + 1}/${slugs.length}] ${slug} (${r.layout}) 共 ${r.total} 条 / 译出 ${r.ok}`
        + ` / 漏译 ${r.missing} / 未译 ${r.untranslated} / 空串 ${r.skipped} / 指令 ${r.directives}`
        + ` · ${Math.round((Date.now() - started) / 1000)}s`,
      )
    } catch (e) {
      console.log(`[${i + 1}/${slugs.length}] ${slug} FAILED: ${String(e?.message ?? e).slice(0, 120)}`)
      results.push({ slug, total: 0, ok: 0, missing: 0, untranslated: 0, skipped: 0, directives: 0, error: String(e?.message ?? e) })
    }
  }

  const sum = (k) => results.reduce((a, r) => a + (r[k] ?? 0), 0)
  const secs = Math.round((Date.now() - t0) / 1000)
  console.log(
    `\n=== 完成：${results.length} 个包 / 共 ${sum('total')} 条 / 译出 ${sum('ok')}`
    + ` / 漏译 ${sum('missing')} / 未译 ${sum('untranslated')}`
    + ` / 空串 ${sum('skipped')} / 指令 ${sum('directives')} / 耗时 ${secs}s ===`,
  )
  console.log(`吞吐 ${(sum('ok') / Math.max(1, secs)).toFixed(2)} 条/秒`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
