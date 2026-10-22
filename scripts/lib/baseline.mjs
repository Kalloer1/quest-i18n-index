/**
 * 基准源归档：把 `research/packs/<slug>/` 压成单个 `<slug>.tar.gz`。
 *
 * 为什么自己写 ustar 而不是调系统 tar：
 *   - FreeBSD bsdtar / GNU tar / Windows MSYS tar 对 pax 扩展头、`./` 前缀、
 *     条目排序的处理各不相同，同一目录在不同机器上打出的包字节不同；
 *   - `tar -z` 的 gzip 头会写入当前时间，同内容两次打包字节也不同 → 仓库出现
 *     无意义 diff，且「同输入同输出」的幂等性无法被测试锁住。
 *
 * 本实现固定：条目按相对路径（正斜杠）字典序排序；mode=0644 / uid=0 / gid=0 /
 * uname='' / gname='' / mtime=0；gzip 由 `zlib.gzipSync` 完成（Node 写出的 gzip
 * 头 MTIME 恒为 0）。=> 同一输入两次打包逐字节相同。
 *
 * 读取全程在内存里解压，不落临时目录。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'

const BLOCK = 512
const NAME_MAX = 100
const PREFIX_MAX = 155

/** 递归收集目录下所有文件（相对路径，正斜杠），按字典序排序。 */
function collectFiles(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectFiles(full, base))
    else out.push({ full, name: relative(base, full).replace(/\\/g, '/') })
  }
  // 不用 localeCompare：它随区域设置变化，会破坏跨机器的字节级幂等。
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** 十进制 → 定宽八进制（末尾留 NUL）。 */
function writeOctal(buf, offset, length, value) {
  const digits = length - 1
  const s = value.toString(8)
  if (s.length > digits) {
    throw new Error(`ustar 字段溢出：${value} 需要 ${s.length} 位八进制，字段只有 ${digits} 位`)
  }
  buf.write(s.padStart(digits, '0'), offset, 'ascii')
  buf[offset + digits] = 0
}

function readOctal(buf, offset, length) {
  const raw = buf.toString('ascii', offset, offset + length).replace(/\0.*$/, '').trim()
  if (!raw) return 0
  if (!/^[0-7]+$/.test(raw)) throw new Error(`ustar 八进制字段非法：「${raw}」`)
  return parseInt(raw, 8)
}

/** 读固定宽度字符串字段（遇 NUL 截止）。 */
function readString(buf, offset, length) {
  const raw = buf.toString('utf8', offset, offset + length)
  const i = raw.indexOf('\0')
  return i < 0 ? raw : raw.slice(0, i)
}

/**
 * 长路径拆分：name 字段 100 字节，超出则用 prefix(155) + name 拆分。
 * 两者都放不下时抛错（当前仓库最长包内路径 ~138 字节，能拆开）。
 */
function splitName(name) {
  if (Buffer.byteLength(name) <= NAME_MAX) return { name, prefix: '' }
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue
    const prefix = name.slice(0, i)
    const rest = name.slice(i + 1)
    if (Buffer.byteLength(rest) <= NAME_MAX && Buffer.byteLength(prefix) <= PREFIX_MAX) {
      return { name: rest, prefix }
    }
  }
  throw new Error(`包内路径过长，ustar 无法表示（name>100 且 prefix>155 字节）：${name}`)
}

