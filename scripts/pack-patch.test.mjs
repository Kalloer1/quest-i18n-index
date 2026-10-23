#!/usr/bin/env node
/**
 * pack-patch 单测：幂等 + 端到端（夹具跑通筛候选 → 翻译桩 → 校验 → 打包，断言 zip 内容）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPatch, readZip, README_TEXT, LICENSE_TEXT } from './pack-patch.mjs'
import { validatePair } from './validate-quests.mjs'
import { runPipeline } from './pipeline.mjs'
import { screenCandidates, LAYOUT } from './lib/candidates.mjs'

const EMBED = 'config/ftbquests/quests/chapters/chapter.snbt'
const EN_TEXT = '{ title: "Hello &aWorld" desc: "Get %s apples" }'
const ZH_TEXT = '# AI 初翻，未人工校对\n{ title: "你好 &a世界" desc: "获得 %s 个苹果" }'

test('buildPatch：含 README 与 LICENSE，路径原样保留', () => {
  const zip = buildPatch([{ name: EMBED, text: ZH_TEXT }])
  const r = readZip(zip)
  assert.ok(r.names.includes(EMBED))
  assert.ok(r.names.includes('README.txt'))
  assert.ok(r.names.includes('LICENSE.txt'))
  assert.match(r.read('README.txt').toString('utf8'), /备份游戏/)
  assert.match(r.read('README.txt').toString('utf8'), /上游整合包更新后本补丁可能失效/)
  assert.match(r.read('LICENSE.txt').toString('utf8'), /CC BY-NC-SA 4\.0/)
  assert.match(r.read('LICENSE.txt').toString('utf8'), /CFPA/)
  assert.equal(r.read(EMBED).toString('utf8'), ZH_TEXT)
})

test('buildPatch：幂等 —— 同一输入两次产出逐字节相同', () => {
  const files = [
    { name: 'b/chapters/x.snbt', text: ZH_TEXT },
    { name: 'a/lang/zh_cn/y.snbt', text: '{ t: "嗨" }' },
  ]
  const z1 = buildPatch(files)
  const z2 = buildPatch(files)
  assert.deepEqual([...z1], [...z2])
})

test('buildPatch：重复条目拒绝', () => {
  assert.throws(() => buildPatch([
    { name: 'a.snbt', text: 'x' },
    { name: 'a.snbt', text: 'y' },
  ]), /重复/)
})

test('buildPatch：点文件不进 zip（.source.json / .DS_Store）', () => {
  const zip = buildPatch([
    { name: EMBED, text: ZH_TEXT },
    { name: '.source.json', text: '{"slug":"demo"}' },
    { name: 'chapters/.DS_Store', text: 'junk' },
  ])
  const r = readZip(zip)
  assert.ok(r.names.includes(EMBED))
  assert.ok(!r.names.includes('.source.json'), '.source.json 不应进 zip')
  assert.ok(!r.names.includes('chapters/.DS_Store'), '嵌套点文件不应进 zip')
  assert.deepEqual(r.names.sort(), [EMBED, 'LICENSE.txt', 'README.txt'].sort())
})

// ---------- 端到端：筛候选 → 翻译桩 → 校验 → 打包 ----------

test('端到端：夹具整合包跑通全流程，产出 zip 内容正确', async () => {
  const pack = { files: [{ name: EMBED, text: EN_TEXT }] }

  // 1) 筛候选
  const { candidates, skipped } = screenCandidates([
    { slug: 'demo', layout: LAYOUT.EMBEDDED, enFiles: 1, zhFiles: 0 },
    { slug: 'native', layout: LAYOUT.EMBEDDED, enFiles: 1, zhFiles: 2 },
  ])
  assert.equal(candidates.length, 1)
  assert.deepEqual(skipped, [{ slug: 'native', reason: 'native-zh' }])

  // 2) 翻译（桩）
  let outputs = []
  await runPipeline({
    records: candidates,
    loadPack: () => pack,
    translate: async (texts) => texts.map((t) => `中:${t}`),
    writeOutput: (_slug, name, text) => outputs.push({ name, text }),
    reportStatus: async () => {},
  })
  assert.equal(outputs.length, 1)
  assert.ok(outputs[0].text.startsWith('# AI 初翻，未人工校对\n'))

  // 3) 校验（质量闸门）
  const verdict = validatePair(pack.files, outputs, { layout: LAYOUT.EMBEDDED, label: 'demo' })
  assert.deepEqual(verdict.problems, [])

  // 4) 打包并断言 zip 内容
  const zipBuf = buildPatch(outputs)
  const r = readZip(zipBuf)
  assert.deepEqual(r.names.sort(), [EMBED, 'LICENSE.txt', 'README.txt'].sort())
  const zhText = r.read(EMBED).toString('utf8')
  assert.ok(zhText.includes('中:Hello &aWorld'))
  // 解压内容再过一次闸门仍通过（zip 内文本与产出一致）
  assert.deepEqual(
    validatePair(pack.files, [{ name: EMBED, text: zhText }], { layout: LAYOUT.EMBEDDED }).problems,
    [],
  )
})

test('端到端：闸门拦下的产出不会被打包（先校验后打包）', async () => {
  const badOutputs = [{ name: EMBED, text: '{ title: "缺键" }' }]
  const verdict = validatePair([{ name: EMBED, text: EN_TEXT }], badOutputs, { layout: LAYOUT.EMBEDDED })
  assert.ok(verdict.problems.length > 0)
  // 调用方约定：problems 非空时不调用 buildPatch
})
