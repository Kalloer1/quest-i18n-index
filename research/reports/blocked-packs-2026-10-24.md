# 30 个被闸门拦下的整合包：诊断报告

日期：2026-10-24
证据现场：`research/tmp/quarantine/run-2026-10-23T23-33-24-843Z/`（未改动、未移动）
诊断中间产物：`research/tmp/diagnose/`（`all.json` / `perfile.json` / `rename.json` / `farm.json`）
闸门脚本未做任何修改。

---

## 0. 一句话结论

**30 个里 27 个跟翻译无关，是发布链路的 `git diff --diff-filter=AM` 被 rename 检测误导，
把「新增的整章文件」判成「从别的包重命名过来」，于是这些路径没进还原清单，
本地 `patches/<slug>/` 只还原了一部分章节 → 闸门报「缺少 N 个键」。**

剩下 3 个（bloom-beyond / forge-and-fortify / furnace-to-singularity）是**上游源文件本身 SNBT 非法**，
且坏文件都不在本次翻译范围里（`reward_tables/`、分离布局下的 `chapters/`）；
闸门的结构检查会解析**全部**英文源文件，因此照样判红。

**翻译器没有丢键。** 30 个包逐一按文件比过：凡是产出里存在的章节文件，
键集合与英文源 **完全一一对应（缺 0 / 多 0）**，色码与占位符也没有一条 fatal 差异。
全部 73898 个"缺键"都来自「整个文件没出现」。

---

## 1. 复现与取证方法

1. **按现场复现**：`readBaseline(隔离区/<slug>.tar.gz)` 作英文源，隔离目录 `<slug>/` 作产出，
   用 `validatePair` 逐包跑（与 `runBatch` 同一条代码路径）→ **30/30 红**，错误文本与发布日志一致。
2. **按分支原样取回**：从 `origin/farm/<host>` 用 `git archive` 取出该包**完整**产出，
   再跑一次 `validatePair` → **27 个直接绿**（7 个只余样式警告），3 个只剩「英文源不可解析」。
3. **对齐还原清单**：读 `research/tmp/publish/plan.json`，
   逐包比较「分支树里的 .snbt 数 / plan 里的 patchPaths 数 / 隔离目录里实际的文件数」：
   `plan == 实际`，且 `plan < 分支树`，30 个包合计**少 166 个文件**。
4. **验明 rename**：对每条分支跑一次
   `git diff --name-status --find-renames origin/main~1 origin/farm/<host> -- patches`，
   把 166 个缺失路径逐个对表 → **166/166 全部命中 `R0xx~R100`**，来源都是 main 里另一个包的同名章节。
5. **最小复现（可直接抄）**：

```bash
# 全树 pathspec（publish-local 的真实用法）：只剩 8 个
git diff --name-only --diff-filter=AM origin/main~1 origin/farm/farm3 \
  -- patches research/packs | grep -c 'patches/aestheticaplus/.*snbt'      # → 8

# 关掉 rename：12 个，一个不少
git diff --no-renames --name-only --diff-filter=AM origin/main~1 origin/farm/farm3 \
  -- patches research/packs | grep -c 'patches/aestheticaplus/.*snbt'      # → 12
```

注意：**必须用全树 pathspec 才复现**。加上 `-- patches/aestheticaplus` 这种窄 pathspec 时
rename 只在单包内配对，结果会变成 13（正确），很容易误判成"没问题"。

---

## 2. 逐包结论表

列说明：`树/还原` = 分支树上该包章节文件数 / 隔离区实际文件数；`缺文件` = 被 rename 吞掉的整章文件数；
`缺键` = 闸门报的缺键数；`修复后` = 用分支原样产出重跑闸门的结果。

