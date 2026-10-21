/**
 * `preparePack` 的 `keepZip` 选项单测。
 *
 * ## 为什么需要这个开关
 *
 * 旧实现无条件把下载到的 zip 留在 `research/tmp/<slug>.zip`（注释说「便于复现」）。
 * 实测 2026-10-20：`research/tmp/` 积了 **1.5 GB / 33 个 zip**。即将跑 346 个包的
 * 批量翻译，按同样比例会再攒约 **15 GB** —— 纯浪费。
 *
 * 关键观察：zip 的唯一价值是「重新解包时不用再下载」。而 `research/packs/<slug>/`
 * 下的 `.snbt` 一旦存在，`preparePack` 本来就会**跳过下载**（幂等分支），
 * 所以 zip 再也用不上。故批量路应传 `keepZip: false`。
 *
 * 默认值保持 `true`：单包调试时留一份 zip 仍有价值（复现解包结果），
 * 批量路自己显式关掉。默认改 false 会让调试场景失去这个便利，
 * 而「默认留、批量显式关」不需要任何人记住新参数就能保持现有行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { preparePack } from './prepare-pack.mjs'

/** 最小合成 zip：只含一个任务书文件。 */
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
  const cenBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cenBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cenBuf, end])
}

const ZIP = buildZip([{
  name: 'overrides/config/ftbquests/quests/lang/en_us.snbt',
  data: 'quest.a.title: "Hi"\n',
}])

/** fetch 桩：先回文件列表，再回 zip 本体。`onBody` 只在真拉走字节时调用。 */
function stubFetch({ onBody } = {}) {
  return async (url) => {
    if (String(url).includes('/files')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          data: [{ id: 1, fileName: 'Demo-1.0.zip', fileLength: ZIP.length, downloadUrl: 'https://cdn.example/demo.zip' }],
        }),
      }
    }
    return {
      ok: true, status: 200,
      arrayBuffer: async () => { onBody?.(); return ZIP },
    }
  }
}

function tempDirs() {
  const root = mkdtempSync(join(tmpdir(), 'pp-keepzip-'))
  return {
    root,
    packsDir: join(root, 'research', 'packs'),
    tmpDir: join(root, 'research', 'tmp'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('keepZip: false —— 解包成功但不留 zip', async () => {
  const dirs = tempDirs()
  try {
    const r = await preparePack({
      slug: 'demo', cfId: '1', apiKey: 'k',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir, keepZip: false,
      fetchImpl: stubFetch(),
    })
    assert.equal(r.status, 'prepared')
    // 任务书照样解出来 —— 关掉 zip 不能影响产物
    assert.ok(existsSync(join(dirs.packsDir, 'demo', 'config/ftbquests/quests/lang/en_us.snbt')))
    // 但 tmp 里不该留 zip
    assert.equal(existsSync(join(dirs.tmpDir, 'demo.zip')), false, 'keepZip:false 不应留下 zip')
  } finally { dirs.cleanup() }
})

test('keepZip 缺省（true）—— 仍然留下 zip，保住旧行为', async () => {
  const dirs = tempDirs()
  try {
    await preparePack({
      slug: 'demo', cfId: '1', apiKey: 'k',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir,
      fetchImpl: stubFetch(),
    })
    assert.ok(existsSync(join(dirs.tmpDir, 'demo.zip')), '默认应保留 zip 便于复现')
  } finally { dirs.cleanup() }
})

test('keepZip: true 显式开启 —— 留下 zip', async () => {
  const dirs = tempDirs()
  try {
    await preparePack({
      slug: 'demo', cfId: '1', apiKey: 'k',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir, keepZip: true,
      fetchImpl: stubFetch(),
    })
    assert.ok(existsSync(join(dirs.tmpDir, 'demo.zip')))
  } finally { dirs.cleanup() }
})

test('keepZip: false 且已有 .snbt —— 仍跳过下载，完全不碰 tmp', async () => {
  const dirs = tempDirs()
  try {
    const outDir = join(dirs.packsDir, 'demo', 'config/ftbquests/quests/lang')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'en_us.snbt'), 'quest.a.title: "Hi"\n')

    // 幂等跳过前会先取一次权威文件地址 + 一次清单（拿不到就退回本地副本），
    // 但绝不下载 zip 字节、绝不碰 tmp。桩只对「拉字节的请求」计数。
    let bodies = 0
    const zipUrl = 'https://cdn.example/files/demo.zip'
    const r = await preparePack({
      slug: 'demo', cfId: '1', apiKey: 'k',
      packsDir: dirs.packsDir, tmpDir: dirs.tmpDir, keepZip: false,
      fetchImpl: stubFetch({ bodies: () => bodies++ }),
    })
    assert.equal(r.status, 'skipped')
    assert.equal(bodies, 0, '跳过时不该拉走任何 zip 字节')
    assert.equal(existsSync(join(dirs.tmpDir, 'demo.zip')), false)
    // 本地英文源一个字节都不能动（它是 validate-quests 的基准键集）
    assert.equal(readFileSync(join(outDir, 'en_us.snbt'), 'utf8'), 'quest.a.title: "Hi"\n')
  } finally { dirs.cleanup() }
})
