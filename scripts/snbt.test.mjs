import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, serialize, collectStrings, setString, quoteString, SnbtParseError } from './snbt.mjs'

const fixture = (name) => readFileSync(new URL(`./fixtures/snbt/${name}`, import.meta.url), 'utf8')

const FIXTURES = ['syntax.snbt', 'aether.snbt', 'embedded-chapter.snbt']

// ---- 无损往返（工单 02 验证重点）----

test('parse → serialize 逐字节相同（真实整合包样本夹具）', () => {
  for (const name of FIXTURES) {
    const text = fixture(name)
    assert.equal(serialize(parse(text)), text, `${name} 未能无损往返`)
  }
})

test('parse → serialize → parse 结构相同', () => {
  for (const name of FIXTURES) {
    const text = fixture(name)
    const once = parse(text)
    const twice = parse(serialize(once))
    assert.deepEqual(twice, once, `${name} 二次解析结构漂移`)
  }
})

test('未改写的 AST 序列化后与原文件逐字节相同（含注释与空白）', () => {
  const text = fixture('syntax.snbt')
  const root = parse(text)
  assert.match(root.lead, /^# 顶层注释/)
  assert.match(root.trail, /# 末尾注释\n$/)
  assert.equal(serialize(root), text)
})

// ---- 覆盖：字符串转义 ----

test('字符串转义解码：\\" \\\\ \\n \\t \\uXXXX', () => {
  const root = parse(fixture('syntax.snbt'))
  const byPath = new Map(collectStrings(root).map((s) => [s.path, s.node.value]))
  assert.equal(byPath.get('escaped'), 'quote " backslash \\ newline \n tab \t unicode \u00a7')
  assert.equal(byPath.get('singleQuoted'), 'single "quoted" value')
})

test('未知转义原样保留（\\& 字面色码）', () => {
  const root = parse('{ a: "x \\& y" }')
  const node = collectStrings(root)[0].node
  assert.equal(node.value, 'x \\& y')
  assert.equal(serialize(root), '{ a: "x \\& y" }')
})

// ---- 覆盖：数字类型后缀 ----

test('数字类型后缀识别：1b / 2s / 3L / 1.5f / 2.5d / 整型', () => {
  const root = parse(fixture('syntax.snbt'))
  const kinds = {}
  const visit = (node) => {
    if (node.type === 'compound') for (const e of node.entries) {
      if (e.key.type === 'string' && e.value.type === 'number') kinds[e.key.value] = e.value.kind
      visit(e.value)
    } else if (node.type === 'list') for (const it of node.items) visit(it.value)
  }
  visit(root.value)
  assert.equal(kinds.byte, 'byte')
  assert.equal(kinds.short, 'short')
  assert.equal(kinds.long, 'long')
  assert.equal(kinds.float, 'float')
  assert.equal(kinds.double, 'double')
  assert.equal(kinds.int, 'int')
  assert.equal(kinds.negative, 'int')
})

// ---- 覆盖：数组 ----

test('数组：带类型标记 [I; / [B; 与普通 list 都能无损往返', () => {
  const text = '{ a: [I; 1, 2, 3] b: [B; 1b, 2b] c: [1, 2, 3] }'
  const root = parse(text)
  assert.equal(serialize(root), text)
  const list = root.value.entries[0].value
  assert.equal(list.open, '[I;')
  assert.equal(list.items.length, 3)
})

// ---- 覆盖：嵌套 ----

test('嵌套 compound / list 无损往返', () => {
  const text = fixture('embedded-chapter.snbt')
  const root = parse(text)
  assert.equal(serialize(root), text)
  const paths = collectStrings(root).map((s) => s.path)
  assert.ok(paths.includes('quests[0].tasks[0].item'))
  assert.ok(paths.includes('quests[0].description[1]'))
})

// ---- 覆盖：注释与空白 ----

test('注释与空白作为 trivia 保留，不进入键集合', () => {
  const text = '# 头\n{\n\t# 内\n\ta: "v"\n}\n'
  const root = parse(text)
  assert.equal(serialize(root), text)
  assert.deepEqual(collectStrings(root).map((s) => s.path), ['a'])
})

// ---- collectStrings / setString ----

test('collectStrings 只收集值字符串、不收集键，路径按 compound/list 展开', () => {
  const root = parse(fixture('aether.snbt'))
  const paths = collectStrings(root).map((s) => s.path)
  assert.deepEqual(paths, [
    'quest.04833C4BB0CCCBB7.quest_desc[0]',
    'quest.04833C4BB0CCCBB7.title',
    'quest.08E4892F96828EC4.quest_desc[0]',
    'quest.08E4892F96828EC4.quest_desc[1]',
    'quest.08E4892F96828EC4.title',
    'chapter.010F3251541FC7DC.title',
  ])
})

test('setString 改写值并保留引号风格，其余字节不动', () => {
  const text = '{ a: "hello" b: 1b }'
  const root = parse(text)
  const node = collectStrings(root).find((s) => s.path === 'a').node
  setString(node, '你好')
  assert.equal(serialize(root), '{ a: "你好" b: 1b }')
})

test('setString 转义新值里的引号与换行', () => {
  const root = parse('{ a: "old" }')
  setString(collectStrings(root)[0].node, 'line1\nline2 "q"')
  assert.equal(serialize(root), '{ a: "line1\\nline2 \\"q\\"" }')
})

test('quoteString 默认双引号', () => {
  assert.equal(quoteString('a"b'), '"a\\"b"')
  assert.equal(quoteString('a', "'"), "'a'")
})

// ---- 错误处理 ----

test('未闭合的 compound 抛 SnbtParseError', () => {
  assert.throws(() => parse('{ a: 1'), SnbtParseError)
})

test('末尾多余内容抛 SnbtParseError', () => {
  assert.throws(() => parse('{ a: 1 } trailing'), SnbtParseError)
})

test('空输入抛 SnbtParseError', () => {
  assert.throws(() => parse('   '), SnbtParseError)
})
