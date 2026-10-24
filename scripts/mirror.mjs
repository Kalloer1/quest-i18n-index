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
 *   QUARK_PARENT_FID    目标目录的**父目录 fid**（选填）。传了就必须用：
 *                       CLI 文档写明「`--parent-fid` 不传时，文件夹会被建在服务端默认目录」，
 *                       而 CI 里解析那个默认目录会失败（`-602 文件浏览器实例不存在`）。
 *   WORKER_URL / INTERNAL_STATUS_TOKEN  配置时回写队列状态（成功→已完成，失败→镜像缺失）；
 *                       未配置时静默跳过，回写失败不阻断镜像。
 *
 * 测试：runMirror() 核心可注入 upload 桩，不联网、不真上传。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { STATUS } from '../shared/quest-status.mjs'
import { defaultReportStatus } from './lib/report-status.mjs'
import { slugFromZipName } from './build-index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DOWNLOADS_DIR = join(ROOT, 'downloads')
export const MIRRORS_FILE = join(ROOT, 'research/quark-mirrors.json')

/**
 * 已知 slug 全集：patches/ 的目录名就是 slug 的本地真源。
 * 用于 `slugFromZipName` 的「已知 slug 优先」判定，防 `a_v_something` 被误剥成 `a`。
 */
function knownSlugs() {
  const dir = join(ROOT, 'patches')
  return new Set(existsSync(dir) ? readdirSync(dir) : [])
}

/**
 * slug → 磁盘上的 zip 路径。两种形态都认：
 * 1. 旧名 `downloads/<slug>.zip`（精确）；
 * 2. 新名 `downloads/<slug>_v<version>.zip`（readdir 匹配，多份取字典序最后）。
 * 都找不到时返回旧名期望路径，让 runMirror 报「找不到补丁包」并留空（绝不伪造链接）。
 *
 * @param {string} slug
 * @param {string} [dir]
 * @returns {string}
 */
export function resolveZipPath(slug, dir = DOWNLOADS_DIR) {
  const exact = join(dir, `${slug}.zip`)
  if (existsSync(exact)) return exact
  if (!existsSync(dir)) return exact
  const hit = readdirSync(dir)
    .filter(n => n.endsWith('.zip') && n.startsWith(`${slug}_v`))
    .sort()
    .at(-1)
  return hit ? join(dir, hit) : exact
}

export const DEFAULT_RATE_LIMIT_MS = 300

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 回写队列状态：回写失败绝不阻断镜像主流程（镜像产物才是主要价值）。 */
async function safeReport(reportStatus, id, payload) {
  try {
    await reportStatus(id, payload)
  } catch { /* 回写失败不影响镜像结果 */ }
}

// ---------- 核心（可注入，测试用桩） ----------

/**
 * 串行镜像一批补丁包。逐条处理，每条之间限流。
 *
 * @param {object} options
 * @param {Array<{slug: string, zipPath: string}>} options.targets 待镜像条目
 * @param {Record<string, string>} [options.existing] 已有分享链接（slug → url），有链接的直接跳过
 * @param {Record<string, string>} [options.existingNames] 已记录在案的**网盘文件名**（slug → fileName）。
 *        只为跳过分支的 drift 检测服务：本地改名后网盘侧不会自动跟着变，这里只警告不改名
 *        （改名走 scripts/quark-rename.mjs，因为它要 fid，而这里只有 url）。
 * @param {(slug: string, zipPath: string) => Promise<string|{shareUrl: string, fileFid?: string, fileName?: string}>} options.upload
 *        上传并创建分享；返回 share_url 字符串，或带 fileFid/fileName 的对象（用于回写元数据）。
 *        失败应抛错
 * @param {number} [options.rateLimitMs] 每条之间的间隔
 * @param {(msg: string) => void} [options.log]
 * @param {(id: string, payload: object) => Promise<void>} [options.reportStatus]
 *        镜像结果回写队列状态：成功 → 已完成；失败/留空 → 镜像缺失（带原因）。
 *        默认不发请求（CLI 显式传 defaultReportStatus），回写失败不阻断镜像。
 * @returns {Promise<{results: Record<string,string|{shareUrl: string, fileFid?: string, fileName?: string}>, attempted: number, succeeded: number, skipped: number, failed: number}>}
 */
