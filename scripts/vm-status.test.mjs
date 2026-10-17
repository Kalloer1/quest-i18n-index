import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseVmEntries, alignEntries, summarize, buildStatusFile, KNOWN_STATUS,
} from '../scripts/fetch-vm-status.mjs'

// 离线测试：只读手写 fixture，不联网。
const FIXTURE = readFileSync(new URL('./fixtures/vm-resources-sample.js', import.meta.url), 'utf8')
const entries = parseVmEntries(FIXTURE, { fetchedAt: 'T' })
const bySlug = new Map(entries.map(e => [e.vmSlug, e]))

test('只解析整合包条目，地图条目被排除', () => {
  assert.deepEqual(entries.map(e => e.vmSlug), ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'])
  assert.equal(bySlug.has('example-map'), false)
})

test('三种已知 status 原样读出并标记 recognized', () => {
  assert.deepEqual(bySlug.get('alpha').status, { type: 'stopped', recognized: true })
  assert.deepEqual(bySlug.get('beta').status, { type: 'maintaining', recognized: true })
  assert.deepEqual(bySlug.get('gamma').status, { type: 'translating', recognized: true })
})

test('未知 status 保留原值并标记，不丢弃也不改写', () => {
  const d = bySlug.get('delta')
  assert.equal(d.status.type, 'paused')
  assert.equal(d.status.recognized, false)
  assert.ok(d.notes.includes('unknown-status:paused'))
})

test('status 缺失记为 null 并留 note，不用空字符串填充', () => {
  const z = bySlug.get('zeta')
  assert.equal(z.status, null)
  assert.ok(z.notes.includes('status-missing'))
  const eta = bySlug.get('eta')
  assert.deepEqual(eta.status, { type: null, recognized: false })
  assert.ok(eta.notes.includes('status.type-missing'))
})

test('versions 缺失记为 null 并留 note；单个字段缺失只标该字段', () => {
  const e = bySlug.get('epsilon')
  assert.equal(e.versions, null)
  assert.ok(e.notes.includes('versions-missing'))
  const eta = bySlug.get('eta')
  assert.deepEqual(eta.versions, { loader: 'forge', mc: '1.19.2', pack: null })
  assert.ok(eta.notes.includes('versions.pack-missing'))
})

test('versions 三个字段正常读出', () => {
  assert.deepEqual(bySlug.get('beta').versions, { loader: 'neoforge', mc: '1.21.1', pack: '1.8.1' })
})

test('字符串里的花括号/逗号/转义反引号不会截断解析', () => {
  const a = bySlug.get('alpha')
  assert.equal(a.author, 'someone')
  assert.match(a.name, /示例包甲/)
  assert.match(a.originalName, /Example Pack A/)
  assert.equal(a.versions.pack, '1.4.0')
})

test('每条记录带来源 URL 与抓取时间戳', () => {
  for (const e of entries) {
    assert.equal(e.sourceUrl, 'https://vmct-cn.top/modpacks/')
    assert.equal(e.fetchedAt, 'T')
  }
})

test('字段缺失（无 originalName）保持 null', () => {
  assert.equal(bySlug.get('theta').originalName, null)
})

test('布尔与数字字面量按 JS 语义读出', () => {
  assert.equal(bySlug.get('alpha').featured, true)
  assert.equal(bySlug.get('beta').featured, false)
})

test('解析是纯函数：同一输入两次结果逐字节相同', () => {
  const a = parseVmEntries(FIXTURE, { fetchedAt: 'T' })
  const b = parseVmEntries(FIXTURE, { fetchedAt: 'T' })
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

test('空输入不炸，返回空数组', () => {
  assert.deepEqual(parseVmEntries(''), [])
  assert.deepEqual(parseVmEntries(null), [])
})

// ---------- 对齐 ----------

const VM = [
  { vmSlug: 'alpha', originalName: 'Example Pack A' },
  { vmSlug: 'beta', originalName: 'Example Pack B' },
  { vmSlug: 'gamma', originalName: 'Example Pack C' },
  { vmSlug: 'delta', originalName: 'Example Pack D' },
  { vmSlug: 'epsilon', originalName: 'Example Pack E' },
  { vmSlug: 'zeta', originalName: 'Example Pack F' },
  { vmSlug: 'eta', originalName: 'Example Pack G' },
  { vmSlug: 'theta', originalName: 'Example Pack H' },
  { vmSlug: 'rad/index', originalName: 'Roguelike Adventures and Dungeons' },
  { vmSlug: 'not-on-site', originalName: 'Ghost Pack' },
]
const SITE = [
  ...entries,
  { vmSlug: 'rad', link: '/modpacks/rad', originalName: 'Roguelike Adventures and Dungeons', name: 'RAD', status: { type: 'maintaining', recognized: true }, versions: { loader: 'forge', mc: '1.12.2', pack: '1.55' }, author: null, displayDate: null, featured: null, sourceUrl: 'u', fetchedAt: 'T', notes: [] },
  { vmSlug: 'extra', link: '/modpacks/extra', originalName: 'Extra Pack', name: 'Extra', status: { type: 'stopped', recognized: true }, versions: { loader: 'forge', mc: '1.20.1', pack: '1' }, author: null, displayDate: null, featured: null, sourceUrl: 'u', fetchedAt: 'T', notes: [] },
]

test('对齐：build-input 顺序优先，官网多出的排在后面并标记', () => {
  const a = alignEntries(SITE, VM, { fetchedAt: 'T' })
  assert.equal(a.entries[0].vmSlug, 'alpha')
  assert.equal(a.entries[0].inBuildInput, true)
  const extra = a.entries.find(e => e.vmSlug === 'extra')
  assert.equal(extra.inBuildInput, false)
  assert.ok(extra.notes.includes('not-in-build-input'))
  assert.deepEqual(a.onlyOnSite, ['extra'])
})

test('对齐：官网缺失的条目保留为 null 行，不静默丢弃', () => {
  const a = alignEntries(SITE, VM, { fetchedAt: 'T' })
  const ghost = a.entries.find(e => e.vmSlug === 'not-on-site')
  assert.equal(ghost.link, null)
  assert.equal(ghost.status, null)
  assert.equal(ghost.versions, null)
  assert.ok(ghost.notes.includes('missing-on-site'))
  assert.deepEqual(a.onlyInBuildInput, ['not-on-site'])
})

test('对齐：slug 漂移（X/index → X）只在 originalName 逐字相同时才认，并留可复核记录', () => {
  const a = alignEntries(SITE, VM, { fetchedAt: 'T' })
  const rad = a.entries.find(e => e.buildInputSlug === 'rad/index')
  assert.equal(rad.vmSlug, 'rad')
  assert.ok(rad.notes.includes('slug-alias:rad/index→rad'))
  assert.deepEqual(a.slugAliases.map(x => [x.from, x.to]), [['rad/index', 'rad']])
})

test('对齐：剥后缀后 originalName 不同则不认，留作官网缺失', () => {
  const site = [{ ...SITE[0], vmSlug: 'rad', originalName: 'Something Else Entirely' }]
  const a = alignEntries(site, [{ vmSlug: 'rad/index', originalName: 'Roguelike Adventures and Dungeons' }], { fetchedAt: 'T' })
  assert.deepEqual(a.slugAliases, [])
  assert.equal(a.entries[0].status, null)
  assert.deepEqual(a.onlyInBuildInput, ['rad/index'])
})

// ---------- 汇总与落盘对象 ----------

test('summarize 把未知与缺失分开计数', () => {
  const s = summarize(entries)
  assert.equal(s.total, 8)
  assert.equal(s.status.stopped, 2)      // alpha, epsilon
  assert.equal(s.status.maintaining, 2)  // beta, theta
  assert.equal(s.status.translating, 1)  // gamma
  assert.equal(s.status.unknown, 1)      // delta
  assert.equal(s.status.missing, 2)      // zeta（无 status）、eta（无 type）
})

test('buildStatusFile：source 与统计、来源字段齐全', () => {
  const out = buildStatusFile({ entries, vmEntries: VM, source: 'cache', fetchedAt: 'T', dataUrl: 'https://x/y.js' })
  assert.equal(out.source, 'cache')
  assert.equal(out.dataUrl, 'https://x/y.js')
  assert.equal(out.fetchedAt, 'T')
  assert.equal(out.sourceUrl, 'https://vmct-cn.top/modpacks/')
  assert.deepEqual(out.statusValues, KNOWN_STATUS)
  assert.equal(out.stat.buildInputEntries, 10)
  assert.equal(out.stat.siteEntries, 8)
  assert.equal(out.entries.length, 10) // 10 条 build-input 槽位，其中 2 条官网缺失
})

test('buildStatusFile：抓取失败时 source=unavailable 且不填充任何条目', () => {
  const out = buildStatusFile({ entries: [], vmEntries: VM, source: 'unavailable', fetchedAt: 'T', unavailableReason: 'HTTP 503' })
  assert.equal(out.source, 'unavailable')
  assert.equal(out.unavailableReason, 'HTTP 503')
  assert.equal(out.stat.matched, 0)
  assert.equal(out.stat.status.missing, VM.length)
  for (const e of out.entries) {
    assert.equal(e.status, null)
    assert.equal(e.versions, null)
  }
})

test('幂等：同一输入连跑两次，除时间戳外逐字节相同', () => {
  const a = buildStatusFile({ entries, vmEntries: VM, source: 'cache', fetchedAt: 'T' })
  const b = buildStatusFile({ entries, vmEntries: VM, source: 'cache', fetchedAt: 'T' })
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})
