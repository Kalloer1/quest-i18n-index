/**
 * 修复上游整合包 lang 文件里一种**具体的**损坏：`key: ["…` 开了列表+字符串却忘了收尾 `"]`。
 *
 * 实测（2026-10-21，`cleancraft-by-acul-neoforged` 的 `en_us.snbt`，1,591,317 字节，
 * 与我们 Range 解出的字节完全一致 → 是上游源文件本身损坏，不是抽取截断）：
 *
 * ```
 *   quest.00307A898A639191.quest_desc: ["This Quest has been authored by … in CleanCraft Modpacks.
 *   quest.003AA945CACCD641.quest_subtitle: "Made with an Offering Table"
 * ```
 *
 * 第 1 行少了 `"]`。SNBT 的引号字符串允许跨行，于是解析器会把后面几行当成同一个字符串，
 * 直到撞上下一个 `"` 才「闭合」——从此整个文件的状态全错位，最终报
 * `无法解析的值："\\"`（位置远在真正出错行之后）。后果是整个包翻译失败。
 *
 * 判据收得很窄，避免误伤合法的多行字符串：
 *   1. 行首是 `key:` 后紧跟 `[` 与 `"`；
 *   2. 该行内没有未转义的收尾 `"`；
 *   3. **下一行非空且以 `key:` 形式开头** —— 说明上一行确实没有把字符串写完，
 *      而不是一条正常跨行的长文本（那种情况下一行不会以 `identifier:` 开头）。
 *
 * 满足三条才在两行之间补 `"]`。返回修复后的文本与修复清单，便于调用方**响亮记录**。
 */

import { parse } from '../snbt.mjs'

const BS = String.fromCharCode(92)
const DQ = String.fromCharCode(34)
const SQ = String.fromCharCode(39)

/** 行的开头是否是 `key:`（复合条目的键值对）。 */
const KEY_LINE = /^\s*[A-Za-z0-9_.\-]+:\s/

/**
 * 该行是否是「开了 `["` 但没闭合」的坏行。
 * @param {string} line
 * @returns {boolean}
 */
function opensUnclosedStringList(line) {
  if (!/^\s*[A-Za-z0-9_.\-]+:\s*\[\s*"/.test(line)) return false
  const start = line.indexOf(DQ)
  const rest = line.slice(start + 1)
  let esc = false
  for (const ch of rest) {
    if (esc) { esc = false; continue }
    if (ch === BS) { esc = true; continue }
    if (ch === DQ) return false // 找到了收尾引号 → 正常
  }
  return true
}

/**
 * @param {string} text
 * @returns {{text: string, repaired: Array<{line: number, key: string}>}}
 */
export function repairUnclosedStringLists(text) {
  const src = String(text ?? '')
  if (!src.includes(DQ)) return { text: src, repaired: [] }
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.split(/\r?\n/)
  const out = []
  const repaired = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (opensUnclosedStringList(line)) {
      // 找下一行非空行；它必须以 `key:` 开头才认定是「上一行少了 "]」
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      const next = lines[j]
      if (next !== undefined && KEY_LINE.test(next) && !next.trim().startsWith(']')) {
        const key = line.trim().slice(0, line.trim().indexOf(':'))
        out.push(line + '"]')
        repaired.push({ line: i + 1, key })
        continue
      }
    }
    out.push(line)
  }
  if (!repaired.length) return { text: src, repaired: [] }
  return { text: out.join(eol), repaired }
}

/**
 * 修复另一种上游损坏：**列表里混进了一个键值对**。
 *
 * 实测（2026-10-22，`realms-of-reverie` 的 `en_us.snbt` 第 165 行）：
 *
 * ```
 *   quest.252DDDBC5923DE1E.quest_desc: [
 *   quest.252DDDBC5923DE1E.title: "&4The Dark Tower"     ← 键值对出现在列表元素位置
 *       "The &4Dark Tower&r looms in the dark forest…"
 *       ""
 *       "Bring your fiery tears: she has many."
 *   ]
 * ```
 *
 * 列表元素位置只能是值，出现 `key:` 就是结构非法。解析器把它当成裸 token 读到 `:`
 * 时报「无法解析的值：\":\"」。
 *
 * **正确语义**：那个 `title` 是同级键，本该在列表**之后**。所以修法是把这一行
 * 移到列表闭合行之后，而不是删掉它（删掉就是丢内容）。
 *
 * 判据收窄到三条，避免误伤：
 *   1. 当前行以 `key: [` 结尾（列表在这个位置打开，元素从下一行开始）；
 *   2. 下一非空行是 `key:` 形式的键值对（不是字符串、不是 `]`）；
 *   3. 从该处向后能找到与之配对的闭合 `]` 行。
 *
 * @param {string} text
 * @returns {{text: string, repaired: Array<{line: number, key: string}>}}
 */
export function repairKeyInsideList(text) {
  const src = String(text ?? '')
  if (!src.includes(DQ)) return { text: src, repaired: [] }
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.split(/\r?\n/)
  const out = []
  const repaired = []
  const OPENS_LIST = /^\s*[A-Za-z0-9_.\-]+:\s*\[\s*$/
  const KEY_LINE_ONLY = /^\s*[A-Za-z0-9_.\-]+:\s/
  const CLOSES_LIST = /^\s*\]\s*$/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!OPENS_LIST.test(line)) { out.push(line); continue }
    // 找下一非空行
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    const next = lines[j]
    if (next === undefined || !KEY_LINE_ONLY.test(next)) { out.push(line); continue }
    // 找与该 `[` 配对的闭合 `]` 行
    let k = j + 1
    while (k < lines.length && !CLOSES_LIST.test(lines[k])) k++
    if (k >= lines.length) { out.push(line); continue }
    // 收窄判据 2 的补充：中间不得再出现别的 `key: [` 打开新列表
    // （那样说明我们对齐错了层级，宁可不动）
    let nested = false
    for (let m = j + 1; m < k; m++) if (OPENS_LIST.test(lines[m])) { nested = true; break }
    if (nested) { out.push(line); continue }

    // 执行：列表内容 = j+1..k-1；把第 j 行挪到 k 之后
    out.push(line)
    for (let m = j + 1; m < k; m++) out.push(lines[m])
    out.push(lines[k])
    out.push(next)
    const key = next.trim().slice(0, next.trim().indexOf(':'))
    repaired.push({ line: j + 1, key })
    i = k // 跳过已处理区间（next 已搬走）
  }
  if (!repaired.length) return { text: src, repaired: [] }
  return { text: out.join(eol), repaired }
}

