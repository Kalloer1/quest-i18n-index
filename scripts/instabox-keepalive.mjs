#!/usr/bin/env node
/**
 * instabox farm 保活：把五台云机从「闲置暂停」里叫醒，并顺手把死掉的农场拉起来。
 *
 * ## 为什么改用 curl 而不是 `instabox` CLI
 *
 * 官方 CLI 在本机根本连不上 API：Go 二进制走本机代理时稳定 `TLS handshake timeout`
 * （`instabox get work` 复现），而 curl（schannel）穿同一个代理正常。
 * 所以这个脚本以前长期是**假警报**：日志里一路 `ok=0/5`，实际上盒子都在跑；
 * 真挂机的时候它也一样报 0/5，等于没救。现在统一走 REST（key 在 research/tmp/.ibx-key）。
 *
 * ## 唤醒与重启的分工
 *
 * `POST /exec` 本身就能把暂停的盒子拉起来（免费账号没有可用的 wake 路由，实测 404），
 * 所以「叫醒」和「探活」是同一次调用。探到没有 translate-local 进程，就远端跑一次
 * `~/restart-farm.sh <box>`（那个脚本会拉新代码、清 CRLF、重置锁再起）。
 *
 * 用法：
 *   node scripts/instabox-keepalive.mjs            # 唤醒并检查五台
 *   node scripts/instabox-keepalive.mjs --quiet     # 只在异常时输出（给计划任务用）
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const API = 'https://api.instabox.sh'
const KEY_FILE = join(ROOT, 'research/tmp/.ibx-key')

export const BOXES = ['work', 'farm1', 'farm2', 'farm3', 'farm4']
const PROBE = 'pgrep -f "translate-local[.]mjs" | head -1'

const stamp = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(...a)

/** 读长期 key；没有就返回空串，让调用方报一条清楚的错，而不是抛栈。 */
function apiKey() {
  try {
    return readFileSync(KEY_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * 调一次 REST。body 走 `--data-binary`（不经 shell），所以引号与中文都安全。
 * 返回 `{ok, stdout, stderr, code}`：把「盒子在但命令失败」和「调用本身失败」分开，
 * 前者说明盒子活着，不该判成掉线。
 */
export function apiCall(path, payload, timeoutMs = 45_000) {
  const key = apiKey()
  if (!key) return { ok: false, code: 'no-key', stdout: '', stderr: `缺少 ${KEY_FILE}` }
  try {
    const out = execFileSync('curl', [
      '-sS', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-X', 'POST', `${API}${path}`,
      '-H', `Authorization: Bearer ${key}`,
      '-H', 'Content-Type: application/json',
      '--data-binary', JSON.stringify(payload ?? {}),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 })
    const data = JSON.parse(out || '{}')
    if (data.error) return { ok: false, code: data.error.code, stdout: '', stderr: data.error.message }
    return { ok: true, code: 'ok', stdout: String(data.stdout ?? ''), stderr: String(data.stderr ?? '') }
  } catch (err) {
    const msg = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || String(err.message ?? err)
    return { ok: false, code: 'curl', stdout: '', stderr: msg.slice(0, 160) }
  }
}

const execIn = (box, cmd, timeoutMs) => apiCall(`/v1/machines/${box}/exec`, { cmd }, timeoutMs)

/**
 * 探一台。返回 `{box, ok, pid, restarted, error}`。
 *
 * - 有 pid：正常。
 * - 盒子在响应但没有进程：跑 restart-farm.sh 拉起来。
 * - `machine_cooldown` / `operation_conflict`：盒子正在唤醒或状态切换，等一轮再说，
 *   这**不是**故障 —— 之前把它当失败，直接导致「明明 5 台都在跑却报 0/5」。
 */
export function checkBox(box, { quiet = false } = {}) {
  let r = execIn(box, PROBE)

  if (!r.ok && (r.code === 'machine_cooldown' || r.code === 'operation_conflict')) {
    if (!quiet) log(`${stamp()} ${box.padEnd(6)} 唤醒中（${r.code}），20s 后重试`)
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},20000)'])
    r = execIn(box, PROBE)
  }

  if (!r.ok) {
    log(`${stamp()} ${box.padEnd(6)} FAIL ${r.code}: ${String(r.stderr).slice(0, 90)}`)
    return { box, ok: false, error: `${r.code}: ${r.stderr}` }
  }

  const pid = r.stdout.trim().split('\n')[0]
  if (pid) {
    if (!quiet) log(`${stamp()} ${box.padEnd(6)} ok   pid=${pid}`)
    return { box, ok: true, pid }
  }

  // 盒子活着但农场不在：重启用独立脚本，避免在这里拼 pkill（会匹配到执行它的 shell 自身）。
  const rs = execIn(box, `sh ~/restart-farm.sh ${box}`, 60_000)
  const line = rs.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  if (rs.ok && /lanes=/.test(line)) {
    log(`${stamp()} ${box.padEnd(6)} 已重启 ${line}`)
    return { box, ok: true, restarted: true, pid: line }
  }
  const why = rs.ok ? `restart 无输出（${line.slice(0, 60)}）` : `${rs.code}: ${String(rs.stderr).slice(0, 80)}`
  log(`${stamp()} ${box.padEnd(6)} FAIL 无进程且重启失败：${why}`)
  return { box, ok: false, error: why }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const quiet = process.argv.includes('--quiet')
  const results = BOXES.map((b) => checkBox(b, { quiet }))
  const bad = results.filter((r) => !r.ok)
  // 计划任务窗口是隐藏的，输出没人看得见 —— 必须落一行日志。
  try {
    const logFile = join(ROOT, 'research', 'logs', 'keepalive.log')
    mkdirSync(dirname(logFile), { recursive: true })
    const line = `${new Date().toISOString()} ok=${results.filter((r) => r.ok).length}/${results.length}`
      + (bad.length ? ` bad=${bad.map((b) => b.box).join(',')}` : '')
    appendFileSync(logFile, line + '\n')
  } catch { /* 日志写不进去不影响保活本身 */ }
  if (bad.length) {
    log(`\n异常 ${bad.length} 台：${bad.map((b) => `${b.box}(${b.error ?? '未知'})`).join(', ')}`)
    process.exitCode = 1
  } else if (!quiet) {
    log(`\n${results.length} 台全部在线`)
  }
}
