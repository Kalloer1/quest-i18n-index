import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 站点是自包含 HTML：site/data.json 被 build-site-html.mjs 内联进 dist/index.html。
// 2026-10-21 实测：默认「全部 + 无搜索」曾把 28,816 个 <li> 一把 innerHTML 塞进 DOM，
// 浏览器直接卡死（其中 23,827 条是「没有 FTB 任务」的噪声包）。
// 这里锁住「有双视图 + 分页，且不再一次渲染全部」这条不变量。
const src = readFileSync(new URL('../site/template.html', import.meta.url), 'utf8')

test('站点模板：有画廊/列表双视图与分页', () => {
  assert.match(src, /data-view="gallery"/, '缺少画廊视图开关')
  assert.match(src, /data-view="list"/, '缺少列表视图开关')
  assert.match(src, /data-page=/, '缺少分页控件')
  assert.match(src, /PAGE_SIZE/, '缺少每页条数上限')
  assert.match(src, /function cardHTML/, '缺少画廊卡片渲染')
  assert.match(src, /function renderPager/, '缺少分页渲染')
})

test('站点模板：不含把全部结果一把 innerHTML 的旧写法（回归护栏）', () => {
  // 旧实现 `results.map(rowHTML).join("")` 在「全部」下会塞 2.8 万个 <li> 卡死浏览器。
  // 新实现只对当页切片 map，故这条断言应通过。
  assert.doesNotMatch(src, /results\.map\(rowHTML\)\.join\(""\)/, '又出现了全量渲染，分页被绕过了')
})
