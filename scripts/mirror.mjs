#!/usr/bin/env node
/**
 * 网盘镜像（工单 04）：把已产出的补丁包 zip（downloads/<slug>.zip）上传夸克网盘，
 * 创建永久公开分享，并把分享链接写回 research/quark-mirrors.json。
 *
 * 设计原则（与光影站 scripts/mirror.mjs 一致）：
 * 1. **wrapper，不改 CLI 本体** —— 只做子进程调用 quark-drive.cjs。
 * 2. **绝不伪造链接** —— 拿不到真实 share_url 就写空字符串（`quark: ''`），
 *    详情页因此不渲染夸克按钮。
 * 3. **失败不阻断发布** —— 单条上传/分享失败只让该条留空，进程不因镜像失败退出非 0
 *    （除非 QUARK_REQUIRED=1 且全部失败，见收尾判红）。
 * 4. **幂等** —— 目录名固定（同名自动复用），已有分享链接的条目直接跳过，不重复上传。
 * 5. **逐条串行 + 限流** —— 每条之间 sleep，避免触发网盘风控。
 *
 * 用法：
 *   node scripts/mirror.mjs                处理 downloads/ 下所有「尚无分享链接」的 zip
 *   node scripts/mirror.mjs --ids a,b      只处理指定 slug
 *   node scripts/mirror.mjs --dry-run      只打印计划，不调用 CLI、不写文件
 *
 * 环境变量：
 *   QUARK_CLI           quark-drive.cjs 路径（缺失则跳过夸克，全部留空）
 *   QUARK_REQUIRED      设为 1 表示本轮必须有夸克：有目标待镜像而 QUARK_CLI 缺失时退出码 1
 *   QUARK_DIR_NAME      网盘目标目录名，默认「任务书汉化」（同名幂等，自动复用）
 *
 * 测试：runMirror() 核心可注入 upload 桩，不联网、不真上传。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DOWNLOADS_DIR = join(ROOT, 'downloads')
export const MIRRORS_FILE = join(ROOT, 'research/quark-mirrors.json')

export const DEFAULT_RATE_LIMIT_MS = 300

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 核心（可注入，测试用桩） ----------

/**
 * 串行镜像一批补丁包。逐条处理，每条之间限流。
 *
 * @param {object} options
 * @param {Array<{slug: string, zipPath: string}>} options.targets 待镜像条目
 * @param {Record<string, string>} [options.existing] 已有分享链接（slug → url），有链接的直接跳过
 * @param {(slug: string, zipPath: string) => Promise<string>} options.upload
 *        上传并创建分享，返回真实 share_url；失败应抛错
 * @param {number} [options.rateLimitMs] 每条之间的间隔
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{results: Record<string,string>, attempted: number, succeeded: number, skipped: number, failed: number}>}
 */
export async function runMirror({ targets, existing = {}, upload, rateLimitMs = DEFAULT_RATE_LIMIT_MS, log = () => {} }) {
  const results = {}
  let attempted = 0, succeeded = 0, skipped = 0, failed = 0

  for (let i = 0; i < targets.length; i++) {
    const { slug, zipPath } = targets[i]
    const prev = existing[slug]
    if (prev) {
      results[slug] = prev
      skipped++
      log(`[${slug}] 已有分享链接，跳过（幂等）：${prev}`)
      continue
    }
    if (!existsSync(zipPath)) {
      results[slug] = ''
      log(`[${slug}] 找不到 ${zipPath}，跳过（字段留空）`)
      continue
    }
    attempted++
    let url = ''
    try {
      url = await upload(slug, zipPath)
      if (typeof url !== 'string' || !url) throw new Error('upload 未返回真实 share_url')
      succeeded++
      log(`[${slug}] 夸克 ✓ ${url}`)
    } catch (err) {
      // 失败不阻断：字段留空（绝不伪造链接）
      url = ''
      failed++
      log(`[${slug}] 夸克 ✗ ${String(err.message || err).slice(0, 200)}`)
    }
    results[slug] = url
    if (i < targets.length - 1) await sleep(rateLimitMs)
  }

  return { results, attempted, succeeded, skipped, failed }
}

/** 读取已写回的镜像链接（不存在时返回空对象）。 */
export function readMirrors(file = MIRRORS_FILE) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const out = {}
    for (const [slug, v] of Object.entries(raw.mirrors ?? raw)) {
      if (typeof v === 'string') out[slug] = v
      else if (v && typeof v.shareUrl === 'string') out[slug] = v.shareUrl
    }
    return out
  } catch {
    return {}
  }
}

/** 写回镜像链接（保留 updatedAt 等 meta 结构）。 */
export function writeMirrors(results, file = MIRRORS_FILE, { now = new Date().toISOString() } = {}) {
  let base = { updatedAt: now, mirrors: {} }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    base = { updatedAt: raw.updatedAt ?? now, mirrors: raw.mirrors ?? raw }
  } catch { /* 新文件 */ }
  for (const [slug, url] of Object.entries(results)) {
    const prev = base.mirrors[slug]
    if (url) {
      base.mirrors[slug] = { shareUrl: url, updatedAt: now }
    } else if (!prev) {
      // 失败条目：只在没有历史链接时登记空占位，绝不伪造
      base.mirrors[slug] = { shareUrl: '', updatedAt: now }
    }
  }
  writeFileSync(file, JSON.stringify({ updatedAt: now, mirrors: base.mirrors }, null, 2) + '\n')
}