/**
 * 修复第三种上游损坏：**compound 条目丢了键名**（空键）。
 *
 * 实测（2026-10-24，`bloom-beyond` 的 `reward_tables/boite_homunculus.snbt`、
 * `furnace-to-singularity` 的 `chapters/45C34EAF227433AE.snbt`）：
 *
 * ```
 *   tag: {
 *       : 0                    ← 键名丢了，只剩 `: 值`
 *       Accelerator: 0
 *   ```
 *
 * ```
 *       {
 *           : "BOOLEAN"        ← 整个 compound 只剩这一条空键条目
 *       }
 *   ```
 *
 * 解析器在键位置遇到 `:` 会报「无法解析的值：":"」，整包翻译失败。
 *
 * **修法选丢弃而非补占位键**：键名不可恢复，补一个假键等于向游戏的 NBT
 * 里编造结构（未知键可能改变游戏行为）；而 `0` / `"BOOLEAN"` 脱离键名毫无
 * 语义（bloom-beyond 处同义零值仍有带键的条目）。丢弃产生最小合法结构，
 * 对解析器最稳。
 *
 * 判据收窄到三条：
 *   1. 全局守卫：整份文件**当前解析失败**（能解析的文件一个字节都不动）；
 *   2. 行是「纯空白 + `:` + 单个标量值」（数字 / 裸词 / 无内引号的引号串）；
 *   3. 上一非空行以 `{` 结尾（空键条目是 compound 的首条目，两处实测均如此）。
 *
 * @param {string} text
 * @returns {{text: string, repaired: Array<{line: number, key: string}>}}
 */
