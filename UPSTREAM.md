# Sources and provenance

本文区分代码派生、行为参考与执行证据。0.2.1 通过 [Guardinary/opencode-anyrouter-auth](<https://github.com/Guardinary/opencode-anyrouter-auth>) 独立 GitHub 仓库发布；本仓库不是 GitHub fork，也不发布同名上游 npm 包。历史来源仓库的 HEAD 不是本仓库的提交或版本证明。

## 代码与版权

- 历史代码基线为 [roiding/opencode-anyrouter-auth](<https://github.com/roiding/opencode-anyrouter-auth>) 的 0.1.0 研究样本。本包保留其 MIT 版权通知 `Copyright (c) 2026 alexcarterio and contributors`。
- [AgentRouter 参考](<https://github.com/ZhaoJun233/agentrouter-magpie-plugin>)是 MIT 许可；本地参考 HEAD 经核对为 `6713ffa`。保护模块包含直接复用或改编，**不能声称所有参考都没有源码进入本包**。
- 当前[有界读取模块](<lib/body-inspection.mjs>)与[参考仓库中的同名模块](<https://github.com/ZhaoJun233/agentrouter-magpie-plugin>) SHA-256 完全一致：`dcee95c6c9e5b08c72284bad55e1c023dbf077ca8f17f34ed40859c9d6073b3e`。文字保护、便携历史、诊断和修复也参考／改编 MIT 实现；站点契约与后续加固按 AnyRouter 的实际行为重写。
- [许可证](<LICENSE>)保留原 MIT 通知，并增加 `Portions Copyright (c) 2026 ZhaoJun233`；再分发须保留这些通知与许可文本。
- 站点公开图标／商标的权利归各自权利人，不因代码的 MIT 许可而转让。

## 行为与研究参考

| 来源 | 用途与边界 |
| --- | --- |
| [magpie-anyrouter-balance](<https://github.com/Bitwise-One/magpie-anyrouter-balance>)，本地 HEAD `063ef1b` | AnyRouter 的 Cookie／已知挑战数学算法、余额／日志／签到行为参考。没有将无许可声明的仓库整体当作 MIT 源码复制。 |
| [AgentRouter](<https://github.com/ZhaoJun233/agentrouter-magpie-plugin>) | Magpie hooks、保护实现和登录／奖励差异的参考。两个魔改站点不是机械域名替换关系。 |
| [New API](<https://github.com/QuantumNous/new-api>) | 路由、New-Api-User、已有 Key、登录与 sign_in 的产品背景；部署魔改后的行为须另行验证。 |
| [pi-anyrouter](<https://github.com/xifan2333/pi-anyrouter>)、[pi-cc-shim](<https://github.com/wylu1037/pi-cc-shim>) | 客户端形态、Claude／Codex 请求指纹的历史参考，不保证站点永远接受这些字段。 |
| [anyrouter-cpa-plugin](<https://github.com/qizhuxu/anyrouter-cpa-plugin>)、[magpie-api-checkin](<https://github.com/awsl404/magpie-api-checkin>)、[magpie-anyrouter-compat](<https://github.com/JinPen-G/magpie-anyrouter-compat>) | 历史行为研究与兼容思路，不把这些项目的功能未经验证地照搬。 |
| [all-api-hub](<https://github.com/qixing-jk/all-api-hub>) | 只读行为参考；AGPL 源码不作为本 MIT 包的复制来源。 |
| [Bun 配置文档](<https://bun.com/docs/runtime/bunfig>) | 验证 runtime preload 的局部配置与全局包管理配置不同；最终仍以本机 CLI 实测 cwd 和 fence 标记为准。 |

运行时依赖 `tough-cookie` 6；版本／传递依赖见[锁文件](<pnpm-lock.yaml>)。其源代码不手工塞入本包 tarball，安装后的依赖保留各自许可证。禁止把安装脚本、第三方账号工具或遥控脚本隐式加入运行时。

## 当前实现相对旧快照的变化

| 边界 | 0.2.1 行为 |
| --- | --- |
| WAF | 不执行 HTML／JS；只计算唯一已知 40-hex arg1；GET 最多一次重试，所有 POST不重放 |
| Cookie | tough-cookie 域／路径／前缀／删除／绝对期限；versioned jar，损坏新状态不回退旧 Cookie |
| 账号 | 保留 schema 2；新登录 generation、UID 队列和凭据快照；最新宿主字段补丁，不冒充跨进程 CAS |
| Key | 模型 Key／系统令牌分离；明确已有 Key ID，只读目标；歧义可保留为余额专用账号 |
| 模型 | config/runtime 显式转换；成功账号列表权威，空列表也是权威；无 Key 零模型；保守自身兜底 |
| 协议 | Claude／cc-format 默认 Messages，GPT／Gemini 默认 Responses；客户端开关独立；未知／签名历史保留 |
| 诊断 | 有界空前导证明、部分／不透明内容原字节回放；生成诊断脱敏，不承诺原始输出 DLP |
| 金额 | 同一换算率用于文本和数值，单 quota 非零；非常规率 18 位截断；不完整／重复日志不估算 |
| 验证 | 合成离线 Node／Bun 回归，真实 Magpie 宿主和 CLI 使用自有存储与 loopback fence |

## 站点观察与宿主验证不是一回事

历史 AnyRouter 研究观察到：站点取得登录态后会发 `POST /api/user/sign_in`，`/api/status` 的验证设置动态变化，公开定价列表与账号 Key 的 `/v1/models` 权限列表不同，`/api/log/self/stat`可能被单独 WAF 规则拦截。

较早真实探测中 GPT Responses 可完成、Claude 仍有 429／520、Chat Completions 为 404，fcapp 入口拒绝访问。这些是历史样本，不是当前站点永久可用性承诺。旧研究目录后来归档；不在本包中分发原始抓包、凭据、cURL或私人日志，也不链接一个已经不存在的开发期路径作为发布证据。

2026-11-24 本机执行证据：Node 26.5.0、Bun 1.4.5 全套离线回归；实际 Magpie 0.1.4720 的 CLI 以及两个缓存 host 脚本在隔离存储／loopback 下通过。实际 CLI 使用的 host 脚本是测试中观察出的 `host-9897559a62af.js`，不是按全球缓存更新时间猜测。

本地最低 Node 声明 20.3.0；CI 矩阵定义不代表已经运行。没有独立验收原版 OpenCode 加载器或上线发布；人工 OAuth／CAPTCHA、真实奖励和线上 Claude 可用性不由离线测试证明。

## 维护原则

新增来源必须记录真实派生关系与许可，不能用“仅行为参考”掩盖实际复制。站点算法或协议变化时同步更新[主文档](<README.md>)、[安全边界](<SECURITY.md>)、[契约](<DESIGN.md>)及回归；旧版本行为只放在明确的历史说明中。
