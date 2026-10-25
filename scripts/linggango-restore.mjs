// linggango 旧版恢复 + 翻译驱动（方案①，在 work 主机 ~/quest-repo/scripts/ 下运行）
// 用法: node linggango-restore.mjs
// 恢复 V6.6.5b3hf (fileId 9020364) 的任务书（183 可解析 + 3 坏文件摘出记账），
// 然后走 translate-local 同款内部链：并行翻译 → writePatch → packBaseline → farm 推送。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { parse } from './snbt.mjs'
import { loadPackUnits, translatePackParallel } from './translate-parallel.mjs'
import { newRunId, mergeShards, loadState, saveState } from './translate-local.mjs'
import { buildOutputs, extractPack, sourceFileNames } from './lib/quest-files.mjs'
import { packBaseline } from './lib/baseline.mjs'
import { commitAndPush } from './lib/farm-git.mjs'

const ROOT = '/data/home/quest-repo'
const PACK_DIR = join(ROOT, 'research/packs/linggango')
const SLUG = 'linggango'
const FILE_ID = 8817111
const FILE_NAME = 'Linggango-V6.6.5b2.zip'
const FILE_DATE = null
const URL = `https://mediafiles.forgecdn.net/files/${Math.floor(FILE_ID / 1000)}/${FILE_ID % 1000}/${encodeURIComponent(FILE_NAME)}`
const UA = { 'User-Agent': 'modpack-i18n-research/0.1' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(new Date().toISOString().slice(11, 19), m)

async function fetchRetry(url, init = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) })
      if (r.status >= 500 || r.status === 429) throw new Error('HTTP ' + r.status)
      return r
    } catch (e) { if (i === tries - 1) throw e; await sleep(1000 * 2 ** i) }
  }
}

// ---- 1. 中央目录 ----
log('读中央目录 ' + URL)
const head = await fetchRetry(URL, { method: 'HEAD', headers: UA })
const len = Number(head.headers.get('content-length'))
const tailLen = Math.min(70000, len)
const tail = Buffer.from(await (await fetchRetry(URL, { headers: { ...UA, Range: `bytes=${len - tailLen}-${len - 1}` } })).arrayBuffer())
let e = -1
for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break }
const cs = tail.readUInt32LE(e + 12), co = tail.readUInt32LE(e + 16)
const cd = Buffer.from(await (await fetchRetry(URL, { headers: { ...UA, Range: `bytes=${co}-${co + cs - 1}` } })).arrayBuffer())
const entries = []
let p = 0
while (p + 46 <= cd.length) {
  if (cd.readUInt32LE(p) !== 0x02014b50) break
  const nl = cd.readUInt16LE(p + 28)
  const name = cd.toString('utf8', p + 46, p + 46 + nl)
  entries.push({ name, offset: cd.readUInt32LE(p + 42) })
  p += 46 + nl + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32)
}
const snbt = entries.filter((x) => x.name.endsWith('.snbt') && /ftbquests\/quests\//i.test(x.name))
log(`snbt ${snbt.length}/${entries.length}，逐个 Range 取回（带节流）`)

// ---- 2. 逐文件取回 + 解析分流 ----
// 先清掉上一轮 --force 留下的 .skipped 残迹与旧记账
for (const f of readdirSync(PACK_DIR)) {
  const full = join(PACK_DIR, f)
  if (statSync(full).isFile() && (f.endsWith('.skipped') || f === '.skipped-files.json' || f === '.source.json')) rmSync(full)
}
const walkClean = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const full = join(d, f.name); f.isDirectory() ? walkClean(full) : f.name.endsWith('.skipped') && rmSync(full) } }
walkClean(PACK_DIR)

