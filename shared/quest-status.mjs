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
  /** 消费器判定「库内已有同版本」：不需要翻，玩家可安心（方案 §3.2 决策 #5）。 */
  SKIPPED_SAME_VERSION: '已在库',
}

/** 状态枚举的合法取值列表（POST /status 校验用）。 */
export const STATUS_VALUES = Object.values(STATUS)

/**
 * 把流水线内部英文 kind 映射到队列中文状态值（POST /status 的 body.status 必须是中文）。
 *
 * - `done`    → STATUS.DONE（已完成）
 * - `failed`  → STATUS.FAILED（失败）
 * - `skipped` → STATUS.FAILED（失败），error 携带跳过原因。
 *   理由：状态机只有「待翻译/翻译中/已完成/镜像缺失/失败」五态，没有「跳过」态；
 *   被跳过的条目（如不含 FTB Quests）永远不会产出，玩家需要看到「为什么没翻」，
 *   而只有「失败」态会在站点上展示 error 文案。故归入失败并回写跳过原因。
 *
 * 未知 kind 直接抛错，避免把无效状态发给 Worker 后被 400 静默吞掉。
 */
export function toStatusValue(kind) {
  switch (kind) {
    case 'done': return STATUS.DONE
    case 'failed': return STATUS.FAILED
    case 'skipped': return STATUS.FAILED
    case 'skipped-same-version': return STATUS.SKIPPED_SAME_VERSION
    default: throw new Error(`未知状态 kind：${kind}`)
  }
}

/** 队列条目来源枚举。 */
export const SOURCE = {
  PLAYER: '玩家请求',
  AUTO: '自动检测',
}
