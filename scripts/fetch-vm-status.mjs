#!/usr/bin/env node
/**
 * 抓取 VM 汉化组官网的整合包维护状态与适配版本（工单 03）。
 *
 * 官网是 SPA：`/modpacks/` 的 HTML 里没有数据，数据在前端 bundle 里。
 * 抓取链路固定为三段，任何一段结构变化都直接报错，不做猜测：
 *   /modpacks/  →  /assets/index-<hash>.js  →  /assets/_virtual_resources-<hash>.js
 * 数据块里有两个数组：整合包（link 以 /modpacks/ 开头）与地图（link 以 /map/ 开头）。
 *
 * 设计约束（见工单 03 验收契约）：
 *   - 解析是纯函数：给一段 bundle 文本，返回结构化条目数组；不联网、不读盘。
 *   - status 只认 stopped / maintaining / translating；其它值原样保留并标记
 *     `recognized: false` + note，绝不丢弃、绝不改写成猜测值。
 *   - 字段缺失一律为 null，不用空字符串或猜测值填充。
 *   - 原始响应缓存到本地（默认 research/tmp/），`--offline` 时只读缓存。
 *
 * 用法：
 *   node scripts/fetch-vm-status.mjs
 *   node scripts/fetch-vm-status.mjs --in research/build-input.json \
 *     --out research/vm-status.json --cache research/tmp
 *   node scripts/fetch-vm-status.mjs --offline
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const PAGE_URL = 'https://vmct-cn.top/modpacks/'
export const KNOWN_STATUS = ['stopped', 'maintaining', 'translating']
export const PACK_LINK_PREFIX = '/modpacks/'
const KNOWN = new Set(KNOWN_STATUS)

// ---------- 字面量扫描 ----------
// bundle 是压缩过的 JS，条目是对象字面量。这里不做通用 JS 解析，只做够用的扫描：
// 认得 ' " ` 三种字符串（含反斜杠转义）与花括号配对。
// 已知边界：模板字符串里的 `${...}` 不单独展开——官网数据块里没有插值（实测 0 处），
// 一旦出现插值，`${` 与 `}` 仍然配对，扫描结果不受影响。

function skipString(text, i) {
  const quote = text[i]
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j]
    if (ch === '\\') { j++; continue }
    if (ch === quote) return j
  }
  return text.length - 1
}

/** 从 `{` 开始，返回配对 `}` 的下标；不配对返回 -1。 */
function readObjectSpan(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '`' || ch === '"' || ch === "'") { i = skipString(text, i); continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 收集文本里所有顶层对象字面量的原文（嵌套对象被跳过）。 */
function collectObjects(text) {
  const spans = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '`' || ch === '"' || ch === "'") { i = skipString(text, i); continue }
    if (ch === '{') {
      const end = readObjectSpan(text, i)
      if (end < 0) break
      spans.push(text.slice(i, end + 1))
      i = end
    }
  }
  return spans
}

function unescapeString(raw) {
  return raw.replace(/\\(.)/g, '$1')
}

/** 读取 `key: value` 的 value；字段不存在时 present=false。 */
function readValue(body, key) {
  const re = new RegExp(`(?:^|[{,])\\s*${key}\\s*:\\s*`)
  const m = re.exec(body)
  if (!m) return { present: false, value: null }
  const i = m.index + m[0].length
  const ch = body[i]
  if (ch === '`' || ch === '"' || ch === "'") {
    const end = skipString(body, i)
    return { present: true, value: unescapeString(body.slice(i + 1, end)) }
  }
  const token = (/^[^,}]*/.exec(body.slice(i))?.[0] || '').trim()
  if (token === '!0' || token === 'true') return { present: true, value: true }
  if (token === '!1' || token === 'false') return { present: true, value: false }
  if (token === 'null' || token === 'undefined' || token === 'void 0') return { present: true, value: null }
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(token)) return { present: true, value: Number(token) }
  // 无法识别的表达式：不当猜测，记为缺失
  return { present: true, value: null }
}

