// linggango 版本考古：对旧版本逐个查任务书数量与垃圾率（HEAD + CD Range + 抽样解压）
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { parse } from '/data/home/quest-repo/scripts/snbt.mjs'
const key = readFileSync('/data/home/.cf-key', 'utf8').trim()
const UA = { 'User-Agent': 'modpack-i18n-research/0.1' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const id of process.argv.slice(2)) {
  const r = await fetch(`https://api.curseforge.com/v1/mods/${id}/files?pageSize=1`, { headers: { 'x-api-key': key, Accept: 'application/json' } })
  const f = (await r.json()).data[0]
  const url = `https://mediafiles.forgecdn.net/files/${Math.floor(f.id / 1000)}/${f.id % 1000}/${encodeURIComponent(f.fileName.trim())}`
  const head = await fetch(url, { method: 'HEAD', headers: UA })
  const len = Number(head.headers.get('content-length'))
  const tail = Buffer.from(await (await fetch(url, { headers: { ...UA, Range: `bytes=${len - 70000}-${len - 1}` } })).arrayBuffer())
  let e = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break }
  const cs = tail.readUInt32LE(e + 12), co = tail.readUInt32LE(e + 16)
  const cd = Buffer.from(await (await fetch(url, { headers: { ...UA, Range: `bytes=${co}-${co + cs - 1}` } })).arrayBuffer())
  const entries = []; let p = 0
  while (p + 46 <= cd.length) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break
    const nl = cd.readUInt16LE(p + 28)
    const name = cd.toString('utf8', p + 46, p + 46 + nl)
    if (name.endsWith('.snbt') && /ftbquests\/quests\//i.test(name)) entries.push({ name: name.replace(/^overrides\//i, ''), offset: cd.readUInt32LE(p + 42) })
    p += 46 + nl + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32)
  }
  console.log(`[${f.id}] ${f.fileName} ${(f.fileLength / 1048576).toFixed(0)}MB 任务书 ${entries.length}`)
  // 抽 3 个样本解压验内容
  let garbage = 0, good = 0
  for (const ent of [entries[0], entries[Math.floor(entries.length / 2)], entries[entries.length - 1]]) {
    if (!ent) continue
    const lh = Buffer.from(await (await fetch(url, { headers: { ...UA, Range: `bytes=${ent.offset}-${ent.offset + 29}` } })).arrayBuffer())
    const csize = lh.readUInt32LE(18), nlen = lh.readUInt16LE(26), elen = lh.readUInt16LE(28), method = lh.readUInt16LE(8)
    const data = Buffer.from(await (await fetch(url, { headers: { ...UA, Range: `bytes=${ent.offset + 30 + nlen + elen}-${ent.offset + 30 + nlen + elen + csize - 1}` } })).arrayBuffer())
    const text = method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8')
    try { parse(text); good++ } catch { garbage++; console.log(`  垃圾: ${ent.name.slice(-40)}`) }
    await sleep(150)
  }
  console.log(`  抽样 good=${good} garbage=${garbage}`)
}
