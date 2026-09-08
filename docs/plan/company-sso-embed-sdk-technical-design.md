# 公司 SSO 接入 Mao Web SDK 技术方案

- 日期：2026-09-07
- 状态：按已确认主线开发；实际协议补充见下文，真实公司 SSO 联调仍为上线前提。
- 范围：公司单一 SSO、多管理后台、Mao 服务端与 `sdk/embed`。

## 1. 需求背景与目标

公司管理后台已经使用统一 SSO 登录，其前端能够取得用户 SSO Token。Mao Web SDK 当前要求宿主通过 `getToken()` 提供 Mao Token，两套认证体系不能直接互用。

目标是在不修改各后台既有登录流程和后端业务代码的前提下接入 SDK。允许新增 SDK 初始化代码，由 Mao 集中完成 SSO 校验、用户映射、凭证签发与自动续期。用户不需要额外注册或登录 Mao，只要宿主能持续提供有效 SSO Token，就能持续使用 SDK。

**确定采用：SSO Token 服务端校验换票，而不是所有 Mao API 直接接受公司 SSO Token。**

## 2. 已确认需求与范围

### 2.1 本期必须做

1. SDK 初始化回调读取宿主当前 SSO Token；公司后台不开发换票接口。
2. Mao 调用公司官方 SSO 校验接口，使用可信返回值识别用户。
3. 首次访问自动创建普通 Mao 账号，跨后台复用同一员工身份。
4. 支持可信邮箱自动关联唯一匹配的已有普通账号，保留历史数据与角色。
5. 已有 SSO 绑定优先于邮箱匹配，以“身份源 + 稳定用户 ID”长期识别用户。
6. 换发与该用户普通 Mao 登录等权的访问 Token，不增加 SDK 专用 Agent 或接口权限范围。
7. SDK 主动自动续期，正常凭证轮换不打断对话、清空会话或停止任务。
8. 不签发独立 Mao refresh token；每次续期重新校验宿主提供的 SSO Token。
9. REST 与 WS 实现一致的认证生命周期，支持同一 WS 连接更新凭证。
10. 单一公司 SSO 使用服务端部署配置，支持多个明确登记的宿主 Origin。
11. 增加必要的输入校验、限流、审计、故障分类和自动化测试。

### 2.2 本期明确不做

- 不修改公司后台后端、现有登录流程或 SSO Token 刷新实现。
- 不要求前端保存应用密钥，不改变 HttpOnly Cookie 的安全属性。
- 不共享 Mao JWT 签名密钥给公司后台，不使用公共 Mao 账号代替员工身份。
- 不直接放行 SSO Token 访问现有 REST/WS，不在原认证失败后尝试另一套认证。
- 不建设多租户、多 SSO 通用平台，不新增 SSO 配置管理页面。
- 不做管理员邮箱自动绑定、账号数据批量合并、自助绑定或专用人工绑定工具。
- 不自动赋予管理员角色，不按 SSO 返回的角色覆盖 Mao 权限。
- 不实现 SSO 退出联动取消已受理任务；不保证已执行的外部操作可回滚。
- 不增加永不过期的 Token，不在 SSO 故障时无限续签。
- 不重构现有 shell/终端任务授权体系，不承诺所有衍生凭证统一随 SSO 撤销。
- 不增加 Mao Web 主站的公司 SSO 登录入口，不改 Electron、安卓或 CLI 登录交互。

## 3. 当前代码事实与改造依据

