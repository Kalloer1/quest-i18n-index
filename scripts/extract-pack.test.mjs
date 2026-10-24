/**
 * extract-pack.mjs 的单测：用合成的小 zip（node:zlib 构造最小 zip 字节）覆盖
 * 三种布局、无任务书、stored/deflated 两种压缩方式，以及最关键的——
 * 落盘路径形态必须能被 candidates.mjs 的 classifyLayout 正确匹配。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import {
  isQuestFile, toOutputPath, extractFromBuffer, listEntries, salvageQuestFiles,
} from './extract-pack.mjs'
import { classifyLayout, LAYOUT } from './lib/candidates.mjs'

// ---------- 合成 zip ----------

/** 把若干条目打成最小合法 zip。method 0=stored，8=deflated（默认）。 */
function buildZip(files) {
  const chunks = []
  const central = []
  let offset = 0
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8')
    const method = f.method ?? 8
    const stored = method === 0 ? data : deflateRawSync(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, stored)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt32LE(stored.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)

    offset += local.length + nameBuf.length + stored.length
  }

  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cdBuf, eocd])
}

/** 解到临时目录，返回 {written, layout 信息}，并保证清理。 */
function extractToTemp(files) {
  const dir = mkdtempSync(join(tmpdir(), 'extract-pack-'))
  try {
    const { written } = extractFromBuffer(buildZip(files), dir)
    return { dir, written, info: classifyLayout(written) }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

const SNBT = '{ title: "Hello" }'

// ---------- isQuestFile / toOutputPath ----------

test('isQuestFile：只认任务书相关 .snbt，忽略其他文件', () => {
  assert.equal(isQuestFile('overrides/config/ftbquests/quests/chapters/a.snbt'), true)
  assert.equal(isQuestFile('config/ftbquests/quests/lang/en_us/chapter.snbt'), true)
  assert.equal(isQuestFile('config/ftbquests/quests/lang/en_us.snbt'), true)
  assert.equal(isQuestFile('packs/x/lang/zh_cn.snbt'), true)
  assert.equal(isQuestFile('packs/x/chapters/a.snbt'), true)
  assert.equal(isQuestFile('overrides/config/checklist/checklist.snbt'), false)
  assert.equal(isQuestFile('overrides/mods/foo.jar'), false)
  assert.equal(isQuestFile('overrides/config/ftbquests/quests/readme.txt'), false)
})

test('isQuestFile：非中英语言的**目录**也不解出', () => {
  // 实测 2026-10-20：ATM10 这类包同时带 lang/en_us/ 与 lang/ja_jp/、lang/ko_kr/…
  // 各一整份章节目录。旧实现只拦 `lang/pt_br.snbt` 这种单文件，
  // 目录式外文全部命中 `ftbquests/.*\.snbt` 被解出，33 个包累计 29 MB 噪声
  // （总 38.3 MB 里只有 9.3 MB 是 en_us）。它们既不会进基准键集，
  // 也不该被 release.mjs 提交进仓库。
  const base = 'config/ftbquests/quests/lang'
  for (const lang of ['ja_jp', 'ko_kr', 'es_es', 'fr_fr', 'pt_br', 'pl_pl', 'tr_tr', 'nb_no', 'recovery']) {
    assert.equal(isQuestFile(`${base}/${lang}/chapter.snbt`), false, `${lang} 目录不该解出`)
    assert.equal(isQuestFile(`${base}/${lang}/chapters/a.snbt`), false, `${lang} 章节目录不该解出`)
  }
  // 中英两种照旧解出。
  assert.equal(isQuestFile(`${base}/en_us/chapters/a.snbt`), true)
  assert.equal(isQuestFile(`${base}/zh_cn/chapters/a.snbt`), true)
})

test('toOutputPath：剥掉顶层包装目录与 overrides/，锚定任务书根', () => {
  assert.equal(
    toOutputPath('SkyFactory5-5.0.8/overrides/config/ftbquests/quests/chapters/x.snbt'),
    'config/ftbquests/quests/chapters/x.snbt',
  )
  assert.equal(
    toOutputPath('overrides/config/ftbquests/quests/lang/en_us/chapter.snbt'),
    'config/ftbquests/quests/lang/en_us/chapter.snbt',
  )
  assert.equal(
    toOutputPath('config/ftbquests/quests/chapters/x.snbt'),
    'config/ftbquests/quests/chapters/x.snbt',
  )
  assert.equal(toOutputPath('SomePack/lang/en_us.snbt'), 'lang/en_us.snbt')
})

// ---------- 三种布局 ----------

test('分离·目录布局：解出 lang/en_us/*.snbt，classifyLayout 判定 separate-dir', () => {
  const { dir, written, info } = extractToTemp([
    { name: 'SkyFactory5-5.0.8/overrides/config/ftbquests/quests/lang/en_us/chapter.snbt', data: SNBT },
    { name: 'SkyFactory5-5.0.8/overrides/config/ftbquests/quests/lang/en_us/chapter_group.snbt', data: SNBT },
    { name: 'SkyFactory5-5.0.8/overrides/mods/foo.jar', data: 'ignored' },
  ])
  try {
    assert.deepEqual(written.sort(), [
      'config/ftbquests/quests/lang/en_us/chapter.snbt',
      'config/ftbquests/quests/lang/en_us/chapter_group.snbt',
    ])
    assert.equal(info.layout, LAYOUT.SEPARATE_DIR)
    assert.equal(info.enFiles, 2)
    assert.equal(info.zhFiles, 0)
    // 落盘内容可用
    assert.equal(readFileSync(join(dir, written[0]), 'utf8'), SNBT)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('分离·单文件布局：解出 lang/en_us.snbt，判定 separate-single', () => {
  const { dir, written, info } = extractToTemp([
    { name: 'overrides/config/ftbquests/quests/lang/en_us.snbt', data: SNBT },
    { name: 'overrides/config/ftbquests/quests/lang/zh_cn.snbt', data: SNBT },
  ])
  try {
    assert.deepEqual(written.sort(), [
      'config/ftbquests/quests/lang/en_us.snbt',
      'config/ftbquests/quests/lang/zh_cn.snbt',
    ])
    assert.equal(info.layout, LAYOUT.SEPARATE_SINGLE)
    assert.equal(info.enFiles, 1)
    assert.equal(info.zhFiles, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('内嵌布局：解出 chapters/*.snbt，判定 embedded', () => {
  const { dir, written, info } = extractToTemp([
    { name: 'Pack-1.0/overrides/config/ftbquests/quests/chapters/chapter.snbt', data: SNBT },
    { name: 'Pack-1.0/overrides/config/ftbquests/quests/chapters/aether.snbt', data: SNBT },
  ])
  try {
    assert.deepEqual(written.sort(), [
      'config/ftbquests/quests/chapters/aether.snbt',
      'config/ftbquests/quests/chapters/chapter.snbt',
    ])
    assert.equal(info.layout, LAYOUT.EMBEDDED)
    assert.equal(info.enFiles, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不含任务书：解出 0 个文件，判定 none', () => {
  const { dir, written, info } = extractToTemp([
    { name: 'SkyFactory5-5.0.8/overrides/config/checklist/checklist.snbt', data: SNBT },
    { name: 'SkyFactory5-5.0.8/overrides/mods/foo.jar', data: 'x' },
    { name: 'SkyFactory5-5.0.8/manifest.json', data: '{}' },
  ])
  try {
    assert.deepEqual(written, [])
    assert.equal(info.layout, LAYOUT.NONE)
    assert.equal(info.enFiles, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 压缩方式 ----------

test('stored（method 0）条目也能解出', () => {
  const { dir, written, info } = extractToTemp([
    { name: 'overrides/config/ftbquests/quests/chapters/stored.snbt', data: SNBT, method: 0 },
  ])
  try {
    assert.deepEqual(written, ['config/ftbquests/quests/chapters/stored.snbt'])
    assert.equal(info.layout, LAYOUT.EMBEDDED)
    assert.equal(readFileSync(join(dir, written[0]), 'utf8'), SNBT)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stored 与 deflated 混用：两种都能解出且内容正确', () => {
  const { dir, written } = extractToTemp([
    { name: 'config/ftbquests/quests/chapters/a.snbt', data: '{ title: "A" }', method: 0 },
    { name: 'config/ftbquests/quests/chapters/b.snbt', data: '{ title: "B" }', method: 8 },
  ])
  try {
    assert.deepEqual(written.sort(), [
      'config/ftbquests/quests/chapters/a.snbt',
      'config/ftbquests/quests/chapters/b.snbt',
    ])
    assert.equal(readFileSync(join(dir, 'config/ftbquests/quests/chapters/a.snbt'), 'utf8'), '{ title: "A" }')
    assert.equal(readFileSync(join(dir, 'config/ftbquests/quests/chapters/b.snbt'), 'utf8'), '{ title: "B" }')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 落盘路径形态与 classifyLayout 对齐（最重要） ----------

test('落盘路径形态让 classifyLayout 正确匹配（含包装目录的真实形态）', () => {
  const cases = [
    {
      files: [{ name: 'Pack/overrides/config/ftbquests/quests/lang/en_us/a.snbt', data: SNBT }],
      layout: LAYOUT.SEPARATE_DIR,
    },
    {
      files: [{ name: 'Pack/overrides/config/ftbquests/quests/lang/en_us.snbt', data: SNBT }],
      layout: LAYOUT.SEPARATE_SINGLE,
    },
    {
      files: [{ name: 'Pack/overrides/config/ftbquests/quests/chapters/a.snbt', data: SNBT }],
      layout: LAYOUT.EMBEDDED,
    },
  ]
  for (const c of cases) {
    const { dir, written, info } = extractToTemp(c.files)
    try {
      // 落盘路径不以包装目录开头，且 classifyLayout 判定正确
      assert.ok(!written[0].startsWith('Pack/'), `不应保留包装目录：${written[0]}`)
      assert.ok(!written[0].startsWith('overrides/'), `不应保留 overrides/：${written[0]}`)
      assert.equal(info.layout, c.layout, `${written[0]} 判定应为 ${c.layout}`)
      assert.equal(info.hasQuests, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

// ---------- 幂等 ----------

test('extractFromBuffer 覆盖写：同目录重复解不残留旧文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-pack-'))
  try {
    extractFromBuffer(buildZip([
      { name: 'config/ftbquests/quests/chapters/old.snbt', data: SNBT },
    ]), dir)
    const first = join(dir, 'config/ftbquests/quests/chapters/old.snbt')
    assert.ok(existsSync(first))

    // 第二次换成不同文件；调用方（CLI）负责先清空，这里直接验证清空后的结果
    rmSync(dir, { recursive: true, force: true })
    extractFromBuffer(buildZip([
      { name: 'config/ftbquests/quests/chapters/new.snbt', data: SNBT },
    ]), dir)
    assert.equal(existsSync(first), false)
    assert.ok(existsSync(join(dir, 'config/ftbquests/quests/chapters/new.snbt')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 错误处理 ----------

test('非 zip 输入明确报错', () => {
  assert.throws(() => listEntries(Buffer.from('not a zip at all')), /EOCD/)
})

// ---------- 中央目录失效 → 按原始本地头扫捞（salvage 兜底） ----------
// 2026-10-25 实测（诊断报告 research/tmp/diag-bad6/task-5.md）：fresh-adventures-2
// 官方 mrpack 的 sha1 与发布页一致（包本身就是坏的），但中央目录记的本地头偏移全体
// 错位 5289 字节，readEntry 全部报「本地头签名错误」。14 个 .snbt 的原始本地头完好，
// 按 PK\x03\x04 逐个扫捞全部解出且 parse 全绿。处置参照 lindenfeld（截断 salvage）
// 先例：上游坏但内容可救 → 救，如实记录；不放宽 validate-quests 任何断言。

/** 把中央目录里每个条目的 localOffset 加 delta（模拟 fresh-adventures-2 的偏移错位）。 */
function shiftLocalOffsets(zip, delta) {
  const eocd = zip.length - 22
  let p = zip.readUInt32LE(eocd + 16)
  while (p + 46 <= zip.length && zip.readUInt32LE(p) === 0x02014b50) {
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    zip.writeUInt32LE(zip.readUInt32LE(p + 42) + delta, p + 42)
    p += 46 + nameLen + extraLen + commentLen
  }
}

/** 抹掉 EOCD 签名 → findEocd 找不到 → listEntries 报「找不到 EOCD」。 */
function killEocd(zip) {
  const broken = Buffer.from(zip)
  broken.writeUInt32LE(0, broken.length - 22)
  return broken
}

test('EOCD 被抹掉：按原始本地头扫捞出任务书文件（deflated + stored），如实带 salvaged 标记', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-salvage-'))
  try {
    const zip = killEocd(buildZip([
      { name: 'overrides/config/ftbquests/quests/chapters/a.snbt', data: SNBT },
      { name: 'overrides/config/ftbquests/quests/chapters/b.snbt', data: SNBT, method: 0 },
      { name: 'overrides/mods/foo.jar', data: 'not a quest file' },
    ]))
    const r = extractFromBuffer(zip, dir)
    assert.equal(r.salvaged, true, '必须如实标记走了扫捞，不许假装正常解包')
    assert.match(r.error, /EOCD/)
    assert.deepEqual(r.written.sort(), [
      'config/ftbquests/quests/chapters/a.snbt',
      'config/ftbquests/quests/chapters/b.snbt',
    ])
    assert.equal(readFileSync(join(dir, 'config/ftbquests/quests/chapters/a.snbt'), 'utf8'), SNBT, 'deflated 内容一字不差')
    assert.equal(readFileSync(join(dir, 'config/ftbquests/quests/chapters/b.snbt'), 'utf8'), SNBT, 'stored 内容一字不差')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('中央目录偏移全体错位（fresh-adventures-2 形态）：本地头签名错也能扫出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-salvage-'))
  try {
    const zip = buildZip([
      { name: 'overrides/config/ftbquests/quests/chapters/alexs_caves.snbt', data: SNBT },
    ])
    shiftLocalOffsets(zip, 5289)
    const r = extractFromBuffer(zip, dir)
    assert.equal(r.salvaged, true)
    assert.match(r.error, /本地头签名错误/)
    assert.deepEqual(r.written, ['config/ftbquests/quests/chapters/alexs_caves.snbt'])
    assert.equal(readFileSync(join(dir, 'config/ftbquests/quests/chapters/alexs_caves.snbt'), 'utf8'), SNBT)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('data-descriptor 条目（本地头无尺寸，bit 3）：流式扫捞也能解出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-salvage-'))
  try {
    // 手工构造带数据描述符的条目：本地头 compSize/uncompSize 均为 0，真实尺寸在数据后。
    const name = 'overrides/config/ftbquests/quests/data.snbt'
    const nameBuf = Buffer.from(name, 'utf8')
    const comp = deflateRawSync(Buffer.from(SNBT, 'utf8'))
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0008, 6) // bit 3：数据描述符
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(nameBuf.length, 26)
    const desc = Buffer.alloc(16) // PK\x07\x08 + crc + comp + uncomp（扫捞不读它）
    desc.writeUInt32LE(0x08074b50, 0)
    const zip = killEocd(Buffer.concat([
      local, nameBuf, comp, desc,
      Buffer.from('trailing garbage that is not a zip at all'),
    ]))
    const r = extractFromBuffer(zip, dir)
    assert.equal(r.salvaged, true)
    assert.deepEqual(r.written, ['config/ftbquests/quests/data.snbt'])
    assert.equal(readFileSync(join(dir, 'config/ftbquests/quests/data.snbt'), 'utf8'), SNBT)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('扫捞不出任何任务书文件时抛回原始错误，不制造「成功」的假象', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-salvage-'))
  try {
    assert.throws(() => extractFromBuffer(killEocd(buildZip([
      { name: 'overrides/mods/foo.jar', data: 'no quest files inside' },
    ])), dir), /EOCD/)
    assert.equal(existsSync(join(dir, 'overrides')), false, '没扫出文件就不落盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('正常 zip 不走扫捞（返回值无 salvaged 标记）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-salvage-'))
  try {
    const r = extractFromBuffer(buildZip([
      { name: 'overrides/config/ftbquests/quests/chapters/a.snbt', data: SNBT },
    ]), dir)
    assert.equal(r.salvaged, undefined)
    assert.equal(r.written.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
