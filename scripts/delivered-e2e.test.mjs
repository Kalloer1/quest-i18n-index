import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZip } from './pack-patch.mjs'

// 端到端：验证「打包 → 索引 → 站点数据」三段闭环真的打通。
// 这是 downloadable 态与站点下载按钮的唯一来源：
//   patches/<slug>/ --release--> downloads/<slug>.zip
//   downloads/<slug>.zip --build-index--> delivered=true ⇒ state=downloadable
//   state=downloadable --build-site-data--> download 区块（zip 指向 downloads/<slug>.zip）
// 只测其中一段无法证明闭环，因此这里跑完整的 release.mjs。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 搭一个临时「项目」：patches/<slug>/ 产出 + 最小 research 输入 + 独立 git 仓库。
 * release.mjs 以 cwd 为仓库根运行，所以直接在临时目录里跑。
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'delivered-e2e-'))
  mkdirSync(join(dir, 'patches', 'demo-pack', 'chapters'), { recursive: true })
  mkdirSync(join(dir, 'research'), { recursive: true })
  mkdirSync(join(dir, 'site'), { recursive: true })
  writeFileSync(join(dir, 'patches', 'demo-pack', 'chapters', 'a.snbt'), 'demo content\n')
  // 扫描 TSV：demo-pack 是分离布局、有英文源、无中文 ⇒ 未产出时本应是 gap-uncovered。
  writeFileSync(join(dir, 'research', 'scan-cf500.tsv'),
    'id\tslug\tbytes\tformat\tnewEn\tnewZh\toldCh\tcdKB\tscannedAt\n'
    + '1\tdemo-pack\t100\tseparate-dir\t1\t0\t0\t0\tT\n')
  writeFileSync(join(dir, 'research', 'build-input.json'), JSON.stringify({ packs: [], vmEntries: [] }))
  writeFileSync(join(dir, 'research', 'pack-metadata.json'), JSON.stringify({
    generatedAt: 'T', incomplete: false, packs: [{ slug: 'demo-pack', title: 'Demo Pack' }],
  }))
  writeFileSync(join(dir, 'research', 'vm-status.json'), JSON.stringify({ source: '', entries: [] }))
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

/** 跑 release.mjs 的完整流水线（--no-push，不碰远端）。 */
function runRelease(dir, extraArgs = []) {
  return execFileSync(process.execPath, [join(ROOT, 'scripts', 'release.mjs'), '--ids', 'demo-pack', '--no-push', ...extraArgs], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'acme/repo' },
  })
}

const readIndex = (dir) => JSON.parse(readFileSync(join(dir, 'research', 'index-dataset.json'), 'utf8'))
const readSite = (dir) => JSON.parse(readFileSync(join(dir, 'site', 'data.json'), 'utf8'))

test('端到端：没有 zip 时 demo-pack 不是 downloadable（delivered 由 downloads/ 驱动）', () => {
  const { dir } = setup()
  try {
    // 只跑索引：还没有 downloads/，delivered 应为 false。
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-index.mjs')], { cwd: dir, encoding: 'utf8' })
    const rec = readIndex(dir).dataset.find(d => d.slug === 'demo-pack')
    assert.ok(rec, '索引里应有 demo-pack')
    assert.equal(rec.delivered, false, '没有 zip 时 delivered 应为 false')
    assert.notEqual(rec.state, 'downloadable', '没有 zip 时不应是 downloadable')
    assert.equal(rec.state, 'gap-uncovered')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('端到端：打包 → 索引 → 站点数据，从 zip 到站点下载区块真的通了', () => {
  const { dir } = setup()
  try {
    runRelease(dir)

    // ① 打包：downloads/<slug>.zip 存在，且内容与 patches/<slug>/ 一致。
    const zipPath = join(dir, 'downloads', 'demo-pack.zip')
    assert.ok(existsSync(zipPath), '应产出 downloads/demo-pack.zip')
    const zip = readZip(readFileSync(zipPath))
    assert.ok(zip.names.includes('chapters/a.snbt'), `zip 内应有产出文件，实际 ${zip.names.join(', ')}`)

    // ② 索引：重跑 build-index 后该 slug 的 state 变成 downloadable。
    const index = readIndex(dir)
    const rec = index.dataset.find(d => d.slug === 'demo-pack')
    assert.ok(rec, '索引里应有 demo-pack')
    assert.equal(rec.delivered, true, '有 zip 时 delivered 应为 true')
    assert.equal(rec.state, 'downloadable', '有 zip 的 slug 应为 downloadable')
    assert.equal(index.stat.stateCounts.downloadable, 1, 'downloadable 计数应为 1')

    // ③ 站点数据：download 区块非 null，zip 链接指向 downloads/<slug>.zip。
    const data = readSite(dir)
    const p = data.packs.find(x => x.slug === 'demo-pack')
    assert.ok(p, '站点数据里应有 demo-pack')
    assert.ok(p.download, 'downloadable 包应有非 null 的 download 区块')
    assert.ok(p.download.zip.includes('downloads/demo-pack.zip'), `zip 链接应指向 downloads/demo-pack.zip，实际 ${p.download.zip}`)
    assert.equal(p.download.zip, 'https://github.com/acme/repo/raw/main/downloads/demo-pack.zip')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('端到端：research/index-dataset.json 与 zip 一起入库（显式路径暂存）', () => {
  const { dir, git } = setup()
  try {
    runRelease(dir)
    const log = git(['show', '--name-only', '--format=', 'HEAD'])
    assert.ok(log.includes('downloads/demo-pack.zip'), log)
    assert.ok(log.includes('research/index-dataset.json'), log)
    assert.ok(log.includes('site/data.json'), log)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
