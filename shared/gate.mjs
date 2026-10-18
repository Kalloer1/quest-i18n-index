/**
 * 维护者门禁与模型多选的纯函数（工单 05）。
 *
 * 消费方：
 * - worker/index.js（POST /translate、POST /verify-passphrase、GET /models）
 * - scripts/worker-translate-gate.test.mjs
 */

/**
 * 口令校验（纯函数）。
 * 期望值缺失视为服务配置错误（返回 'missing-config'），绝不放行；
 * 非字符串输入一律视为口令不符。
 *
 * @param {unknown} input 请求头里的 X-Passphrase
 * @param {unknown} expected Worker secret TRANSLATE_PASSPHRASE
 * @returns {'ok' | 'missing-config' | 'mismatch'}
 */
export function verifyPassphrase(input, expected) {
  if (typeof expected !== 'string' || !expected) return 'missing-config'
  return input === expected ? 'ok' : 'mismatch'
}

/**
 * 把 /translate body.models 归一化为模型 id 数组（纯函数）。
 * 接受数组或逗号分隔字符串；去空白、去空项、去重，保持首次出现顺序。
 * 调用方拿到列表后必须再对网关实时 /models 做白名单过滤，任意字符串不透传。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseModelsInput(raw) {
  if (raw == null) return []
  const parts = Array.isArray(raw)
    ? raw.map((s) => String(s))
    : String(raw).split(',')
  const seen = new Set()
  const out = []
  for (const part of parts) {
    const id = part.trim()
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}
