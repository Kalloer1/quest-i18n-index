#!/usr/bin/env node
/**
 * 把 site/data.json 内联进自包含 HTML，产出 dist/index.html。
 *
 * 为什么内联而不是 fetch：
 *   1. file:// 打开时 fetch 会被 CORS 拦，而设计要求「双击即可打开」
 *   2. 部署后少一个请求，首屏更快
 *
 * 为什么输出到 dist/ 而不是 site/：
 *   site/template.html 是含占位符的模板，不该被当成公开资源分发。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'

const data = readFileSync('site/data.json', 'utf8')
const template = readFileSync('site/template.html', 'utf8')

const marker = '/*__DATA__*/null'
if (!template.includes(marker)) {
  console.error(`模板里找不到占位符 ${marker}`)
  process.exit(1)
}

// 防 </script> 提前闭合
const safe = data.replace(/</g, '\\u003c')

rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })
writeFileSync('dist/index.html', template.replace(marker, safe))

const bytes = readFileSync('dist/index.html').length
console.log('→ dist/index.html', (bytes / 1024).toFixed(0) + 'KB')
