# 别人的整合包汉化工具：工程做法调研（任务 A）

> 调研时间：2026-10-17。工作目录 `E:/project/quest`。
> **铁律执行情况**：GitHub 元数据一律 `gh api`（认证账号 Kalloer1）；仓库文件一律 `raw.githubusercontent.com`；每条结论附可复核来源。查不到的写「未找到」。

## 0. 方法与可复核性

本次调研用到的三类可复核来源：

| 来源类型 | 形式 | 说明 |
| --- | --- | --- |
| 仓库元数据 | `gh api repos/<owner>/<repo>` | star / license / language / pushed_at / archived |
| 文件内容 | `curl -sL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>` | 分支取 `gh api repos/<owner>/<repo> --jq .default_branch` |
| 声明与坑 | `gh api repos/<owner>/<repo>/issues?state=all` + `repos/<o>/<r>/issues/<n>` | issue 号即 URL 锚点 |

检索命令（原样可复跑）：

```bash
gh api "repos/XDawned/FTBQLocalizationTools"
gh api "search/repositories?q=modpack+localization+minecraft&sort=stars&per_page=30"
gh api "search/repositories?q=minecraft+quest+translation&sort=stars&per_page=30"
gh api "repos/<o>/<r>/git/trees/<branch>?recursive=1"
gh api "repos/<o>/<r>/issues?state=all&per_page=100"
```

### 0.1 任务书点名仓库的存在性核验（含 2 处需要更正）

| 任务书写的 | 实际情况 | 证据 |
| --- | --- | --- |
| `ht0apNoR/ftb-quests-precision-localizer` | **不存在**（用户 `ht0apNoR` 也 404）。同名项目实为 `TimErmolt/FTB-Quests-Precision-Localizer`（fork 链：Horeak → TheonlyTazz → Mrbysco → Litchiiiiii → TimErmolt） | `gh api repos/ht0apNoR/...` → `404`；`gh api search/repositories?q=ftb-quests-precision-localizer` → `TimErmolt/FTB-Quests-Precision-Localizer`；fork 链见 raw `TimErmolt/FTB-Quests-Precision-Localizer/1.20.x/README.md` |
| `XDawned/ModpackLocalizationTools` | **同一仓库**：GitHub 返回 `full_name = XDawned/MCPackLocalizer`，`id = 661472413` 两者相同 → 仓库被改名 | `gh api repos/XDawned/MCPackLocalizer` 与 `.../ModpackLocalizationTools` 均返回 `{"id":661472413,"full_name":"XDawned/MCPackLocalizer"}` |
| `Horeak/ftb-quest-lang-generator` | 存在，但 **已归档**（`archived=true`），README 明说不再接受贡献 | `gh api repos/Horeak/ftb-quest-lang-generator`；raw README「Contributing: As this repository is archived and read-only」 |

### 0.2 仓库总表（组 1 + 组 2）

| 仓库 | star | license | 语言 | 最后提交 | 归档 | 一句话做法 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `XDawned/FTBQLocalizationTools` | 66 | GPL-3.0 | Python | 2026-05-24 | 否 | 提键→生成 `en_us.json`；离线/百度机翻；回填 snbt | `gh api repos/XDawned/FTBQLocalizationTools` |
| `XDawned/MCPackLocalizer` | 51 | GPL-3.0 | Python | 2026-10-14 | 否 | PyQt6 桌面工具：识别→翻译→校润→导出 patch 目录 | `gh api repos/XDawned/MCPackLocalizer` |
| `lexacyber/ftb_quests_translater` | 5 | 无 | Python | 2024-10-03 | 否 | 逐行正则改写 `chapters/` → `chapters-translate/` | `gh api repos/lexacyber/ftb_quests_translater` |
| `djacu/ftbquests_converter` | 5 | 无 | Python | 2022-08-27 | 否 | 正则抽 title/text/description，字符串整体 replace | `gh api repos/djacu/ftbquests_converter` |
| `Horeak/ftb-quest-lang-generator` | 2 | MIT | Java | 2024-12-04 | **是** | 游戏内 mod 命令导出 lang json | `gh api repos/Horeak/ftb-quest-lang-generator` |
| `Aletropy/ftb-translator` | 1 | 无 | TypeScript | 2024-01-17 | 否 | **仅脚手架**：`TranslateAll()` 是 `// TODO` | raw `src/Core/Translator.ts` |
| `Zergiv/ftb-quests-translator` | 1 | MIT | HTML/Python | 2026-08-01 | 否 | FastAPI + Gemini，逐行 `LINE_n|||` 协议 + 结构校验 | raw `translator.py` |
| `TimErmolt/FTB-Quests-Precision-Localizer` | 0 | MIT | Java | 2024-12-23 | 否 | 游戏内 mod，**用元素十六进制 ID 当 lang key** | `gh api repos/TimErmolt/FTB-Quests-Precision-Localizer` |
| `Leha2cool/FTB-Quests-translation---html` | 2 | 无 | HTML | 2026-02-11 | 否 | 纯浏览器单文件，正则占位符 + Google 翻译 | raw `FTB_translation.html` |
| `Y-RyuZU/MinecraftModsLocalizer` | 47 | MIT | TypeScript/Rust | 2026-10-03 | 否 | Tauri 桌面应用，自写 FTB lang SNBT 解析器 | `gh api repos/Y-RyuZU/MinecraftModsLocalizer` |
| `Thedrezik/MineAI-Modpack-Translator` | 31 | 无 | Python | 2026-09-30 | 否 | 「钛盾」掩码 `[#n#]` + 资源包/数据包 | raw `mineai/text_processing.py` |
| `dannyball710/minecraft-mod-translate-skill` | 3 | MIT | Python | 2026-08-10 | 否 | Claude Code skill，7 阶段 + subagent 并行 | raw `SKILL.md` |

### 0.3 补搜出来的相关项目（任务书要求「再补搜」）

`gh api "search/repositories?q=modpack+localization+minecraft&sort=stars"` 与 `q=minecraft+quest+translation&sort=stars` 里 star 靠前且做法有新意的：

| 仓库 | star | license | 做法要点 | 证据 |
| --- | --- | --- | --- | --- |
| `ronnikols/SNBT-AI-Localizer` | 4 | MIT | `__FMT_n__` 掩码色码；SQLite 翻译记忆 + 「复数守卫」模糊匹配；**QA/陪审团**三层校验 | raw `core.py`、`README.md`、`docs/QA.md` |
| `Habier/minecraft-modpack-translator` | 2 | MIT | Go：**逗号补全规范化器** + 按 locator 定位回写（带 source hash 校验） | raw `ftb_snbt.go`、`internal/writeback/writeback.go` |
| `Koudesuk/Modpack_Translator` | 2 | MIT | 术语库三层（整串短路/prompt 注入/事后强制）；**硬 token vs 软 token 分级校验** | raw `pipeline/glossary.py`、`pipeline/postprocessor.py` |
| `zack-zzq/FTBQuestLocalizerPython` | 1 | MIT | `split`/`extract`/`merge` 三命令，新老格式都支持 | raw `src/ftb_quest_localizer/splitter.py` 等 |
| `Kamesuta/betterquesting-translation-tools` | 5 | MIT | BQ JSON → CSV → Google 文档翻译 → 回写 | raw `src/toLangFile.js` |
| `CSCTACG/mc-mod-translate` | 1 | MIT | 900K 条社区词典 SQLite 优先，zh.minecraft.wiki 兜底 | raw `SKILL.md`、`scripts/query.py` |
| `neverclear86/modpack-quest-translator` | 0 | 无 | Deno：SNBT overlay / 资源包双模式；**任一字符串校验失败就完全不产出** | raw `README.md` |
| `pietro-lopes/FTB-Quests-Lang-Splitter` | 3 | — | 上游 mod，制造「`lang/en_us/` 目录」布局的那个东西 | `gh api search/repositories?q=quests+lang+splitter` |
| `CFPAOrg/Glossary` | 13 | NOASSERTION | 官方 en-zh 术语库（`Vanilla/*.tsv`、`Mod/*.tsv`） | `gh api repos/CFPAOrg/Glossary/git/trees/main?recursive=1` |

---

## 1. 富文本怎么保

### 1.1 各家手法对照

