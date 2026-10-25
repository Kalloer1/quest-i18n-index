#!/usr/bin/env node
/**
 * scripts/lib/farm-merge.mjs 的单测：分支增量 → 合并计划的纯函数行为。
 * 直接跑：node --test scripts/lib/farm-merge.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDiffPaths, classifyPath, collectBranchPaths, mergeFarm, serializePlan,
  isQualified, isValidHost,
} from './farm-merge.mjs'

const diffOf = (...paths) => `${paths.join('\n')}\n`

test('单分支正常：一个 slug 的译文与基准源被配对', () => {
  const plan = mergeFarm([{
    host: 'gfdrgfd',
    diff: diffOf(
      'patches/aoc/lang/en_us.snbt',
      'patches/aoc/lang/zh_cn.snbt',
      'research/packs/aoc.tar.gz',
    ),
    times: { aoc: '2026-10-01T00:00:00Z' },
  }])

  assert.equal(plan.conflicts.length, 0)
  assert.equal(plan.skipped.length, 0)
  assert.deepEqual([...plan.bySlug.keys()], ['aoc'])
  assert.deepEqual(plan.bySlug.get('aoc'), {
    branch: 'gfdrgfd',
    patchPaths: ['patches/aoc/lang/en_us.snbt', 'patches/aoc/lang/zh_cn.snbt'],
    baselinePath: 'research/packs/aoc.tar.gz',
  })
})

test('同一 slug 出现在两条分支：取最后提交更新的，另一条进 conflicts（不判失败）', () => {
  const plan = mergeFarm([
    { host: 'gfdrgfd', diff: diffOf('patches/aoc/lang/zh_cn.snbt', 'research/packs/aoc.tar.gz'), times: { aoc: '2026-10-01T00:00:00Z' } },
    { host: 'podsjk', diff: diffOf('patches/aoc/lang/zh_cn.snbt', 'research/packs/aoc.tar.gz'), times: { aoc: '2026-10-02T00:00:00Z' } },
  ])

  assert.equal(plan.bySlug.get('aoc').branch, 'podsjk')
  assert.equal(plan.skipped.length, 0)
  assert.equal(plan.conflicts.length, 1)
  assert.equal(plan.conflicts[0].slug, 'aoc')
  assert.equal(plan.conflicts[0].winning, 'podsjk')
  assert.deepEqual(plan.conflicts[0].losers, ['gfdrgfd'])
  assert.match(plan.conflicts[0].reason, /podsjk/)
})

test('时间相同按主机名字典序定胜负，结果与输入顺序无关', () => {
  const same = '2026-10-01T00:00:00Z'
  const a = mergeFarm([
    { host: 'podsjk', diff: diffOf('patches/x/a.snbt', 'research/packs/x.tar.gz'), times: { x: same } },
    { host: 'gfdrgfd', diff: diffOf('patches/x/a.snbt', 'research/packs/x.tar.gz'), times: { x: same } },
  ])
  const b = mergeFarm([
    { host: 'gfdrgfd', diff: diffOf('patches/x/a.snbt', 'research/packs/x.tar.gz'), times: { x: same } },
    { host: 'podsjk', diff: diffOf('patches/x/a.snbt', 'research/packs/x.tar.gz'), times: { x: same } },
  ])
  assert.equal(a.bySlug.get('x').branch, 'gfdrgfd')
  assert.equal(b.bySlug.get('x').branch, 'gfdrgfd')
})

test('只有 patches 没有基准源 tar.gz：进 skipped 并写明缺基准源', () => {
  const plan = mergeFarm([{
    host: 'jslfkds',
    diff: diffOf('patches/lonely/lang/zh_cn.snbt'),
    times: { lonely: '2026-10-01T00:00:00Z' },
  }])

  assert.equal(plan.bySlug.size, 0)
  assert.equal(plan.skipped.length, 1)
  assert.equal(plan.skipped[0].slug, 'lonely')
  assert.equal(plan.skipped[0].branch, 'jslfkds')
  assert.match(plan.skipped[0].reason, /基准源/)
})

test('只有基准源没有译文（patchPaths 为空）：同样进 skipped', () => {
  const plan = mergeFarm([{
    host: 'podsjk',
    diff: diffOf('research/packs/hollow.tar.gz'),
    times: { hollow: '2026-10-01T00:00:00Z' },
  }])

  assert.equal(plan.bySlug.size, 0)
  assert.equal(plan.skipped[0].slug, 'hollow')
  assert.match(plan.skipped[0].reason, /缺补丁文件/)
})

test('mainBaselines 补判：diff 里没有基准源但 main 树上有 → 视为合格，baselinePath 指向 main 同路径', () => {
  const plan = mergeFarm([{
    host: 'work',
    diff: diffOf('patches/beyond-fantasy/config/ftbquests/quests/lang/zh_cn.snbt'),
    times: { 'beyond-fantasy': '2026-10-24T00:00:00Z' },
  }], { mainBaselines: new Set(['beyond-fantasy']) })

  assert.equal(plan.skipped.length, 0)
  assert.equal(plan.bySlug.size, 1)
  const item = plan.bySlug.get('beyond-fantasy')
  assert.equal(item.branch, 'work')
  assert.equal(item.baselinePath, 'research/packs/beyond-fantasy.tar.gz')
  assert.ok(item.patchPaths.length > 0)
})

test('mainBaselines 不含该 slug 时维持旧口径：照旧 skipped', () => {
  const plan = mergeFarm([{
    host: 'work',
    diff: diffOf('patches/orphan/lang/zh_cn.snbt'),
    times: { orphan: '2026-10-24T00:00:00Z' },
  }], { mainBaselines: new Set(['beyond-fantasy']) })

  assert.equal(plan.bySlug.size, 0)
  assert.equal(plan.skipped.length, 1)
  assert.match(plan.skipped[0].reason, /基准源/)
})

test('路径里带子目录（多级 / 大写 / 数字）仍归属同一个 slug', () => {
  const plan = mergeFarm([{
    host: 'gfdrgfd',
    diff: diffOf(
      'patches/adv-of-tech-5/qt/lang/en_us.snbt',
      'patches/adv-of-tech-5/qt/lang/zh_cn.snbt',
      'patches/adv-of-tech-5/readme/README.md',
      'research/packs/adv-of-tech-5.tar.gz',
    ),
    times: { 'adv-of-tech-5': '2026-10-01T00:00:00Z' },
  }])

  const entry = plan.bySlug.get('adv-of-tech-5')
  assert.equal(entry.branch, 'gfdrgfd')
  assert.equal(entry.patchPaths.length, 3)
  assert.ok(entry.patchPaths.includes('patches/adv-of-tech-5/qt/lang/zh_cn.snbt'))
  assert.ok(entry.patchPaths.includes('patches/adv-of-tech-5/readme/README.md'))
})

test('空输入与不相关路径：不产生任何条目也不崩', () => {
  assert.deepEqual([...mergeFarm([]).bySlug.keys()], [])
  assert.deepEqual(mergeFarm([]).conflicts, [])
  assert.deepEqual(mergeFarm([]).skipped, [])

  const plan = mergeFarm([{ host: 'h', diff: diffOf('', '   ', 'downloads/x.zip', 'site/data.json'), times: {} }])
  assert.equal(plan.bySlug.size, 0)
  assert.equal(plan.skipped.length, 0)
})

test('分类：非 tar.gz 的 packs 路径、深层 tar.gz、裸 patches 文件都不算条目', () => {
  assert.equal(classifyPath('patches/a/lang/x.snbt').slug, 'a')
  assert.deepEqual(classifyPath('research/packs/a.tar.gz'), { slug: 'a', kind: 'baseline' })
  assert.equal(classifyPath('research/packs/a/lang/x.snbt'), null)
  assert.equal(classifyPath('research/packs/a/b.tar.gz'), null) // slug 必须单段
  assert.equal(classifyPath('patches/file.snbt'), null) // 没有 slug 目录层级
  assert.equal(classifyPath('downloads/a.zip'), null)
})

test('输出顺序稳定：slug 字典序、patchPaths 字典序、conflicts/skipped 同样排序', () => {
  const plan = mergeFarm([
    {
      host: 'podsjk',
      diff: diffOf('patches/zeta/lang/zh_cn.snbt', 'research/packs/zeta.tar.gz', 'patches/alpha/b.snbt', 'patches/alpha/a.snbt', 'research/packs/alpha.tar.gz'),
      times: { zeta: '2026-10-01T00:00:00Z', alpha: '2026-10-01T00:00:00Z' },
    },
  ])
  assert.deepEqual([...plan.bySlug.keys()], ['alpha', 'zeta'])
  assert.deepEqual(plan.bySlug.get('alpha').patchPaths, ['patches/alpha/a.snbt', 'patches/alpha/b.snbt'])

  const multi = mergeFarm([
    { host: 'b', diff: diffOf('patches/y/a.snbt', 'research/packs/y.tar.gz', 'patches/x/a.snbt', 'research/packs/x.tar.gz'), times: {} },
    { host: 'a', diff: diffOf('patches/y/a.snbt', 'research/packs/y.tar.gz', 'patches/only/a.snbt'), times: {} },
  ])
  assert.deepEqual(multi.conflicts.map((c) => c.slug), ['y'])
  assert.deepEqual(multi.skipped.map((s) => s.slug), ['only'])
})

test('diff 文本容忍 CRLF、重复行与外层引号', () => {
  assert.deepEqual(
    parseDiffPaths('patches/a/x.snbt\r\npatches/a/x.snbt\r\n"research/packs/a.tar.gz"\r\n'),
    ['patches/a/x.snbt', 'research/packs/a.tar.gz'],
  )
})

test('serializePlan：Map 转普通对象，统计按主机分布', () => {
  const plan = mergeFarm([
    { host: 'gfdrgfd', diff: diffOf('patches/a/x.snbt', 'research/packs/a.tar.gz', 'patches/c/x.snbt', 'research/packs/c.tar.gz'), times: {} },
    { host: 'podsjk', diff: diffOf('patches/b/x.snbt', 'research/packs/b.tar.gz'), times: {} },
  ])
  const json = serializePlan(plan)
  assert.deepEqual(Object.keys(json.bySlug), ['a', 'b', 'c'])
  assert.deepEqual(json.stats, { count: 3, byHost: { gfdrgfd: 2, podsjk: 1 }, conflicts: 0, skipped: 0 })
})

test('collectBranchPaths：同 slug 的多条重复基准源只留一个', () => {
  const got = collectBranchPaths(diffOf('research/packs/a.tar.gz', 'research/packs/a.tar.gz', 'patches/a/x.snbt'))
  assert.equal(got.get('a').baselinePath, 'research/packs/a.tar.gz')
  assert.deepEqual(got.get('a').patchPaths, ['patches/a/x.snbt'])
})

// ---------- 缺口 2：裁决只在合格候选之间做 ----------

test('合格候选优先：更新但不合格的那台不参与竞争，别台的合格产物照常入选', () => {
  const plan = mergeFarm([
    // A 台资格齐全，时间更旧。
    {
      host: 'gfdrgfd',
      diff: diffOf('patches/aoc/lang/zh_cn.snbt', 'research/packs/aoc.tar.gz'),
      times: { aoc: '2026-10-01T00:00:00Z' },
    },
    // B 台更新，但漏推了基准源 → 不合格，不能把 A 台挤掉。
    {
      host: 'podsjk',
      diff: diffOf('patches/aoc/lang/zh_cn.snbt'),
      times: { aoc: '2026-10-05T00:00:00Z' },
    },
  ])

  assert.deepEqual([...plan.bySlug.keys()], ['aoc'])
  assert.equal(plan.bySlug.get('aoc').branch, 'gfdrgfd')
  assert.equal(plan.bySlug.get('aoc').baselinePath, 'research/packs/aoc.tar.gz')
  // 只有一个合格候选 → 不算冲突。
  assert.equal(plan.conflicts.length, 0)
  assert.equal(plan.skipped.length, 0)
})

test('落选的合格候选进 conflicts，更新但不合格的那台不进 losers', () => {
  const plan = mergeFarm([
    { host: 'gfdrgfd', diff: diffOf('patches/aoc/lang/zh_cn.snbt', 'research/packs/aoc.tar.gz'), times: { aoc: '2026-10-01T00:00:00Z' } },
    { host: 'jslfkds', diff: diffOf('patches/aoc/lang/zh_cn.snbt', 'research/packs/aoc.tar.gz'), times: { aoc: '2026-10-02T00:00:00Z' } },
    // 最新但缺译文：不合格，既不赢也不该出现在 losers 里。
    { host: 'podsjk', diff: diffOf('research/packs/aoc.tar.gz'), times: { aoc: '2026-10-09T00:00:00Z' } },
  ])

  assert.equal(plan.bySlug.get('aoc').branch, 'jslfkds')
  assert.equal(plan.conflicts.length, 1)
  assert.equal(plan.conflicts[0].winning, 'jslfkds')
  assert.deepEqual(plan.conflicts[0].losers, ['gfdrgfd'])
  assert.equal(plan.skipped.length, 0)
})

test('全部候选都不合格：进 skipped，原因文案写清每台各缺什么', () => {
  const plan = mergeFarm([
    // 只有译文，缺基准源。
    { host: 'gfdrgfd', diff: diffOf('patches/aoc/lang/zh_cn.snbt'), times: { aoc: '2026-10-01T00:00:00Z' } },
    // 只有基准源，缺译文。
    { host: 'podsjk', diff: diffOf('research/packs/aoc.tar.gz'), times: { aoc: '2026-10-03T00:00:00Z' } },
  ])

  assert.equal(plan.bySlug.size, 0)
  assert.equal(plan.conflicts.length, 0)
  assert.equal(plan.skipped.length, 1)
  const entry = plan.skipped[0]
  assert.equal(entry.slug, 'aoc')
  // branch 仍是「时间最新那台」，方便按主机排查。
  assert.equal(entry.branch, 'podsjk')
  assert.match(entry.reason, /gfdrgfd 缺基准源/)
  assert.match(entry.reason, /podsjk 缺补丁文件/)
})

test('isQualified：译文与基准源都有才算合格', () => {
  assert.equal(isQualified({ patchPaths: ['patches/a/x.snbt'], baselinePath: 'research/packs/a.tar.gz' }), true)
  assert.equal(isQualified({ patchPaths: ['patches/a/x.snbt'], baselinePath: null }), false)
  assert.equal(isQualified({ patchPaths: [], baselinePath: 'research/packs/a.tar.gz' }), false)
  assert.equal(isQualified({}), false)
  assert.equal(isQualified(null), false)
})

// ---------- 缺口 3：host 白名单 ----------

test('isValidHost：只接受小写字母/数字开头的主机名', () => {
  for (const ok of ['gfdrgfd', 'podsjk', 'jslfkds', 'a1', 'host-2', '0abc']) {
    assert.equal(isValidHost(ok), true, `应接受 ${ok}`)
  }
  for (const bad of ['', ' ', '-a', '_a', 'A', 'Host', 'a b', 'a/b', '../x', 'a_b', 'a.b', 'a\tb', null, undefined]) {
    assert.equal(isValidHost(bad), false, `应拒绝 ${String(bad)}`)
  }
})
