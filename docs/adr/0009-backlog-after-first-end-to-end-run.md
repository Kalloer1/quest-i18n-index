# 0009. 首次端到端跑通后的遗留清单

日期：2026-10-19
状态：**已接受**（2026-10-19 用户要求把剩余待办固化成可追溯清单）
相关：`0007-translation-platform-submit-to-distribute.md`、`0008-sunset-criteria-commits-and-output.md`

## 背景

2026-10-19 首次真跑 `translate.yml`（run `39166450472`），「提交 → 翻译 → 打包 → 发布 → 站点可下载」
链路**首次端到端成立**：

| 环节 | 实测结果 |
|---|---|
| 翻译 | `完成：done 1，skipped 0，failed 0` |
| 零丢键 | 英文源 608 键 → 译文 608 键 |
| 色码保真 | `&a` `&f` `&7` `&5&l` `&r&e` 抽样逐条核过，全部原样 |
| 打包 | `downloads/fantasy-rpg-with-quests.zip`（26883 字节） |
| 发布 | bot 提交 `6202929`，deploy `39166718856` 绿 |
| 站点状态机 | `gap-uncovered 39→38`，`downloadable 1→2` |

**但这次真跑也暴露了一批此前从未被验证过的缺陷与口径不一致。** 用户 2026-10-19 要求
把它们固化成清单，避免「以为做完了」。本 ADR 记录**已查实的缺陷**（每条附实测证据）、
**已定的处置**、以及**仍需用户裁决的未决项**。

## 已查实的缺陷

### D1. 「全部」计数与台账自相矛盾（UI 口径错）

- **现象**：台账（`#ledger`）显示 `500`，「全部」筛选按钮显示 `395`。
- **证据**：`site/template.html` 的 `renderFilters()`：
  ```js
  PACKS.forEach(function (p) {
    if (p.probeIncomplete) { counts["probe"] = (counts["probe"] || 0) + 1; return; }  // ← 提前 return
    counts[p.state] = (counts[p.state] || 0) + 1;
    counts.all++;                                                                      // ← 这 105 条没被计入
  });
  ```
  而 `renderList()` 对 `currentFilter === "all"` **不做任何过滤**，实际渲染 500 条。
- **真因**：`counts.all` 的口径是「已分类的包」，台账的口径是「扫描到的包」。两个口径同时出现在一屏上。
- **影响**：用户无法判断哪个数字是真的（用户原话：「我真搞不懂它这个计量单位是什么，这合理吗？」）。

### D2. 列表静默截断到 200 条

- **证据**：`site/template.html` 的 `renderList()`：`var shown = results.slice(0, 200);`
- **影响**：点「全部」（500 条）只能看到前 200 条。有提示文案，但用户要看到剩下的必须靠搜索。

### D3. Modrinth **从未扫描**

- **证据**：`research/scan-cf500.log` 末段 `=== Modrinth 整合包热度前 0 ===`；
  `site/data.json` 里 `modrinth` 出现 **0** 次；500 条记录全部来自 CurseForge。
- **影响**：站点「关于」页自述「目前覆盖 CurseForge 热度前 500」是诚实的，
  但**「扫描范围要不要扩到 Modrinth」从未被决策过**——它不是「做完了」，是「没安排」。

### D4. `platform` 字段全空

- **证据**：`site/data.json` 的 500 条记录里，`platform` 字段全部缺失（统计为 `(无): 500`）。
- **影响**：一旦扫描扩到 Modrinth，站点无法区分来源平台，也无法按平台筛选。

### D5. 一键提交跳转按钮**未实现**

- **证据**：`site/template.html` 里**没有任何** `/request?url=` 形式的链接；
  `site/request.html` **不读 URL 参数**（全文无 `URLSearchParams` / `location.search`）。
- **背景**：这是 2026-10-19 早先交接里用户**已确认**的决策——
  「一键提交形态：跳转预填 `/request?url=<整合包链接>`」。**决策已定，代码从未写。**
- **影响**：玩家在列表里看到某个包想求汉化，没有入口直接带着链接跳到提交页。

### D6. 夸克镜像 `create-folder` 失效

- **现象**：run `39166450472` 的 Mirror 步骤报
  `[ERROR][FileBrowserManager] createFo…`（日志被截断），该包夸克链接留空。
- **本地复现**：`create-folder --dir-path 整合包汉化` **不报错但返回错的 fid**——
  返回 `full_path: "夸克网盘/来自：Qoder"`，与已存在目录 `整合包汉化` 的 fid
  （`~1HipPZtSq5gc…`）**不一致**。
- **反证（说明不是「一直坏」）**：2026-10-18 的 `aoc` 镜像**成功过**——
  分享链接 `https://pan.quark.cn/s/a01a2210c9d0` 内含 `aoc.zip`（32687 字节，
  与 `downloads/aoc.zip` 一致）。
- **真因（2026-10-19 查清）**：夸克官方技能 `references/file-ops.md` 写明
  `create-folder` 的失败码——**`-602` = 「文件浏览器实例不存在」（SDK 文件浏览器初始化失败）**。
  CI 报的 `[ERROR][FileBrowserManager] createFo…` 就是它。
  另据同一文档：**`--parent-fid` 不传时，文件夹会被建在「服务端默认目录」，而非根目录**。
- **关键发现**：`translate.yml` 里**传了** `QUARK_PARENT_FID`，但 `scripts/mirror.mjs`
  的 `makeUploader()` **从未读取它**（全文件只有一处 `--parent-fid`，是 `upload` 用的 `dirFid`）。
  即：配置项存在但被忽略。
- **影响**：夸克国内镜像通道**当前完全不可用**；`QUARK_REQUIRED=1` 时整个 run 判红。

### D9. `package-lock.json` 钉死国内镜像，CI 上 `npm ci` 间歇 504

