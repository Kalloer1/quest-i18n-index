#!/usr/bin/env node
/**
 * 质量闸门 validate-quests 单测：每条失败判据都有「应判失败」的用例。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePair, extractPlaceholders, enSourceName, runBatch } from './validate-quests.mjs'
import { packBaseline } from './lib/baseline.mjs'
import { LAYOUT } from './lib/candidates.mjs'

const EN = [{ name: 'chapters/a.snbt', text: '{ title: "Hello &aWorld" desc: "Get %s apples" }' }]
const OK = [{ name: 'chapters/a.snbt', text: '{ title: "你好 &a世界" desc: "获得 %s 个苹果" }' }]

test('通过：键、色码、占位符全一致', () => {
  const r = validatePair(EN, OK, { layout: LAYOUT.EMBEDDED })
  assert.deepEqual(r.problems, [])
  assert.equal(r.keyCount, 2)
})

test('失败：缺键', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "你好" }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('缺少')))
})

test('失败：多键', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "你好" desc: "x" extra: "多出来的" }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('多出')))
})

test('失败：译文引入畸形色码（& 后不是合法码字符 / 行尾）', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "你好 &z世界" desc: "获得 %s 个苹果&" }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('畸形色码')))
})

test('失败：占位符种类/数量不一致（非 %%）', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "你好 &a世界" desc: "获得 %d 个苹果" }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('占位符不一致')))
})

test('失败：SNBT 结构不可解析', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "未闭合 }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('不可解析')))
})

test('失败：BOM', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '\uFEFF{ title: "你好 &a世界" desc: "获得 %s 个苹果" }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('BOM')))
})

test('失败：找不到英文源（绝不退回自检）', () => {
  const r = validatePair([], OK, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('找不到英文源')))
})

test('警告：色码数量差异不判失败', () => {
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "你好 世界" desc: "获得 %s 个苹果" }' }]
  const r = validatePair(EN, zh, { layout: LAYOUT.EMBEDDED })
  assert.deepEqual(r.problems, [])
  assert.ok(r.warnings.some((w) => w.includes('色码数量不一致')))
})

test('警告：%% 占位符差异不判失败', () => {
  // 内嵌布局的英文源只认 chapters/*.snbt，其余路径不算源（见文末基准集口径）。
  const en = [{ name: 'chapters/a.snbt', text: '{ t: "100%% sure" }' }]
  const zh = [{ name: 'chapters/a.snbt', text: '{ t: "100% 确定" }' }]
  const r = validatePair(en, zh, { layout: LAYOUT.EMBEDDED })
  assert.deepEqual(r.problems, [])
  assert.ok(r.warnings.some((w) => w.includes('%%')))
})

test('分离布局：键按 en_us ↔ zh_cn 换名后比对', () => {
  const en = [{ name: 'lang/en_us/a.snbt', text: '{ t: "Hi" }' }]
  const zh = [{ name: 'lang/zh_cn/a.snbt', text: '{ t: "嗨" }' }]
  const r = validatePair(en, zh, { layout: LAYOUT.SEPARATE_DIR })
  assert.deepEqual(r.problems, [])
  assert.equal(enSourceName('lang/zh_cn/a.snbt', LAYOUT.SEPARATE_DIR), 'lang/en_us/a.snbt')
  assert.equal(enSourceName('lang/zh_cn.snbt', LAYOUT.SEPARATE_SINGLE), 'lang/en_us.snbt')
})

test('extractPlaceholders：位置参数与包裹式', () => {
  const counts = extractPlaceholders('%1$s of %value% and %s and 100%%')
  assert.equal(counts.get('%1$s'), 1)
  assert.equal(counts.get('%value%'), 1)
  assert.equal(counts.get('%s'), 1)
  assert.equal(counts.get('%%'), 1)
})

// ---------- runBatch：缺英文源必须判红（假绿灯回归） ----------

test('runBatch：缺英文源判失败，不打「批量校验通过」（假绿灯回归）', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { runBatch } = await import('./validate-quests.mjs')

  const root = mkdtempSync(join(tmpdir(), 'vq-'))
  const patches = join(root, 'patches')
  const packs = join(root, 'packs')
  mkdirSync(join(patches, 'nosource'), { recursive: true })
  writeFileSync(join(patches, 'nosource', 'chapters.snbt'), '{ title: "你好" }')
  mkdirSync(packs, { recursive: true }) // 故意不给英文源

  const logs = []
  const origLog = console.log
  const origWarn = console.warn
  const origErr = console.error
  console.log = (m) => logs.push(String(m))
  console.warn = (m) => logs.push(String(m))
  console.error = (m) => logs.push(String(m))
  let code
  try {
    code = runBatch({ patchesDir: patches, packsDir: packs, datasetFile: join(root, 'none.json') })
  } finally {
    console.log = origLog
    console.warn = origWarn
    console.error = origErr
  }

  assert.equal(code, 1, '缺英文源必须退出码 1')
  assert.ok(!logs.some((l) => l.includes('批量校验通过')), '缺英文源时绝不能打「批量校验通过」')
  assert.ok(logs.some((l) => l.includes('找不到英文源')), '必须明确指出缺源')
})

// ---------- 布局判定：重复 slug 不能用 last-wins ----------

test('runBatch：同 slug 多平台时按磁盘实况判布局，不因后一行是 embedded 而误判', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { runBatch } = await import('./validate-quests.mjs')

  // 复现 create-evolution-renewed：CF 是 separate-single（磁盘上确实只有 lang/en_us.snbt），
  // MR 是 embedded。旧实现按数据集顺序 last-wins，取到 embedded，
  // 于是把 chapters/*.snbt 当基准键集，报出「缺 11301 个键 + 多出 1346 个键」的假失败。
  const root = mkdtempSync(join(tmpdir(), 'vq-layout-'))
  const slug = 'dup-slug-pack'
  const enDir = join(root, 'packs', slug, 'config/ftbquests/quests/lang')
  const zhDir = join(root, 'patches', slug, 'config/ftbquests/quests/lang')
  mkdirSync(enDir, { recursive: true })
  mkdirSync(zhDir, { recursive: true })
  writeFileSync(join(enDir, 'en_us.snbt'), '{ quest.A.title: "Hello" }')
  writeFileSync(join(zhDir, 'zh_cn.snbt'), '{ quest.A.title: "你好" }')
  // 章节文件存在但属于另一平台那条记录；不该被当成本次产出的基准
  const chapDir = join(root, 'packs', slug, 'config/ftbquests/quests/chapters')
  mkdirSync(chapDir, { recursive: true })
  writeFileSync(join(chapDir, 'a.snbt'), '{ title: "Hello" }')

  const dataset = join(root, 'ds.json')
  writeFileSync(dataset, JSON.stringify({
    dataset: [
      { slug, platform: 'cf', layout: 'separate-single' },
      { slug, platform: 'mr', layout: 'embedded' },
    ],
  }))

  const logs = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
  console.log = console.warn = console.error = (m) => logs.push(String(m))
  let code
  try {
    code = runBatch({ patchesDir: join(root, 'patches'), packsDir: join(root, 'packs'), datasetFile: dataset })
  } finally {
    Object.assign(console, orig)
  }

  assert.equal(code, 0, `不该判失败，实际日志：\n${logs.join('\n')}`)
  assert.ok(!logs.some((l) => l.includes('缺少')), '不该报缺键')
})

// ---------- 字面转义 \& 不是畸形色码 ----------

test('通过：原文 \& 在译文里写成裸 & 时不算畸形色码', () => {
  // 实测来源 chosens-create-integrated：
  //   原文 "Create Crafts \& Additions"（SNBT 里是字面转义）
  //   译文 "Create Crafts & Additions"（译成中文后转义失去意义，模型去掉了反斜杠）
  // 旧实现把裸 & 判为畸形色码（& 后跟空格不是合法码字符），判了假失败。
  const en = [{ name: 'lang/en_us.snbt', text: '{ quest.A.quest_desc: "Create Crafts \\& Additions" }' }]
  const zh = [{ name: 'lang/zh_cn.snbt', text: '{ quest.A.quest_desc: "创造工艺 & 附加内容" }' }]
  const r = validatePair(en, zh, { layout: LAYOUT.SEPARATE_SINGLE })
  assert.deepEqual(r.problems, [], `不该有 problems：${JSON.stringify(r.problems)}`)
})

test('失败：原文没有 \& 时，译文里的裸 & 仍是畸形色码', () => {
  // 反向守护：上一条放宽不能把真正的畸形色码也放过去。
  const en = [{ name: 'lang/en_us.snbt', text: '{ quest.A.quest_desc: "Get apples" }' }]
  const zh = [{ name: 'lang/zh_cn.snbt', text: '{ quest.A.quest_desc: "获得 &苹果" }' }]
  const r = validatePair(en, zh, { layout: LAYOUT.SEPARATE_SINGLE })
  assert.ok(r.problems.some((p) => p.includes('畸形色码')), '应判畸形色码')
})

test('失败：原文 \& 数量多于译文裸 & 时仍判畸形（不许凭空多出 &）', () => {
  const en = [{ name: 'lang/en_us.snbt', text: '{ quest.A.t: "A \\& B" }' }]
  const zh = [{ name: 'lang/zh_cn.snbt', text: '{ quest.A.t: "甲 & 乙 & 丙" }' }]
  const r = validatePair(en, zh, { layout: LAYOUT.SEPARATE_SINGLE })
  assert.ok(r.problems.some((p) => p.includes('畸形色码')), '多出的裸 & 应判畸形')
})

// ---- 纯 NUL 文件：上游写坏的空文件，不是「损坏的结构」 ----
//
// 实测（2026-10-22，create-cogs-cataclysm）：重下两次后仍有 3 个 .snbt
// 大小分别 565 / 291 / 474 字节，但**内容全是 0x00**。大小对、内容空，
// 是上游作者用某种工具写坏的。这类文件没有任何可翻译文本，
// 判红只会让整批闸门红着，而重下治不好它。
// 口径：纯 NUL（去掉 NUL 后为空）等同于空文件 —— 跳过校验，不判失败。

const NUL_TEXT = '\u0000'.repeat(565)

test('纯 NUL 文件等同空文件：跳过校验，不判「不可解析」', () => {
  const en = [{ name: 'chapters/a.snbt', text: '{ title: "Hello &aWorld" }' }]
  const zh = [
    { name: 'chapters/a.snbt', text: '{ title: "你好 &a世界" }' },
    { name: 'chapters/empty.snbt', text: NUL_TEXT },
  ]
  const r = validatePair(en, zh, { layout: LAYOUT.EMBEDDED })
  assert.deepEqual(r.problems, [], '纯 NUL 文件不应判失败')
})

test('英文源是纯 NUL 时也不判失败（上游坏文件不该拖死整包）', () => {
  const en = [
    { name: 'chapters/a.snbt', text: '{ title: "Hello" }' },
    { name: 'chapters/broken.snbt', text: NUL_TEXT },
  ]
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "你好" }' }]
  const r = validatePair(en, zh, { layout: LAYOUT.EMBEDDED })
  assert.deepEqual(r.problems, [])
})

test('真正损坏（有内容但结构错）仍判失败 —— 跳过只针对纯 NUL', () => {
  const en = [{ name: 'chapters/a.snbt', text: '{ title: "Hello" }' }]
  const zh = [{ name: 'chapters/a.snbt', text: '{ title: "未闭合 }' }]
  const r = validatePair(en, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('不可解析')))
})

// ---- 内嵌布局的基准键集：只算本布局负责改写的文件 ----
//
// 缺陷（2026-10-22）：内嵌产出只改写 `chapters/*.snbt`，闸门却拿英文源目录下
// **所有** `.snbt` 当基准键集，于是 `data.snbt`、`reward_tables/*.snbt` 永远「缺键」判红。
// 口径：产出什么就校验什么 —— 基准集 = `sourceFileNames(embedded)` = `chapters/*.snbt`。
// 之前没暴露是因为 `resolveLayout` 优先判「分离·目录 / 分离·单文件」，
// 带 `lang/en_us.snbt` 的包根本走不到内嵌这条分支。

const QUEST_DIR = 'config/ftbquests/quests'
const EN_MIXED = [
  { name: `${QUEST_DIR}/chapters/a.snbt`, text: '{ title: "Hello &aWorld" desc: "Get %s apples" }' },
  { name: `${QUEST_DIR}/data.snbt`, text: '{ title: "Quest data" }' },
  { name: `${QUEST_DIR}/reward_tables/x.snbt`, text: '{ title: "Reward A" }' },
]
const ZH_CHAPTER_ONLY = [
  { name: `${QUEST_DIR}/chapters/a.snbt`, text: '{ title: "你好 &a世界" desc: "获得 %s 个苹果" }' },
]

test('内嵌布局：非章节文件（data.snbt、reward_tables/*.snbt）不进基准键集', () => {
  const r = validatePair(EN_MIXED, ZH_CHAPTER_ONLY, { layout: LAYOUT.EMBEDDED })
  assert.deepEqual(r.problems, [], `不该报缺键：${JSON.stringify(r.problems)}`)
  assert.equal(r.keyCount, 2, '基准键数只该来自 chapters/a.snbt')
})

test('内嵌布局：章节文件真缺键仍判红（修成「一律放行」就挂这条）', () => {
  const zh = [{ name: `${QUEST_DIR}/chapters/a.snbt`, text: '{ title: "你好 &a世界" }' }]
  const r = validatePair(EN_MIXED, zh, { layout: LAYOUT.EMBEDDED })
  const missing = r.problems.find((p) => p.includes('缺少'))
  assert.ok(missing, `章节文件少一个键必须判红，实际：${JSON.stringify(r.problems)}`)
  assert.ok(missing.includes('desc'), `缺键里应点名 desc，实际：${missing}`)
})

test('内嵌布局：产出多出的非章节文件允许，但不作校验基准', () => {
  // 有人手动把 data.snbt 也复制进产出：允许（不判「多出」），但不进基准键集。
  const zh = [...ZH_CHAPTER_ONLY, { name: `${QUEST_DIR}/data.snbt`, text: '{ title: "任务数据" }' }]
  const r = validatePair(EN_MIXED, zh, { layout: LAYOUT.EMBEDDED })
  assert.deepEqual(r.problems, [])
  assert.equal(r.keyCount, 2)
})

test('内嵌布局：多出的非章节文件仍要过结构检查（不是整份跳过）', () => {
  const zh = [...ZH_CHAPTER_ONLY, { name: `${QUEST_DIR}/data.snbt`, text: '{ title: "未闭合 }' }]
  const r = validatePair(EN_MIXED, zh, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('不可解析')), '多出的非章节文件也要能解析')
})

test('内嵌布局：英文源里没有章节文件时判红（不许 0 键空转绿灯）', () => {
  const en = [{ name: `${QUEST_DIR}/data.snbt`, text: '{ title: "Quest data" }' }]
  const r = validatePair(en, ZH_CHAPTER_ONLY, { layout: LAYOUT.EMBEDDED })
  assert.ok(r.problems.some((p) => p.includes('找不到英文源')), `实际：${JSON.stringify(r.problems)}`)
})

// ---------- 基准源双读：目录 或 <slug>.tar.gz ----------

function batchEnv(t) {
  const dir = mkdtempSync(join(tmpdir(), 'quest-batch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const patchesDir = join(dir, 'patches')
  const packsDir = join(dir, 'packs')
  mkdirSync(join(patchesDir, 'demo', 'chapters'), { recursive: true })
  mkdirSync(packsDir, { recursive: true })
  writeFileSync(join(patchesDir, 'demo', 'chapters', 'a.snbt'), '{ title: "你好 &a世界" }\n')
  return { dir, patchesDir, packsDir }
}

/** 捕获 runBatch 的汇总输出（它直接写 console）。 */
function captureConsole(t) {
  const logs = []
  const errs = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => logs.push(a.join(' '))
  console.error = (...a) => errs.push(a.join(' '))
  t.after(() => {
    console.log = origLog
    console.error = origErr
  })
  return { logs, errs }
}

