#!/usr/bin/env node
/**
 * 本地批量流水线：下载解包 → 并行翻译 → 写回补丁 → 打包 → 定期入库。
 *
 * ## 为什么要有它
 *
 * ADR-0009 的 U2/U3 裁决是「CI 只负责构建部署，翻译走本机」。
 * 但本机跑一次要敲 4 条命令 + 一堆 env，漏一条就静默降级 ——
 * 这正是 D7/D9 反复咬人的模式。把顺序固化成脚本，等于把踩过的坑锁死。
 *
 * ## 与 translate-batch.mjs 的区别
 *
 * `translate-batch.mjs` 调的是串行 `pipeline.mjs`（CI 时代写的，单包跑完再下一个）。
 * 本脚本调 `translate-parallel.mjs`（包内 24 路并发，一条文本一个请求）。
 *
 * ## 关键设计
 *
 * - **断点续跑**：每包完成立刻写 `research/local-batch-state.json`，中断重跑自动跳过。
 * - **按下载量顺序**：`scan-full.tsv` 本身就是按 index=downloads 抓的，原序即排序。
 * - **先分离后内嵌**：分离格式已实测零漏译；内嵌格式刚修好，放后面观察。
 * - **每 N 包入库**：避免一整天跑完才第一次 push，中断损失最小。
 * - **处理完即删 research/packs/<slug>**：它是中间产物，占磁盘且可重建。
 *
 * ## farm 模式（`--farm`，跑在别人的主机上）
 *
 * 三台 serv00 主机各自跑一段，产物推到自己分支 `farm/<host>`，**永不 push main**
 * （由 `.github/workflows/farm-merge.yml` 统一取增量、过闸门、合 main）。与非 farm 的区别：
 *
 * - 入库路径只有 `patches/<slug>/` + `research/packs/<slug>.tar.gz`，不碰 downloads/site/术语；
 * - 英文源目录先用 `packBaseline` 打成 tar.gz（可复现、几十 MB → 几 MB），**打包成功才删目录**；
 * - 推送失败 `exit 3` 并停机（不停机会把几 GB 产物堆在别人的磁盘上）；
 * - 磁盘不足先清中间产物，仍不足 `exit 4`。
 *
 * 用法：
 *   node scripts/translate-local.mjs --limit 20                 # 先跑 20 个试水
 *   node scripts/translate-local.mjs --limit 0                  # 全部（0 = 不限）
 *   node scripts/translate-local.mjs --layout separate --lanes 24
 *   node scripts/translate-local.mjs --slug some-pack,other      # 只重翻指定的包
 *   node scripts/translate-local.mjs --dry-run                  # 只看清单
 *   node scripts/translate-local.mjs --farm --slug-file research/shards/gfdrgfd.txt --lanes 8
 *
 * 环境变量：
 *   CF_KEY          CurseForge API key（下载解包必需）
 *   BATCH_PUSH_EVERY 每处理多少个包 commit+push 一次（默认 20；0 = 从不）
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, statSync, statfsSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { translatePackParallel, DEFAULT_LANES } from './translate-parallel.mjs'
import { LAYOUT } from './lib/candidates.mjs'
import { packBaseline } from './lib/baseline.mjs'
import { commitAndPush } from './lib/farm-git.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_FILE = join(ROOT, 'research/scan-full.tsv')
const SCAN_FALLBACK = join(ROOT, 'research/scan-2k.tsv')
const STATE_FILE = join(ROOT, 'research/local-batch-state.json')
const PACKS_DIR = join(ROOT, 'research/packs')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) return true
  return /^-?\d+$/.test(v) ? Number(v) : v
}

/**
 * 从扫描 TSV 挑出可翻译的包，按下载量降序（TSV 原序）。
 *
 * 筛选口径与 `translate-parallel.mjs` 的 listTranslatable 一致，但多两个维度：
 * 平台（CF 才有 downloadUrl 能力）与布局（先分离后内嵌）。
 *
 * @param {string} text
 * @param {{platform?: string, layout?: string}} [opts]
 * @returns {Array<{slug:string, platform:string, layout:string, bytes:number}>}
 */
