#!/usr/bin/env node
/**
 * 本机一次性合并发布：把各台主机推上来的 farm/<host> 分支增量，一次性合进 main 并发布。
 *
 * ## 为什么要有它
 *
 * 原来这件事由 `.github/workflows/farm-merge.yml` 每 15 分钟做一遍。撤掉定时任务的原因不是
 * 「合并逻辑不行」，而是同一条流水线里还挂着夸克网盘镜像和玩家请求两个旁路 job，它们的失败
 * （登录态过期、报告文件不存在、840s 超时）把整条 run 判成红的，日志里看不出到底谁坏了。
 * 合并本身是纯本地文件操作 + 几个 node 脚本，没有理由非在云端跑。
 *
 * ## 顺序不能改（每一步都在补前一步的前提）
 *
 * 1. 取 delta：two-dot diff + `--diff-filter=AM`。主机从不追 main，两边没有 merge-base，
 *    three-dot 会直接 fatal；而 two-dot 是两棵树的**全量**差异，别台刚合进来的包会显示成 D，
 *    所以必须只认新增/修改，否则会把同事的产物当成待删项。
 * 2. 逐文件 checkout，不整目录覆盖：main 的 `patches/<slug>/` 里可能已有别台合进来的文件。
 * 3. build-index（布局趟）：validate 与 release 都从 index-dataset 取 layout，
 *    新包还没记录 → 内嵌包会被按分离布局打包/校验，结果不是假绿就是误红。
 * 4. 闸门：判红就**踢掉坏包再校验一次**，而不是整批停摆。坏包基本是主机被中断留下的残包。
 * 5. release：必须在布局趟之后（用 layout 决定 zip 目录形态），且只打工作区里还在的目录。
 * 6. 再 build-index 一次（交付趟）+ 站点数据：zip 落盘后 delivered 才会变 true。
 *
 * ## 用法
 *
 *   node scripts/publish-local.mjs                  # 全量合并（默认不设上限）
 *   node scripts/publish-local.mjs --max 80         # 按 slug 字典序只合前 80 个
 *   node scripts/publish-local.mjs --hosts work,farm1
 *   node scripts/publish-local.mjs --dry-run        # 只算计划，不落盘不提交
 *   node scripts/publish-local.mjs --skip-tests     # 跳过 npm test（赶时间时用，风险自负）
 *
 * 退出码：0 成功（含「无增量」）；1 失败；2 参数错误。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'research/tmp/publish')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d = '') => {
  const i = argv.indexOf(f)
  return i >= 0 ? (argv[i + 1] ?? d) : d
}

const DRY = has('--dry-run')
const SKIP_TESTS = has('--skip-tests')
const HOSTS = val('--hosts').split(',').map((s) => s.trim()).filter(Boolean)
const MAX = Number(val('--max', '0')) || 0

const step = (n, msg) => console.log(`\n\x1b[1m[${n}]\x1b[0m ${msg}`)

/** 跑一条命令，默认把输出直接接到终端（进度可见比收进变量更重要）。 */
function run(cmd, args, { quiet = false, allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: quiet ? 'pipe' : 'inherit',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    if (allowFail) return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    console.error(`\n✘ 失败：${cmd} ${args.join(' ')}`)
    process.exit(1)
  }
}

function git(args, opts) {
  return run('git', args, opts)
}

/** 与 git() 同参，但失败返回 false 而不是退出进程：单个包的检出失败不该拖垮整轮。 */
function gitTry(args) {
  try {
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
    return true
  } catch {
    return false
  }
}

/**
 * 网络类 git 操作必须重试：本机到 github.com 会间歇 `Could not resolve hostname`
 * 或 TLS 超时（同一个仓库今天已经撞过好几次），一次抖动就中断整轮发布会让人以为是代码坏了。
 * 只对 fetch/pull/push 用；本地操作失败就是真失败，重试只会掩盖问题。
 */
function netGit(args, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
    } catch (err) {
      last = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
      if (i < tries - 1) {
        const wait = 5 * (i + 1)
        console.log(`  git ${args[0]} 失败（${String(last).split('\n')[0].slice(0, 60)}），${wait}s 后重试`)
        execFileSync(process.execPath, ['-e', `setTimeout(()=>{},${wait * 1000})`])
      }
    }
  }
  console.error(`✘ git ${args.join(' ')} 连续失败：\n${String(last).slice(-400)}`)
  process.exit(1)
}

