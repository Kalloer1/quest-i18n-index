/**
 * 每 IP 每天「新增提交」限流：纯函数部分。
 *
 * Worker 的 POST / 提交入口用它做限流，离线单元测试也直接 import 这些函数。
 * 设计约束：
 * - 只存 IP 哈希（sha256(INTERNAL_STATUS_TOKEN + "|" + ip)），绝不存原始 IP；
 * - KV 键按天区分（submit:limit:<hash>:<YYYYMMDD>）并带 TTL，避免永久膨胀；
 * - 只统计「新增提交」：同一 id 已入队（existing）的重复提交不计数；
 * - 上限可配置（wrangler.worker.toml [vars] SUBMIT_LIMIT_PER_DAY），解析失败/缺失回退 3；
 * - 所有请求一律计数（无管理员豁免）。
 */

export const DEFAULT_SUBMIT_LIMIT_PER_DAY = 3
export const SUBMIT_LIMIT_TTL_SECONDS = 172800 // 2 天，覆盖跨天窗口，到期自动清理

/**
 * 解析 SUBMIT_LIMIT_PER_DAY 配置。
 * 缺失 / 空串 / 非正整数（含 NaN、小数、负数、0）→ 回退默认 3。
 * @param {unknown} raw
 * @returns {number}
 */
export function parseSubmitLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_SUBMIT_LIMIT_PER_DAY
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SUBMIT_LIMIT_PER_DAY
}

/**
 * 限流决策：count 为当日已新增次数，limit 为每日上限。
 * @param {number} count
 * @param {number} limit
 * @returns {{ allowed: boolean, remainingToday: number }}
 */
export function submitLimit(count, limit) {
  const normalizedLimit = parseSubmitLimit(limit)
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  const remainingToday = Math.max(0, normalizedLimit - safeCount)
  return { allowed: safeCount < normalizedLimit, remainingToday }
}

/**
 * 是否应计入额度：只有「新增提交」计数；同一 id 已存在（重复提交）不算。
 * @param {object|null} existing 队列中已存在的条目
 * @returns {boolean}
 */
export function shouldCountSubmit(existing) {
  return !existing
}

/**
 * 按天生成 KV 键：submit:limit:<hash>:<YYYYMMDD>（UTC）。
 * 日期变化 → key 变化 → 新的一天从空键开始，计数自然归零。
 * @param {Date|string|number} now
 * @param {string} hash IP 哈希
 * @returns {string}
 */
export function submitDayKey(now, hash) {
  const d = new Date(now)
  if (Number.isNaN(d.getTime())) throw new TypeError('submitDayKey: 非法时间')
  const ymd =
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(d.getUTCDate()).padStart(2, '0')}`
  return `submit:limit:${hash}:${ymd}`
}

/**
 * 从请求提取客户端 IP：优先 CF-Connecting-IP（Cloudflare 提供），
 * 缺失则退回 X-Forwarded-For 的第一段；都没有 → ip 为 null（调用方不限流）。
 * @param {Request} request
 * @returns {{ ip: string|null, source: 'cf'|'xff'|'none' }}
 */
export function clientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP')
  if (cf && cf.trim()) return { ip: cf.trim(), source: 'cf' }
  const xff = request.headers.get('X-Forwarded-For')
  if (xff && xff.trim()) {
    const first = xff.split(',')[0].trim()
    if (first) return { ip: first, source: 'xff' }
  }
  return { ip: null, source: 'none' }
}