export function pickTranslatable(text, { platform, layout } = {}) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return []
  const header = lines[0].split('\t')
  const idx = Object.fromEntries(header.map((c, i) => [c, i]))
  for (const col of ['platform', 'slug', 'bytes', 'format', 'newZh']) {
    if (!(col in idx)) throw new Error(`扫描 TSV 缺列：${col}`)
  }
  const PRODUCIBLE = new Set([LAYOUT.SEPARATE_DIR, LAYOUT.SEPARATE_SINGLE, LAYOUT.EMBEDDED])
  const rows = []
  for (const line of lines.slice(1)) {
    const f = line.split('\t')
    const fmt = f[idx.format]
    if (!PRODUCIBLE.has(fmt)) continue
    // 自带中文的包没有翻译价值（本站产出会覆盖掉作者译文）。
    if (Number(f[idx.newZh]) > 0) continue
    const plat = f[idx.platform]
    if (platform && plat !== platform) continue
    if (layout === 'separate' && !/^separate-/.test(fmt)) continue
    if (layout === 'embedded' && fmt !== LAYOUT.EMBEDDED) continue
    rows.push({ slug: f[idx.slug], platform: plat, layout: fmt, bytes: Number(f[idx.bytes]) || 0 })
  }
  return rows
}

/**
 * 算出一轮入库该暂存的显式路径（仓库相对，目录带尾斜杠）。
 *
 * ## 为什么不能 `git add -A`
 *
 * 跑大批量翻译时 `research/packs/` 下会堆 20 多个未跟踪目录（本脚本刚解出来的英文源），
 * `-A` 会把它们连同任何未跟踪文件一起提交、push 到 main。
 * 已实测踩坑：`research/par-out/` 的中间块、本机临时缓存都被卷进过一次提交。
 *
 * 口径与 `release.mjs` 的「显式路径暂存（禁止 git add -A）」一致：
 * 站点消费的是 `downloads/*.zip`，`patches/` 只是产出输入；而闸门要本轮包的英文源
 * 做基准键集，所以 `research/packs/<slug>/` 必须显式带上，别的包不能顺手捎上。
 *
 * ## farm 模式为什么完全是另一张表
 *
 * farm 主机跑的是同一份仓库，但 downloads/site/索引/术语都是**本机各自生成**的产物：
 * 三台各推一份必然冲突，而它们全由 CI 从 `patches/` 重算得出来。所以 farm 只推
 * 「只有这台主机才有的东西」：译文补丁 + 该包的基准源归档（`<slug>.tar.gz`，
 * `research/packs/<slug>/` 目录本身永不入库）。
 *
 * @param {{slugs?: string[], farm?: boolean}} [batch]
 * @returns {string[]}
 */
export function stagedPathsForBatch({ slugs = [], farm = false } = {}) {
  const seen = new Set()
  const uniq = []
  for (const slug of slugs) {
    const s = String(slug ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    uniq.push(s)
  }
  if (farm) return uniq.flatMap((s) => [`patches/${s}/`, `research/packs/${s}.tar.gz`])

  const paths = ['patches/', 'downloads/', 'site/data.json', 'glossary.json', 'research/index-dataset.json']
  for (const s of uniq) paths.push(`research/packs/${s}/`)
  return paths
}

// ---------- farm 模式的磁盘护栏 ----------
//
// 主机侧最容易死得难看的一种：翻译本身正常，但磁盘写满后 prepare-pack 解包失败、
// gzip 写入半截文件，报错看起来像「网络/翻译有问题」，人反复重跑还是同一个错。
// 所以每包开始前查一次剩余空间，不够就先清中间产物，仍不够就带着明细退出。

/** 剩余空间下限：500 MB。低于它时解包 + 打包的临时写都可能失败。 */
export const MIN_FREE_BYTES = 500 * 1024 * 1024

/**
 * `statfsSync` 结果 → 可用字节数（纯函数，便于测）。
 * `bavail` 是「非特权用户可用块数」，比 `bfree` 更保守（对 root 保留块也当成不可用）。
 *
 * @param {{bavail?: number|bigint, bsize?: number|bigint}} st
 * @returns {number}
 */
export function freeBytesFromStatfs(st) {
  return Number(st?.bavail ?? 0) * Number(st?.bsize ?? 0)
}

/** 目录占用字节数（递归）；读不到的条目按 0 计，不让护栏自己把脚本搞崩。 */
export function dirBytes(dir) {
  let total = 0
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const full = join(dir, e.name)
    try {
      if (e.isDirectory()) total += dirBytes(full)
      else total += statSync(full).size
    } catch { /* 统计失败不影响结论 */ }
  }
  return total
}

