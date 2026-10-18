#!/usr/bin/env node
// 抓取整合包元数据（标题 / 图标 / 下载量 / MC 版本 / 加载器 / 作者），产出 research/pack-metadata.json。
// 输入：research/scan-cf500.tsv（扫描结果里的 CF id 与 slug），覆盖全部 500 条。
// 边界：research/index-dataset.json 由 build-index.mjs 独占，本脚本不读不写。
// 密钥：只从环境变量 CF_KEY 读取，不落盘、不打印、不进提交。
//
// 为什么是全量而不是只抓「可产出」的那批：
//   图标与标题是站点列表页的全部可见内容，缺一条就是一个占位块；
//   标题同时是 VM 覆盖匹配的唯一可信依据（见 build-index.mjs 的 matchPack），
//   只给 57 条标题会让其余 443 条永远匹配不上 VM。
//   元数据与任务书探测互不依赖，因此 500 条全都能抓。

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCAN_PATH = join(ROOT, 'research', 'scan-cf500.tsv')
const OUTPUT_PATH = join(ROOT, 'research', 'pack-metadata.json')

const CF_API_BASE = 'https://api.curseforge.com/v1'
const REQUEST_INTERVAL_MS = 300
const RETRY_DELAY_MS = 2000
// POST /v1/mods 支持一次传多个 modId（上游上限 1000）。取 100 是为了单批失败时
// 只丢 100 条、且进度可见。
const BULK_CHUNK = 100

// CurseForge 的 gameVersions 把 MC 版本和加载器混在一个数组里，按加载器名拆开。
const LOADER_NAMES = new Set(['forge', 'neoforge', 'fabric', 'quilt', 'rift', 'liteloader'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function textOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function splitGameVersions(values) {
  const gameVersions = []
  const loaders = []
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || value.trim() === '') continue
    const name = value.trim()
    if (LOADER_NAMES.has(name.toLowerCase())) loaders.push(name)
    else gameVersions.push(name)
  }
  return { gameVersions, loaders }
}

// `mods/search` 与 `mods/<id>` 的响应**没有** gameVersions 字段，
// 版本信息在 latestFilesIndexes 里：gameVersion = MC 版本，modLoader = 数字枚举。
// 4=Forge 5=NeoForge 6=Fabric 7=Quilt
const MOD_LOADER_BY_ID = new Map([
  [1, 'Forge'],
  [4, 'Forge'],
  [5, 'NeoForge'],
  [6, 'Fabric'],
  [7, 'Quilt'],
])

function fromLatestFilesIndexes(indexes) {
  const gameVersions = new Set()
  const loaders = new Set()
  for (const item of Array.isArray(indexes) ? indexes : []) {
    if (typeof item?.gameVersion === 'string' && item.gameVersion.trim()) {
      gameVersions.add(item.gameVersion.trim())
    }
    const loader = MOD_LOADER_BY_ID.get(item?.modLoader)
    if (loader) loaders.add(loader)
  }
  return {
    gameVersions: gameVersions.size > 0 ? [...gameVersions] : null,
    loaders: loaders.size > 0 ? [...loaders] : null,
  }
}

/**
 * 取版本与加载器：优先 gameVersions（老响应），否则从 latestFilesIndexes 推导。
 * 两处都拿不到时返回 null，不猜。
 */
function resolveVersionsAndLoaders(mod) {
  const split = splitGameVersions(mod?.gameVersions)
  if (split.gameVersions.length > 0 || split.loaders.length > 0) {
    return {
      gameVersions: split.gameVersions.length > 0 ? split.gameVersions : null,
      loaders: split.loaders.length > 0 ? split.loaders : null,
    }
  }
  return fromLatestFilesIndexes(mod?.latestFilesIndexes)
}

