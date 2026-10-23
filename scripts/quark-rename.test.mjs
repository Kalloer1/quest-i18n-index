import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendRenameBatch,
  applyLimit,
  buildRenamePlan,
  indexRemote,
  isShareAlive,
  makeItems,
  makeRenameRecord,
  readRenames,
  renameRemote,
  verifyShares,
} from './quark-rename.mjs'

// 只测纯逻辑与「注入假 call」的编排：不联网、不碰真实 quark-drive.cjs。

function remote(name, fid = `fid-${name}`) {
  return { fid, filename: name }
}

test('indexRemote：旧名与新名反解到同一个 slug', () => {
  const bySlug = indexRemote([remote('aoc.zip'), remote('aoc_v1.2.3.zip')], new Set())
  assert.equal(bySlug.get('aoc').length, 2)
  assert.deepEqual(bySlug.get('aoc').map((x) => x.filename), ['aoc.zip', 'aoc_v1.2.3.zip'])
})

test('indexRemote：忽略文件夹 / 非 zip / 缺 fid 的条目', () => {
  const bySlug = indexRemote([
    { fid: 'd1', filename: '某个文件夹', file_type: '0' },
    { fid: '', filename: 'no-fid.zip' },
    { fid: 'f2', filename: 'ok_v2.zip' },
  ], new Set())
  assert.equal(bySlug.size, 1)
  assert.equal(bySlug.get('ok')[0].fid, 'f2')
})

test('差异集：网盘旧名 → 本地带版本号名', () => {
  const plan = buildRenamePlan({
    slugs: ['aoc', 'adj'],
    files: [remote('aoc.zip'), remote('adj.zip')],
    nameFor: (s) => (s === 'aoc' ? 'aoc_v1.2.3.zip' : 'adj_v1.4.3.zip'),
    shareUrls: { aoc: 'https://pan.quark.cn/s/a', adj: 'https://pan.quark.cn/s/b' },
  })
  assert.equal(plan.changes.length, 2)
  assert.deepEqual(plan.changes[0], {
    slug: 'aoc',
    fid: 'fid-aoc.zip',
    oldName: 'aoc.zip',
    newName: 'aoc_v1.2.3.zip',
    shareUrl: 'https://pan.quark.cn/s/a',
  })
  assert.equal(plan.unchanged, 0)
  assert.deepEqual(plan.missing, [])
})

test('幂等：名字已一致的不进批次、不计改动', () => {
  const plan = buildRenamePlan({
    slugs: ['aoc'],
    files: [remote('aoc_v1.2.3.zip')],
    nameFor: () => 'aoc_v1.2.3.zip',
  })
  assert.deepEqual(plan.changes, [])
  assert.equal(plan.unchanged, 1)
})

test('missing：网盘里没有对应 slug 的 zip 时跳过，不瞎猜', () => {
  const plan = buildRenamePlan({
    slugs: ['ghost', 'aoc'],
    files: [remote('aoc.zip')],
    nameFor: () => 'aoc_v1.zip',
  })
  assert.deepEqual(plan.missing, ['ghost'])
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].slug, 'aoc')
})

test('noLocal：本地拿不到期望名时跳过', () => {
  const plan = buildRenamePlan({
    slugs: ['aoc', 'gone'],
    files: [remote('aoc.zip'), remote('gone.zip')],
    nameFor: (s) => (s === 'gone' ? '' : 'aoc_v1.zip'),
  })
  assert.deepEqual(plan.noLocal, ['gone'])
  assert.equal(plan.changes.length, 1)
})

test('ambiguous：同一 slug 有多个远端条目时整条跳过（不改错文件）', () => {
  const plan = buildRenamePlan({
    slugs: ['aoc'],
    files: [remote('aoc.zip', 'f1'), remote('aoc_v1.zip', 'f2')],
    nameFor: () => 'aoc_v2.zip',
  })
  assert.deepEqual(plan.changes, [])
  assert.equal(plan.ambiguous.length, 1)
  assert.deepEqual(plan.ambiguous[0].names, ['aoc.zip', 'aoc_v1.zip'])
})

test('applyLimit：0 / 非法 / 负数 = 全部；正数取前 N', () => {
  const changes = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }]
  assert.equal(applyLimit(changes, '0').length, 3)
  assert.equal(applyLimit(changes, '').length, 3)
  assert.equal(applyLimit(changes, 'abc').length, 3)
  assert.equal(applyLimit(changes, '-2').length, 3)
  assert.deepEqual(applyLimit(changes, '1').map((c) => c.slug), ['a'])
  assert.notEqual(applyLimit(changes, '1'), changes)
})

test('makeItems：结构与字段名符合 rename 的 items 契约', () => {
  const items = makeItems([{ fid: 'f1', oldName: 'a.zip', newName: 'a_v1.zip' }])
  assert.equal(items.schema_version, 1)
  assert.deepEqual(items.items, [{ fid: 'f1', old_name: 'a.zip', new_name: 'a_v1.zip' }])
})

