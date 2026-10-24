# Phase 3「玩家提交链路」独立验收报告（2026-10-24）

- 审核者：审核子代理（独立执行，未采信执行者自述，全部结论来自本机实跑命令与代码逐行阅读）
- 待验收 commit：`ee4aa66f7`（identity）、`544ac36ae`（requests）、`29a13abb4`（worker）、`4244d5f3f`（site）、`80b6b6844`（ci）、`66b9ffd18`（docs）
- 验收标准：`research/reports/final-plan-2026-10-24.md` Phase 3 表格 + 决策 #1/2/3/5/6/15/16
- 约束遵守：全程只读 + 写本报告；未修复、未 push、未跑 publish、未动主机、未真调 LLM

---

## 逐项验证结果

### 1. identity（`ee4aa66f7`）— ✅

**归并条件**（`scripts/build-identity.mjs`）：

- 归并口径 = 按「规范化标题」分组（小写 + 去掉全部非字母数字，`normalizeKey`，build-identity.mjs:47）+ 组内每个平台至多一个成员 + **所有跨平台 pair** 的 slug 相似度 ≥0.9（`SIMILARITY_THRESHOLD = 0.9`，build-identity.mjs:77；相似度 = LCS / 较长 slug，两侧先同样规范化）。与决策 #6 逐字一致。
- **歧义整组进 needs-review，绝不部分归并**：代码先查「同平台多个 slug」（build-identity.mjs:99-104），再遍历全部 pair 查相似度（build-identity.mjs:108-115），任一命中即整组返回 `review`、`merged: null`，不存在部分归并路径。✅

**重点找茬结果**：

- 规范化对大小写/非字母数字：`'Better MC [FORGE] BMC4' → 'bettermcforgebmc4'`（测试断言），null/空 → `''`（空标题不参与分组，build-identity.mjs:146）。处理正确。
- **同平台两个同名包不会错误归并**：`dupPlatform` 检查在相似度判定**之前**，同名同平台多 slug 一律进 needs-review。实际数据里恰好有真实案例：`research/pack-identity-needs-review.json` 中 VerityPack（cf 上 `veritypack` 与 `verity-beta` 同名同平台）整组进人工清单，未归并。代码 + 测试（build-identity.test.mjs「同平台多个 slug → 歧义」用例）+ 生产数据三方印证。

**结构**：`research/pack-identity.json` = `{ generatedAt, groups: [{ id, title, members: [{ platform, slug }] }] }`，符合方案。needs-review 文件带 `count` 与 `reason`。`worker/library-lookup.mjs` 为纯 .mjs 常量导出（文件头注释解释了为何不用 JSON——import attribute 兼容坑，合理）。

**单测**（`scripts/build-identity.test.mjs`，9 例）：归并（2 例，含主 slug 在库优先）、不归并（相似度 <0.9 整组 review）、歧义（同平台多 slug 整组 review）、normalizeKey/lcsLength/slugSimilarity、buildIdentity 汇总、buildLookup。覆盖归并/不归并/歧义三类 ✅。

**注记**（建议级）：LCS 相似度下 `craftoria` vs `craftoriaf` = 9/10 = 0.9，恰好达阈值会被自动归并——这是决策 #6 拍板 0.9 阈值的固有权衡，不是实现偏差；当前 needs-review 仅 1 组，实际风险低。另 `mergeTitleGroup` 取 `members[0].title` 作组标题展示，同组 title 变体不影响主键选取，仅影响展示，极轻微。

### 2. requests.mjs（`544ac36ae`）— ✅（一处边缘缺陷，见问题清单 #1）

**URL→slug 抽取**（实际逻辑在 `shared/quest-links.mjs`，requests.mjs:71 `extractTarget` 调用）：

- CF：`/^\/minecraft\/modpacks\/([^/]+)/i`，实测 `https://www.curseforge.com/minecraft/modpacks/craftoria` → `craftoria`，带 `/files` 尾路径也能解析，`/minecraft/mods/jei` → null ✅
- **Modrinth 结论（实测验证）**：Modrinth 整合包页面的规范路径是 **`/modpack/<slug>`**（不是 `/mod/`）。实现用 `/^\/modpacks?\/([^/]+)/i`，实测 `modrinth.com/modpack/x` 与 `modrinth.com/modpacks/x` **两种都能用**；`modrinth.com/mod/<slug>` → null。`/mod/` 是模组（非整合包）路径，**应当拒绝**，当前行为正确——即不存在「两种都要能用」的问题，是「只该认 /modpack/，且 /modpack/ 与 /modpacks/ 都已兼容」。✅

