#!/usr/bin/env node
/**
 * 质量闸门 validate-quests 单测：每条失败判据都有「应判失败」的用例。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePair, extractPlaceholders, enSourceName } from './validate-quests.mjs'
import { LAYOUT } from './lib/candidates.mjs'

const EN = [{ name: 'chapters/a.snbt', text: '{ title: "Hello &aWorld" desc: "Get %s apples" }' }]
const OK = [{ name: 'chapters/a.snbt', text: '{ title: "你好 &a世界" desc: "获得 %s 个苹果" }' }]

test('通过：键、色码、占位符全一致', () => {
  const r = validatePair(EN, OK, { layout: LAYOUT.EMBEDDED })
  assert.deepEqual(r.problems, [])
  assert.equal(r.keyCount, 2)
})

test('失败：缺键', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "你好" }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('缺少')))
})

test('失败：多键', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "你好" desc: "x" extra: "多出来的" }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('多出')))
})

test('失败：译文引入畸形色码（& 后不是合法码字符 / 行尾）', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "你好 &z世界" desc: "获得 %s 个苹果&" }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('畸形色码')))
})

test('失败：占位符种类/数量不一致（非 %%）', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "你好 &a世界" desc: "获得 %d 个苹果" }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('占位符不一致')))
})

test('失败：SNBT 结构不可解析', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "未闭合 }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('不可解析')))
})

test('失败：BOM', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '\uFEFF{ title: "你好 &a世界" desc: "获得 %s 个苹果" }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('BOM')))
})

test('失败：找不到英文源（绝不退回自检）', () => {
  const r = validatePair([], OK, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('找不到英文源')))
})

test('警告：色码数量差异不判失败', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "你好 世界" desc: "获得 %s 个苹果" }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.deepEqual(r.problems, [])
  assert.ok(r.warnings.some((w) => w.includes('色码数量不一致')))
})

test('警告：%% 占位符差异不判失败', () => {
  const en = [{ name: 'a.snbt', text: '{ t: "100%% sure" }' }]
  const zh = [{ name: 'a.snbt', text: '{ t: "100% 确定" }' }]
  const r = validatePair(en, zh, { layout: LAYOUT.EMBEDDED })
  assert.deepEqual(r.problems, [])
  assert.ok(r.warnings.some((w) => w.includes('%%')))
})

test('分离布局：键按 en_us ↔ zh_cn 换名后比对', () => {
  const en = [{ name: 'lang/en_us/a.snbt', text: '{ t: "Hi" }' }]
  const zh = [{ name: 'lang/zh_cn/a.snbt', text: '{ t: "嗨" }' }]
  const r = validatePair(en, zh, { layout: LAYOUT.SEPARATE_DIR })
  assert.deepEqual(r.problems, [])
  assert.equal(enSourceName('lang/zh_cn/a.snbt', LAYOUT.SEPARATE_DIR), 'lang/en_us/a.snbt')
  assert.equal(enSourceName('lang/zh_cn.snbt', LAYOUT.SEPARATE_SINGLE), 'lang/en_us.snbt')
})

test('extractPlaceholders：位置参数与包裹式', () => {
  const counts = extractPlaceholders('%1$s of %value% and %s and 100%%')
  assert.equal(counts.get('%1$s'), 1)
  assert.equal(counts.get('%value%'), 1)
  assert.equal(counts.get('%s'), 1)
  assert.equal(counts.get('%%'), 1)
})
