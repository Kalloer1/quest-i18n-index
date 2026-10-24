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
 *
 * 中央目录失效（EOCD 找不到 / 条目数不符 / 本地头签名错位）时，退化到
 * salvageQuestFiles 按原始本地头扫捞 —— 这是窄兑底，不是第二条主路径。
 * @param {Buffer} buf
 * @param {string} outDir
 * @returns {{written: string[], entryCount: number, salvaged?: boolean, error?: string}} written 是落盘相对路径（`/` 分隔）
 */
export function extractFromBuffer(buf, outDir) {
  try {
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
  } catch (err) {
    // 扫不出任何任务书文件就抛回原始错误 —— 兑底失败不是成功。
    const salvaged = salvageQuestFiles(buf, outDir)
    if (salvaged.written.length === 0) throw err
    return { ...salvaged, salvaged: true, error: String(err?.message ?? err) }
  }
}

/** 扫捞时用到的三种边界签名：下一个本地头 / 中央目录头 / 数据描述符。 */
const SCAN_SIGS = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04 本地头
  Buffer.from([0x50, 0x4b, 0x01, 0x02]), // PK\x01\x02 中央目录头
  Buffer.from([0x50, 0x4b, 0x07, 0x08]), // PK\x07\x08 数据描述符
]
const SIG_LOCAL_BYTES = SCAN_SIGS[0]

/** buf 中 from 之后最近的边界签名位置；找不到返回 -1。 */
function nextSignature(buf, from) {
  let best = -1
  for (const sig of SCAN_SIGS) {
    const at = buf.indexOf(sig, from)
    if (at >= 0 && (best < 0 || at < best)) best = at
  }
  return best
}

/**
 * 中央目录失效时的兑底：按原始本地头（PK\x03\x04）逐个扫捞任务书文件。
 *
 * 为什么需要：上游打包工具可能改写条目却不同步中央目录 —— 2026-10-25 实测
 * `fresh-adventures-2` 的官方 mrpack（sha1 与发布页一致，包本身就是坏的）中央目录
 * 记的本地头偏移全体错位 5289 字节，`readEntry` 全部报「本地头签名错误」，整包判死；
 * 但 14 个 .snbt 的原始本地头完好，逐个扫捞全部解出且 parse 全绿
 * （research/tmp/diag-bad6/ 的 fa2-rawscan.py 与诊断报告）。
 * 处置参照 lindenfeld（截断 salvage）先例：上游坏但内容可救 → 救，如实记录。
 *
 * 窄路径，不做泛化：
 *   - 只解 isQuestFile 选中的 .snbt，其他条目不碰；
 *   - 条目名必须全为可见 ASCII（乱字节里的假签名过不了这关）；
 *   - data-descriptor 条目（本地头无尺寸）逐候选边界试 inflate ——
 *     inflateRawSync 在流自然结束即停、忽略尾部多余字节，切多了没关系，
 *     切少了（签名出现在压缩流内部）会抛错，那就换下一个候选；
 *   - 拿不准（解不出 / 尺寸对不上）就跳过该条目，绝不写盘垃圾字节。
 *
 * @param {Buffer} buf
 * @param {string} outDir
 * @returns {{written: string[], entryCount: number}}
 */
export function salvageQuestFiles(buf, outDir) {
  // 先把所有像本地头的位置扫出来（不预判真伪，逐个验证）。
  const headers = []
  let pos = 0
  for (;;) {
    const at = buf.indexOf(SIG_LOCAL_BYTES, pos)
    if (at < 0 || at + 30 > buf.length) break
    const nameLen = buf.readUInt16LE(at + 26)
    const extraLen = buf.readUInt16LE(at + 28)
    const dataStart = at + 30 + nameLen + extraLen
    if (dataStart <= buf.length) {
      headers.push({ at, dataStart, name: buf.toString('utf8', at + 30, at + 30 + nameLen) })
    }
    pos = at + 4 // 压缩数据里也可能出现 PK 字节序列，继续逐字节扫
  }

  const written = []
  const seen = new Set()
  for (const h of headers) {
    // 任务书条目名全是可见 ASCII（ftbquests/…/x.snbt）；含控制字节的灵认为是乱字节里的假签名。
    if (!/^[\x20-\x7e]+$/.test(h.name)) continue
    if (!isQuestFile(h.name)) continue
    const rel = toOutputPath(h.name)
    if (seen.has(rel)) continue
    const data = readRawEntry(buf, h)
    if (!data) continue
    const dest = join(outDir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, data)
    seen.add(rel)
    written.push(rel)
  }
  return { written, entryCount: headers.length }
}

/**
 * 按原始本地头读一个条目（不信任中央目录）。
 * 返回解出的字节；形态不认识 / 解不出 / 尺寸对不上时返回 null（调用方跳过）。
 */
function readRawEntry(buf, { at, dataStart }) {
  const flags = buf.readUInt16LE(at + 6)
  const method = buf.readUInt16LE(at + 8)
  const compSize = buf.readUInt32LE(at + 18)
  const uncompSize = buf.readUInt32LE(at + 22)
  if (method !== 0 && method !== 8) return null

  const decompress = (end) => {
    const raw = buf.subarray(dataStart, end)
    try {
      return method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
    } catch {
      return null // 边界切早了（签名在压缩流内部）或数据真的坏了
    }
  }

  let data
  if (compSize > 0) {
    // 普通条目：本地头自带尺寸，精确切片。
    const end = dataStart + compSize
    if (end > buf.length) return null
    data = decompress(end)
  } else if (flags & 0x08) {
    // data-descriptor 条目：尺寸在数据之后的描述符里，本地头读到 0。
    // 逐候选边界试，第一个能解开的即为流尾（尾部多余字节会被 inflate 忽略）。
    let from = dataStart
    data = null
    for (;;) {
      const end = nextSignature(buf, from)
      if (end < 0 || end <= dataStart) break
      data = decompress(end)
      if (data) break
      from = end + 4
    }
    if (!data) return null
  } else {
    // 无描述符且 compSize=0：空文件。
    data = Buffer.alloc(0)
  }
  // 尺寸对不上说明边界猜错或头是假的，不写盘。
  if (uncompSize > 0 && data.length !== uncompSize) return null
  return data
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
