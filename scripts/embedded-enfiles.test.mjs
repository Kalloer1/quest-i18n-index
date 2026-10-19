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

// ---- 单包超时必须随包大小伸缩 ----

import { packTimeoutMs, DEFAULT_TIMEOUT_MS } from './pipeline.mjs'

test('packTimeoutMs：内嵌大包不再被 5 分钟一刀切', () => {
  // 实测：prominence-2-hasturian-era 31 章节，5 分钟预算在第 9 块就被 abort，
  // 整包判 failed —— 已翻好的块全部白丢。
  const t = packTimeoutMs({ enFiles: 31 })
  assert.ok(t > DEFAULT_TIMEOUT_MS, `应大于默认 5 分钟，实际 ${t}`)
  assert.ok(t >= 20 * 60 * 1000, `31 章节至少给 20 分钟，实际 ${t / 60000} 分钟`)
})

test('packTimeoutMs：小包仍保底 5 分钟', () => {
  assert.equal(packTimeoutMs({ enFiles: 1 }), DEFAULT_TIMEOUT_MS)
  assert.equal(packTimeoutMs({}), DEFAULT_TIMEOUT_MS)
})

test('packTimeoutMs：上限 60 分钟，不会无限放大', () => {
  assert.equal(packTimeoutMs({ enFiles: 100000 }), 60 * 60 * 1000)
})

test('packTimeoutMs：显式传入的 timeoutMs 原样尊重，不被下限抬高', () => {
  // 回归：曾把 5 分钟下限无条件套用，导致 runPipeline 测试传 timeoutMs:50
  // 被抬到 300s，测试永远等不到超时（整条挂 5 秒后断言失败）。
  // 用户想用 --timeout-ms 缩短预算也必须能生效。
  assert.equal(packTimeoutMs({ enFiles: 100 }, { base: 50 }), 50)
  assert.equal(packTimeoutMs({ enFiles: 100 }, { base: 1000 }), 1000)
})
