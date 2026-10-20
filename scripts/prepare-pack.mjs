#!/usr/bin/env node
/**
 * 准备整合包：按 slug 从 CurseForge 或 Modrinth 取最新文件，只把任务书 .snbt
 * 解到 `research/packs/<slug>/`，供 `pipeline.mjs` 的 loadPack 读取。
 *
 * 两个来源（`platform`）：
 *   - `cf`（缺省）CurseForge，需要 `CF_KEY`，文件是普通 zip。
 *   - `mr` Modrinth，**不需要 apiKey**，文件是 `.mrpack`（本质也是 zip，任务书在
 *     `overrides/` 下）。实测 better-mc-fabric-bmc2.mrpack 63 MB → 35 个 .snbt，
 *     20 个在 `overrides/defaultconfigs/ftbquests/quests/chapters/`。
 *     解包仍复用 `extractFromBuffer`：`toOutputPath` 锚到 config/ftbquests/lang/chapters，
 *     天然剥掉 `overrides/`，故落盘路径与 CF 包完全一致。
 *
 * 为什么要 Modrinth 分支：数据集 28816 条里 18816 条是 Modrinth（platform=mr），
 * 其中 391 条是可产出的任务书包 —— 只走 CF 等于放弃一半以上候选。
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
 *   node scripts/prepare-pack.mjs --ids a --platform mr
 *   node scripts/prepare-pack.mjs --ids a --quest-files-only   只 Range 取 .snbt，不下载整包
 *
 * `--ids` 里的 slug 可来自任一平台：缺省按 `research/index-dataset.json` 的
 * `platform` 字段自动判定；`--platform mr|cf` 强制指定（数据集没有该字段时用）。
 *
 * 环境变量：
 *   CF_KEY   CurseForge API key（仅 cf 来源需要；缺失时明确失败，不静默跳过）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { extractFromBuffer, isQuestFile, toOutputPath } from './extract-pack.mjs'
import { classifyLayout } from './lib/candidates.mjs'
import { resolveLatestMrpack } from './lib/modrinth.mjs'
import { fetchZipTexts } from './lib/zip-range.mjs'

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
 * 从数据集记录里取来源平台（`'cf'` / `'mr'`），没有该字段时返回 null。
 *
 * 为什么必须查：Modrinth 的项目 id（如 `shFhR8Vx`）不是 CF 数字 id，
 * 拿它去调 `api.curseforge.com/v1/mods/<id>/files` 只会 400。
 * 数据集 `platform` 字段由 `build-index.mjs` 写入（28816 条中 18816 条为 `mr`）。
 * 缺字段时返回 null 而**不猜 `'cf'`**：猜错等于静默请求错平台，比明确报错更难发现。
 * @param {Array<{slug: string, platform?: string}>} records
 * @param {string} slug
 * @returns {'cf'|'mr'|null}
 */