| 位置 | 当前事实 | 设计影响 |
|---|---|---|
| `backend-ts/src/create-app.ts` | Fastify `preHandler` 调用 `authenticateRequest`；非公开路径无身份返回 401 | 保留现有 JWT 入口，不增加 SSO 网络校验到每个 API |
| `backend-ts/src/auth/jwt-hook.ts` | 支持 Bearer/query Token；`/v1/auth` 为公开前缀 | 换票路由独立验证 SSO；新流程禁止 URL 携带 Token |
| `backend-ts/src/crypto/jwt.service.ts` | HS256；访问入口接受 `access`、`shell`，拒绝 `refresh` | 新增可指定有效期和来源的 access 签发方法，复用验证算法 |
| `backend-ts/src/auth/auth.service.ts` | 普通登录返回 access/refresh；logout 仅客户端丢弃；返回 `expiresIn` 写死 86400 | SSO 换票不复用普通登录返回方法；有效期来自实际签发值 |
| `backend-ts/src/user/user.repository.ts` | `findByEmail` 为单结果查询 | 不能据此证明唯一匹配，需新增查重和事务关联能力 |
| `backend-ts/src/user/types.ts` | 当前用户结构无通用 SSO subject 绑定 | 新建外部身份映射表，不复用飞书字段 |
| `sdk/embed/src/types.ts` | `getToken: () => Promise<string>` 为必填 | 新增明确的 SSO 初始化模式 |
| `sdk/embed/src/core/token-provider.ts` | 缓存 Promise，失效后重新调用，无主动续期计时器 | 增加到期元数据、提前续期、并发合并和生命周期管理 |
| `sdk/embed/src/core/rest-client.ts` | 401 后失效缓存并重试一次 | 保留有界重试，区分权限拒绝与凭证失效 |
| `sdk/embed/src/core/ws-client.ts` | 首帧 auth、connected 确认、重连和订阅恢复 | 增加在线更新认证，不用周期性断线模拟续期 |
| `backend-ts/src/session/ws/streaming-ws-handler.ts` | 当前连接认证使用本地 JWT | 增加认证来源、到期时间、同身份更新和到期关闭 |
| `backend-ts/src/harness/tool/impl/shell-session-tool.ts`、`harness/terminal/terminal-manager.ts` | 按用户签发 shell Token | SDK access 到期不代表所有任务凭证撤销，必须如实说明 |

源码阅读以当前工作区为准，其中已有未提交改动。本次只新增方案文档，不覆盖这些改动。

## 4. 技术选型与方案比较

| 方案 | 结论 | 原因 |
|---|---|---|
| 各后台后端分别换发 Mao Token | 不采用 | 违反不改公司后台后端的约束，重复维护 |
| 所有 Mao API 同时接受 SSO Token | 不采用 | 将外部 SSO 校验耦合到所有入口，扩大认证和故障边界 |
| 前端自行签发 Mao JWT | 禁止 | 必须暴露服务端签名密钥 |
| 共享账号或长效固定 Token | 不采用 | 无法隔离用户数据、审计身份与控制凭证生命周期 |
| Mao 专用换票接口 + SDK 自动续期 | 采用 | 宿主只提供现有凭证，Mao 集中管理身份，复用已有业务授权 |

使用当前 Node.js/TypeScript、Fastify 路由与 `jsonwebtoken`，MySQL 8 保存身份映射，Flyway 管理迁移，Vitest 测试。SSO HTTP 调用使用项目运行时 HTTP 能力和明确超时，不引入 OAuth 框架、Redis 或通用身份插件体系。仅实现公司实际协议的一个适配器。

## 5. 认证链路与外部契约

### 5.1 链路

```text
公司后台已登录
  → SDK 调用 getSsoToken() 获取当前凭证
  → POST Mao /api/v1/auth/sso/exchange
  → Mao 调用固定配置的公司 SSO 校验接口
  → 解析可信身份，校验账号，关联/创建用户
  → Mao 返回短期 accessToken、有效期和用户 ID
  → SDK 内存保存，用于 REST Bearer 与 WS auth
  → 临近到期：重新读取宿主最新 SSO Token，重复换票
  → 同用户：更新 REST 凭证和 WS 认证，继续当前会话
```

SSO Token 只传给换票接口，不发送给普通业务接口，不写入 URL、日志、数据库、浏览器持久化存储或 Agent 上下文。

### 5.2 SSO 适配器内部返回契约

开发补充（2026-09-07）：接入方已提供公司 `GET https://sgs.acg.team/api/sso-auth/auth/checkToken?token=<凭证>` 的成功响应样例。实现固定该地址，要求 `code=0`、`success=true`、`data.illegal=false`，从经官方校验的 `data.claims` 读取 `id`、`email`、`realName` 和 `exp`（秒）；`id` 转字符串作 subject，身份源固定 `company_sso`。样例不含明确应用密钥要求，因此不引入虚构密钥参数。不保存或复用样例中的真实凭证。

