#!/usr/bin/env node
/**
 * 索引数据集构建入口（工单 01、02）。
 *
 * 单一职责：读 research/scan-cf500.tsv + research/build-input.json，产出 research/index-dataset.json。
 * 纯函数、离线、幂等：同一输入连跑两次，除时间戳外逐字节相同。
 *
 * 状态模型（工单 02）：每条整合包落入六态之一，见 PACK_STATES 与 classifyPack。
 * 「探测未完成」不是整合包属性，单独用 probeIncomplete 表达，**不得**作为状态值。
 *
 * 匹配分三档，只有前两档计入「已覆盖」：
 *   exact    —— CF 标题规范化后与 VM originalName 全等
 *   confirmed —— 人工确认表里显式登记（处理标题缺失或写法差异）
 *   suspect  —— 疑似，只作待核线索保留，不计入统计
 *
 * 两个结构性根因（见工单 01「已知答案」）：
 *   1. 通用词撞车：VM 有 create / fantasy / cave 这类短 slug，拿 slug 子串匹配必撞。
 *      ⇒ 一律不用 slug 做包含匹配。
 *   2. 续作当同款：craftoria-2 ≠ craftoria，是不同整合包（不同 CF id、不同任务书）。
 *      ⇒ CF slug 带数字续作后缀、且 VM 无同名条目时，判为未覆盖。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'

// ---------- 归一化 ----------

const norm = s => String(s || '')
  .toLowerCase()
  .replace(/[™®©]/g, '')
  .replace(/[‘’`´']/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')

/**
 * 剥掉「展示性后缀」，只用于**生成候选**，不用于判定。
 * 判定的最终依据是标题全等，不是这里的剥离结果。
 */
const stripSuffix = s => norm(s)
  .replace(/-(chinese|cn|zh|zh-cn)-?(patch)?-?(pack)?$/g, '')
  .replace(/-chinese$/g, '')

/**
 * 数字续作后缀：`craftoria-2`、`caveopolis-2`、`ftb-evolution-2`。
 * 命中则说明这是**另一个**整合包，不能靠剥后缀去认亲。
 */
const SEQUEL = /-(\d+)$/

// ---------- 人工确认表 ----------
// 标题缺失或写法与 VM 明显不同、但经人工核对确属同一整合包时登记于此。
// 每一条都必须写明理由，否则将来无法复核。
const CONFIRMED = new Map([
  // 目前 8 条已知误配全部判为「未覆盖」，故本表为空。
  // 新增条目格式：['cf-slug', { vmSlug: 'xxx', why: '核对依据' }]
])

// ---------- 匹配 ----------

/**
 * @param {{slug:string,title:string|null,normSlug:string,normTitle:string|null}} pack
 * @param {Array} vmEntries
 * @returns {{tier:'exact'|'confirmed'|'suspect'|null, vm:object|null, why:string}}
 */
export function matchPack(pack, vmEntries) {
  // 1) 人工确认优先
  const conf = CONFIRMED.get(pack.slug)
  if (conf) {
    const vm = vmEntries.find(v => v.vmSlug === conf.vmSlug)
    if (vm) return { tier: 'confirmed', vm, why: conf.why }
  }

  // 2) 标题全等（唯一可信的自动判定依据）
  if (pack.normTitle) {
    const hits = vmEntries.filter(v => v.normName === pack.normTitle)
    if (hits.length === 1) return { tier: 'exact', vm: hits[0], why: '标题规范化后全等' }
    if (hits.length > 1) {
      return { tier: 'suspect', vm: null, why: `标题全等命中 ${hits.length} 个 VM 条目，无法消歧` }
    }
  }

  // 3) 续作：CF 是 X-2 而 VM 只有 X ⇒ 明确不是同一个包
  const seq = SEQUEL.exec(pack.normSlug)
  if (seq) {
    const base = pack.normSlug.replace(SEQUEL, '')
    const baseHit = vmEntries.find(v => v.normName === base || v.normSlug === base)
    if (baseHit) {
      return {
        tier: null, vm: null,
        why: `续作不继承：CF 为「${base}-${seq[1]}」，VM 只有「${baseHit.originalName}」，属不同整合包`,
      }
    }
  }

  // 4) 兜底：slug 规范化后与 VM 名称**全等**（不是子串）。
  //    全等比对不含「包含」语义，因此不会引入通用词撞车。
  //    它覆盖两种情形：标题写法与 VM 不同（CF「DeceasedCraft - Urban Zombie Apocalypse」
  //    vs VM「DeceasedCraft」、CF「Integrated MC」vs VM「Integrated Minecraft」），
  //    以及标题缺失。两种情形的理由文案必须分开写，否则复核时会被误导。
  const slugHits = vmEntries.filter(v => v.normName === pack.normSlug)
  if (slugHits.length === 1) {
    return {
      tier: 'exact', vm: slugHits[0],
      why: pack.normTitle
        ? `标题写法不同（CF「${pack.title}」vs VM「${slugHits[0].originalName}」），slug 与 VM 名称规范化后全等`
        : '标题缺失，slug 与 VM 名称规范化后全等',
    }
  }

  // 5) 标题缺失 ⇒ 只能给疑似线索，绝不猜成已覆盖
  if (!pack.normTitle) {
    const loose = vmEntries.filter(v => v.normSlug && pack.normSlug.includes(v.normSlug))
    return {
      tier: loose.length ? 'suspect' : null, vm: null,
      why: loose.length
        ? `标题缺失，仅凭 slug 子串得到 ${loose.length} 条线索（${loose.map(v => v.vmSlug).join('/')}），待人工核对`
        : '标题缺失且无 slug 线索',
    }
  }

  return { tier: null, vm: null, why: '标题无全等命中' }
}