export async function runMirror({
  targets,
  existing = {},
  existingNames = {},
  upload,
  rateLimitMs = DEFAULT_RATE_LIMIT_MS,
  log = () => {},
  reportStatus = async () => {},
}) {
  const results = {}
  let attempted = 0, succeeded = 0, skipped = 0, failed = 0

  for (let i = 0; i < targets.length; i++) {
    const { slug, zipPath } = targets[i]
    const prev = existing[slug]
    if (prev) {
      results[slug] = prev
      skipped++
      log(`[${slug}] 已有分享链接，跳过（幂等）：${prev}`)
      // drift：网盘里那个文件的名字还停在「上传当时」的本地名上。
      // 只报警不改名 —— 改名要 fid，这里只有 url；纠正入口是 scripts/quark-rename.mjs。
      const recorded = existingNames[slug]
      const localName = zipPath ? basename(zipPath) : ''
      if (recorded && localName && recorded !== localName) {
        log(`::warning::[${slug}] 网盘名与本地名不一致：${recorded} ≠ ${localName}（用 quark-rename.mjs 纠偏）`)
      }
      await safeReport(reportStatus, slug, { status: STATUS.DONE, error: '' })
      continue
    }
    if (!existsSync(zipPath)) {
      results[slug] = ''
      log(`[${slug}] 找不到 ${zipPath}，跳过（字段留空）`)
      await safeReport(reportStatus, slug, { status: STATUS.DONE_UNMIRRORED, error: `找不到补丁包 ${zipPath}` })
      continue
    }
    attempted++
    let record = ''
    let errorMsg = ''
    try {
      const out = await upload(slug, zipPath)
      const url = typeof out === 'string' ? out : out?.shareUrl
      if (typeof url !== 'string' || !url) throw new Error('upload 未返回真实 share_url')
      // 字符串形态（老桩 / 老调用方）保持原样；对象形态带上元数据，供 writeMirrors 落盘。
      record = typeof out === 'string'
        ? url
        : { shareUrl: url, fileFid: out.fileFid ?? '', fileName: out.fileName ?? '' }
      succeeded++
      log(`[${slug}] 夸克 ✓ ${url}`)
    } catch (err) {
      // 失败不阻断：字段留空（绝不伪造链接）
      record = ''
      failed++
      errorMsg = String(err.message || err).slice(0, 200)
      log(`[${slug}] 夸克 ✗ ${errorMsg}`)
    }
    results[slug] = record
    await safeReport(reportStatus, slug, record
      ? { status: STATUS.DONE, error: '' }
      : { status: STATUS.DONE_UNMIRRORED, error: errorMsg })
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

/**
 * 读取完整记录（含 fileFid / fileName）。readMirrors 只给 url，drift 检测要文件名，
 * 所以另开一个读取口，不动 readMirrors 的返回形状（老调用方与测试都依赖它）。
 *
 * @returns {Record<string, {shareUrl: string, fileFid?: string, fileName?: string, updatedAt?: string}>}
 */
export function readMirrorRecords(file = MIRRORS_FILE) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const out = {}
    for (const [slug, v] of Object.entries(raw.mirrors ?? raw)) {
      if (typeof v === 'string') out[slug] = { shareUrl: v }
      else if (v && typeof v === 'object') out[slug] = v
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 写回镜像链接（保留 updatedAt 等 meta 结构）。
 *
 * 值可以是 url 字符串，也可以是 `{shareUrl, fileFid, fileName}`：
 * 后者把 fid / 文件名一起落盘，为 quark-rename.mjs（改名要有 fid，mirrors 里原本没有）
 * 和 drift 检测提供依据。本轮没拿到元数据时沿用历史值，不把已有字段抹掉。
 */
export function writeMirrors(results, file = MIRRORS_FILE, { now = new Date().toISOString() } = {}) {
  let base = { updatedAt: now, mirrors: {} }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    base = { updatedAt: raw.updatedAt ?? now, mirrors: raw.mirrors ?? raw }
  } catch { /* 新文件 */ }
  for (const [slug, value] of Object.entries(results)) {
    const url = typeof value === 'string' ? value : value?.shareUrl ?? ''
    const prev = base.mirrors[slug]
    const prevMeta = prev && typeof prev === 'object' ? prev : {}
    if (url) {
      const rec = { shareUrl: url }
      const fileFid = (typeof value === 'object' && value?.fileFid) || prevMeta.fileFid || ''
      const fileName = (typeof value === 'object' && value?.fileName) || prevMeta.fileName || ''
      if (fileFid) rec.fileFid = fileFid
      if (fileName) rec.fileName = fileName
      rec.updatedAt = now
      base.mirrors[slug] = rec
    } else if (!prev) {
      // 失败条目：只在没有历史链接时登记空占位，绝不伪造
      base.mirrors[slug] = { shareUrl: '', updatedAt: now }
    }
  }
  writeFileSync(file, JSON.stringify({ updatedAt: now, mirrors: base.mirrors }, null, 2) + '\n')
}

// ---------- 夸克 CLI 调用（仅 CLI 主流程使用） ----------

/** 从 CLI 的 JSONL 输出里取 `type:"result"` 行。 */
function parseResultLine(stdout) {
  let result = null
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const obj = JSON.parse(t)
      if (obj && obj.type === 'result') result = obj
    } catch { /* 非 JSON 行忽略 */ }
  }
  return result
}

/**
 * 执行一个 CLI 调用并解析其 JSONL 输出，返回 result 行的 data。
 *
 * 失败时**必须把 stdout 的 result 行与 stderr 都带进错误信息**：
 * 夸克 CLI 失败时是非零退出，`execFileSync` 于是抛 `Command failed: …` 且**不带 stdout**，
 * 而真正的错误码（如 `-602 文件浏览器实例不存在`）在 stdout 的 result 行里。
 * 实跑 run 39166450472 的日志就只剩一句被截断的
 * `[ERROR][FileBrowserManager] createFo…`，完全无法定位。
 *
 * 导出给 quark-sync.mjs 复用（建链 / browse 同一套调用与错误透传，不复制一份）。
 */
