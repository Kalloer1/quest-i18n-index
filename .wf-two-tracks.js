// 两条链路同时开跑：A=CF Range 只取语言文件；B=MD .mrpack 支持
// 目标仓库 E:/project/quest（main，npm test 当前 385 passed）
// 两者文件域不重叠：A 改 prepare-pack，B 新建 mrpack 模块 + 改 prepare-pack 的入口分支。

const COMMON = `
## 仓库约定（必须遵守）
- Node ESM，测试用 \`npm test\`（= \`node --test scripts/*.test.mjs\`），当前 385 passed。
- **严格 TDD：先写测试，跑一遍看到它红，再实现让它绿。** 这是本仓库已建立的纪律。
- 注释用中文，写「为什么」，并附实测证据。仓库注释风格：喜欢记录踩过的坑和真实数字。
- **绝对不要 git add / git commit / git push。** 改动留在工作区。
- 不要改 \`scripts/translate-local.mjs\`、\`scripts/translate-parallel.mjs\`、\`scripts/lib/line-translator.mjs\`（我在改或刚改完）。
- 不要碰 \`site/\`、\`patches/\`、\`research/packs/\`、\`downloads/\`。
`

const A = `你在 E:/project/quest。

## 背景（实测事实，别质疑，直接用）
CurseForge 整合包的英文源几乎总是**一个文件**：
- 346 个待翻的 \`separate\` 包里，\`separate-single\` 325 个**平均只需 1.06 个文件**（\`config/ftbquests/quests/lang/en_us.snbt\`），
  \`separate-dir\` 10 个平均 4.10 个文件。**合计 384 次 Range 请求就能覆盖全部 346 个包。**
- 已解包的 41 个包实测：\`en_us.snbt\` 合计 6.3 MB，对应整包 1392 MB —— **占 0.453%**。
- 346 个包整包下载约 14.8 GB；只取语言文件约 67 MB。

\`scripts/prepare-pack.mjs\` 现在是整包下载 → 解包 → 丢弃 zip。要加一个「只取需要的 .snbt」的模式。

## 任务（严格 TDD）

1. 读 \`scripts/prepare-pack.mjs\` 全文，以及 \`scripts/scan-packs.mjs\` 的 \`listZip\` / \`getRange\` / \`head\`（约 54-92 行）——
   那里已经有一份「只读 zip 中央目录」的实现，**复用它或抽出共用模块**，不要重写第二份。
   注意 \`scan-packs.mjs\` 的 \`listZip\` 只返回文件名，你需要扩展成返回 \`{name, compressedSize, localHeaderOffset}\`。
2. 实现 \`fetchQuestFilesOnly(url, { filter, fetchImpl })\`（命名自定，清晰即可）：
   - HEAD 拿总长 → Range 读尾部找 EOCD → Range 读中央目录 → 筛出目标文件 → 逐个 Range 读「本地头 + 压缩数据」
   - 需要**解压**（deflate）：用 \`zlib.inflateRawSync\`；\`method === 0\` 时是 stored，直接切
   - 返回 \`Array<{name, text}>\`（text 是解压后的 utf8）
   - 支持 zip64
   - 全程用 \`fetchImpl\` 注入，便于测试
3. \`preparePack\` 加选项 \`questFilesOnly\`（默认 false，保持旧行为）：
   - true 时走新路径，只把目标 \`.snbt\` 写到 \`packsDir/<slug>/\`，**不下载整包、不写 zip**
   - 目标文件用 \`extract-pack.mjs\` 的 \`isQuestFile\` 判定（导出它，或复用现有判定）
   - 落盘路径用 \`extract-pack.mjs\` 的 \`toOutputPath\`（已导出）
   - 必须有兜底：如果 Range 路径任何一步失败（CDN 不支持 Range、解压失败等），**自动回退整包下载**并在日志里明说「Range 失败，回退整包」
   - CLI 加 \`--quest-files-only\` 开关
4. 测试：新建 \`scripts/prepare-pack-range.test.mjs\`（不要覆盖已有的 \`prepare-pack.test.mjs\` 和 \`prepare-pack-keep-zip.test.mjs\`）。
   用**合成 zip**（参照 \`prepare-pack.test.mjs\` 的 \`buildZip\`，但要支持 stored 与 deflate 两种）测：
   - 只取 \`en_us.snbt\` 时，只发出「HEAD + 2 次中央目录 Range + 1 次文件 Range」这类最小请求集，**不请求整包**
   - 解出的文本与原文件逐字节相同
   - 多文件（\`separate-dir\` 场景，\`lang/en_us/chapters/*.snbt\`）全部取到
   - stored（method 0）与 deflate（method 8）都能解
   - Range 失败时回退整包下载，且回退后产物正确
   - \`questFilesOnly: false\`（默认）时行为与现在完全一致（防回归）
   至少 6 条测试。
5. 先让测试红，再实现到绿。跑 \`npm test\` 确认 385 + 新增全绿。

## 汇报
改了哪些文件、新增测试条数、\`npm test\` 最终 pass/fail、你复用了 scan-packs 的哪些代码、兜底策略怎么实现的。
`