export function repairEmptyKeyEntries(text) {
  const src = String(text ?? '')
  // 全局守卫：文件能解析就绝不修改。
  try { parse(src); return { text: src, repaired: [] } } catch { /* 坏文件才继续 */ }
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.split(/\r?\n/)
  const out = []
  const repaired = []
  // 标量值：数字（可带类型后缀）/ 裸词 / 不含内引号的引号串。
  const SCALAR = /^(?:[-+]?(?:\d+\.?\d*|\.\d+)[bBsSlLfFdD]?|[A-Za-z0-9._+\-]+|"[^"]*"|'[^']*')$/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^(\s+):(\s*)(\S.*)$/.exec(line)
    if (m && SCALAR.test(m[3].trim())) {
      // 上一非空行必须以 `{` 结尾（compound 刚打开）。
      let j = i - 1
      while (j >= 0 && !lines[j].trim()) j--
      if (j >= 0 && /\{\s*$/.test(lines[j])) {
        repaired.push({ line: i + 1, key: '(空键)' + m[3].trim().slice(0, 20) })
        continue // 丢弃整行
      }
    }
    out.push(line)
  }
  if (!repaired.length) return { text: src, repaired: [] }
  return { text: out.join(eol), repaired }
}

/**
 * 修复第四种上游损坏：**单引号字符串里的内嵌单引号没转义**。
 *
 * 实测（2026-10-24，`forge-and-fortify` 的 `reward_tables/bathhouse.snbt`、
 * `greenwood_pub.snbt`）：`nbt` 值是单引号串，内容本身又是 SNBT，其中的
 * JSON 文本组件用单引号包裹却没转义：
 *
 * ```
 *   nbt: '{display:{Name:'{"text":"Absinthe","italic":false}'},CustomPotionColor:13762483}'
 * ```
 *
 * 外层串在 `Name:` 后的 `'` 提前闭合，后续字节全错位，报「compound 条目缺少 ":"」。
 * 同文件的 `Kayra\'s Curse` 行是上游自己的正确先例：内嵌 `'` 转义成 `\'`。
 *
 * **为什么按 `\'` 而不是 `''` 转义**：本仓解析器（snbt.mjs 的 parseQuoted）把
 * 引号字符一律当终止符，不支持 doubling —— `''` 会把字符串劈成两半；
 * `\'` 则是 decodeEscape 已支持的合法转义，且与上游先例一致，值内容逐字节不变。
 *
 * 判据收窄到五条：
 *   1. 全局守卫：整份文件当前解析失败；
 *   2. 行内未转义 `'` ≥ 3；
 *   3. 首个未转义 `'` 的前一字符是 `:`（它是值的开引号，如 `nbt: '`）；
 *   4. **每个**中间未转义 `'` 都紧贴嵌套结构：后随 `{`/`[` 或前邻 `}`/`]`
 *      （JSON 文本组件 `'{"text":…}'` 的形态特征）。中间只要有一个不贴，
 *      说明本行引号归属太含混（如 `{ x: 'a', nbt: '…' }`），整行放弃不动；
 *   5. 修复后整行必须能独立 parse（末个未转义 `'` 是真闭合，其余插 `\`）。
 *
 * @param {string} text
 * @returns {{text: string, repaired: Array<{line: number, key: string}>}}
 */
export function repairNestedSingleQuotes(text) {
  const src = String(text ?? '')
  if (!src.includes(SQ)) return { text: src, repaired: [] }
  // 全局守卫：文件能解析就绝不修改。
  try { parse(src); return { text: src, repaired: [] } } catch { /* 坏文件才继续 */ }
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.split(/\r?\n/)
  const out = []
  const repaired = []

  const unescapedQuotes = (line) => {
    const idx = []
    for (let i = 0; i < line.length; i++) {
      if (line[i] === SQ && line[i - 1] !== BS) idx.push(i)
    }
    return idx
  }

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    const q = unescapedQuotes(line)
    // 判据 2：至少 3 个未转义引号（开 + 至少 1 个内嵌 + 闭合）。
    if (q.length < 3) { out.push(line); continue }
    // 判据 3：首引号前是 `:`（值的开引号）。
    const colonBefore = (() => {
      for (let i = q[0] - 1; i >= 0; i--) {
        const ch = line[i]
        if (ch === ' ' || ch === '\t') continue
        return ch === ':'
      }
      return false
    })()
    // 判据 4：每个中间未转义引号都紧贴嵌套结构。
    let allHugBraces = colonBefore
    for (let k = 1; k < q.length - 1 && allHugBraces; k++) {
      const at = q[k]
      const prev = line[at - 1]
      const next = line[at + 1]
      if (next !== '{' && next !== '[' && prev !== '}' && prev !== ']') allHugBraces = false
    }
    if (!allHugBraces) { out.push(line); continue }
    // 执行：除首尾外全部插 `\`。
    let fixed = ''
    let lastEnd = 0
    for (let k = 1; k < q.length - 1; k++) {
      fixed += line.slice(lastEnd, q[k]) + BS + SQ
      lastEnd = q[k] + 1
    }
    fixed += line.slice(lastEnd)
    if (fixed === line) { out.push(line); continue }
    // 判据 5：修后整行必须能独立 parse。
    try { parse(fixed) } catch { out.push(line); continue }
    const key = line.trim().slice(0, line.trim().indexOf(':'))
    out.push(fixed)
    repaired.push({ line: n + 1, key })
  }
  if (!repaired.length) return { text: src, repaired: [] }
  return { text: out.join(eol), repaired }
}

