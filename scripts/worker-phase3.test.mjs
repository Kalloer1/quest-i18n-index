#!/usr/bin/env node
/**
 * worker/index.js Phase 3 增量的离线单测：
 * - POST /status 接受英文 kind（skipped-same-version →「已在库」）
 * - POST / 响应带 groupId / currentVersion / inLibrary；IP+groupId 24h 去重（429）
 * - POST /admin/clear-records：ids / all、口令鉴权、索引与条目一致删除
 * - GET/POST /admin/llm-settings：存取、Key 打码、打码串不覆盖真 Key
 * - maskKey / submitDedupKey 纯函数
 *
 * 用内存 KV 假实现，不发任何真实网络请求（LOOKUP 是随仓库提交的静态快照）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { maskKey } from '../worker/index.js'
import { submitDedupKey, SUBMIT_DEDUP_TTL_SECONDS } from '../shared/submit-limit.mjs'
import { LOOKUP } from '../worker/library-lookup.mjs'

const CF_URL = 'https://www.curseforge.com/minecraft/modpacks/craftoria'
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
    TRANSLATE_PASSPHRASE: 'secret-pass',
    ...extra,
  }
}

function post(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN, ...headers },
    body: JSON.stringify(body),
  })
}

function get(url, headers = {}) {
  return new Request(url, { method: 'GET', headers: { Origin: ALLOWED_ORIGIN, ...headers } })
}

/** 在索引与 KV 里预置一条队列记录。 */
async function seedEntry(env, id, extra = {}) {
  await env.TRANSLATION_QUEUE.put('queue:' + id, JSON.stringify({
    id, name: id, url: `https://www.curseforge.com/minecraft/modpacks/${id}`,
    platform: 'curseforge', source: '玩家请求', status: '待翻译',
    submittedAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z',
    attempts: 0, error: '', note: '', ...extra,
  }))
  await env.TRANSLATION_QUEUE.put('queue:index', JSON.stringify([id]))
}

// ---------- POST /status：英文 kind ----------

test('POST /status：skipped-same-version 映射为「已在库」', async () => {
  const env = makeEnv()
  await seedEntry(env, 'craftoria', { status: '翻译中' })
  const res = await worker.fetch(
    post('https://api.test/status', { id: 'craftoria', status: 'skipped-same-version', note: '同版本' },
      { 'X-Internal-Token': 'test-salt' }),
    env,
  )
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.status, '已在库')
  const entry = JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:craftoria'))
  assert.equal(entry.status, '已在库')
  assert.equal(entry.note, '同版本')
})

test('POST /status：非法状态仍然 400', async () => {
  const env = makeEnv()
  await seedEntry(env, 'craftoria')
  const res = await worker.fetch(
    post('https://api.test/status', { id: 'craftoria', status: 'nonsense' }, { 'X-Internal-Token': 'test-salt' }),
    env,
  )
  assert.equal(res.status, 400)
})

// ---------- POST /：groupId / 当前版本 / 24h 去重 ----------

test('POST /：响应带 groupId、currentVersion、inLibrary（LOOKUP 快照）', async () => {
  const env = makeEnv()
  const res = await worker.fetch(post('https://api.test/', { url: CF_URL }), env)
  assert.equal(res.status, 200)
  const data = await res.json()
  const expectedVersion = LOOKUP.versionBySlug.craftoria ?? null
  assert.equal(data.groupId, LOOKUP.groupBySlug.craftoria ?? 'craftoria')
  assert.equal(data.currentVersion, expectedVersion)
  assert.equal(data.inLibrary, expectedVersion !== null)
})

