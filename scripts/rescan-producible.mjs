#!/usr/bin/env node
/** 用修正后的分类器复扫「可产出」整合包，精确统计 en_us / zh_cn 文件数与区域变体。 */
import { appendFileSync, writeFileSync } from 'node:fs'
const CF = process.env.CF_KEY
const H = { 'User-Agent': 'modpack-i18n-research/0.1', 'x-api-key': CF, Accept: 'application/json' }
const OUT = 'research/rescan-producible.tsv'
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function getRange(url, s, e) {
  const r = await fetch(url, { headers: { ...H, Range: `bytes=${s}-${e}` } })
  if (r.status !== 206) throw new Error('st' + r.status)
  return Buffer.from(await r.arrayBuffer())
}
async function listZip(url) {
  const hr = await fetch(url, { method: 'HEAD', headers: H, redirect: 'follow' })
  const len = Number(hr.headers.get('content-length'))
  const tail = await getRange(hr.url, len - Math.min(70000, len), len - 1)
  let e = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break }
  if (e < 0) throw new Error('no EOCD')
  let cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16)
  if (cdOff === 0xffffffff || cdSize === 0xffffffff) {
    let z = -1
    for (let i = e - 20; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06064b50) { z = i; break }
    cdSize = Number(tail.readBigUInt64LE(z + 40)); cdOff = Number(tail.readBigUInt64LE(z + 48))
  }
  const d = await getRange(hr.url, cdOff, cdOff + cdSize - 1)
  const names = []; let p = 0
  while (p + 46 <= d.length) {
    if (d.readUInt32LE(p) !== 0x02014b50) break
    const nlen = d.readUInt16LE(p + 28)
    names.push(d.toString('utf8', p + 46, p + 46 + nlen))
    p += 46 + nlen + d.readUInt16LE(p + 30) + d.readUInt16LE(p + 32)
  }
  return { len, names }
}
// 从扫描结果取可产出 slug
const slugs = process.argv.slice(2)
writeFileSync(OUT, ['slug','layout','enFiles','zhFiles','otherLocales','enBytes'].join('\t') + '\n')
for (let i = 0; i < slugs.length; i++) {
  const slug = slugs[i]
  try {
    const sr = await fetch(`https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&slug=${slug}`, { headers: H })
    const mod = (await sr.json()).data[0]
    if (!mod) { console.log(`[${i+1}/${slugs.length}] ${slug} - 找不到`); continue }
    const fr = await fetch(`https://api.curseforge.com/v1/mods/${mod.id}/files?pageSize=1`, { headers: H })
    const f = (await fr.json()).data[0]
    const { names } = await listZip(f.downloadUrl)
    const lang = names.filter(n => /ftbquests\/quests\/lang\//i.test(n))
    const dirEn = lang.filter(n => /\/lang\/en_us\//i.test(n)).length
    const dirZh = lang.filter(n => /\/lang\/zh_cn\//i.test(n)).length
    const fileEn = lang.filter(n => /\/lang\/en_us\.snbt$/i.test(n)).length
    const fileZh = lang.filter(n => /\/lang\/zh_cn\.snbt$/i.test(n)).length
    const enFiles = dirEn + fileEn, zhFiles = dirZh + fileZh
    const layout = dirEn > 0 ? 'separate-dir' : fileEn > 0 ? 'separate-single' : 'other'
    const others = [...new Set(lang.map(n => (n.match(/\/lang\/([^/.]+)[/.]?/) || [])[1]).filter(Boolean))]
      .filter(l => l !== 'en_us' && l !== 'zh_cn').sort()
    console.log(`[${i+1}/${slugs.length}] ${slug.padEnd(32)} ${layout.padEnd(16)} en:${String(enFiles).padStart(3)} zh:${String(zhFiles).padStart(3)}  其它:${others.length}`)
    appendFileSync(OUT, [slug, layout, enFiles, zhFiles, others.join(','), 0].join('\t') + '\n')
  } catch (e) {
    console.log(`[${i+1}/${slugs.length}] ${slug} - ERR ${e.message.slice(0, 45)}`)
  }
  await sleep(150)
}
console.log('\n→ ' + OUT)
