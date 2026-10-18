#!/usr/bin/env node
/**
 * 准备整合包：按 slug 从 CurseForge 取最新文件 zip，只把任务书 .snbt 解到
 * `research/packs/<slug>/`，供 `pipeline.mjs` 的 loadPack 读取。
 *
 * 为什么需要这一步：`pipeline.mjs` 读 `research/packs/<slug>/`，`extract-pack.mjs`
 * 能把 zip 解到该目录，但两者之间缺「按 slug 下载 zip」——workflow 里没有任何步骤
 * 产出 `research/packs/<slug>/`，于是 Translate 必然以「找不到整合包文件」失败
 * （实跑 run 39165439848 暴露）。
 *
 * 只解任务书文件（`extract-pack.mjs` 的 isQuestFile），不落整包：整合包动辄上百 MB，
 * 绝大多数是 mods/、assets/。解出的 .snbt 会随发布入库（`release.mjs` 显式暂存
 * `research/packs/<slug>`），因为质量闸门 `validate-quests.mjs` 需要英文源做基准键集——
 * 缺了它闸门只会 warn 跳过，退化成假绿灯。
 *
 * 幂等：`research/packs/<slug>/` 已有 .snbt 时直接跳过，不重复下载。
 *
 * 用法：
 *   node scripts/prepare-pack.mjs --ids a,b
 *   node scripts/prepare-pack.mjs --ids a --force     忽略已解出的文件，重新下载解包
 *
 * 环境变量：
 *   CF_KEY   CurseForge API key（必需；缺失时明确失败，不静默跳过）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { extractFromBuffer } from './extract-pack.mjs'
import { classifyLayout } from './lib/candidates.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATASET_FILE = join(ROOT, 'research/index-dataset.json')
const PACKS_DIR = join(ROOT, 'research/packs')
const TMP_DIR = join(ROOT, 'research/tmp')

const CF_API_BASE = 'https://api.curseforge.com/v1'

/** 递归列目录下的 .snbt（相对路径，/ 分隔）。 */
function listSnbt(dir, base = dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listSnbt(full, base))
    else if (/\.snbt$/i.test(name)) out.push(relative(base, full).replace(/\\/g, '/'))
  }
  return out
}

/**
 * 从数据集记录里取 CurseForge 项目 id。
 * @param {Array<{slug: string, cfId?: string}>} records
 * @param {string} slug
 * @returns {string|null}
 */
export function cfIdOf(records, slug) {
  const row = (records ?? []).find((r) => r?.slug === slug)
  const id = String(row?.cfId ?? '').trim()
  return id || null
}

/**
 * 取该文件条目的下载地址。CurseForge 对作者关闭 API 分发的项目返回 null——
 * 明确报错，不猜替代地址（猜出来的地址一旦变了就是静默下错包）。
 * @param {object|null} file
 * @returns {string}
 */
export function downloadUrlOf(file) {
  const url = typeof file?.downloadUrl === 'string' ? file.downloadUrl.trim() : ''
  if (!url) throw new Error('CurseForge 未返回 downloadUrl（作者可能关闭了 API 分发）')
  return url
}

/**
 * 用 CurseForge API 取项目最新文件的下载地址。
 * @param {string} cfId
 * @param {{apiKey: string, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{url: string, fileName: string, fileLength: number|null}>}
 */
export async function resolveLatestFile(cfId, { apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('未配置 CF_KEY，无法从 CurseForge 取整合包下载地址')
  const res = await fetchImpl(`${CF_API_BASE}/mods/${cfId}/files?pageSize=1`, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`CurseForge 文件列表 HTTP ${res.status}`)
  const body = await res.json()
  const file = Array.isArray(body?.data) ? body.data[0] : null
  if (!file) throw new Error(`CurseForge 项目 ${cfId} 没有任何文件`)
  return {
    url: downloadUrlOf(file),
    fileName: String(file.fileName ?? `${cfId}.zip`),
    fileLength: Number.isFinite(file.fileLength) ? file.fileLength : null,
  }
}

/**
 * 下载 zip 并解出任务书文件到 `<packsDir>/<slug>/`。
 *
 * @param {object} options
 * @param {string} options.slug
 * @param {string} options.cfId
 * @param {string} options.apiKey
 * @param {string} [options.packsDir]
 * @param {string} [options.tmpDir]
 * @param {boolean} [options.force] 已有文件也重新下载解包
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{slug: string, status: 'prepared'|'skipped', written: number, layout: string|null}>}
 */
export async function preparePack({
  slug, cfId, apiKey, packsDir = PACKS_DIR, tmpDir = TMP_DIR,
  force = false, fetchImpl = fetch, log = () => {},
}) {
  const outDir = join(packsDir, slug)
  const existing = listSnbt(outDir)
  if (existing.length > 0 && !force) {
    log(`[${slug}] 已有 ${existing.length} 个任务书文件，跳过下载（--force 可强制重取）`)
    return { slug, status: 'skipped', written: existing.length, layout: classifyLayout(existing).layout }
  }

  const file = await resolveLatestFile(cfId, { apiKey, fetchImpl })
  log(`[${slug}] 下载 ${file.fileName}${file.fileLength ? `（${(file.fileLength / 1048576).toFixed(1)} MB）` : ''}`)

  const res = await fetchImpl(file.url)
  if (!res.ok) throw new Error(`下载整合包 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  // 留一份 zip 在 research/tmp/（已 gitignore），便于复现；不参与提交。
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(join(tmpDir, `${slug}.zip`), buf)

  const { written } = extractFromBuffer(buf, outDir)
  const info = classifyLayout(written)
  log(`[${slug}] 解出 ${written.length} 个任务书文件，布局 ${info.layout}（enFiles=${info.enFiles} zhFiles=${info.zhFiles}）`)
  return { slug, status: 'prepared', written: written.length, layout: info.layout }
}

// ---------- CLI ----------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const args = process.argv.slice(2)
  const idsArg = args.indexOf('--ids')
  const ids = idsArg >= 0 ? (args[idsArg + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : []
  const force = args.includes('--force')
  if (!ids.length) {
    console.error('用法: node scripts/prepare-pack.mjs --ids <slug,slug> [--force]')
    process.exit(2)
  }
  if (!existsSync(DATASET_FILE)) {
    console.error(`✘ 找不到 ${DATASET_FILE}，先跑 npm run build:data 生成整合包记录`)
    process.exit(1)
  }

  const records = JSON.parse(readFileSync(DATASET_FILE, 'utf8')).dataset ?? []
  const apiKey = String(process.env.CF_KEY ?? '').trim()

  let failed = 0
  for (const slug of ids) {
    const cfId = cfIdOf(records, slug)
    if (!cfId) {
      console.log(`[${slug}] 数据集里没有该 slug 的 cfId，跳过`)
      failed++
      continue
    }
    try {
      await preparePack({ slug, cfId, apiKey, force, log: (m) => console.log(m) })
    } catch (err) {
      console.log(`[${slug}] 失败: ${String(err?.message ?? err).slice(0, 200)}`)
      failed++
    }
  }
  process.exit(failed ? 1 : 0)
}
