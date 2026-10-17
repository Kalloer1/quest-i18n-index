# 中文社区与平台是怎么做 MC 汉化的

> 调查时间：2026-10-17（UTC 2026-10-16 23:07）。
> 方法：`gh api` 读 GitHub（账号 Kalloer1，已认证）、`curl` 读 raw.githubusercontent.com、
> 经 `HTTPS_PROXY=http://127.0.0.1:7897` 读中文站点（cfpa.site / modpack.cfpa.team / vmct-cn.top /
> docs.vmct-cn.top / mcmod.cn / bbs.mcmod.cn / klpbbs.com / dict.mcmod.cn）。
> 打包产物做了真实下载与解包验证（`tar.lzma`、`zip`）。
> **铁律遵守情况**：每条结论带来源；拿不到的直接写「未取得」。全文不含对本项目的设计建议。

---

## 0. 一句话结论

| 问题 | 回答 |
|---|---|
| 模组级汉化的事实标准 | CFPAOrg 的 `Minecraft-Mod-Language-Package`：一个 git 仓库 + 一个 C# 打包器 + GitHub Actions，产出**资源包 zip**，玩家用 `I18nUpdateMod3` 在游戏内自动下载并自动启用 |
| 有没有模组译名规范 | **有**，但是**不是**「Create 必须叫机械动力」式的强制译名表；规范是散文体的 `TransRules`（`rules-v2.md`），外加三个 TSV 术语库（`CFPAOrg/Glossary`）和一个机器可读词典产物（`CFPATools/i18n-dict`） |
| 有没有整合包级（含任务书）汉化先例 | **有，且不止一个**。最贴合的是 `CFPAOrg/Modpack-GuideBook-i18n`（35 个整合包 / 127 个版本，2022-06 停止更新）；当前主力是 `VM-Chinese-translate-group`（73 个仓库，13 个在维护） |
| 整合包汉化为什么不能只发资源包 | 因为任务书/手册/魔改脚本在 `config/`、`scripts/`、`kubejs/` 里，**资源包覆盖不到**——这是社区自己反复写在 README 里的原因 |

---

## 1. CFPAOrg 的完整工作流

### 1.1 仓库与目录约定（两代布局，`main` 分支已迁移）

CFPA 主仓库 <https://github.com/CFPAOrg/Minecraft-Mod-Language-Package>（C#，1200 star，1133 fork，
license CC BY-NC-SA 4.0，default_branch = `1-21-update`）。

**旧布局**（`1-21-update` 分支，版本在前）：

```
projects/<MC版本>/assets/<模组slug>/<命名空间>/lang/{en_us,zh_cn}.{json,lang}
```

实测样本（`1-21-update` 分支 tree，共 44674 项，未截断）：

| 路径 | 说明 |
|---|---|
| `projects/1.12.2/assets/enchantments-exchanger/enchxchg/lang/zh_cn.json` | json 形态 |
| `projects/1.12.2/assets/0-modrinth-mod/crossbow/lang/zh_cn.lang` | `.lang` 形态（1.12.2 仍用） |

各版本目录文件数（`1-21-update`）：`1.12.2` 11616、`1.16` 12610、`1.18` 11170、`1.19` 2454、
`1.20` 2476、`1.20-fabric` 789、`1.16-fabric` 1528、`1.18-fabric` 1771、`1.21` 24、`1.21-fabric` 9。

**新布局**（`main` 分支，版本在后）：

```
projects/assets/<模组slug>/<MC版本>/<命名空间>/lang/{en_us,zh_cn}.json
projects/templates/{pack.png,pack.mcmeta,LICENSE,README.txt}
projects/packer-example/
```

实测：`projects/assets/create/` 下有 `1.16 / 1.18 / 1.19 / 1.20` 四个版本目录
（<https://api.github.com/repos/CFPAOrg/Minecraft-Mod-Language-Package/contents/projects/assets/create?ref=main>）；
`projects/assets/create/1.20/create/lang/` 下是 `en_us.json` + `zh_cn.json`。

目录语义（`main` 分支 `CONTRIBUTING.md`「仓库结构」）：

- **项目名称（Project Slug）**= 发布平台 slug。CurseForge 直接用（`tinkers-construct`）；
  仅 Modrinth 发布的加 `modrinth-` 前缀（`modrinth-clean-f3`）。
- **命名空间**= `assets/` 与 `/lang` 之间的内容（`tconstruct`）。一个模组可有多个命名空间。
- `1UNKNOWN/` 存放不在 CurseForge / Modrinth 上发布的模组。
- 命名空间目录内的结构与**资源包**相同，所以手册类文件（`patchouli_books/`、`doc/`、`book/`）
  也直接放在这里。实测样本：
  - `projects/assets/occultism/1.18/occultism/patchouli_books/dictionary_of_spirits/zh_cn/entries/...`
  - `projects/assets/opencomputers/1.12.2/opencomputers/doc/zh_cn/item/terminal.md`
  - `projects/assets/schematic-energistics/1.20/schematicenergistics/ae2guide/_zh_cn/cannon_terminal.md`
  - `projects/assets/tinkers-construct/1.16/tconstruct/book/encyclopedia/zh_cn/armor/info.json`
- 版本优先级：模组活跃更新的 MC 版本优先；都活跃则版本号高者优先（例 1.19.4 优先于 1.19.2）。
  这一优先级不影响其他大版本分支。

来源：<https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/main/CONTRIBUTING.md>、
<https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/1-21-update/CONTRIBUTING.md>

### 1.2 打包器：入口、配置、产物、发布

**入口**：C# 解决方案 `Minecraft-Mod-Language-Package.sln`，实际入口是
`src/Packer/Program.cs` 的 `Main(string version, bool increment, bool grouped, bool flattened)`。

`Program.cs` 的流程（原文要点）：

1. 读 `./config/packer/{version}.json`（`ConfigHelpers.RetrieveConfig`）。
2. 固定注入 4 个初始文件：`projects/templates/pack.png`、`LICENSE`、
   `README.txt`（由 `config.Base.ReadmeTemplate` + `ReadmeParameters` 生成）、
   `pack.mcmeta`（由 `config.Base.McMetaTemplate` + `McMetaParameters` 生成，
   第一个参数是 `DateTime.UtcNow.AddHours(8)`，即 UTC+8 打包时间）。
3. `flattened` → 产出 `./Minecraft-Mod-Language-Modpack-{version}.zip` 并写 `./{version}.md5`。
4. `grouped` → 产出 `./grouped-Minecraft-Mod-Language-Modpack-{version}.zip`，内含 `Manifest.json`，
   内容按**命名空间**分组（`archive.WriteGrouped(query)`）。

来源：<https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/main/src/Packer/Program.cs>

**打包配置**（`config/packer/*.json`，共 12 个版本 + example + discriminator）：

- `base`（不可被局域配置改写）：`version`、`targetLanguages`（现为 `["zh_cn"]`）、
  `mcMetaTemplate`/`mcMetaParameters`、`readmeTemplate`/`readmeParameters`、
  `exclusionMods`、`exclusionNamespaces`、`fallbackVersions`。
- `floating`（可被命名空间级 `local-config.json` 改写）：`inclusionDomains`、
  `exclusionDomains`、`exclusionPaths`、`inclusionPaths`、`characterReplacement`、
  `destinationReplacement`。

`config/packer/1.21.json` 实例要点：

```json
"targetLanguages": ["zh_cn"],
"mcMetaTemplate": "./projects/templates/23w31a_1_21_8_pack.mcmeta",
"exclusionNamespaces": ["create-sound-of-steam", "replication"],
"fallbackVersions": ["1.20", "1.19", "1.18"],
"inclusionDomains": ["font", "textures", "gui"],
"exclusionPaths": ["packer-policy.json", "local-config.json", "README.md"],
"characterReplacement": { "\\[\\[钅卢\\]\\]": "\ud872\udf3b", "……": "\u22ef\u22ef", "——": "\u2e3a", ... }
```

**文件容斥顺序**（`Packer-Doc.md`，7 步）：
① `exclusionMods`/`exclusionNamespaces` 在进入命名空间前就排除（连 `local-config.json` 都不加载）；
② 在剩余命名空间检索文件；③ 排除 `exclusionPaths`；④ 包含 `inclusionPaths` + `inclusionDomains`；
⑤ 排除 `exclusionDomains`；⑥ **只保留路径中含简体中文语言标记的文件**。

**检索策略**（每个命名空间目录可放 `packer-policy.json`，默认 `[{"type":"direct"}]`）：

| type | 作用 | 参数 |
|---|---|---|
| `direct` | 原位打包 | — |
| `indirect` | 引用另一命名空间（目标命名空间自动替换为当前命名空间） | `source` |
| `composition` | 由「组合文件」生成语言文件 | `source`、`destType`（`json`/`lang`） |
| `singleton` | 引用单个文件并指定落点 | `source`、`relativePath` |

策略可**串联**（从前往后，前者优先）与**递归**（引用目标的策略也生效，需避免循环引用）。
公共开关：`modifyOnly`（只改已有键，不新增）、`append`（文本文件换行后追加）。
组合文件用 C# 复合格式化（`{0}`、`{1}`），**键冲突会让打包器直接崩溃**（文档原文）。

**命名空间区分规则**（`config/packer/namespace-discriminator.json`）：当多个 CurseForge 项目共用
同一命名空间时，打包器把命名空间改写为 `<namespace>-CFPA-<区分名>`，客户端用 `operator`
（`author` / `displayName` / 某文件的 MD5）自行算区分名。当前只有 1 条规则：

```json
[{ "namespace": "ae2stuff", "operator": "displayName",
   "mappingRule": { "ae2-stuff": "AE2 Stuff", "ae2-stuff-unofficial": "AE2 Stuff Unofficial" },
   "versionScope": { "forge": ["1.12.2"] } }]
```

来源：`Packer-Doc.md`、`config/packer/*.json`、
<https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/main/src/Packer/Models/NamespaceDiscriminator.cs>、
<https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/main/src/Packer/Helpers/ManifestHelpers.cs>

**CI**：`.github/workflows/` 有 `packer.yml`、`pr-packer.yml`、`formatter.yml`、`labeler.yml`、
`spider.yml`、`stale.yml`。

`packer.yml` 要点：

- 触发：push 到 `main` 且改动 `src/**`、`config/packer/**`、`projects/**`、该 workflow 自身；或手动。
- `build-packer` job：`windows-latest`，`dotnet publish .\src\Packer\Packer.csproj -o ./build -r win-x64`，
  用 `actions/cache` 缓存 `build/Packer.exe` + `build/git2-*.dll`（key = `hashFiles('src/Packer/**')`）。
- `pack` job：matrix
  `["1.12.2","1.16","1.16-fabric","1.18","1.18-fabric","1.19","1.20","1.20-fabric","1.21","1.21-fabric","26.1","26.1-fabric"]`，
  `MarceloPrado/has-changed-path` 判断该版本是否真变了，然后
  **`./Packer --version="<v>" --grouped --flattened`**。
- 产物：`Minecraft-Mod-Language-Modpack-<v>.zip` + `<v>.md5`（旧格式）与
  `grouped-Minecraft-Mod-Language-Modpack-<v>.zip`（新格式）。
- `upload` job：跑 `src/Uploader/Program.cs` 编出的 `Uploader.exe`，
  参数 `--host/--name/--password/--port` 来自 secrets。Uploader 做四件事：
  ① SFTP 上传所有 zip/md5 到服务器 `/var/www/html/files`；
  ② SSH 把 `grouped-*.zip` 在服务器上 `unzip` 到 `/var/www/html/files/<version>/` 再删 zip；
  ③ 在 GitHub 建 `Snapshot-<yyyyMMddHHmmss>` release 并传资产；
  ④ 更新固定 tag `autobuild` 的 release（删旧同名资产、传新资产、改说明里的「最后更新时间（UTC+8）」）。
- 还有一个「避开远程服务器维护窗口」的硬编码：`if [ date -u +%H -eq 20 ]; then exit -1; fi`。

来源：<https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/main/.github/workflows/packer.yml>、
<https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/main/src/Uploader/Program.cs>

**实测产物**（`autobuild` release，2026-09-29 更新，tag `autobuild`，名称「汉化资源包-Autobuild」）：

| 资产 | 字节 |
|---|---|
| `Minecraft-Mod-Language-Modpack-1-10-2.zip` | 1,441,839 |
| `Minecraft-Mod-Language-Modpack-1-16.zip` | 4,489,048 |
| `Minecraft-Mod-Language-Modpack-1-18.zip` | 3,883,053 |
| `Minecraft-Mod-Language-Modpack-1-19.zip` | 1,366,604 |
| `Minecraft-Mod-Language-Modpack-1-20.zip` | 2,142,995 |
| `Minecraft-Mod-Language-Modpack-1-21.zip` | 3,373,288 |
| `Minecraft-Mod-Language-Modpack-1-21-Fabric.zip` | 527,473 |
| `Minecraft-Mod-Language-Modpack-1-6.zip` | 1,398,131（2026-10-15 更新） |

另有 `Snapshot-<时间戳>` 形式的 release（每批打包一个），以及
`1.10.2.md5 / 1.12.2.md5 / … / 26.1-fabric.md5` 等校验文件。

**历史**：1.10.2 时代的打包器是 `run.sh` + `Tool_Update.lua` + `lib/entry.lua`
（从 `mods/*.jar` 里 `unzip assets/*/lang/en_US.lang`，再用 Lua 做中英合并）。
来源：<https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/archived-1.10.2/run.sh>

### 1.3 贡献流程与审核规则（`CONTRIBUTING.md` 全要点）

**总则**：
- 翻译**必须**符合 <https://cfpa.site/TransRules/>。
- **拒绝**机器翻译（含生成式 AI）、生硬翻译；已译后编辑且满足指南的机器翻译可接收。
  违反会打「生硬翻译」标签，不修则走搁置规则。
- 翻译**必须**经审查才能进仓库。