| 项目 | `&a` 色码 | `\n` 转义 | `{image:...}` | 内嵌 JSON 组件（clickEvent/hoverEvent） | 其他 |
| --- | --- | --- | --- | --- | --- |
| `XDawned/FTBQLocalizationTools` | 送百度前把 `&x` 换成 `[&x]`，回来再 debracket；离线模型直接吃 | 见下「转义」列 | 含 `{image:` 的**整行/整元素跳过不译**；`.jpg/.png` 命中即跳过 | 行内含 `{\"` 即**整行跳过**（打印「检测到特殊事件，已保留」） | `#ns:item` → `{xdawned}` 魔词占位后回填；`http(s)://` 命中整行跳过；`{@pagebreak}` 命中整行跳过；`\\&` → `PPP` 保护 |
| `lexacyber/ftb_quests_translater` | `re.sub(r'&([0-9]{1,3}\|[a-z])','^^*^^')` → 按出现次数还原 `&`+code | 不处理 | 行首 `"{` 开头即原样输出 | 不处理 | 译文中 `"` 一律替换成 `''`（会破坏文本里的引号）；只翻 `title:` / `description: [` 两种行 |
| `djacu/ftbquests_converter` | 无任何处理 | 无 | 无 | 无 | 正则 `title: "(.*)"`、`text: \[\n([^]]*)\n\t\]`；用 `quest.replace(line, translated)` 全文替换（**同文不同处会一起被换**） |
| `Horeak/ftb-quest-lang-generator` | 交给下游翻译，自己不处理 | 多行 description 用 `StringJoiner("\n")` 合并成一个 lang 值 | 用 `\{image:.*?}` 从 description 里**摘出来单独作为一个数组元素**（不翻译） | 不处理 | 见 §2 |
| `Zergiv/ftb-quests-translator` | Prompt 明令：`&a`–`&f`/`&0`–`&9`/`&r`/`&l`/`&o`/`&n`/`&m`/`&k` 位置不动、不得加空格 | Prompt 要求 `\\`、`\&` 原样 | Prompt：「`{@pagebreak}` leave exactly as is」 | Prompt：「`{"text": "xxx", "color": "yyy"}` 只翻 text 引号内，`clickEvent`/`hoverEvent` 不许动」 | 校验器逐行比对 `{}[]` 计数、`"` 计数、色码序列 |
| `TimErmolt/FTB-Quests-Precision-Localizer` | 交给下游，自己不处理 | `String.join("\n", ...)` 压成单值 | 单独给 key（`prefix.imageN`） | **拆成 JSON 组件重建**：`toFlatList()` 后逐段产出 `{"translate":"<key>","color":...,"bold":1,"clickEvent":{...},"hoverEvent":{...}}`，文本本身抽成 `prefix.rich_descriptionN` lang key | 见 §2；`{@pagebreak}` 原样保留 |
| `Leha2cool/FTB-Quests-translation---html` | `preserveCodes()` 把 `&([0-9a-z])` 换成 `^^*^^`，`restoreCodes()` 按序还原 | 不处理 | `skipBraces` 选项：含 `{`/`}` 的文本整段跳过 | 无（靠 skipBraces 顺带跳过） | `shouldSkipText()`：含西里尔/中文则跳过；`[:/._-]` 且无空格且 <60 字符视为技术 ID 跳过 |
| `Y-RyuZU/MinecraftModsLocalizer` | `ftb-lang-snbt.ts` 注释明说：字符串载荷**逐字节保留**（含 `\\n`、`&` 色码、`{image:...}`），markup 无损往返 | `quoteSnbtString()` 保留 `\"` `\\` `\n` `\r` `\t` `\b` `\f` 与 `\uXXXX`，其余反斜杠转义成 `\\x` | 不特殊处理，作为普通字符串值参与翻译 | `mod-language.ts`：语言 JSON 里的富文本组件按路径抽 `text`/`extra` 叶子，key 前缀 `__mml_component__`，译完按 JSON path 回填（`applyStructuredJsonTranslations`） | 非空校验：`isFtbQuestLangSourcePath` 只认 `lang/en_us.snbt` 或 `lang/en_us/**.snbt(_merged)` |
| `XDawned/MCPackLocalizer` | `local.py` 的 `PROTECTED` 正则覆盖 `§x§R§R§G§G§B§B`、`&/§#RRGGBB`、`&/§[0-9a-fk-orz]`，掩码成 `__MCPL_<hash>_n__`，回填时要求标记**集合完全一致**（顺序可变，增删重复报错） | `%n` 与 `(?:\\[nrt])+` 都在 PROTECTED 内 | `extraction.py`：`\s*\{(?:image\|item\|icon\|@?pagebreak)[^{}]*\}\s*` 整串匹配 → 计入 `preserved_directives` 计数、**不产出条目** | 内嵌 JSON（值以 `{`/`[` 开头且能 `json.loads`）→ 记 `结构化文本保持原样` 警告并跳过 | 值以 `{...}` 包裹且形如 lang key（`\{[\w.:/-]+\}`）→ 计入 `preserved_language_references` 跳过 |
| `Thedrezik/MineAI-Modpack-Translator` | `mask_protected_fragments()`：`[&§][0-9a-fk-orlmn]` → `[#n#]`；`unmask_translation()` 按编号回填 | `\n` 在 FORMAT_PATTERN 内 | `\{[^\}]+\}` 在 FORMAT_PATTERN 内（含 `{image:...}`） | 无专门处理（`{...}` 一律掩码） | 掩码还覆盖 `$(#AE)`、`<item:minecraft:dirt>`、`](url)`、`![alt]`、`[ns:path]`、`(ns:path)`、`(...md#anchor)`、`%s` |
| `dannyball710/minecraft-mod-translate-skill` | `ftbquests.md` 规则 2：`&` 码位置与前后空格必须逐字保留（举例 `"&e Off-Road"` → `"&e 越野"`） | 规则 3：`\"` `\\` `\n` 原样 | 规则 5 不翻译清单外的对象；行数必须与源一致 | 不涉及（Quest 只处理 lang snbt 值） | `validate_merge.py` 只对 `assets/<mod>/lang/*.json` 做 `%s`/`§`/`$(...)`/`{}` 计数比对 |
| `ronnikols/SNBT-AI-Localizer` | `FMT_CODE_PATTERN = &#RRGGBB｜[&§][0-9a-fk-orz]` → `__FMT_n__`；**大写 `&A`–`&Z` 故意不匹配**，避免吃掉 `Q&A`/`R&B` | 无特殊处理 | 无特殊处理 | 无特殊处理 | `TAG_SHIELD_PATTERN = #\w+:[a-zA-Z0-9_/-]+` → `__TAG_n__`；`ID_PATTERN`/`UUID_PATTERN` 整串跳过 |
| `Habier/minecraft-modpack-translator` | README 说明与 overlay 模式一致地保护并校验 | 同左 | 同左 | 同左 | 见 §5.5 校验清单 |
| `Koudesuk/Modpack_Translator` | `encode()` 把 `_PLACEHOLDERS` 全部换成 `{N}`；`postprocessor` 把色码当**软 token**（丢了也接受） | `\n` 属硬 token | — | — | `format_snbt_lang()` 负责回写 SNBT 结构；数组值拆成 `key[N]` 再重组 |
| `neverclear86/modpack-quest-translator` | 校验清单明列 `&6`/`§r` | 校验「embedded line breaks」 | 校验 `{image:...}` | 不涉及 | 还校验 `\&` 字面转义、空串保持空、术语表命中 |
| `CSCTACG/mc-mod-translate` | SKILL 规则：保留 `&6`/`&r` 等 | — | 保留 `{image:...}` 标签 | 保留 quest 依赖引用与 icon 名 | 只翻 `title:`/`subtitle:`/`description:` 三个字段 |
| `Kamesuta/betterquesting-translation-tools` | 抽成 CSV 时 `§` → `[§]`，回写时还原 | `\n` → 字面 `\\n`，回写还原 | — | — | 用文件路径 MD5 前 7 位当 key（`hashFilePath`） |

### 1.2 谁明确承认会漏哪类

| 项目 | 明确声明会漏 / 已出问题 | 来源 |
| --- | --- | --- |
| `XDawned/FTBQLocalizationTools` | 1.12 的 `text` 字段提取不到 | issue #13 |
| 同上 | lang 提取不完善：「只能提取第一段 title 内容」 | issue #6 |
| 同上 | 外链（超链接）行的翻译错误（其代码是直接跳过该行） | issue #5 |
| 同上 | snbt 提取出现括号错误，导致多个任务被识别成一个任务 | issue #15 |
| 同上 | nbt 翻译：`值为[TAG_String: xxx]的项遇到错误 can only concatenate list (not "NoneType") to list`，游戏内详细描述无法翻译 | issue #19 |
| 同上 | **翻译后 `true`/`false` 被加上引号变成 `"true"`/`"false"`，触发 FTB 兑换死循环把服务器搞崩** | issue #20 |
| `XDawned/MCPackLocalizer` | 提取后隐藏任务全部展示（隐藏失效） | issue #11 |
| 同上 | 多选一奖励提取后无法多选一 | issue #10 |
| 同上 | README「局限」：kubejs、模组内硬编码内容检测**可能存在部分遗漏**；目前只支持 `en→zh` 完整处理 | raw README「### 局限」 |
| `Y-RyuZU/MinecraftModsLocalizer` | 1.21 起 FTB 改用 snbt，一度完全无法翻译 | issue #16 |
| 同上 | `resources/createastral/lang/en_us.json` 这类非标准路径检测不到 | issue #17 |
| 同上 | 只引用 `config/betterquesting/DefaultQuests.lang` 的包翻不了 | issue #11 |
| 同上 | `config/ftbquests/normal/chapters/` 嵌套结构报 `No such file or directory: 'config\ftbquests\quests\chapter_groups.snbt'` | issue #9 |
| `Thedrezik/MineAI-Modpack-Translator` | 1.21.1 上只翻 title/subtitle，`quest_desc` 不翻 | issue #6 |
| 同上 | `&r` 前后的空格被正则吃掉，词粘在一起（`уровня&rи`） | issue #7 |
| 同上 | 会把**所有**语言文件都翻一遍（含 ru_ru），6k 行白跑 | issue #16 |
| 同上 | 重试失败行「有时管用有时不管用」，作者答复是**保护机制主动跳过**并留英文 | issue #17 |
| 同上 | 罗马数字被机翻成 `LVI → ЛВИ`、`CV → резюме` | issue #5 |
| `TimErmolt/FTB-Quests-Precision-Localizer` | 代码注释：「Resourcepack creation got broken by something. I'm not sure what. It's disabled for now. ~TE 22.12.2024」 | raw `commands/FTBQLangConvert.java` |
| `Habier/minecraft-modpack-translator` | 「Referenced-but-missing keys」与「Hard-coded literal labels」**结构性无法处理**，只在报告里计数 | raw README「Known limitations」 |
| `dannyball710/...-skill` | 无法程序化检测简体字残留（四种方法全假阳性）；词表会误套用；`zh_hk` 不满足 `zh_tw` | raw `references/pitfalls.md` |
| `ronnikols/SNBT-AI-Localizer` | 色码标记丢失且无法修复时**直接回退原文**；vanilla 术语表被作者**主动禁用** | raw `core.py`、`docs/QA.md` |
| `Leha2cool/...-html` | FAQ 承认译文会出现「weird characters or broken formatting」，建议开「Preserve format codes」 | raw README FAQ |
| `Zergiv/ftb-quests-translator` | 校验不过的行**静默保留原文**（`if ok: result[...] = trans`，否则丢弃译文） | raw `translator.py` `translate_file()` |