test('appendRenameBatch：只追加，历史批次不丢', () => {
  const prev = { updatedAt: 'old', batches: [{ batchId: 'b1', items: {} }] }
  const next = appendRenameBatch(prev, { batchId: 'b2', items: { f1: { oldName: 'a', newName: 'b' } } }, 'now')
  assert.equal(next.batches.length, 2)
  assert.equal(next.batches[0].batchId, 'b1')
  assert.equal(next.batches[1].batchId, 'b2')
  assert.equal(next.updatedAt, 'now')
  // 不修改入参
  assert.equal(prev.batches.length, 1)
})

test('appendRenameBatch：坏文件 / 空值按空表处理', () => {
  assert.deepEqual(appendRenameBatch(null, { batchId: 'b1' }, 'now'), { updatedAt: 'now', batches: [{ batchId: 'b1' }] })
  assert.deepEqual(appendRenameBatch({ foo: 1 }, { batchId: 'b1' }, 'now').batches.length, 1)
})

test('makeRenameRecord：fid → {oldName,newName,at} 即回滚依据', () => {
  const at = '2026-10-23T00:00:00.000Z'
  const rec = makeRenameRecord({
    batchId: 'abc',
    changes: [{ slug: 'aoc', fid: 'f1', oldName: 'aoc.zip', newName: 'aoc_v1.zip' }],
    at,
    data: { total: 1, success_count: 1, fail_count: 0, result_status: 'SUCCESS' },
  })
  assert.equal(rec.batchId, 'abc')
  assert.deepEqual(rec.items.f1, { slug: 'aoc', oldName: 'aoc.zip', newName: 'aoc_v1.zip', at })
  assert.equal(rec.result.success, 1)
})

test('renameRemote：写 items 文件并只调用一次 rename（假 call）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quark-rename-'))
  try {
    const itemsFile = join(dir, 'items.json')
    const calls = []
    const fakeCall = (cli, args) => {
      calls.push({ cli, args })
      return { total: 1, success_count: 1 }
    }
    const res = renameRemote({
      changes: [{ slug: 'aoc', fid: 'f1', oldName: 'aoc.zip', newName: 'aoc_v1.zip' }],
      call: fakeCall,
      cli: '/fake/quark-drive.cjs',
      cwd: dir,
      itemsFile,
      batchId: '0123456789abcdef',
      at: 'now',
    })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args, ['rename', '--batch-id', '0123456789abcdef', '--items-file', itemsFile])
    assert.equal(res.data.success_count, 1)
    const written = JSON.parse(readFileSync(itemsFile, 'utf8'))
    assert.deepEqual(written.items, [{ fid: 'f1', old_name: 'aoc.zip', new_name: 'aoc_v1.zip' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyShares：全部可访问 → ok=total，无失败', () => {
  const logs = []
  const v = verifyShares({
    gapMs: 0, sleep: () => {},
    changes: [
      { slug: 'a', shareUrl: 'https://pan.quark.cn/s/a' },
      { slug: 'b', shareUrl: 'https://pan.quark.cn/s/b' },
    ],
    call: (cli, args) => {
      assert.deepEqual(args, ['share-detail', '--url', args[2]])
      return { files: [{ fid: 'x', filename: 'a_v1.zip' }] }
    },
    cli: '/fake',
    cwd: '.',
    log: (m) => logs.push(m),
  })
  assert.deepEqual(v, { ok: 2, total: 2, failed: [], flaky: [], unverified: 0 })
  assert.equal(logs.length, 2)
})

test('verifyShares：空列表 / 抛错都算失败，并列出 slug', () => {
  const v = verifyShares({
    gapMs: 0, sleep: () => {},
    changes: [
      { slug: 'good', shareUrl: 'https://pan.quark.cn/s/good' },
      { slug: 'empty', shareUrl: 'https://pan.quark.cn/s/empty' },
      { slug: 'boom', shareUrl: 'https://pan.quark.cn/s/boom' },
      { slug: 'nourl', shareUrl: '' },
    ],
    call: (cli, args) => {
      const url = args[2]
      if (url.endsWith('boom')) throw new Error('share not exist')
      if (url.endsWith('empty')) return { files: [] }
      return { files: [{ fid: 'x' }] }
    },
    cli: '/fake',
    cwd: '.',
  })
  assert.equal(v.ok, 1)
  assert.equal(v.total, 3)
  assert.deepEqual(v.failed, ['empty', 'boom'])
  assert.equal(v.unverified, 1)
})

test('isShareAlive：按 share-detail 的两种形态判定', () => {
  assert.equal(isShareAlive({ files: [{ fid: 'a' }] }), true)
  assert.equal(isShareAlive({ files: [], share_info: { file_num: 1 } }), true)
  assert.equal(isShareAlive({ files: [] }), false)
  assert.equal(isShareAlive({}), false)
  assert.equal(isShareAlive(null), false)
})

test('readRenames：文件不存在或坏 JSON 返回空批次表', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quark-rename-'))
  try {
    assert.deepEqual(readRenames(join(dir, 'nope.json')), { updatedAt: null, batches: [] })
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    assert.deepEqual(readRenames(bad), { updatedAt: null, batches: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
