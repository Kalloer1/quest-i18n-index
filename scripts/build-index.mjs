#!/usr/bin/env node
/**
 * 索引数据集构建入口（工单 01）。
 *
 * 单一职责：读 research/build-input.json，产出 research/index-dataset.json。
 * 纯函数、离线、幂等：同一输入连跑两次，除时间戳外逐字节相同。
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

import { readFileSync, writeFileSync } from 'node:fs'

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

  // 4) 标题缺失时的兜底：slug 规范化后与 VM 名称**全等**（不是子串）
  //    全等比对不含「包含」语义，因此不会引入通用词撞车。
  const slugHits = vmEntries.filter(v => v.normName === pack.normSlug)
  if (slugHits.length === 1) {
    return { tier: 'exact', vm: slugHits[0], why: '标题缺失，slug 与 VM 名称规范化后全等' }
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

// ---------- 构建 ----------

export function buildDataset(input, { now = new Date().toISOString() } = {}) {
  const packs = input.packs.map(p => {
    const m = matchPack(p, input.vmEntries)
    return {
      slug: p.slug,
      cfId: p.cfId,
      layout: p.layout,
      enFiles: p.enFiles,
      zhFiles: p.zhFiles,
      title: p.title,
      // siteStatus 的六态模型由工单 02 接管；此处保持工单 01 的既有语义
      siteStatus: p.zhFiles > 0 ? 'native-zh' : 'gap',
      vm: m.vm
        ? { match: m.tier, vmSlug: m.vm.vmSlug, originalName: m.vm.originalName, title: m.vm.title }
        : null,
      vmSuspect: m.tier === 'suspect' ? { why: m.why } : null,
      vmRejected: m.tier === null ? { why: m.why } : null,
    }
  })

  const stat = {
    total: packs.length,
    gap: packs.filter(p => p.siteStatus === 'gap').length,
    native: packs.filter(p => p.siteStatus === 'native-zh').length,
    coveredByVm: packs.filter(p => p.vm).length,
    vmSuspect: packs.filter(p => p.vmSuspect).length,
    vmRejected: packs.filter(p => p.vmRejected).length,
    trulyUncovered: packs.filter(p => p.siteStatus === 'gap' && !p.vm).length,
  }

  return {
    generatedAt: now,
    // 工单 01 要求：新旧覆盖数差异必须写在元数据里
    coverageChange: {
      previous: 21,
      current: stat.coveredByVm,
      reason: [
        '旧值 21 含 10 条 fuzzy 误配（slug 子串包含即判命中）。',
        '误配分两类：通用词撞车（create / fantasy 短 slug）、续作当同款（X-2 命中 X）。',
        '新逻辑只用标题全等判定；标题缺失时降级为疑似，不计入覆盖。',
      ],
    },
    stat,
    dataset: packs,
  }
}

// ---------- CLI ----------

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())

if (isMain) {
  const inPath = process.argv[2] || 'research/build-input.json'
  const outPath = process.argv[3] || 'research/index-dataset.json'
  const input = JSON.parse(readFileSync(inPath, 'utf8'))
  const out = buildDataset(input)
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')
  console.log(`→ ${outPath}`)
  console.log(`  VM 覆盖 ${out.stat.coveredByVm}（旧 21）  疑似 ${out.stat.vmSuspect}  判拒 ${out.stat.vmRejected}`)
}
