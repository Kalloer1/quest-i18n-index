/**
 * 工单 03：内嵌布局产出端到端测试。
 *
 * 覆盖：
 *   - SNBT 无损往返成立（依据 snbt.test.mjs）→ 合并模式可用：按 quest ID 合并，上游新增任务不丢
 *   - 内嵌夹具整合包跑通「识别 → 翻译（桩）→ 校验 → 打包」，断言产出 zip 内容
 *   - 内嵌包 README 比分离布局更强的备份警告
 *   - 合并产出同样过 validate-quests.mjs 闸门
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mergeByQuestId, serialize, parse, collectStrings, setString } from './snbt.mjs'
import { buildPatch, readZip, README_TEXT, EMBEDDED_README_TEXT } from './pack-patch.mjs'
import { validatePair } from './validate-quests.mjs'
import { runPipeline, processPack } from './pipeline.mjs'
import { LAYOUT } from './lib/candidates.mjs'

const fixture = (p) => readFileSync(new URL(`./fixtures/${p}`, import.meta.url), 'utf8')
const CHAPTER = 'config/ftbquests/quests/chapters/chapter.snbt'
const enText = fixture('packs/embedded-demo/config/ftbquests/quests/chapters/chapter.snbt')
const upstreamText = fixture('merge/upstream/config/ftbquests/quests/chapters/chapter.snbt')
const record = { slug: 'embedded-demo', layout: LAYOUT.EMBEDDED, enFiles: 1, zhFiles: 0 }
const zh = (t) => `中:${t}`

// ---------- 合并模式依据：无损往返 ----------

test('无损往返成立：夹具章节 serialize(parse(t)) === t（合并模式的前提）', () => {
  assert.equal(serialize(parse(enText)), enText)
})

// ---------- mergeByQuestId ----------

test('mergeByQuestId：上游新增 quest 保留，已有 quest 换成译文', () => {
  const translatedText = translateFixture(enText)
  const merged = mergeByQuestId(upstreamText, translatedText)

  // 上游新增任务不丢
  assert.ok(merged.includes('Brand new upstream quest'))
  assert.ok(merged.includes('minecraft:diamond'))
  // 已有任务被换成译文
  assert.ok(merged.includes(zh('Punch a &2Tree')))
  assert.ok(merged.includes(zh('The classic first step')))
  // 上游结构字段不动
  assert.ok(merged.includes('item: "minecraft:oak_log"'))
  assert.ok(merged.includes('count: 3L'))
  // 合并结果可解析（隐含在上面的字符串断言之外再显式验证）
  assert.doesNotThrow(() => parse(merged))
})

test('mergeByQuestId：译文里被删的 quest 不影响上游（上游为准）', () => {
  // 译文快照只有 AAAA 一个任务（模拟旧版快照未覆盖 CCCC）
  const root = parse(translateFixture(enText))
  const list = root.value.entries.find((e) => e.key.value === 'quests').value
  list.items = list.items.filter((it) => !serialize(it.value).includes('CCCC3333DDDD4444'))
  const merged = mergeByQuestId(upstreamText, serialize(root))
  // 上游的 CCCC 任务仍在（合并只改写同 id 条目，不删上游条目）
  assert.ok(merged.includes('CCCC3333DDDD4444'))
  assert.ok(merged.includes('Brand new upstream quest'))
})

test('mergeByQuestId：上游没有 quests 列表时原样返回上游', () => {
  const merged = mergeByQuestId('{ title: "no quests here" }', translateFixture(enText))
  assert.equal(merged, '{ title: "no quests here" }')
})

/** 把夹具章节的所有可翻译文本字段加 `中:` 前缀，模拟流水线译文产出。 */
function translateFixture(text) {
  const root = parse(text)
  for (const { path, node } of collectStrings(root)) {
    const field = path.replace(/\[\d+\]$/, '').split('.').pop()
    if (['title', 'subtitle', 'description', 'text'].includes(field)) setString(node, zh(node.value))
  }
  return `# AI 初翻，未人工校对\n${serialize(root)}`
}

// ---------- 端到端：识别 → 翻译（桩）→ 校验 → 打包 ----------

