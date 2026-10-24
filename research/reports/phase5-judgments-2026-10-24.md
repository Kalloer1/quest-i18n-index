# Phase 5 坏源包处置判定（2026-10-24）

10 个坏源包（B 类 3 + 内嵌 FAILED 7）逐个处置结果：**8 个修复入库、2 个判死**。

> 口径说明：早先的计划文档写「11 个（B 类 3 + FAILED 8）」，其中 FAILED 8 是主机首波快照的估计值；
> 铺开 421 包后的实测清单（`embedded-417-rollout-2026-10-24.md` 的 FAILED 表）为 **7 个**，
> 合计 10 个处置对象。本文与磁盘、与批次校验结果一致：`patches/` 下新增 8 个包目录，
> `research/local-batch-state.json` 标 2 个 dead。

修复工具：`scripts/lib/snbt-repair.mjs`（累计新增 **7 条**窄规则：③④在 `011ae06a4`，⑤⑥⑦⑧⑨在 `206dafe32`）；`validate-quests` 断言零改动。

> **审核后修订（2026-10-24 17:00）**：本文初稿有三处口径要更正，均由独立审核子代理实测指出，已在下文对应位置注明：
> ① 规则是 7 条不是 6 条；
> ② 规则⑨（`repairUnclosedStringValue`）**没有接进** `prepare-pack` 的修复链，因此 lindenfeld 的「补右引号」在当前代码下不可复现 —— 修复后的源已归档入库，但拿同一个坏源重跑不会得到同样结果；
> ③ 「重翻 X/Y」这列是「有产出单元数」，不等于「译成中文」：bloom-beyond 有 139/961 条散文仍是法文、dawncraft 有 459/1693 条散文仍是俄文（模型回退原文），见文末「已知缺陷」。


## 修复并重翻成功（8 个）

| 包 | 病因 | 修复方式 | 重翻 | 校验 |
|---|---|---|---|---|
| bloom-beyond | reward_tables 里空键条目（`: 0`） | 规则③空键丢弃（1 文件） | 1067/1068 · 20 文件 | ✔ 13189 键 |
| forge-and-fortify | `nbt: '…Name:'{"text":…}'…'` 内嵌单引号未转义 | 规则④按 `\'` 转义（2 文件，19 行） | 814/814 · 12 文件 | ✔ 5531 键 |
| furnace-to-singularity | chapters 里空键条目（`: "BOOLEAN"`，5 处） | 规则③空键丢弃 | 1/1 · 1 文件 | ✔ 1 键 |
| dawncraft-russian-lang | 俄语原生包；description 列表里杂物引号 `\.".` 让字符串提前闭合 | 规则⑧杂物引号补 `\` 转义（1 文件 1 行） | 1664/1774 · 29 文件 | ✔ 10954 键 |
| the-world-of-dinosaurs | JSON 风格章节里用 `//` 写注释（2 处） | 规则⑤行首 `//` → `#`（1 文件） | 166/166 · 23 文件 | ✔ 696 键 |
| lindenfeld-via-gastronomica | ① `group: "…` 字符串值少右引号；② `id:`/`dependencies:` 空值；③ **整份文件文本被上游粘贴进自身 description 列表**（截断在文件末尾） | 规则⑨补右引号 + 规则⑥补 `[]`（各 1 行）；粘贴段无法无损恢复 → **截断 salvage**：保留全部散文与既有任务，牺牲最后一个任务的结构尾部（其 id/tasks 已被粘贴覆盖，任何来源都取不回） | 4073/4095（漏译 18 = salvage 空元素）· 117 文件 | ✔ 32648 键 |
| jetlagg-presents-the-altar | 8/23 个章节文件内容为纯 NUL（0x00） | 抽取层跳过（`extractPack` 采 validate-quests 的 isPureNul 先例）；这 8 章上游本身就是游戏读不动的空文件 | 789/790 · 11 文件 | ✔ 9964 键 |
| pixelgo-sky | `item:` 复合块少一个收尾 `}`（全文件 `{` 比 `}` 恰多 1） | 规则⑦在解析撞车的 `]` 处补 `}`（1 文件） | 627/627 · 31 文件 | ✔ 14215 键 |

说明：

