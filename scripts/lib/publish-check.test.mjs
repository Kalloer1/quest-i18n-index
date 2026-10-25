/**
 * 发布自检比对函数（scripts/lib/publish-check.mjs）的验收测试。
 *
 * 锁三条口径：树上比计划多 → 报错（计划漏捞，166 个文件静默丢失的教训）；
 * 树上比计划少或相等 → 放行（patchPaths 只含有差异的文件，没变的自然少）；
 * 闸门踢包时 main 树上已有的基准源必须留在工作区（aeronautics-ikaria 被误杀的教训）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPublishCounts, findStaleSlugs, shouldQuarantineBaseline } from './publish-check.mjs'

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

test('findStaleSlugs：main 已有更新版本的 slug 判陈旧（21 包重影教训，交接 §2.4）', () => {
  const bySlug = {
    stale: { branch: 'ci' },      // main 2000 > 分支 1000 → 跳过
    fresh: { branch: 'work' },    // main 1000 < 分支 3000 → 照常合并
    equal: { branch: 'ci' },      // 相等不跳（内容不新鲜到哪去，但不是「main 更新」）
    onlymain: { branch: 'work' }, // main 有、分支 times 记不到 → fail-open 放行
    onlyfarm: { branch: 'ci' },   // main 没记时（新包）→ 不跳
  }
  const mainTimes = { stale: 2000, fresh: 1000, equal: 1500, onlymain: 900 }
  const farmTimesOf = (branch) =>
    branch === 'ci' ? { stale: 1000, equal: 1500, onlyfarm: 3000 } : { fresh: 3000 }
  assert.deepEqual(findStaleSlugs(bySlug, mainTimes, farmTimesOf), ['stale'])
})

test('findStaleSlugs：分支 times 整体读不到 / 计划为空 → 不误伤', () => {
  const bySlug = { a: { branch: 'farm1' } }
  // 真实调用方里 times 文件读不到时 catch 成 {}（永不抛），这里锁的是 fail-open 口径。
  assert.deepEqual(findStaleSlugs(bySlug, { a: 999 }, () => ({})), [])
  assert.deepEqual(findStaleSlugs({}, { a: 999 }, () => ({ a: 1 })), [])
  assert.deepEqual(findStaleSlugs(undefined, {}, () => ({})), [])
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