function recordFromMod(pack, mod, fetchedAt) {
  const { gameVersions, loaders } = resolveVersionsAndLoaders(mod)
  const authors = Array.isArray(mod.authors)
    ? mod.authors.map((author) => textOrNull(author?.name)).filter(Boolean)
    : []
  return {
    slug: pack.slug,
    cfId: pack.cfId,
    cfModId: Number.isInteger(mod.id) ? mod.id : null,
    title: textOrNull(mod.name),
    description: textOrNull(mod.summary),
    iconUrl: textOrNull(mod.logo?.thumbnailUrl) ?? textOrNull(mod.logo?.url),
    downloads: Number.isFinite(mod.downloadCount) ? mod.downloadCount : null,
    gameVersions: gameVersions ?? null,
    loaders: loaders ?? null,
    authors: authors.length > 0 ? authors : null,
    source: 'curseforge',
    fetchedAt,
    reusedFrom: null,
    sourceFileCommitAt: null,
  }
}

class CfRequestError extends Error {
  constructor(stage, status, message) {
    super(message)
    this.stage = stage
    this.status = status
  }
}

let lastRequestAt = 0

async function throttle() {
  const wait = lastRequestAt + REQUEST_INTERVAL_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

/**
 * 读扫描结果 TSV，取出 CF 侧的 id 与 slug。
 * 列：platform id slug bytes format newEn newZh oldCh cdKB scannedAt
 * 只取 platform=cf 的行——Modrinth 的 id 不是 CF id，不能混进同一个批量请求。
 */
export function parseScanPacks(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  const header = lines[0].split('\t')
  for (const col of ['platform', 'id', 'slug']) {
    if (!header.includes(col)) throw new Error(`扫描 TSV 缺列：${col}`)
  }
  const idx = Object.fromEntries(header.map((col, i) => [col, i]))
  return lines.slice(1)
    .map((line) => line.split('\t'))
    .filter((f) => f[idx.platform] === 'cf')
    .map((f) => ({ cfId: f[idx.id], slug: f[idx.slug] }))
}

/** 按固定大小切块。 */
export function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * 批量取模组信息（POST /v1/mods）。一次最多 BULK_CHUNK 个 id。
 * 返回 data 数组；非 2xx 抛 CfRequestError。429 只重试一次。
 */
async function cfPostBulk(modIds, apiKey) {
  const url = `${CF_API_BASE}/mods`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await throttle()
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ modIds }),
      })
    } catch (error) {
      throw new CfRequestError('network', null, `${error.code ?? 'fetch-failed'}: ${error.message}`)
    }
    if (response.ok) {
      const body = await response.json()
      return Array.isArray(body?.data) ? body.data : []
    }
    if (response.status === 429 && attempt === 0) {
      await sleep(RETRY_DELAY_MS)
      continue
    }
    throw new CfRequestError('http', response.status, `HTTP ${response.status} ${response.statusText}`)
  }
  throw new CfRequestError('http', 429, 'HTTP 429 重试后仍限速')
}

function buildDocument({ packs, recordBySlug, failures, incomplete, reason }) {
  const ordered = packs.map((pack) => recordBySlug.get(pack.slug)).filter(Boolean)
  const coverageKeys = [
    'title',
    'iconUrl',
    'downloads',
    'gameVersions',
    'loaders',
    'authors',
    'fetchedAt',
    'sourceFileCommitAt',
  ]
  const coverage = Object.fromEntries(coverageKeys.map((key) => [key, 0]))
  for (const record of ordered) {
    for (const key of coverageKeys) {
      if (record[key] !== null && record[key] !== undefined) coverage[key] += 1
    }
  }
  const missing = packs
    .filter((pack) => !recordBySlug.has(pack.slug))
    .map((pack) => ({
      slug: pack.slug,
      cfId: pack.cfId,
      reason: reason ?? '未抓取',
    }))

  return {
    note: '整合包元数据旁路产物，覆盖 scan-cf500.tsv 全部 CF 记录。合并进索引由 build-index.mjs 负责，不要手改。',
    generatedAt: new Date().toISOString(),
    sourcePlatform: 'curseforge',
    incomplete,
    reason: reason ?? null,
    sourceFiles: {
      packs: 'research/scan-cf500.tsv',
    },
    counts: {
      total: packs.length,
      reusedFromDemo: ordered.filter((record) => record.reusedFrom !== null).length,
      fetched: ordered.filter((record) => record.fetchedAt !== null).length,
      missing: missing.length,
      failed: failures.length,
    },
    coverage,
    packs: ordered,
    missing,
    failures,
  }
}

