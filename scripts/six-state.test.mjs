import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PACK_STATES, buildDataset, classifyPack, composeScanInput, matchPack, parseScanTsv } from '../scripts/build-index.mjs'

/** 与 build-index.mjs 的 norm() 同形，仅用于测试里造入参。 */
const normLike = s => String(s || '')
  .toLowerCase()
  .replace(/[™®©]/g, '')
  .replace(/[‘’`´']/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')

const scanText = readFileSync(new URL('../research/scan-cf500.tsv', import.meta.url), 'utf8')
const baseInput = JSON.parse(readFileSync(new URL('../research/build-input.json', import.meta.url), 'utf8'))
const packMeta = JSON.parse(readFileSync(new URL('../research/pack-metadata.json', import.meta.url), 'utf8'))
// 标题来自 pack-metadata.json（覆盖全部 500 条），vmEntries 来自 build-input.json。
const titles = Object.fromEntries((packMeta.packs || []).map(p => [p.slug, p.title ?? null]))
const input = composeScanInput(scanText, { titles, vmEntries: baseInput.vmEntries })
const dataset = buildDataset(input, { now: 'T' })
const bySlug = new Map(dataset.dataset.map(d => [d.slug, d]))

/** 扫描 TSV 里每种 format 的条数，作为对账基准。 */
const scanFormatCounts = parseScanTsv(scanText).reduce((acc, row) => {
  acc[row.layout] = (acc[row.layout] || 0) + 1
  return acc
}, {})

/** 用最小 pack 形状直接测判定函数，不经 TSV。normSlug/normTitle 与 matchPack 的入参形状保持一致。 */
const pack = (layout, extra = {}) => {
  const slug = extra.slug ?? `synthetic-${layout}`
  return {
    slug, layout, enFiles: 1, zhFiles: 0, title: null,
    normSlug: slug, normTitle: null, ...extra,
  }
}

test('词表是六个，且顺序稳定', () => {
  assert.deepEqual([...PACK_STATES], [
    'downloadable', 'native-zh', 'gap-uncovered', 'gap-covered', 'embedded', 'no-quests',
  ])
})

test('500 条扫描记录全部进产出', () => {
  assert.equal(dataset.dataset.length, 500)
  assert.equal(dataset.stat.total, 500)
})

test('500 条 = 六态计数之和 + 探测未完成计数', () => {
  const sixSum = PACK_STATES.reduce((n, s) => n + dataset.stat.stateCounts[s], 0)
  assert.equal(sixSum + dataset.stat.probeIncomplete, 500)
  assert.equal(dataset.stat.classified, sixSum)
})

test('每条记录要么有六态之一，要么标探测未完成，二者互斥', () => {
  for (const d of dataset.dataset) {
    if (d.state === null) {
      assert.equal(d.probeIncomplete, true, `${d.slug} 无状态却不是探测未完成`)
    } else {
      assert.ok(PACK_STATES.includes(d.state), `${d.slug} 状态 ${d.state} 不在词表里`)
      assert.equal(d.probeIncomplete, false, `${d.slug} 有状态却标了探测未完成`)
    }
  }
})

test('探测未完成的布局标记不会出现在状态值里', () => {
  const probeLayouts = ['nodl', 'toobig', 'other', 'error:fetch failed']
  for (const d of dataset.dataset) {
    if (probeLayouts.includes(d.layout)) {
      assert.equal(d.state, null, `${d.slug}（${d.layout}）被塞进了状态 ${d.state}`)
    }
  }
  for (const d of dataset.dataset) {
    assert.ok(!probeLayouts.includes(d.state), `状态值里出现了探测标记 ${d.state}`)
  }
})

test('104 条 embedded 全部是 embedded 态，没混进待翻译', () => {
  assert.equal(scanFormatCounts.embedded, 104)
  assert.equal(dataset.stat.stateCounts.embedded, 104)
  const embedded = dataset.dataset.filter(d => d.layout === 'embedded')
  for (const d of embedded) assert.equal(d.state, 'embedded', `${d.slug} 应为 embedded`)
  assert.equal(dataset.dataset.filter(d => d.state === 'gap-uncovered' && d.layout === 'embedded').length, 0)
})

test('234 条 none 全部是 no-quests 态', () => {
  assert.equal(scanFormatCounts.none, 234)
  assert.equal(dataset.stat.stateCounts['no-quests'], 234)
  for (const d of dataset.dataset.filter(x => x.layout === 'none')) {
    assert.equal(d.state, 'no-quests', `${d.slug} 应为 no-quests`)
  }
})

test('探测未完成计数与 TSV 的 nodl/toobig/other/抓取失败之和相等', () => {
  const expected = scanFormatCounts.nodl + scanFormatCounts.toobig
    + scanFormatCounts.other + scanFormatCounts['error:fetch failed']
  assert.equal(dataset.stat.probeIncomplete, expected)
  assert.equal(expected, 85 + 18 + 1 + 1)
})

test('分离布局的条数守恒：native-zh + gap-covered + gap-uncovered = separate-dir + separate-single', () => {
  const separate = scanFormatCounts['separate-dir'] + scanFormatCounts['separate-single']
  const classified = dataset.stat.stateCounts['native-zh']
    + dataset.stat.stateCounts['gap-covered']
    + dataset.stat.stateCounts['gap-uncovered']
  assert.equal(separate, 57)
  assert.equal(classified, separate)
})

test('stateCounts 的键集合与词表一致，各态都有键（含恒 0 的 downloadable）', () => {
  assert.deepEqual(Object.keys(dataset.stat.stateCounts), [...PACK_STATES])
  assert.equal(dataset.stat.stateCounts.downloadable, 0)
})

test('separate-dir / separate-single 有英文源、zhFiles=0、VM 无覆盖 ⇒ gap-uncovered', () => {
  for (const layout of ['separate-dir', 'separate-single']) {
    const r = classifyPack(pack(layout, { slug: 'no-such-pack-xyz' }), baseInput.vmEntries)
    assert.equal(r.state, 'gap-uncovered')
    assert.equal(r.probeIncomplete, false)
    assert.match(r.why, /本站未翻/)
  }
})

test('zhFiles>0 优先判为 native-zh，不再归入待翻译', () => {
  for (const layout of ['separate-dir', 'separate-single']) {
    const r = classifyPack(pack(layout, { slug: 'no-such-pack-xyz', zhFiles: 3 }), baseInput.vmEntries)
    assert.equal(r.state, 'native-zh')
  }
})

test('有英文源且 VM 覆盖 ⇒ gap-covered', () => {
  const r = classifyPack(
    pack('separate-dir', {
      slug: 'craftoria', enFiles: 66, title: 'Craftoria', normTitle: 'craftoria',
    }),
    baseInput.vmEntries,
  )
  assert.equal(r.state, 'gap-covered')
  assert.equal(r.match.vm.originalName, 'Craftoria')
})

test('embedded / none 的判定与 zhFiles 无关', () => {
  assert.equal(classifyPack(pack('embedded'), baseInput.vmEntries).state, 'embedded')
  assert.equal(classifyPack(pack('none'), baseInput.vmEntries).state, 'no-quests')
  assert.equal(classifyPack(pack('embedded', { zhFiles: 5 }), baseInput.vmEntries).state, 'embedded')
})

test('探测未完成的四种标记一律给 state=null 且 probeIncomplete=true', () => {
  for (const layout of ['nodl', 'toobig', 'other', 'error:fetch failed']) {
    const r = classifyPack(pack(layout, { zhFiles: 9 }), baseInput.vmEntries)
    assert.equal(r.state, null, `${layout} 不得有状态`)
    assert.equal(r.probeIncomplete, true)
  }
})

test('未知布局直接报错，不静默落态', () => {
  assert.throws(() => classifyPack(pack('separate-something-new'), baseInput.vmEntries), /未知语言布局/)
})

test('delivered 置位时落到 downloadable（本轮恒 0，结构留出）', () => {
  const r = classifyPack(pack('separate-dir', { delivered: true }), baseInput.vmEntries)
  assert.equal(r.state, 'downloadable')
  assert.equal(dataset.stat.stateCounts.downloadable, 0)
})

test('每条记录都带可读的 stateWhy，页面不必猜', () => {
  for (const d of dataset.dataset) {
    assert.equal(typeof d.stateWhy, 'string')
    assert.ok(d.stateWhy.length > 0, `${d.slug} 缺 stateWhy`)
  }
})

test('probeLayoutCounts 与扫描 TSV 逐格相等', () => {
  assert.deepEqual(dataset.stat.probeLayoutCounts, scanFormatCounts)
})

// ---- 回归：覆盖判定曾只在「分离布局」分支里跑 ----
// 旧实现在 classifyPack 里把 matchPack 写在 SEPARATE_LAYOUTS 分支内，
// 于是内嵌 / 无任务书 / 探测未完成的包在结构上永远查不到 VM。
// 实测漏掉 15 条，含 SkyFactory 5、Create: Astral、MC Eternal。

test('覆盖判定对全部布局生效：内嵌 / 无任务书 / 探测未完成都能命中 VM', () => {
  const cases = [
    // slug, 期望状态, 期望 vmSlug
    ['skyfactory-5', 'no-quests', 'sf5'],
    ['minecraft-eternal', 'no-quests', 'mce'],
    ['create-astral', 'embedded', 'create'],
    ['deceasedcraft', 'embedded', 'deceasedcraft'],
    ['ftb-stoneblock-3', 'embedded', 'sb3'],
    ['infernal-rpg', null, 'infernal'], // toobig：探测未完成，但 VM 有汉化
  ]
  for (const [slug, state, vmSlug] of cases) {
    const rec = bySlug.get(slug)
    assert.ok(rec, `产出里应有 ${slug}`)
    assert.equal(rec.state, state, `${slug} 状态应为 ${state}`)
    assert.ok(rec.vm, `${slug} 应命中 VM 覆盖（旧实现会漏掉）`)
    assert.equal(rec.vm.vmSlug, vmSlug, `${slug} 命中的 vmSlug 不对`)
  }
})

test('探测未完成的包也能带 VM 覆盖，且不因此获得六态', () => {
  const rec = bySlug.get('infernal-rpg')
  assert.equal(rec.probeIncomplete, true)
  assert.equal(rec.state, null, '探测未完成不得冒充六态')
  assert.ok(rec.vm, '探测未完成不代表社区没有汉化')
})

test('标题写法与 VM 不同时，理由文案必须如实说明（不能谎称标题缺失）', () => {
  const rec = bySlug.get('deceasedcraft')
  assert.equal(rec.vm.match, 'exact')
  const meta = JSON.parse(readFileSync(new URL('../research/pack-metadata.json', import.meta.url), 'utf8'))
  const title = meta.packs.find(p => p.slug === 'deceasedcraft')?.title
  assert.ok(title, 'deceasedcraft 应有标题')
  // 标题存在，理由里就不该出现「标题缺失」
  const m = matchPack(
    { slug: 'deceasedcraft', normSlug: 'deceasedcraft', normTitle: normLike(title), title },
    baseInput.vmEntries,
  )
  assert.equal(m.tier, 'exact')
  assert.doesNotMatch(m.why, /标题缺失/, `理由文案说谎：${m.why}`)
  assert.match(m.why, /标题写法不同/)
})

test('500 条标题全覆盖，否则 VM 全等判定无从谈起', () => {
  const missing = dataset.dataset.filter(d => !d.title)
  assert.equal(missing.length, 0, `缺标题：${missing.map(d => d.slug).join(', ')}`)
})

test('VM 命中总数不低于各布局分别命中的总和（防止再退回只跑分离布局）', () => {
  const matched = dataset.dataset.filter(d => d.vm)
  assert.ok(matched.length >= 28, `VM 命中 ${matched.length} 条，少于实测值 28`)
  const nonSeparate = matched.filter(d => !['separate-dir', 'separate-single'].includes(d.layout))
  assert.ok(nonSeparate.length > 0, '非分离布局必须有命中，否则说明覆盖判定又只跑分离布局了')
})

test('幂等：同一输入连跑两次，除时间戳外逐字节相同', () => {
  const a = buildDataset(input, { now: 'T' })
  const b = buildDataset(input, { now: 'T' })
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})
