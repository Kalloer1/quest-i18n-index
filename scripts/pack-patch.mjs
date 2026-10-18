#!/usr/bin/env node
/**
 * 覆盖式补丁包打包（工单 02）：把流水线产出（patches/<slug>/ 下的 .snbt）打成 zip。
 *
 * - zip 内路径与整合包内路径一一对应：解压覆盖到整合包根目录即可生效。
 * - 分离布局包只新增文件（lang/zh_cn/*），不触碰玩家任务数据；内嵌布局是社区通行的
 *   「就地覆盖 chapters/*.snbt」做法（CFPA / VM 汉化组同款）。
 * - 自带 README.txt（「替换前请备份游戏」「上游更新后可能失效」）与 LICENSE.txt
 *   （CC BY-NC-SA 4.0，署名 CFPA 团队与相关模组作者）。
 * - 打包幂等：条目按路径排序、时间戳固定为 1980-01-01，同一输入两次产出逐字节相同。
 *
 * 用法：
 *   import { buildPatch, readZip } from './pack-patch.mjs'
 *   node scripts/pack-patch.mjs <产出目录> <输出 zip>
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const README_TEXT = `任务书汉化补丁（AI 初翻，未人工校对）
=============================================

安装方法：把 zip 内的全部内容解压并覆盖到整合包根目录
（即 config/ 所在的目录）。

注意：
  1. 替换前请备份游戏！覆盖会改写整合包内同名文件。
  2. 上游整合包更新后本补丁可能失效，需等待重新翻译。
  3. 分离语言布局（lang/zh_cn/）只新增文件，不影响原文件；
     内嵌布局（chapters/*.snbt）为覆盖式替换。

问题反馈：任务书汉化索引站
`

/**
 * 内嵌布局包专用 README：比分离布局更强的备份警告。
 * 内嵌包会直接改写玩家已有的 chapters/*.snbt（任务数据文件），
 * 覆盖后无法用「删除新增文件」恢复，必须靠备份回滚。
 */
export const EMBEDDED_README_TEXT = `任务书汉化补丁·内嵌布局覆盖版（AI 初翻，未人工校对）
=====================================================

⚠⚠ 强烈建议：安装前务必备份整个整合包目录（或至少 config/ftbquests/ 整个目录）！⚠⚠

本补丁与普通的语言文件补丁不同：它会【直接改写】你已有的任务文件
（config/ftbquests/quests/chapters/*.snbt），而不是新增文件。

  - 覆盖后无法通过删除补丁文件来恢复原状，只能用备份回滚；
  - 若你或服务器管理员在本地修改过任务（自定义任务、进度、奖励），
    这些修改会被本补丁【覆盖丢失】；
  - 上游整合包更新后本补丁很可能失效（任务结构变化），需要等待重新翻译；
    更新整合包前也请先卸载/回滚本补丁。

安装方法：
  1. 备份 config/ftbquests/ 目录；
  2. 把 zip 内的全部内容解压并覆盖到整合包根目录（即 config/ 所在的目录）。

问题反馈：任务书汉化索引站
`

export const LICENSE_TEXT = `本补丁的翻译部分以 CC BY-NC-SA 4.0（署名-非商业性使用-相同方式共享）授权发布。

署名：
  - 翻译：CFPA 团队（Minecraft-Mod-Language-Package / 任务书汉化索引站）
  - 原始任务书内容版权归相应整合包与模组作者所有：
      FTB Quests —— FTB Team (Feed The Beast)
      以及各整合包作者（见补丁内章节文件所属整合包）

许可证全文：https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.zh-hans
`

// ---------- CRC32 ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// 固定时间戳（1980-01-01 00:00:00）：保证同一输入两次打包逐字节相同。
const DOS_TIME = 0
const DOS_DATE = (1 << 5) | 1 // 年偏移 0（=1980），月 1，日 1

/**
 * 打补丁包：文件条目按路径排序、deflate 压缩，附带 README.txt 与 LICENSE.txt。
 * @param {Array<{name: string, text: string}>} files zip 内路径（/ 分隔）与文本内容
 * @param {{layout?: string}} [options] layout 为 `embedded` 时使用内嵌布局专用 README（更强备份警告）
 * @returns {Buffer}
 */
export function buildPatch(files, { layout } = {}) {
  const readme = layout === 'embedded' ? EMBEDDED_README_TEXT : README_TEXT
  const entries = [
    ...files,
    { name: 'README.txt', text: readme },
    { name: 'LICENSE.txt', text: LICENSE_TEXT },
  ].slice().sort((a, b) => a.name.localeCompare(b.name))

  const seen = new Set()
  const locals = []
  const centrals = []
  let offset = 0
  const u16 = (v) => Buffer.from([v & 0xff, (v >>> 8) & 0xff])
  const u32 = (v) => Buffer.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff])

  for (const { name, text } of entries) {
    if (seen.has(name)) throw new Error(`zip 条目重复：${name}`)
    seen.add(name)
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const method = 8 // deflate
    const comp = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)

    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(method),
      u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(comp.length), u32(data.length),
      u16(nameBuf.length), u16(0), nameBuf,
    ])
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method),
      u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(comp.length), u32(data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ])
    locals.push(local, comp)
    centrals.push(central)
    offset += local.length + comp.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ])
  return Buffer.concat([...locals, centralBuf, eocd])
}

/**
 * 极简 zip 读取（Stored/Deflate，无 zip64）：测试与校验用。
 * @param {Buffer} buf
 * @returns {{names: string[], read: (name: string) => Buffer|null}}
 */
export function readZip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip: 找不到 EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: 中央目录损坏')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOffset = buf.readUInt32LE(off + 42)
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')
    entries.set(name, { method, compSize, localOffset })
    off += 46 + nameLen + extraLen + commentLen
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name)
      if (!e) return null
      const lho = e.localOffset
      if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`zip: 本地头损坏 ${name}`)
      const nameLen = buf.readUInt16LE(lho + 26)
      const extraLen = buf.readUInt16LE(lho + 28)
      const dataStart = lho + 30 + nameLen + extraLen
      const raw = buf.slice(dataStart, dataStart + e.compSize)
      return e.method === 0 ? raw : inflateRawSync(raw)
    },
  }
}

// ---------- CLI ----------

function listFiles(dir, base = dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base).map((n) => `${name}/${n}`))
    else out.push(relative(base, full).replace(/\\/g, '/'))
  }
  return out
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const [dir, outFile] = process.argv.slice(2)
  const embedded = process.argv.includes('--embedded')
  if (!dir || !outFile) {
    console.error('用法: node scripts/pack-patch.mjs <产出目录> <输出 zip> [--embedded]')
    process.exit(2)
  }
  const names = listFiles(dir)
  if (!names.length) {
    console.error(`✘ ${dir} 下没有任何文件`)
    process.exit(1)
  }
  const files = names.map((name) => ({ name, text: readFileSync(join(dir, ...name.split('/')), 'utf8') }))
  const zip = buildPatch(files, { layout: embedded ? 'embedded' : undefined })
  writeFileSync(outFile, zip)
  console.log(`✔ ${outFile}（${names.length} 个任务书文件 + README/LICENSE，${(zip.length / 1024).toFixed(1)} KB）`)
}
