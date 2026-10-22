#!/usr/bin/env node
/**
 * 质量闸门（工单 02）：校验翻译产出与英文源的结构一致性。
 *
 * 闸门分线 —— 判**失败** / 只**警告**：
 *
 *   【失败】会真的渲染错或丢内容：
 *   - 键集合：缺键 / 多键（键 = `<文件名>::<SNBT 路径>`，与流水线一致）
 *   - 色码：译文引入的畸形 `&`/`§` 序列（后继不是 [0-9a-fk-orx] 或位于行尾）
 *   - 占位符：非 `%%` 占位符（%s / %1$s / %value% 等）的种类或数量不一致
 *   - SNBT 结构：产出不可解析 / 不可序列化
 *   - 编码：BOM（必须 UTF-8 无 BOM）
 *   - 找不到英文源：绝不退回「自检」产生假绿灯
 *
 *   【警告】只是样式选择，不阻断：
 *   - 色码数量差异（丢/加颜色码）
 *   - `%%` 占位符差异（转义字面百分号）
 *
 * 用法：
 *   import { validatePair } from './validate-quests.mjs'
 *   node scripts/validate-quests.mjs <英文源目录> <产出目录> [--layout embedded|separate-dir|separate-single]
 *
 * 退出码：0 全部通过；1 有校验失败；2 用法错误。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { parse, serialize, SnbtParseError } from './snbt.mjs'
import { countColorCodes, countMalformedCodes } from './lib/format-codes.mjs'
import { readBaseline } from './lib/baseline.mjs'
import { LAYOUT, LAYOUT_PATTERNS } from './lib/candidates.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATCHES_DIR = join(ROOT, 'patches')
const PACKS_DIR = join(ROOT, 'research/packs')
const DATASET_FILE = join(ROOT, 'research/index-dataset.json')

/** 抽取占位符，返回「占位符 → 次数」。先匹配带位置/包裹的形式，再匹配简单形式。 */
export function extractPlaceholders(value) {
  const counts = new Map()
  const bump = (token) => counts.set(token, (counts.get(token) ?? 0) + 1)
  const re = /%%|%\d+\$[sdfx]|%[sdfx]|%[A-Za-z_][A-Za-z0-9_]*%|%\d+%/g
  let m
  while ((m = re.exec(value)) !== null) bump(m[0])
  return counts
}

function compareCounts(enCounts, zhCounts) {
  const all = new Set([...enCounts.keys(), ...zhCounts.keys()])
  const diffs = []
  for (const token of [...all].sort()) {
    const a = enCounts.get(token) ?? 0
    const b = zhCounts.get(token) ?? 0
    if (a !== b) diffs.push(`${token}（en ${a} / zh ${b}）`)
  }
  return diffs
}

