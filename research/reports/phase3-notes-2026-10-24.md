# Phase 3「玩家提交链路」实现说明（2026-10-24）

方案：`research/reports/final-plan-2026-10-24.md` §Phase 3（决策 #4/#5/#6/#15/#16 等，逐条按用户拍板实现，未重新设计）。

## 交付物一览

| # | 交付物 | 说明 |
|---|---|---|
| 3.1 | `scripts/build-identity.mjs`（`npm run identity`） | 产出 `research/pack-identity.json`、`research/pack-identity-needs-review.json`、`worker/library-lookup.mjs` |
| 3.2 | `scripts/requests.mjs`（`npm run requests`） | 队列消费器：拉队列 → 判重 → 判版本 → 调度翻译 → 回写 → 导出 jsonl |
| 3.3 | `.github/workflows/request-translate.yml` | CI 翻译主力，产物推 `farm/ci` |
| 3.4 | `scripts/publish-local.mjs` | farm/ci 认领（动态发现，无需常量数组）+ 第 8 步重建 identity 快照 |
| 3.5 | `worker/index.js` | `/status` 兼容英文 kind；提交响应带 groupId/版本；IP+groupId 24h 去重 |
| 3.6 | `site/request.html` + Worker admin 端点 | 管理区「翻译设置」「清除记录」 |
| 3.7 | `research/submissions.jsonl` 导出机制 | requests.mjs 首次运行自动导出（见下「重要事实」） |

## 端点与字段

**Worker（`wrangler.worker.toml`，push main 后 deploy.yml 自动部署 worker + pages，已确认 deploy.yml 第 45-57 行有 `wrangler deploy --config wrangler.worker.toml`）：**

- `POST /`：响应新增 `groupId`（归并组主 slug，无组即 slug 自身）、`currentVersion`（库内 fileName，来自 `worker/library-lookup.mjs` 快照）、`inLibrary`。库内已有但不在队列的包，message 直接是「该包已在库，当前版本 X」。
- `POST /` 防滥用：同 IP 哈希 + 同 groupId 24h 内只允许一次**新增**提交（KV 键 `submit:dedup:<hash>:<groupId>`，TTL 86400s）。重复提交已入队的 id 不算新增，不受此键影响。无 IP/缺盐降级为不去重。
- `POST /status`：status 字段现在接受中文枚举值**或**流水线英文 kind（`skipped-same-version` → 「已在库」，新增于 `shared/quest-status.mjs`）。
- `POST /admin/clear-records`（口令 `X-Passphrase`）：`{ids:[...]}` 或 `{all:true}`，删除条目并同步索引。
- `GET/POST /admin/llm-settings`（口令）：存 KV `llm-settings`；GET 只回 `baseUrl/model/keyMasked(••••后4位)/updatedAt`；POST 时 Key 留空沿用旧值，提交打码串（`••••`开头）不会覆盖真 Key。
- `wrangler.worker.toml` 的 `GITHUB_WORKFLOW_FILE` 从已删除的 `translate.yml` 改指 `request-translate.yml`（不改的话 /translate 会 dispatch 404）。

**队列状态**：新增 `已在库`（`STATUS.SKIPPED_SAME_VERSION`），站点徽章按已完成色渲染。

## 归并口径（决策 #6，严格版）

1. 按规范化标题（小写 + 去全部非字母数字）分组；
2. 自动归并当且仅当：组内**每平台至多一个成员** 且 **所有跨平台 pair 的 slug 相似度 ≥0.9**（相似度 = LCS/较长 slug，slug 先做同样规范化）；
3. 任何歧义（同平台多 slug、相似度不足）→ **整组**进 `needs-review`，绝不部分归并；
4. 组 id 优先取在库成员（`source-versions.json` 有记录），再按 cf>mr、slug 字典序。

当前数据实况：dataset 28816 条中有标题的 1083 条（其余 27733 条多为 no-quests 探测淘汰项，`title: null` 不参与分组）→ 标题组 999、自动归并 **83 组**、待人工 **1 组**（`veritypack` vs `verity-beta`，同平台 cf 同名）、单成员 915 组。
⚠ 方案里写的「494 组」与当前 dataset 实算不符（dataset 在定稿后重建过），以实算为准。

## requests.mjs 消费流程

```
GET /queue ─→ 每条 URL ─platform+slug→ groupId（pack-identity；无组=平台:slug）
            ─→ 库内版本？（source-versions.json → patches/<slug>/.source.json 兜底）
                 ├─ 无 ──────────────→ 待翻（新包，不受冷却限制）
                 ├─ 同版（CF 比 fileId / MR 比 fileName 版本串）→ skipped-same-version
                 │    回写「已在库」+ 追加 jsonl
                 └─ 不同版 / 最新版解析不出（决策 #5：一律重翻）→ 待翻
待翻 → 7 天冷却检查（requests-state.json 按 groupId；--force 跳过）
     → prepare-pack → translate-local --lanes 96 --redo-done → translate-fill --lanes 96
     → POST /status 回写 + 追加 research/submissions.jsonl
```

