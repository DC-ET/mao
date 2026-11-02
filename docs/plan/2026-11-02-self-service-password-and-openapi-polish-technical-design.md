# 本地账号自助改密与开放接口体验补完技术方案

- 状态：待实施
- 日期：2026-11-02
- 需求来源：[提案：本地用户不用找管理员改密码 —— 自助修改密码与开放接口体验补完](../proposals/2026-11-02-self-service-password-and-openapi-polish.md)（两项决策已定案：改密不踢出、测试投递不写历史表）
- 规模：小~中（三项合计约 2 人日；**零迁移**，不动执行内核）

## 1. 需求背景

### 1.1 现状（代码可查）

| 断点 | 现状 | 代码证据 |
|---|---|---|
| 本地账号无法自助改密 | 后端只有管理员重置接口 `PUT /v1/users/:id/password`（强校验 `user:write`、不验旧密码）；桌面「设置 → 个人信息」对 `LOCAL` 用户无改密入口；管理后台顶栏「修改密码」复用管理员重置接口，弹窗内横幅自认「服务端未提供校验旧密码的自助改密接口」 | `user.routes.ts:101-110`、`ProfileView.vue`（无入口）、`ChangePasswordDialog.vue:9-15` |
| 触发器创建后无法编辑 | 后端 `PUT /v1/open/triggers/:id` 已支持全字段修改（含 `sessionId` 传 `null` 解绑）；desktop api 层 `updateWebhookTrigger` 也已支持 `name/agentId/sessionId`；视图层只有启停按钮传 `{ enabled }`，无编辑入口——想改名/换 Agent/换绑会话只能删了重建，`pathToken` 与 `Secret` 作废，外部系统跟着换 URL | `open.routes.ts:219-230`、`webhook-trigger.service.ts:126-165`、`OpenApiView.vue:122-137, 682-689`、`api/index.ts:762` |
| 出站订阅无连通性测试 | 「消息通知」有「发送测试通知」、「信号哨兵」有「立即测试探针」、「MCP」有「测试连接」；唯独出站订阅配完 `targetUrl` 后无任何测试按钮，只能跑真实任务等回调，`X-Mao-Signature` 验没验过全靠猜 | `OpenApiView.vue:169-181`、对照 `preference.sendTest`、`watcher.service.ts:308` |

### 1.2 要解决的问题

1. 管理员给成员开本地账号、发初始密码后，成员自己改不了密码，还得把新密码交给管理员代改——安全与合规硬伤。
2. 改触发器配置 = 迫使外部系统重新配置 Webhook URL 与 Secret。
3. 对接出站订阅只能盲调，调试周期极长。

### 1.3 关键事实（设计建立在其上）

- `UserService` 已注入 `PasswordHasher`（`{ hash, matches }`，`user/types.ts:50`；`create-app.ts:266` 装配为 `hashPassword` / `matchesPassword`），密码复杂度校验已有私有 `validatePassword`（8~64 位含字母数字，`user.service.ts:263`）。
- `/v1/users/me` VO 已返回 `authSource`（`user.routes.ts:142`）；桌面 `ProfileView.vue` 已有 `isLocalUser` computed；admin 端接口同样返回该字段但 `stores/auth.ts` 的 `User` 接口未声明。
- 触发器服务端 `update` 对 `sessionId` 专门区分 `undefined`（不改）与 `null`（解绑回「每次新建会话」）（`webhook-trigger.service.ts:156-158`）；不传 `enabled` 时 `patch.enabled != null` 不成立，启用态与 `consecutiveFailures` 均不动。
- 出站 HTTP 发送器 `GenericHttpWebhookSender`：10s 硬超时、HMAC 头 `X-Mao-Event` / `X-Mao-Timestamp` / `X-Mao-Signature`（`generic-webhook-sender.ts`），目前由 `app-lifecycle.ts:71` 内联构造、仅注入投递调度器；调度器调用形态为 `sender.send(url, secret, event, payload, hmacSignature)`（`outbound-delivery.scheduler.ts:114`）。
- 订阅 `Secret` 以 AES-GCM 密文存 `secretCipher`（`WebhookSecretCipher`，与任务通知 Webhook 共用 `APP_NOTIFICATION_WEBHOOK_SECRET`）；订阅创建时已过 `assertGenericWebhookUrl`（仅 https、禁 userinfo/锚点）。
- 就绪横幅以 `matchesPassword(DEFAULT_ADMIN_PASSWORD, admin.passwordHash)` 判定「默认密码未改」（`settings/readiness.service.ts:63-69`）——admin 自助改密后该项自动变绿，无需改 readiness。
- Fastify（find-my-way）静态段优先于参数段：`/v1/users/me/password` 不会被 `/v1/users/:id/password` 吞掉（`/v1/users/me/profile` 与 `/v1/users/:id` 同模式已在生产验证）。

