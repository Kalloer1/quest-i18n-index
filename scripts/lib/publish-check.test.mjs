/**
 * 发布自检比对函数（scripts/lib/publish-check.mjs）的验收测试。
 *
 * 锁三条口径：树上比计划多 → 报错（计划漏捞，166 个文件静默丢失的教训）；
 * 树上比计划少或相等 → 放行（patchPaths 只含有差异的文件，没变的自然少）；
 * 闸门踢包时 main 树上已有的基准源必须留在工作区（aeronautics-ikaria 被误杀的教训）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPublishCounts, shouldQuarantineBaseline } from './publish-check.mjs'

const plan = {
  a: { branch: 'work', patchPaths: ['patches/a/config/ftbquests/quests/chapters/x.snbt', 'patches/a/config/ftbquests/index.snbt', 'patches/a/README.md'] },
  b: { branch: 'farm1', patchPaths: ['patches/b/one.snbt'] },
}
const tree = {
  work: ['patches/a/config/ftbquests/quests/chapters/x.snbt', 'patches/a/config/ftbquests/index.snbt'],
  farm1: ['patches/b/one.snbt', 'patches/b/hidden.snbt'],
}

test('分支树 .snbt 多于计划 → 报告差异', () => {
  const bad = checkPublishCounts(plan, tree)
  assert.deepEqual(bad, [{ slug: 'b', branch: 'farm1', expected: 1, actual: 2 }])
})

test('树上不多于计划（含相等与更少）→ 放行', () => {
  assert.deepEqual(checkPublishCounts(plan, { work: [...tree.work], farm1: ['patches/b/one.snbt'] }), [])
  assert.deepEqual(checkPublishCounts(plan, { work: ['patches/a/config/ftbquests/index.snbt'], farm1: [] }), [])
})

test('别的 slug 的文件不串包；非 .snbt 不计数', () => {
  const t = { work: ['patches/b/hidden.snbt', 'patches/a/README.md'], farm1: [] }
  assert.deepEqual(checkPublishCounts(plan, t), [])
})

test('shouldQuarantineBaseline：main 树上已有的基准源不得进隔离区（反例锁定，不放宽）', () => {
  // aeronautics-ikaria 的教训：main 已有归档时把它踢进隔离区，工作区缺源、
  // 下一轮闸门报「找不到英文源」把补丁也判死。
  assert.equal(shouldQuarantineBaseline({ existsOnDisk: true, trackedInMain: true }), false)
})

test('shouldQuarantineBaseline：随包新检出的归档（main 没有）照旧隔离', () => {
  assert.equal(shouldQuarantineBaseline({ existsOnDisk: true, trackedInMain: false }), true)
  // 磁盘上没有就无事可做，main 有没有都一样。
  assert.equal(shouldQuarantineBaseline({ existsOnDisk: false, trackedInMain: true }), false)
  assert.equal(shouldQuarantineBaseline({ existsOnDisk: false, trackedInMain: false }), false)
})
