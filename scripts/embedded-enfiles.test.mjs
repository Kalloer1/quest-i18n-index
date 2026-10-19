import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyLayout, skipReason, LAYOUT, SKIP } from './lib/candidates.mjs'

// 回归：内嵌格式的 enFiles 必须等于章节数，不能是 0。
//
// 事故经过（2026-10-19 实测）：scan-packs.mjs 的 classify() 只把
// `lang/en_us/*` 算进 enFiles，内嵌格式于是恒为 0；而 candidates.mjs 的约定是
// `enFiles: sepEn > 0 ? sepEn : embedded`。两处口径不一致，导致
// **全部 213 个内嵌包被 skipReason 判成「找不到英文源」而跳过**——
// 2000 条扫描里 66% 的可做工作被静默丢弃，表面上还显示「ok 2 / failed 0」。

test('classifyLayout：内嵌格式的 enFiles 等于章节数（不是 0）', () => {
  const names = [
    'config/ftbquests/quests/chapters/chapter_1.snbt',
    'config/ftbquests/quests/chapters/chapter_2.snbt',
    'config/ftbquests/quests/chapters/chapter_3.snbt',
  ]
  const r = classifyLayout(names)
  assert.equal(r.layout, LAYOUT.EMBEDDED)
  assert.equal(r.enFiles, 3, '内嵌布局的英文源就是 chapters/*.snbt 本身')
  assert.equal(r.embeddedFiles, 3)
})

test('skipReason：内嵌格式不得因 enFiles=0 被判「找不到英文源」', () => {
  const names = ['config/ftbquests/quests/chapters/chapter_1.snbt']
  const r = classifyLayout(names)
  // 这是本测试的核心断言：内嵌包必须可翻译。
  assert.notEqual(skipReason(r), SKIP.NO_EN_SOURCE)
  assert.equal(skipReason(r), null, '内嵌且有章节 = 可翻译')
})

test('classifyLayout：分离布局仍以 lang 文件数计 enFiles', () => {
  const names = [
    'config/ftbquests/quests/lang/en_us/chapter_a.snbt',
    'config/ftbquests/quests/lang/en_us/chapter_b.snbt',
    'config/ftbquests/quests/chapters/ignored.snbt',
  ]
  const r = classifyLayout(names)
  assert.equal(r.layout, LAYOUT.SEPARATE_DIR)
  assert.equal(r.enFiles, 2, '有 lang/en_us 时只数 lang 文件，不把 chapters 混进来')
})

test('skipReason：真·无英文源（none 布局）仍然跳过', () => {
  const r = classifyLayout(['mods/foo.jar'])
  assert.equal(r.layout, LAYOUT.NONE)
  assert.equal(skipReason(r), SKIP.NO_QUESTS)
})