## 2. 需求描述

### 2.1 要做的

1. **P1 本地账号自助改密**：后端新增 `PUT /v1/users/me/password`（登录态即可，无权限码）：仅限本地密码账号，校验旧密码、两次输入一致、复杂度合规且新旧不同，通过后仅更新 `passwordHash`，登录态不变；非本地账号明确拒绝。桌面 `ProfileView.vue` 对 `LOCAL` 用户开放「修改密码」弹窗；管理后台 `ChangePasswordDialog.vue` 改调新接口、补「当前密码」输入、删除临时横幅，无 `user:write` 的普通后台角色也能改自己的密码。
2. **P2 触发器编辑**：`OpenApiView.vue` 触发器卡片新增「编辑」按钮，复用新建对话框回填 `name / agentId / sessionId`，保存调既有 `PUT /v1/open/triggers/:id`——`pathToken`（URL）与 `Secret` 保持不变，外部系统零改动。后端与 desktop api 层零改动。
3. **P3 出站订阅测试投递**：后端新增 `POST /v1/open/subscriptions/:id/test`（属主校验），用该订阅真实 `Secret` 同步发送一条带 `test: true` 标记的示例 payload（签名头与真实投递逐字节同方案），返回 `{ success, httpStatus, error, durationMs }`，零写库；前端订阅卡片新增「测试投递」按钮，toast 展示 HTTP 状态码与耗时。

### 2.2 明确不做的

- **不做**找回密码 / 邮件重置链接（自托管内网无公开邮件验证流，忘记密码仍由管理员后台重置）。
- **不做**第三方账号（LDAP / 飞书 / ECP / 公司 SSO）在 Mao 内设置本地密码；两端仅 `authSource === 'LOCAL'` 展示改密入口，后端对非本地账号兜底 400。
- **不做**改密踢出 / JWT 吊销：改密仅更新 `passwordHash`，当前设备与其他已登录设备均保持登录（提案决策 1 定案；要踢出需先引入 token 版本号 / 黑名单，单独立项）。
- **不做**触发器 `pathToken` 与 `Secret` 的编辑：编辑对话框只含名称 / Agent / 绑定会话；Secret 更换走既有「轮换 Secret」按钮。
- **不做**编辑对话框内的启停切换：保留卡片既有启停按钮；编辑保存请求体不携带 `enabled`，启用态原样保留。
- **不做**出站订阅本身的编辑（`event` / `targetUrl` 修改不做，本期订阅写操作仍只有启停与删除）。
- **不做**测试投递落库：不插 `outbound_delivery`、不触发重试调度、不落审计、不计入任何统计（提案决策 2 定案）。
- **不新增**权限码、**不新增**数据库迁移、**不改** DEPLOY.md（无配置 / 部署步骤变化）。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 改密端点形态 | 新增 `PUT /v1/users/me/password`，`requireUserId` 登录态、不挂 `requirePermission` | 与 `/v1/users/me/profile` 同段同范式；复用管理员接口需 `user:write` 且不验旧密码，两者均不可接受 |
| D2 | 改密后登录态 | 仅更新 `passwordHash`，不触碰 JWT | 提案决策 1 定案；与管理后台 `resetPassword` 现行口径一致 |
| D3 | 非本地账号判定 | `!hasText(user.passwordHash)` 即拒绝，不做 authSource 枚举比对 | 与 `updateOwnProfile`、`resolveAuthSource` 的判定同一口径，避免两套真相 |
| D4 | 触发器编辑实现 | 纯前端接线：复用新建对话框 + 既有 `PUT /v1/open/triggers/:id`，后端与 api 层零改动 | 后端（`webhook-trigger.service.ts:126`）与 `updateWebhookTrigger`（`api/index.ts:762`）早已支持全字段，缺的只是视图层 |
| D5 | 触发器编辑范围 | 仅 `name / agentId / sessionId`；`sessionId: null` 显式传参实现解绑 | 服务端 `patch.sessionId !== undefined` 分支现成支持；`enabled`、`pathToken`、`Secret` 不进编辑请求体 |
| D6 | 测试投递实现 | 新增 `POST /v1/open/subscriptions/:id/test`，复用 `GenericHttpWebhookSender.send` + `hmacSignature` 同步发送 | 与调度器真实投递逐字节同一签名方案，接收方验签逻辑无需任何分支；10s 超时内同步返回 |
| D7 | 测试投递写库 | 不写 `outbound_delivery`、不触发重试、不落审计 | 提案决策 2 定案；与「发送测试通知」「立即测试探针」同口径 |
| D8 | 测试事件标识 | payload 统一附 `test: true`，HTTP 头与真实投递完全一致 | 接收方按 `test` 字段区分测试 / 真实；签名验证链路零分支 |
| D9 | sender 装配 | 共享单实例：`create-app.ts` 构造，同时注入 `OutboundSubscriptionService` 与 `OutboundDeliveryScheduler` | 消除 `app-lifecycle.ts:71` 内联构造；类无状态，实例复用零行为差异 |
| D10 | 改密入口可见性 | 两端仅 `authSource === 'LOCAL'` 展示入口；后端兜底拒绝非本地账号 | admin `User` 接口补声明 `authSource`；桌面复用现成 `isLocalUser` |
| D11 | 测试结果展示 | toast（`ElMessage`），不弹窗、不写「最近投递」列表 | 一条结果无需弹窗；零写库意味着「最近投递」列表不会有测试记录，不应制造「测试了却查不到」的困惑 |

