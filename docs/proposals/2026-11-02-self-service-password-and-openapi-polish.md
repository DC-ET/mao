# 提案：本地用户不用找管理员改密码 —— 自助修改密码与开放接口体验补完

> 在 `admin/src/views/user/ChangePasswordDialog.vue` 第 14 行有一条横幅，原话写着：
> **「服务端未提供『校验旧密码』的自助改密接口，此处复用管理员重置密码接口直接设置新密码。」**
> 这直接带来两个问题：① 普通本地账号用户（无 `user:write` 权限）在桌面端「设置 → 个人信息」里**根本没有修改密码的入口**，管理员建号发了初始密码后，用户自己改不掉；② 管理后台如果给某个运营角色不开 `user:write`，连管理员自己在后台顶栏点「修改密码」都会 403，而开了 `user:write` 改自己密码居然连旧密码都不校验。
> 与此同时，同属「账号与外部接入配置」的「设置 → 开放接口」里也有两处明显断层：Webhook 触发器建好后**列表里只能停用/删除，改不了名称、换不了 Agent 或绑定会话**（后端 `PUT /v1/open/triggers/:id` 早已支持全字段修改，前端却只用来切 `enabled` 开关）；出站订阅建好后**没有像「消息通知 → 发送测试通知」那样的「发送测试事件」按钮**，用户配完 HTTPS 回调地址只能干等真实任务跑完才知道签名验没验过。

- 状态：提案（待评审；2026-11-02 待决策 2 项已按推荐定案，见 §8）
- 日期：2026-11-02
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小~中（三项合计约 2 人日；**零迁移**，不动执行内核）
- 关联：`backend-ts/src/user/user.routes.ts`、`backend-ts/src/user/user.service.ts`、`desktop/src/views/settings/ProfileView.vue`、`admin/src/views/user/ChangePasswordDialog.vue`、`desktop/src/views/settings/OpenApiView.vue`、`backend-ts/src/openapi/open.routes.ts`、`backend-ts/src/openapi/outbound-subscription.service.ts`

## 1. 背景与现状

### 1.1 三处已有后端底座但前端/接口差一口气的断点（代码可查）

| 断点 | 现状 | 代码证据 |
|---|---|---|
| **本地账号无法自助改密** | 后端只有 `PUT /v1/users/:id/password`（强校验 `user:write` 权限，且不验旧密码）；桌面端 `ProfileView.vue` 对 `LOCAL` 用户只展示显示名称与邮箱，无修改密码入口；管理后台 `ChangePasswordDialog.vue` 直接挂了 `el-alert` 坦承「服务端未提供校验旧密码的自助改密接口」 | `user.routes.ts:101-110`、`ProfileView.vue:52-80`、`ChangePasswordDialog.vue:9-15` |
| **Webhook 触发器创建后无法编辑** | 后端 `PUT /v1/open/triggers/:id` 已完整实现修改 `name`、`agentId`、`sessionId`（含换绑或解绑回「每次新建会话」）；但桌面端 `OpenApiView.vue` 的 `toggleTrigger` 只传了 `{ enabled: !trigger.enabled }`，卡片上没有「编辑」按钮，想换绑会话或改名只能删掉重建（重建会导致 `pathToken` 与 `Secret` 全部作废，外部系统得跟着重新配一遍 URL！） | `open.routes.ts:219-230`、`webhook-trigger.service.ts:126-165`、`OpenApiView.vue:122-137, 682-689` |
| **出站事件订阅无法一键测试连通性** | 「设置 → 消息通知」有「发送测试通知」按钮，「设置 → 信号哨兵」有「立即测试探针」，「设置 → MCP」有「测试连接」；唯独「设置 → 开放接口 → 出站订阅」配好 `targetUrl` 后没有任何测试按钮，且最近投递弹窗看不到 payload 详情 | `OpenApiView.vue:169-182`、`outbound-subscription.service.ts` |

### 1.2 真实痛点

