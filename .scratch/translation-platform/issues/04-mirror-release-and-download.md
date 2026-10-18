# 04: 镜像、发布与下载

**What to build:**

把产出的补丁包 zip 上传夸克网盘（国内镜像），写回分享链接；用 GitHub Actions 发布；
详情页给玩家 zip 下载入口 + GitHub 仓库链接 + 夸克镜像按钮。

**Blocked by:** 02

**Status:** blocked

## 参照实现

- `E:/project/shader-i18n-site/scripts/mirror.mjs` —— 夸克上传与分享链接写回
- `E:/project/shader-i18n-site/scripts/release.mjs` —— 发布流水线
- `E:/project/shader-i18n-site/.github/workflows/translate.yml`、`deploy.yml`
- `E:/project/shader-i18n-site/FLOW.md` §3「镜像、发布与部署」
- `E:/project/shader-i18n-site/scripts/install-quark-cli.sh`

## 验收条件

### 镜像

- [ ] `scripts/mirror.mjs` 上传补丁包 zip 到夸克网盘，创建永久公开分享，写回分享链接。
- [ ] 镜像失败**不阻断**发布，只让该字段留空（`quark: ''`）。
- [ ] 绝不伪造链接：拿不到真实 `share_url` 就写空字符串。
- [ ] 镜像幂等：同一整合包重复跑不产生重复目录。
- [ ] 逐条串行 + 每条之间限流（与光影站一致）。

### 发布

- [ ] `.github/workflows/translate.yml`：`workflow_dispatch` 接 `ids`/`models`/`retryFailed` 输入，
      跑「测试 → 校验 → 流水线 → 镜像 → 显式路径 git add → commit → push」。
- [ ] `.github/workflows/deploy.yml`：顺序为「测试 → 校验 → 构建 → Worker → Pages」，
      触发条件是 push main。
- [ ] 两个工作流都用**显式路径** `git add`，禁止 `git add -A`。
- [ ] Worker 必须先于 Pages 部署。
- [ ] 两个工作流共用 `concurrency` 组，避免同时 push 冲突。

### 详情页下载入口

- [ ] 详情页显示 zip 下载链接（本站产出）。
- [ ] 详情页显示对应 GitHub 仓库链接。
- [ ] 详情页显示夸克镜像按钮，**仅当** `quark` 非空时渲染。
- [ ] 镜像缺失时页面不显示夸克按钮，不显示假链接。
- [ ] 详情页显式出现「不同来源汉化不能同时安装」警告，不可折叠隐藏。
- [ ] 两个断点（≥1200px / ≤480px）下详情页可用；键盘可达。
- [ ] 现有测试保持全绿。

## 文件归属

本工单拥有：`scripts/mirror.mjs`、`scripts/release.mjs`、`.github/workflows/`（新建）、
`site/template.html` 中详情页下载区块、`site/data.json` 中下载相关字段（经 `build-site-data.mjs`）。

**注意**：`site/template.html` 与工单 06 可能有交集。工单 06 只改状态文案，本工单只加下载区块，
区域不重叠；若冲突，以工单 06 的状态文案为准，本工单只补下载区块。

## 已知答案

- 夸克网盘 CLI 安装脚本：`E:/project/shader-i18n-site/scripts/install-quark-cli.sh`。
- 发布顺序「测试 → 校验 → 构建 → Worker → Pages」是光影站踩坑后的结论，照搬。
- `dist/` 与 `site/index.html` 已 gitignore，`site/data.json` 是例外（必须随仓库分发）。
