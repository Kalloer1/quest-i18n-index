#!/usr/bin/env node
/**
 * 给 `patches/<slug>/.source.json` 补「可信版本」字段，供 `release.mjs` 命名 zip。
 *
 * ## 为什么需要
 * 现在 zip 名里的版本只从 `fileName` 猜（`versionFromSource`）。猜错的两种实证：
 *   - `NeoTech Reborn.zip` —— 作者把 fileName 写死，三个版本共用同名，猜不出东西，
 *     只能退化成 fileDate（`_v20261018`）；
 *   - `Better MC [FORGE] 1.16.5 v62.zip` —— 名字里唯一的点号版本是 **Minecraft**
 *     版本，猜出来 `1.16.5`，而作者版本是 `v62`。
 * 本脚本把「作者填过的版本」落到 `.source.json` 的 `version` 上，`release.mjs` 优先用它。
 *
 * ## 提取优先级（顺序即可信度）
 * 1. `source.version` 已存在 → 跳过整条（幂等；`--force` 才重算）。
 * 2. Modrinth：`version_number`（`v30` / `1.2`）——作者填的版本号，恒优先。
 * 3. CurseForge：名字里最后一个含点号的版本串（复用 `release.mjs` 的
 *    `extractVersionToken`，不复制规则），在 `displayName` 与 `fileName` 之间挑：
 *    两者冲突且其中一个是纯 MC 版本时选另一个（`LITV2 - 1.38 [MC1.16.5]` 的
 *    displayName 会把 1.16.5 当版本，而 fileName 的 `1.16.5-1.38` 剥前缀后是 1.38）。
 * 4. 条件核实（用户裁决：老包直接信任，近期才核实）：
 *    - `now - fileDate > 30 天` → 不读包内 manifest，直接用 2/3 的结果；
 *      2/3 都提不出 → 用 `fileDate` 的 `YYYYMMDD`，`versionSource: "fileDate"`。
 *    - `now - fileDate <= 30 天` 且（2/3 提不出 **或** `fileName` 里根本没有版本
 *      **或** `displayName` 与 `fileName` 解出的版本不一致）→ 读包内 manifest 核实：
 *      CF 取根 `manifest.json` 的 `version`，MR 取 `modrinth.index.json` 的 `versionId`。
 *      「`fileName` 没有版本」单列一条：`NeoTech Reborn.zip` 这种作者写死同名的包，
 *      只有 displayName 能猜，正该核实一次。
 *      **例外（与新旧无关）**：3 猜出来的值明显是 Minecraft 版本、而名字尾巴上还有
 *      `vNN`（`trailingBuildTag`）时，这条猜测**已知是错的字段**，老包也去读 manifest
 *      ——否则 `Better MC ... 1.16.5 v62` 永远停在 1.16.5。
 * 5. manifest 也取不到 → 回退 3，再回退 4 的日期，`confirmed: false`。
 *
 * ## 字段语义
 *   displayName   上游展示名（MR 用版本条目的 `name`；取不到为 null）
 *   version       版本串原样保留（`v62`、`1.5.6.0`、`2026-10-12-testing` 都容纳），
 *                 只做文件名非法字符清洗（`sanitizeVersion`）
 *   versionSource `modrinth-version` | `manifest` | `displayName` | `fileDate`
 *   confirmed     版本来自作者填写/权威字段（modrinth-version / manifest）才为 true；
 *                 从名字或日期推出来的都是 false
 *   verifiedAt    本次核实时间（ISO 8601）
 *
 * ## 稳健性
 *   - 断点续跑：结果落 `research/tmp/enrich-versions.json`，重跑直接复用，不打网络。
 *   - 单个包失败不中断整轮，最后打印失败清单（失败的 slug 不写盘、也不进缓存，下次重试）。
 *
 * 用法：
 *   node scripts/enrich-source-versions.mjs               # 补齐全部
 *   node scripts/enrich-source-versions.mjs --limit 20    # 只跑 20 个（试水）
 *   node scripts/enrich-source-versions.mjs --dry         # 只统计，不写盘
 *   node scripts/enrich-source-versions.mjs --force       # 忽略已有 version / 缓存，重算
 *   node scripts/enrich-source-versions.mjs --deep        # 老包提不出名字版本时也读 manifest
 *   node scripts/enrich-source-versions.mjs --only a,b    # 只跑指定 slug
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { extractVersionToken, sanitizeVersion, trailingBuildTag } from './release.mjs'
import { fetchZipTexts } from './lib/zip-range.mjs'

const CF_API = 'https://api.curseforge.com/v1'
const MR_API = 'https://api.modrinth.com/v2'
/** Modrinth 强制要求 UA，缺了 400/403（见 lib/modrinth.mjs）。 */
const MR_UA = 'quest-i18n/1.0'
const STATE = 'research/tmp/enrich-versions.json'
const THIRTY_DAYS = 30 * 24 * 3600 * 1000

