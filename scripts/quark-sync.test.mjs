/**
 * quark-sync.mjs 纯函数单测：增量规划 / 工作项展开 / limit / 分批 / 失败登记 / 全军覆没判定。
 * 全部用假清单，绝不调用真实 CLI、不联网、不写文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  planSync,
  workItems,
  applyLimit,
  chunk,
  appendFailures,
  isTotalFailure,
} from './quark-sync.mjs'

const zipFor = (slug) => (['a', 'b', 'c', 'd'].includes(slug) ? `downloads/${slug}.zip` : '')

function fixture() {
  return {
    slugs: ['a', 'b', 'c', 'd', 'e', 'f'],
    zipFor,
    mirrors: {
      a: { shareUrl: 'https://pan.quark.cn/s/aaa' },
      b: { shareUrl: '' },
    },
    remoteBySlug: new Map([
      // b：记录链接为空，但网盘有文件 → 补链
      ['b', [{ fid: 'fid-b', filename: 'b_v1.zip' }]],
      // c：记录与网盘都没有 → 上传
      // d：网盘同 slug 两条（历史重传）→ ambiguous
      ['d', [{ fid: 'fid-d1', filename: 'd_v1.zip' }, { fid: 'fid-d2', filename: 'd_v2.zip' }]],
      // e：本地缺包 → noZip
    ]),
  }
}

test('planSync：已有有效链接 → skip', () => {
  const p = planSync(fixture())
  assert.deepEqual(p.skip, [{ slug: 'a', reason: '记录已有分享链接' }])
})

test('planSync：链接为空但网盘有文件 → relink（带 fid）', () => {
  const p = planSync(fixture())
  assert.deepEqual(p.relink, [{ slug: 'b', fid: 'fid-b', filename: 'b_v1.zip' }])
})

test('planSync：记录与网盘都没有 → upload', () => {
  const p = planSync(fixture())
  assert.deepEqual(p.upload, [{ slug: 'c', zipPath: 'downloads/c.zip' }])
})

test('planSync：同 slug 网盘多条 → ambiguous，绝不猜', () => {
  const p = planSync(fixture())
  assert.deepEqual(p.ambiguous, [{ slug: 'd', names: ['d_v1.zip', 'd_v2.zip'] }])
  assert.ok(!p.relink.some((r) => r.slug === 'd'))
  assert.ok(!p.upload.some((u) => u.slug === 'd'))
})

test('planSync：本地缺包 → noZip，不进 upload', () => {
  const p = planSync(fixture())
  // e：网盘也没有且本地缺包；f：zipFor 同样返回空
  assert.deepEqual(p.noZip, ['e', 'f'])
  assert.ok(!p.upload.some((u) => u.slug === 'e'))
  assert.ok(!p.upload.some((u) => u.slug === 'f'))
})

test('planSync：f 不在任何清单里就完全不出现（zipFor 返回空且网盘无）', () => {
  // f 的 zipFor 返回空 → noZip（与 e 同类）
  const p = planSync(fixture())
  const slugs = new Set([
    ...p.skip.map((s) => s.slug),
    ...p.relink.map((r) => r.slug),
    ...p.upload.map((u) => u.slug),
    ...p.ambiguous.map((a) => a.slug),
    ...p.noZip,
  ])
  assert.deepEqual([...slugs].sort(), ['a', 'b', 'c', 'd', 'e', 'f'])
})

test('planSync：死链清单命中 → 不跳过，按网盘有无分流', () => {
  const fx = fixture()
  const p = planSync({ ...fx, deadUrls: new Set(['https://pan.quark.cn/s/aaa']) })
  assert.ok(!p.skip.some((s) => s.slug === 'a'))
  // a 网盘无文件 → upload
  assert.ok(p.upload.some((u) => u.slug === 'a'))
})

test('planSync：links-only 视角下 relink 项与 upload 项互不混入', () => {
  const p = planSync(fixture())
  for (const r of p.relink) assert.ok(!p.upload.some((u) => u.slug === r.slug))
})

test('workItems：默认 upload 在前 relink 在后；links-only 只剩 relink', () => {
  const p = planSync(fixture())
  const all = workItems(p)
  assert.deepEqual(all.map((w) => w.slug), ['c', 'b'])
  assert.deepEqual(workItems(p, { linksOnly: true }).map((w) => w.slug), ['b'])
})

test('applyLimit：0 / 非法 / 负数 = 全部；正数取前 N', () => {
  const items = [{ slug: 'x' }, { slug: 'y' }, { slug: 'z' }]
  assert.equal(applyLimit(items, 0).length, 3)
  assert.equal(applyLimit(items, -1).length, 3)
  assert.equal(applyLimit(items, 'abc').length, 3)
  assert.deepEqual(applyLimit(items, 2).map((i) => i.slug), ['x', 'y'])
})

test('chunk：按批大小切分，余数成尾批；非法大小整批', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunk([1, 2], 0), [[1, 2]])
  assert.deepEqual(chunk([], 10), [])
})

test('appendFailures：空历史时建表，已有历史时追加', () => {
  const now = '2026-10-24T00:00:00.000Z'
  const first = appendFailures(null, [{ slug: 'a', phase: 'sync', error: 'e1', attempts: 2 }], now)
  assert.deepEqual(first, { updatedAt: now, failures: [{ slug: 'a', phase: 'sync', error: 'e1', attempts: 2 }] })
  const second = appendFailures(first, [{ slug: 'b', phase: 'sync', error: 'e2', attempts: 2 }], now)
  assert.equal(second.failures.length, 2)
  assert.equal(first.failures.length, 1) // 不可变：不污染旧对象
})

test('isTotalFailure：有活但零成功才判红', () => {
  assert.equal(isTotalFailure(10, 0), true)
  assert.equal(isTotalFailure(10, 1), false)
  assert.equal(isTotalFailure(0, 0), false)
})