/** 产出文件名 → 英文源文件名（outputName 的逆变换）。 */
export function enSourceName(outName, layout) {
  if (layout === LAYOUT.SEPARATE_SINGLE) return outName.replace(/zh_cn\.snbt$/i, 'en_us.snbt')
  if (layout === LAYOUT.SEPARATE_DIR) return outName.replace(/\/zh_cn\//i, '/en_us/')
  return outName
}

/**
 * 校验一对（英文源文件集，译文产出文件集）。
 * @param {Array<{name: string, text: string}>} enFiles
 * @param {Array<{name: string, text: string}>} zhFiles
 * @param {{layout?: string, label?: string}} options
 * @returns {{problems: string[], warnings: string[], keyCount: number}}
 */
export function validatePair(enFiles, zhFiles, { layout = LAYOUT.EMBEDDED, label = '' } = {}) {
  const problems = []
  const warnings = []
  const prefix = label ? `${label}: ` : ''

  // 找不到英文源判失败：缺键 / 色码 / 占位符比对会全部空转（假绿灯的根因）。
  if (!Array.isArray(enFiles) || enFiles.length === 0) {
    return { problems: [`${prefix}找不到英文源，无法做完整校验`], warnings, keyCount: 0 }
  }

  // BOM：产出必须 UTF-8 无 BOM。
  for (const f of zhFiles) {
    if (f.text.charCodeAt(0) === 0xfeff) problems.push(`${prefix}${f.name} 含 BOM，必须为 UTF-8 无 BOM`)
  }

  // SNBT 结构：英文源与产出都必须可解析、可序列化。
  //
  // 例外：**纯 NUL 文件等同空文件**，跳过。
  // 实测（2026-10-22，`create-cogs-cataclysm`）：重下两次后仍有 3 个 `.snbt`
  // 大小 565/291/474 字节但内容全是 0x00 —— 上游作者写坏的。这类文件没有
  // 任何可翻译文本，重下治不好它；判红只会让整批闸门红着。
  // 注意判据收得很窄：只有「去掉 NUL 后为空」才算，真损坏（有内容但结构错）仍判红。
  const isPureNul = (text) => String(text ?? '').replace(/\u0000/g, '').trim() === ''
  const parseAll = (files, kind) => {
    const map = new Map()
    for (const f of files) {
      if (isPureNul(f.text)) continue
      try {
        const root = parse(f.text)
        serialize(root) // 可序列化性也属验收
        map.set(f.name, root)
      } catch (err) {
        const pos = err instanceof SnbtParseError ? `（位置 ${err.index}）` : ''
        problems.push(`${prefix}${kind} ${f.name} 不可解析${pos}: ${String(err.message).slice(0, 120)}`)
      }
    }
    return map
  }
  const enMap = parseAll(enFiles, '英文源')
  const zhMap = parseAll(zhFiles, '产出')
  if (problems.some((p) => p.includes('不可解析'))) {
    return { problems, warnings, keyCount: 0 }
  }

  // 键集合：缺键 / 多键判失败。
  const keysOf = (root, name) => {
    // 与流水线 extractPack 同口径：只收集字符串值节点（collectStrings 的路径）。
    // 这里不导入 quest-files 以避免布局过滤 —— 闸门要的是「键集合一致」，与可翻性无关。
    const out = []
    const visit = (node, path) => {
      if (node.type === 'compound') {
        for (const e of node.entries) {
          const key = e.key.type === 'string' ? e.key.value : serialize(e.key)
          visit(e.value, path ? `${path}.${key}` : key)
        }
      } else if (node.type === 'list') {
        node.items.forEach((it, idx) => visit(it.value, `${path}[${idx}]`))
      } else if (node.type === 'string') {
        out.push([`${name}::${path}`, node.value])
      }
    }
    visit(root.value, '')
    return out
  }

  const enEntries = new Map()
  // 只把**英文源**文件计作基准键集。
  // 实测：All of Create 这类包同时带 `lang/en_us.snbt` 与 `lang/pt_br.snbt`（葡语），
  // 若把所有输入文件都当基准，校验器会要求产出里也有葡语译文——那不是我们的职责。
  //
  // 内嵌布局同理，且更严格：产出只改写 `chapters/*.snbt`（见 quest-files.sourceFileNames），
  // `data.snbt`、`reward_tables/*.snbt` 本布局不动，产出侧也不该被要求出现。
  // 旧口径对 embedded 直接 `return true`，把这些文件也算进基准，于是判出「缺键」假失败；
  // 长期没暴露是因为 resolveLayout 优先判分离布局，带 lang/en_us 的包走不到这条分支。
  const isEnSource = (name) => {
    if (layout === LAYOUT.SEPARATE_SINGLE) return /(^|\/)en_us\.snbt$/i.test(name)
    if (layout === LAYOUT.SEPARATE_DIR) return /(^|\/)lang\/en_us\//i.test(name)
    // 内嵌布局：章节文件本身就是源（与 LAYOUT_PATTERNS.embedded 同一判据）。
    return LAYOUT_PATTERNS.embedded.test(name)
  }
  for (const [name, root] of enMap) {
    if (!isEnSource(name)) continue
    for (const [k, v] of keysOf(root, name)) enEntries.set(k, v)
  }
  // 基准集被筛空（英文源里一个章节文件都没有）时不许 0 键空转绿灯。
  if (!enFiles.some((f) => isEnSource(f.name))) {
    problems.push(`${prefix}找不到英文源，无法做完整校验`)
  }
  const zhEntries = new Map()
  for (const [name, root] of zhMap) {
    // 内嵌布局：产出侧同样只算本布局负责改写的文件。多出来的非章节文件
    // （例如有人手动把 data.snbt 也复制了一份）允许存在，但不进入键集合比对；
    // 它们仍要过上面的 BOM / 可解析 / 可序列化检查。
    if (layout === LAYOUT.EMBEDDED && !LAYOUT_PATTERNS.embedded.test(name)) continue
    for (const [k, v] of keysOf(root, name)) zhEntries.set(k, v)
  }

  // 产出文件名换回英文源名再比键（分离布局 en_us → zh_cn 会换名）。
  const remap = (entries) => {
    const out = new Map()
    for (const [k, v] of entries) {
      const [file, path] = splitOnce(k, '::')
      out.set(`${enSourceName(file, layout)}::${path}`, v)
    }
    return out
  }
  const enKeys = remap(enEntries)
  const zhKeys = remap(zhEntries)

  const missing = [...enKeys.keys()].filter((k) => !zhKeys.has(k))
  const extra = [...zhKeys.keys()].filter((k) => !enKeys.has(k))
  if (missing.length) problems.push(`${prefix}缺少 ${missing.length} 个键: ${missing.slice(0, 10).join(', ')}`)
  if (extra.length) problems.push(`${prefix}多出 ${extra.length} 个键: ${extra.slice(0, 10).join(', ')}`)

  // 色码：译文引入的畸形序列判失败；数量差异只警告。
  //
  // 字面转义 `\&`（SNBT 里写作 `\\&`）的特殊处理（实测 2026-10-20，chosens-create-integrated）：
  // 原文 "Create Crafts \& Additions" 里的 `\&` 是**字面 &**，不是色码。
  // 译成中文后这个转义失去意义，模型会把反斜杠去掉写成裸 `&`——
  // 按旧口径裸 `&`（后跟空格）算畸形色码，于是判了假失败。
  // 正确口径：译文允许把原文的 `\&` 还原成裸 `&`，只要**裸 `&` 总数不超过
  // 原文「字面转义 + 合法色码」的总数**。超出的部分才是凭空多出来的畸形 `&`。
  const malformed = []
  const countMismatch = []
  for (const [k, enVal] of enKeys) {
    const zhVal = zhKeys.get(k)
    if (zhVal === undefined) continue
    const enLiteralEscapes = String(enVal ?? '').split('\\&').length - 1
    const enMal = countMalformedCodes(enVal)
    const zhMal = countMalformedCodes(zhVal)
    // 原文里有字面转义时，允许译文多出至多 enLiteralEscapes 个畸形 `&`。
    if (zhMal > enMal + enLiteralEscapes) malformed.push(`${k}（en ${enMal} / zh ${zhMal}）`)
    const enCount = countColorCodes(enVal)
    const zhCount = countColorCodes(zhVal)
    if (enCount !== zhCount) countMismatch.push(`${k}（en ${enCount} / zh ${zhCount}）`)
  }
  if (malformed.length) {
    problems.push(`${prefix}译文引入畸形色码序列 ${malformed.length} 个键: ${malformed.slice(0, 10).join('; ')}`)
  }
  if (countMismatch.length) {
    warnings.push(`${prefix}色码数量不一致 ${countMismatch.length} 个键（样式差异，不阻断）: ${countMismatch.slice(0, 10).join('; ')}`)
  }

  // 占位符：非 %% 的种类与数量必须一致（失败）；%% 差异只警告。
  const placeholderMismatch = []
  const percentMismatch = []
  for (const [k, enVal] of enKeys) {
    const zhVal = zhKeys.get(k)
    if (zhVal === undefined) continue
    const diffs = compareCounts(extractPlaceholders(enVal), extractPlaceholders(zhVal))
    const fatal = diffs.filter((d) => !d.startsWith('%%'))
    const percent = diffs.filter((d) => d.startsWith('%%'))
    if (fatal.length) placeholderMismatch.push(`${k} [${fatal.join(', ')}]`)
    if (percent.length) percentMismatch.push(`${k} [${percent.join(', ')}]`)
  }
  if (placeholderMismatch.length) {
    problems.push(`${prefix}占位符不一致 ${placeholderMismatch.length} 个键: ${placeholderMismatch.slice(0, 10).join('; ')}`)
  }
  if (percentMismatch.length) {
    warnings.push(`${prefix}%% 占位符差异 ${percentMismatch.length} 个键（样式差异，不阻断）: ${percentMismatch.slice(0, 10).join('; ')}`)
  }

  return { problems, warnings, keyCount: enKeys.size }
}

function splitOnce(s, sep) {
  const i = s.indexOf(sep)
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + sep.length)]
}

