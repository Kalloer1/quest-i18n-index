/**
 * `prepare-pack` 的「Range 只取任务书 .snbt」模式单测（`fetchQuestFilesOnly` / `questFilesOnly`）。
 *
 * ## 为什么要这个模式
 * 346 个待翻整合包整包下载约 14.8 GB，而语言文件只占 **0.453%**
 * （41 个已解包包实测：`en_us.snbt` 合计 6.3 MB，对应整包 1392 MB）。
 * `separate-single` 325 个包平均只需 1.06 个文件，`separate-dir` 10 个平均 4.10 个 ——
 * 合计 **384 次文件 Range** 就能覆盖全部 346 个包，约 67 MB。
 *
 * ## 这里守住三件事
 *   1. 请求集必须最小：HEAD + 尾部 Range + 中央目录 Range + 每个目标文件 1 次 Range，
 *      **没有任何整包 GET**（整包 GET 就是本模式要消灭的东西）；
 *   2. 解出的字节必须与 zip 里原文逐字节相同（stored / deflate 两种都要能解）；
 *   3. Range 任何一步失败都要回退整包下载，产物照样正确 ——
 *      CDN 不支持 Range（忽略 Range 头回 200 + 整包）是真实存在的。
 *
 * 全部用合成 zip + fetch 桩，不联网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { fetchQuestFilesOnly, preparePack } from './prepare-pack.mjs'
import { classifyLayout, LAYOUT } from './lib/candidates.mjs'

// ---------- 合成 zip（支持 stored / deflate / zip64） ----------

/**
 * 最小 zip 写入器。`method` 缺省 8（deflate），传 0 写 stored（不压缩，原样切）。
 * `zip64: true` 时额外写 zip64 EOCD 记录 + 定位器，并把 EOCD 的条目数/偏移
 * 置成 0xffff / 0xffffffff —— 真实大包（mods 上千个文件）会出现这种尾部。
 */
function buildZip(files, { zip64 = false } = {}) {
  const chunks = []
  const central = []
  let offset = 0
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const data = Buffer.from(f.data, 'utf8')
    const method = f.method ?? 8
    const comp = method === 0 ? data : deflateRawSync(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, comp)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(method, 10)
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
  if (!zip64) return Buffer.concat([...chunks, cdBuf, eocd])

  const z64 = Buffer.alloc(56)
  z64.writeUInt32LE(0x06064b50, 0)
  z64.writeBigUInt64LE(44n, 4)
  z64.writeUInt16LE(45, 12)
  z64.writeUInt16LE(45, 14)
  z64.writeBigUInt64LE(BigInt(files.length), 24)
  z64.writeBigUInt64LE(BigInt(files.length), 32)
  z64.writeBigUInt64LE(BigInt(cdBuf.length), 40)
  z64.writeBigUInt64LE(BigInt(offset), 48)

  const loc = Buffer.alloc(20)
  loc.writeUInt32LE(0x07064b50, 0)
  loc.writeBigUInt64LE(BigInt(offset + cdBuf.length), 8)

  eocd.writeUInt16LE(0xffff, 8)
  eocd.writeUInt16LE(0xffff, 10)
  eocd.writeUInt32LE(0xffffffff, 12)
  eocd.writeUInt32LE(0xffffffff, 16)
  return Buffer.concat([...chunks, cdBuf, z64, loc, eocd])
}

/**
 * 200 KB 的「假 mod jar」：把 zip 撑到 70000 字节以上，
 * 这样尾部 Range 才是真正的**局部**读取，而不是"顺手读走整个文件"
 * （合成小 zip 的 tailLen = min(70000, len) = len，会把整包读掉，测不出最小请求集）。
 */
const BIG_JAR = Array.from({ length: 200_000 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 90))).join('')

// ---------- 合成 CDN ----------

/**
 * fetch 桩：HEAD 给长度，带 Range 头按切片回 206，不带 Range 回整包。
 * `supportsRange: false` 模拟「忽略 Range 头的 CDN」：回 200 + 整包。
 */
