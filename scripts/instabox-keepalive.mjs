#!/usr/bin/env node
/**
 * instabox farm 保活：把五台云机从「闲置暂停」里叫醒。
 *
 * 为什么需要它：instabox 的盒子闲置 30 分钟会自己暂停（免费账号固定 30m，
 * `--auto-suspend 0` 会被服务端拒绝）。暂停保留内存与进程，所以不会丢进度，
 * 但没人叫它就一直睡着 —— 8 个 worker 里 5 个不动，整条 farm 的实际吞吐腰斩，
 * 而日志上看不出任何错误。
 *
 * 为什么用 `exec` 而不是 `wake`：exec 既能唤醒又顺便验证 farm 进程还活着；
 * 只有 exec 失败（盒子被删/CLI 掉线）时才退回 `wake`。
 *
 * 用法：
 *   node scripts/instabox-keepalive.mjs            # 唤醒并检查五台
 *   node scripts/instabox-keepalive.mjs --quiet     # 只在异常时输出（给计划任务用）
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const BOXES = ['work', 'farm1', 'farm2', 'farm3', 'farm4']

/** 单台的探活命令：拿到 pid 就说明 farm 还在跑。 */
const PROBE = 'pgrep -f "translate-local[.]mjs" | head -1'

const log = (...a) => console.log(...a)

/**
 * 探活一台。返回 { box, ok, pids, woke, error }。
 * exec 超时按失败处理：暂停中的盒子被唤起需要几秒，超时通常意味着它在冷启动。
 */
export function checkBox(box, { run = defaultRun, quiet = false } = {}) {
  const stamp = () => new Date().toISOString().slice(11, 19)
  try {
    const out = run('instabox', ['exec', box, '--', PROBE], 45_000).trim()
    if (out) {
      if (!quiet) log(`${stamp()} ${box.padEnd(6)} ok   pid=${out.split('\n')[0]}`)
      return { box, ok: true, pids: out }
    }
    // 进程没有但盒子活着：可能刚被暂停过、farm-run 没起，或正在两包之间重启
    if (!quiet) log(`${stamp()} ${box.padEnd(6)} 无 farm 进程（盒子在响应）`)
    return { box, ok: false, pids: '', reason: 'no-process' }
  } catch (e) {
    // exec 失败：先 wake 一次再探，别直接判死
    try {
      run('instabox', ['wake', box], 60_000)
    } catch { /* wake 也失败，下面的错误更有信息量 */ }
    try {
      const out = run('instabox', ['exec', box, '--', PROBE], 45_000).trim()
      if (!quiet) log(`${stamp()} ${box.padEnd(6)} woke pid=${out.split('\n')[0] || '-'}`)
      return { box, ok: Boolean(out), pids: out, woke: true }
    } catch (e2) {
      const msg = String(e2?.message || e2).split('\n')[0].slice(0, 120)
      log(`${stamp()} ${box.padEnd(6)} FAIL ${msg}`)
      return { box, ok: false, error: msg }
    }
  }
}

function defaultRun(cmd, args, timeout) {
  return execFileSync(cmd, args, { timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const quiet = process.argv.includes('--quiet')
  const results = BOXES.map((b) => checkBox(b, { quiet }))
  const bad = results.filter((r) => !r.ok)
  // 计划任务里窗口是隐藏的，输出没人看得见 —— 落一行到日志，否则保活坏了只能靠
  // 「5 台里 4 台不动」这种间接现象发现。
  try {
    const { appendFileSync, mkdirSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const logFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'research', 'logs', 'keepalive.log')
    mkdirSync(dirname(logFile), { recursive: true })
    const line = `${new Date().toISOString()} ok=${results.filter((r) => r.ok).length}/${results.length}`
      + (bad.length ? ` bad=${bad.map((b) => b.box).join(',')}` : '')
    appendFileSync(logFile, line + '\n')
  } catch { /* 日志写不进去不影响保活本身 */ }
  if (bad.length) {
    log(`\n异常 ${bad.length} 台：${bad.map((b) => `${b.box}(${b.reason || b.error || '未知'})`).join(', ')}`)
    process.exitCode = 1
  } else if (!quiet) {
    log(`\n${results.length} 台全部在线`)
  }
}