// ---------- CLI ----------

function listSnbt(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listSnbt(full).map((n) => `${name}/${n}`))
    else if (/\.snbt$/i.test(name)) out.push(name)
  }
  return out
}

// ---------- 批量模式 ----------

/**
 * 判定某个 slug 的校验布局。
 *
 * 优先用**磁盘实况**（英文源文件名），数据集只做兵子。
 *
 * 为何不能直接信数据集：同一个 slug 在 CF 与 Modrinth 会各有一条记录，
 * 两条的 layout 可能不同（实测 `create-evolution-renewed` 是 CF=separate-single / MR=embedded）。
 * 旧实现用 `map.set(slug, layout)` 按数据集顺序覆盖 → **last-wins**，
 * 取到 embedded，于是把 `chapters/*.snbt` 当基准键集，
 * 报出「缺 11301 个键 + 多出 1346 个键」的假失败（这个包其实完好）。
 *
 * @param {string[]} enNames 英文源目录下的全部 .snbt 相对路径
 * @param {string|undefined} fromDataset 数据集里的 layout（仅作兵子）
 * @returns {string}
 */
export function resolveLayout(enNames, fromDataset) {
  const list = Array.isArray(enNames) ? enNames : []
  const sepDir = list.filter((n) => LAYOUT_PATTERNS.sepDirEn.test(n)).length
  const sepFile = list.filter((n) => LAYOUT_PATTERNS.sepFileEn.test(n)).length
  const embedded = list.filter((n) => LAYOUT_PATTERNS.embedded.test(n)).length
  // 与 candidates.classifyLayout 同优先级：分离·目录 > 分离·单文件 > 内嵌。
  if (sepDir > 0) return LAYOUT.SEPARATE_DIR
  if (sepFile > 0) return LAYOUT.SEPARATE_SINGLE
  if (embedded > 0) return LAYOUT.EMBEDDED
  return fromDataset ?? LAYOUT.EMBEDDED
}