test('runBatch：只有 <slug>.tar.gz 时能校验通过（双读替代目录）', (t) => {
  const { dir, patchesDir, packsDir } = batchEnv(t)
  captureConsole(t)
  const enDir = join(dir, 'en-src')
  mkdirSync(join(enDir, 'chapters'), { recursive: true })
  writeFileSync(join(enDir, 'chapters', 'a.snbt'), '{ title: "Hello &aWorld" }\n')
  packBaseline(enDir, join(packsDir, 'demo.tar.gz'))

  const code = runBatch({ patchesDir, packsDir, datasetFile: join(dir, 'none.json') })
  assert.equal(code, 0)
})

test('runBatch：目录与 tar.gz 都没有时仍判红（缺基准键集，不许假绿灯）', (t) => {
  const { dir, patchesDir, packsDir } = batchEnv(t)
  const { errs } = captureConsole(t)
  const code = runBatch({ patchesDir, packsDir, datasetFile: join(dir, 'none.json') })
  assert.equal(code, 1)
  assert.ok(errs.some((m) => m.includes('找不到英文源')), errs.join('\n'))
})

test('runBatch：目录存在时优先走目录（与历史行为一致）', (t) => {
  const { dir, patchesDir, packsDir } = batchEnv(t)
  captureConsole(t)
  const enDir = join(packsDir, 'demo')
  mkdirSync(join(enDir, 'chapters'), { recursive: true })
  writeFileSync(join(enDir, 'chapters', 'a.snbt'), '{ title: "Hello &aWorld" }\n')
  // 归档里放一份错的源：若被误用会判缺键。目录优先 → 应通过。
  const badSrc = join(dir, 'bad-src')
  mkdirSync(join(badSrc, 'chapters'), { recursive: true })
  writeFileSync(join(badSrc, 'chapters', 'a.snbt'), '{ other: "x" }\n')
  packBaseline(badSrc, join(packsDir, 'demo.tar.gz'))

  const code = runBatch({ patchesDir, packsDir, datasetFile: join(dir, 'none.json') })
  assert.equal(code, 0)
})
