# AnyRouter provider: implementation contract

本文件描述当前源码（含未发布体验优化）的实际契约。站点观察、离线回归和真实宿主隔离验证是不同证据；不能把其中一种当作另外两种已经通过。

## 1. 归属与实现边界

magpie 负责账号文件、账号选择、路由／故障转移、并发上限、签到调度和展示。插件只服务 `anyrouter`，没有后台代理、心跳、账号池或推理重试引擎。

| 模块 | 职责 |
| --- | --- |
| [入口](<index.mjs>) | magpie 的 `{id, server}` 导出；组装 hooks，不安装全局 fetch |
| [provider](<lib/provider.mjs>) | 登录、loader、usage／checkin、配置与独立功能开关 |
| [accounts](<lib/accounts.mjs>) | schema 2 编解码、模型 Key／站点能力区分、UID 与凭据快照 |
| [cookies](<lib/cookies.mjs>) | tough-cookie 6 的作用域、固定期限、删除和版本化 jar |
| [account operations](<lib/account-operations.mjs>) | UID 队列、最新记录补丁、保存竞争保护与取消 |
| [site client](<lib/site-client.mjs>) | 有界站点 HTTP、profile／已有 Key 校验、单次 POST、本地挑战计算 |
| [usage](<lib/usage.mjs>) | 单一 quota 换算率、北京时间统计和完整日志回退 |
| [usage cache](<lib/usage-cache.mjs>) | 凭据隔离的短缓存、真实采样时间、独立取消的并发合并 |
| [external calls](<lib/external-calls.mjs>) | GUI 自动排除当前 Key／高级白名单校验、完整有界日志分页与最小化消费导出 |
| [call journal](<lib/call-journal.mjs>) | 可选、有界、保留背压的用量观察和同 Key 尽力匹配，不持久化正文 |
| [model pricing](<lib/model-pricing.mjs>) | 显式计价分组、USD／百万 token 换算与未知价格保护 |
| [catalog](<lib/catalog.mjs>) | 权威账号模型列表、SDK 分派与保守兜底 |
| [model metadata](<lib/model-metadata.mjs>) | 逐字段能力、上限、显式 false 与 variants |
| [registry](<lib/model-registry.mjs>) | 匿名、有界、可取消的 capability cache 读取，不授予模型访问权 |
| [declared models](<lib/declared-models.mjs>) | 18 个预览模型及 config／runtime 形状转换 |
| [headers](<lib/headers.mjs>) | 站点／模型头分离和受管字段 |
| [request](<lib/request.mjs>) | 已知形状归一化、便携历史、词表、可选有损修复 |
| [response](<lib/response.mjs>) | 有界空前导证明、早期错误诊断、原始字节回放与诊断脱敏 |
| [session repair](<lib/session-repair.mjs>) | 显式有损资源清理与保留工具调用／结果配对 |
| [body inspection](<lib/body-inspection.mjs>) | 共享的有界克隆读取 |
| [safety](<lib/safety.mjs>) | origin／路径、ID／Key、deadline 和文本脱敏 |

## 2. 登录与已有 Key

六种入口中前五种是 OAuth 形状的本站账号连接，原生模型 Key 是宿主 `api` 方法。密码／系统令牌返回 `method: auto` 和一次性 callback；GitHub、LinuxDO、浏览器 Session 返回 `method: code`，人工导入本站 `/api/user/self` 的 cURL／JSON。

密码连接可有一次认证 POST；profile 与已有 Key 读取是只读。登录 callback 不调用 `sign_in`，也不将登录响应当作奖励证明。浏览器页面可能自己完成签到，这与插件额外发起奖励请求不同。

模型 Key 与站点秘密分离：

1. 直接提供完整 Key 时原样使用，不把旁边的 Key ID 当作已验证的归属证据。
2. 未提供 Key、明确 ID 时只读目标记录，拒绝无效目标，不自动选择其他 Key。
3. 两者都未提供时读取有界列表，只有一条明确可用记录才选择；歧义／截断／无可用记录可以连接成余额专用账号。
4. 目标记录检查 ID、启用状态、完整 Key、期限、额度及存在时的 UID；裸 Key 加 `sk-` 前缀。
5. 不创建 Key、不重置系统访问令牌；保存成功不保证上游推理可用。

## 3. 会话存储与竞争

保留外层 schema 2。新会话子状态为 `sessionState: {version:1, origin, jar}`；每次新登录生成 `loginGeneration`。宿主的模型 Key 保留在原生 `key` 或 OAuth `access`，不重复写入 refresh。

旧 raw Cookie 只在内存导入；无效的新状态不回退旧 Cookie。域／路径／前缀由 tough-cookie 检查，收到的 Max-Age 立即转固定 Expires。读取和恢复不延长期限，已删除 Session 不在 GET 重试中复活。

