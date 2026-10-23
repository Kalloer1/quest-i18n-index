#!/usr/bin/env node
/**
 * 夸克网盘文件名纠偏：把 `整合包汉化/` 里的 zip 改成与 downloads/ 一致的「带版本号」文件名。
 *
 * 为什么需要它：mirror.mjs 上传时用的是「当时 downloads/ 里的 basename」（resolveZipPath），
 * 历史上大部分包上传时还叫 `<slug>.zip`；后来本地改名成 `<slug>_v<version>.zip`，
 * 网盘侧就永久停在了旧名上。已有 593 个文件，人工点不过来。
 *
 * 为什么是「改名」而不是「重传」：share 的入参是 fid（见 mirror.mjs 的 makeUploader），
 * 改名不换 fid，已经发出去的分享链接继续有效；重传会换 fid，等于把全部链接废掉。
 *
 * 为什么不能按「顺序 / 大小」猜对应关系：research/quark-mirrors.json 里只有 shareUrl，
 * 没有 fileFid / fileName。只能把**远端文件名**反解成 slug（slugFromZipName，与
 * build-index / mirror 同一套规则），再用本地 slug 的期望名去比对。
 *
 * 用法：
 *   node scripts/quark-rename.mjs --dry                 只打印统计与前 10 条对照，不改名
 *   node scripts/quark-rename.mjs --dry --limit 5       只看差异的前 5 条
 *   node scripts/quark-rename.mjs --limit 1 --verify    试点一条，改完立刻校验分享链接
 *   node scripts/quark-rename.mjs --limit 0 --verify    整批（0 = 全部）
 *
 * 环境变量（与 mirror.mjs 完全一致）：
 *   QUARK_CLI        quark-drive.cjs 路径；缺失时打印 warning 并 exit 0（本地跑不该炸）
 *   QUARK_DIR_NAME   网盘目标目录名，默认「整合包汉化」（同名 create-folder 幂等，返回已有 fid）
 *   QUARK_PARENT_FID 目标目录的父目录 fid（不传会把目录建到服务端默认目录，CI 里会 -602）
 *
 * 安全边界：
 * 1. **幂等**：名字已一致的不进批次，不产生任何写操作。
 * 2. **可回滚**：每一批的 fid → {oldName,newName,at} 追加写进 research/quark-renames.json，
 *    30 天内可用 `rename-revert --batch-id <id> --record-file <CLI 返回的 record_file>` 整批还原。
 * 3. **不猜**：远端找不到对应 slug 记 missing、同 slug 多个远端条目记 ambiguous，一律跳过不改。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { DOWNLOADS_DIR, readMirrors, resolveZipPath } from './mirror.mjs'
import { slugFromZipName } from './build-index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const RENAMES_FILE = join(ROOT, 'research/quark-renames.json')

// ---------- 纯逻辑（可注入，测试覆盖） ----------

/** 远端条目名：browse 的 Artifact 用 `filename`；兼容个别版本的其它写法。 */
function remoteName(item) {
  const n = item?.filename ?? item?.file_name ?? item?.fileName ?? item?.data?.filename
  return typeof n === 'string' ? n : ''
}

/** 远端条目 fid：Artifact 每行就是一个条目，但个别包装形态下会多一层 data。 */
function remoteFid(item) {
  const fid = item?.fid ?? item?.data?.fid
  return typeof fid === 'string' ? fid : ''
}

/**
 * 远端文件列表 → slug 索引。一个 slug 可能对应多个远端条目（历史重传过），
 * 这种条目在 buildRenamePlan 里判为 ambiguous，绝不擅自挑一个。
 *
 * 只认 `.zip`：目标目录里其余都是文件夹或残留文件，改名它们没有意义。
 *
 * @param {Array<{fid: string, filename?: string}>} files
 * @param {Set<string>|string[]|null} knownSlugs patches/ 的目录名，用于防止 `a_v_something` 被误剥
 * @returns {Map<string, Array<{fid: string, filename: string}>>}
 */