function makeCdn(zip, { supportsRange = true, calls = [], downloadUrl = 'https://cdn.example/files/demo.zip' } = {}) {
  return async (url, init = {}) => {
    const u = String(url)
    const method = String(init.method ?? 'GET').toUpperCase()
    const range = init.headers?.Range ?? init.headers?.range ?? null
    const reply = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      url: u,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      arrayBuffer: async () => body,
    })

    if (u.includes('/files?pageSize=1')) {
      calls.push({ method: 'API', range: null, url: u })
      return {
        ok: true,
        status: 200,
        url: u,
        headers: { get: () => null },
        json: async () => ({
          data: [{ id: 7, fileName: 'Demo-1.0.zip', fileLength: zip.length, downloadUrl }],
        }),
      }
    }

    calls.push({ method, range, url: u })
    if (method === 'HEAD') return reply(200, Buffer.alloc(0), { 'content-length': String(zip.length) })
    if (!range) return reply(200, zip)
    if (!supportsRange) return reply(200, zip)
    const m = /bytes=(\d+)-(\d+)/.exec(range)
    if (!m) return reply(416, Buffer.alloc(0))
    const start = Number(m[1])
    const end = Math.min(Number(m[2]), zip.length - 1)
    if (start > end) return reply(416, Buffer.alloc(0))
    return reply(206, zip.subarray(start, end + 1), { 'content-length': String(end - start + 1) })
  }
}

/** 只数「整包 GET」：不带 Range 头的 GET 就是本模式要消灭的东西。 */
const wholeGets = (calls) => calls.filter((c) => c.method === 'GET' && !c.range)
/** 带 Range 头的 GET。 */
const rangeGets = (calls) => calls.filter((c) => c.method === 'GET' && c.range)

// ---------- 夹具 ----------

const EN_TEXT = '{\nquest.a.title: "你好，世界"\nquest.b.desc: "emoji 🙂 / tab\\tend"\n}'
const EN_PATH = 'Demo-1.0/overrides/config/ftbquests/quests/lang/en_us.snbt'

/** 分离·单文件：1 个英文源 + 1 个内嵌 data.snbt + 一个 200KB 的假 jar。 */
const SINGLE_ZIP = buildZip([
  { name: EN_PATH, data: EN_TEXT },
  { name: 'Demo-1.0/overrides/config/ftbquests/quests/data.snbt', data: '{ }\n' },
  { name: 'Demo-1.0/overrides/mods/big.jar', data: BIG_JAR, method: 0 },
])

/** 分离·目录：`lang/en_us/` 下 4 个 .snbt（craftoria 那种新版格式）。 */
const DIR_FILES = [
  { name: 'Demo-1.0/overrides/config/ftbquests/quests/lang/en_us/file.snbt', data: '{ a: "1" }' },
  { name: 'Demo-1.0/overrides/config/ftbquests/quests/lang/en_us/chapters/apotheosis.snbt', data: '{ b: "2" }' },
  { name: 'Demo-1.0/overrides/config/ftbquests/quests/lang/en_us/chapters/thermal.snbt', data: '{ c: "3" }' },
  { name: 'Demo-1.0/overrides/config/ftbquests/quests/lang/en_us/chapters/create.snbt', data: '{ d: "4" }' },
]
const DIR_ZIP = buildZip([...DIR_FILES, { name: 'Demo-1.0/overrides/mods/big.jar', data: BIG_JAR, method: 0 }])

