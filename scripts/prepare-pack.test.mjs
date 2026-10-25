/**
 * prepare-pack.mjs 的单测：按 slug 取 CurseForge 最新文件 → 只解任务书文件到
 * `research/packs/<slug>/`。全部用 fetch 桩，不联网。
 *
 * 这条链路此前完全缺失（实跑 run 39165439848：Translate 以「找不到整合包文件」失败），
 * 故测试要守住「pipeline 的 loadPack 能读到解出的 .snbt」这个唯一目的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import {
  preparePack, resolveLatestFile, downloadUrlOf, cfIdOf,
  authoritativeQuestNames, compareWithAuthoritative, pruneStaleFiles, rewriteCdnHost,
} from './prepare-pack.mjs'
import { classifyLayout, LAYOUT } from './lib/candidates.mjs'
import { parse } from './snbt.mjs'

/** 与 prepare-pack.mjs 的 listSnbt 同口径：递归列 .snbt（相对路径）——测试里要看「目录实况」。 */
function snbtNames(dir, base = dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...snbtNames(full, base))
    else if (/\.snbt$/i.test(name)) out.push(relative(base, full).replace(/\\/g, '/'))
  }
  return out.sort()
}

// ---------- 合成 zip（与 extract-pack.test.mjs 同构，仅本文件所需的最小子集） ----------

function buildZip(files) {
  const chunks = []
  const central = []
  let offset = 0
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const data = Buffer.from(f.data, 'utf8')
    const comp = deflateRawSync(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, comp)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt32LE(comp.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)

    offset += local.length + nameBuf.length + comp.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cdBuf, eocd])
}

/** 一个带分离·单文件布局任务书的假整合包。 */
const PACK_ZIP = buildZip([
  { name: 'Demo-1.0/overrides/config/ftbquests/quests/lang/en_us.snbt', data: '{\n\tquest_a_title: "Hi"\n}' },
  { name: 'Demo-1.0/overrides/config/ftbquests/quests/data.snbt', data: '{ }\n' },
  { name: 'Demo-1.0/overrides/mods/example.jar', data: 'not-a-quest-file' },
])

/**
 * 按 URL 分派的 fetch 桩：文件列表端点返回 CF 形状，其余返回 zip 字节。
 *
 * HEAD 会返回 content-length（所以 `listZip` 的 HEAD 这步能过），但**忽略 Range 头** ——
 * 于是清单在「Range 未返回 206」这步失败，正好模拟真实 CDN 不支持 Range 的样子。
 * `bodies` 只在 `arrayBuffer()` 真被调用时记一笔：判断「有没有下载整包」要看它，
 * 而不是看请求列表（失败在被拒阶段的 Range 请求并不产生字节）。
 */
function stubFetch({ zip = PACK_ZIP, downloadUrl = 'https://cdn.example/files/demo.zip', fileLength = 1024, fileDate = null, calls = [], bodies = [] } = {}) {
  return async (url, init = {}) => {
    const u = String(url)
    const method = String(init?.method ?? 'GET').toUpperCase()
    calls.push({ url: u, method })
    if (u.includes('/files?pageSize=1')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 7, fileName: 'Demo-1.0.zip', fileLength, downloadUrl, fileDate }],
        }),
      }
    }
    return {
      ok: true,
      status: 200,
      url: u,
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(zip.length) : null) },
      arrayBuffer: async () => {
        bodies.push({ url: u, method })
        return zip
      },
    }
  }
}

/**
 * 支持 HEAD + Range 的桩（`listZip` 能跑通）：HEAD 给总长，带 Range 头按切片回 206。
 * 用来测「权威清单能拿到」时的判定与裁剪。
 */