**PR 规定**：
- 标题格式 `{模组英文全名}{空格}{简述}`。✔️`Tinkers' Construct 翻译提交`；
  ❌`TiC 翻译更新`（未用全名）、❌`匠魂翻译更新`（无英文名）、❌`提交 Tinkers' Construct 翻译`。
- 需签 CLA（<https://cla-assistant.io/CFPAOrg/Minecraft-Mod-Language-Package>）。
- **必须**提到 `main` 分支；路径合规；**必须**同时包含简体中文与项目源语言文件
  （源语言非英语但模组有英语文件时，英语文件也**必须**包含）。
- **建议**一个 PR 一个模组；多模组中文总行数 ≤200 时可合并。
- **建议**用 `提交/更新/修改/删除` 之类词写 commit message；**建议**新开分支提交。

**审查**：
- 任何人都能在 PR 里评论审查，但只有 CFPA 成员（Member）与仓库协作者（Collaborator）是
  「官方审查人」；**至少 1 位官方审查人 Approve 才能合并**。
- 批准后**应**加「即将合并」标签，再**等至少 24 小时**，期间无新动态才可合并。

**搁置规则**（治 PR 积压）：
① 有未响应评论超 7 天 → 官方审查人可 @ 作者 + 加「即将被搁置」；
② 该标签再挂 7 天 → 视为无法回应：
  - 2.1 若审查意见需要作者参与 → 加「即将拒收」，1 天后关闭；
  - 2.2 若不需要作者参与 → 加「即将拒收」，1 天缓冲期内官方审查人**可**直接采纳并转合并。
③ 期间作者回应则清标签，计时重置。因搁置关闭的 PR 可重新打开。

**公示规则**（传播重大译名变更）：
适用于与官方/社区流传度较广的翻译存在**重大差异**且改动译名或词条的 PR。
纯文档/代码 PR 不进入公示（停止支持/重新支持某模组翻译的除外，例 #4327、#4215）。
审查通过后加「需要公示」标签，通过 Bilibili / QQ 群 / MC 百科社群发布，
**发布之日起 14 天**后清标签并加「即将合并」。公示需附 PR 链接、原文、更改内容、更改缘由。

**提示**：
- 路径不含 `zh_cn` 标记的文件会被打包器排除，需改全局或局域 Packer 配置；
  放在 `font` 或 `textures` 下的无需改（默认已特殊处理）。
- 不同版本的同一模组可用「自定义文件检索策略」同步翻译。

**代码贡献**：只针对 `src/`。要求懂 C#、GitHub Actions；提交前必须自己测过；不接受无意义 PR。

**配置更改**：只针对 `config/`。`config/packer/[version].json` 内含所有维护中版本的打包配置。
主要场景：① 增加新翻译版本（要同时更新 `packer.yml`、`pr-packer.yml`、`.github/boring-cyborg.yml`
以及 `CFPABot` 等相关服务，「没有规划最好不要乱动」）；② 改字符替换表 `characterReplacement`
（BMP 外字符最好用 UTF-16 代理对书写，且可能要改字体文件）；③ 处理非文本文件；④ 停止支持某模组
（把 slug 或命名空间加进 `exclusionMods`/`exclusionDomains`）。

**联系**：QQ 群 630943368。

来源：<https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/main/CONTRIBUTING.md>

### 1.4 翻译规范（`TransRules`，即 `rules-v2.md`）

站点 <https://cfpa.site/TransRules/> 是纯前端：`js/index.js` 用 showdown 渲染
`./file/rules-v2.md`。实测该 md 可直接 `curl` 到（28084 字节），页脚标注 **2025-8-28**，
以 **CC0 1.0** 发布。

要点（原文摘录）：

- **1 普适原则**：以原文为准（翻译前务必玩一遍）；不要过度依赖机器翻译/LLM；
  译文符合中文习惯（日期/货币/度量衡转换、语序调整）；注意一致性；
  半成品应删去未翻译内容；语言文件一般 `UTF-8 without BOM`；
  模组作者非英语母语且有母语语言文件时建议以其母语为源语言；
  模组作者要求与本指南冲突时**以作者要求为准**；**禁止套用不适宜烂梗**。
- **2 格式规范**：`%s`/`%d`/`%msg%` 占位符保留（可用 `%1$s` 调序，注意别写成全角 `％`）；
  `§0`/`&r` 颜色码保留并置于对应文本两侧；命令帮助里命令名与字面量保留原文、
  描述性参数名翻译；`<br>`/`\n` 保留；tellraw JSON **只**翻 `"text"` 项的值；
  XML 语言文件保留标签。排版：用规范中文全角标点；中英之间**不加**空格
  （Patchouli 手册例外，仍需加空格）；国际单位翻译成中文。
- **3 一致性**：物品/方块/生物名是重中之重；模组遵循原版术语，附属/联动模组遵循主模组术语；
  原版术语对照 Minecraft Wiki「译名标准化」；
  1.19.2 及以下注意「译名标准化/历史」（影响范围为本版本 + 前两个大版本，
  例 1.19.2 的改动同步到 1.19.2–1.17.X 但不落到 1.16.X）；
  1.19.3+ 按最新版译名翻译即可。
- **4 专有名词**：
  - 人名/神话人物/地名先在「字统网-译名查询」找正式译名，找不到按音译表或常用译名。
  - 商标名按中国大陆商标名翻译，未进入大陆市场的建议保留原文（`Patreon`/`Discord`/`GitHub`）。
  - 网络昵称保留原文；文艺作品名（画名、曲名）一般保留原文。
  - **模组名**：翻译前至少通玩一遍；发挥空间很大，「言之有理且大众喜闻乐见即可」；
    含义明确或为专业术语的不必重新起名（`Forestry`→`林业`、`Logistics Pipes`→`物流管道`、
    `Chisel`→`凿子`）；国创模组不在翻译业务范围。
    - **机械动力附属模组**常以 `Create: ...` 命名，**建议**采用 `主模组：子模组` 格式，
      例 `Create: Steam 'n' Rails` → `机械动力：汽鸣铁道`；其他非机械动力附属模组名也可参考该格式。
    - 多个 `ItemGroup` 建议用 `模组名丨分栏名`（竖线为汉字 `丨`），
      例 `Forestry Apiculture` → `林业丨养蜂`。
    - 自造词/含义广泛的词可先保留原文，等社区意见发酵后再投票定名（`Minecraft`→`我的世界`）。
- **附录：特殊字符替换表**：104~118 号元素的中文名（多为新造字/罕见字，位于 Unicode 拓展平面）。
  1.15 以下渲染器不支持拓展平面，故译文中写作 `[[钅卢]]` 这类标记，**由打包系统替换为正确字符**；
  1.15+ 虽已支持，格式仍保留以便输入与低版本对照。
  同时省略号 `……`→`\u22ef\u22ef`、破折号 `——`→`\u2e3a` 也做特殊处理。

来源：<https://cfpa.site/TransRules/file/rules-v2.md>（页内渲染见 <https://cfpa.site/TransRules/>）；
仓库 <https://github.com/CFPAOrg/TransRules>

### 1.5 译名/术语规范与机器可读词典

**结论：有术语/译名规范，但不是「Create 必须叫机械动力」式的硬表；规范是散文体指南 + TSV 术语库，
机器可读的成品是词典产物而不是规范。**

| 资产 | 位置 | 规模（实测） | 形态 |
|---|---|---|---|
| 翻译指南（规范） | `cfpa.site/TransRules/file/rules-v2.md` | 28084 B | 散文 Markdown |
| 原版术语表 | `CFPAOrg/Glossary` `Vanilla/terms/terms-v1.tsv` | 736 行 | TSV：`en / zh / reason / comment` |
| 原版 QA 规则 | `CFPAOrg/Glossary` `Vanilla/terms/qa-rules.tsv` | 11 行 | TSV：`id / key / except_key / en / require / forbid / mode / except_en / comment` |
| 原版分域术语 | `Vanilla/terms/special/terms-{banner,pottery,subtitles,trim,tropical_fish}.tsv` | — | 只对「语言 key 含该 token」的条目生效 |
| 模组译名 | `CFPAOrg/Glossary` `Mod/模组简体中文翻译指南.tsv` | 963 行 | TSV：`Term / Translation / Remark / Source` |
| 模组材料 | `CFPAOrg/Glossary` `Mod/模组材料简体中文翻译指南.tsv` | 743 行 | TSV：`Term / Translation / Remark / TermSorce / TransaltionSource` |
| 现行原版语言快照 | `Vanilla/latest.tsv`、`Vanilla/1.12.2.tsv` 等 | — | en/zh_cn/zh_tw/zh_hk/ja 对照 |
| 机器可读词典 | `CFPATools/i18n-dict` releases | `Dict.json` 221,723,139 B；`Dict-Mini.json` 18,546,959 B；`Dict-Sqlite.db` 127,307,776 B | 每周五自动发布 |

**匹配语义**（`Glossary/Docs/TERMS_SPEC.md`）：
- `en` 按词边界匹配，从左扫到右取最长命中，用过的词不再算（`Chain` 打不中 `Enchant`）。
- `zh` 无词边界，同一所指的表面变体用 `|` 并列（`深层|深板岩`），任一变体作为子串出现即算已译。
- 程序只产生候选，**对错由人/LLM 裁定**；`reason`/`comment` 不参与匹配。
- `qa-rules.tsv` 管「句子写得对不对」，例：
  `Deepslate(?: \S+){0,3} Ore` 须含「深层」；非矿石短语的 `Deepslate` 须含「深板岩」；
  `Wall \S+` 须含「墙上的」；`Exposed…Copper` 须含「斑驳的」；`Raw \S+` 须含「粗」；
  `Dead…Coral` 须含「失活」；`Suspicious \S+` 须含「可疑的」（`Suspicious Stew` 除外）。

**术语来源**（`Mod/模组简体中文翻译指南.tsv` 的 `Source` 列）既包含社区约定（`配方类型`、`概括`、`矿物`），
也包含模组官方中文；`模组材料…tsv` 明确标 `Official` 来源（`TermSorce = Tinkers' Construct` 等）。

**机器可读词典产物**（`CFPATools/i18n-dict`，20 star，description「基于CFPA汉化项目的英汉词典」）：

- 数据源是 CFPA 主仓库；每周五自动 release（实测最新 tag `模组词典-2026_07_10_11_54_43`）。
- `Dict.json` 条目结构：
  ```json5
  { "origin_name": "Cart", "trans_name": "车", "modid": "cazfps_the_dead_sea",
    "key": "block.cazfps_the_dead_sea.cart", "version": "1.18", "curseforge": "cazfps-the-dead-sea" }
  ```
  非传统语言文件的资源，`key` 写成 `目标路径#结构路径`，例
  `assets/mana-and-artifice/guide/zh_cn.json#Using  this Codex.sections[0].value`。
- `Dict-Mini.json` 是 `{"Cart":["车","马车","货车","推车","敞篷大车"]}` 这种原文→多译文的字典，
  供 `CFPATools/Minecraft-Mods-Translator` 使用。
- 该词典是 <https://dict.mcmod.cn/> 的数据源（该页实测页脚写「词典翻译数据由 CFPA 提供，
  基于 CC BY-NC-SA 4.0 协议，最后更新时间：2025-07-27」）。
- 脚本还会解析 `packer-policy.json`（`direct`/`indirect`/`composition`/`singleton`/`modifyOnly`）、
  `local-config.json` 的路径与 domain 规则、非根 `lang` 路径、`.local`/`.hl` 资源、
  JSON 嵌套结构、`.lang` 的 `#PARSE_ESCAPES`/续行/注释语义。

**衍生的「补差」词典**：`VM-Chinese-translate-group/i18n-Dict-Extender`（13 star）——
动机是「部分热门模组（如机械动力）的简中翻译由模组开发者在官方仓库直接维护，
而非通过 CFPA 社区协作」，导致 CFPA 词典收录不及时；做法是每周五从
`.github/config/source_mods.yml` 列的模组官方 GitHub 仓库拉最新 `en_us.json`/`zh_cn.json`，
与 `CFPATools/i18n-dict` 的 release 合并，产出 `Dict.json`/`Dict-Mini.json`/`Dict-Sqlite.db`/`diff.json`。
来源：<https://github.com/VM-Chinese-translate-group/i18n-Dict-Extender>

**反例说明**：在 CFPA 主仓库里**未找到**「Create 必须叫机械动力」式的强制译名文件。
对 `main` 分支 tree 做正则扫描（`glossar|dict|term|译名|词汇|vocab|blackkey|info.json`），
命中的只有：
- `config/blackkey.txt`（159,881 B，**不是译名表**，是「禁止翻译的原版 key 清单」，
  被 `src/Language.Core/Utils.cs` 的 `DeleteBlackKeys()` 读取；头部样本为
  `addServer.add`、`advMode.allEntities` 等）。
- `config/info.json`（309,602 B，CurseForge 项目元数据缓存：`name`/`downloadCount`/`latestFiles`/`id`）。
- 各种模组自带的 `dictionary_of_spirits`、`patchouli_books/.../info.json` 等内容文件。

---

## 2. 游戏内自动更新机制

CFPA 的自动更新模组三代同堂，加一个 VM 汉化组的衍生。核心思路一致：
**下载资源包 zip → 写进 `resourcepacks/` → 改 `options.txt` 的 `resourcePacks` → 强制切中文**。

### 2.1 `CFPAOrg/I18nUpdateMod3`（现行，未归档）

- 仓库：96 star，30 fork，Java，AGPL-3.0-only，作者 `xfl03`，`pushed_at` 2026-10-15。
- 支持：MC 1.6.1~1.21.11 与 26.1~26.1.2；Forge/NeoForge/Fabric/Quilt；Java 8~25。
  单个 jar 不做版本隔离。需要 Cloth Config API（1.12.2 除外，见 §2.4 的 VMTU 说明）。
