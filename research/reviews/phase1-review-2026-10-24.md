# Phase 1「卫生与防线」独立验收报告

- 审核人：审核子代理（独立验收，未参考执行者自述）
- 日期：2026-10-24
- 待验收 commit：`86ab9a572`（发布自检 + 注释修正）、`09d645dbd`（CI 卫生）
- 验收依据：`research/reports/final-plan-2026-10-24.md` Phase 1 表格 + 审核任务书
- 约束遵守：全程只读 + 本报告；未跑 publish、未改主机状态、未 push。

---

## 逐项验收

### 1. 发布自检（文件数比对）— ✅

**代码确认**（`scripts/publish-local.mjs:310-338`，新增 step 3.5，位于 step 3「检出增量文件」之后）：
- 对 `plan.bySlug` 每个 slug，取 `patchPaths` 里 `.snbt` 数为期望，与 `git ls-tree -r --name-only origin/farm/<branch> -- patches/` 过滤 `patches/<slug>/` + `.snbt` 后的实际数比对。核心逻辑在 `scripts/lib/publish-check.mjs:10-19`。
- **方向正确**：`if (actual > expected) bad.push(...)` —— 实际 > 期望才报错（计划漏捞），实际 ≤ 期望放行（patchPaths 只含差异文件，没变的自然少）。报错时 `process.exit(1)`，且逐 slug 列出未入计划的文件名，提示检查 `--no-renames`。
- **性能正确**：`ls-tree` 按分支循环（`for (const h of branches)`），一次拉全量 `patches/` 树后本地过滤，**不是**每 slug 一次 git。报错路径里的 `extra` 过滤也是纯内存操作。
- **单测覆盖**：`scripts/lib/publish-check.test.mjs` 3 个用例（多→报错；相等/少→放行；别 slug 文件不串包、非 .snbt 不计数）。`npm test` 的 glob（`scripts/lib/*.test.mjs`）包含它，实测 `node --test scripts/lib/publish-check.test.mjs` → `tests 3 / pass 3 / fail 0`。

### 2. farm-merge 剪旁路 — ✅

- `grep -i 'quark|mirror'` 全文仅命中 1 行：第 21-23 行**说明性注释**（「夸克网盘镜像已剪出…Phase 4 会以独立工作流 quark-sync.yml 重生」），无任何 quark-rename / quark / mirror 相关 job、step、input。
- yaml 语法：`python yaml.safe_load` 通过，`jobs: ['merge']`，`needs` 为 None。
- 无残留 `needs:`（全文仅一个 job）。
- 其余结构原样保留：checkout main → Prepare workspace → setup-node → Fetch farm branches (blobless) → Resolve hosts → Compute merge plan → Cap packs → Check out delta → 布局趟 build-index → npm test → 闸门 → Package → Collect source versions → 交付趟 → Stage → Commit and push → Trigger deploy → Write summary，与执行前结构一致。

### 3. 两个工作流已删 — ✅

- 文件系统：`.github/workflows/` 现仅存 `deploy.yml`、`farm-merge.yml`；`spike-lanes.yml`、`translate.yml` 已不存在（git diff 确认两文件分别 -76、-163 行，整文件删除）。
- `gh workflow list` 输出：
  ```
  Deploy to Cloudflare  active  388458849
  farm-merge            active  393155918
  ```
  无残留条目（连「已禁用」都没有）。（方案 1.3 写的「只剩 Deploy / farm-merge / quark-sync / request-translate」——后两者属 Phase 3/4，本次不建，正确。）

### 4. 注释修正 — ✅（附 1 个 note，见问题 N1）