/** 清空目录下的所有子项（保留目录本身）。 */
function rmChildren(dir) {
  let freed = 0
  let entries
  try { entries = readdirSync(dir) } catch { return 0 }
  for (const name of entries) {
    const full = join(dir, name)
    freed += dirBytes(full)
    rmSync(full, { recursive: true, force: true })
  }
  return freed
}

/**
 * farm 模式每包开始前的磁盘检查。
 *
 * 清理顺序刻意从「最没用」到「还有用」：
 *   1. `research/par-out/*` —— 本轮分片，已经写进 `patches/` 了；
 *   2. `research/tmp/*`     —— prepare-pack 的解包临时目录（本来就是垃圾）；
 *   3. `research/packs/<slug>/` —— **只删已经有 `<slug>.tar.gz` 的**（已打成归档、已提交过），
 *      没打档的目录是下一轮接着翻的依据，删了要重下。
 *
 * 仍不足就打印占用明细并 `exit 4`：这时候继续跑必然在解包中途写坏，不如停下等人清盘。
 *
 * @param {{root?: string, minBytes?: number, log?: Function, exit?: Function}} [opts]
 * @returns {{free: number, reclaimed: number}}
 */
export function farmDiskGuard({
  root = ROOT,
  minBytes = MIN_FREE_BYTES,
  log = console.log,
  exit = (code) => process.exit(code),
} = {}) {
  const freeAt = () => freeBytesFromStatfs(statfsSync(root))
  let free = freeAt()
  if (free >= minBytes) return { free, reclaimed: 0 }

  const mb = (n) => `${(n / 1048576).toFixed(0)}MB`
  log(`磁盘剩余 ${mb(free)} < ${mb(minBytes)}，清理中间产物后重试`)
  let reclaimed = 0
  reclaimed += rmChildren(join(root, 'research/par-out'))
  reclaimed += rmChildren(join(root, 'research/tmp'))

  const packsDir = join(root, 'research/packs')
  let names = []
  try { names = readdirSync(packsDir) } catch { names = [] }
  for (const name of names) {
    if (!name.endsWith('.tar.gz')) continue
    const slug = name.slice(0, -'.tar.gz'.length)
    const dir = join(packsDir, slug)
    if (!existsSync(dir)) continue
    reclaimed += dirBytes(dir)
    rmSync(dir, { recursive: true, force: true })
  }

  free = freeAt()
  log(`清理后剩余 ${mb(free)}（回收约 ${mb(reclaimed)}）`)
  if (free >= minBytes) return { free, reclaimed }

  log('磁盘仍然不足，占用明细：')
  for (const rel of ['research/packs', 'research/par-out', 'research/tmp', 'downloads', 'patches']) {
    log(`  ${rel.padEnd(18)} ${mb(dirBytes(join(root, rel)))}`)
  }
  log(`  ${'剩余可用'.padEnd(18)} ${mb(free)}`)
  log('需要人工清理（或删掉已无用的 downloads 下的 zip）后重新启动')
  exit(4)
  return { free, reclaimed }
}

// ---------- 分片运行标识（ADR-0009 D11） ----------
//
// `writePatch` 曾经无过滤地按 `^chunk-\d+\.json$` 读盘，没有时间戳、没有 run-id。
// 实测（2026-10-20）：`research/par-out/ftb-evolution/` 有 216 个 `chunk-NNNN.failed.json`，
// 该正则对它们全部不匹配（侥幸安全，靠文件名巧合）；但「没有普通分片」与
// 「分片还没翻完」都产出全空补丁且不报警；一旦同目录留下上一轮的普通分片，
// 正则无法分辨，会静默混入旧译文。
//
// 现在每轮翻译产出的分片文件名带 `.<runId>.`，`mergeShards` 只合并本轮的分片。

/**
 * 生成本轮的唯一标识。
 * 时间戳在前（目录里按名字排序即按时间排序，便于人看），随机后缀防同一毫秒碰撞。
 * @returns {string}
 */