function listingStub({ zip = PACK_ZIP, downloadUrl = 'https://cdn.example/files/demo.zip', calls = [], bodies = [] } = {}) {
  const base = stubFetch({ zip, downloadUrl, calls, bodies })
  return async (url, init = {}) => {
    const u = String(url)
    const method = String(init?.method ?? 'GET').toUpperCase()
    if (u.includes('/files?pageSize=1')) return base(url, init)
    if (method === 'HEAD') {
      calls.push({ url: u, method })
      return {
        ok: true,
        status: 200,
        url: u,
        headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(zip.length) : null) },
        arrayBuffer: async () => Buffer.alloc(0),
      }
    }
    const range = init?.headers?.Range ?? init?.headers?.range ?? null
    if (!range) return base(url, init)
    const m = /bytes=(\d+)-(\d+)/.exec(range)
    if (!m) return { ok: false, status: 416, url: u, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) }
    const start = Number(m[1])
    const end = Math.min(Number(m[2]), zip.length - 1)
    if (start > end) return { ok: false, status: 416, url: u, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) }
    return {
      ok: true,
      status: 206,
      url: u,
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(end - start + 1) : null) },
      arrayBuffer: async () => zip.subarray(start, end + 1),
    }
  }
}

function tempDirs() {
  const root = mkdtempSync(join(tmpdir(), 'prepare-pack-'))
  return {
    root,
    packsDir: join(root, 'research', 'packs'),
    tmpDir: join(root, 'research', 'tmp'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// ---------- 纯函数 ----------

test('cfIdOf：从数据集记录取 cfId，缺记录或空值返回 null', () => {
  const records = [{ slug: 'demo', cfId: '1514778' }, { slug: 'empty', cfId: '' }]
  assert.equal(cfIdOf(records, 'demo'), '1514778')
  assert.equal(cfIdOf(records, 'empty'), null)
  assert.equal(cfIdOf(records, 'missing'), null)
  assert.equal(cfIdOf(undefined, 'demo'), null)
})

test('downloadUrlOf：没有 downloadUrl 时明确报错，不猜替代地址', () => {
  assert.equal(downloadUrlOf({ downloadUrl: ' https://cdn.example/a.zip ' }), 'https://cdn.example/a.zip')
  assert.throws(() => downloadUrlOf({ downloadUrl: null }), /downloadUrl/)
  assert.throws(() => downloadUrlOf(null), /downloadUrl/)
})

test('downloadUrlOf：nodl 兜底 —— id+fileName 按 CF CDN 路径规则拼直链，主机改写到 mediafiles', () => {
  // CF 官方 CDN 路径规则：files/{floor(id/1000)}/{id%1000}/{fileName}
  const url = downloadUrlOf({ id: 1234567, fileName: 'Some Pack 1.0.0.zip' })
  assert.equal(url, 'https://mediafiles.forgecdn.net/files/1234/567/Some%20Pack%201.0.0.zip')
})

test('downloadUrlOf：nodl 兜底 —— 边界不猜（id 非法或 fileName 缺失时仍报错）', () => {
  assert.throws(() => downloadUrlOf({ id: 0, fileName: 'a.zip' }), /downloadUrl/)
  assert.throws(() => downloadUrlOf({ id: 1234567, fileName: '  ' }), /downloadUrl/)
  assert.throws(() => downloadUrlOf({ fileName: 'a.zip' }), /downloadUrl/)
  assert.throws(() => downloadUrlOf({ id: 1234567 }), /downloadUrl/)
})

test('rewriteCdnHost：把 forgecdn 系主机统一改写成可达的 mediafiles.forgecdn.net', () => {
  // 2026-10-24 实测：mediafilez 直连超时、经代理 CONNECT 失败；mediafiles（同一份对象、
  // 支持 Range）可达。任何 forgecdn 主机名（edge / mediafilez）都统一改写到 mediafiles。
  assert.equal(
    rewriteCdnHost('https://edge.forgecdn.net/files/8989/794/x.zip'),
    'https://mediafiles.forgecdn.net/files/8989/794/x.zip',
  )
  assert.equal(
    rewriteCdnHost('http://edge.forgecdn.net/files/1/2/y.zip'),
    'http://mediafiles.forgecdn.net/files/1/2/y.zip',
  )
  // 已在 mediafilez 的也改写（它同样可能不可达）
  assert.equal(
    rewriteCdnHost('https://mediafilez.forgecdn.net/files/1/2/y.zip'),
    'https://mediafiles.forgecdn.net/files/1/2/y.zip',
  )
  // 别的域名不动
  assert.equal(rewriteCdnHost('https://cdn.example/a.zip'), 'https://cdn.example/a.zip')
})

test('resolveLatestFile：取最新文件的地址、文件名与体积', async () => {
  const file = await resolveLatestFile('1514778', { apiKey: 'k', fetchImpl: stubFetch({ fileLength: 2455660 }) })
  assert.equal(file.url, 'https://cdn.example/files/demo.zip')
  assert.equal(file.fileName, 'Demo-1.0.zip')
  assert.equal(file.fileLength, 2455660)
  // 版本溯源：CF files 条目的 id / fileDate，拿不到就是 null（不猜字段）
  assert.equal(file.fileId, 7)
  assert.equal(file.fileDate, null)
})

test('resolveLatestFile：从 files 条目取 fileId 与 fileDate', async () => {
  const file = await resolveLatestFile('1514778', {
    apiKey: 'k',
    fetchImpl: stubFetch({ fileDate: '2026-09-01T00:00:00Z' }),
  })
  assert.equal(file.fileId, 7)
  assert.equal(file.fileDate, '2026-09-01T00:00:00Z')
})

test('resolveLatestFile：缺 CF_KEY 明确失败（不静默跳过）', async () => {
  await assert.rejects(() => resolveLatestFile('1514778', { apiKey: '' }), /CF_KEY/)
})

test('resolveLatestFile：项目没有任何文件时明确报错', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })
  await assert.rejects(() => resolveLatestFile('1', { apiKey: 'k', fetchImpl }), /没有任何文件/)
})