/**
 * 修复第五种上游损坏：**用 `//` 写注释**（SNBT 注释是 `#`，不是 `//`）。
 *
 * 实测（2026-10-24，`the-world-of-dinosaurs` 的 `chapters/exploration.snbt`）：
 *
 * ```
 *   "custom_task_type": "graves_recovery"
 *   // Placeholder: requires custom trigger …   ← 值位置出现 // 注释
 *   }
 * ```
 *
 * 解析器在值位置遇到 `/` 报「无法解析的值："/"」。修法是把行首 `//` 换成 `#`：
 * 注释内容原样保留（readTrivia 消费 `#` 到行尾），语义零损失。
 *
 * 判据收窄：
 *   1. 全局守卫：整份文件当前解析失败；
 *   2. 行去空白后以 `// ` 开头（注释是散文，URL 在字符串里不会独立成行）；
 *   3. 行内没有任何未转义 `"`（排除多行字符串里的 URL 行；撇号不拦 —— 实测
 *      `Xaero's Minimap` 的注释带 `'`，一并放行，误改由守卫 4 回滚）；
 *   4. 转换后**整份文件**必须能解析，否则全部回滚（防把字符串内容改坏）。
 *
 * @param {string} text
 * @returns {{text: string, repaired: Array<{line: number, key: string}>}}
 */
export function repairSlashComments(text) {
  const src = String(text ?? '')
  if (!src.includes('//')) return { text: src, repaired: [] }
  // 全局守卫：文件能解析就绝不修改。
  try { parse(src); return { text: src, repaired: [] } } catch { /* 坏文件才继续 */ }
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.split(/\r?\n/)
  const out = []
  const repaired = []
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('// ') && !line.includes(DQ)) {
      const at = line.indexOf('//')
      out.push(line.slice(0, at) + '#' + line.slice(at + 2))
      repaired.push({ line: i + 1, key: '//' })
      changed = true
      continue
    }
    out.push(line)
  }
  if (!changed) return { text: src, repaired: [] }
  const fixed = out.join(eol)
  // 回滚守卫：转换后必须能解析，否则宁可不修。
  try { parse(fixed) } catch { return { text: src, repaired: [] } }
  return { text: fixed, repaired }
}

/**
 * 修复第六种上游损坏：**compound 条目只有键没有值**（`dependencies:` 后面空了）。
 *
 * 实测（2026-10-24，`lindenfeld-via-gastronomica` 的两个 chapters 文件）：
 *
 * ```
 *   dependencies:
 *   description: [       ← 下一行是另一个键，上一行的值丢了
 * ```
 *
 * 解析器把下一行的键当成值读，随后报「compound 条目缺少 ":"」。
 * 修法是补一个空列表 `[]`：依赖为空正是「没写依赖」的自然语义，不编造内容。
 *
 * 判据收窄到四条：
 *   1. 全局守卫：整份文件当前解析失败；
 *   2. 行是「空白 + 键 + `:` + 行尾」（无值）；
 *   3. 下一非空行是 `key:` 形式（值的开头是 `{ [ "` 等，绝不会长得像键值对）；
 *   4. 该行单独包一层 `{ }` 无法解析（排除「值在行内、只是行尾有多余空白」的误判）。
 *
 * @param {string} text
 * @returns {{text: string, repaired: Array<{line: number, key: string}>}}
 */
