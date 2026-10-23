#!/usr/bin/env node
/**
 * `scripts/source-versions.mjs` 单测：汇总逻辑、缺文件、坏 JSON、点文件被忽略。
 *
 * 这个汇总物是**生成物**，站点靠它显示「基于哪个上游文件」。测试要守住
 * 「一个包的点文件坏了不能拖垮整份汇总」，否则 CI 的站点重建会整体失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SOURCE_FILE, normalizeSourceInfo, collectSourceVersions, buildSourceVersions,
} from './source-versions.mjs'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'quest-source-versions-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeSource(root, slug, value, { raw } = {}) {
  const dir = join(root, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SOURCE_FILE), raw ?? JSON.stringify(value))
}

const SAMPLE = {
  slug: 'dawn-craft',
  platform: 'cf',
  fileId: 1234567,
  fileName: 'DawnCraft - 2.0.16_hf.zip',
  fileDate: '2026-09-01T00:00:00Z',
  fetchedAt: '2026-10-23T01:20:00Z',
  recovered: false,
}

test('collectSourceVersions：汇总各补丁目录下的 .source.json', (t) => {
  const dir = tempDir(t)
  writeSource(dir, 'dawn-craft', SAMPLE)
  writeSource(dir, 'demo-pack', { ...SAMPLE, slug: 'demo-pack', platform: 'mr', fileId: null, recovered: true })
  const versions = collectSourceVersions(dir)
  assert.deepEqual(Object.keys(versions), ['dawn-craft', 'demo-pack'])
  assert.deepEqual(versions['dawn-craft'], SAMPLE)
  assert.equal(versions['demo-pack'].platform, 'mr')
  assert.equal(versions['demo-pack'].fileId, null)
  assert.equal(versions['demo-pack'].recovered, true)
})

test('collectSourceVersions：没有 .source.json 的旧补丁静默跳过', (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'old-pack'), { recursive: true })
  writeFileSync(join(dir, 'old-pack', 'config.snbt'), '{ }')
  writeSource(dir, 'new-pack', SAMPLE)
  assert.deepEqual(Object.keys(collectSourceVersions(dir)), ['new-pack'])
})

test('collectSourceVersions：坏 JSON 跳过且不影响其它包', (t) => {
  const dir = tempDir(t)
  writeSource(dir, 'broken', null, { raw: '{ 这不是 JSON' })
  writeSource(dir, 'not-object', null, { raw: '[1,2,3]' })
  writeSource(dir, 'good', SAMPLE)
  const logs = []
  const versions = collectSourceVersions(dir, { log: (m) => logs.push(m) })
  assert.deepEqual(Object.keys(versions), ['good'])
  assert.equal(logs.length, 2, '坏 JSON 与非对象各打一行，但不抛错')
  assert.match(logs.join('\n'), /broken/)
})

test('collectSourceVersions：点目录 / 点文件被忽略', (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, '.hidden'), { recursive: true })
  writeFileSync(join(dir, '.hidden', SOURCE_FILE), JSON.stringify(SAMPLE))
  // patches 根下若有 .DS_Store 之类，不是目录，同样跳过
  writeFileSync(join(dir, '.DS_Store'), 'junk')
  writeSource(dir, 'real', SAMPLE)
  assert.deepEqual(Object.keys(collectSourceVersions(dir)), ['real'])
})

test('collectSourceVersions：目录不存在时返回空对象（不抛）', () => {
  assert.deepEqual(collectSourceVersions('/nonexistent/patches/dir'), {})
})

test('normalizeSourceInfo：字段类型不对时置 null，slug 兜底用目录名', () => {
  assert.deepEqual(normalizeSourceInfo({ fileName: 'a.zip', platform: 'weird', fileId: '7', recovered: 'yes' }, 'dir-slug'), {
    slug: 'dir-slug',
    platform: null,
    fileId: null,
    fileName: 'a.zip',
    fileDate: null,
    fetchedAt: null,
    recovered: false,
  })
  assert.equal(normalizeSourceInfo(null, 'x'), null)
  assert.equal(normalizeSourceInfo('str', 'x'), null)
  assert.equal(normalizeSourceInfo([], 'x'), null)
})

test('buildSourceVersions：形状为 { generatedAt, versions }，且可复现（同输入同输出）', (t) => {
  const dir = tempDir(t)
  writeSource(dir, 'b-pack', SAMPLE)
  writeSource(dir, 'a-pack', { ...SAMPLE, slug: 'a-pack' })
  const a = buildSourceVersions(dir, { now: 'T' })
  const b = buildSourceVersions(dir, { now: 'T' })
  assert.equal(a.generatedAt, 'T')
  assert.deepEqual(Object.keys(a.versions), ['a-pack', 'b-pack'], '目录名字典序，输出稳定')
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})
