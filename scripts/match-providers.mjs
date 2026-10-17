#!/usr/bin/env node
/**
 * 把「可产出任务书的整合包」与外部汉化提供方（VM汉化组 / CFPA）做交叉匹配。
 * 输入：research/scan-cf500.tsv、research/vm-packs.json（VM 官网解析）、CFPA 项目清单
 * 输出：research/index-dataset.json
 */
import { readFileSync, writeFileSync } from 'node:fs'

const norm = s => String(s || '')
  .toLowerCase()
  .replace(/[™®©]/g, '')
  .replace(/[''`´]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')

// 去掉常见后缀词做「核心名」，用于宽松匹配
const core = s => norm(s)
  .replace(/-(chinese|cn|zh|zh-cn)-?(patch)?-?(pack)?$/g, '')
  .replace(/-chinese$/g, '')
  .replace(/^ftb-/, 'ftb-')

// ---- 站内扫描结果 ----
const rows = readFileSync('research/scan-cf500.tsv', 'utf8').trim().split('\n').slice(1)
  .map(l => l.split('\t'))
  .filter(r => r[0] === 'cf')
  .map(r => ({ platform: r[0], id: r[1], slug: r[2], bytes: +r[3], layout: r[4], enFiles: +r[5], zhFiles: +r[6], embedded: +r[7] }))

// ---- VM 官网 ----
let vm = []
try { vm = JSON.parse(readFileSync('research/vm-packs.json', 'utf8')) } catch { console.log('⚠ 缺 research/vm-packs.json，VM 匹配跳过') }
const vmIndex = vm.map(v => ({
  ...v,
  keys: [norm(v.vmSlug), norm(v.originalName), core(v.originalName)].filter(Boolean),
  originalNorm: norm(v.originalName),
}))

// ---- CFPA Modpack-GuideBook-i18n（35 个，2019-2022，多为老包）----
const cfpaPacks = [
  'Age of Engineering','All the Mods 3 Expert','Amnesia','Antimatter Chemistry','AstroBlock',
  'Chemical Exchange','Compact Claustrophobia','Enigmatica 2 Expert','Exoria','FTB Continuum',
  'FTB Interactions','FTB Presents SkyFactory 3','FTB Pyramid Reborn','FTB Sky Factory Challenges',
  'Farming Valley','GT New Horizons','Glacial Awakening','Greg Block','Invasion','Mass Production',
  'Material Energy^5- Entity','Modern Skyblock 3','Nomifactory','Omnifactory','Primal Skies',
  'Project Equivalence','Roguelike Adventures and Dungeons','SevTech Ages','SkyFactory 4',
  'Space Astronomy 2','Stone Block 2','Stone Block','TerraFirmaCraft Reloaded','Volcano Block',
]
const cfpaIndex = cfpaPacks.map(n => ({ name: n, keys: [norm(n), core(n)] }))

// ---- 匹配 ----
function matchVm(pack) {
  const cands = [norm(pack.slug), core(pack.slug)]
  for (const v of vmIndex) {
    for (const k of cands) {
      if (!k) continue
      if (v.keys.includes(k)) return { how: 'exact', vm: v }
    }
  }
  // 宽松：互相包含（长度 ≥6 才允许，避免误配）
  for (const v of vmIndex) {
    for (const k of cands) {
      if (!k || k.length < 6) continue
      for (const vk of v.keys) {
        if (!vk || vk.length < 6) continue
        if (vk.includes(k) || k.includes(vk)) return { how: 'fuzzy', vm: v }
      }
    }
  }
  return null
}
function matchCfpa(pack) {
  const cands = [norm(pack.slug), core(pack.slug)]
  for (const c of cfpaIndex) {
    for (const k of cands) if (k && c.keys.includes(k)) return { how: 'exact', cfpa: c }
  }
  return null
}

const producible = rows.filter(r => r.layout === 'separate-dir' || r.layout === 'separate-single')
const dataset = producible.map(p => {
  const vmm = matchVm(p)
  const cfm = matchCfpa(p)
  return {
    slug: p.slug,
    cfId: p.id,
    layout: p.layout,
    enFiles: p.enFiles,
    // siteStatus：本站视角
    siteStatus: p.zhFiles > 0 ? 'native-zh' : 'gap',
    nativeZhFiles: p.zhFiles,
    // 外部提供方
    vm: vmm ? { match: vmm.how, vmSlug: vmm.vm.vmSlug, originalName: vmm.vm.originalName, title: vmm.vm.title, icon: vmm.vm.icon } : null,
    cfpa: cfm ? { match: cfm.how, name: cfm.cfpa.name } : null,
  }
})

// ---- 统计 ----
const stat = { total: producible.length, gap: 0, native: 0, coveredByVm: 0, coveredByCfpa: 0, coveredAny: 0, trulyUncovered: 0 }
for (const d of dataset) {
  if (d.siteStatus === 'gap') stat.gap++; else stat.native++
  if (d.vm) stat.coveredByVm++
  if (d.cfpa) stat.coveredByCfpa++
  if (d.vm || d.cfpa) stat.coveredAny++
  if (d.siteStatus === 'gap' && !d.vm && !d.cfpa) stat.trulyUncovered++
}

writeFileSync('research/index-dataset.json', JSON.stringify({ generatedAt: new Date().toISOString(), stat, dataset }, null, 2))

console.log('=== 交叉匹配结果 ===')
console.log(`  可产出整合包        : ${stat.total}`)
console.log(`  ├ 已自带中文        : ${stat.native}`)
console.log(`  └ 无中文（缺口）    : ${stat.gap}`)
console.log()
console.log(`  VM汉化组已覆盖      : ${stat.coveredByVm}`)
console.log(`  CFPA 已覆盖         : ${stat.coveredByCfpa}`)
console.log(`  至少一家覆盖        : ${stat.coveredAny}`)
console.log(`  ★ 无人覆盖（真空白） : ${stat.trulyUncovered}`)
console.log()
console.log('=== 无人覆盖的包（本站唯一价值所在）===')
dataset.filter(d => d.siteStatus === 'gap' && !d.vm && !d.cfpa)
  .forEach(d => console.log(`  ${d.slug.padEnd(34)} ${d.layout.padEnd(17)} en:${d.enFiles}`))
console.log()
console.log('=== 缺口但已被 VM 覆盖 ===')
dataset.filter(d => d.siteStatus === 'gap' && d.vm)
  .forEach(d => console.log(`  ${d.slug.padEnd(34)} → VM: ${d.vm.originalName} (${d.vm.match})`))
console.log('\n→ research/index-dataset.json')