export function repairEmptyValueEntries(text) {
  const src = String(text ?? '')
  // 全局守卫：文件能解析就绝不修改。
  try { parse(src); return { text: src, repaired: [] } } catch { /* 坏文件才继续 */ }
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.split(/\r?\n/)
  const out = []
  const repaired = []
  const KEY_LINE = /^\s*[A-Za-z0-9_.+\-]+:\s/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^(\s*[A-Za-z0-9_.+\-]+):(\s*)$/.exec(line)
    if (m) {
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      const standaloneOk = (() => { try { parse('{' + line + '}'); return true } catch { return false } })()
      if (j < lines.length && KEY_LINE.test(lines[j]) && !standaloneOk) {
        out.push(m[1] + ': []')
        repaired.push({ line: i + 1, key: m[1].trim() })
        continue
      }
    }
    out.push(line)
  }
  if (!repaired.length) return { text: src, repaired: [] }
  return { text: out.join(eol), repaired }
}

/**
 * 修复第七种上游损坏：**compound 少写一个收尾 `}`**，解析器在 `]` 上撞车。
 *
 * 实测（2026-10-24，`pixelgo-sky` 的 `chapters/balls.snbt`）：
 *
 * ```
 *   item: {
 *     tag: {
 *       PokeBallID: "ultra_ball"
 *     }
 *     match_nbt: true      ← item 的 } 丢了，match_nbt 之后直接是 }]
 * }]
 * ```
 *
 * 解析器在任务 compound 里读到 `]` 报「无法解析的值："]"」。
 * 修法是在出错位置（` ] ` 处）补一个 `}`：让最近的未闭合 compound 就此收口。
 * 括号配对统计佐证：整份文件 `{` 比 `}` 恰好多 1。
 *
 * 判据收窄：
 *   1. 全局守卫：文件当前解析失败，且错误是「无法解析的值："]"」；
 *   2. 在出错下标插入 `}` 后整份文件能解析（插入点即解析器撞车处，
 *      语义上是让当前 compound 提前收口 —— 对翻译无影响：布尔/结构字段不在可译字段内）。
 *
 * @param {string} text
 * @returns {{text: string, repaired: Array<{line: number, key: string}>}}
 */
export function repairMissingCloseBrace(text) {
  const src = String(text ?? '')
  // 全局守卫：文件能解析就绝不修改。
  try { parse(src); return { text: src, repaired: [] } } catch (e) {
    if (!(e instanceof Object) || e.message === undefined || !/无法解析的值："\]"/.test(String(e.message))) return { text: src, repaired: [] }
    const index = e.index
    const fixed = src.slice(0, index) + '}' + src.slice(index)
    try { parse(fixed) } catch { return { text: src, repaired: [] } }
    const line = src.slice(0, index).split('\n').length
    return { text: fixed, repaired: [{ line, key: '(补 })' }] }
  }
}

/**
 * 修复第八种上游损坏：**单行字符串列表里混进一个没转义的 `"`**（双引号版串中串）。
 *
 * 实测（2026-10-24，`dawncraft-russian-lang` 俄语原生包）：
 *
 * ```
 *   description: ["Энта можно вызвать … из \«Порванной записки»\.\"."]
 *                                                    杂物 `".` ↑ 让串提前闭合
 * ```
 *
 * 字符串在杂物引号处提前闭合，`."` 剩在外面把解析器带偏，最终在几行之后
 * 报「无法解析的值："Х"」。修法是给那个多余的 `"` 补 `\` 转义：所有字节保留，
 * 值内容只多一个字面引号（与上游先例 `Kayra\'s` 同款修法）。
 *
 * 判据收窄到五条：
 *   1. 全局守卫：整份文件当前解析失败；
 *   2. 行是「键: [单行列表]」形态（`key: [… one line …]`）；
 *   3. 该行**单独**无法解析（健康行绝不碰）；
 *   4. 行内未转义 `"` ≥ 3（首 = 开引号，末 = 闭引号，中间才有嫌疑人）；
 *   5. 从左到右逐个试：给某个中间 `"` 插 `\` 后整行能独立解析才接受（只改第一个成功的）。
 *
 * @param {string} text
 * @returns {{text: string, repaired: Array<{line: number, key: string}>}}
 */
