#!/usr/bin/env node
/**
 * farm 分支合并计划（纯函数核心 + 一个薄 CLI）。
 *
 * 背景：三台 serv00 主机各自把产物推到自己分支 farm/<host>，永不 push main；
 * 由 .github/workflows/farm-merge.yml 统一取增量、过闸门、打包、提交 main。
 * 本模块只回答一个问题：**这一次该从哪条分支、取哪些路径**。
 *
 * 输入（CLI --dir 目录下）：
 *   diff-<host>.txt    git diff --name-only --diff-filter=AM origin/main origin/farm/<host> -- patches research/packs
 *   times-<host>.json  { "<slug>": "<ISO 提交时间>" }，缺省时 CLI 自己跑 git log 补算
 *
 * 输出：
 *   { bySlug: Map<slug, {branch, patchPaths[], baselinePath|null}>,
 *     conflicts: [{slug, winning, losers[], reason}],
 *     skipped:   [{slug, branch, reason}] }
 *
 * 为什么冲突不判失败：三台主机跑的是同一批待翻译包时很容易撞车，
 * 判红只会让人反复手删分支；取提交更新的一份、把另一份记进 conflicts 就能自愈。
 * 裁决只在「合格候选」（patches 译文 + research/packs 基准源都齐）之间做：
 * 某台更新但缺基准源/缺译文时不参与竞争，免得把别台合格的那份挤掉。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

/** patches/<slug>/... 里 slug 是单段目录名；再深一层（lang/en_us.snbt）也算同一条目。 */
const PATCH_RE = /^patches\/([^/]+)\//
/** 基准源是单文件 tar.gz：research/packs/<slug>.tar.gz（slug 不含 /）。 */
const BASELINE_RE = /^research\/packs\/([^/]+)\.tar\.gz$/
/**
 * 主机名白名单：小写字母或数字开头，其后只允许小写字母、数字、连字符。
 * hosts 来自 workflow_dispatch 的文本输入，会拼进 `git checkout origin/farm/<host>`，
 * 必须先卡在这里，别让 `../` 或大写/下划线之类的值进到 git 参数或目录名里。
 */
const HOST_RE = /^[a-z0-9][a-z0-9-]*$/

/** 主机名是否合法（与 .github/workflows/farm-merge.yml 的 shell 校验保持同一套规则）。 */
export function isValidHost(name) {
  return HOST_RE.test(String(name ?? ''))
}

/**
 * 是否「合格候选」：既有 patches/<slug>/ 译文、又有 research/packs/<slug>.tar.gz 基准源。
 * 两个都齐才能过 validate-quests 的键集闸门并打出正确的 zip；缺一个就是不合格。
 */
export function isQualified(candidate) {
  const { patchPaths = [], baselinePath = null } = candidate ?? {}
  return Array.isArray(patchPaths) && patchPaths.length > 0 && Boolean(baselinePath)
}

/** 不合格候选缺什么 → 「<host> 缺基准源」/「<host> 缺补丁文件」，写进 skipped.reason 便于事后排障。 */
function describeShortfall(candidate) {
  const lacks = []
  if (!candidate.patchPaths.length) lacks.push('缺补丁文件')
  if (!candidate.baselinePath) lacks.push('缺基准源')
  return `${candidate.branch} ${lacks.join(' + ') || '缺译文与基准源'}`
}

/**
 * 把 diff --name-only 的输出切成路径数组。
 * 去空行、去重、保序（git 输出本身已排序）；顺手剥掉 git 给特殊路径加的外层引号。
 */
