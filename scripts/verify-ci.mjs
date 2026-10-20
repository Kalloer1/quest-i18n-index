#!/usr/bin/env node
/**
 * 在**干净克隆**里复跑闸门：`npm test` + `validate:quests`。
 *
 * ## 为什么需要它
 *
 * 2026-10-20 的教训：本机 `npm run validate:quests` 全绿，CI 却红了一整轮
 * （run `39426426002`：`✘ 批量校验失败：19/31 个产出有问题（19 个缺英文源）`）。
 *
 * 真因不是代码错，而是**本机磁盘上有 CI 看不到的东西**：21 个未跟踪的
 * `research/packs/<slug>/` 目录（英文源基准键集）只存在于工作区，
 * 没进 git。本机跑闸门时它们在场，于是通过；CI 拉仓库后它们不在，
 * 19 个包的译文就没有基准可比，闸门判红。
 *
 * 这类错误的共同形状是「验收环境与被验收环境不同」。唯一可靠的防法是
 * **在干净克隆里验一遍**——本脚本就是这句话的固化。
 *
 * ## 用法
 *
 *   node scripts/verify-ci.mjs              # clone → install → test → validate
 *   node scripts/verify-ci.mjs --skip-clone # 在已 clone 的目录里直接跑（调试用）
 *
 * 任何一步非零退出 → 本脚本非零退出，并打印是哪一步。
 * 刻意**不提供**任何能让它「静默通过」的参数。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 要跑的步骤清单（纯数据，便于测试）。
 *
 * `install` 单独一步是因为 `npm ci` 在 CI 上会因 lockfile 钉死国内镜像而间歇 504
 * （ADR-0009 D9），故回退 `npm install`。
 *
 * @returns {Array<{name: string, cmd: string, args: string[]}>}
 */
export function buildSteps() {
  return [
    { name: 'install', cmd: 'npm', args: ['ci'] },
    { name: 'test', cmd: 'npm', args: ['test'] },
    { name: 'validate', cmd: 'npm', args: ['run', 'validate:quests'] },
  ]
}

/**
 * 判定一次完整运行是否通过。
 *
 * 刻意写成「任一失败即失败」而不是「最后一个失败才算」——
 * 旧的手工验收正是只看最后一条命令的输出，才漏掉了中间步骤的失败。
 *
 * 空结果也判失败：一步都没跑成不能算绿（否则 clone 失败后静默通过）。
 *
 * @param {Array<{name: string, code: number|null}>} results
 * @returns {{ok: boolean, failedSteps: string[]}}
 */
export function judgeRun(results) {
  const list = Array.isArray(results) ? results : []
  if (list.length === 0) return { ok: false, failedSteps: ['(没有执行任何步骤)'] }
  const failedSteps = list.filter((r) => r.code !== 0).map((r) => r.name)
  return { ok: failedSteps.length === 0, failedSteps }
}

/** 从本地 `.git` 目录 clone 一个临时仓库（走 `file://`，不走网络）。 */
export function cloneLocal(target) {
  execFileSync('git', ['clone', '--depth', '1', pathToFileURL(join(ROOT, '.git')).href, target], {
    stdio: 'inherit',
  })
}

/**
 * 跑一步命令，返回退出码（不抛错，让调用方统一汇总）。
 *
 * `shell` 只在 Windows 上开：`npm` 在那上面是 `npm.cmd` 的 shim，
 * `execFileSync('npm', ...)` 会直接 ENOENT（实测），而 `npm.cmd` 在
 * shell:false 下又是 EINVAL（Node 的 Windows 安全限制）。
 * 本脚本的命令与参数都是写死的常量，不开 shell 的注入风险在这里不存在。
 */
function runStep(step, cwd) {
  process.stdout.write(`\n▶ ${step.name}: ${step.cmd} ${step.args.join(' ')}\n`)
  const started = Date.now()
  try {
    execFileSync(step.cmd, step.args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    console.log(`✔ ${step.name}（${((Date.now() - started) / 1000).toFixed(1)}s）`)
    return { name: step.name, code: 0 }
  } catch (e) {
    console.error(`✘ ${step.name} 失败（退出码 ${e.status ?? e.code ?? '?'}）`)
    return { name: step.name, code: e.status ?? 1 }
  }
}

function main() {
  const skipClone = process.argv.includes('--skip-clone')
  let dir = ROOT
  let cleanup = () => {}

  if (!skipClone) {
    if (!existsSync(join(ROOT, '.git'))) {
      console.error('✘ 找不到 .git，无法 clone 干净副本')
      process.exit(1)
    }
    const target = mkdtempSync(join(tmpdir(), 'quest-verify-ci-'))
    console.log(`clone 到 ${target}`)
    try {
      cloneLocal(target)
    } catch (e) {
      console.error(`✘ clone 失败：${String(e?.message ?? e).slice(0, 200)}`)
      rmSync(target, { recursive: true, force: true })
      process.exit(1)
    }
    dir = target
    cleanup = () => rmSync(target, { recursive: true, force: true })
  } else {
    console.log('--skip-clone：在现有目录里跑（调试用，不代表 CI 环境）')
  }

  const results = []
  try {
    for (const step of buildSteps()) {
      let r = runStep(step, dir)
      // `npm ci` 在 lockfile 与 node_modules 不一致时会失败；CI 上的真问题是镜像 504。
      // 两条都靠回退 `npm install` 兜住。
      if (r.code !== 0 && step.name === 'install') {
        console.log('… npm ci 失败，回退 npm install')
        r = runStep({ name: 'install(fallback)', cmd: 'npm', args: ['install'] }, dir)
      }
      results.push(r)
      if (r.code !== 0) break // 后续步骤依赖前面，继续跑只会产生误导性噪声
    }
  } finally {
    cleanup()
  }

  const { ok, failedSteps } = judgeRun(results)
  if (!ok) {
    console.error(`\n✘ 干净克隆里验收失败：${failedSteps.join(', ')}`)
    process.exit(1)
  }
  console.log('\n✔ 干净克隆里全部通过（npm test + validate:quests）')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) main()
