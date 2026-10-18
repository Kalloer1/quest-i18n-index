/**
 * 工单 05：维护者门禁与一键触发 的离线单元测试。
 *
 * 覆盖（在 HTTP handler 这个 seam 上观察）：
 * - POST /translate：口令 401 / 缺配置 500 / dispatch 成功并置「翻译中」 /
 *   retryFailed 语义 / 「翻译中」永不入选 / 无条目 triggered:false / models 白名单 / 网关不可达 400
 * - POST /verify-passphrase：正确 200、错误 401
 * - GET /models：代理网关列表，不含秘密
 * - shared/gate.mjs：verifyPassphrase / parseModelsInput
 *
 * 用内存 KV 假实现 + 打桩 globalThis.fetch，不发任何真实网络请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker from '../worker/index.js'
import { verifyPassphrase, parseModelsInput } from '../shared/gate.mjs'

const ALLOWED_ORIGIN = 'https://quest.mccnp.top'

function makeKV() {
  const store = new Map()
  return {
    store,
    async get(key, type) {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key, value) {
      store.set(key, value)
    },
    async delete(key) {
      store.delete(key)
    },
  }
}

function makeEnv(extra = {}) {
  return {
    TRANSLATION_QUEUE: makeKV(),
    INTERNAL_STATUS_TOKEN: 'test-salt',
    TRANSLATE_PASSPHRASE: 'secret-pass',
    GITHUB_PAT: 'gh_pat_test',
    GITHUB_REPO: 'owner/repo',
    GITHUB_WORKFLOW_FILE: 'translate.yml',
    LLM_BASE_URL: 'https://gateway.test/v1',
    LLM_API_KEY: 'sk-test',
    ...extra,
  }
}

async function seedQueue(env, entries) {
  const ids = entries.map((e) => e.id)
  await env.TRANSLATION_QUEUE.put('queue:index', JSON.stringify(ids))
  for (const e of entries) {
    await env.TRANSLATION_QUEUE.put(
      'queue:' + e.id,
      JSON.stringify({ status: '待翻译', ...e }),
    )
  }
}

function post(path, body, headers = {}) {
  return new Request('https://api.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN, ...headers },
    body: JSON.stringify(body ?? {}),
  })
}

function get(path, headers = {}) {
  return new Request('https://api.test' + path, {
    method: 'GET',
    headers: { Origin: ALLOWED_ORIGIN, ...headers },
  })
}

/** 打桩 globalThis.fetch，记录调用；测试结束务必还原。 */
async function withFetch(stub, fn) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts })
    return stub(String(url), opts)
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

function jsonResponse(body, status = 200) {
  // 204/304 不得带 body，否则 Response 构造会抛 TypeError
  const init = { status, headers: { 'Content-Type': 'application/json' } }
  return status === 204 || status === 304
    ? new Response(null, init)
    : new Response(JSON.stringify(body), init)
}

// ---------- shared/gate.mjs ----------

test('verifyPassphrase：ok / mismatch / missing-config', () => {
  assert.equal(verifyPassphrase('secret-pass', 'secret-pass'), 'ok')
  assert.equal(verifyPassphrase('wrong', 'secret-pass'), 'mismatch')
  assert.equal(verifyPassphrase('', 'secret-pass'), 'mismatch')
  assert.equal(verifyPassphrase('secret-pass', undefined), 'missing-config')
  assert.equal(verifyPassphrase('secret-pass', ''), 'missing-config')
})

test('parseModelsInput：数组 / 逗号字符串 / 去重去空 / 顺序保持', () => {
  assert.deepEqual(parseModelsInput(['a', ' b ', 'a', '']), ['a', 'b'])
  assert.deepEqual(parseModelsInput('a, b,,c'), ['a', 'b', 'c'])
  assert.deepEqual(parseModelsInput(null), [])
  assert.deepEqual(parseModelsInput(undefined), [])
  assert.deepEqual(parseModelsInput(''), [])
})

