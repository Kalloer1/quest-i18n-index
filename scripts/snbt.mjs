#!/usr/bin/env node
/**
 * SNBT（Stringified NBT，Minecraft 文本化 NBT）解析与序列化。
 *
 * 设计目标：**无损往返**。`serialize(parse(text)) === text` 对任意合法输入成立。
 *
 * 做法是「保留 trivia」：AST 的每个容器节点都记下结构之间的原始空白与注释
 * （compound 的条目分隔、`:` 两侧、list 的元素分隔、闭合前的尾随），
 * 因此序列化是逐段拼接原文，不重新排版。翻译只改写字符串**值**节点的 raw，
 * 其余字节原样保留 —— 这正是内嵌布局「就地改写 chapters/*.snbt」所需要的性质
 * （见 ADR-0002 附录与工单 03）。
 *
 * 覆盖（工单 02 验收）：
 *   - 字符串转义：`\"` `\\` `\n` `\r` `\t` `\b` `\f` `\uXXXX`，未知转义原样保留
 *   - 数字类型后缀：`1b` / `2s` / `3L` / `1.5f` / `2.5d`，以及整型与浮点
 *   - 数组：普通 list 与带类型标记的 `[B; ...]` / `[I; ...]` / `[L; ...]`
 *   - 嵌套 compound / list
 *   - 注释（`#` 到行尾）与空白
 *
 * 键与值都可能是裸字符串（FTB Quests 的 lang 文件用 `quest.<hex>.title: "..."` 这种裸键）。
 * 裸字符串字符集与 Minecraft 一致：`[A-Za-z0-9._+-]`。
 *
 * 用法：
 *   import { parse, serialize, collectStrings, setString } from './snbt.mjs'
 *   const root = parse(text)
 *   for (const { path, node } of collectStrings(root)) { ... 改写 node ... }
 *   const out = serialize(root)
 */

/** 裸字符串允许的字符（与 Minecraft SNBT 一致）。 */
const BARE_CHAR = /[A-Za-z0-9._+\-]/

/** SNBT 语法错误。带出错位置，便于定位损坏的产出。 */
export class SnbtParseError extends Error {
  constructor(message, index) {
    super(message)
    this.name = 'SnbtParseError'
    this.index = index
  }
}

/** 解码一个反斜杠转义的后继字符；未知转义返回 null（调用方原样保留）。 */
function decodeEscape(ch) {
  switch (ch) {
    case '"': return '"'
    case "'": return "'"
    case '\\': return '\\'
    case 'n': return '\n'
    case 'r': return '\r'
    case 't': return '\t'
    case 'b': return '\b'
    case 'f': return '\f'
    case '/': return '/'
    default: return null
  }
}

/**
 * 判定一个裸 token 是不是数字，并识别其类型后缀。
 * @returns {{kind: string, suffix: string}|null}
 */
function classifyNumber(raw) {
  const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?([bBsSlLfFdD])?$/.exec(raw)
  if (!m) return null
  const suffix = m[1] ?? ''
  const bySuffix = {
    b: 'byte', B: 'byte',
    s: 'short', S: 'short',
    l: 'long', L: 'long',
    f: 'float', F: 'float',
    d: 'double', D: 'double',
  }[suffix]
  const isFloat = /[.eE]/.test(raw) || /[fFdD]/.test(suffix)
  return { kind: bySuffix ?? (isFloat ? 'double' : 'int'), suffix }
}

class Parser {
  constructor(text) {
    this.s = text
    this.i = 0
  }

