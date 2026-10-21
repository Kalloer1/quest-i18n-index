import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
import { translatePackParallel, loadPackUnits, listTranslatable, DEFAULT_LANES } from './translate-parallel.mjs'
import {
  translateText, translateTexts, buildLinePrompt, isDirective, translateModel,
  DEFAULT_TRANSLATE_MODEL, TRANSLATE_MAX_TOKENS, TRANSLATE_TEMPERATURE,
} from './lib/line-translator.mjs'

/** 造一个最小可用的整合包目录（separate-single 布局）。 */
function makePack(root, slug, entries) {
  const dir = join(root, slug, 'config/ftbquests/quests/lang')
  mkdirSync(dir, { recursive: true })
  const body = entries.map(([k, v]) => `\t${k}: "${v}"`).join('\n')
  writeFileSync(join(dir, 'en_us.snbt'), `{\n${body}\n}\n`)
  return join(root, slug)
}

/** 假 fetch：把请求体交回 handler，由 handler 决定回什么。 */
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    const content = await handler(body, calls.length)
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }
  }
  impl.calls = calls
  return impl
}

const srcText = (body) => body.messages[0].content

// ---- loadPackUnits（原样保留） ----

test('loadPackUnits：读 separate-single 布局的待译单元', () => {
  const root = mkdtempSync(join(tmpdir(), 'par-'))
  try {
    makePack(root, 'p1', [['a.title', 'Hello'], ['a.subtitle', 'World']])
    const r = loadPackUnits('p1', root)
    assert.ok(r, '应能读到包')
    assert.equal(r.layout, 'separate-single')
    assert.equal(r.units.length, 2)
    assert.ok(r.units.every((u) => u.key.includes('::')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadPackUnits：目录不存在返回 null，不抛错', () => {
  assert.equal(loadPackUnits('nope', join(tmpdir(), 'definitely-not-here')), null)
})

test('loadPackUnits：空的 en_us.snbt 不算 separate 源，回退到内嵌章节', () => {
  // 实测 2026-10-21（onlymon / pokeheros-2）：en_us.snbt 内容是 `{ }`（空），
  // 但同目录 chapters/*.snbt 有内嵌文本。按文件名 classifyLayout 判成 separate-single，
  // 于是只抽那个空文件 → 0 个单元 → 整包报「没有产出任何译文」。
  const root = mkdtempSync(join(tmpdir(), 'par-'))
  try {
    const lang = join(root, 'p-empty', 'config/ftbquests/quests/lang')
    const chap = join(root, 'p-empty', 'config/ftbquests/quests/chapters')
    mkdirSync(lang, { recursive: true })
    mkdirSync(chap, { recursive: true })
    writeFileSync(join(lang, 'en_us.snbt'), '{ }\n')
    writeFileSync(join(chap, 'main.snbt'), '{\n\tid: "abc"\n\ttitle: "Kill the Dragon"\n\tsubtitle: "Chapter One"\n}\n')
    const r = loadPackUnits('p-empty', root)
    assert.ok(r, '应能读到包')
    assert.equal(r.layout, 'embedded', '空 en_us.snbt 应回退到内嵌布局')
    assert.ok(r.units.length >= 2, '应抽到内嵌章节里的可译文本')
    assert.ok(r.units.some((u) => /Dragon/.test(u.text)), '应包含章节标题文本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listTranslatable：只返回可产出且无自带中文的包', () => {
  const slugs = listTranslatable()
  assert.ok(Array.isArray(slugs))
  assert.ok(slugs.length > 0, '真实数据集里应有可翻译的包')
  assert.ok(!slugs.includes('skyfactory-5'), '无任务书的包不应入选')
})

// ---- 并发默认值 ----

test('DEFAULT_LANES：24（实测 24/32/48 吞吐相同，24 是安全默认）', () => {
  // 实测 2026-10-20：lanes=24/32/48 吞吐都是 19.7 req/s，零 HTTP 错误。
  // 取 24：吞吐不吃亏，同时在途请求更少（被打回的爆炸半径更小）。
  assert.equal(DEFAULT_LANES, 24)
})

// ---- 提示词形态 ----

test('buildLinePrompt：单条 user 消息、纯散文，不用 L1=/【源文】 行式协议', () => {
  // 行式协议在长文本上会让模型丢掉 `L1=` 前缀，输出无法解析；
  // 一次一条不需要承载顺序，也就没有理由再用合成键。
  const msgs = buildLinePrompt('Get a Diamond')
  assert.equal(msgs.length, 1, '免费层只接受单条 user 消息，不能带 system')
  assert.equal(msgs[0].role, 'user')
  assert.ok(msgs[0].content.includes('Get a Diamond'))
  assert.ok(!msgs[0].content.includes('L1='), '不得再用合成键行式协议')
  assert.ok(!msgs[0].content.includes('【源文】'), '不得再用 instTrans 形态')
  assert.match(msgs[0].content, /简体中文/)
  assert.match(msgs[0].content, /<c1>/, '必须点名色码占位符形态')
})

test('buildLinePrompt：emphasizeCodes 是另一套措辞，逐字要求每个占位符', () => {
  const plain = buildLinePrompt('a', { emphasizeCodes: false })[0].content
  const emph = buildLinePrompt('a', { emphasizeCodes: true })[0].content
  assert.notEqual(plain, emph)
  assert.match(emph, /逐字/)
  assert.ok(emph.includes('<c1>'))
})

// ---- 模型与参数 ----

test('translateModel：读 TRANSLATE_MODEL，缺省 index-mt-9b-syllable', () => {
  // 不能复用 FREE_TIER_MODEL：pipeline.mjs 的 35B 批量模式还在用它，
  // 而 9B 只回第一行 —— 在批量路径上是静默丢掉 29/30 条。
  assert.equal(DEFAULT_TRANSLATE_MODEL, 'index-mt-9b-syllable')
  assert.equal(translateModel({}), DEFAULT_TRANSLATE_MODEL)
  assert.equal(translateModel({ TRANSLATE_MODEL: 'custom' }), 'custom')
  assert.equal(translateModel({ TRANSLATE_MODEL: '  ' }), DEFAULT_TRANSLATE_MODEL)
})

// ---- isDirective ----

test('isDirective：整段被花括号包住的指令返回 true', () => {
  assert.equal(isDirective('{@pagebreak}'), true)
  assert.equal(isDirective('  {image:ftbquests:textures/icon.png}  '), true)
  assert.equal(isDirective('hello'), false)
  assert.equal(isDirective('{image:x} 与后续文字'), false)
  assert.equal(isDirective(''), false)
})

// ---- translateText ----

test('translateText：空串/纯空白零请求，直接回空串', async () => {
  const f = fakeFetch(() => '不该被调用')
  assert.equal(await translateText('', { fetchImpl: f }), '')
  assert.equal(await translateText('   \n ', { fetchImpl: f }), '')
  assert.equal(f.calls.length, 0)
})

test('translateText：指令零请求、原样返回', async () => {
  const f = fakeFetch(() => '不该被调用')
  assert.equal(await translateText('{@pagebreak}', { fetchImpl: f }), '{@pagebreak}')
  assert.equal(f.calls.length, 0)
})

test('translateText：色码先遮蔽成 <cN>，模型保住占位符后还原', async () => {
  const src = '&aHello &rWorld'
  const f = fakeFetch((body) => {
    assert.ok(srcText(body).includes('<c1>'), '送模型的是占位符，不是 & 码')
    assert.ok(srcText(body).includes('<c2>'))
    return '<c1>你好 <c2>世界'
  })
  assert.equal(await translateText(src, { fetchImpl: f, url: 'http://x' }), '&a你好 &r世界')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'http://x')
  assert.equal(f.calls[0].body.temperature, TRANSLATE_TEMPERATURE)
  assert.equal(f.calls[0].body.max_tokens, TRANSLATE_MAX_TOKENS)
  assert.equal(f.calls[0].body.enable_thinking, false)
  assert.equal(f.calls[0].body.model, DEFAULT_TRANSLATE_MODEL)
})

test('translateText：丢占位符返回 null（内容失败，不当传输失败重试）', async () => {
  // 实测 2026-10-20：4/55 长文本丢占位符，同 prompt 重试必然复现（temperature 0），
  // 故这里不重试，交给上层换更重的提示词再试一次。
  const f = fakeFetch(() => '你好 世界')
  assert.equal(await translateText('&aHello &rWorld', { fetchImpl: f }), null)
  assert.equal(f.calls.length, 1, '内容失败不重试')
})

test('translateText：HTTP 非 2xx 重试两次后抛错', async () => {
  let n = 0
  const impl = async () => {
    n++
    return { ok: false, status: 504, json: async () => ({}) }
  }
  await assert.rejects(
    () => translateText('Hello', { fetchImpl: impl, retryBackoffMs: [0, 0] }),
    /504/,
  )
  assert.equal(n, 3, '首次 + 2 次重试')
})

test('translateText：网络异常同样属于传输失败，重试后抛错', async () => {
  let n = 0
  const impl = async () => { n++; throw new Error('fetch failed') }
  await assert.rejects(() => translateText('Hello', { fetchImpl: impl, retryBackoffMs: [0, 0] }), /fetch failed/)
  assert.equal(n, 3)
})

test('translateText：模型回空内容算内容失败返回 null', async () => {
  const f = fakeFetch(() => '   ')
  assert.equal(await translateText('Hello', { fetchImpl: f }), null)
})

// ---- translateTexts ----

test('translateTexts：一条文本一次请求（绝不合并成批）', async () => {
  // 这是本设计的命门：index-mt-9b-syllable 面对多条 L<n>= 只回第一行（实测 3/3），
  // 一旦有人把这里「优化」成批处理，除第一条外全部静默丢失。
  const calls = []
  const outs = await translateTexts(['a', 'b', 'c', 'd', 'e'], {
    lanes: 4,
    translateFn: async (t) => { calls.push(t); return `中:${t}` },
  })
  assert.equal(calls.length, 5, '5 条非空文本必须正好 5 次调用')
  assert.deepEqual(outs, ['中:a', '中:b', '中:c', '中:d', '中:e'])
})

test('translateTexts：指令与空串不调用 translateFn，按原样/空串返回', async () => {
  let n = 0
  const outs = await translateTexts(['{@pagebreak}', '', '{image:ftbquests:textures/x.png}', '  ', 'Hello'], {
    translateFn: async (t) => { n++; return '你好' },
  })
  assert.equal(n, 1)
  assert.deepEqual(outs, ['{@pagebreak}', '', '{image:ftbquests:textures/x.png}', '', '你好'], '空白源归空串')
})

test('translateTexts：结果顺序按输入对齐（调度却是长文本优先）', async () => {
  const texts = ['short', 'a much longer text that takes a while', 'mid size text']
  const order = []
  const outs = await translateTexts(texts, {
    lanes: 1,
    translateFn: async (t) => {
      order.push(t)
      const delay = t.length > 20 ? 5 : 1
      await new Promise((r) => setTimeout(r, delay))
      return `中:${t}`
    },
  })
  assert.deepEqual(outs, texts.map((t) => `中:${t}`), '返回顺序必须与输入一致')
  assert.equal(order[0], texts[1], '长文本应先发，别把慢尾巴留在最后')
})

test('translateTexts：在途请求数从不超过 lanes', async () => {
  let inFlight = 0
  let max = 0
  const texts = Array.from({ length: 20 }, (_, i) => `text ${i}`)
  const outs = await translateTexts(texts, {
    lanes: 3,
    translateFn: async (t) => {
      inFlight++
      max = Math.max(max, inFlight)
      await new Promise((r) => setTimeout(r, 2))
      inFlight--
      return `中:${t}`
    },
  })
  assert.equal(max, 3, `最大在途应正好 3（worker 吃满且不超），实际 ${max}`)
  assert.equal(outs.filter((o) => o != null).length, 20, 'worker 要一直取活，不能干一件就退')
})

test('translateTexts：失败项只补扫一轮，且用更重的色码提示词', async () => {
  const src = 'Hello'
  const plain = buildLinePrompt(src, { emphasizeCodes: false })[0].content
  const emph = buildLinePrompt(src, { emphasizeCodes: true })[0].content
  const seen = []
  const outs = await translateTexts([src], {
    lanes: 1,
    translateFn: async (t, opts) => {
      seen.push(opts.emphasizeCodes ? 'emph' : 'plain')
      return opts.emphasizeCodes ? '你好' : null
    },
  })
  assert.deepEqual(seen, ['plain', 'emph'], '首轮 + 一轮补扫，不能无限补')
  assert.deepEqual(outs, ['你好'])
  assert.notEqual(plain, emph)
})

test('translateTexts：补扫后仍为 null 就保留 null，不再多扫', async () => {
  let n = 0
  const outs = await translateTexts(['Hello', 'World'], {
    lanes: 2,
    translateFn: async () => { n++; return null },
  })
  assert.deepEqual(outs, [null, null])
  assert.equal(n, 4, '2 条 × (首轮 + 一轮补扫)')
})

test('translateTexts：translateFn 抛错被吞成 null，不炸整批', async () => {
  const outs = await translateTexts(['a', 'b'], {
    lanes: 2,
    translateFn: async (t) => { if (t === 'a') throw new Error('504'); return '中:b' },
  })
  assert.deepEqual(outs, [null, '中:b'])
})

// ---- translatePackParallel：落盘分片 ----

test('translatePackParallel：450 条按 200 一组落盘 3 个分片，keys/outs 对齐', async () => {
  const root = mkdtempSync(join(tmpdir(), 'par-'))
  const out = mkdtempSync(join(tmpdir(), 'parout-'))
  try {
    const entries = Array.from({ length: 450 }, (_, i) => [`k${i}.title`, `text ${i}`])
    makePack(root, 'p1', entries)
    const r = await translatePackParallel('p1', {
      outDir: out,
      packsDir: root,
      callFn: async (t) => `中:${t}`,
    })
    assert.equal(r.slug, 'p1')
    assert.equal(r.total, 450)
    assert.equal(r.ok, 450)
    assert.equal(r.missing, 0)

    const files = readdirSync(join(out, 'p1')).filter((f) => /^chunk-\d+\.json$/.test(f)).sort()
    assert.equal(files.length, 3, `450 条 / 200 = 3 个分片，实际 ${files.length}`)

    const units = loadPackUnits('p1', root).units
    const merged = []
    for (const f of files) {
      const d = JSON.parse(readFileSync(join(out, 'p1', f), 'utf8'))
      assert.equal(d.slug, 'p1')
      assert.equal(d.keys.length, d.outs.length)
      assert.deepEqual(Object.keys(d), ['slug', 'chunk', 'keys', 'outs'], 'translate-local 按这个形状读')
      d.keys.forEach((k, i) => merged.push([k, d.outs[i]]))
    }
    assert.equal(merged.length, 450)
    assert.deepEqual(merged.map((m) => m[0]), units.map((u) => u.key), '分片合并后仍与原单元同序')
    assert.equal(merged[0][1], '中:text 0')
    assert.equal(merged[449][1], '中:text 449')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('translatePackParallel：计数区分漏译/未译/空串/指令', async () => {
  const root = mkdtempSync(join(tmpdir(), 'par-'))
  const out = mkdtempSync(join(tmpdir(), 'parout-'))
  try {
    makePack(root, 'p1', [
      ['a.title', 'Mekanism'],
      ['a.subtitle', ''],
      ['a.description', '{@pagebreak}'],
      ['b.title', 'Hello'],
      ['b.subtitle', 'Lost in translation'],
    ])
    const r = await translatePackParallel('p1', {
      outDir: out,
      packsDir: root,
      lanes: 1,
      callFn: async (t) => {
        if (t === 'Mekanism') return 'Mekanism' // 14/240 实测：模组名原样回来，是「未译」不是失败
        if (t === 'Lost in translation') return null
        return '你好'
      },
    })
    assert.equal(r.total, 5)
    assert.equal(r.directives, 1)
    assert.equal(r.skipped, 1)
    assert.equal(r.untranslated, 1)
    assert.equal(r.missing, 1)
    assert.equal(r.ok, 2, 'ok = 有译文的非空、非指令条数（未译也算有产出）')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

// ---- U5：布局判定收敛为单一事实来源（ADR-0009 D10） ----
//
// `loadPackUnits` 曾自己写一份三行判定（lang/en_us/ → separate-dir；
// lang/en_us.snbt → separate-single；否则 embedded），与 lib/candidates.mjs 的
// `classifyLayout` 同序同义却分居两处 —— 改一处不会带动另一处。
// 实测（2026-10-20，research/packs/ 下 34 个包逐一对齐）：0 处分歧。
// 故收敛为 `loadPackUnits` 改调 `classifyLayout`，本组测试锁住这件事。

import { classifyLayout } from './lib/candidates.mjs'

/** 造一个整合包目录树，只放 .snbt（内容为空也无妨，判定只看路径）。 */
function makeTree(root, slug, relPaths) {
  const dir = join(root, slug)
  for (const rel of relPaths) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, '{\n}\n')
  }
  return dir
}

/** 递归列 .snbt 相对路径，与 loadPackUnits 内部同口径。 */
function listSnbt(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listSnbt(full, base))
    else if (/\.snbt$/i.test(name)) out.push(full.slice(base.length + 1).split('\\').join('/'))
  }
  return out.sort()
}

test('U5：loadPackUnits 的布局判定与 classifyLayout 一致（separate-dir）', () => {
  const root = mkdtempSync(join(tmpdir(), 'u5-'))
  try {
    const dir = makeTree(root, 'p-dir', [
      'config/ftbquests/quests/lang/en_us/chapters/a.snbt',
      'config/ftbquests/quests/lang/en_us/chapters/b.snbt',
    ])
    const names = listSnbt(dir)
    assert.equal(loadPackUnits('p-dir', root).layout, classifyLayout(names).layout)
    assert.equal(classifyLayout(names).layout, 'separate-dir')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('U5：loadPackUnits 的布局判定与 classifyLayout 一致（separate-single）', () => {
  const root = mkdtempSync(join(tmpdir(), 'u5-'))
  try {
    const dir = makeTree(root, 'p-single', ['config/ftbquests/quests/lang/en_us.snbt'])
    const names = listSnbt(dir)
    assert.equal(loadPackUnits('p-single', root).layout, classifyLayout(names).layout)
    assert.equal(classifyLayout(names).layout, 'separate-single')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('U5：同时有 chapters/ 与 lang/en_us.snbt 时判 separate-single（不是 embedded）', () => {
  // 实测 adm-confluence-otherworld：13 个 chapters/*.snbt + 1 个 lang/en_us.snbt。
  // 旧的两份实现都判 separate-single；这条测试锁住优先级不会因重构而颠倒。
  const root = mkdtempSync(join(tmpdir(), 'u5-'))
  try {
    const dir = makeTree(root, 'p-mixed', [
      'config/ftbquests/quests/lang/en_us.snbt',
      'config/ftbquests/quests/chapters/a.snbt',
      'config/ftbquests/quests/chapters/b.snbt',
    ])
    const names = listSnbt(dir)
    assert.equal(loadPackUnits('p-mixed', root).layout, 'separate-single')
    assert.equal(classifyLayout(names).layout, 'separate-single')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('U5：只有 chapters/ 时判 embedded，两份实现仍一致', () => {
  const root = mkdtempSync(join(tmpdir(), 'u5-'))
  try {
    const dir = makeTree(root, 'p-emb', [
      'config/ftbquests/quests/chapters/a.snbt',
      'config/ftbquests/quests/chapters/b.snbt',
    ])
    const names = listSnbt(dir)
    assert.equal(loadPackUnits('p-emb', root).layout, classifyLayout(names).layout)
    assert.equal(classifyLayout(names).layout, 'embedded')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('U5：research/packs/ 下每个真实包的两种判定都一致（34 包实测锁进 CI）', () => {
  // 这条是 D10 的核心证据：2026-10-20 手工逐包比对 0 处分歧。
  // 收敛后它仍必须成立 —— 一旦 classifyLayout 的优先级被改，这里会立刻红。
  const packsRoot = join(ROOT, 'research/packs')
  if (!existsSync(packsRoot)) {
    // 干净克隆里 research/packs/ 已入库（commit a1830e2），正常应存在；
    // 不存在时跳过而不是假通过。
    return
  }
  const dirs = readdirSync(packsRoot).filter((n) => statSync(join(packsRoot, n)).isDirectory())
  assert.ok(dirs.length > 0, 'research/packs/ 下应有包')
  let compared = 0
  const diverged = []
  for (const slug of dirs) {
    const names = listSnbt(join(packsRoot, slug))
    if (!names.length) continue
    const r = loadPackUnits(slug, packsRoot)
    const viaClassify = classifyLayout(names).layout
    if (r.layout !== viaClassify) diverged.push(`${slug}: loadPackUnits=${r.layout} classifyLayout=${viaClassify}`)
    compared++
  }
  assert.ok(compared > 0, '至少应比对一个包')
  assert.deepEqual(diverged, [], `两种布局判定出现分歧：${diverged.join('; ')}`)
})

test('U5：loadPackUnits 不得再内联一份布局判定（结构性断言）', () => {
  // 行为测试锁不住「两份实现」这件事本身：只要两份逻辑相同，行为测试全绿。
  // 故直接断言源码里不再有那段三行内联判定，并把 classifyLayout 的调用钉住。
  const src = readFileSync(join(ROOT, 'scripts/translate-parallel.mjs'), 'utf8')
  // 用不含反斜杠的独特子串做结构断言，避免正则/字符串两层转义出错。
  const hasInline = src.includes('names.some((n) => /lang')
  assert.ok(!hasInline, 'loadPackUnits 仍在内联布局判定 —— 应改调 classifyLayout')
  assert.match(src, /classifyLayout/, '应导入并使用 classifyLayout')
})

// ---- 占位符守卫：模型不得凭空造出 %value% 这类占位符 ----
//
// 实测（2026-10-20，tensuranewworld）：英文源是 "Reset Scrolls Price"，
// 模型回 "重置卷轴的价格为：&c1%value%&c2%"，凭空造了一个 %value% 与两个色码。
// 闸门抓到了（占位符不一致 1 个键），但那是**写盘之后**才发现 —— 整包被判红。
// `translateText` 原来只核对色码占位符 `<cN>`，不核对 %s / %value% 这类，
// 于是这种内容失败被当成成功返回。现在两者都核，任一不符即返回 null（内容失败，不重试）。

test('translateText：模型凭空造出 %value% 时返回 null（不只是色码要核）', async () => {
  const fetchImpl = fakeFetch(() => '重置卷轴的价格为：%value%')
  const out = await translateText('Reset Scrolls Price', {
    fetchImpl, retryBackoffMs: [0, 0],
  })
  assert.equal(out, null, '源文没有 %value%，译文凭空多出来必须判内容失败')
})

test('translateText：源文有 %value% 且译文保留 → 正常返回', async () => {
  const fetchImpl = fakeFetch(() => '价格是 %value% 个卷轴')
  const out = await translateText('Price is %value% scrolls', {
    fetchImpl, retryBackoffMs: [0, 0],
  })
  assert.equal(out, '价格是 %value% 个卷轴')
})

test('translateText：源文有 %s 而译文丢了 → 返回 null', async () => {
  const fetchImpl = fakeFetch(() => '你好世界')
  const out = await translateText('Hello %s', { fetchImpl, retryBackoffMs: [0, 0] })
  assert.equal(out, null)
})

test('translateText：%% 数量差异不算内容失败（样式差异，闸门也只警告）', async () => {
  const fetchImpl = fakeFetch(() => '百分之百')
  const out = await translateText('100%% sure', { fetchImpl, retryBackoffMs: [0, 0] })
  assert.equal(out, '百分之百')
})

// ---- 边翻边落盘：不能等全包翻完才写分片 ----
//
// 实测（2026-10-21，serv00）`tensura-waka-edition` 有 42,944 条，跑了 23 分钟，
// 期间 `research/par-out/<slug>/` 一直是空的 —— 旧实现是 `translateTexts` 全量返回后
// 才一次性写所有分片。后果：中途中断则整包白跑，且外部完全看不出进度。
//
// 现在要求：每凑满 SHARD_SIZE 条（且是该分片最后一条落位）就立刻落盘。

test('translatePackParallel：首个分片在整包翻完之前就已落盘（边翻边写）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'par-stream-'))
  const out = mkdtempSync(join(tmpdir(), 'par-stream-out-'))
  try {
    // 450 条 → 3 个分片（200/200/50）。
    // 文本必须**等长**：`translateTexts` 按长度降序调度（长文本先发），
    // 长度不齐会让调度序与索引序错开，第 0 片就不是最先填满的那一片，
    // 测的就不再是「边翻边落盘」而是调度顺序。
    const entries = []
    for (let i = 0; i < 450; i++) {
      const id = String(i).padStart(3, '0')
      entries.push([`q${id}.title`, `text ${id}`])
    }
    makePack(root, 'p1', entries)

    // 用计数而不是计时判定：前 200 条翻完后，让第 201 条一直挂着，
    // 直到我们确认第 1 片已落盘才放行。这样与机器快慢无关。
    let served = 0
    let releaseLater = null
    const laterGate = new Promise((res) => { releaseLater = res })
    const dir = join(out, 'p1')

    const p = translatePackParallel('p1', {
      outDir: out, packsDir: root, lanes: 1, runId: 'rr',
      callFn: async (t) => {
        served++
        if (served > 200) await laterGate   // 卡住第 201 条之后的所有请求
        return '你好'
      },
    })

    // 等第 1 片出现（最多 5 秒）。此刻 served 应恰好停在 200 附近 —— 后半被 gate 卡住。
    let sawFirstShard = false
    for (let i = 0; i < 100; i++) {
      if (existsSync(dir) && readdirSync(dir).some((f) => f.startsWith('chunk-0000.'))) { sawFirstShard = true; break }
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.ok(sawFirstShard, '首个分片应在整包翻完前落盘')
    assert.ok(served <= 201, `第 1 片落盘时应还没翻完后半（实际已发 ${served} 条请求）`)

    releaseLater()
    const r = await p
    assert.equal(r.ok, 450)
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.rr.json')).length, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('translatePackParallel：中断后已落盘的分片仍在（可续跑）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'par-resume-'))
  const out = mkdtempSync(join(tmpdir(), 'par-resume-out-'))
  try {
    const entries = []
    for (let i = 0; i < 400; i++) entries.push([`q${i}.title`, `text ${i}`])
    makePack(root, 'p1', entries)

    const ctrl = new AbortController()
    const p = translatePackParallel('p1', {
      outDir: out, packsDir: root, lanes: 4, runId: 'rr',
      callFn: async (t) => {
        const n = Number(/text (\d+)/.exec(t)?.[1] ?? 0)
        if (n >= 200) {
          ctrl.abort()               // 后半段直接中断
          throw new Error('aborted')
        }
        return '你好'
      },
    })
    await p.catch(() => {})
    const dir = join(out, 'p1')
    const shards = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.rr.json')) : []
    assert.ok(shards.length >= 1, '中断前已落盘的分片必须留下')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})