---

## 2. 产出形态

| 项目 | 产出形态 | 关键命令/入口 | 具体落盘位置 | 证据 |
| --- | --- | --- | --- | --- |
| `XDawned/FTBQLocalizationTools` | ①把 `chapters/**.snbt` 就地改写（值换成 `{ftbquests.chapter.<文件名>.quests<i>.title}`）+ 生成 `en_us.json`；②另有一个「回填」功能把 lang 值写回 snbt | `main.py` 菜单；`config.json` 里 `QUESTS_PATH` / `LANG_PATH` / `BACK_FILL_PATH` | 输出目录 = 输入目录首段加 `-trans`（`make_output_path`）；lang 文件固定写 `./en_us.json`；回填写 `-back` | raw `func/generate_lang.py`、`func/back_fill.py`、`func/base.py:make_output_path` |
| `XDawned/MCPackLocalizer` | **从不改写整合包原文件**，产物写独立 `patch/` 目录 + `manifest.json` 覆盖清单 + `report.html` 审核报告；可附带帕秋莉资源包与 I18nUpdateMod | `uv run mcpl-desktop`；导出补丁按钮 | `<任务目录>/patch/`；任务默认 `%LOCALAPPDATA%/MCPackLocalizer/tasks/` | raw `core/pack/patch.py:build_patch`、`AGENTS.md`「翻译产物始终写独立 patch/ 目录，绝不改写整合包原文件」 |
| `lexacyber/ftb_quests_translater` | 就地改写 → `chapters-translate/` 目录 | `python main.py`，交互输入 chapters 路径 | 把路径里的 `chapters` 替换成 `chapters-translate` | raw `main.py:main()` |
| `djacu/ftbquests_converter` | 就地改写 → 输出目录首段加 `-trans` | `python convert_quests.py` | `make_output_path` 把 `parts[0] += "-trans"` | raw `convert_quests.py` |
| `Horeak/ftb-quest-lang-generator` | 游戏内命令 → 导出 lang json + 改写任务文件 | `/ftb-lang-convert <lang>` | `ftb-conv/kubejs/assets/kubejs/lang/<lang>.json`；任务文件写 `ftb-conv/config/ftbquests`；原目录备份到 `ftb-conv/backup/ftbquests` | raw `FtbLangConvertMod.java` |
| `Zergiv/ftb-quests-translator` | 生成 `xx_xx.snbt` 供下载，用户手动放进 `config/ftbquests/quests/lang/` | `uvicorn server:app`；公开站下载 | `translations/` + `metadata.json` | raw README「download the `.snbt` file into `config/ftbquests/quests/lang/`」 |
| `TimErmolt/FTB-Quests-Precision-Localizer` | 生成 lang json，写进 **kubejs 路径** | 游戏内 `/ftblang <lang> <prefix> <mode>` | `FTBLang/kubejs\assets\ftbquests\lang\<lang>.json`；任务文件写 `FTBLang/config/ftbquests`（多难度时写 `FTBLang/config-overrides/<mode>/ftbquests/quests/`） | raw `utils/Constants.java`、`commands/FTBQLangConvert.java` |
| `Leha2cool/FTB-Quests-translation---html` | 浏览器里生成 ZIP，解压得 `chapters-translate/`，用户改名替换 | 打开 `index.html` | ZIP 内 `chapters-translate/` | raw README |
| `Y-RyuZU/MinecraftModsLocalizer` | 三种：模组 → 资源包；FTB Quest → 就地改章节或写 `lang/<locale>.snbt`；帕秋莉 → 写回 JAR | `bun run tauri dev`；GUI 四个 Tab | 资源包进 `<实例>/resourcepacks/`；Quest 就地写或写同目录 `<locale>.snbt`；直改文件先存 `<file>.mml-original.bak` | raw `docs/translation-help.md`、`src/lib/services/quest-text.ts:getQuestOutputPath` |
| `Thedrezik/MineAI-Modpack-Translator` | 资源包 + 数据包，**不动 jar** | `python -m mineai` | `resourcepacks/<name>.zip`；数据包进 `config/openloader/data/<name>_Datapack.zip` | raw `mineai/output/pack_writer.py` |
| `dannyball710/...-skill` | 模组 → 资源包；Quest → 就地写 `lang/<locale>.snbt`（明确不进资源包） | 7 个脚本，见 SKILL.md | `resourcepacks/<name>/`；Quest 与 `en_us.snbt` 同目录 | raw `SKILL.md`、`references/ftbquests.md` |
| `ronnikols/SNBT-AI-Localizer` | 可选 `resource_pack_mode`：把 lang 目录镜像进 `resourcepacks/Modpack_Local_<locale>/` | `snbt-tr -d <dir> -p <provider>` | 默认就地写；资源包模式下写资源包 | raw `core.py` `process()`、README |
| `Habier/minecraft-modpack-translator` | 资源包 + 可分享 ZIP | `modpack-translator --translate <path>` | `<modpack>/modpack-translator-output/export/` | raw README「Output」 |
| `zack-zzq/FTBQuestLocalizerPython` | `split` 出 per-chapter JSON；`extract` 出 `en_us.json` + 改写章节；`merge` 重建 `lang/<locale>/` 目录 | `ftb-quest-localizer split/extract/merge` | 见命令参数 | raw README + `splitter.py`/`merger.py` |
| `Koudesuk/Modpack_Translator` | **就地改 jar**（备份到 `mods_bak/`）+ 写 `zh_tw.json`/`zh_tw.snbt` 到源旁边 | GUI/CLI | `mods_bak/`、`quests_bak/`、`resourcepacks_bak/`、`data_bak/`、`shaderpacks_bak/` | raw README「Output Structure」 |
| `neverclear86/modpack-quest-translator` | 两种：SNBT overlay 归档 / Minecraft 资源包；可打成双击安装器 | `modpack-quest-translator --url ... --target ja_jp` | 输出 ZIP；overlay 内唯一条目 `config/ftbquests/quests/lang/<target>.snbt` | raw README |

**结论性观察（都有来源）**：产出形态分四派 ——
1. **改写原 snbt**（lexacyber、djacu、Horeak、TimErmolt、MCPL 的「旧版任务」路径、YR 的 legacy 路径、Koudesuk、ron 默认）；
2. **只生成 lang 文件**（XDawned 的 lang 工具、Zergiv、zack 的 split、neverclear86 overlay）；
3. **生成资源包/数据包**（YR 的 mods、MineAI、danny、hab、ron 可选、neverclear86 的 jar 模式）；
4. **写独立补丁目录不改原文件**（只有 `XDawned/MCPackLocalizer` 把它当硬约束，`AGENTS.md` 明写）。

---

## 3. 版本布局差异（单文件 `lang/en_us.snbt` vs 目录 `lang/en_us/`）

**有，而且不止两家。**

