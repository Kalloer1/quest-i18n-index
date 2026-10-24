# Phase 4 验收报告：夸克全量镜像 + GitHub 直链开关（2026-10-24）

> 审核方：独立审核子代理。方式：只读 + 亲跑测试 + 线上只读探测；未执行任何上传/建链，未修改任何代码。
> 结论先行：**PASS-with-notes**（3 条低severity 备注、1 条环境限制说明，无阻断项）。

---

## 0. 待验收主张

| 项 | 执行者主张 | 验收结果 |
|---|---|---|
| 4.1 网盘盘点 | `research/reports/phase4-quark-inventory-2026-10-24.md` | ✅ |
| 4.2 同步器 | `scripts/quark-sync.mjs` + 13 例单测 | ✅（备注 N1/N2） |
| 4.3 工作流+试点 | `quark-sync.yml` + secret 刷新 + run 40067579042 success（50/50）+ 回填 commit | ✅ |
| 4.4 直链开关 | deploy run 40068512514 success | ✅（备注 N4：线上端点本机网络不可达，未直接实测） |

---

## 1. quark-sync.mjs 代码审读 — ✅

### 1.1 增量判定三态 vs 决策 #7 — ✅

`planSync()`（scripts/quark-sync.mjs:81-112）三分与决策 #7「全量增量上传（已传跳过）、分批建链」一致：

1. **skip**：记录里有非空 shareUrl 且不在死链清单 → 跳过（:89-93）；
2. **relink**：记录缺失/链接为空但网盘有该 slug 的 zip → 只补链不重传（:100-103）；同 slug 网盘多条 → ambiguous 记清单绝不猜（:95-99）；
3. **upload**：都没有 → 上传+建链，复用 mirror.mjs 的 makeUploader（:104-109、:259）。

附加口径合理：死链清单 `--dead-file` 命中的记录不 skip、强制重传（:81-87 + 测试），给了存量死链的增量重传入口。

### 1.2 建链分批限速 — ✅（备注 N2）

真实实现，非注释：补链路径按 `chunk(relinkTargets, BATCH)` 切批（:300-301），批间 `await sleep(DELAY)`（:302-306）；默认 200/批、30000ms（:186-187），与工作流 inputs 默认一致。`chunk`/`sleep` 均有实际调用链，单测覆盖分批与尾批。

**N2（低）**：分批限速只覆盖**补链**路径；「上传+建链」路径沿用 mirror.mjs 逐条 `DEFAULT_RATE_LIMIT_MS`（=300ms，mirror.mjs:74）节奏而非分批。脚本头注释给了历史依据（存量 882 条按此节奏未触发风控，quark-sync.mjs:11-13），属对决策 #7 字面的合理偏离且有记录；但注意试点 50 条全部走上传路径，**分批代码路径尚无生产流量验证**（仅单测）。

### 1.3 单包重试 + 失败清单 — ✅

`attempt()` 重试 1 次（共 2 次尝试，间隔 5s，:267-284）；仍失败 push 进 `failures`（slug/phase/error/attempts）继续跑；结束时写入 `research/quark-sync-failures.json`（:323，文件已被 .gitignore 覆盖）。「全军覆没」（attempted>0 且 succeeded=0）才退出码 1（:327-330）——与「登录态过期自动判红」的方案风险对策一致。歧义项也记清单可审计（:317-320）。

### 1.4 CLI 参数 — ✅（备注 N1）

- `--limit`：`applyLimit`（:120-124），0/非法/负数=全量，正数取前 N；run 日志可见 `--limit 50：本轮实际处理 50 个工作项` 生效。
- `--links-only`：`workItems(plan,{linksOnly:true})` 只返回 relink（:115-117）；主循环按 `!x.fid` / `!!x.fid` 严格分流，links-only 下上传循环空转。单测覆盖。
- **N1（低）**：`--dry-run` **零副作用成立但「不调夸克 API」不成立**——QUARK_CLI 存在时 dry-run 会调用 `browseDir` 做只读列目录来给出准确计划（:207-226），绝不 create-folder/上传/建链/写文件（:209 注释属实）。但脚本头注释「--dry-run 只打印计划，不调 CLI」与运行日志 `[dry] 未调用 CLI、未写文件。`（:249）在 CLI 存在时是**不实陈述**（只读 browse 确实调了 CLI）。无安全影响，建议后续改措辞；本次不修。

