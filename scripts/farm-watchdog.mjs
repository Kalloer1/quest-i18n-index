#!/usr/bin/env node
/**
 * farm 主机看护：每轮检查 5 台 instabox 的翻译进程，挂了就拉起来。
 *
 * 为什么是独立脚本 + 定时任务，而不是「后台子代理自己循环」：
 * 子代理一轮检查完、不再产生工具调用就结束了，维持不了「每 10 分钟一次、共 N 轮」。
 * 2026-10-23 就是这么停的：日志停在 15:36，一小时没动，而主机其实好好的。
 *
 * 为什么不用官方 instabox CLI：那个 Go 二进制不读 HTTPS_PROXY，直连 api.instabox.sh
 * TLS 握手超时。统一走 research/tmp/ibx.py（curl + 分块，已配 90 天 API key）。
 *
 * 用法：
 *   node scripts/farm-watchdog.mjs            # 检查 + 必要时重启
 *   node scripts/farm-watchdog.mjs --dry      # 只看，不动
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const BOXES = (process.env.FARM_BOXES || 'work,farm1,farm2,farm3,farm4').split(',').filter(Boolean)
const PY = process.env.IBX_PY || 'C:/Users/sss/.workbuddy/binaries/python/versions/3.13.12/python.exe'
const IBX = 'research/tmp/ibx.py'
const LOG = 'research/logs/farm-watch.log'
const STATE = 'research/tmp/farm-watchdog-state.json'
const DRY = process.argv.includes('--dry')
const MAX_FAILS = 3 // 同一台连续重启失败到这个数就停手，避免空转

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 16)

/** 单条命令必须 < 800 字节：本地代理对请求体有 ~1KB 限制，超了 curl 直接断连。 */
function ibx(box, cmd) {
  try {
    return execFileSync(PY, [IBX, 'exec', box, cmd], { encoding: 'utf8', timeout: 120000 })
  } catch (e) {
    return `__ERR__ ${(e.stderr || e.message || '').toString().split('\n')[0].slice(0, 80)}`
  }
}

const PROBE = [
  `printf 'PID=%s\\n' "$(pgrep -f 'translate-local[.]mjs' | head -1)"`,
  `printf 'CRLF=%s\\n' "$(grep -c $(printf '\\r') ~/farm-run.sh 2>/dev/null | head -1)"`,
  `printf 'LAST=%s\\n' "$(tail -1 ~/farm-run.log 2>/dev/null | cut -c1-46)"`,
].join('; ')

function probe(box) {
  const out = ibx(box, PROBE)
  if (out.startsWith('__ERR__')) return { error: out.slice(8) }
  const g = (k) => (new RegExp(`^${k}=(.*)$`, 'm').exec(out) || [])[1]?.trim() ?? ''
  return { pid: g('PID'), crlf: g('CRLF'), last: g('LAST') }
}

function fixScript(box) {
  return ibx(box, "cd ~/quest-repo && git checkout -q origin/main -- scripts/farm-run.sh && tr -d '\\r' < scripts/farm-run.sh > ~/farm-run.sh && sh -n ~/farm-run.sh && echo FIXED")
}

function restart(box) {
  // setsid + 全重定向：否则 exec 会一直等子进程，60 秒超时。
  return ibx(box, `rm -f ~/.quest-farm.lock; cd ~/quest-repo && setsid sh -c 'HOST=${box} exec sh ~/farm-run.sh >> ~/farm-launcher.log 2>&1' </dev/null >/dev/null 2>&1 & echo RESTARTED`)
}

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
mkdirSync(dirname(LOG), { recursive: true })
const lines = []
let unhealthy = 0

for (const box of BOXES) {
  let r = probe(box)
  if (r.error) {
    // 代理抖动很常见（curl 28/35），重试一次再判
    r = probe(box)
    if (r.error) {
      lines.push(`${now()} [${box}] 探测失败（代理抖动？）：${r.error}`)
      continue
    }
  }

  let action = ''
  if (r.crlf && r.crlf !== '0') {
    if (!DRY) { fixScript(box); action += '修脚本 ' }
    r.crlf = '0'
  }
  if (!r.pid) {
    if (!DRY) {
      restart(box)
      const after = probe(box)
      const ok = after.pid && !after.error
      if (ok) {
        action += `已重启 pid=${after.pid}`
        state[box] = 0
      } else {
        state[box] = (state[box] ?? 0) + 1
        action += `重启失败（第 ${state[box]} 次）`
        if (state[box] >= MAX_FAILS) action += ' —— 停止重试，需人工'
        unhealthy++
      }
    } else action += '（dry）进程不存在'
  } else {
    state[box] = 0
  }

  lines.push(`${now()} [${box}] pid=${r.pid || '-'} CRLF=${r.crlf || '?'} ${action || '正常'} | ${r.last}`)
}

const healthy = BOXES.length - unhealthy
lines.push(`${now()} [ROUND] ${healthy}/${BOXES.length} 健康${unhealthy ? '，有异常' : '，无处置'}`)
const text = lines.join('\n') + '\n'

if (!DRY) {
  appendFileSync(LOG, text)
  writeFileSync(STATE, JSON.stringify(state, null, 1))
}
process.stdout.write(text)
