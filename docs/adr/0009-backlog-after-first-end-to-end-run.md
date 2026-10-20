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
| 1 | 修「全部」计数口径（D1） | D1 | — |
| 2 | 列表分页 / 提高 200 上限（D2） | D2 | — |
| 3 | 一键提交跳转预填 `/request?url=`（D5） | D5 | — |
| 4 | 修夸克 `create-folder`（D6） | D6 | U4 |
| 5 | 免费层失效应对（D7） | D7 | U2 |
| 6 | 补一次真实提交路径的端到端验证（D8） | D8 | — |
| 7 | 扫描范围决策与落地（D3/D4） | D3、D4 | U1 |
| 8 | 本地跑流水线的 `CF_KEY` 落盘（若 U3 选 a） | — | U3 |
| 9 | 解开 lockfile 对国内 npm 镜像的钉死（D9） | D9 | — |
| 10 | 合并两份布局判定，或约定单一事实来源（D10） | D10 | 布局判定决策（U5） |
| 11 | 分片按运行标识过滤，并区分「无分片」与「未翻完」（D11） | D11 | — |
| 12 | 指令判定放行 JSON 文本组件那类例外（D12） | D12 | — |

### 2026-10-20 复核

- `Index-Translate-35B-A3B` **已恢复可达**（200），但 24 路下实测 **2.7 req/s**，
  240 次请求里 **32 次**在 60s 超时。
- `index-mt-9b-syllable`：24 路 **19.7 req/s**，**0** 个 HTTP 错误；24/32/48 三档吞吐相同。
- `9b-syllable` **不能批量**（3/3 次只回第一行 `L1=`）。故「一次一条」是**所选模型的性质**，
  不是服务端的普遍限制——ADR-0007 里「免费层必须逐行」的表述应据此收窄。
- 所选模型名与相关调参都在 `TRANSLATE_MODEL` 环境变量之后
  （`scripts/lib/line-translator.mjs:37-42`，缺省 `index-mt-9b-syllable`）。

## 后果

- 本清单是**唯一**的遗留事项权威来源；新增缺陷应追加到本文档，而不是散落在交接文件里。
- 未决项（U1–U5）**不得由实现者自行拍板**——它们是产品/范围决策，不是工程细节。
- 清单里每一条都附了实测证据；**没有证据的条目不得进入本文档**（这是本项目
  「不接受猜测」约定的延伸）。
- 本 ADR 不设失效期：条目全部关闭后，应新增 ADR 记录关闭结论，而非删除本文档。