# 四台云主机全区间重扫：收割、合并与体检报告（未发布）

日期：2026-10-25
执行：work / farm2 / farm3 / farm4（instabox），通道 `research/tmp/ibx.py exec`
方案：`TMP/scan-retry-plan.md`（CF [0,10000) + MR [0,18867) 全区间重扫）
产物备份：`TMP/scan-collect/<host>/*.tsv`（12 份，md5 逐一与远端核对通过）
合并前快照：`TMP/scan-full.before-merge-2026-10-25.tsv`、`TMP/index-before.json`（注意是 HEAD 旧构建，见 §4 口径说明）

---

## 0. 一句话结论

**重扫本身圆满完成（12/12 分片行数全对、md5 全核），合并与重建后的前两条体检
（总数 28816、downloadable 1755 零掉出）全部通过；但第三条硬性体检
——probeIncomplete 从 2905 降到 ~450 以内——被数据现实证伪：
两次独立扫描（10-19 与 10-24，不同主机）的 nodl 集合重合率 99.1%，
nodl 是 CurseForge API 的确定性响应（最新文件就是没有 downloadUrl），
不是网络故障，重扫无法消除。合并后 probeIncomplete = 2891（仅 -14）。
按「体检不过即停、绝不 push」的约定，本次所有改动停留在本地工作区，未 commit、未 push。**

决策点见 §5：接受 2891 发布（数据新鲜度收益真实存在），或整体回滚（一条 git 命令）。

---

## 1. 分片执行情况（全部完成）

| 主机 | lane 文件 | 行数(含表头) | 预期 | md5 |
|---|---|---|---|---|
| work   | cf-0-2500 / mr-0-2359 / mr-9436-11794    | 2501/2360/2359 | ✓ | ✓ |
| farm2  | cf-2500-5000 / mr-2359-4718 / mr-11794-14152 | 2501/2360/2359 | ✓ | ✓ |
| farm3  | cf-5000-7500 / mr-4718-7077 / mr-14152-16510 | 2501/2360/2359 | ✓ | ✓ |
| farm4  | cf-7500-10000 / mr-7077-9436 / mr-16510-18867 | 2501/2360/2358 | ✓ | ✓ |

- 数据行合计：CF 2500×4 = **10000**，MR 2359×4+2358×3+2357 = **18867**，与分片计划逐 lane 吻合，零缺漏。
- 四台 `pgrep scan-packs` 均为 0（无残留进程），仅 cat/wc/md5sum/base64 只读操作。
- 收取方式：远端 `base64 -w0` 单行 + md5sum，本地解码后核对 md5（`research/tmp/collect-scan.py`），
  12/12 全部匹配，免疫传输截断与编码损坏。
- MR 数据内有 10 个 platform+id 重复行（同一包出现在两个相邻 lane，MR 列表边界漂移），
  合并时取 scannedAt 新者，已消解。

## 2. 合并口径（`research/tmp/merge-scan.py`）

以 platform+id 为键，骨架 = 旧 `research/scan-full.tsv` 全部 28816 键（保持原序、保总数）：

- 同键且新数据存在 → **新行覆盖**（scannedAt 新者胜：10-24 恒晚于 10-19）：28695 行；
- 例外 A：新行 `error:*` 而旧行非 error → **保留旧行**（网络抖动不抹掉确定性结果）：7 行；
- 例外 B（体检保护）：`cf 547038` **保留旧行** —— CF 改名 towns-kingdoms-3→towns-kingdoms，
  新 slug 会拆掉 `downloads/towns-kingdoms-3_v3.05.zip` 的 delivered 匹配使其掉出 downloadable；
  两行除 slug/scannedAt 外逐列相同，零信息损失：1 行；
- 旧独有（跌出列表/下架，113 键，含 21 nodl + 2 error + 90 正常分类）→ 保留旧行；
- 新独有（新进榜 154 键，多为 no-quests）→ **不进主表**（保总数 28816），
  留档 `TMP/scan-collect/new-only-keys.tsv`。

## 3. 体检结果

| 体检项 | 门槛 | 结果 | 判定 |
|---|---|---|---|
| 候选总数 | 仍 28816 | 28816 | ✅ |
| downloadable | ≥1755 且零掉出 | 1755，slug 集合前后完全一致（0 掉出 / 0 新增） | ✅ |
| probeIncomplete | 显著下降至 ~450 以内 | **2905 → 2891（仅 -14）** | ❌ **不过** |

前后 stateCounts（合并前工作区构建 → 合并后构建，输入 downloads/ 未变）：