**版本判定方向**（决策 #5）：`isSameVersion`（requests.mjs:100-112）CF 比 fileId、MR 比 fileName 版本串，**任一侧解析不出（null）一律返回 false → 重翻**。主流程 requests.mjs:308-324：`latest` 拉不到时置 `latestErr` 并以 `isSameVersion(platform, lib, null)` 判 false，reason 明写「按决策 #5 一律视为需要重翻」。一致 → skip（回写 `SKIPPED_SAME_VERSION` + 「已在库，当前版本 X」）。方向正确 ✅。

**7 天冷却**：`state[groupId]` 记上次重翻时间（requests.mjs:337、376-379），`cooldownAllowed` 纯函数（≥7 天放行，缺失/非法放行），`--force` 跳过，**新包（不在库）不受冷却限制**（`lib &&` 前置条件）。与方案 §3.6 一致 ✅。

**`--dry-run`**：跳过首次导出（requests.mjs:285 注释明确「--dry-run 只判定不落盘」）、skip 分支的 postStatus/appendSubmission 在 `if (!DRY)` 内（requests.mjs:329-332）、冷却分支同样受闸（requests.mjs:339）、DRY 分支直接 continue 不跑翻译（requests.mjs:343-346）。**但**：URL 解析失败分支的 `appendSubmission`（requests.mjs:299）**没有** DRY 闸门——dry-run 下若队列里有解析失败的条目会写 submissions.jsonl。属条件触发的边缘缺陷（本轮 3 条历史提交 URL 均可解析，验收路径未踩中），见问题清单 #1。

**不自动 publish**：翻完只打印「收批请跑 npm run publish（不自动发布）」（requests.mjs:382），无任何 git/发布调用 ✅。

**单测**（`scripts/requests.test.mjs`，11 例）：全部纯函数 + 假数据，import 的网络函数（fetchLatestMr/Cf）未被测试触达，**绝无真调 LLM/网络** ✅。

### 3. request-translate.yml（`80b6b6844`）— ✅

- 触发：`workflow_dispatch`（inputs.ids 必填）+ `repository_dispatch [player-request]`（client_payload.ids）✅
- 测试闸门：`Run tests: npm test` 在 Prepare packs **之前**（工作流 68-69 行）✅
- 96 路：`--lanes 96 --redo-done --push-every 0`（绝不顺手推 main）✅
- translate-fill 在 translate **之后**独立 step（决策 #14）✅
- **farm/ci 推送安全性**：`git commit-tree` 固化产物 commit（不挪 HEAD，main 不动）；farm/ci 不存在才创建；已存在时在临时 worktree 里**逐 slug 先删后 restore**（全量替换本批 slug，`git add` 全部显式限定路径），只碰 `patches/<slug>` 与 `research/packs/<slug>.tar.gz`，**不会误删 farm/ci 上别的东西**；无产物时 `git diff --cached --quiet` 报错退出不动分支 ✅
- concurrency `repo-write` 与 deploy 串行，防互踩 ✅
- secrets 与仓库实际配置核对（`gh secret list`）：CF_KEY、LLM_BASE_URL、LLM_API_KEY、FREE_TIER_ENABLED、FREE_TIER_BASE_URL、FREE_TIER_MODEL 均存在；`LLM_MODELS` 仓库未配置但写法为 `${{ secrets.LLM_MODELS || '' }}` 有兜底（可选项，见问题清单 #3）✅

### 4. publish 端（`scripts/publish-local.mjs`）— ✅

