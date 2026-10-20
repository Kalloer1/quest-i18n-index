#!/usr/bin/env node
/**
 * 一次一条的逐行翻译器：替代按块批量送免费层的旧路径。
 *
 * ## 为什么必须一次一条（实测 2026-10-20，对 index-translate.bilibili.com 实打实探针）
 *
 * 选用的 `index-mt-9b-syllable` **只回第一行**：给 3 条 `L<n>=` 就只回 `L1=`，3/3 次复现。
 * 也就是说这个模型上批量翻译根本不可行，不是「效果好不好的问题」，是数据直接丢。
 * 于是整个「分块 + 漏译行补翻」的机制都失去意义 —— 一条一次，没有行可丢。
 *
 * 换 `Index-Translate-35B-A3B` 能批量，但实测只有 2.7 req/s，240 次里 32 次撞 60s 超时，
 * 实际比 9B 逐条还慢。故 9B 逐条是本机并行路的唯一选择；
 * `pipeline.mjs` 的 CI 串行路仍用 35B 批量模式（见那边的注释）。
 *
 * ## 并发与延迟
 *
 * lanes=24/32/48 吞吐完全一样（19.7 req/s），零 HTTP 错误 —— 瓶颈在服务端，不在我们。
 * 取 24：吞吐不吃亏，同时把在途请求数压到最小。
 * 最长文本 1251 字符，最坏延迟 8.7s；短文本 p50 约 0.5s。
 *
 * ## 色码占位符
 *
 * 4/55 条长文本会丢 `<cN>` 占位符。**同一 prompt 重试必然复现**（temperature 0，
 * 输出是确定的），所以内容失败时不能原地重试，只能换一套更重的措辞再试一次；
 * 换了之后 1/4 修复，剩下的就留英文 —— 留英文是安全的终态，坏色码不是。
 */
import { freeTierUrl } from './free-tier.mjs'
import { shieldColorCodes, unshieldColorCodes } from './format-codes.mjs'

/**
 * 数一段文本里的占位符（`%s`、`%1$s`、`%value%`、`%d%` 这类）。
 *
 * 与 `validate-quests.mjs` 的 `extractPlaceholders` **同一套正则**，
 * 但刻意不复用那个导出：`validate-quests` 是闸门（写盘后校验），
 * 本模块是翻译器（写盘前拦截），把两者耦合起来会让闸门的改动意外改变翻译行为。
 * 两份实现的一致性由测试锁住（`translate-parallel.test.mjs` 的占位符组）。
 *
 * `%%` 单独计数：它是转义的字面百分号，数量差异闸门只警告不判红，故这里也不拦。
 *
 * @param {string} value
 * @returns {Map<string, number>}
 */
export function countPlaceholders(value) {
  const counts = new Map()
  const bump = (t) => counts.set(t, (counts.get(t) ?? 0) + 1)
  const re = /%%|%\d+\$[sdfx]|%[sdfx]|%[A-Za-z_][A-Za-z0-9_]*%|%\d+%/g
  let m
  while ((m = re.exec(String(value ?? ''))) !== null) bump(m[0])
  return counts
}

/**
 * 译文是否保住了原文的全部**非 `%%`** 占位符（种类与数量都要对）。
 *
 * 为什么必须核：实测 2026-10-20 `tensuranewworld`，英文源是
 * `"Reset Scrolls Price"`，模型回了 `"重置卷轴的价格为：&c1%value%&c2%"` ——
 * 凭空造了一个 `%value%` 和两个色码。闸门抓到了（占位符不一致 1 个键），
 * 但那是**写盘之后**，整个包被判红。写盘前拦住这一条，包就不会脏。
 *
 * @param {string} source
 * @param {string} translated
 * @returns {boolean}
 */
export function placeholdersPreserved(source, translated) {
  const a = countPlaceholders(source)
  const b = countPlaceholders(translated)
  const tokens = new Set([...a.keys(), ...b.keys()])
  for (const t of tokens) {
    if (t === '%%') continue // 字面百分号：闸门只警告，翻译器不拦
    if ((a.get(t) ?? 0) !== (b.get(t) ?? 0)) return false
  }
  return true
}

/**
 * 逐条翻译用的模型。
 *
 * 刻意**不复用** `FREE_TIER_MODEL`：`pipeline.mjs` 的 35B 批量模式还在读它，
 * 一旦这里复用，有人设 `FREE_TIER_MODEL=index-mt-9b-syllable` 就会让 CI 的
 * 30 条一块只翻出第 1 条，静默丢掉 29 条。
 */
