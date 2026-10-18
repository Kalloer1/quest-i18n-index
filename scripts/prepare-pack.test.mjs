/**
 * prepare-pack.mjs 的单测：按 slug 取 CurseForge 最新文件 → 只解任务书文件到
 * `research/packs/<slug>/`。全部用 fetch 桩，不联网。
 *
 * 这条链路此前完全缺失（实跑 run 39165439848：Translate 以「找不到整合包文件」失败），
 * 故测试要守住「pipeline 的 loadPack 能读到解出的 .snbt」这个唯一目的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { preparePack, resolveLatestFile, downloadUrlOf, cfIdOf } from './prepare-pack.mjs'
import { classifyLayout, LAYOUT } from './lib/candidates.mjs'

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
  { name: 'Demo-1.0/overrides/config/ftbquests/quests/lang/en_us.snbt', data: 'quest.a.title: "Hi"\n' },
  { name: 'Demo-1.0/overrides/config/ftbquests/quests/data.snbt', data: '{ }\n' },
  { name: 'Demo-1.0/overrides/mods/example.jar', data: 'not-a-quest-file' },
])

/** 按 URL 分派的 fetch 桩：文件列表端点返回 CF 形状，其余返回 zip 字节。 */
function stubFetch({ downloadUrl = 'https://cdn.example/files/demo.zip', fileLength = 1024, calls = [] } = {}) {
  return async (url) => {
    calls.push(String(url))
    if (String(url).includes('/files?pageSize=1')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 7, fileName: 'Demo-1.0.zip', fileLength, downloadUrl }],
        }),
      }
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => PACK_ZIP,
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

test('resolveLatestFile：取最新文件的地址、文件名与体积', async () => {
  const file = await resolveLatestFile('1514778', { apiKey: 'k', fetchImpl: stubFetch({ fileLength: 2455660 }) })
  assert.equal(file.url, 'https://cdn.example/files/demo.zip')
  assert.equal(file.fileName, 'Demo-1.0.zip')
  assert.equal(file.fileLength, 2455660)
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
    assert.equal(readFileSync(langPath, 'utf8'), 'quest.a.title: "Hi"\n')
    // 非任务书文件（mods/*.jar）不解出
    assert.ok(!existsSync(join(dirs.packsDir, 'demo', 'mods')))
    // zip 留在 research/tmp/ 便于复现
    assert.ok(existsSync(join(dirs.tmpDir, 'demo.zip')))
  } finally { dirs.cleanup() }
})

test('preparePack：已有任务书文件时跳过下载（幂等），不发起任何请求', async () => {
  const dirs = tempDirs()
  try {
    const outDir = join(dirs.packsDir, 'demo', 'config/ftbquests/quests/lang')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'en_us.snbt'), 'quest.a.title: "Hi"\n')

    const calls = []
    const result = await preparePack({
      slug: 'demo', cfId: '1514778', apiKey: 'k', packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: stubFetch({ calls }),
    })
    assert.equal(result.status, 'skipped')
    assert.deepEqual(calls, [], '已有文件时不应下载')
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
    assert.equal(readFileSync(join(outDir, 'en_us.snbt'), 'utf8'), 'quest.a.title: "Hi"\n')
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