export function quarkCall(cli, args, cwd) {
  let stdout
  try {
    stdout = execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    const parsed = parseResultLine(err.stdout)
    const detail = parsed
      ? `code ${parsed.code}: ${parsed.msg ?? ''}`
      : String(err.stdout ?? '').trim().slice(-300) || '（无 stdout）'
    const errOut = String(err.stderr ?? '').trim().slice(-300)
    throw new Error(`quark-drive ${args[0]} 失败（${detail}）${errOut ? ` | stderr: ${errOut}` : ''}`)
  }
  const result = parseResultLine(stdout)
  if (!result) throw new Error(`CLI 未输出 result 行：${stdout.slice(-300)}`)
  if (result.code !== 0) throw new Error(`CLI 返回 code ${result.code}: ${result.msg ?? ''}`)
  return result.data ?? {}
}

/**
 * 业务桩注入点：测试替换 makeUploader 而不触碰 quark CLI。
 *
 * @param {string} cli quark-drive.cjs 路径
 * @param {string} dirName 目标目录名
 * @param {string} cwd 子进程工作目录
 * @param {{parentFid?: string, call?: typeof quarkCall}} [opts] `QUARK_PARENT_FID`：目标目录的父目录 fid。
 *        传了就必须用——CLI 文档写明「`--parent-fid` 不传时，文件夹会被建在服务端默认目录」，
 *        而 CI 里解析那个默认目录会失败（`-602 文件浏览器实例不存在`）。
 *        旧代码把它当空气（workflow 一直在传，脚本从未读），是 D6 的直接成因之一。
 *        `call` 是可注入缝（测试用，不真的调 CLI）。
 */
export function makeUploader(cli, dirName, cwd, { parentFid = '', call = quarkCall } = {}) {
  let dirFid = null
  return async (slug, zipPath) => {
    if (!dirFid) {
      // 同名目录复用：CLI 侧对已存在目录返回其 fid（文档「创建文件夹」一节：
      // 「同名文件夹重复创建时具有幂等性，返回已有文件夹的 FID」）。
      // 注意：**这个幂等性只在能解析出父目录时成立**——所以 parentFid 必须传下去。
      const args = ['create-folder', '--dir-path', dirName]
      if (parentFid) args.push('--parent-fid', parentFid)
      const d = call(cli, args, cwd)
      if (!d.fid) throw new Error(`create-folder 未返回 fid`)
      dirFid = d.fid
    }
    const up = call(cli, ['upload', zipPath, '--parent-fid', dirFid], cwd)
    const fileFid = (up.fids ?? [])[0]
    if (!fileFid) throw new Error('upload 未返回 fids')
    // url-type 1 = 公开链接，expired-type 1 = 永久有效
    const sh = call(cli, ['share', fileFid, '--title', `${slug} 任务书汉化补丁`, '--url-type', '1', '--expired-type', '1'], cwd)
    if (!sh.share_url) throw new Error('share 未返回 share_url')
    // 返回元数据而不只是 url：fileFid / fileName 要落进 quark-mirrors.json，
    // 后面纠偏网盘文件名（scripts/quark-rename.mjs）时才不用猜是哪个文件。
    return { shareUrl: sh.share_url, fileFid, fileName: basename(zipPath) }
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
  // 目标目录的父目录 fid。workflow 一直在传，旧代码从未读（D6 成因之一）。
  const PARENT_FID = process.env.QUARK_PARENT_FID || ''

  // 待镜像目标：downloads/ 下的 zip；全量模式只取「尚无分享链接」的（幂等）。
  // 文件名可能是旧名 `<slug>.zip` 或新名 `<slug>_v<version>.zip`，统一反解成 slug。
  const existing = readMirrors()
  // drift 检测要的是「记录在案的网盘文件名」，readMirrors 只给 url，另读一次完整记录。
  const existingNames = Object.fromEntries(
    Object.entries(readMirrorRecords()).map(([slug, rec]) => [slug, rec.fileName ?? '']),
  )
  const known = knownSlugs()
  const all = existsSync(DOWNLOADS_DIR)
    ? [...new Set(readdirSync(DOWNLOADS_DIR)
        .filter(n => n.endsWith('.zip'))
        .map(n => slugFromZipName(n.slice(0, -4), known)))]
    : []
  const slugs = IDS.length ? IDS : all.filter(s => !existing[s])
  const targets = slugs.map(slug => ({ slug, zipPath: resolveZipPath(slug) }))

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

  const upload = QUARK_CLI ? makeUploader(QUARK_CLI, DIR_NAME, ROOT, { parentFid: PARENT_FID }) : null
  const { results, attempted, succeeded } = await runMirror({
    targets,
    existing,
    existingNames,
    upload: upload ?? (async () => { throw new Error('QUARK_CLI 未配置') }),
    log: (m) => console.log(m),
    reportStatus: defaultReportStatus,
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
