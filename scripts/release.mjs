#!/usr/bin/env node
/**
 * 发布流水线（工单 04）：把流水线产出（patches/<slug>/）打成补丁包 zip 并发布。
 *
 * 流程：
 * 1. 对每个 slug：patches/<slug>/ 存在时打成 downloads/<slug>.zip（复用 pack-patch 的
 *    buildPatch，幂等：条目排序 + 固定时间戳，同输入逐字节相同）
 * 2. 重建站点数据（node scripts/build-site-data.mjs，合并 quark 镜像链接到 site/data.json）
 * 3. **显式路径** git add（禁止 -A）：downloads/<slug>.zip、research/quark-mirrors.json、site/data.json
 * 4. commit + push（--dry-run / --no-push 时跳过）
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

// CLI 以仓库根为工作目录运行（workflow / 文档均如此约定）；
// 用 cwd 而非 import.meta.url，便于测试在临时目录里搭建完整环境。
const ROOT = process.cwd()
// build-site-data.mjs 的绝对路径：数据输入按 cwd 解析（临时目录测试场景），
// 脚本本体按自身位置解析（临时目录里没有 scripts/）。
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PATCHES_DIR = join(ROOT, 'patches')
const DOWNLOADS_DIR = join(ROOT, 'downloads')

function usage() {
  console.error('用法: node scripts/release.mjs --ids <slug,slug> | --all [--dry-run] [--no-push]')
  process.exit(2)
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const noPush = args.includes('--no-push')
const idsArg = args.indexOf('--ids')
const all = args.includes('--all')
let IDS = []
if (idsArg >= 0) IDS = (args[idsArg + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
else if (!all) usage()
if (IDS.length && all) usage()

function exec(cmd) {
  console.log(`> ${cmd}`)
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
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

// 1. 打补丁包
const staged = []
const slugs = IDS.length ? IDS
  : (existsSync(PATCHES_DIR) ? readdirSync(PATCHES_DIR).filter(n => statSync(join(PATCHES_DIR, n)).isDirectory()) : [])
if (!slugs.length) {
  console.log('没有可发布的产出（patches/ 为空或指定的 slug 无产出）')
  process.exit(0)
}

let produced = 0
for (const slug of slugs) {
  const dir = join(PATCHES_DIR, slug)
  if (!existsSync(dir)) {
    console.log(`[${slug}] 找不到 ${dir}，跳过`)
    continue
  }
  const names = listFiles(dir)
  if (!names.length) {
    console.log(`[${slug}] ${dir} 为空，跳过`)
    continue
  }
  produced++
  const files = names.map(name => ({ name, text: readFileSync(join(dir, ...name.split('/')), 'utf8') }))
  const zip = buildPatch(files)
  mkdirSync(DOWNLOADS_DIR, { recursive: true })
  const outPath = join(DOWNLOADS_DIR, `${slug}.zip`)
  writeFileSync(outPath, zip)
  console.log(`[${slug}] ✔ ${relative(ROOT, outPath)}（${names.length} 个文件，${(zip.length / 1024).toFixed(1)} KB）`)
  staged.push(`downloads/${slug}.zip`)
}

if (!produced) {
  console.log('没有打出任何补丁包，无事可做')
  process.exit(0)
}

// 2. 重建站点数据（合并 quark 镜像链接）
exec(`node "${join(SCRIPT_DIR, 'build-site-data.mjs')}"`)
staged.push('site/data.json', 'research/quark-mirrors.json')

// 3. 显式路径暂存（禁止 git add -A）
for (const p of staged) {
  if (existsSync(join(ROOT, p))) exec(`git add -- "${p}"`)
}
const status = exec('git status --porcelain')
if (!status) {
  console.log('无变更，跳过提交')
  process.exit(0)
}

if (dryRun) {
  console.log('--dry-run：已暂存但未提交，待提交内容：')
  console.log(exec('git diff --cached --stat'))
  process.exit(0)
}

// 4. commit + push
exec(`git commit -m "发布补丁包: ${staged.filter(p => p.startsWith('downloads/')).map(p => p.slice(10, -4)).join(', ')}"`)
if (!noPush) {
  exec('git pull --rebase --autostash origin main')
  exec('git push')
  console.log('已推送')
} else {
  console.log('--no-push：已提交但未推送')
}
console.log('发布完成')
