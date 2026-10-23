#!/usr/bin/env node
/**
 * 把 serv00 主机上跑出来的补丁拉回本机 `patches/<slug>/`。
 *
 * ## 为什么需要它
 *
 * 免费主机只负责算力（下载 / 翻译 / 写盘），产物必须回到本机才能校验、打包、发布。
 * 手工 `scp -r` 有三个坑，脚本把它们锁死：
 *   1. 传输中断会留下半个目录，而 `patches/<slug>/` 只要有一个 `.snbt` 就会被
 *      `translate-local.mjs` 判成「已翻过」——半个包会被永久跳过。
 *   2. 本机已有同名包时直接覆盖，可能把本机正在跑的后台任务刚写的产物踩掉。
 *   3. 主机的 `~/quest/patches/` 里可能混有失败留下的空目录，不能无条件全拉。
 *
 * ## 做法
 *
 * 远程 `tar czf - -C ~/quest patches/<a> patches/<b>` → SSH 管道 → 本地解到临时目录 →
 * 逐个 slug 校验「目录非空且含至少一个 `.snbt`」→ 校验通过才 `cp -r` 进 `patches/`。
 * 先解到临时目录是关键：校验失败的包一个字节都不会进仓库。
 *
 * 本机已存在且非空的 slug **默认跳过**（本机可能正在翻它，覆盖会打架），
 * 确实要更新时加 `--force`。
 *
 * ## 用法
 *
 *   node scripts/serv00-pull.mjs --host gfdrgfd
 *   node scripts/serv00-pull.mjs --host gfdrgfd --slugs dawn-craft,deceasedcraft
 *   node scripts/serv00-pull.mjs --host gfdrgfd --slugs dawn-craft --force
 *
 * `--host` 只给别名时补 `@s9.serv00.com`（三台免费机同一台物理机）；
 * 需要跳板时加 `--proxy "<ProxyCommand>"`，例如
 *   --proxy "D:/tools/connect.exe -H 127.0.0.1:10808 %h %p"
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, cpSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_PATCHES = join(ROOT, 'patches')
const DEFAULT_DOMAIN = 's9.serv00.com'

/** 只允许这些字符的 slug —— 它会被拼进远程 shell 命令，必须挡住注入。 */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 解析 `--key value` 形式的参数。
 * 布尔开关（force）出现即为 true；缺值或下一个是 `--` 时也当 true。
 * @param {string[]} argv
 * @param {string[]} [booleans]
 * @returns {Record<string, string|boolean>}
 */
export function parseArgs(argv, booleans = ['force']) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    if (booleans.includes(key)) { out[key] = true; continue }
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) { out[key] = true; continue }
    out[key] = v
    i++
  }
  return out
}

/**
 * 把 `--host` 补成 SSH 目标。
 * `gfdrgfd` 这种别名在本机没有 ssh config 条目，直接 `ssh gfdrgfd` 会解析失败；
 * 三台机都在 s9，补域名比要求用户每次写全名更省事。
 * @param {string} host
 * @param {string} [domain]
 * @returns {string}
 */
export function sshTarget(host, domain = DEFAULT_DOMAIN) {
  const h = String(host ?? '').trim()
  if (!h) throw new Error('缺少 --host')
  return h.includes('@') ? h : `${h}@${domain}`
}

/**
 * 决定这次实际要拉哪些 slug。
 *
 * 规则：
 *   - 请求里给了 slug 就只拉这些（远程不存在的要能报出来，不能静默少拉）；
 *   - 本机已有且非空 → 跳过，除非 force；
 *   - 其余全拉。
 *
 * @param {string[]} remote 远程 `~/quest/patches/` 下的目录名
 * @param {{requested?: string[], force?: boolean, localHas?: (slug: string) => boolean}} [opts]
 * @returns {{pull: string[], skippedLocal: string[], missingRemote: string[]}}
 */