// ---------- preparePack ----------

test('preparePack：只解任务书文件到 research/packs/<slug>/，布局可被 classifyLayout 判定', async () => {
  const dirs = tempDirs()
  try {
    const result = await preparePack({
      slug: 'demo', cfId: '1514778', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: stubFetch(),
    })
    assert.equal(result.status, 'prepared')
    assert.equal(result.layout, LAYOUT.SEPARATE_SINGLE)

    const langPath = join(dirs.packsDir, 'demo', 'config/ftbquests/quests/lang/en_us.snbt')
    assert.ok(existsSync(langPath), '应解出 lang/en_us.snbt')
    assert.equal(readFileSync(langPath, 'utf8'), '{\n\tquest_a_title: "Hi"\n}')
    // 非任务书文件（mods/*.jar）不解出
    assert.ok(!existsSync(join(dirs.packsDir, 'demo', 'mods')))
    // zip 留在 research/tmp/ 便于复现
    assert.ok(existsSync(join(dirs.tmpDir, 'demo.zip')))
  } finally { dirs.cleanup() }
})

test('preparePack：修复链修不活的文件单文件跳过（改名 .skipped + 记账清单）', async () => {
  const dirs = tempDirs()
  try {
    // garbage.snbt 是 linggango 形态：整文件一行 `LGQ1:<blob>` 垃圾，11 规则零命中；
    // fixable.snbt 是 lindenfeld 形态：规则⑥可修的空值条目。
    const zip = buildZip([
      { name: 'Demo-1.0/overrides/config/ftbquests/quests/lang/en_us.snbt', data: '{\n\tquest_a_title: "Hi"\n}' },
      { name: 'Demo-1.0/overrides/config/ftbquests/quests/chapters/garbage.snbt', data: 'LGQ1:' + 'A'.repeat(300) + '\n' },
      { name: 'Demo-1.0/overrides/config/ftbquests/quests/chapters/fixable.snbt', data: '{\n\tdependencies: \n\tquest_links: [ ]\n}\n' },
    ])
    const logs = []
    const result = await preparePack({
      slug: 'demo', cfId: '1514778', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: stubFetch({ zip }), log: (m) => logs.push(m),
    })
    assert.equal(result.status, 'prepared')
    const base = join(dirs.packsDir, 'demo', 'config/ftbquests/quests/chapters')
    // 不可修复：改名保留原文，原路径不再有 .snbt
    assert.ok(existsSync(join(base, 'garbage.snbt.skipped')), '垃圾文件应改名 .skipped 保留')
    assert.match(readFileSync(join(base, 'garbage.snbt.skipped'), 'utf8'), /^LGQ1:/)
    assert.ok(!existsSync(join(base, 'garbage.snbt')), '原路径不应残留可解析失败的 .snbt')
    // 可修复：规则⑥修活，正常保留
    assert.ok(existsSync(join(base, 'fixable.snbt')), '可修复文件应留在原地')
    // 记账清单
    const manifest = JSON.parse(readFileSync(join(dirs.packsDir, 'demo', '.skipped-files.json'), 'utf8'))
    assert.equal(manifest.skipped.length, 1)
    assert.equal(manifest.skipped[0].file, 'config/ftbquests/quests/chapters/garbage.snbt')
    assert.match(manifest.skipped[0].error, /无法解析|LGQ1|末尾|多余/)
    assert.ok(manifest.skipped[0].at)
    assert.match(logs.join('\n'), /单文件跳过/)
  } finally { dirs.cleanup() }
})

