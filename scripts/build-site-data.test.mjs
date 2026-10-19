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

test('全部记录进入站点数据（条数随数据集，不写死）', () => {
  const inp = inputs()
  const out = buildSiteData(inp)
  // 不写死 500/2000：数据集会随扫描范围变化（500 → 2000 → …）。
  // 真正要守的是「一条都不丢」。
  assert.equal(out.stat.total, inp.index.dataset.length)
  assert.equal(out.packs.length, inp.index.dataset.length)
})

test('六态计数与 index-dataset 对账', () => {
  const inp = inputs()
  const out = buildSiteData(inp)
  assert.deepEqual(out.stat.stateCounts, inp.index.stat.stateCounts)
})

test('每条已分类的包都有 stateLabel 与 stateWhy', () => {
  const out = buildSiteData(inputs())
  for (const p of out.packs.filter(x => !x.probeIncomplete)) {
    assert.ok(p.stateLabel, `${p.slug} 缺 stateLabel`)
    assert.ok(p.stateWhy, `${p.slug} 缺 stateWhy`)
  }
})

test('探测未完成的包 state 为 null，不冒充六态', () => {
  const inp = inputs()
  const out = buildSiteData(inp)
  const inc = out.packs.filter(p => p.probeIncomplete)
  // 条数随扫描范围变化（500 条时 105，2000 条时 226）：
  // 守的是「probeIncomplete 与 dataset 一致」和「state 必须为 null」。
  assert.equal(inc.length, inp.index.dataset.filter(r => r.probeIncomplete).length)
  assert.ok(inc.length > 0, '数据集里应有探测未完成的条目')
  for (const p of inc) assert.equal(p.state, null, `${p.slug} 探测未完成却有 state`)
})

test('VM 覆盖的包都带上了 provider，含 status 与 versions', () => {
  const inp = inputs()
  const out = buildSiteData(inp)
  const covered = inp.index.dataset.filter(r => r.vm)
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
  // 元数据覆盖全部条目（不是只覆盖「可产出」的那批）：
  // 图标与标题是列表页的全部可见内容，缺一条就是一个占位块。
  // 注意：元数据只覆盖 CurseForge（fetch-pack-metadata 只拉 cf），
  // 故 Modrinth 条目没有图标是预期的，不应当成缺陷。
  const cfPacks = out.packs.filter((p) => p.platform === 'cf')
  const withIcon = cfPacks.filter((p) => p.iconUrl)
  assert.equal(withIcon.length, cfPacks.length, `CF 条目都应有图标（缺 ${cfPacks.length - withIcon.length}）`)
  const withoutTitle = cfPacks.filter((p) => !p.title)
  assert.equal(withoutTitle.length, 0, `缺标题：${withoutTitle.map((p) => p.slug).join(', ')}`)
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

test('skyfactory-5：state 仍是 no-quests（六态不变），文案区分非 FTB', () => {
  const out = buildSiteData(inputs())
  const sf5 = out.packs.find(p => p.slug === 'skyfactory-5')
  assert.ok(sf5, '应有 skyfactory-5')
  assert.equal(sf5.state, 'no-quests')
  assert.equal(sf5.stateLabel, '无任务书（非 FTB Quests）')
  // 六态计数不变：skyfactory-5 仍计入 no-quests
  assert.deepEqual(out.stat.stateCounts, inputs().index.stat.stateCounts)
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

test('模板：不能混装警告是普通可见块，不在 <details> 等可折叠容器里', () => {
  // 去掉 CSS/HTML 注释后再检查，避免注释里的举例文字（「不得放进 <details>」）误报
  const code = template.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
  assert.doesNotMatch(code, /<details/i)
  assert.match(template, /不同来源的汉化不能同时安装/)
  assert.match(template, /class="warn" role="note"/)
})
