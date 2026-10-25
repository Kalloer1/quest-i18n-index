# no-text 池重扫翻案报告（2026-10-25）

扫描器：main @ 5a18bef09（embeddedLegacy 旧布局识别 + 双模式文本去重）。
驱动脚本：`TMP/rescan-no-text.mjs`（TMP 产物，不入库）——复用仓库库函数
（`prepare-pack.resolveLatestFile` / `lib/modrinth` / `lib/zip-range` /
`lib/candidates.classifyLayout`），只读 zip 中央目录 + Range 单文件，不下载整包。
产物：`research/rescan-no-text.tsv`（188 行全量明细）。

## 翻案统计

| 新分类 | 包数 | 说明 |
| --- | --- | --- |
| 翻案·可翻（embeddedLegacy） | 145 | 1.12.2 旧布局 `ftbquests/<mode>/chapters/<hex>/<hex>.snbt`，旧扫描漏识 |
| 翻案·可翻（embedded 新版布局） | 1 | techno-vanilla（estKeys=2，此前应为 enFiles=0 记账缺陷误入池） |
| 维持 no-text | 42 | 见下表 |

- **翻案 146 包，预估可译单元（键行）合计 60,955**；含可译字段的文件 32,081 / 任务文件总数 66,691。
- estKeys 口径：snbt 中 `title:/subtitle:/description:/text:` 键行数（TEXT_FIELDS 四字段），
  为粗估（多行值/嵌套结构未展开），实际抽取量以正式流程为准。
- 龙头包：roguelike-adventures-and-dungeons(6154)、rad-pack-lite(5014)、ocean-outlast(4168)、
  enigmatica-2-expert-extended(2991)、meatballcraft(1648)。

## 维持 no-text 的 42 包及原因

| 原因 | 包数 | 明细 |
| --- | --- | --- |
| embedded 但章节零文本字段 | 7 | capybaras-play-oritech、cobblerussia、cozy-magic-rubius-reimagend、hard-fantasy-adventure、the-maddest-son、this-land-of-ours、vampack（新版布局章节文件只有结构/图片，抽查确认无 title/description/text） |
| separate-single 但语言表为空 | 4 | electrical-warfare、folklore-smp、lumitech（MR，`lang/en_us.snbt` 为 `{ }` 且章节零文本字段）；untitled-modpack-hard-survival（CF，同况且无章节文件） |
| native-zh（自带中文） | 3 | create_train、immersive-mechanical-workshop、sky-energy-tech |
| 有 ftbquests 目录但无英文源任务文件（layout=other） | 25 | antcraft-avatar-the-last-airbender、avatar-the-new-world、bennett-modpack、conquest-kingdoms、deadly-craft、gun-and-run-parasite、hazbinhotel、immersive-nukes、jutsu-chronicles、manulcraft、mega-smp、naruto-nexus、naruto-path-of-the-shinobi-ahznb、narutolostintime、nonsensecraft-naruto、omega-adventure-pack、purp-naruto、race-to-space-parasites、soldiers-and-battle-craft、swapnils-infinity-craft、the-call-of-berk-how-to-train-your-dragon、the-flash-smp、this-is-new-pixelmon、winter-apokalypse、zombie-apocalypse-remastered |
| 无 ftbquests（layout=none） | 3 | beyond-the-skies、minecraft-eternal（已在 work 主机翻完，不进分片）、star-factory |

扫描 188/188 全部成功，无跳过（URL 全部解析成功：163 CF 走官方 API+x-api-key，
25 MR 走 Modrinth API；无 nodl 兜底触发、无 keyless 退路触发）。

## 5 主机分片（research/shards/，按 estKeys 贪心均衡）

| 分片文件 | 主机 | 包数 | 预估键数 |
| --- | --- | --- | --- |
| work.txt | instabox-work | 28 | 12,191 |
| farm1.txt | instabox-farm1 | 28 | 12,190 |
| farm2.txt | instabox-farm2 | 29 | 12,192 |
| farm3.txt | instabox-farm3 | 30 | 12,192 |
| farm4.txt | instabox-farm4 | 31 | 12,190 |

- 命名与格式沿用既有惯例：单文件单行、逗号分隔 slug；本批次整体重写（先例 f8bfb6119「295 包分片」）。
- minecraft-eternal 不进分片（已翻完待收割）；42 个维持 no-text 的包不进分片。
- 后续：`no-text-slugs.txt` 未动（维护口径归收割流程）；146 包翻译交付后再行摘除。