test('preparePack：跳过记账幂等——重跑合并清单且不丢早先记录', async () => {
  const dirs = tempDirs()
  try {
    const zip = buildZip([
      { name: 'Demo-1.0/overrides/config/ftbquests/quests/lang/en_us.snbt', data: '{\n\tquest_a_title: "Hi"\n}' },
      { name: 'Demo-1.0/overrides/config/ftbquests/quests/chapters/garbage.snbt', data: 'LGQ1:' + 'B'.repeat(50) + '\n' },
    ])
    const common = {
      slug: 'demo', cfId: '1514778', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: stubFetch({ zip }),
    }
    await preparePack({ ...common, log: () => {} })
    // 第二次 --force 重解包：垃圾文件重新出现、重新跳过，清单去重不翻倍
    await preparePack({ ...common, force: true, log: () => {} })
    const manifest = JSON.parse(readFileSync(join(dirs.packsDir, 'demo', '.skipped-files.json'), 'utf8'))
    assert.equal(manifest.skipped.length, 1, '同文件重复跳过只记一笔')
  } finally { dirs.cleanup() }
})

test('preparePack：写 research/packs/<slug>/.source.json（整包模式）', async () => {
  const dirs = tempDirs()
  try {
    await preparePack({
      slug: 'demo', cfId: '1514778', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: stubFetch({ fileDate: '2026-09-01T00:00:00Z' }),
    })
    const info = JSON.parse(readFileSync(join(dirs.packsDir, 'demo', '.source.json'), 'utf8'))
    assert.equal(info.slug, 'demo')
    assert.equal(info.platform, 'cf')
    assert.equal(info.fileId, 7)
    assert.equal(info.fileName, 'Demo-1.0.zip')
    assert.equal(info.fileDate, '2026-09-01T00:00:00Z')
    assert.match(info.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(info.recovered, false)
  } finally { dirs.cleanup() }
})

test('preparePack：已有任务书文件时跳过下载（幂等），不下载整包', async () => {
  const dirs = tempDirs()
  try {
    const outDir = join(dirs.packsDir, 'demo', 'config/ftbquests/quests/lang')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'en_us.snbt'), '{\n\tquest_a_title: "Hi"\n}')

    const calls = []
    const bodies = []
    const logs = []
    const result = await preparePack({
      slug: 'demo', cfId: '1514778', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: stubFetch({ calls, bodies }),
      log: (m) => logs.push(m),
    })
    assert.equal(result.status, 'skipped')
    // 1 次文件列表请求（要知道权威源是谁）+ 1 次 HEAD + 1 次注定被拒的 Range ——
    // 桩忽略 Range 头回 200，`getRange` 因「未返回 206」失败，于是清单拿不到。
    assert.deepEqual(calls.map((c) => c.method), ['GET', 'HEAD', 'GET'])
    assert.deepEqual(bodies, [], '跳过时不该拉走任何 zip 字节')
    assert.match(logs.join('\n'), /权威清单取不到/, '清单拿不到要明说，不能静默当成一致')
    // 本地副本一个字节都不能动
    assert.equal(readFileSync(join(outDir, 'en_us.snbt'), 'utf8'), '{\n\tquest_a_title: "Hi"\n}')
  } finally { dirs.cleanup() }
})

