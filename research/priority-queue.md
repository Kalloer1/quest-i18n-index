# 剩余待翻整合包优先级队列

生成时间：2026-10-22T14:12:50.858Z

数据来源：`research/index-dataset.json`（分类）+ CurseForge `POST /v1/mods` / Modrinth `GET /v2/projects`（下载量）+ `research/scan-full.tsv`（体积）。
排序口径：`downloads` 降序；抓不到下载量的（`downloads` 为空）一律垫底，**不当作 0**。

## 数量

| 类别 | 合计 | CurseForge | Modrinth | 已有下载量 |
| --- | ---: | ---: | ---: | ---: |
| embedded（任务书内嵌、无中文） | 1545 | 1273 | 272 | 1545 |
| separate gap-uncovered（有英文任务书未翻） | 105 | 1 | 104 | 105 |
| **合计** | **1650** | 1274 | 376 | **1650** |

下载体积合计：**82.96 GB**（按 scan-full.tsv 的 bytes 求和，缺失体积的条目不计）。

## 下载量 Top 20

| # | slug | 平台 | 下载量 | 体积 | 类别 |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | `better-mc-forge-bmc4` | cf | 18,770,840 | 0.09 GB | embedded |
| 2 | `all-the-mods-9` | cf | 13,662,532 | 0.05 GB | embedded |
| 3 | `prominence-2-hasturian-era` | cf | 13,145,483 | 0.37 GB | embedded |
| 4 | `dawn-craft` | cf | 10,550,222 | 0.11 GB | embedded |
| 5 | `deceasedcraft` | cf | 9,807,824 | 0.11 GB | embedded |
| 6 | `all-the-mods-8` | cf | 9,313,262 | 0.04 GB | embedded |
| 7 | `cursed-walking-a-modern-zombie-apocalypse` | cf | 8,720,828 | 0.27 GB | embedded |
| 8 | `better-mc-fabric-bmc1` | cf | 7,873,483 | 0.06 GB | embedded |
| 9 | `roguelike-adventures-and-dungeons` | cf | 7,640,398 | 0.13 GB | embedded |
| 10 | `all-the-mods-6` | cf | 6,474,846 | 0.00 GB | embedded |
| 11 | `cave-horror-project` | cf | 6,192,144 | 0.03 GB | embedded |
| 12 | `better-mc-forge-bmc1` | cf | 5,822,170 | 0.08 GB | embedded |
| 13 | `ciscos-adventure-rpg-ultimate` | cf | 5,113,606 | 0.03 GB | embedded |
| 14 | `minecraft-eternal` | cf | 4,860,355 | 0.01 GB | embedded |
| 15 | `roguelike-adventures-and-dungeons-2` | cf | 4,796,277 | 0.03 GB | embedded |
| 16 | `crazy-craft-updated` | cf | 4,481,008 | 0.00 GB | embedded |
| 17 | `medieval-mc-fabric-mmc1` | cf | 4,393,121 | 0.08 GB | embedded |
| 18 | `all-in-one-modded-one-block` | cf | 4,250,555 | 0.05 GB | embedded |
| 19 | `darkrpg` | cf | 3,850,339 | 0.00 GB | embedded |
| 20 | `better-mc-fabric-bmc2` | mr | 3,709,799 | 0.06 GB | embedded |

## 拿不到下载量的条目

无，全部条目都拿到了下载量。
