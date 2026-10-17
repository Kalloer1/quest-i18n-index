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
  'embedded': '内嵌不可做',
  'no-quests': '无任务书',
}

/**
 * 六态的玩家视角解释。`why` 用来告诉玩家「为什么这里没有」，
 * 而不是只给一个状态词。
 */
const STATE_EXPLAIN = {
  'downloadable': '本站已产出该整合包的任务书汉化。',
  'native-zh': '整合包自身已带中文，无需另装汉化。',
  'gap-uncovered': '有英文任务书，但本站尚未翻译，社区也无人覆盖。',
  'gap-covered': '有英文任务书，本站尚未翻译，但社区已有汉化可用。',
  'embedded': '任务书文本混在章节数据里，该版本的 FTB Quests 没有翻译系统，无法以新增文件的方式汉化。',
  'no-quests': '该整合包不含 FTB Quests 任务书，没有任务书可汉化。',
}

export function buildSiteData({ index, vmStatus, packMeta }, { now = new Date().toISOString() } = {}) {
  // VM 官网部分条目的 slug 带 `/index` 后缀（如 sb4/index），工单 03 已归一化为 sb4。
  // 这里两种写法都认，否则这些包会丢掉汉化来源。
  const vmBySlug = new Map()
  for (const e of vmStatus.entries || []) {
    vmBySlug.set(e.vmSlug, e)
    if (typeof e.buildInputSlug === 'string' && e.buildInputSlug) vmBySlug.set(e.buildInputSlug, e)
  }
  const metaBySlug = new Map((packMeta.packs || []).map(p => [p.slug, p]))

  const packs = index.dataset.map(row => {
    const meta = metaBySlug.get(row.slug) || null
    const vmEntry = row.vm
      ? vmBySlug.get(row.vm.vmSlug) || vmBySlug.get(String(row.vm.vmSlug).replace(/\/index$/, '')) || null
      : null

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
      stateLabel: row.state ? STATE_LABEL[row.state] : null,
      stateWhy: row.stateWhy || (row.state ? STATE_EXPLAIN[row.state] : null),
      probeIncomplete: !!row.probeIncomplete,

      layout: row.layout,
      enFiles: row.enFiles,
      zhFiles: row.zhFiles,

      // 社区已有汉化：只放链接与状态，不重分发任何内容
      providers: vmEntry
        ? [{
            name: 'VM汉化组',
            packName: vmEntry.originalName,
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
      total: packs.length,
      stateCounts,
      probeIncomplete: packs.filter(p => p.probeIncomplete).length,
      withProvider: packs.filter(p => p.providers.length > 0).length,
    },
    packs,
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())

if (isMain) {
  const read = p => JSON.parse(readFileSync(p, 'utf8'))
  const out = buildSiteData({
    index: read('research/index-dataset.json'),
    vmStatus: read('research/vm-status.json'),
    packMeta: read('research/pack-metadata.json'),
  })
  mkdirSync('site', { recursive: true })
  writeFileSync('site/data.json', JSON.stringify(out, null, 2) + '\n')
  console.log('→ site/data.json')
  console.log('  条数', out.stat.total, '| 有汉化来源', out.stat.withProvider, '| 探测未完成', out.stat.probeIncomplete)
  console.log('  六态', JSON.stringify(out.stat.stateCounts))
}
