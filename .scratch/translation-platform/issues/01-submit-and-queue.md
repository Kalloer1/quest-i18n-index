# 01: 提交入口与队列

**What to build:**

玩家在站点提交一个整合包链接（CurseForge 或 Modrinth），Worker 校验链接合法性后写入 KV 队列
（权威状态源），站点轮询队列并自动刷新状态。这是整个平台的输入端，也是第一条端到端竖切。

产出：一个新的 Cloudflare Worker（`worker/index.js`）+ KV 队列 + 站点提交页 + 队列状态页。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

## 参照实现（照搬，不要重新设计）

- `E:/project/shader-i18n-site/worker/index.js` —— 提交/队列/状态三个端点的完整实现
- `E:/project/shader-i18n-site/FLOW.md` §4「用户请求与队列」
- `E:/project/shader-i18n-site/wrangler.toml` —— KV binding 名、vars、secrets 清单
- `E:/project/shader-i18n-site/shared/` —— 状态枚举、链接解析、限流纯函数

**差异点**：本项目提交的是**整合包**链接（CF 的 `/minecraft/modpacks/<slug>` 或 Modrinth 的
`/modpack/<slug>`），不是光影。链接解析正则要按整合包路径写。

## 验收条件（每条都必须有对应测试或有可复现的手工验证）

- [ ] `POST /` 接受 `{ url, contact?, note? }`，合法整合包链接入队，返回 `{ success, id, status }`。
- [ ] 非法链接（域名不认 / 路径不是整合包 / Modrinth 项目不存在 / Modrinth 项目类型不是 modpack）当场 400，不入队。
- [ ] CurseForge 链接在提交时**不**调 CF API 校验（避免给 Worker 加 CF key），只做路径解析；项目名交由流水线补全。
- [ ] 同一整合包重复提交只更新 `updatedAt`，不重复入队（`queue:index` 不重复）。
- [ ] `GET /queue` 返回全量条目（公开字段，**不泄露 contact 明文**）。
- [ ] `POST /status` 需 `X-Internal-Token`，只接受状态枚举内的值，写回 KV。
- [ ] 状态枚举：`待翻译 → 翻译中 → 已完成 / 镜像缺失 / 失败`，与 `shared/` 中唯一定义。
- [ ] 每 IP 每天新增提交限流（默认 3），只存 IP 哈希（`sha256(INTERNAL_STATUS_TOKEN + '|' + ip)`），绝不存原始 IP。
- [ ] CORS 白名单只放行本项目域名 + 本地开发域；非白名单 origin 的预检被拒。
- [ ] 站点提交页：表单（链接必填、邮箱选填、说明选填）+ 提交结果提示 + 队列列表。
- [ ] 队列列表每 ~15s 轮询 `GET /queue` 自动刷新，无需手动刷新。
- [ ] 队列条目显示状态中文标签、失败原因（若有）、提交时间。
- [ ] 两个断点（≥1200px / ≤480px）下提交页与队列页都可用；键盘可达。
- [ ] Worker 纯函数（链接解析、`selectTranslateTargets`、限流判定）有单元测试。
- [ ] `wrangler.toml` 声明 `TRANSLATION_QUEUE` KV binding（名字必须一致，不要用 `KV_BINDING`）。
- [ ] 现有 64 项测试保持全绿。

## 文件归属（避免与其他工单冲突）

本工单拥有：`worker/`、`shared/`（新建）、`wrangler.toml`、`site/request.html`（新建）、
`site/template.html` 中**仅**导航栏加一个「提交」链接的那一行。

## 已知答案（implementer 不必再调研）

- 状态枚举与文案：`待翻译`/`翻译中`/`已完成`/`镜像缺失`/`失败`（见 `GLOSSARY.md` 与 ADR-0007）。
- 限流上限默认 3 次/天，缺失或解析失败时回退 3（与光影站一致）。
- KV 权威，腾讯文档类镜像失败只记日志、不阻断（本工单可不实现镜像，留接口即可）。
- `research/tmp/` 已 gitignore，可放临时脚本；Node 在 Windows 下不能 import 绝对路径。
