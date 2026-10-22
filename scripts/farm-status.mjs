#!/usr/bin/env node
/**
 * farm 合并监工（只读，本机定时跑）。
 *
 * 回答三个问题：三台主机各自的分支最后动过没、落后 main 多少、最近几次 farm-merge 有没有红。
 *
 * 用法：
 *   node scripts/farm-status.mjs
 *   node scripts/farm-status.mjs --hosts gfdrgfd,podsjk
 *   node scripts/farm-status.mjs --json
 *   node scripts/farm-status.mjs --ssh
 *
 * 退出码：0 一切正常；1 有分支超过 2 小时没动，或最近 3 次合并里有 failure。
 * 单条网络查询失败只会显示成 n/a 并记一条警告，不会让脚本崩 —— 定时任务里崩掉
 * 和「一切正常」在监控上没法区分，必须留出可见的中间态。
 */
import { execFileSync } from 'node:child_process'

const REPO = 'Kalloer1/quest-i18n-index'
const WORKFLOW = 'farm-merge.yml'
const DEFAULT_HOSTS = ['gfdrgfd', 'podsjk', 'jslfkds']
const SSH_DOMAIN = 's9.serv00.com'
const STALE_MS = 2 * 60 * 60 * 1000
const RECENT_RUNS = 5
const FAIL_WINDOW = 3

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const wantSsh = args.includes('--ssh')
const hostsArg = args.indexOf('--hosts')
const hosts = hostsArg >= 0
  ? (args[hostsArg + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_HOSTS

/** 跑一条命令拿 stdout。失败由调用方决定怎么降级，这里只抛。 */
function run(cmd, cmdArgs, timeout = 25_000) {
  return execFileSync(cmd, cmdArgs, {
    encoding: 'utf8',
    // stdin 用 inherit 而不是 'ignore'：'ignore' 等价于 `ssh -n`，远程若执行 `cat >`
    // 会读到 EOF 把文件清空（仓库里踩过）；这里虽只跑 tail，也不留这个坑。
    stdio: ['inherit', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  }).trim()
}

const gh = (ghArgs) => run('gh', ghArgs)

function tryRun(fn) {
  try {
    return { ok: true, value: fn() }
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err).trim().split('\n').filter(Boolean).pop()
    return { ok: false, value: '', error: msg || 'unknown error' }
  }
}

const pad = (s, width) => s + ' '.repeat(Math.max(0, width - displayWidth(s)))

/** 中文字符占两列，用 String.length 补空格会让表格错位。 */
function displayWidth(s) {
  let n = 0
  for (const ch of String(s)) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return n
}

function agoText(iso) {
  if (!iso) return 'n/a'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'n/a'
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000))
  if (mins < 60) return `${mins}m 前`
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m 前`
  return `${Math.floor(mins / 1440)}d 前`
}

function hostStatus(host) {
  const out = { host, sha: '', lastCommit: '', ahead: null, stale: false, ssh: '', problems: [] }

  // 分支最后提交：branch 端点返回的 commit 就是 tip，无需再拉提交详情。
  const branch = tryRun(() => JSON.parse(gh(['api', `repos/${REPO}/branches/farm/${host}`])))
  if (branch.ok) {
    out.sha = branch.value?.commit?.sha?.slice(0, 7) ?? ''
    out.lastCommit = branch.value?.commit?.commit?.committer?.date
      ?? branch.value?.commit?.commit?.author?.date
      ?? ''
    const t = Date.parse(out.lastCommit)
    out.stale = Number.isFinite(t) ? (Date.now() - t > STALE_MS) : false
    if (!out.lastCommit) out.problems.push(`${host}: 分支时间读不到`)
  } else {
    out.problems.push(`${host}: 分支查询失败（${branch.error}）`)
  }

  // 「落后」在这里的含义是分支领先 main 多少个提交，即还有多少待合。
  const ahead = tryRun(() => gh(['api', `repos/${REPO}/compare/main...farm/${host}`, '--jq', '.ahead_by']))
  if (ahead.ok) out.ahead = Number.parseInt(ahead.value, 10)
  else out.problems.push(`${host}: compare 查询失败（${ahead.error}）`)

  if (wantSsh) {
    // 不用 `ssh -n`：远程一旦是 `cat >` 就会收到空输入，把日志清空。
    const log = tryRun(() => run('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      `${host}@${SSH_DOMAIN}`,
      'tail -n 2 ~/run2.log',
    ]))
    out.ssh = log.ok ? log.value.replace(/\s*\n\s*/g, ' / ') : `n/a（${log.error}）`
    if (!log.ok) out.problems.push(`${host}: ssh 取日志失败（${log.error}）`)
  }

  return out
}

function recentRuns() {
  const res = tryRun(() => JSON.parse(gh([
    'run', 'list', '--workflow', WORKFLOW, '--repo', REPO,
    '-L', String(RECENT_RUNS),
    '--json', 'status,conclusion,createdAt,url',
  ])))
  if (!res.ok) return { runs: [], error: res.error }
  return { runs: Array.isArray(res.value) ? res.value : [], error: '' }
}

function main() {
  const rows = hosts.map(hostStatus)
  const { runs, error: runsError } = recentRuns()

  const problems = rows.flatMap((r) => r.problems)
  if (runsError) problems.push(`run list 查询失败（${runsError}）`)

  const stale = rows.filter((r) => r.stale)
  // 只认已完成且明确 failure 的，in_progress / cancelled 不算失败。
  const failed = runs.slice(0, FAIL_WINDOW).filter((r) => r.conclusion === 'failure')
  // 三台全都读不到时间 = 监工本身瞎了（token 过期 / 断网），不能当绿灯放过去；
  // 只坏一台则记一条警告即可，否则网络抖动会天天误报。
  const blind = rows.length > 0 && rows.every((r) => !r.lastCommit)
  const ok = stale.length === 0 && failed.length === 0 && !blind

  if (asJson) {
    console.log(JSON.stringify({ ok, hosts: rows, runs, failures: failed.length, problems }, null, 2))
  } else {
    const head = ['主机', '最后提交', '距今', '待合提交', wantSsh ? 'run2.log' : ''].filter(Boolean)
    const table = rows.map((r) => [
      r.host,
      r.lastCommit ? r.lastCommit.replace('T', ' ').slice(0, 19) : 'n/a',
      agoText(r.lastCommit),
      r.ahead === null || Number.isNaN(r.ahead) ? 'n/a' : String(r.ahead),
      wantSsh ? (r.ssh || 'n/a') : '',
    ].filter((_, i) => wantSsh || i < 4))

    const widths = head.map((h, i) => Math.max(displayWidth(h), ...table.map((row) => displayWidth(row[i] ?? ''))))
    const line = (cells) => cells.map((c, i) => pad(c ?? '', widths[i])).join('  ').trimEnd()

    console.log(line(head))
    console.log(widths.map((w) => '-'.repeat(w)).join('  '))
    for (const row of table) console.log(line(row))

    console.log('')
    console.log(`最近 ${Math.min(FAIL_WINDOW, runs.length)} 次 farm-merge：`)
    if (!runs.length) console.log(`  无记录${runsError ? `（${runsError}）` : ''}`)
    for (const r of runs.slice(0, FAIL_WINDOW)) {
      const mark = r.conclusion === 'failure' ? '✗' : r.conclusion === 'success' ? '✓' : '-'
      console.log(`  ${mark} ${r.createdAt?.replace('T', ' ').slice(0, 16) ?? 'n/a'}  ${r.conclusion ?? r.status}  ${r.url ?? ''}`)
    }

    if (problems.length) {
      console.log('')
      for (const p of problems) console.log(`  ! ${p}`)
    }
    if (stale.length) console.log(`\n超过 2 小时没有新提交：${stale.map((r) => r.host).join('、')}`)
    if (failed.length) console.log(`\n最近 ${FAIL_WINDOW} 次里有 ${failed.length} 次失败。`)
    if (blind) console.log('\n三台分支时间全部读不到：检查 gh 登录态与网络。')
  }

  process.exitCode = ok ? 0 : 1
}

main()
