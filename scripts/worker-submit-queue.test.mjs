/**
 * worker/index.js 的离线单元测试。
 *
 * 覆盖提交入口与队列的全部可测行为（在 HTTP handler 这个 seam 上观察）：
 * - POST /：合法整合包链接入队；非法链接当场 400；Modrinth 走 API 校验；
 *           CurseForge 不调 CF API；重复提交只更新 updatedAt；每 IP 每天限流
 * - GET /queue：返回全量条目，不泄露 contact 明文
 * - POST /status：需 X-Internal-Token，只接受状态枚举内的值
 * - CORS：白名单放行，非白名单预检被拒
 * - selectTranslateTargets：纯函数选取规则
 *
 * 用内存 KV 假实现 + 打桩 globalThis.fetch，不发任何真实网络请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { selectTranslateTargets } from '../worker/index.js'

const CF_URL = 'https://www.curseforge.com/minecraft/modpacks/craftoria'
const MR_URL = 'https://modrinth.com/modpack/craftoria'
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
    SUBMIT_LIMIT_PER_DAY: '3',
    ...extra,
  }
}

function post(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** 打桩 globalThis.fetch，记录调用；返回给定响应。测试结束务必还原。 */
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ---------- selectTranslateTargets ----------

test('selectTranslateTargets：默认只取「待翻译」', () => {
  const entries = [
    { id: 'a', status: '待翻译' },
    { id: 'b', status: '翻译中' },
    { id: 'c', status: '失败' },
    { id: 'd', status: '已完成' },
  ]
  assert.deepEqual(selectTranslateTargets(entries).map((e) => e.id), ['a'])
})

test('selectTranslateTargets：retryFailed=true 时额外取「失败」，「翻译中」永不入选', () => {
  const entries = [
    { id: 'a', status: '待翻译' },
    { id: 'b', status: '翻译中' },
    { id: 'c', status: '失败' },
  ]
  assert.deepEqual(selectTranslateTargets(entries, { retryFailed: true }).map((e) => e.id), ['a', 'c'])
  assert.deepEqual(selectTranslateTargets(entries, { retryFailed: false }).map((e) => e.id), ['a'])
})

// ---------- POST / ----------