- **主机发现机制**：`git ls-remote --heads origin refs/heads/farm/*`（publish-local.mjs:182）动态发现，farm/ci 一出现即被当一台主机收割；远端无 farm/* 时打印「无事可做」静默退出（publish-local.mjs:187）——空分支容忍 ✅。该机制是**预先存在**的代码，本次 diff 只在文件头注释补充了 farm/ci 的说明。
- **未破坏原有 5+1 主机逻辑**：`git diff 86ea1a44c..HEAD -- scripts/publish-local.mjs` 共 16 行改动，全部为：文件头注释、发布自检 allowed 白名单追加 3 个 identity 产物（worker/library-lookup.mjs、pack-identity.json、pack-identity-needs-review.json）、step 8 追加一行 `run('node', ['scripts/build-identity.mjs'])`、step 9 暂存路径数组追加同样 3 项。**无任何删除**，主机合并/收割/自检逻辑原样 ✅。

### 5. Worker 安全（`29a13abb4`）— ✅（重点审查项，逐条过）

- **口令鉴权**：`POST /admin/clear-records` 与 `GET/POST /admin/llm-settings` 均第一行调 `requirePassphrase`（worker/index.js:557、596），后者用与 `/translate` 完全相同的 `verifyPassphrase(X-Passphrase, TRANSLATE_PASSPHRASE)` 机制（worker/index.js:541-548）。路由处 method 白名单正确（worker/index.js:702-710）。单测覆盖 401（错口令）路径 ✅。
- **GET 绝不返回明文 Key**：只回 `keyMasked: maskKey(saved?.key)`（worker/index.js:607），`maskKey` 只留后 4 位（worker/index.js:536-539）。单测显式断言 `!JSON.stringify(gotData).includes('sk-abcdef123456')` ✅。（注记：≤4 字符的 Key 会被「打码」后全量暴露——实际 LLM Key 远长于 4 位，风险可忽略。）
- **留空沿用旧 Key、打码串不覆盖真 Key**：worker/index.js:632 `key: key && !key.startsWith('••••') ? key : (saved.key ?? '')` —— 空/打码串均沿用 `saved.key`，只有全新值才覆盖。单测两路径都验证：存 `sk-real-key-9999` 后提交 `••••9999`，KV 里仍是旧真值且 model 正常更新 ✅。
- **IP+groupId 去重只存哈希**：`submitDedupKey(hash, groupId)` → `submit:dedup:<sha256(盐|ip)>:<groupId>`（shared/submit-limit.mjs:25-28），hash = `sha256(INTERNAL_STATUS_TOKEN + '|' + ip)`（worker/index.js:212），**KV 键与值均无明文 IP**。单测用 `node:crypto` 复算同款哈希预置键验证 429 ✅。
- **skipped-same-version**：`toStatusValue('skipped-same-version') → STATUS.SKIPPED_SAME_VERSION（'已在库'）`（shared/quest-status.mjs:43），/status 兼容英文 kind（worker/index.js:501-510）；站点 `STATUS_META` 增加 `"已在库": { state: "done" }`（request.html）。单测端到端验证 KV 落库为「已在库」✅。
- **提交响应信息泄露**：`groupId` = 组主 slug 或 slug 自身、`currentVersion` = 库内 fileName（如 "Craftoria 1.2.zip"）、`inLibrary` = 布尔。全是玩家可见的公开语义，**无内部路径/凭据** ✅。

### 6. 站点 UI（`4244d5f3f`）— ✅

- 两块新面板代码在 `site/request.html`：**「翻译设置（LLM 供应商）」**（约 451-468 行）与**「清除队列记录」**（约 470-480 行），均在 `#admin-section` 内的 `#admin-gate`（`hidden`，口令通过后才显示，request.html:441）里。
- 清除记录：复选清单（`renderAdminRecords`）+ 全选 checkbox + `window.confirm("确定清除所选 N 条队列记录吗？此操作不可恢复。")` 二次确认 ✅（决策 #16）。
- Key：输入框 `type="password"`，placeholder 显示 `已保存 ••••xxxx（留空沿用）`，值永不清空回显明文 ✅。
- 普通玩家视图：管理面板默认 hidden；后端端点另有口令鉴权双保险（第 5 项已验）✅。状态条新增「已在库」映射，玩家提交已入库包会看到「当前版本 X」提示（worker message，worker/index.js:300-304）✅。

### 7. 测试 — ✅

- 亲跑 `npm test`：**633 pass / 0 fail / 0 skipped**（132s）。
- Phase 3 新增单测逐文件清点：requests.test.mjs **11** 例 + build-identity.test.mjs **9** 例 + worker-phase3.test.mjs **14** 例 = **34 例**，与执行者声称的 34 对得上 ✅。worker-phase3.test.mjs 全程内存 KV 假实现，无真实网络。

### 8. 无越权 — ✅

- `git diff 86ea1a44c..HEAD --stat`：17 个文件、+3031/-19，全部在 Phase 3 预期范围（workflow、identity、requests、worker、site、publish-local、docs、package.json、wrangler.worker.toml）。
- 按名过滤 `quark|ibx|tmp/|patches/|downloads/`：**零命中**——未碰夸克、`research/tmp/ibx.py`、`patches/`、`downloads/` ✅。
- `publish-local.mjs` 的改动仅 farm/ci/identity 相关（第 4 项已逐行确认）✅。

### 9. 部署 — ✅

- `gh run view 40064412216`：conclusion **success**，headSha = `66b9ffd18…`（即 docs commit，部署的是最新 HEAD）。
- deploy.yml 实含 **Deploy Worker** 步骤（`wrangler deploy --config wrangler.worker.toml`，在 Pages 之前），run 中该步骤 success——**Worker 确实被部署** ✅。

### 10. 遗留问题核实（生产 KV 队列）— ❌ 执行者自述不实

- `npx wrangler kv key list --binding TRANSLATION_QUEUE --config wrangler.worker.toml --remote`（只读）：生产 KV **不是空的**，含 `queue:index` + **3 条队列记录**：

| 记录 | 状态 | 提交/更新时间 |
|---|---|---|
| skyfactory-5 | 翻译中 | 10-18 / 10-18 |
| ciscos-fantasy-medieval-rpg-dragonfyre | 失败（处理超时 840s） | 10-23 / 10-23 |
| lucky-world-invasion | 失败（免费层 HTTP 504） | 10-23 / 10-23 |

- 公平口径：若执行者意指「**待翻译**条目为空」，属实（3 条中 0 条待翻译）；但「生产 KV 队列为空」字面不成立。且这 3 条历史记录正是 requests.mjs 首次运行要导出/判定的对象——`--dry-run` 验收的 3 条历史提交应即为此。
- 附带发现：生产 KV 中**没有 `llm-settings` 键**——管理页「保存翻译设置」尚未在生产端实际操作过（功能本身有单测覆盖，见第 5 项）。见问题清单 #2。

---

## 问题清单（按严重度排序）

**阻断级：无。**

**建议级：**

1. **`--dry-run` 有一处未受闸门的写盘副作用**（`scripts/requests.mjs:299`）：URL 解析失败分支的 `appendSubmission(...)` 不在 `if (!DRY)` 内。dry-run 遇到解析失败的队列条目时仍会写 `research/submissions.jsonl`，与「--dry-run 不写 jsonl」的约定在边缘场景不符。验收用的 3 条历史提交 URL 均可解析，未踩中。修法极简（套一层 `!DRY`），本次不修（审核约束）。
2. **执行者自述「生产 KV 队列为空」与事实不符**：实际 3 条记录（1 翻译中 + 2 失败，均为历史遗留）。不构成功能缺陷（0 条待翻译、消费器首跑会处理），但反映收尾自检不严。另：生产 KV 无 `llm-settings` 键，决策 #15 的「保存后 KV 可读」只过了单测、未做生产端到端验证——建议管理页实际保存一次并复查 KV。
3. **`LLM_MODELS` secret 未在仓库配置**：工作流有 `${{ secrets.LLM_MODELS || '' }}` 兜底，属可选项；若想锁定模型白名单需补配。
4. **相似度阈值 0.9 的固有边界**：`slug+1 字符` 型近名（LCS/len = 0.9）会被自动归并。这是决策 #6 拍板的口径而非实现偏差；当前唯一真实歧义（VerityPack）已正确落人工清单，风险低。
5. **farm/ci 创建路径的极端场景**：`git fetch origin farm/ci` 因网络原因（而非分支不存在）失败时会走「创建」分支推 `$OUR`——非 force push，远端已有不同历史时会被 non-FF 拒绝，最坏是本次失败重跑，不会覆盖既有产物。风险极低，留档备查。
6. **`maskKey` 对 ≤4 字符 Key 全量暴露**（只留后 4 位的设计边界）：真实 LLM Key 远长于 4 位，实际风险可忽略。

---

## 最终结论

**PASS-with-notes**

10 项验收 9 项 ✅、1 项 ❌（第 10 项为执行者自述不实，非代码缺陷）。全部功能验收点（identity 严格归并、requests 消费器、CI 96 路工作流、Worker 安全、管理页两面板、34 例单测、无越权、部署成功）均独立验证通过；无阻断级问题，6 条建议级注记中 #1、#2 建议在下一轮处理。