| # | slug | 类型 | 分支 | 树/还原 | 缺文件 | 缺键 | 具体错误（一句话） | 系统性 |
|---|------|------|------|---------|--------|------|--------------------|--------|
| 1 | aestheticaplus | D | farm3 | 12/8 | 4 | 1111 | 4 个章节文件被判 R100（内容与 create-colonies-a-perfect-world-2-extension 字节相同） | 是 |
| 2 | aeternis | D | work | 12/11 | 1 | 552 | foi1y_collections.snbt 被判 R087（源 projectx-palladium） | 是 |
| 3 | all-the-cobblemon-fabric-1-20-1 | D | farm3 | 18/8 | 10 | 3471 | 10 个章节被判 R087~R098（源 big-star-guys-…-cobblemon-star） | 是 |
| 4 | berzerkish-horror-rpg | D | work | 18/14 | 4 | 1029 | 4 个章节被判 R081~R096（源 techrpg） | 是 |
| 5 | better-mc-modified | D | farm3 | 9/6 | 3 | 214 | 3 个章节被判 R100（源 bfm） | 是 |
| 6 | bigchadguys-plus-w-cobblemon-wommiis-version | D | farm2 | 37/31 | 6 | 3038 | 6 个章节被判 R088~R099（源 skyplus-w-cobblemon / coupletime 等） | 是 |
| 7 | bloom-beyond | B | farm1 | 20/20 | 0 | 0 | 英文源 reward_tables/boite_homunculus.snbt 不可解析（位置 2493）：空键 `{: 0}` | 否（包自身） |
| 8 | cobblemon-viewersmp | D | farm1 | 12/11 | 1 | 29 | 4nfether_tips.snbt 被判 R084（源 big-star-guys…） | 是 |
| 9 | divinns_tasteslikevanilla | D | farm1 | 39/36 | 3 | 568 | 3 个章节被判 R094~R096（源 big-star-guys…） | 是 |
| 10 | eterium-sky-infinity | D | farm2 | 42/35 | 7 | 3735 | 7 个章节被判 R099（源 starfira-origins） | 是 |
| 11 | farming-across-the-skies | D | farm2 | 42/38 | 4 | 856 | 4 个章节被判 R100（源 farming-overloaded） | 是 |
| 12 | fear-nightfall-remastered | D | farm2 | 9/7 | 2 | 649 | 2 个章节被判 R090/R096（源 fearnightfall） | 是 |
| 13 | forge-and-fortify | B | farm2 | 12/12 | 0 | 0 | 英文源 reward_tables/{bathhouse,greenwood_pub}.snbt 不可解析：nbt 字符串里单引号未转义 | 否（包自身） |
| 14 | furnace-to-singularity | B | work | 1/1 | 0 | 0 | 英文源 chapters/45C34EAF227433AE.snbt 不可解析（位置 20247）：空键 `{: "BOOLEAN"}` | 否（包自身） |
| 15 | jurassicpark-survival | D | farm2 | 16/15 | 1 | 164 | epump_dat_oil.snbt 被判 R089（源 aocfabric） | 是 |
| 16 | kaios-mc_forge | D | work | 11/9 | 2 | 170 | 2 个章节被判 R100（源 deezcraft-skibidi-edition） | 是 |
| 17 | lily-craft | D | work | 30/26 | 4 | 2121 | 4 个章节被判 R075~R093（源 purpura-skies-homegrown） | 是 |
| 18 | monumental-experience-beneath-the-surface | D | farm2 | 74/73 | 1 | 98 | not_enough_wands.snbt 被判 R100（源 farming-overloaded） | 是 |
| 19 | mysticcrafts | D | farm2 | 35/34 | 1 | 232 | dark_blades.snbt 被判 R092（源 techrpg） | 是 |
| 20 | paradax-mod-pack | D | work | 37/32 | 5 | 1718 | 5 个章节被判 R100（源 big-star-guys…） | 是 |
| 21 | rossandrewsvts-medieval-mc | D | farm1 | 28/26 | 2 | 218 | the_nether.snbt 被判 R100（源 nomad-medival / dark-fantasy-mmc） | 是 |
| 22 | society-sunlit-valley-mystical-skyblock | D | farm1 | 33/10 | 23 | 9582 | 23 个章节被判 R100（源 purpura-skies-homegrown） | 是 |
| 23 | survival-create-pack | D | farm3 | 5/3 | 2 | 200 | 2 个章节被判 R089/R091（源 fabs-create-pack） | 是 |
| 24 | tensura-nexus | D | farm3 | 42/34 | 8 | 3853 | 8 个章节被判 R076~R095（源 akashic-records-gg） | 是 |
| 25 | topta-a-shrimps-tale | D | farm3 | 20/19 | 1 | 371 | c_bewitchment.snbt 被判 R089（源 prominence-1-rpg） | 是 |
| 26 | tula-grande | D | farm3 | 20/19 | 1 | 298 | fermented_flavours.snbt 被判 R077（源 cisco-rpg-dragonfyre-ru-translation） | 是 |
| 27 | vector-future | D | work | 12/10 | 2 | 180 | 2 个章节被判 R093/R099（源 create-aeronautical-crafting） | 是 |
| 28 | vertuo-hosting-modpack | D | farm2 | 41/21 | 20 | 13579 | 20 个章节被判 R093~R096（源 decursio-project） | 是 |
| 29 | wabacraft | D | farm4 | 37/6 | 31 | 21869 | 31 个章节被判 R092~R099（源 akashic-records-gg） | 是 |
| 30 | zs-deceasedcraft-lite | D | podsjk | 18/1 | 17 | 3993 | 17 个章节被判 R100（源 deceded-craft-but-better） | 是 |

