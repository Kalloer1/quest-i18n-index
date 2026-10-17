# 0001. 用「只读 zip 中央目录」探测整合包，而非下载整包

日期：2026-10-17
状态：已接受

## 背景

要判断一个整合包有没有 FTB Quests 任务书、属于哪代格式、是否自带中文，必须先知道包里的文件清单。

候选做法：

1. **下载整包**再解压看。实测整包 0.2 MB ~ 405 MB（14 个样本），CurseForge 侧普遍 100 MB+。
2. **依赖列表法**：查包清单里的模组依赖，看有没有 FTB Quests。零流量。
3. **只读 zip 中央目录**：用 HTTP Range 取 zip 尾部，解析 EOCD 拿到中央目录。

## 决策

采用 **3：只读 zip 中央目录**。

## 理由

- **2 已被实测否决**：FTB Quests 本体**不在 Modrinth 上**（`GET /v2/project/ftb-quests` → 404，FTB 团队主发 CurseForge）。
  两个确认有任务书的整合包（`better-mc-forge-bmc4`、`prominence-2-fabric`）依赖列表里**都没有** FTB Quests。
- **1 成本不可接受**：单包 190 MB，站内候选规模是千级。
- **3 成本可接受且结果权威**：

| 整合包 | 整包 | 实下 | 耗时 |
|---|---|---|---|
| all-the-mods-10 | 190.8 MB | 607 KB | 4.7 s |
| prominence-2-fabric | 404.9 MB | 307 KB | 1.1 s |
| better-mc-forge-bmc4 | 86.2 MB | 590 KB | 1.3 s |

## 后果

- 需要自己实现 zip 解析（EOCD / 中央目录 / 本地头 + `inflateRawSync`），不引入解压库。
- 同一套原语顺带解决了「**只取需要的文件**」：从 190 MB 的包中取单个 `.snbt` 约 2 秒。
  流水线因此可以做到全程不下载整包。
- **平台差异**：`cdn.modrinth.com` 与 `mediafilez.forgecdn.net` 支持 Range；
  `edge.forgecdn.net`（CF 重定向层）对 Range 返回 **404**，必须先 HEAD 跟随重定向拿到最终地址。
- **Range 语法陷阱**：后缀写法 `bytes=-65536` 返回 **501**，必须用起止写法 `bytes=<start>-<end>`。