### 1.5 纯函数单测 13 例 — ✅

`scripts/quark-sync.test.mjs` 恰好 13 例：planSync×8（skip/relink/upload/ambiguous/noZip/全覆盖/死链分流/links-only 互斥）、workItems、applyLimit、chunk、appendFailures（含不可变断言）、isTotalFailure。全部假清单，不碰 CLI/网络/文件。

## 2. 安全检查（重点）— ✅

- **全历史 pickaxe**：`git log --all -S"passid"`、`-S"kps="` 均**零命中**；工作树 `git grep -iE "cookie|passid|kps=|config.json"` 仅命中：工作流对 secret 名的引用（无值）、package-lock 的 npm cookie 包、patches/ 里的游戏文本（香料饼干等，无关）。
- **git log -p 抽查 Phase 4 全部 5 个 commit**（2e69e2162 / 04dc8fbfb / 97a72292b / 81566b360 / 8a3bd6d57）：改动面只含代码/工作流/mirrors 数据，无任何凭据。2e69e2162 对 mirror.mjs/quark-rename.mjs 仅为补 `export`（不复制逻辑），diff 干净。
- **.gitignore**：覆盖 `research/quark-sync-failures.json`、`.env`/`.env.local`；CLI 登录配置写在 `$HOME/.pi/agent/skills/quarkclouddrive/qoder/config.json`——在仓库外，无需 gitignore 覆盖，口径正确。
- **工作流日志脱敏**：恢复步骤只打印字节数、绝不 echo 内容（quark-sync.yml:60-73）；试点 run 全量日志（4466 行）grep `cookie`/`QUARK_CONFIG_JSON=` 零泄漏；日志里只有 pan.quark.cn 分享链接（本来就是公开物）。
- **secret 名单**（`gh secret list`）：`QUARK_CONFIG_JSON`（更新于 2026-10-24T05:36:47Z，早于试点 run，与「secret 刷新」主张吻合）、`QUARK_PARENT_FID`。命名合理，看不到值。

## 3. quark-sync.yml 工作流 — ✅

- yaml 合法性：已在 GitHub Actions 真实跑通 3 次（40066989375 / 40067579042 等），无需纸面校验。
- **inputs**：limit（0=全量）/ batch（200）/ delay（30000），与脚本默认一致（:15-32）。
- **装 CLI**：`bash scripts/install-quark-cli.sh`（:77）——脚本自带重试与 `::warning::` 容错，注释解释了为何不进 secret（620KB 超 48KB 上限）也不进仓库。
- **secret 恢复登录**：QUARK_CONFIG_JSON 整体写文件 + chmod 600 + 只打印字节数（:61-73）；缺 secret 时 `::error::` 并 exit 1。
- **回填提交**：`permissions: contents: write`（:34-35）；只 `git add -- research/quark-mirrors.json`、`git diff --cached --quiet` 无变更即跳过、bot 身份提交并 push main（:97-107）——最小权限 + 幂等，push main 自动触发 deploy 重建站点数据。
- **失败清单 artifact**：`if: always()` + `if-no-files-found: ignore`（:110-116），不进仓库设计自洽。
- 附带亮点：同步前先跑 `npm test`（:57-58）；独立 concurrency 组 `repo-write` 不与 deploy 互斥。
- `QUARK_CLI` 在 run 脚本里 export 而非 workflow env 块（:84-86）——97a72292b 修复的 $HOME 不展开问题，试点 run 的 headSha 正是该修复 commit（`gh run view` 实证），时间线自洽。