1. **安全与合规硬伤**：自托管团队里管理员给成员开本地账号（`authSource === 'LOCAL'`），成员拿到初始密码登录后想改成自己的密码，翻遍「设置 → 个人信息」找不到入口，只能找管理员在后台代改——管理员还得知道他的新密码。
2. **改触发器配置 = 迫使外部系统换 Webhook URL**：用户把触发器从 Agent A 换到 Agent B，或者想从「每次新建会话」改成「绑定某个固定会话」，因为界面没接上后端已有的 `PUT /v1/open/triggers/:id` 编辑表单，只能删了重建，外部 CI / 工单系统配好的 URL 和 HMAC Secret 当场失效。
3. **对接出站订阅盲调**：开发者写好接收 Mao 出站 Webhook 的服务端接口（要验 `X-Mao-Signature` 和 `X-Mao-Timestamp`），没有「发送测试事件」按钮，只能去跑一轮真 Agent 任务来触发回调，调试周期极长。

## 2. 目标 / 非目标

**目标**

1. **P1 本地账号自助修改密码（含旧密码校验）**：
   - 后端新增 `PUT /v1/users/me/password`（登录态即可，无需 `user:write`）：仅限本地密码账号（`hasText(user.passwordHash)`），校验 `oldPassword` 与当前 `passwordHash` 匹配、校验 `newPassword === confirmPassword` 且符合密码复杂度（8~64 位含字母数字）、且新旧密码不同，通过后更新 `passwordHash`；非本地账号（飞书 / ECP / SSO / LDAP）调用时明确拒绝「第三方登录账号请前往对应平台修改密码」。改密成功仅更新 `passwordHash`，**当前登录态保持不变**（不踢出、不要求重新登录；决策 1）。
   - 桌面端 `ProfileView.vue`：当 `isLocalUser` 为真时，在资料卡片下方新增「修改密码」区块/按钮（旧密码 / 新密码 / 确认新密码）。
   - 管理后台 `ChangePasswordDialog.vue`：改为调用 `PUT /v1/users/me/password` 并补上「当前密码」输入框，删掉那条尴尬的「服务端未提供校验旧密码的自助改密接口」提示条；同时让没有 `user:write` 权限的普通后台角色也能改自己的密码。
2. **P2 Webhook 触发器补齐编辑能力（零后端改动）**：
   - `OpenApiView.vue` 触发器卡片操作区增加「编辑」按钮，复用新建触发器对话框（预填当前名称、目标 Agent、绑定会话），保存时调已有的 `PUT /v1/open/triggers/:id`——**保持 `pathToken`（URL）与 `Secret` 不变**，外部系统零改动。
3. **P3 出站订阅新增「发送测试事件」**：
   - 后端新增 `POST /v1/open/subscriptions/:id/test`（属主校验）：用已有的 `GenericHttpWebhookSender.send` 与该订阅的真实 `secret` 同步发送一条示例 payload（带 `test: true` 标记与真实 `X-Mao-Signature` / `X-Mao-Event` 头），**不写入 `outbound_delivery` 历史表**，仅同步返回 `{ success, httpStatus, error, durationMs }`（决策 2，与「消息通知 → 发送测试通知」「信号哨兵 → 立即测试探针」不写历史表的口径一致），前端立即弹窗展示 HTTP 状态码与耗时，一秒验证签名与连通性。

**非目标**

- 不做「找回密码 / 邮件重置密码链接」（自托管内网环境无公开邮件验证流，忘记密码仍由管理员在后台重置）。
- 不允许 LDAP / 飞书 / ECP / 公司 SSO 账号在 Mao 内设置本地密码（严格保持单点登录身份边界）。
- 不改 JWT 无状态吊销机制（与管理员重置密码保持同口径）。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 开放接口调用中心（已实施，0.0.255） | 调用中心管的是**入站** API/Webhook 流水；本提案补的是触发器编辑（前端未接已有后端）与**出站**订阅连通性测试。 |
| 平台扩张 / MCP Server 输出（2026-10-25 否决） | 不新增任何对外公开协议端点，全是登录态下的个人设置闭环。 |

## 4. 方案设计

### 4.1 P1：自助改密 `PUT /v1/users/me/password`

