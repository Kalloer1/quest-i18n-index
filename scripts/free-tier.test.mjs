import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  freeTierEnabled, freeTierOnly, freeTierUrl, freeTierModel,
  FREE_TIER_MIN_INTERVAL_MS, FREE_TIER_BACKOFF_MS, FREE_TIER_MAX_RETRIES,
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

// ---- 色码遮蔽（回归：免费层会把 &credstone 翻成 &红石）----

test('shieldColorCodes：色码换成带序号占位符，可无损还原', async () => {
  const { shieldColorCodes, unshieldColorCodes } = await import('./lib/format-codes.mjs')
  const cases = [
    '&6Packager&r will pack &credstone&r power',
    'A &dGrapplin Whisk&r',
    'no codes here',
    '&a&b&c multi',
    '',
  ]
  for (const src of cases) {
    const s = shieldColorCodes(src)
    assert.ok(!/[&§][0-9a-fk-orx]/i.test(s.text), `遮蔽后不应残留色码：${s.text}`)
    assert.equal(unshieldColorCodes(s.text, s.codes), src)
  }
})

test('shieldColorCodes：多个不同色码用不同序号（无序号会被模型合并）', async () => {
  const { shieldColorCodes } = await import('./lib/format-codes.mjs')
  const s = shieldColorCodes('&6a&rb&cc')
  assert.deepEqual(s.codes, ['&6', '&r', '&c'])
  // 三个占位符序号必须互不相同，否则还原时无法区分。
  const marks = s.text.match(/<c\d+>/g)
  assert.deepEqual(marks, ['<c1>', '<c2>', '<c3>'])
})

// ---- hex 色码 &#RRGGBB（2026-10-21 查实的系统性漏译根因）----
//
// FTB Quests 任务书除了 `&a`/`&f` 这种字母色码，还有 `&#ff8137` 这种 6 位 hex 色码。
// `VALID_CODE` 只认字母码，hex 码不被遮蔽、不被计数，于是：
//   1. 提示词里 hex 码以明文出现，模型视之为乱码，常把同句的 <cN> 一起弄丢
//      -> translateText 返回 null -> 该键静默保留英文原文（看起来就是「漏译」）
//   2. 闸门里数的是另一套正则，于是同一批文本质检报「色码数量不一致」但翻译侧不拦
// 实测影响：4 个包 / 3637 个键，hex 键未译率 31.4%，普通键 3.79%（差 8 倍）。
// cobblemon-colony 有 62 条真句子因此没译（"Can You Kill Them All?" 等）。