test('preparePack：跳过下载时也写 .source.json（失败重试 / 中断残包重跑就走这条分支）', async () => {
  const dirs = tempDirs()
  try {
    // 目录里已有产物（farm 打包后才删目录，重试时目录还在）→ 走幂等跳过分支
    const langDir = join(dirs.packsDir, 'demo', 'config/ftbquests/quests/lang')
    mkdirSync(langDir, { recursive: true })
    writeFileSync(join(langDir, 'en_us.snbt'), '{\n\tquest_a_title: "Hi"\n}')

    const calls = []
    const bodies = []
    const result = await preparePack({
      slug: 'demo', cfId: '1514778', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: stubFetch({ calls, bodies, fileDate: '2026-09-01T00:00:00Z' }),
    })
    assert.equal(result.status, 'skipped')

    // 版本必须落盘 —— 不写的话这些包永远产不出 `.source.json`（8 台 worker 实测一次都没写出）
    const info = JSON.parse(readFileSync(join(dirs.packsDir, 'demo', '.source.json'), 'utf8'))
    assert.equal(info.slug, 'demo')
    assert.equal(info.platform, 'cf')
    assert.equal(info.fileId, 7)
    assert.equal(info.fileName, 'Demo-1.0.zip')
    assert.equal(info.fileDate, '2026-09-01T00:00:00Z')
    assert.match(info.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(info.recovered, false)

    // 复用**当次** resolveLatestFile 的结果：不因写版本多发一次文件列表请求
    assert.equal(calls.filter((c) => String(c.url).includes('/files?pageSize=1')).length, 1)
    assert.deepEqual(bodies, [], '跳过时不该拉走任何 zip 字节')
    // 本地副本一个字节都不能动，也不能凭空多出 zip
    assert.equal(readFileSync(join(langDir, 'en_us.snbt'), 'utf8'), '{\n\tquest_a_title: "Hi"\n}')
    assert.ok(!existsSync(join(dirs.tmpDir, 'demo.zip')))
  } finally { dirs.cleanup() }
})

test('preparePack：目录实况与权威清单一致时跳过下载，一个 zip 字节都不拉', async () => {
  const dirs = tempDirs()
  try {
    // 整包路解出的完整形态：lang/en_us.snbt + data.snbt（与 PACK_ZIP 的权威清单一致）
    const questsDir = join(dirs.packsDir, 'demo', 'config/ftbquests/quests')
    mkdirSync(join(questsDir, 'lang'), { recursive: true })
    writeFileSync(join(questsDir, 'lang/en_us.snbt'), '{\n\tquest_a_title: "Hi"\n}')
    writeFileSync(join(questsDir, 'data.snbt'), '{ }\n')

    const calls = []
    const bodies = []
    const result = await preparePack({
      slug: 'demo', cfId: '1514778', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: listingStub({ calls, bodies }),
    })
    assert.equal(result.status, 'skipped')
    assert.equal(result.layout, LAYOUT.SEPARATE_SINGLE)
    // 清单一致而跳过，同样要留下版本记录（两条 skip 分支同一口径）
    assert.ok(existsSync(join(dirs.packsDir, 'demo', '.source.json')))
    assert.deepEqual(bodies.filter((b) => b.method === 'GET'), [], '一致时连整包 GET 都不该发')
    // 只花清单的钱：1 次 API + 1 次 HEAD + 2 次中央目录 Range
    assert.equal(calls.filter((c) => c.method === 'HEAD').length, 1)
    assert.equal(calls.filter((c) => c.method === 'GET' && String(c.url).includes('/files?pageSize=1')).length, 1)
  } finally { dirs.cleanup() }
})

test('preparePack：--force 忽略已有文件，重新下载解包', async () => {
  const dirs = tempDirs()
  try {
    const outDir = join(dirs.packsDir, 'demo', 'config/ftbquests/quests/lang')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'en_us.snbt'), 'stale')

    const calls = []
    const result = await preparePack({
      slug: 'demo', cfId: '1514778', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      force: true, fetchImpl: stubFetch({ calls }),
    })
    assert.equal(result.status, 'prepared')
    assert.ok(calls.length >= 2, '应重新请求文件列表并下载')
    assert.equal(readFileSync(join(outDir, 'en_us.snbt'), 'utf8'), '{\n\tquest_a_title: "Hi"\n}')
  } finally { dirs.cleanup() }
})

