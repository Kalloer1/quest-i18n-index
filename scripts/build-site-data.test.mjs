import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildSiteData } from '../scripts/build-site-data.mjs'

const read = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'))
const inputs = () => ({
  index: read('research/index-dataset.json'),
  vmStatus: read('research/vm-status.json'),
  packMeta: read('research/pack-metadata.json'),
})

test('站点数据只收「有 FTB 任务书」的包（2026-10-22 裁决：其余不上页面）', () => {
  const inp = inputs()
  const out = buildSiteData(inp)
  // 旧契约是「一条不丢」，已被推翻：28816 行一次渲染会把浏览器卡死。
  // 新契约：no-quests 与探测未完成都不进站点数据，但**全量数据集不丢**。
  assert.equal(out.packs.length, new Set(out.packs.map(p => p.slug)).size, '按 slug 合并后不应有重复卡片')
  assert.ok(out.packs.length > 0)
  assert.equal(out.stat.total, out.packs.length)
  assert.equal(out.stat.total + out.stat.hidden, inp.index.dataset.length)
})

test('六态计数与可见卡片对账（no-quests 恒为 0，每张卡片恰好一个状态）', () => {
  const inp = inputs()
  const out = buildSiteData(inp)
  assert.equal(out.stat.stateCounts['no-quests'], 0, 'no-quests 已不上页面')
  // 关键契约：计数是**卡片**维度，总和必须等于可见卡片数。
  const sum = Object.values(out.stat.stateCounts).reduce((a, b) => a + b, 0)
  assert.equal(sum, out.stat.total, '六态计数总和应等于可见卡片数')
  assert.equal(out.stat.total, new Set(out.packs.map(p => p.slug)).size)
})

test('每张卡片的状态必须是该包在某个平台上的真实状态（不凭空造态）', () => {
  const inp = inputs()
  const out = buildSiteData(inp)
  const statesBySlug = new Map()
  for (const r of inp.index.dataset) {
    if (!statesBySlug.has(r.slug)) statesBySlug.set(r.slug, new Set())
    if (r.state) statesBySlug.get(r.slug).add(r.state)
  }
  for (const card of out.packs) {
    const real = statesBySlug.get(card.slug)
    assert.ok(real, `${card.slug} 不在数据集里`)
    assert.ok(real.has(card.state), `${card.slug} 的 state=${card.state} 不是任何平台上的真实状态`)
    // 跨平台同态就不应标冲突
    const visibleStates = [...real].filter(s => s !== 'no-quests')
    assert.equal(card.stateConflict, visibleStates.length > 1,
      `${card.slug} 的 stateConflict 标记不对（真实状态：${visibleStates.join('/')}）`)
  }
})

test('每条已分类的包都有 stateLabel 与 stateWhy', () => {
  const out = buildSiteData(inputs())
  for (const p of out.packs.filter(x => !x.probeIncomplete)) {
    assert.ok(p.stateLabel, `${p.slug} 缺 stateLabel`)
    assert.ok(p.stateWhy, `${p.slug} 缺 stateWhy`)
  }
})

test('探测未完成的包不上页面（未知不冒充有任务书）', () => {
  const inp = inputs()
  const out = buildSiteData(inp)
  assert.equal(out.packs.filter(p => p.probeIncomplete).length, 0,
    'probeIncomplete 的包已被隐藏')
  // 但数据集里确实有这类条目（被隐藏而非消失）
  assert.ok(inp.index.dataset.filter(r => r.probeIncomplete).length > 0,
    '数据集里应有探测未完成的条目')
})

test('VM 覆盖的包都带上了 provider，含 status 与 versions', () => {
  const inp = inputs()
  const out = buildSiteData(inp)
  const covered = inp.index.dataset.filter(r => r.vm && r.state && r.state !== 'no-quests' && !r.probeIncomplete)
  assert.ok(covered.length > 0)
  const bySlug = new Map(out.packs.map(p => [p.slug, p]))
  for (const r of covered) {
    const p = bySlug.get(r.slug)
    assert.equal(p.providers.length, 1, `${r.slug} 应有一个 provider，实际 ${p.providers.length}`)
    const prov = p.providers[0]
    assert.ok(prov.name)
    assert.ok(prov.link.startsWith('https://'))
    assert.ok(prov.versions, `${r.slug} 缺 versions`)
    assert.ok(prov.fetchedAt, `${r.slug} 缺抓取时间`)
  }
})

