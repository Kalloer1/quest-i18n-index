# 06: 状态模型与文案收尾

**What to build:**

把站点的状态模型与文案从「索引站」更新到「翻译平台」定位。ADR-0007 已接受，
本工单不再被决策阻塞。

具体：
1. 六态模型中「内嵌不可做」改为「内嵌可做（覆盖式产出）」。
2. 非 FTB 任务书系统（如 Checklist）的包显示为「无任务书（非 FTB Quests）」，不误导。
3. ADR-0004 重写为「分发衍生作品」的许可与署名约束。
4. 关站判据写入 ADR（基于提交量与产出量）。
5. GLOSSARY 更新内嵌布局的定义。
6. 站点文案（首页、关于页）反映平台定位。

**Blocked by:** None (ADR-0007 已接受，可立即开工)

**Status:** done

## 参照实现 / 权威来源

- `docs/adr/0007-translation-platform-submit-to-distribute.md`（已接受）
- `docs/adr/0004-cc-by-nc-sa-license.md`（须重写）
- `docs/adr/0002-separate-translation-layouts-first.md`（内嵌立场改为「覆盖式产出」）
- `GLOSSARY.md`（六态表须更新）
- `E:/project/shader-i18n-site/docs/用户问题记录.md`（31 个问题 + 17 条教训，文案可参考）
- `design/BRIEF-共享上下文.md`（两断点、无障碍、署名约束）

## 验收条件

- [ ] `scripts/build-site-data.mjs` 的 `STATE_LABEL` / `STATE_EXPLAIN` 更新：
      `embedded` 从「内嵌不可做」改为「内嵌可做（覆盖式产出）」，解释文案说明「会改写你的文件，替换前请备份」。
- [ ] `no-quests` 的解释区分「不含 FTB Quests」与「含非 FTB 任务书系统（如 Checklist）」，
      后者文案为「无任务书（非 FTB Quests）」。
- [ ] `GLOSSARY.md` 六态表更新：`embedded` 定义改为「可做（覆盖式产出）」，
      并保留「译文内嵌」的布局定义。
- [ ] `docs/adr/0002-*.md` 增加修订说明：内嵌立场从「不可做」改为「走覆盖式产出」，
      附录证据保留（它证明的是没有语言注入机制，不是不能做）。
- [ ] `docs/adr/0004-*.md` 重写：本站从「只分发 URL」变成「分发衍生作品」；
      须署名 CFPA 团队与相关模组作者；产出文件带许可标识；非商业条款约束到译文本身。
- [ ] 新增或更新 ADR：关站判据基于提交量与产出量（连续 6 个月无新增提交且无新增产出）。
- [ ] 站点首页/关于页文案反映「提交 → 自动翻译 → 双通道分发」的平台定位，
      不再自称「只放链接的索引」。
- [ ] 「不同来源汉化不能同时安装」警告在详情页显式出现，不可折叠隐藏。
- [ ] 两个断点（≥1200px / ≤480px）下文案不溢出、不截断；键盘可达。
- [ ] 所有外部结论可追溯到来源链接与抓取时间。
- [ ] 现有 64 项测试保持全绿（若改 `build-site-data` 的标签，更新对应断言）。

## 文件归属

本工单拥有：`docs/adr/`、`GLOSSARY.md`、`scripts/build-site-data.mjs`（标签与解释文案）、
`scripts/build-site-data.test.mjs`、`site/template.html` 中**仅**状态文案与关于页文案区块。

**注意**：`site/template.html` 与工单 04 可能有交集。工单 04 只加下载区块，本工单只改状态/关于文案，
区域不重叠。

## 已知答案

- SkyFactory 5 用的是 Checklist 模组（CF 项目 405211），任务书是 `overrides/config/checklist/tasks.txt`
  （11.6 KB 纯文本、346 行），不是 FTB Quests。所以它显示「无任务书（非 FTB Quests）」是对的。
- 内嵌包 104 条，社区先例见 `research/other-projects-2-community.md` §3、§4。
- 关站判据：连续 6 个月无新增提交且无新增产出（用户 2026-10-18 确认）。