test('preparePack：解出的文件能被 classifyLayout 认出可翻译的英文源', async () => {
  const dirs = tempDirs()
  try {
    await preparePack({
      slug: 'demo', cfId: '1', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: stubFetch(),
    })
    const written = ['config/ftbquests/quests/lang/en_us.snbt']
    const info = classifyLayout(written)
    assert.equal(info.layout, LAYOUT.SEPARATE_SINGLE)
    assert.equal(info.enFiles, 1)
    assert.equal(info.zhFiles, 0)
  } finally { dirs.cleanup() }
})

// ---------- 残留旧文件的稳健性（ADR-0009 P1） ----------
//
// 背景：`research/packs/<slug>/` 的英文源是 `validate-quests.mjs` 的基准键集，
// 下游 `loadPackUnits` / `pipeline.loadPack` / `resolveLayout` 又都按**目录实况**跑
// `classifyLayout`。所以目录里一旦混进上一次不同来源的文件，取源就会被带偏 ——
// 实测 5 个已发布包（peace-of-mind-21-1 等）就是因此走了内嵌路。
// 下面几条锁住「取源后目录实况 == 本次权威取源」这个不变量。

test('authoritativeQuestNames：权威 zip 清单 → 落盘路径集（剥包装目录、去重排序）', () => {
  assert.deepEqual(authoritativeQuestNames([
    'Demo-1.0/overrides/config/ftbquests/quests/lang/en_us.snbt',
    'Demo-1.0/overrides/config/ftbquests/quests/data.snbt',
    'Demo-1.0/overrides/mods/big.jar', // 非任务书文件不进清单
    'Demo-1.0/overrides/mods/', // 目录条目也不进
  ]), [
    'config/ftbquests/quests/data.snbt',
    'config/ftbquests/quests/lang/en_us.snbt',
  ])
})

test('compareWithAuthoritative：目录多出上一次来源的文件 = 不新鲜，并点名叫出残留', () => {
  const r = compareWithAuthoritative(
    ['config/ftbquests/quests/lang/en_us.snbt', 'config/ftbquests/quests/chapters/old.snbt'],
    ['config/ftbquests/quests/lang/en_us.snbt'],
  )
  assert.equal(r.fresh, false)
  assert.deepEqual(r.stale, ['config/ftbquests/quests/chapters/old.snbt'])
  assert.deepEqual(r.missing, [])
})

test('compareWithAuthoritative：集合相等（顺序无关）算新鲜；缺文件算不新鲜', () => {
  assert.equal(compareWithAuthoritative(['b.snbt', 'a.snbt'], ['a.snbt', 'b.snbt']).fresh, true)
  const r = compareWithAuthoritative(['a.snbt'], ['a.snbt', 'b.snbt'])
  assert.equal(r.fresh, false)
  assert.deepEqual(r.missing, ['b.snbt'])
  assert.deepEqual(r.stale, [])
})

test('pruneStaleFiles：只删不属于本次取源的文件，留下的与 written 逐条一致', () => {
  const dirs = tempDirs()
  try {
    const outDir = join(dirs.packsDir, 'demo', 'config/ftbquests/quests')
    mkdirSync(join(outDir, 'chapters'), { recursive: true })
    mkdirSync(join(outDir, 'lang'), { recursive: true })
    writeFileSync(join(outDir, 'lang/en_us.snbt'), 'fresh')
    writeFileSync(join(outDir, 'chapters/old.snbt'), 'stale')

    const removed = pruneStaleFiles(outDir, ['lang/en_us.snbt'])
    assert.deepEqual(removed, ['chapters/old.snbt'])
    assert.equal(readFileSync(join(outDir, 'lang/en_us.snbt'), 'utf8'), 'fresh')
    assert.equal(existsSync(join(outDir, 'chapters')), false, '删空后的 chapters/ 目录也要清掉')
    assert.deepEqual(snbtNames(outDir), ['lang/en_us.snbt'])
  } finally { dirs.cleanup() }
})

