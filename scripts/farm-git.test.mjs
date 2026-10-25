/**
 * `scripts/lib/farm-git.mjs` 的测试。
 *
 * ## 为什么值得建真仓库
 *
 * 这一段代码干的活全是「git 的输出怎么解读」：`rev-list --count` 的返回值、
 * 首次推送时 `fetch` 必然失败、远端被别的主机抢先推之后的 rebase。
 * 用 mock 覆盖这些，等于把「我以为 git 会这样回」写进测试 —— 而 farm 分支上
 * 一次错误的 rebase 就会把三台主机的产物搅在一起。
 *
 * 所以集成用例一律：tmp 里 `git init --bare` 当 origin，真推、真读回。
 * 环境里没有 git 时（罕见的 CI 镜像）用 `skip` 兜底 —— 这是环境能力缺失，
 * 不是被测代码的问题，但必须留一行说明，否则「测试被跳过」会被当成绿灯。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isBehind, hostFromBranch, farmPathsForBatch, countCommittedPacks, commitAndPush,
} from './lib/farm-git.mjs'

const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// 测试环境（CI 容器、精简镜像）可能没装 git；那是环境能力缺失，跳过而不是判红。
const SKIP_NO_GIT = HAS_GIT ? false : '环境里没有 git 可执行文件，跳过需要真仓库的用例'

const quiet = () => {}

function g(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // stdin 断开：自动化里任何交互（凭据、编辑器）都会把测试挂死。
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** 起一组「bare origin + 一个工作仓库」，工作仓库已有一条 main 提交但**没有**推上去。 */
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'farm-git-'))
  const bare = join(base, 'origin.git')
  const work = join(base, 'work')
  execFileSync('git', ['init', '-q', '--bare', bare], { cwd: base, stdio: 'ignore' })
  execFileSync('git', ['init', '-q', work], { stdio: 'ignore' })
  g(work, ['config', 'user.email', 'farm@test.local'])
  g(work, ['config', 'user.name', 'farm test'])
  g(work, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(work, 'README.md'), '# fixture\n')
  g(work, ['add', 'README.md'])
  g(work, ['commit', '-q', '-m', 'init'])
  // bare 路径在 Windows 上是反斜杠，git 的 remote URL 里要正斜杠。
  g(work, ['remote', 'add', 'origin', bare.replace(/\\/g, '/')])
  return { base, bare, work }
}

/** 在工作仓库里造一个包的产物（补丁 + 基准源），外加一堆**不该**被提交的诱饵。 */
function seedPack(work, slug, { decoys = false } = {}) {
  mkdirSync(join(work, 'patches', slug, 'config/ftbquests/quests/lang'), { recursive: true })
  writeFileSync(join(work, 'patches', slug, 'config/ftbquests/quests/lang/zh_cn.snbt'), `{ "${slug}" }\n`)
  mkdirSync(join(work, 'research/packs', slug), { recursive: true })
  writeFileSync(join(work, 'research/packs', slug, 'en_us.snbt'), `{ "${slug}" }\n`)
  writeFileSync(join(work, 'research/packs', `${slug}.tar.gz`), `fake-${slug}\n`)
  if (!decoys) return
  mkdirSync(join(work, 'downloads'), { recursive: true })
  writeFileSync(join(work, 'downloads/x.zip'), 'zip\n')
  mkdirSync(join(work, 'site'), { recursive: true })
  writeFileSync(join(work, 'site/data.json'), '{}\n')
  writeFileSync(join(work, 'glossary.json'), '{}\n')
  mkdirSync(join(work, 'research/par-out', slug), { recursive: true })
  writeFileSync(join(work, 'research/par-out', slug, 'chunk-0000.json'), '{}\n')
}

// ---------- 纯函数 ----------

test('isBehind：0 / 空 / 非数字 都算不落后', () => {
  assert.equal(isBehind('0\n'), false)
  assert.equal(isBehind('0'), false)
  assert.equal(isBehind('  0  \n'), false)
  assert.equal(isBehind(''), false)
  assert.equal(isBehind(undefined), false)
  // rev-list 失败时输出可能是空/垃圾：当成「不落后」比去 rebase 一个不存在的提交安全。
  assert.equal(isBehind('fatal: bad revision'), false)
})

test('isBehind：正整数算落后，多行里只要有一个 > 0 也算', () => {
  assert.equal(isBehind('3\n'), true)
  assert.equal(isBehind('12'), true)
  assert.equal(isBehind('0\n0\n'), false)
  assert.equal(isBehind('0\n7\n'), true)
})