上游唯一已知传参方式为 query，这是原“Token 不进 URL”原则的协议例外：浏览器到 Mao 仍只用 Header，Mao 到 SSO 使用官方 query，并禁止日志输出该 URL。SSO 网关脱敏、claims.id 不回收、停用/撤销失败响应仍须联调核实，不能从成功样例推断。内部异常和未知响应拒绝换票（503），明确 `illegal=true` 或已过期返回401。

```ts
interface VerifiedSsoIdentity {
  subject: string;          // 稳定、不可复用的员工标识
  email: string;            // 公司已验证、唯一、不重新分配的邮箱
  displayName: string;
  expiresAt: number;        // 官方可信的凭证失效时间，epoch 毫秒
}
```

只有接口确认凭证有效、用户有效且允许 Mao 使用该凭证后，适配器才能返回身份。身份源来自服务端配置，不由浏览器指定。邮箱验证保证可以来自官方字段或经确认的 SSO 制度契约，不能自行假设。

**实现前必须获取脱敏协议文档并完成联调：**请求方式、服务端调用授权、跨应用 Token 接受范围、稳定 ID、邮箱字段和大小写规则、过期时间、撤销/停用语义、错误码、容量限制。以上内部类型是 Mao 的设计，不是公司接口已经存在的字段。

SSO 必须提供可信剩余有效期或等价有效性上界。不能从未验证 JWT payload 猜测有效期；若接口不提供，需要 SSO 团队补齐可验证契约后才能上线。公司已口头确认邮箱可信、唯一且不重分配，上线前须记录依据。

### 5.3 Mao 换票接口

- 路由：`POST /api/v1/auth/sso/exchange`。
- 请求：`Authorization: Bearer <公司 SSO Token>`，无用户名、邮箱或角色输入。
- 此路由必须绕过普通 Mao Token 解析，直接进入专用 SSO 校验，不能用两种 Token 的自动探测来分流。
- 成功：项目标准 `Result<T>`，`data` 为 `{ accessToken, expiresIn, expiresAt, refreshAfter, user: { id, displayName } }`。
- `expiresIn`、`refreshAfter` 单位秒，`expiresAt` 为 epoch 毫秒；所有值来自实际签发计算。
- 不返回 `refreshToken`，响应添加 `Cache-Control: no-store`。
- JWT 保持 `type=access`，增加明确的 `auth_source=company_sso`；不从客户端决定来源和权限。

| 场景 | HTTP | SDK 行为 |
|---|---|---|
| Token 缺失、格式非法 | 400 | 停止该次换票，报告接入错误 |
| SSO 明确失效/撤销 | 401 | 清除当前认证，停止自动换票风暴，提示宿主登录 |
| Mao 账号禁用、SSO 不允许该用户 | 403 | 提示无权使用，不当作网络错误重试 |
| 邮箱/绑定冲突 | 409 | 停止绑定，提示联系管理员，不透露目标账号资料 |
| 换票限流 | 429 | 遵守 Retry-After，有界重试 |
| SSO 超时/不可用/异常响应 | 503 | 保留仍有效的 Mao Token，退避重试 |

新增业务错误码在实现时按 `common/error-code.ts` 分配，新增 HTTP 映射必须有测试；不能让默认业务异常 HTTP 200 隐藏换票失败。

## 6. 身份映射与邮箱关联

### 6.1 数据结构

新增 `user_external_identity`：`id`、`provider`、`subject`、`user_id`、`email_at_binding`、`created_at`、`updated_at`。

- 唯一约束 `(provider, subject)`：一个 SSO 身份只能绑定一个 Mao 用户。
- 唯一约束 `(provider, user_id)`：本期一个 Mao 用户在该身份源下只绑定一个身份。
- subject 使用区分大小写的精确比较，不转为数字，不做大小写折叠。
- `email_at_binding` 记录关联依据，不作为后续登录主键。
- 不保存 SSO Token，不覆盖现有密码、飞书绑定或用户角色。
- 迁移编号在实现时从仓库最新序号分配，不提前占用当前已有迁移编号。

### 6.2 处理顺序