| 项目 | 单文件 `lang/en_us.snbt` | 目录 `lang/en_us/*.snbt` | 其它布局 | 来源 |
| --- | --- | --- | --- | --- |
| `Y-RyuZU/MinecraftModsLocalizer` | ✅ 正则 `^.*/ftbquests/(quests\|normal)/lang/en_us\.snbt$` | ✅ `lang/en_us/.+\.snbt(_merged)?`，输出 `lang/<locale>/...` | `ftb_quests` 与 `quests` 两种目录名；`normal/` 布局；splitter 的 `_merged` 后缀双写 | raw `src/lib/utils/ftb-lang-snbt.ts`、`src-tauri/src/minecraft/mod.rs:ftb_quest_lang_translation_paths` |
| `XDawned/MCPackLocalizer` | ✅ `len(parts)==2 and stem==source_locale` → 目标 `<locale><suffix>` | ✅ `len(parts)>=3 and parts[1]==source_locale` → 目标 `quests/lang/<locale>/<rest>` | 额外识别 `ftb_root/*/chapters/` 多难度目录；`questpacks/*.nbt` 旧整本 | raw `core/pack/extraction.py` |
| `zack-zzq/FTBQuestLocalizerPython` | ✅ 同时读 `lang/en_us.snbt` | ✅ 读 `lang/en_us/*.snbt` 与 `lang/en_us/chapters/*.snbt` | merge 时用 key 前缀路由回 `chapter.snbt`/`chapter_group.snbt`/`file.snbt`/`reward_table.snbt`/`chapters/<name>.snbt` | raw `splitter.py`、`merger.py` |
| `Habier/minecraft-modpack-translator` | ✅ | ✅ | 还支持 **JSON5 lang 文件**（`ftbquests_json5` 适配器） | raw `README.md`、`internal/writeback/writeback.go`（`case "ftbquests_snbt", "ftbquests_json5"`） |
| `ronnikols/SNBT-AI-Localizer` | ✅ `lang/en_us.json` | ✅ **FTB Quests 26.x 的 `lang/en_us/*.json5`**，逐文件写 `lang/<locale>/<file>.json5` + `.json5.bak` | 数组值拆 `key[idx]` | raw `README.md`「FTB Quests 26.x (.json5) Support」、`core.py:_find_lang_dirs` |
| `Thedrezik/MineAI-Modpack-Translator` | — | — | 用 `LOOSE_JSON_SEARCH_DIRS = ("kubejs/assets", "defaultconfigs", "config/ftbquests/lang")` 兜底 | raw `mineai/constants.py` |
| `dannyball710/...-skill` | ✅ 只认单文件 | ❌ 未提及 | — | raw `references/ftbquests.md` |
| `Zergiv/ftb-quests-translator` | ✅ `lang/en_us.snbt` | ❌ | 从 modpacks.ch 取 `lang/en_us.snbt` | raw `fetcher.py` |
| `TimErmolt/...-Precision-Localizer` | 不适用（游戏内导出，不读 lang） | 不适用 | 多难度：`config-overrides/<mode>/ftbquests/quests/` | raw `commands/FTBQLangConvert.java` |
| `Leha2cool/...-html` | 不适用（用户直接选 `chapters/`） | 不适用 | — | raw README |

**「`_merged` 后缀」与「`normal/` 布局」是最容易踩的两个坑**，只有 YR 明确在代码里同时处理（`strip_suffix("_merged")` + `is_ftb_quest_lang_directory` 接受 `quests` 或 `normal`）。splitter 本体是 `pietro-lopes/FTB-Quests-Lang-Splitter`（`gh api search/repositories?q=quests+lang+splitter`）。

---

## 4. 词表 / 术语 / 模组名

### 4.1 术语表机制对照

| 项目 | 有术语表？ | 形态 | 一致性怎么保证 | 专门处理模组名？ | 来源 |
| --- | --- | --- | --- | --- | --- |
| `XDawned/FTBQLocalizationTools` | 间接 | 百度翻译「术语库」在百度后台配，代码不实现；README 建议参考 CFPA 术语库 | 靠外部 API | 无 | raw README「Tips 1」 |
| `XDawned/MCPackLocalizer` | ✅ | `resources/glossary/glossary_en_zh.json`（**395,635 条**）+ `common_words_en.txt`（功能词排除表）+ 用户覆盖层 | Aho-Corasick 自动机；**最长匹配优先 + 重叠丢弃**；`is_generic_term` 排除常见词与纯数字；同一 key 多译名则记为 `ambiguous` 直接不用 | 部分：术语表里 `Create → ['制造','创建','新建','制作','机械动力','写入','创建地图','终端']` 是**多义项列表**，不强行唯一化 | raw `core/translation/glossary.py`；本地解析 `glossary_en_zh.json` 实测 `Create` 条目 |
| `dannyball710/...-skill` | ✅ | `build_glossary.py` 从整合包内**已有双语 mod** 挖 en↔target，**≥75% 一致才收**；vanilla client jar 权重 ×5 | 词表当**提示**而非法律；翻译 agent brief 明说「judge from context… Override when wrong」；另有「一致性审查」阶段按 namespace 复查术语漂移并输出 patch | 是：pitfall #8 明说 namespace ≠ 模组名（"Create: Sound of Steam" 的 namespace 是 `pipeorgans`），要求查 namespace 不查标题 | raw `scripts/build_glossary.py`、`references/pitfalls.md`、`references/workflow.md` |
| `Koudesuk/Modpack_Translator` | ✅ | `assets/glossary/minecraft_zh_tw.json`（73KB）+ `modnames_zh_tw.json` + `custom_glossary.json`，三层合并（自订 > 模组名 > 官方） | **三层用法**：①整串短路 `lookup()` 原文整串命中直接取官方译名；②`prompt_block()` 注入 system prompt（放最后以保持 prompt 缓存）；③`enforce()` 事后强制替换。单字词条只在译文整串等于该词时替换，多字词条才句中替换；译名已出现则跳过（保护「中文名（English）」夹注） | 有专门文件 `modnames_zh_tw.json`（内容示例 `{"Saturation Value":"飽和度", ...}`） | raw `pipeline/glossary.py`、`assets/glossary/modnames_zh_tw.json` |
| `ronnikols/SNBT-AI-Localizer` | ✅ 三层 | `resources/dictionary.json`（用户词典）+ `resources/vanilla_ru.json`（官方术语，**已主动禁用**）+ `resources/mod_rules.json`（按 modid 的禁翻提示） | 「Pins are additive forever」；术语 pin 仲裁（mini-model 判断是译文错还是 pin 错）；`build_glossary_context()` 只挑批次里**实际出现**的术语 | 是：`mod_rules.json` 按 modid 给 `name_override` + `translation_hint`（例：GregTech 禁译 `GT, EU, LV, MV, HV...`；AE2 禁译 `ME, AE, Network, Channel, ...`）；`global_hints` 明列「不要翻译 modid:item_name」「不要翻译模组名」 | raw `core.py:build_glossary_context`、`resources/mod_rules.json`、`docs/QA.md` §4 |
| `CSCTACG/mc-mod-translate` | ✅ | `Dict-Sqlite.db`（~142MB，90 万+ 条，来自 `i18n-Dict-Extender`，含 `ORIGIN_NAME/TRANS_NAME/MODID/KEY/VERSION/CURSEFORGE`）+ zh.minecraft.wiki 兜底 | 优先级：词典精确匹配 > wiki 重定向标题 > 上下文翻译；按 `modid` 拉全量已知译名当 glossary | 是：`query.py --modid <modid> --limit 10000` 把该模组所有已译名拉出来；`--list-mods --search` 反查 modid | raw `SKILL.md`、`scripts/query.py` |
| `Thedrezik/MineAI-Modpack-Translator` | ✅ | `dictionary.json`（自动生成，用户手改）；`IGNORE_TERMS` 白名单（RF/FE/EU/mB/GUI/JEI/API/NBT/罗马数字…） | `polish_translation()` 末尾按词典做 `\b` 边界替换，并保留首字母大写/全大写形态 | 否（`mod_names.py` 只从 jar 文件名推显示名，用于 UI） | raw `mineai/text_processing.py`、`mineai/constants.py`、`mineai/mod_names.py` |
| `Y-RyuZU/MinecraftModsLocalizer` | ❌（未找到术语表文件） | — | — | 靠 prompt 与结构化富文本路径 | `gh api search/code?q=repo:Y-RyuZU/... +glossary` → 仅测试文件命中；tree 里无 glossary/dictionary 文件 |
| `TimErmolt/...-Precision-Localizer` | ❌ | — | 靠 key 用十六进制 ID 稳定（便于人工按 ID 检索），但无术语一致性机制 | 无 | raw `README.md`、`Handler.java` |
| `Zergiv/ftb-quests-translator` | ❌ | — | 无 | Prompt 里「Do not translate: mod/brand names, registry IDs, keybind names」 | raw `translator.py:_build_prompt` |
| `Habier/minecraft-modpack-translator` | ❌（README 未提） | — | 无 | — | raw README |
| `Leha2cool/...-html` | ❌ | — | 无 | 靠「技术 ID 跳过」启发式 | raw README |
| `zack-zzq/...Python` | ❌ | — | 无 | 无 | raw README |
| `Kamesuta/...-tools` | ❌ | — | 无（靠 Google 文档翻译） | 无 | raw README |

### 4.2 关于「Create → 机械动力 而不是创造」

- **唯一带多义项列表的**是 `XDawned/MCPackLocalizer`：`glossary_en_zh.json` 里 `Create` 映射到 `['制造','创建','新建','制作','机械动力','写入','创建地图','终端']`，它的 `Glossary._build()` 对**多译名条目直接跳过**（`if len(translations) != 1: self.stats["ambiguous"] += 1; continue`）。也就是说它靠「不确定就不用」来避免把「创造」硬塞进机械动力语境。来源：raw `core/translation/glossary.py`、实测解析该 JSON。
- `dannyball710` 明确把这类问题写成 pitfall #4：词表从**整条物品名**挖出来，单词条目会带上复合词的含义（`Toast → 酪梨吐司` 来自 "Avocado Toast"，用在通知弹窗上就是错的；`Burner → 瓦斯爐` 用在 Create 的 Blaze Burner 上应该是「燃燒室」），并要求 agent 从英文判断、覆盖词表。来源：raw `references/pitfalls.md`。
- `ronnikols` 的 `mod_rules.json` 是最直接的「按模组禁译」机制：`"gregtech": {"name_override": "GregTech", "translation_hint": "Не переводить термины: GT, EU, LV, MV, HV, EV, IV, LuV, ZPM, UV, UHV, AE, ME..."}`，`global_hints` 里还有「Не переводить названия модов (например, 'GregTech', 'Applied Energistics 2')」。来源：raw `resources/mod_rules.json`。
- `Koudesuk` 有独立的 `modnames_zh_tw.json` 文件，但**内容极少**（实测只有 3 条，且是「Saturation Value/Food Saturation/Saturation Level」这类游戏机制词，不是模组名）。来源：raw `assets/glossary/modnames_zh_tw.json`。