/** `1.20.1` 这种「只有 Minecraft 版本」的形态，用于识别猜错字段。 */
const MC_VERSION = /^1\.\d+(?:\.\d+)?$/

// ---------- CLI ----------

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}

const dry = process.argv.includes('--dry')
const force = process.argv.includes('--force')
/** `--deep`：连「老包」也在提不出任何名字版本时读一次包内 manifest（默认按 30 天规则跳过）。 */
const deep = process.argv.includes('--deep')
const limit = Number(arg('limit', 0)) || 0
/** `--only a,b` 只跑指定 slug（排查 / 重试单个包时用）。 */
const only = typeof arg('only', '') === 'string'
  ? String(arg('only', '')).split(',').map((s) => s.trim()).filter(Boolean)
  : []

// ---------- HTTP ----------

/**
 * 从 .env 读 key；**必须剥掉外层引号**（带引号直接发会 403 空体，踩过）。
 * @param {string} file
 * @param {string} name
 */
export function readKey(file, name) {
  if (!existsSync(file)) return ''
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = new RegExp(`^${name}=(.*)$`).exec(line.trim())
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return ''
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * GET JSON，429 / 5xx / 网络错误重试（退避 1s、2s），4xx 直接给 null。
 * 与 `backfill-source-versions.mjs` 的 `getJson` 同口径。
 */
async function getJson(url, headers = {}, tries = 3) {
  let lastErr = ''
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers })
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) return null
      return await res.json()
    } catch (e) {
      lastErr = e?.message ?? String(e)
      if (i === tries) break
      await sleep(1000 * i)
    }
  }
  throw new Error(lastErr || 'fetch failed')
}

/**
 * CF 的 `downloadUrl` 常指向 `edge.forgecdn.net`，它会 302 到
 * `mediafilez.forgecdn.net`；后者在部分网络下不可达（实测 CONNECT 502）。
 * `mediafiles.forgecdn.net` 是同一份对象的可达域名且支持 Range —— 换主机名，
 * 路径（含签名/编码）一字不改。
 */
export function normalizeCdnUrl(url) {
  try {
    const u = new URL(url)
    if (/(^|\.)forgecdn\.net$/i.test(u.hostname)) u.hostname = 'mediafiles.forgecdn.net'
    return u.toString()
  } catch {
    return url
  }
}

// ---------- 上游元数据 ----------

/**
 * 取上游「我们交付的那个文件」的元数据。
 *
 * CF 优先用 `fileId` 精确取（`/mods/{cfId}/files/{fileId}`）：`.source.json` 记的就是
 * 交付时的那个文件，取「最新文件」可能已经漂到新版本，会把版本号认错。
 * 没有 fileId / 精确端点 404 时才退回 `files?pageSize=1`。
 *
 * @returns {Promise<{displayName: string|null, fileName: string|null, fileDate: string|null,
 *   versionNumber: string|null, url: string|null}>}
 */
async function fetchCfMeta(cfId, fileId, apiKey) {
  const headers = { 'x-api-key': apiKey }
  if (fileId) {
    const body = await getJson(`${CF_API}/mods/${cfId}/files/${fileId}`, headers)
    const f = body?.data
    if (f) return cfRow(f)
    await sleep(200)
  }
  const body = await getJson(`${CF_API}/mods/${cfId}/files?pageSize=1`, headers)
  const f = Array.isArray(body?.data) ? body.data[0] : null
  if (!f) throw new Error('CF 文件列表为空')
  return cfRow(f)
}