1. 校验 SSO，获取可信 subject、邮箱及有效期。
2. 查询 `(provider, subject)`；存在则按绑定用户登录，检查用户仍存在、未删除、未禁用，不重新按邮箱查找。
3. 无绑定时，按已确认的公司邮箱规范查询所有匹配记录，不能用现有单结果 `findByEmail` 直接关联。
4. 唯一匹配有效普通账号：检查它没有绑定其他 subject，事务内建立身份关系；保留角色和数据。
5. 匹配管理员、禁用/删除记录、重复邮箱或身份冲突：拒绝自动关联，不绕过冲突另建账号。
6. 无匹配：创建启用的普通用户，用户名由服务端生成且保证唯一，密码为空，分配现有普通用户角色，创建身份绑定。
7. 并发重复换票必须返回同一用户。身份创建与账号/角色写入同事务；按规范邮箱在数据库事务内串行处理首次关联，并让相关用户邮箱写入遵守同一并发规则。唯一约束冲突须回滚重读，不残留孤儿账号。
8. 每次换票检查本地账号状态；已有身份后来被人工提升为管理员时沿用其现有角色，本方案不提供新权限入口。

邮箱规范以公司契约为准，不擅自去掉 `+tag`、点号或转换整个地址的小写。上线前检查存量重复邮箱，不能自动挑选第一条。

邮箱变更不改变身份绑定，本期不自动改写已绑定 Mao 用户资料，不将新邮箱指向另一个账号。两个已存在 Mao 账号之间不搬迁会话、不合并数据。

## 7. 自动续期与失效边界

### 7.1 连续使用规则

**不设置用户连续使用时长上限，不设置每 5 分钟强制退出。** SSO 有效且网络正常时，用户无感持续使用。

本设计采用如下实现参数，不将其描述为用户已经逐项确认的数值：

- 部署项 `SSO_ACCESS_TTL_SECONDS` 默认 1800 秒，启动时校验为 60～3600 秒。
- 实际 access 有效期取配置 TTL 与 SSO 剩余有效期的较小值。
- 正常提前量取 TTL 的 20%，最多 120 秒；加入仅提前的随机抖动，避免同时换票。
- SSO 剩余有效期不足 30 秒时不签发极短 Token，返回明确的临期状态；SDK 再读取一次宿主最新凭证，仍临期则提示宿主恢复登录，不陷入循环。
- `refreshAfter` 由服务器计算，SDK 使用相对计时并在发送请求、页面重新可见、网络恢复时检查，不能仅依赖可能被浏览器挂起的定时器。
- 单实例只有一个在途换票 Promise；成功后原子替换 Token 和时间信息。销毁实例清理计时器、监听器与内存凭证。

公司后台必须保证回调读取“当前”Token，而不是捕获初始化时的旧字符串。若宿主现有登录机制不能获取新 SSO Token，SDK 无法代替公司登录机制完成续期；本方案不索取 SSO refresh token。

### 7.2 错误与请求处理

- REST 请求前取得仍有效的 Token；收到认证层 401 只换票重试一次，403 不触发续期。
- 仅对确定在认证层被拒绝、未进入业务执行的请求重试；不因未知网络失败自动重放写操作。
- SSO 503/429 等暂时故障采用 1、2、4、8、16、30 秒上限的退避并带抖动，遵守 Retry-After；每轮最多 5 次。耗尽后显示服务异常，由明确用户操作或网络恢复触发下一轮，不后台无限刷请求。
- 暂时故障不清除仍有效的 Mao Token；过期后暂停新业务访问，不追加宽限期伪装成功。
- SSO 明确拒绝时主动清除 SDK 凭证并关闭认证连接，展示登录提示；本期不自动跳转宿主地址。
- 因临期暂停时保留输入草稿；同身份恢复后继续，同身份以外的切换清理旧账号内容。

### 7.3 WebSocket 在线更新

新增共享协议帧 `auth_refresh` 和服务端确认 `auth_refreshed`，携带请求关联 ID；首次连接仍沿用现有 auth/connected。

