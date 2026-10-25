/**
 * `scripts/scan-packs.mjs` 纯函数的测试。
 *
 * 背景（交接 §4.5 / 2026-10-25 收官场）：probeLayoutCounts 里出现过两行
 * 「error:Cannot read properties of undefined (rea」——Modrinth 项目一个版本
 * 都没有时 `vs[0]` 是 undefined，`v.files` 抛 TypeError，错误文案被
 * `'error:' + e.message.slice(0, 40)` 从中截断成无法归类的脏键。
 * 修法是源头消除：pickMrpackFile 对空列表/无文件一律返回 null，调用方按
 * nodl 记账（与 CurseForge 侧「无下载地址」同口径），不再让 TypeError 进 error 键。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickMrpackFile } from './scan-packs.mjs'

test('pickMrpackFile：空版本列表 / 非数组 → null（截断脏键的源头）', () => {
  // 事故现场：项目刚建或已清空，version 接口返回 []。
  assert.equal(pickMrpackFile([]), null)
  assert.equal(pickMrpackFile(undefined), null)
  assert.equal(pickMrpackFile('garbage'), null)
})

test('pickMrpackFile：优先 .mrpack，否则退回第一个文件', () => {
  const mrpack = { filename: 'pack.mrpack', url: 'https://cdn/x.mrpack', size: 10 }
  const zip = { filename: 'pack.zip', url: 'https://cdn/x.zip', size: 20 }
  assert.equal(pickMrpackFile([{ files: [zip, mrpack] }]), mrpack)
  assert.equal(pickMrpackFile([{ files: [zip] }]), zip)
})

test('pickMrpackFile：版本没有 files 字段 / files 为空 → null，不抛', () => {
  assert.equal(pickMrpackFile([{}]), null)
  assert.equal(pickMrpackFile([{ files: [] }]), null)
  // 非 mrpack 文件按原语义退回第一个（调用方再按 url 缺失与否决定 nodl），不算异常。
  assert.equal(pickMrpackFile([{ files: [{ filename: 'readme.txt' }] }]).filename, 'readme.txt')
})

test('pickMrpackFile：前面的版本缺 files 不挡住后面的合格版本', () => {
  const mrpack = { filename: 'pack.mrpack', url: 'https://cdn/x.mrpack', size: 1 }
  assert.equal(pickMrpackFile([{ files: null }, { files: [mrpack] }]), mrpack)
})