## 4. 实现步骤

### 4.1 P1 后端：`PUT /v1/users/me/password`

1. `user.routes.ts` 在 `PUT /v1/users/me/profile`（`user.routes.ts:29`）之后注册：
   - `requireUserId`；**不挂** `requirePermission`。
   - body `{ oldPassword, newPassword, confirmPassword }`；`newPassword == null || newPassword !== confirmPassword` → 400「两次输入的密码不一致」（与 `user.routes.ts:105-107` 同文案）。
   - 调 `userService.changeOwnPassword(userId, body.oldPassword ?? '', body.newPassword)`，成功 `sendOk(reply)`（空数据）。
2. `UserService` 新增 `changeOwnPassword(userId, oldPassword, newPassword)`，按序校验：
   1. `getUser(userId)`；
   2. `!hasText(user.passwordHash ?? undefined)` → 400 `PARAM_INVALID`「当前账号为第三方登录，不支持修改本地密码，请前往对应平台修改」；
   3. `!hasText(oldPassword) || !(await this.passwordHasher.matches(oldPassword, user.passwordHash))` → 400「当前密码不正确」（`hasText` 前置避免 null 进 crypto 比较）；
   4. `newPassword === oldPassword` → 400「新密码不能与当前密码相同」；
   5. `this.validatePassword(newPassword)`（复用既有私有方法，不合规抛 `PASSWORD_INVALID`）；
   6. `await this.userRepo.updateFields(userId, { passwordHash: await this.passwordHasher.hash(newPassword) })`。
3. 不触碰 JWT、不触发 `emailChangeListener`、不加锁（与既有 `resetPassword` 同口径）。

### 4.2 P1 桌面端

1. 新建 `desktop/src/views/settings/ChangePasswordDialog.vue`（el-dialog，480px）：
   - 三字段：当前密码（`show-password`）、新密码、确认新密码；`autocomplete="new-password"`。
   - 前端校验：当前密码必填；新密码 8~64 位含字母数字（正则与后端 `PASSWORD_PATTERN` 一致）；确认一致；新密码 ≠ 当前密码（前端先拦，后端仍兜底）。
   - 提交 `api.put('/users/me/password', { oldPassword, newPassword, confirmPassword })`，成功 `ElMessage.success('密码已修改')` 并关闭；错误由拦截器统一提示。
