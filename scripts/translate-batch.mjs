#!/usr/bin/env node
/**
 * 批量翻译：从扫描结果里取可产出的包，按下载量顺序逐个「下载解包 → 翻译 → 打包 → 回写」。
 *
 * 为什么需要它（ADR-0009 U2/U3 用户裁决）：CI 只负责构建部署，翻译走本机/serv00。
 * 但 `translate.yml` 里那 6 个 step 的顺序本身就有坑（「先打包后镜像」是 819e705 才修对的），
 * 手动敲 6 条命令 + 4 个 env 前缀，漏一条就静默降级 —— 这正是 D7/D9 反复咬人的模式。
 * 把顺序固化成脚本，等于把踩过的坑锁死。
 *
 * 关键设计：
 *   - **断点续跑**：每包处理完立刻落盘状态到 `research/batch-state.json`，
 *     中断后重跑自动跳过已完成的，不重烧额度。
 *   - **串行**：免费层的触发变量是调用频度（实测），并行会把频度乘 N 直接撞限速。
 *   - **每 N 包回写一次**：serv00 磁盘只有 3.0G，`research/packs/` 是中间产物，
 *     处理完即删；只有 `patches/` 是产物，攒够 N 个 commit+push 一次。
 *
 * 用法：
 *   node scripts/translate-batch.mjs --platform cf --limit 271
 *   node scripts/translate-batch.mjs --platform cf --limit 10 --dry-run
 *   node scripts/translate-batch.mjs --platform cf --resume      # 跳过已完成
 *
 * 环境变量：
 *   CF_KEY             CurseForge API key（必需）
 *   BATCH_STATE        状态文件路径，默认 research/batch-state.json
 *   BATCH_PUSH_EVERY   每处理多少个包 commit+push 一次（默认 10；0 = 从不）
 *   BATCH_KEEP_PACKS   1 = 保留 research/packs（调试用）；默认删除
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_FILE = join(ROOT, 'research/scan-2k.tsv')
const STATE_FILE = process.env.BATCH_STATE || join(ROOT, 'research/batch-state.json')

/** 可产出的语言布局。其余（none/nodl/toobig/error/other）都不产出。 */
export const PRODUCIBLE_LAYOUTS = new Set(['separate-dir', 'separate-single', 'embedded'])

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) return true
  return /^-?\d+$/.test(v) ? Number(v) : v
}

/**
 * 解析扫描 TSV，返回按可产出性筛选后的包列表。
 *
 * @param {string} text research/scan-2k.tsv 内容
 * @param {{platform?: string}} [opts]
 * @returns {Array<{platform:string, id:string, slug:string, bytes:number, layout:string}>}
 */
export function parseScan(text, { platform } = {}) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return []
  const header = lines[0].split('\t')
  const idx = Object.fromEntries(header.map((c, i) => [c, i]))
  for (const col of ['platform', 'id', 'slug', 'format']) {
    if (!(col in idx)) throw new Error(`扫描 TSV 缺列：${col}`)
  }
  const rows = []
  for (const line of lines.slice(1)) {
    const f = line.split('\t')
    const plat = f[idx.platform]
    if (platform && plat !== platform) continue
    const layout = f[idx.format]
    if (!PRODUCIBLE_LAYOUTS.has(layout)) continue
    rows.push({
      platform: plat,
      id: f[idx.id],
      slug: f[idx.slug],
      bytes: Number(f[idx.bytes]) || 0,
      layout,
    })
  }
  // TSV 已按平台内下载量降序写入（scan-packs 用 index=downloads），保持原顺序即「按下载量」。
  return rows
}

/** 读状态文件；不存在返回空结构。 */
export function loadState(file = STATE_FILE) {
  if (!existsSync(file)) return { done: {}, failed: {} }
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    return { done: s.done ?? {}, failed: s.failed ?? {} }
  } catch {
    // 状态文件坏了不能让整批停摆：当作空状态重来（最坏只是重翻几包）。
    return { done: {}, failed: {} }
  }
}

