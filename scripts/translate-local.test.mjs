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
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stagedPathsForBatch, prepareArgsForBatch, isAlreadyTranslated, pendingWorklist, describeWorklist } from './translate-local.mjs'

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