2. `ProfileView.vue`：`.profile-actions` 内「保存」按钮右侧新增「修改密码」按钮，`v-if="isLocalUser"`，点击打开弹窗。

### 4.3 P1 管理后台

1. `ChangePasswordDialog.vue`：
   - 删除 `el-alert` 横幅（`ChangePasswordDialog.vue:9-15`）与对应样式。
   - 表单首位新增「当前密码」输入框（必填校验）。
   - `handleSubmit` 改为 `api.put('/users/me/password', { oldPassword, newPassword, confirmPassword })`——不再读取 `authStore.user.id`，删除「用户信息未加载」守卫。
   - 新增前端校验「新密码不能与当前密码相同」。
2. `Layout.vue:47`：修改密码菜单项条件由 `v-if="canWrite"` 改为 `v-if="authStore.user?.authSource === 'LOCAL'"`（无 `user:write` 的本地账号角色从此可改自己的密码）。
3. `stores/auth.ts` 的 `User` 接口补 `authSource: string`（`/v1/users/me` 已返回）。
4. `ReadinessBanner` 触发的 `change-password` 事件保持不变（默认密码提示只针对 admin 本地账号）。

### 4.4 P2 触发器编辑（纯前端，`OpenApiView.vue`）

1. 新增状态 `editingTriggerId = ref<number | null>(null)`。
2. 触发器卡片操作区「调用记录」左侧新增「编辑」按钮（`Edit` 图标 + tooltip）。
3. 新增 `openEditTrigger(trigger)`：置 `editingTriggerId`；回填 `triggerForm` 为 `{ name, agentId, sessionId }`；清空 `sessionOptions` 后若 `trigger.sessionId != null` 塞入 `{ id: sessionId, title: `#${sessionId}` }` 保证下拉回显；`agents` 为空则 `fetchAgents()`；打开对话框。
4. 对话框标题（`OpenApiView.vue:211`）改为动态 `:title="editingTriggerId != null ? '编辑 Webhook 触发器' : '新建 Webhook 触发器'"`；底部确认按钮文案按编辑态切「保存 / 保存中…」；`@closed` 的 `resetTriggerForm` 内同时清空 `editingTriggerId`。
5. `submitTrigger` 按编辑态分支：
   - 编辑：`await updateWebhookTrigger(editingTriggerId, { name: name.trim(), agentId, sessionId: triggerForm.sessionId ?? null })`——**显式传 `sessionId: null` 支持解绑**（服务端 `patch.sessionId !== undefined` 分支落 `null`）；**不传 `enabled`**；成功后关弹窗 + `fetchTriggers()`，**不弹 Secret 一次性弹窗**（Secret 未变）。
   - 新建：现有逻辑不变。
   - 表单校验复用同一 `canCreateTrigger` computed。

### 4.5 P3 后端：`POST /v1/open/subscriptions/:id/test`

1. `OutboundSubscriptionService`：
   - `OutboundSubscriptionDeps` 增 `sender: GenericHttpWebhookSender`。
   - 新增 `async sendTest(userId, id): Promise<{ success, httpStatus, error, durationMs }>`：
     1. `subscriptionRepo.findById(id)`；为空或 `subscription.userId !== userId` → 400「订阅不存在」（与 `listRecentDeliveries` 同款，`outbound-subscription.service.ts:105-108`）；
     2. `secret = this.deps.cipher.decrypt(subscription.secretCipher)`；
     3. 按订阅 `event` 构造测试 payload（见下表，字段结构与真实事件同构），统一追加 `test: true` 与 `sentAt: formatDateTime(new Date())`；
     4. `Date.now()` 计时调 `this.deps.sender.send(subscription.targetUrl, secret, event, payload, hmacSignature)`（`hmacSignature` 从 `openapi/hmac.ts` 直接复用）；
     5. 返回 `{ success, httpStatus, error, durationMs }`，**零写库**。
   - 测试对**停用订阅同样可发**（先验证连通再启用的语义）；`targetUrl` 不再过 `assertGenericWebhookUrl`（创建时已校验，测试原样发送存量值）。
