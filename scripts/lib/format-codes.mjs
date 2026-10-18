#!/usr/bin/env node
/**
 * Minecraft 色码（`&` / `§`）的纯函数：剥离、计数、畸形检测。
 *
 * FTB Quests 的任务文本用 `&7` `&e` `&r` `&c&l` 这类传统色码（也可能写成 `§`）。
 * 色码是**渲染指令**，翻译必须逐字保留；译文引入畸形序列会让游戏渲染错。
 *
 * 判据（工单 02 验收）：
 *   - 合法码：`&` / `§` 后紧跟 `[0-9a-fk-orx]`（不区分大小写）
 *   - 畸形：`&` / `§` 后不是合法码字符，或位于行尾
 *   - `\&` / `\§` 是字面转义，既不算码也不算畸形
 *
 * 无 IO、无网络，可直接单测。
 */

/** 合法色码后继字符。 */
const VALID_CODE = /[0-9a-fk-orx]/i

/** 该位置是不是被反斜杠转义的字面色码前缀。 */
function isEscaped(text, i) {
  return text[i - 1] === '\\'
}

/**
 * 剥离全部合法色码，保留字面转义（`\&` → `&`）。
 * 用于术语记忆的英文骨架提取。
 * @param {string} text
 * @returns {string}
 */
export function stripColorCodes(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && (text[i + 1] === '&' || text[i + 1] === '§')) {
      out += text[i + 1]
      i++
      continue
    }
    if ((ch === '&' || ch === '§') && VALID_CODE.test(text[i + 1] ?? '')) {
      i++
      continue
    }
    out += ch
  }
  return out
}

/**
 * 统计合法色码数量（`&` 与 `§` 合计）。
 * @param {string} text
 * @returns {number}
 */
export function countColorCodes(text) {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (isEscaped(text, i)) continue
    if ((ch === '&' || ch === '§') && VALID_CODE.test(text[i + 1] ?? '')) {
      n++
      i++
    }
  }
  return n
}

/**
 * 统计畸形色码序列数量（`&` / `§` 后不是合法码字符，或位于行尾）。
 * @param {string} text
 * @returns {number}
 */
export function countMalformedCodes(text) {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (isEscaped(text, i)) continue
    if (ch !== '&' && ch !== '§') continue
    if (VALID_CODE.test(text[i + 1] ?? '')) i++
    else n++
  }
  return n
}