### 4.3 上游术语库（可复核）

| 库 | 内容 | 证据 |
| --- | --- | --- |
| `CFPAOrg/Glossary` | `Vanilla/1.12.2.tsv`(392KB) `1.16.5.tsv`(686KB) `1.18.2.tsv`(745KB) `1.19.2.tsv`(805KB)；`Mod/模组简体中文翻译指南.tsv`(33KB) `模组材料简体中文翻译指南.tsv`(30KB)；`Vanilla/WIKI/*.json`（Block 214KB / Biome / Dungeons…） | `gh api repos/CFPAOrg/Glossary/git/trees/main?recursive=1` |
| `VM-Chinese-translate-group/i18n-Dict-Extender` | 周更合并 CFPA 与各模组自维护译文的 SQLite（90 万+ 条），`CSCTACG` 与 `XDawned` 都在用 | raw `XDawned/MCPackLocalizer/README.md`「致谢」；raw `CSCTACG/mc-mod-translate/SKILL.md` |
| `zhtw-naming-for-minecraft` | 繁中原版术语，`dannyball710` 的 `references/vanilla-terms.md` 明确说是改自它（CC BY 4.0） | raw `dannyball710/.../references/vanilla-terms.md` |

---

## 5. 校验

### 5.1 校验项总表（✅=有，—=无，⚠=部分/仅警告）

| 项目 | key 集合 | 行数/元素数 | 色码 | 括号/引号 | 占位符 | 数值 | 空值 | 失败处置 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Zergiv/ftb-quests-translator` | ✅ key 前缀必须不变 | — | ✅ 色码序列 `re.findall` 后必须**完全相等** | ✅ `{}[]` 计数 + `"` 计数 | — | — | — | ⚠ **静默丢弃该行译文，保留英文** | raw `translator.py:validate_translation`、`translate_file` |
| `dannyball710/...-skill` | ✅ 每个请求 key 必须存在、无多余 key | ✅ FTB 要求行数与源一致 | ✅ `§`/`\n`/`$(...)`/`{}` 计数比对（`markup_ok`） | — | ✅ Java 格式参数按**位置集合**比较，允许 `%1$s` 重排；禁止混用位置式与顺序式 | ⚠ 数值变化只出 info 级提示，不阻断 | ✅ 空 en → 保持空 | **BLOCKING**（missing_keys/format_mismatch/markup_mismatch/bad_json/chunk_missing）；其余仅警告 | raw `scripts/validate_merge.py`、`scripts/mclang.py:format_ok/markup_ok` |
| `XDawned/MCPackLocalizer` | ✅ 每个条目恰好绑定一次（`len(bindings)==len(entries)` 且值集合相等） | — | ✅ PROTECTED 片段**多重集完全相等**（`check_inventory`），可放宽为「不允许新增」 | ✅ 解析失败即整文件失败 | ✅ 同上（PROTECTED 含 `%s`、`%n`、`{}`、`{{}}`） | ⚠ 数字表达变化只出 `numeric_expression_changed` 提示 | ✅ 译文为空即报错 | **阻断**：源文件哈希变化、保留符丢失/重复/换序、`.lang` 含字面换行、路径越界、目标已存在；**仅警告**：数字变化、保留符变化（人工审核后可用） | raw `core/translation/local.py`、`core/pack/patch.py`、`core/formats/rendering.py` |
| `Y-RyuZU/MinecraftModsLocalizer` | ✅ `validateTranslationResponse` 检查 missing/extra/non-string 三类；`validateFtbQuestLangTranslation` 同 | ✅ FTB 输出保结构（单元素数组 vs 多元素数组分别处理） | ⚠ 无独立色码计数校验（靠「原文/译文 key 一致」+ prompt 约束） | ✅ SNBT 解析器 fail-closed（`unexpected content after outer compound` 等） | ⚠ 无独立占位符计数 | — | — | 抛异常 → 重试同一 chunk（默认 `maxRetries=5`，指数退避 `1000*retries` ms） | raw `src/lib/services/translation-service.ts`、`src/lib/utils/ftb-lang-snbt.ts` |
| `ronnikols/SNBT-AI-Localizer` | ✅ | — | ✅ `CODES_MISMATCH`；标记丢失 → **回退原文**（唯一例外：只丢一个 `&r` 时自动补到末尾） | — | ✅ `__TAG_n__` 必须全在 | ✅ `NUMBERS_MISMATCH`（"10%"→"15%"） | — | 机器层（0 token）直接**重译一次**；仍失败记 `unresolved`，不静默跳过 | raw `core.py:restore_formatting_codes`、`docs/QA.md` §1 |
| `Koudesuk/Modpack_Translator` | ✅ 无中文也算失败 | ✅ 换行被压掉算失败 | ⚠ **软 token**：色码丢失**仍然接受** | — | ✅ **硬 token**（`%1$s`、`{key}`、`\n`）丢失 → 回退原文 | ✅ 格式参数多于源直接拒（即使模组自带译文） | — | 重试 `--retry N` 次；仍失败回退英文并进 `Failed Items/`；「输出远短于多分句原文」也算失败（实测 144,580 对里假阳性 0.022%） | raw `pipeline/postprocessor.py`、README「Q: 校验」 |
| `neverclear86/modpack-quest-translator` | ✅ 必须与源 key 集合和值形状完全一致 | ✅ embedded line breaks 校验 | ✅ `&6`/`§r` | ✅ 整文档重新 parse 成 SNBT | ✅ `%s`/`%02d`/`%1$.2f`/`%<s`/`%%`/`{image:...}`/`<mod_var>` | — | ✅ 空串保持空 | **原子**：任一字符串校验失败就**完全不产出可安装归档**（`--allow-partial` 故意不实现），但缓存保留已成功部分 | raw `README.md`「Output is atomic」 |
| `Habier/minecraft-modpack-translator` | ✅ 用 locator + **source hash** 比对 | — | — | ✅ 自写 SNBT 规范化器（补逗号）+ 严格解析 | — | — | — | `FTB Quests source hash mismatch` / `locator ... target the same source span` 直接报错 | raw `internal/writeback/writeback.go`、`ftb_snbt.go` |
| `Thedrezik/MineAI-Modpack-Translator` | ⚠ 靠掩码回填时数量核对 | — | ⚠ 只做 `polish_translation` 修补（吃空格、修 `% s`→`%s`），不阻断 | — | ⚠ 同上 | — | — | 校验失败的行**留英文**（issue #17 作者确认这是「保护机制」） | raw `mineai/text_processing.py`、issue #17 |
| `XDawned/FTBQLocalizationTools` | — | — | ⚠ 只做「颜色码保护」不校验 | — | — | — | — | 异常 `try/except` 后 `continue`，只打印红字 | raw `func/quest_translate.py` |
| `Leha2cool/...-html` | — | — | ⚠ 只做掩码/还原 | — | — | — | — | 出错回退原文并记日志 | raw `FTB_translation.html` |
| `zack-zzq/...Python` | — | — | — | ⚠ 靠 `snbtlib` 解析 | — | — | — | 文件级 `try/except` + 打印 warning | raw `splitter.py`/`extractor.py` |
| `TimErmolt`/`Horeak` | — | — | — | — | — | — | — | 无 | raw 源码 |
| `Kamesuta` | — | — | ⚠ `[§]` 包裹保护 | — | — | — | — | 「If a translation target key is not found, the corresponding key is logged」 | raw README |

### 5.2 「哪项阻断、哪项仅警告」——两家写得最清楚

- **`dannyball710/validate_merge.py`**：`blocking = missing_keys + format_mismatch + markup_mismatch + bad_json + chunk_missing`；`mainland_fixed` 与 `empty_value` 只计数。且注释明确写：**故意不做简体字检测**，因为「OpenCC rewrites many perfectly valid Traditional characters (台->臺, 曲->麴, 岩->巖, 造, 那, 西), so every attempt at it produced only false positives」。来源：raw `scripts/validate_merge.py`。
- **`XDawned/MCPackLocalizer`**：`manifest["quality_warnings"]` 与 `pending_entries` 分开；`allow_partial` 才允许带着未译条目导出，否则 `raise ValueError(f"{len(pending)} 个条目尚无译文")`。来源：raw `core/pack/patch.py:build_patch`。

### 5.3 值得单独抄的校验技巧