- **路由**：与既有 `PUT /v1/users/me/profile` 同挂 `me` 段（`user.routes.ts:29` 旁），`requireUserId` 登录态即可，**不挂 `requirePermission`**（无需 `user:write`）；body `{ oldPassword, newPassword, confirmPassword }`，`newPassword !== confirmPassword` 在路由层直接拒（与 `user.routes.ts:105-107` 同款「两次输入的密码不一致」）。
- **`UserService.changeOwnPassword(userId, oldPassword, newPassword)`**：
  1. 查用户，若 `!hasText(user.passwordHash)` 抛 `PARAM_INVALID`（「当前账号为第三方登录，不支持修改本地密码」——飞书 / ECP / SSO / LDAP 一律回各自平台改密，与 `updateOwnProfile` 对非本地账号的收窄口径一致）；
  2. `!(await this.passwordHasher.matches(oldPassword, user.passwordHash))` → 抛 `PARAM_INVALID`（「当前密码不正确」）（`matches` 为 `user/types.ts:52` 既有接口）；
  3. `newPassword === oldPassword` → 抛 `PARAM_INVALID`（「新密码不能与当前密码相同」）；
  4. `this.validatePassword(newPassword)`（复用既有私有方法，8~64 位含字母数字）；
  5. `await this.userRepo.updateFields(userId, { passwordHash: await this.passwordHasher.hash(newPassword) })`。
- **登录态保持不变（决策 1）**：成功路径只更新 `passwordHash`，不触碰 JWT——当前设备与其他已登录设备均保持登录，与管理后台现行代改密（`resetPassword` 同样无吊销逻辑）行为一致。
- **管理后台就绪横幅联动**：`readiness.service.ts:68-69` 以 `matchesPassword(DEFAULT_ADMIN_PASSWORD, admin.passwordHash)` 判定「默认密码未改（admin123）」，管理员通过升级后的 `ChangePasswordDialog` 自助改密后，就绪横幅照常自动变绿，零额外改动。

### 4.2 P2：Webhook 触发器编辑（纯前端接通）

- `OpenApiView.vue` 的 `WebhookTriggerView` 列表已返回 `id, name, agentId, sessionId, enabled`；桌面 api 层 `updateWebhookTrigger`（`api/index.ts:762`）也早已支持 `name / agentId / sessionId` 全字段——今天只有 `toggleTrigger`（`OpenApiView.vue:682-689`）在用时仅传了 `{ enabled }`，缺的只是视图层接线；
- 新增 `editingTriggerId` 状态：点「编辑」打开同一 `triggerDialogVisible`（标题按 `editingTriggerId != null` 切为「编辑 Webhook 触发器」，`@closed` 时清空该状态），回填 `name / agentId / sessionId`（若 `sessionId != null`，预先把 `#sessionId` 塞入 `sessionOptions` 以便下拉正常回显，清空下拉即传 `sessionId: null` 切回「每次新建会话」）；
- 保存调 `updateWebhookTrigger(editingTriggerId, { name, agentId, sessionId })`，**不传 `enabled`**（路由层转 `null`，服务端 `patch.enabled != null` 分支不触发，启用态原样保留），也不弹 Secret 一次性弹窗（Secret 未变）。

### 4.3 P3：出站订阅测试 `POST /v1/open/subscriptions/:id/test`

- **路由**：沿用订阅段既有范式——`requireJwtIdentity` + `requirePositiveId`；归属校验 `subscriptionRepo.findById(id)` 且 `userId` 不符抛 `PARAM_INVALID「订阅不存在」`（与 `listRecentDeliveries:105-108` 同款）。
- **`OutboundSubscriptionService.sendTest(userId, id)`**：
  - 校验订阅归属当前用户；解密 `secretCipher`；
  - 按订阅 `event` 构造与真实事件同结构的示例 payload（如 `task.completed` 带上 `sessionId / title / phase` 等字段的假数据），统一附 `test: true` 与 `sentAt`——接收方可据此把测试事件与真实事件区分开；
  - 调用 `GenericHttpWebhookSender.send(sub.targetUrl, secret, sub.event, payload, hmacSignature)`（`openapi/hmac.ts` 的签名函数与调度器投递逐字节同方案；发送器内置 10s 硬超时），`durationMs` 在 service 内计时；
  - 返回 `{ success, httpStatus, error, durationMs }`，**零写库**：不插 `outbound_delivery`、不触发重试调度（决策 2）。先例：信号哨兵「立即测试探针」`watcher.service.ts:308` 注释原文「不触发、不写库」；任务通知「发送测试通知」`preference.sendTest` 同样直发不落历史。
