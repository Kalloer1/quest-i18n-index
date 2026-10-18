import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  freeTierEnabled, freeTierUrl, freeTierModel,
  toSingleLine, fromSingleLine,
  buildInstTransPrompt, parseInstTransOutput,
  callFreeTier,
  DEFAULT_FREE_TIER_URL, DEFAULT_FREE_TIER_MODEL,
} from './lib/free-tier.mjs'

// ---- 配置读取 ----

test('freeTierEnabled：缺省开启，0/false/no/off 关闭', () => {
  assert.equal(freeTierEnabled({}), true)
  assert.equal(freeTierEnabled({ FREE_TIER_ENABLED: '' }), true)
  assert.equal(freeTierEnabled({ FREE_TIER_ENABLED: '1' }), true)
  for (const v of ['0', 'false', 'no', 'off', 'OFF', 'False']) {
    assert.equal(freeTierEnabled({ FREE_TIER_ENABLED: v }), false, v)
  }
})

test('freeTierUrl：只给到 /v1 时自动补 /chat/completions', () => {
  assert.equal(freeTierUrl({}), DEFAULT_FREE_TIER_URL)
  assert.equal(freeTierUrl({ FREE_TIER_BASE_URL: 'https://x/v1' }), 'https://x/v1/chat/completions')
  assert.equal(freeTierUrl({ FREE_TIER_BASE_URL: 'https://x/v1/' }), 'https://x/v1/chat/completions')
  assert.equal(
    freeTierUrl({ FREE_TIER_BASE_URL: 'https://x/v1/chat/completions' }),
    'https://x/v1/chat/completions',
  )
})

test('freeTierModel：缺省用 Index-Translate-35B-A3B', () => {
  assert.equal(freeTierModel({}), DEFAULT_FREE_TIER_MODEL)
  assert.equal(freeTierModel({ FREE_TIER_MODEL: 'custom' }), 'custom')
})

// ---- 单行化：行式协议的前提 ----

test('toSingleLine / fromSingleLine：真实换行转字面量 \\n 并可还原', () => {
  const src = '第一行\n第二行'
  const one = toSingleLine(src)
  assert.ok(!one.includes('\n'), '必须压成单行，否则行式协议错位')
  assert.equal(one, '第一行\\n第二行')
  assert.equal(fromSingleLine(one), src)
})

test('toSingleLine：CRLF 也归一', () => {
  assert.equal(toSingleLine('a\r\nb'), 'a\\nb')
})

// ---- 提示词形态 ----

test('buildInstTransPrompt：单条 user 消息，无 system 角色', () => {
  const msgs = buildInstTransPrompt(['Get a Diamond', 'Hello'])
  assert.equal(msgs.length, 1, '免费层只接受单条 user 消息')
  assert.equal(msgs[0].role, 'user')
  assert.ok(msgs[0].content.includes('【源文】'))
  assert.ok(msgs[0].content.includes('【约束要求】'))
})

test('buildInstTransPrompt：用合成键 L1..Ln 承载顺序', () => {
  const msgs = buildInstTransPrompt(['alpha', 'beta'])
  assert.ok(msgs[0].content.includes('L1=alpha'))
  assert.ok(msgs[0].content.includes('L2=beta'))
})

// ---- 输出解析 ----

test('parseInstTransOutput：按 L<n> 还原顺序', () => {
  const out = parseInstTransOutput('L1=获取钻石\nL2=你好', 2)
  assert.deepEqual(out, ['获取钻石', '你好'])
})

test('parseInstTransOutput：顺序打乱也能归位', () => {
  const out = parseInstTransOutput('L2=你好\nL1=获取钻石', 2)
  assert.deepEqual(out, ['获取钻石', '你好'])
})

test('parseInstTransOutput：漏行返回 null（按行回退），不判整块失败', () => {
  const out = parseInstTransOutput('L1=获取钻石', 3)
  assert.deepEqual(out, ['获取钻石', null, null])
})

test('parseInstTransOutput：越界与空译文都当缺行', () => {
  const out = parseInstTransOutput('L1=好\nL9=越界\nL2=   ', 2)
  assert.deepEqual(out, ['好', null])
})

test('parseInstTransOutput：容忍前导空白与 markdown 噪声行', () => {
  const out = parseInstTransOutput('```\n  L1=获取钻石\n```', 1)
  assert.deepEqual(out, ['获取钻石'])
})

test('parseInstTransOutput：字面量 \\n 还原成真换行', () => {
  const out = parseInstTransOutput('L1=第一行\\n第二行', 1)
  assert.deepEqual(out, ['第一行\n第二行'])
})

// ---- callFreeTier：用 fetch 桩，不联网 ----

const stubFetch = (content, { status = 200 } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ choices: [{ message: { content } }] }),
})

test('callFreeTier：不发 Authorization 头（公开服务不需要）', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = init
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'L1=好' } }] }) }
  }
  await callFreeTier(['hi'], { fetchImpl })
  assert.ok(!('Authorization' in seen.headers), '不应带 Authorization')
  assert.equal(seen.headers['Content-Type'], 'application/json')
})

test('callFreeTier：空输入不发请求', async () => {
  let called = false
  await callFreeTier([], { fetchImpl: async () => { called = true } })
  assert.equal(called, false)
})

test('callFreeTier：HTTP 非 2xx 抛错（由调用方决定降级）', async () => {
  await assert.rejects(
    () => callFreeTier(['hi'], { fetchImpl: stubFetch('', { status: 503 }) }),
    /免费层 HTTP 503/,
  )
})

test('callFreeTier：返回空内容抛错', async () => {
  await assert.rejects(
    () => callFreeTier(['hi'], { fetchImpl: stubFetch('') }),
    /空内容/,
  )
})

test('callFreeTier：正常返回按序解析', async () => {
  const arr = await callFreeTier(['a', 'b'], { fetchImpl: stubFetch('L1=甲\nL2=乙') })
  assert.deepEqual(arr, ['甲', '乙'])
})
