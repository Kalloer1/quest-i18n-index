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
 * 内嵌布局的双树去重：同一章节文件同时出现在 `config/ftbquests/quests/` 与
 * 根级 `ftbquests/quests/`（zip 里 overrides 打包失误的产物）时，只保留 config 侧。
 *
 * 为什么：游戏运行时只读 `config/ftbquests`，根级副本是过期导出；
 * 实测 dawncraft-russian-lang 根级副本含上游坏 SNBT（`\«…»\.`"." 序列），
 * 字符串提前闭合让整包解析失败，而 config 副本完好 —— 保 config 既符合
 * 游戏语义又绕开坏源，无需逐文件内容修复。
 * 键 = 去掉可选 `overrides/` 与可选 `config/` 前缀后的相对路径（大小写不敏感）。
 * 同键都是 config（或都不是）时保留先出现的，顺序稳定。
 * @param {string[]} names
 * @returns {string[]}
 */
export function dedupeConfigTree(names) {
  const list = Array.isArray(names) ? names : []
  const groups = new Map()
  const plain = []
  for (const n of list) {
    const norm = String(n).replace(/^overrides\//i, '')
    const m = /^(config\/)?ftbquests\/quests\/(.+)$/i.exec(norm)
    if (!m) { plain.push(n); continue }
    const key = m[2].toLowerCase()
    const cur = { name: n, isConfig: Boolean(m[1]) }
    const prev = groups.get(key)
    if (!prev) groups.set(key, cur)
    else if (cur.isConfig && !prev.isConfig) groups.set(key, cur)
  }
  return [...plain, ...[...groups.values()].map((g) => g.name)]
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
  if (layout === LAYOUT.EMBEDDED) return dedupeConfigTree(list.filter((n) => LAYOUT_PATTERNS.embedded.test(n)))
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
  // 纯 NUL 文件等同空文件，跳过（与 validate-quests 的 isPureNul 先例同口径）。
  // 实测（2026-10-24，`jetlagg-presents-the-altar`）：23 个章节里 8 个内容全是 0x00 ——
  // 上游写坏的空文件，没有任何可翻译文本；不跳过会让整包解析失败。
  // 输出 zip 里因此不含这几个文件 —— 上游那几个文件本来就是游戏读不动的垃圾。
  const isPureNul = (text) => String(text ?? '').replace(/\u0000/g, '').trim() === ''
  const parsed = (files ?? []).filter((f) => !isPureNul(f.text)).map((f) => ({ name: f.name, root: parse(f.text) }))
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
