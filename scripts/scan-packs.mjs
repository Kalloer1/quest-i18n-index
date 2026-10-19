#!/usr/bin/env node
/**
 * 扫描整合包：判断有没有 FTB Quests 任务书、是哪种格式、有没有自带 zh_cn。
 *
 * 只读 zip 中央目录（Range 请求），不下载整包。约 0.3~0.6MB / 包。
 * 用法：node scripts/scan-packs.mjs [--cf N] [--mr N]
 * 输出：research/scan-results.tsv（增量写入，中断可续）
 *
 * 分类逻辑**复用 lib/candidates.mjs 的 classifyLayout**，不在这里再写一份。
 * 事故：本文件曾复制过一份分类器，只把 `lang/en_us/*` 算进 enFiles，
 * 内嵌格式于是恒为 0，导致全部 213 个内嵌包被 skipReason 判成「找不到英文源」而跳过
 * （2000 条扫描里 66% 的可做工作被静默丢弃，表面还显示「ok / failed 0」）。
 * 两处重复实现是这类偏差的温床，故合并为一处。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { classifyLayout } from './lib/candidates.mjs'

const CF_KEY = process.env.CF_KEY
const OUT = process.env.SCAN_OUT
  || new URL('../research/scan-results.tsv', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const UA = { 'User-Agent': 'modpack-i18n-research/0.1' }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 带重试的 fetch：长任务（上千条）里单次网络抖动不该让整轮退出。
 * 早先 --cf 1000 实测：搜索页第一次请求就 'TypeError: terminated' 直接崩溃，一行没扫。
 * @param {string} url
 * @param {object} [init]
 * @param {number} [tries]
 */
async function fetchRetry(url, init = {}, tries = 4) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) })
      if (r.status >= 500 || r.status === 429) throw new Error('HTTP ' + r.status)
      return r
    } catch (e) {
      last = e
      const wait = 1000 * 2 ** i
      console.log(`  [retry ${i + 1}/${tries}] ${url.slice(0, 60)}… ${e.message.slice(0, 40)}，${wait}ms 后重试`)
      await sleep(wait)
    }
  }
  throw last
}

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt
}

// ---------- zip 中央目录（只读） ----------
async function head(url, headers) {
  const r = await fetchRetry(url, { method: 'HEAD', headers, redirect: 'follow' })
  if (!r.ok) throw new Error('HEAD ' + r.status)
  return { len: Number(r.headers.get('content-length')), finalUrl: r.url }
}
async function getRange(url, s, e, headers) {
  const r = await fetchRetry(url, { headers: { ...headers, Range: `bytes=${s}-${e}` } })
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
  // 唯一真相源：lib/candidates.mjs。本文件不再自己算 enFiles/zhFiles。
  const c = classifyLayout(names)
  const fq = names.filter((n) => /ftbquests\/quests\//i.test(n))
  return {
    layout: c.layout,
    produces: c.layout === 'separate-dir' || c.layout === 'separate-single',
    nativeZh: c.zhFiles,
    // classifyLayout 已保证内嵌布局的 enFiles = 章节数（不是 0）。
    enFiles: c.enFiles,
    embedded: c.embeddedFiles,
    fqCount: fq.length,
  }
}

// ---------- CurseForge ----------
/**
 * 扫 CurseForge。支持按 index 区间切分，便于多进程并行。
 *
 * @param {number} limit 总数上限
 * @param {{start?: number, end?: number}} [range] index 区间 [start, end)；不传则从 0 开始扫 limit 条
 */
async function scanCF(limit, { start = 0, end = null } = {}) {
  if (!CF_KEY) { console.log('跳过 CF：未设置 CF_KEY'); return }
  const H = { ...UA, 'x-api-key': CF_KEY, Accept: 'application/json' }
  const stop = end ?? (start + limit)
  const mods = []
  for (let index = start; index < stop; index += 50) {
    const r = await fetchRetry(`https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&sortField=2&sortOrder=desc&pageSize=50&index=${index}`, { headers: H })
    const j = await r.json()
    if (!j.data?.length) break
    mods.push(...j.data)
  }
  const list = mods.slice(0, stop - start)
  console.log(`\n=== CurseForge 整合包 index ${start}..${start + list.length - 1}（共 ${list.length}） ===`)
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    const tag = `[CF ${start + i + 1}/${stop}] ${m.slug}`
    try {
      const fr = await fetchRetry(`https://api.curseforge.com/v1/mods/${m.id}/files?pageSize=1`, { headers: H })
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
/**
 * 扫 Modrinth。支持按 offset 区间切分，便于多进程并行。
 *
 * @param {number} limit 总数上限
 * @param {{start?: number, end?: number}} [range] offset 区间 [start, end)
 */
async function scanMR(limit, { start = 0, end = null } = {}) {
  const H = UA
  const facets = encodeURIComponent(JSON.stringify([['project_type:modpack']]))
  const stop = end ?? (start + limit)
  const hits = []
  for (let off = start; off < stop; off += 50) {
    const r = await fetchRetry(`https://api.modrinth.com/v2/search?limit=50&index=downloads&facets=${facets}&offset=${off}`, { headers: H })
    const j = await r.json()
    hits.push(...j.hits)
    if (j.hits.length === 0) break
  }
  const list = hits.slice(0, stop - start)
  console.log(`\n=== Modrinth 整合包 offset ${start}..${start + list.length - 1}（共 ${list.length}） ===`)
  for (let i = 0; i < list.length; i++) {
    const h = list[i]
    const tag = `[MR ${start + i + 1}/${stop}] ${h.slug}`
    try {
      const vr = await fetchRetry(`https://api.modrinth.com/v2/project/${h.project_id}/version`, { headers: H })
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

// 区间参数：多进程并行时每个进程扫一段。
// 不传则从 0 开始（保持旧行为）。
const rangeOf = (prefix) => ({
  start: arg(`${prefix}-start`, 0),
  end: process.argv.includes(`--${prefix}-end`) ? arg(`${prefix}-end`, null) : null,
})

await scanCF(arg('cf', 100), rangeOf('cf'))
await scanMR(arg('mr', 100), rangeOf('mr'))
console.log('\n完成 → ' + OUT)
