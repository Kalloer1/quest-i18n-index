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
  // `lang/en_us/` 下**允许任意层级子目录**。
  //
  // 早先写成 `[^/]+\.snbt$`，只认 `lang/en_us/file.snbt` 这种单层；
  // 实测 craftoria 用的是新版格式 `lang/en_us/chapters/apotheosis.snbt`（31 个章节文件），
  // 于是只有 file.snbt / reward_table.snbt 被当作英文源，
  // 章节全部漏译 —— 产出缺 7354 个键（校验器拓出来的）。
  // 同样的问题也会让 ATM10 那类包少翻大量文本。
  sepDirEn: /(^|\/)lang\/en_us\/.+\.snbt$/i,
  sepDirZh: /(^|\/)lang\/zh_cn\/.+\.snbt$/i,
  sepFileEn: /(^|\/)lang\/en_us\.snbt$/i,
  sepFileZh: /(^|\/)lang\/zh_cn\.snbt$/i,
  // 新版布局：任务 snbt 直接位于 chapters/ 下一层。
  // `index.snbt` 是纯 uid 数组的结构性文件（章节清单，不含 title/description 等
  // 可译字段），不能当英文源 —— 实测 1.12.2 旧布局包里能匹配旧正则的只有它，
  // 抽出 0 个单元被误记 noText，故显式排除。
  embedded: /(^|\/)chapters\/(?!index\.snbt$)[^/]+\.snbt$/i,
  // 1.12.2 旧布局：任务文件比新版深一层 ——
  //   config/ftbquests/<mode>/chapters/<章节hex>/<任务hex>.snbt（mode 为 challenge/classic 等）。
  // 必须锚定 `ftbquests/<非quests>/` 前缀：新版包在 quests/chapters/ 下也有
  // 嵌套的 backup/、reward_tables/ 等结构文件（实测已交付基线），裸放宽到
  // `chapters/.+` 会把它们当英文源，闸门基准凭空多键 → 存量包假失败。
  embeddedLegacy: /(^|\/)ftbquests\/(?!quests(\/|$))[^/]+\/chapters\/[^/]+\/[^/]+\.snbt$/i,
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
  // 内嵌布局的新旧两代判据并集：新版 `chapters/*.snbt` + 旧版
  // `ftbquests/<mode>/chapters/<hex>/<hex>.snbt`。index.snbt 两个模式都不匹配。
  const embedded = list.filter(
    (n) => LAYOUT_PATTERNS.embedded.test(n) || LAYOUT_PATTERNS.embeddedLegacy.test(n),
  ).length
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
