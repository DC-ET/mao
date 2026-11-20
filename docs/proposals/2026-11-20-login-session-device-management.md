# 提案：登录会话与设备治理 —— 我的设备、强制下线与登录防护

> 平台的账号体系是「管理员手工开号 + 外部登录 JIT 建号」的最小闭环：自助改密（批次 20）与在线设备只读页（2026-11-10）补了可见性，但**会话本身仍完全不受治理**——认证是无状态 JWT（access/refresh/shell 三种），服务端不存任何会话记录，登出只是客户端丢 token，改密也不吊销已发凭证；用户看不到自己在哪些设备上登录，管理员对「在线设备」只能看不能管。对一个自托管的**团队级**平台，这是安全面的最后一块明显短板：员工离职只停账号不停设备、token 泄露后无法远程止损、密码重置（管理员线下传新密码）后旧设备依旧在线。本提案把「会话」从纯客户端状态升级为服务端可登记、可吊销的资源，并补上登录暴力破解的基础防护，全部为增量端点与增量校验点，**不改任何既有凭证的签发与验证语义**。

- 状态：已否决（2026-11-20 评审：范围过大，不立项；其中「登录失败锁定」拆出单独实施，其余不做）
- 日期：2026-11-20
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：中（约 3-4 人日；1 个迁移 `V199 user_login_session`；后端 auth/user + desktop 设置页 + admin 用户详情）
- 关联：`backend-ts/src/auth/auth.service.ts`（refresh 换发 :54-67、登出 :69-71）、`backend-ts/src/user/user.service.ts`（改密 :174-179）、`backend-ts/src/session/ws/streaming-ws-handler.ts`（建连/续期账号状态校验 :622-624、:2853-2855）、`backend-ts/src/session/ws/streaming-ws-registry.ts`（listConnections :644）、`admin/src/views/statistics/OnlineDevicesView.vue`（只读快照页）、`backend-ts/src/audit/audit.interceptor.ts`（`/v1/auth` 排除 :34）

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 会话存储 | 无状态 JWT（HS256），服务端零会话记录；登出仅客户端丢 token | `auth.service.ts:69-71` 注释明说 stateless |
| refresh 换发 | 只复查账号状态，不校验该凭证是否已作废 | `auth.service.ts:54-67` |
| 改密 / 管理员重置密码 | 只重写 passwordHash，「改密不踢出、不要求重新登录」 | `user.service.ts:174-179` 注释 |
| 用户侧设备可见性 | 无任何「我的设备 / 登录会话」端点与页面 | `app-routes.ts` 仅 WS/终端内部使用 deviceId |
| 管理员踢人 | 无入口；唯一手段是禁用账号（间接全端生效） | `app-hooks.ts:52-80`（30s 负缓存）+ WS `closeConnection`（`streaming-ws-handler.ts:622-624`） |
| 在线设备页（2026-11-10） | 管理员只读 WS 内存快照：15s 轮询、仅刷新与复制设备 ID，无踢出按钮 | `statistics.service.ts:188-238`、`OnlineDevicesView.vue:180-211` |
| 登录暴力破解防护 | 无失败锁定、无验证码、`/v1/auth/login` 无限流（限流仅存在于 SSO 换票与 OpenAPI） | `auth.service.ts:27-43`、`company-sso.service.ts:10-24` |
| 登录审计 | `/v1/auth/*` 被审计拦截器整体排除，登录成败不留痕 | `audit/audit.interceptor.ts:34` |
| 已有的地基 | 客户端已持有 deviceId（WS 建连按 (userId, deviceId) 去重）；lastLoginAt 已落库 | `streaming-ws-registry.ts`、`auth.service.ts:49` |

## 2. 目标 / 非目标

**目标**