1. Token 更新后 SDK 在当前连接发送 `auth_refresh`，服务端验证签名、类型、来源、有效期和 userId。
2. 只允许原身份更新，原子替换认证元数据和到期定时器，保留订阅、流状态与执行状态；不能用续期帧切换用户。
3. 确认丢失时在旧凭证有效期间进行有界重试；用关联 ID 保证重复更新无副作用，不重复发送用户消息。
4. 对 SSO 来源连接，服务端到期关闭连接，并在业务帧处理及出站推送入口检查到期，避免事件循环延迟导致继续使用旧认证。
5. 页面休眠或掉线导致错过续期时，唤醒后先换票再重连，沿用订阅恢复和历史对账，不取消后台任务。
6. 非 SSO 现有连接保持原行为；升级协议必须同步更新共享类型、服务端与 SDK 测试。

### 7.4 账号切换与数据缓存

换票结果 userId 变化时销毁旧 WS、清空旧账号消息和草稿、重新取得新用户会话，不在原连接替换 userId。会话本地存储键和 BroadcastChannel 隔离维度改为 Mao 服务地址、用户 ID、Agent ID；不沿用只有 Agent ID 的键，不广播 Token。

跨后台共享身份不表示跨 Origin 的 localStorage 自动互通，也不要求不同后台打开同一条会话。数据访问最终依赖服务端用户归属检查。

### 7.5 撤销与后台任务的真实边界

用户已取消先前“最多 5 分钟统一失效”的要求，本文不再承诺该指标。

- SDK 下一次换票收到 SSO 明确失效后立即停止使用；离线验证的已签发 access 仍可能被其他客户端使用至到期，最大窗口为其剩余 TTL。
- 公司退出若只是删除页面本地凭证，未撤销 SSO 服务器 Token，不能等同服务端全局注销；需要在公司协议联调中验证实际语义。
- 本期不增加注销回调、Token 黑名单或每次业务操作远程查询 SSO，因此不承诺即时撤销。
- 已受理 Agent 任务继续，认证轮换与连接关闭不触发取消；恢复登录后查看结果。
- 现有 shell/终端凭证按当前独立生命周期处理。本期不改变它们，也不承诺长任务中所有 Mao API 调用永久可用。shell 凭证及定时任务等非交互授权不属于 SDK access 撤销保证。

如果将来要求“公司离职后所有凭证和后台执行立即失效”，必须另立统一授权撤销与任务凭证设计，不能宣称本期已解决。

## 8. SDK 接入契约

新增 SSO 模式，与现有 Mao Token 模式用 TypeScript 联合类型表达互斥；现有模式是保留的产品能力，不是认证失败降级路径。传入两种模式或均未传入时初始化报错。

```ts
MaoChat.init({
  serverUrl: 'https://mao.company.example',
  agentId: 123,
  auth: {
    type: 'company-sso',
    getSsoToken: async () => {
      // 示例占位：必须替换为宿主已有登录 SDK 的真实取当前 Token 方法。
      return companyLogin.getCurrentToken();
    },
  },
  context: () => ({ page: location.pathname }),
});
```

`companyLogin` 是接入示意，不是项目或公司现有 API 的事实。宿主只配置回调、服务地址、Agent 和业务上下文，不编写换票请求、Mao Token 缓存或续期定时器。

SDK 新增结构化认证事件，区分 `login_required`、`service_unavailable`、`account_forbidden`、`identity_conflict`；默认 UI 提供明确提示，宿主不接事件也能理解失败原因。不在错误中透出原始凭证或 SSO 完整响应。

## 9. 安全与运维