| 技巧 | 说明 | 来源 |
| --- | --- | --- |
| **位置式参数按集合比较** | `%1$s ... %2$s` 重排是合法的（中文语序），所以比较「参数位置集合 + 类型」而不是字面顺序；同时禁止「位置式与顺序式混用」 | raw `dannyball710/scripts/mclang.py:format_ok` |
| **保护片段用多重集比较 + 可放宽** | `Counter(actual) - Counter(expected)` 为空即可（允许漏译但禁止新增/改坏） | raw `XDawned/MCPackLocalizer/core/translation/local.py:check_inventory` |
| **色码丢失的「单 `&r` 自动补」** | 只丢一个 reset 码时自动追加到末尾（未闭合 `&l` 会把样式糊到整行），其他情况回退原文 | raw `ronnikols/SNBT-AI-Localizer/core.py:restore_formatting_codes` |
| **硬/软 token 分级** | 色码是装饰性软 token（丢了仍接受），格式参数与结构占位符是硬 token（丢了回退） | raw `Koudesuk/Modpack_Translator/pipeline/postprocessor.py` |
| **大小写敏感的色码匹配** | 故意**不**匹配大写 `&A`–`&Z`，否则会吃掉 `Q&A` / `R&B`；`§` 码才用 ignore-case | raw `ronnikols/SNBT-AI-Localizer/core.py`（注释原文） |
| **source hash + locator 回写** | 每个待回写字符串记录 locator（JSON path / 数组下标）与源文件哈希；回写前重新定位并比对，且禁止两个 locator 指向同一 span | raw `Habier/minecraft-modpack-translator/internal/writeback/writeback.go` |
| **逗号补全规范化器** | FTB 的 SNBT 允许省略兄弟元素间逗号；自写状态机在「完整值之后 + 空白 + 下一个 key 形如 `x:`」处插入逗号，并对 typed array（`B;`/`I;`/`L;`）单独校验 | raw `Habier/minecraft-modpack-translator/ftb_snbt.go:normalizeFTBQuestSNBT` |
| **保留字节范围只替换字符串值** | `documents.py` 记录每个字符串的 `start/end`，倒序替换；注释、key、后缀、空白全部原样存活 | raw `XDawned/MCPackLocalizer/core/formats/documents.py:replace_strings` |
| **「输出远短于多分句原文」算漏译** | 结构检查全过但语义漏一大段的情况，用长度/分句数兜底（实测假阳性 0.022%） | raw `Koudesuk/Modpack_Translator/README.md` |
| **LLM 响应必须按 id 而不是按位置 join** | 「Missing, unknown or duplicate ids fail the batch」 | raw `neverclear86/modpack-quest-translator/README.md` |
| **禁用词/技术词白名单** | `IGNORE_TERMS` 列 RF/FE/EU/mB/GUI/JEI/API/NBT/罗马数字，并用 `(?<![a-zA-Z])...(?![a-zA-Z])` 边界匹配 | raw `Thedrezik/MineAI-Modpack-Translator/mineai/constants.py`、`text_processing.py` |
| **多义术语直接弃用** | 一个 en 词对应多个 zh 译名时不计入术语表，避免「Create→创造」污染 | raw `XDawned/MCPackLocalizer/core/translation/glossary.py` |

---

## 6. 它们声明未解决的坑（逐条抄录）

| # | 项目 | 声明原文（节录） | 来源 |
| --- | --- | --- | --- |
| 1 | `XDawned/FTBQLocalizationTools` | 「翻译后…所有 `true` 和 `false` 都被加上了引号变成了 `"true"` 和 `"false"`…领取任务的一瞬间服务器就崩了」；「FTB 官方依旧没有解决」 | issue #20 |
| 2 | 同上 | 「值为[TAG_String: xxx]的项遇到错误 can only concatenate list (not "NoneType") to list，请手动处理！进入游戏后详细描述无法翻译」 | issue #19 |
| 3 | 同上 | 「1.12 会有以 text 为 key 的任务文本，无法提取」 | issue #13 |
| 4 | 同上 | 「lang 文件提取不完善…他只能提取第一段 title 内容」 | issue #6 |
| 5 | 同上 | 「任务的外链翻译错误」 | issue #5 |
| 6 | 同上 | 「snbt 任务提取出现错误，导致文件失效…提取任务键名时会出现括号错误，导致多个任务在文件中被识别为一个任务」 | issue #15 |
| 7 | 同上 | 「1.12 严重问题…提取后任务文件 snbt 格式会变，导致完全加载不出来任务」；作者答复：原因是行末 `,` 缺失，1.12.2 同时存在有逗号与无逗号两种格式 | issue #16 + 作者评论 |
| 8 | 同上 | README「未来的计划」仍列「优化模型翻译效果，以及运行速度」「**添加对更多富文本格式的支持**」→ 说明富文本覆盖仍不全 | raw README |
| 9 | `XDawned/MCPackLocalizer` | issue #11「提取 ftb 任务后，任务会全部展示（隐藏任务失效）」——**无任何评论/结论，仍 open 状态下的已关闭** | issue #11 |
| 10 | 同上 | issue #10「其中有些任务奖励是多选一，提取后就无法多选一了」 | issue #10 |
| 11 | 同上 | README 局限：「自动化程序无法确保处理过程 100% 正确」「关于 kubejs、模组内的硬编码内容的检测**可能存在部分遗漏**」「目前暂时只支持 en→zh 方向上的完整处理」 | raw README「### 局限」 |
| 12 | 同上 | AGENTS.md：「当前有 1 个已知失败…`tests/core/pack/test_kubejs.py::test_js_user_examples_and_language_keys`」 | raw `AGENTS.md` |
| 13 | `TimErmolt/...-Precision-Localizer` | 「Resourcepack creation got broken by something. I'm not sure what. It's disabled for now. ~TE 22.12.2024」——资源包生成功能**已停用且原因不明** | raw `commands/FTBQLangConvert.java` |
| 14 | 同上 | `JSONService.java` 里 hoverEvent 处理留 `//TODO: Check if this is the correct way to get the JsonObject from the CODEC`，且旧实现被注释掉 | raw `service/impl/JSONService.java` |
| 15 | `Aletropy/ftb-translator` | `public TranslateAll() : void { // TODO }`——**整个核心未实现** | raw `src/Core/Translator.ts` |
| 16 | `Horeak/ftb-quest-lang-generator` | 仓库已归档；README：「As this repository is archived and read-only, contributions are no longer accepted」 | raw README |
| 17 | `Y-RyuZU/MinecraftModsLocalizer` | 「1.21 から FTBquest の仕様変更により翻訳が不可能に」——作者在 v3.0.3 才补上 snbt 支持 | issue #16 + 作者评论 |
| 18 | 同上 | 「Create:Astral の quest 翻訳に失敗する…言語パックのファイルパスをアプリ上で打ち込めるようにしてほしい」；作者答复：v3 才自动检测该路径，**且「ゲーム内表示の実機確認は未実施」** | issue #17 |
| 19 | 同上 | 「FTB の modpack である interactions remastered…`No such file or directory: 'config\ftbquests\quests\chapter_groups.snbt'`」——`normal/chapters/` 嵌套结构 | issue #9 |
| 20 | 同上 | 「BetterQuest の DefaultQuests.lang のみを参照する ModPack が翻訳できない」 | issue #11 |
| 21 | 同上 | 「raft to Exile 2 にこちらの翻訳を適用したいです」——issue 仍 open | issue #10 |
| 22 | `Thedrezik/MineAI-Modpack-Translator` | 「1.21.1…переводит заголовок и подзаголовок, но описание самих квестов все еще на англе」+ 用户追加「описание (quest_desc) почему-то нет」 | issue #6 |
| 23 | 同上 | 「the text processing removes the space before `&r`, which leads to both words…stuck together」 | issue #7 |
| 24 | 同上 | 「программа переводит все файлы языков в квестах…по 6к строк в каждом」+ 用户追问「воспользовавшись релизной версией…он решил перевести еще и ru_ru файл」 | issue #16 |
| 25 | 同上 | 作者答复 issue #17：「Программа запросила перевод повторно, но снова получила бракованный ответ…скрипт безопасно пропустил эти проблемные строки, оставив их на английском」+「сейчас программа не выводит сам текст забракованных строк」——**被拒行的原文不进日志** | issue #17 |
| 26 | 同上 | 「LVI -> ЛВИ, LII -> ЛИИ, CV -> резюме」——罗马数字被机翻；作者答复需用户手工写 `dictionary.json` | issue #5 |
| 27 | `dannyball710/...-skill` | 「Four methods were tried to flag leftover Simplified characters…**Every one produced only false positives**」——简体字检测做不到 | raw `references/pitfalls.md` #3 |
| 28 | 同上 | 「never run OpenCC to "normalize" or "fix" finished output」（`曲柄→麴柄`、`干擾→幹擾`、`附魔台→附魔臺`） | raw `references/pitfalls.md` #2 |
| 29 | 同上 | 「the original build of this workflow counted `zh_hk` as done and left ~600 keys silently English across 8 mods」 | raw `references/pitfalls.md` #1 |
| 30 | 同上 | 词表误套用：`Toast→酪梨吐司` 用在通知弹窗、`Burner→瓦斯爐` 用在 Create 的 Blaze Burner（应为燃燒室）；「expect ~75% false-positive rate」 | raw `references/pitfalls.md` #4 |
| 31 | 同上 | 「Blind substring replacement…`質量 → 品質`…turned a mass readout into "quality"；`內存 → 記憶體`…producing 空間記憶體取」 | raw `references/pitfalls.md` #5 |
| 32 | `ronnikols/SNBT-AI-Localizer` | 「vanilla glossary is off…DISABLED (user directive 2026-10-02)…The vanilla_ru.json file stays on disk unused」——**官方术语表被作者主动关闭** | raw `core.py:load_vanilla_glossary`、`docs/QA.md` §4 |
| 33 | 同上 | 「The model lost/mangled formatting markers: falling back to the ORIGINAL string…a later complement run retries this string」——**色码丢失时牺牲翻译保原文** | raw `core.py` |
| 34 | `Habier/minecraft-modpack-translator` | 「**Referenced-but-missing keys.** A key the quest files reference that the source language file does not define has no English text to translate. It is omitted…the game keeps showing the raw key」 | raw README「Known limitations」 |
| 35 | 同上 | 「**Hard-coded literal labels.** A `title`, `subtitle` or `description` typed straight into a quest file…has no translation key, so no resource pack can reach it」 | raw README |
| 36 | 同上 | 「A pack with more than 500 quest files is **refused** rather than partly read」；「Minecraft `1.21.9` and newer are not supported yet」 | raw README |
| 37 | `neverclear86/modpack-quest-translator` | 「**Output is atomic.** If any string cannot be validated, no installable archive is written at all…`--allow-partial` is deliberately not implemented in v1」 | raw README |
| 38 | 同上 | 「Most of the code and documentation in this repository are currently AI-generated. AI-generated content may contain errors or bugs」 | raw README 顶部 WARNING |
| 39 | `Koudesuk/Modpack_Translator` | 「A few mod JARs contain duplicate entries for the same path. Rewrites de-duplicate them (last entry wins)」；「Trailing commas are accepted in JSON everywhere — the game's GSON reader tolerates them, Python's `json` does not」 | raw README |
| 40 | `Leha2cool/...-html` | FAQ：「My translated quests show weird characters or broken formatting」——**用户报告过格式损坏**；「Firefox and Safari not supported for folder input」 | raw README FAQ |
| 41 | `zack-zzq/...Python` | 各处理函数统一 `except Exception: print(f"Warning: Failed to process {filename}: {e}")` ——**失败只打印 warning 后继续**，无阻断 | raw `splitter.py`/`extractor.py` |
| 42 | `Zergiv/ftb-quests-translator` | 校验不过时 `if ok: result[...] = trans`，即**静默丢弃译文**，不计数不报告 | raw `translator.py:translate_file` |
| 43 | `yasuhero99/Quest-Logistics-Framework` | `FTBQuestsAdapter.extract/inject` 均 `raise NotImplementedError("...still provided by legacy qlf.py in v1.9.x")`；ROADMAP 明说「Do not implement adapters based only on guessed formats」 | raw `qlf_core/adapters/ftbquests.py`、`docs/ROADMAP.md` |
| 44 | `djacu/ftbquests_converter` | `googletrans` 上游 bug 被迫用异常兜底：`except AttributeError: return translate_line(line)`（注释里贴了 `py-googletrans#350`）；且用 `quest.replace(line, translated)` 全文替换 | raw `convert_quests.py` |