2. 测试 payload 构造（service 内私有方法，各 event 占位值定死）：

   | event | payload（除 `test` / `sentAt` 外与真实事件同构） |
   |---|---|
   | `task.completed` | `{ event, sessionId: 0, userId, executionId: null, phase: 'COMPLETED', title: '【Mao 测试】出站订阅连通性验证', failureReason: null, source: 'MANUAL' }` |
   | `task.failed` | 同上，`phase: 'FAILED'`、`failureReason: '【Mao 测试】模拟任务失败'` |
   | `question.pending` | `{ event, sessionId: 0, userId, requestId: '<randomUUID()>' }` |
   | `digest.daily` | `{ event, coveredDate: '<当天 YYYY-MM-DD>', digest: { notice: '测试事件，不含真实数据' }, text: '【Mao 测试】出站订阅连通性验证' }` |

   请求头与真实投递一致：`Content-Type: application/json; charset=utf-8`、`X-Mao-Event`、`X-Mao-Timestamp`、`X-Mao-Signature: sha256=<hex(HMAC-SHA256(secret, `${ts}.${body}`))>`；真实投递链路（`enqueueDeliveries`）**不添加** `test` 字段，二者由此区分。
3. `open.routes.ts` 订阅段（`/v1/open/subscriptions` 管理组内）新增：
   ```ts
   app.post('/v1/open/subscriptions/:id/test', async (req, reply) => {
     const userId = requireJwtIdentity(req);
     const id = requirePositiveId((req.params as { id: string }).id);
     sendJson(reply, 200, ok(await deps.subscriptionService.sendTest(userId, id)));
   });
   ```
4. 装配（D9）：`create-app.ts` 构造 `const genericWebhookSender = new GenericHttpWebhookSender()`，注入 `outboundSubscriptionService` 的 deps（`create-app.ts:668-673` 处）；同一实例经生命周期 deps 传入 `app-lifecycle.ts`，替换 `new GenericHttpWebhookSender()` 内联构造（`app-lifecycle.ts:71`）注入 `OutboundDeliveryScheduler`。

### 4.6 P3 前端

1. `api/index.ts` 新增类型与函数：
   ```ts
   export interface OutboundSubscriptionTestResult { success: boolean; httpStatus: number | null; error: string | null; durationMs: number }
   export async function testOutboundSubscription(id: number): Promise<OutboundSubscriptionTestResult> {
     const { data } = await api.post(`/open/subscriptions/${id}/test`)
     return data
   }
   ```
2. `OpenApiView.vue` 订阅卡片操作区「最近投递」左侧新增「测试投递」按钮（`Promotion` 图标 + tooltip）；`testingId` ref 按订阅维度 loading 防连点；完成后：
   - `success` → `ElMessage.success(`测试成功（HTTP ${httpStatus}，${durationMs}ms）`)`；
   - 失败 → `ElMessage.error(`测试失败：${error ?? '目标不可达'}`)`（`error` 已含「目标返回 4xx/5xx」或超时文案）。
   不弹窗、不刷新「最近投递」列表。

### 4.7 文档同步

- `skills/mao-cli/reference/open-api.md`：触发器 CRUD 增补「编辑」说明（改 `name / agentId / sessionId`，URL 与 Secret 不变，`sessionId: null` 表示解绑）；出站订阅增补 `POST /v1/open/subscriptions/:id/test` 请求 / 响应示例与 `test: true` 识别说明。
- `README.md`：功能列表「开放接口」行与使用指南「开放接口」段补「触发器支持就地编辑（URL 与 Secret 不变）、出站订阅支持一键测试投递」；「治理」行补「本地账号可自助修改密码」。
- `CHANGELOG.md`：新增版本小节，按 backend-ts（后端）/ admin（管理后台）/ desktop 共用 UI（前端）/ skills/mao-cli（终端 CLI）分节记录。
- `DEPLOY.md` **不改**（无配置项、无迁移、无部署步骤变化）。

## 5. 落地变更清单

