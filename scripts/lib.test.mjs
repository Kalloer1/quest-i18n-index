#!/usr/bin/env node
/**
 * scripts/lib/ 四个纯函数模块的单测：色码、术语记忆、候选筛选、任务书抽取/产出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { stripColorCodes, countColorCodes, countMalformedCodes } from './lib/format-codes.mjs'
import {
  stripSkeleton, isSourceEcho, isUsableMemory, lookupMemory,
  shouldRememberMemory, mergeGlossary,
} from './lib/glossary.mjs'
import { classifyLayout, skipReason, screenCandidates, LAYOUT, SKIP } from './lib/candidates.mjs'
import {
  isTranslatablePath, sourceFileNames, outputName, extractPack, buildOutputs,
} from './lib/quest-files.mjs'
import { parse } from './snbt.mjs'
import { readFileSync } from 'node:fs'
import { fetchRetry } from './lib/fetch-retry.mjs'
import { repairUnclosedStringLists, repairKeyInsideList, repairEmptyKeyEntries, repairNestedSingleQuotes, repairSlashComments, repairEmptyValueEntries, repairMissingCloseBrace, repairStrayQuoteInStringList, repairUnclosedStringValue, repairMissingOpenQuote, repairUnclosedListElement } from './lib/snbt-repair.mjs'

// ---------- format-codes ----------

test('stripColorCodes：剥离合法色码，保留正文', () => {
  assert.equal(stripColorCodes('&7Holystone&r Weapons'), 'Holystone Weapons')
  assert.equal(stripColorCodes('§eThe Aether§r'), 'The Aether')
  assert.equal(stripColorCodes('&c&lSun Spirit&r'), 'Sun Spirit')
})

const BS = String.fromCharCode(92)
test('stripColorCodes：字面转义 \\& 保留为 &', () => {
  assert.equal(stripColorCodes(`${BS}&`), '&')
  assert.equal(stripColorCodes(`${BS}&n&7x`), '&nx')
})

test('countColorCodes：合法码计数，转义不算', () => {
  assert.equal(countColorCodes('&a&b&c'), 3)
  assert.equal(countColorCodes('\\&a'), 0)
  assert.equal(countColorCodes('§6§l'), 2)
})

test('countMalformedCodes：畸形序列计数（行尾/非法后继）', () => {
  assert.equal(countMalformedCodes('abc&'), 1)
  assert.equal(countMalformedCodes('&gg'), 1)
  assert.equal(countMalformedCodes('§'), 1)
  assert.equal(countMalformedCodes('\\&x'), 0)
  assert.equal(countMalformedCodes('&a好'), 0)
})

// ---------- glossary ----------

test('stripSkeleton：剥色码 + 小写 + 压缩空白', () => {
  assert.equal(stripSkeleton('&7Holystone&r   Weapons'), 'holystone weapons')
  assert.equal(stripSkeleton('  The   Aether '), 'the aether')
})

test('isSourceEcho：逐字比较', () => {
  assert.equal(isSourceEcho('same', 'same'), true)
  assert.equal(isSourceEcho('Same', 'same'), false)
})

test('isUsableMemory：空值与英文回显都不可用', () => {
  assert.equal(isUsableMemory('译文', '原文'), true)
  assert.equal(isUsableMemory('', '原文'), false)
  assert.equal(isUsableMemory('原文', '原文'), false)
  assert.equal(isUsableMemory(undefined, '原文'), false)
})

test('lookupMemory：按骨架命中，污染条目视为未命中', () => {
  const entries = { 'holystone weapons': '圣愈石武器', 'echo trap': 'Echo Trap' }
  assert.equal(lookupMemory(entries, '&7Holystone&r Weapons'), '圣愈石武器')
  assert.equal(lookupMemory(entries, 'Echo Trap'), undefined)
  assert.equal(lookupMemory(entries, ''), undefined)
})

test('shouldRememberMemory：骨架空/已有/回显都不记', () => {
  assert.equal(shouldRememberMemory('k', '译文', '原文', undefined), true)
  assert.equal(shouldRememberMemory('', '译文', '原文', undefined), false)
  assert.equal(shouldRememberMemory('k', '译文', '原文', '已有'), false)
  assert.equal(shouldRememberMemory('k', '原文', '原文', undefined), false)
})

test('mergeGlossary：合并式回写，历史条目优先', () => {
  const existing = { a: '旧译', b: '保留' }
  const out = mergeGlossary(existing, { a: '新译', c: '新增', d: '' })
  assert.deepEqual(out, { a: '旧译', b: '保留', c: '新增' })
  assert.deepEqual(existing, { a: '旧译', b: '保留' }) // 不改入参
})

// ---------- candidates ----------

test('classifyLayout：分离·目录', () => {
  const r = classifyLayout([
    'config/ftbquests/quests/lang/en_us/chapter.snbt',
    'config/ftbquests/quests/lang/zh_cn/chapter.snbt',
    'config/ftbquests/quests/chapters/chapter.snbt',
  ])
  assert.equal(r.layout, LAYOUT.SEPARATE_DIR)
  assert.equal(r.enFiles, 1)
  assert.equal(r.zhFiles, 1)
  assert.equal(r.hasQuests, true)
})

test('classifyLayout：分离·单文件', () => {
  const r = classifyLayout(['config/ftbquests/quests/lang/en_us.snbt'])
  assert.equal(r.layout, LAYOUT.SEPARATE_SINGLE)
  assert.equal(r.enFiles, 1)
  assert.equal(r.zhFiles, 0)
})

test('classifyLayout：内嵌', () => {
  const r = classifyLayout(['config/ftbquests/quests/chapters/chapter.snbt'])
  assert.equal(r.layout, LAYOUT.EMBEDDED)
  assert.equal(r.enFiles, 1)
  assert.equal(r.embeddedFiles, 1)
})

test('classifyLayout：无任务书 / 有 ftbquests 但无 snbt 布局', () => {
  assert.equal(classifyLayout(['mods/a.jar']).layout, LAYOUT.NONE)
  assert.equal(classifyLayout(['config/ftbquests/other.txt']).layout, LAYOUT.OTHER)
})

test('skipReason：四种跳过原因', () => {
  assert.equal(skipReason({ layout: LAYOUT.NONE }), SKIP.NO_QUESTS)
  assert.equal(skipReason({ layout: LAYOUT.OTHER }), SKIP.NO_QUESTS)
  assert.equal(skipReason({ layout: LAYOUT.EMBEDDED, zhFiles: 2 }), SKIP.NATIVE_ZH)
  assert.equal(skipReason({ layout: LAYOUT.SEPARATE_DIR, enFiles: 0 }), SKIP.NO_EN_SOURCE)
  assert.equal(skipReason({ layout: LAYOUT.EMBEDDED, enFiles: 1, version: '1.2', translatedVersion: '1.2' }), SKIP.UP_TO_DATE)
  assert.equal(skipReason({ layout: LAYOUT.EMBEDDED, enFiles: 1 }), null)
})

test('screenCandidates：候选与跳过清单分离', () => {
  const rows = [
    { slug: 'good', layout: LAYOUT.EMBEDDED, enFiles: 1 },
    { slug: 'bad', layout: LAYOUT.NONE },
  ]
  const { candidates, skipped } = screenCandidates(rows)
  assert.deepEqual(candidates, [rows[0]])
  assert.deepEqual(skipped, [{ slug: 'bad', reason: SKIP.NO_QUESTS }])
})

// ---------- quest-files ----------

const SEP_DIR_EN = 'config/ftbquests/quests/lang/en_us/chapter.snbt'
const EMBED = 'config/ftbquests/quests/chapters/chapter.snbt'

test('isTranslatablePath：内嵌只翻文本字段，分离全翻', () => {
  assert.equal(isTranslatablePath('title', LAYOUT.EMBEDDED), true)
  assert.equal(isTranslatablePath('tasks[0].item', LAYOUT.EMBEDDED), false)
  assert.equal(isTranslatablePath('icon', LAYOUT.EMBEDDED), false)
  assert.equal(isTranslatablePath('whatever.key', LAYOUT.SEPARATE_DIR), true)
})

test('sourceFileNames / outputName：三种布局', () => {
  const names = [SEP_DIR_EN, 'config/ftbquests/quests/lang/zh_cn/x.snbt', EMBED, 'lang/en_us.snbt']
  assert.deepEqual(sourceFileNames(names, LAYOUT.SEPARATE_DIR), [SEP_DIR_EN])
  assert.deepEqual(sourceFileNames(names, LAYOUT.SEPARATE_SINGLE), ['lang/en_us.snbt'])
  assert.deepEqual(sourceFileNames(names, LAYOUT.EMBEDDED), [EMBED])
  assert.equal(outputName(SEP_DIR_EN, LAYOUT.SEPARATE_DIR), SEP_DIR_EN.replace('/en_us/', '/zh_cn/'))
  assert.equal(outputName('lang/en_us.snbt', LAYOUT.SEPARATE_SINGLE), 'lang/zh_cn.snbt')
  assert.equal(outputName(EMBED, LAYOUT.EMBEDDED), EMBED)
})

test('extractPack / buildOutputs：内嵌布局只改文本字段，其余字节无损', () => {
  const text = readFileSync('scripts/fixtures/snbt/aether.snbt', 'utf8')
  const pack = extractPack({ files: [{ name: EMBED, text }], layout: LAYOUT.EMBEDDED })
  // 内嵌布局只翻文本字段：夹具里是 3 个 title（quest_desc 不在 TEXT_FIELDS）
  assert.equal(pack.units.length, 3)
  const translations = new Map(pack.units.map((u) => [u.key, `中:${u.text}`]))
  const outputs = buildOutputs(pack, translations, { header: '# AI 初翻，未人工校对\n' })
  assert.equal(outputs[0].name, EMBED)
  assert.ok(outputs[0].text.startsWith('# AI 初翻，未人工校对\n'))
  const body = outputs[0].text.slice('# AI 初翻，未人工校对\n'.length)
  // 未改写的结构无损；被改写的字符串值已替换
  assert.ok(body.includes('中:&7Holystone&r Weapons'))
  // 再解析不抛错
  parse(body)
})

test('extractPack：分离布局所有字符串都可翻', () => {
  const pack = extractPack({
    files: [{ name: SEP_DIR_EN, text: '{ "quest.a.title": "Hello" }' }],
    layout: LAYOUT.SEPARATE_DIR,
  })
  assert.equal(pack.units.length, 1)
  assert.equal(pack.units[0].key, `${SEP_DIR_EN}::quest.a.title`)
})

// ---------- snbt-repair ----------
// 上游整合包确实存在「忘了收尾 "]」的坏行（cleancraft-by-acul-neoforged 实测）。
// 这种坏行会让整个文件解析错位，拖死整包翻译。判据要窄，不误伤合法多行字符串。

test('repairUnclosedStringLists：补上遗漏的 "]，且后续行不被吞进字符串', () => {
  const bad = '{\n\tquest.A.quest_desc: ["This Quest has been authored by X.\n\tquest.B.title: "Hello"\n\tquest.C.title: "World"\n}'
  const { text, repaired } = repairUnclosedStringLists(bad)
  assert.equal(repaired.length, 1)
  assert.equal(repaired[0].key, 'quest.A.quest_desc')
  assert.match(text, /quest\.A\.quest_desc: \["This Quest has been authored by X\."\]/)
  // 修完后整份文件必须能解析
  assert.doesNotThrow(() => parse(text))
  const root = parse(text).value
  const byKey = Object.fromEntries(root.entries.map((e) => [e.key.value, e.value.value]))
  assert.equal(byKey['quest.B.title'], 'Hello')
  assert.equal(byKey['quest.C.title'], 'World')
})

test('repairUnclosedStringLists：正常的单行列表/跨行长文本不动', () => {
  const ok = '{\n\tquest.A.quest_desc: ["one line"]\n\tquest.B.quest_desc: ["multi\nline text"]\n}'
  const { text, repaired } = repairUnclosedStringLists(ok)
  assert.equal(repaired.length, 0)
  assert.equal(text, ok)
})

test('repairUnclosedStringLists：后面不是新键行时不修（避免误伤）', () => {
  const s = '{\n\tquest.A.quest_desc: ["open text\nplain continuation line\n}'
  const { repaired } = repairUnclosedStringLists(s)
  assert.equal(repaired.length, 0)
})

// ---------- fetch-retry ----------
// 用全局 fetch 桩验证重试行为，不联网。baseWaitMs 传 1 让退避几乎不耗时。
const withFetch = async (impl, fn) => {
  const orig = globalThis.fetch
  globalThis.fetch = impl
  try { return await fn() } finally { globalThis.fetch = orig }
}
const retryResp = (status) => ({ status, ok: status >= 200 && status < 300 })

test('fetchRetry：瞬时网络错误重试后成功', async () => {
  let n = 0
  await withFetch(async () => { n++; if (n < 3) throw new TypeError('fetch failed'); return retryResp(200) }, async () => {
    const res = await fetchRetry('https://x/y', {}, 5, 60_000, 1)
    assert.equal(res.status, 200)
    assert.equal(n, 3, '前两次失败、第三次应成功')
  })
})

test('fetchRetry：5xx/429 重试，4xx/302 原样返回不重试', async () => {
  let n = 0
  await withFetch(async () => { n++; return n < 2 ? retryResp(503) : retryResp(200) }, async () => {
    const res = await fetchRetry('https://x/y', {}, 5, 60_000, 1)
    assert.equal(res.status, 200)
    assert.equal(n, 2)
  })
  let m = 0
  await withFetch(async () => { m++; return retryResp(404) }, async () => {
    const res = await fetchRetry('https://x/y', {}, 5, 60_000, 1)
    assert.equal(res.status, 404)
    assert.equal(m, 1, '404 不该重试')
  })
  await withFetch(async () => retryResp(302), async () => {
    const res = await fetchRetry('https://x/y', {}, 5, 60_000, 1)
    assert.equal(res.status, 302)
  })
})

test('fetchRetry：所有尝试都失败则抛出最后一次错误', async () => {
  let n = 0
  await withFetch(async () => { n++; throw new TypeError('fetch failed') }, async () => {
    await assert.rejects(() => fetchRetry('https://x/y', {}, 3, 60_000, 1), /fetch failed/)
    assert.equal(n, 3, '应尝试 tries 次')
  })
})

// ---------- snbt-repair：列表里混进键值对 ----------
// 实测（2026-10-22，realms-of-reverie 的 en_us.snbt 第 165 行）：
// `quest_desc: [` 开了列表，紧接着却是一整行 `quest.XXX.title: "..."`，
// 列表元素位置出现了键值对 —— 结构非法，解析器报「无法解析的值：":"」。
// 这是与「忘了收尾 "]"」不同的第三种损坏形态：**列表里混进了一个键值对**。
//
// 正确语义：那个 title 是**同级**的另一个键，不该被吞进列表里。
// 修法是把它移到列表闭合之后。

test('repairKeyInsideList：列表里混进的键值对挪到列表外，列表照常闭合', () => {
  const bad = [
    '{',
    '\tquest.A.quest_desc: [',
    '\tquest.A.title: "&4The Dark Tower"',
    '\t\t"The tower looms in the dark forest."',
    '\t\t""',
    '\t\t"Bring tears."',
    '\t]',
    '}',
  ].join('\n')
  const { text, repaired } = repairKeyInsideList(bad)
  assert.equal(repaired.length, 1)
  assert.equal(repaired[0].key, 'quest.A.title')
  // 修完必须能解析
  const root = parse(text).value
  const byKey = Object.fromEntries(root.entries.map((e) => [e.key.value, e.value]))
  assert.equal(byKey['quest.A.title'].value, '&4The Dark Tower', 'title 必须是字符串值，不能丢')
  assert.equal(byKey['quest.A.quest_desc'].type, 'list', 'quest_desc 必须仍是列表')
  assert.deepEqual(byKey['quest.A.quest_desc'].items.map((it) => it.value.value),
    ['The tower looms in the dark forest.', '', 'Bring tears.'],
    '列表内容不得被 title 行污染')
})

test('repairKeyInsideList：正常文件一字不动', () => {
  const ok = [
    '{',
    '\tquest.A.quest_desc: [',
    '\t\t"line one"',
    '\t\t"line two"',
    '\t]',
    '\tquest.A.title: "Hello"',
    '}',
  ].join('\n')
  const { text, repaired } = repairKeyInsideList(ok)
  assert.equal(repaired.length, 0)
  assert.equal(text, ok)
})

test('repairKeyInsideList：列表里只有正常字符串时不误判', () => {
  const ok = '{\n\tquest.A.quest_desc: ["a: b", "c: d"]\n}'
  const { repaired } = repairKeyInsideList(ok)
  assert.equal(repaired.length, 0)
})

// ---------- snbt-repair：空键条目 ----------
// 实测（2026-10-24，bloom-beyond 的 reward_tables/boite_homunculus.snbt、
// furnace-to-singularity 的 chapters/45C34EAF227433AE.snbt）：
// compound 条目丢了键名，只剩 `: 0` / `: "BOOLEAN"`。
// 修法选丢弃：键名不可恢复，补占位键等于向游戏 NBT 编造结构。

test('repairEmptyKeyEntries：空键条目整行丢弃，其余条目保留', () => {
  const bad = [
    '{',
    '\titem: {',
    '\t\tCount: 1',
    '\t\tid: "minecraft:stone"',
    '\t\ttag: {',
    '\t\t\t: 0',
    '\t\t\tAccelerator: 0',
    '\t\t\tAmount: 0',
    '\t\t}',
    '\t}',
    '}',
  ].join('\n')
  const { text, repaired } = repairEmptyKeyEntries(bad)
  assert.equal(repaired.length, 1)
  assert.match(repaired[0].key, /^\(空键\)0$/)
  const root = parse(text).value
  const item = root.entries.find((e) => e.key.value === 'item').value
  const tag = item.entries.find((e) => e.key.value === 'tag').value
  const tagKeys = tag.entries.map((e) => e.key.value)
  assert.deepEqual(tagKeys, ['Accelerator', 'Amount'], '空键条目没了，其余保留')
  assert.doesNotThrow(() => parse(text))
})

test('repairEmptyKeyEntries：整个 compound 只剩空键条目 → 丢弃后成为空 compound', () => {
  const bad = '{\n\tprops: [\n\t\t[\n\t\t\t{\n\t\t\t\t: "BOOLEAN"\n\t\t\t}\n\t\t\t{\n\t\t\t\tname: "x"\n\t\t\t}\n\t\t]\n\t]\n}'
  const { text, repaired } = repairEmptyKeyEntries(bad)
  assert.equal(repaired.length, 1)
  assert.doesNotThrow(() => parse(text))
})

test('repairEmptyKeyEntries：文件本来能解析、或上一行不以 { 结尾时不误伤', () => {
  // 能解析的文件 → 全局守卫，一个字节不动
  const ok = '{\n\ttag: {\n\t\t: 0\n\t}\n}'.replace('\t\t: 0\n', '') // 本来就没有空键
  assert.equal(repairEmptyKeyEntries(ok).repaired.length, 0)
  // 不能解析、但空键行不在 compound 首条目位置 → 放弃不动
  const ambiguous = '{\n\ttag: {\n\t\tA: 1\n\t\t: 0\n\t}\n}'
  const { repaired } = repairEmptyKeyEntries(ambiguous)
  assert.equal(repaired.length, 0, '非首条目的空键行形态未实测，宁可不动')
})

// ---------- snbt-repair：单引号串内嵌单引号 ----------
// 实测（2026-10-24，forge-and-fortify 的 reward_tables/bathhouse.snbt）：
// `nbt: '{display:{Name:'{"text":"Absinthe"}'…}'` —— 内嵌 JSON 文本组件的
// 单引号没转义，外层串提前闭合。同文件 `Kayra\'s Curse` 是上游自己的正确先例。
// 按 `\'` 转义而非 `''`：本仓解析器把引号字符一律当终止符，不支持 doubling。

// 坏行（SNBT 文件内容，与 forge-and-fortify 实测同构）：内嵌单引号裸着。
// JS 字面量里 `\'` = 裸 `'`，`\\\'` = `\'`（文件里已转义的引号）。
const NESTED_BAD = [
  '[',
  "  { item: \"minecraft:potion\", nbt: '{display:{Name:'{\"text\":\"Absinthe\",\"italic\":false}'},CustomPotionColor:13762483}', weight: 2.0f }",
  "  { item: \"minecraft:iron\", weight: 1.0f }",
  ']',
].join('\n')

test('repairNestedSingleQuotes：内嵌单引号按 \\\' 转义，值内容逐字节保留', () => {
  const { text, repaired } = repairNestedSingleQuotes(NESTED_BAD)
  assert.equal(repaired.length, 1)
  const root = parse(text).value
  const item = root.items[0].value
  const nbt = item.entries.find((e) => e.key.value === 'nbt').value
  assert.equal(nbt.value, '{display:{Name:\'{"text":"Absinthe","italic":false}\'},CustomPotionColor:13762483}', '解析值 = 上游本意')
  assert.equal(item.entries.find((e) => e.key.value === 'weight').value.raw, '2.0f', '后续字段不被吞')
})

test('repairNestedSingleQuotes：已有 \\\' 转义（Kayra\\\'s 形态）不双重转义', () => {
  const bad = "{ item: \"minecraft:potion\", nbt: '{display:{Name:'{\"text\":\"Kayra\\\'s Curse\",\"italic\":false}'}},CustomPotionColor:6519211}', weight: 2.0f }"
  const { text, repaired } = repairNestedSingleQuotes(bad)
  assert.equal(repaired.length, 1)
  const nbt = parse(text).value.entries.find((e) => e.key.value === 'nbt').value
  assert.equal(nbt.value, '{display:{Name:\'{"text":"Kayra\'s Curse","italic":false}\'}},CustomPotionColor:6519211}')
  assert.ok(!nbt.raw.includes("\\\\'"), '不得把已有 \\\' 变成 \\\\\'')
})

test('repairNestedSingleQuotes：合法多引号行与含混行不动', () => {
  // 能解析的文件 → 全局守卫不动
  const ok = '{ nbt: \'{Potion:"minecraft:water"}\', weight: 1.0f }'
  assert.equal(repairNestedSingleQuotes(ok).repaired.length, 0)
  // 中间引号不贴嵌套结构（含混归属）→ 整行放弃
  const ambiguous = '{ x: \'a\', nbt: \'{Name:\\\'{"t":1}\'} }'.replace(/\\\\'/g, "'")
  const { repaired } = repairNestedSingleQuotes(ambiguous + '\n}')
  assert.equal(repaired.length, 0, 'x 的闭合引号不贴 {}，太含混不动')
})

// ---------- snbt-repair：// 注释 ----------
// 实测（2026-10-24，the-world-of-dinosaurs 的 exploration.snbt）：
// 值位置出现 `// Placeholder: …`（SNBT 注释是 `#`），解析器报「无法解析的值："/"」。

test('repairSlashComments：行首 // 换成 #，注释内容保留，文件转为可解析', () => {
  const bad = [
    '{',
    '  "task": {',
    '    "type": "custom" ',
    '    // Placeholder: requires custom trigger',
    '  }',
    '}',
  ].join('\n')
  const { text, repaired } = repairSlashComments(bad)
  assert.equal(repaired.length, 1)
  assert.match(text, /# Placeholder: requires custom trigger/)
  assert.ok(!text.includes('//'))
  assert.doesNotThrow(() => parse(text))
})

test('repairSlashComments：撇号注释（Xaero\'s）也放行；转换后仍不可解析则整体回滚', () => {
  const bad = '{\n\t"a": "b"\n\t// Xaero\'s Minimap note\n}'
  const { text, repaired } = repairSlashComments(bad)
  assert.equal(repaired.length, 1)
  assert.match(text, /# Xaero's Minimap note/)
  // 转换救不活的文件 → 一个字节不动
  const hopeless = '{\n\t"a": "b"\n\t// note\n\t???\n}'
  const r2 = repairSlashComments(hopeless)
  assert.equal(r2.repaired.length, 0)
  assert.equal(r2.text, hopeless)
})

test('repairSlashComments：字符串里的 URL 行不动', () => {
  const ok = '{\n\tdoc: ["see https://example.com/x for details"]\n}'
  const r = repairSlashComments(ok)
  assert.equal(r.repaired.length, 0)
  assert.equal(r.text, ok)
})

// ---------- snbt-repair：条目只有键没有值 ----------

test('repairEmptyValueEntries：空值条目补 []，下一行是键值对才触发', () => {
  const bad = [
    '{',
    '\tdependencies:',
    '\tdescription: [',
    '\t\t"prose"',
    '\t]',
    '}',
  ].join('\n')
  const { text, repaired } = repairEmptyValueEntries(bad)
  assert.equal(repaired.length, 1)
  assert.equal(repaired[0].key, 'dependencies')
  assert.match(text, /dependencies: \[\]/)
  assert.doesNotThrow(() => parse(text))
})

test('repairEmptyValueEntries：下一行是值开头（列表/字符串）时不误伤', () => {
  // 下一行是字符串元素 → 不是「键吃掉下一行键名」的形态，不动
  const ok = '{\n\titems: [\n\t\t"a"\n\t]\n}'
  const r = repairEmptyValueEntries(ok)
  assert.equal(r.repaired.length, 0)
  assert.equal(r.text, ok)
})

// ---------- snbt-repair：compound 少收尾 } ----------

test('repairMissingCloseBrace：在撞车的 ] 处补 }，修后可解析', () => {
  const bad = [
    '{',
    '\ttasks: [{',
    '\t\titem: {',
    '\t\t\ttag: {',
    '\t\t\t\tPokeBallID: "ultra_ball"',
    '\t\t\t}',
    '\t\t\tmatch_nbt: true',
    '\t}]',
    '}',
  ].join('\n')
  const { text, repaired } = repairMissingCloseBrace(bad)
  assert.equal(repaired.length, 1)
  assert.doesNotThrow(() => parse(text))
  const root = parse(text).value
  const tasks = root.entries.find((e) => e.key.value === 'tasks').value
  assert.equal(tasks.type, 'list')
})

test('repairMissingCloseBrace：能解析的文件不动', () => {
  const ok = '{\n\ttasks: [{\n\t\titem: {}\n\t}]\n}'
  const r = repairMissingCloseBrace(ok)
  assert.equal(r.repaired.length, 0)
  assert.equal(r.text, ok)
})

// ---------- snbt-repair：单行字符串列表里混进没转义的 " ----------

test('repairStrayQuoteInStringList：杂物引号补 \\ 转义，字节全保留', () => {
  // 原文（dawncraft 实测形态）：行尾 `…«Note»\."."]` —— `\.` 后的裸 `"` 让串提前闭合。
  const BSx = String.fromCharCode(92)
  const raw = '{\n\tdescription: ["text from «Note»' + BSx + '."."]\n}'
  const { text, repaired } = repairStrayQuoteInStringList(raw)
  assert.equal(repaired.length, 1)
  const root = parse(text).value
  const d = root.entries.find((e) => e.key.value === 'description').value
  assert.equal(d.type, 'list')
  assert.equal(d.items[0].value.value, 'text from «Note»' + BSx + '.".')  // `\.` 保留 + 补转义的引号
})

test('repairStrayQuoteInStringList：健康的双元素列表不动', () => {
  const ok = '{\n\tdescription: ["first", "second"]\n}'
  const r = repairStrayQuoteInStringList(ok)
  assert.equal(r.repaired.length, 0)
  assert.equal(r.text, ok)
})

// ---------- snbt-repair：字符串值忘了收尾引号 ----------

test('repairUnclosedStringValue：行末补右引号，下一行不被吞', () => {
  const bad = [
    '{',
    '\tgroup: "0F9BFF21DB6FDC1E',
    '\ticon: "dustydecorations:bookstack"',
    '\tid: "41C80F49D58EB175"',
    '}',
  ].join('\n')
  const { text, repaired } = repairUnclosedStringValue(bad)
  assert.equal(repaired.length, 1)
  assert.equal(repaired[0].key, 'group')
  const root = parse(text).value
  const byKey = Object.fromEntries(root.entries.map((e) => [e.key.value, e.value.value]))
  assert.equal(byKey['group'], '0F9BFF21DB6FDC1E')
  assert.equal(byKey['icon'], 'dustydecorations:bookstack')
})

test('repairUnclosedStringValue：正常跨行长文本不动', () => {
  const ok = '{\n\tnote: "第一行\n第二行还在字符串里"\n\tid: "X"\n}'
  const r = repairUnclosedStringValue(ok)
  assert.equal(r.repaired.length, 0)
  assert.equal(r.text, ok)
})

// ---------- snbt-repair：值是裸 {quest.N.title} 缺左引号 ----------
// 2026-10-25 实测：crafting-craft-2 的 chapters/7858BB56C9DEDD06.snbt L252，
// 报「compound 条目缺少 ":"」—— 值以 { 开头被当 compound 读。同文件其他同类键都有引号。

test('repairMissingOpenQuote：`key: {quest.N.title}"` 补左引号后能 parse', () => {
  const bad = [
    '{',
    '\tid: "ABC"',
    '\ticon: "book"',
    '\ttitle: {quest.156.title}"',
    '}',
  ].join('\n')
  const { text, repaired } = repairMissingOpenQuote(bad)
  assert.equal(repaired.length, 1)
  assert.equal(repaired[0].key, 'title')
  const root = parse(text).value
  const byKey = Object.fromEntries(root.entries.map((e) => [e.key.value, e.value.value]))
  assert.equal(byKey.title, '{quest.156.title}', '值内容只能多一对引号，不能丢字节')
})

test('repairMissingOpenQuote：健康的带引号模板值不动', () => {
  const ok = '{\n\ttitle: "{quest.151.title}"\n}'
  const r = repairMissingOpenQuote(ok)
  assert.equal(r.repaired.length, 0)
  assert.equal(r.text, ok)
})

test('repairMissingOpenQuote：非 quest 模板形态的裸花括号不碰（规则要窄）', () => {
  // 值不是 {quest.N.<字段>} 形态（比如真 compound），补引号只会把结构改坏 —— 不在窄规则命中面内。
  const bad = '{\n\tx: {a: 1}"\n}'
  const r = repairMissingOpenQuote(bad)
  assert.equal(r.repaired.length, 0)
})

// ---------- snbt-repair：多行字符串列表的元素行缺右引号 ----------
// 2026-10-25 实测：etbw 的 chapters/707C89F17A4596E5.snbt L82，报「无法解析的值：\"如\"」。
// 规则⑨只认 `key: "` 键值形态，元素行（行首就是 "）匹配不上。

test('repairUnclosedListElement：元素行行尾补 \'"\'，下一元素不再被吞', () => {
  const bad = [
    '{',
    '\tdescription: [',
    '\t\t"BOSS技能："',
    '\t\t"它会偶尔短暂停止移动，可以破坏任何方块。；',
    '\t\t"如果玩家在很高的地方时，方块；"',
    '\t]',
    '\tid: "X"',
    '}',
  ].join('\n')
  const { text, repaired } = repairUnclosedListElement(bad)
  assert.equal(repaired.length, 1)
  assert.equal(repaired[0].line, 4, '修的是缺右引号的那一行')
  const root = parse(text).value
  const d = root.entries.find((e) => e.key.value === 'description').value
  assert.equal(d.type, 'list')
  assert.deepEqual(d.items.map((it) => it.value.value), [
    'BOSS技能：',
    '它会偶尔短暂停止移动，可以破坏任何方块。；',
    '如果玩家在很高的地方时，方块；',
  ], '三个元素都在，内容一字不丢')
})

test('repairUnclosedListElement：正常跨行字符串（下一行不以 " 开头）不动', () => {
  // 本解析器允许字符串跨行：下一行是纯文本延续时，那是合法文件，不能当坏行补引号。
  const ok = '{\n\tdescription: [\n\t\t"第一行\n第二行还在字符串里"\n\t]\n}'
  const r = repairUnclosedListElement(ok)
  assert.equal(r.repaired.length, 0)
  assert.equal(r.text, ok)
})

// ---------- quest-files：纯 NUL 文件在抽取层跳过 ----------

test('extractPack：纯 NUL 文件跳过，不影响其余文件解析', async () => {
  const { extractPack } = await import('./lib/quest-files.mjs')
  const files = [
    { name: 'chapters/a.snbt', text: '{ title: "Hello" }' },
    { name: 'chapters/b.snbt', text: '\u0000\u0000\u0000'.repeat(10) },
    { name: 'chapters/c.snbt', text: '{ title: "World" }' },
  ]
  const pack = extractPack({ files, layout: LAYOUT.EMBEDDED })
  assert.equal(pack.files.length, 2, 'NUL 文件不进 pack.files')
  assert.ok(pack.units.every((u) => !u.file.includes('b.snbt')))
})
