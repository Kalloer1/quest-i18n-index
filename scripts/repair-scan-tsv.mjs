#!/usr/bin/env node
/**
 * 修补扫描 TSV：内嵌格式（embedded）的 `newEn` 列被历史 bug 写成了 0。
 *
 * 背景：`scan-packs.mjs` 曾复制过一份分类器，只把 `lang/en_us/*` 算进 enFiles，
 * 内嵌格式于是恒为 0；而章节数被写进了 `oldCh` 列。
 * 后果是全部 213 个内嵌包被 `skipReason` 判成「找不到英文源」而跳过
 * （2000 条扫描里 66% 的可做工作被静默丢弃）。
 *
 * 分类器已修（`scan-packs.mjs` 改为复用 `classifyLayout`），但**已有的 TSV 是脏的**。
 * 重扫 2000 条约需 2 小时且会重新消耗 CF 配额；而正确值**就在同一行的 oldCh 列里**，
 * 故用本脚本就地修补，不重扫。
 *
 * 幂等：已经修过的行（newEn > 0）不动；只改 `format=embedded && newEn=0` 的行。
 *
 * 用法：
 *   node scripts/repair-scan-tsv.mjs                    就地修补 research/scan-2k.tsv
 *   node scripts/repair-scan-tsv.mjs --file x.tsv       指定文件
 *   node scripts/repair-scan-tsv.mjs --dry-run          只报告，不写
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 修补 TSV 文本，返回 `{text, repaired, unchanged}`。纯函数，便于测试。
 *
 * 规则：`format === 'embedded'` 且 `newEn === '0'` 且 `oldCh` 是正整数
 * → `newEn = oldCh`（内嵌布局的英文源就是 chapters/*.snbt，数量即 oldCh）。
 *
 * @param {string} text
 * @returns {{text: string, repaired: number, unchanged: number, skipped: number}}
 */
export function repairScanTsv(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const headerLine = lines.find((l) => l.trim())
  if (!headerLine) return { text, repaired: 0, unchanged: 0, skipped: 0 }
  const header = headerLine.split('\t')
  const idx = Object.fromEntries(header.map((c, i) => [c, i]))
  for (const col of ['format', 'newEn', 'oldCh']) {
    if (!(col in idx)) throw new Error(`扫描 TSV 缺列：${col}`)
  }

  let repaired = 0
  let unchanged = 0
  let skipped = 0
  const out = lines.map((line) => {
    if (!line.trim()) return line
    if (line === headerLine) return line
    const f = line.split('\t')
    if (f[idx.format] !== 'embedded') { unchanged++; return line }
    if (f[idx.newEn] !== '0') { unchanged++; return line }
    const chapters = Number(f[idx.oldCh])
    if (!Number.isInteger(chapters) || chapters <= 0) { skipped++; return line }
    f[idx.newEn] = String(chapters)
    repaired++
    return f.join('\t')
  })
  return { text: out.join('\n'), repaired, unchanged, skipped }
}

function main() {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`)
    if (i < 0) return dflt
    const v = process.argv[i + 1]
    return v === undefined || v.startsWith('--') ? true : v
  }
  const file = arg('file', join(ROOT, 'research/scan-2k.tsv'))
  const dryRun = Boolean(arg('dry-run', false))

  const before = readFileSync(file, 'utf8')
  const { text, repaired, unchanged, skipped } = repairScanTsv(before)
  console.log(`文件 ${file}`)
  console.log(`修补 ${repaired} 行（内嵌格式的 newEn 从 oldCh 补齐）`)
  console.log(`未动 ${unchanged} 行 / 无法修补 ${skipped} 行（oldCh 非正整数）`)
  if (dryRun) { console.log('dry-run：不写文件'); return }
  if (repaired === 0) { console.log('无需修改'); return }
  writeFileSync(file, text)
  console.log('已写入')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