function tempDirs() {
  const root = mkdtempSync(join(tmpdir(), 'prepare-pack-range-'))
  return {
    root,
    packsDir: join(root, 'research', 'packs'),
    tmpDir: join(root, 'research', 'tmp'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// ---------- fetchQuestFilesOnly ----------

test('fetchQuestFilesOnly：只取 en_us.snbt —— HEAD + 尾部/中央目录 2 次 Range + 1 次文件 Range，不碰整包', async () => {
  const calls = []
  const files = await fetchQuestFilesOnly('https://cdn.example/demo.zip', {
    filter: (n) => /\/lang\/en_us\.snbt$/.test(n),
    fetchImpl: makeCdn(SINGLE_ZIP, { calls }),
  })

  assert.deepEqual(files.map((f) => f.name), [EN_PATH])
  assert.equal(wholeGets(calls).length, 0, '不能有整包 GET')
  assert.equal(calls.filter((c) => c.method === 'HEAD').length, 1, '只需 1 次 HEAD')
  // 尾部 Range（找 EOCD）+ 中央目录 Range + 1 个文件的「本地头+压缩数据」Range
  assert.equal(rangeGets(calls).length, 3, `Range 请求应为 3 次，实际 ${JSON.stringify(calls)}`)
  // 关键断言：**文件 Range** 只覆盖「本地头 + 压缩数据」，不是整包。
  // 不能拿「不以 0 开头」当判据 —— 第一个条目的本地头偏移就是 0。
  // 也不能假定尾部 Range 的大小：它取 min(64KB, 总长)，本夹具的 zip 约 200KB
  // （含一个 200KB 的假 jar，method 0 不压缩），所以尾部窗口就是 64KB 量级。
  // 故按「哪一次以 0 开头」挑出文件 Range，而不是写死索引 2。
  const ranges = rangeGets(calls).map((c) => /bytes=(\d+)-(\d+)/.exec(c.range).slice(1).map(Number))
  const fileRange = ranges.find(([s2]) => s2 === 0)
  assert.ok(fileRange, '应有一次以 0 开头的文件 Range')
  const [fileStart, fileEnd] = fileRange
  assert.ok(fileEnd - fileStart + 1 < 8192, `文件 Range 跨度过大：${fileEnd - fileStart + 1} 字节`)
  assert.ok(fileEnd < SINGLE_ZIP.length - 1, '文件 Range 不应拉到底')
})

test('fetchQuestFilesOnly：解出的文本与 zip 里原文逐字节相同（多字节字符不走样）', async () => {
  const files = await fetchQuestFilesOnly('https://cdn.example/demo.zip', {
    filter: (n) => /\/lang\/en_us\.snbt$/.test(n),
    fetchImpl: makeCdn(SINGLE_ZIP),
  })
  assert.equal(files[0].text, EN_TEXT)
  assert.deepEqual(Buffer.from(files[0].text, 'utf8'), Buffer.from(EN_TEXT, 'utf8'))
})

test('fetchQuestFilesOnly：分离·目录布局的 4 个章节文件全部取到（每个 1 次 Range）', async () => {
  const calls = []
  const files = await fetchQuestFilesOnly('https://cdn.example/demo.zip', {
    fetchImpl: makeCdn(DIR_ZIP, { calls }),
  })

  assert.equal(files.length, DIR_FILES.length)
  for (const want of DIR_FILES) {
    const got = files.find((f) => f.name === want.name)
    assert.ok(got, `缺文件 ${want.name}`)
    assert.equal(got.text, want.data)
  }
  assert.equal(wholeGets(calls).length, 0)
  // HEAD + 2 次中央目录 Range + 4 次文件 Range
  assert.equal(rangeGets(calls).length, 2 + DIR_FILES.length)
})

test('fetchQuestFilesOnly：stored（method 0）与 deflate（method 8）都能解', async () => {
  const zip = buildZip([
    { name: 'p/config/ftbquests/quests/lang/en_us.snbt', data: '{ deflated: "8" }', method: 8 },
    { name: 'p/config/ftbquests/quests/lang/zh_cn.snbt', data: '{ stored: "0" }', method: 0 },
  ])
  const files = await fetchQuestFilesOnly('https://cdn.example/demo.zip', { fetchImpl: makeCdn(zip) })
  const byName = Object.fromEntries(files.map((f) => [f.name, f.text]))
  assert.equal(byName['p/config/ftbquests/quests/lang/en_us.snbt'], '{ deflated: "8" }')
  assert.equal(byName['p/config/ftbquests/quests/lang/zh_cn.snbt'], '{ stored: "0" }')
})

test('fetchQuestFilesOnly：zip64 尾部（EOCD 字段全 0xff）也能读出中央目录', async () => {
  const zip = buildZip([
    { name: EN_PATH, data: EN_TEXT },
    { name: 'Demo-1.0/overrides/mods/big.jar', data: BIG_JAR, method: 0 },
  ], { zip64: true })
  const files = await fetchQuestFilesOnly('https://cdn.example/demo.zip', {
    filter: (n) => /\/lang\/en_us\.snbt$/.test(n),
    fetchImpl: makeCdn(zip),
  })
  assert.equal(files.length, 1)
  assert.equal(files[0].text, EN_TEXT)
})

test('fetchQuestFilesOnly：CDN 忽略 Range（回 200 整包）时明确失败，交给上层回退', async () => {
  await assert.rejects(
    () => fetchQuestFilesOnly('https://cdn.example/demo.zip', { fetchImpl: makeCdn(SINGLE_ZIP, { supportsRange: false }) }),
    /206/,
  )
})

test('fetchQuestFilesOnly：没有任务书文件时返回空数组，且不发任何文件 Range', async () => {
  const zip = buildZip([
    { name: 'p/mods/a.jar', data: 'x' },
    { name: 'p/config/other.cfg', data: 'y' },
  ])
  const calls = []
  const files = await fetchQuestFilesOnly('https://cdn.example/demo.zip', { fetchImpl: makeCdn(zip, { calls }) })
  assert.deepEqual(files, [])
  // 只有 HEAD + 尾部 Range + 中央目录 Range
  assert.equal(rangeGets(calls).length, 2)
})

// ---------- preparePack({ questFilesOnly: true }) ----------

test('preparePack questFilesOnly：只写目标 .snbt 到 packsDir/<slug>/，不下载整包、不写 zip', async () => {
  const dirs = tempDirs()
  try {
    const calls = []
    const r = await preparePack({
      slug: 'demo', cfId: '7', apiKey: 'k',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir, questFilesOnly: true,
      fetchImpl: makeCdn(SINGLE_ZIP, { calls }),
    })

    assert.equal(r.status, 'prepared')
    assert.equal(r.layout, LAYOUT.SEPARATE_SINGLE)
    const langPath = join(dirs.packsDir, 'demo', 'config/ftbquests/quests/lang/en_us.snbt')
    assert.equal(readFileSync(langPath, 'utf8'), EN_TEXT)
    assert.ok(existsSync(join(dirs.packsDir, 'demo', 'config/ftbquests/quests/data.snbt')))
    // mods/ 不解出
    assert.equal(existsSync(join(dirs.packsDir, 'demo', 'mods')), false)
    // 关键：没有整包 GET，也没有留 zip
    assert.equal(wholeGets(calls).length, 0, `不该请求整包：${JSON.stringify(calls)}`)
    assert.equal(existsSync(join(dirs.tmpDir, 'demo.zip')), false, 'questFilesOnly 不应写 zip')
    // Range 模式也要落上游版本记录（版本溯源两条取源路必须一致）
    const info = JSON.parse(readFileSync(join(dirs.packsDir, 'demo', '.source.json'), 'utf8'))
    assert.equal(info.fileName, 'Demo-1.0.zip')
    assert.equal(info.fileId, 7)
    assert.equal(info.fileDate, null, '桩没给 fileDate 时应写 null，不瞎猜')
    // 落盘结果能被 classifyLayout 认成可翻译的英文源
    assert.equal(classifyLayout(['config/ftbquests/quests/lang/en_us.snbt']).enFiles, 1)
  } finally { dirs.cleanup() }
})

test('preparePack questFilesOnly：Range 失败自动回退整包下载，产物照样正确', async () => {
  const dirs = tempDirs()
  try {
    const calls = []
    const logs = []
    const r = await preparePack({
      slug: 'demo', cfId: '7', apiKey: 'k',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir, questFilesOnly: true,
      fetchImpl: makeCdn(SINGLE_ZIP, { supportsRange: false, calls }),
      log: (m) => logs.push(m),
    })

    assert.equal(r.status, 'prepared')
    assert.equal(r.layout, LAYOUT.SEPARATE_SINGLE)
    assert.equal(wholeGets(calls).length, 1, '回退后应恰好整包下载一次')
    assert.match(logs.join('\n'), /Range 失败，回退整包/)
    assert.equal(readFileSync(join(dirs.packsDir, 'demo', 'config/ftbquests/quests/lang/en_us.snbt'), 'utf8'), EN_TEXT)
    // 回退走的是旧路径，keepZip 默认 true，所以 zip 留下
    assert.ok(existsSync(join(dirs.tmpDir, 'demo.zip')))
  } finally { dirs.cleanup() }
})

test('preparePack questFilesOnly：已有 .snbt 且目录实况与权威清单一致时跳过（只取清单，不下文件）', async () => {
  const dirs = tempDirs()
  try {
    await preparePack({
      slug: 'demo', cfId: '7', apiKey: 'k',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir, questFilesOnly: true,
      fetchImpl: makeCdn(SINGLE_ZIP),
    })
    const calls = []
    const r = await preparePack({
      slug: 'demo', cfId: '7', apiKey: 'k',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir, questFilesOnly: true,
      fetchImpl: makeCdn(SINGLE_ZIP, { calls }),
      log: () => {},
    })
    assert.equal(r.status, 'skipped')
    assert.equal(wholeGets(calls).length, 0, '跳过时不该下载整包')
    // 只取权威清单：HEAD + 尾部 Range + 中央目录 Range，没有任何**文件** Range
    assert.equal(rangeGets(calls).length, 2, `跳过时只该取权威清单：${JSON.stringify(calls)}`)
  } finally { dirs.cleanup() }
})

test('preparePack questFilesOnly：目录残留上一次来源的章节文件 → 权威清单说不该有 → 清空重取（无需 --force）', async () => {
  const dirs = tempDirs()
  try {
    // 上一次来源的内嵌章节文件：只有它存在时，loadPackUnits 会把布局判成 embedded
    const staleDir = join(dirs.packsDir, 'demo', 'config/ftbquests/quests/chapters')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(join(staleDir, 'old.snbt'), 'title: "上一次来源"\n')

    const calls = []
    const logs = []
    const r = await preparePack({
      slug: 'demo', cfId: '7', apiKey: 'k',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir, questFilesOnly: true,
      fetchImpl: makeCdn(SINGLE_ZIP, { calls }),
      log: (m) => logs.push(m),
    })

    assert.equal(r.status, 'prepared')
    assert.equal(r.layout, LAYOUT.SEPARATE_SINGLE)
    // 自愈：残留章节文件没了，目录实况 == 本次权威取源
    assert.equal(existsSync(staleDir), false)
    assert.equal(readFileSync(join(dirs.packsDir, 'demo', 'config/ftbquests/quests/lang/en_us.snbt'), 'utf8'), EN_TEXT)
    assert.ok(existsSync(join(dirs.packsDir, 'demo', 'config/ftbquests/quests/data.snbt')))
    assert.match(logs.join('\n'), /残留/)
    assert.equal(wholeGets(calls).length, 0, '不该回退整包下载')
  } finally { dirs.cleanup() }
})

test('preparePack questFilesOnly：权威清单取不到时退回旧行为 —— 用本地副本，不把包判失败', async () => {
  const dirs = tempDirs()
  try {
    // 本地副本（上一次取源留下的，比如 CDN 只挡住了中央目录）
    const langDir = join(dirs.packsDir, 'demo', 'config/ftbquests/quests/lang')
    mkdirSync(langDir, { recursive: true })
    writeFileSync(join(langDir, 'en_us.snbt'), EN_TEXT)

    const headFails = async (url, init = {}) => {
      const u = String(url)
      const method = String(init?.method ?? 'GET').toUpperCase()
      if (u.includes('/files?pageSize=1')) {
        return {
          ok: true, status: 200, url: u, headers: { get: () => null },
          json: async () => ({ data: [{ id: 7, fileName: 'Demo-1.0.zip', fileLength: 1, downloadUrl: 'https://cdn.example/files/demo.zip' }] }),
        }
      }
      if (method === 'HEAD') return { ok: false, status: 500, url: u, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) }
      throw new Error('清单取不到时不该继续发请求')
    }

    const logs = []
    const r = await preparePack({
      slug: 'demo', cfId: '7', apiKey: 'k',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir, questFilesOnly: true,
      fetchImpl: headFails,
      log: (m) => logs.push(m),
    })

    assert.equal(r.status, 'skipped', '清单取不到要退回「有 .snbt 就用本地副本」')
    assert.equal(r.layout, LAYOUT.SEPARATE_SINGLE)
    assert.match(logs.join('\n'), /权威清单取不到/)
    assert.equal(readFileSync(join(langDir, 'en_us.snbt'), 'utf8'), EN_TEXT, '本地副本必须原样留着')
  } finally { dirs.cleanup() }
})

test('preparePack 缺省（questFilesOnly 未开）：行为不变 —— 整包下载 + 留 zip，不发 HEAD', async () => {
  const dirs = tempDirs()
  try {
    const calls = []
    const r = await preparePack({
      slug: 'demo', cfId: '7', apiKey: 'k',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: makeCdn(SINGLE_ZIP, { calls }),
    })

    assert.equal(r.status, 'prepared')
    assert.equal(r.layout, LAYOUT.SEPARATE_SINGLE)
    assert.equal(wholeGets(calls).length, 1, '旧路径就是整包下载')
    assert.equal(calls.filter((c) => c.method === 'HEAD').length, 0, '旧路径不该发 HEAD')
    assert.equal(rangeGets(calls).length, 0, '旧路径不该发 Range')
    assert.ok(existsSync(join(dirs.tmpDir, 'demo.zip')))
    assert.equal(readFileSync(join(dirs.packsDir, 'demo', 'config/ftbquests/quests/lang/en_us.snbt'), 'utf8'), EN_TEXT)
  } finally { dirs.cleanup() }
})
