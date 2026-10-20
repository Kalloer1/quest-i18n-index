#!/usr/bin/env node
/**
 * 解包整合包 zip：只抽出任务书相关的 .snbt 到 research/packs/<slug>/。
 *
 * 这是流水线与真实世界之间的缺口：pipeline.mjs 的 loadPack 直接读
 * research/packs/<slug>/ 下的 .snbt，但没有任何代码把 zip 解到这个目录。
 * 本脚本补上这一步（上游一步，不修改 loadPack）。
 *
 * 只解出需要的文件，不全量解压（整合包动辄上百 MB，绝大多数是 mods/、assets/）：
 *   - 任意层级 ftbquests/ 下的 .snbt            内嵌/分离都在 ftbquests 下
 *   - 任意层级 lang/en_us/ 下的 .snbt、lang/en_us.snbt
 *   - 任意层级 lang/zh_cn/ 下的 .snbt、lang/zh_cn.snbt
 *   - 任意层级 chapters/ 下的 .snbt             内嵌章节
 *   - 任意层级 lang/ 下的单层 .snbt             兜底（分离·单文件布局）
 *
 * 落盘路径形态：去掉 zip 顶层的包装目录（`<包名>/`、`overrides/`、`minecraft/`），
 * 从最早的 `config` / `ftbquests` / `lang` / `chapters` 段开始保留，得到仓库约定的
 * `config/ftbquests/quests/...`。这样 classifyLayout 的 LAYOUT_PATTERNS
 * （`(^|\/)lang\/en_us\/…`、`(^|\/)chapters\/…`、`(^|\/)ftbquests\/`）才能正确匹配，
 * 与 pipeline 的判据、以及仓库内既有夹具（`config/ftbquests/quests/...`）保持一致。
 *
 * 用法：node scripts/extract-pack.mjs <zip路径> <slug>
 * 幂等：每次先清空 research/packs/<slug>/，重复跑覆盖写，不残留旧文件。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { classifyLayout, LAYOUT } from './lib/candidates.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKS_DIR = join(ROOT, 'research/packs')

const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOC = 0x07064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/**
 * 任务书相关文件的路径判据（大小写不敏感），对应本文件头部的清单。
 * 与 candidates.mjs 的 LAYOUT_PATTERNS 同口径，但放宽到任意层级（`**`）。
 */
export const NEEDED_PATTERNS = [
  /(^|\/)ftbquests\/.*\.snbt$/i,
  /(^|\/)lang\/en_us(\/.*)?\.snbt$/i,
  /(^|\/)lang\/zh_cn(\/.*)?\.snbt$/i,
  /(^|\/)chapters\/[^/]+\.snbt$/i,
]

/**
 * 已知的非中英语言（`lang/pt_br.snbt`、`lang/ja_jp/chapters/a.snbt`），**不解出**。
 *
 * 为何要排除：实测 All of Create 同时带 `lang/en_us.snbt` 与 `lang/pt_br.snbt`。
 * 解出葡语只会让校验器把它当基准键集、要求我们也翻葡语；
 * 本站只产出简体中文，其余语言对流水线是噪声。
 *
 * 2026-10-20 修正：旧口径只拦**单文件**（`lang/pt_br.snbt`），拦不住**目录式**外文
 * （`lang/ja_jp/chapters/*.snbt`）。ATM10 这类包带 9 份完整外文章节目录，
 * 全部命中 `ftbquests/.*\.snbt` 被解出；33 个包累计 29 MB，
 * 而总 38.3 MB 里只有 9.3 MB 是 en_us。它们既进不了基准键集，
 * 又会被 release.mjs 原样提交进仓库。
 * 现在两种形态都拦：`lang/<非中英>/` 目录与 `lang/<非中英>.snbt` 单文件。
 */
export const OTHER_LANG_SINGLE = /(^|\/)lang\/(?!en_us|zh_cn)([^/]+\.snbt|[^/]+\/)/i

/** 该 zip 条目是否是任务书相关文件（需要解出）。 */
export function isQuestFile(name) {
  if (!/\.snbt$/i.test(name)) return false
  // 先排除非中英语言单文件：它们同时命中 `ftbquests/.*\.snbt` 与 `lang/`，
  // 必须在正向匹配之前拦掉，否则 `lang/pt_br.snbt` 会被当成任务书文件解出。
  if (OTHER_LANG_SINGLE.test(name)) return false
  return NEEDED_PATTERNS.some((re) => re.test(name))
}

/** 落盘时作为「任务书根」的路径段：从最早出现的一个开始保留。 */
const ANCHOR_SEGMENTS = new Set(['config', 'ftbquests', 'lang', 'chapters'])

/**
 * zip 内路径 → 落盘相对路径：剥掉顶层包装目录，锚定到任务书根。
 * 例：`SkyFactory5-5.0.8/overrides/config/ftbquests/quests/chapters/x.snbt`
 *   → `config/ftbquests/quests/chapters/x.snbt`。
 * 每个被 isQuestFile 选中的路径都必然含 config/ftbquests/lang/chapters 之一，故锚点总能命中。
 */
export function toOutputPath(name) {
  const segs = name.split('/').filter(Boolean)
  for (let i = 0; i < segs.length; i++) {
    if (ANCHOR_SEGMENTS.has(segs[i].toLowerCase())) return segs.slice(i).join('/')
  }
  return segs.join('/')
}

