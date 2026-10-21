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
 * 用法：
 *   node scripts/translate-local.mjs --limit 20                 # 先跑 20 个试水
 *   node scripts/translate-local.mjs --limit 0                  # 全部（0 = 不限）
 *   node scripts/translate-local.mjs --layout separate --lanes 24
 *   node scripts/translate-local.mjs --slug some-pack,other      # 只重翻指定的包
 *   node scripts/translate-local.mjs --dry-run                  # 只看清单
 *
 * 环境变量：
 *   CF_KEY          CurseForge API key（下载解包必需）
 *   BATCH_PUSH_EVERY 每处理多少个包 commit+push 一次（默认 20；0 = 从不）
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { translatePackParallel, DEFAULT_LANES } from './translate-parallel.mjs'
import { LAYOUT } from './lib/candidates.mjs'

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
 * @param {{slugs?: string[]}} [batch]
 * @returns {string[]}
 */
export function stagedPathsForBatch({ slugs = [] } = {}) {
  const paths = ['patches/', 'downloads/', 'site/data.json', 'glossary.json', 'research/index-dataset.json']
  const seen = new Set()
  for (const slug of slugs) {
    const s = String(slug ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    paths.push(`research/packs/${s}/`)
  }
  return paths
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

  const scanFile = existsSync(SCAN_FILE) ? SCAN_FILE : SCAN_FALLBACK
  if (!existsSync(scanFile)) throw new Error(`找不到扫描结果：${SCAN_FILE}`)
  console.log(`扫描结果 ${scanFile}`)

  const all = pickTranslatable(readFileSync(scanFile, 'utf8'), { platform: platform || undefined, layout: layout || undefined })
  const state = loadState()

  // `--slug` 直接给清单，跳过 limit/platform/layout 筛选，也不看已完成状态。
  // 为什么需要：要重翻的那个包常常排在下载量后面、或者已经标了 done，
  // 用 `--limit N` 只能从队头取，会顺带把前面 N-1 个包一起重跑。
  const explicit = typeof slugArg === 'string'
    ? slugArg.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  const pending = pendingWorklist(ROOT, all, state, explicit)
  const d = describeWorklist(ROOT, all, state, explicit)
  const worklist = explicit.length
    ? explicit.map((slug) => all.find((p) => p.slug === slug) ?? { slug, platform, layout, bytes: 0 })
    : (limit > 0 ? pending.slice(0, limit) : pending)

  console.log(`平台 ${platform || '全部'}：可翻译 ${d.total} 个，已完成 ${d.done} 个，本次处理 ${worklist.length} 个，${lanes} 路并发`)
  if (dryRun) {
    worklist.slice(0, 30).forEach((p, i) => console.log(`${String(i + 1).padStart(4)}. ${p.slug} (${p.layout}, ${(p.bytes / 1048576).toFixed(0)}MB)`))
    if (worklist.length > 30) console.log(`… 另有 ${worklist.length - 30} 个`)
    return
  }

  let ok = 0
  let fail = 0
  let sincePush = 0
  // 本轮已成功处理的 slug：入库时只暂存它们的英文源，别捎上别人的未跟踪目录。
  let sincePushSlugs = []

  for (let i = 0; i < worklist.length; i++) {
    const p = worklist[i]
    const tag = `[${i + 1}/${worklist.length}] ${p.slug}`
    const started = Date.now()
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
      // 3) 写回补丁
      const w = await writePatch(p.slug, r.layout, runId)
      if (!w || w.translated === 0) throw new Error('没有产出任何译文')
      state.done[p.slug] = { layout: p.layout, files: w.files, translated: w.translated, total: w.total, at: new Date().toISOString(), ms: Date.now() - started }
      delete state.failed[p.slug]
      saveState(state)
      ok++
      sincePush++
      sincePushSlugs.push(p.slug)
      const secs = Math.round((Date.now() - started) / 1000)
      console.log(`${tag} done ${secs}s · ${w.translated}/${w.total} 条译文 · ${w.files} 个文件 · 漏译 ${r.missing}`)
    } catch (e) {
      const msg = String(e?.message ?? e).slice(0, 300)
      state.failed[p.slug] = { layout: p.layout, at: new Date().toISOString(), error: msg }
      saveState(state)
      fail++
      console.log(`${tag} FAILED: ${msg}`)
    }
    // 中间产物清理：**只删并行翻译的块文件，不删英文源**。
    //
    // `research/packs/<slug>` 是 `validate-quests.mjs` 的**基准键集**。
    // 删了它，闸门就只会打一行「找不到英文源，跳过该条」——
    // 实测：11 个包里 9 个被跳过校验，等于零质检（假绿灯）。
    //
    // 代价是占磁盘，但英文源只抽 .snbt（几 MB 级），不是整包（几百 MB）。
    const parDir = join(ROOT, 'research/par-out', p.slug)
    if (existsSync(parDir)) rmSync(parDir, { recursive: true, force: true })

    if (pushEvery > 0 && sincePush >= pushEvery) {
      console.log(`--- 入库：${sincePush} 个包 ---`)
      try {
        // 显式路径暂存（禁止 git add -A）：-A 会把 research/packs/ 下 20 多个未跟踪
        // 目录连同任何未跟踪文件一起提交。只认本轮产物 + 站点/索引/术语数据。
        for (const sp of stagedPathsForBatch({ slugs: sincePushSlugs })) {
          if (existsSync(join(ROOT, sp))) run('git', ['add', '--', sp])
        }
        run('git', ['commit', '-q', '-m', `data(translate): 本地并行翻译 ${sincePush} 个整合包`])
        run('git', ['push', '-q', 'origin', 'HEAD:main'])
        sincePush = 0
        sincePushSlugs = []
      } catch (e) {
        console.log(`入库失败（不中断整批）：${String(e?.message ?? e).slice(0, 200)}`)
      }
    }
  }

  console.log(`\n=== 完成：ok ${ok} / failed ${fail} / 共 ${worklist.length} ===`)
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