- **装配**：`GenericHttpWebhookSender` 实例目前在 `app-lifecycle.ts:67-71` 内联构造给调度器，P3 将其提出为共享实例，同时注入 `OutboundDeliveryScheduler` 与 `OutboundSubscriptionService` 的 deps。
- **前端**：`OpenApiView.vue` 订阅行操作区新增「测试投递」图标，`api/index.ts` 增 `testOutboundSubscription(id)`，结果 toast 或弹窗展示（如 `测试成功（HTTP 200，42ms）` 或 `测试失败：目标返回 401`）。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | `user.routes.ts` / `user.service.ts` 新增 `PUT /v1/users/me/password`；`open.routes.ts` / `outbound-subscription.service.ts` 新增 `POST /v1/open/subscriptions/:id/test`；`app-lifecycle.ts` 将 `GenericHttpWebhookSender` 实例提出并同时注入调度器与订阅服务 |
| desktop | `ProfileView.vue` 新增本地账号修改密码弹窗/表单；`OpenApiView.vue` 触发器增加「编辑」按钮（补 `editingTriggerId` 编辑态）、出站订阅增加「测试投递」按钮；`api/index.ts` 增 `testOutboundSubscription` |
| admin | `ChangePasswordDialog.vue` 改调 `/v1/users/me/password`，增加「当前密码」输入，移除临时提示横幅 |
| skills/mao-cli | 手册同步说明本地用户自助改密与触发器编辑、出站订阅测试 |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 暴力穷举 `oldPassword` | 复用登录接口同级的错误处理；必须已持有有效 JWT 才能调用，且旧密码错误立即拒绝 |
| 触发器编辑时把 `sessionId` 从有值改为「每次新建会话」（`null`）后端不生效 | 检查 `webhook-trigger.service.ts:156`：`if (patch.sessionId !== undefined) fields.sessionId = patch.sessionId;`，后端早已专门区分了 `undefined`（不改）与 `null`（清空绑定），前端传 `null` 即可精准解绑 |
| 出站订阅测试地址指向内网 | 出站订阅创建时已过 `assertGenericWebhookUrl`（仅 https），且 `GenericHttpWebhookSender` 10s 硬超时，测试不会产生额外 SSRF 面 |
| 改密后其他已登录设备仍持有有效 JWT（无状态吊销） | 决策 1 已知取舍：仅更新 `passwordHash`，与管理后台代改密同口径；若未来要「改密即全局踢出」需先引入 token 版本号 / 黑名单机制，单独立项，本期不做 |
| 接收方把测试事件当作真实事件处理 | payload 统一附 `test: true` 标记（与 `X-Mao-Event` 头并用），桌面 UI 提示与 mao-cli 手册均说明测试事件的识别方式 |

## 7. 测试要点

1. `PUT /v1/users/me/password`：正确旧密码 + 合规新密码成功更新且可用新密码登录；旧密码错误 400；新密码不合规 400；新密码与旧密码相同 400；两次密码不一致 400；飞书/LDAP 无本地密码账号调用返回 400；**改密成功后原 JWT 仍可正常调用 `/v1/users/me`（不踢出，决策 1）**；admin 自助改密后 readiness「默认密码未改」项自动变绿。
2. 触发器编辑：修改名称、更换 Agent、绑定会话与解绑会话（传 `sessionId: null`）均成功，且 `pathToken` 与 `secretCipher` 保持不变；编辑保存不传 `enabled` 时启用态原样保留。
3. 出站订阅测试：属主调用返回目标 HTTP 状态码与耗时；非属主调用 400/404 拒绝；**测试不产生 `outbound_delivery` 投递记录（`listRecentDeliveries` 仍为空，决策 2）**；测试 payload 带 `test: true`，且 `X-Mao-Signature` 可用订阅 secret 按既有 HMAC 方案验过。

## 8. 决策记录（2026-11-02 定案）

原 2 项待确认决策已按推荐定案：

1. **自助改密成功后保持当前登录态，不踢出**（原推荐项）。JWT 无状态、服务端无会话吊销列表，改密仅更新 `passwordHash`；当前设备与其他已登录设备均保持登录，与管理后台现行代改密行为一致，体验连贯。若未来要「改密即全局踢出」，需先引入 token 版本号 / 黑名单机制，单独立项。
2. **出站订阅「测试投递」不写 `outbound_delivery` 历史表，仅同步返回测试结果**（原推荐项）。测试数据不污染真实投递记录与统计口径，与「消息通知 → 发送测试通知」（`preference.sendTest` 直发）和「信号哨兵 → 立即测试探针」（`watcher.service.ts`「不触发、不写库」）完全同口径；测试事件与真实事件经 payload 的 `test: true` 标记区分。
