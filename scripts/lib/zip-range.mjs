#!/usr/bin/env node
/**
 * 只读 zip 中央目录（HTTP Range）——`scan-packs.mjs` 与 `prepare-pack.mjs` 共用一份实现。
 *
 * ## 为什么抽成模块
 * 这段「HEAD 拿总长 → Range 读尾部找 EOCD → Range 读中央目录」的代码原本只存在于
 * `scan-packs.mjs`，`rescan-producible.mjs` 又抄了一份。本仓库已经踩过这种重复的坑：
 * `scan-packs.mjs` 曾复制过一份布局分类器，只把 `lang/en_us/*` 算进 enFiles，
 * 内嵌格式于是恒为 0，213 个内嵌包被静默判成「找不到英文源」跳过
 * （2000 条扫描里 66% 的可做工作被丢弃，表面还显示 ok / failed 0）。
 * 现在 `prepare-pack` 也要用同一套中央目录解析，**不能再抄第二份**：
 * 抄一份就意味着以后修 zip64 要修两处，漏一处就是静默读错偏移。
 *
 * ## 为什么值钱
 * 整包 1392 MB 对应的语言文件只有 6.3 MB（41 个已解包包实测，占 0.453%）。
 * 一次中央目录 Range 约 0.3~0.6 MB，一个目标文件再 1 次 Range —— 346 个包
 * 合计约 384 次文件 Range / 67 MB，而整包下载要 14.8 GB。
 *
 * 所有函数都接受 `fetchImpl` 注入：`scan-packs.mjs` 传它自己的重试包装，
 * 单测传合成 CDN 桩，不联网。
 */

import { inflateRawSync } from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOC = 0x07064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** EOCD 最大 22 字节 + 最大注释 65535 字节；尾部读这么多一定能覆盖到 EOCD。 */
const TAIL_BYTES = 65557

/**
 * 本地头解析时预留的余量：本地头的 name/extra 长度不一定等于中央目录里的，
 * 所以一次多读 1 KB，避免为每个文件多发一次「只读 30 字节头」的 Range。
 * 1 KB × 384 次 = 384 KB，比多 384 次往返便宜得多。
 */
const LOCAL_SLACK = 1024

/**
 * HEAD 取总长与最终 URL（CDN 会 302 到实际存储域名，Range 必须打到最终地址）。
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, headers?: object}} [options]
 * @returns {Promise<{length: number, finalUrl: string}>}
 */
export async function head(url, { fetchImpl = fetch, headers = {} } = {}) {
  const res = await fetchImpl(url, { method: 'HEAD', headers, redirect: 'follow' })
  if (!res.ok) throw new Error(`HEAD ${res.status}`)
  const length = Number(res.headers.get('content-length'))
  if (!Number.isFinite(length) || length <= 0) throw new Error('HEAD 未返回 content-length')
  return { length, finalUrl: res.url || url }
}

/**
 * 取闭区间字节。CDN 不支持 Range（忽略 Range 头回 200 + 整包）时明确失败，
 * 由调用方决定是否回退整包下载 —— 静默接受 200 会把整包读进内存，正是要避免的。
 * @param {string} url
 * @param {number} start
 * @param {number} end
 * @param {{fetchImpl?: typeof fetch, headers?: object}} [options]
 * @returns {Promise<Buffer>}
 */
