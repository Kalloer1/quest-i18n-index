#!/usr/bin/env node
/**
 * GitHub 直链开关（决策 #8）的离线单测：
 * - shared/download-settings.mjs：normalizeDownloadSettings 的 fail-open 语义
 * - worker：GET /settings（公开、默认 true）、GET/POST /admin/download-settings（口令鉴权）
 * - 站点契约：template.html 里存在「运行时 fetch /settings + fail-open + 移除 #dl-zip」逻辑，
 *   request.html 管理区存在开关面板（静态站渲染逻辑以内联 JS 交付，契约断言防手滑删掉）
 *
 * 用内存 KV 假实现，不发任何真实网络请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import worker from '../worker/index.js'
import {
  DOWNLOAD_SETTINGS_KEY,
  DEFAULT_DOWNLOAD_SETTINGS,
  normalizeDownloadSettings,
} from '../shared/download-settings.mjs'

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
    ...extra,
  }
}

function get(url, headers = {}) {
  return new Request(url, { method: 'GET', headers: { Origin: ALLOWED_ORIGIN, ...headers } })
}

function post(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN, ...headers },
    body: JSON.stringify(body),
  })
}

// ---------- normalizeDownloadSettings（fail-open） ----------

test('normalize：null / 非对象 / 数组 → 默认 true', () => {
  assert.deepEqual(normalizeDownloadSettings(null), { githubDownloads: true })
  assert.deepEqual(normalizeDownloadSettings('garbage'), { githubDownloads: true })
  assert.deepEqual(normalizeDownloadSettings([1]), { githubDownloads: true })
})

test('normalize：字段缺失或非布尔 → 默认 true；布尔原样保留', () => {
  assert.deepEqual(normalizeDownloadSettings({}), { githubDownloads: true })
  assert.deepEqual(normalizeDownloadSettings({ githubDownloads: 'false' }), { githubDownloads: true })
  assert.deepEqual(normalizeDownloadSettings({ githubDownloads: false }), { githubDownloads: false })
  assert.deepEqual(normalizeDownloadSettings({ githubDownloads: true }), { githubDownloads: true })
})

test('默认值常量：githubDownloads 必须是 true（决策 #8：全局开关默认开）', () => {
  assert.deepEqual(DEFAULT_DOWNLOAD_SETTINGS, { githubDownloads: true })
})

// ---------- Worker：GET /settings（公开） ----------

test('GET /settings：KV 为空 → 默认 { githubDownloads: true }，无需鉴权', async () => {
  const res = await worker.fetch(get('https://api.test/settings'), makeEnv())
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.deepEqual(data, { githubDownloads: true })
})

test('GET /settings：KV 存了 false → 返回 false（关闭立即生效）', async () => {
  const env = makeEnv()
  await env.TRANSLATION_QUEUE.put(DOWNLOAD_SETTINGS_KEY, JSON.stringify({ githubDownloads: false }))
  const res = await worker.fetch(get('https://api.test/settings'), env)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { githubDownloads: false })
})

test('GET /settings：KV 值损坏 → fail-open 返回 true', async () => {
  const env = makeEnv()
  await env.TRANSLATION_QUEUE.put(DOWNLOAD_SETTINGS_KEY, JSON.stringify({ oops: 1 }))
  const res = await worker.fetch(get('https://api.test/settings'), env)
  assert.deepEqual(await res.json(), { githubDownloads: true })
})

// ---------- Worker：/admin/download-settings（口令） ----------

test('POST /admin/download-settings：错口令 → 401，KV 不写', async () => {
  const env = makeEnv()
  const res = await worker.fetch(
    post('https://api.test/admin/download-settings', { githubDownloads: false }, { 'X-Passphrase': 'wrong' }),
    env,
  )
  assert.equal(res.status, 401)
  assert.equal(env.TRANSLATION_QUEUE.store.has(DOWNLOAD_SETTINGS_KEY), false)
})

test('POST /admin/download-settings：正口令写入 false → GET /settings 变 false', async () => {
  const env = makeEnv()
  const res = await worker.fetch(
    post('https://api.test/admin/download-settings', { githubDownloads: false }, { 'X-Passphrase': 'secret-pass' }),
    env,
  )
  assert.equal(res.status, 200)
  assert.deepEqual((await res.json()).settings, { githubDownloads: false })

  const pub = await worker.fetch(get('https://api.test/settings'), env)
  assert.deepEqual(await pub.json(), { githubDownloads: false })
})

test('POST /admin/download-settings：缺 githubDownloads 字段 → 400', async () => {
  const env = makeEnv()
  const res = await worker.fetch(
    post('https://api.test/admin/download-settings', { other: true }, { 'X-Passphrase': 'secret-pass' }),
    env,
  )
  assert.equal(res.status, 400)
})

test('GET /admin/download-settings：口令通过返回当前值与默认值', async () => {
  const env = makeEnv()
  const res = await worker.fetch(
    get('https://api.test/admin/download-settings', { 'X-Passphrase': 'secret-pass' }),
    env,
  )
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.success, true)
  assert.deepEqual(data.settings, { githubDownloads: true })
  assert.deepEqual(data.defaults, { githubDownloads: true })
})

// ---------- 站点契约（静态内联 JS，防手滑删逻辑） ----------

test('template.html：有 WORKER_URL 常量 + fetch /settings + fail-open + 移除 #dl-zip', () => {
  const t = readFileSync(new URL('../site/template.html', import.meta.url), 'utf8')
  assert.match(t, /var WORKER_URL = "https:\/\/quest-i18n-api\.wqclo\.workers\.dev"/, '缺少 WORKER_URL 常量')
  assert.match(t, /fetchSettings/, '缺少 fetchSettings 函数')
  assert.match(t, /WORKER_URL \+ "\/settings"/, '缺少 /settings 请求')
  assert.match(t, /githubDownloads !== false/, 'fail-open 语义缺失（必须明确 false 才隐藏）')
  assert.match(t, /#dl-zip/, '缺少 #dl-zip 移除逻辑')
  // renderDetail 必须接线（innerHTML 赋值后调用 applyGithubSwitch）
  assert.match(t, /applyGithubSwitch\(\$\("#view-detail"\)\)/, 'renderDetail 未接开关')
})

test('request.html：管理区有下载开关面板与读写调用', () => {
  const t = readFileSync(new URL('../site/request.html', import.meta.url), 'utf8')
  assert.match(t, /id="dl-github-enabled"/, '缺少开关复选框')
  assert.match(t, /id="dl-save"/, '缺少保存按钮')
  assert.match(t, /loadDownloadSettings\(\)/, '解锁后未加载下载开关')
  assert.match(t, /\/admin\/download-settings/, '缺少管理端点调用')
})