/** 从 index-dataset.json 的 `dataset` 数组读 slug → layout 映射。 */
function loadLayouts(file) {
  const map = new Map()
  if (!existsSync(file)) return map
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    for (const row of data.dataset ?? []) {
      if (row?.slug) map.set(row.slug, row.layout ?? LAYOUT.EMBEDDED)
    }
  } catch {
    // 数据集缺失/损坏不阻断：layout 回退为默认值。
  }
  return map
}

/** 读取目录下所有 .snbt 为 {name, text} 列表。 */
const readDir = (dir) => listSnbt(dir).map((name) => ({ name, text: readFileSync(join(dir, ...name.split('/')), 'utf8') }))

/**
 * 取某个 slug 的英文源（基准键集）。
 *
 * 两种形态并列存在（双读）：
 *   - `research/packs/<slug>/` 目录 —— 历史形态，解包后的 `.snbt` 树；
 *   - `research/packs/<slug>.tar.gz` —— 新形态，`scripts/lib/baseline.mjs` 打的归档。
 *
 * 目录优先：本地解包过的包通常比归档新（调试时会改），且目录分支行为与历史完全一致。
 * 归档分支在内存里解压，不落临时目录；只收 `.snbt`，与 `listSnbt` 同口径
 * （归档里若混进 `.DS_Store` 之类，不该被当成英文源去解析）。
 *
 * 都可注入（runBatch 的 loadSource 参数），便于测试替换。
 *
 * @param {string} packsDir research/packs 目录
 * @param {string} slug 包 slug
 * @returns {{files: Array<{name: string, text: string}>, kind: 'dir'|'tar.gz'}|null} 找不到返回 null
 */
export function loadPackSource(packsDir, slug) {
  const dir = join(packsDir, slug)
  if (existsSync(dir)) return { files: readDir(dir), kind: 'dir' }
  const tarFile = join(packsDir, `${slug}.tar.gz`)
  if (existsSync(tarFile)) {
    const files = readBaseline(tarFile).filter((f) => /\.snbt$/i.test(f.name))
    return { files, kind: 'tar.gz' }
  }
  return null
}