- **现象**：run `39175693590`（用户从管理界面触发的真实提交路径）**在 `npm ci` 就死了**，
  耗时 **18m59s**，**根本没走到翻译**：
  ```
  npm error code E504
  npm error 504 Gateway Time-out - GET https://registry.npmmirror.com/youch-core/-/youch-core-0.3.3.tgz
  ```
- **真因**：`package-lock.json` 里**每一条** `resolved` 都指向 `https://registry.npmmirror.com/…`
  （国内镜像）。仓库无 `.npmrc`，`package.json` 也无 registry 配置——钉死发生在 lockfile 里。
- **性质**：**间歇性**，不是硬阻断——run `39166450472`（21:07）的 `npm ci` 是过的。
  但它让**每一次 CI 都依赖一个国内镜像从美国可达**，与 D7 同一类风险。
- **影响**：与 D7 叠加——CI 链路里**两个关键依赖都在国内**（npm 镜像、免费层 API），
  任一个抖动就让整轮失败，且失败点离「翻译」很远，排查成本高。

### D7. 免费层在 GitHub runner 上不可用

- **证据**：两次 run 均出现 `[免费层] 失败（1/2）：免费层 HTTP 504`，耗时 **66 秒**；
  本机同一接口 **6.5 秒 200**。runner 在美国，`index-translate.bilibili.com` 打不通。
- **影响**：ADR-0007 已决「**免费层优先**、自建网关回退」在 CI 里**不成立**。
  裸 `gh workflow run`（不带 `models`）必然失败；只有从管理界面勾了模型才跑得通。

### D8. 队列状态回写 404（手动 dispatch 时）

- **证据**：`[status] 回写失败 HTTP 404: {"error":"队列中没有 fantasy-rpg-with-quests"}`
- **真因**：手动 `gh workflow run` 的包从未进入 KV 队列，故无条目可回写。
- **影响**：状态机（`待翻译 → 翻译中 → 已完成 / 镜像缺失 / 失败`）**尚未被真实路径验证过**。

### D10. 布局判定有两份实现，`ftb-evolution` 的单元来源与直觉不符

- **现象**：`loadPackUnits`（`scripts/translate-parallel.mjs:147-149`）自己写了一份布局判定，
  没有调用 `scripts/lib/candidates.mjs:63` 的 `classifyLayout`。同一条优先级规则维护在两处。
- **实测**（`research/packs/ftb-evolution/`）：全包 **82** 个 `.snbt`，其中 **41** 个在 `chapters/`，
  同时存在 `config/ftbquests/quests/lang/en_us.snbt`（846,207 字节、4,807 个键）。
  `loadPackUnits` 判为 `separate-single`，产出 **10,789** 个单元；按 `u.key.split('::')[0]` 统计，
  **10,789/10,789** 全部来自 `lang/en_us.snbt`。
- **反证**：同一棵树按 `embedded` 判定只抽出 **1** 个单元
  （`chapters/ftb_pyramid.snbt::quests[12].rewards[2].description`，值 `Fed The Beast`），
  该串在 `en_us.snbt` 里已有对应键 `reward.5E71D2A58521E928`。
  即「这 10,789 个单元大部分来自 `chapters/`」**不成立**：章节文件的文本字段几乎是空的
  （41 个文件合计 `title:` **0** 处、`subtitle:` **0** 处、`description:` **1** 处）。
- **全量比对**：`research/packs/` 下 30 个包，`classifyLayout` 与 `loadPackUnits` 的判定
  **0 处不一致**（`skyfactory-5` 两边都判「无可用任务书」，不是分歧）。
- **影响**：风险是**潜在的**——两份实现此刻同序同义，尚未翻错来源；但改一处不会带动另一处。
  本轮仍跳过 `ftb-evolution`；按实测该包可按 `separate-single` 正常产出，跳过已非必需。
- **处置**：待裁决「两个判定是否合并为一个函数」。

### D11. `writePatch` 不区分分片属于哪一次运行

- **证据**：`scripts/translate-local.mjs` 的 `writePatch()`（:110）在 :138-141 无过滤地遍历
  `research/par-out/<slug>/`，只按文件名 `^chunk-\d+\.json$`（:139）筛选，无时间戳、无 run-id。
- **实测**：`research/par-out/ftb-evolution/` 现有 **216** 个文件，**全部**是
  `chunk-NNNN.failed.json`，普通分片 **0** 个，时间跨 06:52–07:05。
  该正则对这 216 个名字**全部不匹配**（`chunk-0000.failed.json` → `false`）。
- **真因/影响**：遗留的失败标记被正则挡住了，**不会**被静默合并；但它同样让 `writePatch`
  分不清「没有分片」与「分片还没翻」——两种情况下都产出全空补丁，且不报警。
  一旦同目录留下**上一轮**的普通 `chunk-NNNN.json`，正则无法分辨，就会静默混入。
- **处置**：本轮每轮开跑前清空 `research/par-out/<slug>/`。按运行标识过滤仍欠着。

### D12. 任务书媒体指令白占翻译请求

- **证据**：`all-the-mods-10-lite` 共 2,784 个单元，非空 **2,608** 个；其中整段被花括号包裹的
  **119** 个：**106** 个 `{image:atm:textures/...}`、**11** 个 `{@pagebreak}`（合计 117 条纯指令），
  另 **2** 个不是指令——`en_us/chapters/chapter_2_allthemodium.snbt` 的
  `{"text": "POWAH QUESTLINE", "color": "#55FF55", ...}`（JSON 文本组件，含真实文案）与
  `{atm10.quest.ae2.img.star}`（翻译键引用）。
- **影响**：117 条纯指令模型原样返回，白花请求；计入「未译」时它不是真缺陷。
  但「花括号包裹即跳过」会连带跳过那条 JSON 文案。
- **处置**：已落地——`scripts/lib/line-translator.mjs:68-70` 的 `isDirective()` 按
  `/^\{[\s\S]*\}$/` 判定，`translateText`（:149）与 `translateTexts`（:216）都不发请求，
  `translatePackParallel`（`scripts/translate-parallel.mjs:150`）单独计入 `directives`。
  上述 2 条例外尚无处理。

