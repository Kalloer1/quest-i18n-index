#!/usr/bin/env node
/**
 * 回填补丁的来源版本：给所有缺 `fileDate` 的补丁查一次上游「最新文件」。
 *
 * ## 为什么需要
 * 版本记录是后加的功能，660 个已交付补丁里绝大多数没有 `.source.json`；
 * 273 个从构建日志回捞出来的也只有 fileName，没有 fileDate，
 * 站点上「汉化于 <日期>」永远是空的，文件名也没法带版本号。
 *
 * ## 判据（用户裁决：入库时间为主，30 天兜底）
 * 补丁的「首次入库时间」= `git log --diff-filter=A --format=%ct -- patches/<slug>/`
 * 最早那次的提交时间，它是「我们下载那个整合包」的时间上界。
 *   - `fileDate <= 入库时间` → 当时的最新文件就是我们翻的那一版 → inferred: latest
 *   - 否则 `now - fileDate > 30 天` → 也判 latest（作者一个月没动，几乎不可能是别的版本）
 *   - 都不满足 → inferred: null（页面上不显示版本，不编造）
 *
 * ## 为什么必须标 inferred
 * 这是**推断**：我们只知道「当前最新文件是什么时候发的」，不知道当时下载的是哪一个。
 * 标注出来，站点 tooltip 才能跟玩家说清楚，也方便以后真做了失效检测再纠正。
 *
 * 用法：
 *   node scripts/backfill-source-versions.mjs            # 回填并写盘
 *   node scripts/backfill-source-versions.mjs --dry       # 只统计，不写
 *   node scripts/backfill-source-versions.mjs --limit 50  # 只跑前 50 个（试水）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const CF_API = 'https://api.curseforge.com/v1'
const MR_API = 'https://api.modrinth.com/v2'
const STATE = 'research/tmp/backfill-versions.json'
const THIRTY_DAYS = 30 * 24 * 3600 * 1000

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}

/** 从 .env 读 key；**必须剥掉外层引号**（带引号直接发会 403 空体，踩过）。 */
function readKey(file, name) {
  if (!existsSync(file)) return ''
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = new RegExp(`^${name}=(.*)$`).exec(line.trim())
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return ''
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url, headers, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers })
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) return null
      return await res.json()
    } catch (e) {
      if (i === tries) return null
      await sleep(1000 * i)
    }
  }
  return null
}

/** 取某个包「当前最新上游文件」的 {fileId, fileName, fileDate}；取不到返回 null。 */
export async function latestFileOf({ platform, cfId, slug }, apiKey) {
  if (platform === 'mr' || (!cfId && platform !== 'cf')) {
    const ver = await getJson(`${MR_API}/project/${slug}/version?limit=1`)
    const v = Array.isArray(ver) ? ver[0] : null
    if (!v) return null
    return { fileId: null, fileName: v.files?.[0]?.filename ?? null, fileDate: v.date_published ?? null }
  }
  const body = await getJson(`${CF_API}/mods/${cfId}/files?pageSize=1`, { 'x-api-key': apiKey })
  const f = Array.isArray(body?.data) ? body.data[0] : null
  if (!f) return null
  return { fileId: Number.isFinite(f.id) ? f.id : null, fileName: f.fileName ?? null, fileDate: f.fileDate ?? null }
}

/** 该 slug 首次进 main 的时间（秒）；查不到返回 null。 */
export function firstCommitSeconds(slug) {
  try {
    const out = execFileSync('git', ['log', '--diff-filter=A', '--format=%ct', '--', `patches/${slug}/`], { encoding: 'utf8' }).trim()
    const lines = out.split(/\r?\n/).filter(Boolean).map(Number).filter(Number.isFinite)
    return lines.length ? Math.min(...lines) : null
  } catch { return null }
}

/** 判据：返回 'latest' 或 null。 */
export function decideInferred({ fileDate, firstSeen, now = Date.now() }) {
  if (!fileDate) return null
  const t = Date.parse(fileDate)
  if (!Number.isFinite(t)) return null
  if (firstSeen && t <= firstSeen * 1000) return 'latest'
  if (now - t > THIRTY_DAYS) return 'latest'
  return null
}

const dry = process.argv.includes('--dry')
const limit = Number(arg('limit', 0)) || 0
const apiKey = readKey('.env', 'CF_KEY')
if (!apiKey) { console.error('缺少 CF_KEY（.env）'); process.exit(1) }

const index = JSON.parse(readFileSync('research/index-dataset.json', 'utf8')).dataset
const bySlug = new Map(index.map((r) => [r.slug, r]))

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
let done = 0, wrote = 0, noHit = 0, skipped = 0, decided = 0
const slugs = readdirSync('patches').filter((s) => statSync(join('patches', s)).isDirectory())
const todo = slugs.filter((slug) => {
  const f = join('patches', slug, '.source.json')
  if (!existsSync(f)) return true
  try { return !JSON.parse(readFileSync(f, 'utf8')).fileDate } catch { return true }
})
console.log(`补丁 ${slugs.length} 个，需补 fileDate ${todo.length} 个`)

for (const slug of (limit ? todo.slice(0, limit) : todo)) {
  const row = bySlug.get(slug)
  if (!row) { skipped++; continue }
  let hit = state[slug]
  if (!hit) {
    hit = await latestFileOf({ platform: row.platform, cfId: row.cfId, slug }, apiKey)
    state[slug] = hit
    await sleep(220) // CF 免费额度有限，别打满
  }
  done++
  if (!hit) { noHit++; continue }
  const firstSeen = firstCommitSeconds(slug)
  const inferred = decideInferred({ fileDate: hit.fileDate, firstSeen })
  if (inferred) decided++
  const rec = {
    slug,
    platform: row.platform ?? null,
    fileId: hit.fileId ?? null,
    fileName: hit.fileName ?? null,
    fileDate: hit.fileDate ?? null,
    fetchedAt: firstSeen ? new Date(firstSeen * 1000).toISOString() : null,
    recovered: true,
    inferred,
  }
  if (!dry) writeFileSync(join('patches', slug, '.source.json'), JSON.stringify(rec, null, 2) + '\n')
  wrote++
  if (done % 50 === 0) {
    console.log(`  进度 ${done}/${todo.length}  写入 ${wrote}  判为 latest ${decided}`)
    if (!dry) writeFileSync(STATE, JSON.stringify(state, null, 1))
  }
}

if (!dry) writeFileSync(STATE, JSON.stringify(state, null, 1))
console.log(`完成：处理 ${done}，写入 ${wrote}，其中判定 inferred=latest ${decided}，取不到 ${noHit}，无 cfId 跳过 ${skipped}`)
if (dry) console.log('（--dry，未写盘）')
