/**
 * shared/quest-links.mjs 的离线单元测试。
 *
 * 覆盖 Worker 提交入口的整合包链接解析：
 *  - parseCurseforgeModpackSlug：只认 /minecraft/modpacks/<slug>，容忍 http / 有无 www /
 *    尾部子路径 / 尾斜杠 / 查询串；其他分类与非法输入一律 null（绝不抛）
 *  - parseModrinthModpackSlug：只认 /modpack/<slug>（https）
 *
 * 不发任何网络请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCurseforgeModpackSlug,
  parseModrinthModpackSlug,
} from '../shared/quest-links.mjs'

// ---------- CurseForge ----------

test('parseCurseforgeModpackSlug：标准整合包链接', () => {
  assert.equal(
    parseCurseforgeModpackSlug('https://www.curseforge.com/minecraft/modpacks/better-mc-forge-bmc4'),
    'better-mc-forge-bmc4',
  )
})

test('parseCurseforgeModpackSlug：带尾部子路径 /files', () => {
  assert.equal(
    parseCurseforgeModpackSlug('https://www.curseforge.com/minecraft/modpacks/craftoria/files'),
    'craftoria',
  )
})

test('parseCurseforgeModpackSlug：末尾斜杠与查询串', () => {
  assert.equal(
    parseCurseforgeModpackSlug('https://www.curseforge.com/minecraft/modpacks/craftoria/'),
    'craftoria',
  )
  assert.equal(
    parseCurseforgeModpackSlug('https://www.curseforge.com/minecraft/modpacks/craftoria?foo=1'),
    'craftoria',
  )
})

test('parseCurseforgeModpackSlug：http 与无 www 都接受', () => {
  assert.equal(parseCurseforgeModpackSlug('http://curseforge.com/minecraft/modpacks/craftoria'), 'craftoria')
  assert.equal(parseCurseforgeModpackSlug('http://www.curseforge.com/minecraft/modpacks/craftoria'), 'craftoria')
})

test('parseCurseforgeModpackSlug：slug 含数字/点/下划线/连字符', () => {
  assert.equal(parseCurseforgeModpackSlug('https://www.curseforge.com/minecraft/modpacks/ftb-stoneblock-3'), 'ftb-stoneblock-3')
  assert.equal(parseCurseforgeModpackSlug('https://www.curseforge.com/minecraft/modpacks/a_b.c-1'), 'a_b.c-1')
})

test('parseCurseforgeModpackSlug：非整合包分类一律 null', () => {
  assert.equal(parseCurseforgeModpackSlug('https://www.curseforge.com/minecraft/shaders/bsl-shaders'), null)
  assert.equal(parseCurseforgeModpackSlug('https://www.curseforge.com/minecraft/mc-mods/jei'), null)
  assert.equal(parseCurseforgeModpackSlug('https://www.curseforge.com/minecraft/texture-packs/foo'), null)
})

test('parseCurseforgeModpackSlug：Modrinth 链接与随机串一律 null', () => {
  assert.equal(parseCurseforgeModpackSlug('https://modrinth.com/modpack/craftoria'), null)
  assert.equal(parseCurseforgeModpackSlug('craftoria'), null)
  assert.equal(parseCurseforgeModpackSlug('https://example.com/minecraft/modpacks/craftoria'), null)
  assert.equal(parseCurseforgeModpackSlug('https://www.curseforge.com/minecraft/modpacks/'), null)
  assert.equal(parseCurseforgeModpackSlug(''), null)
  assert.equal(parseCurseforgeModpackSlug(undefined), null)
  assert.equal(parseCurseforgeModpackSlug(null), null)
  assert.equal(parseCurseforgeModpackSlug(42), null)
})

test('parseCurseforgeModpackSlug：非法百分号转义返回 null 而不是抛', () => {
  assert.equal(parseCurseforgeModpackSlug('https://www.curseforge.com/minecraft/modpacks/%E0%A4%A'), null)
})

test('parseCurseforgeModpackSlug：非 http(s) 协议一律 null', () => {
  assert.equal(parseCurseforgeModpackSlug('ftp://www.curseforge.com/minecraft/modpacks/craftoria'), null)
})

// ---------- Modrinth ----------

test('parseModrinthModpackSlug：标准整合包链接', () => {
  assert.equal(parseModrinthModpackSlug('https://modrinth.com/modpack/craftoria'), 'craftoria')
  assert.equal(parseModrinthModpackSlug('https://www.modrinth.com/modpack/craftoria'), 'craftoria')
})

test('parseModrinthModpackSlug：查询串与末尾斜杠', () => {
  assert.equal(parseModrinthModpackSlug('https://modrinth.com/modpack/craftoria?x=1'), 'craftoria')
  assert.equal(parseModrinthModpackSlug('https://modrinth.com/modpack/craftoria/'), 'craftoria')
})

test('parseModrinthModpackSlug：只接受 https', () => {
  assert.equal(parseModrinthModpackSlug('http://modrinth.com/modpack/craftoria'), null)
})

test('parseModrinthModpackSlug：非整合包路径与 CF 链接一律 null', () => {
  assert.equal(parseModrinthModpackSlug('https://modrinth.com/shader/bsl-shaders'), null)
  assert.equal(parseModrinthModpackSlug('https://modrinth.com/mod/jei'), null)
  assert.equal(parseModrinthModpackSlug('https://www.curseforge.com/minecraft/modpacks/craftoria'), null)
  assert.equal(parseModrinthModpackSlug('https://modrinth.com/modpack/'), null)
  assert.equal(parseModrinthModpackSlug('craftoria'), null)
  assert.equal(parseModrinthModpackSlug(undefined), null)
})
