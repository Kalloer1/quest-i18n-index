import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMirror, readMirrors, writeMirrors, makeUploader } from './mirror.mjs'
import { STATUS } from '../shared/quest-status.mjs'
import { defaultReportStatus } from './lib/report-status.mjs'

// 工单 04：镜像核心逻辑。全部用桩，不联网、不真上传。

function targets(dir, slugs) {
  return slugs.map((slug) => {
    const zipPath = join(dir, `${slug}.zip`)
    writeFileSync(zipPath, 'zip-bytes')
    return { slug, zipPath }
  })
}

test('上传成功：写回真实 share_url', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-'))
  try {
    const t = targets(dir, ['a', 'b'])
    const { results, succeeded } = await runMirror({
      targets: t,
      upload: async (slug) => `https://pan.quark.cn/s/${slug}`,
    })
    assert.equal(succeeded, 2)
    assert.equal(results.a, 'https://pan.quark.cn/s/a')
    assert.equal(results.b, 'https://pan.quark.cn/s/b')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('失败不阻断：单条失败该条留空（quark: \'\'），其余照常成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-'))
  try {
    const t = targets(dir, ['ok1', 'bad', 'ok2'])
    const { results, succeeded, failed } = await runMirror({
      targets: t,
      upload: async (slug) => {
        if (slug === 'bad') throw new Error('上传失败')
        return `https://pan.quark.cn/s/${slug}`
      },
    })
    assert.equal(failed, 1)
    assert.equal(succeeded, 2)
    assert.equal(results.bad, '', '失败条目必须留空字符串，绝不伪造链接')
    assert.equal(results.ok2, 'https://pan.quark.cn/s/ok2')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('绝不伪造：upload 返回空字符串视为失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-'))
  try {
    const [t] = targets(dir, ['x'])
    const { results, failed } = await runMirror({
      targets: [t],
      upload: async () => '',
    })
    assert.equal(failed, 1)
    assert.equal(results.x, '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('幂等：已有分享链接的条目直接跳过，不再上传', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-'))
  try {
    const t = targets(dir, ['a', 'b'])
    let calls = 0
    const { results, skipped, attempted } = await runMirror({
      targets: t,
      existing: { a: 'https://pan.quark.cn/s/old' },
      upload: async (slug) => { calls++; return `https://pan.quark.cn/s/${slug}` },
    })
    assert.equal(calls, 1)
    assert.equal(attempted, 1)
    assert.equal(skipped, 1)
    assert.equal(results.a, 'https://pan.quark.cn/s/old', '已有链接原样保留')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('逐条串行 + 每条之间限流', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-'))
  try {
    const t = targets(dir, ['a', 'b', 'c'])
    const order = []
    let running = 0, maxConcurrent = 0
    const { results } = await runMirror({
      targets: t,
      rateLimitMs: 5,
      upload: async (slug) => {
        running++
        maxConcurrent = Math.max(maxConcurrent, running)
        await new Promise(r => setTimeout(r, 5))
        running--
        order.push(slug)
        return `https://pan.quark.cn/s/${slug}`
      },
    })
    assert.equal(maxConcurrent, 1, '必须串行，不允许并发上传')
    assert.deepEqual(order, ['a', 'b', 'c'], '按输入顺序逐条处理')
    assert.equal(Object.keys(results).length, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('zip 文件缺失：该条留空并跳过，不算失败', async () => {
  const { results, attempted, failed } = await runMirror({
    targets: [{ slug: 'ghost', zipPath: join(tmpdir(), 'no-such-zip.zip') }],
    upload: async () => { throw new Error('不应被调用') },
  })
  assert.equal(attempted, 0)
  assert.equal(failed, 0)
  assert.equal(results.ghost, '')
})

// ---------- 写回 research/quark-mirrors.json ----------

test('writeMirrors/readMirrors 往返：成功写真实链接，失败留空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-'))
  const file = join(dir, 'quark-mirrors.json')
  try {
    writeMirrors({ a: 'https://pan.quark.cn/s/a', b: '' }, file, { now: 'T1' })
    const m = readMirrors(file)
    assert.equal(m.a, 'https://pan.quark.cn/s/a')
    assert.equal(m.b, '', '失败条目登记为空，不伪造')
    assert.ok(existsSync(file))

    // 幂等追加：第二次只更新新条目，不抹历史
    writeMirrors({ c: 'https://pan.quark.cn/s/c' }, file, { now: 'T2' })
    const m2 = readMirrors(file)
    assert.equal(m2.a, 'https://pan.quark.cn/s/a')
    assert.equal(m2.c, 'https://pan.quark.cn/s/c')

    // 历史上有链接的条目本轮失败：保留旧链接（不倒退为空）
    writeMirrors({ a: '' }, file, { now: 'T3' })
    assert.equal(readMirrors(file).a, 'https://pan.quark.cn/s/a')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.updatedAt, 'T3')
    assert.equal(raw.mirrors.a.updatedAt, 'T1')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------- 队列状态回写（回归：mirror 不回写，「镜像缺失」是死代码） ----------

test('回写：镜像成功条目 → 已完成', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-'))
  try {
    const t = targets(dir, ['a'])
    const posted = []
    await runMirror({
      targets: t,
      upload: async (slug) => `https://pan.quark.cn/s/${slug}`,
      reportStatus: async (id, payload) => { posted.push([id, payload]) },
    })
    assert.equal(posted.length, 1)
    assert.equal(posted[0][0], 'a')
    assert.equal(posted[0][1].status, STATUS.DONE)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('回写：镜像失败条目 → 镜像缺失，且带 error 原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-'))
  try {
    const t = targets(dir, ['bad'])
    const posted = []
    await runMirror({
      targets: t,
      upload: async () => { throw new Error('登录态过期') },
      reportStatus: async (id, payload) => { posted.push([id, payload]) },
    })
    assert.equal(posted[0][1].status, STATUS.DONE_UNMIRRORED)
    assert.match(posted[0][1].error, /登录态过期/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('回写：zip 缺失（留空）条目 → 镜像缺失', async () => {
  const posted = []
  await runMirror({
    targets: [{ slug: 'ghost', zipPath: join(tmpdir(), 'no-such-zip.zip') }],
    upload: async () => { throw new Error('不应被调用') },
    reportStatus: async (id, payload) => { posted.push([id, payload]) },
  })
  assert.equal(posted[0][1].status, STATUS.DONE_UNMIRRORED)
  assert.match(posted[0][1].error, /找不到补丁包/)
})

test('回写失败绝不阻断镜像：reportStatus 抛错时镜像结果照常产出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-'))
  try {
    const t = targets(dir, ['a', 'b'])
    const { results, succeeded } = await runMirror({
      targets: t,
      upload: async (slug) => `https://pan.quark.cn/s/${slug}`,
      reportStatus: async () => { throw new Error('回写炸了') },
    })
    assert.equal(succeeded, 2)
    assert.equal(results.a, 'https://pan.quark.cn/s/a')
    assert.equal(results.b, 'https://pan.quark.cn/s/b')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('未配置 WORKER_URL/token 时 defaultReportStatus 不发请求、不报错', async () => {
  let called = false
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => { called = true; throw new Error('不应调用') }
  try {
    await runMirror({
      targets: [{ slug: 'ghost', zipPath: join(tmpdir(), 'no-such-zip.zip') }],
      upload: async () => { throw new Error('不应被调用') },
      reportStatus: (id, payload) => defaultReportStatus(id, payload, { workerUrl: '', token: '' }),
    })
  } finally {
    globalThis.fetch = origFetch
  }
  assert.equal(called, false)
})

// ---- makeUploader：CLI 参数形状（回归：QUARK_PARENT_FID 被 workflow 传了但脚本从不读）----

/** 造一个假 CLI 调用器，记录每次调用的 args，并按命令返回预设 data。 */
function fakeCall(overrides = {}) {
  const calls = []
  const call = (_cli, args) => {
    calls.push(args)
    const cmd = args[0]
    if (cmd === 'create-folder') return { fid: 'DIR_FID', full_path: '夸克网盘/整合包汉化' }
    if (cmd === 'upload') return { fids: ['FILE_FID'] }
    if (cmd === 'share') return { share_url: 'https://pan.quark.cn/s/abc' }
    return overrides[cmd] ?? {}
  }
  return { call, calls }
}

test('makeUploader：给了 parentFid 时 create-folder 必须带 --parent-fid', async () => {
  const { call, calls } = fakeCall()
  const upload = makeUploader('/cli.cjs', '整合包汉化', '/cwd', { parentFid: 'PARENT_FID', call })
  const url = await upload('demo', '/downloads/demo.zip')

  assert.equal(url, 'https://pan.quark.cn/s/abc')
  assert.deepEqual(calls[0], ['create-folder', '--dir-path', '整合包汉化', '--parent-fid', 'PARENT_FID'])
  assert.deepEqual(calls[1], ['upload', '/downloads/demo.zip', '--parent-fid', 'DIR_FID'])
})

test('makeUploader：没给 parentFid 时不带 --parent-fid（沿用 CLI 服务端默认目录）', async () => {
  const { call, calls } = fakeCall()
  const upload = makeUploader('/cli.cjs', '整合包汉化', '/cwd', { call })
  await upload('demo', '/downloads/demo.zip')

  assert.deepEqual(calls[0], ['create-folder', '--dir-path', '整合包汉化'])
})

test('makeUploader：目录 fid 只解析一次，多条复用（不重复建目录）', async () => {
  const { call, calls } = fakeCall()
  const upload = makeUploader('/cli.cjs', '整合包汉化', '/cwd', { parentFid: 'P', call })
  await upload('a', '/downloads/a.zip')
  await upload('b', '/downloads/b.zip')

  assert.equal(calls.filter((c) => c[0] === 'create-folder').length, 1)
  assert.equal(calls.filter((c) => c[0] === 'upload').length, 2)
})

test('makeUploader：create-folder 未返回 fid 时报错（不静默继续）', async () => {
  const call = (_cli, args) => (args[0] === 'create-folder' ? {} : {})
  const upload = makeUploader('/cli.cjs', 'd', '/cwd', { call })
  await assert.rejects(() => upload('demo', '/downloads/demo.zip'), /create-folder 未返回 fid/)
})

test('makeUploader：share 未返回 share_url 时报错（绝不伪造链接）', async () => {
  const call = (_cli, args) => {
    if (args[0] === 'create-folder') return { fid: 'D' }
    if (args[0] === 'upload') return { fids: ['F'] }
    return {}
  }
  const upload = makeUploader('/cli.cjs', 'd', '/cwd', { call })
  await assert.rejects(() => upload('demo', '/downloads/demo.zip'), /share 未返回 share_url/)
})