1. **P1 服务端登录会话登记**：新表 `user_login_session`——refresh 换发时按 (userId, deviceId) upsert 一行（clientType / 设备名 / IP / UA / 最近活跃）。客户端三端已持有 deviceId，refresh 请求携带即可；未携带时按单条匿名会话登记（不阻塞旧客户端）。**存量 JWT 语义零变化**：签发、验签、TTL 口径全部不动。
2. **P1 吊销与强制下线**：设备行标记 revoked 后——refresh 换发拒绝、WS 建连/续期在**既有账号状态校验点**（`streaming-ws-handler.ts:622-624`）追加吊销校验并断开、WS registry 按 (userId, deviceId) 主动 close。诚实边界：已签发的 access token 在剩余时效内仍可完成 REST 请求（与「禁用账号 30s 负缓存」同量级的窗口，TTL 口径在技术方案里敲定）；refresh 与 WS 即时生效。
3. **P1 用户侧「我的设备」**：桌面端 `设置 → 安全` 新页——设备列表（clientType、设备名/IP 摘要、最近活跃、当前设备标记），支持「下线单台」（当前设备除外）与「下线其他设备」。
4. **P2 管理员侧治理**：admin 用户详情抽屉新增「登录设备」区块（读持久化表，可吊销任意设备）；`OnlineDevicesView` 保持只读快照定位不变，每行加跳转到该用户的设备区块（避免两个页面职责混淆）。
5. **P2 登录失败锁定**：仅本地密码登录路径——按 (用户名, IP) 滑动窗口计数，连续 5 次失败锁 15 分钟（env 可配），锁定返回明确中文文案与剩余时间。LDAP / 飞书 OAuth / ECP / Company SSO 流程不动。
6. **P2 认证事件进审计**：登录成功 / 失败 / 锁定触发 / 登出 / 吊销踢出显式写审计日志（带来源 IP 与 clientType）——**不解除** `/v1/auth/*` 的整体排除（否则每次 refresh 都会刷屏），由 auth service 在关键动作处显式落一条。
7. **P2 改密联动**：自助改密与管理员重置密码弹窗增加「同时下线其他设备」勾选（默认勾选与否为评审决策点）；勾选后吊销除当前会话外的全部设备行。

**非目标**

- 不做 2FA / TOTP、验证码、异地登录通知（通知渠道属任务通知体系，不混入登录事件；需要时另案）。
- 不做注册开放 / 邀请链接（用户来源仍为管理员创建与外部登录 JIT）。
- 不做密码找回邮件（避免部署强依赖 SMTP）。
- 不做 token 无状态吊销名单（jti 黑名单）——以设备粒度的持久化会话为准，粒度够用且可解释。
- 不改 LDAP / SSO / ECP 换票流程、不改 shell token 语义。

## 3. 与已落地 / 已否决方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 自助改密（批次 20 已落地） | 那是凭证变更入口；本提案治理的是凭证发出后的会话生命周期 |
| 在线设备页（2026-11-10 已落地） | 那是 WS 实时快照（重启即清零、无历史）；本提案是持久化登记 + 吊销动作，快照页定位不变 |
| 跨任务审批收件箱（批次 21 否决） | 无关——不碰审批面 |
| 数据保留与可携带（批次 4 否决） | 登录会话表的生命周期治理（过期行定期清理）随本提案一并给出简单口径，不引入通用数据寿命框架 |

## 4. 方案设计