## 本地跑流水线：可行性

用户 2026-10-19 提问：「从那里拉取这个提交的列表下来，直接到我这个本地项目上面跑吗？」

**结论：可以，但有前置条件。**

| 项 | 状态 |
|---|---|
| 拉队列 | ✅ 可行。`GET https://quest-i18n-api.wqclo.workers.dev/queue` 是公开端点（实测返回 `count: 1`，`skyfactory-5`） |
| 翻译 | ✅ 可行，且**比 CI 好**——免费层本机 6.5 秒 200，CI 上 66 秒 504 |
| 下载解包整合包 | ⚠️ 需要 `CF_KEY`（`scripts/prepare-pack.mjs` 用它调 CurseForge API）。**本机当前没有** |
| 打包 + 发布 | ✅ `node scripts/release.mjs --ids <slug>` |
| 夸克镜像 | ❌ 同一个 D6 缺陷，本机也坏 |

**所以「本地跑」是 D7（免费层在 CI 失效）的天然替代路径**，代价是 `CF_KEY` 要落到本机环境。

## 处置决定

### 已定（本轮已落地）

1. **推翻「不重译」**：VM / CFPA 已覆盖的包照常产出本站版本（ADR-0007 已改，commit `164315f`）。
2. **不选模型 = 只走免费层**：`parseModels` 不再兜底 `gpt-4o-mini`
   （实测该模型在中转站上 503 不存在），commit `2944d0a`。
3. **无 FTB 提交侧检测不做**：只在流水线侧跳过（ADR-0007 已决第 6 条）。
4. **补齐「下载解包」环节**：新增 `scripts/prepare-pack.mjs`，commit `819e705`。
5. **修正打包/镜像顺序**：镜像必须排在打包之后，commit `819e705`。

### 未决（需用户裁决，不得由实现者猜）

| 编号 | 问题 | 选项 |
|---|---|---|
| U1 | 扫描范围要不要扩到 Modrinth？（D3/D4） | (a) 只做 CF 前 500，站点文案明说；(b) 扩到 Modrinth；(c) 扩到 CF 前 N（N>500） |
| U2 | 免费层在 CI 失效怎么应对？（D7） | (a) 约定「必须从管理界面触发」；(b) 设 `LLM_MODELS` 默认值兜底（违背「不设默认模型」）；(c) 查清免费层能否救（换域名/加重试）；(d) 改走本地跑 |
| U3 | 本地跑流水线要不要作为正式路径？（`CF_KEY` 落本机） | (a) 是，作为 CI 的替代/补充；(b) 否，只作调试手段 |
| U4 | 夸克镜像修不修、怎么修？（D6） | (a) 改成先 `search` 拿 fid；(b) 显式传 `--parent-fid`；(c) 暂时关掉 `QUARK_REQUIRED`，不阻断发布 |
| U5 | 布局判定要不要收敛成一个函数？（D10） | (a) `loadPackUnits` 改调 `classifyLayout`；(b) 保留两份，加测试锁住一致性；(c) 只删 `loadPackUnits` 里那份，全部走 `classifyLayout` |

## 待办清单

| # | 事项 | 缺陷 | 阻塞于 |
|---|---|---|---|
| 1 | ~~修「全部」计数口径（D1）~~ **已于 `52961b0` 修好** | D1 | ✅ 关闭 |
| 2 | ~~列表分页 / 提高 200 上限（D2）~~ **已于 `52961b0` 改为全量渲染** | D2 | ✅ 关闭 |
| 3 | 一键提交跳转预填 `/request?url=`（D5） | D5 | — |
| 4 | 修夸克 `create-folder`（D6） | D6 | U4 |
| 5 | 免费层失效应对（D7） | D7 | U2 |
| 6 | 补一次真实提交路径的端到端验证（D8） | D8 | — |
| 7 | 扫描范围决策与落地（D3/D4） | D3、D4 | U1 |
| 8 | 本地跑流水线的 `CF_KEY` 落盘（若 U3 选 a） | — | U3 |
| 9 | 解开 lockfile 对国内 npm 镜像的钉死（D9） | D9 | — |
| 10 | ~~合并两份布局判定~~ **已于 `878f259` 收敛为 `classifyLayout`** | D10 | ✅ 关闭（U5 已裁） |
| 11 | ~~分片按运行标识过滤~~ **已于 `878f259` 加 runId** | D11 | ✅ 关闭 |
| 12 | 指令判定放行 JSON 文本组件那类例外（D12） | D12 | — |
| 13 | ~~英文源只在本机、CI 红灯~~ **已于 `a1830e2` 入库 + `34ac096` 加 `verify:ci`** | D13 | ✅ 关闭 |
| 14 | ~~入库裸 `git add -A`~~ **已于 `878f259` 改显式路径** | D14 | ✅ 关闭 |
| 15 | 批量翻译 `separate` 包（实测约 9.2 小时） | — | 已跑 **93 个**（第一批 20 + 第二批 73），**剩 348 个**；`embedded` 与 Modrinth 未开战线 |
| 17 | 5 个已发布包的重跑版取源不一致（`peace-of-mind-21-1` 等），暂不覆盖 | — | 需查 serv00 `research/packs/` 残留旧章节文件为何让布局判定走内嵌路 |
| 18 | 第二批 273 条漏译（`tensura-waka-edition` 78 条最多） | — | 未处置；漏译率 0.4%，与第一批 0.63% 同量级 |
| 19 | `fids-cobblemon-server` 产出含 `config/ftbquests - Copy/`、`verlac` 产出在 `saved/` 下 | — | 能过闸门，但补丁包路径可能不被游戏加载 |
| 20 | ~~serv00 凭据用可写 GitHub token~~ **已改只读 deploy key**（`77a5c9f` 后的运维动作） | — | ✅ 关闭 |
| 21 | ~~断点续跑只信本机 state，跨机丢进度~~ **已改看 `patches/` 产物实况** | — | ✅ 关闭（`77a5c9f`） |
| 16 | ~~模型凭空造占位符不拦~~ **已修：`placeholdersPreserved`** | D16 | ✅ 关闭 |