"修复后"一列：第 1~6、8~12、15~30 号共 27 个包用分支原样产出重跑闸门 = **通过**
（其中 farming-across-the-skies / monumental / ross… / tensura / topta / tula / wabacraft 各带 1 条
「色码数量不一致」样式警告，按闸门口径不阻断）。

---

## 3. 分类汇总

| 类型 | 数量 | 根因 | 代码位置 |
|------|------|------|----------|
| **A 翻译侧丢键/多键** | **0** | 无。文件内键集 30/30 完全一致（缺 0 / 多 0），无一条 fatal 色码或占位符差异 | — |
| **B 源包本身异常** | **3** | 上游 SNBT 非法：空键 `{: 0}`；`nbt:` 字符串里的单引号未转义 | 触发点 `scripts/validate-quests.mjs:96`（parseAll）、`:111`（解析**全部** en 文件） |
| **C 布局判定错误** | **0** | 30 个包的 `resolveLayout` 结果与数据集一致；furnace-to-singularity 的 `separate-single` 也正确（它确实有 `lang/en_us.snbt`），失败原因不是布局 | — |
| **D 发布链路缺陷（rename 吞路径）** | **27** | `git diff --name-only --diff-filter=AM origin/main origin/farm/<host>` 默认开 rename 检测。主干里已有的别包章节被当作「删除」，farm 侧新增的整章文件被当作「重命名目标」→ 状态 R（不是 A）→ 被 `--diff-filter=AM` 过滤 → 不进 `patchPaths` → `git restore` 只还原子集 | `scripts/publish-local.mjs:188`；`.github/workflows/farm-merge.yml:176`；口径文档 `scripts/lib/farm-merge.mjs:10` |

### D 类的三条硬证据

1. **166/166**：30 个包少的 166 个文件，逐个在 `git diff --name-status -M` 里都是 `R0xx~R100`，
   没有一个是别的原因。
2. **字节相同**（R100 的那批）：
   `aestheticaplus/chapters/end_mobs.snbt` 与主干 `create-colonies-a-perfect-world-2-extension` 同名文件
   md5 均为 `77223877da49269b456e7671c82f832d`；
   `zs-deceasedcraft-lite/chapters/basic_needs.snbt` 与 `deceded-craft-but-better` 同名文件
   md5 均为 `581415845e0ad3c6e8ce20686307be0f`。
3. **还原是忠实的**：隔离目录里的文件集合 == `plan.json` 的 `patchPaths`，一个不多一个不少
   → 不是 checkout 出错，是**清单本身**缺项。

### 为什么这事会"越修越顽固"

这些包与主干里已有包往往是**同一本任务书的马甲/分支**（aestheticaplus ↔ create-colonies…、
zs-deceasedcraft-lite ↔ deceded-craft-but-better、wabacraft ↔ akashic-records-gg…），
同名章节的译文经同一份 glossary 生成，**逐字节相同**。只要主干里那份还在，
rename 配对就必然成立，重翻出来的新字节还是同一份 → 还是被吞。

> 抽样验证结论：**27 个 D 类包，重翻 100% 治不好**。不是概率问题，是确定性配对。
> 这也解释了为什么"主机重翻好几遍仍然失败"。

---

## 4. 三个 B 类的原文（判"上游损坏"而非"解析器不行"的依据）

1. `bloom-beyond: config/ftbquests/quests/reward_tables/boite_homunculus.snbt`
   ```
   { item: { Count: 1  id: "create_bnz:handheld_block_zapper"  tag: {
       : 0                 ← 空键
       Accelerator: 0
   ```
   SNBT 不允许空键。这是 mod 把 NBT 写成 `map[""]` 的结果，作者侧序列化 bug。

2. `forge-and-fortify: reward_tables/bathhouse.snbt` / `greenwood_pub.snbt`
   ```
   nbt: '{display:{Name:'{"text":"Absinthe","italic":false}'},CustomPotionEffects:[…]}'
                     ↑ 外层是单引号字符串，内层又出现裸单引号（应写 '' 或改用 \" 转义）
   ```
   经典"手写 NBT 字符串嵌套引号"损坏。

3. `furnace-to-singularity: config/ftbquests/quests/chapters/45C34EAF227433AE.snbt`
   ```
   components: { "draconicevolution:config_properties": [ [ { : "BOOLEAN"  default_value: 0b …
   ```
   同一个空键问题。