export function repairStrayQuoteInStringList(text) {
  const src = String(text ?? '')
  // 全局守卫：文件能解析就绝不修改。
  try { parse(src); return { text: src, repaired: [] } } catch { /* 坏文件才继续 */ }
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.split(/\r?\n/)
  const out = []
  const repaired = []
  const LIST_LINE = /^\s*[A-Za-z0-9_.+\-]+:\s*\[.*\]\s*$/

  const unescapedQuotes = (line) => {
    const idx = []
    for (let i = 0; i < line.length; i++) {
      if (line[i] === DQ && line[i - 1] !== BS) idx.push(i)
    }
    return idx
  }

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    if (!LIST_LINE.test(line)) { out.push(line); continue }
    // 判据 3：健康的行不碰。行是 `key: [...]` 键值对形态，独立测要包一层 compound。
    const wrapped = '{ ' + line.trim() + ' }'
    let lineBroken = false
    try { parse(wrapped) } catch { lineBroken = true }
    if (!lineBroken) { out.push(line); continue }
    const q = unescapedQuotes(line)
    if (q.length < 3) { out.push(line); continue }
    // 判据 5：逐个试中间引号，取第一个能解析的。
    let fixed = null
    for (let k = 1; k < q.length - 1 && !fixed; k++) {
      const at = q[k]
      const candidate = line.slice(0, at) + BS + DQ + line.slice(at + 1)
      try { parse('{ ' + candidate.trim() + ' }'); fixed = candidate } catch { /* 下一个 */ }
    }
    if (fixed) {
      const key = line.trim().slice(0, line.trim().indexOf(':'))
      out.push(fixed)
      repaired.push({ line: n + 1, key })
      continue
    }
    out.push(line)
  }
  if (!repaired.length) return { text: src, repaired: [] }
  return { text: out.join(eol), repaired }
}

/**
 * 修复第九种上游损坏：**普通字符串值忘了收尾引号**（规则①的纯字符串版）。
 *
 * 实测（2026-10-24，`lindenfeld-via-gastronomica` 的两个 chapters 文件）：
 *
 * ```
 *   group: "0F9BFF21DB6FDC1E        ← 少右引号，下一行被吞进字符串
 *   icon: "dustydecorations:bookstack"
 * ```
 *
 * 字符串跨行吞掉后续内容直到撞上下一个 `"`，整个文件的状态从此错位。
 * 修法同规则①：行末补 `"`。判据与规则①同构，只是值形态从 `["…` 换成 `"…`：
 *
 *   1. 全局守卫：整份文件当前解析失败；
 *   2. 行首是 `key: "`，开引号之后行内**再无**未转义的 `"`；
 *   3. 下一非空行是 `key:` 形式（正常跨行长文本的下一行不会长得像键值对）且不以 `]` 开头。
 *
 * @param {string} text
 * @returns {{text: string, repaired: Array<{line: number, key: string}>}}
 */
export function repairUnclosedStringValue(text) {
  const src = String(text ?? '')
  if (!src.includes(DQ)) return { text: src, repaired: [] }
  // 全局守卫：文件能解析就绝不修改。
  try { parse(src); return { text: src, repaired: [] } } catch { /* 坏文件才继续 */ }
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.split(/\r?\n/)
  const out = []
  const repaired = []
  const OPENS = /^\s*([A-Za-z0-9_.+\-]+):\s*"/
  const KEY_LINE = /^\s*[A-Za-z0-9_.+\-]+:\s/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = OPENS.exec(line)
    if (m) {
      const afterOpen = line.slice(line.indexOf(DQ) + 1)
      let unclosed = true
      for (let k = 0; k < afterOpen.length; k++) {
        if (afterOpen[k] === BS) { k++; continue }
        if (afterOpen[k] === DQ) { unclosed = false; break }
      }
      if (unclosed) {
        let j = i + 1
        while (j < lines.length && !lines[j].trim()) j++
        const next = lines[j]
        if (next !== undefined && KEY_LINE.test(next) && !next.trim().startsWith(']')) {
          out.push(line + DQ)
          repaired.push({ line: i + 1, key: m[1] })
          continue
        }
      }
    }
    out.push(line)
  }
  if (!repaired.length) return { text: src, repaired: [] }
  return { text: out.join(eol), repaired }
}

/**
 * 修复第十种上游损坏：**字符串值丢了开头的左引号**（值是裸 `{quest.N.title}` 模板变量）。
 *
 * 实测（2026-10-25，`crafting-craft-2` 的 `chapters/7858BB56C9DEDD06.snbt` L252，
 * 诊断报告 research/tmp/diag-bad6/task-5.md）：
 *
 * ```
 * 	title: {quest.156.title}"          ← 少左引号，行尾孤 "
 * ```
 *
 * 同文件 L55/115/165/175 同类键全部是 `title: "{quest.15x.title}"`。值以 `{` 开头被
 * 解析器当 compound 读，报「compound 条目缺少 ":"」。内存里补回左引号后整文件 parse 通过。
 * 规则⑨是缺**右**引号，此形态（缺左引号）它管不到。
 *
 * 判据收窄到三条：
 *   1. 全局守卫：整份文件当前解析失败；
 *   2. 行形如 `key: {quest.<数字>.<标识符>}"`（行尾恰一个孤立闭引号）；
 *   3. 补左引号后的整行能独立 parse（健康行不碰）。
 *
 * @param {string} text
 * @returns {{text: string, repaired: Array<{line: number, key: string}>}}
 */