// ---------- 六态状态模型（工单 02） ----------

/**
 * 六态词表，顺序即页面展示顺序。词表与 GLOSSARY.md 同步。
 * 六态描述**整合包本身**；探测进度不是状态，见 classifyPack 的 probeIncomplete。
 */
export const PACK_STATES = Object.freeze([
  'downloadable',  // 可下载：本站已产出该整合包任务书汉化（本轮恒 0，结构保留）
  'native-zh',     // 自带中文：整合包自身已带中文译文
  'gap-uncovered', // 待翻译·无人覆盖：有英文源，本站未翻，社区也没有
  'gap-covered',   // 待翻译·社区已覆盖：有英文源，本站未翻，VM 或 CFPA 已有
  'embedded',      // 内嵌不可做：文本混在 chapters/*.snbt，该版本 FTB Quests 无翻译系统
  'no-quests',     // 无任务书：不含 FTB Quests
])

/** 有英文源、可定向产出的两种语言布局。 */
const SEPARATE_LAYOUTS = new Set(['separate-dir', 'separate-single'])

/**
 * 探测没跑完的布局标记。它们是探测结果，不是整合包属性，因此不进六态。
 *   nodl              无下载地址，探测没开始
 *   toobig            包体过大，未探测
 *   other             布局无法识别，探测未定论
 *   error:fetch failed 抓取失败
 */
const PROBE_INCOMPLETE_LAYOUTS = new Set(['nodl', 'toobig', 'other', 'error:fetch failed'])

/**
 * 判定一个整合包落入哪一态。
 * @param {{slug:string,layout:string,enFiles:number|null,zhFiles:number|null,delivered?:boolean}} pack
 * @param {Array} vmEntries
 * @returns {{state:string|null, probeIncomplete:boolean, why:string, match?:object}}
 */
export function classifyPack(pack, vmEntries) {
  const layout = pack.layout

  // 覆盖判定与探测进度、语言布局都无关，因此**先算一次**，各分支共用。
  // 两个曾经漏掉的情形（实测各有一条）：
  //   · 探测未完成（Infernal Origins 是 toobig，但 VM 有汉化）
  //   · 内嵌 / 无任务书（Create: Astral、SkyFactory 5 等 14 条，VM 都有汉化）
  // 旧实现只在「分离布局」分支里调 matchPack，导致这三类包在结构上
  // 永远不可能显示社区汉化来源。
  const m = matchPack(pack, vmEntries)

  // 探测未完成：拿不到探测结果，就无从判断整合包属性，六态留 null。
  if (PROBE_INCOMPLETE_LAYOUTS.has(layout)) {
    return { state: null, probeIncomplete: true, why: `探测未完成：${layout}`, match: m }
  }

  // delivered 由 downloads/<slug>.zip 的存在驱动（见 buildDataset 与 CLI）：
  // 只要该包已产出补丁包，就落入 downloadable 态。
  if (pack.delivered) {
    return { state: 'downloadable', probeIncomplete: false, why: '本站已产出该整合包任务书汉化', match: m }
  }

  if (layout === 'embedded') {
    return {
      state: 'embedded', probeIncomplete: false, match: m,
      why: '任务书文本内嵌在 chapters/*.snbt，该版本 FTB Quests 无翻译系统',
    }
  }

  if (layout === 'none') {
    return { state: 'no-quests', probeIncomplete: false, match: m, why: '探测到整合包不含 FTB Quests' }
  }

  if (SEPARATE_LAYOUTS.has(layout)) {
    // 自带中文的包也记录 VM 命中情况，供人工复核。
    if (Number(pack.zhFiles) > 0) {
      return {
        state: 'native-zh', probeIncomplete: false, match: m,
        why: `自带中文：${pack.zhFiles} 个中文任务书文件`,
      }
    }
    if (m.vm) {
      return {
        state: 'gap-covered', probeIncomplete: false, match: m,
        why: `社区已有「${m.vm.originalName}」：${m.why}`,
      }
    }
    return {
      state: 'gap-uncovered', probeIncomplete: false, match: m,
      why: `有 ${pack.enFiles} 个英文任务书文件，本站未翻；${m.why}`,
    }
  }

  throw new Error(`未知语言布局：${JSON.stringify(layout)}（整合包 ${pack.slug}）。新增布局须先定义其状态归属`)
}