function cfRow(f) {
  return {
    displayName: typeof f.displayName === 'string' ? f.displayName : null,
    fileName: typeof f.fileName === 'string' ? f.fileName : null,
    fileDate: typeof f.fileDate === 'string' ? f.fileDate : null,
    versionNumber: null,
    url: typeof f.downloadUrl === 'string' && f.downloadUrl.trim() ? f.downloadUrl.trim() : null,
  }
}

async function fetchMrMeta(slug) {
  const list = await getJson(`${MR_API}/project/${encodeURIComponent(slug)}/version?limit=1`, {
    'User-Agent': MR_UA,
  })
  const v = Array.isArray(list) ? list[0] : null
  if (!v) throw new Error('Modrinth 没有版本')
  const file = Array.isArray(v.files) ? v.files[0] : null
  return {
    // Modrinth 没有 CF 的 displayName；版本条目的 name 是作者写的标题，同义。
    displayName: typeof v.name === 'string' ? v.name : null,
    fileName: typeof file?.filename === 'string' ? file.filename : null,
    fileDate: typeof v.date_published === 'string' ? v.date_published : null,
    versionNumber: v.version_number == null ? null : String(v.version_number),
    url: typeof file?.url === 'string' ? file.url : null,
  }
}

// ---------- 包内 manifest ----------

/** zip-range 失败（CDN 抖动 / 429）重试两次，仍失败返回 null，由调用方回退。 */
async function readZipTextSafe(url, filter) {
  for (let i = 1; i <= 3; i++) {
    try {
      const out = await fetchZipTexts(url, { filter })
      return out.length ? out[0] : null
    } catch (e) {
      if (i === 3) return null
      await sleep(800 * i)
    }
  }
  return null
}