export function indexRemote(files, knownSlugs = null) {
  const bySlug = new Map()
  for (const item of files ?? []) {
    const fid = remoteFid(item)
    const name = remoteName(item)
    if (!fid || !name) continue
    if (!name.toLowerCase().endsWith('.zip')) continue
    const slug = slugFromZipName(name.slice(0, -4), knownSlugs)
    if (!bySlug.has(slug)) bySlug.set(slug, [])
    bySlug.get(slug).push({ fid, filename: name })
  }
  return bySlug
}

/**
 * 计算差异集。期望名由调用方注入（CLI 用 resolveZipPath 的 basename，测试用固定表）。
 *
 * @param {object} options
 * @param {string[]} options.slugs 本地 slug（downloads/ 反解得到）
 * @param {Array<{fid: string, filename?: string}>} options.files 远端条目
 * @param {(slug: string) => string} options.nameFor slug → 期望文件名；返回空串表示本地没有该包
 * @param {Record<string, string>} [options.shareUrls] slug → shareUrl，仅用于 --verify
 * @param {Set<string>|string[]|null} [options.knownSlugs]
 * @returns {{changes: Array<{slug: string, fid: string, oldName: string, newName: string, shareUrl: string}>,
 *            unchanged: number, missing: string[], ambiguous: Array<{slug: string, names: string[]}>, noLocal: string[]}}
 */
export function buildRenamePlan({ slugs, files, nameFor, shareUrls = {}, knownSlugs = null }) {
  const bySlug = indexRemote(files, knownSlugs)
  const changes = []
  const missing = []
  const ambiguous = []
  const noLocal = []
  let unchanged = 0

  for (const slug of slugs ?? []) {
    const expected = nameFor(slug)
    if (!expected) {
      noLocal.push(slug)
      continue
    }
    const candidates = bySlug.get(slug) ?? []
    if (candidates.length === 0) {
      missing.push(slug)
      continue
    }
    if (candidates.length > 1) {
      ambiguous.push({ slug, names: candidates.map((c) => c.filename) })
      continue
    }
    const current = candidates[0]
    if (current.filename === expected) {
      unchanged++
      continue
    }
    changes.push({
      slug,
      fid: current.fid,
      oldName: current.filename,
      newName: expected,
      shareUrl: shareUrls[slug] ?? '',
    })
  }

  return { changes, unchanged, missing, ambiguous, noLocal }
}

/** `--limit N`：N 为 0 / 非法 / 负数时表示全部；否则取前 N 条（试点用 1）。 */
export function applyLimit(changes, limit) {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return changes
  return changes.slice(0, n)
}

/** 差异集 → rename 命令的 items 文件内容（schema 见 file-rename.md）。 */
export function makeItems(changes) {
  return {
    schema_version: 1,
    items: (changes ?? []).map((c) => ({ fid: c.fid, old_name: c.oldName, new_name: c.newName })),
  }
}

/** 一批改名 → 回滚记录（fid → oldName/newName/at，外加 batchId 供 rename-revert）。 */
export function makeRenameRecord({ batchId, changes, at, data = {} }) {
  const items = {}
  for (const c of changes ?? []) {
    items[c.fid] = { slug: c.slug, oldName: c.oldName, newName: c.newName, at }
  }
  return {
    batchId,
    at,
    result: {
      total: data.total ?? null,
      success: data.success_count ?? null,
      fail: data.fail_count ?? null,
      status: data.result_status ?? null,
    },
    items,
  }
}

/**
 * 追加一个批次记录（只增不改：旧批次是 30 天内回滚的唯一依据）。
 *
 * @param {object|null} prev 现有的 quark-renames.json 内容
 * @param {object} batch makeRenameRecord 的产物
 * @param {string} [now]
 */
export function appendRenameBatch(prev, batch, now = new Date().toISOString()) {
  const base = prev && Array.isArray(prev.batches) ? prev : { updatedAt: null, batches: [] }
  return { updatedAt: now, batches: [...base.batches, batch] }
}

/** share-detail 的返回是否算「链接还活着」：能列出至少一个文件即视为可访问。 */
export function isShareAlive(data) {
  if (!data || typeof data !== 'object') return false
  if (Array.isArray(data.files) && data.files.length > 0) return true
  const num = data.share_info?.file_num
  return typeof num === 'number' && num > 0
}

