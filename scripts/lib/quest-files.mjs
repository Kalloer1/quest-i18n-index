#!/usr/bin/env node
/**
 * 任务书文本的抽取与产出：把整合包内的英文源文件解析成「待译单元」，再把译文写回。
 *
 * 三种语言布局（GLOSSARY.md）：
 *   - 分离·目录   `lang/en_us/*.snbt` → 产出 `lang/zh_cn/*.snbt`（纯新增文件）
 *   - 分离·单文件 `lang/en_us.snbt`   → 产出 `lang/zh_cn.snbt`（纯新增文件）
 *   - 内嵌        `chapters/*.snbt`   → 就地改写同路径文件（覆盖式）
 *
 * 待译单元的键 = `<文件名>::<SNBT 路径>`，全局唯一，便于跨文件合并译文。
 * 内嵌布局只翻译文本字段（`title` / `subtitle` / `description` / `text`），
 * 不碰 `item` / `id` / `type` 这类结构化字段。
 *
 * 纯函数、无 IO（文件读取由调用方注入）。
 */
import { parse, serialize, collectStrings, setString } from '../snbt.mjs'
import { LAYOUT, LAYOUT_PATTERNS } from './candidates.mjs'

/** 内嵌布局里可翻译的字段名。 */
export const TEXT_FIELDS = new Set(['title', 'subtitle', 'description', 'text'])

/**
 * 该 SNBT 路径是否是可翻译文本。
 * 分离布局：lang 文件里的每个字符串都是译文，全部可翻。
 * 内嵌布局：只翻文本字段（去掉 `[i]` 下标后的末段字段名）。
 * @param {string} path
 * @param {string} layout
 * @returns {boolean}
 */
export function isTranslatablePath(path, layout) {
  if (layout !== LAYOUT.EMBEDDED) return true
  const field = path.replace(/\[\d+\]$/, '').split('.').pop()
  return TEXT_FIELDS.has(field)
}

/**
 * 从整合包文件路径列表里选出英文源文件。
 * @param {string[]} names
 * @param {string} layout
 * @returns {string[]}
 */
export function sourceFileNames(names, layout) {
  const list = Array.isArray(names) ? names : []
  if (layout === LAYOUT.SEPARATE_DIR) return list.filter((n) => LAYOUT_PATTERNS.sepDirEn.test(n))
  if (layout === LAYOUT.SEPARATE_SINGLE) return list.filter((n) => LAYOUT_PATTERNS.sepFileEn.test(n))
  if (layout === LAYOUT.EMBEDDED) return list.filter((n) => LAYOUT_PATTERNS.embedded.test(n))
  return []
}

/**
 * 英文源文件路径 → 产出文件路径。
 * 分离布局换成 `zh_cn`；内嵌布局路径不变（就地改写）。
 * @param {string} name
 * @param {string} layout
 * @returns {string}
 */
export function outputName(name, layout) {
  if (layout === LAYOUT.SEPARATE_SINGLE) return name.replace(/en_us\.snbt$/i, 'zh_cn.snbt')
  if (layout === LAYOUT.SEPARATE_DIR) return name.replace(/\/en_us\//i, '/zh_cn/')
  return name
}

/**
 * 解析英文源文件，抽出待译单元。
 * @param {{files: Array<{name: string, text: string}>, layout: string}} input
 * @returns {{layout: string, files: Array<{name: string, root: object}>, units: Array<{file: string, key: string, path: string, node: object, text: string}>}}
 */
export function extractPack({ files, layout }) {
  const parsed = (files ?? []).map((f) => ({ name: f.name, root: parse(f.text) }))
  const units = []
  for (const pf of parsed) {
    for (const { path, node } of collectStrings(pf.root)) {
      if (!isTranslatablePath(path, layout)) continue
      units.push({ file: pf.name, key: `${pf.name}::${path}`, path, node, text: node.value })
    }
  }
  return { layout, files: parsed, units }
}

/**
 * 把译文写回 AST 并序列化，产出文件列表。
 * 未命中译文的单元保持英文原文（回退），由调用方按回退率把关。
 * @param {ReturnType<typeof extractPack>} pack
 * @param {Map<string,string>} translations
 * @param {{header?: string}} [options]
 * @returns {Array<{name: string, text: string}>}
 */
export function buildOutputs(pack, translations, { header = '' } = {}) {
  const byFile = new Map()
  for (const u of pack.units) {
    if (!byFile.has(u.file)) byFile.set(u.file, [])
    byFile.get(u.file).push(u)
  }
  const outputs = []
  for (const pf of pack.files) {
    for (const u of byFile.get(pf.name) ?? []) {
      const zh = translations.get(u.key)
      if (typeof zh === 'string' && zh.length > 0) setString(u.node, zh)
    }
    outputs.push({ name: outputName(pf.name, pack.layout), text: header + serialize(pf.root) })
  }
  return outputs
}