- 依赖：`src/main/resources/i18nMetaData.json`（5567 B）是版本匹配表，含两段：
  - `games[]`：`gameVersions`（范围字符串）+ `packFormat`（或 `minFormat`/`maxFormat`）+ `convertFrom[]`。
    例 `{"gameVersions":"[1.20,1.20.1]","packFormat":15,"convertFrom":["1.20","1.19","1.18"]}`，
    末条 `{"gameVersions":"[26.1,26.3]","minFormat":76,"maxFormat":97,"convertFrom":["26.1","1.21","1.20"]}`。
  - `assets[]`：13 条，`targetVersion` + `loader` + `filename` + `md5Filename`，
    例 `{"targetVersion":"1.21","loader":"Forge","filename":"Minecraft-Mod-Language-Modpack-1-21.zip","md5Filename":"1.21.md5"}`。
- 入口 `I18nUpdateMod.init(minecraftPath, minecraftVersion, loader, mods)`：
  1. 读自身 `i18nMetaData.json` 拿版本；把自身命名空间从 mods 列表里剔掉。
  2. **网易我的世界检测**：若 `Class.forName("com.netease.mc.mod.network.common.Library")` 成功，
     打印警告（该行为违背网易「开发者内容审核制度」）并**直接 return，不下载任何东西**。
  3. 算本地缓存目录 `getLocalStoragePos()`：Windows 用 `%LocalAppData%`，macOS 用
     `~/Library/Application Support`，其余用 `$XDG_DATA_HOME` 或 `~/.local/share`；
     若存在旧目录 `~/.i18nupdatemod` 则退回 `user.home`。缓存根为 `<localStorage>/.i18nupdatemod`。
  4. `ResourcePackUpdater.update(...)` 得到 `convertedPack`。
  5. 若 `RuntimePackActivation.isEnabled()`（NeoForge 路径，因为 NeoForge 在其资源仓库填充后才应用选择）
     → `RuntimePackActivation.prepare(...)`；否则走
     `GameConfig(minecraftPath/options.txt).addResourcePack("Minecraft-Mod-Language-Modpack", ("file/" 前缀，1.13+) + 文件名)`。
- **下载源**（`build.gradle.kts` 按 variant 生成 `i18n-build.properties`）：
  | variant | `assetBaseUrl` | `bmclBaseUrl` |
  |---|---|---|
  | Release | `http://downloader1.meitangdehulu.com:22943/` | `https://bmclapi2.bangbang93.com/mirrors/i18n-update-mod/` |
  | Debug | `https://i18dl.imc.wiki/` | （空） |
  `ResourcePackHttp` 里 `bmclBaseUrl != null` 时并行度 = 64，否则 = 4；`open()` 先试 bmcl，
  命中非 2xx 才回落到 `assetBaseUrl`。
- **缓存与版本匹配**：缓存目录 `<cacheRoot>/<version>/mods/`，
  文件为 `<命名空间>.zip` + `<命名空间>.md5`（+ 内部算出的 `.zipmd5`）。
  增量判定（`UPDATE_TIME_GAP = 1 天`）：本地文件存在且 mtime 在 1 天内 → 直接跳过；
  否则拉远程 `<namespace>.md5` 比对，相同则跳过。
  图标单独处理：`ICON_UPDATE_TIME_GAP = 30 天`，路径 `<version>/pack.png`。
- **失效处理**（源码注释原文）：「NS 不存在、下载失败、MD5 不匹配、解压失败时跳过更新，
  **已有缓存仍参与组包**。其他错误回滚到旧流程。」
  `updateMod()` 内：远程 md5 必须匹配 `[0-9a-fA-F]{32}` 否则抛 `AssetFailure`；
  下载到临时 `.tar.lzma` 后校验 md5，再 `TranslationArchive.unpack` 解成 zip；
  最后原子 move 进缓存并写两个 md5 文件。`discardUnverifiedCache()` 会丢弃校验不过的缓存。
- **命名空间区分**（与打包器的 `namespace-discriminator.json` 对称）：
  `resolveNamespace(mod, identifier)` 按 `author` / `displayName` / 某文件 MD5
  得到 `<namespace>-CFPA-<值>`；`Manifest.json` 的 `rules` 提供映射，`blackList` 提供排除表。
  `download()` 里额外把 `minecraft` 从黑名单剔除（注释：「Minecraft's baseline fixes are not optional mod translations」）。
- **实测服务端**（经代理）：
  | URL | 结果 |
  |---|---|
  | `https://bmclapi2.bangbang93.com/mirrors/i18n-update-mod/1.21/Manifest.json` | 200，内容 `{"blackList":["create-sound-of-steam","replication"],"rules":{}}` |
  | 同上 `/1.20/Manifest.json` | 200，`{"blackList":["alexscaves","biomancy","cataclysm","create-sound-of-steam","hexcasting","occultism"],"rules":{}}` |
  | `http://downloader1.meitangdehulu.com:22943/1.21/Manifest.json` | **404** |
  | `https://bmclapi2.bangbang93.com/mirrors/i18n-update-mod/1.20/assets/jei.tar.lzma` | 200，2630 B |
  | `http://downloader1.meitangdehulu.com:22943/1.20/assets/jei.tar.lzma` | 200 |
  | 同上 `.../assets/jei.md5` | 200，`727E21E0B9AEDAD663FA3FC7EE138406` |
  | 同上 `.../assets/jei.zip.md5` | 404（说明 md5 路径是 `assets/<ns>.md5`，不带 `.zip`） |
  | 同上 `.../assets/{create,minecraft,tconstruct}.tar.lzma` | 200；`ae2` → 404（命名空间名不是 `ae2`） |
  | 同上 `.../1.20/pack.png` | 200，4472 B（与旧仓库 `assets/i18nmod/icon/pack.png` 同尺寸） |
  | `http://downloader1.meitangdehulu.com:22943/Minecraft-Mod-Language-Modpack-1-21.zip` | 200，`Content-Length: 3373288`，`Last-Modified: Tue, 29 Sep 2026 01:40:51 GMT`（与 GitHub `autobuild` 资产字节数一致） |

  **解包验证**：下载 `1.20/assets/jei.tar.lzma`（2630 B）→ `xz/lzma -dc` 得 tar（8468 B 成员）
  → 唯一成员 `lang/zh_cn.json`（8468 B，权限 777，mtime 归零 1970-01-01），内容为
  `{"jei.tooltip.config":"JEI配置", ...}`。即**按命名空间切分的小包，内部路径是相对资源包根的 `lang/...`**，
  与 `1.1` 里 `projects/.../<ns>/lang/zh_cn.json` 一一对应。

来源：<https://github.com/CFPAOrg/I18nUpdateMod3>（README、
`src/main/resources/i18nMetaData.json`、`src/main/java/i18nupdatemod/I18nUpdateMod.java`、
`core/GameConfig.java`、`core/net/ResourcePackHttp.java`、`core/v2/ResourcePackDownloader.java`、`build.gradle.kts`）

### 2.2 `CFPAOrg/I18nReborn`（已归档，2020-08-27 建，2020-08-31 最后推送，MIT）

**该仓库没有 README**（`https://raw.githubusercontent.com/CFPAOrg/I18nReborn/master/README.md` → 404）。
以下全部来自源码。它是一次**重构尝试**，同一份代码按 `fabric115` / `fabric116` / `forge115` / `forge116`
四个模块分别编译（有 `gradle.properties`、`gradlew`），比旧版多支持了 Fabric。

- **下载源**：硬编码在 `I18nrebornClient.URL` =
  `http://downloader1.meitangdehulu.com:22943/Minecraft-Mod-Language-Modpack-1-16.zip`
  （Forge 侧 `NI18nUpdateMod.URL` 同为 1.16 包，1.15 与 1.16 共用同一 URL）。
- **缓存**：`System.getProperty("user.home") + "/.i18n/" + <大版本>`，
  文件名固定 `Minecraft-Mod-Language-Modpack.zip`，同目录有 `update.txt` 存上次更新时间戳。
- **版本匹配**：`SharedConstants.getGameVersion().getName().replaceAll("(.+\\..+)\\..+","$1")`
  取大版本目录名；`Mixin` 按 `startsWith("1.15")` / `startsWith("1.16")` 反射加载对应的
  `I18nUpdateModPackFinder`。
- **失效/节流**：`update.txt` 存在且 `now - 上次 < 7 * 24*60*60` 毫秒则直接 return（**7 天节流**）。
  下载失败（`FileDownloadManager.catching`）只把「资源包更新失败。」塞进提示队列并置 `FAIL`，
  不删旧包；连接超时 10s；分块 64 字节读、`ByteArrayOutputStream` 全量入内存后才落盘
  （`readInputStream` 每次循环更新 `completePercentage`）。
- **启用方式**：
  - Fabric：`ResourcePackManagerMixin` 注入 `ResourcePackManager.<init>` 的 TAIL，
    往 `providers` 集合里加 `I18nUpdateModPackFinder`；后者在 `register()` 里
    `ResourcePackProfile.of("Minecraft-Mod-Language-Modpack", true, () -> new ZipResourcePack(file), factory, InsertionPosition.TOP)`
    —— **直接以 zip 文件构造资源包，插入位置 TOP**。
  - Forge：`NI18nUpdateMod` 构造器里按 MC 版本反射调用 `I18nUpdateModPackFinder.init()`，
    并在 `FMLClientSetupEvent` 里 `setCurrentLanguage(new Language("zh_cn","CN","简体中文",false))`。
  - 两边都在初始化时直接把 `gameSettings.language = "zh_cn"`。
  - 下载成功回调里调 `MinecraftClient.getInstance().reloadResources()` 热重载。
- `DownloadInfoHelper` 是一个 `ConcurrentLinkedQueue<String>` 提示队列；`DownloadStatus` 枚举
  `IDLE/DOWNLOADING/BACKGROUND/SUCCESS/FAIL/CANCELED`（`getStatus()` 会在 `done` 时把
  `DOWNLOADING|BACKGROUND` 归一为 `SUCCESS`）。

来源：<https://github.com/CFPAOrg/I18nReborn>（`fabric115/.../I18nrebornClient.java`、
`FileDownloadManager.java`、`mc115/I18nUpdateModPackFinder.java`、`mixin/ResourcePackManagerMixin.java`、
`mixin/MinecraftClientMixin.java`、`forge115/.../NI18nUpdateMod.java`）

### 2.3 `CFPAOrg/I18nUpdateMod`（1.12.2 时代，**已归档**，2021-01-22 归档）

README 首行即停止维护公告，指向 I18nReborn。

**关于「七牛云 + Travis」**——README 原文（**这是本报告里唯一能拿到的直接证据**）：

> - 启动时检查远程云端（使用七牛云）最新版资源包文件。资源包目前大小为 5M 左右，
>   下载速度能达到 1M/s，下载耗时只有四五秒；
> - 远程云端文件与 GitHub 对应汉化仓库绑定。通过 Travis 自动集成工具实现远程云端汉化资源包自动更新；

**取证限制（如实记录）**：
- 仓库内**没有** `.travis.yml`（`https://raw.githubusercontent.com/CFPAOrg/I18nUpdateMod/master/.travis.yml` → 404）；
  主仓库 `Minecraft-Mod-Language-Package` 的 `main` / `1-21-update` / `archived-1.12.2` 分支也都**没有**。
- `gh api search/code` 在 `CFPAOrg` 范围内搜 `qiniu` / `七牛` → 0 命中；
  搜 `travis` → 仅命中 `CFPAOrg/TransQualityControl/README.md`（那里是在**设想**把检查结果集成 travis）。
- 因此「Travis 具体怎么配、七牛具体哪个 bucket」**未取得**，只能确认 README 的这句自述。

**已能确认的实现细节**（源码）：

- 不是「下载 zip 再启用」，而是**用 JGit 做稀疏检出、在本地现场组装资源包**：
  `RepoUpdateManager.start()` → `repo.fetch(monitor)` → `repo.reset(monitor)` →
  `repo.sparseCheckout("assets/i18nmod/asset_map/asset_map.json")` →
  `AssetMap.instance().update(assetMap)` → `repo.sparseCheckout(repo.getSubPaths())` → `repo.close()`。
  即：先只取 `asset_map.json`（58,124 B，记录各模组 asset domain），据此算出**当前实例实际装了哪些模组**，
  再稀疏检出这些模组的路径。
- **远程源列表**（`I18nConfig.Download.remoteRepoURL`，按序尝试，且支持解析 HTML 302 重定向，
  因为 `git.dev.tencent.com` 之类会返回 `meta http-equiv="refresh"`）：
  ```java
  "https://git.dev.tencent.com/baka943/Minecraft-Mod-Language-Package.git",
  "https://git.cfpa.team/main.html",
  "https://github.com/CFPAOrg/Minecraft-Mod-Language-Package.git",
  "https://git.cfpa.team/fallback.html"
  ```
  说明当时走的是 **git 协议 + 自建 git 镜像 + 国内代码托管（腾讯 coding）**，而不是 zip 下载。
- **缓存/更新判定**（`ResourcePackBuilder.checkUpdate()`）：
  ① 目录或 `assets` 不存在 → 需要更新；② `pack.mcmeta` 的 mtime 超过
  `maxDay`（默认 3 天，可配 0~30 天）→ 需要更新；
  ③ **本地已装模组的 asset domain 目录缺失**（说明玩家加了新模组）→ 需要更新。
- **启用方式**：`ResourcePackInstaller.setResourcesRepository()` + 写 `options.txt`（源码里被注释掉了，
  注释写着 `下载后能够修改原版 option.txt 文件自动加载汉化资源包，同时将游戏语言设置为简体中文`）。
  另外有 `priority = true` 的配置项「优先加载资源包 / 是否将资源包设为最高优先级」。
- **下载与超时**：`maxTime`（默认 60 秒）超时后取消主线程阻塞、转为后台下载；
  `DownloadWindow` 弹进度条窗口。
- **强制中文**：`I18nUtils.setupLang()` 直接改 `gameSettings.language = "zh_cn"` 与
  `LanguageManager.currentLanguage`；`setupChinese` 可关。