export const DEFAULT_TRANSLATE_MODEL = 'index-mt-9b-syllable'

/** 模型 id：`TRANSLATE_MODEL` 优先，缺省 9B。 */
export function translateModel(env = process.env) {
  return String(env.TRANSLATE_MODEL ?? '').trim() || DEFAULT_TRANSLATE_MODEL
}

/** 默认并发。实测 24/32/48 吞吐相同（19.7 req/s），取最小够用的那个。 */
export const DEFAULT_LANES = 24

/** 单请求超时。实测最坏 8.7s，60s 只用来兜住真正卡死的连接。 */
export const TRANSLATE_TIMEOUT_MS = 60_000

/** 输出上限。最长源文 1251 字符，4000 tokens 足够且不给模型续写的空间。 */
export const TRANSLATE_MAX_TOKENS = 4000

/** 温度 0：逐条翻译不需要多样性，越低越不容易漂格式。 */
export const TRANSLATE_TEMPERATURE = 0

/** 传输失败的退避（毫秒）。并发下偶发 5xx，两次足够。单测传 `[0, 0]` 跳过等待。 */
export const TRANSLATE_RETRY_BACKOFF_MS = [2000, 4000]

/**
 * 整段文本是不是 FTB Quests 指令。
 *
 * `{image:...}`、`{@pagebreak}` 这类是渲染指令，没有自然语言可翻。
 * 实测 117/2608 条 atm10 单元是这种，模型会原样返回 —— 白花一次请求。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isDirective(text) {
  return /^\{[\s\S]*\}$/.test(String(text ?? '').trim())
}

/**
 * 逐条翻译的提示词：**一条 user 消息、纯散文**。
 *
 * 为什么不用 `L1=` / `【源文】` 那套行式协议：
 * 实测长文本上模型会把 `L1=` 前缀吃掉，输出变成裸译文，解析层只能判整条失败。
 * 一次一条本来就不需要承载顺序，合成键只会多一个出错面。
 *
 * @param {string} text
 * @param {{emphasizeCodes?: boolean}} [opts]
 * @returns {Array<{role: string, content: string}>}
 */
export function buildLinePrompt(text, { emphasizeCodes = false } = {}) {
  const rules = emphasizeCodes
    ? '2. 文中形如 <c1>、<c2> 的标记是颜色占位符。必须逐字、逐个、按原顺序保留，'
      + '一个都不能少、不能合并、不能改写、不能挪位置。译文有几个词就还写几个标记。\n'
    : '2. 文中形如 <c1>、<c2> 的标记是颜色占位符，请原样保留，顺序不变。\n'
  return [
    {
      role: 'user',
      content: '把下面这段 Minecraft 整合包的任务书文本翻译成简体中文。\n\n'
        + '要求：\n'
        + '1. 只输出译文本身，不要解释、不要引号、不要 markdown。\n'
        + rules
        + '3. 保留 & 开头的色码、%s / %1$s / %value% 这类占位符原样不动。\n'
        + '4. 字面量 \\n 表示原文的换行，原样保留。\n'
        + '5. 模组名、物品 id 之类没有通行译法的专有名词保留英文。\n\n'
        + `原文：\n${text}`,
    },
  ]
}

/** 发一次 HTTP 请求，带超时与外部 abort 联动。 */
function postFetch(url, body, fetchImpl, signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('逐条翻译超时')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  })
}

/**
 * 翻一条文本。
 *
 * - 空串/纯空白 → `''`，不发请求。
 * - 指令（`{...}` 整段） → 原文，不发请求。
 * - 传输失败（HTTP 非 2xx、网络异常） → 退避重试 2 次，仍失败则**抛错**（由调用方决定怎么办）。
 * - 内容失败（占位符丢失、回空） → `null`，**不重试**：temperature 0 下同一 prompt 必然复现。
 *
 * @param {string} text
 * @param {{
 *   fetchImpl?: typeof fetch, url?: string, model?: string, timeoutMs?: number,
 *   signal?: AbortSignal, emphasizeCodes?: boolean, retryBackoffMs?: number[],
 * }} [opts]
 * @returns {Promise<string|null>}
 */
