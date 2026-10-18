# 02: 翻译流水线与覆盖式打包

**What to build:**

一条**离线可跑**的翻译流水线：筛候选（只做 FTB Quests）→ 站点术语记忆精确命中 → LLM 分块翻译
→ 质量闸门 → 覆盖式补丁包 zip。这是平台的核心引擎。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

## 参照实现（照搬骨架，目标换成 FTB Quests 的 SNBT）

- `E:/project/shader-i18n-site/scripts/pipeline.mjs` —— 筛候选 → 术语记忆 → LLM 分块 → 回退率闸门
- `E:/project/shader-i18n-site/scripts/validate-lang.mjs` —— 闸门分线（失败 vs 警告）
- `E:/project/shader-i18n-site/scripts/mirror.mjs` / `release.mjs` —— 打包与发布（本工单只做打包）
- `E:/project/shader-i18n-site/FLOW.md` §2
- `docs/adr/0002-separate-translation-layouts-first.md` 附录 —— 三种语言布局与内嵌的证据
- `GLOSSARY.md` —— 语言布局、任务书、站点术语记忆的定义

## 交付物

- `scripts/pipeline.mjs` —— 主入口，支持 `--ids a,b` 与 `--top N`（互斥）。
- `scripts/validate-quests.mjs` —— 质量闸门。
- `scripts/snbt.mjs` —— SNBT 解析/序列化（无损往返）。
- `scripts/pack-patch.mjs` —— 覆盖式补丁包打包。
- `glossary.json` —— 站点术语记忆（从 CFPA 模组术语库起步做种子）。
- `shared/` 中与流水线共用的纯函数（若与工单 01 冲突，放 `scripts/lib/`）。

## 验收条件

### 流水线

- [ ] `npm run translate -- --ids <slug>` 能在本地离线跑通（LLM 可用桩替换，测试不依赖网络）。
- [ ] 筛候选：只处理含 FTB Quests 的整合包；不含的直接跳过并记录原因（`no-quests`）。
- [ ] 筛候选排除：自带中文、已是最新汉化、找不到英文源。
- [ ] 语言布局识别三种：分离·目录（`lang/<locale>/*.snbt`）、分离·单文件（`lang/<locale>.snbt`）、内嵌（`chapters/*.snbt`）。
- [ ] 术语记忆精确命中：按剥离色码后的英文骨架比对，全命中时一次 LLM 都不调。
- [ ] LLM 分块默认 60 行/块，块大小可配；分块回退率超阈值整块重试（最多 3 次）。
- [ ] 整体回退率 > 30% 判失败，不写文件、不登记。
- [ ] 每条整合包独立超时（默认 5 分钟），超时只让该条失败，其余继续。
- [ ] 产出文件头部标注「AI 初翻，未人工校对」。
- [ ] 翻译产出的英文↔中文对照回写 `glossary.json`（合并式，不抹掉历史条目）。
- [ ] 失败原因写回队列状态（调 `POST /status`，需 `X-Internal-Token`）。

### 质量闸门（`validate-quests.mjs`）

- [ ] 键集合：缺键/多键判**失败**。
- [ ] 色码：译文引入的畸形 `&`/`§` 序列（`§` 后不是 `0-9a-fk-orx`）判**失败**；色码数量差异判**警告**。
- [ ] 占位符：非 `%%` 占位符种类与数量差异判**失败**；`%%` 差异判**警告**。
- [ ] SNBT 结构：内嵌布局产出必须可解析、可序列化；结构损坏判**失败**。
- [ ] 编码：BOM 判**失败**；非 UTF-8 判**失败**。
- [ ] 找不到英文源判**失败**，绝不退回「自检」产生假绿灯。
- [ ] 每条失败判据都必须有「应判失败」的单元测试。

### SNBT 无损往返

- [ ] `parse → serialize → parse` 逐字节相同（用真实整合包样本做夹具）。
- [ ] 覆盖：字符串转义、数字类型后缀（`0b`/`0s`/`0L`/`0.0f`/`0.0d`）、数组、嵌套 compound/list、注释与空白。
- [ ] 若无法保证无损，**明确记录**，内嵌布局降级为「只做整体覆盖」（见工单 03）。

### 覆盖式补丁包（`pack-patch.mjs`）

- [ ] 产出 zip，解压覆盖到整合包根目录即可生效。
- [ ] zip 内路径与整合包内路径一一对应。
- [ ] zip 内自带 `README.txt`：写明「替换前请备份游戏」与「上游更新后可能失效」。
- [ ] zip 内自带许可与署名文件（CC BY-NC-SA 4.0，署名 CFPA 团队与相关模组作者）。
- [ ] 分离布局包只新增文件，不触碰玩家任务数据。
- [ ] 打包幂等：同一输入两次产出逐字节相同（时间戳除外），有测试。

### 端到端

- [ ] 用夹具整合包跑通「筛候选 → 翻译（桩）→ 校验 → 打包」，断言产出 zip 内容。
- [ ] 现有 64 项测试保持全绿。

## 文件归属

本工单拥有：`scripts/pipeline.mjs`、`scripts/validate-quests.mjs`、`scripts/snbt.mjs`、
`scripts/pack-patch.mjs`、`scripts/lib/`（新建）、`glossary.json`、`scripts/fixtures/` 下新增夹具。

## 已知答案

- 只做 FTB Quests。SkyFactory 5 用的是 Checklist 模组（CF 项目 405211），
  实测 `D:\SkyFactory5-5.0.8.zip` 里路径含 `ftb` 的 0 条、`.snbt` 0 个、293 模组含 FTB 的 0 个
  —— 它**有**任务书但不是 FTB Quests，判为 `no-quests` 是对的。
- 覆盖式是社区主流：CFPA `Modpack-GuideBook-i18n`（35 包/127 版本）、VM 汉化组（含 9 个内嵌包）、
  Kiwi233 `Translation-of-GTNH`。CFPA README 明写「一定要在替换之前备份游戏」。
- LLM 网关：免费层优先，失败落自建网关模型池（沿用光影站）。
- 术语来源：自建 `glossary.json`，CFPA 模组术语库做种子。
