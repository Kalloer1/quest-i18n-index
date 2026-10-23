#!/usr/bin/env node
/**
 * 发布流水线（工单 04）：把流水线产出（patches/<slug>/）打成补丁包 zip 并发布。
 *
 * 流程：
 * 1. 对每个 slug：patches/<slug>/ 存在时打成 downloads/<slug>_v<version>.zip（复用 pack-patch 的
 *    buildPatch，幂等：条目排序 + 固定时间戳，同输入逐字节相同）。版本取自
 *    patches/<slug>/.source.json；取不到时沿用旧名 downloads/<slug>.zip（见 buildZipName）。
 *    改名只动文件名，**不动 zip 内容**——已上传夸克的分享链接不受影响。
 * 2. 重建索引（node scripts/build-index.mjs）：扫描 downloads/*.zip 置 delivered=true，
 *    使这些 slug 落入 downloadable 态（产品闭环的最后一环）
 * 3. 重建站点数据（node scripts/build-site-data.mjs，合并 quark 镜像链接到 site/data.json）
 * 4. **显式路径** git add（禁止 -A）：downloads/<slug>.zip、research/packs/<slug>.tar.gz
 *    （无归档时 fallback 到 research/packs/<slug> 目录）、
 *    research/index-dataset.json、research/quark-mirrors.json、site/data.json、glossary.json
 * 5. commit + push（--dry-run / --no-push 时跳过）
 *
 * 两段式（workflow 需要）：镜像步骤要上传 downloads/<slug>.zip，而 zip 由第 1 步产出。
 * `--package-only` 只跑第 1 步（不重建索引、不暂存、不提交），让
 * 「打包 → 镜像 → 发布」能按正确顺序串起来。
 *
 * 用法：
 *   node scripts/release.mjs --ids a,b
 *   node scripts/release.mjs --all
 *   node scripts/release.mjs --ids a --package-only
 *   node scripts/release.mjs --ids a --dry-run
 *   node scripts/release.mjs --ids a --no-push
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { buildPatch } from './pack-patch.mjs'

// 脚本本体按自身位置解析（临时目录里没有 scripts/）；数据输入按 cwd 解析。
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

// ---------- 补丁包文件名（版本化） ----------
//
// 命名规则：`<slug>_v<version>.zip`，版本取自 patches/<slug>/.source.json。
// **文件名是唯一可变的部分**：zip 内容（条目、顺序、时间戳）完全不变，所以已上传
// 夸克的分享链接不会因为改名失效——分享是按文件内容/上传产物算的，与本地名字无关。
//
// 版本串必须含至少一个点号：`1.20.1`、`2.0.16_hf` 合法；`v62hf`、`65` 只是构建号，
// 拿它当版本会产生 `slug_v65.zip` 这种和上游版本对不上的名字。

/** 去掉末尾扩展名（`.zip` / `.mrpack`），只剥「字母开头」的，避免吃掉 `x.1` 里的 `.1`。 */
const TRAILING_EXT = /\.[A-Za-z][A-Za-z0-9]{0,4}$/

/** 版本样式 token：必须以 `数字.数字` 开头，尾部允许字母/数字/点/下划线/连字符。 */
const VERSION_TOKEN = /[vV]?(\d+(?:\.\d+)+[A-Za-z0-9._-]*)/g

