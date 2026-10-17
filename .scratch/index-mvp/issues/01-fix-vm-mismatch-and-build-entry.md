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
