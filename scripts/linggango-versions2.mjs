// 版本考古 v2：无 API 依赖，直接构造 CDN 直链抽样
import { inflateRawSync } from 'node:zlib'
import { parse } from '/data/home/quest-repo/scripts/snbt.mjs'
const UA = { 'User-Agent': 'modpack-i18n-research/0.1' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const VERSIONS = [
  [8812273, 'Linggango-V6.6.5.zip'],
  [8813477, 'Linggango-V6.6.5b1.zip'],
  [8817111, 'Linggango-V6.6.5b2.zip'],
]
const sleepRetry = async (fn, tries = 3) => { for (let i = 0; ; i++) { try { return await fn() } catch (e) { if (i === tries - 1) throw e; await sleep(1500) } } }

for (const [id, name] of VERSIONS) {
  const url = `https://mediafiles.forgecdn.net/files/${Math.floor(id / 1000)}/${id % 1000}/${encodeURIComponent(name)}`
  const head = await sleepRetry(() => fetch(url, { method: 'HEAD', headers: UA }))
  const len = Number(head.headers.get('content-length'))
  const tail = Buffer.from(await (await sleepRetry(() => fetch(url, { headers: { ...UA, Range: `bytes=${len - 70000}-${len - 1}` } }))).arrayBuffer())
  let e = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break }
  const cs = tail.readUInt32LE(e + 12), co = tail.readUInt32LE(e + 16)
  const cd = Buffer.from(await (await sleepRetry(() => fetch(url, { headers: { ...UA, Range: `bytes=${co}-${co + cs - 1}` } }))).arrayBuffer())
  const entries = []; let p = 0
  while (p + 46 <= cd.length) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break
    const nl = cd.readUInt16LE(p + 28)
    const fname = cd.toString('utf8', p + 46, p + 46 + nl)
    if (fname.endsWith('.snbt') && /ftbquests\/quests\//i.test(fname)) entries.push({ name: fname.replace(/^overrides\//i, ''), offset: cd.readUInt32LE(p + 42) })
    p += 46 + nl + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32)
  }
  console.log(`[${id}] ${name} ${(len / 1048576).toFixed(0)}MB 任务书 ${entries.length}`)
  let garbage = 0, good = 0
  for (const ent of [entries[0], entries[Math.floor(entries.length / 2)], entries[entries.length - 1]]) {
    if (!ent) continue
    const lh = Buffer.from(await (await sleepRetry(() => fetch(url, { headers: { ...UA, Range: `bytes=${ent.offset}-${ent.offset + 29}` } }))).arrayBuffer())
    const csize = lh.readUInt32LE(18), nlen = lh.readUInt16LE(26), elen = lh.readUInt16LE(28), method = lh.readUInt16LE(8)
    const data = Buffer.from(await (await sleepRetry(() => fetch(url, { headers: { ...UA, Range: `bytes=${ent.offset + 30 + nlen + elen}-${ent.offset + 30 + nlen + elen + csize - 1}` } }))).arrayBuffer())
    const text = method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8')
    try { parse(text); good++ } catch { garbage++; console.log(`  垃圾: ${ent.name.slice(-40)}`) }
    await sleep(150)
  }
  console.log(`  抽样 good=${good} garbage=${garbage}`)
}