- **表结构**：`user_login_session`（BIGINT 自增、user_id 索引、device_id、client_type、device_name、last_ip、user_agent、created_at、last_active_at、revoked_at nullable）——(user_id, device_id) 唯一，吊销即写 revoked_at，不删行（历史可审计）。
- **登记点**：`POST /v1/auth/refresh` 响应前 upsert + 刷新 last_active_at；吊销校验放在 upsert 之前（revoked 直接拒绝换发）。
- **吊销动作**：`DELETE /v1/auth/sessions/:id`（本人）与 `POST /v1/admin/users/:id/sessions/:sessionId/revoke`（管理员，`user:write`）→ 写 revoked_at → 经 registry 按 (userId, deviceId) 关闭活跃 WS 连接。
- **用户端点**：`GET /v1/auth/sessions`（本人列表，当前请求的 deviceId 标记 `current`）；设备名由客户端首登时上报（桌面用主机名，Web 用 UA 摘要，安卓用机型，均可后改）。
- **登录锁定**：内存滑动窗口 Map（进程内即可，多实例部署本平台当前为单实例；重启清零可接受），env：`LOGIN_MAX_FAILURES`（默认 5）/ `LOGIN_LOCK_MINUTES`（默认 15）。LDAP 等外部认证路径显式绕过。
- **审计落点**：auth.service 显式调用 audit 写入（复用既有 audit service），objectType=`auth`，action 枚举 LOGIN / LOGIN_FAILED / LOGIN_LOCKED / LOGOUT / SESSION_REVOKED。
- **desktop**：设置页新增「安全」分组（与「个人信息」同级），列表 + 吊销按钮 + 二次确认；吊销当前设备等价登出。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | 迁移 V199；auth（refresh 登记与吊销校验、锁定、显式审计）、user（管理员吊销端点、改密联动）、registry（按 userId+deviceId 关闭）；新增 spec |
| desktop | 设置 → 安全页（设备列表 / 吊销 / 改密勾选）；refresh 请求补 deviceId |
| admin | 用户详情抽屉「登录设备」区块；`OnlineDevicesView` 加跳转 |
| android | 共用 Web 设置页即生效；refresh 补 deviceId（壳内 Web 同步受益） |
| agent-cli | `local --serve` 与 REPL 的 refresh 逻辑补 deviceId（不补则登记为匿名会话，不阻塞） |
| 数据库迁移 | 1 个（V199） |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 旧客户端不携带 deviceId 导致登记质量差 | 未携带按匿名会话登记且不阻塞换发；三端随版本自然升级（与 0.0.527 capabilities 分层同口径） |
| 吊销后 access token 短窗口仍可用 | 窗口与「禁用账号」既有量级相同；技术方案敲定 access TTL 与「高危动作二次校验账号状态」的取舍，不静默扩大承诺 |
| 锁定误伤（用户自己连输错） | 锁定文案明确给出剩余时间与「稍后再试」；按 (用户名, IP) 而非全局 IP，避免办公室出口 IP 连坐；管理员不受旁路 `admin/login` 影响（该端点保持现状） |
| refresh 高频写表 | upsert 为主路径（无新增行），仅 last_active_at 更新；可加节流（如 5 分钟内不重复刷） |
| WS 关闭误伤共享 deviceId 的多标签页 | 同 deviceId 多连接一并关闭属预期语义（同一设备）；文案说明「该设备所有 Mao 页面将退出」 |
| 审计噪音 | 仅 5 类关键事件显式落库，refresh / token 换发不落 |

## 7. 测试要点

1. 登录 → 设备行产生；refresh 后 last_active_at 更新；同设备重复 refresh 不新增行。
2. 用户吊销其它设备：该设备 refresh 拒绝、活跃 WS 被断开并收到明确关闭原因；当前设备不受影响。
3. 管理员在用户详情吊销：同上，且写审计；只读角色调管理员端点被拒。
4. 改密勾选「下线其他设备」：其它设备全部吊销；不勾选时行为与现状完全一致（回归口径）。
5. 登录锁定：连续 5 次失败后第 6 次返回锁定文案（含剩余时间）；正确密码在锁定期内同样被拒；LDAP 账号不受影响；窗口过期后恢复。
6. 审计：登录成败 / 锁定 / 吊销各落一条，字段含 IP 与 clientType；refresh 不落。
7. 回归：无 deviceId 的旧版 agent-cli refresh 成功（匿名登记）；WS 建连 / 续期的账号禁用校验行为零变化；`/v1/auth` 整体审计排除不变。
