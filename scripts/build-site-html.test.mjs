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

// 2026-10-26：详情页曾经没有地址、没有历史记录，退出时 window.scrollTo(0,0) 把人扔回页首，
// 浏览器后退键更是直接离开站点。这里锁住「详情可分享 / 后退回原位置」这条行为契约。
test('站点模板：详情页有地址、能后退、后退回到原位置', () => {
  assert.match(src, /history\.pushState/, '缺少 pushState：详情页不会有 URL，后退会离开站点')
  assert.match(src, /addEventListener\("popstate"/, '缺少 popstate：浏览器后退不会回到列表')
  assert.match(src, /#\/p\//, '缺少详情页路由格式 #/p/<slug>')
  assert.match(src, /scrollY: listScroll/, '后退时没有恢复列表滚动位置')
  // 列表分支必须走「恢复原位置 / 保持不动」两条路，而不是重新滚到顶
  assert.match(
    src,
    /showIndex\(isBack \? \{ scroll: true, scrollY: listScroll \} : \{ scroll: false \}\)/,
    '列表分支不再是「返回原位 / 新开链接留在顶部」，可能又统一滚到页首了'
  )
})

test('站点模板：封面直接引用 CurseForge / Modrinth 的 CDN，不落地到本地', () => {
  // 图标一律走 p.iconUrl（media.forgecdn.net / cdn.modrinth.com），
  // 站点是自包含单文件，不打包也不代理图片。
  assert.match(src, /class="cover" src="' \+ esc\(p\.iconUrl\)/, '封面没有直接用 iconUrl')
  assert.doesNotMatch(src, /iconUrl[^\n]*downloads\//, '不要把封面下载到 downloads/ 再本地引用')
})

