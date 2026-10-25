#!/usr/bin/env node
/**
 * 1.12.2 FTB Quests 旧布局（embeddedLegacy）的识别、源选择与双模式去重。
 *
 * 背景（2026-10-25，MC Eternal 实物核对）：
 *   旧布局任务文件在 `config/ftbquests/<mode>/chapters/<章节hex>/<任务hex>.snbt`，
 *   比新版 `quests/chapters/*.snbt` 深一层；mode 为 challenge/classic 两个模式副本。
 *   旧 embedded 正则只认 chapters/ 直接下一层，整包只匹配到两个纯 uid 数组的
 *   index.snbt → 抽出 0 个单元 → 全库 181 个 no-text 包的已知样本系统性误杀。
 *
 * fixture 按 MC Eternal（CF 349129）真实结构最小化。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyLayout, LAYOUT } from './candidates.mjs'
import { sourceFileNames, extractPack, buildOutputs, TEXT_FIELDS } from './quest-files.mjs'
import { validatePair } from '../validate-quests.mjs'
import { translatePackParallel, loadPackUnits } from '../translate-parallel.mjs'

// ---- fixture：MC Eternal 真实结构的最小切片 ----

const CH = '03049ff4'
const challengeQuest = `{
	id: "0241f757",
	title: "Stone Age",
	description: [
		"Welcome to the pack.",
		"Dig down and gather wood."
	],
	tasks: [{
		id: "2f8a1c9d",
		type: "item",
		item: { item: "minecraft:stone" }
	}]
}
`
const classicOnlyQuest = `{
	id: "0d3b082d",
	title: "Classic Only Chapter Quest",
	description: ["Only the classic mode book has this one."]
}
`
const indexSnbt = `{
	index: [
		"03049ff4",
		"147ca0a1"
	]
}
`
const fileSnbt = `{
	version: 9,
	default_autoclaim_rewards: "disabled"
}
`
const rewardTable = `{
	id: "5e5a9f4c",
	rewards: [{ id: "aa11", type: "item", item: { item: "minecraft:diamond" } }]
}
`

/** 旧布局最小包：challenge + classic 双模式副本，文本大面积重复。 */
const LEGACY_NAMES = [
  `config/ftbquests/challenge/chapters/${CH}/0241f757.snbt`,
  `config/ftbquests/challenge/chapters/index.snbt`,
  `config/ftbquests/challenge/file.snbt`,
  `config/ftbquests/challenge/reward_tables/5e5a9f4c.snbt`,
  `config/ftbquests/classic/chapters/${CH}/0241f757.snbt`,
  `config/ftbquests/classic/chapters/${CH}/0d3b082d.snbt`,
  `config/ftbquests/classic/chapters/index.snbt`,
  `config/ftbquests/classic/file.snbt`,
]

// ---- 识别（classifyLayout）----

test('classifyLayout：1.12.2 旧布局识别为 embedded，enFiles 数任务文件（不含 index.snbt）', () => {
  const r = classifyLayout(LEGACY_NAMES)
  assert.equal(r.layout, LAYOUT.EMBEDDED)
  assert.equal(r.enFiles, 3, '两个 challenge 任务 + 一个 classic-only 任务；index/file/reward_tables 都不算')
  assert.equal(r.embeddedFiles, 3)
  assert.equal(r.hasQuests, true)
})

test('classifyLayout：旧布局不影响新版布局与分离布局的判定', () => {
  const r = classifyLayout([
    'config/ftbquests/quests/chapters/start.snbt',
    'config/ftbquests/challenge/chapters/03049ff4/0241f757.snbt',
  ])
  assert.equal(r.layout, LAYOUT.EMBEDDED)
  assert.equal(r.enFiles, 2)
  // 分离布局优先级不变
  const sep = classifyLayout([
    'config/ftbquests/quests/lang/en_us/a.snbt',
    'config/ftbquests/challenge/chapters/03049ff4/0241f757.snbt',
  ])
  assert.equal(sep.layout, LAYOUT.SEPARATE_DIR)
  assert.equal(sep.enFiles, 1, '有 lang/en_us 时只数 lang 文件')
})

// ---- 源选择（sourceFileNames）----

test('sourceFileNames：旧布局选中嵌套任务文件；index.snbt / file.snbt / reward_tables 不入源', () => {
  const src = sourceFileNames(LEGACY_NAMES, LAYOUT.EMBEDDED)
  assert.deepEqual(src, [
    `config/ftbquests/challenge/chapters/${CH}/0241f757.snbt`,
    `config/ftbquests/classic/chapters/${CH}/0241f757.snbt`,
    `config/ftbquests/classic/chapters/${CH}/0d3b082d.snbt`,
  ])
})