/** 读取回滚记录（不存在时返回空批次表）。 */
export function readRenames(file = RENAMES_FILE) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && Array.isArray(raw.batches) ? raw : { updatedAt: null, batches: [] }
  } catch {
    return { updatedAt: null, batches: [] }
  }
}

// ---------- 可注入的写操作（测试用假 call，不碰真实 CLI） ----------

/**
 * 提交一个 rename 批次。
 *
 * @param {object} options
 * @param {Array<{fid: string, oldName: string, newName: string}>} options.changes
 * @param {(cli: string, args: string[], cwd: string) => object} options.call CLI 调用桩
 * @param {string} options.cli
 * @param {string} options.cwd
 * @param {string} options.itemsFile items JSON 的**绝对**路径（CLI 要求）
 * @param {string} options.batchId 16 位十六进制
 * @param {string} [options.at]
 */
export function renameRemote({ changes, call, cli, cwd, itemsFile, batchId, at = new Date().toISOString() }) {
  writeFileSync(itemsFile, `${JSON.stringify(makeItems(changes), null, 2)}\n`)
  const data = call(cli, ['rename', '--batch-id', batchId, '--items-file', itemsFile], cwd)
  return { batchId, at, data: data ?? {} }
}

/**
 * 逐个用 shareUrl 调 share-detail，判定改名后链接是否仍可访问。
 * 没有 shareUrl 的条目不猜、不阻塞，单独计成 unverified。
 *
 * @returns {{ok: number, total: number, failed: string[], unverified: number}}
 */