| | downloadable | native-zh | gap-uncovered | gap-covered | embedded | no-quests | probeIncomplete | total |
|---|---|---|---|---|---|---|---|---|
| 前 | 1755 | 49 | 37 | 0 | 256 | 23814 | 2905 | 28816 |
| 后 | 1755 | 49 | 38 | 0 | 257 | 23826 | **2891** | 28816 |

slug 级状态迁移（仅 39 个）：no-quests→未探明 17、未探明→no-quests 16、no-quests→embedded 3、
embedded→no-quests 2、no-quests→gap-uncovered 1。downloadable 零迁移。

## 4. 为什么 probeIncomplete 降不动：nodl 是确定性事实

原预期模型（~450 = toobig 363 注定保留 + 少量 error/跌出）隐含「nodl 2383 会被重扫解决」。数据证伪：

- 新旧两次独立扫描（不同日期、不同主机、不同出口 IP）的 nodl 集合重合 **2362/2383 = 99.1%**：
  仅 21 个转好（多在跌出列表的边缘包）、19 个新出现；
- `scripts/scan-packs.mjs:132`：nodl = CF API `/mods/{id}/files` 正常响应但最新文件
  `downloadUrl` 为 null（限制分发/需登录下载/已下架文件的包）。这是 API 确定性内容，与网络无关；
- 重扫真正解决的只有旧 error:*（15 → 2）与个别列表变动。

**剩余 2891 个未探明的构成**（slug 级清单：`TMP/probe-incomplete-after-2026-10-25.tsv`）：

| format | 数量 | 性质 | 重扫可否解决 |
|---|---|---|---|
| nodl | 2384 | CF 最新文件无 downloadUrl（确定性） | 否，除非 CF 改政策或包更新 |
| toobig | 363 | >400MB 硬编码跳过（scan-packs.mjs:134） | 否，需改脚本放宽阈值 |
| other | 142 | 布局无法归类（确定性探测结论） | 否，是终态分类 |
| error:* | 2 | Cannot read properties of undefined | 偶发，可再试 |

口径说明：合并前基线取**本地工作区构建**（1755/2905），而非 git HEAD 的 index-dataset.json
（1716，上次提交时的旧快照；合并前工作区本就有未提交的 index-dataset/site 变更，本次改动叠加其上）。

## 5. 决策点（本次未发布）

合并后的收益是真实的：26895 个包的探测数据从 10-19 刷新到 10-24（bytes/文件计数/scannedAt 全新），
downloadable 全保、总数不变、无任何回退。但「显著下降」目标未达成。两个选项：

- **发布**：commit `research/scan-full.tsv` + `research/index-dataset.json` + `site/data.json` + 本报告，push 后 watch Deploy；
- **回滚**：`git checkout -- research/scan-full.tsv research/index-dataset.json site/data.json`，
  备份与收取产物都在 TMP/，零损失。

若追求 probeIncomplete 实质下降，唯一路径是处理 nodl/toobig 口径本身（改脚本或改 build-index 分类定义），
超出本次「纯数据合并、不改 scripts/」的边界。

## 6. 待议:nodl 的后续出路(本次不做,另立任务)

剩余 2891 里 nodl 2384(82%)是 CF 禁第三方分发的确定性响应,重扫永远无解。若要实质压低,候选路径:

- **Modrinth 同名交叉**:nodl 的 cf 键里查 MR 是否有同 slug/同名项目(部分禁分发包双平台发布),有则借 MR 文件探测;需扩展 scan-packs 的键源,改脚本;
- **提高 400MB 上限**:toobig 363 是 `scan-packs.mjs:134` 硬编码阈值,带宽/时间成本需评估(大包 Range 读中央目录照样可行,只是单包更慢);
- **口径重定义**:nodl/toobig 若被认定为「终态」而非「未探明」,可改 build-index 分类定义——但这改变站点语义,须单独评审。

以上均超出本次「纯数据合并、不改 scripts/」的边界,留待另立任务。

## 7. 遗留物清单

- `TMP/scan-collect/<host>/*.tsv` —— 12 份原始收取件（md5 与远端一致）
- `TMP/scan-collect/new-only-keys.tsv` —— 新进榜 154 键留档
- `TMP/scan-full.before-merge-2026-10-25.tsv` —— 合并前 scan-full 快照
- `TMP/probe-incomplete-after-2026-10-25.tsv` —— 剩余 2891 未探明 slug 级清单
- `TMP/index-before.json` —— HEAD 旧构建快照（1716 口径，仅存档）
- 脚本（均在 research/tmp/，未动 scripts/）：`collect-scan.py`、`analyze-keys.py`、`merge-scan.py`
