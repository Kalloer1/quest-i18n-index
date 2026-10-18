# 03: 内嵌布局产出

**What to build:**

让**内嵌布局**的整合包也能产出任务书汉化。ADR-0002 证明的是「没有语言注入机制」，
因此内嵌包**只能改写文件**——它证明的是路径唯一，不是路径不存在。社区早就在这么做。

产出方式：**整体覆盖式**（社区主流）。若工单 02 已验证 SNBT 无损往返，则额外提供
「按 quest ID 合并」的可选增强（不丢上游新任务）；若无法保证无损，只做整体覆盖。

**Blocked by:** 02

**Status:** done

## 参照实现

- `E:/project/shader-i18n-site/scripts/pipeline.mjs` —— 覆盖式产出的写法
- `docs/adr/0002-separate-translation-layouts-first.md` 附录 —— 内嵌的证据与结论
- `docs/adr/0007-translation-platform-submit-to-distribute.md` §为什么用覆盖式
- `research/other-projects-2-community.md` §3、§4 —— CFPA/VM 的内嵌包先例（含 `config/ftbquests/normal/chapters/<chapterId>/<questId>.nbt`）
- `GLOSSARY.md` —— 「译文内嵌」定义

## 验收条件

- [ ] 内嵌布局包（`chapters/*.snbt` 内含 `title`/`description`）能被流水线识别并产出。
- [ ] 整体覆盖：产出 zip 内的 `chapters/*.snbt` 覆盖玩家文件，路径一一对应。
- [ ] 若 SNBT 无损往返已验证：提供按 quest ID 合并模式，只改写译文、保留上游新增任务；有测试证明上游新增任务不丢。
- [ ] 若 SNBT 无损往返未验证：**不**提供合并模式，并在产出 README 中说明「整体覆盖，上游更新后可能失效」。
- [ ] 内嵌包补丁包的 README 比分离布局包**更强**的备份警告（它会改写玩家已有文件）。
- [ ] 内嵌包产出同样过 `validate-quests.mjs` 闸门（SNBT 结构可解析、可序列化）。
- [ ] 端到端测试：用内嵌布局夹具整合包跑通「识别 → 翻译（桩）→ 校验 → 打包」，断言产出 zip 内容。
- [ ] 现有测试保持全绿。

## 文件归属

本工单拥有：`scripts/pipeline.mjs` 中内嵌布局分支、`scripts/snbt.mjs` 中合并逻辑、
`scripts/fixtures/` 下内嵌夹具。

## 已知答案

- 社区先例：CFPA `Modpack-GuideBook-i18n` 的产出含 `config/ftbquests/normal/chapters/<chapterId>/<questId>.nbt`；
  VM 汉化组有 9 个内嵌布局包（Create: Astral、FTB StoneBlock 3、MC Eternal 2…）。
- 失败模式是社区已知并接受的：整合包更新后这些文件可能无法使用。
- 内嵌包共 104 条（见 `research/index-dataset.json`）。
