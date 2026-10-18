#!/usr/bin/env node
/**
 * 把 site/data.json 内联进自包含 HTML。
 *
 * 为什么内联而不是 fetch：file:// 打开时 fetch 会被 CORS 拦，
 * 而 ADR / 设计稿要求「双击即可在浏览器打开，不依赖本地服务器」。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const data = readFileSync('site/data.json', 'utf8')
const template = readFileSync('site/template.html', 'utf8')

const marker = '/*__DATA__*/null'
if (!template.includes(marker)) {
  console.error(`模板里找不到占位符 ${marker}`)
  process.exit(1)
}

// 防 </script> 提前闭合
const safe = data.replace(/</g, '\\u003c')

writeFileSync('site/index.html', template.replace(marker, safe))
console.log('→ site/index.html', (readFileSync('site/index.html', 'utf8').length / 1024).toFixed(0) + 'KB')