- `git diff 86ab9a572^..86ab9a572 -- scripts/build-index.mjs`：唯一改动是 `PACK_STATES` 中 `'embedded'` 行的注释（约 133 行），由「内嵌不可做：文本混在 chapters/*.snbt，该版本 FTB Quests 无翻译系统」改为「内嵌未交付…**不是**内嵌布局本身不可翻：内嵌包已用覆盖式补丁交付了 1121 个」。133 行附近已无冲突表述。
- `classifyLayout` 与状态判定逻辑零改动：diff 中除该注释外无任何代码行变化（4 行 diff 全是注释/文案）。

### 5. 工作区清理 — ✅（附 2 个 note，见问题 N2、N3）

- 已删：`research/tmp/diagnose/`（No such file）、`research/par-out/`（No such file）。
- 最新 quarantine 在：`research/tmp/quarantine/run-2026-10-24T00-07-29-789Z/`，内含 3 个包 + 各自 tar.gz：`bloom-beyond`、`forge-and-fortify`、`furnace-to-singularity`（= 3 个 B 类包）。
- 分片：`git ls-files research/shards/` = farm1/farm2/farm3/farm4/work.txt（5 台在用），磁盘上另有 4 个未跟踪分片（gfdrgfd/jslfkds/local/podsjk.txt），全部完好。
- 保留项：`patches/` 1547 个、`downloads/` 1547 个、`research/reports/` 4 份（含 final-plan）、全部脚本在位；`research/tmp/ibx.py`（4324 字节）与 `.ibx-key` 均在。
- `git status --porcelain` 中 ` D ` 开头行计数 = **0**，tracked 文件零丢失。

### 6. 测试 — ✅

自己跑了 `npm test`：
```
# tests 599  # pass 599  # fail 0  # cancelled 0  # skipped 0
# duration_ms 134968
```
全绿（599/599，耗时约 135 秒，真跑非口头）。

### 7. 无越权 — ✅

`git diff 86ab9a572^..09d645dbd --stat`：
```
.github/workflows/farm-merge.yml   | 357 ++++---
.github/workflows/spike-lanes.yml  |  76 ---
.github/workflows/translate.yml    | 163 ---
scripts/build-index.mjs            |   4 +-
scripts/lib/publish-check.mjs      |  19 ++
scripts/lib/publish-check.test.mjs |  33 ++
scripts/publish-local.mjs          |  31 ++
7 files changed, 116 insertions(+), 567 deletions(-)
```
7 个文件全部在 Phase 1 范围内。未触碰 `worker/`、`site/`（除 `site/data.json` 类产物未出现）、无 publish 类大 diff、无主机相关改动。commit 分工清晰：86ab9a572 = 自检+注释（6 文件），09d645dbd = farm-merge + 删工作流（3 文件）。

### 8. 主机无恙 — ✅（附 1 个 note，见问题 N4）

抽查了全部 5 台（超出要求的 2 台，pgrep 只读）：

| 主机 | `pgrep -fc translate-local.mjs` | 状态 |
|---|---|---|
| work | 1 | 在跑 |
| farm1 | 2 | 在跑 |
| farm3 | 2 | 在跑 |
| farm4 | 1 | 在跑 |
| farm2 | **0** | **已自停**（见 N4） |

---

## 发现的问题（按严重度排序）

无阻断性问题（无 ❌ 项）。以下为 notes：

### N1（低）· `build-index.mjs:194` 残留同款误导文案
`PACK_STATES` 注释已修正，但运行时输出进 dataset 的 `why` 字段仍是旧口径：
```js
why: '任务书文本内嵌在 chapters/*.snbt，该版本 FTB Quests 无翻译系统',
```
这是 `classifyPackState` 在 `layout === 'embedded'` 分支返回的 `why`，会落进 `research/index-dataset.json` 并可能渲染到站点/管理页，与「内嵌已交付 1121 个」的事实冲突。验收标准字面只要求 133 行注释，故不算 ❌，但建议 Phase 2 前顺手改掉。

### N2（低）· `git status` 不完全「干净」
方案 1.5 验收写「git status 干净」。当前工作区有：20 个 `patches/skyt-2/...snbt` 的未提交修改（M）、`.scratch/test-out.txt` 等 untracked 杂物、`.wrangler/` 运行时文件。无任何 `D` 行（零删除）。M 修改疑似在跑的 work 主机/本地进程产出，属进行中工作，不算意外删除；但「干净」字面未达成，留作说明。

### N3（低）· `research/tmp/` 仍存若干历史日志与探针脚本
`batch-30.log`、`npm-test.log`、`npm-test2.log`、`probe-*.mjs`、`diag*.mjs`、`fetch-farm1.log`、`enrich-run.log` 等仍在。它们**不在方案 §4 删除清单内**（清单只列 diagnose / par-out / quarantine 旧轮次 / 旧分片 / publish-run.log 旧份），`publish-run.log` 属「保留最近一份」合规。严格按方案是合规的，但与任务书「旧 tmp 日志确实没了」的字面有出入，判定为方案未要求、非违规。

### N4（低，非 Phase 1 责任）· farm2 已触发「连续 3 批无进展」自停
farm2 无 translate-local 进程，`farm-guard.log` 每 5 分钟尝试拉起但进程起不来。原因在其自身运行日志：连续 3 批全部 FAILED（`lindenfeld-via-gastronomica: compound 条目缺少 ":"`、`jetlagg-presents-the-altar: 无法解析的值 "\u0000"`、`create-stellar: 权威源无任务书文件`），是**包内容解析问题**触发自停保险，与本次 Phase 1 改动无关（farm2 仓库停在旧 commit `b58db337`，尚未刷到 09d645db）。建议 Phase 2 重开主机时按方案 2.3「清旧分片/旧 state，刷新代码」一并处理，且这 3 个失败包与 §5.1 的 B 类修复有交集。

---

## 最终结论

**PASS-with-notes**

8 项验收全部 ✅（其中第 4、5、8 项各带 1 个低severity note）。两条防线（发布自检、farm-merge 剪旁路）实现正确、方向正确、有测试锁定；删除与清理干净且未误伤在用资产（5 台主机分片、最新 quarantine 3 个 B 类包、ibx 通道全部完好）；改动范围零越权；599 测试全绿；4/5 主机在跑，farm2 自停属其自身包问题、非本次改动所致。

唯一建议尽快跟进：N1 的 `why` 字段旧文案（1 行改动，建议合入 Phase 2 首个 commit）。