---

## 7. 值得吸收的手法（逐条 + 来源）

> 只写客观手法与其出处，不替本项目做设计决策。

### 7.1 富文本 / 转义

| # | 手法 | 具体做法 | 来源 |
| --- | --- | --- | --- |
| A1 | **色码掩码 + 回填 + 集合校验** | `&`/`§` 码换成不透明占位符（`__FMT_n__` / `[#n#]` / `__MCPL_hash_n__` / `^^*^^` / `[&x]`），翻译后回填，并要求**多重集相等**；不等则回退原文或报错 | `ronnikols/core.py`、`Thedrezik/text_processing.py`、`XDawned/MCPackLocalizer/local.py`、`Leha2cool/FTB_translation.html`、`XDawned/FTBQLocalizationTools/base.py:bracket/debracket` |
| A2 | **大小写敏感的色码正则** | 只匹配小写 `&a`–`&f`/`&0`–`&9`/`&r&l&o&n&m&k&z` + `&#RRGGBB`，**故意不匹配**大写 `&A`–`&Z`，避免吃掉 `Q&A`/`R&B` | `ronnikols/core.py`（注释明确写此理由） |
| A3 | **单 `&r` 丢失自动补末尾** | 只丢一个 reset 码时追加到译文末尾（未闭合 `&l` 会污染整行），其他丢失情形回退原文 | `ronnikols/core.py:restore_formatting_codes` |
| A4 | **`{image:...}` 三种处理任选** | ①整行/整元素跳过（XDawned、zack）；②摘出来当独立数组元素、给独立 lang key（Horeak、TimErmolt）；③整串匹配后计入 `preserved_directives` 计数、不产出条目（MCPL） | `XDawned/FTBQLocalizationTools/base.py`、`Horeak/FtbLangConvertMod.java`、`TimErmolt/Handler.java:handleDescriptionImage`、`zack/extractor.py`、`XDawned/MCPackLocalizer/extraction.py` |
| A5 | **内嵌 JSON 组件拆叶子 + JSON path 回填** | 把 `{"text":..., "extra":[...], "clickEvent":...}` 的 `text`/`extra` 叶子按路径抽出（key 前缀 `__mml_component__`），只翻叶子，再按 path 写回；clickEvent 的 value 与 hoverEvent 的结构**原样保留** | `Y-RyuZU/MinecraftModsLocalizer/src/lib/services/mod-language.ts` |
| A6 | **用 `translate` 键重建 JSON 组件** | 把富文本解析成 flat list，逐段产出 `{"translate":"<lang key>","color":...,"bold":1,"clickEvent":{"action":...,"value":...}}`，文本抽成独立 lang key；hoverEvent 的 contents 也走 `translate` | `TimErmolt/FTB-Quests-Precision-Localizer/service/impl/JSONService.java` |
| A7 | **保留源字符串的字节范围，倒序替换** | 解析时记录每个字符串值的 `start/end`，只替换值区间，注释/key/空白/后缀全部原样存活；替换前校验「快照范围与条目不匹配」 | `XDawned/MCPackLocalizer/core/formats/documents.py:replace_strings`、`core/formats/rendering.py` |
| A8 | **`\n` 与 `\\&` 显式保护** | `%n`、`(?:\\[nrt])+`、`\\&`→临时词，避免机翻吃掉转义 | `XDawned/MCPackLocalizer/local.py`、`XDawned/FTBQLocalizationTools/base.py`（`\\\\&` → `PPP`） |
| A9 | **`true`/`false` 这类裸标量不得加引号** | 该 bug 会直接崩服（见坑 #1）；对应做法是把「只翻引号内的字符串值」当硬约束（YR 的 `replace_strings` 只动 quoted span；MCPL 的 `documents.py` 同理） | issue `XDawned/FTBQLocalizationTools#20`；`Y-RyuZU/src/lib/services/quest-text.ts:applyQuestTranslations` |

### 7.2 布局 / 版本兼容

| # | 手法 | 来源 |
| --- | --- | --- |
| B1 | 用正则同时匹配「单文件 `lang/en_us.snbt`」与「目录 `lang/en_us/**.snbt`」，并把 `_merged` 后缀当作同一文件的另一种停放态（输出时双写 active 与 `_merged`） | `Y-RyuZU/src/lib/utils/ftb-lang-snbt.ts`、`src-tauri/src/minecraft/mod.rs:ftb_quest_lang_translation_paths` |
| B2 | 目录名 `ftbquests` 与 `ftb_quests` 都认；`quests` 与 `normal` 都认 | `Y-RyuZU/.../mod.rs:is_ftb_quest_lang_directory` |
| B3 | 多难度（packmode）布局：把每个 `ftb_root/*/chapters/` 当独立 quest root，输出到 `config-overrides/<mode>/ftbquests/quests/` | `XDawned/MCPackLocalizer/core/pack/extraction.py`（`quest_roots` 循环）、`TimErmolt/.../FTBQLangConvert.java` |
| B4 | 新版 `lang/en_us/*.json5` 目录（FTB Quests 26.x）单独一条分支，逐文件写 `<locale>/<file>.json5` + `.bak`，数组值拆 `key[idx]` | `ronnikols/core.py:_find_lang_dirs`/`process()`、`Habier/internal/writeback/writeback.go` |
| B5 | 旧版整本 `questpacks/<mode>.nbt` 单独处理（含二进制 NBT 解析/回写） | `XDawned/MCPackLocalizer/core/formats/binary_nbt.py` + `extraction.py` |
| B6 | 老格式（pre-1.20 内联文本）与新格式（lang 文件）分两个子命令：`extract` vs `split` | `zack-zzq/FTBQuestLocalizerPython/README.md` |
| B7 | 用内容启发式区分「内联直写文本」与「lang key 引用」：查 `minecraft:`/`ftbquests:`/`item.`/`quest.` 与 `description:`/`title:` 的组合 | `Y-RyuZU/src-tauri/src/minecraft/mod.rs:detect_snbt_content_type` |
| B8 | 「引用但缺失的 key」与「硬编码字面量」单独计数并在报告里列出，绝不猜 | `Habier/README.md`「Known limitations」 |
| B9 | `pack_format` 由整合包自身 MC 版本推导，未知/过新时用 15 并**明确告知**，可 `--pack-format` 覆盖 | `Habier/README.md`、`neverclear86/README.md`；版本表亦见 `Thedrezik/mineai/constants.py:PACK_FORMATS` |

### 7.3 产出与安全