  /** 消费并返回一段 trivia：空白、逗号分隔符、`#` 行注释。 */
  readTrivia() {
    const start = this.i
    while (this.i < this.s.length) {
      const ch = this.s[this.i]
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.i++
        continue
      }
      if (ch === '#') {
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++
        continue
      }
      break
    }
    return this.s.slice(start, this.i)
  }

  parseValue() {
    const ch = this.s[this.i]
    if (ch === undefined) throw new SnbtParseError('输入意外结束', this.i)
    if (ch === '{') return this.parseCompound()
    if (ch === '[') return this.parseList()
    if (ch === '"' || ch === "'") return this.parseQuoted()
    return this.parseBare()
  }

  parseQuoted() {
    const start = this.i
    const quote = this.s[this.i]
    this.i++
    let value = ''
    let closed = false
    while (this.i < this.s.length) {
      const ch = this.s[this.i]
      if (ch === '\\') {
        const next = this.s[this.i + 1]
        if (next === undefined) throw new SnbtParseError('转义符后输入结束', this.i)
        if (next === 'u') {
          const hex = this.s.slice(this.i + 2, this.i + 6)
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            value += String.fromCharCode(parseInt(hex, 16))
            this.i += 6
            continue
          }
        }
        const decoded = decodeEscape(next)
        if (decoded !== null) {
          value += decoded
          this.i += 2
        } else {
          // 未知转义（如 `\&` 字面色码）：原样保留两个字符，值里也能被下游识别为字面量。
          value += '\\' + next
          this.i += 2
        }
        continue
      }
      if (ch === quote) {
        this.i++
        closed = true
        break
      }
      value += ch
      this.i++
    }
    if (!closed) throw new SnbtParseError('未闭合的字符串', start)
    return { type: 'string', value, quote, raw: this.s.slice(start, this.i) }
  }

  parseBare() {
    const start = this.i
    while (this.i < this.s.length && BARE_CHAR.test(this.s[this.i])) this.i++
    if (this.i === start) {
      throw new SnbtParseError(`无法解析的值：${JSON.stringify(this.s[this.i] ?? '')}`, this.i)
    }
    const raw = this.s.slice(start, this.i)
    const num = classifyNumber(raw)
    if (num) return { type: 'number', ...num, raw }
    return { type: 'string', value: raw, quote: '', bare: true, raw }
  }

  parseCompound() {
    const start = this.i
    this.i++ // `{`
    const entries = []
    let tail = ''
    for (;;) {
      const sep = this.readTrivia()
      if (this.i >= this.s.length) throw new SnbtParseError('未闭合的 compound', start)
      if (this.s[this.i] === '}') {
        tail = sep
        this.i++
        break
      }
      const key = this.parseValue()
      const beforeColon = this.readTrivia()
      if (this.s[this.i] !== ':') throw new SnbtParseError('compound 条目缺少 “:”', this.i)
      this.i++
      const afterColon = this.readTrivia()
      const value = this.parseValue()
      entries.push({ sep, key, mid: beforeColon + ':' + afterColon, value })
    }
    return { type: 'compound', open: '{', entries, tail, close: '}', raw: this.s.slice(start, this.i) }
  }

  parseList() {
    const start = this.i
    this.i++ // `[`
    // 带类型标记的数组：`[B;` / `[I;` / `[L;`（大小写都认）。
    let typeMark = ''
    const m = /^([BILbil])\s*;/.exec(this.s.slice(this.i))
    if (m) {
      typeMark = m[0]
      this.i += m[0].length
    }
    const items = []
    let tail = ''
    for (;;) {
      const sep = this.readTrivia()
      if (this.i >= this.s.length) throw new SnbtParseError('未闭合的 list', start)
      if (this.s[this.i] === ']') {
        tail = sep
        this.i++
        break
      }
      items.push({ sep, value: this.parseValue() })
    }
    return { type: 'list', open: '[' + typeMark, items, tail, close: ']', raw: this.s.slice(start, this.i) }
  }
}

/**
 * 解析 SNBT 文本。
 * @param {string} text
 * @returns {{type:'root', lead:string, value:object, trail:string}}
 */
export function parse(text) {
  if (typeof text !== 'string') throw new TypeError('parse 需要字符串')
  const p = new Parser(text)
  const lead = p.readTrivia()
  const value = p.parseValue()
  const trail = p.readTrivia()
  if (p.i !== text.length) {
    throw new SnbtParseError(`末尾有多余内容：${JSON.stringify(text.slice(p.i, p.i + 20))}`, p.i)
  }
  return { type: 'root', lead, value, trail }
}

/**
 * 序列化 AST。对未改写的节点逐段拼回原文，因此 `serialize(parse(text)) === text`。
 * @param {object} node
 * @returns {string}
 */
export function serialize(node) {
  switch (node.type) {
    case 'root':
      return node.lead + serialize(node.value) + node.trail
    case 'compound':
      return node.open
        + node.entries.map((e) => e.sep + serialize(e.key) + e.mid + serialize(e.value)).join('')
        + node.tail + node.close
    case 'list':
      return node.open
        + node.items.map((it) => it.sep + serialize(it.value)).join('')
        + node.tail + node.close
    case 'string':
    case 'number':
      return node.raw
    default:
      throw new TypeError(`未知节点类型：${node?.type}`)
  }
}

/**
 * 收集所有字符串**值**节点（不含键），按路径索引。
 *
 * 路径规则：compound 用 `.` 连接键，list 用 `[i]`。FTB Quests 的 lang 文件键本身带点
 * （`quest.<hex>.title`），因此顶层路径就是那个键；内嵌章节则是 `title` / `tasks[0].title` 等。
 *
 * @param {object} root parse() 的结果
 * @returns {Array<{path: string, node: object}>}
 */
export function collectStrings(root) {
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
      out.push({ path, node })
    }
  }
  visit(root.value, '')
  return out
}

/**
 * 改写字符串节点的值，并同步重算其 raw（保留原引号风格）。
 * @param {object} node 字符串节点
 * @param {string} value 新值
 * @returns {object} 同一个节点
 */
export function setString(node, value) {
  if (node.type !== 'string') throw new TypeError('setString 只能作用于字符串节点')
  node.value = value
  node.raw = node.quote ? quoteString(value, node.quote) : value
  return node
}

/**
 * 把值转成带引号的 SNBT 字符串字面量。
 * @param {string} value
 * @param {string} [quote] 引号字符（`"` 或 `'`）
 * @returns {string}
 */
export function quoteString(value, quote = '"') {
  let out = quote
  for (const ch of value) {
    if (ch === '\\') out += '\\\\'
    else if (ch === quote) out += '\\' + quote
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else out += ch
  }
  return out + quote
}