test('preparePack：目录里有上一次来源的残留文件时，取源后清掉残留（不需要 --force）', async () => {
  const dirs = tempDirs()
  try {
    // 残留：上一个来源留下的内嵌章节文件（已发布包里就是这么混进去的）
    const staleDir = join(dirs.packsDir, 'demo', 'config/ftbquests/quests/chapters')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(join(staleDir, 'old.snbt'), 'title: "上一次来源"\n')

    const logs = []
    const r = await preparePack({
      slug: 'demo', cfId: '1514778', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: listingStub(),
      log: (m) => logs.push(m),
    })
    assert.equal(r.status, 'prepared')
    assert.equal(r.layout, LAYOUT.SEPARATE_SINGLE)
    // 目录实况 == 本次权威取源（PACK_ZIP 里是 lang/en_us.snbt + data.snbt）
    assert.deepEqual(snbtNames(join(dirs.packsDir, 'demo')), [
      'config/ftbquests/quests/data.snbt',
      'config/ftbquests/quests/lang/en_us.snbt',
    ])
    // 下游按目录实况判布局，必须与 preparePack 报回来的一致
    assert.equal(classifyLayout(snbtNames(join(dirs.packsDir, 'demo'))).layout, r.layout)
    assert.match(logs.join('\n'), /清掉 1 个不属于权威源的残留文件/)
  } finally { dirs.cleanup() }
})

test('preparePack --force：权威源里没有任务书文件时不动目录（不毁已发布包的基准键集）', async () => {
  const dirs = tempDirs()
  try {
    // 已发布包的英文源（validate-quests 的基准键集）
    const langDir = join(dirs.packsDir, 'demo', 'config/ftbquests/quests/lang')
    mkdirSync(langDir, { recursive: true })
    writeFileSync(join(langDir, 'en_us.snbt'), '{\n\tquest_a_title: "Hi"\n}')

    const noQuestZip = buildZip([{ name: 'Demo-1.0/overrides/mods/example.jar', data: 'not-a-quest-file' }])
    const r = await preparePack({
      slug: 'demo', cfId: '1514778', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      force: true, fetchImpl: stubFetch({ zip: noQuestZip }),
    })
    assert.equal(r.status, 'prepared')
    assert.equal(r.written, 0)
    assert.equal(readFileSync(join(langDir, 'en_us.snbt'), 'utf8'), '{\n\tquest_a_title: "Hi"\n}')
    // 门禁：提前 return 的「没有任务书文件」分支也要写版本，否则这类包永远缺 .source.json。
    // `.source.json` 不是 .snbt，不影响目录实况判定。
    assert.ok(existsSync(join(dirs.packsDir, 'demo', '.source.json')))
  } finally { dirs.cleanup() }
})

test('preparePack：判定为不一致后下载失败 —— 原样留着旧英文源（基准键集不能因为一次失败就没了）', async () => {
  const dirs = tempDirs()
  try {
    // 已发布包的英文源 + 上一次来源的残留
    const questsDir = join(dirs.packsDir, 'demo', 'config/ftbquests/quests')
    mkdirSync(join(questsDir, 'chapters'), { recursive: true })
    mkdirSync(join(questsDir, 'lang'), { recursive: true })
    writeFileSync(join(questsDir, 'chapters/old.snbt'), 'title: "上一次来源"\n')
    writeFileSync(join(questsDir, 'lang/en_us.snbt'), '{\n\tquest_a_title: "Hi"\n}')
    const before = snbtNames(join(dirs.packsDir, 'demo'))

    // 清单能拿到（不一致 → 决定重取），但拉 zip 本体时挂掉
    const fetchImpl = listingStub({
      downloadUrl: 'https://cdn.example/files/demo.zip',
    })
    const failing = async (url, init) => {
      const u = String(url)
      const method = String(init?.method ?? 'GET').toUpperCase()
      const hasRange = init?.headers?.Range ?? init?.headers?.range
      if (u.includes('/files?pageSize=1') || method === 'HEAD' || hasRange) return fetchImpl(url, init)
      throw new Error('下载整合包 HTTP 500')
    }

    await assert.rejects(
      () => preparePack({
        slug: 'demo', cfId: '1514778', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
        fetchImpl: failing,
      }),
      /下载整合包 HTTP 500/,
    )
    // 关键：目录一个字节都没动 —— 闸门的基准键集还在
    assert.deepEqual(snbtNames(join(dirs.packsDir, 'demo')), before)
    assert.equal(readFileSync(join(questsDir, 'lang/en_us.snbt'), 'utf8'), '{\n\tquest_a_title: "Hi"\n}')
    assert.equal(readFileSync(join(questsDir, 'chapters/old.snbt'), 'utf8'), 'title: "上一次来源"\n')
  } finally { dirs.cleanup() }
})

