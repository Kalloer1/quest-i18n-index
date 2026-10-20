#!/usr/bin/env node
/**
 * validate-quests 批量模式单测：无参数调用时扫描 patches/ 做全量校验。
 *
 * 用临时目录 + 注入路径，不依赖仓库真实状态。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runBatch } from './validate-quests.mjs'

/** 造一棵临时树：patches/、research/packs/、research/index-dataset.json。 */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'validate-batch-'))
  const research = join(root, 'research')
  mkdirSync(research, { recursive: true })
  return {
    root,
    patchesDir: join(root, 'patches'),
    packsDir: join(research, 'packs'),
    datasetFile: join(research, 'index-dataset.json'),
  }
}

function writeSnbt(dir, name, text) {
  const full = join(dir, ...name.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text)
}

function writeDataset(file, rows) {
  writeFileSync(file, JSON.stringify({ dataset: rows }))
}

/** 捕获 runBatch 期间的 console 输出与返回码。 */
function capture(fn) {
  const logs = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...a) => logs.push(a.join(' '))
  console.warn = (...a) => logs.push(a.join(' '))
  console.error = (...a) => logs.push(a.join(' '))
  try {
    return { code: fn(), logs }
  } finally {
    Object.assign(console, orig)
  }
}

test('批量：无产出 → exit 0 并提示跳过', () => {
  const t = makeTree()
  try {
    const { code, logs } = capture(() =>
      runBatch({ patchesDir: t.patchesDir, packsDir: t.packsDir, datasetFile: t.datasetFile }),
    )
    assert.equal(code, 0)
    assert.ok(logs.some((l) => l.includes('没有待校验的产出，跳过')))
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

test('批量：一条产出通过 → exit 0', () => {
  const t = makeTree()
  try {
    writeDataset(t.datasetFile, [{ slug: 'demo', layout: 'embedded' }])
    writeSnbt(join(t.packsDir, 'demo'), 'chapters/a.snbt', '{ title: "Hello &aWorld" desc: "Get %s apples" }')
    writeSnbt(t.patchesDir, 'demo/chapters/a.snbt', '{ title: "你好 &aWorld" desc: "获得 %s 个苹果" }')
    const { code } = capture(() =>
      runBatch({ patchesDir: t.patchesDir, packsDir: t.packsDir, datasetFile: t.datasetFile }),
    )
    assert.equal(code, 0)
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

test('批量：一条产出有问题 → exit 1，且其余条目仍被校验', () => {
  const t = makeTree()
  try {
    writeDataset(t.datasetFile, [
      { slug: 'bad', layout: 'embedded' },
      { slug: 'good', layout: 'embedded' },
    ])
    // bad：缺键
    writeSnbt(join(t.packsDir, 'bad'), 'chapters/a.snbt', '{ title: "Hello" desc: "World" }')
    writeSnbt(t.patchesDir, 'bad/chapters/a.snbt', '{ title: "你好" }')
    // good：完全对应
    writeSnbt(join(t.packsDir, 'good'), 'chapters/a.snbt', '{ title: "Hello" }')
    writeSnbt(t.patchesDir, 'good/chapters/a.snbt', '{ title: "你好" }')
    const { code, logs } = capture(() =>
      runBatch({ patchesDir: t.patchesDir, packsDir: t.packsDir, datasetFile: t.datasetFile }),
    )
    assert.equal(code, 1)
    // 两个条目都跑完：汇总里分母是 2
    assert.ok(logs.some((l) => l.includes('1/2')), `应汇总 1/2，实际输出：\n${logs.join('\n')}`)
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

test('批量：找不到英文源 → 判失败（缺基准键集时不许「通过」）', () => {
  const t = makeTree()
  try {
    writeDataset(t.datasetFile, [{ slug: 'demo', layout: 'embedded' }])
    // 只有产出，没有 research/packs/demo/
    writeSnbt(t.patchesDir, 'demo/chapters/a.snbt', '{ title: "你好" }')
    const { code, logs } = capture(() =>
      runBatch({ patchesDir: t.patchesDir, packsDir: t.packsDir, datasetFile: t.datasetFile }),
    )
    // 这条断言曾经是 code === 0（warn 跳过）。
    // 2026-10-19 那轮假绿灯就是它放过去的：20/31 个包没有英文源，
    // 全部跳过，最后仍打印「✔ 31 个产出，33201 个键」。
    assert.equal(code, 1)
    assert.ok(logs.some((l) => l.includes('找不到英文源')), '应说明缺的是英文源')
    assert.ok(logs.some((l) => l.includes('1/1')), '汇总分母应包含这一条')
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

test('批量：缺英文源与校验不通过分开计数，汇总行不许把跳过的算进键数', () => {
  const t = makeTree()
  try {
    writeDataset(t.datasetFile, [
      { slug: 'good', layout: 'embedded' },
      { slug: 'nosrc', layout: 'embedded' },
    ])
    writeSnbt(join(t.packsDir, 'good'), 'chapters/a.snbt', '{ title: "Hello" }')
    writeSnbt(t.patchesDir, 'good/chapters/a.snbt', '{ title: "你好" }')
    writeSnbt(t.patchesDir, 'nosrc/chapters/a.snbt', '{ title: "你好" }')
    const { code, logs } = capture(() =>
      runBatch({ patchesDir: t.patchesDir, packsDir: t.packsDir, datasetFile: t.datasetFile }),
    )
    assert.equal(code, 1)
    const summary = logs.find((l) => l.includes('批量校验失败')) ?? ''
    assert.ok(summary.includes('1 个缺英文源'), `汇总应点名缺源数，实际：${summary}`)
    assert.ok(!logs.some((l) => l.includes('✔ 批量校验通过')), '有失败时不许打印通过行')
  } finally {
    rmSync(t.root, { recursive: true, force: true })
  }
})

