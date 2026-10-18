import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildDataset, matchPack } from '../scripts/build-index.mjs'

const input = JSON.parse(readFileSync(new URL('../research/build-input.json', import.meta.url), 'utf8'))
const bySlug = new Map(input.packs.map(p => [p.slug, p]))

/** 工单 01「已知答案」表格里的 8 条误配，必须全部不被判为覆盖。 */
const KNOWN_MISMATCHES = [
  ['craftoria-2', '续作'],
  ['caveopolis-2', '续作'],
  ['ftb-evolution-2', '续作'],
  ['all-of-create-aeronautics', '通用词撞车'],
  ['create-aeronautics-skybound', '通用词撞车'],
  ['chosens-create-integrated', '通用词撞车'],
  ['create-evolution-renewed', '通用词撞车'],
  ['create-chronicles-the-endventure', '通用词撞车'],
  ['fantasy-rpg-with-quests', '通用词撞车'],
  ['better-fantasy-overture', '通用词撞车'],
]

test('8 条已知误配全部不再被判为覆盖', () => {
  const ds = buildDataset(input)
  const bySlugOut = new Map(ds.dataset.map(d => [d.slug, d]))
  for (const [slug, kind] of KNOWN_MISMATCHES) {
    const rec = bySlugOut.get(slug)
    assert.ok(rec, `产出里应有 ${slug}`)
    assert.equal(rec.vm, null, `${slug}（${kind}）不应被判为已覆盖，实际命中 ${JSON.stringify(rec.vm)}`)
  }
})

test('精确命中仍然命中', () => {
  const ds = buildDataset(input)
  const bySlugOut = new Map(ds.dataset.map(d => [d.slug, d]))
  // craftoria 本身应命中 Craftoria；craftoria-2 不应命中
  assert.equal(bySlugOut.get('craftoria')?.vm?.originalName, 'Craftoria')
  assert.equal(bySlugOut.get('craftoria-2')?.vm, null)
})

test('续作被判拒时留下可复核的理由', () => {
  const rec = matchPack(bySlug.get('craftoria-2'), input.vmEntries)
  assert.equal(rec.tier, null)
  assert.match(rec.why, /续作不继承/)
  assert.match(rec.why, /Craftoria/)
})

test('通用词撞车不再发生：create 系列包不会命中 Create: Astral', () => {
  for (const slug of ['all-of-create-aeronautics', 'create-evolution-renewed']) {
    const rec = matchPack(bySlug.get(slug), input.vmEntries)
    assert.notEqual(rec.vm?.originalName, 'Create: Astral', `${slug} 不应命中 Create: Astral`)
  }
})

test('标题缺失时，只有 slug 全等才可计入覆盖；子串线索一律降为疑似', () => {
  const ds = buildDataset(input)
  const bySlugOut = new Map(ds.dataset.map(d => [d.slug, d]))
  for (const p of input.packs.filter(x => !x.title)) {
    const rec = bySlugOut.get(p.slug)
    if (rec.vm) {
      // 计入覆盖的，理由必须是「全等」而不是「子串/包含」
      assert.match(rec.vm.match, /^(exact|confirmed)$/, `${p.slug} 以 ${rec.vm.match} 计入覆盖`)
      assert.doesNotMatch(rec.vm.match, /suspect/)
    } else {
      assert.ok(rec.vmSuspect || rec.vmRejected, `${p.slug} 未覆盖却无理由记录`)
    }
  }
})

test('slug 子串线索不得计入覆盖', () => {
  // chosens-create-integrated 标题缺失，slug 含通用词 create，只能给疑似
  const rec = matchPack(bySlug.get('chosens-create-integrated'), input.vmEntries)
  assert.equal(rec.tier, 'suspect')
  assert.equal(rec.vm, null)
})

test('slug 规范化后与 VM 名称全等的，判为精确命中', () => {
  const rec = matchPack(bySlug.get('ftb-skies-2'), input.vmEntries)
  assert.equal(rec.tier, 'exact')
  assert.equal(rec.vm?.originalName, 'FTB Skies 2')
})

test('幂等：同一输入连跑两次，除时间戳外逐字节相同', () => {
  const a = buildDataset(input, { now: 'T' })
  const b = buildDataset(input, { now: 'T' })
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

test('元数据记录新旧覆盖数差异', () => {
  const ds = buildDataset(input)
  assert.equal(ds.coverageChange.previous, 21)
  // current 用 vmMatched（不分状态的全部 VM 命中），不是 coveredByVm：
  // 内嵌 / 无任务书 / 探测未完成的包也可能有 VM 汉化，
  // 而它们的状态不是 gap-covered。
  assert.equal(ds.coverageChange.current, ds.stat.vmMatched)
  assert.ok(ds.coverageChange.reason.length > 0)
})