export function newRunId() {
  return `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}

/**
 * 某个分片文件名是否属于本轮、且不是失败标记。
 * @param {string} name
 * @param {string} runId
 * @returns {boolean}
 */
export function isCurrentRunShard(name, runId) {
  const n = String(name ?? '')
  if (!runId) return false
  if (!n.endsWith(`.${runId}.json`)) return false
  return /^chunk-\d+\.[^.]+\.json$/.test(n)
}

/**
 * 从 `par-out/<slug>/` 里只合并**本轮**的分片。
 *
 * 返回 `foundAnyShard` 让调用方分清两种零结果：
 *   - `shards === 0 && foundAnyShard === false` → 目录里一个分片都没有（翻译没写盘）；
 *   - `shards === 0 && foundAnyShard === true`  → 有分片，但都不属于本轮（遗留物）。
 * 两者都应该让调用方抛错，但原因不同，日志里要能看出来。
 *
 * @param {string} dir
 * @param {string} runId
 * @returns {{translations: Map<string,string>, shards: number, foundAnyShard: boolean}}
 */
export function mergeShards(dir, runId) {
  const translations = new Map()
  if (!existsSync(dir)) return { translations, shards: 0, foundAnyShard: false }
  const names = readdirSync(dir)
  const foundAnyShard = names.some((f) => /^chunk-\d+\..+\.json$/.test(f) || /^chunk-\d+\.json$/.test(f))
  let shards = 0
  for (const f of names) {
    if (!isCurrentRunShard(f, runId)) continue
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    if (d.runId !== runId) continue
    d.keys.forEach((k, i) => {
      const v = d.outs[i]
      if (typeof v === 'string') translations.set(k, v)
    })
    shards++
  }
  return { translations, shards, foundAnyShard }
}

/** 读状态；损坏时当空状态（最坏只重翻几包）。 */
export function loadState(file = STATE_FILE) {
  if (!existsSync(file)) return { done: {}, failed: {} }
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    return { done: s.done ?? {}, failed: s.failed ?? {} }
  } catch { return { done: {}, failed: {} } }
}

/** 原子写状态。 */
export function saveState(state, file = STATE_FILE) {
  writeFileSync(file, JSON.stringify(state, null, 1) + '\n')
}

/**
 * 「这个包翻过没有」——**看产物实况，不看 state 文件**。
 *
 * ## 为什么不能只信 state
 *
 * 2026-10-21 实测：serv00 跑完 72 个包，产物全在 `patches/<slug>/`，
 * 但 `research/local-batch-state.json` 在 `.gitignore` 里（几 KB 的耗时统计，
 * 跟着 git 走会把每次翻译都变成一次提交冲突）。换台机器重跑时 state 里一个都没有，
 * 72 个包会被整体重翻 —— 含 `tensura-waka-edition` 这种要 25 分钟的。
 *
 * 产物则天然跨机：`patches/<slug>/` 必须入库才能发布，`git clone` 下来就在。
 * 所以判定权威是产物，state 只当本机的耗时统计与失败记录。
 *
 * 注意只认 `patches/`：`research/packs/<slug>/` 是**英文源**，
 * 它存在只说明下载过，不说明翻过（内嵌包还会因为布局判定失败留下半套源）。
 *
 * @param {string} root 仓库根
 * @param {string} slug 整合包 slug
 * @returns {boolean}
 */
export function isAlreadyTranslated(root, slug) {
  const dir = join(root, 'patches', slug)
  if (!existsSync(dir)) return false
  const walk = (d) => {
    let found = false
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) found = found || walk(join(d, e.name))
      else if (/\.snbt$/i.test(e.name)) found = true
      if (found) break
    }
    return found
  }
  return walk(dir)
}

/**
 * 算本次真正要翻的清单：`state.done` 与 `patches/<slug>/` 实况取并集。
 *
 * @param {string} root 仓库根
 * @param {Array<{slug: string}>} all 候选包
 * @param {{done?: object}} state 本机状态
 * @param {string[]} [explicit] 显式 slug 清单（给了就不看已完成状态）
 * @returns {Array<object>}
 */
export function pendingWorklist(root, all, state, explicit = []) {
  if (explicit.length) return all.filter((p) => explicit.includes(p.slug))
  const done = state?.done ?? {}
  return all.filter((p) => !done[p.slug] && !isAlreadyTranslated(root, p.slug))
}

/**
 * 日志用的三个数字。**`done` 不受显式清单影响**。
 *
 * 2026-10-21 实测踩到：给了 `--slug one-pack` 后日志打出
 * 「可翻译 1649 个，已完成 1648 个」—— 因为 `pendingWorklist` 在显式清单下只返回那 1 个，
 * `all.length - pending.length` 就成了 1648。这个数字有出处但口径错，
 * 与「交接误判产物丢失」是同一类错误（数字对不上真实现状）。
 *
 * @param {string} root
 * @param {Array<{slug: string}>} all
 * @param {{done?: object}} state
 * @param {string[]} [explicit]
 * @returns {{total: number, done: number, selected: number}}
 */
export function describeWorklist(root, all, state, explicit = []) {
  const doneMap = state?.done ?? {}
  const done = all.filter((p) => doneMap[p.slug] || isAlreadyTranslated(root, p.slug)).length
  const selected = pendingWorklist(root, all, state, explicit).length
  return { total: all.length, done, selected }
}

const run = (cmd, args, env = {}) => execFileSync(cmd, args, {
  cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env },
})

/**
 * 算出调 `prepare-pack` 的参数（纯函数，便于测）。
 *
 * 为什么抽出来：2026-10-21 踩到的坑是「开关做了但没接到调用方」——
 * `prepare-pack` 已经支持 `--quest-files-only`，但 `translate-local` 调它时没传，
 * 于是批量仍在整包下载（346 包 ≈ 14.8 GB），而只取语言文件只要约 67 MB。
 * 这种错误只有把参数构造本身变成可测对象才能拦住。
 *
 * `embedded` 刻意**不**开 Range：内嵌包必须拿到全部 `chapters/*.snbt`
 * 才知道哪些有文本（atm10 是 82 个），逐个 Range 反而不如整包一次下完。
 *
 * @param {{slug: string, platform?: string, layout?: string}} pack
 * @returns {string[]}
 */
export function prepareArgsForBatch({ slug, platform, layout }) {
  const args = ['scripts/prepare-pack.mjs', '--ids', slug, '--no-keep-zip']
  if (platform === 'mr') args.push('--platform', 'mr')
  if (layout !== LAYOUT.EMBEDDED) args.push('--quest-files-only')
  return args
}

/** 把并行翻译的块合并写回 patches/<slug>/（复用 pipeline 的 buildOutputs）。 */
async function writePatch(slug, layout, runId) {
  const { loadPackUnits } = await import('./translate-parallel.mjs')
  const { buildOutputs } = await import('./lib/quest-files.mjs')
  const { extractPack, sourceFileNames } = await import('./lib/quest-files.mjs')
  const { readdirSync, statSync } = await import('node:fs')

  const packDir = join(PACKS_DIR, slug)
  if (!existsSync(packDir)) return null

  // 重新读源文件（与翻译时同一套布局判定）
  const listSnbt = (dir, base = dir) => {
    const out = []
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) out.push(...listSnbt(full, base))
      else if (/\.snbt$/i.test(name)) out.push(full.slice(base.length + 1).replace(/\\/g, '/'))
    }
    return out
  }
  const names = listSnbt(packDir).sort()
  const sourceNames = sourceFileNames(names, layout)
  const files = names.filter((n) => sourceNames.includes(n)).map((n) => ({ name: n, text: readFileSync(join(packDir, n), 'utf8') }))
  const pack = extractPack({ files, layout })

  // 读并行产出的块，拼成 key → 译文。
  //
  // 只合并**本轮**的分片（D11）：旧实现按 `^chunk-\d+\.json$` 无差别读盘，
  // 分不清「上一轮遗留」与「本轮产出」，一旦同目录留下旧分片就会静默混入旧译文。
  const outDir = join(ROOT, 'research/par-out', slug)
  if (!existsSync(outDir)) return null
  const { translations, shards, foundAnyShard } = mergeShards(outDir, runId)
  if (shards === 0) {
    // 「无分片」与「分片都不属于本轮」必须区分开来 —— 两者都不能当成功写空补丁。
    const why = foundAnyShard
      ? `只有不属于本轮（runId=${runId}）的遗留分片`
      : '目录里没有任何分片'
    throw new Error(`${slug}：${why}，拒绝写空补丁`)
  }

  const outputs = buildOutputs(pack, translations, { header: '# AI 初翻，未人工校对\n' })
  const patchDir = join(ROOT, 'patches', slug)
  for (const o of outputs) {
    const target = join(patchDir, o.name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, o.text)
  }
  // 上游版本记录跟着补丁走：`prepare-pack` 写在 `research/packs/<slug>/.source.json`，
  // 这里复制到 `patches/<slug>/.source.json`，由 farm 的 `git add -- patches/<slug>/`
  // 一并带上（按路径合并不冲突）。旧包没有这份文件时静默跳过。
  const sourceInfo = join(packDir, '.source.json')
  if (existsSync(sourceInfo)) {
    mkdirSync(patchDir, { recursive: true })
    copyFileSync(sourceInfo, join(patchDir, '.source.json'))
  }
  return { files: outputs.length, translated: translations.size, total: pack.units.length }
}

