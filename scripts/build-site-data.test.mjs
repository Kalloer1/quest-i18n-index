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

test('500 条全部进入站点数据', () => {
  const out = buildSiteData(inputs())
  assert.equal(out.stat.total, 500)
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
  const out = buildSiteData(inputs())
  const inc = out.packs.filter(p => p.probeIncomplete)
  assert.equal(inc.length, 105)
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
  const withIcon = out.packs.filter(p => p.iconUrl)
  assert.equal(withIcon.length, 57, '57 个可产出包应有图标')
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

test('幂等：同一输入连跑两次结果相同', () => {
  const a = buildSiteData(inputs(), { now: 'T' })
  const b = buildSiteData(inputs(), { now: 'T' })
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})