## 4. 试点真实性 — ✅

- **run 40067579042**：`gh run view` 实证 `conclusion=success`，job sync success、无失败步骤，headSha=97a72292b（含 CI 修复）。
- **日志抽样 3 包**（「上传→建链→写记录」链路）：
  - `a-little-bit-of-everything-fabric` → `https://pan.quark.cn/s/5b8cf3bb8124`（1/50）
  - `above-the-known-sky` → `https://pan.quark.cn/s/bcc2d2a2d481`（2/50）
  - `ad-odyssey` → `https://pan.quark.cn/s/ea79e5df6f3c`（3/50）
  - 日志共 50 条 `pan.quark.cn/s/` 链接，结尾 `同步结束：尝试 50，成功 50，失败 0`。
- **三重交叉验证**：① 日志 URL = ② 回填 commit 81566b360 新增的 50 条 shareUrl（前 5 条逐字吻合）= ③ 当前 `research/quark-mirrors.json` 里这 3 个 slug 的记录。顶层 `updatedAt=2026-10-24T05:59:14Z` 与 run 结束时间一致。
- **mirrors json 现状**：1076 条记录 / 932 条有链接（试点前 1026/882，+50/+50 吻合）；全部链接形如 `https://pan.quark.cn/s/xxx`，格式与旧条目一致（`{shareUrl, updatedAt}`），0 条异常域名。
- **回填 commit**：81566b360（github-actions[bot]，`quark-sync: 回填分享链接（run 40067579042，limit=50）`，+301/-1 行）。

## 5. 直链开关端到端 — ✅（备注 N4）

- **Worker 代码**：`GET /settings` 公开无需鉴权返回 `{githubDownloads}`，KV 读失败 fail-open 默认 true（worker/index.js handleSettings）；`GET/POST /admin/download-settings` 有 `requirePassphrase` 闸（handleAdminDownloadSettings），POST 校验 body 必须是布尔，写 KV 带 updatedAt。
- **管理页**：site/request.html 新增「下载开关」面板，解锁后 `loadDownloadSettings()` 用 `X-Passphrase` 读、保存按钮 POST 同头写——写端点鉴权在代码与单测双重确认（错口令 → 401 且 KV 不写，download-settings.test.mjs 例 7）。
- **站点渲染**：site/template.html `applyGithubSwitch()`——`s.githubDownloads !== false` 才隐藏（明确布尔 false 才移除 `#dl-zip`），fetch 失败/非 200/字段缺失一律保持显示（**fail-open**，:713-720 注释写明理由：静态站让开关立即生效的唯一方式）。挂在详情页渲染尾部（:1205）。
- **fail-open**：三层一致——normalizeDownloadSettings（KV 层）、handleSettings（Worker 层）、template.html（站点层），shared/download-settings.mjs 统一口径 + 12 例单测（含站点契约断言例 11/12）。
- **部署**：deploy run 40068512514 success；日志实证 `Uploaded quest-i18n-api` → `Deployed quest-i18n-api triggers` → `https://quest-i18n-api.wqclo.workers.dev`，version 06a3d001。
- **N4（环境限制）**：审核机直连与代理访问 workers.dev 均 TLS reset（HTTP 000，典型 SNI 阻断），**线上 `/settings` 未能直接 curl 实测**。以 deploy 日志 + 全链路代码审读 + 12 例单测（含 KV 空值/false/损坏三分支与「正口令写 false → GET /settings 变 false」闭环）替代验证。建议运维在网络可达处补一次 `curl https://quest-i18n-api.wqclo.workers.dev/settings`（预期 `{"githubDownloads":true}`）。

## 6. 测试 — ✅

- 亲跑 `npm test`：**658 pass / 0 fail / 0 skipped**（134s）。
- quark-sync 13 例确认在 npm test 内运行（单独 `node --test` 复核 13/13 ok；全量输出中 13 例名逐个命中）。
- download-settings 新增 12 例同样全过（含站点契约断言）。

