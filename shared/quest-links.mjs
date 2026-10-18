/**
 * 整合包链接解析：从 CurseForge / Modrinth 页面链接抽取 slug。
 *
 * 只认整合包路径：
 * - CurseForge：`/minecraft/modpacks/<slug>`
 * - Modrinth：`/modpack/<slug>`
 * 光影、模组、资源包等其他分类一律返回 null。
 *
 * 纯函数，绝不抛异常。提交入口只做路径解析（CurseForge 不调 CF API），
 * 项目是否存在、是不是整合包交由调用方处理。
 */

const CF_HOSTS = new Set(['curseforge.com', 'www.curseforge.com'])
const MR_HOSTS = new Set(['modrinth.com', 'www.modrinth.com'])
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i

function parseUrl(url) {
  if (typeof url !== 'string') return null
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function decodeSlug(raw) {
  let slug
  try {
    slug = decodeURIComponent(raw).trim()
  } catch {
    return null // 非法百分号转义：当解析失败处理，不抛
  }
  if (!slug || !SLUG_RE.test(slug)) return null
  return slug
}

/**
 * 从 CurseForge 整合包链接抽取 slug。
 * 支持 https/http、有无 www、尾部子路径（如 /files）、末尾斜杠与查询串。
 * 只认 `/minecraft/modpacks/<slug>` 分类。
 *
 * @param {string} url
 * @returns {string|null} slug，无法解析时返回 null（绝不抛）
 */
export function parseCurseforgeModpackSlug(url) {
  const parsed = parseUrl(url)
  if (!parsed) return null
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (!CF_HOSTS.has(parsed.hostname)) return null

  const m = parsed.pathname.match(/^\/minecraft\/modpacks\/([^/]+)/i)
  if (!m) return null
  return decodeSlug(m[1])
}

/**
 * 从 Modrinth 整合包链接抽取 slug。
 * 只接受 https，只认 `/modpack/<slug>`（兼容 `/modpacks/<slug>`），
 * 容忍末尾斜杠与查询串。
 *
 * @param {string} url
 * @returns {string|null} slug，无法解析时返回 null（绝不抛）
 */
export function parseModrinthModpackSlug(url) {
  const parsed = parseUrl(url)
  if (!parsed) return null
  if (parsed.protocol !== 'https:') return null
  if (!MR_HOSTS.has(parsed.hostname)) return null

  const m = parsed.pathname.match(/^\/modpacks?\/([^/]+)/i)
  if (!m) return null
  return decodeSlug(m[1])
}