- **国际化开关**：`internationalization.openI18n`（默认 false）开启后按 `System.getProperty("user.language") == "zh"`
  决定是否启用下载/公告/键位。
- **额外的产品化功能**（同一 jar）：
  - 公告：`noticeURL`（默认 `http://downloader.meitangdehulu.com/Notice.txt`，要求纯文本 UTF-8），
    首次进存档显示一次，可关。
  - 问题反馈：JEI 里对着物品按 `K`（可改）打开反馈界面（默认 `http://issues.cfpa.team`）。
  - 一键打开 Weblate 词条：对着物品按 `L`。
  - 游戏内上传翻译：`/lang_upload`，POST 到 `https://weblate.exz.me/api/translations/langpack/<modid>/zh_cn/file/`，
    带 `Authorization: Token <config/TOKEN.txt 里的 token>`。
  - `/lang_report`、`/lang_notice`、`/lang_reload` 等命令。
  - 本地仓库路径 `localRepoPath`：`Auto` 时 Windows 用 `%APPDATA%/I18nUpdateMod`，
    Linux/macOS 用 `~/.I18nUpdateMod`；路径非法会在加载期弹 `GuiErrorScreen`
    「本地仓库路径无效，请更改配置文件中的本地资源包仓库地址。」。

来源：<https://github.com/CFPAOrg/I18nUpdateMod>（README、`I18nConfig.java`、`I18nUtils.java`、
`download/RepoUpdateManager.java`、`resourcepack/ResourcePackBuilder.java`、
`git/ResourcePackRepository.java`、`command/CmdGetLangpack.java`、`command/CmdUpload.java`）

> 另注：`CmdGetLangpack` 里还存在一条**按单个模组**从 coding.net 拉 `zh_cn.lang`/`en_us.lang`
  拼一个临时资源包的路径：
  `https://coding.net/u/baka943/p/Minecraft-Mod-Language-Package/git/raw/1.12.2/project/assets/%s/lang/zh_cn.lang`
  （注意路径是 `project/` 单数，属早期结构）。

### 2.4 `VM-Chinese-translate-group` 的衍生实现（VMTU）

`VMTranslationUtilityMod`（VMTU，13 star）是一个**为整合包汉化补丁设计的自动化汉化管理工具**，
把 CFPA 的机制「产品化」了。README 明确写了血缘：

> 自动下载并激活资源包功能（`VMTULibraries-Resourcepack`）的代码源于 `i18nUpdateMod3` 模组代码修改，
> 按照上游协议规定使用 AGPL 协议。

`VMTULibraries` 三个子模块的 license 分开标注：
`common` LGPL v3、`modpack` LGPL v3、`resourcepack` **AGPL v3（I18nUpdateMod3 的 fork）**。

VMTU 相对 CFPA 版**多出来的能力**（`docs.vmct-cn.top/vmtu/`）：

- ✅ 自动检测汉化版本更新并在游戏内通知
- 📥 自动下载并激活汉化资源包（继承 I18nUpdateMod3）
- 🌐 自动切换游戏语言
- 📦 **指定整合包配置文件，支持为每个包指定自身汉化策略**
- 🚦 **指定资源包加载顺序**
- 🔍 **检测 I18nUpdateMod / Vault Patcher / Texture Locale Redirector 是否缺失**，
  缺失则弹提示页引导下载

前置：Cloth Config API（1.12.2 除外）；支持 Forge 1.12.2 / 1.16.5 / 1.18~1.20.4，
NeoForge 1.20~26.2，Fabric 1.16.5~26.2。文档基于 5.2.3 编写；
1.12.2 的配置是 `.cfg` 格式（其他版本是 `.toml`）；1.12.2 之后不再更新大版本（停在 5.x）。

**整合包识别机制**：读游戏根目录的 `modpackinfo.json`：

```json
{ "modpack": { "name": "FTB Skies 2", "version": "1.24.0",
  "translation": { "id": "skies-2", "url": "https://vmct-cn.top/modpacks/skies-2/",
                   "language": "zh_cn", "version": "1.24.0" } } }
```

`VMTULibraries/modpack` 还提供 `FTBMetadataImpl`、`MPUCMetadataImpl`、`SMUCMetadataImpl`、
`SUCMetadataImpl` 四种元数据读取实现（即识别 FTB / MultiMC-PolyMC / … 系启动器的实例元数据）。
来源：<https://github.com/VM-Chinese-translate-group/VMTranslationUtilityMod>、
<https://github.com/VM-Chinese-translate-group/VMTULibraries>、<https://docs.vmct-cn.top/vmtu/>

---

## 3. 整合包级（而非模组级）汉化是否存在先例

**存在。** 下面按「最像先例 → 当前主力 → 个人项目」排列，每条给出产物形态、安装步骤、覆盖范围。

### 3.1 `CFPAOrg/Modpack-GuideBook-i18n` —— 最贴合的整合包级先例（但已停更）

- 122 star，65 fork，default_branch `master`，**最后一次推送 2023-10-23**，无 release。
- 描述：「一个专为1.10.2/1.12.2主流整合包添加手册本地化以及其他本地化的仓库」。
- 官网 <https://modpack.cfpa.team/>（**只支持 http**，https 不通；实测 http 200，877 B，是个 Vue SPA）。
- README 开篇即声明风险与**动机**（原文）：

  > ## 请注意，一定要在替换之前备份游戏，否则可能会出现难以修复的问题
  > ## 1. 为什么要另开仓库？
  > 因为很多整合包手册的加载方式都是基于 `Config` 文件夹文件加载的，**无法通过资源包形式覆盖**，
  > 故另开仓库来放置整合包手册的本地化。
  > 这里还包括了很多其他类型的汉化，诸如 CraftTweaker 的文本提示，这些翻译极具时效性，
  > 如果整合包更新，那么意味着这些文件可能无法使用。

- **目录结构**：`project/<整合包名>/<整合包版本>/<原样覆盖到 MC 根目录的路径>`。
  实测覆盖的 35 个整合包（`project/` 下）：

  `Age of Engineering`、`All the Mods 3 Expert`、`Amnesia`、`Antimatter Chemistry`、`AstroBlock`、
  `Chemical Exchange`、`Compact Claustrophobia`、`Enigmatica 2 Expert`、`Exoria`、`FTB Continuum`、
  `FTB Interactions`、`FTB Presents SkyFactory 3`、`FTB Pyramid Reborn`、`FTB Sky Factory Challenges`、
  `Farming Valley`、`GT New Horizons`、`GT New Horizons (含魔改汉化)`、`Glacial Awakening`、`Greg Block`、
  `Invasion`、`Mass Production`、`Material Energy^5- Entity`、`Modern Skyblock 3`、`Nomifactory`、
  `Omnifactory`、`Primal Skies`、`Project Equivalence`、`Roguelike Adventures and Dungeons`、
  `SevTech Ages`、`SkyFactory 4`、`Space Astronomy 2`、`Stone Block`、`Stone Block 2`、
  `TerraFirmaCraft Reloaded`、`Volcano Block`。

  **共 127 个「整合包版本」条目**（`data.json` 里 `contents` 之和）。
  有版本的整合包平均 3~6 个版本（如 `SkyFactory 4` 有 `4.0.2/4.0.3/4.0.4/4.0.5/4.0.8/4.1.0`…，
  `SevTech Ages` 有 `3.0.6`~`3.2.1`）；也有 `latest`、`config`、`scripts` 这类非版本号目录。
- **覆盖的内容**（实测 tree 抽样）：
  - FTB Quests 任务书：`project/FTB Interactions/1.7.0/config/ftbquests/normal/chapters/<chapterId>/<questId>.nbt`
    （**1.12.2 时代是 NBT 二进制**，不是 snbt；`FTB Interactions/1.7.0` 下光这一个章节目录就有几十个 `.nbt`）。
  - FTB Guides 手册：`project/Roguelike Adventures and Dungeons/1.39/config/ftbguides/modpack_guide/**/README.md`。
  - CustomMainMenu：`project/FTB Interactions/1.7.0/config/CustomMainMenu/mainmenu.json`（8973 B）。
  - 简单成就：`config/SimpleAchievements/achievementList.txt`、`config/prestige/rewards.json`、
    `SevTech Ages/**/config/triumph/**.txt`（见 `config.yml` 的 `file_rgx`）。
  - 纯 `config/` 与 `scripts/` 目录也有（`Antimatter Chemistry` 下就是 `config` + `scripts`）。
- **产物形态**：**每个「整合包 × 版本」两个 zip**，Windows / Linux 各一个，因为要转编码。
  `main.py` 逻辑：
  1. 把 `./project` 递归 copy 成两份临时目录；
  2. 其中 Linux 那份按 `config.yml` 的 `file_rgx` 正则**把 GBK 文件转成 UTF-8**（`change_coding()`）；
  3. `clear_timestamp()` 把全部文件 mtime 归零（配 `zip -X -t 1970-01-01` 保证 md5 稳定）；
  4. `zip -X -t 1970-01-01 -r -9 -q` 打包成
     `<整合包名>-<版本>-windows.zip` / `-linux.zip`；
  5. 算 md5 + sha1，与上次的 `data.json` 比对；**md5 相同就复用旧条目，不同才上传腾讯云 COS**
     （`Bucket='modpack-1257209710'`，`Region='ap-guangzhou'`）；
  6. 用 `git log --pretty=format:"%an"` 收集该目录的作者列表、用最后一次 commit 时间当 `time`；
  7. 输出 `data.json` 供前端页面读取。
  `config.yml`（2019-03-30）：
  ```yaml
  file_rgx:
   - "config/SimpleAchievements/achievementList\\.txt"
   - "SevTech Ages/.*?config/triumph/.*?\\.txt"
   - "config/prestige/rewards\\.json"
  data_json_path: "./data.json"
  ```
  CI 是 `.github/workflows/Coding CI Webhook.yml`（仓库里 `page` 是一个指向
  `CFPAOrg/Modpack-Download-Page` 的 **git submodule**）。
- **实测下载页数据**（`http://modpack.cfpa.team/static/data.json`，87967 B，35 条）：
  每条形如
  ```json5
  { "name": "Amnesia",
    "contents": [{ "author": ["HinsonDongGua","TartaricAcid"], "version": "1.0.4",
      "windows": { "url": "https://modpack-1257209710.cos.ap-guangzhou.myqcloud.com/Amnesia-1.0.4-windows.zip",
                   "md5": "b48d89cf89736d932184af30802c47e2", "sha1": "dc80e127..." },
      "linux": { ... }, "time": 1582792063 }] }
  ```
  时间范围：**最早 2019-02-26，最晚 2022-06-11**（FTB Interactions 2.12.1）→ 2022 年后基本停更。
- **安装步骤**（README 原文）：「为什么不先访问神奇的网站呢？<https://modpack.cfpa.team/>」；
  即**下载 zip → 覆盖解压到 MC 目录**。
  附带一个已知故障与修复：
  > 如果你在覆盖了汉化以后进入游戏后，发现 SimpleAchievements 的手册上没有任何文字了，
  > 请使用 `/flushAchievements` 指令（单机需要开启作弊模式才可用，服务器需要 OP 权限）重载手册。
- **实测解包验证**：下载 `Amnesia-1.0.4-windows.zip`（49775 B，200 OK），67 个条目，
  内容为 `config/triumph/script/challenges/challenges/*.txt`（Nether.txt、Brains.txt、…），
  即**覆盖式 config 补丁**，不含任何 `assets/`。
- README 也写了翻译这类东西的坑（原文）：
  > 手册以及其他说明的翻译非常的恶心，作者们标准不一，翻译的位置也不一样，甚至连编码都不能统一。
  > 如果你想要翻译，一定要注意整合版本，其次要确认编码有没有出错，结构位置是否正确。
- 协议：CC-BY-NC-SA（与汉化资源包一致）。

来源：<https://github.com/CFPAOrg/Modpack-GuideBook-i18n>、
<http://modpack.cfpa.team/>、<http://modpack.cfpa.team/static/data.json>、仓库 `main.py` / `config.yml` / README

### 3.2 `VM-Chinese-translate-group` —— 当前整合包级汉化的主力

组织信息（`gh api orgs/VM-Chinese-translate-group`）：
名称 `VM Chinese Translation Group`，成立 **2022-11-19**，location `China`，blog <https://vmct-cn.top/>，
**73 个公开仓库**。组织自述：

> VM汉化组是一个用爱发电专注于汉化MC整合包与地图的非营利组织。我们制作的汉化及相关技术最终目的是使公众收益，
> 汉化组将寻求高质量永久免费汉化包以造福玩家。汉化组的成立不是为了任何人的私人利益。
> 汉化组产生的所有收益将"不可撤销的"用于上述目的

**官网整合包清单**（<https://vmct-cn.top/modpacks/>，SPA，数据在前端 bundle
`/assets/index-C3BIZ3Hk.js`，663288 B）。实测解析出 **58 个条目**（+1 表头 = 59 行），
统计（按 `status` / `loader` / `mc`）：

| 状态 | 数量 |
|---|---|
| `stopped`（停止维护） | 38 |
| `maintaining`（维护中） | 13 |
| `translating`（翻译中） | 7 |

| 加载器 | 数量 |
|---|---|
| forge | 42 |
| neoforge | 13 |
| fabric | 3 |

| MC 版本 | 数量 |
|---|---|
| 1.20.1 | 12 |
| 1.21.1 | 12 |
| 1.18.2 | 11 |
| 1.19.2 | 9 |
| 1.16.5 | 6 |
| 1.12.2 | 5 |
| 1.16.5+1.18.2 | 1 |
| 1.19.4 / 1.20.4 | 各 1 |

条目字段形如（原文）：`{name, originalName, icon, image, author, description, featured, link,
date, displayDate, status:{type}, versions:{loader, mc, pack}}`。抽样：