export function verifyShares({ changes, call, cli, cwd, log = () => {}, retries = 2, gapMs = 1200, sleep = (ms) => execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`]) }) {
  const targets = (changes ?? []).filter((c) => c.shareUrl)
  const failed = []
  const flaky = [] // 重试后成功：说明是限流而不是真断
  let ok = 0
  let first = true
  for (const c of targets) {
    // 连续 589 次 share-detail 会触发限流，间隔一下比"改判红规则"更根本。
    if (!first && gapMs) sleep(gapMs)
    first = false
    let alive = false
    let lastErr = null
    for (let i = 0; i <= retries; i++) {
      try {
        const data = call(cli, ['share-detail', '--url', c.shareUrl], cwd)
        if (isShareAlive(data)) { alive = true; break }
        lastErr = 'share-detail 无文件列表'
      } catch (err) {
        lastErr = String(err?.message ?? err).slice(0, 160)
      }
      if (i < retries) sleep(5000 * (i + 1))
    }
    if (alive) {
      ok++
      if (lastErr) { flaky.push(c.slug); log(`[${c.slug}] 重试后可访问 ✓（首发失败：${lastErr.slice(0, 60)}）`) }
      else log(`[${c.slug}] 链接可访问 ✓ ${c.shareUrl}`)
    } else {
      failed.push(c.slug)
      log(`[${c.slug}] 链接不可访问 ✗ ${c.shareUrl}（${String(lastErr).slice(0, 120)}）`)
    }
  }
  return { ok, total: targets.length, failed, flaky, unverified: (changes ?? []).length - targets.length }
}

// ---------- CLI 调用（照 mirror.mjs 的 quarkCall 写法） ----------

/** CLI 输出是 JSONL：逐行解析，非 JSON 行忽略。 */
function parseJsonLines(stdout) {
  const out = []
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      out.push(JSON.parse(t))
    } catch { /* 非 JSON 行忽略 */ }
  }
  return out
}

function lastOfType(lines, type) {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]?.type === type) return lines[i]
  return null
}

/**
 * 执行一次 CLI 调用，返回 `{data, lines}`。
 *
 * 失败时把 stdout 的 result 行与 stderr 一起塞进错误信息：夸克 CLI 失败是非零退出，
 * execFileSync 抛错时不带 stdout，而真正的错误码在 result 行里（同 mirror.mjs 的踩坑记录）。
 */
function callRaw(cli, args, cwd) {
  let stdout
  try {
    stdout = execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    const lines = parseJsonLines(err.stdout)
    const result = lastOfType(lines, 'result')
    const detail = result
      ? `code ${result.code}: ${result.msg ?? ''}`
      : String(err.stdout ?? '').trim().slice(-300) || '（无 stdout）'
    const errOut = String(err.stderr ?? '').trim().slice(-300)
    throw new Error(`quark-drive ${args[0]} 失败（${detail}）${errOut ? ` | stderr: ${errOut}` : ''}`)
  }
  const lines = parseJsonLines(stdout)
  const result = lastOfType(lines, 'result')
  if (!result) throw new Error(`CLI 未输出 result 行：${String(stdout).slice(-300)}`)
  if (result.code !== 0) throw new Error(`CLI 返回 code ${result.code}: ${result.msg ?? ''}`)
  return { data: result.data ?? {}, lines }
}

const call = (cli, args, cwd) => callRaw(cli, args, cwd).data

// ---------- 主流程 ----------

function argValue(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? '') : ''
}

/** patches/ 的目录名即 slug 真源，用于 slugFromZipName 的「已知 slug 优先」。 */
function knownSlugs() {
  const dir = join(ROOT, 'patches')
  return new Set(existsSync(dir) ? readdirSync(dir) : [])
}

/** downloads/ 下的 zip → 去重后的 slug 列表（与 mirror.mjs 的反解规则一致）。 */
function localSlugs(known) {
  if (!existsSync(DOWNLOADS_DIR)) return []
  const slugs = readdirSync(DOWNLOADS_DIR)
    .filter((n) => n.endsWith('.zip'))
    .map((n) => slugFromZipName(n.slice(0, -4), known))
  return [...new Set(slugs)].sort()
}

/**
 * browse 目标目录，拿全部直接子项。
 *
 * 为什么必须读 Artifact 而不是 result：`browse` 的 `result.data.file_list` 只给最多 5 条预览，
 * 完整结果写在 `artifact.data.file_path` 指向的 JSONL 里（file-ops.md / file-search.md）。
 * 目录 593 个文件，只读预览等于什么都没看到。
 */
function browseDir(cli, dirFid, cwd) {
  const { data, lines } = callRaw(cli, ['browse', '--parent-fid', dirFid, '--all'], cwd)
  const artifact = lastOfType(lines, 'artifact')
  const filePath = artifact?.data?.file_path
  if (!filePath) throw new Error('browse 未返回 artifact 文件路径（无法确认拿到了全量清单）')
  if (!existsSync(filePath)) throw new Error(`browse 的 artifact 文件不存在：${filePath}`)
  const files = []
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      files.push(JSON.parse(t))
    } catch { /* 忽略坏行 */ }
  }
  return { files, count: data.count ?? files.length }
}

/**
 * 定位目标目录的 fid：先试 create-folder（同名幂等），失败再按名字在父目录里找。
 *
 * 为什么不能只靠 create-folder：实测它在「目录已存在」时会返回
 * `code 1007: 创建操作失败`，而不是像文档说的返回已有 fid —— 试点成功后紧接着
 * 跑整批就直接炸在这里。重试 + 按名查找两条兜底，比赌一个未文档化的行为可靠。
 */
function resolveDirFid(cli, dirName, parentFid, cwd) {
  const folderArgs = ['create-folder', '--dir-path', dirName]
  if (parentFid) folderArgs.push('--parent-fid', parentFid)
  for (let i = 1; i <= 3; i++) {
    try {
      const r = call(cli, folderArgs, cwd)
      if (r?.fid) return r.fid
    } catch (e) {
      console.log(`::warning::create-folder 第 ${i} 次失败：${String(e?.message || e).split('\n')[0].slice(0, 120)}`)
      // 同步睡眠：这个脚本主体是同步流程，用 Atomics.wait 比拿子进程当 sleep 干净。
      if (i < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, i * 3000)
    }
  }
  // 兜底：父目录里按名字找文件夹。字段名在 CLI 的不同版本里叫法不一，逐个试。
  const parent = parentFid || '0'
  const { files } = browseDir(cli, parent, cwd)
  const nameOf = (f) => f.filename ?? f.file_name ?? f.name ?? ''
  const hit = files.find((f) => nameOf(f) === dirName)
  if (hit?.fid) {
    console.log(`[目录] create-folder 失败，按名字找到已有目录 fid=${hit.fid}`)
    return hit.fid
  }
  throw new Error(`无法定位网盘目录「${dirName}」：create-folder 三次失败，且父目录里没有同名项`)
}

async function main() {
  const args = process.argv.slice(2)
  const dry = args.includes('--dry')
  const verify = args.includes('--verify')
  const verifyOnly = args.includes('--verify-only')
  const LIMIT = argValue(args, '--limit')

  const QUARK_CLI = process.env.QUARK_CLI || ''
  const DIR_NAME = process.env.QUARK_DIR_NAME || '整合包汉化'
  const PARENT_FID = process.env.QUARK_PARENT_FID || ''

  if (!QUARK_CLI || !existsSync(QUARK_CLI)) {
    console.log(`::warning::QUARK_CLI 未配置或不存在（${QUARK_CLI || '空'}）：跳过网盘改名。本机没有 CLI 时这是正常情况。`)
    process.exit(0)
  }

  const known = knownSlugs()
  const slugs = localSlugs(known)
  const mirrors = readMirrors()
  const work = mkdtempSync(join(tmpdir(), 'quark-rename-'))

  // 只校验：拿回滚记录里每一批改过的 slug，重新确认分享链接是否还能打开。
  // 为什么需要它：整批 589 条改完后有 117 条被判"不可访问"，但那是**连续 589 次**
  // share-detail 的结果，很可能混着限流。不复查就回滚/重传，是在拿数据赌。
  if (verifyOnly) {
    // 目标来源有两个：优先用登记过的失败清单（仓库里的文件，可审计），
    // 其次才是本次工作区的改名记录 —— 后者不进 git，新 checkout 里恒为 0 批，
    // 第一次跑就是这样空转的（"改名批次共 0 批"）。
    const targetsFile = 'research/quark-verify-targets.txt'
    let uniq = []
    if (existsSync(targetsFile)) {
      uniq = readFileSync(targetsFile, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean)
        .map((slug) => ({ slug, shareUrl: mirrors[slug] || '' }))  // readMirrors() 直接就是 slug→url 字符串
    } else {
      const { batches } = readRenames()
      const changed = []
      for (const b of batches) for (const [fid, it] of Object.entries(b.items ?? {})) changed.push({ slug: it.slug, fid, shareUrl: mirrors[it.slug] || '' })
      uniq = [...new Map(changed.map((c) => [c.slug, c])).values()]
    }
    console.log(`[校验] 目标 ${uniq.length} 个 slug（来源：${existsSync(targetsFile) ? targetsFile : '改名记录'}），逐个复查（含重试与间隔）`)
    const v = verifyShares({ changes: uniq, call, cli: QUARK_CLI, cwd: work, log: (m) => console.log(m) })
    // research/tmp 是 gitignore 的临时目录，CI 的干净 checkout 里不存在 ——
    // 第一次复查就是死在 ENOENT 上（校验一条都没跑）。先建目录，且写报告失败不能拖垮校验。
    if (!dry) {
      try {
        mkdirSync('research/tmp', { recursive: true })
        writeFileSync('research/tmp/quark-verify.json', `${JSON.stringify({ at: new Date().toISOString(), ...v }, null, 1)}\n`)
      } catch (e) {
        console.log(`::warning::校验报告写盘失败（不影响结论）：${e.message}`)
      }
    }
    console.log(`[校验] 可访问 ${v.ok}/${v.total}，重试后恢复 ${v.flaky.length}，仍失败 ${v.failed.length}`)
    // 失败清单必须**全量**落到日志：报告文件在 research/tmp（gitignore），CI 里随沙箱消失，
    // 而这是「哪些链接要重传」的唯一依据。原来只打前 40 条，116 条目标里其余部分就永久丢了。
    for (let i = 0; i < v.failed.length; i += 40) {
      const chunk = v.failed.slice(i, i + 40)
      const head = i === 0 ? `::error::重试后仍不可访问 ${v.failed.length} 条` : '::error::（续）'
      console.log(`${head}：${chunk.join(', ')}`)
    }
    if (v.failed.length) {
      console.log(`[校验] 失败清单共 ${v.failed.length} 条，已逐条写入 research/tmp/quark-verify.json`)
    }
    process.exit(v.failed.length ? 1 : 0)
  }

  // 目录 fid：create-folder 号称同名幂等，但实测第二次调用会以 `1007 创建操作失败`
  // 被拒（试点成功、3 分钟后的整批就炸了）。所以：先重试几次，仍失败就退回
  // 「列父目录按名字找」——两者都失败才报错，不能因为建目录失败就整个放弃。
  const dirFid = resolveDirFid(QUARK_CLI, DIR_NAME, PARENT_FID, work)

  const { files, count } = browseDir(QUARK_CLI, dirFid, work)
  const nameFor = (slug) => {
    const p = resolveZipPath(slug, DOWNLOADS_DIR)
    return existsSync(p) ? basename(p) : ''
  }
  const plan = buildRenamePlan({ slugs, files, nameFor, shareUrls: mirrors, knownSlugs: known })
  const picked = applyLimit(plan.changes, LIMIT)

  console.log(`[规划] 本地 ${slugs.length} 个 slug / 远端 ${count} 个条目`)
  console.log(
    `[规划] 需改名 ${plan.changes.length}，已一致 ${plan.unchanged}，远端缺失 ${plan.missing.length}，` +
      `同 slug 多条 ${plan.ambiguous.length}，本地无包 ${plan.noLocal.length}`,
  )
  if (LIMIT && Number(LIMIT) > 0) console.log(`[规划] --limit ${LIMIT}：本轮实际处理 ${picked.length} 条`)
  for (const s of plan.missing.slice(0, 10)) console.log(`  缺失：${s}（网盘里没有对应 slug 的 zip）`)
  for (const a of plan.ambiguous.slice(0, 10)) console.log(`  歧义：${a.slug}（${a.names.join(' / ')}）`)
  if (plan.changes.length === 0) {
    console.log('网盘文件名已与本地一致，无需改名（幂等）。')
    process.exit(0)
  }
  if (dry) {
    for (const c of picked.slice(0, 10)) console.log(`  ${c.oldName} → ${c.newName}`)
    console.log(`[dry] 未调用 rename，未改任何文件。`)
    process.exit(0)
  }

  const batchId = randomBytes(8).toString('hex')
  const itemsFile = join(work, 'rename-items.json')
  const renamed = renameRemote({ changes: picked, call, cli: QUARK_CLI, cwd: work, itemsFile, batchId })

  const record = makeRenameRecord({ batchId, changes: picked, at: renamed.at, data: renamed.data })
  writeFileSync(RENAMES_FILE, `${JSON.stringify(appendRenameBatch(readRenames(), record), null, 2)}\n`)
  console.log(
    `[改名] 批次 ${batchId}：提交 ${picked.length} 条，服务端 total=${record.result.total ?? '—'} ` +
      `success=${record.result.success ?? '—'} fail=${record.result.fail ?? '—'}`,
  )
  console.log(`[改名] 回滚依据已追加到 research/quark-renames.json（30 天内可 rename-revert）`)
  console.log(`[改名] CLI 的 record_file 见上一步 result 行；后续回滚需要它和 batchId ${batchId}`)

  if (!verify) return

  const v = verifyShares({ changes: picked, call, cli: QUARK_CLI, cwd: work, log: (m) => console.log(m) })
  console.log(`verified ${v.ok}/${v.total}`)
  if (v.unverified) console.log(`::warning::${v.unverified} 条没有历史分享链接，无法校验（不影响本次改名）`)
  if (v.failed.length) {
    console.log(`::error::改名后分享链接不可访问 ${v.failed.length} 条：${v.failed.join(', ')}`)
    process.exitCode = 1
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((err) => {
    console.log(`::error::夸克改名失败：${String(err?.message ?? err).slice(0, 400)}`)
    process.exitCode = 1
  })
}