每个站点操作有自己的 jar，跨 self、WAF、日志分页和 POST 携带最新 Set-Cookie。UID 不一致的候选 jar 不落盘；密码仅在密码模式且显式授权保存时保留。

usage／checkin 按站点 UID 串行执行。执行与 POST 前检查凭据快照；保存前读取最新宿主记录，只补插件拥有的 session／checkin 字段。最新 metadata、账号名、UID、Key 和未知 refresh 字段不从旧快照覆盖。

队列只知道本插件自己的状态转换。**宿主 `auth.set` 是替换，不提供跨进程原子 CAS**；最后一次检查与写入之间仍存在外部竞争窗口。旧凭据没有 generation 且内容完全相同的 ABA 变化无法识别。新 jar 降级旧插件时可能需要重新导入会话，不应恢复旧失效 Cookie。

业务读取不自动登录或签到，但合法 Cookie 轮换可以由宿主保存。显式保存失败不再次写入；已经由服务器确认的签到结果仍成功并附警告。

## 4. 签到与站点 HTTP

有效 Session：`self → sign_in`。只有 self 明确拒绝会话且用户授权保存密码时才走 `self(拒绝) → status → login → self → sign_in`。WAF、网络和限流故障不被当作密码登录许可。

认证端点 `/api/user/login` 与 `/api/user/sign_in` 的 POST 均不重放；sign_in 仅发送站点 Cookie、New-Api-User、浏览器／XHR 头和空 JSON。Session 必须对该精确 URL 有效。

只读 GET 可对唯一的已知 40-hex arg1 做固定本地排列／XOR，并最多重试一次。**没有远端 JS 执行器**；未知挑战、人机验证与路径规则保留为明确失败，必要时人工浏览器处理。

`claimed`／`done` 按北京时间确认日记录完成；其他结果不记录完成日。跨午夜的预检不使用旧启动日期，排队的第二次调用读取最新完成状态而不是重复展示领取。

站点 HTTP 仅官方 HTTPS origin，不跟随重定向；响应读取上限 2 MiB，deadline／调用者 signal 贯穿 callback、body、队列和分页。旧宿主未传 signal 的调用只能使用插件自己的预算；不能承诺撤销已提交的服务器动作。

## 5. 余额与日志

同一个正安全整数 `quotaPerUnit` 用于显示和数值钱包，默认 500000。插件不把负 quota 截断为零；宿主的数值窗口可能另有展示／截断策略。

金额使用整数长除法；标准换算率精确到单 quota，非常规率最多展开 18 位小数并截断。合法安全整数率不会把单 quota 显示成零，不宣称任意分母能精确用有限小数表示。

额度默认只读 self；GUI `site-today-spend` 显式开启才读今日统计。今日统计在 self 返回后重新取北京时间窗口。stat 无有效值时回退日志，100 条／页、最多 20 页；完整总数、页号、条目 quota、时间／UID和重复页／ID都检查。未知或不完整数据不能变成零或部分总数；取消或限流不能触发另一轮回退。

