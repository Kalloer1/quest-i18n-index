/**
 * GitHub 直链全局开关（决策 #8）的共享口径：Worker 与站点测试共用同一套默认值/归一化。
 *
 * 语义：
 * - 开关存 KV 键 `download-settings`，值形如 `{ githubDownloads: boolean }`；
 * - **默认开**（fail-open）：键缺失、值非法、读取失败一律视为 `githubDownloads: true` ——
 *   关闭是主动的运维动作，任何故障都不应把玩家可用的下载入口悄悄藏掉。
 */

export const DOWNLOAD_SETTINGS_KEY = 'download-settings'

export const DEFAULT_DOWNLOAD_SETTINGS = Object.freeze({ githubDownloads: true })

/**
 * 任意 KV 读出物 → `{ githubDownloads: boolean }`。
 * null / 非对象 / 字段缺失或非布尔 → 对应默认值（githubDownloads 缺失时为 true）。
 *
 * @param {unknown} raw
 * @returns {{ githubDownloads: boolean }}
 */
export function normalizeDownloadSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { githubDownloads: DEFAULT_DOWNLOAD_SETTINGS.githubDownloads }
  }
  const gh = raw.githubDownloads
  return { githubDownloads: typeof gh === 'boolean' ? gh : DEFAULT_DOWNLOAD_SETTINGS.githubDownloads }
}
