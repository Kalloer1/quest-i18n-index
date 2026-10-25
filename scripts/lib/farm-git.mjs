#!/usr/bin/env node
/**
 * farm 模式的 git 收尾：显式暂存 → 提交 → 带重试推送自己的分支。
 *
 * ## 为什么单独成模块
 *
 * `translate-local.mjs` 的非 farm 路径要**逐字**保持不变（推 main、失败只打一行继续），
 * 而 farm 路径的要求几乎相反：只推 `farm/<host>`、失败必须停机、要能扛住远端被别的
 * 主机抢先推。把两套语义塞在同一个 `if` 里，改一边必伤另一边；抽出来各自可测。
 *
 * ## 三条硬口径
 *
 * 1. **只 add 显式路径**：`patches/<slug>/` 与 `research/packs/<slug>.tar.gz`。
 *    `downloads/`、`site/`、`research/index-dataset.json`、`glossary.json` 由主机侧
 *    各自生成，推上去只会打架；`research/par-out/` 是中间态，永远不该入库。
 * 2. **无改动不提交**：`git status --porcelain` 为空直接返回 ok / committed 0。
 *    空提交在 farm 分支上会被 CI 当成一次「增量」，白跑一次合并。
 * 3. **推送失败不抛**：返回 `{ok:false, error}`，让上层区分「翻译失败」与「推送失败」。
 *    抛出的话上层只能 catch 成一条日志，跟翻译失败混在一起，事后无从分辨。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 一次推送失败后的等待基数：第 n 轮等 n × 15s（不是固定 15s，避免三台主机同频重试）。 */
const RETRY_DELAY_MS = 15_000

/**
 * 同步睡眠。
 *
 * `commitAndPush` 刻意保持同步：它只被主循环顺序调用，异步化会让「推送中」与
 * 「下一个包开始翻译」交错，日志顺序变得不可读。Node 没有 sync sleep，用
 * `Atomics.wait` 阻塞当前线程是最小代价的写法（不占 CPU、不引入依赖）。
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 跑一条 git 命令，**从不抛**。失败时把 stderr 完整带回来。
 *
 * 用 `execFileSync` 而不是 `execSync`：参数不经过 shell，slug 里有空格/分号也不会
 * 被二次解释（`packBaseline` 的产物名来自 slug，属于外部输入）。
 *
 * @param {string} root 仓库根（也是 cwd）
 * @param {string[]} args
 * @returns {{ok: boolean, stdout: string, stderr: string}}
 */
function git(root, args) {
  try {
    const stdout = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      // stdin 用 'ignore'：git 偶尔会读 stdin（凭据、编辑器），无人值守时必须断开，
      // 否则一个 `git commit` 卡在编辑器里，整个流水线就静默停摆。
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    })
    return { ok: true, stdout, stderr: '' }
  } catch (err) {
    const stderr = String(err?.stderr ?? '').trim()
    return {
      ok: false,
      stdout: String(err?.stdout ?? ''),
      stderr: stderr || String(err?.message ?? err),
    }
  }
}

/**
 * `git rev-list --count HEAD..FETCH_HEAD` 的输出 → 是否落后远端。
 *
 * 抽成纯函数是为了能穷举 git 的各种输出形态：空（没有 FETCH_HEAD）、`0`、
 * 带换行的数字、多个数字（理论上不该出现，但宁可判定为落后也不要漏 rebase）。
 * 解析不出整数时返回 false —— 那种情况多半是命令本身失败，调用方已在别处处理，
 * 这里把「读不懂」当成「不落后」比当成「落后」安全（后者会去 rebase 一个不存在的提交）。
 *
 * @param {string} output
 * @returns {boolean}
 */
export function isBehind(output) {
  const nums = String(output ?? '').match(/\d+/g)
  if (!nums) return false
  return nums.some((n) => Number.parseInt(n, 10) > 0)
}

/**
 * `farm/gfdrgfd` → `gfdrgfd`。没有 `/` 时原样返回（便于把非 farm 分支也传进来）。
 *
 * @param {string} branch
 * @returns {string}
 */
export function hostFromBranch(branch) {
  const b = String(branch ?? '')
  const i = b.indexOf('/')
  return i < 0 ? b : b.slice(i + 1)
}

