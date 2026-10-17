# 任务 B：中文社区与平台是怎么做 MC 汉化的

> 你是独立调研代理。工作目录 `E:/project/quest`。产出写到 `research/other-projects-2-community.md`。

## 环境（先读）

- 你**有 bash**，直接 bash + curl / gh 联网。
- `gh` 已认证（账号 Kalloer1，5000 请求/小时）→ GitHub **一律用 `gh api`**；**别**用裸 curl 打 `api.github.com`。
- 读仓库文件：`curl -sL https://raw.githubusercontent.com/<owner>/<repo>/<main|master>/<path>`
- 中文站点（mcmod.cn、苦力怕论坛等）需代理与可能需真实浏览器：
  `HTTPS_PROXY=http://127.0.0.1:7897 NODE_USE_ENV_PROXY=1`
  若 curl 拿不到，**如实写「未取得」**，绝不编造。
- **铁律：绝不猜测、绝不凭记忆当证据。** 每条结论带来源 URL。
- 只写客观事实，不要给我们项目提设计建议。输出中文，表格优先。

## 要查清的

### 1. CFPAOrg 的完整工作流（社区事实标准）
- 目录约定：`projects/<MC版本>/assets/<modid>/lang/<locale>.json` 的实际情况（抽样几个版本目录）
- 打包器：`gh api repos/CFPAOrg/Minecraft-Mod-Language-Package/contents/.github/workflows`，
  以及主打包脚本（仓库里是 C#/.sln，找到实际入口）——它怎么把 `projects/` 打成资源包？
- `CONTRIBUTING.md` 与 `Packer-Doc.md` 全要点：贡献流程、审核规则、翻译规范
- **有没有模组译名规范/译名表？**（例如「Create 必须叫机械动力」这类约定）有没有可机器读取的词典文件？

### 2. 游戏内自动更新机制
- `CFPAOrg/I18nReborn`：怎么实现「游戏内自动下载并启用汉化资源包」？
  下载源、缓存、版本匹配、失效处理分别怎么做？（读 README + 源码）
- 已归档的 `CFPAOrg/I18nUpdateMod`：早期七牛云 + Travis 的实现细节

### 3. 整合包级（而非模组级）汉化是否存在先例
用搜索找出**专门做整合包（含任务书）汉化**的社区项目或组织：
- `gh api "search/repositories?q=%E6%95%B4%E5%90%88%E5%8C%85+%E6%B1%89%E5%8C%96&sort=stars"`
- 搜 "modpack localization chinese"、"VM汉化组"、"苦力怕论坛 整合包汉化"、"整合包汉化补丁"
- 找到就逐条记录：**产物形态 + 玩家安装步骤 + 覆盖哪些内容**

### 4. 分发形态对比

把找到的每种「玩家拿到什么 + 怎么装」列成表：
资源包 zip / 覆盖 config 的补丁包 / 重打包整合包 / 游戏内模组自动更新。
并标注各自的**失败模式**（装错会怎样）。

## 交付

写到 `research/other-projects-2-community.md`，必须包含两节：
- **社区已形成的约定**（逐条 + 来源）
- **是否存在整合包级先例**（明确回答，附证据）

最后在回复里给一页以内的中文摘要（表格优先）。