- 换票仅允许 HTTPS，SSO 校验地址为服务端固定配置，禁止客户端提供 URL；校验响应大小、结构和超时，禁止随意跟随重定向携带凭证。
- SSO 调用密钥用环境变量或密钥文件注入，不入 Git、不发给浏览器；更新部署配置后按现有发布流程重启生效。
- 部署配置包含启用开关、身份源、校验地址、调用身份、允许的 Origin、公司邮箱契约、超时、TTL 和限流参数；启用但缺少必需项时启动失败，不静默降级。
- SDK 跨源请求不依赖第三方 Cookie。换票 CORS 使用精确 Origin 白名单，不用反射任意 Origin；拒绝浏览器 `null` Origin。无 Origin 的服务端调用仍必须通过 SSO 凭证校验和限流。
- Origin、Referer、Agent ID 均不是身份凭证。前端可持有并使用普通 Mao 权限的 Bearer Token，这是已确认的授权范围，宿主 XSS 也能窃取它，短期有效期不能替代宿主安全治理。
- 宿主 CSP 放行 Mao 的 script-src、connect-src（HTTPS/WSS）；宿主域名和网络策略配置属于接入准备，不改业务后端。
- 换票路由按 IP 和已验证身份限流；首期单实例进程内计数，多副本部署必须在现有网关落实聚合限流，不能把单进程限流宣称为全局限流。
- SSO 校验超时默认 3 秒；不缓存“有效”结果来绕过续期校验。进程不持久保存原始 SSO Token。
- 日志与审计记录 requestId、身份源、内部 userId、结果分类、关联动作和耗时；屏蔽 Authorization、响应 Token 和 WS auth 帧，不能仅依赖现有 onResponse 日志。
- 监控换票成功率、SSO 延迟/超时、401/403/409/429、续期失败和 WS 更新失败；不以邮箱/Token 作为指标标签。

## 10. 实现步骤与落地清单

以下清单是后续开发任务，不表示本次已完成。

### 阶段一：锁定协议与上线前提

- [ ] 获取公司脱敏 SSO 文档与测试账号，确认 Mao 有权校验现有后台 Token。
- [ ] 固定字段映射、有效期与撤销语义、邮箱规范和不重分配保证。
- [ ] 验证宿主回调能持续返回最新凭证，确认 SSO 容量满足多后台、多页签续期。
- [ ] 检查存量用户邮箱冲突、禁用/删除记录和普通角色；冲突人工处理，不自动修复。
- [ ] 明确生产宿主 Origin、Mao/SSO 网络连通、TLS/CSP、调用密钥注入方式。

### 阶段二：后端身份与换票

- [ ] 在 `backend-ts/src/auth/` 新增 SSO 配置、单协议校验适配器、换票 service/routes 及测试。
- [ ] 在 `backend-ts/src/config/app-config.ts` 接入部署参数；`create-app.ts` 注入依赖和路由级策略。
- [ ] 新增外部身份 repository 和 Flyway 迁移，补充账号邮箱精确查重、事务和并发串行化。
- [ ] 在 `user` 与 `permission` 模块复用普通角色与管理员判断，不新增 SDK 权限模型。
- [ ] 扩展 `crypto/jwt.service.ts` 签发参数，保持普通登录有效期行为不变。
- [ ] 为换票单独返回实际有效期；拒绝以 SSO access 访问 refresh 接口获取续签凭证。
- [ ] 在 `common/error-code.ts`、`common/http-error.ts` 增加错误映射；落实路由限流和日志脱敏。

### 阶段三：SDK 与 WS 无感续期

- [ ] 在 `shared/contracts` 增加换票 DTO 和在线认证更新帧，避免前后端重复定义。
- [ ] 在 `sdk/embed/src/types.ts` 和初始化校验中加入互斥 SSO 模式。
- [ ] 在 `core/token-provider.ts` 实现换票、主动续期、single-flight、临期处理、重试和清理。
- [ ] 在 `core/rest-client.ts` 保证有界认证重试且不重放未知结果的写操作。
- [ ] 在 `core/ws-client.ts`、后端 WS handler/registry 实现在线更新、到期与身份一致性检查。
- [ ] 在 SDK controller/store/session-manager/tabs 实现账号切换清理和按身份隔离缓存。
- [ ] 增加认证状态文案与事件，不暴露原始 SSO 错误内容。

### 阶段四：验证、文档和发布

- [ ] 执行下节测试与真实 SSO 联调；协议和邮箱前提未满足时不得上线。
- [ ] 同任务更新 `README.md`、`DEPLOY.md`、`skills/mao-cli/reference/embed-sdk.md`、配置参考文档和 `shared/contracts/README.md`。
- [ ] 功能实际交付时按根 `CHANGELOG.md` 规则记录后端和 SDK 用户可见变化；本次仅设计不写虚假发版记录。
- [ ] 更新 SDK 构建产物 `desktop/public/embed/mao-chat*.js`，验证版本锁定脚本与未锁定脚本。
- [ ] 先发布可同时支持现有认证和新协议的后端，再发布 SDK，再在一个后台接入验收，之后扩展其余后台。
- [ ] 发布前按项目流程检查线上代码版本；部署、提交、推送需另行授权，本次不执行。

