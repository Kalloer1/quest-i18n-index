#!/usr/bin/env node
// 工单 04：补齐 35 条整合包元数据，产出旁路文件 research/pack-metadata.json。
// 边界：research/index-dataset.json 由工单 02 独占，本脚本不读不写。
// 密钥：只从环境变量 CF_KEY 读取，不落盘、不打印、不进提交。

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUILD_INPUT_PATH = join(ROOT, 'research', 'build-input.json')
const DEMO_DATA_PATH = join(ROOT, 'design', 'demo-data.json')
const OUTPUT_PATH = join(ROOT, 'research', 'pack-metadata.json')

const CF_API_BASE = 'https://api.curseforge.com/v1'
const CF_GAME_ID = '432'
const CF_CLASS_ID = '4471'
const REQUEST_INTERVAL_MS = 300
const RETRY_DELAY_MS = 2000

// CurseForge 的 gameVersions 把 MC 版本和加载器混在一个数组里，按加载器名拆开。
const LOADER_NAMES = new Set(['forge', 'neoforge', 'fabric', 'quilt', 'rift', 'liteloader'])

const execFileAsync = promisify(execFile)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// demo-data.json 没有记录上游抓取时间，用该文件的提交时间作为可核对的快照来源时间。
// 取不到 git 时返回 null，不用当前时间顶替。
async function resolveDemoDataCommitAt() {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-1', '--format=%cI', '--', 'design/demo-data.json'],
      { cwd: ROOT },
    )
    return textOrNull(stdout)
  } catch {
    return null
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function listOrNull(value) {
  if (!Array.isArray(value)) return null
  const items = value.filter((item) => typeof item === 'string' && item.trim() !== '')
  return items.length > 0 ? items : null
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

function recordFromDemo(pack, demo, demoDataCommitAt) {
  return {
    slug: pack.slug,
    cfId: pack.cfId,
    cfModId: null,
    title: textOrNull(demo.title),
    description: textOrNull(demo.description),
    iconUrl: textOrNull(demo.iconUrl),
    downloads: Number.isFinite(demo.downloads) ? demo.downloads : null,
    gameVersions: listOrNull(demo.gameVersions),
    loaders: listOrNull(demo.loaders),
    authors: listOrNull(demo.authors),
    source: textOrNull(demo.source) ?? 'curseforge',
    fetchedAt: null,
    reusedFrom: 'design/demo-data.json',
    sourceFileCommitAt: demoDataCommitAt,
  }
}

function recordFromMod(pack, mod, fetchedAt) {
  const { gameVersions, loaders } = splitGameVersions(mod.gameVersions)
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
    gameVersions: gameVersions.length > 0 ? gameVersions : null,
    loaders: loaders.length > 0 ? loaders : null,
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

// 返回 { url, body }；非 2xx 抛 CfRequestError。429 只重试一次。
async function cfGet(path, apiKey) {
  const url = `${CF_API_BASE}${path}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await throttle()
    let response
    try {
      response = await fetch(url, { headers: { 'x-api-key': apiKey, accept: 'application/json' } })
    } catch (error) {
      throw new CfRequestError('network', null, `${error.code ?? 'fetch-failed'}: ${error.message}`)
    }
    if (response.ok) return { url, body: await response.json() }
    if (response.status === 429 && attempt === 0) {
      await sleep(RETRY_DELAY_MS)
      continue
    }
    throw new CfRequestError('http', response.status, `HTTP ${response.status} ${response.statusText}`)
  }
  throw new CfRequestError('http', 429, 'HTTP 429 重试后仍限速')
}

async function fetchOne(pack, apiKey) {
  const searchPath = `/mods/search?gameId=${CF_GAME_ID}&classId=${CF_CLASS_ID}&slug=${encodeURIComponent(pack.slug)}`
  const search = await cfGet(searchPath, apiKey)
  const mod = Array.isArray(search.body?.data) ? search.body.data[0] : undefined
  if (mod) return recordFromMod(pack, mod, new Date().toISOString())

  // 搜索无结果时用 build-input 已知的 cfId 兜底一次。
  const byId = await cfGet(`/mods/${pack.cfId}`, apiKey)
  const byIdMod = byId.body?.data
  if (!byIdMod) {
    throw new CfRequestError('search', 200, `slug 搜索无结果，/mods/${pack.cfId} 也无 data`)
  }
  return recordFromMod(pack, byIdMod, new Date().toISOString())
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
    note: '工单 04 旁路产物：整合包元数据。合并进索引由工单 01 的构建入口负责，不要手改。',
    generatedAt: new Date().toISOString(),
    sourcePlatform: 'curseforge',
    incomplete,
    reason: reason ?? null,
    sourceFiles: {
      packs: 'research/build-input.json',
      reused: 'design/demo-data.json',
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

function printDryRun(pending, reusedCount) {
  console.log(`dry-run: 复用 design/demo-data.json ${reusedCount} 条，待抓取 ${pending.length} 条，共 ${reusedCount + pending.length} 条`)
  console.log('dry-run: 不发请求，以下为将要请求的 URL')
  for (const pack of pending) {
    console.log(
      `${CF_API_BASE}/mods/search?gameId=${CF_GAME_ID}&classId=${CF_CLASS_ID}&slug=${encodeURIComponent(pack.slug)}`,
    )
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const buildInput = await readJson(BUILD_INPUT_PATH)
  const demoData = await readJson(DEMO_DATA_PATH)

  const packs = Array.isArray(buildInput.packs) ? buildInput.packs : []
  if (packs.length === 0) throw new Error('research/build-input.json 没有 packs，无法继续')
  const demoBySlug = new Map(
    (Array.isArray(demoData) ? demoData : []).map((entry) => [entry.slug, entry]),
  )
  const demoDataCommitAt = await resolveDemoDataCommitAt()

  const recordBySlug = new Map()
  const pending = []
  for (const pack of packs) {
    const demo = demoBySlug.get(pack.slug)
    if (demo) recordBySlug.set(pack.slug, recordFromDemo(pack, demo, demoDataCommitAt))
    else pending.push(pack)
  }

  if (dryRun) {
    printDryRun(pending, recordBySlug.size)
    return
  }

  const apiKey = (process.env.CF_KEY ?? '').trim()
  const failures = []

  if (apiKey === '') {
    const reason = 'CF_KEY not set, 35 条未抓'
    const document = buildDocument({
      packs,
      recordBySlug,
      failures,
      incomplete: true,
      reason,
    })
    await writeFile(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    console.log(`未检测到 CF_KEY：只写回复用条目 ${document.counts.reusedFromDemo} 条，缺口 ${document.counts.missing} 条`)
    console.log(`已写入 ${OUTPUT_PATH}`)
    return
  }

  console.log(`CF_KEY 已就绪，抓取 ${pending.length} 条，请求间隔 ${REQUEST_INTERVAL_MS}ms`)
  for (const [index, pack] of pending.entries()) {
    try {
      const record = await fetchOne(pack, apiKey)
      recordBySlug.set(pack.slug, record)
      const missingFields = ['title', 'iconUrl', 'downloads', 'gameVersions', 'loaders', 'authors']
        .filter((key) => record[key] === null)
      const suffix = missingFields.length > 0 ? `（上游缺 ${missingFields.join('/')}）` : ''
      console.log(`[${index + 1}/${pending.length}] ${pack.slug} ok${suffix}`)
    } catch (error) {
      const failure = {
        slug: pack.slug,
        cfId: pack.cfId,
        stage: error.stage ?? 'unknown',
        status: error.status ?? null,
        reason: error.message,
      }
      failures.push(failure)
      console.log(`[${index + 1}/${pending.length}] ${pack.slug} 失败: ${failure.stage} ${failure.reason}`)
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
