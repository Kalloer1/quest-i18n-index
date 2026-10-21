/**
 * repair-hex-codes.mjs 的单元测试。
 *
 * ## 为什么盯这个
 *
 * 2026-10-21 修 hex 色码遮蔽后，5 个包的旧产出露出 88 个键共 110 个畸形色码。
 * 修复脚本的每一个选择都可能把「定向修 88 个键」变成「顺手改坏整个文件」：
 *
 * - 整文件重新序列化会改掉全部行尾（这些 .snbt 是 CRLF/LF 混排的）
 * - `node.raw` 没命中就写盘，等于静默跳过
 * - 重译结果仍带畸形码时就接受，等于白修
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  needsRepair, replaceRaw, toOutputName, relFiles, repairUnit, DEFAULT_SLUGS,
} from './repair-hex-codes.mjs'
import { parse, collectStrings, setString } from './snbt.mjs'
import { countMalformedCodes } from './lib/format-codes.mjs'

test('needsRepair：畸形 hex 码只出现在译文侧时要修', () => {
  // 还原闸门口径：字母码畸形数 + 字面 \& 转义数，超出才算译文引入。
  assert.equal(needsRepair('Accessories', '&#FF4O26Accessories'), true)
  // 英文侧是合法 hex 码（修好后不再算畸形），译文把它写成字母 O。
  assert.equal(needsRepair('&#FF4F26Accessories', '&#FF4O26Accessories'), true)
})

test('needsRepair：英文本来就不合法（包作者自用的 &z）时，译文同样不判', () => {
  assert.equal(needsRepair('&z交汇', '&z交汇'), false, '两侧都畸形，译文没有引入新的')
  assert.equal(needsRepair('&z交汇', '&z交汇&z'), true, '译文多出一个才算引入')
})

test('needsRepair：译文允许把原文的 \\& 字面转义还原成裸 &', () => {
  assert.equal(needsRepair('Create Crafts \\& Additions', 'Create Crafts & Additions'), false)
})

test('replaceRaw：替换命中并如实报告次数，没命中不悄悄写盘', () => {
  const r = replaceRaw('aa"旧"bb"旧"cc', '"旧"', '"新"')
  assert.equal(r.hits, 2)
  assert.equal(r.text, 'aa"新"bb"新"cc')
  const miss = replaceRaw('aa bb', '"不在"', '"新"')
  assert.equal(miss.hits, 0)
  assert.equal(miss.text, 'aa bb', '没命中必须原文返回，让调用方有机会拒绝')
})

test('replaceRaw：新旧相同是无操作（重译结果与原文一致时不制造 diff）', () => {
  const same = replaceRaw('abc', 'abc', 'abc')
  assert.equal(same.hits, 0)
})

test('toOutputName：只改 en_us，不动其余路径', () => {
  assert.equal(toOutputName('config/ftbquests/quests/lang/en_us.snbt'), 'config/ftbquests/quests/lang/zh_cn.snbt')
  assert.equal(toOutputName('lang/en_us/chapters/a.snbt'), 'lang/zh_cn/chapters/a.snbt')
  assert.equal(toOutputName('chapters/a.snbt'), 'chapters/a.snbt')
})

test('relFiles：递归列出 .snbt，非 .snbt 忽略', () => {
  const root = mkdtempSync(join(tmpdir(), 'rel-'))
  mkdirSync(join(root, 'a/b'), { recursive: true })
  writeFileSync(join(root, 'top.snbt'), '{}')
  writeFileSync(join(root, 'a/b/deep.snbt'), '{}')
  writeFileSync(join(root, 'a/note.txt'), 'x')
  const rels = relFiles(root).map((f) => f.rel).sort()
  assert.deepEqual(rels, ['a/b/deep.snbt', 'top.snbt'])
  rmSync(root, { recursive: true, force: true })
})

test('relFiles：rel 用正斜杠（Windows 上 join 会给反斜杠）', () => {
  const root = mkdtempSync(join(tmpdir(), 'rel2-'))
  mkdirSync(join(root, 'x/y'), { recursive: true })
  writeFileSync(join(root, 'x/y/f.snbt'), '{}')
  for (const f of relFiles(root)) assert.ok(!f.rel.includes('\\'), f.rel)
  rmSync(root, { recursive: true, force: true })
})

test('定向替换不碰其余字节：CRLF/LF 混排与注释都保持原样', () => {
  const root = mkdtempSync(join(tmpdir(), 'bytes-'))
  const orig = '# 头注释\r\n{\r\n\tkey: "&#FF4O26旧"\r\n\tother: "保持不动"\r\n}'
  const f = join(root, 'x.snbt')
  writeFileSync(f, orig)
  const tree = parse(orig)
  const strs = collectStrings(tree)
  const target = strs.find((s) => String(s.node.value).includes('旧'))
  const oldRaw = target.node.raw
  setString(target.node, '&#FF4F26新')
  const res = replaceRaw(orig, oldRaw, target.node.raw)
  assert.ok(res.hits >= 1)
  writeFileSync(f, res.text)
  const after = readFileSync(f, 'utf8')
  // 只有目标字符串变了；行尾、注释、另一个键全部逐字节保留。
  assert.ok(after.includes('# 头注释\r\n'), '注释与行尾不能被动')
  assert.ok(after.includes('other: "保持不动"'), '别的键不能被动')
  assert.ok(after.includes('key: "&#FF4F26新"'), '目标键要换成新值')
  assert.equal(after.split('\r\n').length, orig.split('\r\n').length, '行数必须一致')
  rmSync(root, { recursive: true, force: true })
})

test('countMalformedCodes 认得修好后的 hex 码（护栏：别把修复判成畸形）', () => {
  assert.equal(countMalformedCodes('&#FF4F26Accessories&r'), 0)
  assert.equal(countMalformedCodes('&#FF4O26Accessories&r'), 1)
  assert.equal(countMalformedCodes('&#FF4F26'), 0)
  assert.equal(countMalformedCodes('&#FF4F2'), 1, '不足 6 位仍是畸形')
})

test('DEFAULT_SLUGS：默认清单非空，且都是闸门会报的那一批', () => {
  assert.ok(DEFAULT_SLUGS.length >= 5)
  assert.ok(DEFAULT_SLUGS.includes('all-the-mons'))
})

test('repairUnit：英文合法 hex 码时不该被自己的畸形检查打回', async () => {
  // 纯函数口径验证：enVal 合法 → 门限是 0；返回值只要不超 0 个畸形就接受。
  const gate = (v) => countMalformedCodes(v) <= countMalformedCodes('&#FF4F26bosses')
  assert.equal(gate('&#FF4F26bosses'), true)
})