/** 读取 `key: {...}` 的嵌套对象原文；不存在返回 null。 */
function readNestedObject(body, key) {
  const re = new RegExp(`(?:^|[{,])\\s*${key}\\s*:\\s*\\{`)
  const m = re.exec(body)
  if (!m) return null
  const open = m.index + m[0].length - 1
  const end = readObjectSpan(body, open)
  return end < 0 ? null : body.slice(open, end + 1)
}

// ---------- 解析（纯函数） ----------

/**
 * 从 bundle 文本里解析整合包条目。地图条目（link 以 /map/ 开头）不进入结果。
 * @param {string} bundleText
 * @param {{sourceUrl?:string, fetchedAt?:string|null}} opts
 * @returns {Array<object>}
 */
export function parseVmEntries(bundleText, { sourceUrl = PAGE_URL, fetchedAt = null } = {}) {
  const entries = []
  for (const body of collectObjects(String(bundleText || ''))) {
    const link = readValue(body, 'link')
    if (!link.present || typeof link.value !== 'string') continue
    if (!link.value.startsWith(PACK_LINK_PREFIX)) continue

    const notes = []
    const name = readValue(body, 'name').value
    const originalName = readValue(body, 'originalName').value
    const author = readValue(body, 'author').value
    const displayDate = readValue(body, 'displayDate').value
    const featured = readValue(body, 'featured').value

    const statusBody = readNestedObject(body, 'status')
    let status = null
    if (statusBody === null) {
      notes.push('status-missing')
    } else {
      const type = readValue(statusBody, 'type').value
      if (type === null) notes.push('status.type-missing')
      else if (!KNOWN.has(type)) notes.push(`unknown-status:${type}`)
      status = { type, recognized: typeof type === 'string' && KNOWN.has(type) }
    }

    const versionsBody = readNestedObject(body, 'versions')
    let versions = null
    if (versionsBody === null) {
      notes.push('versions-missing')
    } else {
      versions = {
        loader: readValue(versionsBody, 'loader').value,
        mc: readValue(versionsBody, 'mc').value,
        pack: readValue(versionsBody, 'pack').value,
      }
      for (const [k, v] of Object.entries(versions)) {
        if (v === null) notes.push(`versions.${k}-missing`)
      }
    }

    entries.push({
      vmSlug: link.value.slice(PACK_LINK_PREFIX.length),
      link: link.value,
      name,
      originalName,
      author,
      displayDate,
      featured,
      status,
      versions,
      sourceUrl,
      fetchedAt,
      notes,
    })
  }
  return entries
}

/**
 * 官网 slug 漂移：`rad/index` → `rad`、`sb4/index` → `sb4`。
 * 旧口径把 wiki 页路径（`/index`、`/secret`）当成了条目 slug，官网现在只保留整合包本体 slug。
 * 剥掉末尾 `/index` 后**全等**才算同一包；不做包含匹配、不猜。
 */
export function aliasSlug(vmSlug) {
  return typeof vmSlug === 'string' && vmSlug.endsWith('/index') ? vmSlug.slice(0, -'/index'.length) : null
}

/**
 * 按 build-input 的 vmSlug 顺序对齐；官网多出的条目排在后面并标记 inBuildInput=false。
 * 官网缺失的条目也保留（status/versions 为 null），不静默丢行。
 * slug 漂移的配对会在 notes 里留下 `slug-alias:` 记录，可复核。
 */