## 7. 无越权 — ✅

Phase 4 五个 commit 的文件清单逐一核对：

| commit | 文件 |
|---|---|
| 2e69e2162 | .gitignore、盘点报告、mirror.mjs/quark-rename.mjs（仅补 export）、quark-sync.mjs/.test.mjs |
| 04dc8fbfb / 97a72292b | .github/workflows/quark-sync.yml |
| 81566b360 | research/quark-mirrors.json |
| 8a3bd6d57 | shared/download-settings.mjs、scripts/download-settings.test.mjs、site/request.html、site/template.html、worker/index.js |

- **未碰**：patches/（`git diff 574c818b5..HEAD -- patches/` 为空）、farm-* 主机脚本、request-translate/提交链路（Phase 3 产物零改动）、downloads/（diff 为空）。
- mirror.mjs/quark-rename.mjs 的改动是纯 export 关键字 + 注释，不改变行为（diff 逐行核实）。

## 8. 成本真相：「放开全量只需 645 包」 — ✅ 账目清楚

数字来源可完整追溯，三层对账吻合：

1. **盘点层（4.1，只读 browse）**：本地 1547 slug；网盘「整合包汉化」1045 zip；交集 899 → 网盘缺 **648**。镜像记录 1026 条：882 有链接 / 144 空链，空链里 19 个网盘已有文件、2 个「记了链接但网盘没有」。
2. **规划层（试点 run 日志实跑输出）**：`跳过 882，补链 19，上传 645，歧义 0，本地缺包 1`，合计 882+19+645+1 = **1547** ✓（与本地 slug 全集严格对账）。
3. **口径解释**：648（网盘缺）− 2（记录里有链接 → 按「已镜像」跳过，不重传）= 646 = **645 上传 + 1 本地缺包（noZip）**。即「645」= 规划器实际要上传的工作项数，不是拍脑袋；盘点报告写的「约 646」与之吻合（645+1）。

「全量增量」的真实工作量：**上传 645**（试点已消化 50，剩 595）+ 补链 19 + 跳过 882+50；失败项下轮自动重试（记录缺失 → 重新规划为 upload）。回填后 mirrors 1076/932 与 882+50 严格吻合。**无糊涂账。**

---

## 9. 问题清单（按严重度降序）

均为低severity/观察项，无阻断：

- **N1（低）** dry-run 措辞不实：CLI 存在时会做只读 browse（调夸克 API），但注释与 `[dry] 未调用 CLI` 日志声称「不调 CLI」。零副作用（不写不传不建链）成立，仅措辞误导。（scripts/quark-sync.mjs:19、:249）
- **N2（低）** 分批限速只覆盖补链路径；上传+建链走逐条 300ms 节奏。偏离有文档依据（历史 882 条未触发风控），但分批代码尚无生产流量验证。
- **N4（观察/环境）** 审核 机网络无法访问 workers.dev，线上 `/settings` 未直接实测；已用 deploy 日志 + 代码 + 12 例单测替代。建议网络可达处补一次只读 curl。
- **N3（观察）** `final-plan-2026-10-24.md` 等本轮报告文件尚为 untracked（未提交），不影响功能验收，但方案文档不在 git 历史里，建议后续一并入库。

## 10. 最终结论

**PASS-with-notes。**

Phase 4 四个子项全部达成且证据链闭环：同步器与决策 #7 一致、试点 50/50 真实发生（日志↔回填 commit↔mirrors json 三方吻合）、安全无泄漏（全历史 pickaxe 零命中、日志脱敏、secret 名单合理）、开关全链路 fail-open 且已部署、全测试 658 pass、无越权改动、645 成本账目可追溯。N1/N2 为低危措辞/覆盖面备注，留给执行者后续消化，不构成回退理由。
