# 05: 维护者门禁与一键触发

**What to build:**

管理区：维护者输入口令后，一键触发翻译（Worker 调 GitHub Actions `workflow_dispatch`）。
口令错误拒绝；触发成功后条目立即置「翻译中」；可选只重试失败条目；可选从网关实时模型列表多选模型。

**Blocked by:** 01, 02

**Status:** blocked

## 参照实现

- `E:/project/shader-i18n-site/worker/index.js` —— `handleTranslate`、`handleVerifyPassphrase`、
  `handleModels`、`selectTranslateTargets` 的完整实现
- `E:/project/shader-i18n-site/FLOW.md` §2、§4
- `E:/project/shader-i18n-site/wrangler.toml` —— `TRANSLATE_PASSPHRASE`、`GITHUB_PAT`、
  `LLM_BASE_URL`、`LLM_API_KEY` 的配置方式

## 验收条件

- [ ] `POST /translate` 需 `X-Passphrase`，与 `TRANSLATE_PASSPHRASE` 不符返回 401。
- [ ] 口令正确时，取全部「待翻译」条目，调 GitHub API `workflow_dispatch`（`ref: main`，`inputs.ids`）。
- [ ] dispatch 成功后立即把条目置为「翻译中」，避免重复点击重复触发。
- [ ] 默认**不**重试「失败」条目；`body.retryFailed === true` 时才额外收集「失败」条目。
- [ ] 「翻译中」条目永不入选（可能真有 workflow 在跑）。
- [ ] 没有待翻译条目时返回 `{ success: true, triggered: false }`，不触发 workflow。
- [ ] `POST /verify-passphrase` 仅校验口令，供管理区门禁渲染模型多选。
- [ ] `GET /models` 代理网关 `/models`，返回实时模型 id 列表，**不含任何秘密**。
- [ ] `POST /translate` 的 `body.models` 必须命中网关实时列表（白名单校验），
      任意字符串不透传进 workflow；网关不可达时宁可 400 拒绝。
- [ ] 缺 `GITHUB_PAT` / `TRANSLATE_PASSPHRASE` 时返回明确的服务配置错误（500）。
- [ ] `selectTranslateTargets` 有单元测试（覆盖：默认只取待翻译、retryFailed 含失败、翻译中永不入选）。
- [ ] 管理区 UI：口令输入框 + 门禁 + 一键触发按钮 + 重试失败勾选 + 模型多选（口令通过后才渲染）。
- [ ] 现有测试保持全绿。

## 文件归属

本工单拥有：`worker/index.js` 中 `/translate`、`/verify-passphrase`、`/models` 端点、
`shared/` 中口令与模型校验纯函数、`site/request.html` 管理区块。

**注意**：`worker/index.js` 由工单 01 建立。本工单依赖 01，开工时先把集成分支 tip 并入自己的分支，
在 01 的成果上追加。

## 已知答案

- 口令存 Worker secret `TRANSLATE_PASSPHRASE`，绝不写进仓库。
- `GITHUB_PAT` 仅需本仓库 `actions: write`。
- 模型白名单校验的必要性：光影站曾担心任意字符串透传进 workflow，故加白名单。
- 网关地址 `LLM_BASE_URL` 是公开值，可放 `wrangler.toml` vars；`LLM_API_KEY` 是 secret。