### 2026-10-20 复核

- `Index-Translate-35B-A3B` **已恢复可达**（200），但 24 路下实测 **2.7 req/s**，
  240 次请求里 **32 次**在 60s 超时。
- `index-mt-9b-syllable`：24 路 **19.7 req/s**，**0** 个 HTTP 错误；24/32/48 三档吞吐相同。
- `9b-syllable` **不能批量**（3/3 次只回第一行 `L1=`）。故「一次一条」是**所选模型的性质**，
  不是服务端的普遍限制——ADR-0007 里「免费层必须逐行」的表述应据此收窄。
- 所选模型名与相关调参都在 `TRANSLATE_MODEL` 环境变量之后
  （`scripts/lib/line-translator.mjs:37-42`，缺省 `index-mt-9b-syllable`）。

### 2026-10-20 复核（二）：批量开跑前的裁决与落地

用户于 2026-10-20 夜逐条裁决了「还有多少个包没翻」这条战线。本节记录**裁决内容**、
**实测数据**，以及本轮已落地的改动。

#### 新查实的缺陷

##### D13. 主分支 CI 红灯：19 个包的英文源只在本机磁盘上（假绿灯）

- **现象**：`bbc5389` 的 Deploy run `39426426002` 失败，日志末行
  `✘ 批量校验失败：19/31 个产出有问题（19 个缺英文源）`。而当时的交接文档称验收全绿。
- **真因**：`patches/` 有 31 个包，`research/packs/`（英文源基准键集）只入库了 12 个。
  差的 19 个只存在于本机工作区、未跟踪。`validate-quests` 对每个包要读英文源做
  键集/色码/占位符比对，CI 拉仓库后看不到，于是判红。
- **反证（说明本机绿灯是环境差，不是代码对）**：干净克隆里复跑
  `npm test` → 349 passed，`npm run validate:quests` → 判红 19 个。
- **关键教训**：「本机跑过」不等于「CI 会过」。验收必须**在干净克隆里**做。
- **处置**：21 个未跟踪目录一次全入（15 MB / 799 个 `.snbt`，commit `a1830e2`），
  并新增 `npm run verify:ci` 把「干净克隆里复跑闸门」固化成脚本（见下方 U6）。

##### D14. `translate-local` 的入库是裸 `git add -A`

- **证据**：`scripts/translate-local.mjs` 的 `pushEvery` 分支。
- **影响**：批量跑 346 个包时，`research/packs/` 下会堆几百个未跟踪目录，
  `-A` 会把它们连同任何未跟踪文件一起提交并 push 到 main。
- **处置**：改走 `stagedPathsForBatch({slugs})` 的显式路径清单，
  口径与 `release.mjs` 的「显式路径暂存（禁止 git add -A）」一致。

##### D15. 「还有 347 个包没翻」这个数查无出处

- **实测**（`research/scan-full.tsv`，平台=cf、可产出布局、无自带中文、未完成）：
  **1619 个**，其中 `separate-single`/`separate-dir` 合计 **346** 个、`embedded` **1273** 个。
  347 对不上任何一个自然口径，最可能是某个时点的快照或笔误。
- **同样被推翻的还有「2.6 分钟/包 → 15 小时」**：实测 30 个已完成包，
  72,913 条 / 67.3 分钟 = **1083 条/分钟**，中位数 **1.63 分钟/包**。
  346 个包约 64 万条译文 → **约 9.2 小时**（不含下载 14.8 GB）。
- **处置**：按实测值执行，本文档记下 347 查无出处。

#### 多机并行的实测（推翻「开 5 台机器更快」）

用户提问「能不能同时开 5 台机器跑」。实测结论是**不能更快，且单机就够**：

| 并发 | 成功/总数 | 吞吐 | 备注 |
|---|---|---|---|
| 24 路 | 48/48 | 2.63 块/s | 零错误 |
| 56 路 | 112/112 | 5.06 块/s | 零错误，单机天花板 |
| 64 路 | 94/148 | 5.63 块/s | **12 路死掉，HTTP 429** |
| 96 路 | 161/192 | 7.65 块/s | **8 路死掉，HTTP 429** |

- 免费层**不需要 API key**（`free-tier.mjs` 头注释：实测不带 auth 返回 200），
  故不存在「每台机器一份额度」；限速按来源 IP 算。
- 但 5 台 × 24 路 ≈ 120 路，**吞吐还不如单机 56 路**（后者已达 5.06 块/s），
  且要付 5 份 state 合并、磁盘、`git add` 冲突的协调成本。
- InstaBox 免费账号按 `instabox-handoff.md` 是「临时键、非常驻」形态，
  不适合扛 9 小时关键任务。
- **处置**：本机单机 24 路跑。将来若要做 1273 个 `embedded`（约 132 小时），
  再重新评估多机。

#### 本轮已落地

| 改动 | 缺陷 | 提交 |
|---|---|---|
| 21 个包的英文源入库（15 MB） | D13 | `a1830e2` |
| 入库改显式路径 | D14 | `878f259` |
| 分片按 run-id 过滤，区分「无分片」与「未翻完」 | D11 | `878f259` |
| 布局判定收敛为 `classifyLayout` | D10 / U5 | `878f259` |
| `prepare-pack --no-keep-zip` | D12 附带 | `878f259` |
| `npm run verify:ci`（干净克隆复跑闸门） | D13 | `878f259`、`34ac096` |

`npm test`：349 → **380 passed**（+31 条，全部先红后绿）。
`npm run verify:ci`：干净克隆里 `npm test` + `validate:quests` 均通过。

#### 本轮的裁决