/** 文件名里不允许的字符（Windows 与 URL 双重口径）统一换成 `-`。 */
const UNSAFE = /[ \/\\:*?"<>|]/g

/** 版本串清洗：非法字符换 `-`，连续 `-` 收敛，去首尾 `-`。 */
function sanitizeVersion(raw) {
  return String(raw ?? '')
    .replace(UNSAFE, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 从 `.source.json` 推导版本号。
 *
 * 顺序：
 * 1. `fileName` 里**最后一个含点号的版本串**（`1.20.1 v62hf` → `1.20.1`）。
 *    用「最后一个」而不是「结尾那个」：上游文件名尾部常见 `v62hf`（构建号）这类
 *    没有点号的尾巴，它不配当版本。
 * 2. 退而取 `fileDate` 的 `YYYYMMDD`。
 * 3. 都没有 → null（调用方回退到旧名，不猜）。
 *
 * @param {{fileName?: string|null, fileDate?: string|null}|null|undefined} source
 * @returns {string|null}
 */
export function versionFromSource(source) {
  if (!source || typeof source !== 'object') return null

  const fileName = typeof source.fileName === 'string' ? source.fileName.trim() : ''
  if (fileName) {
    const stem = fileName.replace(TRAILING_EXT, '')
    let last = null
    for (const m of stem.matchAll(VERSION_TOKEN)) last = m[1]
    const v = last ? sanitizeVersion(last) : ''
    if (v) return v
  }

  const digits = String(source.fileDate ?? '').replace(/\D/g, '')
  if (digits) return digits.length > 8 ? digits.slice(0, 8) : digits

  return null
}

/**
 * 补丁包文件名：有版本 → `<slug>_v<version>.zip`；没版本 → 旧名 `<slug>.zip`。
 * 无版本时回退旧名而不是编一个版本号——宁可不带版本，也不产生假版本。
 *
 * @param {string} slug
 * @param {object|null} source `.source.json` 内容（可为 null）
 * @returns {string}
 */
export function buildZipName(slug, source) {
  const version = versionFromSource(source)
  return version ? `${slug}_v${version}.zip` : `${slug}.zip`
}

/** 读 patches/<slug>/.source.json（缺失或损坏都返回 null）。 */
function readSource(dir) {
  const file = join(dir, '.source.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function usage() {
  console.error('用法: node scripts/release.mjs --ids <slug,slug> | --all [--package-only] [--dry-run] [--no-push]')
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
 * @param {{ids?: string[], all?: boolean, packageOnly?: boolean, dryRun?: boolean, noPush?: boolean, cwd?: string, log?: (...args:any[])=>void}} [opts]
 * @returns {{produced:number, slugs:string[], staged:string[], committed:boolean, dryRun?:boolean, packageOnly?:boolean}}
 */
export function runRelease({ ids = [], all = false, packageOnly = false, dryRun = false, noPush = false, cwd = process.cwd(), log = console.log } = {}) {
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
    // 文件名带上游版本（`<slug>_v<version>.zip`）；拿不到版本就沿用旧名。
    const zipName = buildZipName(slug, readSource(dir))
    const outPath = join(DOWNLOADS_DIR, zipName)
    writeFileSync(outPath, zip)
    // 幂等：旧名 `<slug>.zip` 还在就删掉，否则 downloads/ 里同一个包会有两份
    // （build-index 会把两份都当成 delivered，站点也会多出一个下载入口）。
    const legacyPath = join(DOWNLOADS_DIR, `${slug}.zip`)
    if (zipName !== `${slug}.zip` && existsSync(legacyPath)) {
      rmSync(legacyPath, { force: true })
      log(`[${slug}] 清理旧名 ${relative(ROOT, legacyPath)}`)
    }
    log(`[${slug}] ✔ ${relative(ROOT, outPath)}（${names.length} 个文件，${(zip.length / 1024).toFixed(1)} KB）`)
    staged.push(`downloads/${zipName}`)
  }

  if (!produced) {
    log('没有打出任何补丁包，无事可做')
    return { produced: 0, slugs, staged, committed: false }
  }

  // 只打包：镜像步骤需要 zip 已存在，但不该在这时重建索引/提交。
  if (packageOnly) {
    log('--package-only：只打包，不重建索引、不暂存、不提交')
    return { produced, slugs, staged, committed: false, packageOnly: true }
  }

  // 2. 重建索引：downloads/ 里的新 zip 变成 delivered=true ⇒ state=downloadable。
  //    必须在 build-site-data 之前跑，否则站点数据里拿不到 download 区块。
  exec(`node "${join(SCRIPT_DIR, 'build-index.mjs')}"`)
  staged.push('research/index-dataset.json')

  // 3. 重建站点数据（合并 quark 镜像链接）
  exec(`node "${join(SCRIPT_DIR, 'build-site-data.mjs')}"`)
  staged.push('site/data.json', 'research/quark-mirrors.json', 'glossary.json')

  // 4. 显式路径暂存（禁止 git add -A）
  //    整合包英文源一并入库：质量闸门 validate-quests 需要它做基准键集，
  //    缺了它闸门只 warn 跳过该条（假绿灯）。与既有的 research/packs/aoc 同口径。
  //    新形态是 `<slug>.tar.gz`（scripts/lib/baseline.mjs，可复现）；历史包仍是解包目录，
  //    所以「有归档推归档，否则推目录」——目录 fallback 让旧包照常入库。
  const forceAdd = new Set()
  for (const slug of slugs) {
    const tgz = `research/packs/${slug}.tar.gz`
    const dirPath = `research/packs/${slug}`
    if (existsSync(join(ROOT, tgz))) staged.push(tgz)
    else {
      staged.push(dirPath)
      forceAdd.add(dirPath)
    }
  }
  for (const p of staged) {
    if (!existsSync(join(ROOT, p))) continue
    // 目录 fallback 必须 `-f`：`.gitignore` 里有 `research/packs/*/`（新解包目录不入库），
    // 而 git 会因此连**已跟踪**的旧包目录一起拒收（实测 git 2.55：`git add` 直接报
    // ignored 并让 release 抛错中断）。历史包的目录本来就该入库，force 只解除这条误伤。
    exec(`git add ${forceAdd.has(p) ? '-f ' : ''}-- "${p}"`)
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
  const packageOnly = args.includes('--package-only')
  const idsArg = args.indexOf('--ids')
  const all = args.includes('--all')
  let ids = []
  if (idsArg >= 0) ids = (args[idsArg + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
  else if (!all) usage()
  if (ids.length && all) usage()
  runRelease({ ids, all, packageOnly, dryRun, noPush })
}
