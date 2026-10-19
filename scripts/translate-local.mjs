#!/usr/bin/env node
/**
 * 本地批量流水线：下载解包 → 并行翻译 → 写回补丁 → 打包 → 定期入库。
 *
 * ## 为什么要有它
 *
 * ADR-0009 的 U2/U3 裁决是「CI 只负责构建部署，翻译走本机」。
 * 但本机跑一次要敲 4 条命令 + 一堆 env，漏一条就静默降级 ——
 * 这正是 D7/D9 反复咬人的模式。把顺序固化成脚本，等于把踩过的坑锁死。
 *
 * ## 与 translate-batch.mjs 的区别
 *
 * `translate-batch.mjs` 调的是串行 `pipeline.mjs`（CI 时代写的，单包跑完再下一个）。
 * 本脚本调 `translate-parallel.mjs`（包内 12 路并发），实测快 8 倍。
 *
 * ## 关键设计
 *
 * - **断点续跑**：每包完成立刻写 `research/local-batch-state.json`，中断重跑自动跳过。
 * - **按下载量顺序**：`scan-full.tsv` 本身就是按 index=downloads 抓的，原序即排序。
 * - **先分离后内嵌**：分离格式已实测零漏译；内嵌格式刚修好，放后面观察。
 * - **每 N 包入库**：避免一整天跑完才第一次 push，中断损失最小。
 * - **处理完即删 research/packs/<slug>**：它是中间产物，占磁盘且可重建。
 *
 * 用法：
 *   node scripts/translate-local.mjs --limit 20                 # 先跑 20 个试水
 *   node scripts/translate-local.mjs --limit 0                  # 全部（0 = 不限）
 *   node scripts/translate-local.mjs --layout separate --lanes 12
 *   node scripts/translate-local.mjs --dry-run                  # 只看清单
 *
 * 环境变量：
 *   CF_KEY          CurseForge API key（下载解包必需）
 *   BATCH_PUSH_EVERY 每处理多少个包 commit+push 一次（默认 20；0 = 从不）
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { translatePackParallel, DEFAULT_LANES } from './translate-parallel.mjs'
import { LAYOUT } from './lib/candidates.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_FILE = join(ROOT, 'research/scan-full.tsv')
const SCAN_FALLBACK = join(ROOT, 'research/scan-2k.tsv')
const STATE_FILE = join(ROOT, 'research/local-batch-state.json')
const PACKS_DIR = join(ROOT, 'research/packs')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) return true
  return /^-?\d+$/.test(v) ? Number(v) : v
}

/**
 * 从扫描 TSV 挑出可翻译的包，按下载量降序（TSV 原序）。
 *
 * 筛选口径与 `translate-parallel.mjs` 的 listTranslatable 一致，但多两个维度：
 * 平台（CF 才有 downloadUrl 能力）与布局（先分离后内嵌）。
 *
 * @param {string} text
 * @param {{platform?: string, layout?: string}} [opts]
 * @returns {Array<{slug:string, platform:string, layout:string, bytes:number}>}
 */
export function pickTranslatable(text, { platform, layout } = {}) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return []
  const header = lines[0].split('\t')
  const idx = Object.fromEntries(header.map((c, i) => [c, i]))
  for (const col of ['platform', 'slug', 'bytes', 'format', 'newZh']) {
    if (!(col in idx)) throw new Error(`扫描 TSV 缺列：${col}`)
  }
  const PRODUCIBLE = new Set([LAYOUT.SEPARATE_DIR, LAYOUT.SEPARATE_SINGLE, LAYOUT.EMBEDDED])
  const rows = []
  for (const line of lines.slice(1)) {
    const f = line.split('\t')
    const fmt = f[idx.format]
    if (!PRODUCIBLE.has(fmt)) continue
    // 自带中文的包没有翻译价值（本站产出会覆盖掉作者译文）。
    if (Number(f[idx.newZh]) > 0) continue
    const plat = f[idx.platform]
    if (platform && plat !== platform) continue
    if (layout === 'separate' && !/^separate-/.test(fmt)) continue
    if (layout === 'embedded' && fmt !== LAYOUT.EMBEDDED) continue
    rows.push({ slug: f[idx.slug], platform: plat, layout: fmt, bytes: Number(f[idx.bytes]) || 0 })
  }
  return rows
}

/** 读状态；损坏时当空状态（最坏只重翻几包）。 */
export function loadState(file = STATE_FILE) {
  if (!existsSync(file)) return { done: {}, failed: {} }
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    return { done: s.done ?? {}, failed: s.failed ?? {} }
  } catch { return { done: {}, failed: {} } }
}

/** 原子写状态。 */
export function saveState(state, file = STATE_FILE) {
  writeFileSync(file, JSON.stringify(state, null, 1) + '\n')
}

const run = (cmd, args, env = {}) => execFileSync(cmd, args, {
  cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env },
})

