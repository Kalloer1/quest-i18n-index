import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZip } from './pack-patch.mjs'

// 工单 04：release.mjs 端到端（git 步骤用临时仓库桩环境，不碰真实仓库、不 push）。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 搭一个临时「项目」：patches/<slug>/ 产出 + 最小 research 输入 + 独立 git 仓库。
 * release.mjs 以 cwd 运行，ROOT 相对定位用 process.cwd()，所以直接在临时目录里跑。
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'release-'))
  mkdirSync(join(dir, 'patches', 'demo-pack', 'chapters'), { recursive: true })
  mkdirSync(join(dir, 'research'), { recursive: true })
  mkdirSync(join(dir, 'site'), { recursive: true })
  writeFileSync(join(dir, 'patches', 'demo-pack', 'chapters', 'a.snbt'), 'demo content\n')
  writeFileSync(join(dir, 'research', 'index-dataset.json'), JSON.stringify({
    generatedAt: 'T', stat: {}, dataset: [{ slug: 'demo-pack', cfId: 1, state: 'downloadable', vm: null, vmSuspect: null, layout: null, enFiles: 1, zhFiles: 0, probeIncomplete: false, stateWhy: '' }],
  }))
  writeFileSync(join(dir, 'research', 'vm-status.json'), JSON.stringify({ source: '', entries: [] }))
  writeFileSync(join(dir, 'research', 'pack-metadata.json'), JSON.stringify({ generatedAt: 'T', incomplete: false, packs: [] }))
  writeFileSync(join(dir, 'research', 'quark-mirrors.json'), JSON.stringify({ mirrors: {} }))
  writeFileSync(join(dir, 'site', 'template.html'), '<html></html>')
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git(['init'])
  git(['config', 'user.email', 't@t'])
  git(['config', 'user.name', 't'])
  git(['add', '.'])
  git(['commit', '-m', 'init'])
  return { dir, git }
}

function runRelease(dir, extraArgs = []) {
  return execFileSync(process.execPath, [join(ROOT, 'scripts', 'release.mjs'), '--ids', 'demo-pack', '--no-push', ...extraArgs], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'acme/repo' },
  })
}

test('release：打包 zip 到 downloads/，zip 内路径与整合包一致，含 README/LICENSE', () => {
  const { dir, git } = setup()
  try {
    runRelease(dir)
    const zipPath = join(dir, 'downloads', 'demo-pack.zip')
    assert.ok(existsSync(zipPath), '应产出 downloads/demo-pack.zip')
    const zip = readZip(readFileSync(zipPath))
    assert.ok(zip.names.includes('chapters/a.snbt'))
    assert.ok(zip.names.includes('README.txt'))
    assert.ok(zip.names.includes('LICENSE.txt'))
    // 显式路径暂存：data.json 与 quark-mirrors.json 也应入库
    const log = git(['show', '--name-only', '--format=', 'HEAD'])
    assert.ok(log.includes('downloads/demo-pack.zip'), log)
    assert.ok(log.includes('site/data.json'), log)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('release：site/data.json 合并 download 字段（zip 链接指向 GitHub raw）', () => {
  const { dir } = setup()
  try {
    runRelease(dir)
    const data = JSON.parse(readFileSync(join(dir, 'site', 'data.json'), 'utf8'))
    const p = data.packs.find(x => x.slug === 'demo-pack')
    assert.ok(p.download, 'downloadable 包应有 download 字段')
    assert.equal(p.download.zip, 'https://github.com/acme/repo/raw/main/downloads/demo-pack.zip')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('release：--dry-run 暂存但不提交', () => {
  const { dir, git } = setup()
  try {
    runRelease(dir, ['--dry-run'])
    assert.ok(existsSync(join(dir, 'downloads', 'demo-pack.zip')))
    const count = git(['rev-list', '--count', 'HEAD']).trim()
    assert.equal(count, '1', 'dry-run 不应产生新提交')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('release：无产出的 slug 跳过，不产出 zip', () => {
  const { dir } = setup()
  try {
    rmSync(join(dir, 'patches', 'demo-pack'), { recursive: true, force: true })
    const out = runRelease(dir)
    assert.match(out, /跳过|没有/)
    assert.ok(!existsSync(join(dir, 'downloads')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