test('sourceFileNames：新版 quests/chapters/ 下的嵌套垃圾（backup 等）仍不入源', () => {
  // 实测已交付基线里有 quests/chapters/backup/*.snbt、quests/chapters/reward_tables/*.snbt。
  // 裸放宽 embedded 正则会把它们当英文源，闸门基准凭空多键 → 存量包假失败。
  const names = [
    'config/ftbquests/quests/chapters/real.snbt',
    'config/ftbquests/quests/chapters/backup/bows.snbt',
    'config/ftbquests/quests/chapters/reward_tables/simple.snbt',
    'config/ftbquests/quests/chapters/index.snbt',
  ]
  const src = sourceFileNames(names, LAYOUT.EMBEDDED)
  assert.deepEqual(src, ['config/ftbquests/quests/chapters/real.snbt'])
})

// ---- 抽取（extractPack）----

test('extractPack：旧布局抽出 >0 个可译单元，字段全在 TEXT_FIELDS，index 不产单元', () => {
  const files = [
    { name: `config/ftbquests/challenge/chapters/${CH}/0241f757.snbt`, text: challengeQuest },
    { name: 'config/ftbquests/challenge/chapters/index.snbt', text: indexSnbt },
    { name: 'config/ftbquests/challenge/file.snbt', text: fileSnbt },
  ]
  const pack = extractPack({ files, layout: LAYOUT.EMBEDDED })
  assert.ok(pack.units.length > 0, '必须有可译单元（旧正则下这里是 0 → noText 误挂账）')
  for (const u of pack.units) {
    const field = u.path.replace(/\[\d+\]$/, '').split('.').pop()
    assert.ok(TEXT_FIELDS.has(field), `单元字段 ${field} 不在 TEXT_FIELDS: ${u.key}`)
    assert.ok(u.key.startsWith(`${files[0].name}::`), `key 应带源文件名: ${u.key}`)
  }
  const texts = pack.units.map((u) => u.text)
  assert.deepEqual(texts, ['Stone Age', 'Welcome to the pack.', 'Dig down and gather wood.'])
})

// ---- 双模式去重（translatePackParallel 文本级请求去重）----

/** 造旧布局包目录：challenge 与 classic 两份副本。 */
function makeLegacyPack(root, slug) {
  const base = join(root, slug, 'config/ftbquests')
  const write = (rel, text) => {
    const f = join(base, rel)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, text)
  }
  write(`challenge/chapters/${CH}/0241f757.snbt`, challengeQuest)
  write(`challenge/chapters/index.snbt`, indexSnbt)
  write(`challenge/file.snbt`, fileSnbt)
  write(`classic/chapters/${CH}/0241f757.snbt`, challengeQuest)
  write(`classic/chapters/${CH}/0d3b082d.snbt`, classicOnlyQuest)
  write(`classic/chapters/index.snbt`, indexSnbt)
  write(`classic/file.snbt`, fileSnbt)
}