export function planPull(remote, { requested = [], force = false, localHas = () => false } = {}) {
  const remoteSet = new Set(remote)
  const missingRemote = requested.filter((s) => !remoteSet.has(s))
  const candidates = requested.length ? requested.filter((s) => remoteSet.has(s)) : [...remote]
  const pull = []
  const skippedLocal = []
  for (const slug of candidates) {
    if (!SLUG_RE.test(slug)) continue
    if (!force && localHas(slug)) skippedLocal.push(slug)
    else pull.push(slug)
  }
  return { pull, skippedLocal, missingRemote }
}

/**
 * 目录里是否有至少一个 `.snbt`（递归）。
 *
 * 判定口径与 `translate-local.mjs:isAlreadyTranslated` 一致：只有 `.snbt` 才算产物，
 * 仅有 `par-out` 之类中间文件不算。
 * @param {string} dir
 * @returns {boolean}
 */
export function hasSnbt(dir) {
  if (!existsSync(dir)) return false
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (hasSnbt(join(dir, e.name))) return true
    } else if (/\.snbt$/i.test(e.name)) return true
  }
  return false
}

/**
 * 统计目录下 `.snbt` 的个数与总字节数（报告用）。
 * @param {string} dir
 * @returns {{files: number, bytes: number}}
 */
export function snbtStats(dir) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.snbt$/i.test(e.name)) { files++; bytes += statSync(full).size }
    }
  }
  if (existsSync(dir)) walk(dir)
  return { files, bytes }
}

/** 本机某 slug 是否已有可用产物（目录存在且有 .snbt）。 */
function localHas(slug) {
  return hasSnbt(join(LOCAL_PATCHES, slug))
}

/**
 * 跑一条 SSH 命令，返回 stdout；失败时抛错并带上 stderr 的首行。
 * @param {string} target
 * @param {string} remoteCmd
 * @param {{proxy?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<string>}
 */
function sshExec(target, remoteCmd, { proxy, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes']
    if (proxy) args.push('-o', `ProxyCommand=${proxy}`)
    args.push(target, remoteCmd)
    const p = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`ssh 超时 ${timeoutMs}ms：${remoteCmd.slice(0, 80)}`)) }, timeoutMs)
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`ssh 退出 ${code}：${(err.trim().split('\n').pop() || remoteCmd).slice(0, 200)}`))
    })
  })
}

/**
 * 远程 tar → 本地解包。整条链路走 SSH stdout 管道，不落中间 tar 文件。
 * @param {string} target
 * @param {string[]} slugs
 * @param {string} destDir
 * @param {{proxy?: string, remoteRoot?: string}} opts
 * @returns {Promise<void>}
 */
function fetchPatches(target, slugs, destDir, { proxy, remoteRoot = '~/quest' } = {}) {
  // slug 已过白名单，这里再拼成 tar 的成员路径。`--` 之后的都当路径，避免以 `-` 开头被当选项。
  const members = slugs.map((s) => `patches/${s}`).join(' ')
  const remoteCmd = `tar czf - -C ${remoteRoot} ${members}`
  return new Promise((resolve, reject) => {
    const sshArgs = ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes']
    if (proxy) sshArgs.push('-o', `ProxyCommand=${proxy}`)
    sshArgs.push(target, remoteCmd)
    const ssh = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    const tar = spawn('tar', ['xzf', '-', '-C', destDir], { stdio: [ssh.stdout, 'ignore', 'pipe'] })
    let err = ''
    ssh.stderr.on('data', (d) => { err += d })
    tar.stderr.on('data', (d) => { err += d })
    ssh.on('error', reject)
    tar.on('error', reject)
    // 两个进程都要成功：远程 tar 失败会写 stderr，本地 tar 拿到空流也会失败。
    //
    // ssh 必须听 `exit` 而不是 `close`：它把 stdout 交给了本地 tar，
    // 这个流永远不会回到我们手里，`close` 就不会触发（实测：tar 解完、
    // 两个子进程都退了，Node 因事件循环空掉直接以 0 退出，产物留在临时目录没被搬走）。
    let codeSsh = null
    let codeTar = null
    const done = () => {
      if (codeSsh === null || codeTar === null) return
      if (codeSsh === 0 && codeTar === 0) return resolve()
      reject(new Error(`拉取失败（ssh=${codeSsh} tar=${codeTar}）：${err.trim().split('\n').slice(-1)[0] ?? ''}`))
    }
    ssh.on('exit', (c) => { codeSsh = c; done() })
    tar.on('close', (c) => { codeTar = c; done() })
  })
}

