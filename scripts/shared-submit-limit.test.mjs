/**
 * shared/submit-limit.mjs 的离线单元测试。
 *
 * 覆盖「每 IP 每天新增提交限流」的全部纯函数：
 * - 计数 < 上限 → 放行，remainingToday 正确
 * - 计数 == 上限 → 拒绝（429 语义）
 * - 上限解析失败/缺失 → 回退 3
 * - 跨天换 key（日期变化 → 计数归零）
 * - 重复提交（existing）不计数
 * - IP 提取优先级（CF-Connecting-IP → X-Forwarded-For 第一段 → 无）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SUBMIT_LIMIT_PER_DAY,
  SUBMIT_LIMIT_TTL_SECONDS,
  parseSubmitLimit,
  submitLimit,
  shouldCountSubmit,
  submitDayKey,
  clientIp,
} from '../shared/submit-limit.mjs'

test('submitLimit：计数 < 上限 → 放行，remainingToday 正确', () => {
  assert.deepEqual(submitLimit(0, 3), { allowed: true, remainingToday: 3 })
  assert.deepEqual(submitLimit(1, 3), { allowed: true, remainingToday: 2 })
  assert.deepEqual(submitLimit(2, 3), { allowed: true, remainingToday: 1 })
})

test('submitLimit：计数 >= 上限 → 拒绝，remainingToday 0', () => {
  assert.deepEqual(submitLimit(3, 3), { allowed: false, remainingToday: 0 })
  assert.deepEqual(submitLimit(5, 3), { allowed: false, remainingToday: 0 })
})

test('parseSubmitLimit：缺失/空值回退默认 3', () => {
  assert.equal(parseSubmitLimit(undefined), DEFAULT_SUBMIT_LIMIT_PER_DAY)
  assert.equal(parseSubmitLimit(null), DEFAULT_SUBMIT_LIMIT_PER_DAY)
  assert.equal(parseSubmitLimit(''), DEFAULT_SUBMIT_LIMIT_PER_DAY)
})

test('parseSubmitLimit：非正整数回退默认 3', () => {
  assert.equal(parseSubmitLimit('abc'), 3)
  assert.equal(parseSubmitLimit('0'), 3)
  assert.equal(parseSubmitLimit('-1'), 3)
  assert.equal(parseSubmitLimit('3.5'), 3)
  assert.equal(parseSubmitLimit('NaN'), 3)
})

test('parseSubmitLimit：合法正整数原样返回', () => {
  assert.equal(parseSubmitLimit('3'), 3)
  assert.equal(parseSubmitLimit('5'), 5)
  assert.equal(parseSubmitLimit(4), 4)
})

test('默认上限与 TTL 常量', () => {
  assert.equal(DEFAULT_SUBMIT_LIMIT_PER_DAY, 3)
  assert.equal(SUBMIT_LIMIT_TTL_SECONDS, 172800)
})

test('submitDayKey：同一天同一 hash → 相同 key', () => {
  const a = submitDayKey(new Date('2026-10-14T03:00:00Z'), 'hash1')
  const b = submitDayKey(new Date('2026-10-14T23:59:59Z'), 'hash1')
  assert.equal(a, b)
  assert.equal(a, 'submit:limit:hash1:20261014')
})

test('submitDayKey：日期变化 → key 变化（新的一天计数归零）', () => {
  const d1 = submitDayKey(new Date('2026-10-14T23:00:00Z'), 'hash1')
  const d2 = submitDayKey(new Date('2026-10-15T01:00:00Z'), 'hash1')
  assert.notEqual(d1, d2)
  assert.equal(d1, 'submit:limit:hash1:20261014')
  assert.equal(d2, 'submit:limit:hash1:20261015')
})

test('submitDayKey：按 UTC 换天', () => {
  const key = submitDayKey(new Date('2026-10-14T16:00:00-08:00'), 'h')
  assert.equal(key, 'submit:limit:h:20261015')
})

test('shouldCountSubmit：新增计数、重复提交不计数', () => {
  assert.equal(shouldCountSubmit(null), true)
  assert.equal(shouldCountSubmit(undefined), true)
  assert.equal(shouldCountSubmit({ id: 'craftoria' }), false)
})

test('clientIp：优先 CF-Connecting-IP', () => {
  const req = new Request('https://example.test/', {
    headers: { 'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '9.9.9.9, 8.8.8.8' },
  })
  assert.deepEqual(clientIp(req), { ip: '1.2.3.4', source: 'cf' })
})

test('clientIp：缺失 CF-Connecting-IP → X-Forwarded-For 第一段', () => {
  const req = new Request('https://example.test/', {
    headers: { 'X-Forwarded-For': ' 9.9.9.9 , 8.8.8.8 ' },
  })
  assert.deepEqual(clientIp(req), { ip: '9.9.9.9', source: 'xff' })
})

test('clientIp：都没有 → ip 为 null（调用方不限流）', () => {
  const req = new Request('https://example.test/')
  assert.deepEqual(clientIp(req), { ip: null, source: 'none' })
})