| 编号 | 问题 | 裁决 |
|---|---|---|
| U5 | 布局判定收敛成哪个？（D10） | **`loadPackUnits` 改调 `classifyLayout`**，删掉内联那份。实测 34 包 0 分歧，无行为变化；加结构性断言锁住「不得再内联」 |
| U6 | 怎么防「本机绿灯、CI 红灯」？（D13） | **新增 `npm run verify:ci`**：在 `mkdtemp` 里 `git clone` 本地 `.git` → `npm ci`（失败回退 `npm install`）→ `npm test` → `validate:quests`。任一步失败即整体失败，空结果也判失败 |
| U7 | 英文源入库的形状？ | **原样入库 `.snbt`**。查过 `validate-quests` 到底要什么：它需要每键的**原文值**（数色码、数占位符）与**SNBT 可解析性**，这两条决定了「紧凑台账」省不了多少却要付「改读取侧 + 削弱闸门」的代价。346 个包约 300 MB，可接受 |
| U8 | 批量范围？ | **本轮只做 346 个 `separate` 包**（约 9.2 小时、下载 14.8 GB）。`embedded` 的 1273 个留到 D10/D12 全部关闭后单独开战线 |
| U9 | 跑在哪台机器？ | **本机单机 24 路**。见上方多机实测 |
| U10 | 失败包怎么处置？ | 失败即继续，跑完看清单人工决定；任何包连续两轮失败不再自动纳入后续批量 |

#### 本轮的作废项

- ~~「紧凑基准键集」~~：见 U7，查实后作废。
- ~~「347 个包 / 15 小时」~~：见 D15，查无出处，按实测 346 个 / 9.2 小时。
- ~~「开 5 台机器并行更快」~~：见上方实测表。
- ~~「D2 列表静默截断到 200 条」~~：**早已在 `52961b0`（2026-10-19）修好**，
  `renderList()` 现在是全量渲染。实测 28,816 条全量渲染 2.8 MB / 14 ms，无性能问题。
  本文档待办 #2 可关闭。
- ~~「D1 计数口径」~~：同一提交已修（`counts.all` 直接取 `PACKS.length`）。待办 #1 可关闭。

#### 站点文案的事实错误（已修）

`site/template.html` 有三处写「CurseForge 热度前 500」，而 `D.stat.total` 实际是 28,816
（CF 10,000 + Modrinth 18,816）—— 同一屏上两个口径自相矛盾，正是 D1 那条教训的重演。
已改为「CurseForge 热度前 10,000 与 Modrinth 热度前列」，并按 U8 的范围裁决补一句：
本站已翻译**分离式布局**，**内嵌式布局尚未开始**（附该类包的条数）。

#### 2026-10-20 夜第一轮实测：CDN 拦截了 9/20 个包

按 U8/U9 跑了第一轮 20 个混合体积的 `separate` 包（0.1 MB ~ 400 MB）。
**结果：11 成功 / 9 失败**，失败全部卡在下载阶段，且**不是随机**：

```
[12/20] more-animals-exclusive FAILED   (14.7MB)
[13/20] tales-of-celerity     FAILED   (19.1MB)
… 一直到 [20/20] maria-create-project FAILED (399.8MB)
```

##### 真因（已查实，不是我们的代码问题）

CurseForge 的下载链是**两跳**：

```
api.curseforge.com/v1/mods/<id>/files   → 200，返回 downloadUrl
  downloadUrl = https://edge.forgecdn.net/files/8632/969/xxx.zip
edge.forgecdn.net                        → 302，Location 指向 mediafilez.forgecdn.net
mediafilez.forgecdn.net                  → 本机 TCP 443 连不上（超时）
```

实测证据：

| 检查 | 结果 |
|---|---|
| `curl -I edge.forgecdn.net/files/…` | **302**，`Location: https://mediafilez.forgecdn.net/…`，`X-Cache: Miss from cloudfront`，`X-Amz-Cf-Pop: HKG61-P1` |
| `curl -L` 跟到 mediafilez | `curl: (28) Failed to connect … after 21716 ms` |
| `mediafilez.forgecdn.net` 三个 A 记录（54.230.70.63/66/72）的 443 端口 | **全部不通**（`/dev/tcp` 直连超时） |
| 同一台机器上的 `registry.npmjs.org` / `api.github.com` | **200**（网络本身正常） |
| 免费层 `index-translate.bilibili.com` | **200**（国内线路正常） |
| 本地代理 `127.0.0.1:10808`（系统设置里是关的） | 端口开着，但走它访问 CDN **同样超时** |
| **昨天下载成功过的包**（atm10 / aoc / tensura-evolutions）的 URL | **现在也是 404/超时** |

最后一条最关键：**这不是「新文件没准备好」，而是整条 mediafilez 线路对本机不可达** ——
连昨天成功下过的文件今天也下不了。

##### 为何 11 个成功了

成功的 11 个里有 3 个（`ftb-evolution`、`tats1`、`tensura-rpg-new-world`）**本来就在硬盘上**，
`prepare-pack` 直接跳过下载。剩下 8 个是**小包**（0.1 MB ~ 11.8 MB），
推测小文件命中了不同的 CloudFront POP 或走了未拦截的路径；
从 14.7 MB 起全部失败。**这是相关性，不是已证实的因果** —— 未做进一步定位。

##### 这一轮的实际产出

- 11 个包成功，**21,692 / 21,830 条译文，漏译率 0.63%**
- 闸门：**41 个产出 / 94,743 个键全绿**（20 条样式警告，不阻断）
- 站点 `downloadable` 36 → **47**，`gap-uncovered` 445 → 436
- Deploy run `39460274127` 绿

##### 本轮新查实的缺陷（已修）

**D16. 模型会凭空造出 `%value%` 这类占位符，翻译器不拦。**

- **证据**：`tensuranewworld` 的 `quest.173D9856BCD06A82.title`，
  英文源 `"Reset Scrolls Price"`（无占位符），
  模型回 `"重置卷轴的价格为：&c1%value%&c2%"` —— 凭空造了一个 `%value%` 与两个色码。
