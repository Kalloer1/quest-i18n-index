#!/usr/bin/env node
/**
 * 把三份数据合并成站点唯一的数据文件 `site/data.json`。
 *
 * 输入：
 *   research/index-dataset.json   —— 500 条，六态分类（工单 02）
 *   research/vm-status.json       —— 58 条 VM 维护状态与适配版本（工单 03）
 *   research/pack-metadata.json   —— 57 条元数据（工单 04）
 *
 * 纯函数、离线、幂等。站点只读 data.json，不直接读 research/ 下的文件。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const STATE_LABEL = {
  'downloadable': '可下载',
  'native-zh': '自带中文',
  'gap-uncovered': '待翻译·无人覆盖',
  'gap-covered': '待翻译·社区已覆盖',
  'embedded': '内嵌可做（覆盖式产出）',
  'no-text': '无可译文本',
  'no-quests': '无任务书',
}

/**
 * 已确认使用非 FTB 任务书系统的整合包。数据集的 `no-quests` 探测无法区分
 * 「不含任何任务书」与「含非 FTB 任务书系统」，这里按实证逐个登记：
 * - skyfactory-5：Checklist 模组（CF 项目 405211），任务书为
 *   `overrides/config/checklist/tasks.txt`（11.6 KB 纯文本、346 行），非 FTB Quests。
 */
const KNOWN_NON_FTB_QUESTS = new Set(['skyfactory-5'])

/**
 * 六态的玩家视角解释。`why` 用来告诉玩家「为什么这里没有」，
 * 而不是只给一个状态词。
 */
const STATE_EXPLAIN = {
  'downloadable': '本站已产出该整合包的任务书汉化。',
  'native-zh': '整合包自身已带中文，无需另装汉化。',
  'gap-uncovered': '有英文任务书，但本站尚未翻译，社区也无人覆盖。',
  'gap-covered': '有英文任务书，本站尚未翻译，但社区已有汉化可用。',
  'embedded': '任务书文本混在章节数据里，本站以覆盖式补丁产出汉化（解压覆盖到整合包根目录）。'
    + '注意：补丁会改写你的任务书文件，替换前请备份。整合包更新后补丁可能失效。',
  'no-text': '翻译实测该整合包的任务书里没有可译的英文文本（只有任务 ID、图标、奖励表等机械字段），无从汉化。',
  'no-quests': '该整合包不含 FTB Quests 任务书，没有任务书可汉化。'
    + '（若它使用其他任务书系统，如 Checklist，也不在本站范围内。）',
}

/** skyfactory-5 这类已知含非 FTB 任务书系统的包，专用文案。 */
const NON_FTB_LABEL = '无任务书（非 FTB Quests）'
const NON_FTB_EXPLAIN = '该整合包的任务书不是 FTB Quests（如 Checklist），本站只做 FTB Quests 任务书汉化。'

/**
 * GitHub 仓库（工单 04 下载入口）：优先取调用方显式传入，其次 CI 的 GITHUB_REPOSITORY。
 *
 * 兜底常量是**本项目自己的仓库**：本地跑 release.mjs 时没有 CI 环境变量，
 * 若不兜底，download.zip 会是 null，打出的补丁包在详情页上根本没有下载按钮
 * （实测踩到：state 已是 downloadable，但 zip 为 null）。
 */
const FALLBACK_REPO = 'Kalloer1/quest-i18n-index'
const GITHUB_REPO = process.env.GITHUB_REPOSITORY || FALLBACK_REPO