| 中文名 | 原名 | 状态 | loader | mc | pack |
|---|---|---|---|---|---|
| 吸血鬼的反击 | Vampires Strike Back | maintaining | forge | 1.20.1 | 1.8.1 |
| 亡者世界 | DeceasedCraft | maintaining | forge | 1.20.1 | 5.11.19 |
| 宝藏猎人3 | Vault Hunters 3rd Edition | maintaining | forge | 1.18.2 | 3.21.7 |
| 机械动力：星辰 | Create: Astral | maintaining | — | 1.18.2 | 2.1.4c |
| 永恒的MC | MC Eternal | stopped | forge | 1.12.2 | 1.6.1 |
| Craftoria | Craftoria | translating | neoforge | 1.21.1 | 1.37.0 |
| 永恒的MC 2 | MC Eternal 2 | translating | forge | 1.20.1 | 1.2.2.1 |

**官网统一的安装说明文案**（bundle 原文，出现 20+ 次）：
> 你可以先在 CurseForge 或启动器内下载整合包，然后下载汉化补丁，最后将补丁**解压并覆盖相应文件**，即可完成汉化。

**官方安装文档**（<https://docs.vmct-cn.top/tutorial/modpack/translation.html>）写明两种形态：

1. **覆盖文件式**（「本方法适用于**所有**汉化补丁」）：
   下载 zip → 右键「解压到当前文件夹」→ 打开整合包文件夹（给出 HMCL / PCL2 系 / PrismLauncher 三套截图指引）
   → 进解压出的文件夹 → `Ctrl+A` 全选 → 拖到整合包文件夹 → 弹「替换或跳过文件」时选「替换目标中的文件」→ 启动。
   若仍是英文，「请在选项-语言中切换语言为简体中文」。
   **明确写了服务端也要装**：「如果你是服主，请同时在服务端和玩家的客户端都加入汉化补丁，否则无法进入游戏！」
2. **exe 安装程序式**（「仅适用于春晓之巫、宝藏猎人3、喷气背包猫」，仅 Windows）：
   双击 exe → 选整合包文件夹 → 一路下一步。会校验版本：「检测到版本文件内容不对应。
   如果跨版本使用汉化包，请确认VM汉化组公告，保证此汉化包兼容当前版本整合包。点击以继续安装。」

**单仓库的产物结构**（实测多个仓库 tree）：

| 仓库 | 结构 |
|---|---|
| `dawncraft-Chinese-patch-Pack`（24 star，已停维，README 标注「汉化支持整合包版本 2.0.9f3，不支持最新版」） | `zh-CN/` 下：`global_packs/required_data`(773) + `global_packs/required_resources`(373) + `config/ftbquests`(20) + `config/vaultpatcher_asm`(3) + `config/vmtranslationupdate.toml` + `options.txt` + `optionsof.txt` + `本汉化补丁适配版本2.0.15` |
| `FTB-Skies-2-Chinese`（6 star） | `CNPack/`（成品）+ `Source/`（英文原文）双目录：`CNPack/kubejs/assets`(227) + `Source/config/ftbquests`(122) + `Source/kubejs/assets`(46) + `CNPack/config/ftbquests`(39) + `CNPack/datapacks/ftb`(23) + `CNPack/ftbteambases/pregen`(21)；`CNPack/modpackinfo.json` |
| `Craftoria-Chinese` | `CNPack/kubejs/assets`(55) + `Source/config/ftbquests`(54) + `Source/kubejs/assets`(43) + `CNPack/config/ftbquests`(13) + `CNPack/config/fancymenu`(10) |
| `FTB-Oceanblock-2-Chinese`（12 star） | `CNPack/kubejs/assets`(180) + `Source/kubejs/assets`(113) + `Source/config/ftbquests`(53) + `CNPack/config/ftbquests`(4) |
| `MC-Eternal` / `Vault-Hunters-1.18.2` / `SkyFactory-5-Chinese` / … | 语言是 ZenScript（`.zs`），即 CraftTweaker 魔改文本 |

**FTB Quests 的具体产物**（`FTB-Skies-2-Chinese` 实测）：
- `Source/config/ftbquests/quests/lang/en_us.snbt` = 873,082 B（英文原文，**单一大文件**）
- `CNPack/config/ftbquests/quests/lang/zh_cn.snbt` = 951,638 B（中文成品，**单一大文件**）
- 同时还有按章节切分的 `CNPack/config/ftbquests/quests/chapters/*.snbt`（35 个，单文件 2.4KB~137KB）
- 即 VM 用的是**「单文件 lang + 章节文件并存」**的高版本 FTBQ 结构。

**自动化与工具链**：

- `Template-Repo`（项目模板）说明了标准工作流：Paratranz 作为翻译平台，两条 GitHub Actions：
  **Paratranz → GitHub**（每天北京时间早晚 10 点左右自动跑，拉译文到仓库）与
  **GitHub → Paratranz**（推原文）；译文有变动就自动发**预发布 Release**；
  每次同步上游后跑一次 **FTB 任务颜色字符检查**，有错就在 Release 说明里提示并上传 HTML 报告到 Artifacts 与 Release。
  需要 secrets：`API_KEY`（Paratranz token）、`CF_API_KEY`（CurseForge API key，用于检查上游整合包更新）；
  env：`ID`（Paratranz 项目 ID）。**主分支必须叫 `main`**。
- `translate-tools`（12 star）三个工具：
  ① **FTB 任务颜色字符合法检查**——查 `&` 后面数字/字母丢失（「这会导致任务无法正常显示」），
     支持单文件/整目录、导出 HTML、暗色模式。错误示例原文：
     ```
     文件: ...\CNPack\kubejs\assets\integrateddynamics\lang\zh_cn.json
     键: info_book.integrateddynamics.tutorials.theValueOfOperators.text4
     值: &2运算符&0有很多其他的操作，例如&谓词&r合取，翻转&2运算符&0参数，以及关于&7列表&0的更多操作……
     错误: '&'后包含非法字符 '谓'
     ```
  ② **Paratranz 译文同步工具**（批量上传/下载，需要 project id + token）。
  ③ **snbt/json 互转工具**——「用于将 FTB 任务在 mc1.21+ 新加入的 snbt 语言文件与 json 格式互转，
     便于导入翻译平台进行翻译」。
- `FTBQuestLangSpliter`（1 star，Python，依赖 `snbtlib`）：把巨大的 `en_us.snbt`
  **按章节拆成多个 JSON**（`en_us_chapter1.json` 等，条目按「章节 → 任务 → 子任务 → 奖励」排序，
  `chapter_group`/`reward_table` 单独拆出），翻完再**合并回 SNBT**（自动处理多行文本转义与列表重建）。
  动机原文：「传统的翻译流程需要直接编辑一个巨大且复杂的 `en_us.snbt` 文件，这很容易出错且难以管理。」
- 每个仓库还有 `.github/configs/modpack.json`（声明 `packId`/`packName`/`updateMethod`/`infoFilePath`/
  `sourceDir`/`paratranz`/`attentionList`/`exclusionPatterns`）与 `replace_rule.json`
  （字面替换表，例 `{"New items available in the Shop!":"商店中出现了新的物品！"}`）；
  `FTB-Skies-2-Chinese` 的 `exclusionPatterns` 是 `["**/lang/*.*", "!**/lang/en_us.*", ...]`。
- `VMTranslationUtilityMod`（VMTU）作为**客户端侧的整合包识别 + 资源包自动激活**组件（见 §2.4）。
- `VMTULibraries` 的 `resourcepack` 模块是 I18nUpdateMod3 的 fork。

**产物发布**（实测 releases）：

| 仓库 | 最新 tag | 资产 |
|---|---|---|
| `dawncraft-Chinese-patch-Pack` | `2.0.5`（2024-04-05） | `DawnCraft-2.0.5-beta-VM-CN.zip` 855,344 B |
| `FTB-Oceanblock-2-Chinese` | `test-20260809-134621`（2026-08-09） | `VM-CNPack-20260809-134621.zip` 697,156 B（CI 自动打的**测试版构建**，tag 带时间戳） |
| `Vault-Hunters-1.18.2` | `2.5.1`（2023-11-23） | `vh3rd-3.12.4-VM.-V2.5.1.zip` 24,118,347 B；更早的 `Vault-Hunters-3rd-3.11.1-VM-V2.3.1.zip` 86,041,192 B |

**`Vault-Hunters-1.18.2` 的安装说明**（`【必看】覆盖版使用说明.txt`，GBK 编码，原文要点）：
- 「本压缩包为覆盖版汉化包，提供给无法使用 exe 文件，并对 MC 文件结构有一定了解的玩家使用。
  若没有把握正确安装，请使用安装程序（exe 文件）。」
- 「请在使用前再次确认整合包版本与汉化包版本对应。」
- 步骤 1：「打开压缩包，**选择安装组件**，打开对应文件夹，将其中的内容解压到整合包根目录。
  注意注意！！！一定是文件夹里的内容（config、mods、resoursepacks 等文件夹）！
  一定是解压到整合包根目录！**出现是否覆盖的提示才是正确的安装！**」
- 步骤 2：客户端**需额外安装** `I18nUpdateMod`（自动汉化更新）、`VaultPatcher`（硬编码汉化模组）等。
- 步骤 3：「如果此前已安装汉化包，请删除根目录下的 `vaultpatcher` 文件夹。」
- 服务端：第一步与客户端相同，**安装组件必须与客户端保持一致**；额外装 `VaultPatcher`，无需其他模组；
  同样要删旧 `vaultpatcher` 文件夹。「注：必须保证客户端与服务端使用的汉化组件相同！」
- 安装组件解析（原文）：
  - `基础+硬编码汉化`：主要汉化 + 硬编码汉化文件 **[双端必装]**
  - `游戏体验增强`：额外内容 **[双端选装]**
  - `辅助配置`：自动初始化最低配置并启用 Jade **[客户端选装]**
  - `支持阿鹉谢谢喵`：简易标题修改，适配 PCL **[PCL客户端选装]**
- 「注意：VaultPatcher 模组需要使用 1.4.4+3 版本。」
- 注：主作者要求 Innosetup 打包文件 `bzlr.iss` 不上传 GitHub。

**`dawncraft-Chinese-patch-Pack` README 顶部**（原文）：
> [!IMPORTANT]
> 必须下载 Vault Patcher（VP）模组才能完整汉化！
> **汉化支持整合包版本 2.0.9f3，不支持最新版！**

且「本整合包汉化已获得作者授权。本汉化补丁不违反任何社区规则。」并附授权截图。

来源：<https://github.com/orgs/VM-Chinese-translate-group/repositories>、
<https://vmct-cn.top/modpacks/>、<https://docs.vmct-cn.top/tutorial/modpack/translation.html>、
<https://docs.vmct-cn.top/rule/common.html>、各仓库 README/tree/releases

### 3.3 其他整合包级项目（个人 / 小团队）

| 项目 | star | 形态 | 说明 |
|---|---|---|---|
| `Kiwi233/Translation-of-GTNH` | **492** | `7z` 覆盖包 + **每日构建** | 见下方详述 |
| `chiba233/atm10-zh-cn`（「绿油油版」） | **329** | 资源包式，**按整合包版本一个专属包**，client/server 分开 | ATM10，MC 1.21.1；同时支持 7.0~8.2；README 称「语言文件 18.4 万余条、任务书、19 本模组手册、467 种蜂、799 条结构名、201 张图片艺术字都在里面，是完整的一份，不是叠加在别家之上的补充包」；**「不需要先装 BBSMC 或任何其他汉化当前置——同时装两份会互相覆盖」**；安装=解压后把 `atm10-zh_cn-client` 整个文件夹拖进实例目录；警告「别把客户端包丢到服务器上，会让所有玩家进服时刷 `error creating crop with id null`」 |
| `chiba233/ProductiveBees_zh-cn` | 9 | **单个 jar 放进 `mods/`** | 「不需要资源包，也不需要改配置」；开服时 1.21/1.21.1 服务端也要放一份（否则蜂笼里蜂名是英文）；README 表格称覆盖 MC 1.15.2–1.21.1 共 20 个平台，词条与导览书 100% |
| `zero6six/nomi-ceu-zh_cn` | 16 | 资源包 + 硬编码修复脚本 | 基于 Nomi-CEu 官方语言包（LGPL-3.0）修改；结构含 `converter`（任务书语言文件 ↔ ParaTranz json）、`scripts/Zero6sixFix.zs`（硬编码文本修复，置于 `.minecraft/scripts`）、`packer.py`；食用方法=把本汉化包 + CFPA 资源包一起放进 `resourcepacks` 并加载 |
| `blibilijojo/Modpack-Localizer` | 12 | **桌面工具**（Windows exe） | 「整合包汉化工作台」；项目类型 `mod`/`modsearch`/`quest`/`github`；`quest` 模式自动探测 `config/ftbquests/quests/**/*.snbt` 与 `config/betterquesting/DefaultQuests.json`；译文优先级：原文复制 → 模组自带中文 → 个人词典 → 第三方汉化包 → 社区词典；输出资源包（目录或 zip） |
| `ycccpu/minecraft-localizer` | 0 | 工具 | 「整合包汉化补丁生成器，支持 CFPA 资源复用与 OpenAI 兼容 API」；扫描目录及 JAR/ZIP 内 `en_us.json`/`en_us.lang`，支持 FTB Quests/SNBT、KubeJS、FancyMenu、配置注释、存档 `serverconfig`；输出**实例覆盖目录** |
| `xiaofeizi-ch/BetterMC-ftbquests-CN` | 0 | 补丁仓库 | 描述即「Minecraft BetterMC整合包任务书汉化补丁」，default_branch 直接叫 `汉化补丁合集` |
| `doctormdkzrp/RAD3_Chinese_Localization` | 0 | 非官方资源包 | R.A.D.3；README 自称「使用AI翻译，因此可能有一些专用术语并不准确」「夹杂了很多私货修改」；内置 DeepSeek 批量翻译脚本 |
| `XDawned/minecraft-quests-en-zh` | 12 | 数据集 | 「提取已汉化整合包任务文件生成数据集，并基于其对 transformer 预训练翻译模型进行微调」 |
| `Annijang/Annijang-Modpack` | 15 | 网盘替代 | 用 GitHub 存汉化（「因为有人以"色情"为由举报了我在微云里的文件」） |

