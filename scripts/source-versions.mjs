#!/usr/bin/env node
/**
 * 把各补丁目录下的 `.source.json` 汇总成 `research/source-versions.json`。
 *
 * 为什么需要汇总：版本记录刻意放在**每个补丁目录**里（`patches/<slug>/.source.json`），
 * 这样多台 farm worker 只推自己那一个目录、按路径合并天然无冲突；站点要一次性读到
 * 全部版本，就需要一个生成物。本脚本是**单写入者**（只在 CI 的 farm-merge 里跑一次），
 * worker 不写它 —— 这正是它不会重蹈「多写入者 rebase 合并生成型 JSON」覆辙的原因。
 *
 * 输出形状：
 *   { "generatedAt": "...", "versions": { "<slug>": { slug, platform, fileId, fileName,
 *     fileDate, fetchedAt, recovered } } }
 *
 * 兼容性：没有 `.source.json` 的旧补丁直接跳过；坏 JSON 也跳过（打一行日志），
 * 绝不因为某个包的点文件坏了就让整份汇总失败。
 *
 * 用法：
 *   node scripts/source-versions.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATCHES_DIR = join(ROOT, 'patches')
const OUT_FILE = join(ROOT, 'research/source-versions.json')

export const SOURCE_FILE = '.source.json'

/**
 * 归一化一条版本记录：只保留约定字段，类型不对的一律置 null。
 *
 * 纯函数；`raw` 不是对象时返回 null（调用方跳过该目录）。
 *
 * @param {unknown} raw 解析后的 `.source.json`
 * @param {string} slug 目录名（`raw.slug` 缺失时兜底）
 * @returns {{slug: string, platform: 'cf'|'mr'|null, fileId: number|null, fileName: string|null, fileDate: string|null, fetchedAt: string|null, recovered: boolean}|null}
 */
export function normalizeSourceInfo(raw, slug) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const platform = str(raw.platform)
  return {
    slug: str(raw.slug) ?? slug,
    platform: platform === 'cf' || platform === 'mr' ? platform : null,
    fileId: Number.isFinite(raw.fileId) ? raw.fileId : null,
    fileName: str(raw.fileName),
    fileDate: str(raw.fileDate),
    fetchedAt: str(raw.fetchedAt),
    recovered: raw.recovered === true,
  }
}

/**
 * 扫描 `patches/<slug>/.source.json`，返回 `slug → 记录` 的有序映射。
 *
 * 目录按名字排序，保证同一输入两次生成逐字节相同（幂等）。
 * 缺文件、非目录、坏 JSON 全部跳过；`log` 只用于提示坏 JSON，不抛错。
 *
 * @param {string} patchesDir
 * @param {{log?: (msg: string) => void}} [options]
 * @returns {Record<string, ReturnType<typeof normalizeSourceInfo>>}
 */
export function collectSourceVersions(patchesDir, { log = () => {} } = {}) {
  const versions = {}
  let names
  try {
    names = readdirSync(patchesDir)
  } catch {
    return versions
  }
  for (const slug of names.sort()) {
    if (slug.startsWith('.')) continue
    const dir = join(patchesDir, slug)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    let text
    try {
      text = readFileSync(join(dir, SOURCE_FILE), 'utf8')
    } catch {
      continue // 旧补丁没有版本记录：正常情况，静默跳过
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      log(`[${slug}] ${SOURCE_FILE} 不是合法 JSON，跳过`)
      continue
    }
    const info = normalizeSourceInfo(raw, slug)
    if (!info) {
      log(`[${slug}] ${SOURCE_FILE} 不是对象，跳过`)
      continue
    }
    versions[slug] = info
  }
  return versions
}

/**
 * 生成汇总对象。
 * @param {string} patchesDir
 * @param {{now?: string, log?: (msg: string) => void}} [options]
 * @returns {{generatedAt: string, versions: Record<string, object>}}
 */
export function buildSourceVersions(patchesDir, { now = new Date().toISOString(), log } = {}) {
  return { generatedAt: now, versions: collectSourceVersions(patchesDir, { log }) }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const out = buildSourceVersions(PATCHES_DIR, { log: (m) => console.log(m) })
  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n')
  console.log(`→ ${OUT_FILE}（${Object.keys(out.versions).length} 个补丁有版本记录）`)
}
