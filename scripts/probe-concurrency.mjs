#!/usr/bin/env node
/**
 * 免费层并发探测：测出「N 路并发时多久开始被限速」。
 *
 * 为什么必须先测：免费层的限速变量是**调用频度**（实测：串行 8s 间隔连跑 6 次全过；
 * 零间隔串行第 3 次就 504）。但「串行安全」不等于「并发安全」——
 * 5 路并发等于把频度乘 5，可能立刻撞墙。
 *
 * 不测就开跑 = 拿真实整合包的任务书去试错，浪费额度且可能产出半成品。
 * 本脚本用**真实任务书文本**（不是假文本），所以即使失败也不浪费——
 * 成功的块本身就是可用译文。
 *
 * 判定：
 *   - 每路独立计数成功/失败；
 *   - 任一路连续 CONSECUTIVE_LIMIT 次失败 → 判定该并发度不可用；
 *   - 记录每路的耗时分布，用于估算总吞吐。
 *
 * 用法：
 *   node scripts/probe-concurrency.mjs --lanes 5 --rounds 4
 *   node scripts/probe-concurrency.mjs --lanes 1,3,5,8 --rounds 3   # 扫描多个并发度
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { callFreeTier } from './lib/free-tier.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env.PROBE_OUT || join(ROOT, 'research/concurrency-probe.json')

/** 连续失败多少次判该并发度不可用。 */
export const CONSECUTIVE_LIMIT = 2

/**
 * 从真实整合包里取 N 条文本块（每块 CHUNK_SIZE 条）。
 *
 * 优先用已解包的 research/packs/<slug>；没有就退回内置的真实任务书样本。
 * @param {number} count 需要几块
 * @param {number} chunkSize 每块几条
 * @returns {string[][]}
 */
export function loadRealChunks(count, chunkSize) {
  const dir = join(ROOT, 'research/packs/fantasy-rpg-with-quests/config/ftbquests/quests/lang')
  const file = join(dir, 'en_us.snbt')
  let texts = []
  try {
    const raw = readFileSync(file, 'utf8')
    // 从真实 lang 文件里抽引号内的字符串值。
    const re = /:\s*"((?:[^"\\]|\\.)*)"/g
    let m
    while ((m = re.exec(raw)) !== null) {
      const v = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')
      if (v.trim().length > 3) texts.push(v)
    }
  } catch {
    // 解包目录不在时用内置真实样本（同样来自 fantasy-rpg-with-quests）。
    texts = [
      '&5&lQuest: &r&eNecropolis Ballista',
      '&7Unleash siege-level destruction',
      '&fThe &anecropolis ballista &fis a massive ranged &aweapon &fwith incredible power.',
      '&7Craft a Bartering Station',
      'Used to automatically &eTrade&r with nearby &6Piglins.',
      '&7Claim the Ice Dragon\'s essence',
      '&fHidden within the remains of a fallen dragon lies a source of immense &apower.',
      '&7Craft armor infused with the power of water',
      '&fThe &aAqua Set &fis a magical armor forged mainly from &akelp.',
      '&7Defeat the shadow of the night',
    ]
  }
  const chunks = []
  for (let i = 0; i < count; i++) {
    const chunk = []
    for (let j = 0; j < chunkSize; j++) chunk.push(texts[(i * chunkSize + j) % texts.length])
    chunks.push(chunk)
  }
  return chunks
}

/**
 * 跑一次并发探测。
 *
 * @param {{lanes: number, rounds: number, chunkSize?: number}} opts
 * @returns {Promise<object>} 报告
 */
export async function probeConcurrency({ lanes, rounds, chunkSize = 30 }) {
  const chunks = loadRealChunks(lanes * rounds, chunkSize)
  const stats = Array.from({ length: lanes }, () => ({ ok: 0, fail: 0, ms: [], consecutive: 0, dead: false }))
  const events = []
  let idx = 0

  // 每路是一个独立 worker，不断从共享队列取块 —— 这就是真实并行的形态。
  const worker = async (lane) => {
    const st = stats[lane]
    while (idx < chunks.length) {
      const my = idx++
      const texts = chunks[my]
      const started = Date.now()
      try {
        const outs = await callFreeTier(texts)
        const ms = Date.now() - started
        st.ok++
        st.consecutive = 0
        st.ms.push(ms)
        events.push({ lane, chunk: my, ok: true, ms, missing: outs.filter((x) => x == null).length })
      } catch (e) {
        st.fail++
        st.consecutive++
        events.push({ lane, chunk: my, ok: false, ms: Date.now() - started, error: String(e?.message ?? e).slice(0, 120) })
        if (st.consecutive >= CONSECUTIVE_LIMIT) { st.dead = true; break }
      }
    }
  }

  await Promise.all(Array.from({ length: lanes }, (_, i) => worker(i)))

  const okMs = stats.flatMap((s) => s.ms).sort((a, b) => a - b)
  const pct = (p) => (okMs.length ? okMs[Math.min(okMs.length - 1, Math.floor(okMs.length * p))] : null)
  const totalOk = stats.reduce((a, s) => a + s.ok, 0)
  const totalFail = stats.reduce((a, s) => a + s.fail, 0)
  const wallMs = events.reduce((a, e) => a + e.ms, 0) / Math.max(1, lanes)

  return {
    probedAt: new Date().toISOString(),
    lanes,
    rounds,
    chunkSize,
    ok: totalOk,
    failed: totalFail,
    deadLanes: stats.filter((s) => s.dead).length,
    // 吞吐：每秒完成多少块。这是决定「322 个包要跑多久」的核心数字。
    chunksPerSecond: wallMs > 0 ? Number((totalOk / (wallMs / 1000)).toFixed(3)) : 0,
    latencyMs: { p50: pct(0.5), p95: pct(0.95), max: okMs.at(-1) ?? null },
    perLane: stats.map((s, i) => ({ lane: i, ok: s.ok, fail: s.fail, dead: s.dead })),
    events,
  }
}

async function main() {
  const argOf = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
  }
  const lanesList = String(argOf('lanes', '5')).split(',').map(Number).filter((n) => n > 0)
  const rounds = Number(argOf('rounds', 4))

  const reports = []
  for (const lanes of lanesList) {
    console.log(`\n=== 探测 ${lanes} 路并发（${rounds} 轮/路）===`)
    const r = await probeConcurrency({ lanes, rounds })
    reports.push(r)
    console.log(`成功 ${r.ok} / 失败 ${r.failed} / 死掉的路 ${r.deadLanes}`)
    console.log(`吞吐 ${r.chunksPerSecond} 块/秒 · p50=${r.latencyMs.p50}ms p95=${r.latencyMs.p95}ms`)
    if (r.failed) {
      for (const e of r.events.filter((x) => !x.ok).slice(0, 3)) console.log(`  lane${e.lane} FAIL: ${e.error}`)
    }
    // 上一档已经死了，再加并发没意义。
    if (r.deadLanes > 0) { console.log(`→ ${lanes} 路已被限速，停止加大并发`); break }
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify({ reports }, null, 2) + '\n')
  console.log(`\n→ ${OUT}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