test('POST /：合法 CurseForge 链接入队，返回 { success, id, status }', async () => {
  const env = makeEnv()
  await withFetch(
    () => {
      throw new Error('CurseForge 提交不得调用任何外部 API')
    },
    async (calls) => {
      const res = await worker.fetch(post('https://api.test/', { url: CF_URL }), env)
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(data.success, true)
      assert.equal(data.id, 'craftoria')
      assert.equal(data.status, '待翻译')
      assert.equal(calls.length, 0, 'CurseForge 提交不应触发 fetch')
    },
  )
  const entry = JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:craftoria'))
  assert.equal(entry.platform, 'curseforge')
  assert.equal(entry.status, '待翻译')
  assert.deepEqual(JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:index')), ['craftoria'])
})

test('POST /：合法 Modrinth 链接调 API 校验后入队', async () => {
  const env = makeEnv()
  await withFetch(
    () =>
      jsonResponse({ slug: 'craftoria', id: 'abc123', title: 'Craftoria', project_type: 'modpack' }),
    async (calls) => {
      const res = await worker.fetch(post('https://api.test/', { url: MR_URL }), env)
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(data.success, true)
      assert.equal(data.id, 'craftoria')
      assert.equal(calls.length, 1)
      assert.match(calls[0].url, /api\.modrinth\.com\/v2\/project\/craftoria/)
    },
  )
  const entry = JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:craftoria'))
  assert.equal(entry.platform, 'modrinth')
  assert.equal(entry.projectId, 'abc123')
  assert.equal(entry.name, 'Craftoria')
})

test('POST /：非法链接当场 400，不入队', async () => {
  const env = makeEnv()
  const res = await worker.fetch(post('https://api.test/', { url: 'https://example.com/foo' }), env)
  assert.equal(res.status, 400)
  const data = await res.json()
  assert.equal(data.success, undefined)
  assert.equal(env.TRANSLATION_QUEUE.store.has('queue:index'), false)
})

test('POST /：Modrinth 项目不存在 → 400，不入队', async () => {
  const env = makeEnv()
  await withFetch(
    () => new Response('not found', { status: 404 }),
    async () => {
      const res = await worker.fetch(post('https://api.test/', { url: MR_URL }), env)
      assert.equal(res.status, 400)
      assert.equal(env.TRANSLATION_QUEUE.store.has('queue:index'), false)
    },
  )
})

test('POST /：Modrinth 项目类型不是 modpack → 400', async () => {
  const env = makeEnv()
  await withFetch(
    () => jsonResponse({ slug: 'bsl-shaders', id: 'x', title: 'BSL', project_type: 'shader' }),
    async () => {
      const res = await worker.fetch(post('https://api.test/', { url: MR_URL }), env)
      assert.equal(res.status, 400)
      const data = await res.json()
      assert.match(data.error, /modpack|整合包/)
    },
  )
})

test('POST /：缺少 url → 400', async () => {
  const env = makeEnv()
  const res = await worker.fetch(post('https://api.test/', {}), env)
  assert.equal(res.status, 400)
})

test('POST /：重复提交只更新 updatedAt，queue:index 不重复', async () => {
  const env = makeEnv()
  // 预置一条旧条目，模拟此前已提交
  await env.TRANSLATION_QUEUE.put(
    'queue:craftoria',
    JSON.stringify({
      id: 'craftoria',
      name: 'craftoria',
      url: CF_URL,
      platform: 'curseforge',
      source: '玩家请求',
      status: '待翻译',
      submittedAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      attempts: 0,
      error: '',
      contact: '',
      note: '',
    }),
  )
  await env.TRANSLATION_QUEUE.put('queue:index', JSON.stringify(['craftoria']))

  const res = await worker.fetch(post('https://api.test/', { url: CF_URL }), env)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.id, 'craftoria')

  const index = JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:index'))
  assert.deepEqual(index, ['craftoria'], 'queue:index 不得重复登记')
  const entry = JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:craftoria'))
  assert.equal(entry.submittedAt, '2020-01-01T00:00:00.000Z', 'submittedAt 不得被覆盖')
  assert.notEqual(entry.updatedAt, '2020-01-01T00:00:00.000Z', 'updatedAt 必须刷新')
})

test('POST /：每 IP 每天新增提交限流（默认 3），第 4 条 429', async () => {
  const env = makeEnv()
  const slugs = ['pack-a', 'pack-b', 'pack-c', 'pack-d']
  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(
      post(
        'https://api.test/',
        { url: `https://www.curseforge.com/minecraft/modpacks/${slugs[i]}` },
        { 'CF-Connecting-IP': '9.9.9.9' },
      ),
      env,
    )
    assert.equal(res.status, 200, `第 ${i + 1} 条应放行`)
  }
  const blocked = await worker.fetch(
    post(
      'https://api.test/',
      { url: `https://www.curseforge.com/minecraft/modpacks/${slugs[3]}` },
      { 'CF-Connecting-IP': '9.9.9.9' },
    ),
    env,
  )
  assert.equal(blocked.status, 429)
  const index = JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:index'))
  // queue:index 最新在前（unshift），被限流的 pack-d 未入队
  assert.deepEqual(index, ['pack-c', 'pack-b', 'pack-a'])
})

test('POST /：限流只存 IP 哈希，绝不存原始 IP', async () => {
  const env = makeEnv()
  await worker.fetch(
    post(
      'https://api.test/',
      { url: 'https://www.curseforge.com/minecraft/modpacks/pack-a' },
      { 'CF-Connecting-IP': '9.9.9.9' },
    ),
    env,
  )
  const limitKeys = [...env.TRANSLATION_QUEUE.store.keys()].filter((k) => k.startsWith('submit:limit:'))
  assert.equal(limitKeys.length, 1)
  assert.ok(!limitKeys[0].includes('9.9.9.9'), '限流键不得含原始 IP')
})

// ---------- GET /queue ----------

test('GET /queue：返回全量条目，不泄露 contact 明文', async () => {
  const env = makeEnv()
  await worker.fetch(post('https://api.test/', { url: CF_URL, contact: 'me@example.com', note: 'hi' }), env)
  const res = await worker.fetch(new Request('https://api.test/queue'), env)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.success, true)
  assert.equal(data.count, 1)
  assert.equal(data.entries.length, 1)
  assert.equal(data.entries[0].id, 'craftoria')
  assert.equal('contact' in data.entries[0], false, '公开端点不得回传 contact')
  assert.equal(data.entries[0].status, '待翻译')
})

