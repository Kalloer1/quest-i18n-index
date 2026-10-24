# 内嵌未交付包 5 台主机翻译铺开报告（2026-10-24）

## 目标与实际规模

- 计划目标：数据集 `research/index-dataset.json` 中 `layout==='embedded' && !delivered` 的包，条目数 **427**。
- 实际唯一包 **421 个**，两处缩水：
  1. 5 个 slug 在数据集中各重复出现 2 次：`society-sunlit-cobblemon`、`better-mc-fabric-bmc2`、`nanomagic`、`underdog`、`techblock-skytech-3`（427 条 → 422 唯一）。
  2. `million-mile` 已存在于 origin/main 的 `patches/`（与任务前提「427 个都不在 main」不符），从分片剔除（422 → 421）。
- 排序：按 `research/scan-full.tsv` 行序（下载量降序），422 个全部命中 TSV，无缺失。

## 分片

均分写入 `research/shards/{work,farm1,farm2,farm3,farm4}.txt`（单行逗号分隔，无尾随逗号），已 commit（574c818b5）并 push origin main：

| 主机 | 分片大小 | 首个包 |
|---|---|---|
| work | 85 | lucky-world-invasion |
| farm1 | 85 | my-zn-naruto-pack |
| farm2 | 85 | super-hostile-modpack |
| farm3 | 85 | divine-descent |
| farm4 | 81（剔除 million-mile 后） | fantazy-tech-expert-mode |

## 事故：首次启动跑的是旧分片（已修复）

- 首次重启后各台「本次处理」仅 1/5/2/0/3 个，处理的包与分片归属完全错位，farm3 直接报「分片清单已清空」。
- 根因：`scripts/farm-run.sh` 的 `refresh_code()` 只 restore `scripts shared package.json .github`（farm-run.sh:102），**不含 `research/shards/`**。git 推送的新分片永远到不了主机；各台读到的是旧分片的残余（失败项重试 → 全部再失败 → 4 台触发「连续 3 批无进展」自停，farm3 清空退出）。
- 修复：不改代码，直接经 `ibx.py exec` 将 5 个分片内容写入各主机 `~/quest-repo/research/shards/<host>.txt`（字节数与本地逐一核对一致），再次 `sh ~/restart-farm.sh` 拉起。
- 遗留建议（本次未动，超出任务范围）：把 `research/shards` 加入 `refresh_code()` 的 restore 列表，否则下次从监工机改分片仍需人工直写主机。

## 新分片生效后首波（约 15 分钟）

各台「本次处理 N 个」= 分片大小 − 已 done 跳过（含此前已成功但尚未合入 main 的）：

| 主机 | 分片 | 已done跳过 | 本次处理 | done | skipped(没有可译文本) | FAILED | 进程 |
|---|---|---|---|---|---|---|---|
| work | 85 | 15 | 70 | 7 | 3 | 1 | 存活 |
| farm1 | 85 | 5 | 80 | 2 | 3 | 2 | 存活 |
| farm2 | 85 | 11 | 74 | 11 | 14 | 3 | 存活 |
| farm3 | 85 | 8 | 77 | 7 | 4 | 0 | 存活 |
| farm4 | 81 | 71 | 10 | 9 | 0 | 1 | 自停（见下） |
| 合计 | 421 | 110 | 311 | **36** | **24** | **7** | |

注：farm4 第一批处理 10 个（9 done + 1 failed），随后分片只剩 1 项进入第二批；表中 farm4 为两批合计。farm1/farm2/farm3/work 首批（25/台）仍在继续跑。

## FAILED 明细（全部为源文件解析失败，非翻译 API 问题）

| 包 | 错误 | 归属 |
|---|---|---|
| linggango | SNBT 解析：末尾有多余内容 `":RF7HDo58q6zyHHgRVbD"` | work |
| dawncraft-russian-lang | 无法解析的值 `"Х"`（疑为俄语原生包，正文非英文） | farm1 |
| the-world-of-dinosaurs | 无法解析的值 `"/"` | farm1 |
| create-stellar | 权威源 zip（0.5MB）内无任务书文件，本地目录无英文源 | farm2 |
| lindenfeld-via-gastronomica | compound 条目缺少 ":" | farm2 |
| jetlagg-presents-the-altar | 无法解析的值 `"\u0000"` | farm2 |
| pixelgo-sky | 无法解析的值 `"]"`（同一错误连续 3 批 → farm4 自停） | farm4 |

历史日志中另见 `infinitylegends` 因包内路径过长（ustar name>100 且 prefix>155）打包基准源失败。

## 「没有可译文本」判定复核

- 本次首波 skipped(no-text) 比例：24 / 67 ≈ **36%**；此前旧判定约 191/427 ≈ 45%，方向一致、量级吻合。
- 这些包被干净跳过（`skipped · 没有可译文本（布局 embedded）`，秒级完成），不算失败，也不阻塞队列 —— **旧判定不构成误伤**，本次重跑验证通过。
- 真正值得人工看的是上面 7 个 FAILED：源文件本身格式坏（SNBT/JSON 解析失败）或根本没有任务书，重跑多少次结果相同。

## farm4 自停说明

farm4 分片 81 个中 71 个此前已 done，第一批 10 个完成后队列只剩 `pixelgo-sky` 一个顽固解析失败项；自旋防护（连续 3 批「已完成」数不涨）正确触发停机。这不是故障，但 farm4 不会因分片「还有 1 个失败项」而一直空转 —— 若要清掉它需人工单独处理该包的源文件。

## 结论

- 421 个唯一内嵌未交付包已全部进入 5 台主机分片，311 个待处理项在跑（首批仍在继续），首波净产出 done 36、确认无文本跳过 24、源文件损坏失败 7。
- 无需进一步干预的：work/farm1/farm2/farm3 持续跑批自会消化。
- 需要后续人工的：7 个 FAILED 包（解析修复或判死）、`refresh_code` 不含分片路径的改进。
