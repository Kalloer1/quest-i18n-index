/**
 * 发布自检（publish-local.mjs step 3.5）的核心比对函数。
 *
 * 为什么要有这道自检：上次发布 166 个 .snbt 被静默丢弃 —— patchPaths 缺文件时
 * checkout 只还原一部分，闸门报「缺 N 个键」，看起来像翻译坏了，其实是计划漏捞。
 * 这里从另一个方向兜底：计划里每个包的 .snbt 数（来自分支 diff）必须 ≥
 * farm 分支树上实际存在的 .snbt 数；树上更多就说明计划漏了文件，必须报错拦下。
 * 反向（实际 ≤ 期望）不算错 —— patchPaths 只含有差异的文件，没变的自然少。
 */
export function checkPublishCounts(bySlug, treeByBranch) {
  const bad = []
  for (const [slug, item] of Object.entries(bySlug)) {
    const expected = item.patchPaths.filter((p) => p.endsWith('.snbt')).length
    const actual = (treeByBranch[item.branch] || [])
      .filter((p) => p.startsWith(`patches/${slug}/`) && p.endsWith('.snbt')).length
    if (actual > expected) bad.push({ slug, branch: item.branch, expected, actual })
  }
  return bad
}

/**
 * 新鲜度判定（publish-local.mjs 的 --skip-slugs 自动版）。
 *
 * 背景（2026-10-25 的 21 包重影险情）：farm/ci 与旧 farmN 分支上的陈旧副本会被
 * two-dot diff 当成增量 —— 分支不再推进时，那份旧产物每轮都躺在 diff 里，一旦
 * 取数就会把 main 上更新的版本盖回旧版。判定：main 上该 slug 最后一次提交比
 * 获选分支上的还新 → 分支那份是陈旧副本，跳过（手动 --skip-slugs 保留，用于
 * 「分支时间戳更新但内容更旧」这类机器判不了的场景）。
 *
 * 判不了的都不跳（fail-open）：main 没记时（新包）、两边时间相等、分支侧时间
 * 读不到（times-<host>.json 加载失败），一律放行走正常合并。理由：times 文件
 * 与 plan 同一轮进程内刚生成，读不到属罕见故障；那种轮次里静默跳过会把好包
 * 无限饿死，而误合并下一轮仍会被本判定拦下。
 *
 * @param {Record<string, {branch: string}>} bySlug 合并计划
 * @param {Record<string, number>} mainTimes slug → main 上最后提交时间（秒）
 * @param {(branch: string) => Record<string, number>} farmTimesOf 分支 → slug → 时间
 * @returns {string[]} 陈旧 slug，字典序
 */
export function findStaleSlugs(bySlug, mainTimes, farmTimesOf) {
  const stale = []
  for (const [slug, item] of Object.entries(bySlug ?? {})) {
    const mainAt = Number(mainTimes?.[slug] ?? 0)
    const farmAt = Number(farmTimesOf?.(item?.branch ?? '')?.[slug])
    if (Number.isFinite(farmAt) && mainAt > farmAt) stale.push(slug)
  }
  return stale.sort()
}

/**
 * 闸门踢包时，基准 tar.gz 是否该随残包进隔离区。
 *
 * 规则：main 树上已有的归档**永远留在工作区**（trackedInMain=true → false）。
 * 它是权威英文源，闸门失败只说明补丁坏；把它一起踢走会造出「工作区缺源、
 * main 有、检出步骤又因 main 已有而跳过」的三不管状态 —— 下一轮闸门报
 * 「找不到英文源」，把可能是好的补丁也判死（aeronautics-ikaria 被反复误杀
 * 的根因）。随包新检出的归档（main 上没有）仍是未验证的交付物，照旧隔离。
 *
 * @param {{existsOnDisk: boolean, trackedInMain: boolean}} state
 * @returns {boolean}
 */
export function shouldQuarantineBaseline({ existsOnDisk, trackedInMain }) {
  return existsOnDisk && !trackedInMain
}