**`Kiwi233/Translation-of-GTNH` 详述**（492 star，61 fork，`pushed_at` 2026-10-16，homepage 指向
<https://paratranz.cn/projects/4964>）——这是 star 数最高的整合包汉化仓库，也是**自动化程度最高**的一个：

- 覆盖内容：`GregTech.lang`（3,941,689 B）、`GregTech_US.lang`（603,413 B）、
  `zh_CN_GT5.09.32pre6.lang`（1,103,679 B）、`GTNH介绍.txt`、`config/`（含 `config/txloader` 64 项）、
  `resources/<模组名>[<modid>]/lang/zh_CN.lang`（**每个模组一个目录**，如
  `resources/Applied Energistics 2[appliedenergistics2]/lang/zh_CN.lang` 55,550 B）。
- 与 CFPA 的关键差异：**它同时汉化「魔改」部分**。README 原文：
  > 不包含魔改汉化即只有语言文件汉化以及任务书汉化
  > 包含魔改汉化即许多通过 script 文件重写的物品名称、添加的 tooltip 以及大量的魔导手册内容均汉化。
  > 之所以区分是由于使用本汉化包时，需要覆盖本地文件，而包含魔改汉化需要覆盖本地 script 文件（即 MT 魔改文件）。
  > 如果你自己对整合包进行过魔改，请慎重考虑是否选择包含魔改汉化。
  > 最后，本汉化包均通过本地覆盖完成汉化，语言文件部分不论服务器还是单机都可正常汉化，
  > **但任务书和魔改部分，如果在服务器使用需将此汉化包用于服务端方可生效。**
- 产物：`nightly-YYYY-MM-DD.7z`（约 1.96 MB），**每天北京时间凌晨 2 点（cron `0 18 * * *` UTC）自动构建**，
  发到 tag `0-nightly-build/<日期>` 的 release。
- 工作流文件直接以步骤编号命名，说明其流水线：
  `1-quest-book-to-paratranz.yml`、`2a-lang-and-zs-to-paratranz-url.yml`、
  `2b-lang-and-zs-to-paratranz-artifact.yml`、`3-gt-lang-to-paratranz.yml`、
  `4-export-from-paratranz.yml`、`nightly-build.yml`、`release.yml`、`purge-workflows.yml`。
  `nightly-build.yml` 里依次跑 `bun run src/index.ts from-paratranz:quest-book`、
  `from-paratranz:lang-zs`、`from-paratranz:gt-lang`，再 `release.ts` 打包。
  `release.yml` 触发条件是打 tag，会额外注入 `NEC_URL`/`NEC_NAME`
  （`NotEnoughCharacters-1.6.1.jar`，即中日文字符支持补丁）。
- README 里逐条记录了**版本相关的坑与修复动作**（对「失败模式」极有价值，原文）：
  - 「2.0.6.2 及以后版本在 config 文件夹内添加了带 us 后缀的 json 文件，请删除此文件，否则会造成任务书汉化失败」
  - 「2.3.1 及以后版本，任务书结构再次大改，config 中的相应 json 文件不再影响汉化，无需再执行删除操作」
  - 「2.7.2 和 2.7.3 版本需要删除自带的汉化文件，否则可能会有过时汉化残留。具体做法为删除
    `.minecraft/config/txloader` 中的 `forceload` 文件夹中 `____gtnhoverridenames` 和
    `betterloadingscreen` 以外的所有文件夹」
  - 「PS：有时任务书无法正确汉化，可以尝试重载任务书，方法有两种：1、输入指令 `/bq_admin default load`；
    2、寻找一个名为 `默认加载方块` 的命令方块，右键即可」
- 致谢里点名了工具作者：`MuXiu1997`（版本更新自动化比对脚本、PT 推送脚本、自动化打包脚本、
  自动化每日构建脚本）、`Wired`（语言文件提取脚本）、`BloCamLimb`（任务书 config 生成脚本）、
  `albus12138`（GT++ 手册汉化工具）。

来源：<https://github.com/Kiwi233/Translation-of-GTNH>（README、tree、workflows、releases）

### 3.4 中文平台在其中扮演的角色

**MC 百科（mcmod.cn）**：
- 有「整合包」分区，也有「词典」页（<https://dict.mcmod.cn/>），该页实测页脚：
  「词典翻译数据由 CFPA 提供，基于 CC BY-NC-SA 4.0 协议，最后更新时间：2025-07-27」。
- **站方明确不接收翻译内容**。实测 `bbs.mcmod.cn/thread-16859-1-1.html`（2023-12-17，
  标题「整合包汉化补丁信息有关问题」，楼主问「在整合包资料内添加汉化资源地址的有关规范是什么」），
  版主「妖刀桑」回复原文：
  > 百科不接收翻译相关的提交，你可以提交给其他组织；想分享的*合法合规的*链接可以直接发在短评区。
  楼主回：「是这样啊，知道了，感谢解答。」
  2024-12-03 另一用户追问「求问给整合包添加汉化补丁信息的方法」→ **无人回答**。
- 站内搜索「整合包汉化」实测 7 条结果：2 条教程（`www.mcmod.cn/post/4108.html`、`post/5167.html`）、
  5 条社群帖（含上述 16859、`bbs.mcmod.cn/thread-23532-1-1.html`「带词典缓存加速和界面的整合包模组汉化工具发布」、
  `thread-21061-1-1.html`「BOMD祸乱鬼魅非官方版-V1.5.1个人汉化」等）。
  **结论：MC 百科不是整合包汉化的发布渠道，只是讨论与索引场所。**

**苦力怕论坛（klpbbs.com）**：
- 站内搜索是 Discuz + xunsearch。实测搜「汉化补丁」约 **40 条**结果、
  搜「整合包汉化」约 **40 条**结果，命中主要是：
  - 基岩版（BE）附加包/材质/地图的汉化补丁（占多数）；
  - 「悬赏问答」区的求汉化帖（「求1.18+汉化，整合包」「需1.20汉化幸运方块整合包」
    「哪位大佬可以帮忙汉化一个整合包」）；
  - 少量整合包发布帖，如「【1.21】［恐怖］［汉化］［整合包］来自迷雾整合包汉化」（2025-11-08，
    网盘 `pan.quark.cn`）、「【26.x/整合包】内容全汉化！基岩版最新整合包蛾之挽歌Beta版发布，附带任务书（未完成）」
    （2026-04-10）。
- **未取得**：一个可点名的、系统性的「苦力怕论坛整合包汉化」项目或组织。站内不存在类似 CFPA/VM 的
  版本化仓库 + 发布流水线；分发方式是**发帖 + 网盘链接**。此外 `search.php?mod=forum&srchtxt=整合包汉化&formhash=0&searchsubmit=yes`
  这种带 `formhash` 的 URL 返回 **HTTP 500**，只有去掉 `formhash`/`searchsubmit` 的 URL 才返回 200，
  说明搜索接口对参数敏感（可复现的取证限制，非编造）。

**ParaTranz（paratranz.cn）**：中文社区事实上的翻译协作平台。
实测 `https://paratranz.cn/projects/4964` 返回 200 但是 SPA 空壳（11401 B，无内容）。
被以下项目用作翻译后台：`Kiwi233/Translation-of-GTNH`（homepage 即该项目页）、
VM 汉化组的 `Template-Repo` 全部流程、`create_astral_translation_zhcn`
（<https://paratranz.cn/projects/11990>）、`CKRainbow/PoPLocalization` 等。

**Bilibili / QQ 群**：CFPA 的「公示规则」把 Bilibili、QQ 群、MC 百科社群并列为公示渠道；
VM 汉化组把 QQ 交流群写在安装教程里。CFPA 官方 QQ 群 630943368。

---

## 4. 分发形态对比

| # | 玩家拿到什么 | 怎么装 | 覆盖范围 | 代表实现 | 失败模式（装错会怎样） |
|---|---|---|---|---|---|
| **A** | **资源包 zip**（`Minecraft-Mod-Language-Modpack-<v>.zip`，1.21 实测 3.37 MB） | ① 手动丢进 `resourcepacks/` 并启用；② 或装 `I18nUpdateMod3` 由模组自动下载 + 自动写 `options.txt` | 只有 `assets/` 下的语言/手册/纹理；**`config/`、`scripts/`、`kubejs/` 一律覆盖不到** | CFPA `Minecraft-Mod-Language-Package` + `I18nUpdateMod3` | 版本不匹配 → 只显示英文（1.13 起语言文件改 json，1.12.2 包不能用于 1.13+，「反之同理」）；被 `blackList` 排除的命名空间不生效 |
| **B** | **按命名空间切分的资源包小包**（`<ns>.tar.lzma`，实测 `jei` 2630 B → `lang/zh_cn.json` 8468 B）+ 根级 `Manifest.json` | 由 `I18nUpdateMod3` 自动下载；**玩家不手工装** | 同上，但可**按实际安装的模组增量下载**、可被 `Manifest.blackList` 服务端下发排除 | `I18nUpdateMod3` v2 流程 + `bmclapi2.bangbang93.com/mirrors/i18n-update-mod/` | md5 不匹配/解压失败/NS 不存在 → **跳过该模组更新，已有缓存仍参与组包**（源码注释原文）；全流程失败 → 回滚到旧流程；缓存目录被清 → 下次全量重下 |
| **C** | **覆盖 config 的补丁包**（每个「整合包 × 版本」两个 zip：windows / linux） | 下载 zip → **解压覆盖到 MC 根目录**（README 要求先备份游戏） | `config/ftbquests/**`（含 1.12.2 的 `.nbt`）、`config/ftbguides/**`、`config/CustomMainMenu/`、`config/SimpleAchievements/`、`config/triumph/`、`config/prestige/`、`scripts/` | CFPA `Modpack-GuideBook-i18n`（35 包 / 127 版本，2019-02~2022-06） | ① 覆盖后 SimpleAchievements 手册空白 → 需 `/flushAchievements`（单机需开作弊，服务器需 OP）；② 编码不统一：原文件可能是 GBK，打包脚本要转 UTF-8，玩家若混用 windows/linux 包会乱码；③ 整合包一更新，这些覆盖文件「可能无法使用」（README 原话） |
| **D** | **覆盖式补丁包，且分「安装组件」** | 解压 → **选组件** → 把**组件文件夹里的内容**解压到**整合包根目录** → 必须出现「是否覆盖」提示才算对 → 再手工往 `mods/` 放 `VaultPatcher` / `I18nUpdateMod` | `config/`、`kubejs/`、`mods/`、`resourcepacks/`、`ftbteambases/pregen/`、`global_packs/`、`config/vaultpatcher_asm/`、`options.txt` | VM 汉化组（`dawncraft-Chinese-patch-Pack`、`Vault-Hunters-1.18.2`、`FTB-Skies-2-Chinese`…） | ① **跨版本用**：VM 的 exe 会弹「检测到版本文件内容不对应…点击以继续安装」，覆盖版则直接坏；② **双端组件不一致 → 无法进入游戏**（文档加粗原文）；③ 未删旧 `vaultpatcher` 文件夹 → 残留旧汉化；④ **客户端包误装到服务器** → ATM10 的案例是所有玩家进服刷 `error creating crop with id null`；⑤ 与别家汉化**同时装两份会互相覆盖**（ATM10 README 明写） |
| **E** | **重打包/覆盖整包 + 每日构建**（`nightly-YYYY-MM-DD.7z`，约 1.96 MB） | 下载 release 里对应版本 → 覆盖解压到 MC 目录 | 语言文件 + 任务书 + **魔改（script 重写的物品名、tooltip、手册）** | `Kiwi233/Translation-of-GTNH`（492 star） | ① 「不包含魔改汉化」与「包含魔改汉化」是**两个包**，选错则物品名/tooltip 不汉化，或反过来覆盖掉玩家自己的魔改；② 版本演进时上游新增的 `-us` 后缀 json 会导致任务书汉化失败，需手工删除；③ 上游自带汉化会造成「过时汉化残留」，需删 `config/txloader/forceload` 下除 `____gtnhoverridenames`、`betterloadingscreen` 外的所有文件夹；④ 任务书没生效 → 需 `/bq_admin default load` 或右键 `默认加载方块` 命令方块；⑤ 服务器端不装 → 任务书与魔改不生效 |
| **F** | **游戏内模组自动更新**（玩家只放一个 jar） | 把 jar 丢进 `mods/`；模组启动时下载 → 装进 `resourcepacks/` → 改 `options.txt` → 强制切 `zh_cn` | 同 A/B（资源包能覆盖的部分） | `I18nUpdateMod3`（现行）/ `I18nReborn`（归档，含 Fabric）/ `I18nUpdateMod`（1.12.2，归档）/ VMTU（衍生） | ① 旧版 `I18nUpdateMod`：下载超时（默认 60s）转后台；远程 git 镜像全挂则拿不到更新（它按 `remoteRepoURL` 列表顺序试，还要解析 HTML 302）；② `I18nReborn`：7 天节流期内**不会**重试，且下载全程在内存里拼字节数组；③ `I18nUpdateMod3`：网易我的世界环境**主动拒绝下载**并打印警告；④ 无网/下载失败 → 保留旧缓存或保持原样，玩家看到的是旧汉化或英文 |
| **G** | **单个 jar 直接放进 `mods/`（不走资源包）** | 放进 `mods/` | 该模组自身语言文件 + 其导览书 | `chiba233/ProductiveBees_zh-cn` | 开服时 1.21/1.21.1 服务端不放 → 蜂笼里的蜂名仍是英文（其余版本服务端装了也没这功能）；玩家自己用命名牌起的名字不会被覆盖 |
| **H** | **exe 安装程序**（Windows only） | 双击 → 选整合包文件夹 → 一路下一步 | 同 D | VM 汉化组的 `Vault-Hunters-1.18.2`（`bzlr.iss` 不上传 GitHub）、`春晓之巫`、`喷气背包猫` | 路径选错 → 覆盖到错误目录；非 Windows 不可用（故同项目还提供覆盖版） |
| **I** | **词典 / 术语库（不是给玩家装的东西）** | — | — | `CFPATools/i18n-dict`（Dict.json 221 MB，每周五发）、`CFPAOrg/Glossary`（TSV）、`i18n-Dict-Extender`（合并官方仓库译文） | 词典过期（`dict.mcmod.cn` 页脚实测标注「最后更新时间：2025-07-27」）→ 查不到新模组译名；`i18n-Dict-Extender` 就是为了补这个差 |

