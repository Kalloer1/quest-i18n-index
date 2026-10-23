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
// **猜名字**时必须含至少一个点号：`1.20.1`、`2.0.16_hf` 合法；`v62hf`、`65` 只是
// 构建号，拿它当版本会产生 `slug_v65.zip` 这种和上游版本对不上的名字。
// 受信字段（`.source.json` 的 `version`）不受这条限制——`v62` 是作者自己填的版本。

/** 去掉末尾扩展名（`.zip` / `.mrpack`），只剥「字母开头」的，避免吃掉 `x.1` 里的 `.1`。 */
const TRAILING_EXT = /\.[A-Za-z][A-Za-z0-9]{0,4}$/

/** 版本样式 token：必须以 `数字.数字` 开头，尾部允许字母/数字/点/下划线/连字符。 */
const VERSION_TOKEN = /[vV]?(\d+(?:\.\d+)+[A-Za-z0-9._-]*)/g

/**
 * 复合版本 token 里的 Minecraft 版本前缀：`1.16.5-1.38`、`1.21-12.9`。
 * 上游大量包名写成 `<MC>-<包版本>`，整段会被 `VERSION_TOKEN` 吞成一个 token，
 * 直接拿来当版本会得到 `1.16.5-1.38` 这种既不是 MC 版本也不是包版本的东西。
 * 只有「前缀落在真实 MC 版本区间（1.7–1.29）、且后面紧跟另一个带点号的版本」才剥；
 * `1.2.4-3.12` 这种 1.2.4 不是 MC 版本，不能动。
 */
const MC_PREFIX = /^1\.(?:[7-9]|1\d|2[0-9])(?:\.\d+)?-(?=[vV]?\d+\.\d)/

/** 文件名里不允许的字符（Windows 与 URL 双重口径）统一换成 `-`。 */
const UNSAFE = /[ \/\\:*?"<>|]/g

/** 版本串清洗：非法字符换 `-`，连续 `-` 收敛，去首尾 `-`。 */
export function sanitizeVersion(raw) {
  return String(raw ?? '')
    .replace(UNSAFE, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 从**上游名字**（`fileName` / `displayName`）里猜版本：最后一个含点号的版本串。
 *
 * 这是「猜」的那条路，只接受点号版本：`1.20.1 v62hf` → `1.20.1`。
 * 用「最后一个」而不是「结尾那个」：上游尾部常见 `v62hf` 这类没有点号的构建号，
 * 它不配当版本。**受信字段**（manifest / version_number）不走这里，它们原样接受
 * `v62` 这种无点号值（见 enrich-source-versions.mjs）。
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function extractVersionToken(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return null
  const stem = raw.replace(TRAILING_EXT, '')
  let last = null
  for (const m of stem.matchAll(VERSION_TOKEN)) last = m[1]
  // `<MC>-<包版本>`：剥掉 MC 前缀，否则拿到的复合串两头不靠（见 MC_PREFIX）。
  // `1.20-V1.3` 剥完还剩 `V1.3`，再去掉这个 v —— 模板里本来就有 `_v`。
  let stripped = last ? last.replace(MC_PREFIX, '').replace(/^[vV](?=\d)/, '') : ''
  // `1.0.5-1.0.5`：前后半段完全相同的复合串收敛成一个（作者把版本写了两遍）。
  const dup = /^([0-9][\w.]*)-\1$/.exec(stripped)
  if (dup) stripped = dup[1]
  const v = stripped ? sanitizeVersion(stripped) : ''
  return v || null
}

/**
 * 名字里「版本 token 之后」残留的 `vNN` 构建号。
 *
 * 用来识别「猜到了 Minecraft 版本」这种错法：`Better MC [FORGE] 1.16.5 v62`
 * 的含点号 token 是 `1.16.5`，尾部还剩 ` v62` —— 后者才是作者填的包版本。
 * 提取规则只有这一份（与 `extractVersionToken` 同一个 token 正则）。
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function trailingBuildTag(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return null
  const stem = raw.replace(TRAILING_EXT, '')
  let end = 0
  for (const m of stem.matchAll(VERSION_TOKEN)) end = m.index + m[0].length
  const hit = /[vV]\s*\d+/.exec(stem.slice(end))
  return hit ? hit[0].replace(/\s+/g, '') : null
}

/**
 * 从 `.source.json` 推导版本号。
 *
 * 顺序：
 * 0. `version`（受信字段，由 enrich-source-versions.mjs 从 MR `version_number` 或
 *    包内 manifest 落盘）——直接采用。有了它就不再从名字猜，NeoTech Reborn 那种
 *    `fileName` 写死成 `NeoTech Reborn.zip` 的包也能拿到真版本。
 * 1. `fileName` 里**最后一个含点号的版本串**（`1.20.1 v62hf` → `1.20.1`）。
 * 2. 退而取 `fileDate` 的 `YYYYMMDD`。
 * 3. 都没有 → null（调用方回退到旧名，不猜）。
 *
 * @param {{version?: string|null, fileName?: string|null, fileDate?: string|null}|null|undefined} source
 * @returns {string|null}
 */
export function versionFromSource(source) {
  if (!source || typeof source !== 'object') return null

  // 受信字段优先：非空即用，清洗后为空串（全是非法字符）才继续往下猜。
  if (source.version) {
    const trusted = sanitizeVersion(source.version)
    if (trusted) return trusted
  }

  const fileName = typeof source.fileName === 'string' ? source.fileName.trim() : ''
  const guessed = extractVersionToken(fileName)
  if (guessed) return guessed

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
  if (!version) return `${slug}.zip`
  // 受信字段常自带 v 前缀（MR version_number / manifest 的 `v62`），而模板里已有一个
  // `_v`，直接拼会得到 `<slug>_vv62.zip`。已带 v 时省掉模板的那个 v。
  return /^[vV]\d/.test(version) ? `${slug}_${version}.zip` : `${slug}_v${version}.zip`
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