| # | 手法 | 来源 |
| --- | --- | --- |
| C1 | **产物写独立 `patch/` 目录，绝不改原文件**；附 `manifest.json` 覆盖清单 + `report.html` 审核报告（含每条原文/译文/状态/质量提示） | `XDawned/MCPackLocalizer/core/pack/patch.py`、`AGENTS.md` |
| C2 | 导出前校验「任务目录必须位于游戏实例之外」（`validate_output`），并用 `safe_path` 防目录穿越 | 同上 |
| C3 | 回写前比对源文件哈希，变了就拒绝并要求重建任务（`--baseline`） | 同上（`validate_sources`） |
| C4 | 直改原文件的场景一律先备份：`<file>.mml-original.bak`（YR）、`mods_bak/`+`quests_bak/`（Koudesuk）、`ftb-conv/backup/`（Horeak）、`<file>.bak`（MineAI）、`.json5.bak`（ron） | `Y-RyuZU/docs/translation-help.md`、`Koudesuk/README.md`、`Horeak/FtbLangConvertMod.java`、`MineAI/snbt.py`、`ronnikols/README.md` |
| C5 | 资源包路径必须 `assets/<ns>/lang/<locale>.json`，**多一层 `mod/` 游戏就读不到**（用户实测报的 bug） | issue `XDawned/MCPackLocalizer#3` |
| C6 | 若同时给「界面翻译包」与「任务/剧情翻译包」，要求剧情包**排在界面包之上** | `Thedrezik/README.md`「Strategy」 |
| C7 | 「只翻出真正缺口」：已装目标语言资源包 + jar 自带译文都算覆盖，重跑只报新增缺口（`--our-pack` 避免自算） | `dannyball710/SKILL.md`、`scripts/scan_gap.py` |
| C8 | 大 namespace 先分诊（≥300 缺口标红，`fancymenu` 这类开发者/配置 mod 直接 `--skip-ns` 跳过），跳过要明说 | `dannyball710/SKILL.md`、`scripts/scan_gap.py` |
| C9 | 增量与幂等：按「task 文件 vs 输出文件」做差集，只翻缺的；`--prefix` 给新批次打标不碰旧的 | `dannyball710/references/workflow.md` |
| C10 | 译文缓存按「源文本+源语言+目标语言+provider+…」做键，且**同一文本=译文的记录不算命中**（防缓存污染） | `neverclear86/README.md`、`ronnikols/README.md`（Cache poisoning protection） |
| C11 | 双缓存分离（机翻 / AI 各自独立），避免风格互相污染 | `Thedrezik/README.md`「Isolated Caching System」 |
| C12 | 整合包更新时复用上版本已审核译文 / 模组共享译库 | `XDawned/MCPackLocalizer/README.md`「支持增量翻译」；`i18nMetaData.json` 资源 |
| C13 | 可附带 I18nUpdateMod（从 Modrinth 取 release，校验 sha512/sha1 + size + 下载主机） | `XDawned/MCPackLocalizer/core/mods/i18n.py:attach_i18n` |
| C14 | 帕秋莉/资源包兼容规则外置成 JSON（namespace + key 正则 + 正则替换），改规则不用改代码 | `XDawned/MCPackLocalizer/resources/compatibility/mod_language_rules.json` + `README.md` |

### 7.4 翻译流程工程化

| # | 手法 | 来源 |
| --- | --- | --- |
| D1 | 把「整包上万条字符串」切成 ≤220 key / ≤4500 源字符的任务文件，每个文件附上「本块用得到的术语子集」+「每条 key 的提示（zh_hk 高保真 / zh_cn 低保真，且标注可信度）」 | `dannyball710/scripts/make_chunks.py` |
| D2 | 提示分级要**显式标注可信度**：`hint_kind` 写「zh_hk converted to TW: meaning is correct, fix only HK vocabulary」/「machine conversion of zh_cn (~28% reliable): rewrite from English」 | 同上 |
| D3 | 翻译 agent brief 里写死 HARD RULES：保留每个格式 token（数量一致）、`%1$s` 重排仅当全部参数都改、专名/注册 ID/keybind 不译、空 en 保持空、自检 | `dannyball710/references/workflow.md` § Translation agent brief |
| D4 | 独立的「一致性审查」阶段：按 namespace 复查术语漂移，**只回传有改动的 key 组成的 patch**，且 patch 必须再过一遍结构校验（审查者可能弄丢 `%s`） | `dannyball710/references/workflow.md` § Phase 6 |
| D5 | 术语表「当提示不当法律」：从复合名挖出来的单词条目会带错义，要求 agent 从英文判断并覆盖 | `dannyball710/references/pitfalls.md` #4 |
| D6 | 术语表三层用法：整串短路 → prompt 注入（放 prompt 末尾以保 prompt 缓存）→ 事后强制替换（带结构 token 复查，失败则放弃替换） | `Koudesuk/pipeline/glossary.py` |
| D7 | 事后替换的守则：大小写敏感、单字词条只在整串相等时替换、译名已出现则跳过（保护夹注）、替换后结构 token 丢失就回滚 | 同上 `enforce()` |
| D8 | 术语表用 **Aho-Corasick 自动机 + 最长匹配优先 + 重叠丢弃**，并对「同一 key 多译名」直接弃用 | `XDawned/MCPackLocalizer/core/translation/glossary.py` |
| D9 | 只把**批次里实际出现**的术语塞进 prompt（避免每次带 1900 条） | `ronnikols/core.py:build_glossary_context`、`Koudesuk/pipeline/glossary.py:terms_in` |
| D10 | 按 modid 给「禁译提示」与「显示名覆盖」（GregTech/AE2 的缩写不许译） | `ronnikols/resources/mod_rules.json` |
| D11 | 词典优先、wiki 兜底、最后靠模型：`query.py --text "Copper Ingot"` 先查 90 万条 SQLite，未命中查 zh.minecraft.wiki 重定向标题 | `CSCTACG/SKILL.md`、`scripts/query.py` |
| D12 | 术语表来源可挖：从整合包内**已带双语的 mod** 反向挖 en↔target，≥75% 一致才收，官方 vanilla jar 权重 ×5 | `dannyball710/scripts/build_glossary.py` |
| D13 | 质量分级：机器层（0 token，确定性）先拦硬错 → LLM judge 两阶段（先只回有问题的 id，再出详情）→ 多 judge 陪审 + foreman 裁决 | `ronnikols/docs/QA.md` |
| D14 | 脚本违规只重译一次；仍失败**如实计为 `unresolved`**，绝不静默跳过 | 同上 §1 |
| D15 | 「输出远短于多分句源」算漏译（实测 0.022% 假阳性） | `Koudesuk/README.md` |
| D16 | LLM 响应按 id 而非位置 join；缺/多/重复 id 一律失败 | `neverclear86/README.md` |
| D17 | 整包只产出一份资源包，且**只写新翻的 key**（已覆盖的让下层资源包/模组 jar 透过），避免绕过校验 | `dannyball710/scripts/validate_merge.py` 注释 |
| D18 | 术语库来源可参考 `CFPAOrg/Glossary`（官方 en-zh 术语 TSV）与 `i18n-Dict-Extender`（90 万条 SQLite） | `gh api repos/CFPAOrg/Glossary/git/trees/main`；`CSCTACG/SKILL.md` |
| D19 | 用 `claude` CLI 子进程当 provider，且**不直连 HTTP API**；文本走 stdin 不进 argv | `neverclear86/README.md` |
| D20 | 把「批量 API（异步 job）」与「同步 API」做成两条路，断线后**不自动重提**，让用户去 provider 后台确认 | `Y-RyuZU/docs/translation-help.md` |

---

## 8. 未找到 / 存疑（如实记录）

| 事项 | 结论 |
| --- | --- |
| `ht0apNoR` 这个 GitHub 用户 | **不存在**（`gh api users/ht0apNoR` → 404）；任务书该条应为 `TimErmolt/FTB-Quests-Precision-Localizer` |
| `Y-RyuZU/MinecraftModsLocalizer` 的术语表机制 | **未找到**术语表/词典文件（tree 全量列过，`grep -i gloss\|term\|dict` 无命中；`search/code?q=repo:...+glossary` 仅 3 个测试文件命中）。它靠 prompt + 结构化富文本路径，不靠词表 |
| `Habier/minecraft-modpack-translator` 的术语表 | README 未提及；未找到 glossary 文件 |
| `Leha2cool`、`zack-zzq`、`Kamesuta`、`Zergiv` 的术语机制 | 均**未找到** |
| `Aletropy/ftb-translator` 的实际实现 | 无（`TranslateAll()` 是 `// TODO`），仅脚手架 |
| `Horeak` 的富文本处理 | 仅处理 `{image:...}` 与 description 的多行合并；**未见**色码/内嵌 JSON 处理 |
| `TimErmolt` 的色码处理 | 源码里**未见**色码正则；富文本靠 `toFlatList()` + JSON 组件重建，色码交由下游 |
| 是否有项目处理「`clickEvent.value` 是章节 ID 需保持不译」这一具体点 | 只有 `TimErmolt/JSONService.java` 把 clickEvent 的 `value` 原样写进 `"clickEvent":{"action":...,"value":"<原值>"}`（不翻译）；其余项目要么整行跳过（XDawned）、要么靠 prompt 声明（Zergiv）。**未找到**任何项目对 clickEvent value 做「是不是合法章节 ID」的校验 |
