/**
 * Modrinth 来源的单测：`scripts/lib/modrinth.mjs` 的取版本逻辑，以及
 * `preparePack({platform:'mr'})` 的端到端解包。全部用 fetch 桩，不联网。
 *
 * ## 为什么需要这一层
 *
 * `prepare-pack.mjs` 原本只认 CurseForge API。实测数据集 28816 条里
 * **18816 条是 Modrinth**（`platform: 'mr'`），其中 391 条是可产出的任务书包
 * （separate-single + embedded）。只走 CF 分支等于放弃一半以上的候选。
 *
 * ## Modrinth 与 CF 的两处关键差异（实测）
 *
 * 1. `.mrpack` 是 zip，任务书在 `overrides/` 下
 *    （实测 better-mc-fabric-bmc2.mrpack 63 MB → 35 个 .snbt，20 个在
 *    `overrides/defaultconfigs/ftbquests/quests/chapters/`）。
 *    `extract-pack.mjs` 的 `toOutputPath` 用 ANCHOR_SEGMENTS 锚到
 *    `config`/`ftbquests`/`lang`/`chapters`，**天然剥掉 overrides/**
 *    —— 所以落盘路径不用改，直接复用 `extractFromBuffer`。
 * 2. Modrinth API **要求 User-Agent**（实测不带会 400/403），而 CF 用 `x-api-key`。
 *    故 `resolveLatestMrpack` 的默认 UA 必须非空，测试要守住这一点。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import {
  resolveLatestMrpack, modrinthProjectUrl, MR_USER_AGENT, MR_API_BASE,
} from './lib/modrinth.mjs'
import { preparePack, platformOf } from './prepare-pack.mjs'
import { LAYOUT } from './lib/candidates.mjs'

// ---------- 合成 zip（.mrpack 就是 zip，与 prepare-pack.test.mjs 同构的最小子集） ----------

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

/** 仿真实 .mrpack 结构：modrinth.index.json + overrides/ 下的任务书。 */
const MRPACK = buildZip([
  { name: 'modrinth.index.json', data: '{"formatVersion":1,"files":[]}\n' },
  { name: 'overrides/config/ftbquests/quests/lang/en_us.snbt', data: 'quest.a.title: "Hi"\n' },
  { name: 'overrides/defaultconfigs/ftbquests/quests/chapters/demo.snbt', data: 'id: "demo"\n' },
  { name: 'overrides/mods/example.jar', data: 'not-a-quest-file' },
])

const VERSION_URL = 'https://cdn.modrinth.com/data/shFhR8Vx/versions/abc/bmc2.mrpack'

/** Modrinth 版本列表的真实响应形状（只保留本模块用到的字段）。 */
function versionBody({
  fileName = 'bmc2.mrpack', size = 65536000, versionNumber = '2.1.0',
  url = VERSION_URL, versions = 1,
} = {}) {
  const one = {
    id: 'abc',
    version_number: versionNumber,
    files: [{ url, filename: fileName, size, primary: true }],
  }
  return Array.from({ length: versions }, (_, i) => (i === 0 ? one : { ...one, id: `v${i}`, version_number: `0.${i}` }))
}

/** 按 URL 分派的 fetch 桩：版本端点返回 JSON，其余返回 .mrpack 字节。 */
function stubFetch({ body = versionBody(), status = 200, calls = [] } = {}) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} })
    // 只把 API 端点当 JSON；下载地址在 cdn.modrinth.com/data/.../versions/... 下，
    // 也含 "version" 字样，用 '/project/' 区分才不会把 zip 请求当版本列表。
    if (String(url).includes('/project/')) {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      }
    }
    return { ok: true, status: 200, arrayBuffer: async () => MRPACK }
  }
}

