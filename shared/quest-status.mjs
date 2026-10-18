/**
 * 队列状态与来源枚举：Worker 与站点共用的唯一定义。
 *
 * 状态机（ADR-0007）：待翻译 → 翻译中 → 已完成 / 镜像缺失 / 失败。
 * 状态权威源是 KV 队列条目的 status 字段；任何镜像失败都不阻断主流程。
 *
 * 消费方：
 * - worker/index.js（POST / 入队、POST /status 回写、GET /queue 返回）
 * - 站点请求页（状态中文标签）
 */

/** 队列条目状态枚举。取值即面向玩家的中文文案，KV 与页面共用一套。 */
export const STATUS = {
  PENDING: '待翻译',
  TRANSLATING: '翻译中',
  DONE: '已完成',
  DONE_UNMIRRORED: '镜像缺失',
  FAILED: '失败',
}

/** 状态枚举的合法取值列表（POST /status 校验用）。 */
export const STATUS_VALUES = Object.values(STATUS)

/** 队列条目来源枚举。 */
export const SOURCE = {
  PLAYER: '玩家请求',
  AUTO: '自动检测',
}
