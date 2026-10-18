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

/**
 * 色码遮蔽用的占位符前缀。
 * 形如 `<c1>`、`<c2>` —— 带序号的短标记。
 *
 * 为何是这个形态（实测对比过 `<<C0>>`、`{C}`、`<c>`、`<c1>`）：
 * - 无序号的形式（`<<C>>`、`{C}`）会被模型**合并成同一个标记**，多个不同色码就丢区分度；
 * - 带序号的 `<c1>` 实测 4/4 完整保留，漏译率 0；
 * - 不含 `&`/`§`，不会被自己的色码扫描误判。
 */
const SHIELD_OPEN = '<c'
const SHIELD_CLOSE = '>'

/**
 * 把文本里的合法色码替换成不透明占位符，交给 LLM 翻译。
 *
 * 为什么必须这么做（实测）：免费层会把 `&credstone` 翻成 `&红石`、
 * 把 `&ritem` 吃掉 `&r` 变成 `&item`。`&` 后面跟中文字符是**畸形色码**，
 * 游戏里会直接把 `&红` 当字面量显示，玩家看到的是 `&红石` 而不是红色文字。
 * 换成占位符后模型只搬动占位符，不碰码字符。
 *
 * @param {string} text
 * @returns {{text: string, codes: string[]}} 遮蔽后的文本与按序还原用的色码表
 */
export function shieldColorCodes(text) {
  const codes = []
  let out = ''
  const src = String(text ?? '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if ((ch === '&' || ch === '§') && VALID_CODE.test(src[i + 1] ?? '')) {
      codes.push(ch + src[i + 1])
      // 序号从 1 开始：`<c0>` 在模型眼里比 `<c1>` 更容易被当作可删的列表头。
      out += `${SHIELD_OPEN}${codes.length}${SHIELD_CLOSE}`
      i++
    } else {
      out += ch
    }
  }
  return { text: out, codes }
}

/**
 * 还原 `shieldColorCodes`。占位符按序号取回原色码。
 * 模型若把占位符弄丢，该色码就丢失（由调用方的色码数量校验兜底）。
 *
 * @param {string} text
 * @param {string[]} codes
 * @returns {string}
 */
export function unshieldColorCodes(text, codes) {
  const list = Array.isArray(codes) ? codes : []
  // 不用正则：占位符含 `<`/`>`，正则会遇到转义陷阱（已踩过一次）。
  // 按序号逐个字符串替换，语义更直白也更难写错。序号与 shieldColorCodes 一致从 1 开始。
  let out = String(text ?? '')
  for (let i = 0; i < list.length; i++) {
    out = out.split(`${SHIELD_OPEN}${i + 1}${SHIELD_CLOSE}`).join(list[i])
  }
  return out
}

/**
 * 译文是否引入了畸形色码（`&`/`§` 后不是合法码字符）。
 *
 * 用于「术语记忆写入前」与「回写前」的把关：
 * 记忆是跨整合包复用的，一条坏译文会被反复注入到其他包的产出里，
 * 比一次性的坏译文危害大得多。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasMalformedColorCodes(text) {
  return countMalformedCodes(text) > 0
}