const B = `你在 E:/project/quest。

## 背景（实测事实）
Modrinth 的整合包是 \`.mrpack\` 格式（本质是 zip），任务书在 \`overrides/\` 下：
- 实测 \`better-mc-fabric-bmc2.mrpack\`（63 MB）解出 35 个 \`.snbt\`，其中 20 个在
  \`overrides/defaultconfigs/ftbquests/quests/chapters/\`（**内嵌布局**），
  另有 \`overrides/config/ftbquests/quests/lang/en_us.snbt\`。
- Modrinth 可产出且无自带中文、未完成的包：**377 个**（\`separate-single\` 106 + \`embedded\` 271）。
- \`cdn.modrinth.com\` 的 Range 请求可用（实测 HTTP 206）。
- 好消息：\`scripts/extract-pack.mjs\` 的 \`toOutputPath\` **已经会剥掉 \`overrides/\`**（\`ANCHOR_SEGMENTS\` 锚定到 \`config\`/\`ftbquests\`/\`lang\`/\`chapters\`），所以落盘路径不用改。

\`scripts/prepare-pack.mjs\` 现在只从 CurseForge API 取下载地址。要加 Modrinth 支持。

## 任务（严格 TDD）

1. 读 \`scripts/prepare-pack.mjs\` 全文（尤其 \`resolveLatestFile\` / \`cfIdOf\` / CLI 入口）与 \`scripts/extract-pack.mjs\` 的 \`extractFromBuffer\` / \`toOutputPath\` / \`isQuestFile\`。
   也读 \`scripts/lib/candidates.mjs\`。
2. 新建 \`scripts/lib/modrinth.mjs\`：
   - \`modrinthProjectUrl(slugOrId)\` / \`resolveLatestMrpack(slug, { fetchImpl, userAgent })\`
   - 调 \`https://api.modrinth.com/v2/project/<slug>/version\`，取第一个版本的 \`.mrpack\` 文件，
     返回 \`{ url, fileName, fileLength, versionNumber }\`
   - Modrinth API **要求 \`User-Agent\`**（实测不带会 400/403），默认给 \`quest-i18n/1.0\`
   - 错误要明确：项目不存在 / 没有版本 / 没有 \`.mrpack\` 文件，分别给不同的错误信息
3. \`preparePack\` 支持 Modrinth 来源：
   - 现有签名以 \`cfId\` + \`apiKey\` 为主。新增可选 \`platform\`（\`'cf'\` 默认 / \`'mr'\`）与 \`mrSlug\`
   - \`platform === 'mr'\` 时走 \`resolveLatestMrpack\`，不需要 \`apiKey\`
   - 下载后仍用 \`extractFromBuffer\` 解包（\`.mrpack\` 是 zip，可直接复用）
   - \`keepZip\` 语义保持（默认 true，\`--no-keep-zip\` 关闭）
   - CLI：\`--ids\` 里的 slug 现在可能来自任一平台，需要能按数据集查平台。
     读 \`research/index-dataset.json\`（有 \`platform\` 字段），自动判定；允许 \`--platform mr\` 强制指定
4. 测试：新建 \`scripts/modrinth.test.mjs\`（不要动 \`prepare-pack.test.mjs\` / \`prepare-pack-keep-zip.test.mjs\`）。
   全部用 fetch 桩，不联网。至少 6 条：
   - \`resolveLatestMrpack\` 取到正确的 url/fileName/fileLength/versionNumber
   - 请求带 \`User-Agent\`
   - 项目不存在 → 明确报错
   - 没有版本 → 明确报错
   - 版本里没有 \`.mrpack\` → 明确报错
   - \`preparePack({platform:'mr', ...})\` 端到端：合成一个含 \`overrides/config/ftbquests/quests/lang/en_us.snbt\`
     的 mrpack，断言解到 \`packsDir/<slug>/config/ftbquests/quests/lang/en_us.snbt\`（**overrides/ 必须被剥掉**）
   - 平台判定：数据集里 platform=mr 的 slug 自动走 Modrinth 分支
5. 先让测试红，再实现到绿。跑 \`npm test\` 确认 385 + 新增全绿。

## 汇报
改了哪些文件、新增测试条数、\`npm test\` 最终 pass/fail、平台判定怎么实现的、\`overrides/\` 剥除是复用还是新写。
`

const results = await runs.all([
  { key: 'A-cf-range', agent: 'worker', task: A + COMMON },
  { key: 'B-modrinth', agent: 'worker', task: B + COMMON },
])

return results.map((r, i) =>
  `===== ${['A-cf-range', 'B-modrinth'][i]} =====\n${r.output ?? '(no output)'}`).join('\n\n')