/**
 * 一次 git log 算出「该分支上每个 slug 最后一次提交时间」。
 *
 * 语义与 `scripts/lib/farm-merge.mjs` 里逐 slug 的 `gitLastCommit` 一致（取该 slug
 * 所有路径里的最新提交），但只起一个进程 —— 那边是每个 slug 一个 `git log`，
 * Windows 上单次 0.6s，700 个 slug 要 8 分钟，还没开始合并人就已经等不下去了。
 * log 是「新 → 旧」，所以每个 slug 第一次出现的时间戳就是最新，直接记下即可。
 *
 * 失败就返回空对象：farm-merge 会退回自己逐 slug 的慢路径，结果一样，只是慢。
 */
function bulkTimes(host) {
  try {
    const out = execFileSync('git', [
      '-c', 'core.quotePath=false', 'log', '--format=@@%ct', '--name-only',
      `origin/farm/${host}`, '--', 'patches', 'research/packs',
    ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 })
    const times = {}
    let ts = 0
    for (const raw of out.split('\n')) {
      const l = raw.trim()
      if (!l) continue
      if (l.startsWith('@@')) { ts = Number(l.slice(2)) || 0; continue }
      let slug = ''
      const p = /^patches\/([^/]+)\//.exec(l)
      if (p) slug = p[1]
      else {
        const b = /^research\/packs\/(.+)\.tar\.gz$/.exec(l)
        if (b) slug = b[1]
      }
      if (slug && ts && times[slug] === undefined) times[slug] = ts
    }
    return times
  } catch {
    return {}
  }
}


// 半成品被 -A 带进提交是这个仓库反复踩过的坑，所以宁可在这里停。
// ---------- 0. 工作区必须干净 ----------
step(0, '检查工作区')
{
  const dirty = git(['status', '--porcelain'], { quiet: true })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // 只拦「已跟踪文件的改动」：未跟踪文件（?? .scratch/、新旧草稿）不会被带进提交，
    // 因为下面全是显式路径 git add，没有 -A。
    .filter((l) => !l.startsWith('??'))
    // .wrangler 是 miniflare 的本地 sqlite，随每次 dev 都变，不参与发布。
    .filter((l) => !l.includes('.wrangler/') && !l.includes('.workbuddy/'))
  if (dirty.length) {
    console.error('工作区有未提交改动，先处理掉再发布：')
    for (const d of dirty.slice(0, 20)) console.error(`  ${d}`)
    process.exit(1)
  }
  console.log('工作区干净')
}

// ---------- 1. 取各分支增量 ----------
step(1, '拉取远端分支并计算增量')
netGit(['fetch', '-q', 'origin', 'main'])
// blobless：这些分支里塞满了 tar.gz 和 zip，全量 fetch 一次要几分钟（实测 400s 还没完）；
// 只拉提交与树，blob 在 checkout 时按需取，增量那一步只碰十几个文件，代价极小。
// 不按 --hosts 分次拉：GitHub 上一条 refspec 通配一次往返拿完，比逐台拉快得多。
netGit(['fetch', '-q', '--filter=blob:none', '--no-tags', 'origin',
  '+refs/heads/farm/*:refs/remotes/origin/farm/*'])

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

