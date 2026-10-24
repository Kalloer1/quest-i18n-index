#!/usr/bin/env node
/**
 * 夸克全量镜像同步器（决策 #7）：downloads/*.zip → 网盘「整合包汉化/」，增量、分批建链、回填记录。
 *
 * 增量判定（纯函数 planSync，单测覆盖）：
 *   1. 镜像记录里已有**非空 shareUrl** 且不在死链清单 → skip（不重传不重建）；
 *   2. 记录缺失或链接为空，但网盘目录里有该 slug 的 zip → 只补建分享链接（不重传）；
 *      同 slug 网盘有多个条目 → 判 ambiguous，记失败清单，绝不猜哪一个；
 *   3. 都没有 → 上传 + 建链（mirror.mjs 的 makeBatchUploader：一次 CLI 传一批，逐包建链）。
 *
 * 建链分批限速：补建链（rel­ink）按 --batch（默认 200）分批，批间 sleep --delay（默认 30s）。
 * 上传按 --upload-batch（默认 40）分组：一组一次 CLI 调用传完，组与组之间 RATE_LIMIT_MS。
 * 建链仍逐包（CLI 支持多 FID 一次分享，但那是「一条链接覆盖一批文件」，站点要每包一条）。
 *
 * 单包失败：重试 1 次，仍失败记入 research/quark-sync-failures.json 继续跑，
 * 不让一个坏包断全局；只有「有活但全军覆没」（典型：登录态过期）才退出码 1。
 *
 * 用法：
 *   node scripts/quark-sync.mjs --dry-run            只打印计划，不调 CLI、不写文件
 *   node scripts/quark-sync.mjs --limit 50           试点：只处理前 50 个工作项
 *   node scripts/quark-sync.mjs --links-only         只补链接，不上传
 *   node scripts/quark-sync.mjs --batch 200 --delay 30000 --upload-batch 40
 *   node scripts/quark-sync.mjs --dead-file research/quark-dead-urls.json
 *                                    死链清单（["https://pan.quark.cn/s/…"]），命中的记录强制重传/重建
 *
 * 环境变量（与 mirror.mjs / quark-rename.mjs 一致）：
 *   QUARK_CLI        quark-drive.cjs 路径；缺失时打印 warning 并 exit 0（本机没 CLI 不该炸）
 *   QUARK_DIR_NAME   网盘目标目录名，默认「整合包汉化」
 *   QUARK_PARENT_FID 目标目录的父目录 fid（不传在 CI 会 -602）
 *   QODER_PRODUCT_ID / QODER_AGENT  CI 里按 qoder 产品的登录配置调 CLI
 *
 * 产出：
 *   research/quark-mirrors.json      追加/更新本轮成功条目（沿用现有 {shareUrl, updatedAt} 结构）
 *   research/quark-sync-failures.json 失败清单（slug / phase / error / attempts）
 *
 * 安全边界：
 *   - 绝不伪造链接：拿不到真实 share_url 就记失败，不写假 URL；
 *   - 幂等：skip 判定保证重跑只处理增量；
 *   - 不碰网盘里的既有文件（补链用 fid，上传只新增），改名走 quark-rename.mjs。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import {
  DEFAULT_RATE_LIMIT_MS,
  DOWNLOADS_DIR,
  makeBatchUploader,
  quarkCall,
  readMirrorRecords,
  resolveZipPath,
  writeMirrors,
} from './mirror.mjs'
import { slugFromZipName } from './build-index.mjs'
import { browseDir, indexRemote, resolveDirFid } from './quark-rename.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const FAILURES_FILE = join(ROOT, 'research/quark-sync-failures.json')

// ---------- 纯函数（单测覆盖，不碰 CLI / 网络） ----------

/**
 * 增量规划：本地 slug 全集 × 镜像记录 × 网盘实际文件 → skip / relink / upload 三张清单。
 *
 * @param {object} options
 * @param {string[]} options.slugs 本地 slug 全集（downloads/ 反解）
 * @param {(slug: string) => string} options.zipFor slug → 本地 zip 路径（空串 = 本地缺包）
 * @param {Record<string, {shareUrl?: string}>} options.mirrors 镜像记录（readMirrorRecords 的产物）
 * @param {Map<string, Array<{fid: string, filename: string}>>} options.remoteBySlug
 *        网盘 slug 索引（indexRemote 的产物，一个 slug 可能多条）
 * @param {Set<string>} [options.deadUrls] 已确认失效的分享链接（命中的记录不跳过）
 * @returns {{
 *   skip: Array<{slug: string, reason: string}>,
 *   relink: Array<{slug: string, fid: string, filename: string}>,
 *   upload: Array<{slug: string, zipPath: string}>,
 *   ambiguous: Array<{slug: string, names: string[]}>,
 *   noZip: string[],
 * }}
 */