test('POST /：同 IP + 同 groupId 24 小时内第二次新提交被拒（429）', async () => {
  const env = makeEnv()
  // 现网数据里归并组的成员 slug 都相同，429 的真实触发路径是：
  // 提交过（或被管理员清除记录）之后 24h 内同 IP 再提交同一实体（新提交）。
  // 直接预置去重键（与 Worker 同款：sha256(INTERNAL_STATUS_TOKEN|ip)）。
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256').update('test-salt|203.0.113.7').digest('hex')
  const groupId = LOOKUP.groupBySlug.craftoria ?? 'craftoria'
  await env.TRANSLATION_QUEUE.put(submitDedupKey(hash, groupId), '1')

  const res = await worker.fetch(
    post('https://api.test/', { url: CF_URL }, { 'CF-Connecting-IP': '203.0.113.7' }),
    env,
  )
  assert.equal(res.status, 429)
  const data = await res.json()
  assert.ok(data.error.includes('24 小时'))
  assert.equal(data.groupId, groupId)
})

test('POST /：首次成功提交写入去重键；不同 IP 不受影响', async () => {
  const env = makeEnv()
  const r1 = await worker.fetch(post('https://api.test/', { url: CF_URL }, { 'CF-Connecting-IP': '203.0.113.7' }), env)
  assert.equal(r1.status, 200)
  const dedupKeys = [...env.TRANSLATION_QUEUE.store.keys()].filter((k) => k.startsWith('submit:dedup:'))
  assert.equal(dedupKeys.length, 1, '首次成功提交后应写入去重键')
  assert.ok(dedupKeys[0].includes('craftoria'))

  const r2 = await worker.fetch(post('https://api.test/', { url: CF_URL }, { 'CF-Connecting-IP': '203.0.113.8' }), env)
  assert.equal(r2.status, 200, '不同 IP 不受第一个 IP 的去重键影响（同 id 走「已在队列」路径）')
})

test('POST /：已入队 id 的重复提交不触发去重键，走「已在队列」路径', async () => {
  const env = makeEnv()
  // 预先用另一 IP 入队（产生去重键），再模拟同 IP 重复提交已存在的 id
  await worker.fetch(post('https://api.test/', { url: CF_URL }, { 'CF-Connecting-IP': '203.0.113.7' }), env)
  const res = await worker.fetch(post('https://api.test/', { url: CF_URL }, { 'CF-Connecting-IP': '203.0.113.9' }), env)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok(data.message.includes('已在翻译队列'))
})

// ---------- /admin/clear-records ----------

test('/admin/clear-records：按 ids 删除条目并更新索引', async () => {
  const env = makeEnv()
  await seedEntry(env, 'a')
  await env.TRANSLATION_QUEUE.put('queue:b', JSON.stringify({ id: 'b' }))
  await env.TRANSLATION_QUEUE.put('queue:index', JSON.stringify(['a', 'b']))

  const res = await worker.fetch(
    post('https://api.test/admin/clear-records', { ids: ['a', '不存在'] }, { 'X-Passphrase': 'secret-pass' }),
    env,
  )
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.deepEqual(data.removed, ['a'])
  assert.equal(env.TRANSLATION_QUEUE.store.get('queue:a'), undefined)
  assert.ok(env.TRANSLATION_QUEUE.store.get('queue:b'), '未选中的 b 保留')
  assert.deepEqual(JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:index')), ['b'])
})

test('/admin/clear-records：all:true 清空全部', async () => {
  const env = makeEnv()
  await seedEntry(env, 'a')
  await env.TRANSLATION_QUEUE.put('queue:b', JSON.stringify({ id: 'b' }))
  await env.TRANSLATION_QUEUE.put('queue:index', JSON.stringify(['a', 'b']))

  const res = await worker.fetch(
    post('https://api.test/admin/clear-records', { all: true }, { 'X-Passphrase': 'secret-pass' }),
    env,
  )
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.count, 2)
  assert.deepEqual(JSON.parse(env.TRANSLATION_QUEUE.store.get('queue:index')), [])
  assert.equal(env.TRANSLATION_QUEUE.store.get('queue:a'), undefined)
  assert.equal(env.TRANSLATION_QUEUE.store.get('queue:b'), undefined)
})