async function main() {
  const limit = arg('limit', 0)
  const lanes = arg('lanes', DEFAULT_LANES)
  const platform = arg('platform', 'cf')
  const layout = arg('layout', '')
  const slugArg = arg('slug', '')
  const dryRun = Boolean(arg('dry-run', false))
  const pushEvery = Number(arg('push-every', process.env.BATCH_PUSH_EVERY ?? 20))
  const farm = Boolean(arg('farm', false))
  const branch = String(arg('branch', `farm/${hostname()}`))
  const slugFileArg = arg('slug-file', '')
  const pushMinutes = Number(arg('push-minutes', 20))

  // `--slug-file`：544 个 slug 拼成一条 10KB 的 argv 在 FreeBSD 上不可靠
  // （不同内核/登录方式对单参数长度限制不一，超了是 `Argument list too long` 或静默截断）。
  // 文件里允许逗号、换行、空白混合分隔，方便人工追加。
  const explicitList = []
  if (typeof slugArg === 'string') explicitList.push(...slugArg.split(',').map((s) => s.trim()).filter(Boolean))
  if (typeof slugFileArg === 'string' && slugFileArg) {
    const file = isAbsolute(slugFileArg) ? slugFileArg : resolve(process.cwd(), slugFileArg)
    if (!existsSync(file)) throw new Error(`找不到 slug 清单：${file}`)
    explicitList.push(...readFileSync(file, 'utf8').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))
  }

  const scanFile = existsSync(SCAN_FILE) ? SCAN_FILE : SCAN_FALLBACK
  if (!existsSync(scanFile)) throw new Error(`找不到扫描结果：${SCAN_FILE}`)
  console.log(`扫描结果 ${scanFile}`)

  const all = pickTranslatable(readFileSync(scanFile, 'utf8'), { platform: platform || undefined, layout: layout || undefined })
  const state = loadState()

  // `--slug` 直接给清单，跳过 limit/platform/layout 筛选，也不看已完成状态。
  // 为什么需要：要重翻的那个包常常排在下载量后面、或者已经标了 done，
  // 用 `--limit N` 只能从队头取，会顺带把前面 N-1 个包一起重跑。
  const explicit = [...new Set(explicitList)]
  const pending = pendingWorklist(ROOT, all, state, explicit)
  const d = describeWorklist(ROOT, all, state, explicit)
  const worklist = explicit.length
    ? explicit.map((slug) => all.find((p) => p.slug === slug) ?? { slug, platform, layout, bytes: 0 })
    : (limit > 0 ? pending.slice(0, limit) : pending)

  console.log(`平台 ${platform || '全部'}：可翻译 ${d.total} 个，已完成 ${d.done} 个，本次处理 ${worklist.length} 个，${lanes} 路并发`)
  if (farm) console.log(`farm 模式：只推 ${branch}（每 ${pushEvery} 包 或 ${pushMinutes} 分钟，先到者）`)
  if (dryRun) {
    worklist.slice(0, 30).forEach((p, i) => console.log(`${String(i + 1).padStart(4)}. ${p.slug} (${p.layout}, ${(p.bytes / 1048576).toFixed(0)}MB)`))
    if (worklist.length > 30) console.log(`… 另有 ${worklist.length - 30} 个`)
    return
  }

  let ok = 0
  let fail = 0
  let noText = 0
  let sincePush = 0
  // 本轮已成功处理的 slug：入库时只暂存它们的英文源，别捎上别人的未跟踪目录。
  let sincePushSlugs = []
  // 上一次成功入库的时刻（farm 模式的 `--push-minutes` 用它算间隔）。
  let lastPushAt = Date.now()

  for (let i = 0; i < worklist.length; i++) {
    const p = worklist[i]
    const tag = `[${i + 1}/${worklist.length}] ${p.slug}`
    const started = Date.now()
    // 每包开始前查盘：解包 + 打包都要临时空间，写满后报的错全都长得像「翻译失败」。
    if (farm) farmDiskGuard({ root: ROOT })
    try {
      // 1) 下载解包
      //
      // `--quest-files-only`：只 Range 取任务书文件，不下载整包。
      // 实测（2026-10-21）41 个已解包包，`en_us.snbt` 合计 6.3 MB / 整包 1392 MB = **0.453%**。
      // 346 个待翻 separate 包只需约 384 次文件 Range / 67 MB，整包下载要 14.8 GB。
      // 它在 Range 失败时会自动回退整包，所以这里无条件开。
      //
      // `--no-keep-zip`：批量跑时不留 zip。zip 的唯一价值是「重新解包时不用再下载」，
      // 而 `research/packs/<slug>/` 下的 `.snbt` 一旦存在，prepare-pack 本来就跳过下载 ——
      // zip 再也用不上。实测 2026-10-20 积了 1.5 GB / 33 个，346 个包会再攒约 15 GB。
      const prepArgs = prepareArgsForBatch(p)
      run('node', prepArgs, { CF_KEY: process.env.CF_KEY ?? '' })
      // 2) 并行翻译
      // 每个包一份独立 runId：分片文件名带它，`writePatch` 只合并本轮的分片（D11）。
      const runId = newRunId()
      const r = await translatePackParallel(p.slug, { lanes, runId })
      // 真的没有可译文本 → 跳过，不当失败。
      //
      // 实测 2026-10-21（`onlymon`）：`en_us.snbt` 是 `{ }`，`chapters/*.snbt`
      // 里只有 `tasks`/`rewards`/`icon` 这类机械字段，一个 `title`/`subtitle`/
      // `description` 都没有 —— 这包就是没有文本可翻。旧行为在这里抛
      // 「没有产出任何译文」并计入 failed，既吓人又会每轮重试。
      // 记入 done 并带 `noText` 标记，下一轮不再重试，台账也能区分。
      if (!r.total) {
        state.done[p.slug] = {
          layout: r.layout, files: 0, translated: 0, total: 0,
          at: new Date().toISOString(), noText: true,
        }
        delete state.failed[p.slug]
        saveState(state)
        noText++
        console.log(`${tag} skipped · 没有可译文本（布局 ${r.layout}）`)
        continue
      }
      // 3) 写回补丁
      const w = await writePatch(p.slug, r.layout, runId)
      if (!w || w.translated === 0) throw new Error('没有产出任何译文')
      // farm 模式：英文源先打档，**打包成功才删目录**。
      //
      // 反过来（先删后打）在磁盘满 / 文件名过长时会同时丢掉「可重试的源」和「该有的归档」，
      // 只剩一份 patches 让 `validate-quests` 找不到基准键集 —— 正是那句
      // 「删了英文源，闸门假绿灯」的老坑。打档本身是幂等的（baseline.mjs 同输入同字节），
      // 重跑同一包不会产生无意义 diff。
      let packedNote = ''
      if (farm) {
        const packDir = join(PACKS_DIR, p.slug)
        const archive = join(PACKS_DIR, `${p.slug}.tar.gz`)
        try {
          const packed = packBaseline(packDir, archive)
          packedNote = ` · 基准源 ${packed.files} 个文件 ${(packed.bytes / 1048576).toFixed(1)}MB`
        } catch (err) {
          throw new Error(`打包基准源失败（保留 research/packs/${p.slug}/ 不删）：${String(err?.message ?? err).slice(0, 200)}`)
        }
        rmSync(packDir, { recursive: true, force: true })
      }
      state.done[p.slug] = { layout: p.layout, files: w.files, translated: w.translated, total: w.total, at: new Date().toISOString(), ms: Date.now() - started }
      delete state.failed[p.slug]
      saveState(state)
      ok++
      sincePush++
      sincePushSlugs.push(p.slug)
      const secs = Math.round((Date.now() - started) / 1000)
      console.log(`${tag} done ${secs}s · ${w.translated}/${w.total} 条译文 · ${w.files} 个文件 · 漏译 ${r.missing}${packedNote}`)
    } catch (e) {
      const msg = String(e?.message ?? e).slice(0, 300)
      state.failed[p.slug] = { layout: p.layout, at: new Date().toISOString(), error: msg }
      saveState(state)
      fail++
      console.log(`${tag} FAILED: ${msg}`)
    }
    // 中间产物清理：分片块文件永远删。
    //
    // 英文源目录 `research/packs/<slug>/` 非 farm 模式**保留**：它是 `validate-quests.mjs`
    // 的基准键集，删了闸门只会打一行「找不到英文源，跳过该条」（实测 11 个包里 9 个被跳过）。
    // 仓库已改约定「`research/packs/<slug>/` 只在本机、归档 `<slug>.tar.gz` 才入库」，
    // 所以 farm 模式的目录在打档之后、上面那段里就已经删掉了，这里不再重复。
    const parDir = join(ROOT, 'research/par-out', p.slug)
    if (existsSync(parDir)) rmSync(parDir, { recursive: true, force: true })

    const dueByCount = pushEvery > 0 && sincePush >= pushEvery
    // farm 模式再加一道时间闸：某个包翻 40 分钟时，光靠「20 包」可能一整天不入库。
    const dueByTime = farm && pushMinutes > 0 && sincePush > 0
      && Date.now() - lastPushAt >= pushMinutes * 60_000

    if (farm && (dueByCount || dueByTime)) {
      console.log(`--- 入库：${sincePush} 个包 → origin/${branch}（farm）---`)
      const res = commitAndPush({ root: ROOT, branch, slugs: sincePushSlugs, pushAttempts: 3 })
      lastPushAt = Date.now()
      if (res.ok) {
        sincePush = 0
        sincePushSlugs = []
      } else {
        // 不停机的话，产物会在这台主机的磁盘上无限堆积（每包几十 MB 的归档 + 补丁），
        // 最后以「磁盘满导致解包失败」的样子出现，看起来像翻译问题。
        console.error('')
        console.error(`!!! 推送失败（不是翻译失败）：origin/${branch}`)
        console.error(`!!! 产物都已提交在本地 HEAD，未推上去；本次已成功 ${ok} 个包`)
        console.error(`!!! 最后一次错误：${String(res.error ?? '').trim().split('\n').slice(-3).join(' / ').slice(0, 400)}`)
        console.error(`!!! 处理完远端问题后重跑同一条命令即可续推（不会重翻已完成的包）`)
        process.exitCode = 3
        break
      }
    } else if (!farm && dueByCount) {
      console.log(`--- 入库：${sincePush} 个包 ---`)
      // 非 farm 路径：口径与改 farm 之前逐字一致 —— 只暂存原有的显式清单、
      // 用原提交信息、只推一次 main、失败打一行继续。
      const res = commitAndPush({
        root: ROOT,
        branch: 'main',
        slugs: sincePushSlugs,
        pushAttempts: 1,
        fetch: false,
        // 显式路径暂存（禁止 git add -A）：-A 会把 research/packs/ 下 20 多个未跟踪
        // 目录连同任何未跟踪文件一起提交。只认本轮产物 + 站点/索引/术语数据。
        paths: stagedPathsForBatch({ slugs: sincePushSlugs }),
        message: `data(translate): 本地并行翻译 ${sincePush} 个整合包`,
        log: () => {},
      })
      if (res.ok) {
        sincePush = 0
        sincePushSlugs = []
      } else {
        console.log(`入库失败（不中断整批）：${String(res.error ?? '').slice(0, 200)}`)
      }
    }
  }

  console.log(`\n=== 完成：ok ${ok} / 无可译文本 ${noText} / failed ${fail} / 共 ${worklist.length} ===`)
  if (fail) {
    console.log('失败清单：')
    for (const p of worklist) {
      const f = state.failed[p.slug]
      if (f) console.log(`  ${p.slug}: ${f.error.slice(0, 100)}`)
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