// ---------- 修复链接线：⑨⑩⑪ ----------
// 2026-10-25 诊断（research/tmp/diag-bad6/task-5.md）：规则⑨写好后一直没接进
// repairSources（Phase 5 已知缺陷）；⑩（crafting-craft-2 的裸 {quest.N.title} 缺左引号）
// 与⑪（etbw 的列表元素缺右引号）是新规则。端到端验证：坏文件落盘后必须已被修好。

test('preparePack 修复链：⑨缺右引号/⑩裸模板缺左引号/⑪列表元素缺右引号 —— 落盘后都能 parse', async () => {
  const badZip = buildZip([
    // ⑨ lindenfeld 形态：字符串值缺右引号（此前规则没接线，文件落盘仍是坏的）
    { name: 'Demo-1.0/overrides/config/ftbquests/quests/chapters/r9.snbt', data: '{\n\tgroup: "0F9BFF21DB6FDC1E\n\ticon: "dustydecorations:bookstack"\n}\n' },
    // ⑩ crafting-craft-2 形态：`title: {quest.156.title}"` 缺左引号
    { name: 'Demo-1.0/overrides/config/ftbquests/quests/chapters/r10.snbt', data: '{\n\tid: "ABC"\n\ticon: "book"\n\ttitle: {quest.156.title}"\n}\n' },
    // ⑪ etbw 形态：多行字符串列表的元素行缺右引号
    { name: 'Demo-1.0/overrides/config/ftbquests/quests/chapters/r11.snbt', data: '{\n\tdescription: [\n\t\t"BOSS技能："\n\t\t"它会偶尔短暂停止移动，可以破坏任何方块。；\n\t\t"如果玩家在很高的地方时，方块；"\n\t]\n\tid: "X"\n}\n' },
  ])
  const dirs = tempDirs()
  try {
    const logs = []
    const r = await preparePack({
      slug: 'demo', cfId: '1514778', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      force: true, fetchImpl: stubFetch({ zip: badZip }), log: (m) => logs.push(m),
    })
    assert.equal(r.status, 'prepared')
    assert.equal(r.written, 3)
    assert.match(logs.join('\n'), /修正上游源文件的结构损坏：3 个文件/)
    // 落盘后三个文件必须都能被下游 loadPack/validate-quests 解析
    const chapters = join(dirs.packsDir, 'demo', 'config/ftbquests/quests/chapters')
    for (const f of ['r9.snbt', 'r10.snbt', 'r11.snbt']) {
      const text = readFileSync(join(chapters, f), 'utf8')
      assert.doesNotThrow(() => parse(text), `${f} 修复后必须能 parse`)
    }
    // 值内容只能多引号，不能丢字节
    const r10 = readFileSync(join(chapters, 'r10.snbt'), 'utf8')
    assert.ok(r10.includes('title: "{quest.156.title}"'), '⑩的修法是补左引号')
    const r9 = readFileSync(join(chapters, 'r9.snbt'), 'utf8')
    assert.ok(r9.includes('group: "0F9BFF21DB6FDC1E"'), '⑨的修法是行尾补右引号')
  } finally { dirs.cleanup() }
})
