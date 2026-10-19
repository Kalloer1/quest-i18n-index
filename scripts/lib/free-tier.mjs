#!/usr/bin/env node
/**
 * 免费层：bilibili Index-Translate 公开 API（无需 API key、无 SLA）。
 *
 * 为什么要有它：自建网关按 token 计费，而整合包任务书动辄几千条文本。
 * 免费层作为**默认主路**，失败才落到自建网关模型池（ADR-0007 已决）。
 *
 * 与网关提供方的三处关键差异（都是实测得出的，不是猜的）：
 *   1. **不需要 Authorization 头**（实测不带 auth 返回 200）；
 *   2. 提示词必须是**单条 user 消息 + instTrans 形态**（`【源文】`/`【约束要求】`），
 *      不能带 system 角色 —— 带 system 会「把键名一起翻掉」；
 *   3. 输出是**行式 `键=值`**，不是 JSON 数组。故用合成键 `L1..Ln` 承载顺序。
 *
 * 刻意不参与 `LLM_MODELS`：否则管理区一勾模型就会静默关掉免费层，界面上看不出来。
 */

export const DEFAULT_FREE_TIER_URL = 'https://index-translate.bilibili.com/v1/chat/completions'
export const DEFAULT_FREE_TIER_MODEL = 'Index-Translate-35B-A3B'

/** 单请求超时（免费层无 SLA，不能让它拖满整条整合包的预算）。 */
export const FREE_TIER_TIMEOUT_MS = 60_000

/** 连续失败多少次才判定「本轮免费层不可用」。单次抖动只降级当前分块。 */
export const FREE_TIER_FAILURE_THRESHOLD = 2

/**
 * 免费层最小调用间隔（毫秒）。
 *
 * 实测（2026-10-19，本机连续探测）：
 *   - 30 条 + 8s 间隔，连跑 6 次全部 200；
 *   - 30 条零间隔，第 3 次就 504；
 *   - 60 条零间隔，30.6s 后 504（旧 CHUNK_LINES=60 正好踩这条线）。
 *
 * 所以限速的触发变量是**调用频度**，不是单次体积。改小分块没用，隔开时间才有用。
 */
export const FREE_TIER_MIN_INTERVAL_MS = 8000

/**
 * 免费层失败后的指数退避序列（毫秒）。
 *
 * 为何需要：实测完整跑一个整合包（21 块），失败集中在开头第 3/4/6 块，
 * 之后连续 15 块全过——冷启动阶段会被限一下，跑热了就稳。
 * 30s → 60s → 120s 正好跨过这个冷却期；再长就接近单包超时了。
 */
export const FREE_TIER_BACKOFF_MS = [30_000, 60_000, 120_000]

/** 免费层单块最多重试几次（不含首次）。3 次 = 共 4 次尝试。 */
export const FREE_TIER_MAX_RETRIES = 3

/**
 * 只走免费层，**绝不静默转付费网关**。
 *
 * 背景（ADR-0009 U2，用户裁决「先翻译，封了再说」）：
 * 旧行为是连续 2 次失败就熔断并静默切到 `LLM_MODELS` 网关，
 * 而网关是**按 token 计费**的。322 个整合包一旦免费层全封，
 * 会在无人察觉的情况下烧掉难以预估的额度。
 *
 * 默认开启（未设或空字符串都视为开启）；显式设 `0/false/no/off` 才允许转网关。
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
export function freeTierOnly(env = process.env) {
  const raw = env.FREE_TIER_ONLY
  if (raw === undefined || raw === '') return true
  return !/^(0|false|no|off)$/i.test(String(raw).trim())
}

/** 免费层固定温度：低温度减少格式漂移。 */
export const FREE_TIER_TEMPERATURE = 0.2
export const FREE_TIER_MAX_TOKENS = 8192

