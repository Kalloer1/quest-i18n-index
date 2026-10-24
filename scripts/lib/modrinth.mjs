#!/usr/bin/env node
/**
 * Modrinth 项目 → 最新 `.mrpack` 下载地址。
 *
 * 为什么需要：`prepare-pack.mjs` 原本只认 CurseForge。实测数据集 28816 条里
 * **18816 条来自 Modrinth**（`research/index-dataset.json` 的 `platform: 'mr'`），
 * 其中 391 条是可产出的任务书包。只走 CF 分支等于放弃一半以上候选。
 *
 * `.mrpack` 就是 zip，任务书在 `overrides/` 下（实测 better-mc-fabric-bmc2.mrpack
 * 63 MB → 35 个 .snbt，20 个在 `overrides/defaultconfigs/ftbquests/quests/chapters/`）。
 * 解包直接复用 `extract-pack.mjs` 的 `extractFromBuffer`：它的 `toOutputPath`
 * 用 ANCHOR_SEGMENTS 锚到 `config`/`ftbquests`/`lang`/`chapters`，
 * **天然剥掉 `overrides/`**，故本模块只管取地址，不碰解包。
 *
 * 纯 HTTP 层：不读文件、不写文件，fetch 可注入（测试全用桩，不联网）。
 */

export const MR_API_BASE = 'https://api.modrinth.com/v2'

/**
 * Modrinth API **强制要求** `User-Agent`，缺了会 400/403（实测）。
 * 这一点与 CurseForge 相反（CF 用 `x-api-key`），故不能靠「浏览器默认 UA」，
 * 必须显式给一个稳定的标识。
 */
export const MR_USER_AGENT = 'quest-i18n/1.0'

/**
 * 项目版本列表端点。slug 与 project id 都能用（Modrinth 两者同路径）。
 * @param {string} slugOrId
 * @returns {string}
 */
export function modrinthProjectUrl(slugOrId) {
  const key = String(slugOrId ?? '').trim()
  if (!key) throw new Error('缺少 Modrinth 项目 slug/id')
  return `${MR_API_BASE}/project/${encodeURIComponent(key)}/version`
}

/**
 * 取项目最新版本里的 `.mrpack` 文件。
 *
 * 版本列表按发布时间倒序，第一个就是最新版（与 `prepare-pack.mjs` 取 CF
 * `pageSize=1` 同口径）。三种失败各有明确文案，不做「退而求其次」的猜测：
 * 拿错包比拿不到包更难发现。
 *
 * @param {string} slug
 * @param {{fetchImpl?: typeof fetch, userAgent?: string}} [options]
 * @returns {Promise<{url: string, fileName: string, fileLength: number|null, versionNumber: string|null, fileId: null, fileDate: string|null, sha1: string|null}>}
 */
export async function resolveLatestMrpack(slug, { fetchImpl = fetch, userAgent = MR_USER_AGENT } = {}) {
  const res = await fetchImpl(modrinthProjectUrl(slug), {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
  })
  // 404 与其它非 2xx 分开说：前者是 slug 打错了，后者是服务端/限流，处置不同。
  if (res.status === 404) throw new Error(`Modrinth 项目不存在：${slug}（404）`)
  if (!res.ok) throw new Error(`Modrinth 版本列表 HTTP ${res.status}：${slug}`)

  const body = await res.json()
  const versions = Array.isArray(body) ? body : []
  if (versions.length === 0) throw new Error(`Modrinth 项目 ${slug} 没有任何版本`)

  const latest = versions[0]
  const files = Array.isArray(latest?.files) ? latest.files : []
  const mrpack = files.find((f) => /\.mrpack$/i.test(String(f?.filename ?? '')))
  if (!mrpack) {
    const seen = files.map((f) => f?.filename).filter(Boolean).join(', ') || '（无文件）'
    throw new Error(`Modrinth 项目 ${slug} 的版本 ${latest?.version_number ?? latest?.id} 没有 .mrpack 文件：${seen}`)
  }

  const url = typeof mrpack.url === 'string' ? mrpack.url.trim() : ''
  if (!url) throw new Error(`Modrinth 项目 ${slug} 的 .mrpack 缺少下载地址`)

  return {
    url,
    fileName: String(mrpack.filename ?? `${slug}.mrpack`),
    fileLength: Number.isFinite(mrpack.size) ? mrpack.size : null,
    versionNumber: latest?.version_number == null ? null : String(latest.version_number),
    // 版本溯源：Modrinth 的文件没有 CF 那样的数字 fileId，故恒为 null；
    // 发布时间取版本条目的 `date_published`（ISO 8601），拿不到就 null。
    fileId: null,
    fileDate: typeof latest?.date_published === 'string' && latest.date_published.trim()
      ? latest.date_published.trim()
      : null,
    // 文件哈希（下载侧校验用）：只透传 sha1（40 位十六进制），大小写归一。
    // 拿不到就 null，调用方据此跳过校验 —— 不猜替代字段。
    sha1: typeof mrpack.hashes?.sha1 === 'string' && /^[0-9a-f]{40}$/i.test(mrpack.hashes.sha1)
      ? mrpack.hashes.sha1.toLowerCase()
      : null,
  }
}