function buildHeader({ name, size }) {
  const { name: shortName, prefix } = splitName(name)
  const header = Buffer.alloc(BLOCK, 0)

  header.write(shortName, 0, 'utf8')
  writeOctal(header, 100, 8, 0o644) // mode
  writeOctal(header, 108, 8, 0) // uid
  writeOctal(header, 116, 8, 0) // gid
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, 0) // mtime = 0（ephemeral → 可复现）
  header.write('0', 156, 'ascii') // typeflag：普通文件
  // linkname(157..256) 留空
  header.write('ustar', 257, 'ascii')
  header.write('00', 263, 'ascii')
  // uname(265..296) / gname(297..328) 留空
  // devmajor(329..336) / devminor(337..344) 留空
  if (prefix) header.write(prefix, 345, 'utf8')

  // 校验和：chksum 字段先按 8 个空格参与计算，再写 6 位八进制 + NUL + 空格。
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const b of header) sum += b
  header.write(sum.toString(8).padStart(6, '0'), 148, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

/**
 * 把一个目录打成可复现的 tar.gz。
 *
 * @param {string} dir 源目录（其下所有文件，相对路径入包）
 * @param {string} outFile 输出 .tar.gz 路径
 * @returns {{files: number, bytes: number}} 打包条目数与写出字节数
 */
export function packBaseline(dir, outFile) {
  const entries = collectFiles(dir)
  const chunks = []
  for (const entry of entries) {
    const data = readFileSync(entry.full)
    chunks.push(buildHeader({ name: entry.name, size: data.length }), data)
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (pad) chunks.push(Buffer.alloc(pad, 0))
  }
  // 结尾两个全零块标记归档结束。
  chunks.push(Buffer.alloc(BLOCK * 2, 0))
  const tar = Buffer.concat(chunks)
  const gz = gzipSync(tar, { level: 9 })
  writeFileSync(outFile, gz)
  return { files: entries.length, bytes: gz.length }
}

function isZeroBlock(block) {
  for (const b of block) if (b !== 0) return false
  return true
}

/** 解析 ustar 缓冲，返回 [{ name, buffer }]。 */
function parseTar(buf, file) {
  if (buf.length % BLOCK !== 0) {
    throw new Error(`基准源 ${file} 损坏：长度 ${buf.length} 不是 512 的整数倍`)
  }
  const out = []
  let off = 0
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK)
    if (isZeroBlock(header)) break

    // 校验和：读取时同样把 chksum 字段当作 8 个空格。
    const expected = readOctal(header, 148, 8)
    const copy = Buffer.from(header)
    copy.fill(0x20, 148, 156)
    let sum = 0
    for (const b of copy) sum += b
    if (sum !== expected) {
      throw new Error(`基准源 ${file} 损坏：偏移 ${off} 处头部校验和不匹配（${expected} ≠ ${sum}）`)
    }
    if (readString(header, 257, 6) !== 'ustar') {
      throw new Error(`基准源 ${file} 损坏：偏移 ${off} 处不是 ustar 头`)
    }

    const name = readString(header, 0, NAME_MAX)
    const prefix = readString(header, 345, PREFIX_MAX)
    const type = readString(header, 156, 1) || '0'
    const size = readOctal(header, 124, 12)
    const start = off + BLOCK
    const end = start + size
    if (end > buf.length) {
      throw new Error(`基准源 ${file} 损坏：${prefix ? `${prefix}/${name}` : name} 声明 ${size} 字节，实际数据被截断`)
    }
    // 只收普通文件；目录/软链等记账条目跳过。
    if (type === '0' || type === '\0') {
      out.push({ name: prefix ? `${prefix}/${name}` : name, buffer: buf.subarray(start, end) })
    }
    off = start + Math.ceil(size / BLOCK) * BLOCK
  }
  return out
}

/**
 * 读取基准源归档，返回包内文件（utf8 文本）。内存解压，不落临时目录。
 *
 * @param {string} file .tar.gz 路径
 * @returns {Array<{name: string, text: string}>}
 */
export function readBaseline(file) {
  let buf
  try {
    buf = gunzipSync(readFileSync(file))
  } catch (err) {
    throw new Error(`基准源 ${file} 无法解压：${err.message}`)
  }
  return parseTar(buf, file).map((e) => ({ name: e.name, text: e.buffer.toString('utf8') }))
}

/**
 * 只列包内路径（监工/诊断用，不解码文本）。
 *
 * @param {string} file .tar.gz 路径
 * @returns {string[]}
 */
export function listBaseline(file) {
  let buf
  try {
    buf = gunzipSync(readFileSync(file))
  } catch (err) {
    throw new Error(`基准源 ${file} 无法解压：${err.message}`)
  }
  return parseTar(buf, file).map((e) => e.name)
}
