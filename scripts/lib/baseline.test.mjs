/**
 * 基准源归档（scripts/lib/baseline.mjs）的验收测试。
 *
 * 重点锁住三件事：
 *   - 往返无损：CRLF 与中文内容逐字节还原；
 *   - 幂等：同目录两次打包 sha256 相同（否则仓库每次发布都产生无意义 diff）；
 *   - 损坏文件要抛明确错误，不能静默返回空数组（静默空 = 闸门假绿灯）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { packBaseline, readBaseline, listBaseline } from './baseline.mjs'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'quest-baseline-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

test('packBaseline/readBaseline：多层嵌套 + 中文内容 + CRLF 往返无损', (t) => {
  const dir = tempDir(t)
  const src = join(dir, 'pack')
  const files = {
    'config/ftbquests/quests/data.snbt': '{ title: "主章节" }\n',
    'config/ftbquests/quests/chapters/01_start.snbt': '{\r\n\tquests: [\r\n\t\t{ title: "入门任务 &a" }\r\n\t]\r\n}\r\n',
    'config/ftbquests/quests/chapters/deep/nest/02_more.snbt': '{ title: "深层任务 · 中文标点，ok" }\n',
  }
  writeTree(src, files)
  const out = join(dir, 'pack.tar.gz')
  const stat = packBaseline(src, out)
  assert.equal(stat.files, 3)

  const back = readBaseline(out)
  assert.deepEqual(back.map((f) => f.name), [
    'config/ftbquests/quests/chapters/01_start.snbt',
    'config/ftbquests/quests/chapters/deep/nest/02_more.snbt',
    'config/ftbquests/quests/data.snbt',
  ])
  const byName = new Map(back.map((f) => [f.name, f.text]))
  // CRLF 必须原样保留：闸门按文本比对，丢 \r 会改变键值。
  assert.equal(byName.get('config/ftbquests/quests/chapters/01_start.snbt'), files['config/ftbquests/quests/chapters/01_start.snbt'])
  assert.equal(byName.get('config/ftbquests/quests/data.snbt'), files['config/ftbquests/quests/data.snbt'])
  assert.equal(byName.get('config/ftbquests/quests/chapters/deep/nest/02_more.snbt'), files['config/ftbquests/quests/chapters/deep/nest/02_more.snbt'])
})

test('packBaseline：同一目录两次打包 sha256 相同（幂等）', (t) => {
  const dir = tempDir(t)
  const src = join(dir, 'pack')
  writeTree(src, {
    'b.snbt': '{ b: 1 }\n',
    'a/x.snbt': '{ a: 1 }\n',
    'a/y/z.snbt': '{ z: 1 }\n',
  })
  const one = join(dir, 'one.tar.gz')
  const two = join(dir, 'two.tar.gz')
  packBaseline(src, one)
  packBaseline(src, two)
  assert.equal(sha(one), sha(two))
})

test('packBaseline：条目顺序与文件系统返回顺序无关（字典序）', (t) => {
  const dir = tempDir(t)
  const a = join(dir, 'a')
  const b = join(dir, 'b')
  // 同样的内容，写入顺序相反 → 归档字节必须相同（跨平台 tar 排序差异的老问题）。
  writeTree(a, { 'z.snbt': 'z', 'm.snbt': 'm', 'a.snbt': 'a' })
  writeTree(b, { 'a.snbt': 'a', 'm.snbt': 'm', 'z.snbt': 'z' })
  const fa = join(dir, 'a.tar.gz')
  const fb = join(dir, 'b.tar.gz')
  packBaseline(a, fa)
  packBaseline(b, fb)
  assert.equal(sha(fa), sha(fb))
  assert.deepEqual(listBaseline(fa), ['a.snbt', 'm.snbt', 'z.snbt'])
})

test('packBaseline：空目录产出可读归档（0 条目）', (t) => {
  const dir = tempDir(t)
  const src = join(dir, 'empty')
  mkdirSync(src, { recursive: true })
  const out = join(dir, 'empty.tar.gz')
  assert.equal(packBaseline(src, out).files, 0)
  assert.deepEqual(readBaseline(out), [])
  assert.deepEqual(listBaseline(out), [])
})

test('packBaseline：单文件 + 空文件（0 字节）往返', (t) => {
  const dir = tempDir(t)
  const src = join(dir, 'pack')
  writeTree(src, { 'only.snbt': '{ a: 1 }', 'zero.snbt': '' })
  const out = join(dir, 'one.tar.gz')
  packBaseline(src, out)
  const back = readBaseline(out)
  assert.deepEqual(back, [
    { name: 'only.snbt', text: '{ a: 1 }' },
    { name: 'zero.snbt', text: '' },
  ])
})

test('packBaseline：长路径用 prefix 拆分（90~120 字节）且往返一致', (t) => {
  const dir = tempDir(t)
  const src = join(dir, 'pack')
  const exactly100 = `${'z'.repeat(95)}.snbt` // 正好 100 字节：应直接放 name 字段
  const ninety = `a/${'b'.repeat(90)}.snbt` // 92 字节：不触发拆分
  const split = `deep/nested/${'x'.repeat(95)}.snbt` // 112 字节：prefix=deep/nested, name=100
  writeTree(src, {
    [exactly100]: '1',
    [ninety]: '2',
    [split]: '3',
  })
  const out = join(dir, 'long.tar.gz')
  packBaseline(src, out)
  const back = readBaseline(out)
  assert.equal(back.length, 3)
  const names = back.map((f) => f.name)
  assert.ok(names.includes(exactly100))
  assert.ok(names.includes(ninety))
  assert.ok(names.includes(split))
  // 拆分后名字必须拼回原样（不能多/少斜杠）。
  assert.equal(back.find((f) => f.name === split).text, '3')
  assert.ok(back.every((f) => !f.name.includes('\\')), '包内路径必须用正斜杠')
})

test('packBaseline：路径超出 ustar 容量（>255 字节）时抛明确错误', (t) => {
  const dir = tempDir(t)
  const src = join(dir, 'pack')
  writeTree(src, { [`${'q'.repeat(240)}.snbt`]: 'x' })
  const out = join(dir, 'bad.tar.gz')
  assert.throws(() => packBaseline(src, out), /路径过长/)
})

test('readBaseline：损坏的 gzip 抛明确错误，不静默返回空', (t) => {
  const dir = tempDir(t)
  const bad = join(dir, 'bad.tar.gz')
  writeFileSync(bad, Buffer.from('这不是 gzip 数据'))
  assert.throws(() => readBaseline(bad), /无法解压/)
  assert.throws(() => listBaseline(bad), /无法解压/)
})

test('readBaseline：gzip 正常但 ustar 校验和损坏时抛错', (t) => {
  const dir = tempDir(t)
  const src = join(dir, 'pack')
  writeTree(src, { 'a.snbt': '{ a: 1 }' })
  const good = join(dir, 'good.tar.gz')
  packBaseline(src, good)

  // 解压后翻转头部一个字节，再重新 gzip：结构仍是 tar，但校验和对不上。
  const tar = gunzipSync(readFileSync(good))
  tar[0] = tar[0] === 0x61 ? 0x62 : 0x61
  const bad = join(dir, 'corrupt.tar.gz')
  writeFileSync(bad, gzipSync(tar))
  assert.throws(() => readBaseline(bad), /校验和不匹配/)
})

test('readBaseline：数据被截断时抛错（不返回半个文件）', (t) => {
  const dir = tempDir(t)
  const src = join(dir, 'pack')
  writeTree(src, { 'a.snbt': 'x'.repeat(400) })
  const good = join(dir, 'good.tar.gz')
  packBaseline(src, good)

  const tar = gunzipSync(readFileSync(good))
  const bad = join(dir, 'truncated.tar.gz')
  // 保留头部 + 一半数据，去掉结尾的零块。
  writeFileSync(bad, gzipSync(tar.subarray(0, 512 + 200)))
  assert.throws(() => readBaseline(bad), /损坏/)
})
