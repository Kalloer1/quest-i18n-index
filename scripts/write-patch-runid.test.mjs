/**
 * `writePatch` 的分片运行标识单测（ADR-0009 的 D11）。
 *
 * ## 为什么需要它
 *
 * 旧实现无过滤地遍历 `research/par-out/<slug>/`，只按文件名 `^chunk-\d+\.json$` 筛选，
 * 没有时间戳、没有 run-id。实测后果（2026-10-20）：
 *
 *   - `research/par-out/ftb-evolution/` 有 **216** 个 `chunk-NNNN.failed.json`，
 *     该正则对它们**全部不匹配** → 不会被静默合并（侥幸安全，靠文件名巧合）；
 *   - 但「目录里没有普通分片」与「分片还没翻完」两种情况都产出全空补丁且**不报警**；
 *   - 一旦同目录留下**上一轮**的普通 `chunk-NNNN.json`，正则无法分辨，会静默混入旧译文。
 *
 * 现在分片带 `runId`，`writePatch` 只合并**本轮**的分片；无本轮分片时明确失败。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeShards, newRunId, isCurrentRunShard } from './translate-local.mjs'

/** 造一个 par-out 目录，写入若干分片。 */
function makeShards(shards) {
  const dir = mkdtempSync(join(tmpdir(), 'shards-'))
  for (const s of shards) writeFileSync(join(dir, s.name), JSON.stringify(s.body, null, 1) + '\n')
  return dir
}

test('newRunId：两次调用得到不同的非空字符串', () => {
  const a = newRunId()
  const b = newRunId()
  assert.equal(typeof a, 'string')
  assert.ok(a.length > 0)
  assert.notEqual(a, b, 'run id 必须唯一，否则分不清两轮')
})

test('isCurrentRunShard：只认本轮、非 failed 的分片', () => {
  const run = 'r1'
  assert.equal(isCurrentRunShard('chunk-0000.r1.json', run), true)
  assert.equal(isCurrentRunShard('chunk-0000.r2.json', run), false, '上一轮的分片不认')
  assert.equal(isCurrentRunShard('chunk-0000.r1.failed.json', run), false, 'failed 标记不认')
  assert.equal(isCurrentRunShard('chunk-0000.json', run), false, '无 run id 的旧分片不认')
})

test('mergeShards：混入上一轮遗留分片时，本轮译文不被污染', () => {
  // 上一轮把 quest.OLD 译成了「旧译文」，本轮把它译成「新译文」。
  // 若不过滤 run id，旧分片会把「旧译文」覆盖上去。
  const dir = makeShards([
    { name: 'chunk-0000.old.json', body: { slug: 'p', chunk: 0, runId: 'old', keys: ['f::quest.OLD'], outs: ['旧译文'] } },
    { name: 'chunk-0000.new.json', body: { slug: 'p', chunk: 0, runId: 'new', keys: ['f::quest.OLD'], outs: ['新译文'] } },
  ])
  try {
    const m = mergeShards(dir, 'new')
    assert.equal(m.translations.get('f::quest.OLD'), '新译文')
    assert.equal(m.shards, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('mergeShards：.failed.json 不被合并', () => {
  const dir = makeShards([
    { name: 'chunk-0000.new.json', body: { slug: 'p', chunk: 0, runId: 'new', keys: ['f::a'], outs: ['甲'] } },
    { name: 'chunk-0001.new.failed.json', body: { slug: 'p', chunk: 1, runId: 'new', keys: ['f::b'], outs: ['乙'] } },
  ])
  try {
    const m = mergeShards(dir, 'new')
    assert.equal(m.translations.get('f::a'), '甲')
    assert.equal(m.translations.has('f::b'), false, 'failed 分片不得合并')
    assert.equal(m.shards, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('mergeShards：目录里只有别的轮次的分片 → 判定为「无本轮分片」', () => {
  // 这正是「无分片」与「未翻完」必须分清的场景：不能让调用方拿到空补丁当成功。
  const dir = makeShards([
    { name: 'chunk-0000.old.json', body: { slug: 'p', chunk: 0, runId: 'old', keys: ['f::a'], outs: ['旧'] } },
  ])
  try {
    const m = mergeShards(dir, 'new')
    assert.equal(m.shards, 0)
    assert.equal(m.translations.size, 0)
    assert.equal(m.foundAnyShard, true, '目录里确实有分片，只是不属于本轮')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('mergeShards：空目录 → foundAnyShard=false，与「有别的轮次分片」可区分', () => {
  const dir = makeShards([])
  try {
    const m = mergeShards(dir, 'new')
    assert.equal(m.shards, 0)
    assert.equal(m.foundAnyShard, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('mergeShards：正常场景本轮多个分片全部合并，keys/outs 对齐', () => {
  const dir = makeShards([
    { name: 'chunk-0000.rr.json', body: { slug: 'p', chunk: 0, runId: 'rr', keys: ['f::a', 'f::b'], outs: ['甲', '乙'] } },
    { name: 'chunk-0001.rr.json', body: { slug: 'p', chunk: 1, runId: 'rr', keys: ['f::c'], outs: ['丙'] } },
  ])
  try {
    const m = mergeShards(dir, 'rr')
    assert.equal(m.shards, 2)
    assert.deepEqual([...m.translations.entries()], [['f::a', '甲'], ['f::b', '乙'], ['f::c', '丙']])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
