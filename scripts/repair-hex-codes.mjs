#!/usr/bin/env node
/**
 * 修复旧翻译里的畸形 hex 色码。
 *
 * ## 背景（2026-10-21）
 *
 * `format-codes.mjs` 原先只认 `&a`/`&f` 这种单字母色码，不认 `&#RRGGBB` hex 码。
 * 后果有两层：
 *
 * 1. **翻译时**：hex 码不被遮蔽，提示词里以明文出现，模型常把它改坏
 *    （实测 `&#FF4F26` → `&#FF4O26`，数字 0 写成字母 O）或弄丢同句的 `<cN>`
 *    → `translateText` 返回 null → 该键静默保留英文。4 个包 / 3637 个键，
 *    hex 键未译率 31.4% vs 普通键 3.79%。
 *
 * 2. **质检时**：`countMalformedCodes` 把合法 hex 码也判成畸形码，于是英文侧的
 *    `enMal` 虚高，把译文侧真正的畸形码掩住了。修好第 1 层后，5 个包的旧产出
 *    立刻露出 88 个键共 110 个畸形码（闸门判红）。
 *
 * 本脚本修第 2 层暴露出来的那批：对**译文畸形数超过英文容许值**的键重译一遍。
 * 用现在的遮蔽逻辑重译，hex 码会被挡成 `<cN>`，模型必须原样带回，畸形就消失。
 *
 * ## 写法：只做原文定向替换，不整文件重新序列化
 *
 * 这些 `.snbt` 是 CRLF/LF 混排的，整文件 `serialize` 会顺手改掉所有行尾，
 * 把一次定向修复变成一次全文件 diff。所以这里逐条替换 `node.raw` → 新 `node.raw`，
 * 文件其余部分逐字节不动。
 *
 * 用法：node scripts/repair-hex-codes.mjs [--slug a,b] [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse, collectStrings, setString } from './snbt.mjs'
import { countMalformedCodes } from './lib/format-codes.mjs'
import { translateText } from './lib/line-translator.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '')
/** 闸门报出来那 5 个包（`validate:quests` 判红的）—— 重跑时可从闸门输出取。 */
export const DEFAULT_SLUGS = ['adm-confluence-otherworld', 'all-the-mods-10-sky', 'all-the-mons', 'infinity-legacy-2', 'tats1']

/** 递归列出某目录下全部 .snbt。 */
export function relFiles(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...relFiles(p, base))
    else if (/\.snbt$/i.test(name)) out.push({ full: p, rel: p.slice(base.length + 1).replace(/\\/g, '/') })
  }
  return out
}

/** 产出文件名 ← 英文源文件名（与 validate-quests 的 `enSourceName` 同口径）。 */
export function toOutputName(rel) {
  return rel.replace(/(^|\/)en_us(\/|\.snbt$)/, '$1zh_cn$2')
}

/**
 * 这个键是否需要修：译文畸形色码数 > 英文畸形数 + 英文字面 `\&` 转义数。
 * 与 `validate-quests.mjs` 同一套判据（刻意不复用同一个常量，口径由测试锁住）。
 */
export function needsRepair(enVal, zhVal) {
  const enEsc = String(enVal ?? '').split('\\&').length - 1
  return countMalformedCodes(zhVal) > countMalformedCodes(enVal) + enEsc
}

/** 在原文文本里做定向替换，返回替换后的文本与命中次数。 */
export function replaceRaw(text, oldRaw, newRaw) {
  if (oldRaw === newRaw) return { text, hits: 0 }
  const parts = text.split(oldRaw)
  return { text: parts.join(newRaw), hits: parts.length - 1 }
}

/** 重译单个键，不合格（null 或仍带畸形码）返回 null。 */
export async function repairUnit(enVal) {
  const next = await translateText(String(enVal), {})
  if (typeof next !== 'string') return null
  if (countMalformedCodes(next) > countMalformedCodes(enVal)) return null
  return next
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const slugArg = process.argv.find((a) => a.startsWith('--slug='))
  const slugs = slugArg ? slugArg.slice('--slug='.length).split(',').filter(Boolean) : DEFAULT_SLUGS

  let keysRepaired = 0, keysFailed = 0, filesChanged = 0
  for (const slug of slugs) {
    const enDir = join(ROOT, 'research/packs', slug)
    const zhDir = join(ROOT, 'patches', slug)
    if (!existsSync(enDir) || !existsSync(zhDir)) {
      console.log(`${slug}: 缺 patches/ 或 research/packs/，跳过`)
      continue
    }
    for (const ef of relFiles(enDir)) {
      const zhFull = join(zhDir, toOutputName(ef.rel))
      if (!existsSync(zhFull)) continue
      const enMap = new Map(
        collectStrings(parse(readFileSync(ef.full, 'utf8'))).map((s) => [s.path, s.node.value]),
      )
      const original = readFileSync(zhFull, 'utf8')
      let text = original
      let changed = 0
      for (const s of collectStrings(parse(text))) {
        const enVal = enMap.get(s.path)
        if (enVal === undefined || !needsRepair(enVal, s.node.value)) continue
        const oldRaw = s.node.raw
        let next
        try {
          next = await repairUnit(enVal)
        } catch (e) {
          console.log(`  ${slug} ${s.path}: 翻译报错 ${String(e?.message ?? e).slice(0, 120)}`)
          keysFailed++
          continue
        }
        if (next === null) {
          console.log(`  ${slug} ${s.path}: 重译仍不合格，跳过`)
          keysFailed++
          continue
        }
        setString(s.node, next)
        const res = replaceRaw(text, oldRaw, s.node.raw)
        if (res.hits === 0) {
          console.log(`  ${slug} ${s.path}: 原文未命中，跳过`)
          keysFailed++
          continue
        }
        text = res.text
        changed++
      }
      if (changed > 0) {
        filesChanged++
        keysRepaired += changed
        if (!dryRun) writeFileSync(zhFull, text)
        console.log(`${slug} ${ef.rel}: 修 ${changed} 个键${dryRun ? '（干跑，未写盘）' : ''}`)
      }
    }
  }
  console.log(`\n=== ${dryRun ? '干跑结果' : '完成'}：修 ${keysRepaired} 个键 / ${filesChanged} 个文件，跳过 ${keysFailed} 个 ===`)
}

const invoked = process.argv[1] && new URL(import.meta.url).href === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (invoked) main().catch((e) => { console.error(e); process.exit(1) })