export async function getRange(url, start, end, { fetchImpl = fetch, headers = {} } = {}) {
  const res = await fetchImpl(url, { headers: { ...headers, Range: `bytes=${start}-${end}` } })
  if (res.status !== 206) throw new Error(`Range 请求未返回 206（实际 ${res.status}，CDN 可能不支持 Range）`)
  return Buffer.from(await res.arrayBuffer())
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
 * 从尾部缓冲里定位 zip64 EOCD 记录（相对 tail 的偏移），找不到返回 -1。
 * 先按规范读 EOCD 前 20 字节的定位器；定位器指到尾部窗口之外时
 * （超大的中央目录，尾部窗口盖不住）再退化成反向扫签名。
 */
function findZip64Eocd(tail, tailStart, eocd) {
  const loc = eocd - 20
  if (loc >= 0 && tail.readUInt32LE(loc) === SIG_EOCD64_LOC) {
    const abs = Number(tail.readBigUInt64LE(loc + 8))
    const rel = abs - tailStart
    if (rel >= 0 && rel + 56 <= tail.length && tail.readUInt32LE(rel) === SIG_EOCD64) return rel
  }
  for (let i = eocd - 20; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD64) return i
  return -1
}

/** 解析中央目录字节，返回条目列表（支持 zip64 扩展字段）。 */
function parseCentralDirectory(cd) {
  const entries = []
  let p = 0
  while (p + 46 <= cd.length) {
    if (cd.readUInt32LE(p) !== SIG_CENTRAL) break
    const method = cd.readUInt16LE(p + 10)
    let compSize = cd.readUInt32LE(p + 20)
    let uncompSize = cd.readUInt32LE(p + 24)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    let localOffset = cd.readUInt32LE(p + 42)
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen)

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      const z = parseZip64Extra(cd, p + 46 + nameLen, extraLen, {
        uncompSize: uncompSize === 0xffffffff,
        compSize: compSize === 0xffffffff,
        localOffset: localOffset === 0xffffffff,
      })
      if (z.uncompSize !== undefined) uncompSize = z.uncompSize
      if (z.compSize !== undefined) compSize = z.compSize
      if (z.localOffset !== undefined) localOffset = z.localOffset
    }

    entries.push({ name, method, compressedSize: compSize, uncompressedSize: uncompSize, localHeaderOffset: localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * 只读中央目录，返回全部条目（含定位压缩数据所需的三元组）。
 *
 * 返回 `{name, method, compressedSize, uncompressedSize, localHeaderOffset}`：
 * 光有文件名不够 —— 要按需取单个文件的内容，必须知道它的压缩方式、
 * 压缩后长度与本地头偏移。
 *
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, headers?: object}} [options]
 * @returns {Promise<{totalBytes: number, cdBytes: number, finalUrl: string, entries: Array<{name: string, method: number, compressedSize: number, uncompressedSize: number, localHeaderOffset: number}>}>}
 */
export async function listZip(url, { fetchImpl = fetch, headers = {} } = {}) {
  const { length, finalUrl } = await head(url, { fetchImpl, headers })
  const tailLen = Math.min(TAIL_BYTES, length)
  const tailStart = length - tailLen
  const tail = await getRange(finalUrl, tailStart, length - 1, { fetchImpl, headers })

  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD（中央目录结尾）')

  let cdSize = tail.readUInt32LE(eocd + 12)
  let cdOff = tail.readUInt32LE(eocd + 16)
  if (tail.readUInt16LE(eocd + 10) === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const z = findZip64Eocd(tail, tailStart, eocd)
    if (z < 0) throw new Error('zip64：EOCD 声称 zip64，但找不到 zip64 EOCD 记录')
    cdSize = Number(tail.readBigUInt64LE(z + 40))
    cdOff = Number(tail.readBigUInt64LE(z + 48))
  }
  if (!(cdSize > 0) || cdOff + cdSize > length) {
    throw new Error(`中央目录偏移越界（offset=${cdOff} size=${cdSize} total=${length}）`)
  }

  const cd = await getRange(finalUrl, cdOff, cdOff + cdSize - 1, { fetchImpl, headers })
  return { totalBytes: length, cdBytes: cdSize, finalUrl, entries: parseCentralDirectory(cd) }
}

/**
 * 读单个条目的内容：1 次 Range 取「本地头 + 压缩数据」，再按 method 还原。
 *
 * method 0 = stored（原样切）；method 8 = deflated（raw deflate，无 zlib 头，
 * 故用 `inflateRawSync` 而不是 `inflateSync`）。其余方式明确报错，不猜。
 *
 * @param {string} url
 * @param {{name: string, method: number, compressedSize: number, localHeaderOffset: number}} entry
 * @param {{fetchImpl?: typeof fetch, headers?: object, totalBytes?: number}} [options]
 * @returns {Promise<Buffer>}
 */
export async function readZipEntry(url, entry, { fetchImpl = fetch, headers = {}, totalBytes = Infinity } = {}) {
  const lo = entry.localHeaderOffset
  // 本地头的 name/extra 长度以本地头自身为准（规范允许与中央目录不同），
  // 所以先按「30 + 压缩长度 + 余量」多读一点，happy path 只花 1 次 Range。
  const end = Math.min(totalBytes - 1, lo + 30 + entry.compressedSize + LOCAL_SLACK - 1)
  let buf = await getRange(url, lo, end, { fetchImpl, headers })

  if (buf.length < 30 || buf.readUInt32LE(0) !== SIG_LOCAL) {
    throw new Error(`zip 条目本地头签名错误：${entry.name}`)
  }
  let dataStart = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28)
  if (dataStart + entry.compressedSize > buf.length) {
    // 本地扩展字段异常大（> 余量）：补一次精确 Range，不猜偏移。
    const preciseEnd = Math.min(totalBytes - 1, lo + dataStart + entry.compressedSize - 1)
    buf = await getRange(url, lo, preciseEnd, { fetchImpl, headers })
    dataStart = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28)
    if (dataStart + entry.compressedSize > buf.length) {
      throw new Error(`zip 条目数据被截断：${entry.name}`)
    }
  }

  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`zip 条目用了不支持的压缩方式 ${entry.method}：${entry.name}`)
}

/**
 * 只取匹配的文件并解成 utf8 文本，全程 Range，不下载整包。
 *
 * @param {string} url
 * @param {{filter?: (name: string) => boolean, fetchImpl?: typeof fetch, headers?: object}} [options]
 * @returns {Promise<Array<{name: string, text: string}>>}
 */
export async function fetchZipTexts(url, { filter = () => true, fetchImpl = fetch, headers = {} } = {}) {
  const { totalBytes, finalUrl, entries } = await listZip(url, { fetchImpl, headers })
  // HEAD 会跟随 302 到实际存储域名；后续 Range 必须继续打最终地址，
  // 否则每个文件都再吃一次重定向。
  const targets = entries.filter((e) => !e.name.endsWith('/') && filter(e.name))
  const out = []
  for (const entry of targets) {
    const buf = await readZipEntry(finalUrl, entry, { fetchImpl, headers, totalBytes })
    out.push({ name: entry.name, text: buf.toString('utf8') })
  }
  return out
}