同凭据额度并发读取合并，调用者独立取消；成功结果在当前实例缓存 60 秒，最多 64 个凭据作用域。缓存显示实际 self 完成的北京时间；登录／凭据变化、Cookie 到期、保存失败和今日跨日不会复用新鲜样本。共享控制台冷却期间的过期样本最多保留 5 分钟，只展示历史文本，不返回数值钱包。详见[额度使用规则](<README.md#余额累计消耗与今日消耗>)。

控制台会话失效只影响控制台数据，usage 返回 `signIn: kept`，不把独立模型 Key 宣告失效。

## 6. 模型形状与权限

config 模型使用 `provider.{npm,api}`、`reasoning`、`attachment`、`tool_call`、`modalities`。运行时使用 `api.{id,npm,url}` 与 `capabilities`；两者显式转换，不能靠宿主默认字段推断用户意图。

- 无登录时可以预览 18 个声明模型；无 Key 的已登录账号返回零模型／零模型网络请求。
- 成功账号列表权威，包括空列表。显式别名／禁用／元数据应用于已发现 ID，不把缺失手工 ID 或 registry-only ID追加到成功列表。
- 临时失败回退插件自己的声明／显式配置，并带 `fellBack`；不无条件并入 models.dev 或宿主已有模型。宿主自身可以保留此前账号缓存，其展示策略不由插件改写。
- 用户显式模型 SDK 优先于账号端点元数据和家族默认。Claude／cc-format 默认 Messages；GPT/Codex 默认 Responses；Gemini 默认原生 Google，模型 SDK 基址为官方 `/v1beta`，账号发现仍为 `/v1/models`。2026-11-26 neon 原生 SSE 实测成功，carbon 受负载限制，2.5-pro 仍 404，不按模型名字或目录存在就承诺可用。
- 原生动作只放行 `generateContent`、`streamGenerateContent` 与 `countTokens`，官方 v1／末尾斜杠形式规范化为 `/v1beta`；不改签名内容或注入 Codex/Claude 字段，清除 query Key 并使用账号的 `x-goog-api-key`。计数 HTTP200 需有效非负安全整数 `totalTokens`，不能是候选／错误响应；失败不估算或重试。允许原生路径不等于允许任意 Google 文件／删除／缓存操作。
- 上限和能力逐字段处理，明确 false 不被默认覆盖；context/input/output 独立，厂商 input 不能冒充本站明确 input。
- HTML WAF 401 与已识别客户端拒绝不宣告模型 Key 失效；其他模型接口 JSON 401会按模型认证拒绝报告。控制台失败不代替模型判断。

价格与能力来源独立：用户明确 `cost` 采用 USD／百万 token，保留零值，不填缺失字段。`provider.anyrouter.pricingGroup` 明确选定公开计价分组后，且当次公开响应给出分组倍率／模型允许该组／按 token 计费时，才转换 `model_ratio * 2 * group_ratio` 及补全倍率为参考 `cost`。未选组、未知／重复报价、按次计费、缺失缓存倍率、浮点溢出或非零下溢均保持未知。不能把公开默认价当作账号实际账单、充值汇率、厂商价格或 Magpie `rate`；不增加认证价格请求。

## 7. 发送和响应不变量

最终凭据目标固定官方 HTTPS origin 与允许路径。认证、Cookie、Host、代理认证、长度字段不能由自定义头替换；未知路径／外域／凭据 URL／重定向被本地拒绝。

Claude 与 Codex 开关独立，控制各自头／正文／beta行为。已给定的有效字段不随意覆盖，不发明 reasoning effort；未知、签名或不透明历史项保留。关闭全部正文功能才意味着正文不变，认证／目的地检查不因此停用。

便携历史仅拆除已知且完整的引用 ID，保留调用关联、明文和不透明状态；不是替服务器检索缺失历史。有损修复默认关闭，启用后可能不可逆丢失上下文，保留工具输出没有相应调用时本地拒绝。

JSON 诊断上限 64 KiB／2 秒克隆；SSE 前导上限 64 KiB／15 秒。只有已验证空形状能被略过或改写；语义内容、未知状态、超限、非法编码立即回放原始字节。保留背压、在途读取和取消，不等待不合作的 reader.cancel 才返回。

生成的诊断代码／文案／详情脱敏已知秘密、限制长度、不复制未知代码对象，并去除失效摘要头。原始模型内容和原始传输头不是自动隐私擦洗范围；外部日志分享仍需脱敏。

**一次宿主推理 fetch 对应一次上游 fetch**。模型发现／只读 usage 的多个 GET 不属于推理重放；网关／SDK自己决定的重试或账号故障转移不由插件承诺消除。

## 8. 验收与证据边界

| 契约 | 离线／宿主证据 |
| --- | --- |
| Cookie 域／路径／期限／删除／恢复和无脚本执行 | [Cookie 回归](<test/cookies-hardening.test.mjs>) |
| 队列、同 UID 登录、退出、保存失败和午夜 | [生命周期回归](<test/account-lifecycle.test.mjs>) |
| 已有 Key ID／歧义／期限／归属 | [Key 回归](<test/key-selection.test.mjs>) |
| config/runtime、未知模型、权威空列表与能力 | [模型边界回归](<test/model-hardening.test.mjs>) |
| 原始语义／不透明流、独立开关、目的地 | [协议回归](<test/protocol-hardening.test.mjs>) |
| 诊断脱敏、深层证明、非法 UTF-8、摘要头 | [响应对抗回归](<test/final-response-hardening.test.mjs>) |
| 极端率、重复／错误日志和取消 | [金额对抗回归](<test/final-usage-hardening.test.mjs>) |
| 真正宿主 normalization、登录、轮换和 CLI fence | [宿主集成](<test/host.integration.test.mjs>) |

本地执行 Node 26.5.0／Bun 1.4.5 全套回归，实际 Magpie 0.1.4720 的 CLI 和两个缓存宿主脚本在 test-owned storage／loopback 中通过。实际 CLI 的宿主脚本选择与 cwd由测试验证，不从缓存 mtime或HOME设置猜测。默认测试跳过 opt-in 宿主项，但这些项目另有显式无跳过执行。

[CI](<.github/workflows/ci.yml>)和打包门禁应先安装锁定依赖并禁用生命周期脚本，检查白名单、相对 import、私有文件排除和实际离线导入。矩阵配置不是执行证明；当前 Node 最低声明 20.3.0，但本机其他 Node／原版 OpenCode 加载器没有因此被宣称已验收。

更早的站点探测是历史观察，不能保证今天的 OAuth、奖励、WAF或 Claude 上游可用性。当前工作不执行生产安装、真实账号签到、Key 轮换或 npm 发布。