/** 原子写状态：先写临时文件再 rename，避免中途被杀留下半截 JSON。 */
export function saveState(state, file = STATE_FILE) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n')
  // rename 在 Windows 上不能覆盖已存在文件，故先删。
  if (existsSync(file)) rmSync(file)
  writeFileSync(file, readFileSync(tmp, 'utf8'))
  rmSync(tmp)
}

const run = (cmd, args, env = {}) => {
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } })
}

async function main() {
  const platform = arg('platform', 'cf')
  const limit = arg('limit', 0)
  const dryRun = Boolean(arg('dry-run', false))
  const pushEvery = Number(arg('push-every', process.env.BATCH_PUSH_EVERY ?? 10))
  const keepPacks = process.env.BATCH_KEEP_PACKS === '1'

  if (!existsSync(SCAN_FILE)) {
    throw new Error(`找不到 ${SCAN_FILE}；先跑 scripts/scan-packs.mjs`)
  }
  const all = parseScan(readFileSync(SCAN_FILE, 'utf8'), { platform })
  const state = loadState()
  const pending = all.filter((p) => !state.done[p.slug])
  const worklist = limit > 0 ? pending.slice(0, limit) : pending

  console.log(`平台 ${platform}：可产出 ${all.length} 个，已完成 ${all.length - pending.length} 个，本次处理 ${worklist.length} 个`)
  if (dryRun) {
    worklist.forEach((p, i) => console.log(`${String(i + 1).padStart(3)}. ${p.slug} (${p.layout})`))
    return
  }

  let sincePush = 0
  let ok = 0
  let fail = 0

  for (let i = 0; i < worklist.length; i++) {
    const p = worklist[i]
    const tag = `[${i + 1}/${worklist.length}] ${p.slug}`
    const started = Date.now()
    try {
      console.log(`\n=== ${tag} (${p.layout}) ===`)
      run('node', ['scripts/prepare-pack.mjs', '--ids', p.slug], { CF_KEY: process.env.CF_KEY ?? '' })
      run('node', ['scripts/pipeline.mjs', '--ids', p.slug])
      run('node', ['scripts/release.mjs', '--ids', p.slug, '--package-only'])
      state.done[p.slug] = { layout: p.layout, at: new Date().toISOString(), ms: Date.now() - started }
      delete state.failed[p.slug]
      saveState(state)
      ok++
      sincePush++
      console.log(`=== ${tag} done ${Math.round((Date.now() - started) / 1000)}s ===`)
    } catch (e) {
      const msg = String(e?.message ?? e).slice(0, 300)
      state.failed[p.slug] = { layout: p.layout, at: new Date().toISOString(), error: msg }
      saveState(state)
      fail++
      console.log(`=== ${tag} FAILED: ${msg} ===`)
    }
    // research/packs/<slug> 是中间产物，删掉省磁盘（serv00 只有 3.0G）。
    if (!keepPacks) {
      const dir = join(ROOT, 'research/packs', p.slug)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
    // 每 N 包回写一次：断点损失最小，且不会让 3.0G 撑爆。
    if (pushEvery > 0 && sincePush >= pushEvery) {
      console.log(`\n--- 回写：${sincePush} 个包 commit+push ---`)
      try {
        run('git', ['add', '-A'])
        run('git', ['commit', '-q', '-m', `data(translate): 批量翻译 ${sincePush} 个整合包`])
        run('git', ['push', '-q', 'origin', 'HEAD:main'])
        sincePush = 0
      } catch (e) {
        console.log(`回写失败（不中断整批）：${String(e?.message ?? e).slice(0, 200)}`)
      }
    }
  }

  console.log(`\n=== 完成：ok ${ok} / failed ${fail} / 共 ${worklist.length} ===`)
  if (fail) {
    console.log('失败清单：')
    for (const p of worklist) {
      const f = state.failed[p.slug]
      if (f) console.log(`  ${p.slug}: ${f.error}`)
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