const good = [], bad = []
for (const ent of snbt) {
  const rel = ent.name.replace(/^overrides\//i, '')
  try {
    const lh = Buffer.from(await (await fetchRetry(URL, { headers: { ...UA, Range: `bytes=${ent.offset}-${ent.offset + 29}` } })).arrayBuffer())
    const csize = lh.readUInt32LE(18), nlen = lh.readUInt16LE(26), elen = lh.readUInt16LE(28), method = lh.readUInt16LE(8)
    const data = Buffer.from(await (await fetchRetry(URL, { headers: { ...UA, Range: `bytes=${ent.offset + 30 + nlen + elen}-${ent.offset + 30 + nlen + elen + csize - 1}` } })).arrayBuffer())
    const text = method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8')
    parse(text) // 可解析才收
    const dest = join(PACK_DIR, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, text)
    good.push(rel)
  } catch (err) {
    bad.push({ file: rel, error: String(err.message).slice(0, 80) })
  }
  await sleep(150)
}
log(`取回完成：可解析 ${good.length}，坏 ${bad.length}（${bad.map((b) => b.file.split('/').pop()).join('、')}）`)
if (bad.length > 3) { console.log('坏文件超预期（>5），中止不进入翻译，请人工复盘'); process.exit(2) }

// ---- 3. 记账 + .source.json ----
writeFileSync(join(PACK_DIR, '.skipped-files.json'), JSON.stringify({ skipped: bad.map((b) => ({ ...b, at: new Date().toISOString() })) }, null, 2) + '\n')
writeFileSync(join(PACK_DIR, '.source.json'), JSON.stringify({
  slug: SLUG, platform: 'cf', fileId: FILE_ID, fileName: FILE_NAME, fileDate: FILE_DATE,
  fetchedAt: new Date().toISOString(), recovered: true,
  note: 'V6.6.5b3 起任务书逐步变为 LGQ1 加密形态不可翻（V6.6.6hf 已 186/186 全加密），本补丁基于最后可译版本 V6.6.5b2（158 文件全干净，2026-09-05 发布）',
}, null, 2) + '\n')

// ---- 4. 翻译（translate-local 同款引擎） ----
const runId = newRunId()
log('翻译开始 lanes=96 runId=' + runId)
const r = await loadPackUnits(SLUG, join(ROOT, 'research/packs'))
log(`布局 ${r.layout}，单元 ${r.units.length} 条`)
await translatePackParallel(SLUG, { lanes: 96, runId, packsDir: join(ROOT, 'research/packs') })

// ---- 5. writePatch 复刻 ----
const listSnbt = (d, base = d) => { const o = []; for (const f of readdirSync(d)) { const full = join(d, f); statSync(full).isDirectory() ? o.push(...listSnbt(full, base)) : /\.snbt$/i.test(f) && o.push(full.slice(base.length + 1).replace(/\\/g, '/')) } return o }
const names = listSnbt(PACK_DIR).sort()
const srcNames = sourceFileNames(names, r.layout)
const files = names.filter((n) => srcNames.includes(n)).map((n) => ({ name: n, text: readFileSync(join(PACK_DIR, n), 'utf8') }))
const pack = extractPack({ files, layout: r.layout })
const { translations, shards } = mergeShards(join(ROOT, 'research/par-out', SLUG), runId)
if (!shards) throw new Error('无本轮分片')
const outputs = buildOutputs(pack, translations, { header: '# AI 初翻，未人工校对\n' })
const patchDir = join(ROOT, 'patches', SLUG)
let wFiles = 0, wKeys = 0
for (const o of outputs) {
  const target = join(patchDir, o.name)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, o.text)
  wFiles++
  wKeys += o.keyCount ?? 0
}
log(`补丁写出 ${wFiles} 个文件`)

// ---- 6. 基准源打包 + 台账 ----
const packed = packBaseline(PACK_DIR, join(ROOT, 'research/packs', SLUG + '.tar.gz'))
rmSync(PACK_DIR, { recursive: true, force: true })
log(`基准源打包 ${packed.files} 文件 ${(packed.bytes / 1048576).toFixed(1)}MB，源目录已删`)
const state = loadState()
state.done[SLUG] = { layout: r.layout, files: wFiles, translated: translations.size, total: r.units.length, at: new Date().toISOString() }
delete state.failed[SLUG]
saveState(state)

// ---- 7. farm 推送 ----
const push = commitAndPush({ root: ROOT, branch: 'farm/instabox-work', slugs: [SLUG] })
log(`推送 ${push.ok ? '成功' : '失败'}: ${push.ok ? '' : push.error}`)
