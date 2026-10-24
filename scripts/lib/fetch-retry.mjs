/**
 * 带重试的 fetch：CDN（mediafilez.forgecdn.net）在本机网络时间歇性 "fetch failed"
 * （实测同一文件时而 206 全速、时而连接被重置），单次抖动不该让整个包判失败。
 *
 * 瞬时网络错误 / 5xx / 408 / 429 重试（指数退避）；其余状态（4xx、200、206、302）
 * 原样返回，交调用方判定——404 之类明确错误不浪费重试。
 *
 * 与 scan-packs.mjs 的 fetchRetry 同思路，抽成共享库供 prepare-pack 用：
 * zip-range 的 head/getRange、整包下载都经它（preparePack 把 fetchImpl 往下传）。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {string} url
 * @param {object} [init] 原样传给 fetch；未带 signal 时自动加超时
 * @param {number} [tries] 最多尝试次数
 * @param {number} [timeoutMs] 单次请求超时（毫秒）
 * @param {number} [baseWaitMs] 退避基数（毫秒），第 i 次重试等 baseWaitMs * 2^i
 * @returns {Promise<Response>}
 */
export async function fetchRetry(url, init = {}, tries = 5, timeoutMs = 60_000, baseWaitMs = 800) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const signal = init.signal ?? AbortSignal.timeout(timeoutMs)
      const res = await fetch(url, { ...init, signal })
      if (res.status >= 500 || res.status === 429 || res.status === 408) throw new Error('HTTP ' + res.status)
      return res
    } catch (e) {
      last = e
      if (i === tries - 1) break
      await sleep(baseWaitMs * 2 ** i)
    }
  }
  throw last
}

/**
 * CF 的 `downloadUrl` 指向的 CDN 主机在部分网络下不可达：
 * `mediafilez.forgecdn.net` 直连超时、经代理也被重置（实测 2026-10-24，
 * 连续 8 次 CONNECT 失败）；`mediafiles.forgecdn.net` 是同一份对象的可达域名
 * 且支持 Range。换主机名，路径（含签名/编码）一字不改。
 *
 * 先例：`enrich-source-versions.mjs` 的同名函数（实测 CONNECT 502 的场合）。
 * 这里抽成共享库，prepare-pack 的 `downloadUrlOf` 也走它。
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeCdnUrl(url) {
  try {
    const u = new URL(url)
    if (/(^|\.)forgecdn\.net$/i.test(u.hostname)) u.hostname = 'mediafiles.forgecdn.net'
    return u.toString()
  } catch {
    return url
  }
}