// ---------- 构建 ----------

const countBy = (list, key) => list.reduce((acc, item) => {
  const k = key(item)
  acc[k] = (acc[k] || 0) + 1
  return acc
}, {})

export function buildDataset(input, { now = new Date().toISOString() } = {}) {
  // 已产出补丁包的 slug（downloads/<slug>.zip）。不传时为空，delivered 全为 false，
  // 六态计数与旧行为一致。
  const deliveredSlugs = input.deliveredSlugs ?? []
  const packs = input.packs.map(p => {
    const delivered = deliveredSlugs.includes(p.slug)
    const c = classifyPack({ ...p, delivered }, input.vmEntries)
    const m = c.match || null
    return {
      slug: p.slug,
      cfId: p.cfId,
      layout: p.layout,
      enFiles: p.enFiles,
      zhFiles: p.zhFiles,
      title: p.title ?? null,
      delivered,
      state: c.state,
      probeIncomplete: c.probeIncomplete,
      stateWhy: c.why,
      vm: m?.vm
        ? { match: m.tier, vmSlug: m.vm.vmSlug, originalName: m.vm.originalName, title: m.vm.title }
        : null,
      vmSuspect: m?.tier === 'suspect' ? { why: m.why } : null,
      vmRejected: m?.tier === null ? { why: m.why } : null,
    }
  })

  const stat = {
    total: packs.length,
    // 各态计数：可与 scan-cf500.tsv 的 format 列对账
    stateCounts: Object.fromEntries(PACK_STATES.map(s => [s, packs.filter(p => p.state === s).length])),
    classified: packs.filter(p => p.state !== null).length,
    probeIncomplete: packs.filter(p => p.probeIncomplete).length,
    probeLayoutCounts: countBy(packs, p => p.layout),
    // 「VM 覆盖」即待翻译·社区已覆盖的条数（自带中文的包不再重复计入）
    coveredByVm: packs.filter(p => p.state === 'gap-covered').length,
    // 有 VM 汉化来源的总条数，**不分状态**。站点列表页显示的「查到了社区汉化来源」
    // 就是这个数（build-site-data 的 stat.withProvider）。
    // 它比 coveredByVm 大：内嵌包、无任务书包、探测未完成的包也可能有 VM 汉化。
    vmMatched: packs.filter(p => p.vm).length,
    vmSuspect: packs.filter(p => p.vmSuspect).length,
    vmRejected: packs.filter(p => p.vmRejected).length,
  }

  // 完整性不变式：每条记录要么有态，要么是探测未完成，不允许凭空消失。
  if (stat.classified + stat.probeIncomplete !== stat.total) {
    throw new Error(`状态计数对不上：${stat.classified} + ${stat.probeIncomplete} ≠ ${stat.total}`)
  }

  return {
    generatedAt: now,
    // 工单 01 要求：新旧覆盖数差异必须写在元数据里
    coverageChange: {
      previous: 21,
      current: stat.vmMatched,
      reason: [
        '旧值 21 含 10 条 fuzzy 误配（slug 子串包含即判命中）。',
        '误配分两类：通用词撞车（create / fantasy 短 slug）、续作当同款（X-2 命中 X）。',
        '新逻辑只用标题全等判定；标题缺失时降级为疑似，不计入覆盖。',
        '工单 02 起产出覆盖全部 500 条扫描记录（原 57 条），current 与旧值不可直接比大小。',
        '此后又修了两个使覆盖数被低估的缺陷：',
        '  ① 覆盖判定原先只在「分离布局」分支里跑，内嵌 / 无任务书 / 探测未完成的包',
        '     结构上永远查不到 VM（实测少 15 条，含 SkyFactory 5、Create: Astral）。',
        '  ② 标题原只有 57 条「可产出」包有，其余 443 条无标题则无法做全等判定；',
        '     现由 fetch-pack-metadata.mjs 覆盖全部 500 条。',
      ],
    },
    stat,
    dataset: packs,
  }
}