export async function translateText(text, {
  fetchImpl = fetch,
  url = freeTierUrl(),
  model = translateModel(),
  timeoutMs = TRANSLATE_TIMEOUT_MS,
  signal,
  emphasizeCodes = false,
  retryBackoffMs = TRANSLATE_RETRY_BACKOFF_MS,
} = {}) {
  const src = String(text ?? '')
  if (src.trim() === '') return ''
  if (isDirective(src)) return src

  const shielded = shieldColorCodes(src)
  const body = {
    model,
    messages: buildLinePrompt(shielded.text, { emphasizeCodes }),
    temperature: TRANSLATE_TEMPERATURE,
    max_tokens: TRANSLATE_MAX_TOKENS,
    // 9B 默认不思考，发这个字段纯粹是把行为钉死 —— 别哪天服务端默认改了，输出多一段推理。
    enable_thinking: false,
  }

  let lastErr = null
  for (let attempt = 0; attempt <= retryBackoffMs.length; attempt++) {
    try {
      const res = await postFetch(url, body, fetchImpl, signal, timeoutMs)
      if (!res.ok) throw new Error(`逐条翻译 HTTP ${res.status}`)
      const json = await res.json()
      const content = json?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) return null

      // 遮蔽的每个 <cN> 都必须在**还原之前**的原文里核对：
      // 还原是「有则替换」，缺了也看不出来，只能等写盘后色码数校验才发现。
      for (let i = 1; i <= shielded.codes.length; i++) {
        if (!content.includes(`<c${i}>`)) return null
      }
      const restored = unshieldColorCodes(content.trim(), shielded.codes)
      // 占位符也要在返回前核：色码只挡住了一类内容失败，
      // 实测有模型凭空造出 `%value%` 的情况（见 `placeholdersPreserved` 注释）。
      if (!placeholdersPreserved(src, restored)) return null
      return restored
    } catch (e) {
      lastErr = e
      // 重试是给传输抖动的，signal 已 abort 时再等只是白拖。
      if (signal?.aborted) break
      if (attempt < retryBackoffMs.length) {
        await new Promise((r) => setTimeout(r, retryBackoffMs[attempt]))
      }
    }
  }
  throw lastErr ?? new Error('逐条翻译失败')
}

/**
 * 并发翻一批文本，返回与输入**同序**的结果。
 *
 * 调度细节：
 * - 长文本先发。实测长文本 5~8s、短文本 0.5s，按输入序发会把慢尾巴全堆在收尾。
 * - 恰好 `min(lanes, pending)` 个 worker 共享一个游标，且每个 worker 一直取到队列空。
 *   早先写成「干一件就 return」，24 路各干一条就退出，剩下的全成漏译。
 * - 失败项只补扫**一轮**，换 `emphasizeCodes` 的措辞。旧批量模式要 `MAX_MISSING_ROUNDS = 8`，
 *   是因为那时候模型会随机丢行；一次一条不存在随机丢行，多扫纯属浪费。
 *
 * @param {string[]} texts
 * @param {{
 *   lanes?: number, translateFn?: (text: string, opts: {emphasizeCodes: boolean}) => Promise<string|null>,
 * } & Parameters<typeof translateText>[1]} [opts]
 * @returns {Promise<(string|null)[]>}
 */
export async function translateTexts(texts, {
  lanes = DEFAULT_LANES,
  translateFn = translateText,
  ...opts
} = {}) {
  const list = Array.isArray(texts) ? texts.map((t) => String(t ?? '')) : []
  const results = new Array(list.length).fill(null)

  // 不需要请求的项先就地结清，剩下才是真正要排队的。
  const pending = []
  for (let i = 0; i < list.length; i++) {
    if (list[i].trim() === '') results[i] = ''
    else if (isDirective(list[i])) results[i] = list[i]
    else pending.push(i)
  }
  if (!pending.length) return results

  const queue = pending.sort((a, b) => list[b].length - list[a].length)

  /** 用 `min(lanes, n)` 个 worker 跑完 items；worker 一直取到游标越过队尾才退。 */
  const runPass = async (items, emphasizeCodes) => {
    let cursor = 0
    const worker = async () => {
      while (cursor < items.length) {
        const i = items[cursor++]
        try {
          results[i] = await translateFn(list[i], { ...opts, emphasizeCodes })
        } catch {
          // 单条传输失败只影响这一条：留 null，由上层回退英文或计数。
          results[i] = null
        }
      }
    }
    const workers = Math.max(1, Math.min(lanes, items.length))
    await Promise.all(Array.from({ length: workers }, worker))
  }

  await runPass(queue, false)

  // 一轮补扫：只针对还没翻出来的，换更重的占位符措辞（实测能修回 1/4）。
  // 只扫一轮 —— 同 prompt 重试在 temperature 0 下是确定性复现，多扫纯属浪费请求。
  const retry = queue.filter((i) => results[i] == null)
  if (retry.length) await runPass(retry, true)

  return results
}