test('端到端：内嵌夹具整合包全流程，zip 内容与强备份警告正确', async () => {
  // 1) 识别：夹具文件路径能被内嵌布局判据命中
  const { sourceFileNames } = await import('./lib/quest-files.mjs')
  assert.deepEqual(
    sourceFileNames([CHAPTER, 'config/ftbquests/quests/data.snbt'], LAYOUT.EMBEDDED),
    [CHAPTER],
  )

  // 2) 翻译（桩）+ 3) 校验闸门 + 4) 打包
  let outputs = []
  await runPipeline({
    records: [record],
    loadPack: () => ({ files: [{ name: CHAPTER, text: enText }] }),
    translate: async (texts) => texts.map(zh),
    writeOutput: (_slug, name, text) => outputs.push({ name, text }),
    reportStatus: async () => {},
  })
  assert.equal(outputs.length, 1)
  assert.equal(outputs[0].name, CHAPTER) // 内嵌：路径不变（覆盖式）
  assert.ok(outputs[0].text.startsWith('# AI 初翻，未人工校对\n'))

  // 校验：产出与英文源键集合一致、可解析可序列化、无 BOM
  const verdict = validatePair([{ name: CHAPTER, text: enText }], outputs, { layout: LAYOUT.EMBEDDED })
  assert.deepEqual(verdict.problems, [])

  // 打包：内嵌包用内嵌专用 README
  const zip = buildPatch(outputs, { layout: 'embedded' })
  const r = readZip(zip)
  assert.deepEqual(r.names.sort(), [CHAPTER, 'LICENSE.txt', 'README.txt'].sort())
  const readme = r.read('README.txt').toString('utf8')
  assert.equal(readme, EMBEDDED_README_TEXT)
  assert.notEqual(readme, README_TEXT)
  // 更强的备份警告：改写玩家已有文件、无法用删除恢复、本地修改会丢失
  assert.match(readme, /直接改写/)
  assert.match(readme, /无法通过删除补丁文件来恢复/)
  assert.match(readme, /覆盖丢失/)
  assert.match(readme, /备份 config\/ftbquests\//)
  // zip 内章节内容是译文，且再过一次闸门仍通过
  const zhText = r.read(CHAPTER).toString('utf8')
  assert.ok(zhText.includes(zh('Punch a &2Tree')))
  assert.deepEqual(
    validatePair([{ name: CHAPTER, text: enText }], [{ name: CHAPTER, text: zhText }], { layout: LAYOUT.EMBEDDED }).problems,
    [],
  )
})

test('端到端：合并模式（loadMergePack）产出过闸门且保留上游新增任务', async () => {
  let outputs = []
  let notes = []
  await runPipeline({
    records: [record],
    loadPack: () => ({ files: [{ name: CHAPTER, text: enText }] }),
    loadMergePack: () => [{ name: CHAPTER, text: upstreamText }],
    translate: async (texts) => texts.map(zh),
    writeOutput: (_slug, name, text) => outputs.push({ name, text }),
    reportStatus: async (id, payload) => { if (payload.note) notes.push(payload.note) },
  })
  assert.equal(outputs.length, 1)
  const merged = outputs[0].text
  // 上游新增任务不丢
  assert.ok(merged.includes('Brand new upstream quest'))
  // 译文已写入
  assert.ok(merged.includes(zh('Punch a &2Tree')))
  // 合并产出与上游最新文件键集合一致 → 过闸门
  const verdict = validatePair([{ name: CHAPTER, text: upstreamText }], outputs, { layout: LAYOUT.EMBEDDED })
  assert.deepEqual(verdict.problems, [])
  assert.deepEqual(notes, [])
})

test('processPack：合并模式下上游已删除的章节不再产出', async () => {
  const r = await processPack(
    record,
    { files: [{ name: CHAPTER, text: enText }, { name: 'config/ftbquests/quests/chapters/gone.snbt', text: '{ title: "Deleted upstream" quests: [] }' }] },
    {
      translate: async (texts) => texts.map(zh),
      mergeFiles: [{ name: CHAPTER, text: upstreamText }], // gone.snbt 上游已不存在
    },
  )
  assert.equal(r.status, 'done')
  assert.deepEqual(r.outputs.map((o) => o.name), [CHAPTER])
  assert.match(r.note, /上游已删除/)
})

test('processPack：分离布局不受 mergeFiles 影响（合并只针对内嵌）', async () => {
  const sepRecord = { slug: 's', layout: LAYOUT.SEPARATE_SINGLE, enFiles: 1, zhFiles: 0 }
  const r = await processPack(
    sepRecord,
    { files: [{ name: 'lang/en_us.snbt', text: '{ "quest.a.title": "Hello" }' }] },
    {
      translate: async (texts) => texts.map(zh),
      mergeFiles: [{ name: 'lang/en_us.snbt', text: '{ "quest.a.title": "Hello" }' }],
    },
  )
  assert.equal(r.status, 'done')
  assert.equal(r.outputs[0].name, 'lang/zh_cn.snbt')
  assert.ok(!('note' in r))
})
