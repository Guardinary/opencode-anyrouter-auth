# Changelog

本文件记录 `opencode-anyrouter-auth` 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.2] — 2026-11-26（Gemini 原生协议修复）

- 修复 Gemini 被误分派到 Responses 的 404：默认使用 `@ai-sdk/google` 和官方 `/v1beta`，保留用户 SDK 及已识别端点元数据优先级。
- 放行精确的 `generateContent`／`streamGenerateContent` 原生路径，使用所选账号的 Google Key，清除 URL query Key，保留签名正文；仍拒绝外域、未知动作和凭据重定向，不重试或换协议重放。
- 配置／运行时／预览／失败兜底的 Gemini SDK 和 base 一致；模型发现仍读取 `/v1/models`。新增模型、loader 和隔离真实 Magpie 宿主回归。
- 用户授权的最小真实验证：`gemini-4-neon` 经修复 loader 返回 200 SSE 和 `STOP`；carbon 原生接口报告负载上限，2.5-pro 原生接口仍 404。后两项不宣称线上可用；不修改账号配置或轮换 Key。
- 升级后重新获取模型；手工固定旧 Responses SDK 的模型需恢复默认或切换 Google。无需重新登录。

## [0.2.1] — 2026-11-25（GitHub Release；不发布同名 npm 包）

独立发布仓库为 `Guardinary/opencode-anyrouter-auth`，根目录包含可直接加载的源码入口。`magpie-plugin` topic 用于非官方 GitHub 发现，不代表官方推荐列表收录；2026-11-24 的加固验收记录保留为历史证据。

### 安全与正确性修复

- 完全移除远端 JS／VM 执行，只解析唯一已知 40-hex arg1并用本地固定算法计算；GET 最多重试一次，密码认证和签到 POST 均不重放。
- 引入 `tough-cookie` 6 的作用域 jar、固定期限、删除／前缀验证；保留 schema 2，新增 versioned sessionState 和 loginGeneration，损坏新状态不回退旧 Cookie。
- 同 UID 站点操作排队，使用预检轮换 Cookie；检测换登录／退出，保存最新宿主字段。保存失败只尝试一次，已确认 POST 成功不变成重试失败；跨午夜按确认日记录。
- 新增已有 Key ID 的只读选择，拒绝歧义、掩码、过期、耗尽和身份不符的 Key。无 Key 账号不宣告推理模型，不向上游发送占位符。
- 显式区分 config／runtime 模型对象，修正 GPT SDK 被宿主默认覆盖及能力 false／图片／输出丢失；成功账号列表（包括空列表）是权威。
- Claude／Codex 客户端开关独立；在最终 fetch 校验官方目的地／路径并阻止凭据重定向。
- 保留部分／未知／签名／加密输出及非法 UTF-8 原始字节；空前导与空完成必须证明字段形状和全零用量。新生成的诊断对已知凭据脱敏，并移除失效摘要头。
- 有损清理后验证工具调用／结果配对，不发送孤立结果；未知 Codex 数据不改成普通消息。
- 统一数值与文本的换算率；非常规率最多 18 位截断，合法率不会隐藏非零单 quota；重复／不完整／错误用户日志不发布部分汇总。控制台会话失效不禁用独立模型 Key。

### 工程与文档

- 本地文件夹安装现在必须明确安装锁定依赖；不依赖 postinstall。
- 运行时发布白名单仅含 `.mjs`，排除本地私有词表。校正复用代码的 MIT 版权通知和来源说明。
- 三项 opt-in 宿主／真实 CLI 测试验证测试自有 HOME 与 loopback preload 标记，不再把假 Key 发往真实站点；旧沙箱脚本改为委托同一实现。
- Node 26.5.0、Bun 1.4.5 及 Magpie 0.1.4720 隔离验收通过；最低 Node 声明 20.3.0，其他矩阵配置不作为已运行证明。
- 原版 OpenCode 的加载器和 Magpie 专有 hooks 未独立验收；发布、生产安装、真实奖励与上游模型可用性不是本次离线验收结果。

## [0.2.0] - 2026-11-22

> 以下是早期开发快照的历史记录，不是当前安全契约，也不证明该版本已在 npm 发布。其中远端 VM、POST 重放、无依赖和模型形状等问题由 0.2.1 修复；请勿据此恢复旧实现。

首个面向 AnyRouter（anyrouter.top）的完整 magpie 供应商版本。相对 0.1.0 基线，站点契约、模型协议与账号模型都被重写。

### 新增

