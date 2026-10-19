#!/usr/bin/env node
/**
 * 免费层限速探测：连续调用 bilibili Index-Translate，直到开始失败为止。
 *
 * 为什么需要它：ADR-0007 把免费层定为翻译主路，但它**没有任何公开配额文档**。
 * 2000 个整合包的翻译要发几十万次请求，不知道阈值就等于盲跑——
 * 一旦在第 N 次被限速，整批任务会在无人察觉时批量失败。
 *
 * 本脚本只做一件事：**测出「第几次开始失败」**，并把结果写成 JSON。
 * 它不翻译、不写 patches、不碰仓库任何产物。
 *
 * 判定口径：
 *   - 单次失败不判「被封」——免费层无 SLA，偶发抖动是常态；
 *   - 连续 CONSECUTIVE_LIMIT 次失败才判「已被限速」并停止；
 *   - 每次失败都记录 HTTP 码、耗时、错误体前 200 字符，供事后判断是限速还是别的问题。
 *
 * 用法：
 *   node scripts/probe-free-tier-limit.mjs --max 500 --interval 1000
 *   node scripts/probe-free-tier-limit.mjs --max 50 --interval 0     # 压测模式
 *
 * 环境变量：
 *   FREE_TIER_BASE_URL / FREE_TIER_MODEL  与 pipeline 同一套（见 lib/free-tier.mjs）
 *   PROBE_OUT                              结果 JSON 路径，默认 research/free-tier-probe.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { freeTierUrl, freeTierModel, FREE_TIER_TEMPERATURE } from './lib/free-tier.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env.PROBE_OUT || join(ROOT, 'research/free-tier-probe.json')

/** 连续失败多少次判「已被限速」。单次失败只是抖动。 */
export const CONSECUTIVE_LIMIT = 3

/** 探测用的固定文本：足够长以触发真实计费路径，又足够短以免浪费额度。 */
export const PROBE_TEXTS = [
  'Craft a Bartering Station',
  'Used to automatically &eTrade&r with nearby &6Piglins.',
  'Collect 64 iron ingots from the Nether',
  'Defeat the Ender Dragon and return to the Overworld',
  'Place a chest next to the furnace to start automation',
]

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt
}

/** 把一批文本压成免费层要求的「单条 user 消息 + instTrans」形态。 */
export function buildProbeBody(texts) {
  const lines = texts.map((t, i) => `L${i + 1}=${t.replace(/\n/g, '\\n')}`).join('\n')
  return {
    model: freeTierModel(),
    messages: [{
      role: 'user',
      content: `【源文】\n${lines}\n【约束要求】\n翻译成简体中文，逐行输出，保持 L1= 这样的前缀，不要输出解释。`,
    }],
    temperature: FREE_TIER_TEMPERATURE,
  }
}

/**
 * 发一次请求，返回结果而不抛错（探测脚本要记录失败，不能让失败中断循环）。
 * @param {number} n 第几次调用（1 起）
 * @param {typeof fetch} [fetchImpl]
 */
export async function probeOnce(n, fetchImpl = fetch) {
  const started = Date.now()
  try {
    const res = await fetchImpl(freeTierUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildProbeBody(PROBE_TEXTS)),
      signal: AbortSignal.timeout(60_000),
    })
    const ms = Date.now() - started
    const text = await res.text()
    if (!res.ok) {
      return { n, ok: false, status: res.status, ms, error: text.slice(0, 200) }
    }
    // 200 也要验内容：限速有时表现为「空 content」而不是错误码。
    let content = ''
    try { content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '' } catch { /* 非 JSON 视为失败 */ }
    if (!content.trim()) {
      return { n, ok: false, status: res.status, ms, error: `空响应体：${text.slice(0, 120)}` }
    }
    return { n, ok: true, status: res.status, ms, contentLen: content.length }
  } catch (e) {
    return { n, ok: false, status: 0, ms: Date.now() - started, error: String(e?.message ?? e).slice(0, 200) }
  }
}

async function main() {
  const max = arg('max', 500)
  const interval = arg('interval', 1000)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  console.log(`探测免费层限速：最多 ${max} 次，间隔 ${interval}ms`)
  console.log(`端点 ${freeTierUrl()} · 模型 ${freeTierModel()}\n`)

  const attempts = []
  let consecutive = 0
  let firstFailure = null
  let verdict = 'no-limit-observed'

  for (let n = 1; n <= max; n++) {
    const r = await probeOnce(n)
    attempts.push(r)
    const tag = r.ok ? 'ok ' : 'FAIL'
    console.log(`[${String(n).padStart(4)}] ${tag} ${r.status} ${r.ms}ms${r.ok ? '' : ' ' + r.error}`)

    if (r.ok) {
      consecutive = 0
    } else {
      consecutive++
      if (!firstFailure) firstFailure = r
      if (consecutive >= CONSECUTIVE_LIMIT) {
        verdict = 'limited'
        console.log(`\n连续 ${consecutive} 次失败 → 判定已被限速，停止探测`)
        break
      }
    }
    if (interval > 0) await sleep(interval)
  }

  const okCount = attempts.filter((a) => a.ok).length
  const failCount = attempts.length - okCount
  const latencies = attempts.filter((a) => a.ok).map((a) => a.ms).sort((a, b) => a - b)
  const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] : null)

  const report = {
    probedAt: new Date().toISOString(),
    verdict,
    endpoint: freeTierUrl(),
    model: freeTierModel(),
    intervalMs: interval,
    attempts: attempts.length,
    ok: okCount,
    failed: failCount,
    consecutiveLimit: CONSECUTIVE_LIMIT,
    firstFailure,
    latencyMs: { p50: pct(0.5), p95: pct(0.95), max: latencies.at(-1) ?? null },
    // 全量明细保留：事后要看「是不是固定次数后开始抖」这类模式，删了就再也拿不到。
    detail: attempts,
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
  console.log(`\n=== 结论：${verdict} ===`)
  console.log(`成功 ${okCount} / 失败 ${failCount} / 共 ${attempts.length}`)
  console.log(`延迟 p50=${report.latencyMs.p50}ms p95=${report.latencyMs.p95}ms max=${report.latencyMs.max}ms`)
  console.log(`→ ${OUT}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
