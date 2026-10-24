#!/usr/bin/env node
/**
 * 生成跨平台身份归并表（方案 §3.1 / 决策 #6）。
 *
 * 产出三份文件：
 *   research/pack-identity.json              严格归并成功的组（≥2 个跨平台成员）
 *   research/pack-identity-needs-review.json 歧义/不满足条件的组（人工清单，本次不归并）
 *   worker/library-lookup.mjs                Worker 打包用的快照（slug→groupId、slug→当前版本）
 *
 * ## 严格归并口径（决策 #6，逐条拍板，不要放宽）
 *
 * 1. 按「规范化标题」分组：小写 + 去掉全部非字母数字字符。
 *    标题缺失（dataset 里 27733 条无 title，多为 no-quests 探测淘汰项）不参与分组。
 * 2. 组内**每个平台至多一个成员**、且**所有跨平台 pair 的 slug 相似度 ≥0.9**
 *    才自动归并。slug 相似度 = 最长公共子序列 / 较长 slug 长度（slug 先做同样规范化）。
 *    只要组内出现任一歧义（同平台多个 slug、或相似度不足），**整组**进 needs-review，
 *    绝不部分归并 —— 宁可漏归并由人工确认，不可错归并烧错包。
 * 3. 组 id（主 slug）选取：优先取「已在库」（research/source-versions.json 有记录）的
 *    成员；多候选时按 cf > mr、slug 字典序取第一个，保证结果确定。
 *
 * ## worker/library-lookup.mjs 为什么是 .mjs 而不是 .json
 *
 * worker/index.js 会被 node --test 直接 import（离线单测），Node 22 的 ESM 裸 import JSON
 * 需要 import attribute，而 wrangler(esbuild) 对 attribute 的支持版本不一。.mjs 导出常量
 * 两边都能吃，免去兼容坑。该文件由本脚本生成、随仓库提交；publish-local 第 8 步会重跑
 * 本脚本保持「已在库，当前版本 X」提示新鲜。
 *
 * 用法：
 *   node scripts/build-identity.mjs            # 产出三份文件
 *   npm run identity
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATASET_FILE = join(ROOT, 'research/index-dataset.json')
const VERSIONS_FILE = join(ROOT, 'research/source-versions.json')
const IDENTITY_FILE = join(ROOT, 'research/pack-identity.json')
const REVIEW_FILE = join(ROOT, 'research/pack-identity-needs-review.json')
const LOOKUP_FILE = join(ROOT, 'worker/library-lookup.mjs')

/** 平台优先序：组 id 候选排序用。 */
const PLATFORM_ORDER = { cf: 0, mr: 1 }

/** 规范化：小写 + 只留字母数字（标题与 slug 共用同一口径）。 */
export function normalizeKey(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 最长公共子序列长度（经典 O(n·m) 滚动数组）。 */
export function lcsLength(a, b) {
  if (!a || !b) return 0
  let prev = new Array(b.length + 1).fill(0)
  let cur = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const ca = a[i - 1]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = ca === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length]
}

/**
 * slug 相似度：LCS / 较长者。两侧先 normalizeKey（去分隔符差异）。
 * 空串返回 0（绝不把空 slug 判成相似）。
 */
export function slugSimilarity(a, b) {
  const na = normalizeKey(a)
  const nb = normalizeKey(b)
  if (!na || !nb) return 0
  return lcsLength(na, nb) / Math.max(na.length, nb.length)
}

export const SIMILARITY_THRESHOLD = 0.9

/**
 * 对一个「同规范化标题」的成员组做严格归并判定（纯函数）。
 *
 * @param {Array<{platform: string, slug: string, title: string}>} members
 * @param {Set<string>} librarySlugs 已在库的 slug 集合（组 id 优先取在库成员）
 * @returns {{ merged: object|null, review: object|null }}
 *   merged：{ id, title, members:[{platform,slug}] }（不归并时为 null）
 *   review：{ title, normalizedTitle, reason, members }（无歧义时为 null）
 */
export function mergeTitleGroup(members, librarySlugs = new Set()) {
  if (!Array.isArray(members) || members.length === 0) {
    return { merged: null, review: null }
  }
  const normalizedTitle = normalizeKey(members[0].title)
  const base = { title: members[0].title, normalizedTitle, members: members.map(({ platform, slug }) => ({ platform, slug })) }

  // 单成员：自成一组，无歧义，两边都不进。
  if (members.length === 1) return { merged: null, review: null }

  // 歧义一：同平台多个 slug —— 可能是同实体的重复收录，也可能真是两个包，人工定。
  const byPlat = {}
  for (const m of members) (byPlat[m.platform] ??= []).push(m)
  const dupPlatform = Object.entries(byPlat).find(([, list]) => list.length > 1)
  if (dupPlatform) {
    return { merged: null, review: { ...base, reason: `同名同平台（${dupPlatform[0]}）有 ${dupPlatform[1].length} 个 slug，无法自动判定同实体` } }
  }

  // 歧义二：跨平台 pair 里任何一个相似度不足 —— 严格口径整组不归并。
  const SIM = SIMILARITY_THRESHOLD
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const sim = slugSimilarity(members[i].slug, members[j].slug)
      if (sim < SIM) {
        return { merged: null, review: { ...base, reason: `跨平台 slug 相似度不足 ${SIM}（${members[i].slug} vs ${members[j].slug} = ${sim.toFixed(3)}）` } }
      }
    }
  }

  // 全部通过：选主 slug。优先在库成员，再按平台序、slug 字典序。
  const sorted = [...members].sort((a, b) => {
    const libA = librarySlugs.has(a.slug) ? 0 : 1
    const libB = librarySlugs.has(b.slug) ? 0 : 1
    if (libA !== libB) return libA - libB
    const pA = PLATFORM_ORDER[a.platform] ?? 99
    const pB = PLATFORM_ORDER[b.platform] ?? 99
    if (pA !== pB) return pA - pB
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  })
  const primary = sorted[0]
  return {
    merged: { id: primary.slug, title: primary.title, members: members.map(({ platform, slug }) => ({ platform, slug })) },
    review: null,
  }
}

