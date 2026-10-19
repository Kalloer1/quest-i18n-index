import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { translatePackParallel, loadPackUnits, listTranslatable, chunkByChars, DEFAULT_LANES } from './translate-parallel.mjs'

/** 造一个最小可用的整合包目录（separate-single 布局）。 */
function makePack(root, slug, entries) {
  const dir = join(root, slug, 'config/ftbquests/quests/lang')
  mkdirSync(dir, { recursive: true })
  const body = entries.map(([k, v]) => `\t${k}: "${v}"`).join('\n')
  writeFileSync(join(dir, 'en_us.snbt'), `{\n${body}\n}\n`)
  return join(root, slug)
}

test('loadPackUnits：读 separate-single 布局的待译单元', () => {
  const root = mkdtempSync(join(tmpdir(), 'par-'))
  try {
    makePack(root, 'p1', [['a.title', 'Hello'], ['a.subtitle', 'World']])
    const r = loadPackUnits('p1', root)
    assert.ok(r, '应能读到包')
    assert.equal(r.layout, 'separate-single')
    assert.equal(r.units.length, 2)
    assert.ok(r.units.every((u) => u.key.includes('::')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadPackUnits：目录不存在返回 null，不抛错', () => {
  assert.equal(loadPackUnits('nope', join(tmpdir(), 'definitely-not-here')), null)
})

test('translatePackParallel：一个 worker 要一直取块，不能干一块就退出', async () => {
  // 回归：早先 worker 成功一次就 return，导致 12 路各只干一块，
  // 21 块只完成 12 块（日志「块 12/21」）。这是静默丢块，最坏情况没人发现。
  const root = mkdtempSync(join(tmpdir(), 'par-'))
  const out = mkdtempSync(join(tmpdir(), 'parout-'))
  try {
    // 30 条文本 + chunkLines=3 → 10 块，lanes=2 必然有 worker 干多块。
    const entries = Array.from({ length: 30 }, (_, i) => [`k${i}.title`, `text ${i}`])
    makePack(root, 'p1', entries)
    const r = await translatePackParallel('p1', {
      lanes: 2,
      charBudget: 40,
      maxChunkItems: 3,
      outDir: out,
      packsDir: root,
      callFn: async (texts) => texts.map((t) => `中:${t}`),
    })
    assert.equal(r.chunks, 10, '30 条 / 3 条一块 = 10 块')
    assert.equal(r.ok, 10, '所有块都必须完成（丢块就是这个 bug 的形状）')
    assert.equal(r.failed, 0)
    // 落盘块数也要是 10，不能只是计数对而文件少
    const files = readdirSync(join(out, 'p1')).filter((f) => /^chunk-\d+\.json$/.test(f))
    assert.equal(files.length, 10, `应落盘 10 块，实际 ${files.length}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('translatePackParallel：单块失败会重试，仍失败则计 failed 且不拖住其他块', async () => {
  const root = mkdtempSync(join(tmpdir(), 'par-'))
  const out = mkdtempSync(join(tmpdir(), 'parout-'))
  try {
    makePack(root, 'p1', Array.from({ length: 9 }, (_, i) => [`k${i}.title`, `text ${i}`]))
    let n = 0
    const r = await translatePackParallel('p1', {
      lanes: 2,
      charBudget: 40,
      maxChunkItems: 3,
      outDir: out,
      packsDir: root,
      callFn: async (texts) => {
        n++
        if (n === 1) throw new Error('模拟 504')
        return texts.map((t) => `中:${t}`)
      },
    })
    assert.equal(r.chunks, 3)
    // 第一次失败会被重试，重试成功后 ok 应为 3。
    assert.equal(r.ok + r.failed, 3)
    assert.ok(r.ok >= 2, `至少 2 块应成功，实际 ok=${r.ok} failed=${r.failed}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('DEFAULT_LANES：12（实测吞吐/延迟甜点）', () => {
  // 实测：12 路 3.94 块/秒 p50 2955ms；32 路 7.93 块/秒 p50 4070ms。
  // 取 12 作为默认：吞吐够用，且单块延迟仍在 3s 内。
  assert.equal(DEFAULT_LANES, 12)
})

test('listTranslatable：只返回可产出且无自带中文的包', () => {
  const slugs = listTranslatable()
  assert.ok(Array.isArray(slugs))
  assert.ok(slugs.length > 0, '真实数据集里应有可翻译的包')
  assert.ok(!slugs.includes('skyfactory-5'), '无任务书的包不应入选')
})

// ---- 漏译行单独补翻（实测：免费层随机丢行，同一批在 0~20 条间波动） ----

test('translatePackParallel：漏译行会被单独补翻，直到补回', async () => {
  // 实测依据：同一批 30 条重复 5 次，漏译数在 11,0,17,0,14 之间波动；
  // 但只重发漏掉的那几条时，2~4 轮就能全部补回。
  const root = mkdtempSync(join(tmpdir(), 'par-'))
  const out = mkdtempSync(join(tmpdir(), 'parout-'))
  try {
    makePack(root, 'p1', Array.from({ length: 9 }, (_, i) => [`k${i}.title`, `text ${i}`]))
    let call = 0
    const r = await translatePackParallel('p1', {
      lanes: 1,
      charBudget: 40,
      maxChunkItems: 3,
      outDir: out,
      packsDir: root,
      callFn: async (texts) => {
        call++
        // 第一轮每 3 条只回 1 条（模拟随机丢行），之后全部正常
        if (call === 1) return texts.map((t, i) => (i === 0 ? `中:${t}` : null))
        return texts.map((t) => `中:${t}`)
      },
    })
    assert.equal(r.ok, 3, '所有块都应完成')
    assert.equal(r.missing, 0, '补翻后不应有漏译')
    assert.ok(call > 3, `应发生补翻调用，实际调用 ${call} 次`)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('chunkByChars：按字符预算切块，长文本不会被塞进同一块', () => {
  // 实测依据：按「30 条」切块时，aoc 含 9 个 quest_desc 的块漏 27 条，
  // 全是 title 的块漏 0 条 —— 因为长文本块输出撞到 max_tokens 上限。
  const units = [
    { key: 'a', text: 'x'.repeat(500) },
    { key: 'b', text: 'x'.repeat(500) },
    { key: 'c', text: 'x'.repeat(500) },
    { key: 'd', text: 'y' },
  ]
  const chunks = chunkByChars(units, { charBudget: 600, maxItems: 40 })
  // 3 条 500 字符各占一块（500+500 > 600），末尾 1 字符的短文本并入最后一块。
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks.map((c) => c.map((u) => u.key)), [['a'], ['b'], ['c', 'd']])
  // 短文本仍会合并
  const short = chunkByChars([{ key: 'a', text: 'aa' }, { key: 'b', text: 'bb' }], { charBudget: 600 })
  assert.equal(short.length, 1)
})

test('chunkByChars：全是空串时由 maxItems 兜底，不会切成一块上千条', () => {
  const units = Array.from({ length: 100 }, (_, i) => ({ key: `k${i}`, text: '' }))
  const chunks = chunkByChars(units, { charBudget: 1200, maxItems: 40 })
  assert.ok(chunks.length >= 3, `应有条数上限兜底，实际 ${chunks.length} 块`)
  assert.ok(chunks.every((c) => c.length <= 40))
})