- **dawncraft-russian-lang 语言判定**：正文为俄语，但它是「俄语任务书原生包」而非「非英文不该翻」——内容就是任务书文本，语义上与其他源语言包无异，照翻中文。校验通过。
- **lindenfeld salvage 取舍**：两个 chapters（librarianfil / librariandoamna_fileor， twin 章节）被上游把整份文件文本粘进字符串列表，quest 尾部（id/tasks/x/y）与文件收尾结构被覆盖且不可恢复。选择截断 salvage 而非整包判死：其余 115 个章节完好且全部翻译；受影响的每个章节只丢最后一个任务的 id/tasks（该任务在游戏里不可完成，与上游「整章读不出来」相比是改善）。损失如实记录，未编造任何键名或结构。
- **jetlagg 纯 NUL**：输出 zip 不含这 8 个章节文件 —— 上游文件本来就是空垃圾，游戏同样读不出。

## 判死（2 个）

| 包 | 病因 | 判死理由 | 防重试 |
|---|---|---|---|
| linggango | 186/186 个任务书文件（chapters + reward_tables + data）全部是加密混淆形态：首行 `LGQ1:<base64 乱码>`，无任何明文 SNBT | 不是格式损坏，是刻意加密（疑似 quest 保护模组）。没有明文就没有翻译对象，任何规则都无从下手 | `research/local-batch-state.json` 标 `done.dead=true`；主机侧分片无法直改（硬约束），farm 的失败重试会自然撞死在同一个错上，自旋防护会停 |
| create-stellar | 权威源 zip（0.5MB）内没有任何任务书文件（`prepare-pack` 复核：解出 0 个） | 无源可译。本地目录确认无英文源 | 同上 |

## 顺带发现（11 个之外）

- 隔离区 3 个 B 类包内部还有同病种的其他文件（如 forge-and-fortify 的 greenwood_pub.snbt 与 bathhouse.snbt 同为内嵌单引号），均在同一修复链内一并修好，已计入上表数字。
- lindenfeld 两个坏文件里的 `id:` / `dependencies:` 空值条目是同文件附带病灶，规则⑥顺带修复。
- 本轮全部 8 个产出包（5 个内嵌 FAILED 转绿 + 3 个 B 类，其中 furnace 为 separate-single）单包 validate-quests 全绿；
  全量批次校验同样全绿：**1555 个产出 / 8,071,302 个键 / 169 条样式警告 / 0 个阻断失败**。
  （这一条只在**本机**成立：本地有修好的 `research/packs/<slug>/` 目录而 `validate-quests` 是目录优先。
  干净 checkout 里只有 tar.gz，当时 5 个包连归档都没有、3 个归档还是修复前的坏源，CI 因此报 8/1666。
  已用 `packBaseline` 从修好的目录重新打档并入库，见 `fix(baseline)` 提交。）

## 已知缺陷（审核实测，未修）

- **未译残留**：bloom-beyond 139/961 条散文仍是法文原文（`spectrum.snbt` 43%、`chapitre__1.snbt` 38%），
  dawncraft-russian-lang 459/1693 条仍是俄文（`create.snbt` 87%、`enchanting.snbt` 88%）；
  lindenfeld 2.6%、pixelgo 5 条（均为模组名）、dinosaurs 17 条（模组名）。
  这是翻译阶段模型回退原文，不是格式损坏 —— 上表的「重翻 X/Y」只说有产出单元数，不代表中文覆盖。
  补翻需要重跑这两个包（`translate-local --slug … --redo-done`，成本约 20 分钟/包）。
- **规则⑨未接线**：`repairUnclosedStringValue` 只被测试引用，`prepare-pack` 的 import 里没有它。
  lindenfeld 的右引号补全在当前代码下无法复现（修复结果已随基准源归档）。
- **规则①/② 的误判风险**：已加两道守卫（原文件能 parse 就整文件不动；改完不能 parse 就回滚），
  但 ⑥⑦⑧ 仍是「结构靠猜」，只在解析失败时才触发。规则⑥ 只对 `dependencies` 这类已知列表键生效更稳。


## 基础设施备注

- `mediafilez.forgecdn.net` 本机今日起直连超时、经代理 CONNECT 全挂；`rewriteCdnHost` 统一改写为可达的 `mediafiles.forgecdn.net`（同一对象、支持 Range，enrich-source-versions.mjs 早有先例）。
- 内嵌 8 包的源已重新下载落盘 `research/packs/<slug>/`（修复后版本），作为闸门基准键集留在本机。
- 2 个判死包的源移到 `research/packs-dead/`：`research/packs/` 的语义是「可解析的英文基准源」，
  而 U5 那条"D10 布局判定一致性"测试会遍历该目录逐个包解析 —— 加密串/空源放进去会把测试弄红。
  挪目录而非改测试：测试一行未动。