// ---------- POST /status ----------

test('POST /status：缺少或错误的 X-Internal-Token → 401', async () => {
  const env = makeEnv()
  const noToken = await worker.fetch(post('https://api.test/status', { id: 'craftoria', status: '翻译中' }), env)
  assert.equal(noToken.status, 401)
  const badToken = await worker.fetch(
    post('https://api.test/status', { id: 'craftoria', status: '翻译中' }, { 'X-Internal-Token': 'nope' }),
    env,
  )
  assert.equal(badToken.status, 401)
})

test('POST /status：状态不在枚举内 → 400', async () => {
  const env = makeEnv()
  await worker.fetch(post('https://api.test/', { url: CF_URL }), env)
  const res = await worker.fetch(
    post('https://api.test/status', { id: 'craftoria', status: '随便写的' }, { 'X-Internal-Token': 'test-salt' }),
    env,
  )
  assert.equal(res.status, 400)
})

test('POST /status：合法状态写回 KV', async () => {
  const env = makeEnv()
  await worker.fetch(post('https://api.test/', { url: CF_URL }), env)
  const res = await worker.fetch(
    post(
      'https://api.test/status',
      { id: 'craftoria', status: '已完成', error: '' },
      { 'X-Internal-Token': 'test-salt' },
    ),
    env,
  )
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.success, true)
  assert.equal(data.status, '已完成')
  const entry = JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:craftoria'))
  assert.equal(entry.status, '已完成')
})

test('POST /status：可选 name 回写（CurseForge 项目名由流水线补全）', async () => {
  const env = makeEnv()
  await worker.fetch(post('https://api.test/', { url: CF_URL }), env)
  // 提交时 name 暂用 slug
  assert.equal(JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:craftoria')).name, 'craftoria')
  const res = await worker.fetch(
    post(
      'https://api.test/status',
      { id: 'craftoria', status: '已完成', name: 'Craftoria 2' },
      { 'X-Internal-Token': 'test-salt' },
    ),
    env,
  )
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:craftoria')).name, 'Craftoria 2')
})

test('POST /status：不传 name 时保留原值', async () => {
  const env = makeEnv()
  await worker.fetch(post('https://api.test/', { url: CF_URL }), env)
  await worker.fetch(
    post('https://api.test/status', { id: 'craftoria', status: '翻译中' }, { 'X-Internal-Token': 'test-salt' }),
    env,
  )
  assert.equal(JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:craftoria')).name, 'craftoria')
})

test('POST /status：队列中不存在该 id → 404', async () => {
  const env = makeEnv()
  const res = await worker.fetch(
    post('https://api.test/status', { id: 'nope', status: '已完成' }, { 'X-Internal-Token': 'test-salt' }),
    env,
  )
  assert.equal(res.status, 404)
})

// ---------- CORS ----------

test('CORS：白名单 origin 的预检放行，回显该 origin', async () => {
  const env = makeEnv()
  const res = await worker.fetch(
    new Request('https://api.test/', { method: 'OPTIONS', headers: { Origin: ALLOWED_ORIGIN } }),
    env,
  )
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN)
})

test('CORS：Pages 预览域正则放行', async () => {
  const env = makeEnv()
  const res = await worker.fetch(
    new Request('https://api.test/', {
      method: 'OPTIONS',
      headers: { Origin: 'https://abc123.quest-i18n-index.pages.dev' },
    }),
    env,
  )
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://abc123.quest-i18n-index.pages.dev')
})

test('CORS：非白名单 origin 的预检被拒（403）', async () => {
  const env = makeEnv()
  const res = await worker.fetch(
    new Request('https://api.test/', { method: 'OPTIONS', headers: { Origin: 'https://evil.example.com' } }),
    env,
  )
  assert.equal(res.status, 403)
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null)
})

test('CORS：非白名单 origin 的实际请求也被拒（403）', async () => {
  const env = makeEnv()
  const res = await worker.fetch(
    post('https://api.test/', { url: CF_URL }, { Origin: 'https://evil.example.com' }),
    env,
  )
  assert.equal(res.status, 403)
})
