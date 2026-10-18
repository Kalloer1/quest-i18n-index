#!/usr/bin/env node
/**
 * build-site-html 单测：构建必须把 site/request.html 复制进 dist/，
 * 否则提交页上线后不存在（线上 fallback 到 index）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function build() {
  execFileSync(process.execPath, ['scripts/build-site-html.mjs'], { cwd: ROOT, stdio: 'pipe' })
}

test('构建产出 dist/request.html，且内容与 site/request.html 一致', () => {
  build()
  const distReq = join(ROOT, 'dist/request.html')
  assert.ok(existsSync(distReq), 'dist/request.html 应存在')
  assert.equal(readFileSync(distReq, 'utf8'), readFileSync(join(ROOT, 'site/request.html'), 'utf8'))
})

test('构建仍正常产出 dist/index.html（占位符已替换）', () => {
  build()
  const index = join(ROOT, 'dist/index.html')
  assert.ok(existsSync(index), 'dist/index.html 应存在')
  assert.ok(!readFileSync(index, 'utf8').includes('/*__DATA__*/null'), '数据占位符应被替换')
})