function tempDirs() {
  const root = mkdtempSync(join(tmpdir(), 'modrinth-'))
  return {
    root,
    packsDir: join(root, 'research', 'packs'),
    tmpDir: join(root, 'research', 'tmp'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// ---------- resolveLatestMrpack ----------

test('modrinthProjectUrl：拼出 v2 版本端点，空 slug 明确报错', () => {
  assert.equal(modrinthProjectUrl('better-mc-fabric-bmc2'), `${MR_API_BASE}/project/better-mc-fabric-bmc2/version`)
  assert.equal(modrinthProjectUrl(' shFhR8Vx '), `${MR_API_BASE}/project/shFhR8Vx/version`)
  assert.throws(() => modrinthProjectUrl(''), /slug/)
})

test('resolveLatestMrpack：取第一个版本的 .mrpack，返回 url/fileName/fileLength/versionNumber', async () => {
  const file = await resolveLatestMrpack('better-mc-fabric-bmc2', {
    fetchImpl: stubFetch({ body: versionBody({ size: 65536000, versionNumber: '2.1.0' }) }),
  })
  assert.equal(file.url, VERSION_URL)
  assert.equal(file.fileName, 'bmc2.mrpack')
  assert.equal(file.fileLength, 65536000)
  assert.equal(file.versionNumber, '2.1.0')
})

test('resolveLatestMrpack：请求带 User-Agent（Modrinth 不带会 400/403）', async () => {
  const calls = []
  await resolveLatestMrpack('better-mc-fabric-bmc2', { fetchImpl: stubFetch({ calls }) })
  const headers = calls[0].headers
  const ua = headers['User-Agent'] ?? headers['user-agent']
  assert.equal(ua, MR_USER_AGENT, '默认 UA 必须非空')
  assert.match(String(ua), /quest-i18n\/1\.0/)
  assert.match(calls[0].url, /api\.modrinth\.com\/v2\/project\/better-mc-fabric-bmc2\/version$/)

  // 允许覆盖 UA（将来打不同的标识时不必改模块）
  const calls2 = []
  await resolveLatestMrpack('x', { fetchImpl: stubFetch({ calls: calls2 }), userAgent: 'custom/9.9' })
  assert.equal(calls2[0].headers['User-Agent'], 'custom/9.9')
})

test('resolveLatestMrpack：项目不存在（404）明确报错', async () => {
  await assert.rejects(
    () => resolveLatestMrpack('no-such-pack', { fetchImpl: stubFetch({ status: 404 }) }),
    /项目不存在.*no-such-pack/,
  )
})

test('resolveLatestMrpack：项目没有版本时明确报错', async () => {
  await assert.rejects(
    () => resolveLatestMrpack('empty-pack', { fetchImpl: stubFetch({ body: [] }) }),
    /没有任何版本/,
  )
})

test('resolveLatestMrpack：版本里没有 .mrpack 文件时明确报错（不猜 zip）', async () => {
  const body = versionBody({ fileName: 'bmc2.zip' })
  await assert.rejects(
    () => resolveLatestMrpack('zip-only', { fetchImpl: stubFetch({ body }) }),
    /没有 \.mrpack/,
  )
})

// ---------- preparePack 走 Modrinth ----------

test('preparePack(platform:mr)：端到端解包，overrides/ 被剥掉', async () => {
  const dirs = tempDirs()
  try {
    const calls = []
    const result = await preparePack({
      slug: 'better-mc-fabric-bmc2', platform: 'mr',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: stubFetch({ calls }),
    })

    assert.equal(result.status, 'prepared')
    // 只走 Modrinth：第一个请求是版本端点，没有 CF 的 /mods/<id>/files
    assert.match(calls[0].url, /api\.modrinth\.com\/v2\/project\/better-mc-fabric-bmc2\/version$/)
    assert.ok(!calls.some((c) => String(c.url).includes('curseforge')), 'mr 分支不应请求 CurseForge')

    // 关键断言：落盘路径不含 overrides/
    const langPath = join(dirs.packsDir, 'better-mc-fabric-bmc2', 'config/ftbquests/quests/lang/en_us.snbt')
    assert.ok(existsSync(langPath), `应解出 ${langPath}`)
    assert.equal(readFileSync(langPath, 'utf8'), 'quest.a.title: "Hi"\n')
    assert.ok(!existsSync(join(dirs.packsDir, 'better-mc-fabric-bmc2', 'overrides')), 'overrides/ 必须被剥掉')
    // 非任务书文件（mods/*.jar）与 index 都不解出
    assert.ok(!existsSync(join(dirs.packsDir, 'better-mc-fabric-bmc2', 'mods')))
    assert.ok(!existsSync(join(dirs.packsDir, 'better-mc-fabric-bmc2', 'modrinth.index.json')))

    // 内嵌章节也在（真实包同时带两处）。注意 toOutputPath 的锚点是
    // config/ftbquests/lang/chapters，故 `overrides/defaultconfigs/ftbquests/...`
    // 会落成 `ftbquests/quests/chapters/...`（defaultconfigs 段被当包装目录剥掉）。
    // 这是复用 extract-pack 的现有口径，不在本次改动范围内修改。
    assert.ok(existsSync(join(dirs.packsDir, 'better-mc-fabric-bmc2', 'ftbquests/quests/chapters/demo.snbt')))
    assert.equal(result.layout, LAYOUT.SEPARATE_SINGLE)

    // keepZip 语义不变：默认留 zip
    assert.ok(existsSync(join(dirs.tmpDir, 'better-mc-fabric-bmc2.zip')))
  } finally { dirs.cleanup() }
})

test('preparePack(platform:mr)：不需要 apiKey；keepZip:false 仍解包但不留 zip', async () => {
  const dirs = tempDirs()
  try {
    const result = await preparePack({
      slug: 'better-mc-fabric-bmc2', platform: 'mr', keepZip: false,
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: stubFetch(),
    })
    assert.equal(result.status, 'prepared')
    assert.ok(existsSync(join(dirs.packsDir, 'better-mc-fabric-bmc2', 'config/ftbquests/quests/lang/en_us.snbt')))
    assert.equal(existsSync(join(dirs.tmpDir, 'better-mc-fabric-bmc2.zip')), false)
  } finally { dirs.cleanup() }
})

test('preparePack(platform:mr)：幂等——已有 .snbt 时跳过下载，不拉任何字节', async () => {
  const dirs = tempDirs()
  try {
    await preparePack({
      slug: 'better-mc-fabric-bmc2', platform: 'mr',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir, fetchImpl: stubFetch(),
    })
    // 幂等跳过前会先取一次权威地址 + 一次清单（拿不到就退回本地副本），
    // 但绝不下载 zip 字节。桩只对「拉字节的请求」计数。
    let bodies = 0
    const again = await preparePack({
      slug: 'better-mc-fabric-bmc2', platform: 'mr',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: stubFetch({ onBody: () => bodies++ }),
    })
    assert.equal(again.status, 'skipped')
    assert.equal(bodies, 0, '跳过时不该拉走任何 zip 字节')
  } finally { dirs.cleanup() }
})

test('preparePack：platform 写错时明确报错，不静默落到 cf 分支', async () => {
  const dirs = tempDirs()
  try {
    await assert.rejects(
      () => preparePack({
        slug: 'demo', platform: 'modrinth', cfId: '1', apiKey: 'k',
        packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
        fetchImpl: async () => { throw new Error('不该发起请求') },
      }),
      /platform 只接受/,
    )
  } finally { dirs.cleanup() }
})

// ---------- 平台判定 ----------

test('platformOf：按数据集的 platform 字段判定来源，缺失时返回 null', () => {
  const records = [
    { slug: 'atm10', cfId: '925200', platform: 'cf' },
    { slug: 'bmc2', cfId: 'shFhR8Vx', platform: 'mr' },
    { slug: 'legacy', cfId: '1514778' },
    { slug: 'blank', platform: '  ' },
  ]
  assert.equal(platformOf(records, 'atm10'), 'cf')
  assert.equal(platformOf(records, 'bmc2'), 'mr', 'Modrinth 包必须判成 mr，否则会拿 MR id 去调 CF API')
  assert.equal(platformOf(records, 'legacy'), null, '没有 platform 字段时不猜平台')
  assert.equal(platformOf(records, 'blank'), null)
  assert.equal(platformOf(records, 'missing'), null)
  assert.equal(platformOf(undefined, 'atm10'), null)
})