export function alignEntries(entries, vmEntries, { sourceUrl = PAGE_URL, fetchedAt = null } = {}) {
  const bySlug = new Map(entries.map(e => [e.vmSlug, e]))
  const ordered = []
  const seen = new Set()
  const aliased = []

  for (const v of vmEntries) {
    let hit = bySlug.get(v.vmSlug)
    let aliasNote = null
    if (!hit) {
      const alias = aliasSlug(v.vmSlug)
      const candidate = alias ? bySlug.get(alias) : null
      // 剥后缀只是产生候选；还必须 originalName 逐字相同才算同一个包
      if (candidate && candidate.originalName && candidate.originalName === v.originalName) {
        hit = candidate
        aliasNote = `slug-alias:${v.vmSlug}→${alias}`
        aliased.push({ from: v.vmSlug, to: alias, why: 'originalName 逐字相同' })
      }
    }
    if (hit) {
      ordered.push({
        ...hit,
        inBuildInput: true,
        buildInputOriginalName: v.originalName,
        buildInputSlug: v.vmSlug,
        notes: aliasNote ? [...hit.notes, aliasNote] : hit.notes,
      })
      seen.add(hit.vmSlug)
    } else {
      ordered.push({
        vmSlug: v.vmSlug,
        link: null,
        name: null,
        originalName: null,
        author: null,
        displayDate: null,
        featured: null,
        status: null,
        versions: null,
        sourceUrl,
        fetchedAt,
        notes: ['missing-on-site'],
        inBuildInput: true,
        buildInputOriginalName: v.originalName,
        buildInputSlug: v.vmSlug,
      })
    }
  }

  for (const e of entries) {
    if (seen.has(e.vmSlug)) continue
    ordered.push({ ...e, inBuildInput: false, buildInputOriginalName: null, buildInputSlug: null, notes: [...e.notes, 'not-in-build-input'] })
  }

  return {
    entries: ordered,
    slugAliases: aliased,
    onlyInBuildInput: ordered.filter(e => e.inBuildInput && e.link === null).map(e => e.vmSlug),
    onlyOnSite: ordered.filter(e => !e.inBuildInput).map(e => e.vmSlug),
  }
}

export function summarize(entries) {
  const status = { stopped: 0, maintaining: 0, translating: 0, unknown: 0, missing: 0 }
  for (const e of entries) {
    if (!e.status || e.status.type === null) status.missing++
    else if (KNOWN.has(e.status.type)) status[e.status.type]++
    else status.unknown++
  }
  return {
    total: entries.length,
    status,
    missingVersions: entries.filter(e => !e.versions || e.versions.loader === null || e.versions.mc === null || e.versions.pack === null).length,
    withNotes: entries.filter(e => e.notes.length > 0).length,
  }
}

/**
 * 组装落盘对象。
 * source: live = 本次联网；cache = 读本地缓存；unavailable = 两者都拿不到。
 */
export function buildStatusFile({ entries, vmEntries, source, fetchedAt, dataUrl = null, unavailableReason = null, droppedVmEntries = null }) {
  const aligned = alignEntries(entries, vmEntries, { fetchedAt })
  const stat = summarize(aligned.entries)
  return {
    note: 'VM 官网整合包状态与适配版本（工单 03）。由 scripts/fetch-vm-status.mjs 生成，不要手改。',
    source,
    sourceUrl: PAGE_URL,
    dataUrl,
    fetchedAt,
    unavailableReason,
    statusValues: KNOWN_STATUS,
    stat: {
      siteEntries: entries.length,
      buildInputEntries: vmEntries.length,
      matched: aligned.entries.filter(e => e.inBuildInput && e.link !== null).length,
      ...stat,
    },
    alignment: {
      buildInputEntries: vmEntries.length,
      siteEntries: entries.length,
      slugAliases: aligned.slugAliases,
      onlyInBuildInput: aligned.onlyInBuildInput,
      onlyOnSite: aligned.onlyOnSite,
      // research/vm-packs.json 的 71 条与 build-input 的 58 条之差，见 build-input 的 droppedVmEntries
      vmPacksDifference: droppedVmEntries,
    },
    entries: aligned.entries,
  }
}

// ---------- 抓取 ----------

const UA = { 'User-Agent': 'modpack-i18n-site/0.1 (+https://vmct-cn.top/modpacks/)' }

async function download(url, timeoutMs) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return await res.text()
}

const CACHE_FILES = { page: 'vm-page.html', index: 'vm-index.js', data: 'vm-resources.js' }

function resolveUrl(from, ref) {
  return new URL(ref, from).href
}

/**
 * 取得数据块文本。
 * 联网成功时把三段响应都写进 cacheDir；offline 时只读缓存。
 */
