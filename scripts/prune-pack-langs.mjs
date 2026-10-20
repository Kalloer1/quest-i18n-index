#!/usr/bin/env node
/**
 * 一次性清理：删掉 research/packs/<slug>/ 里非中英语言的目录与单文件。
 *
 * 为什么需要：`extract-pack.mjs` 的 OTHER_LANG_SINGLE 旧口径只拦单文件，
 * 目录式外文（lang/ja_jp/chapters/*.snbt 等）全被解了出来。
 * 33 个包累计 29 MB 噪声，而 release.mjs 会把 research/packs/<slug>
 * 原样 git add 进仓库。过滤器已在 2026-10-20 修好，但已经解出来的要清掉。
 *
 * 不重新下载：prepare-pack 是幂等跳过（目录里已有 .snbt 就不再下），
 * 所以清完不会自动补回。要补回只能 `prepare-pack --force`，而修复后的
 * 过滤器也不会再解外文，属预期。
 *
 * 用法：
 *   node scripts/prune-pack-langs.mjs --dry-run     # 只报不删
 *   node scripts/prune-pack-langs.mjs               # 真删
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKS_DIR = join(ROOT, 'research/packs')
const DRY = process.argv.includes('--dry-run')

const KEEP = new Set(['en_us', 'zh_cn'])

/** 收集要删的路径：`lang/<x>/` 目录（x 非中英）与 `lang/<x>.snbt` 单文件。 */
export function findPrunable(packsDir) {
  const out = []
  if (!existsSync(packsDir)) return out
  for (const slug of readdirSync(packsDir)) {
    const slugDir = join(packsDir, slug)
    if (!statSync(slugDir).isDirectory()) continue
    // lang/ 可能出现在任意层级（config/ftbquests/quests/lang 是常见形态）。
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        const isDir = statSync(full).isDirectory()
        if (name.toLowerCase() === 'lang' && isDir) {
          for (const entry of readdirSync(full)) {
            const entryFull = join(full, entry)
            const entryIsDir = statSync(entryFull).isDirectory()
            const base = entry.replace(/\.snbt$/i, '').toLowerCase()
            if (entryIsDir && !KEEP.has(base)) out.push({ slug, path: entryFull, kind: 'dir', bytes: sizeOf(entryFull) })
            else if (!entryIsDir && /\.snbt$/i.test(entry) && !KEEP.has(base)) {
              out.push({ slug, path: entryFull, kind: 'file', bytes: statSync(entryFull).size })
            }
          }
          continue
        }
        if (isDir) walk(full)
      }
    }
    walk(slugDir)
  }
  return out
}

function sizeOf(dir) {
  let total = 0
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) total += sizeOf(full)
    else total += st.size
  }
  return total
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const targets = findPrunable(PACKS_DIR)
  const totalBytes = targets.reduce((a, t) => a + t.bytes, 0)
  const bySlug = new Map()
  for (const t of targets) bySlug.set(t.slug, (bySlug.get(t.slug) ?? 0) + 1)

  console.log(`${DRY ? '[dry-run] ' : ''}待清理 ${targets.length} 项，共 ${(totalBytes / 1048576).toFixed(1)} MB`)
  for (const [slug, n] of [...bySlug].sort()) console.log(`  ${slug}: ${n} 项`)
  if (!DRY) {
    for (const t of targets) rmSync(t.path, { recursive: true, force: true })
    console.log(`已删除。`)
  }
}
