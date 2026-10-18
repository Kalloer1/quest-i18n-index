/**
 * 队列状态回写（pipeline 与 mirror 共用）：POST {WORKER_URL}/status，带 X-Internal-Token。
 *
 * 尽力而为，绝不抛错：
 * - 未配置 WORKER_URL 或 INTERNAL_STATUS_TOKEN 时静默跳过（本地跑不报错、不发请求）。
 * - 非 2xx 时打印 status code 与响应体前 200 字符（不再静默吞掉 Worker 的 400/500）。
 * - 网络异常只打日志——回写失败不得阻断翻译/镜像主流程。
 */
export function defaultReportStatus(id, payload, {
  workerUrl = process.env.WORKER_URL,
  token = process.env.INTERNAL_STATUS_TOKEN,
  log = console.log,
} = {}) {
  if (!workerUrl || !token) return Promise.resolve()
  return fetch(`${workerUrl.replace(/\/+$/, '')}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
    body: JSON.stringify({ id, ...payload }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      log(`  [status] 回写失败 HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
  }).catch((err) => log(`  [status] 回写异常: ${String(err?.message ?? err).slice(0, 120)}`))
}