export function parseDiffPaths(text) {
  const out = []
  const seen = new Set()
  for (const raw of String(text ?? '').split('\n')) {
    const p = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/** 单条路径 → {slug, kind}；不属于 patches/ 或 research/packs/*.tar.gz 的返回 null。 */
export function classifyPath(path) {
  const p = String(path ?? '')
  const patch = PATCH_RE.exec(p)
  if (patch) return { slug: patch[1], kind: 'patch' }
  const base = BASELINE_RE.exec(p)
  if (base) return { slug: base[1], kind: 'baseline' }
  return null
}

/**
 * 一条分支的 diff 文本 → Map<slug, {patchPaths[], baselinePath|null}>（按 slug 字典序）。
 * patchPaths 内部也排序，方便测试逐字断言。
 */
export function collectBranchPaths(text) {
  const acc = new Map()
  for (const path of parseDiffPaths(text)) {
    const hit = classifyPath(path)
    if (!hit) continue
    if (!acc.has(hit.slug)) acc.set(hit.slug, { patchPaths: [], baselinePath: null })
    const entry = acc.get(hit.slug)
    if (hit.kind === 'patch') entry.patchPaths.push(path)
    else entry.baselinePath = path
  }
  const sorted = new Map()
  for (const slug of [...acc.keys()].sort(cmp)) {
    const entry = acc.get(slug)
    entry.patchPaths.sort(cmp)
    sorted.set(slug, entry)
  }
  return sorted
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** ISO 时间 → 毫秒；缺失/非法一律当 0（最旧），排序仍有确定结果。 */
function toTime(value) {
  const n = Date.parse(value ?? '')
  return Number.isFinite(n) ? n : 0
}

/**
 * 合并计划。
 * @param {Array<{host: string, diff?: string, times?: Record<string,string>}>} branches
 * @param {{mainBaselines?: Set<string>|null}} [opts] main 树上已有基准源的 slug 集合（资格补判，见调用处注释）
 * @returns {{bySlug: Map<string,{branch:string,patchPaths:string[],baselinePath:string|null}>, conflicts:Array, skipped:Array}}
 */
export function mergeFarm(branches = [], { mainBaselines = null } = {}) {
  // 同一台主机出现两次（重试、两批输入拼接）时以最后一份为准，避免自己跟自己冲突。
  const byHost = new Map()
  for (const b of Array.isArray(branches) ? branches : []) {
    const host = String(b?.host ?? '').trim()
    if (!host) continue
    byHost.set(host, { host, diff: b?.diff ?? '', times: b?.times ?? {} })
  }
  const list = [...byHost.values()].sort((a, b) => cmp(a.host, b.host))

  // slug → 各分支的候选（host、路径、该 slug 在该分支上的最后提交时间）
  const perSlug = new Map()
  for (const branch of list) {
    for (const [slug, entry] of collectBranchPaths(branch.diff)) {
      if (!perSlug.has(slug)) perSlug.set(slug, [])
      perSlug.get(slug).push({
        branch: branch.host,
        patchPaths: entry.patchPaths,
        baselinePath: entry.baselinePath,
        at: toTime(branch.times?.[slug]),
      })
    }
  }

  const bySlug = new Map()
  const conflicts = []
  const skipped = []

  for (const slug of [...perSlug.keys()].sort(cmp)) {
    const candidates = perSlug.get(slug)
      .slice()
      // 时间新的在前；同刻按主机名字典序，保证任何机器上跑出来的计划完全一致。
      .sort((a, b) => (b.at - a.at) || cmp(a.branch, b.branch))

    // 基准源补判：分支 diff 里没有 tar.gz，但 **main 树上已有**同名归档时，视为有基准源。
    // 为什么：two-dot diff 只列「与 main 有差异」的文件。主机重推了一个补丁、而基准源
    // 与 main 逐字节相同时，diff 里只有 patch —— 按旧口径会被误判「缺基准源」踢出计划，
    // 但 publish-local 检出步骤本来就会保留 main 的同名归档（keepBranchBaseline），
    // release 也从工作区（main 内容）读基准 —— 资格判定没跟上这个设计意图。
    // 2026-10-25 实测：本轮 30 个滞留包里 25 个被这条误判挡在计划外。
    // baselinePath 回填成 main 上的同路径，检出/打包逻辑零改动。
    if (mainBaselines?.size) {
      for (const c of candidates) {
        if (!c.baselinePath && mainBaselines.has(slug)) c.baselinePath = `research/packs/${slug}.tar.gz`
      }
    }

    // 先在「合格候选」里取最新，而不是「所有候选里取最新再判合格」：
    // 否则 B 台更新但没推基准源时，A 台其实合格的产物会被整轮白等（下一轮还得重来）。
    const qualified = candidates.filter(isQualified)
    if (!qualified.length) {
      skipped.push({
        slug,
        branch: candidates[0].branch,
        reason: `所有候选都不合格：${candidates.map(describeShortfall).join('; ')}`,
      })
      continue
    }

    const winner = qualified[0]
    const losers = qualified.slice(1)

    if (losers.length) {
      conflicts.push({
        slug,
        winning: winner.branch,
        losers: losers.map((x) => x.branch),
        reason: `多台主机产出同一 slug 且都齐全，取最后提交更新的 ${winner.branch}（${new Date(winner.at).toISOString()}）`,
      })
    }

    bySlug.set(slug, {
      branch: winner.branch,
      patchPaths: winner.patchPaths.slice(),
      baselinePath: winner.baselinePath,
    })
  }

  return { bySlug, conflicts, skipped }
}

// ---------- CLI ----------

const USAGE = `用法: node scripts/lib/farm-merge.mjs --dir <目录> [--hosts a,b] [--out plan.json] [--github-output <文件>]

目录内读取 diff-<host>.txt（必需）与 times-<host>.json（可选，缺省时用 git log 补算）。
输出计划 JSON 到 stdout；--out 额外落盘；--github-output 追加 count / slugs / byhost 三个标量。`

function parseArgs(argv) {
  const out = { dir: '', hosts: '', out: '', githubOutput: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') out.dir = argv[++i] ?? ''
    else if (a === '--hosts') out.hosts = argv[++i] ?? ''
    else if (a === '--out') out.out = argv[++i] ?? ''
    else if (a === '--github-output') out.githubOutput = argv[++i] ?? ''
  }
  return out
}

/** 某个 slug 在某分支上的最后提交时间：只沿该 slug 的路径看历史，别台的新提交不干扰。 */
function gitLastCommit(host, paths) {
  const args = ['log', '-1', '--format=%cI', `origin/farm/${host}`]
  if (paths.length) args.push('--', ...paths)
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function readInputs(dir, hostFilter) {
  const files = existsSync(dir) ? readdirSync(dir) : []
  const hosts = files
    .map((f) => /^diff-(.+)\.txt$/.exec(f)?.[1] ?? '')
    .filter(Boolean)
    .filter((h) => (hostFilter ? hostFilter.includes(h) : true))
    .sort(cmp)

  return hosts.map((host) => {
    const diff = readFileSync(join(dir, `diff-${host}.txt`), 'utf8')
    const timesFile = join(dir, `times-${host}.json`)
    let times = {}
    if (existsSync(timesFile)) {
      try { times = JSON.parse(readFileSync(timesFile, 'utf8')) } catch { times = {} }
    } else {
      // depth=1 的浅克隆里历史只有 tip 一个 commit：如果 tip 没碰过这个 slug 的路径，
      // 按路径 log 会一无所获（返回空）。这时退回 tip 时间——冲突判定只需要「哪条分支更新」，
      // 同一分支内所有 slug 共享 tip 时间不影响结论，反而避免把所有人的时间都算成 0。
      const tipTime = gitLastCommit(host, [])
      for (const [slug, entry] of collectBranchPaths(diff)) {
        const paths = [...entry.patchPaths, entry.baselinePath].filter(Boolean)
        times[slug] = gitLastCommit(host, paths) || tipTime
      }
    }
    return { host, diff, times }
  })
}

/** 计划 → 可存档的普通对象（Map 不能直接 JSON 化，顺序由插入序保证稳定）。 */
export function serializePlan(result) {
  const bySlug = {}
  for (const [slug, item] of result.bySlug) {
    bySlug[slug] = { branch: item.branch, patchPaths: item.patchPaths, baselinePath: item.baselinePath }
  }
  const byHost = {}
  for (const item of Object.values(bySlug)) byHost[item.branch] = (byHost[item.branch] ?? 0) + 1
  return {
    bySlug,
    conflicts: result.conflicts,
    skipped: result.skipped,
    stats: {
      count: Object.keys(bySlug).length,
      byHost,
      conflicts: result.conflicts.length,
      skipped: result.skipped.length,
    },
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (!args.dir) {
    console.error(USAGE)
    return 2
  }
  const hostFilter = args.hosts ? args.hosts.split(',').map((s) => s.trim()).filter(Boolean) : null
  // main 树上已有的基准源 slug 集合：diff 里看不到「与 main 相同」的 tar.gz，
  // 但 release 可以直接用 main 的那份（检出步骤本就保留 main 版本）。取不到时当空集。
  const mainBaselines = new Set(
    (() => {
      try {
        const out = execFileSync('git', ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'research/packs/'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        return out.split('\n').map((p) => /^research\/packs\/(.+)\.tar\.gz$/.exec(p.trim())?.[1] ?? '').filter(Boolean)
      } catch { return [] }
    })(),
  )
  const plan = serializePlan(mergeFarm(readInputs(args.dir, hostFilter), { mainBaselines }))
  const json = JSON.stringify(plan, null, 2)

  if (args.out) writeFileSync(args.out, `${JSON.stringify(plan)}\n`)
  process.stdout.write(`${json}\n`)

  if (args.githubOutput) {
    // 只放标量：plan 本身走 --out 文件，避免多行 JSON 塞进 $GITHUB_OUTPUT 的转义地狱。
    const lines = [
      `count=${plan.stats.count}`,
      `slugs=${Object.keys(plan.bySlug).join(',')}`,
      `byhost=${JSON.stringify(plan.stats.byHost)}`,
      `conflicts=${plan.conflicts.map((c) => c.slug).join(',')}`,
      `skipped=${plan.skipped.map((s) => s.slug).join(',')}`,
    ]
    writeFileSync(args.githubOutput, `${lines.join('\n')}\n`, { flag: 'a' })
  }
  return 0
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) process.exit(main())