**这三个坏文件都不在翻译范围内**：
- embedded 布局只翻 `chapters/*.snbt` → 前两个包的 `reward_tables/` 根本不会被读；
- separate-single 布局只翻 `lang/en_us.snbt` → furnace 的 `chapters/` 不会被读。

也就是说：**翻译器一次都没碰过这些坏文件**，是闸门 `parseAll` 把所有 en 文件都解析了一遍才红的。
`validatePair` 内部口径本身也不统一：键集只认 `isEnSource`（`:147`），结构检查却认全部文件（`:111`）。

把坏文件剔掉后重跑：bloom-beyond 13189 键、forge-and-fortify 5531 键、furnace-to-singularity 1 键，
**problems 全为空**——说明这 3 个包除了这些坏文件之外没有任何问题。

现有 `scripts/lib/snbt-repair.mjs` 只覆盖「`key: ["…` 漏收尾」一种损坏，**不覆盖**上述两种。

---

## 5. 下一步建议

### 第一优先：修 D 类（1 行改动，解锁 27 个包）

在两处 diff 命令上加 `--no-renames`（或把 filter 改成 `--diff-filter=AMR`，但 `--no-renames` 语义更干净）：

- `scripts/publish-local.mjs:188`
- `.github/workflows/farm-merge.yml:176`
- 顺带更新 `scripts/lib/farm-merge.mjs:10` 的口径注释

```diff
- git -c core.quotePath=false diff --name-only --diff-filter=AM origin/main origin/farm/$h -- patches research/packs
+ git -c core.quotePath=false diff --no-renames --name-only --diff-filter=AM origin/main origin/farm/$h -- patches research/packs
```

工作量：**~0.5 人时**（含一条回归单测：构造"主干有 A 包、farm 有内容完全相同的 B 包"，
断言 plan 里 B 的路径一个不少）。收益：27 个包下一轮直接放行，且以后不会再出现同类静默截断。

**连带风险（建议同批修）**：`research/packs/<slug>.tar.gz`（`baselinePath`）走的是同一条 diff 口径。
tar.gz 被判 rename 的概率低但非零，一旦命中就变成"缺英文源"的红，症状更难认。

### 第二优先：3 个 B 类源包（三选一）

| 方案 | 做法 | 评价 | 工作量 |
|------|------|------|--------|
| b1（推荐） | 在 `scripts/lib/snbt-repair.mjs` 增两条窄规则：① `{ : value` 空键 → 补一个占位键名/丢弃该条目；② `nbt: '…\'…'` 单引号内裸引号 → 按 `''` 转义 | 治好包本身，不动闸门、不掩盖问题；修复清单可打印留痕（该文件已有先例：`prepare-pack.mjs:326` 落盘后修） | ~2~3 人时 + 单测 |
| b2 | 把闸门 `parseAll` 收窄到 `isEnSource` 的文件（与键集口径统一） | 逻辑上更自洽（不翻译的文件坏了不该拦），但**属于放宽闸门**，需 owner 拍板；且会削弱"源包结构完整性"的兜底 | ~0.5 人时 |
| b3 | 3 个包列入长期豁免/放弃 | 最省事，但等于承认这 3 个包永远不出 | 0 |

本次**没有**动 b2 的代码（硬性约束：不改闸门阈值与断言）。

### 第三优先：加发布侧自检（防复发）

在 `publish-local.mjs` 第 3 步 restore 之后加一条断言：
「`plan.bySlug[s].patchPaths` 里 `.snbt` 数 == `git ls-tree` 该 slug 在分支上的 `.snbt` 数」，
不等就打印差集并当作本轮失败，而不是交给闸门用"缺少 N 个键"这种间接症状报警。

工作量 **~1 人时**，能把这类静默截断（本次的 166 个文件）在源头暴露。

---

## 6. 附：证据文件清单

| 文件 | 内容 |
|------|------|
| `research/tmp/diagnose/all.json` | 30 个包 × 隔离现场跑 `validatePair` 的原始 problems / warnings |
| `research/tmp/diagnose/perfile.json` | 逐文件键集比对（证明"文件内缺键 = 0"） |
| `research/tmp/diagnose/rename.json` | 分支树 vs plan vs 实际，及 166 个缺失路径的 rename 状态与来源包 |
| `research/tmp/diagnose/farm.json` | 用分支原样产出重跑闸门的结果（27 绿 / 3 红） |
| `research/tmp/diagnose/{diag,perfile,check-farm,rename,parse,isolate}.mjs` | 复现脚本，可直接 `node` 重跑 |