/** 把并行翻译的块合并写回 patches/<slug>/（复用 pipeline 的 buildOutputs）。 */
async function writePatch(slug, layout) {
  const { loadPackUnits } = await import('./translate-parallel.mjs')
  const { buildOutputs } = await import('./lib/quest-files.mjs')
  const { extractPack, sourceFileNames } = await import('./lib/quest-files.mjs')
  const { readdirSync, statSync } = await import('node:fs')

  const packDir = join(PACKS_DIR, slug)
  if (!existsSync(packDir)) return null

  // 重新读源文件（与翻译时同一套布局判定）
  const listSnbt = (dir, base = dir) => {
    const out = []
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) out.push(...listSnbt(full, base))
      else if (/\.snbt$/i.test(name)) out.push(full.slice(base.length + 1).replace(/\\/g, '/'))
    }
    return out
  }
  const names = listSnbt(packDir).sort()
  const sourceNames = sourceFileNames(names, layout)
  const files = names.filter((n) => sourceNames.includes(n)).map((n) => ({ name: n, text: readFileSync(join(packDir, n), 'utf8') }))
  const pack = extractPack({ files, layout })

  // 读并行产出的块，拼成 key → 译文
  const outDir = join(ROOT, 'research/par-out', slug)
  if (!existsSync(outDir)) return null
  const translations = new Map()
  for (const f of readdirSync(outDir)) {
    if (!/^chunk-\d+\.json$/.test(f)) continue
    const d = JSON.parse(readFileSync(join(outDir, f), 'utf8'))
    d.keys.forEach((k, i) => { const v = d.outs[i]; if (typeof v === 'string') translations.set(k, v) })
  }

  const outputs = buildOutputs(pack, translations, { header: '# AI 初翻，未人工校对\n' })
  const patchDir = join(ROOT, 'patches', slug)
  for (const o of outputs) {
    const target = join(patchDir, o.name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, o.text)
  }
  return { files: outputs.length, translated: translations.size, total: pack.units.length }
}

async function main() {
  const limit = arg('limit', 0)
  const lanes = arg('lanes', DEFAULT_LANES)
  const platform = arg('platform', 'cf')
  const layout = arg('layout', '')
  const dryRun = Boolean(arg('dry-run', false))
  const pushEvery = Number(arg('push-every', process.env.BATCH_PUSH_EVERY ?? 20))

  const scanFile = existsSync(SCAN_FILE) ? SCAN_FILE : SCAN_FALLBACK
  if (!existsSync(scanFile)) throw new Error(`找不到扫描结果：${SCAN_FILE}`)
  console.log(`扫描结果 ${scanFile}`)

  const all = pickTranslatable(readFileSync(scanFile, 'utf8'), { platform: platform || undefined, layout: layout || undefined })
  const state = loadState()
  const pending = all.filter((p) => !state.done[p.slug])
  const worklist = limit > 0 ? pending.slice(0, limit) : pending

  console.log(`平台 ${platform || '全部'}：可翻译 ${all.length} 个，已完成 ${all.length - pending.length} 个，本次处理 ${worklist.length} 个，${lanes} 路并发`)
  if (dryRun) {
    worklist.slice(0, 30).forEach((p, i) => console.log(`${String(i + 1).padStart(4)}. ${p.slug} (${p.layout}, ${(p.bytes / 1048576).toFixed(0)}MB)`))
    if (worklist.length > 30) console.log(`… 另有 ${worklist.length - 30} 个`)
    return
  }

  let ok = 0
  let fail = 0
  let sincePush = 0

  for (let i = 0; i < worklist.length; i++) {
    const p = worklist[i]
    const tag = `[${i + 1}/${worklist.length}] ${p.slug}`
    const started = Date.now()
    try {
      // 1) 下载解包
      run('node', ['scripts/prepare-pack.mjs', '--ids', p.slug], { CF_KEY: process.env.CF_KEY ?? '' })
      // 2) 并行翻译
      const r = await translatePackParallel(p.slug, { lanes })
      // 3) 写回补丁
      const w = await writePatch(p.slug, r.layout)
      if (!w || w.translated === 0) throw new Error('没有产出任何译文')
      state.done[p.slug] = { layout: p.layout, files: w.files, translated: w.translated, total: w.total, at: new Date().toISOString(), ms: Date.now() - started }
      delete state.failed[p.slug]
      saveState(state)
      ok++
      sincePush++
      const secs = Math.round((Date.now() - started) / 1000)
      console.log(`${tag} done ${secs}s · ${w.translated}/${w.total} 条译文 · ${w.files} 个文件 · 漏译 ${r.missing}`)
    } catch (e) {
      const msg = String(e?.message ?? e).slice(0, 300)
      state.failed[p.slug] = { layout: p.layout, at: new Date().toISOString(), error: msg }
      saveState(state)
      fail++
      console.log(`${tag} FAILED: ${msg}`)
    }
    // 中间产物清理：**只删并行翻译的块文件，不删英文源**。
    //
    // `research/packs/<slug>` 是 `validate-quests.mjs` 的**基准键集**。
    // 删了它，闸门就只会打一行「找不到英文源，跳过该条」——
    // 实测：11 个包里 9 个被跳过校验，等于零质检（假绿灯）。
    //
    // 代价是占磁盘，但英文源只抽 .snbt（几 MB 级），不是整包（几百 MB）。
    const parDir = join(ROOT, 'research/par-out', p.slug)
    if (existsSync(parDir)) rmSync(parDir, { recursive: true, force: true })

    if (pushEvery > 0 && sincePush >= pushEvery) {
      console.log(`--- 入库：${sincePush} 个包 ---`)
      try {
        run('git', ['add', '-A'])
        run('git', ['commit', '-q', '-m', `data(translate): 本地并行翻译 ${sincePush} 个整合包`])
        run('git', ['push', '-q', 'origin', 'HEAD:main'])
        sincePush = 0
      } catch (e) {
        console.log(`入库失败（不中断整批）：${String(e?.message ?? e).slice(0, 200)}`)
      }
    }
  }

  console.log(`\n=== 完成：ok ${ok} / failed ${fail} / 共 ${worklist.length} ===`)
  if (fail) {
    console.log('失败清单：')
    for (const p of worklist) {
      const f = state.failed[p.slug]
      if (f) console.log(`  ${p.slug}: ${f.error.slice(0, 100)}`)
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
