#!/usr/bin/env node
/**
 * 扫描整合包：判断有没有 FTB Quests 任务书、是哪种格式、有没有自带 zh_cn。
 *
 * 只读 zip 中央目录（Range 请求），不下载整包。约 0.3~0.6MB / 包。
 * 用法：node scripts/scan-packs.mjs [--cf N] [--mr N]
 * 输出：research/scan-results.tsv（增量写入，中断可续）
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

const CF_KEY = process.env.CF_KEY
const OUT = process.env.SCAN_OUT
  || new URL('../research/scan-results.tsv', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const UA = { 'User-Agent': 'modpack-i18n-research/0.1' }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt
}

// ---------- zip 中央目录（只读） ----------
async function head(url, headers) {
  const r = await fetch(url, { method: 'HEAD', headers, redirect: 'follow' })
  if (!r.ok) throw new Error('HEAD ' + r.status)
  return { len: Number(r.headers.get('content-length')), finalUrl: r.url }
}
async function getRange(url, s, e, headers) {
  const r = await fetch(url, { headers: { ...headers, Range: `bytes=${s}-${e}` } })
  if (r.status !== 206) throw new Error('range ' + r.status)
  return Buffer.from(await r.arrayBuffer())
}
async function listZip(url, headers) {
  const { len, finalUrl } = await head(url, headers)
  const tailLen = Math.min(70000, len)
  const tail = await getRange(finalUrl, len - tailLen, len - 1, headers)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('no EOCD')
  let cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16)
  if (cdOff === 0xffffffff || cdSize === 0xffffffff) {
    let z = -1
    for (let i = eocd - 20; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06064b50) { z = i; break }
    if (z < 0) throw new Error('no zip64 EOCD')
    cdSize = Number(tail.readBigUInt64LE(z + 40)); cdOff = Number(tail.readBigUInt64LE(z + 48))
  }
  const cd = await getRange(finalUrl, cdOff, cdOff + cdSize - 1, headers)
  const names = []; let p = 0
  while (p + 46 <= cd.length) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break
    const nlen = cd.readUInt16LE(p + 28)
    names.push(cd.toString('utf8', p + 46, p + 46 + nlen))
    p += 46 + nlen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32)
  }
  return { totalBytes: len, cdBytes: cdSize, names }
}

// ---------- 判定 ----------
function classify(names) {
  const fq = names.filter(n => /ftbquests\/quests\//i.test(n))
  const sepDirEn = names.filter(n => /ftbquests\/quests\/lang\/en_us\//i.test(n)).length
  const sepDirZh = names.filter(n => /ftbquests\/quests\/lang\/zh_cn\//i.test(n)).length
  const sepFileEn = names.filter(n => /ftbquests\/quests\/lang\/en_us\.snbt$/i.test(n)).length
  const sepFileZh = names.filter(n => /ftbquests\/quests\/lang\/zh_cn\.snbt$/i.test(n)).length
  const embedded = names.filter(n => /ftbquests\/quests\/chapters\/.+\.snbt$/i.test(n)).length
  // 布局判定优先级：分离·目录 > 分离·单文件 > 内嵌
  let layout = 'none'
  if (sepDirEn > 0) layout = 'separate-dir'
  else if (sepFileEn > 0) layout = 'separate-single'
  else if (embedded > 0) layout = 'embedded'
  else if (fq.length > 0) layout = 'other'
  const produces = layout === 'separate-dir' || layout === 'separate-single'
  return {
    layout,
    produces,
    nativeZh: sepDirZh + sepFileZh,
    enFiles: sepDirEn + sepFileEn,
    embedded,
    fqCount: fq.length,
  }
}

// ---------- CurseForge ----------
async function scanCF(limit) {
  if (!CF_KEY) { console.log('跳过 CF：未设置 CF_KEY'); return }
  const H = { ...UA, 'x-api-key': CF_KEY, Accept: 'application/json' }
  const mods = []
  for (let page = 0; mods.length < limit; page++) {
    const r = await fetch(`https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&sortField=2&sortOrder=desc&pageSize=50&index=${page * 50}`, { headers: H })
    const j = await r.json()
    if (!j.data?.length) break
    mods.push(...j.data)
  }
  const list = mods.slice(0, limit)
  console.log(`\n=== CurseForge 整合包热度前 ${list.length} ===`)
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    const tag = `[CF ${i + 1}/${list.length}] ${m.slug}`
    try {
      const fr = await fetch(`https://api.curseforge.com/v1/mods/${m.id}/files?pageSize=1`, { headers: H })
      const f = (await fr.json()).data[0]
      if (!f?.downloadUrl) { console.log(`${tag} - 无下载地址`); write(tag, 'cf', m.id, m.slug, 0, 'nodl', '', '', '', ''); continue }
      const mb = f.fileLength / 1048576
      if (mb > 400) { console.log(`${tag} - ${mb.toFixed(0)}MB 跳过`); write(tag, 'cf', m.id, m.slug, f.fileLength, 'toobig', '', '', '', ''); continue }
      const { totalBytes, cdBytes, names } = await listZip(f.downloadUrl, H)
      const c = classify(names)
      console.log(`${tag} - ${mb.toFixed(0)}MB ${c.layout} en${c.enFiles} zh${c.nativeZh} emb${c.embedded}`)
      write(tag, 'cf', m.id, m.slug, totalBytes, c.layout, c.enFiles, c.nativeZh, c.embedded, Math.round(cdBytes / 1024))
    } catch (e) { console.log(`${tag} - ERR ${e.message.slice(0, 50)}`); write(tag, 'cf', m.id, m.slug, 0, 'error:' + e.message.slice(0, 40), '', '', '', '') }
    await sleep(120)
  }
}

// ---------- Modrinth ----------
async function scanMR(limit) {
  const H = UA
  const facets = encodeURIComponent(JSON.stringify([['project_type:modpack']]))
  const hits = []
  for (let off = 0; hits.length < limit; off += 50) {
    const r = await fetch(`https://api.modrinth.com/v2/search?limit=50&index=downloads&facets=${facets}&offset=${off}`, { headers: H })
    const j = await r.json()
    hits.push(...j.hits)
    if (j.hits.length === 0) break
  }
  const list = hits.slice(0, limit)
  console.log(`\n=== Modrinth 整合包热度前 ${list.length} ===`)
  for (let i = 0; i < list.length; i++) {
    const h = list[i]
    const tag = `[MR ${i + 1}/${list.length}] ${h.slug}`
    try {
      const vr = await fetch(`https://api.modrinth.com/v2/project/${h.project_id}/version`, { headers: H })
      const vs = await vr.json()
      const v = vs.find(v => v.files.some(f => f.filename.endsWith('.mrpack'))) || vs[0]
      const f = v.files.find(f => f.filename.endsWith('.mrpack')) || v.files[0]
      const mb = f.size / 1048576
      if (mb > 400) { console.log(`${tag} - ${mb.toFixed(0)}MB 跳过`); write(tag, 'mr', h.project_id, h.slug, f.size, 'toobig', '', '', '', ''); continue }
      const { totalBytes, cdBytes, names } = await listZip(f.url, H)
      const c = classify(names)
      console.log(`${tag} - ${mb.toFixed(0)}MB ${c.layout} en${c.enFiles} zh${c.nativeZh} emb${c.embedded}`)
      write(tag, 'mr', h.project_id, h.slug, totalBytes, c.layout, c.enFiles, c.nativeZh, c.embedded, Math.round(cdBytes / 1024))
    } catch (e) { console.log(`${tag} - ERR ${e.message.slice(0, 50)}`); write(tag, 'mr', h.project_id, h.slug, 0, 'error:' + e.message.slice(0, 40), '', '', '', '') }
    await sleep(120)
  }
}

function write(tag, platform, id, slug, bytes, format, newEn, newZh, oldCh, cdKB) {
  appendFileSync(OUT, [platform, id, slug, bytes, format, newEn, newZh, oldCh, cdKB, new Date().toISOString()].join('\t') + '\n')
}

if (!existsSync(OUT)) writeFileSync(OUT, ['platform', 'id', 'slug', 'bytes', 'format', 'newEn', 'newZh', 'oldCh', 'cdKB', 'scannedAt'].join('\t') + '\n')
await scanCF(arg('cf', 100))
await scanMR(arg('mr', 100))
console.log('\n完成 → ' + OUT)
