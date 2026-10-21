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

const BS = String.fromCharCode(92)
const DQ = String.fromCharCode(34)

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