| 端 | 文件 | 变更 | 新增/修改 |
|---|---|---|---|
| backend-ts | `src/user/user.routes.ts` | 新增 `PUT /v1/users/me/password` 路由（两次一致性校验在路由层） | 修改 |
| backend-ts | `src/user/user.service.ts` | 新增 `changeOwnPassword` | 修改 |
| backend-ts | `src/openapi/outbound-subscription.service.ts` | deps 增 `sender`；新增 `sendTest` 与测试 payload 构造 | 修改 |
| backend-ts | `src/openapi/open.routes.ts` | 新增 `POST /v1/open/subscriptions/:id/test` | 修改 |
| backend-ts | `src/create-app.ts` | 构造共享 `GenericHttpWebhookSender` 注入订阅服务与生命周期 deps | 修改 |
| backend-ts | `src/app-lifecycle.ts` | 调度器改用共享 sender 实例 | 修改 |
| desktop | `src/views/settings/ChangePasswordDialog.vue` | 新建自助改密弹窗组件 | 新增 |
| desktop | `src/views/settings/ProfileView.vue` | `isLocalUser` 显示「修改密码」按钮并接弹窗 | 修改 |
| desktop | `src/views/settings/OpenApiView.vue` | 触发器编辑态与「编辑」按钮；订阅「测试投递」按钮 | 修改 |
| desktop | `src/api/index.ts` | 新增 `changeOwnPassword`、`testOutboundSubscription` 与结果类型 | 修改 |
| admin | `src/views/user/ChangePasswordDialog.vue` | 改调 `/users/me/password`、加「当前密码」、删临时横幅 | 修改 |
| admin | `src/components/Layout.vue` | 修改密码菜单项条件改 `authSource === 'LOCAL'` | 修改 |
| admin | `src/stores/auth.ts` | `User` 接口补 `authSource` | 修改 |
| 文档 | `CHANGELOG.md`、`README.md`、`skills/mao-cli/reference/open-api.md` | 同步 | 修改 |
| 测试 | `backend-ts/src/user/user.service.spec.ts`、`backend-ts/src/openapi/outbound-subscription.service.spec.ts` | 新增用例（见 §7） | 修改 |
| 数据库迁移 | — | **无（零迁移）** | — |

## 6. 影响面与回归护栏

| 风险 | 护栏 |
|---|---|
| 暴力穷举旧密码 | 调用须持有效 JWT；旧密码错误立即拒绝；调用面与管理后台 `resetPassword` 同级，本期不额外引入限流（与登录接口现状一致） |
| `/v1/users/me/password` 被 `/v1/users/:id/password` 吞掉 | find-my-way 静态段优先于参数段，`/v1/users/me/profile` 同模式已在产验证；spec 断言新端点可达 |
| 触发器编辑误改启用态 / Secret | 编辑请求体不含 `enabled`（服务端 `patch.enabled != null` 分支不触发）；`pathToken` / `secretCipher` 不在请求体；spec 断言编辑后二者不变 |
| `sessionId` 解绑不生效 | 前端显式传 `sessionId: null`（非 `undefined`）；服务端 `patch.sessionId !== undefined` 分支落 `null`（`webhook-trigger.service.ts:156` 现成）；spec 覆盖解绑路径 |
| 测试事件被接收方当真实事件处理 | payload 统一 `test: true`；`X-Mao-Event` 头不变；手册与 UI 文案说明识别方式；真实投递链路不带 `test` 字段 |
| sender 共享化引入调度回归 | `GenericHttpWebhookSender` 无状态、构造参数不变，仅实例复用；既有 `outbound-delivery.scheduler` 相关测试不动保持全绿 |
| 改密后其他设备旧 JWT 仍有效 | 已知取舍（提案决策 1）：与管理后台代改密同口径；README / 手册明示；要踢出需先立项 token 版本号 / 黑名单 |
| 订阅测试地址指向内网 | 创建时已过 `assertGenericWebhookUrl`（仅 https、禁凭据 / 锚点）；sender 10s 硬超时；测试不新增 SSRF 面 |
| 非属主越权测试他人订阅 | `findById` 后严格比对 `userId`，不符统一 400「订阅不存在」（不泄露资源存在性） |

## 7. 测试要点

### 7.1 后端单测（Vitest）

1. `changeOwnPassword`（`user.service.spec.ts`）：
   - 本地账号正确旧密码 + 合规新密码 → `updateFields` 收到新 `passwordHash`，且新哈希 `matches(newPassword)` 通过；
   - 旧密码错误 / 旧密码为空 → 400「当前密码不正确」；
   - 新旧密码相同 → 400「新密码不能与当前密码相同」；
   - 新密码不合规（过短 / 纯数字 / 超 64 位）→ `PASSWORD_INVALID`；
   - `passwordHash` 为空（模拟飞书 / LDAP / ECP / SSO 账号）→ 400「当前账号为第三方登录…」；
   - 成功路径不触发 `emailChangeListener`、不写 `updateById` 整行。