/**
 * 批量校验仓库里已有的产出：扫描 patches/<slug>/，逐个与基准源（research/packs/<slug>/）比对。
 *
 * 关键约定：
 *   - patches/ 不存在（或没有任何 slug）时视为「无产出」→ 退出码 0，绝不判红。
 *   - 找不到英文源（`research/packs/<slug>/` 目录与 `<slug>.tar.gz` 归档都不存在）**判失败**。
 *
 *     这里曾写成「只 warn 跳过该条」，于是 2026-10-19 那轮出现了假绿灯：
 *     31 个产出里有 20 个没有英文源，全部被跳过，最后仍打印
 *     「✔ 批量校验通过：31 个产出，共 33201 个键」——那 33201 个键其实只来自
 *     真正校验过的 11 个包。缺源时没有基准键集，任何「通过」都是空转。
 *     内嵌布局是覆盖式改写玩家任务文件，闸门必须能独立复算，故缺源 = 红。
 *   - 单条失败不中断其余条目，全部跑完再统一给退出码。
 *   - 汇总行只报**真正校验过**的包数与键数，跳过的单独列出（不许混算）。
 *
 * @param {{patchesDir?: string, packsDir?: string, datasetFile?: string, loadSource?: (packsDir: string, slug: string) => ({files: Array<{name: string, text: string}>}|null)}} [options] 注入路径（测试用）
 * @returns {number} 退出码：0 通过；1 有校验失败
 */
export function runBatch({ patchesDir = PATCHES_DIR, packsDir = PACKS_DIR, datasetFile = DATASET_FILE, loadSource = loadPackSource } = {}) {
  const slugs = existsSync(patchesDir)
    ? readdirSync(patchesDir).filter((n) => statSync(join(patchesDir, n)).isDirectory())
    : []
  if (!slugs.length) {
    console.log('ℹ️  没有待校验的产出，跳过')
    return 0
  }

  const layoutBySlug = loadLayouts(datasetFile)
  let failed = 0
  let totalKeys = 0
  let warningCount = 0
  const missingSource = []
  let checked = 0

  for (const slug of slugs) {
    // 目录优先，其次 <slug>.tar.gz（双读）；都没有 → 缺源，判红。
    const source = loadSource(packsDir, slug)
    if (!source) {
      // 缺源 = 红（见函数头注释：这里曾经是假绿灯的产地）。
      missingSource.push(slug)
      failed++
      console.error(`✘ ${slug}: 找不到英文源 research/packs/${slug}/，无法校验（缺基准键集）`)
      continue
    }
    checked++
    const enFiles = source.files
    // 布局按磁盘实况判定（见 resolveLayout 注释：数据集里同 slug 有多条且可能不同）
    const layout = resolveLayout(enFiles.map((f) => f.name), layoutBySlug.get(slug))
    const result = validatePair(enFiles, readDir(join(patchesDir, slug)), {
      layout,
      label: `patches/${slug}`,
    })
    totalKeys += result.keyCount
    for (const w of result.warnings) {
      warningCount++
      console.warn(`⚠ ${w}`)
    }
    if (result.problems.length) {
      failed++
      console.error(`✘ patches/${slug}`)
      for (const p of result.problems) console.error(`    - ${p}`)
    }
  }

  if (failed) {
    const parts = []
    if (missingSource.length) parts.push(`${missingSource.length} 个缺英文源`)
    const bad = failed - missingSource.length
    if (bad) parts.push(`${bad} 个校验不通过`)
    console.error(`\n✘ 批量校验失败：${failed}/${slugs.length} 个产出有问题（${parts.join('，')}）`)
    return 1
  }
  console.log(
    `✔ 批量校验通过：${checked} 个产出，共 ${totalKeys} 个键${warningCount ? `（${warningCount} 条样式警告）` : ''}`,
  )
  return 0
}

// ---------- 入口 ----------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const argv = process.argv.slice(2)
  const layoutArg = argv.indexOf('--layout')
  const layout = layoutArg >= 0 ? argv[layoutArg + 1] : LAYOUT.EMBEDDED
  const dirs = argv.filter((a, i) => !a.startsWith('--') && i !== layoutArg + 1)
  const [enDir, zhDir] = dirs
  // 无参数 → 批量校验仓库已有产出（CI 的 npm run validate:quests 走这条）。
  if (!enDir) process.exit(runBatch())
  if (!zhDir) {
    console.error('用法: node scripts/validate-quests.mjs <英文源目录> <产出目录> [--layout embedded|separate-dir|separate-single]')
    console.error('      node scripts/validate-quests.mjs            （批量扫描 patches/）')
    process.exit(2)
  }
  const result = validatePair(readDir(enDir), readDir(zhDir), { layout, label: zhDir })
  for (const w of result.warnings) console.warn(`⚠ ${w}`)
  if (result.problems.length) {
    console.error(`✘ 校验失败：\n${result.problems.map((p) => `  - ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`✔ 校验通过：${result.keyCount} 个键全部对应，色码与占位符一致，UTF-8 无 BOM`)
}