// ---------- 扫描 TSV ----------

const toCount = v => (v === '' || v == null ? null : Number(v))

/**
 * 读扫描结果 TSV。列：platform id slug bytes format newEn newZh oldCh cdKB scannedAt。
 * TSV 的 format 列就是语言布局，产出里统一叫 layout。
 * @returns {Array<{slug:string,cfId:string,layout:string,enFiles:number|null,zhFiles:number|null,normSlug:string,normTitle:null}>}
 */
export function parseScanTsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  const header = lines[0].split('\t')
  for (const col of ['id', 'slug', 'format', 'newEn', 'newZh']) {
    if (!header.includes(col)) throw new Error(`扫描 TSV 缺列：${col}`)
  }
  const idx = Object.fromEntries(header.map((col, i) => [col, i]))
  return lines.slice(1).map(line => {
    const f = line.split('\t')
    const slug = f[idx.slug]
    return {
      cfId: f[idx.id],
      slug,
      layout: f[idx.format],
      enFiles: toCount(f[idx.newEn]),
      zhFiles: toCount(f[idx.newZh]),
      normSlug: norm(slug),
      normTitle: null,
    }
  })
}

/**
 * 合成 buildDataset 的输入。
 *
 * 扫描 TSV 提供全部 500 条记录；标题由 pack-metadata.json 提供（覆盖全部 500 条），
 * 它是 VM 覆盖匹配的**唯一可信依据**（见 matchPack）。
 * vmEntries 由 build-input.json 提供（VM 官网 58 条）。
 * deliveredSlugs 是 downloads/ 下已有 zip 的 slug 列表，透传给 buildDataset 置 delivered。
 *
 * @param {string} scanText  research/scan-cf500.tsv 的内容
 * @param {{titles?: Record<string,string|null>, vmEntries?: Array, deliveredSlugs?: string[]}} sources
 */
export function composeScanInput(scanText, { titles = {}, vmEntries = [], deliveredSlugs = [] } = {}) {
  return {
    packs: parseScanTsv(scanText).map(row => {
      const title = titles[row.slug] ?? null
      return { ...row, title, normTitle: title ? norm(title) : null }
    }),
    vmEntries,
    deliveredSlugs,
  }
}

// ---------- CLI ----------

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())

if (isMain) {
  const scanPath = process.argv[2] || 'research/scan-cf500.tsv'
  const outPath = process.argv[3] || 'research/index-dataset.json'
  const baseInput = JSON.parse(readFileSync('research/build-input.json', 'utf8'))
  const packMeta = JSON.parse(readFileSync('research/pack-metadata.json', 'utf8'))
  const titles = Object.fromEntries(
    (packMeta.packs || []).map(p => [p.slug, p.title ?? null]),
  )
  // downloads/ 下已有的 zip 即「已产出」：目录不存在时视为空（不破坏现有行为）。
  const deliveredSlugs = existsSync('downloads')
    ? readdirSync('downloads').filter(n => n.endsWith('.zip')).map(n => n.slice(0, -4))
    : []
  const input = composeScanInput(readFileSync(scanPath, 'utf8'), {
    titles,
    vmEntries: baseInput.vmEntries,
    deliveredSlugs,
  })
  const out = buildDataset(input)
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')
  console.log(`→ ${outPath}`)
  console.log(`  共 ${out.stat.total} 条：${Object.entries(out.stat.stateCounts).map(([s, n]) => `${s} ${n}`).join('  ')}`)
  console.log(`  标题覆盖 ${Object.values(titles).filter(Boolean).length}/${out.stat.total}`)
  console.log(`  探测未完成 ${out.stat.probeIncomplete}  VM 覆盖 ${out.stat.vmMatched}（旧 21）  疑似 ${out.stat.vmSuspect}`)
}