// ---------- POST /verify-passphrase ----------

test('POST /verify-passphrase：口令正确 200，错误 401，缺配置 500', async () => {
  const ok = await worker.fetch(
    post('/verify-passphrase', {}, { 'X-Passphrase': 'secret-pass' }),
    makeEnv(),
  )
  assert.equal(ok.status, 200)

  const bad = await worker.fetch(
    post('/verify-passphrase', {}, { 'X-Passphrase': 'wrong' }),
    makeEnv(),
  )
  assert.equal(bad.status, 401)

  const noConfig = await worker.fetch(
    post('/verify-passphrase', {}, { 'X-Passphrase': 'secret-pass' }),
    makeEnv({ TRANSLATE_PASSPHRASE: undefined }),
  )
  assert.equal(noConfig.status, 500)
})

// ---------- GET /models ----------

test('GET /models：代理网关列表，响应不含任何秘密', async () => {
  const res = await withFetch(
    (url) => {
      assert.ok(url.startsWith('https://gateway.test/v1/models'))
      return jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] })
    },
    async () => {
      const res = await worker.fetch(get('/models'), makeEnv())
      assert.equal(res.status, 200)
      return res
    },
  )
  const data = await res.json()
  assert.deepEqual(data.models, ['model-a', 'model-b'])
  assert.ok(!JSON.stringify(data).includes('sk-test'), '响应绝不能含网关 key')
})

test('GET /models：网关不可达返回 502', async () => {
  await withFetch(
    () => {
      throw new Error('boom')
    },
    async () => {
      const res = await worker.fetch(get('/models'), makeEnv())
      assert.equal(res.status, 502)
    },
  )
})

// ---------- POST /translate ----------

const AUTH = { 'X-Passphrase': 'secret-pass' }

test('POST /translate：口令不符 401，缺 TRANSLATE_PASSPHRASE 500', async () => {
  const bad = await worker.fetch(post('/translate', {}, { 'X-Passphrase': 'wrong' }), makeEnv())
  assert.equal(bad.status, 401)

  const noConfig = await worker.fetch(
    post('/translate', {}, { 'X-Passphrase': 'secret-pass' }),
    makeEnv({ TRANSLATE_PASSPHRASE: undefined }),
  )
  assert.equal(noConfig.status, 500)
})