- **闸门抓到了**（`占位符不一致 1 个键: … [%value%（en 0 / zh 1）]`），但那是**写盘之后**，
  整个包被判红。
- **真因**：`translateText` 只核对色码占位符 `<cN>`，不核对 `%s` / `%value%` 这类。
- **处置**：`line-translator.mjs` 新增 `countPlaceholders` / `placeholdersPreserved`，
  与闸门**同一套正则**但**刻意不复用**（闸门改动不应意外改变翻译行为，
  两份一致性由测试锁住）。任一非 `%%` 占位符种类或数量不符 → 返回 `null`（内容失败，不重试）。
  `%%` 不拦，与闸门「只警告」口径一致。修后重翻 `tensuranewworld`，该键变为 `"重置卷轴价格"`。

#### 下一轮的前提（阻塞项）

**CDN 不可达是硬阻塞**：346 个 `separate` 包里，只剩 3 个已解包，其余 343 个都要下载。
在 mediafilez 线路恢复前，批量只能做「已在硬盘上的包」。

可选绕法（均未验证）：

| 方案 | 代价 |
|---|---|
| 换一条能到 mediafilez 的出口（VPN/其他代理/其他机器） | 需实测；serv00 与 InstaBox 的出口是否可达未知 |
| 找 CurseForge 的备用下载域（`media.forgecdn.net` 等） | 实测同样超时 |
| 等线路自行恢复 | 不可控 |
| 只翻已解包的包 | 只省 3 个，不解决问题 |

**在拿到一条可达 mediafilez 的出口之前，不建议开始 346 包的批量。**

#### 2026-10-21 补充：Modrinth 的 CDN 是通的

同一时刻对比两个平台的下载域（均用 `Range: bytes=0-99` 探测）：

| 平台 | 域名 | 结果 |
|---|---|---|
| CurseForge | `mediafilez.forgecdn.net`（`edge` 的 302 目标） | **TCP 443 超时** |
| Modrinth | `cdn.modrinth.com` | **HTTP 206**，拿到 100 字节 |

`scripts/scan-packs.mjs --cf 1` 实测也是这个形状：CF 1/1 重试 4 次后 `ERR fetch failed`，
同一次运行的 MR 1~3 全部正常返回体积与布局。

**这不是巧合**：CF 与 MR 走完全不同的 CDN，本机只是到不了 CF 那条。
故在 CF 线路恢复前，**可以先做 Modrinth 侧的包**：

- Modrinth 可产出且无自带中文、未完成的包：**377 个**
  （`separate-single` 106 个 + `embedded` 271 个）
- 其中 `separate` 的 106 个可以直接进本轮批量口径（与 CF 的 346 个同一处理方式）

但这需要 `prepare-pack` 支持 Modrinth 的 `.mrpack` 格式（当前只处理 CF 的 zip），
是一个独立工程量，**未在本轮实现**。

#### 2026-10-21 端到端验证：serv00 跑通了 CF 与 MD 两条链路

在 Herdr 里开了一个常驻 serv00 会话（`gfdrgfd@s9`），把「下载 → 解包 → 翻译」
整条链路跑了一遍。**结论：CF 的 CDN 在 serv00 上可达，MD 全链路也跑通了。**

##### 三台机器的 CDN 可达性（同一时刻）

| 主机 | `mediafilez.forgecdn.net` | 说明 |
|---|---|---|
| 本机（Windows） | TCP 443 **超时** | 整包下不来 |
| `win11-direct`（10.77.77.2） | **超时** | 同本机 |
| `p20pro`（手机） | **403** | 网络可达 |
| **serv00 `gfdrgfd`** | **403 → 真实文件 200** | **可用** |

关键区分：**403 不等于不可达**。mediafilez 的根路径本来就禁访（S3 返回
`<Error><Code>AccessDenied</Code></Error>`），要拿**具体文件**才看得出能不能下。
本机是 TCP 都连不上（超时），serv00 是能连上、只是路径不对。

##### CF 链路实测（serv00）

```
GET https://edge.forgecdn.net/files/5540/618/The%20New%20Exploration-1.2.5.zip
→ HTTP 200, 163,843 bytes, 0.83s
```

解包后得到 10 个 `.snbt`（含 `lang/en_us.snbt`），56 条可译文本。

##### MD 链路实测（serv00）

按用户要求“随便探索一个 MD 站的包”：

1. `GET api.modrinth.com/v2/search?facets=[["project_type:modpack"]]` → 25 个热门包
2. 逐个用 **Range 读 mrpack 尾部中央目录**，找含 `ftbquests` 的 —— 这一步只花几十 KB/包，
   不用下整包。命中 3 个：

   | slug | 体积 | `.snbt` 数 |
   |---|---|---|
   | `better-mc-fabric-bmc2` | 63.2 MB | 18 |
   | `better-mc-forge-bmc4` | 86.2 MB | 24 |
   | `prominence-2-fabric` | 404.9 MB | 3 |

3. 下 `better-mc-fabric-bmc2`（63 MB，`cdn.modrinth.com`）→ 解出 35 个 `.snbt`，
   其中 20 个在 `chapters/`（**内嵌布局**）
4. 提取 252 条可译文本（`title` 148 / `subtitle` 104）
5. 24 路并发翻译 → **252/252 成功，0 失败，11.2 秒，1351 条/分钟**

样例（注意 `&` 色码保留得很好）：

```
Enter The &8&lOtherside          => 进入 &8&l另一个世界
Grants the wearer a permanent &3speed effect
                                 => 赋予穿戴者永久性的 &3速度效果
Found by stepping on Infested Sculk
                                 => 踩在被感染的潜声方块上即可找到
```

##### 两条链路的共同结论