function printDryRun(packs) {
  const batches = chunk(packs, BULK_CHUNK)
  console.log(`dry-run: 不发请求。${packs.length} 条将分 ${batches.length} 批（每批 ${BULK_CHUNK}）走 POST ${CF_API_BASE}/mods`)
  for (const [index, batch] of batches.entries()) {
    console.log(`  第 ${index + 1} 批：${batch.map((p) => p.slug).join(', ')}`)
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const packs = parseScanPacks(await readFile(SCAN_PATH, 'utf8'))
  if (packs.length === 0) throw new Error('research/scan-cf500.tsv 没有 CF 记录，无法继续')

  if (dryRun) {
    printDryRun(packs)
    return
  }

  const apiKey = (process.env.CF_KEY ?? '').trim()
  const failures = []
  const recordBySlug = new Map()

  if (apiKey === '') {
    const reason = `CF_KEY not set，${packs.length} 条全部未抓`
    const document = buildDocument({
      packs,
      recordBySlug,
      failures,
      incomplete: true,
      reason,
    })
    await writeFile(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    console.log(`未检测到 CF_KEY：${packs.length} 条全部未抓，已写入空壳 ${OUTPUT_PATH}`)
    return
  }

  const batches = chunk(packs, BULK_CHUNK)
  console.log(`CF_KEY 已就绪，${packs.length} 条分 ${batches.length} 批（每批 ${BULK_CHUNK}）`)
  for (const [index, batch] of batches.entries()) {
    const label = `[${index + 1}/${batches.length}]`
    try {
      const mods = await cfPostBulk(batch.map((pack) => Number(pack.cfId)), apiKey)
      // 批量响应不保证顺序，按 id 建索引再按 pack 取，避免错位。
      const byId = new Map(mods.map((mod) => [mod.id, mod]))
      let hit = 0
      for (const pack of batch) {
        const mod = byId.get(Number(pack.cfId))
        if (mod) {
          recordBySlug.set(pack.slug, recordFromMod(pack, mod, new Date().toISOString()))
          hit += 1
        } else {
          failures.push({
            slug: pack.slug,
            cfId: pack.cfId,
            stage: 'bulk',
            status: 200,
            reason: '批量响应里没有这个 id',
          })
        }
      }
      console.log(`${label} 本批 ${batch.length} 条，命中 ${hit}，累计 ${recordBySlug.size}`)
    } catch (error) {
      for (const pack of batch) {
        failures.push({
          slug: pack.slug,
          cfId: pack.cfId,
          stage: error.stage ?? 'unknown',
          status: error.status ?? null,
          reason: error.message,
        })
      }
      console.log(`${label} 整批失败: ${error.message}`)
    }
  }

  const document = buildDocument({
    packs,
    recordBySlug,
    failures,
    incomplete: failures.length > 0,
    reason: failures.length > 0 ? `${failures.length} 条抓取失败，见 failures` : null,
  })
  await writeFile(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8')

  console.log(`抓取成功 ${document.counts.fetched} 条，失败 ${document.counts.failed} 条`)
  console.log(`覆盖率 ${JSON.stringify(document.coverage)} / 总数 ${document.counts.total}`)
  console.log(`已写入 ${OUTPUT_PATH}`)
}

main().catch((error) => {
  console.error(`失败: ${error.message}`)
  process.exitCode = 1
})