/** CF：根 `manifest.json` 的 `version`（作者填，可能是空串或 `v62`）。 */
async function readCfManifestVersion(url) {
  if (!url) return null
  const hit = await readZipTextSafe(normalizeCdnUrl(url), (n) => /^manifest\.json$/i.test(n))
  if (!hit) return null
  try {
    const version = JSON.parse(hit.text)?.version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/** MR：`modrinth.index.json` 的 `versionId`（与 API 的 version_number 同值）。 */
async function readMrManifestVersion(url) {
  if (!url) return null
  const hit = await readZipTextSafe(url, (n) => n === 'modrinth.index.json')
  if (!hit) return null
  try {
    const version = JSON.parse(hit.text)?.versionId
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

// ---------- 判定（纯函数部分） ----------

/** `fileDate` → `YYYYMMDD`；取不到返回 null。 */
export function dateVersion(fileDate) {
  const digits = String(fileDate ?? '').replace(/\D/g, '')
  if (!digits) return null
  return digits.length > 8 ? digits.slice(0, 8) : digits
}

/** 距离 fileDate 是否超过 30 天（日期不可解析时按「老包」处理，不额外打网络）。 */
export function isStale(fileDate, now = Date.now()) {
  const t = Date.parse(fileDate ?? '')
  if (!Number.isFinite(t)) return true
  return now - t > THIRTY_DAYS
}

/**
 * 从两个上游名字里挑一个版本，并记下它来自哪个字段。
 *
 * 为什么不是「displayName 优先」就完事：实测大量包把 MC 版本追加在末尾
 * （`LITV2 - 1.38 [MC1.16.5]`、`EARTH - v12.9 - MC 1.21`），而提取器取的是
 * **最后一个**含点号 token，于是落在 MC 版本上。同一批包的 `fileName` 写成
 * `<MC>-<包版本>`（`LITV2-1.16.5-1.38.zip`），剥掉 MC 前缀后正是包版本。
 * 所以两者都在时优先**不是 MC 版本**的那个；都不是 / 都是时仍按 displayName 优先。
 *
 * @param {string|null} displayName
 * @param {string|null} fileName
 * @returns {{version: string|null, source: 'displayName'|'fileName'|null}}
 */
export function pickNameGuess(displayName, fileName) {
  const d = extractVersionToken(displayName)
  const f = extractVersionToken(fileName)
  if (!d) return { version: f, source: f ? 'fileName' : null }
  if (!f) return { version: d, source: 'displayName' }
  if (MC_VERSION.test(d) && !MC_VERSION.test(f)) return { version: f, source: 'fileName' }
  return { version: d, source: 'displayName' }
}

/**
 * 决定要不要读包内 manifest（返回的 `need` 已把 30 天规则算进去）。
 *
 * @param {{platform: string, guess: string|null, displayGuess?: string|null,
 *   fileGuess?: string|null, displayName: string|null, fileDate: string|null}} meta
 * @param {number} now
 * @returns {{need: boolean, because: string}}
 */
export function shouldVerify(meta, now = Date.now(), { deep = false } = {}) {
  const guess = meta.guess
  const stale = isStale(meta.fileDate, now)
  const displayGuess = meta.displayGuess ?? extractVersionToken(meta.displayName)
  const fileGuess = meta.fileGuess ?? extractVersionToken(meta.fileName)

  // ① 猜到了但明显是 Minecraft 版本（尾巴上还有 vNN）：这条猜测**已知错字段**，
  //    与新旧无关，必须核实——否则 `1.16.5 v62` 永远停在 1.16.5。
  if (guess && meta.platform === 'cf' && MC_VERSION.test(guess) && trailingBuildTag(meta.displayName)) {
    return { need: true, because: 'mc-version' }
  }
  // ② 提不出：近期才去包内找，老包按用户裁决直接用 fileDate，不打网络。
  //    `--deep` 打破这条（日期不是版本，一次 Range 就能换成作者填的值）。
  if (!guess) return { need: deep || !stale, because: stale ? '老包提不出→fileDate' : '提不出' }
  // ③ fileName 干脆不带版本（NeoTech Reborn 那种写死同名）⇒ 与 displayName 对不上。
  if (meta.platform === 'cf' && !fileGuess) {
    return { need: !stale, because: stale ? '老包 fileName 无版本→信任 displayName' : 'fileName 无版本' }
  }
  // ④ displayName 与 fileName 解出的版本不一致。
  if (displayGuess && fileGuess && displayGuess !== fileGuess) {
    return { need: !stale, because: stale ? '老包名字不一致→信任名字' : 'name-mismatch' }
  }
  return { need: false, because: stale ? '老包且一致' : '近期且一致' }
}

// ---------- 主流程 ----------

function loadCfIds() {
  try {
    const rows = JSON.parse(readFileSync('research/index-dataset.json', 'utf8')).dataset ?? []
    return new Map(rows.filter((r) => r?.slug && r?.cfId).map((r) => [r.slug, String(r.cfId)]))
  } catch {
    return new Map()
  }
}

async function main() {
  const apiKey = readKey('.env', 'CF_KEY')
  if (!apiKey) {
    console.error('缺少 CF_KEY（.env）')
    process.exit(1)
  }

  const slugs = readdirSync('patches')
    .filter((s) => !s.startsWith('.') && statSync(join('patches', s)).isDirectory())
    .sort()
  const cfIds = loadCfIds()
  // 缓存始终读入：`--force` 只是忽略每个 slug 的旧结果，不能把别的 slug 的缓存冲掉
  // （否则一次「只重算 47 个」会把另外 613 个的断点记录清空）。
  const cache = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}

  const now = Date.now()
  const verifiedAt = new Date(now).toISOString()
  let done = 0, written = 0, skipped = 0, manifests = 0, dated = 0, confirmed = 0
  const failures = []

  const pending = slugs.filter((slug) => {
    if (only.length && !only.includes(slug)) return false
    if (force) return true
    const file = join('patches', slug, '.source.json')
    if (!existsSync(file)) return false
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return !raw.version
    } catch {
      return false
    }
  })
  const todo = limit ? pending.slice(0, limit) : pending
  console.log(`补丁 ${slugs.length} 个，待补版本 ${pending.length} 个${limit ? `，本轮跑 ${todo.length}` : ''}`)

  for (const slug of todo) {
    const file = join('patches', slug, '.source.json')
    if (!existsSync(file)) continue
    let raw
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      failures.push(`${slug}: .source.json 不是合法 JSON`)
      continue
    }

    // 断点续跑：缓存里有结果就直接套用（旧一轮已经把网络请求花掉了）。
    const cached = force ? null : cache[slug]
    if (cached && cached.version) {
      applyAndWrite(slug, raw, cached, { dry })
      skipped++
      continue
    }

    const platform = raw.platform === 'mr' ? 'mr' : 'cf'
    let meta
    let manifestVersion = null
    try {
      if (platform === 'mr') {
        meta = await fetchMrMeta(raw.slug || slug)
      } else {
        const cfId = raw.cfId ?? cfIds.get(slug)
        if (!cfId) throw new Error('数据集里没有 cfId')
        meta = await fetchCfMeta(cfId, raw.fileId ?? null, apiKey)
      }
    } catch (e) {
      failures.push(`${slug}: 元数据 ${e?.message ?? e}`)
      continue
    }

    const displayGuess = extractVersionToken(meta.displayName)
    const fileGuess = extractVersionToken(meta.fileName)
    const named = platform === 'mr'
      ? { version: sanitizeVersion(meta.versionNumber) || null, source: 'displayName' }
      : pickNameGuess(meta.displayName, meta.fileName)
    const guess = named.version
    const decision = shouldVerify(
      { platform, guess, displayGuess, fileGuess, displayName: meta.displayName, fileDate: meta.fileDate ?? raw.fileDate },
      now,
      { deep },
    )

    if (decision.need) {
      manifestVersion = platform === 'mr'
        ? await readMrManifestVersion(meta.url)
        : await readCfManifestVersion(meta.url)
      if (manifestVersion) manifests++
    }

    let version = null
    let versionSource = null
    let ok = false
    const fromManifest = manifestVersion ? sanitizeVersion(manifestVersion) : ''
    // manifest 的 `version` 也可能是标签而不是版本（实测 `Latest-Version`、`Slicks-Edition`）。
    // 版本号必然含数字，纯文字的一律不采信，继续回退。
    if (fromManifest && /\d/.test(fromManifest)) {
      version = fromManifest
      versionSource = 'manifest'
      ok = true
    } else if (guess) {
      version = guess
      versionSource = platform === 'mr' ? 'modrinth-version' : named.source
      ok = platform === 'mr'
    } else {
      version = dateVersion(meta.fileDate ?? raw.fileDate)
      versionSource = 'fileDate'
    }
    if (!version) {
      failures.push(`${slug}: 元数据与 manifest 都取不到版本，且无 fileDate`)
      continue
    }

    const rec = {
      displayName: meta.displayName ?? null,
      version,
      versionSource,
      confirmed: ok,
      verifiedAt,
    }
    cache[slug] = rec
    applyAndWrite(slug, raw, rec, { dry })
    done++
    written++
    if (versionSource === 'fileDate') dated++
    if (ok) confirmed++
    if (done % 25 === 0) {
      console.log(`  进度 ${done}/${todo.length}  已写 ${written}  manifest 读 ${manifests}  日期兜底 ${dated}`)
      if (!dry) persist(cache)
    }
    // CF 免费额度有限，别打满；MR 宽松些但也留间隔。
    await sleep(platform === 'mr' ? 80 : 220)
  }

  if (!dry) persist(cache)
  console.log(`完成：处理 ${done}，写入 ${written}，manifest 读到版本 ${manifests}，confirmed ${confirmed}，日期兜底 ${dated}，缓存复用 ${skipped}`)
  if (dated) {
    console.log(`  日期兜底（无可信版本）${dated} 个；详见本脚本落盘的 versionSource="fileDate" 记录`)
  }
  if (failures.length) {
    console.log(`失败 ${failures.length} 个（未写盘，下次重跑会重试）：`)
    for (const f of failures) console.log('  - ' + f)
  }
  if (dry) console.log('（--dry，未写盘）')
  return { done, written, manifests, dated, confirmed, skipped, failures }
}

/** 保留原字段顺序，只在末尾追加新字段。 */
function applyAndWrite(slug, raw, rec, { dry }) {
  const next = { ...raw, ...rec }
  if (!dry) writeFileSync(join('patches', slug, '.source.json'), JSON.stringify(next, null, 2) + '\n')
}

function persist(cache) {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(cache, null, 1))
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (isMain) {
  await main()
}