**形态之间的组合关系（实测）**：
- A/B/F 是「资源包层」，D/E 是「非资源包层」，二者**并存不互斥**：VM 的覆盖版说明里
  客户端「需额外安装 `I18nUpdateMod`（自动汉化更新）+ `VaultPatcher`（硬编码汉化模组）」。
- `zero6six/nomi-ceu-zh_cn` 明确要求「将这两个资源包（本汉化包 + CFPA 资源包）置入 `resourcepacks` 并加载」。
- `chiba233/atm10-zh-cn` 反过来强调自己是**完整的一份、不是补充包**，「不需要先装 BBSMC 或任何其他汉化当前置」。
- 「硬编码」是社区术语：模组把文本写死在 Java 代码里，资源包覆盖不到，
  需要 `VaultPatcher` 这类 ASM 打补丁工具。VM 的 `dawncraft` 包 README 第一行就是
  「必须下载 Vault Patcher（VP）模组才能完整汉化！」

---

## 5. 社区已形成的约定（逐条 + 来源）

### 5.1 仓库与文件组织

| # | 约定 | 来源 |
|---|---|---|
| 1 | 翻译文件按 `<模组 slug>/<命名空间>/lang/{en_us,zh_cn}.{json,lang}` 组织，目录结构与资源包一致 | `CONTRIBUTING.md`「仓库结构」 |
| 2 | 文件夹名取发布平台 slug；仅 Modrinth 的加 `modrinth-` 前缀 | 同上 |
| 3 | 一个 PR 一个模组；多模组中文总行数 ≤200 才合并 | `CONTRIBUTING.md`「PR 内容」 |
| 4 | 每个 PR **必须**同时带简体中文与源语言文件（源语言非英语但有英语文件时英语也要带） | 同上 |
| 5 | 不带 `zh_cn` 语言标记的文件默认不会被打包，要进包必须改 Packer 配置（`font`/`textures` 例外） | `CONTRIBUTING.md`「提示」+ `Packer-Doc.md` |
| 6 | 同一模组的多版本翻译用 `packer-policy.json` 的 `indirect` 策略复用，而不是复制文件 | `Packer-Doc.md`「复用语言文件」 |
| 7 | 整合包汉化另开仓库，因为手册在 `config/` 里「无法通过资源包形式覆盖」 | `Modpack-GuideBook-i18n/README.md` 原文 |
| 8 | 整合包汉化仓库用 `<整合包名>/<整合包版本>/<原样路径>` 组织，且**按整合包版本一个包** | `Modpack-GuideBook-i18n` tree；`chiba233/atm10-zh-cn`「必须下载与你整合包版本对应的那个包，不能跨版本用」 |
| 9 | 需要双目录：`Source/`（英文原文）+ `CNPack/`（中文成品） | VM `FTB-Skies-2-Chinese`、`Craftoria-Chinese`、`FTB-Oceanblock-2-Chinese` 实测 tree |
| 10 | 仓库根放 `modpackinfo.json`（含 `translation.id`/`url`/`language`/`version`）供模组识别 | VM `CNPack/modpackinfo.json` + VMTU `ModpackInfoHelper` |
| 11 | 主分支必须叫 `main`（VM 模板仓库明文要求） | VM `Template-Repo/README.md` |

### 5.2 翻译质量与流程

| # | 约定 | 来源 |
|---|---|---|
| 12 | 翻译必须遵守 `cfpa.site/TransRules`（现为 `rules-v2.md`，2025-8-28） | `CONTRIBUTING.md`「总则」 |
| 13 | **拒绝**机器翻译（含生成式 AI）；译后编辑且达标的可收 | 同上 |
| 14 | 翻译**必须**经审查才能入库；至少 1 位官方审查人 Approve | `CONTRIBUTING.md`「审查人」 |
| 15 | 批准后加「即将合并」标签并**等 24 小时**才能合 | 同上 |
| 16 | 作者超期不响应有明确计时（7 天提醒 → 7 天搁置 → 1 天拒收），期间可被官方直接采纳 | `CONTRIBUTING.md`「搁置规则」 |
| 17 | 重大译名变更走**公示**：Bilibili / QQ 群 / MC 百科社群发布，14 天后才合并 | `CONTRIBUTING.md`「公示规则」 |
| 18 | 必须签 CLA | `CONTRIBUTING.md`「标题与文字内容」 |
| 19 | 模组作者要求与指南冲突时，**以作者要求为准** | `rules-v2.md` §1 |
| 20 | 语言文件统一 `UTF-8 without BOM` | `rules-v2.md` §1 |
| 21 | 占位符（`%s`/`%d`/`%msg%`）、颜色码（`§0`/`&r`）、换行符（`<br>`/`\n`）、命令名与字面量必须保留 | `rules-v2.md` §2 |
| 22 | tellraw JSON **只**翻 `"text"` 项的值 | `rules-v2.md` §2 |
| 23 | 中英之间**不加**空格（Patchouli 手册例外，仍需加） | `rules-v2.md` §2「排版」 |
| 24 | 1.19.2 及以下要注意译名变更历史（影响本版本 + 前两个大版本） | `rules-v2.md` §3 |
| 25 | 禁止套用不适宜烂梗 | `rules-v2.md` §1 |

### 5.3 译名与术语

| # | 约定 | 来源 |
|---|---|---|
| 26 | 模组遵循原版术语；附属/联动模组遵循主模组术语 | `rules-v2.md` §3 |
| 27 | 原版术语对照 Minecraft Wiki「译名标准化」页 | 同上；`README.md`「MC 相关翻译资源」 |
| 28 | **机械动力附属模组用 `主模组：子模组` 格式**（`Create: Steam 'n' Rails` → `机械动力：汽鸣铁道`） | `rules-v2.md` §4「模组名」 |
| 29 | 多个 `ItemGroup` 用 `模组名丨分栏名`（竖线是汉字 `丨`） | 同上 |
| 30 | 商标名按中国大陆商标名译；未进入大陆市场的建议保留原文（`Patreon`/`Discord`/`GitHub`） | 同上 |
| 31 | 网络昵称、文艺作品名（画名/曲名）一般保留原文 | 同上 |
| 32 | 模组名可先保留原文等社区意见发酵后投票定名 | 同上 |
| 33 | 104~118 号元素的中文名在译文中写成 `[[钅卢]]` 形式，由打包系统替换 | `rules-v2.md` 附录 |
| 34 | 省略号 `……`→`\u22ef\u22ef`、破折号 `——`→`\u2e3a` | `config/packer/*.json` 的 `characterReplacement` + `rules-v2.md` 附录 |
| 35 | 术语匹配：英文按词边界取最长命中；中文按 `|` 切分后子串匹配 | `Glossary/Docs/TERMS_SPEC.md` |
| 36 | 术语与 QA 分离：「这个零件叫什么」进术语表，「这句话写得对不对」进 `qa-rules.tsv` | `TERMS_SPEC.md` §5 |
| 37 | 词典每周五自动发布 | `CFPATools/i18n-dict/README.md` |
| 38 | 官方仓库自行维护汉化的热门模组（如机械动力）需要单独补差 | `i18n-Dict-Extender/README.md` |

### 5.4 分发与安装

| # | 约定 | 来源 |
|---|---|---|
| 39 | 模组级汉化首选「装自动更新模组」，次选「手动加资源包」 | CFPA 主仓库 `README.md`「如何使用」原文 |
| 40 | 整合包级汉化用「覆盖解压到 MC 根目录」，且**先备份游戏** | `Modpack-GuideBook-i18n/README.md` 首行；VM 安装文档 |
| 41 | 服务端**也必须装**汉化补丁，否则进不去游戏（VM）；或至少任务书/魔改不生效（GTNH） | `docs.vmct-cn.top/tutorial/modpack/translation.html`；`Translation-of-GTNH/README.md` |
| 42 | 双端（客户端/服务端）安装组件必须一致 | VM `Vault-Hunters` 覆盖版说明 |
| 43 | 装了新版本要删旧残留（如 `vaultpatcher/`、`config/txloader/forceload/`） | VM 覆盖版说明；GTNH README |
| 44 | 任务书没生效先尝试重载：`/bq_admin default load` 或右键命令方块；FTBQ 新版可用 `/ftbquests reload` 类操作 | GTNH README；VM 模板仓库的检查程序 |
| 45 | 汉化与上游整合包**版本强绑定**，跨版本用必须显式警告 | VM exe 提示语；ATM10「不能跨版本用」；dawncraft「不支持最新版」 |
| 46 | 与别家汉化**不能同时装**（会互相覆盖） | `chiba233/atm10-zh-cn/README.md` |
| 47 | 硬编码文本需要额外模组（`VaultPatcher` / `NotEnoughCharacters` / `I18nUpdateMod`） | VM `dawncraft` README 第一行；GTNH `release.yml` 注入 `NEC` jar |
| 48 | 汉化可被整合包作者授权/认可；不认可时用「非官方」标注 | VM `dawncraft` README 附作者授权截图；`RAD3` README「非官方汉化资源包」 |
| 49 | 翻译内容与汉化资源包同样用 CC BY-NC-SA 4.0 | 主仓库 `LICENSE`；`Modpack-GuideBook-i18n/README.md`「和汉化资源包一样，汉化部分采用 CC-BY-NC-SA 协议」 |
| 50 | MC 百科不接收翻译内容提交，汉化链接只能发短评区 | `bbs.mcmod.cn/thread-16859-1-1.html` 版主回复 |
| 51 | 翻译协作平台用 ParaTranz | GTNH homepage、VM `Template-Repo`、`create_astral_translation_zhcn` |

### 5.5 工程约定

| # | 约定 | 来源 |
|---|---|---|
| 52 | 打包配置每版本一个 JSON，改版本要同时改 `packer.yml`、`pr-packer.yml`、`boring-cyborg.yml` 和 `CFPABot` | `CONTRIBUTING.md`「配置更改指南」 |
| 53 | 一个 zip 配一个 `.md5` 文件（`<version>.md5`；按命名空间包为 `assets/<ns>.md5`） | `Uploader/Program.cs`、`i18nMetaData.json`；实测 `1.20/assets/jei.md5` = `727E21E0…` |
| 54 | 下载后必须校验 md5 才落盘；校验不过就丢弃缓存 | `ResourcePackDownloader.updateMod` + `discardUnverifiedCache` |
| 55 | 缓存目录按 `<游戏大版本>/mods/<命名空间>.zip` 分版本隔离 | `ResourcePackDownloader.download`（`cacheRoot.resolve(version).resolve("mods")`） |
| 56 | 更新节流：资源包 1 天、图标 30 天（v3）；旧版是 7 天 / 可配 0~30 天 | `ResourcePackDownloader` 的 `UPDATE_TIME_GAP`/`ICON_UPDATE_TIME_GAP`；`I18nReborn` 的 7 天；`I18nUpdateMod` 的 `maxDay=3` |
| 57 | 打包 zip 必须时间戳归零 + `-X` 才能得到稳定 md5 | `Modpack-GuideBook-i18n/main.py`（`clear_timestamp` + `zip -X -t 1970-01-01`） |
| 58 | 手动 GBK→UTF-8 转码是必要步骤（各作者编码不统一） | `Modpack-GuideBook-i18n/config.yml` 的 `file_rgx`；`README.md`「甚至连编码都不能统一」 |
| 59 | 打包器必须支持「不按命名空间」和「按命名空间」两种产物 | `Program.cs` 的 `--flattened` 与 `--grouped`；`Uploader` 把 grouped 包在服务器上解包成目录 |
| 60 | 命名空间冲突用 `<ns>-CFPA-<区分名>` 并在 `Manifest.json` 的 `rules` 里下发算法 | `namespace-discriminator.json` + `ManifestHelpers.cs` + `ResourcePackDownloader.resolveNamespace` |
| 61 | 官方包与镜像并存，客户端按顺序回退 | `build.gradle.kts`（`downloader1` + `bmclapi2`）、`ResourcePackHttp.open()` |
| 62 | 网易我的世界环境下必须放弃下载（合规） | `I18nUpdateMod3/I18nUpdateMod.java` 里的 `com.netease.mc.mod.network.common.Library` 检测与警告 |
| 63 | FTBQ 颜色字符 `&` 后丢字符会导致任务不显示，需要专门的检查器 | VM `translate-tools` README |
| 64 | SNBT 需要专门解析器（`snbtlib`）；大文件要按章节拆分再合并 | VM `FTBQuestLangSpliter` README |
| 65 | mc1.21+ 的 FTBQ snbt 语言文件需要与 json 互转才能进翻译平台 | VM `translate-tools` README |
| 66 | 资源包加载顺序要显式控制 | VMTU 功能列表「🚦 指定资源包加载顺序」；旧版 `I18nUpdateMod` 的 `priority` 配置 |
| 67 | 每日/定时构建是常态 | GTNH `nightly-build.yml`（cron `0 18 * * *`）、VM `Template-Repo`（每天早晚 10 点）、`i18n-dict`（每周五） |

---

## 6. 是否存在整合包级先例 —— 明确回答

**存在，而且是复数的、有成体系先例的。**