/**
 * 是否启用免费层。缺省开启；`0/false/no/off` 关闭。
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
export function freeTierEnabled(env = process.env) {
  const raw = env.FREE_TIER_ENABLED
  if (raw === undefined || raw === '') return true
  return !/^(0|false|no|off)$/i.test(String(raw).trim())
}

/**
 * 免费层地址：允许只给到 `/v1`，自动补 `/chat/completions`。
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function freeTierUrl(env = process.env) {
  const raw = String(env.FREE_TIER_BASE_URL ?? '').trim() || DEFAULT_FREE_TIER_URL
  return /\/chat\/completions$/.test(raw) ? raw : `${raw.replace(/\/+$/, '')}/chat/completions`
}

/**
 * 免费层模型 id。
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function freeTierModel(env = process.env) {
  return String(env.FREE_TIER_MODEL ?? '').trim() || DEFAULT_FREE_TIER_MODEL
}

/**
 * 把一条文本压成单行：真实换行转成字面量 `\n` 两个字符，翻译后还原。
 *
 * 为什么必须这么做：免费层是**行式**协议（一行一条 `键=值`），
 * 任务书描述里的真实换行会让行数对不上，整块译文错位。
 * @param {string} text
 * @returns {string}
 */
export function toSingleLine(text) {
  return String(text ?? '').replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/\r/g, '')
}

/**
 * 还原 `toSingleLine` 的转义。
 * @param {string} text
 * @returns {string}
 */
export function fromSingleLine(text) {
  return String(text ?? '').replace(/\\n/g, '\n')
}

/**
 * 构造 instTrans 形态的提示词：**单条 user 消息**（无 system），合成键承载顺序。
 * @param {string[]} texts
 * @returns {Array<{role: string, content: string}>}
 */
export function buildInstTransPrompt(texts) {
  const body = texts
    .map((t, i) => `L${i + 1}=${toSingleLine(t)}`)
    .join('\n')
  return [
    {
      role: 'user',
      content: `【源文】\n${body}\n\n【约束要求】\n`
        + '1. 只翻译等号右侧；等号左侧的键名（L1、L2…）一字不改，必须原样保留。\n'
        + '2. 保留色码（&7 这类 & 加一个字符）与占位符（%s、%1$s、%value%）的原样与数量。\n'
        + '3. 输出行数与输入完全一致、顺序相同；禁止合并、拆分或增删行。\n'
        + '4. 字面量 \\n 表示原文中的换行，必须原样保留。\n'
        + '5. 只输出结果行，禁止解释、序号、markdown 代码块。\n'
        + '6. 这是 Minecraft 整合包的任务书文本，术语用大陆通行译法。',
    },
  ]
}

/**
 * 解析免费层的行式输出，按合成键 `L<n>` 还原顺序。
 *
 * 缺行不判整块失败：返回 `null` 占位，由调用方按行回退（漏掉的行留英文）。
 * 实测免费层会以一定概率漏行，若按整块失败处理会扔掉全部好译文。
 *
 * @param {string} content 模型返回的原始文本
 * @param {number} expected 期望条数
 * @returns {(string|null)[]} 长度恒为 expected；缺失位置为 null
 */
export function parseInstTransOutput(content, expected) {
  const out = new Array(expected).fill(null)
  const lines = String(content ?? '').replace(/\r\n/g, '\n').split('\n')
  for (const line of lines) {
    const m = /^\s*L(\d+)\s*=(.*)$/.exec(line)
    if (!m) continue
    const idx = Number(m[1]) - 1
    if (!Number.isInteger(idx) || idx < 0 || idx >= expected) continue
    const value = m[2]
    // 空译文等同于缺行：留英文比留空更好。
    if (value.trim() === '') continue
    out[idx] = fromSingleLine(value)
  }
  return out
}

/**
 * 调一次免费层。单次尝试、无退避、带超时；失败抛错。
 *
 * @param {string[]} texts
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   url?: string,
 *   model?: string,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<(string|null)[]>}
 */
export async function callFreeTier(texts, {
  fetchImpl = fetch,
  url = freeTierUrl(),
  model = freeTierModel(),
  timeoutMs = FREE_TIER_TIMEOUT_MS,
  signal,
} = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('免费层超时')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: buildInstTransPrompt(texts),
        temperature: FREE_TIER_TEMPERATURE,
        max_tokens: FREE_TIER_MAX_TOKENS,
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`免费层 HTTP ${res.status}`)
    const json = await res.json()
    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content) throw new Error('免费层返回空内容')
    return parseInstTransOutput(content, texts.length)
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