export function buildSiteData({ index, vmStatus, packMeta, quarkMirrors }, { now = new Date().toISOString(), githubRepo = GITHUB_REPO, quarkMirrors: quarkMirrorsOpt, sourceVersions } = {}) {
  // VM 官网部分条目的 slug 带 `/index` 后缀（如 sb4/index），工单 03 已归一化为 sb4。
  // 这里两种写法都认，否则这些包会丢掉汉化来源。
  const vmBySlug = new Map()
  for (const e of vmStatus.entries || []) {
    vmBySlug.set(e.vmSlug, e)
    if (typeof e.buildInputSlug === 'string' && e.buildInputSlug) vmBySlug.set(e.buildInputSlug, e)
  }
  const metaBySlug = new Map((packMeta.packs || []).map(p => [p.slug, p]))
  // 夸克镜像链接（mirror.mjs 写回 research/quark-mirrors.json）：slug → 真实 share_url。
  // 缺失/失败条目为空字符串，详情页不渲染夸克按钮，绝不显示假链接。
  const quarkSource = quarkMirrors ?? quarkMirrorsOpt
  const quarkBySlug = new Map(Object.entries(quarkSource?.mirrors ?? {})
    .map(([slug, v]) => [slug, typeof v === 'string' ? v : (v?.shareUrl || '')]))

  // 上游版本记录（`scripts/source-versions.mjs` 汇总的 `research/source-versions.json`）。
  // 可选输入：文件缺失时整块跳过，所有卡片 sourceVersion 为 null，站点不渲染那一行。
  const versionsBySlug = sourceVersions?.versions ?? {}

  const allPacks = index.dataset.map(row => {
    const meta = metaBySlug.get(row.slug) || null
    const vmEntry = row.vm
      ? vmBySlug.get(row.vm.vmSlug) || vmBySlug.get(String(row.vm.vmSlug).replace(/\/index$/, '')) || null
      : null

    // 「非 FTB 任务书系统」不是第七态：state 仍是 no-quests，只在文案上区分。
    const nonFtb = row.state === 'no-quests' && KNOWN_NON_FTB_QUESTS.has(row.slug)
    return {
      slug: row.slug,
      cfId: row.cfId,
      title: row.title || meta?.title || null,
      iconUrl: meta?.iconUrl || null,
      description: meta?.description || null,
      downloads: meta?.downloads ?? null,
      gameVersions: meta?.gameVersions ?? null,
      loaders: meta?.loaders ?? null,
      authors: meta?.authors ?? null,

      state: row.state,
      // D4：站点要能按平台区分/筛选。原实现漏了这行，导致 `platform` 恒为
      // undefined，下游的跨平台合并永远拿不到平台（2026-10-22 实测发现）。
      platform: row.platform ?? null,
      stateLabel: row.state ? (nonFtb ? NON_FTB_LABEL : STATE_LABEL[row.state]) : null,
      stateWhy: row.stateWhy || (row.state ? (nonFtb ? NON_FTB_EXPLAIN : STATE_EXPLAIN[row.state]) : null),
      probeIncomplete: !!row.probeIncomplete,

      layout: row.layout,
      enFiles: row.enFiles,
      zhFiles: row.zhFiles,

      // 详情页下载入口（工单 04）：仅本站已产出的包（downloadable）有下载区块。
      // zip 走 GitHub raw（zips 随仓库分发），文件名取索引里的 `zipName`
      // （`<slug>.zip` 或 `<slug>_v<version>.zip`，由 build-index 从 downloads/ 实测得出）。
      // 这里**不再自己拼** `<slug>.zip`：文件名的真源只有 build-index 一处，
      // 否则改名后站点链接会全部 404。旧索引没有该字段时回退旧名。
      // quark 为空时详情页不渲染夸克按钮。
      download: row.state === 'downloadable'
        ? {
            zip: githubRepo ? `https://github.com/${githubRepo}/raw/main/downloads/${row.zipName || `${row.slug}.zip`}` : null,
            github: githubRepo ? `https://github.com/${githubRepo}` : null,
            quark: quarkBySlug.get(row.slug) || '',
          }
        : null,

      // 补丁是基于哪个上游整合包文件翻的（详情页「本站产出」下面那行小字）。
      // 旧补丁没有版本记录 → null，页面不渲染（不显示「未知」，避免 494 个旧包变噪声）。
      sourceVersion: (() => {
        if (row.state !== 'downloadable') return null
        const v = versionsBySlug[row.slug]
        if (!v || !v.fileName) return null
        return {
          fileName: v.fileName,
          fileDate: v.fileDate ?? null,
          fetchedAt: v.fetchedAt ?? null,
          recovered: v.recovered === true,
        }
      })(),

      // 社区已有汉化：只放链接与状态，不重分发任何内容
      providers: vmEntry
        ? [{
            name: 'VM汉化组',
            packName: vmEntry.originalName,
            // VM 官网的中文名（如「FTB石头世界4汉化下载」）是玩家搜索时真正会输入的词，
            // 必须带进站点数据，否则中文查询全部落空。
            packNameZh: (vmEntry.name || '').replace(/汉化下载$/, '') || null,
            link: `https://vmct-cn.top/modpacks/${vmEntry.vmSlug}`,
            status: vmEntry.status?.type ?? null,
            statusRecognized: vmEntry.status?.recognized ?? false,
            versions: vmEntry.versions ?? null,
            fetchedAt: vmEntry.fetchedAt ?? null,
          }]
        : [],

      // 待核线索：疑似命中但不计入覆盖
      suspect: row.vmSuspect?.why ?? null,
    }
  })

  // ---- 站点只显示「有 FTB 任务书」的包 ----
  //
  // 2026-10-22 用户裁决：28816 行一次性渲染会把浏览器卡死，页面只保留
  // 「确认含 FTB 任务书」的包，其余不显示。
  //
  // 收窄只发生在**站点数据层**：`research/index-dataset.json` 仍是全量、一条不丢，
  // 将来补探测还能把这些包捞回来。被剔除的两类：
  //   · `no-quests` —— 确认不含 FTB 任务书，没有可汉化的东西
  //   · `probeIncomplete` —— 探测没跑完，我们不知道它有没有任务书。
  //     未知不该冒充「有」，所以一并隐藏；它仍是全量数据集的一部分。
  const visible = allPacks.filter(p => p.state && p.state !== 'no-quests' && !p.probeIncomplete)

  // ---- 跨平台合并：同一 slug 在 CF 与 Modrinth 各有一条记录 ----
  //
  // 实测（2026-10-22）：424 个 slug 在数据集里出现两次，`platform` 分别是 `cf` 与 `mr`。
  // 这不是脏数据 —— 同一个包确实存在于两个平台。但页面上它是**一张卡片**，
  // 所以这里按 slug 合并，把平台收进 `platforms` 数组，绝不丢信息。
  // 合并时以先出现的那条为基准（字段实质相同），只补 `platforms`。
  const bySlug = new Map()
  for (const p of visible) {
    const prev = bySlug.get(p.slug)
    if (!prev) {
      bySlug.set(p.slug, {
        ...p,
        platforms: p.platform ? [p.platform] : [],
        // 平台 → 该平台上的状态。绝大多数包两个平台同态，不必额外展示；
        // 实测有 1 个包不同态（`whispers-in-the-void`：CF 是 gap-uncovered、
        // Modrinth 是 embedded），卡片上带 `stateConflict` 让页面能提示玩家。
        platformStates: p.platform ? { [p.platform]: p.state } : {},
        stateConflict: false,
      })
      continue
    }
    if (p.platform && !prev.platforms.includes(p.platform)) prev.platforms.push(p.platform)
    if (p.platform) prev.platformStates[p.platform] = p.state
    if (p.state !== prev.state) prev.stateConflict = true
  }
  const packs = [...bySlug.values()]

  const stateCounts = {}
  for (const key of Object.keys(STATE_LABEL)) stateCounts[key] = 0
  for (const p of packs) if (p.state) stateCounts[p.state]++

  return {
    generatedAt: now,
    meta: {
      stateLabel: STATE_LABEL,
      stateExplain: STATE_EXPLAIN,
      // ADR-0006：不同来源汉化不能同时装，这是排他选择
      noMixWarning: '不同来源的任务书汉化不能同时安装。同时装多份会导致任务文本错乱或任务无法显示，'
        + '请只选一家，并确认其适配你当前的整合包版本。',
      sources: {
        index: { path: 'research/index-dataset.json', generatedAt: index.generatedAt },
        vmStatus: { source: vmStatus.source, sourceUrl: vmStatus.sourceUrl, fetchedAt: vmStatus.fetchedAt },
        packMetadata: { generatedAt: packMeta.generatedAt, incomplete: packMeta.incomplete },
      },
      license: {
        name: 'CC BY-NC-SA 4.0',
        note: '本站索引只放链接，不重分发任何第三方内容。若将来分发译文，须署名 CFPA 团队与相关模组作者。',
      },
      nonCommercial: true,
    },
    stat: {
      // `total` 是**页面可见的包数**（按 slug 合并后），与 packs.length 一致。
      total: packs.length,
      // 被站点隐藏的原始行数（no-quests + 探测未完成 + 跨平台重复行）。
      // 口径可追溯：total + hidden === 数据集原始行数。
      hidden: index.dataset.length - packs.length,
      stateCounts,
      // 可见包里的探测未完成数恒为 0（它们已被隐藏），保留字段是为了口径不突变。
      probeIncomplete: packs.filter(p => p.probeIncomplete).length,
      withProvider: packs.filter(p => p.providers.length > 0).length,
    },
    packs,
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())

if (isMain) {
  const read = p => JSON.parse(readFileSync(p, 'utf8'))
  // 夸克镜像链接可选：文件不存在（还没跑过镜像）时全部留空
  let quarkMirrors
  try { quarkMirrors = read('research/quark-mirrors.json') } catch { quarkMirrors = { mirrors: {} } }
  // 上游版本汇总可选：文件还没生成（首次上线 / worker 未回捞）时整块跳过。
  let sourceVersions
  try { sourceVersions = read('research/source-versions.json') } catch { sourceVersions = undefined }
  const out = buildSiteData({
    index: read('research/index-dataset.json'),
    vmStatus: read('research/vm-status.json'),
    packMeta: read('research/pack-metadata.json'),
    quarkMirrors,
  }, { sourceVersions })
  mkdirSync('site', { recursive: true })
  writeFileSync('site/data.json', JSON.stringify(out, null, 2) + '\n')
  console.log('→ site/data.json')
  console.log('  可见条数', out.stat.total, '| 已隐藏', out.stat.hidden, '| 有汉化来源', out.stat.withProvider)
  console.log('  六态', JSON.stringify(out.stat.stateCounts))
}