export function repairMissingOpenQuote(text) {
  const src = String(text ?? '')
  // 全局守卫：文件能解析就绝不修改。
  try { parse(src); return { text: src, repaired: [] } } catch { /* 坏文件才继续 */ }
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.split(/\r?\n/)
  const out = []
  const repaired = []
  // 只认 quest.<数字>.<标识符> 模板变量（ftbquests 的 title/subtitle 引用形态），
  // 不泛化到任意 {…}（真 compound 值补引号只会改坏结构）。
  const BARE_TEMPLATE = /^(\s*)([A-Za-z0-9_.+\-]+):\s*(\{quest\.[A-Za-z0-9_]+\.[A-Za-z_][A-Za-z0-9_]*\})"\s*$/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = BARE_TEMPLATE.exec(line)
    if (!m) { out.push(line); continue }
    const fixed = `${m[1]}${m[2]}: "${m[3]}"`
    // 判据 3：修后整行必须能独立 parse（包一层 compound 测）。
    try { parse(`{ ${fixed.trim()} }`) } catch { out.push(line); continue }
    out.push(fixed)
    repaired.push({ line: i + 1, key: m[2] })
  }
  if (!repaired.length) return { text: src, repaired: [] }
  return { text: out.join(eol), repaired }
}

/**
 * 修复第十一种上游损坏：**多行字符串列表的元素行缺右引号**（规则⑨的列表元素版）。
 *
 * 实测（2026-10-25，`etbw` 的 `chapters/707C89F17A4596E5.snbt` L82）：
 *
 * ```
 * description: [
 *     "BOSS技能："
 *     "它会偶尔短暂停止移动…可以破坏任何方块。；        ← 这行缺右引号
 *     "如果玩家在很高的地方时…"
 * ]
 * ```
 *
 * 未闭合的字符串跨行吞掉下一行的开引号，解析器在再下一行报「无法解析的值：\"如\"」。
 * 规则⑨只认 `key: "` 键值形态（OPENS 要求行首 `key:`），元素行（行首就是 `"`）匹配不上。
 *
 * 判据收窄到四条：
 *   1. 全局守卫：整份文件当前解析失败；
 *   2. 行（去缩进）以 `"` 开头，开引号之后行内再无未转义的 `"`；
 *   3. 下一非空行仍以 `"` 开头（下一行是纯文本延续的合法跨行字符串不碰）；
 *   4. 只在行尾补 `"`，不动行内任何字节。
 *
 * @param {string} text
 * @returns {{text: string, repaired: Array<{line: number, key: string}>}}
 */
export function repairUnclosedListElement(text) {
  const src = String(text ?? '')
  // 全局守卫：文件能解析就绝不修改。
  try { parse(src); return { text: src, repaired: [] } } catch { /* 坏文件才继续 */ }
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.split(/\r?\n/)
  const out = []
  const repaired = []
  const ELEMENT = /^\s*"/

  // 开引号之后行内是否还有未转义的闭引号（有 = 该行字符串已闭合，不是本规则的病）。
  const selfClosed = (rest) => {
    for (let k = 0; k < rest.length; k++) {
      if (rest[k] === BS) { k++; continue }
      if (rest[k] === DQ) return true
    }
    return false
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!ELEMENT.test(line)) { out.push(line); continue }
    if (selfClosed(line.slice(line.indexOf(DQ) + 1))) { out.push(line); continue }
    // 判据 3：下一非空行仍以 " 开头才修 —— 否则这是合法的跨行字符串延续。
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    if (j >= lines.length || !ELEMENT.test(lines[j])) { out.push(line); continue }
    out.push(line + DQ)
    repaired.push({ line: i + 1, key: '(列表元素)' })
  }
  if (!repaired.length) return { text: src, repaired: [] }
  return { text: out.join(eol), repaired }
}