export function planSync({ slugs, zipFor, mirrors, remoteBySlug, deadUrls = new Set() }) {
  const skip = []
  const relink = []
  const upload = []
  const ambiguous = []
  const noZip = []
  for (const slug of slugs ?? []) {
    const recorded = mirrors?.[slug]
    const hasLiveLink = !!recorded?.shareUrl && !deadUrls.has(recorded.shareUrl)
    if (hasLiveLink) {
      skip.push({ slug, reason: '记录已有分享链接' })
      continue
    }
    const remote = remoteBySlug?.get(slug) ?? []
    if (remote.length > 1) {
      // 历史重传残留：分享哪个都不对（另一个链接会指向旧版本），绝不猜。
      ambiguous.push({ slug, names: remote.map((r) => r.filename) })
      continue
    }
    if (remote.length === 1) {
      relink.push({ slug, fid: remote[0].fid, filename: remote[0].filename })
      continue
    }
    const zipPath = zipFor(slug)
    if (!zipPath) {
      noZip.push(slug)
      continue
    }
    upload.push({ slug, zipPath })
  }
  return { skip, relink, upload, ambiguous, noZip }
}

/** 工作项展开：--links-only 时只补链，否则先传后补（上传项自身建链，顺序无依赖）。 */
export function workItems(plan, { linksOnly = false } = {}) {
  return linksOnly ? [...plan.relink] : [...plan.upload, ...plan.relink]
}

/** --limit N：N 为 0 / 非法 / 负数 = 全部；否则取前 N 个工作项（试点用 50）。 */
export function applyLimit(items, limit) {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return [...(items ?? [])]
  return (items ?? []).slice(0, n)
}

/** 分批：批大小 ≤0 或非法时整批返回（不分批）。 */
export function chunk(items, size) {
  const list = [...(items ?? [])]
  const n = Number(size)
  if (!Number.isFinite(n) || n <= 0) return list.length ? [list] : []
  const out = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}

/** 失败登记（纯）：重试后仍失败的条目追加进现有清单。 */
export function appendFailures(prev, entries, now = new Date().toISOString()) {
  const base = prev && Array.isArray(prev.failures) ? prev : { updatedAt: null, failures: [] }
  return { updatedAt: now, failures: [...base.failures, ...entries] }
}

/** 本轮汇总是否「全军覆没」：有活要干但一条没成 → 判红（典型：登录态过期）。 */
export function isTotalFailure(attempted, succeeded) {
  return attempted > 0 && succeeded === 0
}

// ---------- CLI 调用 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 已知 slug 全集（patches/ 目录名，slugFromZipName 的「已知优先」判定用）。 */
function knownSlugs() {
  const dir = join(ROOT, 'patches')
  return new Set(existsSync(dir) ? readdirSync(dir) : [])
}

/** downloads/ 下 zip → 去重排序的 slug 列表。 */
function localSlugs(known) {
  if (!existsSync(DOWNLOADS_DIR)) return []
  return [...new Set(
    readdirSync(DOWNLOADS_DIR)
      .filter((n) => n.endsWith('.zip'))
      .map((n) => slugFromZipName(n.slice(0, -4), known)),
  )].sort()
}

/** 对一个已有 fid 的网盘文件补建公开永久分享（与 makeUploader 的 share 参数一致）。 */
function shareByFid(cli, cwd, fid, slug) {
  const sh = quarkCall(cli, ['share', fid, '--title', `${slug} 任务书汉化补丁`, '--url-type', '1', '--expired-type', '1'], cwd)
  if (!sh.share_url) throw new Error('share 未返回 share_url')
  return sh.share_url
}

// ---------- 主流程 ----------

function argValue(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? '') : ''
}

