#!/usr/bin/env node
/**
 * requests.mjs 纯函数单测：URL→slug 抽取、版本比较（决策 #5）、7 天冷却、
 * 历史状态映射、jsonl 记录、identity 映射。全部假数据，不碰网络与 LLM。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractTarget, normalizeFileId, mrVersionKey, isSameVersion, cooldownAllowed,
  mapLegacyStatus, buildRecord, identityMapFrom,
} from './requests.mjs'
import { STATUS } from '../shared/quest-status.mjs'

// ---------- URL → platform + slug ----------

test('extractTarget：CF / MR 链接抽 slug 并规范化小写', () => {
  assert.deepEqual(
    extractTarget('https://www.curseforge.com/minecraft/modpacks/Craftoria'),
    { platform: 'cf', slug: 'craftoria' },
  )
  assert.deepEqual(
    extractTarget('https://modrinth.com/modpack/Better-MC-Forge-BMC4'),
    { platform: 'mr', slug: 'better-mc-forge-bmc4' },
  )
})

test('extractTarget：非整合包路径 / 垃圾输入 → null', () => {
  assert.equal(extractTarget('https://www.curseforge.com/minecraft/mods/jei'), null)
  assert.equal(extractTarget('https://example.com/modpack/x'), null)
  assert.equal(extractTarget('不是链接'), null)
  assert.equal(extractTarget(undefined), null)
})

// ---------- 版本比较（决策 #5：解析不出一律重翻） ----------

test('normalizeFileId：数字/字符串归一，垃圾 → null', () => {
  assert.equal(normalizeFileId(5155575), 5155575)
  assert.equal(normalizeFileId('5155575'), 5155575)
  assert.equal(normalizeFileId(null), null)
  assert.equal(normalizeFileId(0), null)
  assert.equal(normalizeFileId('abc'), null)
})

test('mrVersionKey：fileName 去扩展名做键，空/非串 → null', () => {
  assert.equal(mrVersionKey('Above the Known Sky 1.1.0.mrpack'), 'above the known sky 1.1.0')
  assert.equal(mrVersionKey('adventures+ 2.4 1.20.1.mrpack'), 'adventures+ 2.4 1.20.1')
  assert.equal(mrVersionKey(''), null)
  assert.equal(mrVersionKey(null), null)
  assert.equal(mrVersionKey(42), null)
})

test('isSameVersion：CF fileId 相同 → 一致；不同/缺失 → 重翻', () => {
  assert.equal(isSameVersion('cf', { fileId: 5155575 }, { fileId: 5155575 }), true)
  assert.equal(isSameVersion('cf', { fileId: 5155575 }, { fileId: 9999999 }), false)
  assert.equal(isSameVersion('cf', { fileId: 5155575 }, {}), false, '拿不到最新 fileId → 一律重翻')
  assert.equal(isSameVersion('cf', {}, { fileId: 1 }), false)
})

test('isSameVersion：MR fileName 版本串相同 → 一致；不同/解析不出 → 重翻', () => {
  assert.equal(
    isSameVersion('mr', { fileName: 'Above the Known Sky 1.1.0.mrpack' }, { fileName: 'Above the Known Sky 1.1.0.mrpack' }),
    true,
  )
  assert.equal(
    isSameVersion('mr', { fileName: 'Above the Known Sky 1.1.0.mrpack' }, { fileName: 'Above the Known Sky 1.2.0.mrpack' }),
    false,
  )
  assert.equal(isSameVersion('mr', { fileName: null }, { fileName: 'x.mrpack' }), false, '库内解析不出 → 重翻')
  assert.equal(isSameVersion('mr', { fileName: 'x.mrpack' }, {}), false, '最新名拿不到 → 重翻')
})

test('isSameVersion：未知平台 → false（保守重翻）', () => {
  assert.equal(isSameVersion('zz', { fileId: 1 }, { fileId: 1 }), false)
})

// ---------- 7 天冷却 ----------

test('cooldownAllowed：7 天内拒绝，过期/缺失/非法放行', () => {
  const now = new Date('2026-10-24T00:00:00Z')
  assert.equal(cooldownAllowed('2026-10-20T00:00:00Z', now), false, '4 天前重翻过 → 冷却')
  assert.equal(cooldownAllowed('2026-10-16T23:59:59Z', now), true, '刚过 7 天 → 放行')
  assert.equal(cooldownAllowed('2026-10-17T00:00:00Z', now), true, '整 7 天 → 放行')
  assert.equal(cooldownAllowed(undefined, now), true, '从没翻过 → 放行')
  assert.equal(cooldownAllowed('垃圾', now), true, '解析不出 → 放行（不因脏数据卡死队列）')
})

// ---------- 历史状态映射 ----------

test('mapLegacyStatus：英文旧状态 → 现行中文；未知原样', () => {
  assert.equal(mapLegacyStatus('done'), '已完成')
  assert.equal(mapLegacyStatus('failed'), '失败')
  assert.equal(mapLegacyStatus('queued'), '待翻译')
  assert.equal(mapLegacyStatus('已完成'), '已完成', '已是中文的原样通过')
  assert.equal(mapLegacyStatus('weird'), 'weird')
})

// ---------- jsonl 记录 ----------

test('buildRecord：字段齐全且缺省安全', () => {
  const r = buildRecord({
    entry: { id: 'craftoria', url: 'https://x', submittedAt: '2026-10-01T00:00:00Z' },
    platform: 'cf', slug: 'craftoria', groupId: 'craftoria',
    versionAtSubmit: null, status: STATUS.DONE, processedAt: '2026-10-24T00:00:00Z',
    note: 'ok',
  })
  assert.deepEqual(
    Object.keys(r).sort(),
    ['groupId', 'id', 'note', 'platform', 'processedAt', 'requestedAt', 'slug', 'status', 'url', 'versionAtSubmit'].sort(),
  )
  assert.equal(r.requestedAt, '2026-10-01T00:00:00Z')
  assert.equal(buildRecord({}).note, '')
})

// ---------- identity 映射 ----------

test('identityMapFrom：组内成员都指到主 slug；容错空文档', () => {
  const doc = {
    groups: [
      { id: 'craftoria', title: 'Craftoria', members: [{ platform: 'cf', slug: 'craftoria' }, { platform: 'mr', slug: 'craftoria' }] },
    ],
  }
  assert.deepEqual(identityMapFrom(doc), { craftoria: 'craftoria' })
  assert.deepEqual(identityMapFrom(null), {})
  assert.deepEqual(identityMapFrom({}), {})
})
