#!/usr/bin/env node
/**
 * 发布流水线（工单 04）：把流水线产出（patches/<slug>/）打成补丁包 zip 并发布。
 *
 * 流程：
 * 1. 对每个 slug：patches/<slug>/ 存在时打成 downloads/<slug>.zip（复用 pack-patch 的
 *    buildPatch，幂等：条目排序 + 固定时间戳，同输入逐字节相同）
 * 2. 重建索引（node scripts/build-index.mjs）：扫描 downloads/*.zip 置 delivered=true，
 *    使这些 slug 落入 downloadable 态（产品闭环的最后一环）
 * 3. 重建站点数据（node scripts/build-site-data.mjs，合并 quark 镜像链接到 site/data.json）
 * 4. **显式路径** git add（禁止 -A）：downloads/<slug>.zip、research/index-dataset.json、
 *    research/quark-mirrors.json、site/data.json、glossary.json
 * 5. commit + push（--dry-run / --no-push 时跳过）
 *
 * 用法：
 *   node scripts/release.mjs --ids a,b
 *   node scripts/release.mjs --all
 *   node scripts/release.mjs --ids a --dry-run
 *   node scripts/release.mjs --ids a --no-push
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { buildPatch } from './pack-patch.mjs'

// 脚本本体按自身位置解析（临时目录里没有 scripts/）；数据输入按 cwd 解析。
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function usage() {
  console.error('用法: node scripts/release.mjs --ids <slug,slug> | --all [--dry-run] [--no-push]')
  process.exit(2)
}

/** 递归列出目录下全部文件（相对路径，/ 分隔）。 */
function listFiles(dir, base = dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base))
    else out.push(relative(base, full).replace(/\\/g, '/'))
  }
  return out
}

/**
 * 执行发布流水线。以 cwd 为仓库根运行（workflow / 文档均如此约定），
 * 便于测试在临时目录里搭建完整环境。
 *
 * @param {{ids?: string[], all?: boolean, dryRun?: boolean, noPush?: boolean, cwd?: string, log?: (...args:any[])=>void}} [opts]
 * @returns {{produced:number, slugs:string[], staged:string[], committed:boolean, dryRun?:boolean}}
 */
export function runRelease({ ids = [], all = false, dryRun = false, noPush = false, cwd = process.cwd(), log = console.log } = {}) {
  const ROOT = cwd
  const PATCHES_DIR = join(ROOT, 'patches')
  const DOWNLOADS_DIR = join(ROOT, 'downloads')

  const exec = (cmd) => {
    log(`> ${cmd}`)
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
  }

  /**
   * slug → 语言布局。内嵌布局包要用更强的备份警告 README（工单 03）。
   * 数据集字段是 `dataset`（build-index.mjs 产出）；读不到时返回空表（按分离布局处理）。
   */
  const loadLayouts = () => {
    try {
      const ds = JSON.parse(readFileSync(join(ROOT, 'research/index-dataset.json'), 'utf8'))
      const rows = ds.dataset ?? ds.packs ?? []
      return new Map(rows.filter((r) => r?.slug).map((r) => [r.slug, r.layout]))
    } catch {
      return new Map()
    }
  }

  // 1. 打补丁包
  const staged = []
  const slugs = ids.length ? ids
    : (existsSync(PATCHES_DIR) ? readdirSync(PATCHES_DIR).filter(n => statSync(join(PATCHES_DIR, n)).isDirectory()) : [])
  if (!slugs.length) {
    log('没有可发布的产出（patches/ 为空或指定的 slug 无产出）')
    return { produced: 0, slugs: [], staged, committed: false }
  }

  let produced = 0
  const layouts = loadLayouts()
  for (const slug of slugs) {
    const dir = join(PATCHES_DIR, slug)
    if (!existsSync(dir)) {
      log(`[${slug}] 找不到 ${dir}，跳过`)
      continue
    }
    const names = listFiles(dir)
    if (!names.length) {
      log(`[${slug}] ${dir} 为空，跳过`)
      continue
    }
    produced++
    const files = names.map(name => ({ name, text: readFileSync(join(dir, ...name.split('/')), 'utf8') }))
    const zip = buildPatch(files, { layout: layouts.get(slug) === 'embedded' ? 'embedded' : undefined })
    mkdirSync(DOWNLOADS_DIR, { recursive: true })
    const outPath = join(DOWNLOADS_DIR, `${slug}.zip`)
    writeFileSync(outPath, zip)
    log(`[${slug}] ✔ ${relative(ROOT, outPath)}（${names.length} 个文件，${(zip.length / 1024).toFixed(1)} KB）`)
    staged.push(`downloads/${slug}.zip`)
  }

  if (!produced) {
    log('没有打出任何补丁包，无事可做')
    return { produced: 0, slugs, staged, committed: false }
  }

  // 2. 重建索引：downloads/ 里的新 zip 变成 delivered=true ⇒ state=downloadable。
  //    必须在 build-site-data 之前跑，否则站点数据里拿不到 download 区块。
  exec(`node "${join(SCRIPT_DIR, 'build-index.mjs')}"`)
  staged.push('research/index-dataset.json')

  // 3. 重建站点数据（合并 quark 镜像链接）
  exec(`node "${join(SCRIPT_DIR, 'build-site-data.mjs')}"`)
  staged.push('site/data.json', 'research/quark-mirrors.json', 'glossary.json')

  // 4. 显式路径暂存（禁止 git add -A）
  for (const p of staged) {
    if (existsSync(join(ROOT, p))) exec(`git add -- "${p}"`)
  }
  const status = exec('git status --porcelain')
  if (!status) {
    log('无变更，跳过提交')
    return { produced, slugs, staged, committed: false }
  }

  if (dryRun) {
    log('--dry-run：已暂存但未提交，待提交内容：')
    log(exec('git diff --cached --stat'))
    return { produced, slugs, staged, committed: false, dryRun: true }
  }

  // 5. commit + push
  exec(`git commit -m "发布补丁包: ${staged.filter(p => p.startsWith('downloads/')).map(p => p.slice(10, -4)).join(', ')}"`)
  if (!noPush) {
    exec('git pull --rebase --autostash origin main')
    exec('git push')
    log('已推送')
  } else {
    log('--no-push：已提交但未推送')
  }
  log('发布完成')
  return { produced, slugs, staged, committed: true }
}

// ---------- CLI ----------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const noPush = args.includes('--no-push')
  const idsArg = args.indexOf('--ids')
  const all = args.includes('--all')
  let ids = []
  if (idsArg >= 0) ids = (args[idsArg + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
  else if (!all) usage()
  if (ids.length && all) usage()
  runRelease({ ids, all, dryRun, noPush })
}