| 指标 | CF（serv00） | MD（serv00） |
|---|---|---|
| 下载 | 200 / 0.83s（163 KB） | 200 / 33s（96 MB） |
| 解包 | 10 个 `.snbt` | 35 个 `.snbt` |
| 翻译 | 56/56 ok，2.6s，1295 条/分 | 252/252 ok，11.2s，1351 条/分 |
| 免费层 | **200，1.13s** | 同 |

**serv00 同时能到 mediafilez 和 index-translate，两条链路都不需要额外代理。**
磁盘 `/tmp` 有 8.3 GB 可用（已用 875 MB），单个包解包后约 130 MB。

##### 本轮观察到的质量点

- 252 条里有 **8 条色码数量不符**（3.2%），与 atm10 那轮的 4/55 同量级；
  `translateText` 的 `<cN>` 占位符核对会拦住这类（这次探针没做遮蔽，故直接暴露）。
- **3 条未译**：模型把 `Warden Leggings` 这类专有名词原样返回，符合提示词第 5 条，不算缺陷。
- 内嵌布局的文本量（252 条）远小于分离式单文件（atm10 有 2784 条），
  因为内嵌包的 `chapters/*.snbt` 里大部分字段不是文案。

#### 2026-10-21 两条新链路在 serv00 实跑验证

代码已落地并推送（`5925926`，`npm test` 385 → **407**）。在 serv00 上实跑两个新分支：

##### Range 只取语言文件（`--quest-files-only`）

```
$ node scripts/prepare-pack.mjs --ids the-new-exploration --quest-files-only --no-keep-zip
[the-new-exploration] 只取任务书文件（Range，不下载整包）：The New Exploration-1.2.5.zip
[the-new-exploration] Range 取到 10 个任务书文件，布局 separate-single（enFiles=1 zhFiles=0）
```

产物 103 KB / 10 个 `.snbt`，整包是 0.2 MB。**全程未下载整包。**

##### Modrinth `.mrpack`（`--platform mr`）

```
$ node scripts/prepare-pack.mjs --ids better-mc-fabric-bmc2 --platform mr --no-keep-zip
[better-mc-fabric-bmc2] 下载 BMC2 [FABRIC] 1.20.1 v40.mrpack（63.2 MB）
[better-mc-fabric-bmc2] 解出 28 个任务书文件，布局 embedded（enFiles=20 zhFiles=0）
```

`overrides/` 被 `toOutputPath` 正确剥掉，内嵌布局识别正确。

##### 代码如何到 serv00（下次照做）

serv00 的 SSH **拒绝 stdin 管道与 scp**（实测 50 KB / 300 KB / 20 KB base64 全部
`Connection closed`），所以不能用 `scp` 或 `ssh 'cat >'` 传文件。
**正确做法（用户指定）**：代码推 GitHub，serv00 上 `git clone` 拉。

私有仓库需要凭据。本次用 `gh auth token` 的 token 拼进 clone URL（`x-access-token:<t>@github.com/...`），
克隆后**立即 `git remote set-url` 去掉 token**，并清掉 shell history。
**待办**：该 token 曾明文出现在 pane 输出里，建议在 GitHub 设置里吊销重发
（`gh auth refresh` 被网络挡住，未能自动轮换）。

##### serv00 空间约束（用户提醒）

个人免费用户只有 **3 GB**。当前 `~/qsrc` 49 MB，整个 home 63 MB。
跑批量时必须**每包跑完就清 `research/packs/<slug>/` 与 `research/tmp/`**，
否则 346 个包 × 平均 1 MB 语言文件 = 约 350 MB，加上临时 zip 会很快撞配额。

#### 2026-10-21 第一批 20 包实跑完成

在 serv00 上跑完 20 个 `separate` 包（按体积分位选，0.1 MB ~ 400 MB）：

| # | 包 | 耗时 | 译文 | 漏译 |
|---|---|---|---|---|
| 1 | tensura-true-aura | 24s | 1057/1057 | 0 |
| 2 | braincells-magical-creation | 15s | 420/421 | 1 |
| 3 | peace-of-mind-21-1 | 9s | 293/294 | 1 |
| 4 | **tensura-waka-edition** | **1384s** | 42866/42944 | 78 |
| 5 | cobblemon-colony | 218s | 3633/3656 | 23 |
| 6 | pixelsprings-plus | 6s | 145/145 | 0 |
| 7 | **fr3shpack-toomanymods** | **729s** | 12813/12913 | 100 |
| 8 | scoobyland-create-and-friends | 30s | 329/386 | 57 |
| 9 | a-lightweight-skyblock | 49s | 1438/1444 | 6 |
| 10 | skytech-evolution | 135s | 1253/1253 | 0 |
| 11 | overclock-tech-automation | 62s | 1556/1556 | 0 |
| 12 | modern-revolutions | 115s | 531/536 | 5 |
| 13 | bgv-adventure-survival | 149s | 2632/2636 | 4 |
| 14 | jiromon-reborn | 7s | 191/191 | 0 |
| 15 | muratcraft-v2 | 2s | 1/1 | 0 |
| 16 | crazymc-a-special-apocalypse | 151s | 834/936 | 102 |
| 17 | the-frozen-hell | 2s | 3/3 | 0 |
| 18 | our-antarchy-craft | 124s | 1167/1167 | 0 |
| 19 | dragoncraft | 134s | 1220/1223 | 3 |
| 20 | maria-create-project | 5s | 67/68 | 1 |

**20/20 全部成功，合计 73,246 条译文。** 闸门：**61 个产出 / 167,573 个键全绿**
（24 条样式警告，不阻断）。站点 `downloadable` 47 → **67**，`gap-uncovered` 436 → 416。

##### 本轮的两个关键实测

**① 分片要全部翻完才落盘 → 大包看不到进度。**
`tensura-waka-edition` 有 **42,944 条**（atm10 的 15 倍），跑了 23 分钟，
期间 `research/par-out/<slug>/` 一直是空的。这不是卡死，是 `translatePackParallel`
把全包翻完才写分片。风险：中途中断则全包白跑。
**待改进**：改为边翻边落盘（每 `SHARD_SIZE` 条写一片）。