- **六种登录入口**：账号密码（可选保存密码用于签到）、GitHub 浏览器交接、LinuxDO 浏览器交接、浏览器会话（WAF/JS 盾入口）、系统访问令牌（余额，不签到）、模型 API Key（仅推理）。
- **独立的每日签到**：`auth.checkin` 先只读 `GET /api/user/self` 预热并校验 UID，再发唯一一次 `POST /api/user/sign_in`；北京时间按日去重，`failed` 不写完成标记，当天可重试。
- **余额与消耗**：钱包余额（`quota`）、累计消耗（`used_quota`）、北京时间今日消耗（`/api/log/self/stat`，被路径级 WAF 拦截时回退 `/api/log/self` 分页求和）。
- **多协议模型供应商**：Claude 走 Anthropic Messages（`/v1/messages?beta=true`），GPT/Gemini 走 OpenAI Responses（`/v1/responses`）；一个 provider 内按模型分派。
- **模型目录**：账号 `GET /v1/models` 优先，`/api/pricing` 与 models.dev 只补充元数据；内置 16 个公开模型作为登录前的兜底展示列表；不默认启用任何模型。
- **客户端形态兼容**：Claude Code（system 块、`metadata.user_id`、`context_management`、`anthropic-beta`、`x-app`、`x-claude-code-session-id`）与 Codex Responses Lite（`originator`、`prompt_cache_key`、`client_metadata`、`include`、`store:false`）。
- **请求保护**：有界 JSON/SSE 早期错误诊断（保留上游状态、错误码、`Retry-After`，不重试）、Responses 历史内联、可选的有损会话清理。
- **本地文字替换**：`lib/content-filter.local.json` 字面量词表，保护 Markdown 代码、工具数据与不透明历史；文件损坏时失败关闭。
- **WAF 处理**：识别 `http_custom`（JS 挑战）、`http_ratelimit`（限流）、`http_security_level_rule`（路径规则）与未知 HTML；只执行站点自己的内联挑战脚本（≤128 KiB、≤1 s、无网络/文件/进程），且只对 GET 重试一次。
- `SECURITY.md`、`CHANGELOG.md`、`content-filter.example.json`、`.gitignore` 与 GitHub Actions CI（Node 20/22/24 矩阵 + `npm test` + `npm pack --dry-run`）。
- `package.json` 增加 `engines.node >= 20`、`magpie.name`/`summary`/`icon`/`maxConcurrency`/`options`，`files` 覆盖全部运行时模块与文档。

### 修复（相对 0.1.0）

- **签到 POST 不再被 WAF 重放**：挑战求解只允许发生在 GET（以及登录这类尚未产生副作用的 POST）上；`sign_in` 的 POST 即使返回可解挑战也绝不重发。
- **签到先校验账号身份**：密码模式改为 `status → login → self → sign_in`，会话模式为 `self → sign_in`，UID 不一致时不发 POST、不覆盖凭据。
- **签到结果严格分类**：`success` 必须是布尔；空成功消息视为 `done`；`success:"true"`、`{}`、`[]` 等畸形响一律 `failed`；401/403 → `ineligible`，404/405 → `inactive`，429/5xx → `failed`。
- **余额不再伪造零**：缺少 `quota`/`used_quota`、非安全整数、`success:false` 显示“不可用”，只有明确 `0` 才显示 `$0.00`。
- **今日消耗回退**：统计接口被路径级 WAF 拦截时自动改走消费日志分页；分页总数不一致、提前结束、超过 2000 条都判不可用，绝不显示部分值。
- **凭据隔离**：站点 `Cookie`、`New-Api-User`、系统令牌、密码永不进入模型请求；模型请求只带模型 key。
- **账号切换保护**：loader 在请求期间检测到账号变化时返回 409 `anyrouter_account_changed`，避免把请求发给错误的账号。
- **缺失模型 key 本地拒绝**：返回 400 `anyrouter_missing_api_key`，不向 AnyRouter 发请求。
- **来源绑定**：站点地址被改成非 `anyrouter.top` 时拒绝发送凭据。
- **移除不可用的备用端点**：`https://a-ocnfniawgw.cn-shanghai.fcapp.run` 实测 `403 AccessDenied: Current user is in debt.`，不再作为可选 API 端点。
- **移除内部重试引擎**：模型请求不再在插件内自动重试；429/5xx/账号故障转移交给 magpie 网关，避免重复计费与重复工具副作用。
- **文档与实现对齐**：README/DESIGN 中的请求序列、签到前置校验、API 端点与协议表均按当前源码重写。

### 变更

- 包版本 `0.1.0` → `0.2.0`；`package.json` 描述改为 AnyRouter provider 定位。
- 默认 provider：`npm: "@ai-sdk/anthropic"`、`api: "https://anyrouter.top/v1"`、16 个兜底模型。
- Provider 开关改为六个：`send-codex-headers`、`claude-code-compat`、`portable-responses`、`text-filter`、`codex-session-repair`、`request-diagnostics`。
- 插件级 JSON 选项：`quotaPerUnit`、`retryAfterSeconds`、`siteTimeoutMs`（`package.json` 的 `magpie.options` 只是建议值，插件内部有同样的默认值）。
- 测试脚本统一为 `node --test --test-concurrency=1 test/*.test.mjs`（Node 内置 test runner，无第三方依赖）。

### 移除

- 旧的 `fcapp.run` 模型 API 端点选择（实测 403）。
- 插件内部的自动重试与保活/心跳过滤器（只保留有界错误诊断，不重试、不注入心跳）。
- 通用 Responses 入口 `generic.mjs` 及其过滤器模块（本包只服务 AnyRouter）。
- 未引入 AgentRouter 参考仓库里的 GitHub Cookie 签到、`local-checkin.mjs` 本地 CLI 与 `windows-acl.mjs`（AnyRouter 不需要它们）。

### 已知问题

- Claude 模型在真实站点可能返回 429/503/520（客户端形态校验）；插件已补齐兼容层，但不能保证站点策略不变。
- LinuxDO 自动 OAuth 子路径不可行（回调页会立即消费 code），只支持浏览器交接。
- 真实账号的密码/GitHub/LinuxDO/签到端到端验证尚未完成（见 `DESIGN.md` 的 Release gates）。

## [0.1.0] - 2026-11-18

基线版本（`roiding/opencode-anyrouter-auth`）。

- AnyRouter 账号登录（密码 / GitHub / LinuxDO / 浏览器会话 / 系统访问令牌 / 模型 API Key）。
- 单窗口余额、独立签到、按账号模型目录、四种协议请求保护、WAF 隔离 VM。
- 已知问题：签到 POST 可能被 WAF 重放；签到未做只读预检；余额只有单窗口且 `Math.max(0, …)` 截断负值；默认启用带 8 次内部重试的过滤器；`package.json` 无 `engines`/`magpie.summary`。
