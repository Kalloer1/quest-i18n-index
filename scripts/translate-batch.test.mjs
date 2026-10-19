import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScan, loadState, saveState, PRODUCIBLE_LAYOUTS } from './translate-batch.mjs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HEADER = 'platform\tid\tslug\tbytes\tformat\tnewEn\tnewZh\toldCh\tcdKB\tscannedAt'

const tsv = (...rows) => [HEADER, ...rows].join('\n')

// ---- parseScan ----

test('parseScan：只保留可产出布局，排除 none/nodl/toobig/error/other', () => {
  const text = tsv(
    'cf\t1\ta\t100\tseparate-dir\t73\t0\t0\t10\t2026-10-19',
    'cf\t2\tb\t200\tseparate-single\t1\t0\t0\t5\t2026-10-19',
    'cf\t3\tc\t300\tembedded\t0\t0\t20\t5\t2026-10-19',
    'cf\t4\td\t400\tnone\t0\t0\t0\t0\t2026-10-19',
    'cf\t5\te\t500\tnodl\t0\t0\t0\t0\t2026-10-19',
    'cf\t6\tf\t600\ttoobig\t0\t0\t0\t0\t2026-10-19',
    'cf\t7\tg\t700\tother\t0\t0\t0\t0\t2026-10-19',
    'cf\t8\th\t800\terror:fetch failed\t0\t0\t0\t0\t2026-10-19',
  )
  const rows = parseScan(text)
  assert.deepEqual(rows.map((r) => r.slug), ['a', 'b', 'c'])
  for (const r of rows) assert.ok(PRODUCIBLE_LAYOUTS.has(r.layout), r.layout)
})

test('parseScan：按平台过滤', () => {
  const text = tsv(
    'cf\t1\ta\t100\tseparate-dir\t0\t0\t0\t0\t2026-10-19',
    'mr\t2\tb\t200\tembedded\t0\t0\t0\t0\t2026-10-19',
  )
  assert.deepEqual(parseScan(text, { platform: 'cf' }).map((r) => r.slug), ['a'])
  assert.deepEqual(parseScan(text, { platform: 'mr' }).map((r) => r.slug), ['b'])
  assert.deepEqual(parseScan(text).map((r) => r.slug), ['a', 'b'])
})

test('parseScan：保持 TSV 原顺序（= 下载量降序，不重排）', () => {
  const text = tsv(
    'cf\t1\tfirst\t100\tseparate-dir\t0\t0\t0\t0\t2026-10-19',
    'cf\t2\tsecond\t999\tembedded\t0\t0\t0\t0\t2026-10-19',
    'cf\t3\tthird\t50\tseparate-single\t0\t0\t0\t0\t2026-10-19',
  )
  assert.deepEqual(parseScan(text).map((r) => r.slug), ['first', 'second', 'third'])
})

test('parseScan：缺列明确报错，不静默返回空', () => {
  assert.throws(() => parseScan('platform\tslug\ncf\ta'), /缺列/)
})

test('parseScan：空内容返回空数组', () => {
  assert.deepEqual(parseScan(''), [])
  assert.deepEqual(parseScan(HEADER), [])
})

// ---- 状态文件 ----

test('saveState/loadState：往返一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-state-'))
  const file = join(dir, 'state.json')
  try {
    const s = { done: { a: { layout: 'embedded', at: '2026-10-19', ms: 100 } }, failed: {} }
    saveState(s, file)
    assert.deepEqual(loadState(file), s)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadState：文件不存在返回空结构（不抛错）', () => {
  assert.deepEqual(loadState(join(tmpdir(), 'definitely-not-here-xyz.json')), { done: {}, failed: {} })
})

test('loadState：状态文件损坏时当作空状态，不让整批停摆', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-state-'))
  const file = join(dir, 'state.json')
  try {
    writeFileSync(file, '{ 这不是 JSON')
    assert.deepEqual(loadState(file), { done: {}, failed: {} })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