/** 从尾部找 EOCD（中央目录结尾）签名；找不到返回 -1。 */
export function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/** 解析 zip64 扩展字段（header id 0x0001），按需读取被置为 0xffffffff 的字段。 */
function parseZip64Extra(buf, start, len, need) {
  const out = {}
  let p = start
  const end = start + len
  while (p + 4 <= end) {
    const id = buf.readUInt16LE(p)
    const size = buf.readUInt16LE(p + 2)
    if (id === 0x0001) {
      let q = p + 4
      if (need.uncompSize && q + 8 <= end) { out.uncompSize = Number(buf.readBigUInt64LE(q)); q += 8 }
      if (need.compSize && q + 8 <= end) { out.compSize = Number(buf.readBigUInt64LE(q)); q += 8 }
      if (need.localOffset && q + 8 <= end) { out.localOffset = Number(buf.readBigUInt64LE(q)); q += 8 }
      break
    }
    p += 4 + size
  }
  return out
}

/**
 * 读 zip 中央目录，返回条目列表。
 * 支持 zip64（EOCD 字段为 0xffff/0xffffffff 时读 zip64 EOCD 与扩展字段）；
 * zip64 结构缺失或损坏时明确报错，不静默读错。
 * @returns {Array<{name: string, method: number, compSize: number, uncompSize: number, localOffset: number}>}
 */
export function listEntries(buf) {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD（中央目录结尾）')

  let total = buf.readUInt16LE(eocd + 10)
  let cdSize = buf.readUInt32LE(eocd + 12)
  let cdOff = buf.readUInt32LE(eocd + 16)

  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const loc = eocd - 20
    if (loc < 0 || buf.readUInt32LE(loc) !== SIG_EOCD64_LOC) {
      throw new Error('zip64：EOCD 声称 zip64，但找不到 zip64 EOCD 定位器')
    }
    const z64 = Number(buf.readBigUInt64LE(loc + 8))
    if (z64 < 0 || z64 + 56 > buf.length || buf.readUInt32LE(z64) !== SIG_EOCD64) {
      throw new Error('zip64：找不到 zip64 EOCD 记录')
    }
    total = Number(buf.readBigUInt64LE(z64 + 32))
    cdSize = Number(buf.readBigUInt64LE(z64 + 40))
    cdOff = Number(buf.readBigUInt64LE(z64 + 48))
  }

  const entries = []
  const end = Math.min(cdOff + cdSize, buf.length)
  let p = cdOff
  while (p + 46 <= end) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) break
    const method = buf.readUInt16LE(p + 10)
    let compSize = buf.readUInt32LE(p + 20)
    let uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      const extraStart = p + 46 + nameLen
      const z = parseZip64Extra(buf, extraStart, extraLen, {
        uncompSize: uncompSize === 0xffffffff,
        compSize: compSize === 0xffffffff,
        localOffset: localOffset === 0xffffffff,
      })
      if (z.uncompSize !== undefined) uncompSize = z.uncompSize
      if (z.compSize !== undefined) compSize = z.compSize
      if (z.localOffset !== undefined) localOffset = z.localOffset
    }

    entries.push({ name, method, compSize, uncompSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  if (entries.length !== total) {
    throw new Error(`zip 中央目录条目数不符：声明 ${total}，实读 ${entries.length}`)
  }
  return entries
}

/**
 * 读取单个条目的内容。
 * method 0 = stored（原样），method 8 = deflated（raw deflate，无 zlib 头，用 inflateRawSync）。
 */
export function readEntry(buf, entry) {
  const lo = entry.localOffset
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== SIG_LOCAL) {
    throw new Error(`zip 条目本地头签名错误：${entry.name}`)
  }
  const nameLen = buf.readUInt16LE(lo + 26)
  const extraLen = buf.readUInt16LE(lo + 28)
  const dataStart = lo + 30 + nameLen + extraLen
  const raw = buf.subarray(dataStart, dataStart + entry.compSize)
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`zip 条目用了不支持的压缩方式 ${entry.method}：${entry.name}`)
}

/**
 * 从内存里的 zip 字节解出任务书文件到 outDir。
 * @param {Buffer} buf
 * @param {string} outDir
 * @returns {{written: string[], entryCount: number}} written 是落盘相对路径（`/` 分隔）
 */
export function extractFromBuffer(buf, outDir) {
  const entries = listEntries(buf)
  const written = []
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    if (!isQuestFile(entry.name)) continue
    const rel = toOutputPath(entry.name)
    const dest = join(outDir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readEntry(buf, entry))
    written.push(rel)
  }
  return { written, entryCount: entries.length }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const [zipPath, slug] = process.argv.slice(2)
  if (!zipPath || !slug) {
    console.error('用法: node scripts/extract-pack.mjs <zip路径> <slug>')
    process.exit(2)
  }
  if (!existsSync(zipPath)) {
    console.error(`✘ 找不到 zip：${zipPath}`)
    process.exit(1)
  }

  const outDir = join(PACKS_DIR, slug)
  rmSync(outDir, { recursive: true, force: true }) // 幂等：先清空，避免残留旧文件
  mkdirSync(outDir, { recursive: true })

  const { written } = extractFromBuffer(readFileSync(zipPath), outDir)
  const info = classifyLayout(written)
  console.log(`解出 ${written.length} 个文件，判定布局 = ${info.layout}`)
  console.log(`enFiles=${info.enFiles} zhFiles=${info.zhFiles}`)
  if (info.layout === LAYOUT.NONE) console.log('该整合包不含 FTB Quests 任务书')
  process.exit(0)
}