2. 改密路由（挂到既有路由层测试或 spec 内联）：`newPassword !== confirmPassword` → 400「两次输入的密码不一致」；无 `user:write` 的普通用户（mock 权限服务）调用成功——证明未挂权限。
3. `sendTest`（`outbound-subscription.service.spec.ts`）：
   - 属主 + 假 sender（注入 `FetchLike` stub）→ 返回 `{ success: true, httpStatus, durationMs > 0 }`；断言 sender 收到 `url / secret（解密后）/ event / payload` 与 `hmacSignature` 函数；
   - 非属主 / 不存在 id → 400「订阅不存在」，且未调用 sender；
   - 四种 event 的 payload 断言：字段结构与 §4.5 表一致、`test === true`、`sentAt` 非空；
   - 零写库：断言 `deliveryRepo.insert` 从未被调用；
   - 停用订阅仍可测试；目标 5xx / 网络异常时 `success: false` 且 `error` 透传（超时 → `httpStatus: null`）。

### 7.2 手工 / 集成验收

1. P1：本地账号在桌面「设置 → 个人信息」改密 → 用新密码重新登录成功、旧密码登录失败；改密后**当前会话不退出**、原 JWT 仍可调 `/v1/users/me`（决策 1）；管理后台无 `user:write` 角色顶栏可见「修改密码」且可成功改密；admin 自助改密后就绪横幅「默认密码未改」项自动变绿；第三方登录账号两端均不展示入口，直接调接口返回 400 明确文案。
2. P2：改名、换 Agent、绑定会话、清空下拉解绑（`sessionId: null`）均生效；编辑后触发器 URL 与 Secret 不变（外部系统无需改动）；编辑保存后启用态与「连续失败」计数不变。
3. P3：对可公网可达的 HTTPS 接收端点点「测试投递」→ toast 展示 HTTP 状态与耗时；抓包验证 `X-Mao-Signature` 可用订阅 Secret 按 `sha256=HMAC(secret, ts.body)` 验过、`X-Mao-Event` 值正确、payload 带 `test: true`；「最近投递」列表仍为空（零写库）；对停用订阅可测试；对不存在 / 他人订阅返回 400。

### 7.3 构建验证

- `cd backend-ts && npm run build && npm test`（长输出落盘 grep 摘要）；
- `cd desktop && npm run build`、`cd admin && npm run build`（`vue-tsc -b && vite build`，**禁用** `npx vue-tsc --noEmit` 假通过路径）。

## 8. 实施顺序与验收清单

实施顺序：后端 P1 → 后端 P3（含装配）→ 桌面三项 → admin 改造 → 文档 / CHANGELOG → 全量构建回归。

- [ ] `PUT /v1/users/me/password` 路由 + `changeOwnPassword`（含全部 400 分支与文案）
- [ ] `user.service.spec.ts` 用例全绿
- [ ] `POST /v1/open/subscriptions/:id/test` 端点 + `sendTest`（零写库、四种 payload、属主校验）
- [ ] `outbound-subscription.service.spec.ts` 用例全绿
- [ ] sender 共享化（create-app 构造、app-lifecycle 复用），既有调度测试不回归
- [ ] desktop 改密弹窗 + ProfileView 入口（仅 LOCAL）
- [ ] desktop 触发器编辑（含解绑 `null` 路径、不传 `enabled`、不弹 Secret 弹窗）
- [ ] desktop 订阅「测试投递」按钮与 toast
- [ ] admin ChangePasswordDialog 改造 + Layout / auth store `authSource`
- [ ] backend-ts build + test 全绿；desktop / admin `npm run build` 全绿
- [ ] CHANGELOG.md 新版本小节、README.md、skills/mao-cli/reference/open-api.md 同步完成
- [ ] 手工验收三件套：改密后 readiness 变绿且原 JWT 仍登录；订阅测试抓包验签且不产生投递记录；触发器编辑后外部 URL 不变