/**
 * 对全部 dataset 条目分组并归并（纯函数，便于单测）。
 *
 * @param {Array<{slug: string, platform: string, title: string|null}>} entries
 * @param {Set<string>} librarySlugs
 * @returns {{ groups: object[], needsReview: object[], stats: object }}
 */
export function buildIdentity(entries, librarySlugs = new Set()) {
  const byTitle = new Map()
  let noTitle = 0
  for (const e of entries || []) {
    const key = normalizeKey(e.title)
    if (!key) { noTitle++; continue }
    if (!byTitle.has(key)) byTitle.set(key, [])
    byTitle.get(key).push({ slug: e.slug, platform: e.platform, title: e.title })
  }

  const groups = []
  const needsReview = []
  let singletons = 0
  for (const key of [...byTitle.keys()].sort()) {
    const members = byTitle.get(key)
    const { merged, review } = mergeTitleGroup(members, librarySlugs)
    if (merged) groups.push(merged)
    else if (review) needsReview.push(review)
    else singletons++
  }
  return {
    groups,
    needsReview,
    stats: { entries: entries.length, titled: entries.length - noTitle, titleGroups: byTitle.size, merged: groups.length, needsReview: needsReview.length, singletons },
  }
}

/**
 * 生成 worker/library-lookup.mjs 的内容（纯函数）。
 * groupBySlug：出现在归并组里的 slug + 全部在库 slug → groupId（无组 slug 即自身）。
 * versionBySlug：在库 slug → 当前 fileName（无版本记录的 slug 不出现）。
 */
export function buildLookup(groups, versions) {
  const groupBySlug = {}
  for (const g of groups || []) {
    for (const m of g.members) groupBySlug[m.slug] = g.id
  }
  const versionBySlug = {}
  for (const [slug, v] of Object.entries(versions || {})) {
    if (!groupBySlug[slug]) groupBySlug[slug] = slug
    if (v && typeof v.fileName === 'string' && v.fileName) versionBySlug[slug] = v.fileName
  }
  return { groupBySlug, versionBySlug }
}

function main() {
  const dataset = JSON.parse(readFileSync(DATASET_FILE, 'utf8'))
  const entries = Array.isArray(dataset.dataset) ? dataset.dataset : []
  let librarySlugs = new Set()
  let versions = {}
  try {
    versions = JSON.parse(readFileSync(VERSIONS_FILE, 'utf8')).versions ?? {}
    librarySlugs = new Set(Object.keys(versions))
  } catch {
    console.warn('⚠ 读不到 source-versions.json，按「无在库成员」处理')
  }

  const { groups, needsReview, stats } = buildIdentity(entries, librarySlugs)
  const generatedAt = new Date().toISOString()

  // 内容（不含 generatedAt）没变就不重写：publish 每轮都会跑本脚本，
  // 重写时间戳会让每次发布都带一份假 diff。
  const writeIfChanged = (file, doc) => {
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'))
      const { generatedAt: _drop, ...rest } = prev
      if (JSON.stringify(rest) === JSON.stringify(doc)) return false
    } catch { /* 不存在/损坏 → 重写 */ }
    writeFileSync(file, JSON.stringify({ ...doc, generatedAt }, null, 2) + '\n')
    return true
  }
  const w1 = writeIfChanged(IDENTITY_FILE, { groups })
  const w2 = writeIfChanged(REVIEW_FILE, { count: needsReview.length, groups: needsReview })

  const lookup = buildLookup(groups, versions)
  const banner = '// 自动生成：node scripts/build-identity.mjs —— 请勿手改。\n'
    + `// 生成时间 ${generatedAt}；Worker 提交响应用它带出 groupId 与库内当前版本。\n`
  const lookupBody = banner + 'export const LOOKUP = ' + JSON.stringify(lookup) + '\n'
  let w3 = true
  try {
    w3 = readFileSync(LOOKUP_FILE, 'utf8') !== lookupBody
  } catch { /* 不存在 → 写 */ }
  if (w3) writeFileSync(LOOKUP_FILE, lookupBody)

  console.log(`标题分组 ${stats.titleGroups}（有标题 ${stats.titled}/${stats.entries}）：`
    + ` 自动归并 ${stats.merged} 组，待人工 ${stats.needsReview} 组，单成员 ${stats.singletons} 组`)
  console.log(`→ ${IDENTITY_FILE}${w1 ? '' : '（未变）'}`)
  console.log(`→ ${REVIEW_FILE}${w2 ? '' : '（未变）'}`)
  console.log(`→ ${LOOKUP_FILE}${w3 ? '' : '（未变）'}（groupBySlug ${Object.keys(lookup.groupBySlug).length}，versionBySlug ${Object.keys(lookup.versionBySlug).length}）`)
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main()