## 11. 测试与验收

### 11.1 必须覆盖的自动化测试

| 领域 | 验收要求 |
|---|---|
| SSO 校验 | 有效/过期/撤销/停用、跨应用不允许、字段缺失、非法有效期、超时、非 JSON、响应超大和密钥脱敏 |
| 身份关联 | 新建、唯一邮箱关联、重复邮箱、管理员拒绝、禁用/删除拒绝、subject 稳定、邮箱变更不换账号 |
| 并发 | 同 subject 并发只创建一个用户；不同 subject 相同邮箱冲突；失败事务无残留账号/角色 |
| JWT | TTL 不超过 SSO 上界；实际 expiresIn 正确；access 不能当 refresh；普通登录与 shell 原行为回归 |
| 权限 | 原普通账号角色不变；无角色提升；现有受保护接口和本人会话校验不被绕过 |
| SDK 续期 | 多个并发请求只换票一次；定时续期、短 TTL、401 一次重试、503 保留有效 Token、到期停用 |
| WS | 流式输出中续期不中断；重复更新幂等；异用户更新拒绝；到期关闭且不推送；重连恢复不重复执行 |
| 浏览器生命周期 | 休眠唤醒、网络恢复、多页签、账号切换、destroy 清理，Token 不写入存储和广播 |
| 故障体验 | 401/403/409/429/503 明确区分，无无限重试，无凭证错误造成消息自动重复发送 |

后端执行 `cd backend-ts && npm run build && npm test`；SDK 执行 `cd sdk/embed && npm test && npm run build && npm run size`；执行 `cd desktop && npm run build` 检查集成。共享契约验证使用其 package.json 中现有脚本，实施时读取后运行，不猜测命令。

### 11.2 真实环境验收

1. 在测试公司后台仅增加初始化配置，首次打开浮窗无需 Mao 登录，能够发送和接收消息。
2. 连续运行超过两次实际 Token TTL：不出现强制登录、丢消息或任务中断；确认 SSO 确实被重新校验，不能仅验证 UI 在线。
3. 模拟 SSO Token 轮换：回调返回新值，Mao 续签成功；旧值失效不能继续换票。
4. 模拟 SSO 不可用：现有 Token 到期前继续，到期后明确暂停；恢复后同账号可继续，任务未被取消。
5. SSO 明确撤销：下一次换票拒绝；已签发离线 access 的剩余窗口符合 TTL，不能宣称立即全局退出。
6. 同一员工在两个后台映射同一 Mao 用户；切换员工后看不到前一人的缓存与会话内容。
7. 人工检查浏览器存储、网络 URL、服务日志、审计、WS 调试日志无原始凭证泄露。
8. 原账号密码/LDAP/飞书登录及既有 SDK `getToken` 模式回归通过。

## 12. 发布限制与回退

- SSO 校验接口未联调、邮箱可信保证未落定、并发关联测试未通过，属于上线阻塞，不做“暂时按前端邮箱登录”的降级。
- 关闭 SSO 接入开关只停止换票；已签发 access 至到期前仍可能有效，不能把关闭开关当作即时撤销。
- 回退 SDK 会停止新接入的 SSO 模式；必须同时撤回宿主新增配置，不能让旧 SDK 接收不认识的参数。
- 不删除已创建用户、身份关系或历史会话来回退；数据库迁移采取前向保留方式。
- 公司 SSO、Mao 与网络不可用时无法保证无限连续使用；本方案保证正常条件下凭证轮换无感，不承诺离线认证。
- 等权 Token 的实际能力仍取决于现有 Mao 路由权限检查；本方案不宣称修复了全部历史授权缺口。

## 13. 最终交付定义

实现完成后，接入方仅需引入 SDK 并提供读取当前 SSO Token 的初始化回调；Mao 集中承担官方校验、可信身份绑定、访问凭证签发和自动续期。正常续期不影响连续对话，认证失败不静默降级。

本设计已进入开发。代码、自测与审查结果以开发交付说明为准；真实公司 SSO 的停用/撤销联调和生产部署仍须另行执行，不以合成响应测试替代。