**② 小包的“耗时”很多是下载而非翻译。**
`muratcraft-v2` 1 条译文花 2 秒、`the-frozen-hell` 3 条花 2 秒 —— 这些包任务书里
几乎全是指令与空串。反过来 `tensura-waka-edition` 4 万条占全批 58% 的时间。
**346 包的时间预算不能按“平均”算**，得按译文总量算：全批 73,246 条 / 约 66 分钟
= **1,110 条/分钟**，与之前本机实测的 1,083 条/分钟一致。

##### 代码 bug：开关做了但没接上（已修）

第一次开跑时发现 `translate-local.mjs` 调 `prepare-pack` 时**没传 `--quest-files-only`**，
于是批量仍在整包下载。开关落在 `prepare-pack` 上、却没接到调用方 ——
这类“功能做了但没接上”只有把参数构造变成可测对象才能拦住。
已抽成 `prepareArgsForBatch` 纯函数 + 5 条测试（`e63286b`，npm test 407 → 412）。

`embedded` 包刻意**不**开 Range：内嵌包必须拿到全部 `chapters/*.snbt` 才知道哪些有文本
（atm10 是 82 个），逐个 Range 不如整包一次下完。

## 后果

- 本清单是**唯一**的遗留事项权威来源；新增缺陷应追加到本文档，而不是散落在交接文件里。
- 未决项（U1–U5）**不得由实现者自行拍板**——它们是产品/范围决策，不是工程细节。
- 清单里每一条都附了实测证据；**没有证据的条目不得进入本文档**（这是本项目
  「不接受猜测」约定的延伸）。
- 本 ADR 不设失效期：条目全部关闭后，应新增 ADR 记录关闭结论，而非删除本文档。
#### 2026-10-21 第二批：交接误判「产物没回传」，实为 78/100 后进程消失

上一份交接（`quest-handoff-2026-10-21-batch-in-progress.md`）称第二批 100 个包
「跑到第 70/100 个时会话断了，那批的产物没有回传」。**本轮查实：产物一个都没丢。**

##### 查实结果

| 交接说法 | 实测 |
|---|---|
| 「会话断了，产物没回传」 | `~/qsrc/patches/` 下有 **73 个新包目录 + 5 个重跑包**，81 个 `zh_cn.snbt` 全在 |
| 「跑到第 70/100 断了」 | `/tmp/runA.log` 到 **78/100**：77 done + 1 FAILED（`creator-academy-based-on-create`），第 79 个 `cobblemon-age-of-industry` 跑到一半进程消失 |
| 「serv00 会话已消失」 | SSH 正常，`~/qsrc` @ `a8a45e9`，5 核、磁盘余量 3.6 T |
| 「~70 个包的产物没回传」 | **72 个新包**（state 记 92 done = 第一批 20 + 第二批 72，与本机 41 done **零重叠**） |

`state` 与 `patches/` 完全对齐：92 个 done **全部**有产物目录，零缺失。
所以「产物没回传」这个判断的根因不是产物丢了，而是**没有人去看 `patches/` 实况** ——
交接作者只读了被 gitignore 的 `state` 文件，而那个文件恰恰不跟着 git 走。

##### 落地

| 改动 | 提交 |
|---|---|
| 导入 73 个新包产出 + 76 个英文源（`validate:quests` 61 → **134 个产出 / 212,281 键**全绿） | `b743a9c` |
| 断点续跑改看产物实况（`isAlreadyTranslated` / `pendingWorklist`） | `77a5c9f` |

**5 个已发布包（`braincells-magical-creation` / `cobblemon-colony` / `peace-of-mind-21-1` /
`tensura-true-aura` / `tensura-waka-edition`）的重跑版暂不覆盖**：它们的差异不是措辞好坏，
而是**取源不同**。例：`peace-of-mind-21-1` 的 `chapter.7BCC04609D1A692A.title`，
英文源只有 `"Tipps & Tricks"`，已发布版是 37 字符，serv00 重跑版是 200+ 字符一整段
（`survival` 之类无关文案）—— 说明 serv00 的 `research/packs/<slug>/` 残留了旧章节文件，
布局判定走了内嵌路。**取源不一致时覆盖等于用未知换已知。**

##### 本轮的 273 条漏译（尚未处置）

第二批 77 个成功包里合计 **273 条漏译**，集中在
`tensura-waka-edition 78` / `chaos-oneblock 65` / `cobblemon-colony 22` /
`fids-cobblemon-server 21` / `oritech-academy 19` / `tensura-roguelike 17` /
`the-best-of-twilight-forest 13` / `tcc-skyzone 10`。
漏译率 0.4%（273 / 约 7 万条），与第一批的 0.63% 同量级。

##### serv00 凭据改为只读 deploy key

上一轮的 `gho_...` token 曾多次明文出现在 pane 输出里，且被持久化在 serv00 的
`~/.git-credentials`（69 字节）—— 任何拿到 serv00 账号的人都能推仓库。

本轮改为：serv00 生成 `~/.ssh/id_deploy`，**只读** deploy key 加进仓库
（`id=167139117, read_only=true`），`~/.ssh/config` 固定 `IdentityFile`，
删掉 `~/.git-credentials` 与 `credential.helper`。
实测：`git ls-remote` 通、`git push` 被拒 —— 这正是想要的形状。
**代码流向仍是「本机 push → serv00 fetch」**，只是 serv00 再也推不动了。

##### 待查的产物路径异常（本批 2 个包）

- `fids-cobblemon-server` 产出里有一个 `config/ftbquests - Copy/` 目录（Windows 复制残留）
- `verlac` 的源与产出都在 `ftbquests/saved/2025-09-02-*/lang/`（存档备份目录，不是运行目录）

两者都能过闸门（键集一致），但打出来的补丁包路径可能不被游戏加载。
