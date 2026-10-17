# 整合包汉化：现状调查

> 调查时间：2026-10-17。方法：直接读一手来源（FTB Quests 源码、Modrinth API、GitHub raw、真实 `.mrpack` 解包）。
> 每条结论标注来源。**查不到的写「未找到」，不猜。**

---

## 1. 结论摘要

| # | 结论 | 影响 |
|---|---|---|
| 1 | 高版本 FTB Quests 已**原生支持翻译**，译文放 `config/ftbquests/quests/lang/<locale>/`，**无需改玩家文件** | 产物可以做得干净：一个文件夹丢进去就行 |
| 2 | 老版本（≤ 1.20.x 时代）文本**内嵌在 `chapters/*.snbt`**，没有 lang 目录 | 老整合包必须改写 `chapters/*.snbt`，安装步骤重、易损坏 |
| 3 | 格式在版本间**变过**：单文件 `lang/en_us.snbt` → 按章节切分的多文件目录 | 解析器要覆盖两代格式 |
| 4 | 任务文本是**带 `&` 色码的富文本**，且章节文件含 `0.0d` 这类 SNBT 特有类型标记 | 必须做 SNBT 感知解析，不能当 JSON 处理 |
| 5 | `.mrpack` 是 **zip + 清单**，通常**不含模组本体**（只有 overrides + 下载清单） | 下载 `.mrpack` 就能拿到任务书，不必下 GB 级模组 |
| 6 | Modrinth CDN **不支持 HTTP Range**（返回 501） | 不能「只取 zip 目录」，只能整包下载（0.2MB~405MB 实测） |
| 7 | 任务书可能在 **overrides**（config 或 defaultconfigs），也可能在 **mods/*.jar 内**（自带默认任务书） | 两条路径都要走 |
| 8 | 社区已有**多个**做同一件事的开源项目，其中两个可直接借鉴 | 不必从零发明 |

---

## 2. FTB Quests 翻译机制（一手来源：源码）

### 2.1 译文存放位置

`BaseQuestFile.java:596`：

```java
translationManager.loadFromFile(this, folder.resolve("lang"));
```

`folder` 是 `config/ftbquests/quests/`。因此译文目录为：

```
config/ftbquests/quests/lang/<locale>/
```

`TranslationManager.saveToFile()` 会把每个 locale 的表按章节切分成多个文件写入该目录。
来源：<https://github.com/FTBTeam/FTB-Quests/blob/main/common/src/main/java/dev/ftb/mods/ftbquests/quest/translation/TranslationManager.java>

### 2.2 键名格式

`TranslationManager.makeKey()`：

```java
String.format("%s.%s.%s", object.getObjectType().getId(), QuestObjectBase.getCodeString(object), subKey.getName());
```

`getObjectType().getId()` 取值（`QuestObjectType.java:13-22`）：
`null` / `file` / `chapter` / `quest` / `task` / `reward` / `reward_table` / `chapter_group` / `quest_link` / `image`

`subKey.getName()` 取值（`TranslationKey.java:9-12`）：
`title` / `quest_subtitle` / `quest_desc`（列表值） / `chapter_subtitle`（列表值）

⇒ 实际键形如：

```
quest.03795968E7FA18BA.title
quest.03795968E7FA18BA.quest_subtitle
quest.03795968E7FA18BA.quest_desc          ← 值是字符串数组
chapter.010F3251541FC7DC.title
chapter.010F3251541FC7DC.chapter_subtitle  ← 值是字符串数组
task.2D4C1E2F839FD674.title
```

**注意**：`getCodeString()` 产出的是十六进制 ID 字符串，不是章节名。
来源：`QuestObjectBase.java` / `TranslationKey.java` / `QuestObjectType.java`（同上仓库）

### 2.3 文件切分规则

`TranslationTable.getPathForQuestObject()`：

| 对象类型 | 写到哪个文件 |
|---|---|
| `QUEST` / `TASK` / `QUEST_LINK` | 该对象所属章节的文件（`qo.getQuestChapter().getPath()`） |
| 其它（`chapter` / `reward_table` / …） | `<objectTypeId>.snbt`（放在 locale 目录根部） |

文件格式是 **JSON5 / SNBT**（`Json5Util.FILE_EXT`），`loadAndCombine()` 用 `Files.walk()` 递归读该 locale 目录下**所有**文件再合并。
⇒ 目录结构可以扁平也可以嵌套，读取端不敏感。

来源：`TranslationTable.java`、`BaseQuestFile.java:78`

### 2.4 格式的两代演进（关键）

`CHANGELOG.md` 有两处翻译系统改动，版本号不同：

| 版本 | 改动 | 原文（CHANGELOG 行号） |
|---|---|---|
| `2100.1.0` | 引入独立翻译系统：文本从任务数据里拆出来，放到 `lang/` 下、**按 locale 命名单文件**，如 `lang/en_us.snbt` | 行 558-562 |
| `26.1.2.1` | 翻译数据**从单文件切分为多个文件**，按任务对象类型与章节组织 | 行 133 |

来源：<https://github.com/FTBTeam/FTB-Quests/blob/main/CHANGELOG.md>

⇒ **两代格式并存于真实整合包中**，解析器必须都覆盖。

### 2.5 富文本与格式陷阱

社区项目 `dannyball710/minecraft-mod-translate-skill` 的 `references/ftbquests.md` 列出了踩过的坑（该文件明确写「getting any of these wrong breaks parsing or display」）：

1. **只翻值，绝不碰键**
2. **`&` 色码必须逐字保留**，包括位置与前后空格：`"&e Off-Road"` → `"&e 越野"`（`&e` 后的空格要留）
3. **转义序列** `\"` / `\\` / `\n` 原样保留
4. **按键提示留在原文里**：`\"R\"`、`\"Z\"` 的字母不翻
5. **不翻**：数字、物品/方块 ID、其它模组的专有名词
6. **缩进是有意义的**：顶层 `key:` 一个制表符，数组元素两个制表符，闭合 `]` 一个
7. **行数必须与源文件完全一致**；数组里的 `""` 是刻意留的空行，要保留

来源：<https://github.com/dannyball710/minecraft-mod-translate-skill/blob/main/references/ftbquests.md>

### 2.6 老格式：文本内嵌（实测证据）

实测 `better-mc-forge-bmc4`（Forge，1.20.1 时代）的 `.mrpack`：

- `overrides/config/ftbquests/quests/chapters/*.snbt` 存在（13 个章节文件）
- `overrides/config/ftbquests/quests/lang/` **不存在**（条目数 0）
- 文本直接内嵌，如 `chapters/oddities.snbt:357`：

```
			subtitle: "Used to automatically &eTrade&r with nearby &6Piglins.&r Holds &6Gold ingots&r and output barter items."
```

同文件另有 `title: "Craft a &4Bartering Station"`、`title: "Craft a&1 Saw"`（注意 `a&1` 中间**没有空格**——色码解析不能假设空格分隔）。

⇒ 老整合包要在**玩家自己的 `config/ftbquests/quests/chapters/` 里就地改写**。这是「改文件」而非「放文件」，风险等级不同。

### 2.7 新格式在真实整合包里确实存在（实测）

**`All the Mods 10`（CurseForge 排行第一，190.8 MB）** 的目录清单里：

```
overrides/config/ftbquests/quests/lang/en_us/chapters/achapter_2r_6the_atm_star.snbt
overrides/config/ftbquests/quests/lang/en_us/chapters/aether.snbt
overrides/config/ftbquests/quests/lang/en_us/chapter.snbt
overrides/config/ftbquests/quests/lang/en_us/chapter_group.snbt
```

按 locale 分组的条目数：

| locale | 条目 | locale | 条目 |
|---|---:|---|---:|
| `en_us` | 73 | `ja_jp` | 63 |
| `pt_br` | 72 | `uk_ua` | 62 |
| `tr_tr` | 72 | `es_es` | 61 |
| `id_id` | 69 | `ko_kr` | 61 |
| `it_it` | 69 | `nb_no` | 29 |
| `ru_ru` | 69 | `fr_fr` | 18 |
| **`zh_cn`** | **69** | `pl_pl` | 12 |

⇒ **两个重要事实**：
1. **新格式（`lang/<locale>/` 目录）在头部整合包里真实存在**。「只支持新格式会没活干」这个悲观假设**被推翻**。
2. **ATM10 已经带 `zh_cn`**（69/73 条目，社区贡献并随包分发）——这是 `hasNativeZhCN` 的天然对应物，需要识别并跳过。

### 2.8 两代格式的真实分布（抽样实测）

| 样本 | 有任务书 | 新格式 | 旧格式 | 无 |
|---|---:|---:|---:|---:|
| Modrinth 下载量前 20 | 3 | **0** | 3 | 15 |

Modrinth 榜首以性能包为主（Fabulously Optimized、Sodium 系），**基本没有任务书**；
任务书重的包（ATM 系列、FTB 系列、诅咒类）是 **CurseForge 优先发布**的。

⇒ 目标市场在 CurseForge，而 Modrinth 侧的 `project_type:modpack`（18,863 个）大多不是目标。

### 2.9 FTB Quests 本体不在 Modrinth 上

| 查询 | 结果 |
|---|---|
| `GET /v2/project/ftb-quests` | **404** |
| `GET /v2/search?query=FTB Quests` | 命中的是第三方附加模组（freeze-fix / optimizer 等），**无本体** |

FTB 团队主发 CurseForge。因此**不能靠 `dependencies` 列表判断整合包有没有任务书**——实测：

| 整合包 | 依赖总数 | 可解析 | 命中 FTB Quests |
|---|---:|---:|---|
| better-mc-forge-bmc4（**确实有**任务书） | 368 | 338 | ❌ 仅 freeze-fix |
| prominence-2-fabric（**确实有**任务书） | 656 | 563 | ❌ 无 |

⇒ 依赖列表法**不可靠**，改用 §3.3 的「只读 zip 目录」。

---

## 3. 整合包分发格式（实测）

### 3.1 `.mrpack` 的结构

以 `fabulously-optimized` 为例（0.17 MB），解包内容：

```
overrides/                       ← 整合包自带文件（config / defaultconfigs / 资源包…）
modrinth.index.json              ← 清单：模组清单 + 下载地址 + 校验和
```

**模组本体不在包里**，只有清单里的 URL 和哈希。来源：Modrinth `.mrpack` 格式（实测解包）。

⇒ 下载 `.mrpack` 就能拿到整合包作者自带的**任务书与 config**，不必下载 GB 级模组。

### 3.2 体积实测（14 个整合包，按下载量）

| 整合包 | 体积 |
|---|---|
| fabulously-optimized | 0.2 MB |
| sodiumplus | 0.0 MB |
| skyblock-enhanced | 0.6 MB |
| slimes-adventure | 16.7 MB |
| vanilla-perfected | 25.9 MB |
| zombie-invade-100-days | 28.6 MB |
| the-pixelmon-modpack | 43.9 MB |
| better-mc-fabric-bmc2 | 63.2 MB |
| better-mc-forge-bmc4 | 86.2 MB |
| cobblemon-fabric | 96.2 MB |
| cave-horror-project-modpack | 161.8 MB |
| cobbleverse | 227.9 MB |
| battlearmorytacz | 339.2 MB |
| prominence-2-fabric | 404.9 MB |

### 3.3 只读 zip 目录是可行的（**关键**）

> ⚠️ 本节结论经过两轮实测修正。初次用后缀写法 `Range: bytes=-65536` 得到 **501**，误判为「不支持 Range」。
> 正确写法 `Range: bytes=<start>-<end>` 得到 **206**。

| 目标 | 后缀写法 | 起止写法 | 结论 |
|---|---|---|---|
| `cdn.modrinth.com`（.mrpack） | 501 | **206** | ✅ 支持 |
| `mediafilez.forgecdn.net`（CF 包） | — | **206** | ✅ 支持 |
| `edge.forgecdn.net`（CF 重定向层） | — | **404** | ❌ 只做重定向，不支持 Range |

**CF 的正确用法**：先 HEAD 跟随重定向拿到最终的 `mediafilez.forgecdn.net` 地址，再对该地址发 Range。
直接在 `edge.forgecdn.net` 上发 Range 会 404。

#### 实测：只读中央目录即可列出全部文件

用 Range 取 zip 尾部 → 解析 EOCD → 按偏移取中央目录 → 得到完整文件清单：

| 整合包 | 平台 | 整包体积 | 只读目录 | 耗时 | 条目数 |
|---|---|---|---|---|---|
| fabulously-optimized | Modrinth | 0.17 MB | 6.2 KB | — | 53 |
| better-mc-forge-bmc4 | Modrinth | 86.2 MB | 590.1 KB | 1.3 s | 4,646 |
| prominence-2-fabric | Modrinth | 404.9 MB | 307.0 KB | 1.1 s | 2,426 |
| All the Mods 10 | CurseForge | 190.8 MB | 607.0 KB | 4.7 s | 4,178 |

⇒ **判断一个整合包有没有任务书、是哪种格式，成本约 0.3~0.6 MB、1~5 秒**，不需要下载整包。

#### 实测：按需解出单个文件

从 190.8 MB 的 ATM10 中只取 `lang/en_us/chapters/aether.snbt`（压缩 8,753 B → 原始 23,295 B）：

- 解析本地头 + 按偏移取压缩数据 + `inflateRawSync`
- 耗时 **2.1 秒**，加上目录总计 6.8 秒
- 内容正确：确认为 `quest.<hex>.title` / `quest.<hex>.quest_desc` 格式

⇒ 整条流水线可以做到「**只碰需要的文件**」：读目录 → 挑出 `ftbquests/**` 条目 → 逐个取原文 → 翻译 → 产出。

### 3.4 任务书的三种位置（实测）

| 位置 | 实测案例 | 说明 |
|---|---|---|
| `overrides/config/ftbquests/` | `better-mc-forge-bmc4`（19 条）、`prominence-2-fabric`（50 条） | 整合包作者定义的任务书，**玩家可改** |
| `overrides/defaultconfigs/ftbquests/` | `better-mc-forge-bmc4`（20 条） | 新实例的默认值 |
| `mods/*.jar` 内部 | 多个样本的清单里有 FTB Quests 系模组 jar | 模组自带的默认任务书 |

⇒ 三条路径都要覆盖。

### 3.5 平台规模

| 平台 | 数量 | 来源 |
|---|---|---|
| Modrinth `project_type:modpack` | **18,863** | `GET /v2/search?facets=[["project_type:modpack"]]`，2026-10-17 |
| Modrinth `project_type:shader`（对照） | 1,002 | 同上（对照现有 shader-i18n-site 的 1,000 条） |
| CurseForge 整合包（`classId=4471`） | **≥ 10,000** | `GET /v1/mods/search?gameId=432&classId=4471`，`pagination.totalCount = 10000`（**API 上限**，真实值更高） |

---

## 4. 社区已有做法（这是最重要的借鉴来源）

### 4.1 CFPAOrg —— 模组汉化的事实标准

| 项 | 值 |
|---|---|
| 仓库 | <https://github.com/CFPAOrg/Minecraft-Mod-Language-Package> |
| 说明 | "A language package for Minecraft Mods" |
| Stars / Forks | 1,200 / 1,133 |
| 许可 | CC BY-NC-SA 4.0 |
| 主语言 | C#（打包器） |
| 官网 | <https://cfpa.site/> |

**玩家侧两种用法**（README 原文）：

1. **装模组（推荐）**：`I18nUpdateMod` / `I18nReborn` —— 启动时自动下载最新资源包（约 5 MB）并自动启用、自动把游戏语言设为简体中文
2. **手动**：官网下载资源包，自己放进游戏

**仓库结构**：`projects/`（翻译源）、`src/`（打包器 C#）、`config/`、`data/`、`broken/`

**关键借鉴点**：
- 产物是**资源包**（不是重打包的整合包）—— 与用户选择的产物形态一致
- 用**自动更新模组**解决「玩家懒得手动装」的问题
- 翻译协作走 Weblate（`I18nUpdateMod` README 提到「一键进入 Weblate 模组翻译项目对应位置」）

来源：README 原文（raw.githubusercontent.com，2026-10-17 读取）

### 4.1b FTB Quests 官方 lang 的格式（一手样本）

从 ATM10 的 `lang/en_us/chapters/aether.snbt` 实测解出（原文节选）：

```
{
	quest.04833C4BB0CCCBB7.quest_desc: ["Same as Stone Weapons just the &7Sword &rwill Drop &eAmbrosium Shards&r when Hitting Mobs and the &7Axe&r will drop them when chopping down &2Trees&r."]
	quest.04833C4BB0CCCBB7.title: "&7Holystone&r Weapons"
	quest.08E4892F96828EC4.quest_desc: [
		"You can't Hit the &c&lSun Spirit&r, ..."
		"{image:atm:textures/questpics/aether/aether_gold2.png width:200 height:100 align:center}"
	]
	quest.08E4892F96828EC4.title: "&c&lSun Spirit"
}
```

要点（全部来自实测）：

| 现象 | 含义 |
|---|---|
| 顶层键为 `quest.<十六进制>.title` / `.quest_desc` | 与 §2.2 源码推导一致，**实证** |
| tab 缩进（`\t`），数组元素两层缩进 | 与社区规则一致（§2.5） |
| `&7` `&e` `&r` `&c&l` 色码 | 必须保留；`&c&l` 是**组合码** |
| `\n\n` 转义 | 在**单行字符串**里，不是真换行 |
| `{image:atm:textures/... width:200 height:100 align:center}` | **内嵌资源指令**，出现在 `quest_desc` 数组里，绝不能翻 |

⇒ 校验器必须覆盖：**键集合、色码数量、转义序列、内嵌 `{...}` 指令、数组行数**。

### 4.2 直接可借鉴的任务书汉化工具

| 项目 | Stars | 语言 | 做什么 | 借鉴价值 |
|---|---|---|---|---|
| `XDawned/FTBQLocalizationTools` | 66 | Python | FTB 任务书本地化，**支持富文本保留**、术语优化、离线翻译模型 | ⭐ 已明确「因高版本原生支持 lang 而停止维护」，并指向后继项目 |
| `XDawned/ModpackLocalizationTools` | — | — | 图形界面版，支持 BetterQuesting 等 | 后继项目 |
| `XDawned/MCPackLocalizer` | — | — | 再后继，加 BQ / KubeJS / Mod 处理 | README 拉取返回 404，**未找到** |
| `Y-RyuZU/MinecraftModsLocalizer` | 47 | Rust/Tauri | 桌面应用：模组语言文件 + **FTB Quests** + Patchouli 手册 | ⭐ 有 Windows/macOS/Linux 安装包，可跑起来对照 |
| `dannyball710/minecraft-mod-translate-skill` | 3 | Python | Claude Code skill：7 阶段流水线（扫描缺口→词表→切块→翻译→校验→一致性审查→组装资源包） | ⭐ **流水线设计与本项目最像**，且 `references/ftbquests.md` 的规则清单可直接用作校验器需求 |

**`FTBQLocalizationTools` 的富文本清单**（README 原文，说明「需要保留富文本特殊格式的同时保证翻译需翻部分」，称已覆盖「将近十种富文本格式」）：

- 动态物品 ID：`#minecraft:apple`
- 网址：`www.minecraft.net`
- 彩色标记：`Find an &aAPPLE`
- 点击事件：`["",{"text":"Click here","color":"light_purple","clickEvent":{"action":"change_page","value":"4FA6ADCA7857A92F"},"hoverEvent":{"action":"show_text","contents":["Botania chapter"]}}," to see the Botania quest chapter for help in making Mana Steel."]`

⇒ **最后一条极其重要**：任务文本里可能内嵌完整的 JSON 富文本组件，其中 `value` 是**章节 ID**，绝不能翻。

来源：各仓库 README（raw.githubusercontent.com，2026-10-17 读取）

### 4.3 其它相关项目

`Y-RyuZU/MinecraftModsLocalizer` README 列出的任务书目录结构变体（值得照抄为兼容清单）：

- 标准：`config/ftbquests/quests/`
- FTB Interactions Remastered：`config/ftbquests/normal/`
- 嵌套分类与深层嵌套结构

GitHub 搜索 `ftb quests translation` 命中 **23 个**仓库（`GET /search/repositories`，2026-10-17）。

---

## 5. 未找到 / 待查

| 问题 | 状态 |
|---|---|
| 新版格式的**普及率**（占全部含任务书整合包的百分比） | 已知「确实存在」（ATM10 实测），但**未做大规模抽样** |
| 旧格式整合包中有多少已完成汉化 | 未统计 |
| 各整合包 `lang/zh_cn` 的完整度 | 仅知 ATM10 为 69/73 条目 |
| 明确的授权争议先例（模组作者禁止翻译分发） | **未找到**。CFPA 用 CC BY-NC-SA 4.0，是翻译项目自身的许可 |
| CurseForge 对「只分发语言文件」的政策条文 | **未找到** |
| `MCPackLocalizer` 的内容 | README 拉取 404 |
| 是否存在「网页版整合包汉化」的先例 | **未找到**。现有工具都是本地脚本/桌面应用 |

---

## 6. 对设计的直接影响（待用户裁决的问题）

1. **两代格式要不要都支持**——老格式要改玩家文件（重、险），新格式只需放文件夹（轻、安全）。只做新格式 = 放弃当前绝大多数真实整合包。
2. **产物形态**——`lang/<locale>/` 是**目录**不是文件，无法装进资源包 zip。玩家拿到的到底是什么（文件夹 / 补丁包 / 带安装说明的 zip）需要定义。
3. **`defaultconfigs` 要不要一起翻**——它与 `config` 内容基本重复，翻两遍浪费；只翻一个则新实例可能回落英文。
4. **下载成本**——CDN 不支持 Range，判断一个整合包有没有任务书需要整包下载（实测中位数数十 MB，最大 405 MB）。
5. **校验器必须全新写**——现有 `validate-lang.mjs` 只认 `key=value`，完全无法覆盖 SNBT 的行数一致性、色码数量、括号平衡。
