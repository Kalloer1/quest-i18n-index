# 01: 修 VM 误配，建立可复现的数据构建入口

**What to build:**

让「某个整合包是否已被 VM 汉化组覆盖」这个结论可信，并且能用一条命令重算出来。

现在有 8 条已知误配：`all-of-create-aeronautics`、`create-aeronautics-skybound`、
`chosens-create-integrated`、`create-evolution-renewed`、`create-chronicles-the-endventure`
全部被标成命中 VM 的 `Create: Astral`；`fantasy-rpg-with-quests` 与 `better-fantasy-overture`
命中 `Fantasy Realm`；`craftoria-2` 命中 `Craftoria`（而 `Craftoria` 本身已有精确命中）。
根因是宽松匹配只要「互相包含且长度 ≥ 6」就判定命中。

完成后：这些包不再显示为「社区已覆盖」；「VM 覆盖数」这个统计被重算并留下新旧对照；
整条「读输入 → 归一化 → 合并 → 写数据集」成为单一入口，可离线重跑，同一输入产出稳定输出。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 8 条已知误配不再被判为覆盖；每条误配在输出里留下「为何被拒」的记录（候选是谁、为何不成立）
- [ ] 匹配分三档：精确命中 / 人工确认 / 疑似（疑似不计入「已覆盖」统计，只作为待核线索保留）
- [ ] 数据集构建可离线重跑，同一份输入连续跑两次产出逐字节相同（时间戳字段除外）
- [ ] 重算后的「VM 覆盖数」与旧值 21 的差异有明确说明，写进产出文件的元数据
- [ ] 构建入口不再依赖脚本顶层副作用，调用方可以指定输入路径与输出路径

---

## 已知答案（2026-10-17 补，implementer 不必再调研）

8 条误配的**正确归属已查清**。全部判定为「VM 未覆盖」，理由分两类：

| CF slug | CF 真实标题 | 被误配到的 VM 条目 | 正确判定 | 理由类别 |
|---|---|---|---|---|
| `craftoria-2` | Craftoria 2 | `craftoria` = Craftoria | 未覆盖 | 续作 |
| `caveopolis-2` | Caveopolis 2 | `cave` = Caveopolis | 未覆盖 | 续作 |
| `ftb-evolution-2` | FTB Evolution 2 | `ftbe` = FTB Evolution | 未覆盖 | 续作 |
| `all-of-create-aeronautics` | All of Create Aeronautics | `create` = Create: Astral | 未覆盖 | 通用词撞车 |
| `create-aeronautics-skybound` | Create Aeronautics - Skybound | `create` = Create: Astral | 未覆盖 | 通用词撞车 |
| `chosens-create-integrated` | — | `create` = Create: Astral | 未覆盖 | 通用词撞车 |
| `create-evolution-renewed` | — | `create` = Create: Astral | 未覆盖 | 通用词撞车 |
| `create-chronicles-the-endventure` | — | `create` = Create: Astral | 未覆盖 | 通用词撞车 |
| `fantasy-rpg-with-quests` | Fantasy RPG - RPG Quests, Bosses & Magic | `fantasy` = Fantasy Realm | 未覆盖 | 通用词撞车 |
| `better-fantasy-overture` | — | `fantasy` = Fantasy Realm | 未覆盖 | 通用词撞车 |

**两个结构性根因**（修的是这两个，不是逐条打补丁）：

1. **通用词撞车**：VM 的 slug 有 `create`、`fantasy`、`cave` 这类短词，
   拿 slug 子串匹配必然撞上所有含该词的包。⇒ 匹配应基于 **CF 真实标题**对 VM 的 `originalName`，
   不做 slug 子串包含。
2. **续作当同款**：`core()` 把 `-2` 当后缀剥掉，导致 `craftoria-2` 命中 `craftoria`。
   但两者是不同整合包（不同 CF id、不同任务书、不同版本）。
   ⇒ 当 CF slug 带数字续作后缀而 VM 无对应条目时，判为未覆盖。

注意：CF 真实标题在 `design/demo-data.json` 里只有 22 条，其余需靠工单 04 补齐。
在标题缺失时，**宁可判为「疑似」不计入覆盖，也不要猜**。
