# 任务 A：别人的整合包汉化工具，工程做法是什么

> 你是独立调研代理。工作目录 `E:/project/quest`。产出写到 `research/other-projects-1-tools.md`。

## 环境（先读）

- 你**有 bash**，直接 bash + curl / gh 联网。
- `gh` 已认证（账号 Kalloer1，5000 请求/小时）→ GitHub **一律用 `gh api`**。
  **别**用裸 curl 打 `api.github.com`（未认证仅 60/h，会打爆）。
- 读仓库文件：`curl -sL https://raw.githubusercontent.com/<owner>/<repo>/<main|master>/<path>`
- 部分站点需代理，命令前加：`HTTPS_PROXY=http://127.0.0.1:7897 NODE_USE_ENV_PROXY=1`
- **铁律：绝不猜测、绝不凭记忆当证据。** 每条结论必须带可复核来源（raw 路径 / API 响应 / issue 号）。查不到就写「未找到」。
- 只写客观事实与**可借鉴的具体手法**，不要给我们项目提设计建议。
- 输出中文，表格优先。

## 要看的仓库

用 `gh api repos/<owner>/<repo>` 逐个确认存在性/star/license/language/最后提交，
再用 raw 读 README 与**关键源码**（不要只读 README）：

**组 1：FTB Quests 专用工具**
- `XDawned/FTBQLocalizationTools`
- `XDawned/MCPackLocalizer`
- `XDawned/ModpackLocalizationTools`
- `lexacyber/ftb_quests_translater`
- `djacu/ftbquests_converter`
- `Horeak/ftb-quest-lang-generator`
- `Aletropy/ftb-translator`
- `Zergiv/ftb-quests-translator`
- `ht0apNoR/ftb-quests-precision-localizer`
- `Leha2cool/FTB-Quests-translation---html`

**组 2：做成完整应用/流水线的**
- `Y-RyuZU/MinecraftModsLocalizer`（Rust/Tauri 桌面应用，重点读 `docs/` 与 Rust 源码）
- `Thedrezik/MineAI-Modpack-Translator`
- `dannyball710/minecraft-mod-translate-skill`（重点读 `references/` 下全部文件）
- 再补搜：`gh api "search/repositories?q=modpack+localization+minecraft&sort=stars"`、
  `gh api "search/repositories?q=minecraft+quest+translation&sort=stars"` 里 star 靠前的相关项目

## 必须回答（逐条给证据）

1. **富文本怎么保**：`&a` 色码、`\n` 转义、`{image:...}` 指令、内嵌 JSON 组件（clickEvent 的 value 是章节 ID）——各家分别怎么处理？谁明确说会漏哪类？
2. **产出形态**：生成 lang 文件？回填原 snbt？还是就地改写 `chapters/`？写清每个仓库的具体做法与命令示例。
3. **版本布局差异**：有没有项目提到「单文件 `lang/en_us.snbt`」与「目录 `lang/en_us/`」两种布局的兼容处理？
4. **词表/术语**：有没有术语表机制？怎么保证同词前后一致？**有没有专门处理模组名**（如 Create→机械动力 而不是"创造"）？怎么做的？
5. **校验**：校验什么（键、行数、色码、括号）？失败怎么办？哪项阻断、哪项仅警告？
6. **它们声明未解决的坑**：README 的「已知问题」、issues 标题、代码 TODO 里逐条抄出来。

## 交付

写到 `research/other-projects-1-tools.md`，必须包含两节：
- **值得吸收的手法**（逐条 + 来源）
- **它们踩过但声明未解决的坑**（逐条 + 来源）

最后在回复里给一页以内的中文摘要（表格优先）。
