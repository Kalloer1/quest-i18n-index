# 翻译平台工单（translation-platform）

**Spec:** [`spec.md`](./spec.md)
**集成分支:** `feat/translation-platform`
**日期:** 2026-10-18

## 任务图

```
01 提交入口与队列            ← None        ┐
02 翻译流水线与覆盖式打包     ← None        ├─ 前沿（可并行起跑）
06 状态模型与文案收尾         ← None        ┘
      ↓
03 内嵌布局产出              ← 02
04 镜像、发布与下载           ← 02
05 维护者门禁与一键触发        ← 01, 02
```

| 工单 | 阻塞于 | 状态 | 文件归属 |
|---|---|---|---|
| [01 提交入口与队列](./issues/01-submit-and-queue.md) | — | ready-for-agent | `worker/`、`shared/`、`wrangler.toml`、`site/request.html` |
| [02 翻译流水线与覆盖式打包](./issues/02-translation-pipeline-and-patch-packaging.md) | — | ready-for-agent | `scripts/pipeline.mjs`、`validate-quests.mjs`、`snbt.mjs`、`pack-patch.mjs`、`glossary.json` |
| [03 内嵌布局产出](./issues/03-embedded-layout-output.md) | 02 | blocked | `scripts/pipeline.mjs`（内嵌分支）、`snbt.mjs`（合并） |
| [04 镜像、发布与下载](./issues/04-mirror-release-and-download.md) | 02 | blocked | `scripts/mirror.mjs`、`release.mjs`、`.github/workflows/`、详情页下载区块 |
| [05 维护者门禁与一键触发](./issues/05-maintainer-gate-and-trigger.md) | 01, 02 | blocked | `worker/index.js`（translate/models 端点） |
| [06 状态模型与文案收尾](./issues/06-status-model-and-copy.md) | — | ready-for-agent | `docs/adr/`、`GLOSSARY.md`、`build-site-data.mjs`、状态文案 |

## 前沿

- 第一批（可并行）：**01、02、06**
- 02 合并后解锁：**03、04**
- 01+02 合并后解锁：**05**

## 交付方式

- 每个工单在自己的 worktree、自己的分支上实现，分支基于 `feat/translation-platform`。
- 实现前先确认 worktree 基于集成分支；不是则 reset 到集成分支。
- 实现用 `tdd` 技能：先写测试，再写实现。
- 报告完成前，把集成分支 tip 并入自己的分支。
- 全部完成后跑 `code-review`（spec 一致性 + 仓库规范两个维度）。