| 判断 | 证据 |
|---|---|
| **有专门做整合包（含任务书）汉化的组织** | `VM-Chinese-translate-group`（2022-11-19 成立，73 仓库，自述「专注于汉化MC整合包与地图」）；`CFPAOrg` 本身也做过（`Modpack-GuideBook-i18n`、`ModpackTransTools`、`Modpack-Download-Page`） |
| **有专门的仓库** | `CFPAOrg/Modpack-GuideBook-i18n`（35 整合包 / 127 版本）；VM 的 `dawncraft-Chinese-patch-Pack`、`FTB-Skies-2-Chinese`、`Craftoria-Chinese`、`FTB-Oceanblock-2-Chinese`、`MC-Eternal`、`MCE2`、`Vault-Hunters-1.18.2`、`Roguelike-Adventures-and-Dungeons`(2)、`StoneBlock4-Chinese`、`SkyFactory-5-Chinese`、`Techopolis-3`、`FTB-Evolution-Chinese`、`FTB-Neotech`、`FTB-Arcanum-Institute-Chinese`、`FTB-Sky-Odyssey`、`create_astral_translation_zhcn`、`dawncraft`… 共 40+ 个；外部还有 `Kiwi233/Translation-of-GTNH`、`chiba233/atm10-zh-cn`、`zero6six/nomi-ceu-zh_cn` 等 |
| **任务书确实被汉化了** | `CFPAOrg/Modpack-GuideBook-i18n` 的 `project/FTB Interactions/1.7.0/config/ftbquests/normal/chapters/*/*.nbt`（1.12.2 的 NBT 形态）；VM `FTB-Skies-2-Chinese` 的 `Source/config/ftbquests/quests/lang/en_us.snbt`(873 KB) 与 `CNPack/config/ftbquests/quests/lang/zh_cn.snbt`(952 KB)，以及 35 个 `CNPack/.../chapters/*.snbt` |
| **有专门为整合包汉化做的工具** | `CFPAOrg/ModpackTransTools`（`BetterQuesting/bq2lang.py`+`lang2bq.py`、`FTB-Quests/ftbquest_parser.py`、`Patchouli/parser.py`）；VM 的 `FTBQuestLangSpliter`、`translate-tools`、`VMTU`、`VMTULibraries`；`blibilijojo/Modpack-Localizer`；`ycccpu/minecraft-localizer` |
| **有专门的分发站** | `http://modpack.cfpa.team/`（CFPA，35 包）；`https://vmct-cn.top/modpacks/`（VM，58 条目） |
| **有整合包级译文的训练数据项目** | `XDawned/minecraft-quests-en-zh`：「提取已汉化整合包任务文件生成数据集」 |
| **社区自己解释了为什么必须单开一层** | `Modpack-GuideBook-i18n/README.md`：「很多整合包手册的加载方式都是基于 `Config` 文件夹文件加载的，**无法通过资源包形式覆盖**，故另开仓库来放置整合包手册的本地化」 |
| **但「整合包级」不等于「整包重打包」** | 所有实测项目的产物都是**补丁**（覆盖 zip / exe / 资源包 / jar），**没有**一个项目重新分发完整的整合包。VM 的产物都是 zip/exe，且 exe 只是把同样的文件覆盖到玩家指定的整合包目录 |

**同时要如实指出的边界**：
1. **最完整的先例已经停更**。`CFPAOrg/Modpack-GuideBook-i18n` 最后推送 2023-10-23，
   `data.json` 里最新条目是 2022-06-11；官网 https 不通。
2. **当前先例集中在少数组织/个人**，且以 1.16.5~1.21.1 为主；
   VM 官网 59 个条目里 38 个 `stopped`，只有 13 个 `maintaining`。
3. **没有通用的整合包级格式标准**。CFPA 用「整包 zip 覆盖」，VM 用「分组件 zip + 可选 exe」，
   GTNH 用「单 7z + 每日构建 + 魔改/非魔改二分」，ATM10 用「按整合包版本一个资源包 + client/server 二分」，
   `ProductiveBees` 用「单个 jar」。四者互不兼容，README 里反复警告「不能与别家同时装」。
4. **苦力怕论坛没有形成整合包级项目**（见 §3.4）。

---

## 7. 未取得 / 无法证实（如实记录）

| 项 | 状态 | 说明 |
|---|---|---|
| `I18nUpdateMod` 的 Travis 配置细节 | **未取得** | README 明确写「通过 Travis 自动集成工具实现远程云端汉化资源包自动更新」，但仓库无 `.travis.yml`；`CFPAOrg` 范围内 code search `travis` 仅命中 `TransQualityControl/README.md`（且那里只是设想） |
| `I18nUpdateMod` 的七牛云 bucket / 具体 URL | **未取得** | README 只说「使用七牛云」；`CFPAOrg` 范围内搜 `qiniu`/`七牛` 0 命中。可确认的是当时的 git 源列表里有 `git.dev.tencent.com`、`git.cfpa.team/main.html`、`git.cfpa.team/fallback.html` |
| `I18nReborn` 的设计文档 | **未取得** | 该仓库**没有 README**（raw 返回 404），只有源码。它的下载源是硬编码的 `downloader1.meitangdehulu.com` |
| CFPA 官网的下载链接是否已迁移 | **部分未取得** | `cfpa.site` 页面实测仍指向 `http://downloader1.meitangdehulu.com:22943/Minecraft-Mod-Language-Modpack-1-21.zip`（HEAD 200，3373288 B，`Last-Modified: Tue, 29 Sep 2026 01:40:51 GMT`）。`1.20/Manifest.json` 在该主机 404、在 `bmclapi2` 200，说明**新旧两套文件在两台主机上的分布并不一致**，具体运维约定未取得 |
| 「Create 必须叫机械动力」式强制译名表 | **不存在（在 CFPA 主仓库内）** | 对 `main` tree 做 `glossar\|dict\|term\|译名\|词汇\|vocab\|blackkey` 正则扫描，只命中 `config/blackkey.txt`（禁译 key 清单，159,881 B）、`config/info.json`（CurseForge 元数据，309,602 B）和各模组自带的内容文件。译名约定以散文形式写在 `rules-v2.md` §4「模组名」，或落在 `Glossary` 的 TSV 里 |
| 苦力怕论坛的整合包汉化项目 | **未取得** | 站内搜索（Discuz + xunsearch）搜「汉化补丁」「整合包汉化」各约 40 条，命中以 BE 附加包/材质汉化与悬赏求汉化为主，无系统性项目。且带 `formhash` 参数的搜索 URL 返回 HTTP 500（去掉参数才 200） |
| MC 百科的「整合包汉化补丁信息」编辑规范 | **不存在（站方明确拒绝）** | 版主回复「百科不接收翻译相关的提交」；后续追问无人回答 |
| `Modpack-GuideBook-i18n` 的官网 https | **不通** | `https://modpack.cfpa.team/` 返回 000；`http://` 返回 200（877 B SPA） |
| ParaTranz 项目页内容 | **未取得** | `https://paratranz.cn/projects/4964` 返回 200 但是 SPA 空壳（11401 B，无内容）；`/11990` 等同理 |
| `xiaofeizi-ch/BetterMC-ftbquests-CN` 的产物细节 | **未取得** | default_branch 名为 `汉化补丁合集`，仓库大小 1625 KB，但未逐文件核对 |
| `jingqi-ohhh/Cobblemon-Official-Modpack-Chinese-Translation` | **未取得** | raw README 返回 404（可能无 README 或分支名不同） |
| 各 VM 仓库的完整「安装步骤」是否统一 | **部分** | 只有 `dawncraft`、`Vault-Hunters-1.18.2` 与官方安装文档有明确步骤；其余仓库 README 多引用官网/文档 |
| `Minecraft-Mod-Language-Modpack-1-6.zip`（1,398,131 B，2026-10-15 更新）与 `1.10.2` 包的产出路径 | **未取得** | `autobuild` release 里确实有这两个资产（含 `1.6.md5`、`1.10.2.md5`），但 `packer.yml` 与 `pr-packer.yml` 的 matrix 都只有 `1.12.2 / 1.16(-fabric) / 1.18(-fabric) / 1.19 / 1.20(-fabric) / 1.21(-fabric) / 26.1(-fabric)`，**不含 1.6 与 1.10.2**，也没有对应的 `config/packer/*.json`。它们的构建来源未查到 |
| `GTNH` 任务书的实际存放路径 | **未取得** | 仓库 tree 里未见 `config/betterquesting` 或 `config/ftbquests` 的任务文件（`config/txloader` 64 项为语言覆盖文件）；README 只说「覆盖解压到 MC 目录」并用 `/bq_admin default load` 重载，推测任务书由 release 打包脚本在构建时生成 |

---

## 附：本报告引用的一手 URL 清单

**CFPA 主仓库**
- <https://github.com/CFPAOrg/Minecraft-Mod-Language-Package>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/CONTRIBUTING.md>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/Packer-Doc.md>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/README.md>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/.github/workflows/packer.yml>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/.github/workflows/pr-packer.yml>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/src/Packer/Program.cs>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/src/Packer/Helpers/ManifestHelpers.cs>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/src/Packer/Models/NamespaceDiscriminator.cs>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/src/Uploader/Program.cs>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/src/Language.Core/Utils.cs>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/config/packer/1.21.json>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/config/packer/1.12.2.json>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/config/packer/26.1.json>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/config/packer/namespace-discriminator.json>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/archived-1.10.2/run.sh>
- <https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/archived-1.10.2/README.md>

**规范与词典**
- <https://cfpa.site/TransRules/> 与 <https://cfpa.site/TransRules/file/rules-v2.md>
- <https://github.com/CFPAOrg/TransRules>
- <https://github.com/CFPAOrg/Glossary>、<https://raw.githubusercontent.com/CFPAOrg/Glossary/main/Docs/TERMS_SPEC.md>
- `Glossary` 各 TSV：`Vanilla/terms/terms-v1.tsv`、`Vanilla/terms/qa-rules.tsv`、`Mod/模组简体中文翻译指南.tsv`、`Mod/模组材料简体中文翻译指南.tsv`
- <https://github.com/CFPATools/i18n-dict>、<https://raw.githubusercontent.com/CFPATools/i18n-dict/main/README.md>
- <https://github.com/VM-Chinese-translate-group/i18n-Dict-Extender>
- <https://dict.mcmod.cn/>

**自动更新模组**
- <https://github.com/CFPAOrg/I18nUpdateMod3>（`README.md`、`src/main/resources/i18nMetaData.json`、`src/main/resources/fabric.mod.json`、`src/main/java/i18nupdatemod/I18nUpdateMod.java`、`core/GameConfig.java`、`core/net/ResourcePackHttp.java`、`core/v2/ResourcePackDownloader.java`、`build.gradle.kts`）
- <https://github.com/CFPAOrg/I18nReborn>（`fabric115/.../I18nrebornClient.java`、`FileDownloadManager.java`、`mc115/I18nUpdateModPackFinder.java`、`mixin/*`、`forge115/.../NI18nUpdateMod.java`）
- <https://github.com/CFPAOrg/I18nUpdateMod>（`README.md`、`I18nConfig.java`、`I18nUtils.java`、`download/RepoUpdateManager.java`、`resourcepack/ResourcePackBuilder.java`、`git/ResourcePackRepository.java`、`command/CmdGetLangpack.java`、`command/CmdUpload.java`）
- <https://github.com/VM-Chinese-translate-group/VMTranslationUtilityMod>、<https://github.com/VM-Chinese-translate-group/VMTULibraries>、<https://docs.vmct-cn.top/vmtu/>
- 实测服务端：`https://bmclapi2.bangbang93.com/mirrors/i18n-update-mod/{1.20,1.21}/Manifest.json`、`.../1.20/assets/{jei,create,minecraft,tconstruct}.tar.lzma`、`.../1.20/assets/jei.md5`、`.../1.20/pack.png`、`http://downloader1.meitangdehulu.com:22943/Minecraft-Mod-Language-Modpack-1-21.zip`

**整合包级先例**
- <https://github.com/CFPAOrg/Modpack-GuideBook-i18n>（`README.md`、`config.yml`、`main.py`、`project/**` tree）
- <http://modpack.cfpa.team/>、<http://modpack.cfpa.team/static/data.json>
- <https://github.com/CFPAOrg/ModpackTransTools>、<https://github.com/CFPAOrg/Modpack-Download-Page>
- <https://github.com/VM-Chinese-translate-group>（org repos）、<https://vmct-cn.top/modpacks/>、<https://vmct-cn.top/assets/index-C3BIZ3Hk.js>
- <https://docs.vmct-cn.top/tutorial/modpack/translation.html>、<https://docs.vmct-cn.top/rule/common.html>
- <https://github.com/VM-Chinese-translate-group/Template-Repo>、`translate-tools`、`FTBQuestLangSpliter`
- <https://github.com/VM-Chinese-translate-group/dawncraft-Chinese-patch-Pack>、`FTB-Skies-2-Chinese`、`Craftoria-Chinese`、`FTB-Oceanblock-2-Chinese`、`Vault-Hunters-1.18.2`、`create_astral_translation_zhcn`
- <https://github.com/Kiwi233/Translation-of-GTNH>（`README.md`、`nightly-build.yml`、`release.yml`、tree、releases）
- <https://github.com/chiba233/atm10-zh-cn>、<https://github.com/chiba233/ProductiveBees_zh-cn>
- <https://github.com/zero6six/nomi-ceu-zh_cn>、<https://github.com/blibilijojo/Modpack-Localizer>、<https://github.com/ycccpu/minecraft-localizer>、<https://github.com/xiaofeizi-ch/BetterMC-ftbquests-CN>、<https://github.com/doctormdkzrp/RAD3_Chinese_Localization>、<https://github.com/XDawned/minecraft-quests-en-zh>、<https://github.com/Annijang/Annijang-Modpack>

**中文平台**
- <https://www.mcmod.cn/s?key=整合包汉化>、<https://bbs.mcmod.cn/thread-16859-1-1.html>、<https://www.mcmod.cn/class/1188.html>
- <https://klpbbs.com/search.php?mod=forum&srchtxt=汉化补丁>、`...srchtxt=整合包汉化`
- <https://paratranz.cn/projects/4964>