test('POST /translate：dispatch 成功后条目置「翻译中」，workflow_dispatch 参数正确', async () => {
  const env = makeEnv()
  await seedQueue(env, [
    { id: 'a', status: '待翻译' },
    { id: 'b', status: '待翻译' },
  ])

  const res = await withFetch(
    (url, opts) => {
      assert.ok(url === 'https://api.github.com/repos/owner/repo/actions/workflows/translate.yml/dispatches')
      const payload = JSON.parse(opts.body)
      assert.equal(payload.ref, 'main')
      assert.equal(payload.inputs.ids, 'a,b')
      return jsonResponse({}, 204)
    },
    async () => worker.fetch(post('/translate', {}, AUTH), env),
  )
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.deepEqual(data, { success: true, triggered: true, ids: ['a', 'b'], count: 2 })

  assert.equal(JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:a')).status, '翻译中')
  assert.equal(JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:b')).status, '翻译中')
})

test('POST /translate：默认不重试失败条目；retryFailed=true 才含失败；翻译中永不入选', async () => {
  const entries = [
    { id: 'p', status: '待翻译' },
    { id: 't', status: '翻译中' },
    { id: 'f', status: '失败' },
  ]

  // 默认：只有待翻译
  const env1 = makeEnv()
  await seedQueue(env1, entries)
  await withFetch(
    (url, opts) => {
      assert.equal(JSON.parse(opts.body).inputs.ids, 'p')
      return jsonResponse({}, 204)
    },
    async () => worker.fetch(post('/translate', {}, AUTH), env1),
  )
  assert.equal(JSON.parse(env1.TRANSLATION_QUEUE.store.get('queue:t')).status, '翻译中', '翻译中不得被改状态')
  assert.equal(JSON.parse(env1.TRANSLATION_QUEUE.store.get('queue:f')).status, '失败', '默认不重试失败')

  // retryFailed=true：待翻译 + 失败，仍不含翻译中
  const env2 = makeEnv()
  await seedQueue(env2, entries)
  await withFetch(
    (url, opts) => {
      assert.equal(JSON.parse(opts.body).inputs.ids, 'p,f')
      return jsonResponse({}, 204)
    },
    async () => worker.fetch(post('/translate', { retryFailed: true }, AUTH), env2),
  )
  assert.equal(JSON.parse(env2.TRANSLATION_QUEUE.store.get('queue:t')).status, '翻译中', '翻译中永不入选')
})

test('POST /translate：没有可触发条目时 { success, triggered: false }，不调 GitHub', async () => {
  const env = makeEnv()
  await seedQueue(env, [{ id: 't', status: '翻译中' }])

  const res = await withFetch(
    () => {
      throw new Error('不应触发 workflow')
    },
    async () => worker.fetch(post('/translate', {}, AUTH), env),
  )
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.triggered, false)
  assert.equal(data.success, true)
})

test('POST /translate：缺 GITHUB_PAT 返回 500，且不改条目状态', async () => {
  const env = makeEnv({ GITHUB_PAT: undefined })
  await seedQueue(env, [{ id: 'a', status: '待翻译' }])
  const res = await worker.fetch(post('/translate', {}, AUTH), env)
  assert.equal(res.status, 500)
  assert.equal(JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:a')).status, '待翻译')
})

test('POST /translate：models 必须命中网关白名单；非法模型 400 不透传', async () => {
  const env = makeEnv()
  await seedQueue(env, [{ id: 'a', status: '待翻译' }])

  await withFetch(
    (url) => {
      if (url.includes('gateway.test')) {
        return jsonResponse({ data: [{ id: 'model-a' }] })
      }
      throw new Error('白名单校验失败时不得触发 workflow')
    },
    async () => {
      const res = await worker.fetch(post('/translate', { models: ['model-a', 'evil-model'] }, AUTH), env)
      assert.equal(res.status, 400)
      const data = await res.json()
      assert.ok(data.error.includes('evil-model'))
      assert.equal(JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:a')).status, '待翻译')
    },
  )
})

test('POST /translate：网关不可达时宁可 400 拒绝', async () => {
  const env = makeEnv()
  await seedQueue(env, [{ id: 'a', status: '待翻译' }])
  await withFetch(
    () => {
      throw new Error('gateway down')
    },
    async () => {
      const res = await worker.fetch(post('/translate', { models: ['model-a'] }, AUTH), env)
      assert.equal(res.status, 400)
    },
  )
})

test('POST /translate：合法 models 透传进 workflow inputs.models', async () => {
  const env = makeEnv()
  await seedQueue(env, [{ id: 'a', status: '待翻译' }])
  await withFetch(
    (url, opts) => {
      if (url.includes('gateway.test')) {
        return jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] })
      }
      assert.equal(JSON.parse(opts.body).inputs.models, 'model-a,model-b')
      return jsonResponse({}, 204)
    },
    async () => {
      const res = await worker.fetch(post('/translate', { models: ['model-a', 'model-b'] }, AUTH), env)
      assert.equal(res.status, 200)
      assert.equal((await res.json()).triggered, true)
    },
  )
})

test('POST /translate：dispatch 失败返回 502，条目保持原状态', async () => {
  const env = makeEnv()
  await seedQueue(env, [{ id: 'a', status: '待翻译' }])
  await withFetch(
    () => jsonResponse({ message: 'nope' }, 403),
    async () => {
      const res = await worker.fetch(post('/translate', {}, AUTH), env)
      assert.equal(res.status, 502)
      assert.equal(JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:a')).status, '待翻译')
    },
  )
})
