#!/usr/bin/env node
/**
 * build-identity 的单测：严格归并三用例（归并 / 不归并 / 歧义）+ 相似度与 lookup。
 * 全部喂假数据，不读真实 dataset。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeKey, lcsLength, slugSimilarity, mergeTitleGroup, buildIdentity, buildLookup,
} from './build-identity.mjs'

// ---------- 规范化与相似度 ----------

test('normalizeKey：小写 + 去非字母数字', () => {
  assert.equal(normalizeKey('Better MC [FORGE] BMC4'), 'bettermcforgebmc4')
  assert.equal(normalizeKey('  All-the-Mods-10! '), 'allthemods10')
  assert.equal(normalizeKey(null), '')
})

test('lcsLength：经典 LCS', () => {
  assert.equal(lcsLength('abcde', 'ace'), 3)
  assert.equal(lcsLength('abc', 'abc'), 3)
  assert.equal(lcsLength('', 'abc'), 0)
})

test('slugSimilarity：分隔符差异不算距离，空串不相似', () => {
  assert.equal(slugSimilarity('all-the-mods-10', 'all_the_mods_10'), 1)
  assert.equal(slugSimilarity('craftoria', 'craftoria-x'), 9 / 10)
  assert.equal(slugSimilarity('', 'abc'), 0)
  assert.ok(slugSimilarity('craftoria', 'craftoriaf') >= 0.9)
  assert.ok(slugSimilarity('abc', 'xyz') < 0.9)
})

// ---------- 用例一：满足条件 → 自动归并 ----------

test('mergeTitleGroup：跨平台同名且 slug 相似度 ≥0.9 → 归并，主 slug 优先取在库成员', () => {
  const members = [
    { platform: 'mr', slug: 'better-mc-forge-bmc4', title: 'Better MC [FORGE] BMC4' },
    { platform: 'cf', slug: 'better-mc-forge-bmc4', title: 'Better MC [FORGE] BMC4' },
  ]
  const { merged, review } = mergeTitleGroup(members, new Set(['better-mc-forge-bmc4']))
  assert.ok(merged, '应归并')
  assert.ok(!review)
  assert.equal(merged.id, 'better-mc-forge-bmc4')
  assert.equal(merged.members.length, 2)
})

test('mergeTitleGroup：相似度达标但都不在库 → 主 slug 取 cf 优先、slug 字典序', () => {
  const members = [
    { platform: 'mr', slug: 'craftoriaf', title: 'Craftoria' },
    { platform: 'cf', slug: 'craftoria', title: 'Craftoria' },
  ]
  const { merged } = mergeTitleGroup(members, new Set())
  assert.equal(merged.id, 'craftoria')
})

// ---------- 用例二：相似度不足 → 不归并，进 needs-review ----------

test('mergeTitleGroup：跨平台同名但相似度 <0.9 → 整组进 needs-review', () => {
  const members = [
    { platform: 'cf', slug: 'create-perfect-world', title: 'Create Perfect World' },
    { platform: 'mr', slug: 'perfectworld', title: 'Create Perfect World' },
  ]
  const { merged, review } = mergeTitleGroup(members, new Set())
  assert.ok(!merged, '相似度不足绝不归并')
  assert.ok(review)
  assert.ok(review.reason.includes('相似度不足'))
  assert.equal(review.members.length, 2)
})

// ---------- 用例三：歧义 → 整组进 needs-review，绝不部分归并 ----------

test('mergeTitleGroup：同平台多个 slug → 歧义，整组 needs-review', () => {
  const members = [
    { platform: 'cf', slug: 'pack-a', title: 'Same Name' },
    { platform: 'cf', slug: 'pack-a-2', title: 'Same Name' },
    { platform: 'mr', slug: 'packa', title: 'Same Name' },
  ]
  const { merged, review } = mergeTitleGroup(members, new Set())
  assert.ok(!merged, '有歧义时连达标 pair 也不归并')
  assert.ok(review)
  assert.ok(review.reason.includes('同名同平台'))
})

// ---------- buildIdentity 汇总 ----------

test('buildIdentity：单成员自成一组两边都不进，汇总统计正确', () => {
  const entries = [
    { slug: 'craftoria', platform: 'cf', title: 'Craftoria' },
    { slug: 'craftoria', platform: 'mr', title: 'Craftoria' },
    { slug: 'lone-pack', platform: 'cf', title: 'Lone Pack' },
    { slug: 'no-title-pack', platform: 'cf', title: null },
    { slug: 'dup-cf-1', platform: 'cf', title: 'Dup' },
    { slug: 'dup-cf-2', platform: 'cf', title: 'Dup' },
  ]
  const { groups, needsReview, stats } = buildIdentity(entries, new Set(['craftoria']))
  assert.equal(groups.length, 1)
  assert.equal(groups[0].id, 'craftoria')
  assert.equal(needsReview.length, 1)
  assert.equal(needsReview[0].reason.includes('同名同平台'), true)
  assert.equal(stats.singletons, 1)
  assert.equal(stats.entries, 6)
  assert.equal(stats.merged, 1)
})

// ---------- buildLookup ----------

test('buildLookup：组内 slug 与在库 slug 都有 groupId；versionBySlug 只收有 fileName 的', () => {
  const groups = [
    { id: 'craftoria', title: 'Craftoria', members: [{ platform: 'cf', slug: 'craftoria' }, { platform: 'mr', slug: 'craftoria' }] },
  ]
  const versions = {
    craftoria: { slug: 'craftoria', fileName: 'Craftoria 1.2.zip' },
    'skyfactory-5': { slug: 'skyfactory-5', fileName: 'SkyFactory 5 5.0.1.zip' },
    'no-file-pack': { slug: 'no-file-pack', fileName: null },
  }
  const { groupBySlug, versionBySlug } = buildLookup(groups, versions)
  assert.equal(groupBySlug.craftoria, 'craftoria')
  assert.equal(groupBySlug['skyfactory-5'], 'skyfactory-5')
  assert.equal(groupBySlug['unknown-slug'], undefined, '不在库也不在组的不出现，Worker 端回退 slug 自身')
  assert.equal(versionBySlug.craftoria, 'Craftoria 1.2.zip')
  assert.equal(versionBySlug['no-file-pack'], undefined)
})