test('shieldColorCodes：hex 色码 &#RRGGBB 也要遮蔽（否则静默漏译）', async () => {
  const { shieldColorCodes, unshieldColorCodes } = await import('./lib/format-codes.mjs')
  const cases = [
    'Can You &#ff8137&oKill&r Them All?',
    'Time to &#92fe27&oExplore&r the Lands!',
    '&#6100ffDragon',
    '&#fd1c52S&#fd214bt&#fd2645a&#fd2b3er&r',
    'After &#fd1c52&oCollecting&r &#1c3efd&oLogs&r, craft them into Planks.',
  ]
  for (const src of cases) {
    const s = shieldColorCodes(src)
    assert.ok(!/[&§]#[0-9a-fA-F]{6}/.test(s.text), `遮蔽后不应残留 hex 色码：${s.text}`)
    assert.ok(s.codes.length > 0, 'hex 色码必须被计入 codes')
    assert.equal(unshieldColorCodes(s.text, s.codes), src)
  }
})

test('shieldColorCodes：hex 色码与字母色码各自独立占位序号', async () => {
  const { shieldColorCodes } = await import('./lib/format-codes.mjs')
  const s = shieldColorCodes('&#ff8137&oKill&r')
  assert.deepEqual(s.codes, ['&#ff8137', '&o', '&r'])
  const marks = s.text.match(/<c\d+>/g)
  assert.deepEqual(marks, ['<c1>', '<c2>', '<c3>'])
})

test('shieldColorCodes：形似 hex 但不是色码的不能误伤', async () => {
  const { shieldColorCodes, unshieldColorCodes } = await import('./lib/format-codes.mjs')
  // `&#ff8137` 要求严格 6 位十六进制；少一位、多一位、含非十六进制字符都不算。
  // 不足 6 位、非十六进制、中间插空格 —— 这些都不是 color code，必须原样留着。
  for (const src of ['&#ff41 short', '&#ff813 nothex', '&#zzzzzz nothex', '& #ff8137 spaced', '&#8226 bullet']) {
    const s = shieldColorCodes(src)
    assert.deepEqual(s.codes, [], `不该被当成色码：${src}`)
    assert.equal(unshieldColorCodes(s.text, s.codes), src, '必须可无损还原')
  }
  // 贪心取 6 位：7 位十六进制里前 6 位是码，第 7 位是正文（实测 cobblemon-colony 有 &#FF8027F）。
  const greedy = shieldColorCodes('&#FF8027F')
  assert.deepEqual(greedy.codes, ['&#FF8027'])
  assert.equal(unshieldColorCodes(greedy.text, greedy.codes), '&#FF8027F')
  // 大写 hex 也是合法色码，应被遮蔽。
  const upper = shieldColorCodes('&#FF8137Dragon')
  assert.deepEqual(upper.codes, ['&#FF8137'])
})

test('countColorCodes / hasMalformedColorCodes 认识 hex 色码', async () => {
  const { countColorCodes, hasMalformedColorCodes } = await import('./lib/format-codes.mjs')
  const t = '&#ff8137&oKill&r'
  assert.equal(countColorCodes(t), 3, 'hex 码也算色码')
  assert.equal(hasMalformedColorCodes(t), false, '合法 hex 码不是畸形码')
  assert.equal(hasMalformedColorCodes('&#ff81 not-a-code'), true)
})

test('translateText 对 hex 色码文本不再静默返回 null', async () => {
  const { shieldColorCodes } = await import('./lib/format-codes.mjs')
  // 遮蔽后提示词里必须只剩 <cN> 占位符，模型才看得懂要保留什么。
  const s = shieldColorCodes('Can You &#ff8137&oKill&r Them All?')
  assert.ok(!s.text.includes('&#ff8137'), 'hex 码必须以占位符形式出现')
  assert.equal(s.text, 'Can You <c1><c2>Kill<c3> Them All?')
})

test('unshieldColorCodes：占位符丢失时该色码消失，不产生畸形码', async () => {
  const { shieldColorCodes, unshieldColorCodes, hasMalformedColorCodes } = await import('./lib/format-codes.mjs')
  const s = shieldColorCodes('&6Packager&r power')
  const broken = s.text.replace('<c2>', '')
  const back = unshieldColorCodes(broken, s.codes)
  assert.equal(back, '&6Packager power')
  assert.equal(hasMalformedColorCodes(back), false)
})

// ---- 免费层调用纪律（实测得出的硬约束） ----

test('freeTierOnly：缺省开启（封了就停，不静默转付费网关）', () => {
  assert.equal(freeTierOnly({}), true)
  assert.equal(freeTierOnly({ FREE_TIER_ONLY: '' }), true)
  assert.equal(freeTierOnly({ FREE_TIER_ONLY: '1' }), true)
  for (const v of ['0', 'false', 'no', 'off', 'OFF']) {
    assert.equal(freeTierOnly({ FREE_TIER_ONLY: v }), false, v)
  }
})

test('调用纪律常量：间隔 8s、退避递增、最多重试 3 次', () => {
  // 实测：30 条 + 8s 间隔连跑 6 次全过；零间隔时 30 条第 3 次、60 条首块即 504。
  assert.equal(FREE_TIER_MIN_INTERVAL_MS, 8000)
  assert.deepEqual(FREE_TIER_BACKOFF_MS, [30000, 60000, 120000])
  assert.equal(FREE_TIER_MAX_RETRIES, 3)
  // 退避必须严格递增：固定退避救不回「冷启动被限」那段。
  for (let i = 1; i < FREE_TIER_BACKOFF_MS.length; i++) {
    assert.ok(FREE_TIER_BACKOFF_MS[i] > FREE_TIER_BACKOFF_MS[i - 1])
  }
})

// ---- 空串原文不算漏译（实测：aoc 948 条里约 40 条是空串） ----

test('parseInstTransOutput：原文为空串时，空译文是正确结果，不算漏译', () => {
  // 回归：早先把所有空译文当缺行，导致 aoc 稳定报 38 条"漏译"，
  // 而那 38 条原文本来就是 ""，没有任何可翻的内容。
  const sources = ['', 'Hello', '', 'World']
  const content = 'L2=你好\nL4=世界'
  const out = parseInstTransOutput(content, 4, sources)
  assert.deepEqual(out, ['', '你好', '', '世界'])
})

test('parseInstTransOutput：原文非空而译文为空 → 仍算漏译（null）', () => {
  const sources = ['Hello', 'World']
  const content = 'L1=\nL2=世界'
  const out = parseInstTransOutput(content, 2, sources)
  assert.equal(out[0], null, '原文非空、译文空 → 漏译')
  assert.equal(out[1], '世界')
})

test('parseInstTransOutput：不传 sources 时保持旧行为（空译文=缺行）', () => {
  const out = parseInstTransOutput('L1=\nL2=世界', 2)
  assert.deepEqual(out, [null, '世界'])
})
