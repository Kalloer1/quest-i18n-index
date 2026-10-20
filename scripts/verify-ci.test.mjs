/**
 * `verify-ci.mjs` 的纯逻辑单测。
 *
 * ## 为什么盯这个
 *
 * 本机绿灯、CI 红灯已经真实发生过一次（run 39426426002）：21 个未跟踪的
 * `research/packs/<slug>/` 只在本机磁盘上，CI 看不到，19 个包被判「缺英文源」。
 * `verify-ci.mjs` 是「在干净克隆里验一遍」的固化。
 *
 * 这里只测纯逻辑（步骤清单、结果判定），不测真的 clone —— 那个由脚本自己实跑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSteps, judgeRun } from './verify-ci.mjs'

test('buildSteps：覆盖 install / test / validate 三步', () => {
  const names = buildSteps().map((s) => s.name)
  assert.deepEqual(names, ['install', 'test', 'validate'])
})

test('buildSteps：validate 步必须真跑 validate:quests（不是别的脚本）', () => {
  const validate = buildSteps().find((s) => s.name === 'validate')
  assert.equal(validate.cmd, 'npm')
  assert.deepEqual(validate.args, ['run', 'validate:quests'])
})

test('buildSteps：test 步跑的是 npm test', () => {
  const t = buildSteps().find((s) => s.name === 'test')
  assert.deepEqual(t.args, ['test'])
})

test('judgeRun：全部 0 → 通过', () => {
  const r = judgeRun([
    { name: 'install', code: 0 },
    { name: 'test', code: 0 },
    { name: 'validate', code: 0 },
  ])
  assert.equal(r.ok, true)
  assert.deepEqual(r.failedSteps, [])
})

test('judgeRun：任一步失败 → 整体失败（这是本脚本存在的理由）', () => {
  const r = judgeRun([
    { name: 'install', code: 0 },
    { name: 'test', code: 1 },
    { name: 'validate', code: 0 },
  ])
  assert.equal(r.ok, false)
  assert.deepEqual(r.failedSteps, ['test'])
})

test('judgeRun：中间步骤失败不得被后面步骤的成功掩盖', () => {
  // 旧的手工验收正是只看最后一条命令的输出，才漏掉了中间失败。
  const r = judgeRun([
    { name: 'install', code: 0 },
    { name: 'test', code: 2 },
    { name: 'validate', code: 0 },
  ])
  assert.equal(r.ok, false)
  assert.ok(r.failedSteps.includes('test'))
})

test('judgeRun：退出码 null（进程被信号杀死）也算失败', () => {
  const r = judgeRun([{ name: 'test', code: null }])
  assert.equal(r.ok, false)
  assert.deepEqual(r.failedSteps, ['test'])
})

test('judgeRun：空结果不算通过（没跑过就没有资格说绿）', () => {
  // 刻意要求显式步骤：空数组代表「一步都没跑成」，不能当成功。
  const r = judgeRun([])
  assert.equal(r.ok, false)
})