/**
 * farm 模式下本轮该暂存的候选路径（**不含** downloads/site/glossary/索引）。
 *
 * 只给候选，是否 add 由 `commitAndPush` 用 `existsSync` 过滤：包翻失败时
 * `patches/<slug>/` 可能已经写了一部分、`research/packs/<slug>.tar.gz` 可能还没打出来，
 * 一次 `git add` 一个不存在的路径会让整条命令失败，把「这个包没产出」升级成「整批推不上去」。
 *
 * @param {{slugs?: string[]}} [batch]
 * @returns {string[]}
 */
export function farmPathsForBatch({ slugs = [] } = {}) {
  const paths = []
  const seen = new Set()
  for (const slug of slugs) {
    const s = String(slug ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    paths.push(`patches/${s}/`)
    paths.push(`research/packs/${s}.tar.gz`)
  }
  return paths
}

/**
 * 从已暂存文件清单里数出「有几个整合包的产物」。
 *
 * 不能直接用 slugs.length：某个包可能因为内容没变而根本没进这次提交
 * （重跑同一包、译文完全相同），提交信息里的 N 会虚高。
 *
 * @param {string} stagedText `git diff --cached --name-only` 的输出
 * @returns {number}
 */
export function countCommittedPacks(stagedText) {
  const slugs = new Set()
  for (const raw of String(stagedText ?? '').split('\n')) {
    const p = raw.trim().replace(/^"(.*)"$/, '$1')
    const patch = /^patches\/([^/]+)\//.exec(p)
    if (patch) {
      slugs.add(patch[1])
      continue
    }
    const base = /^research\/packs\/([^/]+)\.tar\.gz$/.exec(p)
    if (base) slugs.add(base[1])
  }
  return slugs.size
}

/**
 * 暂存 + 提交 + 推送（farm 模式的主路径）。
 *
 * 推送逻辑：
 *   - 最多 `pushAttempts` 轮；每轮先 `fetch --depth=1`，然后分两路：
 *     · 远端 tip 已包含在本机 HEAD 里（merge-base --is-ancestor 判定）→ 安全强推。
 *       远端有的本机全有，强推不可能覆盖任何未收割内容；健康路径（主机在自己
 *       farm 分支上连续推进，上次推送的 tip 就是本次提交的祖先）本就走这里，
 *       -f 只是兕底浅仓库下 git 把快进误判成非快进的情况（交接 §2.5 三连败的
 *       根因之一）。用 --force-with-lease 钉住刚 fetch 到的 tip：fetch 与 push
 *       之间远端若又前进（多写者的 farm/ci 才可能），推送失败而不是静默覆盖。
 *     · 不是祖先 → 绝不强推（远端可能有未收割内容），落后就 rebase，然后普通推。
 *       rebase 失败立即 `--abort`：留下一个半完成的 rebase 会让后续每个 git 命令
 *       都报「already a rebase in progress」，比推送失败本身更难收拾。
 *   - fetch 失败**不**中止：远端还没有这条分支时 fetch 必然失败（首次推送），
 *     这种情况本来就该直接 push。
 *   - 全轮失败返回 `{ok:false, error}`（完整 stderr），**不抛**。
 *
 * `paths` / `message` / `fetch` / `log` 都是给非 farm 路径复用同一实现的逃生口；
 * 不传时就是 farm 的默认口径。
 *
 * @param {object} opts
 * @param {string} opts.root 仓库根
 * @param {string} opts.branch 目标分支（farm 模式是 `farm/<host>`）
 * @param {string[]} [opts.slugs] 本轮包
 * @param {number} [opts.pushAttempts] 最多推几轮
 * @param {(line: string) => void} [opts.log]
 * @param {string[]} [opts.paths] 显式暂存路径（覆盖 farm 默认清单）
 * @param {string} [opts.message] 提交信息（覆盖 farm 默认格式）
 * @param {boolean} [opts.fetch] 是否先 fetch+rebase（非 farm 保持旧的「直接 push」）
 * @param {number} [opts.retryDelayMs] 重试基数，仅测试用
 * @returns {{ok: boolean, committed: number, attempts: number, forced?: boolean, error?: string}}
 *   forced=true 表示走了「远端 ⊆ 本机 HEAD → 安全强推」路径
 */
export function commitAndPush({
  root,
  branch,
  slugs = [],
  pushAttempts = 3,
  log = console.log,
  paths,
  message,
  fetch = true,
  retryDelayMs = RETRY_DELAY_MS,
} = {}) {
  if (!root || !branch) return { ok: false, committed: 0, attempts: 0, error: '缺少 root 或 branch' }

  const batchPaths = paths ?? farmPathsForBatch({ slugs })
  for (const p of batchPaths) {
    if (!existsSync(join(root, p))) continue
    const r = git(root, ['add', '--', p])
    if (!r.ok) return { ok: false, committed: 0, attempts: 0, error: r.stderr }
  }

  // 无改动 → 不提交。`status` 非空但 `diff --cached` 为空，说明改动都在暂存范围之外
  // （别的代理的未跟踪文件、本机临时产物）：这时 commit 只会失败，不叫「有改动」。
  const status = git(root, ['status', '--porcelain'])
  if (!status.ok) return { ok: false, committed: 0, attempts: 0, error: status.stderr }
  if (!status.stdout.trim()) return { ok: true, committed: 0, attempts: 0 }

  const staged = git(root, ['diff', '--cached', '--name-only'])
  if (!staged.ok) return { ok: false, committed: 0, attempts: 0, error: staged.stderr }
  if (!staged.stdout.trim()) return { ok: true, committed: 0, attempts: 0 }

  const committed = countCommittedPacks(staged.stdout)
  const msg = message ?? `farm(${hostFromBranch(branch)}): ${committed} 个整合包`
  const commit = git(root, ['commit', '-q', '-m', msg])
  if (!commit.ok) return { ok: false, committed: 0, attempts: 0, error: commit.stderr }
  log(`${msg}（已提交本地）`)

  const rounds = Math.max(1, Number(pushAttempts) || 1)
  let lastError = ''

  for (let attempt = 1; attempt <= rounds; attempt++) {
    let failure = ''
    let force = false

    if (fetch) {
      // fetch 失败当作「远端没有这条分支」：首次推送就是这种，fetch 必然报
      // "couldn't find remote ref"。
      const f = git(root, ['fetch', '--depth=1', 'origin', branch])
      if (f.ok) {
        // 远端 tip 是否已包含在本机 HEAD 里。merge-base --is-ancestor 只看
        // FETCH_HEAD 这个提交本身可不可达，--depth=1 的浅 graft 截的是它的
        // 祖先链，不影响该判定。不是祖先（远端有本机没有的提交）时绝不强推，
        // 交回 rebase/普通推 —— 那种强推就是交接 §2.5 里「静默覆盖未收割内容」。
        const anc = git(root, ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'])
        if (anc.ok) {
          force = true
        } else {
          const behind = git(root, ['rev-list', '--count', 'HEAD..FETCH_HEAD'])
          if (behind.ok && isBehind(behind.stdout)) {
            log(`远端 ${branch} 有新提交（${behind.stdout.trim()} 个），rebase 后再推`)
            const rb = git(root, ['-c', 'rebase.autoStash=true', 'rebase', 'FETCH_HEAD'])
            if (!rb.ok) {
              git(root, ['rebase', '--abort'])
              failure = rb.stderr
            }
          }
        }
      }
    }

    if (!failure) {
      let pushArgs = ['push', 'origin', `HEAD:refs/heads/${branch}`]
      if (force) {
        const tip = git(root, ['rev-parse', 'FETCH_HEAD'])
        if (!tip.ok) {
          failure = tip.stderr
        } else {
          pushArgs = ['push', `--force-with-lease=refs/heads/${branch}:${tip.stdout.trim()}`,
            'origin', `HEAD:refs/heads/${branch}`]
        }
      }
      if (!failure) {
        const p = git(root, pushArgs)
        if (p.ok) return force
          ? { ok: true, committed, attempts: attempt, forced: true }
          : { ok: true, committed, attempts: attempt }
        failure = p.stderr
      }
    }

    lastError = failure
    log(`推送 origin/${branch} 失败（第 ${attempt}/${rounds} 轮）：${failure.split('\n').filter(Boolean).pop() ?? ''}`)
    if (attempt < rounds) sleepSync(retryDelayMs * attempt)
  }

  return { ok: false, committed, attempts: rounds, error: lastError }
}