test('sb4/index 这类带后缀的 vmSlug 也能匹配上（数据链不断裂）', () => {
  const out = buildSiteData(inputs())
  const sb4 = out.packs.find(p => p.slug === 'ftb-stoneblock-4')
  assert.ok(sb4, '应有 ftb-stoneblock-4')
  assert.equal(sb4.providers.length, 1, 'ftb-stoneblock-4 应带 VM 汉化来源')
  assert.equal(sb4.providers[0].status, 'maintaining')
})

test('元数据字段从 pack-metadata 合并进来', () => {
  const out = buildSiteData(inputs())
  const meta = inputs().packMeta
  const metaSlugs = new Set((meta.packs || []).map(p => p.slug))
  // 元数据只覆盖已抓取的那批（2026-10-22 实测：1000 条，而扫描已扩到 28816 行），
  // 所以「缺图标」不代表合并出错。真正要守的是：
  //   ① 有元数据的包，图标/标题必须合进来（合并链路不断）
  //   ② 无元数据的包不得伪造字段（不得凭空造图标）
  const cfPacks = out.packs.filter((p) => p.platform === 'cf')
  const shouldHave = cfPacks.filter(p => metaSlugs.has(p.slug))
  assert.ok(shouldHave.length > 0, '应至少有一个包能合上元数据')
  for (const p of shouldHave) {
    assert.ok(p.iconUrl, `${p.slug} 在 pack-metadata 里却有没图标`)
    assert.ok(p.title, `${p.slug} 在 pack-metadata 里却有没标题`)
  }
  // 未抓元数据的包不得造出图标
  const noMeta = cfPacks.filter(p => !metaSlugs.has(p.slug))
  assert.equal(noMeta.filter(p => p.iconUrl).length, 0, '无元数据的包不得凭空有图标')
  const sb4 = out.packs.find(p => p.slug === 'ftb-stoneblock-4')
  assert.ok(sb4.downloads > 0)
  assert.ok(sb4.gameVersions.length > 0)
  assert.ok(sb4.loaders.length > 0)
})

test('不能混装警告存在（ADR-0006 / 社区约定 #46）', () => {
  const out = buildSiteData(inputs())
  assert.match(out.meta.noMixWarning, /不能同时安装/)
})

test('许可与非商业声明存在（ADR-0004）', () => {
  const out = buildSiteData(inputs())
  assert.match(out.meta.license.name, /CC BY-NC-SA 4\.0/)
  assert.equal(out.meta.nonCommercial, true)
})

test('skyfactory-5：no-quests 不再上页面（六态词表保留，但该包被隐藏）', () => {
  const out = buildSiteData(inputs())
  const sf5 = out.packs.find(p => p.slug === 'skyfactory-5')
  // 2026-10-22 裁决后：no-quests 的包不上页面，skyfactory-5 不再出现在 packs 里。
  assert.equal(sf5, undefined, 'no-quests 的包不应出现在站点数据')
  // 六态词表本身仍在 meta 里（将来补探测或扩范围还能用）
  assert.ok(out.meta.stateLabel['no-quests'])
})

