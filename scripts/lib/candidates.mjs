#!/usr/bin/env node
/**
 * 候选筛选：从整合包目录记录里挑出「本站可翻译」的条目。
 *
 * 只做 FTB Quests（工单 02 验收）。跳过原因用稳定的英文标识记录：
 *   - 不含 FTB Quests            → `no-quests`
 *   - 自带中文（zhFiles > 0）     → `native-zh`
 *   - 找不到英文源（enFiles = 0） → `no-en-source`
 *   - 已是最新汉化               → `up-to-date`
 *
 * 语言布局识别三种（GLOSSARY.md）：
 *   - 分离·目录   `lang/en_us/*.snbt`   → `separate-dir`
 *   - 分离·单文件 `lang/en_us.snbt`     → `separate-single`
 *   - 内嵌        `chapters/*.snbt`     → `embedded`
 *
 * 纯函数、无 IO。
 */

/** 语言布局标识。 */
export const LAYOUT = {
  SEPARATE_DIR: 'separate-dir',
  SEPARATE_SINGLE: 'separate-single',
  EMBEDDED: 'embedded',
  NONE: 'none',
  OTHER: 'other',
}

/** 跳过原因标识。 */
export const SKIP = {
  NO_QUESTS: 'no-quests',
  NATIVE_ZH: 'native-zh',
  NO_EN_SOURCE: 'no-en-source',
  UP_TO_DATE: 'up-to-date',
}

/** 三种布局的路径判据（大小写不敏感）。 */
export const LAYOUT_PATTERNS = {
  sepDirEn: /(^|\/)lang\/en_us\/[^/]+\.snbt$/i,
  sepDirZh: /(^|\/)lang\/zh_cn\/[^/]+\.snbt$/i,
  sepFileEn: /(^|\/)lang\/en_us\.snbt$/i,
  sepFileZh: /(^|\/)lang\/zh_cn\.snbt$/i,
  embedded: /(^|\/)chapters\/[^/]+\.snbt$/i,
  ftbQuests: /(^|\/)ftbquests\//i,
}

/**
 * 从整合包内的文件路径列表判定语言布局。
 *
 * 优先级：分离·目录 > 分离·单文件 > 内嵌 > other > none。
 * `enFiles` 是「可翻译的英文源文件数」：分离布局数 `lang/en_us*`，
 * 内嵌布局数 `chapters/*.snbt`（内嵌的英文源就是章节文件本身）。
 *
 * @param {string[]} names 整合包内文件路径（`/` 分隔）
 * @returns {{layout: string, enFiles: number, zhFiles: number, embeddedFiles: number, hasQuests: boolean}}
 */
export function classifyLayout(names) {
  const list = Array.isArray(names) ? names : []
  const sepDirEn = list.filter((n) => LAYOUT_PATTERNS.sepDirEn.test(n)).length
  const sepDirZh = list.filter((n) => LAYOUT_PATTERNS.sepDirZh.test(n)).length
  const sepFileEn = list.filter((n) => LAYOUT_PATTERNS.sepFileEn.test(n)).length
  const sepFileZh = list.filter((n) => LAYOUT_PATTERNS.sepFileZh.test(n)).length
  const embedded = list.filter((n) => LAYOUT_PATTERNS.embedded.test(n)).length
  const hasQuests = list.some((n) => LAYOUT_PATTERNS.ftbQuests.test(n))

  let layout = LAYOUT.NONE
  if (sepDirEn > 0) layout = LAYOUT.SEPARATE_DIR
  else if (sepFileEn > 0) layout = LAYOUT.SEPARATE_SINGLE
  else if (embedded > 0) layout = LAYOUT.EMBEDDED
  else if (hasQuests) layout = LAYOUT.OTHER

  const sepEn = sepDirEn + sepFileEn
  return {
    layout,
    enFiles: sepEn > 0 ? sepEn : embedded,
    zhFiles: sepDirZh + sepFileZh,
    embeddedFiles: embedded,
    hasQuests,
  }
}

/**
 * 单条记录的跳过原因；可翻译时返回 null。
 * @param {object} row
 * @returns {string|null}
 */
export function skipReason(row) {
  const layout = row?.layout ?? LAYOUT.NONE
  if (layout === LAYOUT.NONE || layout === LAYOUT.OTHER) return SKIP.NO_QUESTS
  if ((row.zhFiles ?? 0) > 0) return SKIP.NATIVE_ZH
  if ((row.enFiles ?? 0) === 0) return SKIP.NO_EN_SOURCE
  if (row.translatedVersion && row.version && row.translatedVersion === row.version) return SKIP.UP_TO_DATE
  return null
}

/**
 * 筛候选：返回可翻译的候选与跳过清单（带原因）。
 * @param {object[]} rows
 * @returns {{candidates: object[], skipped: Array<{slug: string, reason: string}>}}
 */
export function screenCandidates(rows) {
  const candidates = []
  const skipped = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const reason = skipReason(row)
    if (reason) skipped.push({ slug: row.slug, reason })
    else candidates.push(row)
  }
  return { candidates, skipped }
}

/** 跳过原因的中文说明（写回队列 note 用）。 */
export const SKIP_LABEL = {
  [SKIP.NO_QUESTS]: '无 FTB Quests 任务书',
  [SKIP.NATIVE_ZH]: '整合包自带中文',
  [SKIP.NO_EN_SOURCE]: '找不到英文源',
  [SKIP.UP_TO_DATE]: '已是最新汉化',
}
