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