async function main() {
  const args = process.argv.slice(2)
  const dry = args.includes('--dry-run')
  const linksOnly = args.includes('--links-only')
  const LIMIT = argValue(args, '--limit')
  const BATCH = Number(argValue(args, '--batch') || 200)
  const UPLOAD_BATCH = Math.max(1, Number(argValue(args, '--upload-batch') || 40))
  const DELAY = Number(argValue(args, '--delay') || 30000)
  const deadFile = argValue(args, '--dead-file')

  const QUARK_CLI = process.env.QUARK_CLI || ''
  const DIR_NAME = process.env.QUARK_DIR_NAME || '整合包汉化'
  const PARENT_FID = process.env.QUARK_PARENT_FID || ''

  const known = knownSlugs()
  const slugs = localSlugs(known)
  const mirrors = readMirrorRecords()

  let deadUrls = new Set()
  if (deadFile && existsSync(deadFile)) {
    const raw = JSON.parse(readFileSync(deadFile, 'utf8'))
    deadUrls = new Set(Array.isArray(raw) ? raw : [])
  }

  // 规划先行：--dry-run / 无 CLI 时也要能给出计划（本机没 CLI 时不炸，只打印）。
  let remoteBySlug = new Map()
  let remoteCount = 0
  if (QUARK_CLI && existsSync(QUARK_CLI)) {
    const work = mkdtempSync(join(tmpdir(), 'quark-sync-'))
    // dry-run 只读定位目录：绝不走 create-folder（那是写操作）。
    // 父目录/根目录里按名找；找不到就按「网盘为空」规划并在日志里说明。
    let dirFid = ''
    if (dry) {
      const { files } = browseDir(QUARK_CLI, PARENT_FID || '0', work)
      const nameOf = (f) => f.filename ?? f.file_name ?? f.name ?? ''
      const hit = files.find((f) => nameOf(f) === DIR_NAME)
      if (hit?.fid) dirFid = hit.fid
      else console.log(`::warning::dry-run：父目录里没找到「${DIR_NAME}」，按网盘为空规划（补链数为 0）。`)
    } else {
      dirFid = resolveDirFid(QUARK_CLI, DIR_NAME, PARENT_FID, work)
    }
    if (dirFid) {
      const { files, count } = browseDir(QUARK_CLI, dirFid, work)
      remoteBySlug = indexRemote(files, known)
      remoteCount = count ?? files.length
    }
  }

  const zipFor = (slug) => {
    const p = resolveZipPath(slug, DOWNLOADS_DIR)
    return existsSync(p) ? p : ''
  }
  const plan = planSync({ slugs, zipFor, mirrors, remoteBySlug, deadUrls })
  const allWork = workItems(plan, { linksOnly })
  const picked = applyLimit(allWork, LIMIT)
  const pickedSlugs = new Set(picked.map((w) => w.slug))

  console.log(`[规划] 本地 ${slugs.length} 个 slug / 网盘 ${remoteCount} 个条目`)
  console.log(`[规划] 跳过 ${plan.skip.length}（已有链接），补链 ${plan.relink.length}，上传 ${plan.upload.length}，` +
    `歧义 ${plan.ambiguous.length}，本地缺包 ${plan.noZip.length}`)
  if (linksOnly) console.log('[模式] --links-only：只补链接不上传')
  if (Number(LIMIT) > 0) console.log(`[规划] --limit ${LIMIT}：本轮实际处理 ${picked.length} 个工作项`)
  for (const a of plan.ambiguous.slice(0, 10)) console.log(`  歧义：${a.slug}（${a.names.join(' / ')}）`)
  for (const s of plan.noZip.slice(0, 10)) console.log(`  本地缺包：${s}`)

  if (dry) {
    for (const w of picked.slice(0, 10)) {
      console.log(`  [dry] ${w.slug}: ${w.fid ? `补链（网盘文件 ${w.filename}）` : `上传 ${basename(w.zipPath)} + 建链`}`)
    }
    console.log('[dry] 未调用 CLI、未写文件。')
    process.exit(0)
  }

  if (!QUARK_CLI || !existsSync(QUARK_CLI)) {
    console.log(`::warning::QUARK_CLI 未配置或不存在（${QUARK_CLI || '空'}）：本轮不执行同步。`)
    process.exit(0)
  }

  const cwd = mkdtempSync(join(tmpdir(), 'quark-sync-run-'))
  // 批量上传：一次 CLI 调用传 N 个文件（--upload-batch，默认 40），再逐包建链。
  // 逐包跑一次的固定开销是两次 node 启动 + 鉴权（实测 15s/包），批量能把这段省掉；
  // 链接仍逐包建 —— CLI 支持多 FID 一次分享，但那是「一条链接覆盖一批文件」，
  // 站点要求每包一条专属链接。
  const uploadBatch = makeBatchUploader(QUARK_CLI, DIR_NAME, cwd, { parentFid: PARENT_FID })

  const results = {} // slug → {shareUrl, fileFid, fileName}（writeMirrors 的输入）
  const failures = []
  let attempted = 0
  let succeeded = 0

  /** 单包重试 1 次；仍失败记入清单继续跑。 */
  async function attempt(slug, fn) {
    attempted++
    let lastErr = null
    for (let i = 0; i < 2; i++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = String(err?.message ?? err).slice(0, 300)
        if (i === 0) {
          await sleep(5000)
          console.log(`[${slug}] 第 1 次失败（${lastErr}），重试…`)
        }
      }
    }
    failures.push({ slug, phase: 'sync', error: lastErr, attempts: 2 })
    console.log(`[${slug}] 重试后仍失败 ✗：${lastErr}`)
    return null
  }

  // 上传 + 建链：按 --upload-batch 分组，每组一次 CLI 上传、逐包建链。
  let done = 0
  const uploadItems = picked.filter((x) => !x.fid)
  for (const group of chunk(uploadItems, UPLOAD_BATCH)) {
    let outs = []
    try {
      outs = uploadBatch(group)
    } catch (err) {
      // 整批连目录都建不出来（多半是登录态过期）—— 记失败继续，别炸掉整轮
      const msg = String(err?.message ?? err).slice(0, 300)
      console.log(`[批上传] 整批失败：${msg}`)
      for (const w of group) {
        attempted++
        failures.push({ slug: w.slug, phase: 'upload', error: msg, attempts: 1 })
      }
      continue
    }
    for (const o of outs) {
      done++
      attempted++
      if (o.shareUrl) {
        succeeded++
        results[o.slug] = { shareUrl: o.shareUrl, fileFid: o.fileFid ?? '', fileName: o.fileName ?? '' }
        console.log(`[${o.slug}] 上传+建链 ✓ ${o.shareUrl}（${done}/${uploadItems.length}）`)
      } else {
        failures.push({ slug: o.slug, phase: 'upload', error: o.error ?? '未知错误', attempts: 1 })
        console.log(`[${o.slug}] 失败 ✗：${o.error ?? '未知错误'}（${done}/${uploadItems.length}）`)
      }
    }
    await sleep(DEFAULT_RATE_LIMIT_MS)
  }

  // 补链分批限速：--batch 个一批，批间 --delay。
  const relinkTargets = picked.filter((x) => !!x.fid)
  const batches = chunk(relinkTargets, BATCH)
  for (let b = 0; b < batches.length; b++) {
    if (b > 0 && DELAY > 0) {
      console.log(`[建链] 批间休眠 ${DELAY}ms（第 ${b + 1}/${batches.length} 批前）`)
      await sleep(DELAY)
    }
    for (const w of batches[b]) {
      const out = await attempt(w.slug, () => shareByFid(QUARK_CLI, cwd, w.fid, w.slug))
      if (out) {
        succeeded++
        results[w.slug] = { shareUrl: out, fileFid: w.fid, fileName: w.filename }
        console.log(`[${w.slug}] 补链 ✓ ${out}`)
      }
    }
  }

  // 歧义与缺包也记入失败清单（可审计），但不算 attempted。
  for (const a of plan.ambiguous.filter((a) => pickedSlugs.has(a.slug))) {
    failures.push({ slug: a.slug, phase: 'ambiguous', error: `同 slug 网盘多条：${a.names.join(' / ')}`, attempts: 0 })
  }

  writeMirrors(results)
  writeFileSync(FAILURES_FILE, `${JSON.stringify(appendFailures(readFailures(), failures), null, 2)}\n`)

  console.log(`\n同步结束：尝试 ${attempted}，成功 ${succeeded}，失败 ${failures.length}（详见 research/quark-sync-failures.json）`)

  if (isTotalFailure(attempted, succeeded)) {
    console.log('::error::本轮工作项全部失败：常见原因是登录态过期（QUARK_CONFIG_JSON）或 CLI 环境异常。')
    process.exitCode = 1
  }
}

function readFailures() {
  try {
    return JSON.parse(readFileSync(FAILURES_FILE, 'utf8'))
  } catch {
    return { updatedAt: null, failures: [] }
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((err) => {
    console.log(`::error::夸克同步失败：${String(err?.message ?? err).slice(0, 400)}`)
    process.exitCode = 1
  })
}