test('hostFromBranch：取第一个 / 之后的部分', () => {
  assert.equal(hostFromBranch('farm/gfdrgfd'), 'gfdrgfd')
  assert.equal(hostFromBranch('farm/podsjk'), 'podsjk')
  assert.equal(hostFromBranch('main'), 'main')
  // 只是防御：正常不会出现两级，但截断只会给错分支名，不会给错仓库。
  assert.equal(hostFromBranch('farm/a/b'), 'a/b')
})

test('farmPathsForBatch：只有补丁与基准源，不带 downloads/site/术语/索引/中间态', () => {
  const paths = farmPathsForBatch({ slugs: ['p1', 'p2', 'p1'] })
  assert.deepEqual(paths, [
    'patches/p1/', 'research/packs/p1.tar.gz',
    'patches/p2/', 'research/packs/p2.tar.gz',
  ])
  for (const forbidden of ['downloads/', 'site/data.json', 'glossary.json', 'research/index-dataset.json', 'research/par-out/']) {
    assert.ok(!paths.includes(forbidden), `farm 模式不该暂存 ${forbidden}`)
  }
  // 目录形态的英文源（解包目录）永不入库：它被 .gitignore 挡着，硬 add 会失败或把几十 MB 塞进仓库。
  assert.ok(!paths.some((p) => /^research\/packs\/[^/]+\/$/.test(p)), '不该出现 research/packs/<slug>/ 目录')
})

test('countCommittedPacks：按 slug 去重，补丁与归档只算一个包', () => {
  const text = [
    'patches/p1/a.snbt',
    'patches/p1/b.snbt',
    'research/packs/p1.tar.gz',
    'patches/p2/a.snbt',
    'README.md',
  ].join('\n')
  assert.equal(countCommittedPacks(text), 2)
  assert.equal(countCommittedPacks(''), 0)
})

// ---------- 集成：真仓库 ----------

