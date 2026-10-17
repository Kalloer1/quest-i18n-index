#!/usr/bin/env node
/** 为设计稿抓真实整合包元数据（CurseForge 为主 + Modrinth 补充），产出 design/demo-data.json */
import { readFileSync, writeFileSync } from 'node:fs'
const UA = { 'User-Agent': 'modpack-i18n-site/0.1' }
const CF = process.env.CF_KEY
const CFH = { ...UA, 'x-api-key': CF, Accept: 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const lines = readFileSync('research/rescan-producible.tsv', 'utf8').trim().split('\n').slice(1)
const state = new Map()
for (const l of lines) { const [slug, layout, en, zh] = l.split('\t'); state.set(slug, { layout, en: +en, zh: +zh }) }
const out = []
for (const [slug, st] of state) {
  const rec = { slug, layout: st.layout, enFiles: st.en, zhFiles: st.zh, siteStatus: st.zh > 0 ? '自带中文' : '待翻译' }
  try {
    const r = await fetch(`https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&slug=${slug}`, { headers: CFH })
    const m = (await r.json()).data?.[0]
    if (m) {
      Object.assign(rec, {
        source: 'curseforge', title: m.name, description: (m.summary || '').replace(/\r?\n/g, ' ').trim(),
        iconUrl: m.logo?.thumbnailUrl || m.logo?.url || null,
        screenshots: (m.screenshots || []).slice(0, 4).map(s => s.thumbnailUrl || s.url),
        downloads: m.downloadCount, updated: (m.dateModified || '').slice(0, 10),
        gameVersions: (m.latestFilesIndexes || []).map(x => x.gameVersion).filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 6),
        loaders: [...new Set((m.latestFilesIndexes || []).map(x => ({ 1: 'Forge', 4: 'Fabric', 5: 'Quilt', 6: 'NeoForge' })[x.modLoader] || null).filter(Boolean))],
        authors: (m.authors || []).map(a => a.name).slice(0, 3),
        categories: (m.categories || []).map(c => c.name).slice(0, 5),
      })
    }
  } catch (e) { /* 保持无元数据 */ }
  out.push(rec)
  await sleep(150)
}
writeFileSync('design/demo-data.json', JSON.stringify(out, null, 2))
const withMeta = out.filter(x => x.title).length
console.log(`写入 design/demo-data.json：${out.length} 条，其中有完整元数据 ${withMeta} 条`)
console.log('自带中文:', out.filter(x => x.siteStatus === '自带中文').length, '| 待翻译:', out.filter(x => x.siteStatus === '待翻译').length)
