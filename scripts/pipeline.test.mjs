#!/usr/bin/env node
/**
 * 翻译流水线单测：LLM 用桩注入，不联网。
 * 覆盖：--ids/--top 互斥、分块 60 行、块回退重试、整体回退率判失败、独立超时、术语记忆全命中不调 LLM、
 * 失败回写 POST /status（X-Internal-Token）、产出头部标注。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseArgs, runPipeline, processPack, translateUnits, readRecords,
  CHUNK_LINES, OVERALL_FALLBACK_THRESHOLD, DEFAULT_TIMEOUT_MS,
} from './pipeline.mjs'

// ---- 数据集键名（回归：曾只读 `packs`，而实际字段是 `dataset`，CLI 全量空跑）----

test('readRecords 认 `dataset` 字段，并兼容旧的 `packs` 写法', () => {
  assert.deepEqual(readRecords({ dataset: [{ slug: 'a' }] }), [{ slug: 'a' }])
  assert.deepEqual(readRecords({ packs: [{ slug: 'b' }] }), [{ slug: 'b' }])
  assert.deepEqual(readRecords({}), [])
  assert.deepEqual(readRecords(null), [])
})

test('真实数据集能被 readRecords 读出 500 条（守护键名漂移）', () => {
  const ds = JSON.parse(readFileSync(new URL('../research/index-dataset.json', import.meta.url), 'utf8'))
  assert.equal(readRecords(ds).length, 500)
})
import { LAYOUT } from './lib/candidates.mjs'

const EMBED = 'config/ftbquests/quests/chapters/chapter.snbt'
const record = { slug: 'demo', layout: LAYOUT.EMBEDDED, enFiles: 1, zhFiles: 0 }
const pack = {
  files: [{
    name: EMBED,
    text: '{ title: "Hello World" description: "Welcome to the pack" tasks: [{ item: "minecraft:stone" }] }',
  }],
}

// ---------- parseArgs ----------

test('parseArgs：--ids 与 --top 互斥', () => {
  assert.deepEqual(parseArgs(['--ids', 'a,b']).ids, ['a', 'b'])
  assert.equal(parseArgs(['--top', '5']).top, 5)
  assert.throws(() => parseArgs(['--ids', 'a', '--top', '5']), /互斥/)
  assert.throws(() => parseArgs([]), /--ids/)
})

test('parseArgs：默认分块 60 行、超时 5 分钟', () => {
  const args = parseArgs(['--top', '1'])
  assert.equal(args.chunkLines, CHUNK_LINES)
  assert.equal(args.timeoutMs, DEFAULT_TIMEOUT_MS)
})

// ---------- translateUnits ----------

function stubTranslator(echoFrom) {
  // echoFrom：第 N 条原文原样回显（模拟回退）
  return async (texts) => texts.map((t, i) => (i === echoFrom ? t : `中:${t}`))
}

test('translateUnits：全命中术语记忆时一次 LLM 都不调', async () => {
  let calls = 0
  const translate = async (texts) => { calls++; return texts }
  const units = [{ key: 'a', text: 'Welcome to the pack' }]
  const r = await translateUnits(units, translate, { glossary: { 'welcome to the pack': '欢迎来到本整合包' } })
  assert.equal(calls, 0)
  assert.equal(r.map.get('a'), '欢迎来到本整合包')
  assert.equal(r.glossaryHits, 1)
})

test('translateUnits：默认分块 60 行', async () => {
  const sizes = []
  const translate = async (texts) => { sizes.push(texts.length); return texts.map((t) => `中:${t}`) }
  const units = Array.from({ length: 130 }, (_, i) => ({ key: `k${i}`, text: `text ${i}` }))
  await translateUnits(units, translate)
  assert.deepEqual(sizes, [60, 60, 10])
})

test('translateUnits：块回退率 >10% 整块重试，最多 3 次', async () => {
  // 10 行里 2 行回显（20% > 10%）→ 重试；第 3 次仍失败就接受（最多 3 次）
  let attempts = 0
  const translate = async (texts) => {
    attempts++
    return texts.map((t, i) => (i < 2 ? t : `中:${t}`))
  }
  const units = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, text: `text ${i}` }))
  const r = await translateUnits(units, translate)
  assert.equal(attempts, 3)
  assert.equal(r.fallback, 2)
})

test('translateUnits：整体回退率 >30% 判失败不写文件', async () => {
  const translate = async (texts) => texts // 全部回显
  const units = [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }]
  await assert.rejects(translateUnits(units, translate), /回退率过高/)
})

test('translateUnits：回显不进术语记忆', async () => {
  const translate = async (texts) => texts
  const units = [{ key: 'a', text: 'only one' }]
  await assert.rejects(translateUnits(units, translate), /回退率过高/)
})

// ---------- processPack ----------

test('processPack：产出带「AI 初翻」头部，结构字段不被改写', async () => {
  const r = await processPack(record, pack, { translate: stubTranslator(-1) })
  assert.equal(r.status, 'done')
  assert.ok(r.outputs[0].text.startsWith('# AI 初翻，未人工校对\n'))
  assert.ok(r.outputs[0].text.includes('title: "中:Hello World"'))
  assert.ok(r.outputs[0].text.includes('item: "minecraft:stone"'))
})

test('processPack：缺英文源判失败', async () => {
  const r = await processPack({ ...record, layout: LAYOUT.SEPARATE_DIR }, { files: [{ name: 'a.snbt', text: '{}' }] }, { translate: stubTranslator(-1) })
  assert.equal(r.status, 'failed')
  assert.equal(r.error, 'no-en-source')
})

test('processPack：跳过原因透传', async () => {
  const r = await processPack({ ...record, layout: LAYOUT.NONE }, pack, { translate: stubTranslator(-1) })
  assert.equal(r.status, 'skipped')
  assert.equal(r.error, 'no-quests')
})

// ---------- runPipeline ----------

test('runPipeline：独立超时只让该条失败，其余继续', async () => {
  const slowTranslate = async (texts, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(texts.map((x) => `中:${x}`)), 5000)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
  })
  const records = [
    record,
    { slug: 'slow', layout: LAYOUT.EMBEDDED, enFiles: 1, zhFiles: 0 },
  ]
  const packs = {
    demo: pack,
    slow: { files: [{ name: EMBED, text: '{ title: "Slow" }' }] },
  }
  // 只有内容含 Slow 的原文才挂起；其余立即返回
  const translate = async (texts, signal) => {
    if (texts.some((t) => t.includes('Slow'))) return slowTranslate(texts, signal)
    return texts.map((x) => `中:${x}`)
  }
  const results = await runPipeline({
    records,
    loadPack: (slug) => packs[slug],
    translate,
    timeoutMs: 50,
  })
  const bySlug = new Map(results.map((r) => [r.slug, r]))
  assert.equal(bySlug.get('demo').status, 'done')
  assert.equal(bySlug.get('slow').status, 'failed')
  assert.match(String(bySlug.get('slow').error), /超时|aborted/)
})

test('runPipeline：失败回写 POST /status 带 X-Internal-Token', async () => {
  const posted = []
  const records = [
    { slug: 'good', layout: LAYOUT.EMBEDDED, enFiles: 1, zhFiles: 0 },
    { slug: 'gone', layout: LAYOUT.EMBEDDED, enFiles: 1, zhFiles: 0 },
  ]
  const packs = { good: pack } // gone 缺文件 → loadPack 抛错
  await runPipeline({
    records,
    loadPack: (slug) => {
      if (!packs[slug]) throw new Error('找不到整合包文件')
      return packs[slug]
    },
    translate: stubTranslator(-1),
    reportStatus: async (id, payload) => { posted.push([id, payload]) },
  })
  const fail = posted.find(([id]) => id === 'gone')
  assert.ok(fail)
  assert.equal(fail[1].status, 'failed')
  const done = posted.find(([id]) => id === 'good')
  assert.equal(done[1].status, 'done')
})

test('runPipeline：no-quests 跳过并回写 skipped', async () => {
  const posted = []
  const results = await runPipeline({
    records: [{ slug: 'notq', layout: LAYOUT.NONE }],
    loadPack: () => { throw new Error('不应被调用') },
    translate: stubTranslator(-1),
    reportStatus: async (id, payload) => { posted.push([id, payload]) },
  })
  assert.equal(results[0].status, 'skipped')
  assert.equal(posted[0][1].status, 'skipped')
})

test('runPipeline：writeOutput 收到产出（done 时）', async () => {
  const written = []
  await runPipeline({
    records: [record],
    loadPack: () => pack,
    translate: stubTranslator(-1),
    writeOutput: (slug, name, text) => written.push([slug, name, text]),
    reportStatus: async () => {},
  })
  assert.equal(written.length, 1)
  assert.equal(written[0][1], EMBED)
})
