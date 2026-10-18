#!/usr/bin/env node
/**
 * 站点术语记忆（`glossary.json`）的纯函数：骨架提取、精确命中、合并式回写。
 *
 * 「站点术语记忆」与「模组术语库」是两回事（ADR-0005），本模块只管前者：
 * 记忆键是**剥离色码后的英文骨架**（小写、压缩空白），因此同一句英文在不同整合包里
 * 只调一次 LLM；全部命中时一次 LLM 都不调（工单 02 验收）。
 *
 * 无 IO、无网络，可直接单测。
 */
import { stripColorCodes } from './format-codes.mjs'

/**
 * 英文骨架：剥离合法色码、小写、压缩空白、trim。
 * 作为术语记忆的键，跨整合包复用。
 * @param {string} text
 * @returns {string}
 */
export function stripSkeleton(text) {
  return stripColorCodes(String(text ?? ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 「回退」判据：模型把英文原文原样回显（译文 === 原文）。
 * 逐字比较，不做大小写/空白归一，避免正常差异被误判。
 * @param {string} translated
 * @param {string} source
 * @returns {boolean}
 */
export function isSourceEcho(translated, source) {
  return translated === source
}

/**
 * 读取端守卫：记忆条目能不能当命中用。
 * 值等于英文原文的历史污染（回退被写进记忆）视为未命中。
 * @param {unknown} memory
 * @param {string} source
 * @returns {boolean}
 */
export function isUsableMemory(memory, source) {
  return typeof memory === 'string' && memory.length > 0 && !isSourceEcho(memory, source)
}

/**
 * 精确命中：按英文骨架查记忆，命中且可用时返回译文，否则 undefined。
 * @param {Record<string,string>} entries
 * @param {string} text 英文原文
 * @returns {string|undefined}
 */
export function lookupMemory(entries, text) {
  const skeleton = stripSkeleton(text)
  if (!skeleton) return undefined
  const hit = entries?.[skeleton]
  return isUsableMemory(hit, text) ? hit : undefined
}

/**
 * 写入端守卫：只有「骨架非空 + 记忆里还没有这个骨架 + 值不是英文原文回显」才记入记忆。
 * @param {string} skeleton stripSkeleton(英文原文) 的结果
 * @param {string} translated 译文
 * @param {string} source 英文原文
 * @param {unknown} existing 记忆里该骨架当前的值（undefined 表示没有）
 * @returns {boolean}
 */
export function shouldRememberMemory(skeleton, translated, source, existing) {
  return Boolean(skeleton) && !existing && !isSourceEcho(translated, source)
}

/**
 * 合并式回写：把新增条目并入既有记忆，**不抹掉历史条目**（工单 02 验收）。
 * 已存在的骨架保留原值（历史优先），只补新键。
 * @param {Record<string,string>} existing
 * @param {Record<string,string>} additions
 * @returns {Record<string,string>} 新对象，不改动入参
 */
export function mergeGlossary(existing, additions) {
  const out = { ...(existing ?? {}) }
  for (const [key, value] of Object.entries(additions ?? {})) {
    if (!key || typeof value !== 'string' || value.length === 0) continue
    if (out[key] === undefined) out[key] = value
  }
  return out
}