test('幂等：同一输入连跑两次结果相同', () => {
  const a = buildSiteData(inputs(), { now: 'T' })
  const b = buildSiteData(inputs(), { now: 'T' })
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

// ---------- 工单 04：详情页下载字段 ----------
// 真实数据集目前 downloadable 计数为 0（尚无产出），下载字段用合成输入单测。

const GITHUB = 'acme/quest-i18n-index'

const SYNTH = () => ({
  index: {
    generatedAt: 'T',
    stat: { stateCounts: { downloadable: 1 } },
    dataset: [{
      slug: 'demo-pack', cfId: 1, state: 'downloadable', probeIncomplete: false,
      stateWhy: '', vm: null, vmSuspect: null, layout: null, enFiles: 1, zhFiles: 0,
    }],
  },
  vmStatus: { source: '', entries: [] },
  packMeta: { generatedAt: 'T', incomplete: false, packs: [] },
})

const synthetic = (opts) => buildSiteData(SYNTH(), { now: 'T', ...opts })

test('downloadable 包带 download 字段：zip 走 GitHub raw，github 仓库链接，quark 默认留空', () => {
  const out = synthetic({ githubRepo: GITHUB })
  const p = out.packs[0]
  assert.equal(p.download.zip, `https://github.com/${GITHUB}/raw/main/downloads/demo-pack.zip`)
  assert.equal(p.download.github, `https://github.com/${GITHUB}`)
  assert.equal(p.download.quark, '')
})

test('非 downloadable 包没有 download 字段', () => {
  const out = buildSiteData(inputs(), { githubRepo: GITHUB })
  for (const p of out.packs.filter(x => x.state !== 'downloadable')) {
    assert.equal(p.download, null, `${p.slug} 不应有 download 字段`)
  }
})

test('quark 镜像链接从 quarkMirrors 合并进来；缺失条目留空（绝不伪造）', () => {
  const withQuark = synthetic({
    githubRepo: GITHUB,
    quarkMirrors: { mirrors: { 'demo-pack': { shareUrl: 'https://pan.quark.cn/s/real-link' } } },
  }).packs[0]
  assert.equal(withQuark.download.quark, 'https://pan.quark.cn/s/real-link')
  // 缺失条目：空字符串，不渲染按钮
  assert.equal(synthetic({ githubRepo: GITHUB }).packs[0].download.quark, '')
})

test('githubRepo 缺失时 zip 与 github 链接为 null（不伪造链接），quark 仍可渲染', () => {
  const p = synthetic({ githubRepo: '' }).packs[0]
  assert.equal(p.download.zip, null)
  assert.equal(p.download.github, null)
})

// ---------- 详情页下载区块的渲染契约（site/template.html） ----------
// 渲染逻辑在模板内联 JS 里，无法直接单测；这里对模板做静态契约断言，
// 防止有人删掉 quark 空值守卫或把警告塞进可折叠容器。
const template = readFileSync(new URL('../site/template.html', import.meta.url), 'utf8')

test('模板：夸克按钮必须在 quark 非空守卫内（空字符串绝不渲染假链接）', () => {
  // 守卫：`if (p.download.quark)` 包住 dl-quark 按钮的拼接
  assert.match(template, /if \(p\.download\.quark\) \{[\s\S]*?dl-quark/)
})

test('模板：下载区只有两个按钮——国内镜像 + GitHub 下载', () => {
  assert.match(template, /国内镜像/, '镜像按钮文案应为「国内镜像」')
  assert.match(template, /GitHub 下载/, 'zip 直链按钮文案应为「GitHub 下载」')
  // 旧文案必须彻底消失，防止改一半留下僵尸按钮
  assert.doesNotMatch(template, /夸克网盘镜像/, '旧文案「夸克网盘镜像」应已删除')
  assert.doesNotMatch(template, /GitHub 仓库/, '第三个按钮（仓库链接）应已删除')
})

test('模板：quark 为空时按钮置灰（else 分支 is-disabled），不是隐藏', () => {
  // 置灰态必须落在 `if (p.download.quark) { ... } else { ... }` 的 else 里：
  // 隐藏会让还没镜像的包看起来「没有下载入口」
  assert.match(template, /if \(p\.download\.quark\) \{[\s\S]*?\} else \{[\s\S]*?is-disabled/)
  // 置灰用 span + aria-disabled，绝不能用 <a disabled> 或留下 href
  assert.match(template, /<span class="cta dl-quark is-disabled" aria-disabled="true"/)
})

test('模板：zip 直链按钮仍是 id="dl-zip" 且指向 p.download.zip', () => {
  assert.match(template, /id="dl-zip" href="' \+ esc\(p\.download\.zip\) \+ '" download>/)
})

test('模板：不能混装警告是普通可见块，不在 <details> 等可折叠容器里', () => {
  // 去掉 CSS/HTML 注释后再检查，避免注释里的举例文字（「不得放进 <details>」）误报
  const code = template.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
  assert.doesNotMatch(code, /<details/i)
  assert.match(template, /不同来源的汉化不能同时安装/)
  assert.match(template, /class="warn" role="note"/)
})

// ---- 站点只显示「有 FTB 任务书」的包（2026-10-22 用户裁决） ----
//
// 背景：28816 行一次性渲染到一页会让浏览器卡死。用户裁决：
// 「只显示有 FTB 任务的整合包，其他的不放在网页上」。
// 收窄发生在**站点数据层**（site/data.json 的 packs），
// `research/index-dataset.json` 仍是全量、一条不丢 —— 将来补探测还能捞回来。

test('站点数据剔除 no-quests：页面只显示有 FTB 任务书的包', () => {
  const inp = inputs()
  const out = buildSiteData(inp)
  assert.equal(out.packs.filter(p => p.state === 'no-quests').length, 0,
    'no-quests 的包不得进入站点数据')
  // 除 no-quests 外，其余五态的包一个不少（按 slug 去重后比对）
  const expected = new Set(inp.index.dataset
    .filter(r => r.state && r.state !== 'no-quests' && !r.probeIncomplete)
    .map(r => r.slug))
  assert.equal(out.packs.length, expected.size, '可见卡片数应与「有任务书的包数」一致')
  for (const slug of expected) {
    assert.ok(out.packs.some(p => p.slug === slug), `${slug} 丢了`)
  }
})

test('站点数据剔除探测未完成的包：未知不冒充「有任务书」', () => {
  const inp = inputs()
  const out = buildSiteData(inp)
  assert.equal(out.packs.filter(p => p.probeIncomplete).length, 0,
    'probeIncomplete 的包不得进入站点数据')
})

test('剔除后 stat.total 等于可见包数，且给出被剔除的计数（口径可追溯）', () => {
  const inp = inputs()
  const out = buildSiteData(inp)
  const hidden = inp.index.dataset.length - out.packs.length
  assert.equal(out.stat.total, out.packs.length)
  assert.equal(out.stat.hidden, hidden)
  assert.ok(out.stat.hidden > 0, '本数据集应有被剔除的包')
  // 隐藏原因可追溯：两个数字相加必须等于原始行数
  assert.equal(out.stat.total + out.stat.hidden, inp.index.dataset.length)
})

test('同一 slug 在多平台各有记录时不丢平台：合并成一条卡片，platforms 保留全部', () => {
  const inp = inputs()
  const out = buildSiteData(inp)
  const slugs = out.packs.map(p => p.slug)
  assert.equal(new Set(slugs).size, slugs.length, '站点数据里一个 slug 只能出现一次')

  // 找一个原始数据里跨平台重复的 slug 来验证 platforms 字段
  const counts = new Map()
  for (const r of inp.index.dataset) counts.set(r.slug, (counts.get(r.slug) || 0) + 1)
  const dupSlug = [...counts].find(([slug, n]) => n > 1 && out.packs.some(p => p.slug === slug))?.[0]
  if (dupSlug) {
    const card = out.packs.find(p => p.slug === dupSlug)
    const raw = inp.index.dataset.filter(r => r.slug === dupSlug)
    assert.ok(Array.isArray(card.platforms), `${dupSlug} 应带 platforms 数组`)
    assert.deepEqual(
      [...card.platforms].sort(),
      [...new Set(raw.map(r => r.platform).filter(Boolean))].sort(),
      `${dupSlug} 的 platforms 应保留全部来源平台`,
    )
  }
})

test('幂等：剔除与合并后连跑两次结果相同', () => {
  const a = buildSiteData(inputs(), { now: 'X' })
  const b = buildSiteData(inputs(), { now: 'X' })
  assert.deepEqual(a, b)
})
