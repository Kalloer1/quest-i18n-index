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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
    // 超时兜底：promisor 仓库的 checkout 会顺带懒加载 blob，网络卡住时这里会无限等，
    // 卡死比失败更糟（失败还能重试，卡死只能靠人发现）。
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 })
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
// ---------- 0. 工作区基线 ----------
// 这里只记录基线，不判脏：发布过程本身会把 plan 里的包写进工作区（restore 覆盖、
// build-* 重建数据），等到计划算出来之后再按「是否在本次范围内」判定，
// 否则上一轮跑剩的改动会把下一轮直接挡在门外。
step(0, '检查工作区')
const baseDirty = git(['status', '--porcelain'], { quiet: true })
  .split('\n').map((l) => l.trim()).filter(Boolean)
  .filter((l) => !l.startsWith('??'))
  .filter((l) => !l.includes('.wrangler/') && !l.includes('.workbuddy/'))
  .map((l) => l.replace(/^\S+\s+/, ''))
console.log(baseDirty.length ? `已有 ${baseDirty.length} 个改动，稍后按计划范围核对` : '工作区干净')

// ---------- 1. 取各分支增量 ----------
step(1, '拉取远端分支并计算增量')
netGit(['fetch', '-q', 'origin', 'main'])
// 不能用 `--filter=blob:none`：那会把 remote 标成 promisor，之后 checkout 的懒加载
// 会带着 blob:none 去要单个 blob，永远要不到、无限等（实测卡死十分钟无输出）。
// 全量拉一次反而稳：分支只增量推送，后续每轮只下新增的那几个包。
// 代价是首次会下几百 MB，但那是**必须**的数据（补丁 + 基准源），早下晚下都得下。
netGit(['fetch', '--no-tags', '--progress', 'origin',
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
  // `--no-renames` 是必须的：整棵树 pathspec 下 git 默认开 rename 检测，
  // main 上某个包删掉/改名的同名章节，会和 farm 侧新增的整章文件配成 R，
  // 被 `--diff-filter=AM` 滤掉 —— 于是 plan 里的 patchPaths 缺文件，
  // checkout 只还原一部分，闸门报「缺 N 个键」，看起来像翻译坏了。
  // 2026-10-24 实测：aestheticaplus 在同一分支上只出 9/13 个文件，
  // 加 --no-renames 才 13 个；30 个被拦的包共缺 166 个文件，全部是 R 状态。
  const out = git(
    ['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '--diff-filter=AM',
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

// 范围校验：只放行「本次要合并的包」和发布自己重建的那几个数据文件。
// 别的已跟踪改动（别人正在改的脚本、半成品）必须在这里停 —— 后面是显式路径 add，
// 但工作区脏着跑下去，出问题时分不清是本次引入的还是别人留下的。
{
  const allowed = (p) => {
    for (const slug of Object.keys(plan.bySlug)) {
      if (p.startsWith(`patches/${slug}/`) || p === `research/packs/${slug}.tar.gz`) return true
      if (p.startsWith('downloads/') && (p.includes(`/${slug}_v`) || p.includes(`/${slug}.zip`))) return true
    }
    return ['research/index-dataset.json', 'site/data.json', 'research/source-versions.json',
      'research/quark-mirrors.json', 'glossary.json', 'dist/index.html', 'dist/request.html'].includes(p)
  }
  const stray = baseDirty.filter((p) => !allowed(p))
  if (stray.length) {
    console.error(`工作区有 ${stray.length} 处与本次合并无关的改动，先处理掉：`)
    for (const p of stray.slice(0, 15)) console.error(`  ${p}`)
    process.exit(1)
  }
}

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
  // 必须 --no-filter 整分支补齐，不能让 checkout 懒加载：
  // 本仓库被前面的 `--filter=blob:none` 标成了 promisor，懒加载会走
  // `fetch --filter=blob:none --stdin` 去要那**一个** blob —— 过滤器把要的东西又滤掉，
  // 于是无限等（实测卡死 10 分钟、无任何输出，只能靠人 kill）。
  // 单分支补一次约 40s，可续传；缺什么补什么，比逐文件往返快得多。
  for (const h of branches) netGit(['fetch', '--no-filter', '--progress', '--no-tags', 'origin', `farm/${h}:refs/remotes/origin/farm/${h}`])
  console.log(`补齐 ${branches.length} 条分支的 blob：${branches.join(', ')}`)
}
let checkedOut = 0
const lost = []
// 按分支一次性 restore，而不是逐包 `git checkout`：
// Windows 上每调一次 git 都要重写整个索引（几千个文件），实测一个包 4 秒，
// 488 个包要半小时。`--pathspec-from-file` 让一条命令处理整批路径，几条分支几秒就完。
// 不做「先删后捡」：这台机器的安全垫片会拦单次 50 个以上的批量删除
// （SAFE_DELETE_BULK_CONFIRM_REQUIRED），而且按 HEAD 列表判定一旦口径错了就会误删真实产物。
// 残留只可能来自同一分支的同名文件，restore 会覆盖；真缺文件的包由闸门拦下。
const perBranch = {}
for (const [slug, item] of Object.entries(plan.bySlug)) {
  const paths = [...item.patchPaths, item.baselinePath].filter(Boolean)
  ;(perBranch[item.branch] ??= []).push({ slug, paths })
}
for (const [h, items] of Object.entries(perBranch)) {
  const specFile = join(DIR, `restore-${h}.txt`)
  writeFileSync(specFile, items.flatMap((x) => x.paths).join('\0'))
  const ok = gitTry(['restore', `--source=origin/farm/${h}`, '--worktree',
    '--pathspec-from-file', specFile, '--pathspec-file-nul'])
  if (ok || gitTry(['restore', `--source=origin/farm/${h}`, '--worktree',
    '--pathspec-from-file', specFile, '--pathspec-file-nul'])) { checkedOut += items.length; continue }
  // 整批失败通常是本地缺 blob（ref 没变时普通 fetch 会跳过，filter 漏下的对象永远补不回来）。
  // --refetch 会让 git 假装本地什么都没有、重新协商，是唯一可靠的补救。
  if (!ok) netGit(['fetch', '--refetch', '--no-tags', 'origin', `+refs/heads/farm/${h}:refs/remotes/origin/farm/${h}`])
  // 补完再来一次整批；还不行才退回逐包，只丢真正坏的那几个。
  for (const { slug, paths } of items) {
    if (gitTry(['checkout', `origin/farm/${h}`, '--', ...paths])) { checkedOut++; continue }
    lost.push(slug)
    console.log(`  ✘ ${slug} 检出失败，本轮跳过（下一轮会重试）`)
  }
}
console.log(`已检出 ${checkedOut} 个包（补丁 + 基准源）${lost.length ? `，失败 ${lost.length} 个` : ''}`)

// ---------- 4. 布局趟 ----------
step(4, 'build-index（布局趟）')
run('node', ['scripts/build-index.mjs'])

// ---------- 5. 测试 ----------
if (!SKIP_TESTS) {
  step(5, 'npm test')
  // 不通过 npm 跑：Windows 上 `npm` / `npm.cmd` 都是包装脚本，execFileSync 直接 spawn
  // 会 ENOENT 且**不带任何输出**，表现为「npm test 失败但日志空白」。
  // 直接按 package.json 里那条命令的等价形式起 node --test，文件列表自己列。
  const tests = [
    ...readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.test.mjs')).map((f) => `scripts/${f}`),
    ...readdirSync(join(ROOT, 'scripts/lib')).filter((f) => f.endsWith('.test.mjs')).map((f) => `scripts/lib/${f}`),
  ]
  run(process.execPath, ['--test', ...tests])
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
    // 移走而不是删除：这台机器的安全垫片会拦单次 >50 个 rm
    // （SAFE_DELETE_BULK_CONFIRM_REQUIRED），而且残包留着比删掉更好排查 ——
    // 想清空就把 research/tmp/quarantine 整个删掉。
    // 每次一个独立子目录：同名包可能连续几轮都被拦（主机重翻后还是坏的），
    // 固定路径会在 renameSync 上撞「dest already exists」把整轮发布打挂。
    const vault = join(ROOT, 'research/tmp/quarantine',
      `run-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(vault, { recursive: true })
    for (const s of bad) {
      git(['rm', '-q', '-r', '--cached', `patches/${s}`], { allowFail: true })
      const src = join(ROOT, 'patches', s)
      if (existsSync(src)) renameSync(src, join(vault, s))
      const base = join(ROOT, 'research/packs', `${s}.tar.gz`)
      if (existsSync(base)) renameSync(base, join(vault, `${s}.tar.gz`))
    }
    console.log(`已移入隔离区：research/tmp/quarantine（${bad.length} 个）`)
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