export function platformOf(records, slug) {
  const row = (records ?? []).find((r) => r?.slug === slug)
  const platform = String(row?.platform ?? '').trim().toLowerCase()
  return platform === 'cf' || platform === 'mr' ? platform : null
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
 * 只取任务书文件（Range，不下载整包）。
 *
 * 中央目录解析复用 `lib/zip-range.mjs`（与 `scan-packs.mjs` 同一份实现）——
 * 本仓库踩过「同一逻辑抄两份」的坑：`scan-packs.mjs` 曾复制一份布局分类器，
 * 只认 `lang/en_us/*`，213 个内嵌包被静默跳过（2000 条扫描里丢 66% 的工作）。
 *
 * `filter` 缺省用 `extract-pack.mjs` 的 `isQuestFile`：与整包解包路径同一口径，
 * 两条路径解出的文件集必须一致，否则「回退整包」会改变产物内容。
 *
 * @param {string} url
 * @param {{filter?: (name: string) => boolean, fetchImpl?: typeof fetch, headers?: object}} [options]
 * @returns {Promise<Array<{name: string, text: string}>>}
 */
export async function fetchQuestFilesOnly(url, { filter = isQuestFile, fetchImpl = fetch, headers = {} } = {}) {
  return fetchZipTexts(url, { filter, fetchImpl, headers })
}

/**
 * 把 Range 取回的文本按 `toOutputPath` 落盘，返回落盘相对路径。
 * 落盘路径与 `extractFromBuffer` 同口径（都走 `toOutputPath`），
 * 否则「回退整包」会把同一批文件写到不同路径。
 * @param {Array<{name: string, text: string}>} files
 * @param {string} outDir
 * @returns {string[]}
 */
function writeQuestTexts(files, outDir) {
  const written = []
  for (const file of files) {
    const rel = toOutputPath(file.name)
    const dest = join(outDir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, file.text)
    written.push(rel)
  }
  return written
}

/**
 * 下载 zip 并解出任务书文件到 `<packsDir>/<slug>/`。
 *
 * @param {object} options
 * @param {string} options.slug
 * @param {'cf'|'mr'} [options.platform] 来源平台（缺省 'cf'，保持旧行为）
 * @param {string} [options.cfId] CurseForge 项目 id（platform='cf' 时必需）
 * @param {string} [options.mrSlug] Modrinth 项目 slug/id（缺省用 slug；Modrinth 两者同路径）
 * @param {string} [options.apiKey] CF_KEY（仅 platform='cf' 需要）
 * @param {string} [options.packsDir]
 * @param {string} [options.tmpDir]
 * @param {boolean} [options.force] 已有文件也重新下载解包
 * @param {boolean} [options.keepZip] 把下载到的 zip 留在 `tmpDir` 便于复现（缺省 true）
 * @param {boolean} [options.questFilesOnly] 只 Range 取 .snbt，不下载整包（缺省 false，保持旧行为）
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{slug: string, status: 'prepared'|'skipped', written: number, layout: string|null}>}
 */
export async function preparePack({
  slug, platform = 'cf', cfId, mrSlug, apiKey, packsDir = PACKS_DIR, tmpDir = TMP_DIR,
  force = false, keepZip = true, questFilesOnly = false, fetchImpl = fetch, log = () => {},
}) {
  // 平台白名单：写错（`'modrinth'`、`'mr '` 之类）时不静默落到 CF 分支 ——
  // 那会用 cfId=null 去调 CF API，报出「未配置 CF_KEY」这种与真实原因无关的错误。
  // 放在幂等跳过分支之前：参数写错就该立刻失败，不因「恰好已有产物」而被吞掉。
  if (platform !== 'cf' && platform !== 'mr') {
    throw new Error(`platform 只接受 'cf' 或 'mr'，收到：${String(platform)}`)
  }

  const outDir = join(packsDir, slug)
  const existing = listSnbt(outDir)
  if (existing.length > 0 && !force) {
    log(`[${slug}] 已有 ${existing.length} 个任务书文件，跳过下载（--force 可强制重取）`)
    return { slug, status: 'skipped', written: existing.length, layout: classifyLayout(existing).layout }
  }

  // 两个来源只在「取下载地址」这一步分叉；后面的下载 / 留 zip / 解包完全相同
  // （`.mrpack` 就是 zip，overrides/ 由 toOutputPath 剥掉）。
  const file = platform === 'mr'
    ? await resolveLatestMrpack(String(mrSlug ?? slug).trim(), { fetchImpl })
    : await resolveLatestFile(cfId, { apiKey, fetchImpl })

  // 只取任务书文件：HEAD + 尾部 Range + 中央目录 Range + 每个目标文件 1 次 Range。
  //
  // 兜底是硬要求，不是可选项：真实 CDN 会忽略 Range 头直接回 200 + 整包
  // （此时 `getRange` 报「未返回 206」），压缩方式也可能不是 0/8。
  // 任何一步失败都回退整包下载 —— 宁可多花 100 MB，也不能让 346 个包的批量
  // 任务卡在一个不支持 Range 的 CDN 上。日志里明说是为了能统计到底回退了多少包。
  if (questFilesOnly) {
    log(`[${slug}] 只取任务书文件（Range，不下载整包）：${file.fileName}`)
    try {
      const files = await fetchQuestFilesOnly(file.url, { fetchImpl })
      const written = writeQuestTexts(files, outDir)
      const info = classifyLayout(written)
      log(`[${slug}] Range 取到 ${written.length} 个任务书文件，布局 ${info.layout}（enFiles=${info.enFiles} zhFiles=${info.zhFiles}）`)
      return { slug, status: 'prepared', written: written.length, layout: info.layout }
    } catch (err) {
      log(`[${slug}] Range 失败，回退整包：${String(err?.message ?? err).slice(0, 200)}`)
    }
  }

  log(`[${slug}] 下载 ${file.fileName}${file.fileLength ? `（${(file.fileLength / 1048576).toFixed(1)} MB）` : ''}`)

  const res = await fetchImpl(file.url)
  if (!res.ok) throw new Error(`下载整合包 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  // 留一份 zip 在 research/tmp/（已 gitignore），便于复现；不参与提交。
  //
  // 批量路（`translate-local.mjs`）传 `keepZip: false` 关掉：实测 2026-10-20，
  // `research/tmp/` 积了 1.5 GB / 33 个 zip，346 个包按同比例会再攒约 15 GB。
  // zip 的唯一价值是「重新解包时不用再下载」，而 `research/packs/<slug>/` 下的
  // `.snbt` 一旦存在，上面那个幂等分支本来就会跳过下载 —— 故 zip 再也用不上。
  //
  // 默认仍为 true：单包调试时留一份 zip 有复现价值；默认改 false 会让调试场景
  // 失去这个便利，而「默认留、批量显式关」不需要任何人记住新参数就能保持旧行为。
  if (keepZip) {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, `${slug}.zip`), buf)
  }

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
  // `--no-keep-zip`：解包完不留 zip。批量跑 346 个包时用，否则会攒约 15 GB 用不上的中间物。
  const keepZip = !args.includes('--no-keep-zip')
  // `--quest-files-only`：Range 只取 .snbt，不下载整包（失败自动回退整包）。
  const questFilesOnly = args.includes('--quest-files-only')
  // `--platform mr`：强制来源。缺省按数据集的 platform 字段逐 slug 判定。
  const platformArg = args.indexOf('--platform')
  const platformFlag = platformArg >= 0 ? String(args[platformArg + 1] ?? '').trim().toLowerCase() : ''
  if (platformFlag && platformFlag !== 'cf' && platformFlag !== 'mr') {
    console.error(`--platform 只接受 cf 或 mr，收到：${platformFlag}`)
    process.exit(2)
  }
  if (!ids.length) {
    console.error('用法: node scripts/prepare-pack.mjs --ids <slug,slug> [--force] [--no-keep-zip] [--platform cf|mr] [--quest-files-only]')
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
    // 平台判定：--platform 强制优先，否则查数据集。判不出来就跳过并报明原因，
    // 不默认当成 cf —— Modrinth 的 slug 拿去调 CF API 只会 400，白跑一轮。
    const platform = platformFlag || platformOf(records, slug)
    if (!platform) {
      console.log(`[${slug}] 数据集里没有该 slug 的 platform，跳过（可用 --platform cf|mr 强制）`)
      failed++
      continue
    }
    const cfId = platform === 'cf' ? cfIdOf(records, slug) : null
    if (platform === 'cf' && !cfId) {
      console.log(`[${slug}] 数据集里没有该 slug 的 cfId，跳过`)
      failed++
      continue
    }
    try {
      await preparePack({
        slug, platform, cfId, mrSlug: slug, apiKey, force, keepZip, questFilesOnly, log: (m) => console.log(m),
      })
    } catch (err) {
      console.log(`[${slug}] 失败: ${String(err?.message ?? err).slice(0, 200)}`)
      failed++
    }
  }
  process.exit(failed ? 1 : 0)
}