/**
 * 列出远程 `~/quest/patches/` 下的 slug 目录。
 * @param {string} target
 * @param {{proxy?: string, remoteRoot?: string}} [opts]
 * @returns {Promise<string[]>}
 */
async function listRemoteSlugs(target, { proxy, remoteRoot = '~/quest' } = {}) {
  const out = await sshExec(
    target,
    `ls -1 ${remoteRoot}/patches 2>/dev/null || true`,
    { proxy, timeoutMs: 60_000 },
  )
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

async function main() {
  const opt = parseArgs(process.argv)
  const target = sshTarget(opt.host, opt.domain)
  const requested = typeof opt.slugs === 'string'
    ? opt.slugs.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  const force = Boolean(opt.force)
  const proxy = typeof opt.proxy === 'string' ? opt.proxy : undefined
  const remoteRoot = typeof opt['remote-root'] === 'string' ? opt['remote-root'] : '~/quest'

  console.log(`主机 ${target}${proxy ? '（经代理）' : ''} · 远程 ${remoteRoot}/patches`)
  const remote = await listRemoteSlugs(target, { proxy, remoteRoot })
  if (remote.length === 0) {
    console.log('远程没有任何补丁目录，什么都没有拉。')
    return
  }
  console.log(`远程 ${remote.length} 个补丁目录`)

  const plan = planPull(remote, { requested, force, localHas })
  for (const s of plan.missingRemote) console.log(`⚠ 远程不存在：${s}`)
  for (const s of plan.skippedLocal) console.log(`- 跳过（本机已有）：${s}  —— 需要覆盖加 --force`)
  if (plan.pull.length === 0) {
    console.log('没有需要拉取的包。')
    return
  }

  // 临时目录与 patches/ 同一盘符：万一需要跨盘拷贝也不会因空间不足半途而废。
  const tmp = mkdtempSync(join(tmpdir(), 'serv00-pull-'))
  try {
    console.log(`拉取 ${plan.pull.length} 个：${plan.pull.join(', ')}`)
    const started = Date.now()
    await fetchPatches(target, plan.pull, tmp, { proxy, remoteRoot })

    // 先校验、后落地：校验失败的包一个字节都不进 patches/，避免「半个包」被当成已完成。
    const okSlugs = []
    for (const slug of plan.pull) {
      const src = join(tmp, 'patches', slug)
      const st = snbtStats(src)
      if (st.files === 0) {
        console.log(`✘ ${slug}：解出的目录里没有 .snbt，不落地`)
        continue
      }
      const dest = join(LOCAL_PATCHES, slug)
      // 已有目录且非空时默认跳过；--force 才删旧目录重写。
      // 不 merge 是刻意的：远程这一轮的文件集才是完整产物，合并会留下上一轮的孤儿文件。
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(src, dest, { recursive: true })
      console.log(`✔ ${slug}：${st.files} 个 .snbt / ${st.bytes} 字节 → patches/${slug}/`)
      okSlugs.push(slug)
    }
    console.log(`完成 ${okSlugs.length}/${plan.pull.length} 个，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
    if (okSlugs.length !== plan.pull.length) process.exitCode = 1
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`✘ ${e?.message ?? e}`); process.exit(1) })
}