const allHosts = HOSTS.length
  ? HOSTS
  : execFileSync('git', ['ls-remote', '--heads', 'origin', 'refs/heads/farm/*'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((l) => /refs\/heads\/farm\/(.+)$/.exec(l.trim())?.[1])
      .filter(Boolean)
if (!allHosts.length) {
  console.log('远端没有 farm/* 分支，无事可做')
  process.exit(0)
}
console.log(`候选主机 ${allHosts.length} 台：${allHosts.join(', ')}`)

for (const h of allHosts) {
  const out = git(
    ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=AM',
      'origin/main', `origin/farm/${h}`, '--', 'patches', 'research/packs'],
    { quiet: true },
  )
  writeFileSync(join(DIR, `diff-${h}.txt`), out)
  const n = out.split('\n').filter(Boolean).length
  console.log(`  farm/${h}: ${n} 个路径`)

  // 预生成 times-<host>.json：不生成的话 farm-merge 会对每个 slug 跑一次
  // `git log -1 -- path`，Windows 上一次进程 0.6s，700 个 slug 就是 8 分钟纯等待
  // （上一轮发布就是卡在这一步被中断的）。这里用**一次** git log 扫完整个分支历史，
  // 只读树不读 blob，blobless 克隆下也很快。
  writeFileSync(join(DIR, `times-${h}.json`), JSON.stringify(bulkTimes(h), null, 0))
}

// ---------- 2. 合并计划 ----------
step(2, '计算合并计划')
const planJson = execFileSync('node', ['scripts/lib/farm-merge.mjs', '--dir', DIR,
  '--hosts', allHosts.join(','), '--out', join(DIR, 'plan.json')], { cwd: ROOT, encoding: 'utf8' })
let plan = JSON.parse(readFileSync(join(DIR, 'plan.json'), 'utf8'))
let slugs = Object.keys(plan.bySlug)

if (MAX > 0 && slugs.length > MAX) {
  // 按 slug 字典序截断：顺序稳定可重放；被截掉的包下一轮仍在 diff 里，不会饿死。
  slugs = [...slugs].sort().slice(0, MAX)
  const keep = new Set(slugs)
  const bySlug = {}
  for (const s of slugs) bySlug[s] = plan.bySlug[s]
  plan = { ...plan, bySlug, conflicts: plan.conflicts.filter((c) => keep.has(c.slug)) }
  writeFileSync(join(DIR, 'plan.json'), `${JSON.stringify(plan)}\n`)
  console.log(`按 --max ${MAX} 截断到 ${slugs.length} 个`)
}

const byHost = {}
for (const it of Object.values(plan.bySlug)) byHost[it.branch] = (byHost[it.branch] ?? 0) + 1
console.log(`可合并 ${slugs.length} 个包：${Object.entries(byHost).sort().map(([h, n]) => `${h}×${n}`).join(', ') || '—'}`)
if (plan.conflicts?.length) console.log(`冲突 ${plan.conflicts.length} 个（已在同 slug 里取最新那台）`)
if (plan.skipped?.length) console.log(`跳过 ${plan.skipped.length} 个（候选不合格，见 plan.json）`)

if (!slugs.length) {
  console.log('\n没有可合并的增量，收工。')
  process.exit(0)
}
if (DRY) {
  console.log('\n--dry-run：计划已写到 research/tmp/publish/plan.json，未落盘。')
  process.exit(0)
}

// ---------- 3. 只取这些包的产物 ----------
step(3, '检出增量文件')
// 补 blob 必须整分支补，不能靠 checkout 时懒加载：localhost 到 GitHub 的往返一次几百毫秒，
// 一个包几十个文件就是几十次往返 —— 实测 5 个包 600s 都没检出完。
// 整分支 fetch 只下载本地缺的对象（main 上已有的包不会再下），等于只取这批增量。
{
  const branches = [...new Set(Object.values(plan.bySlug).map((it) => it.branch))]
  // --no-filter 是必须的：本仓库因为前面用 `--filter=blob:none` 取增量的缘故，
  // remote.origin 已被标成 promisor（blob:none）。这时候普通 fetch **不会下 blob**，
  // checkout 时才一个文件一次懒加载 —— 网络一抖就 `unable to read sha1 file` 直接中断，
  // 而且一断就是整轮作废（上一轮 482 个包卡在第一个 slug 上）。
  for (const h of branches) netGit(['fetch', '-q', '--no-filter', '--no-tags', 'origin', `farm/${h}:refs/remotes/origin/farm/${h}`])
  console.log(`补齐 ${branches.length} 条分支的 blob：${branches.join(', ')}`)
}
let checkedOut = 0
const lost = []
for (const [slug, item] of Object.entries(plan.bySlug)) {
  const paths = [...item.patchPaths, item.baselinePath].filter(Boolean)
  if (gitTry(['checkout', `origin/farm/${item.branch}`, '--', ...paths])) { checkedOut++; continue }
  // 单包失败不该拖垮整轮：补一次 blob 再试，仍不行就记下来跳过（下一轮它还在 diff 里）。
  netGit(['fetch', '-q', '--no-filter', '--no-tags', 'origin', `farm/${item.branch}:refs/remotes/origin/farm/${item.branch}`])
  if (gitTry(['checkout', `origin/farm/${item.branch}`, '--', ...paths])) { checkedOut++; continue }
  lost.push(slug)
  console.log(`  ✘ ${slug} 检出失败，本轮跳过（下一轮会重试）`)
}
console.log(`已检出 ${checkedOut} 个包（补丁 + 基准源）${lost.length ? `，失败 ${lost.length} 个` : ''}`)

// ---------- 4. 布局趟 ----------
step(4, 'build-index（布局趟）')
run('node', ['scripts/build-index.mjs'])

// ---------- 5. 测试 ----------
if (!SKIP_TESTS) {
  step(5, 'npm test')
  run('npm', ['test'])
} else {
  step(5, 'npm test（已跳过）')
}

// ---------- 6. 闸门 ----------
step(6, '校验任务书（闸门）')
let blocked = []
{
  let out = ''
  let rc = 0
  try {
    out = execFileSync('node', ['scripts/validate-quests.mjs'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    rc = err.status ?? 1
  }
  console.log(out.split('\n').slice(-40).join('\n'))
  if (rc !== 0) {
    const bad = [...new Set([...out.matchAll(/✘ patches\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]))]
    if (!bad.length) {
      console.error('闸门红了但解析不出包名，按硬失败处理（不静默放行）')
      process.exit(1)
    }
    console.log(`\n闸门拦下 ${bad.length} 个坏包：${bad.join(', ')}`)
    console.log('这些包本轮排除，其余照常合并（主机侧下一轮会重翻）')
    for (const s of bad) {
      git(['rm', '-q', '-r', '--cached', `patches/${s}`], { allowFail: true })
      rmSync(join(ROOT, 'patches', s), { recursive: true, force: true })
      rmSync(join(ROOT, 'research/packs', `${s}.tar.gz`), { force: true })
    }
    blocked = bad
    // 二次校验：剩下的必须全绿，仍红说明不是个别残包，这时才真该停。
    run('node', ['scripts/validate-quests.mjs'])
  }
}

// ---------- 7. 打包 ----------
step(7, '打包 zip')
const keep = slugs.filter((s) => !blocked.includes(s) && existsSync(join(ROOT, 'patches', s)))
if (!keep.length) {
  console.log('本轮没有可打包的包（全被闸门排除），不提交')
  process.exit(0)
}
run('node', ['scripts/release.mjs', '--ids', keep.join(','), '--package-only'])

// ---------- 8. 版本汇总 + 交付趟 ----------
step(8, '汇总版本、重建索引与站点数据')
run('node', ['scripts/source-versions.mjs'])
run('node', ['scripts/build-index.mjs'])
run('node', ['scripts/build-site-data.mjs'])
run('node', ['scripts/build-site-html.mjs'])

// ---------- 9. 暂存 ----------
step(9, '暂存产物（显式路径，不用 -A）')
{
  const addIf = (p) => { if (existsSync(join(ROOT, p))) git(['add', '--', p], { allowFail: true }) }
  for (const slug of keep) {
    addIf(`patches/${slug}`)
    addIf(`research/packs/${slug}.tar.gz`)
    // zip 有两种命名：旧 downloads/<slug>.zip、新 downloads/<slug>_v<ver>.zip
    const dir = join(ROOT, 'downloads')
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (f === `${slug}.zip` || (f.startsWith(`${slug}_v`) && f.endsWith('.zip'))) {
          git(['add', '--', `downloads/${f}`], { allowFail: true })
        }
      }
    }
  }
  for (const p of ['research/index-dataset.json', 'site/data.json',
    'research/quark-mirrors.json', 'research/source-versions.json', 'glossary.json']) {
    addIf(p)
  }
  const staged = git(['diff', '--cached', '--name-only'], { quiet: true }).split('\n').filter(Boolean).length
  console.log(`暂存 ${staged} 个文件`)
  if (!staged) {
    console.log('无变更，收工')
    process.exit(0)
  }
}

// ---------- 10. 提交推送 ----------
step(10, '提交并推送')
{
  const parts = Object.entries(byHost).sort().map(([h, n]) => `${h}×${n}`).join(', ')
  const note = blocked.length ? `；闸门排除 ${blocked.length} 个（${blocked.join(', ')}）` : ''
  const msg = `farm: 合并 ${keep.length} 个整合包（${parts}）${note}`
  git(['commit', '-q', '-m', msg])
  console.log(msg)
  // 合并期间别处可能也推了 main：先 rebase 再推，绝不 force。
  netGit(['pull', '--rebase', '--autostash', '-q', 'origin', 'main'])
  netGit(['push', '-q', 'origin', 'main'])
  console.log('已推送。deploy.yml 会按 push 自动发布到 Cloudflare。')
}
