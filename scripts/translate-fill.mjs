#!/usr/bin/env node
/**
 * 只补漏译：找出 `patches/<slug>` 里仍是英文原文的条目，单独重翻后回写。
 *
 * ## 为什么需要它
 *
 * 并发翻译时偶发失败（网关超时 / 返回解析不出来），`buildOutputs` 对没有译文的键
 * 会**原样写英文** —— 这就是日志里「漏译 N」的来源。同一个包三次实测漏译 5/6/6 条
 * （约 0.5%），每次都不一样，说明是偶发而不是死键。
 *
 * 以前的补法是**整包重翻**：1256 条重发一遍只为了补 6 条。本脚本只发「疑似漏译」的那几条。
 *
 * ## 怎么判定「疑似漏译」
 *
 * 拿英文源（`research/packs/<slug>`，loadPackUnits）与补丁（`patches/<slug>`）做同键对比：
 * 补丁里**没有这个键**，或**值与英文原文完全相同**，且英文原文本身可翻（非空、非纯指令、含拉丁字母、
 * 不含中文），就重发一次。
 *
 * 误伤面：模组名（Mekanism）、`AllRightsReserved` 这类「翻译了也原样」的条目会被重发，
 * 结果还是原样 —— 无害，只是多花几条请求。
 *
 * ## 用法
 *
 *   node scripts/translate-fill.mjs --slug <slug> [--lanes 96] [--dry-run]
 *
 * 前提：`research/packs/<slug>` 存在（先 `node scripts/prepare-pack.mjs --ids <slug>`，
 * 基准源已在仓库里时不会重新下载）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPackUnits } from './translate-parallel.mjs'
import { translateTexts, translateText } from './lib/line-translator.mjs'
import { buildOutputs, extractPack, sourceFileNames } from './lib/quest-files.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKS_DIR = join(ROOT, 'research/packs')
const PATCHES_DIR = join(ROOT, 'patches')
const HEADER = '# AI 初翻，未人工校对\n'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) return true
  return v
}

const slug = String(arg('slug', ''))
const lanes = Number(arg('lanes', 96))
const dryRun = Boolean(arg('dry-run', false))
if (!slug) {
  console.error('用法: node scripts/translate-fill.mjs --slug <slug> [--lanes 96] [--dry-run]')
  process.exit(2)
}

const listSnbt = (dir, base = dir) => {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listSnbt(full, base))
    else if (/\.snbt$/i.test(name)) out.push(full.slice(base.length + 1).replace(/\\/g, '/'))
  }
  return out
}

// ---------- 1. 英文源 ----------
const loaded = loadPackUnits(slug, PACKS_DIR)
if (!loaded) {
  console.error(`✘ ${slug}：research/packs/${slug} 不存在。先跑 node scripts/prepare-pack.mjs --ids ${slug}`)
  process.exit(1)
}
const { units, layout } = loaded

// 重建完整 pack（buildOutputs 需要整个 pack 对象，不是只有 units）。
const packDir = join(PACKS_DIR, slug)
const allNames = listSnbt(packDir).sort()
const sourceNames = sourceFileNames(allNames, layout)
const enFiles = allNames
  .filter((n) => sourceNames.includes(n))
  .map((n) => ({ name: n, text: readFileSync(join(packDir, n), 'utf8') }))
const pack = extractPack({ files: enFiles, layout })

// ---------- 2. 补丁现状 ----------
const patchDir = join(PATCHES_DIR, slug)
if (!existsSync(patchDir)) {
  console.error(`✘ ${slug}：patches/${slug} 不存在，没有可补的东西`)
  process.exit(1)
}
const patchNames = listSnbt(patchDir).sort()
const patchSource = patchNames.filter((n) => sourceNames.includes(n))
const zhFiles = patchSource.map((n) => ({ name: n, text: readFileSync(join(patchDir, n), 'utf8') }))
const zh = extractPack({ files: zhFiles, layout })
const zhMap = new Map(zh.units.map((u) => [u.key, u.text]))

// ---------- 3. 找疑似漏译 ----------
const isTranslatable = (t) =>
  typeof t === 'string' && t.trim() !== ''
  && !/^\{[\s\S]*\}$/.test(t.trim())
  && /[A-Za-z]{2,}/.test(t)
  && !/[一-鿿]/.test(t)

const need = units.filter((u) => {
  const v = zhMap.get(u.key)
  return (v === undefined || v === u.text) && isTranslatable(u.text)
})

console.log(`${slug}：共 ${units.length} 条，疑似漏译 ${need.length} 条（${layout}）`)
if (!need.length) {
  console.log('没有需要补的，收工')
  process.exit(0)
}
if (dryRun) {
  for (const u of need.slice(0, 30)) console.log(`  - ${u.key}`)
  if (need.length > 30) console.log(`  … 另有 ${need.length - 30} 条`)
  process.exit(0)
}

// ---------- 4. 只翻这几条 ----------
const results = new Array(need.length).fill(null)
await translateTexts(need.map((u) => u.text), {
  lanes,
  translateFn: (text, opts) => translateText(text, opts),
  onResult: (i, value) => { results[i] = value },
})

let filled = 0
let unchanged = 0
let failed = 0
const translations = new Map(zhMap)
need.forEach((u, i) => {
  const v = results[i]
  if (typeof v === 'string' && v.trim() && v !== u.text) { translations.set(u.key, v); filled++ }
  // 模型把原文原样送回来 ≠ 失败：专有名词（&bQuantum Ring、Mekanism）本来就该保持原样，
  // 老计数器（untranslated）也是这么处理的。把它和「真失败」分开，免得看起来像还有一堆没补上。
  else if (typeof v === 'string' && v.trim()) unchanged++
  else failed++
})

// ---------- 5. 回写补丁 ----------
const outputs = buildOutputs(pack, translations, { header: HEADER })
for (const o of outputs) {
  const target = join(patchDir, o.name)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, o.text)
}

console.log(`补上 ${filled} 条 · 原样保留 ${unchanged} 条（专有名词，正常） · 真失败 ${failed} 条（可再跑一次本脚本）`)
console.log(`已回写 patches/${slug}/（${outputs.length} 个文件）`)