test('commitAndPush：只推到 farm/test，main 不动，英文源是 tar.gz 不是目录', { skip: SKIP_NO_GIT }, () => {
  const { base, bare, work } = setup()
  seedPack(work, 'p1', { decoys: true })
  seedPack(work, 'p2', { decoys: true })

  const res = commitAndPush({ root: work, branch: 'farm/test', slugs: ['p1', 'p2'], pushAttempts: 1, log: quiet })
  assert.equal(res.ok, true, `推送应成功：${res.error}`)
  assert.equal(res.committed, 2)
  assert.equal(res.attempts, 1)

  // 远端只有 farm/test：main 从来没被这条路径碰过。
  const refs = g(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads'])
  assert.deepEqual(refs.split('\n').filter(Boolean), ['refs/heads/farm/test'])
  assert.throws(() => g(bare, ['rev-parse', '--verify', 'main']), 'main 不该存在')

  const files = g(bare, ['ls-tree', '-r', '--name-only', 'farm/test']).split('\n').filter(Boolean)
  assert.ok(files.includes('patches/p1/config/ftbquests/quests/lang/zh_cn.snbt'))
  assert.ok(files.includes('patches/p2/config/ftbquests/quests/lang/zh_cn.snbt'))
  assert.ok(files.includes('research/packs/p1.tar.gz'))
  assert.ok(files.includes('research/packs/p2.tar.gz'))
  assert.ok(!files.some((f) => f.startsWith('research/packs/p1/')), '解包目录不该入库')
  for (const forbidden of ['downloads/x.zip', 'site/data.json', 'glossary.json', 'research/par-out/p1/chunk-0000.json']) {
    assert.ok(!files.includes(forbidden), `不该提交 ${forbidden}`)
  }

  assert.equal(g(bare, ['log', '-1', '--format=%s', 'farm/test']), 'farm(test): 2 个整合包')
  rmSync(base, { recursive: true, force: true })
})

test('commitAndPush：没有改动就不提交（不产生空提交）', { skip: SKIP_NO_GIT }, () => {
  const { base, bare, work } = setup()
  seedPack(work, 'p1')
  const first = commitAndPush({ root: work, branch: 'farm/test', slugs: ['p1'], pushAttempts: 1, log: quiet })
  assert.equal(first.ok, true)
  assert.equal(first.committed, 1)
  // farm/test 上有两个提交：工作仓库自己的 init + 本轮产物，后者不能重复。
  const commitsAfterFirst = g(bare, ['rev-list', '--count', 'farm/test'])

  // 同一批 slug 原样再跑：内容没变，不该再出一个提交。
  const second = commitAndPush({ root: work, branch: 'farm/test', slugs: ['p1'], pushAttempts: 1, log: quiet })
  assert.equal(second.ok, true)
  assert.equal(second.committed, 0)
  assert.equal(second.attempts, 0)
  assert.equal(g(bare, ['rev-list', '--count', 'farm/test']), commitsAfterFirst)

  // 只有暂存范围之外的未跟踪文件时同样不提交（否则 git commit 会失败）。
  writeFileSync(join(work, 'unrelated.txt'), 'x\n')
  const third = commitAndPush({ root: work, branch: 'farm/test', slugs: ['p1'], pushAttempts: 1, log: quiet })
  assert.equal(third.ok, true)
  assert.equal(third.committed, 0)
  rmSync(base, { recursive: true, force: true })
})

test('commitAndPush：远端被别的主机抢先推 → fetch + rebase 后仍能推上去', { skip: SKIP_NO_GIT }, () => {
  const { base, bare, work } = setup()
  seedPack(work, 'p1')
  assert.equal(commitAndPush({ root: work, branch: 'farm/test', slugs: ['p1'], pushAttempts: 2, log: quiet }).ok, true)

  // 模拟另一台主机：clone 下来、翻出 p9、直接推同一个分支。
  // 必须 `-b farm/test`：bare 仓库的 HEAD 指向不存在的默认分支，裸 clone 会拿到一个空仓库。
  const other = join(base, 'other')
  g(base, ['clone', '-q', '-b', 'farm/test', bare.replace(/\\/g, '/'), other])
  g(other, ['config', 'user.email', 'other@test.local'])
  g(other, ['config', 'user.name', 'other'])
  g(other, ['config', 'commit.gpgsign', 'false'])
  seedPack(other, 'p9')
  g(other, ['add', '--', 'patches/p9', 'research/packs/p9.tar.gz'])
  g(other, ['commit', '-q', '-m', 'other: p9'])
  g(other, ['push', '-q', 'origin', 'HEAD:refs/heads/farm/test'])

  // 本地再翻出 p3：此时 HEAD 落后远端 1 个提交，必须是「先 rebase 再 push」才能成功。
  seedPack(work, 'p3')
  const res = commitAndPush({ root: work, branch: 'farm/test', slugs: ['p3'], pushAttempts: 2, log: quiet })
  assert.equal(res.ok, true, `应 rebase 后推送成功：${res.error}`)
  assert.equal(res.committed, 1)

  const files = g(bare, ['ls-tree', '-r', '--name-only', 'farm/test']).split('\n').filter(Boolean)
  assert.ok(files.includes('patches/p3/config/ftbquests/quests/lang/zh_cn.snbt'), '本轮产物应在远端')
  assert.ok(files.includes('patches/p9/config/ftbquests/quests/lang/zh_cn.snbt'), '别台主机的产物不能被覆盖掉')
  rmSync(base, { recursive: true, force: true })
})

test('commitAndPush：远端 tip 是本机 HEAD 祖先 → 安全强推（交接 §2.5）', { skip: SKIP_NO_GIT }, () => {
  const { base, bare, work } = setup()
  seedPack(work, 'p1')
  // 首推：远端无分支，fetch 必败，走普通 push。
  const first = commitAndPush({ root: work, branch: 'farm/test', slugs: ['p1'], pushAttempts: 1, log: quiet })
  assert.equal(first.ok, true, `首推应成功：${first.error}`)
  assert.equal(first.forced, undefined, '首推不是强推路径')

  // 续推：上次推送的 tip 就是本次 HEAD 的祖先（健康路径，也是浅仓库下 git
  // 可能把快进误判成非快进的场景）→ 走「远端 ⊆ 本机 HEAD → 安全强推」。
  seedPack(work, 'p2')
  const res = commitAndPush({ root: work, branch: 'farm/test', slugs: ['p2'], pushAttempts: 1, log: quiet })
  assert.equal(res.ok, true, `续推应成功：${res.error}`)
  assert.equal(res.forced, true, '应走安全强推路径')
  assert.equal(g(bare, ['rev-parse', 'farm/test']), g(work, ['rev-parse', 'HEAD']))
  // 强推不能丢先前已入库的内容。
  const files = g(bare, ['ls-tree', '-r', '--name-only', 'farm/test']).split('\n').filter(Boolean)
  assert.ok(files.includes('patches/p1/config/ftbquests/quests/lang/zh_cn.snbt'))
  assert.ok(files.includes('patches/p2/config/ftbquests/quests/lang/zh_cn.snbt'))
  rmSync(base, { recursive: true, force: true })
})

test('commitAndPush：远端与本机分叉且 rebase 冲突 → 如实报败，绝不强推覆盖（交接 §2.5）', { skip: SKIP_NO_GIT }, () => {
  const { base, bare, work } = setup()
  seedPack(work, 'p1')
  assert.equal(commitAndPush({ root: work, branch: 'farm/test', slugs: ['p1'], pushAttempts: 1, log: quiet }).ok, true)

  // 另一台主机改了同一个包的同一份文件并推上远端。
  const other = join(base, 'other')
  g(base, ['clone', '-q', '-b', 'farm/test', bare.replace(/\\/g, '/'), other])
  g(other, ['config', 'user.email', 'other@test.local'])
  g(other, ['config', 'user.name', 'other'])
  g(other, ['config', 'commit.gpgsign', 'false'])
  const p1Path = join(other, 'patches/p1/config/ftbquests/quests/lang/zh_cn.snbt')
  writeFileSync(p1Path, '{ "other-version" }\n')
  g(other, ['add', '--', 'patches/p1'])
  g(other, ['commit', '-q', '-m', 'other: 改 p1'])
  g(other, ['push', '-q', 'origin', 'HEAD:refs/heads/farm/test'])
  const remoteTipAfterOther = g(bare, ['rev-parse', 'farm/test'])

  // 本机改同一文件（不预提交，由 commitAndPush 自己暂存提交）：rebase 必然冲突。
  // 此时远端可能有未收割内容，正确行为是报败停机，而不是像 §2.5 事故里那样靠 push -f 绕过。
  writeFileSync(join(work, 'patches/p1/config/ftbquests/quests/lang/zh_cn.snbt'), '{ "local-version" }\n')

  const res = commitAndPush({ root: work, branch: 'farm/test', slugs: ['p1'], pushAttempts: 2, retryDelayMs: 0, log: quiet })
  assert.equal(res.ok, false, 'rebase 冲突必须报败而不是覆盖远端')
  assert.equal(g(bare, ['rev-parse', 'farm/test']), remoteTipAfterOther, '远端分支不能被动过')
  assert.match(
    g(bare, ['show', 'farm/test:patches/p1/config/ftbquests/quests/lang/zh_cn.snbt']),
    /other-version/,
    '别台主机的未收割内容必须原样保留',
  )
  rmSync(base, { recursive: true, force: true })
})

test('commitAndPush：推不上去时返回 ok=false 并带上 stderr（不抛）', { skip: SKIP_NO_GIT }, () => {
  const { base, work } = setup()
  seedPack(work, 'p1')
  // 把 origin 指到一个不存在的地方：push 必然失败。
  g(work, ['remote', 'set-url', 'origin', join(base, 'nope.git').replace(/\\/g, '/')])

  const res = commitAndPush({ root: work, branch: 'farm/test', slugs: ['p1'], pushAttempts: 2, retryDelayMs: 0, log: quiet })
  assert.equal(res.ok, false)
  assert.equal(res.committed, 1, '提交本身是成功的，失败的只是推送')
  assert.equal(res.attempts, 2)
  assert.match(res.error, /does not appear to be a git repository|No such file|could not read|not found/i)
  rmSync(base, { recursive: true, force: true })
})

test('pre-push 钩子：拦 main，放行 farm/*', { skip: SKIP_NO_GIT }, () => {
  const { base, bare, work } = setup()
  mkdirSync(join(work, '.git/hooks'), { recursive: true })
  // 直接装仓库里的那份钩子（测的是真实文件，不是重写一份逻辑）。
  writeFileSync(join(work, '.git/hooks/pre-push'), readFileSync(new URL('./farm-pre-push.sh', import.meta.url), 'utf8'))
  try { execFileSync('chmod', ['755', join(work, '.git/hooks/pre-push')], { stdio: 'ignore' }) } catch { /* Windows 上 chmod 是空操作 */ }

  seedPack(work, 'p1')
  g(work, ['add', '--', 'patches/p1', 'research/packs/p1.tar.gz'])
  g(work, ['commit', '-q', '-m', 'p1'])

  assert.throws(
    () => g(work, ['push', 'origin', 'HEAD:refs/heads/main']),
    '钩子必须拦住指向 main 的推送',
  )
  assert.equal(g(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads']), '', 'main 不该被推上去')
  // 同一份提交推到自己的 farm 分支是允许的。
  g(work, ['push', '-q', 'origin', 'HEAD:refs/heads/farm/test'])
  assert.match(g(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads']), /refs\/heads\/farm\/test/)
  rmSync(base, { recursive: true, force: true })
})
