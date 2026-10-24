/**
 * 发布自检比对函数（scripts/lib/publish-check.mjs）的验收测试。
 *
 * 锁两条口径：树上比计划多 → 报错（计划漏捞，166 个文件静默丢失的教训）；
 * 树上比计划少或相等 → 放行（patchPaths 只含有差异的文件，没变的自然少）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPublishCounts } from './publish-check.mjs'

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