- `--dry-run` 只打印判定；`--only=<slug>` 单包；`--force` 跳冷却。
- 缺 `WORKER_URL`/`INTERNAL_STATUS_TOKEN` 直接退出；缺翻译凭据时只打印将执行的命令，**不伪造成功**。
- 每包翻译强制 `BATCH_PUSH_EVERY=0`：消费器绝不顺手推 main。
- 翻完打印「收批请跑 npm run publish」，不自动发布。
- **首次运行自动导出**：`research/submissions.jsonl` 不存在时把队列现状（含历史英文状态 done/failed/queued → 中文映射）整体导出。

## CI 工作流（request-translate.yml）

`workflow_dispatch`（inputs.ids）+ `repository_dispatch(types:[player-request], client_payload.ids)`。
步骤：tests 闸门 → prepare-pack（CF_KEY）→ translate-local 96 路 `--redo-done --push-every 0` → **translate-fill 96 路**（决策 #14）→ 基准源打 tar.gz → 推 `farm/ci`。
farm/ci 推送细节：commit-tree 固化产物 → 分支不存在直接建（基于 main）；已存在则临时 worktree 里逐 slug「先删后 restore」全量替换（防 publish 自检撞「树里比计划多文件」）。env 沿用旧 translate.yml 的 secret 名（LLM_BASE_URL/LLM_API_KEY/LLM_MODELS/FREE_TIER_*）。

## publish 端

主机清单**不是常量数组**：`git ls-remote --heads origin refs/heads/farm/*` 动态发现，farm/ci 出现即自动收割；空 diff / 分支不存在静默跳过（farm-merge 对空 plan 实测 exit 0）。唯一代码改动：第 8 步在 source-versions 之后跑 `build-identity`，刷新 `worker/library-lookup.mjs`（保持「已在库，当前版本 X」新鲜；内容没变时脚本自不重写、无假 diff），并把三个产物加入显式暂存清单。

## 没做的事 / 需要用户注意

1. **KV 现状：3 条历史提交已不存在**。用已登录的 wrangler 查了生产 `TRANSLATION_QUEUE`（namespace 115cc34d5853428aa32fe493f46d9268）：键列表为空（`queue:index` 也没有）。可能已被处理清掉。首次导出机制已就绪，队列再来记录时第一条命令就会落 `research/submissions.jsonl`。**没有伪造历史数据**。
2. **LLM 设置与翻译侧尚未接线**（决策 #15 的后半句）：管理区可存供应商地址/Key/模型到 KV，但 CI 翻译现在读的还是 GitHub secrets。把 KV 设置下发为翻译 env 需要改 request-translate.yml 开头加一步 KV 读取，属后续工单；页面上的说明文案（「翻译机器翻译时从这里取用；主机侧需重启才生效」）是按方案原文写的。
3. **worker/library-lookup.mjs 的时效性**：它是随仓库提交的快照，版本信息在每次 publish（第 8 步重建）或手跑 `npm run identity` 后刷新；publish 之间的新提交只会看到稍旧的「当前版本」。
4. 管理区口令 = `TRANSLATE_PASSPHRASE`（现有 secret，未改动）；admin 端点与 /translate 同一口令。
5. KV 里的 `llm-settings` 含**明文 Key**（翻译侧要取用；页面只回打码值）。泄露时管理页换 Key 即可。
6. 队列 KV 为空，`/admin/clear-records`、冷却、导出等只做过**本地 mock 端到端**（假 Worker + 假队列），未在真实 KV 上演练——下次有真实提交时建议先 `npm run requests -- --dry-run` 看判定。
7. 相似度口径：slug 先做规范化（去分隔符）再比 LCS，`all-the-mods-10` vs `all_the_mods_10` = 1.0；标题规范化后为空的（纯非拉丁标题）不参与分组——当前 dataset 无此情况。

## 测试

- `scripts/build-identity.test.mjs`：9 例（归并/不归并/歧义/汇总/lookup）。
- `scripts/requests.test.mjs`：11 例（URL→slug、CF fileId、MR 版本串、解析不出→重翻、7 天冷却、历史状态映射、jsonl 记录、identity 映射）。
- `scripts/worker-phase3.test.mjs`：14 例（/status 英文 kind、去重 429、clear-records、llm-settings 打码、maskKey、submitDedupKey）。
- 全套 `npm test` 见 commit 时运行记录；worker 打包用 `wrangler deploy --dry-run` 验证（未部署）。