test('translatePackParallel：双模式副本同文本只发一次请求，两副本各拿译文', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-pack-'))
  const out = mkdtempSync(join(tmpdir(), 'legacy-out-'))
  try {
    makeLegacyPack(root, 'legacy1')
    const served = []
    const r = await translatePackParallel('legacy1', {
      outDir: out,
      packsDir: root,
      lanes: 1,
      callFn: async (t) => { served.push(t); return `中:${t}` },
    })
    // 单元：challenge 3 条 + classic 同文本 3 条 + classic-only 2 条（title+desc）= 8
    assert.equal(r.total, 8)
    assert.equal(r.ok, 8)
    // 去重后只发 5 个请求：title/desc1/desc2（两副本同文本各一次）+ classic-only 两条
    assert.equal(served.length, 5, `重复文本必须合并请求，实际发了 ${served.length} 次`)

    // 分片 keys 覆盖两个副本的全部 key，译文按 key 各自就位。
    const shardDir = join(out, 'legacy1')
    const chunks = readdirSync(shardDir).filter((f) => /^chunk-\d+\.json$/.test(f)).sort()
    const translations = new Map()
    for (const f of chunks) {
      const d = JSON.parse(readFileSync(join(shardDir, f), 'utf8'))
      d.keys.forEach((k, i) => translations.set(k, d.outs[i]))
    }
    assert.equal(translations.size, 8, '两个副本的 key 都要拿到译文')

    // 产物两处生效：challenge 与 classic 的同名任务文件都写出中文。
    const dir = join(root, 'legacy1')
    const list = (d, base = d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const full = join(d, e.name)
      return e.isDirectory() ? list(full, base) : [full.slice(base.length + 1).replace(/\\/g, '/')]
    }).filter((n) => /\.snbt$/i.test(n)).sort()
    const files = list(dir).filter((n) => sourceFileNames(list(dir), LAYOUT.EMBEDDED).includes(n))
      .map((n) => ({ name: n, text: readFileSync(join(dir, n), 'utf8') }))
    const pack = extractPack({ files, layout: LAYOUT.EMBEDDED })
    const outputs = buildOutputs(pack, translations)
    const byName = new Map(outputs.map((o) => [o.name, o.text]))
    const chPath = `config/ftbquests/challenge/chapters/${CH}/0241f757.snbt`
    const clPath = `config/ftbquests/classic/chapters/${CH}/0241f757.snbt`
    assert.ok(byName.get(chPath).includes('中:Stone Age'), 'challenge 副本应有译文')
    assert.ok(byName.get(clPath).includes('中:Stone Age'), 'classic 副本应有译文（两处生效）')
    assert.ok(byName.get(`config/ftbquests/classic/chapters/${CH}/0d3b082d.snbt`).includes('中:Classic Only Chapter Quest'),
      '差异文本按自己的 key 翻译')
    assert.equal(byName.get(chPath), byName.get(clPath), '同文本副本产出应一致')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

// ---- 闸门同步（validate-quests）----

test('validatePair：旧布局嵌套章节文件计入基准键集，index/file/reward_tables 不计', () => {
  const chName = `config/ftbquests/challenge/chapters/${CH}/0241f757.snbt`
  const zhQuest = challengeQuest
    .replace('Stone Age', '石器时代')
    .replace('Welcome to the pack.', '欢迎来到这个整合包。')
    .replace('Dig down and gather wood.', '往下挖并收集木头。')
  const en = [
    { name: chName, text: challengeQuest },
    { name: 'config/ftbquests/challenge/chapters/index.snbt', text: indexSnbt },
    { name: 'config/ftbquests/challenge/file.snbt', text: fileSnbt },
    { name: 'config/ftbquests/challenge/reward_tables/5e5a9f4c.snbt', text: rewardTable },
  ]
  const zh = [
    { name: chName, text: zhQuest },
    { name: 'config/ftbquests/challenge/chapters/index.snbt', text: indexSnbt },
  ]
  const r = validatePair(en, zh, { layout: LAYOUT.EMBEDDED, label: 'legacy' })
  assert.deepEqual(r.problems, [], `不应有校验问题: ${r.problems.join('; ')}`)
  // 闸门键集 = 任务文件内的全部字符串（title+2×desc+id+task id+type+item 共 7 个），
  // index 的 uid / file.snbt / reward_tables 的字符串一概不进。
  assert.equal(r.keyCount, 7)
})

test('validatePair：只剩结构文件时判「找不到英文源」，不许空转绿灯', () => {
  const en = [{ name: 'config/ftbquests/challenge/chapters/index.snbt', text: indexSnbt }]
  const zh = [{ name: 'config/ftbquests/challenge/chapters/index.snbt', text: indexSnbt }]
  const r = validatePair(en, zh, { layout: LAYOUT.EMBEDDED, label: 'legacy-empty' })
  assert.ok(r.problems.some((p) => p.includes('找不到英文源')), `应判找不到英文源: ${r.problems.join('; ')}`)
})

test('validatePair：新版 quests/chapters/ 嵌套垃圾不进基准键集', () => {
  // 与 sourceFileNames 的垃圾排除同判据：backup/ 下的文件不是源。
  const en = [{ name: 'config/ftbquests/quests/chapters/backup/bows.snbt', text: challengeQuest }]
  const r = validatePair(en, [{ name: 'config/ftbquests/quests/chapters/backup/bows.snbt', text: challengeQuest }],
    { layout: LAYOUT.EMBEDDED, label: 'junk' })
  assert.ok(r.problems.some((p) => p.includes('找不到英文源')), '垃圾嵌套文件不能当源')
})

// ---- noText 记账回归 ----

test('新版布局真没文本的包：units 为 0 仍走 noText；只剩 index.snbt 的包没有英文源', () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-notext-'))
  try {
    // onlymon 型：chapters/*.snbt 只有机械字段，无任何 title/description。
    const dir = join(root, 'notext1/config/ftbquests/quests/chapters')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'foo.snbt'), '{\n\tid: "aa",\n\ticon: "minecraft:stone"\n}\n')
    const loaded = loadPackUnits('notext1', root)
    assert.equal(loaded.layout, LAYOUT.EMBEDDED)
    assert.equal(loaded.units.length, 0, '没有可译单元 → translate-local 记 noText 的既有语义不变')

    // 只剩 index.snbt（新版结构文件）：排除后没有英文源 → loadPackUnits 返回 null，
    // 扫描侧 enFiles=0 → skipReason 判 no-en-source，不再误挂 noText。
    const dir2 = join(root, 'notext2/config/ftbquests/quests/chapters')
    mkdirSync(dir2, { recursive: true })
    writeFileSync(join(dir2, 'index.snbt'), indexSnbt)
    assert.equal(loadPackUnits('notext2', root), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
