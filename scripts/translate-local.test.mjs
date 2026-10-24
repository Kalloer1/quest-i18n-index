/**
 * translate-local.mjs 入库路径的单元测试。
 *
 * ## 为什么盯这个
 *
 * 早先入库用的是裸 `git add -A`。跑大批量翻译时 `research/packs/` 下有 20 多个
 * 未跟踪目录（本脚本自己刚解出来的英文源），`-A` 会把它们连同任何未跟踪文件
 * 一起提交，再 push 到 main。已实测踩坑：research/par-out/ 下的中间块、
 * 临时的下载缓存都会被卷进去。
 *
 * 现在入库路径必须走 `stagedPathsForBatch({slugs})` 算出的显式清单，
 * 与 `release.mjs` 的「显式路径暂存（禁止 git add -A）」同口径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  stagedPathsForBatch, prepareArgsForBatch, isAlreadyTranslated, pendingWorklist, describeWorklist,
  farmDiskGuard, freeBytesFromStatfs, MIN_FREE_BYTES, pickTranslatable, farmExitFlush,
} from './translate-local.mjs'

// 断言函数不存在时会 ImportError，正是我们要的红。
// 去注释再匹配：注释里写「禁止 git add -A」不该被当成实现本身。
const SOURCE = readFileSync(new URL('./translate-local.mjs', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

test('stagedPathsForBatch：入库清单覆盖本轮产物与站点/术语数据', () => {
  const paths = stagedPathsForBatch({ slugs: ['demo-pack'] })
  assert.ok(paths.includes('patches/'), '应含 patches/')
  assert.ok(paths.includes('research/packs/demo-pack/'), '应含本轮包的英文源目录')
  assert.ok(paths.includes('downloads/'), '应含 downloads/')
  assert.ok(paths.includes('site/data.json'))
  assert.ok(paths.includes('glossary.json'))
  assert.ok(paths.includes('research/index-dataset.json'))
})

test('stagedPathsForBatch：不含未跟踪的全量暂存参数（-A / --all / .）', () => {
  const paths = stagedPathsForBatch({ slugs: ['a', 'b'] })
  for (const p of paths) {
    assert.notEqual(p, '-A')
    assert.notEqual(p, '--all')
    assert.notEqual(p, '.')
    assert.notEqual(p, '')
  }
  // 实现里也不能残留裸 add：-A 会把 research/packs/ 下未跟踪目录一起卷进提交。
  assert.ok(!/\bgit\s+add\s+(-A|--all)\b/.test(SOURCE), '实现不得出现 git add -A/--all')
  assert.ok(!/\bgit\s+add\s+\.\s*(?:"|$)/m.test(SOURCE), '实现不得出现 git add .')
})

test('stagedPathsForBatch：只暂存本轮 slug，不带别人的 research/packs/<其他slug>/', () => {
  const paths = stagedPathsForBatch({ slugs: ['this-one'] })
  const packPaths = paths.filter((p) => p.startsWith('research/packs/'))
  assert.deepEqual(packPaths, ['research/packs/this-one/'])
  assert.ok(!paths.includes('research/packs/other-pack/'), '不得暂存不属于本轮的包')
})

test('stagedPathsForBatch：多个 slug 各给一条，且不重复', () => {
  const paths = stagedPathsForBatch({ slugs: ['p1', 'p2', 'p1'] })
  const packPaths = paths.filter((p) => p.startsWith('research/packs/'))
  assert.deepEqual(packPaths, ['research/packs/p1/', 'research/packs/p2/'])
  assert.equal(new Set(paths).size, paths.length, '路径应去重')
})

test('stagedPathsForBatch：空清单时不暂存任何 research/packs/', () => {
  const paths = stagedPathsForBatch({ slugs: [] })
  assert.deepEqual(paths.filter((p) => p.startsWith('research/packs/')), [])
  // 其余固定产物仍在，缺了它们站点数据会退回到旧版本。
  assert.ok(paths.includes('patches/'))
  assert.ok(paths.includes('downloads/'))
})

test('stagedPathsForBatch：每条都是仓库相对路径（不带盘符/反斜杠）', () => {
  for (const p of stagedPathsForBatch({ slugs: ['demo-pack'] })) {
    assert.ok(!p.includes('\\'), `不应出现反斜杠：${p}`)
    assert.ok(!/^[a-zA-Z]:/.test(p), `不应出现盘符：${p}`)
    assert.ok(!p.startsWith('/'), `不应是绝对路径：${p}`)
  }
})

// ---- 批量路必须把 Range 模式传给 prepare-pack ----
//
// 2026-10-21 实测踩到的坑：`translate-local` 调 `prepare-pack` 时没传 `--quest-files-only`，
// 于是批量跑仍在整包下载（346 包 ≈ 14.8 GB），而只取语言文件只要约 67 MB。
// 开关落在 prepare-pack 上、却没接到调用方 —— 这种「功能做了但没接上」只有测试能拦。

test('prepareArgsForBatch：separate 包传 --quest-files-only（只取语言文件）', () => {
  const args = prepareArgsForBatch({ slug: 'demo', platform: 'cf', layout: 'separate-single' })
  assert.ok(args.includes('--quest-files-only'), 'separate 包应只取语言文件')
  assert.ok(args.includes('--no-keep-zip'))
})

test('prepareArgsForBatch：embedded 包不传 --quest-files-only（章节文件太多）', () => {
  // 内嵌包必须拿到全部 chapters/*.snbt 才知道哪些有文本（atm10 是 82 个），
  // 逐个 Range 不如整包一次下完。
  const args = prepareArgsForBatch({ slug: 'demo', platform: 'cf', layout: 'embedded' })
  assert.ok(!args.includes('--quest-files-only'), '内嵌包应整包下载')
})

test('prepareArgsForBatch：Modrinth 包带 --platform mr', () => {
  const args = prepareArgsForBatch({ slug: 'demo', platform: 'mr', layout: 'separate-single' })
  const i = args.indexOf('--platform')
  assert.ok(i >= 0, '应带 --platform')
  assert.equal(args[i + 1], 'mr')
})

test('prepareArgsForBatch：CF 包不带 --platform（默认就是 cf）', () => {
  const args = prepareArgsForBatch({ slug: 'demo', platform: 'cf', layout: 'separate-dir' })
  assert.ok(!args.includes('--platform'), 'CF 是默认值，不必显式传')
})

test('prepareArgsForBatch：--ids 用该包的 slug', () => {
  const args = prepareArgsForBatch({ slug: 'my-pack', platform: 'cf', layout: 'separate-single' })
  const i = args.indexOf('--ids')
  assert.ok(i >= 0)
  assert.equal(args[i + 1], 'my-pack')
})

// ---- 断点续跑不能只信本机 state 文件 ----
//
// 2026-10-21 实测踩到的坑：serv00 跑完 72 个包，产物全在 `patches/<slug>/`，
// 但 `research/local-batch-state.json` 在 `.gitignore` 里、跨机不同步。
// 换一台机器重跑时 state 里一个都没有 → 72 个包会被整体重翻（含 25 分钟的 tensura-waka-edition）。
//
// 产物本身才是权威：`patches/<slug>/` 存在且含 `.snbt` 就是「翻过」，
// 因为它必须入库才能发布，天然跟着 git 走。

test('isAlreadyTranslated：patches/<slug>/ 里有 .snbt 就算翻过（不依赖 state）', () => {
  assert.equal(typeof isAlreadyTranslated, 'function')
  const root = mkdtempSync(join(tmpdir(), 'done-'))
  mkdirSync(join(root, 'patches/has-patch/config/ftbquests/quests/lang'), { recursive: true })
  writeFileSync(join(root, 'patches/has-patch/config/ftbquests/quests/lang/zh_cn.snbt'), '{}')
  mkdirSync(join(root, 'patches/empty-patch'), { recursive: true })
  assert.equal(isAlreadyTranslated(root, 'has-patch'), true)
  assert.equal(isAlreadyTranslated(root, 'empty-patch'), false, '空目录不算翻过')
  assert.equal(isAlreadyTranslated(root, 'never-heard-of-it'), false)
  rmSync(root, { recursive: true, force: true })
})

test('isAlreadyTranslated：只认 patches/，不认 research/packs/（那是英文源不是产出）', () => {
  const root = mkdtempSync(join(tmpdir(), 'done2-'))
  mkdirSync(join(root, 'research/packs/en-only/config/ftbquests/quests/lang'), { recursive: true })
  writeFileSync(join(root, 'research/packs/en-only/config/ftbquests/quests/lang/en_us.snbt'), '{}')
  assert.equal(isAlreadyTranslated(root, 'en-only'), false, '英文源存在不代表翻过')
  rmSync(root, { recursive: true, force: true })
})

test('pendingWorklist：state 与产物取并集，任一判定翻过就跳过', () => {
  assert.equal(typeof pendingWorklist, 'function')
  const root = mkdtempSync(join(tmpdir(), 'done3-'))
  mkdirSync(join(root, 'patches/from-artifact/config/ftbquests/quests/lang'), { recursive: true })
  writeFileSync(join(root, 'patches/from-artifact/config/ftbquests/quests/lang/zh_cn.snbt'), '{}')
  const all = [
    { slug: 'from-artifact' },   // 产物在，state 不在
    { slug: 'from-state' },      // state 在，产物不在
    { slug: 'untouched' },       // 都没有 → 待翻
  ]
  const state = { done: { 'from-state': {} }, failed: {} }
  const pending = pendingWorklist(root, all, state)
  assert.deepEqual(pending.map((p) => p.slug), ['untouched'])
  rmSync(root, { recursive: true, force: true })
})

test('pendingWorklist：explicit slug 清单不看已完成状态（要重翻就重翻）', () => {
  const root = mkdtempSync(join(tmpdir(), 'done4-'))
  mkdirSync(join(root, 'patches/already/config/ftbquests/quests/lang'), { recursive: true })
  writeFileSync(join(root, 'patches/already/config/ftbquests/quests/lang/zh_cn.snbt'), '{}')
  const all = [{ slug: 'already' }]
  const pending = pendingWorklist(root, all, { done: { already: {} }, failed: {} }, ['already'])
  assert.deepEqual(pending.map((p) => p.slug), ['already'])
  rmSync(root, { recursive: true, force: true })
})

// ---- `--slug` 时「已完成 N 个」不能算错 ----
//
// 2026-10-21 实测踩到：给了 `--slug one-pack` 后日志打出
// 「可翻译 1649 个，已完成 1648 个，本次处理 1 个」——
// 因为 `pendingWorklist` 在显式清单下只返回那 1 个，`all.length - pending.length` 就成了 1648。
// 这个数字会让人以为「已经翻完了 1648 个」，正好是交接误判的同类问题（数字有出处但口径错）。

test('describeWorklist：显式 slug 时「已完成」仍按 state+产物实况统计', () => {
  assert.equal(typeof describeWorklist, 'function')
  const root = mkdtempSync(join(tmpdir(), 'desc-'))
  mkdirSync(join(root, 'patches/done-one/config/ftbquests/quests/lang'), { recursive: true })
  writeFileSync(join(root, 'patches/done-one/config/ftbquests/quests/lang/zh_cn.snbt'), '{}')
  const all = [{ slug: 'done-one' }, { slug: 'todo-a' }, { slug: 'todo-b' }]
  const state = { done: {}, failed: {} }
  const d = describeWorklist(root, all, state, ['todo-a'])
  assert.equal(d.total, 3, '总数是候选包数')
  assert.equal(d.done, 1, '已完成只算真翻过的（产物 1 个），不受显式清单影响')
  assert.equal(d.selected, 1, '本次处理是显式清单里的')
  rmSync(root, { recursive: true, force: true })
})

test('describeWorklist：不给显式清单时 selected = 待翻数', () => {
  const root = mkdtempSync(join(tmpdir(), 'desc2-'))
  const all = [{ slug: 'a' }, { slug: 'b' }]
  const d = describeWorklist(root, all, { done: { a: {} }, failed: {} })
  assert.equal(d.done, 1)
  assert.equal(d.selected, 1)
  rmSync(root, { recursive: true, force: true })
})

// ---- farm 模式：入库只认补丁与基准源归档 ----
//
// 三台 serv00 主机共享同一个远端，各自的分支只该带「只有这台机器才有的东西」：
// 译文补丁 + 该包的 <slug>.tar.gz。downloads/site/术语/索引是各机自行生成、
// 由 CI 从 patches/ 重算的产物，推上去只会互相覆盖。

test('stagedPathsForBatch：farm 模式不含 downloads/site/术语/索引', () => {
  const paths = stagedPathsForBatch({ slugs: ['p1', 'p2'], farm: true })
  for (const forbidden of ['downloads/', 'site/data.json', 'glossary.json', 'research/index-dataset.json', 'research/par-out/']) {
    assert.ok(!paths.includes(forbidden), `farm 模式不该暂存 ${forbidden}`)
  }
  assert.deepEqual(paths, [
    'patches/p1/', 'research/packs/p1.tar.gz',
    'patches/p2/', 'research/packs/p2.tar.gz',
  ])
})

test('stagedPathsForBatch：farm 模式不暂存英文源目录（只推归档）', () => {
  const paths = stagedPathsForBatch({ slugs: ['p1'], farm: true })
  assert.ok(!paths.includes('research/packs/p1/'), '解包目录是中间态，永不入库')
  assert.ok(paths.includes('research/packs/p1.tar.gz'), '基准源以归档形态入库')
  assert.ok(!paths.includes('patches/'), 'farm 模式按包暂存，别的包的补丁不能顺手捎上')
})

test('farm 模式：打包必须先于删目录（否则闸门失去基准键集）', () => {
  // 「先删后打」在磁盘满时会把可重试的源和该有的归档一起丢掉，
  // 而只剩 patches/ 时 validate-quests 会退化成「找不到英文源，跳过该条」的假绿灯。
  // 这条顺序只能靠源码位置锁住：运行时很难稳定复现磁盘写失败。
  const iPack = SOURCE.indexOf('packBaseline(')
  const iRm = SOURCE.indexOf('rmSync(packDir')
  assert.ok(iPack > 0, 'farm 分支应调用 packBaseline')
  assert.ok(iRm > iPack, 'rmSync(packDir) 必须出现在 packBaseline 之后')
  // 推送失败要能被上层识别成「推送失败」，而不是混进「翻译失败」。
  assert.match(SOURCE, /process\.exitCode\s*=\s*3/, '推送失败应把退出码置 3')
  assert.ok(SOURCE.includes('commitAndPush('), 'farm 分支应走 lib/farm-git 的 commitAndPush')
})

test('freeBytesFromStatfs：可用块 × 块大小', () => {
  assert.equal(MIN_FREE_BYTES, 500 * 1024 * 1024)
  assert.equal(freeBytesFromStatfs({ bavail: 100, bsize: 4096 }), 409600)
  assert.equal(freeBytesFromStatfs({}), 0)
})

test('farmDiskGuard：清 par-out/tmp 与已打档的英文源，仍不足则 exit 4', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'))
  const mk = (rel, body = 'x') => {
    mkdirSync(join(root, rel), { recursive: true })
    writeFileSync(join(root, rel, 'f.txt'), body)
  }
  mk('research/par-out/p1')
  mk('research/tmp/unzip-1')
  mk('research/packs/packed-p1')           // 已打档 → 可删
  writeFileSync(join(root, 'research/packs/packed-p1.tar.gz'), 'gz')
  mk('research/packs/unpacked-p2')         // 没打档 → 必须留着（下一轮接着翻）

  const logs = []
  let code = 0
  // 把下限设成「任何真实磁盘都达不到」，模拟磁盘满：清理做完仍然不够 → exit 4。
  farmDiskGuard({
    root,
    minBytes: Number.MAX_SAFE_INTEGER,
    log: (l) => logs.push(l),
    exit: (c) => { code = c },
  })

  assert.equal(code, 4, '清理后仍不足应 exit 4')
  assert.equal(existsSync(join(root, 'research/par-out/p1')), false, 'par-out 应清空')
  assert.equal(existsSync(join(root, 'research/tmp/unzip-1')), false, 'research/tmp 应清空')
  assert.equal(existsSync(join(root, 'research/packs/packed-p1')), false, '已打档的目录应删')
  assert.equal(existsSync(join(root, 'research/packs/unpacked-p2')), true, '未打档的目录不能删')
  assert.ok(logs.some((l) => l.includes('占用明细')), '退出前应打印占用明细')
  rmSync(root, { recursive: true, force: true })
})

test('farmDiskGuard：空间充足时不动任何文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard2-'))
  mkdirSync(join(root, 'research/par-out/p1'), { recursive: true })
  writeFileSync(join(root, 'research/par-out/p1/f.txt'), 'x')
  let code = 0
  farmDiskGuard({ root, minBytes: 1, log: () => {}, exit: (c) => { code = c } })
  assert.equal(code, 0)
  assert.equal(existsSync(join(root, 'research/par-out/p1/f.txt')), true)
  rmSync(root, { recursive: true, force: true })
})

// ---------- pickTranslatable：跨平台去重 ----------
// 2026-10-24 实测：cf 行 format=none 的包在 mr 侧是 embedded，只认 cf 会让这些包
// 永远进不了队列（homestead / beyondberk / etbw 等 19 个就是这么漏的）。

const HEADER = 'platform\tid\tslug\tbytes\tformat\tnewEn\tnewZh\toldCh\tcdKB\tscannedAt'

test('pickTranslatable：不指定平台时按 slug 去重，取 newEn 更多的那行', () => {
  const tsv = [
    HEADER,
    'cf\t1\thomestead\t63053\tnone\t0\t0\t0\t9\tx',
    'mr\t2\thomestead\t112965569\tembedded\t24\t0\t24\t389\tx',
  ].join('\n')
  const rows = pickTranslatable(tsv)
  assert.equal(rows.length, 1, '同一 slug 只能出现一次')
  assert.equal(rows[0].platform, 'mr')
  assert.equal(rows[0].layout, 'embedded')
})

test('pickTranslatable：指定平台时仍按平台过滤，不做跨平台合并', () => {
  const tsv = [
    HEADER,
    'cf\t1\tp1\t100\tseparate-dir\t3\t0\t3\t10\tx',
    'mr\t2\tp1\t200\tembedded\t1\t0\t1\t10\tx',
  ].join('\n')
  assert.equal(pickTranslatable(tsv, { platform: 'cf' }).length, 1)
  assert.equal(pickTranslatable(tsv, { platform: 'cf' })[0].layout, 'separate-dir')
})

test('pickTranslatable：自带中文（newZh>0）与不可产出 format 依然被排除', () => {
  const tsv = [
    HEADER,
    'cf\t1\ta\t100\tembedded\t3\t5\t3\t10\tx',
    'mr\t2\tb\t100\tnone\t3\t0\t3\t10\tx',
  ].join('\n')
  assert.deepEqual(pickTranslatable(tsv), [])
})

test('pickTranslatable：includeSlugs 点名的包绕过 newZh>0 过滤，其余照旧被排除', () => {
  // 2026-10-25 实测：sky-energy-tech 等 3 个包 zh_cn 覆盖率仅 0~1.5%，newZh 的整包判断
  // 把它们误杀。--slug 显式点名的包（强制收录通道）应进入工作列表；
  // 默认（不带 includeSlugs）口径不变，批量路不会因此翻进自带中文的包。
  const tsv = [
    HEADER,
    'mr\t1\tsky-energy-tech\t100\tembedded\t30\t1\t3\t10\tx',
    'mr\t2\tother-zh-pack\t100\tembedded\t30\t9\t3\t10\tx',
  ].join('\n')
  assert.deepEqual(pickTranslatable(tsv), [], '默认口径：newZh>0 仍整包排除')
  const rows = pickTranslatable(tsv, { includeSlugs: ['sky-energy-tech'] })
  assert.equal(rows.length, 1, '点名的包应进入工作列表')
  assert.equal(rows[0].slug, 'sky-energy-tech')
  assert.equal(rows[0].layout, 'embedded', '平台/布局信息来自扫描行，不再是空壳 stub')
})

// ---------- farmExitFlush：分片收尾强制推剩余成果 ----------
// 2026-10-24 实测踩坑：work 主机一轮只剩 19 个包（< pushEvery=20），分片处理完直接退出，
// 19 个成果全部滞留在本地 HEAD，直到人工上机比对才发现。退出前必须补一次 commit+push。

test('farmExitFlush：分片跑完还有未推包（sincePush>0）→ 强制 commit+push 后再退出', () => {
  const calls = []
  const logs = []
  const res = farmExitFlush({
    farm: true, pushFailed: false, sincePush: 19, slugs: ['pack-a', 'pack-b'],
    root: '/repo', branch: 'farm/work',
    push: (args) => { calls.push(args); return { ok: true, committed: 19, attempts: 1 } },
    log: (l) => logs.push(l),
  })
  assert.equal(res.flushed, true)
  assert.equal(res.ok, true)
  assert.equal(calls.length, 1, '退出前必须补推一次')
  assert.equal(calls[0].branch, 'farm/work', '只推 farm/<host> 分支')
  assert.deepEqual(calls[0].slugs, ['pack-a', 'pack-b'])
  assert.ok(logs.some((l) => l.includes('19') && l.includes('farm/work')), '日志要如实记这次收尾入库')
})

test('farmExitFlush：非 farm / 中途推送已失败退出 / 没有剩余 → 不再推', () => {
  const push = () => { throw new Error('不该调 push') }
  assert.equal(farmExitFlush({ farm: false, sincePush: 19, slugs: ['a'], root: '/r', branch: 'main', push }).flushed, false, '非 farm 不推')
  assert.equal(farmExitFlush({ farm: true, pushFailed: true, sincePush: 19, slugs: ['a'], root: '/r', branch: 'farm/work', push }).flushed, false, '中途推送失败已 break：产物在本地 HEAD，重跑即续推，不再重复报错')
  assert.equal(farmExitFlush({ farm: true, sincePush: 0, slugs: [], root: '/r', branch: 'farm/work', push }).flushed, false, '没有剩余不推')
})

test('farmExitFlush：收尾推送失败 → 带回错误让上层标 exit 3，不吞', () => {
  const res = farmExitFlush({
    farm: true, sincePush: 3, slugs: ['x'], root: '/r', branch: 'farm/work',
    push: () => ({ ok: false, committed: 3, attempts: 3, error: 'remote rejected' }),
    log: () => {},
  })
  assert.equal(res.flushed, true)
  assert.equal(res.ok, false)
  assert.equal(res.error, 'remote rejected')
})