test('/admin/clear-records：口令错 → 401；body 缺 ids/all → 400', async () => {
  const env = makeEnv()
  const bad = await worker.fetch(
    post('https://api.test/admin/clear-records', { ids: ['a'] }, { 'X-Passphrase': 'wrong' }),
    env,
  )
  assert.equal(bad.status, 401)
  const noBody = await worker.fetch(
    post('https://api.test/admin/clear-records', {}, { 'X-Passphrase': 'secret-pass' }),
    env,
  )
  assert.equal(noBody.status, 400)
})

// ---------- /admin/llm-settings ----------

test('/admin/llm-settings：POST 存 KV，GET 只回打码 Key', async () => {
  const env = makeEnv()
  const saved = await worker.fetch(
    post('https://api.test/admin/llm-settings',
      { baseUrl: 'https://gw.example/v1', key: 'sk-abcdef123456', model: 'gemini-x' },
      { 'X-Passphrase': 'secret-pass' }),
    env,
  )
  assert.equal(saved.status, 200)
  const savedData = await saved.json()
  assert.equal(savedData.settings.keyMasked, '••••3456')
  assert.equal(savedData.settings.baseUrl, 'https://gw.example/v1')

  const got = await worker.fetch(
    get('https://api.test/admin/llm-settings', { 'X-Passphrase': 'secret-pass' }),
    env,
  )
  assert.equal(got.status, 200)
  const gotData = await got.json()
  assert.equal(gotData.settings.keyMasked, '••••3456')
  assert.ok(!JSON.stringify(gotData).includes('sk-abcdef123456'), 'GET 响应绝不含明文 Key')
  const stored = JSON.parse(env.TRANSLATION_QUEUE.store.get('llm-settings'))
  assert.equal(stored.key, 'sk-abcdef123456', 'KV 里存的是明文（翻译侧要取用），页面只看打码值')
})

test('/admin/llm-settings：Key 留空沿用旧值；提交打码串不覆盖真 Key', async () => {
  const env = makeEnv()
  await worker.fetch(
    post('https://api.test/admin/llm-settings',
      { key: 'sk-real-key-9999' }, { 'X-Passphrase': 'secret-pass' }),
    env,
  )
  const r = await worker.fetch(
    post('https://api.test/admin/llm-settings',
      { key: '••••9999', model: 'new-model' }, { 'X-Passphrase': 'secret-pass' }),
    env,
  )
  assert.equal(r.status, 200)
  const stored = JSON.parse(env.TRANSLATION_QUEUE.store.get('llm-settings'))
  assert.equal(stored.key, 'sk-real-key-9999')
  assert.equal(stored.model, 'new-model')
})

test('/admin/llm-settings：空 body → 400；口令错 → 401', async () => {
  const env = makeEnv()
  const empty = await worker.fetch(
    post('https://api.test/admin/llm-settings', {}, { 'X-Passphrase': 'secret-pass' }),
    env,
  )
  assert.equal(empty.status, 400)
  const bad = await worker.fetch(
    get('https://api.test/admin/llm-settings', { 'X-Passphrase': 'nope' }),
    env,
  )
  assert.equal(bad.status, 401)
})

// ---------- 纯函数 ----------

test('maskKey：打码只留后 4 位；空值 → 空串', () => {
  assert.equal(maskKey('sk-abcdef123456'), '••••3456')
  assert.equal(maskKey('abc'), '••••abc')
  assert.equal(maskKey(''), '')
  assert.equal(maskKey(null), '')
  assert.equal(maskKey(undefined), '')
})

test('submitDedupKey：键形与 TTL 常量', () => {
  assert.equal(submitDedupKey('h1', 'craftoria'), 'submit:dedup:h1:craftoria')
  assert.throws(() => submitDedupKey('', 'x'))
  assert.throws(() => submitDedupKey('h', ''))
  assert.equal(SUBMIT_DEDUP_TTL_SECONDS, 86400)
})