// ---------- 夸克 CLI 调用（仅 CLI 主流程使用） ----------

/** 执行一个 CLI 调用并解析其 JSONL 输出，返回 result 行的 data。 */
function quarkCall(cli, args, cwd) {
  const stdout = execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let result = null
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const obj = JSON.parse(t)
      if (obj && obj.type === 'result') result = obj
    } catch { /* 非 JSON 行忽略 */ }
  }
  if (!result) throw new Error(`CLI 未输出 result 行：${stdout.slice(-300)}`)
  if (result.code !== 0) throw new Error(`CLI 返回 code ${result.code}: ${result.msg ?? ''}`)
  return result.data ?? {}
}

/** 业务桩注入点：测试替换 makeUploader 而不触碰 quark CLI。 */
function makeUploader(cli, dirName, cwd) {
  let dirFid = null
  return async (slug, zipPath) => {
    if (!dirFid) {
      // 同名目录幂等：CLI 侧自动复用已有目录，重复跑不产生重复目录
      const d = quarkCall(cli, ['create-folder', '--dir-path', dirName], cwd)
      if (!d.fid) throw new Error(`create-folder 未返回 fid`)
      dirFid = d.fid
    }
    const up = quarkCall(cli, ['upload', zipPath, '--parent-fid', dirFid], cwd)
    const fileFid = (up.fids ?? [])[0]
    if (!fileFid) throw new Error('upload 未返回 fids')
    // url-type 1 = 公开链接，expired-type 1 = 永久有效
    const sh = quarkCall(cli, ['share', fileFid, '--title', `${slug} 任务书汉化补丁`, '--url-type', '1', '--expired-type', '1'], cwd)
    if (!sh.share_url) throw new Error('share 未返回 share_url')
    return sh.share_url
  }
}

// ---------- CLI ----------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const idsArg = args.indexOf('--ids')
  const IDS = idsArg >= 0 ? (args[idsArg + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean) : []

  const QUARK_CLI = process.env.QUARK_CLI
  const QUARK_REQUIRED = process.env.QUARK_REQUIRED === '1'
  const DIR_NAME = process.env.QUARK_DIR_NAME || '任务书汉化'

  // 待镜像目标：downloads/ 下的 zip；全量模式只取「尚无分享链接」的（幂等）
  const existing = readMirrors()
  const all = existsSync(DOWNLOADS_DIR)
    ? readdirSync(DOWNLOADS_DIR).filter(n => n.endsWith('.zip')).map(n => n.slice(0, -4))
    : []
  const slugs = IDS.length ? IDS : all.filter(s => !existing[s])
  const targets = slugs.map(slug => ({ slug, zipPath: join(DOWNLOADS_DIR, `${slug}.zip`) }))

  if (!targets.length) {
    console.log('没有需要镜像的条目')
    process.exit(0)
  }

  const quarkUnavailable = QUARK_REQUIRED && !QUARK_CLI
  if (!QUARK_CLI) {
    console.log(`[夸克] QUARK_CLI 未配置：跳过夸克镜像，${targets.length} 个目标字段留空（不阻断发布）。`)
  } else {
    console.log(`镜像 ${targets.length} 个补丁包到夸克（目录「${DIR_NAME}」）`)
  }
  if (dryRun) {
    for (const t of targets) console.log(`  [dry-run] ${t.slug} ← ${t.zipPath}${existing[t.slug] ? '（已有链接，将跳过）' : ''}`)
    process.exit(0)
  }

  const upload = QUARK_CLI ? makeUploader(QUARK_CLI, DIR_NAME, ROOT) : null
  const { results, attempted, succeeded } = await runMirror({
    targets,
    existing,
    upload: upload ?? (async () => { throw new Error('QUARK_CLI 未配置') }),
    log: (m) => console.log(m),
  })

  writeMirrors(results)
  console.log(`\n镜像结束：尝试 ${attempted}，成功 ${succeeded}，其余留空（site 数据经 build-site-data.mjs 合并 quark 字段）`)

  // 「有活要干却零链接」不能静默绿灯：CLI 缺失（QUARK_REQUIRED=1）或全部尝试失败时置红。
  if (quarkUnavailable) {
    console.log('::error::夸克镜像必须有但不可用（QUARK_CLI 未配置，通常是 CLI 下载/安装失败）。')
    process.exitCode = 1
  } else if (attempted > 0 && succeeded === 0) {
    console.log('::error::夸克镜像全部失败：常见原因是登录态过期（QUARK_CONFIG_JSON）或 CLI 环境异常。')
    process.exitCode = 1
  }
}