export async function fetchVmData({ cacheDir = 'research/tmp', offline = false, timeoutMs = 30000 } = {}) {
  const paths = Object.fromEntries(Object.entries(CACHE_FILES).map(([k, f]) => [k, join(cacheDir, f)]))
  mkdirSync(cacheDir, { recursive: true })

  if (offline) {
    for (const p of Object.values(paths)) {
      if (!existsSync(p)) throw new Error(`离线模式缺少缓存文件：${p}`)
    }
    const dataUrl = readDataUrlMarker(paths)
    return { text: readFileSync(paths.data, 'utf8'), dataUrl, pageUrl: PAGE_URL, source: 'cache' }
  }

  const page = await download(PAGE_URL, timeoutMs)
  writeFileSync(paths.page, page)
  const scriptSrc = /<script[^>]+src="([^"]*\/assets\/index-[^"]+\.js)"/.exec(page)?.[1]
  if (!scriptSrc) throw new Error('页面结构变化：未在 /modpacks/ HTML 里找到 /assets/index-*.js')

  const indexUrl = resolveUrl(PAGE_URL, scriptSrc)
  const index = await download(indexUrl, timeoutMs)
  writeFileSync(paths.index, index)
  const dataRef = /assets\/(_virtual_resources-[A-Za-z0-9_-]+\.js)/.exec(index)?.[1]
  if (!dataRef) throw new Error('页面结构变化：index bundle 里没有 _virtual_resources-*.js 引用')

  const dataUrl = resolveUrl(PAGE_URL, `/assets/${dataRef}`)
  const text = await download(dataUrl, timeoutMs)
  writeFileSync(paths.data, text)
  writeFileSync(`${paths.data}.url`, `${dataUrl}\n`)
  if (!text.includes(`link:\`${PACK_LINK_PREFIX}`)) {
    throw new Error('页面结构变化：数据块里找不到 link:`/modpacks/…` 条目')
  }
  return { text, dataUrl, pageUrl: PAGE_URL, source: 'live' }
}

function readDataUrlMarker(paths) {
  const marker = `${paths.data}.url`
  return existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null
}

// ---------- CLI ----------

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())

if (isMain) {
  const args = process.argv.slice(2)
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback
  }
  const inPath = opt('in', 'research/build-input.json')
  const outPath = opt('out', 'research/vm-status.json')
  const cacheDir = opt('cache', 'research/tmp')
  const offline = args.includes('--offline')

  const input = JSON.parse(readFileSync(inPath, 'utf8'))
  const fetchedAt = new Date().toISOString()

  let payload
  try {
    const data = await fetchVmData({ cacheDir, offline })
    const entries = parseVmEntries(data.text, { sourceUrl: PAGE_URL, fetchedAt })
    if (entries.length === 0) throw new Error('解析结果为 0 条：数据块结构可能已变化')
    payload = buildStatusFile({
      entries, vmEntries: input.vmEntries, source: data.source, fetchedAt,
      dataUrl: data.dataUrl, droppedVmEntries: input.droppedVmEntries ?? null,
    })
  } catch (err) {
    payload = buildStatusFile({
      entries: [], vmEntries: input.vmEntries, source: 'unavailable', fetchedAt,
      dataUrl: null, unavailableReason: String(err?.message || err),
      droppedVmEntries: input.droppedVmEntries ?? null,
    })
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n')
    console.error(`✗ 抓取失败：${payload.unavailableReason}`)
    console.error(`  已写出 ${outPath}（source: unavailable，未填充任何数据）`)
    process.exit(1)
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n')
  const s = payload.stat
  console.log(`→ ${outPath}（source: ${payload.source}）`)
  console.log(`  官网 ${s.siteEntries} 条 | 对齐 build-input ${s.buildInputEntries} 条 | 命中 ${s.matched}`)
  console.log(`  status: stopped ${s.status.stopped} / maintaining ${s.status.maintaining} / translating ${s.status.translating} / 未知 ${s.status.unknown} / 缺失 ${s.status.missing}`)
  if (payload.alignment.slugAliases.length) console.log(`  slug 漂移: ${payload.alignment.slugAliases.map(a => `${a.from}→${a.to}`).join(', ')}`)
  if (payload.alignment.onlyInBuildInput.length) console.log(`  官网缺失: ${payload.alignment.onlyInBuildInput.join(', ')}`)
  if (payload.alignment.onlyOnSite.length) console.log(`  官网多出: ${payload.alignment.onlyOnSite.join(', ')}`)
}
