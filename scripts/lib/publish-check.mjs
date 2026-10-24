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
