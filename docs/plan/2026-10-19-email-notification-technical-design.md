# 邮件通知渠道（Email Notification）技术方案

> 状态：已确认（待实施）
> 2026-10-20 评审：结论「可行」，已按评审修订——微信降级白名单放行、SMTP 开关依赖、邮箱清空语义、桌面保存门禁旁路、admin 邮箱校验、测试补充，及三处事实勘误（email 无唯一约束 / desktop api 步骤 no-op / CHANGELOG 版本号）
> 日期：2026-10-19
> 上游提案：[docs/proposals/2026-10-19-email-notification.md](../proposals/2026-10-19-email-notification.md)
> 覆盖端：后端 backend-ts、桌面端 desktop、管理后台 admin、共享契约 shared/contracts
> 迁移编号：V161（当前最新 V160）

---

## 0. 决策记录

以下 8 条决策于 2026-10-19 与需求方逐条追问确认：

| # | 决策 | 结论 |
|---|---|---|
| 1 | 方案范围 | **只做 P1**：实例 SMTP 配置 + 用户通知偏好第三渠道 + 投递链路 + 管理后台 / 桌面 UI。**每日运营摘要邮件出口、管理后台投递流水页明确不做**，从范围中删除 |
| 2 | 收件地址 | **只用 `user.email`**（个人资料邮箱）。保存偏好时校验非空；用户后续修改邮箱时**即时刷新**偏好里已存的收件地址，不停发到旧地址 |
| 3 | SMTP 客户端 | **nodemailer**（TLS / STARTTLS、账号密码认证、HTML + 纯文本多 Part 开箱即用；后端已有 ldapts 等三方依赖先例） |
| 4 | 覆盖场景 | **全部现有通知场景**：任务完成 / 失败 / 提问待答 / 审批待办 / 预算 WARN，以及微信超窗降级推送——复用同一 sender 接口。注意：降级推送非「零额外分支」，`weixin/webhook-fallback.service.ts:70-74` 有 DINGTALK / FEISHU 硬编码白名单，需放行 EMAIL（一行改动，见 §5 步骤表与 §1.1） |
| 5 | 内容形态 | **HTML 正文 + 纯文本备用 Part**（双 Part 邮件）。正文字段与现有 Webhook 文本同源：事件类型、任务标题、结果 / 相位、时间、失败原因 |
| 6 | 会话深链 | **不做**。邮件不含「打开会话」链接；通知管道已计算的 `sessionDetailUrl` 在邮件渲染器中**不使用** |
| 7 | 失败可见性 | **不加收件箱 kind**，与钉钉 / 飞书 Webhook 现状一致：重试耗尽后只落 `task_notification_delivery`（status=FAILED + failureReason），用户侧无提醒 |
| 8 | 测试连接 | 管理后台「测试连接」= 用当前表单配置**发一封测试邮件到管理员自己的 `user.email`**；管理员未填邮箱时拒绝并提示。用户侧「发送测试」沿用既有 test 端点语义，自然发到用户本人邮箱 |

---

## 1. 需求背景

平台的任务通知今天有两个出口：飞书、钉钉（Webhook 形态），外加站内收件箱。`shared/contracts/src/notification.ts:5` 的 `NotificationChannel = 'DINGTALK' | 'FEISHU'` 是全部渠道集合；任务完成 / 失败、提问待答、审批待办、预算 WARN 全部经这两个 Webhook 或站内收件箱送达。大量企业的默认通知面是邮件：领导不看钉钉、外部协作方只认邮件、告警系统默认出口也是邮件。

同时 `user.email` 是一个「收集了从未使用」的字段：`user` 表 `email` 列（`V001__init_schema.sql:7`）为裸 `VARCHAR(128)`——**无 DB 唯一约束**（后续迁移亦未加唯一索引），唯一性仅 `updateOwnProfile` 应用层校验（`countByEmailExcept`），`createUser` 与管理端 `updateUser`（`user.service.ts:94-96`）均不校验；管理后台收集、桌面个人资料页本地用户可自改（`ProfileView.vue:68-69`，`isLocalUser` 门控），全项目没有任何邮件发送能力（SMTP / IMAP 零命中）。衍生影响：存量库可能存在重复邮箱，同一地址会投给多个用户——不阻断本方案，登记于 §7 风险。

本方案把邮件落为**任务通知的第三种投递渠道**：管理员在系统设置配置实例级 SMTP；用户在通知设置里三选一（钉钉 / 飞书 / 邮件）；之后全部现有通知场景的投递自动走邮件出口。投递的偏好、快照、调度、重试、WS 抑制全链路复用既有设施，本方案只新增一个渠道发送器与一处配置面。

### 1.1 现状代码事实（实施前已核对）

| 事项 | 现状 | 本方案的用法 |
|---|---|---|
| 渠道枚举与校验 | `NotificationChannel = 'DINGTALK' \| 'FEISHU'`（`shared/contracts/src/notification.ts:5`）；唯一校验入口 `parseNotificationChannel`（`notification/task/types.ts:17`），只放行这两个值 | 联合加 `'EMAIL'`；parse 放行 EMAIL。**全仓无 `Record<渠道,…>` 穷尽映射**（消费方仅为 parse、Map 注册表、桌面选项数组），联合放宽对既有取值零影响 |
| 发送器注册表 | `WebhookSenderRegistry`（`notification/task/webhook-sender.ts:93`）= `Map<NotificationChannel, WebhookSender>`，构造时注册（`create-app.ts:1291`：`new WebhookSenderRegistry([new DingTalkWebhookSender(), new FeishuWebhookSender()])`） | 新增 `EmailWebhookSender` 并入数组，一行注册。接口 `send(webhookUrl, message)` 的第一参对邮件渠道即收件地址 |
| 投递调度 | `WebhookDeliveryScheduler`（`delivery.scheduler.ts`）：到期扫描 → `cipher.decrypt(delivery.webhookCiphertext)` → `senderRegistry.get(channel).send(url, await buildMessage(delivery))`（:231-234）；重试参数 `maxAttempts` + `retryDelayMinutes`、终态 CAS、WS 抑制、metrics 按 channel 打点 | **调度器零改动**：邮件发送器返回同构 `WebhookSendResult`（success / retryable / httpStatus / providerCode / error），重试与观测自动生效 |
| 消息体构造 | `buildMessage`（`delivery.scheduler.ts:276`）= `{ text: buildTaskNotificationText(input), card: buildTaskNotificationCard(input) }`；text 形态见 `feishu-notification-card.ts:143-154`（首行「Mao 任务完成通知」+ 任务 / 结果 / 时间 / 失败原因） | 邮件渲染器只消费 `text`：**subject 取 text 首行**，HTML 正文 = 其余行转义保留换行 + 保守样式包装；`card`（飞书 JSON）忽略 |
| 用户偏好 | `user_task_notification_preference`（V054）：`user_id / enabled / channel / webhook_ciphertext`；`TaskNotificationPreferenceService`（`preference.service.ts`）的 save / get / sendTest 全走 channel + 密文两列 | **表零迁移**：channel 列存 `'EMAIL'`；`webhook_ciphertext` 语义扩展为「渠道目标密文」——邮件渠道存收件邮箱密文 |
| 密文与掩码 | `WebhookSecretCipher`（AES-GCM，`DEFAULT_NOTIFICATION_SECRET`）；`urlValidator.mask()` 面向 URL | 邮件密文复用同一 cipher；掩码新增邮箱版（`a***@domain.com`），不复用 URL 掩码 |
| 系统设置 | `system_setting`（setting_key / value / category / description / editable / is_secret）；secret 行 AES-GCM 加密 + 掩码回显（`settings.service.ts:169-174`）；seed 范式见 V160 / V093；test 端点范式 `/v1/system-settings/test/{ldap,feishu,oss}`（body 带 overrides 与已存值合并，`settings:write` 守卫） | SMTP 配置 = 7 个 setting 行（V161 seed），密码行 `is_secret=1`；新增 `POST /v1/system-settings/test/smtp` 同款守卫与合并语义 |
| 用户改邮箱 | 自助：`PUT /v1/users/me/profile`（`user.routes.ts:26`）→ `UserService.updateOwnProfile`（`user.service.ts:140`，本地用户才可改邮箱）；管理端：`PUT /v1/users/:id` | 两条路径在邮箱**实际发生变化后**触发偏好刷新钩子（决策 2） |
| 微信降级推送 | `weixin/webhook-fallback.service.ts:75-97`：解密偏好密文 → `senderRegistry.get(channel).send(url, { text, card })`；**但 :70-74 有硬编码白名单**（`channel !== 'DINGTALK' && channel !== 'FEISHU'` 即 warn 跳过） | 邮件渠道覆盖需先改白名单（放行 EMAIL 或改为委托 `senderRegistry.get` 抛错），否则 EMAIL 用户静默收不到降级推送；email sender 忽略 `card`，把 `text`（含「Mao 微信回复发送失败」头与截断）渲染为邮件 |
| 桌面通知设置 | `NotificationSettingsView.vue`：渠道单选 `channelOptions`（:263 钉钉 / 飞书）、webhook 输入区（:31）、保存与「发送测试」走 `/v1/user-preferences/task-notification` 三端点 | 单选加「邮件」；选中后隐藏 webhook 输入、展示目标邮箱与补全引导 |
| 管理后台设置 | `SystemSettingsView.vue`：分组目录含「通知与消息」（:313）；`notify: '任务通知'`（:259） | 「通知与消息」下新增「邮件（SMTP）」卡片组 + 测试连接按钮 |
| 会话深链现状 | 管道已算 `sessionDetailUrl`（`delivery.scheduler.ts:288`，来源 ECP `desktopCallbackUrl`，仅 ECP 实例有），飞书卡片消费它 | 邮件渲染器**不使用**（决策 6）；该字段在 email sender 内被忽略 |

### 1.2 对上游提案的修正（本方案对提案的实质变更）

1. **提案 P2 两件（每日摘要邮件、管理后台投递流水页）删除**（决策 1）：写入非目标，后续另案。
2. **深链开放问题关闭为「不做」**（决策 6）：提案曾把「深链 base 地址」列为开放问题；追问后确认——邮件只含事件与摘要文本，不新增任何地址设置项。
3. **收件地址从「实时读」精确为「快照 + 变更刷新」**（决策 2）：偏好密文列存保存时的邮箱；用户或管理员改邮箱后由钩子即时重写密文，兼顾既有快照语义与地址时效。
4. **HTML 正文字段口径修正**：提案曾描述正文含「耗时 / 成本」——核对后现有通知文本（`buildTaskNotificationText`）并不含耗时与成本，邮件正文与文本同源（事件类型 / 任务标题 / 结果 / 时间 / 失败原因）。耗时与成本进通知文本是另一个增强，不在本方案。

---

## 2. 需求描述

### 2.1 要做的

**共享契约（shared/contracts）**

1. `notification.ts`：`NotificationChannel = 'DINGTALK' | 'FEISHU' | 'EMAIL'`。

**后端（backend-ts）**

2. **V161 迁移**：`system_setting` seed 7 行（§4），密码行随后 `UPDATE ... SET is_secret=1`（V093 同款句式）。
3. **设置域**（`settings/`）：
   - `types.ts` 增 `EmailSmtpSettings`（enabled / smtpHost / smtpPort / smtpUser / smtpPassword / fromAddr / useTls）；
   - `settings.service.ts` 增 `getEmailSmtpConfig()` / 保存校验（enabled 时 host、port、fromAddr 必填；port 限 1-65535；fromAddr 校验邮箱格式），key 常量 7 个；
   - `settings.routes.ts` 增 `POST /v1/system-settings/test/smtp`（`settings:write` 守卫；body overrides 与已存合并；发测试信到当前管理员 `user.email`；管理员无邮箱时 PARAM_INVALID 拒绝）。
4. **邮件发送器**（`notification/task/email-sender.ts`，新文件）：
   - `EmailWebhookSender implements WebhookSender`：`channel() = 'EMAIL'`；`send(toEmail, message)` 用 nodemailer 发送双 Part 邮件（§3.2）；
   - transport 按配置缓存复用（配置变更即重建），socket 超时 10s（对齐 webhook `REQUEST_TIMEOUT_MS`）；
   - 错误映射：网络错 / 超时 / SMTP 5xx → `retryable: true`；4xx（认证失败 535、收件人无效 550 等）→ `retryable: false`，error 带 SMTP 响应摘要；**配置缺失分支**（`notify.email.enabled=0` / host 或 fromAddr 为空，发送时实时读配置的必然路径）→ `retryable: false`，error「邮件通知未配置或已停用，请联系管理员」——不可重试可避免无谓重试 20 分钟才终态，也让 test 端点拿到人话；
   - 依赖 `SettingService` 取 SMTP 配置（发送时实时读，配置保存后即时生效，不缓存 transport 之外的态）。
5. **装配**（`create-app.ts:1291`）：`new WebhookSenderRegistry([new DingTalkWebhookSender(), new FeishuWebhookSender(), new EmailWebhookSender(settingService)])`。
6. **渠道解析**（`notification/task/types.ts`）：`parseNotificationChannel` 放行 `'EMAIL'`，错误文案改「通知渠道只支持 DINGTALK、FEISHU 或 EMAIL」。
7. **偏好服务 EMAIL 分支**（`preference.service.ts`）：
   - `save`：channel=EMAIL 时不再要求 webhookUrl 入参——改从用户表取 email（新增 `UserEmailLookup` 依赖：`findEmailById(userId)`），空则 PARAM_INVALID「请先在个人资料中填写邮箱，再选择邮件通知」；**每次保存都从用户表重算密文**（`encrypt(email)`，不继承 `row.webhookCiphertext`——否则钩子刷新失败过的用户保存同渠道偏好仍拿旧地址）；「切换渠道必须填新地址」规则仅对 webhook 渠道生效；
   - `save` 的 enabled 校验依赖 SMTP 开关：§4.1 与 §8 要求「`notify.email.enabled=0` 时选 EMAIL 拒绝」，故偏好服务**同时需要 `SettingService`（或窄接口 `emailSmtpEnabled()`）依赖**，拒绝文案「邮件通知未启用，请联系管理员」；`enabled` 但无密文的报错文案对 EMAIL 改为邮箱口径（「请先在个人资料中填写邮箱」）；
   - `get`：`maskedWebhook` 对 EMAIL 返回邮箱掩码（§3.3，桌面直接展示 API 返回值、无需前端自实现掩码），`webhookConfigured` 语义不变；
   - `sendTest`：channel=EMAIL 时 resolvedUrl = 解密后的偏好密文（忽略入参 webhookUrl），发送测试邮件（subject「Mao Agent 测试通知」）；未保存过 EMAIL 偏好时的报错文案改为邮箱口径（「请先保存邮件通知偏好」）。可选增强：无已存偏好时回落到当前资料邮箱（复用 `UserEmailLookup`），让「发送测试」不必先保存——不做则沿用既有「先保存再测试」语义，前端需明示。
8. **邮箱变更刷新钩子**（`user.service.ts`）：`updateOwnProfile` 与管理端更新路径在邮箱实际变化后调用 `emailChangeListener(userId, newEmail)`（构造注入可选依赖）；`create-app` 里接 `preferenceService.refreshEmailAddress(userId, email)`——channel='EMAIL' 时用新邮箱重写密文，其他渠道 no-op，失败只 warn 不阻断资料更新。**新邮箱为空（用户清空邮箱）时**：channel=EMAIL 则清空 `webhook_ciphertext`（不动 enabled/channel）——`findEnabled` 因密文为空自然跳过投递，「不停发到旧地址」在清空场景同样成立，warn 日志。管理端路径注意：`updateUser:94-96` 现状不校验邮箱格式 / 查重，建议钩子触发前补 EMAIL_PATTERN 校验、非法则拒绝本次管理更新（否则垃圾地址进密文，表现为重试后 FAILED 的 silent breakage）。
9. **结果摘要 / 展示链**（AGENTS.md 规范）：本次无新内置工具，`tool-result-summarizer.ts` / `toolDisplay.ts` **不涉及**；邮件投递的记录口径与 webhook 完全一致（activity / delivery 表 / metrics），无新增展示面。

**桌面端（desktop）**

10. `NotificationSettingsView.vue`：`channelOptions` 加 `{ label: '邮件', value: 'EMAIL' }`；channel=EMAIL 时隐藏 webhook 输入区，展示「将发送到：{user.email}」+ 未填时引导去个人资料（链接到设置页个人信息）；「发送测试」按钮对 EMAIL 同样可用（不传 webhookUrl）。**保存门禁旁路（易漏）**：`canSave`/`canTest`/`hasUsableWebhook`（:300-306）与 `validateWebhook`（:468-477）、`handleTest`/`handleSave` 的校验调用（:511、:526-527）现全部以 webhook 为中心，EMAIL 分支需改造——usable = 当前用户邮箱非空（`authStore.user?.email`），`validateWebhook` 对 EMAIL 直接放行；`handleChannelChange`（:479-492）对 EMAIL 无需特殊处理（清空 webhookUrl 即可）。
11. `ProfileView.vue`：邮箱输入框下补一句说明「用于接收任务通知邮件」（编辑器与校验已存在，不改逻辑）。
12. `api/index.ts`：`saveTaskNotificationPreference` 的 webhookUrl 参数改为可选（EMAIL 不传）。

**管理后台（admin）**

13. `SystemSettingsView.vue`：「通知与消息」分组新增「邮件（SMTP）」卡片组——启用开关、SMTP 主机 / 端口 / TLS 开关 / 用户名 / 密码（掩码占位）/ 发件人地址 + 「测试连接」按钮（调 test/smtp，成功 toast「测试邮件已发送至你的邮箱」）。

### 2.2 不做的（明确清单）

- **每日运营摘要邮件出口**（决策 1）：digest 域不改，摘要仍只走收件箱 + 出站订阅。
- **管理后台投递流水页**（决策 1）：邮件投递记录只在 `task_notification_delivery` 表内可查，不建管理端 UI。
- **会话深链**（决策 6）：邮件不含任何跳转链接；`sessionDetailUrl` 在邮件渲染器中被忽略。
- **投递失败的用户提醒**（决策 7）：不加收件箱 kind、不加任何用户侧失败通知。
- **入站邮件**：不收信、不建会话、不给 Agent 配邮箱、不做「转发即任务」（提案收窄时已排除）。
- **主动外发**：Agent 不能在会话里给任意地址发邮件；测试连接只发管理员本人。
- **每用户独立 SMTP / 多 SMTP 配置**：仅实例级单一配置。
- **SPF / DKIM / DMARC 自动配置**：只写部署文档建议，产品内不做引导。
- **OAuth 授权流 / 第三方邮件 API**（决策 3 已否）。
- **多收件人 / 抄送 / 通讯录 / 邮件模板系统 / 退订管理**。

---

## 3. 技术选型

### 3.1 nodemailer（决策 3）

- SMTP 生态标准：TLS（465 隐式）/ STARTTLS（587）、AUTH LOGIN/PLAIN、多 Part 邮件开箱即用；测试可注入 transport stub。
- 依赖新增一个包；后端已有 `ldapts` 等三方依赖先例，无新增风险类。
- transport 单实例按配置复用：`nodemailer.createTransport({ host, port, secure, auth: { user, pass }, connectionTimeout/socketTimeout: 10_000 })`；配置变更（host/port/user/pass/secure 任一变化）即重建，不设 TTL。

### 3.2 邮件渲染（决策 5）

- **subject**：`message.text` 首行（如「Mao 任务失败通知」）。安全属性：所有 text 的首行均为固定头（任务通知三类头 / 微信降级头 / 测试通知），**不含用户输入**，无 CRLF 注入面（nodemailer 亦会折叠换行）——后续若把用户标题挪进 subject 需重新评估；
- **text Part**：`message.text` 原文（钉钉 / 飞书回退消费的同款文本）；
- **html Part**：纯字符串模板（不引模板引擎）——标题条（subject）+ 正文（text 其余行，HTML 转义后保留换行与缩进）+ 页脚「本邮件由 Mao 实例自动发送」；保守内联样式（系统字体栈、细边框、无外链资源），保 Outlook 兼容；
- **from**：`fromAddr`（缺省回落 `smtpUser`）；**to**：send 第一参（解谜后的收件邮箱）；
- 微信降级推送的 text 已含「Mao 微信回复发送失败」头与超长截断，原样进 subject / 正文，不特殊处理。

### 3.3 邮箱掩码

`maskEmail(local, domain)`：本地部分保留首字符 + `***`（本地部分长度 1 时整体 `***`），如 `z***@example.com`。放在 `email-sender.ts` 导出，`preference.service.get` 与桌面展示共用。

---

## 4. 数据与设置

### 4.1 V161 迁移（唯一迁移）

```sql
-- V161: 邮件通知渠道（第三通知渠道：飞书/钉钉/邮件）。
-- 消费方 EmailSmtpSettings：缺行/未启用 = 邮件渠道不可用（偏好保存 EMAIL 时拒绝并提示联系管理员）。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('notify.email.enabled',   '0',    '通知与消息', '邮件通知渠道开关：0=关（默认），1=开。开启后用户可在消息通知里选择邮件渠道', 1),
('notify.email.smtpHost',  NULL,   '通知与消息', 'SMTP 服务器地址', 1),
('notify.email.smtpPort',  '465',  '通知与消息', 'SMTP 端口（TLS 465 / STARTTLS 587）', 1),
('notify.email.smtpSecure','1',    '通知与消息', '是否使用 TLS 隐式加密：1=是（465），0=STARTTLS（587）', 1),
('notify.email.smtpUser',  NULL,   '通知与消息', 'SMTP 登录用户名', 1),
('notify.email.smtpPassword', NULL,'通知与消息', 'SMTP 登录密码（加密存储）', 1),
('notify.email.fromAddr',  NULL,   '通知与消息', '发件人地址（留空则使用 SMTP 用户名）', 1);

-- 密码行按 V093 同款句式标记 secret（加密存储 + 掩码回显）。
UPDATE `system_setting` SET `is_secret` = 1 WHERE `setting_key` = 'notify.email.smtpPassword';
```

### 4.2 业务表零迁移

`user_task_notification_preference` 与 `task_notification_delivery` 均不改结构：channel 列（VARCHAR）存 `'EMAIL'`；`webhook_ciphertext` 列语义扩展为「渠道目标密文」，邮件渠道存收件邮箱密文。既有 DINGTALK / FEISHU 行完全不变。

---

## 5. 实现步骤（按文件）

| # | 文件 | 动作 | 要点 |
|---|---|---|---|
| 1 | `backend-ts/package.json` | 增依赖 `nodemailer` + `@types/nodemailer`（devDependency） | — |
| 2 | `backend-ts/db/migration/V161__email_notification_setting.sql` | 新建（§4.1） | seed + is_secret UPDATE |
| 3 | `shared/contracts/src/notification.ts` | 联合加 `'EMAIL'` | 无其他契约变动 |
| 4 | `backend-ts/src/notification/task/types.ts` | `parseNotificationChannel` 放行 EMAIL、改错误文案 | 唯一校验入口 |
| 5 | `backend-ts/src/notification/task/email-sender.ts` | 新建：`EmailWebhookSender` + `maskEmail` + transport 缓存 | §3.1 / §3.2 / §3.3 |
| 6 | `backend-ts/src/create-app.ts` | 注册 sender（:1291）；接线 `emailChangeListener` | 一行 + 钩子 |
| 7 | `backend-ts/src/settings/types.ts` / `settings.service.ts` | `EmailSmtpSettings` 类型 + getter + 保存校验 + 7 个 key 常量 | 对齐既有 settings getter 范式 |
| 8 | `backend-ts/src/settings/settings.routes.ts` | `POST /v1/system-settings/test/smtp` | overrides 合并 + `settings:write` + 发管理员邮箱 |
| 9 | `backend-ts/src/notification/task/preference.service.ts` | EMAIL 分支（save / get / sendTest）+ `refreshEmailAddress` + `UserEmailLookup` 与 `SettingService`（`emailSmtpEnabled()`）双依赖 | §2.1-7；SMTP 开关校验、密文每次重算、文案邮箱口径 |
| 10 | `backend-ts/src/user/user.service.ts` | 邮箱实际变化后调 `emailChangeListener`（自助 + 管理端两条路径） | 失败只 warn；清空邮箱清密文；管理端补邮箱格式校验 |
| 11 | `backend-ts/src/weixin/webhook-fallback.service.ts` | 渠道白名单（:70-74）放行 EMAIL | 决策 4 前提：不改则 EMAIL 用户静默收不到降级推送；DINGTALK / FEISHU 行为不变 |
| 12 | `desktop/src/views/settings/NotificationSettingsView.vue` | 渠道选项 + EMAIL 分支 UI + 测试 | §2.1-10；含 `canSave`/`canTest`/`validateWebhook` 旁路。`desktop/src/api/index.ts` 的 `webhookUrl?` 现状已可选，无需改动 |
| 13 | `desktop/src/views/settings/ProfileView.vue` | 邮箱字段用途说明一句 | 纯文案 |
| 14 | `admin/src/views/settings/SystemSettingsView.vue` | 「邮件（SMTP）」卡片组 + 测试连接 | §2.1-13 |
| 15 | 测试（见 §8） | 新增 / 扩展 spec | 含既有通知 spec 全量回归 |

---

## 6. 接口与契约

**无新增用户级端点**；复用既有三个：

- `GET /v1/user-preferences/task-notification`（ PreferenceView 的 `maskedWebhook` 对 EMAIL 为邮箱掩码）
- `PUT /v1/user-preferences/task-notification`（body `{ enabled, channel, webhookUrl? }`；EMAIL 不传 webhookUrl）
- `POST /v1/user-preferences/task-notification/test`（channel=EMAIL 发到本人邮箱）

**新增一个管理端点**：

- `POST /v1/system-settings/test/smtp`（`settings:write`；body 为 SMTP 配置 overrides，与已存合并；发测试信到当前管理员 `user.email`；成功返回 `{ ok: true }`，失败 PARAM_INVALID 带原因）

**设置 key**（7 个，§4.1）；**契约**：`NotificationChannel += 'EMAIL'`（三处同改：contracts、`parseNotificationChannel`、桌面 `channelOptions`——无 `Record` 穷尽映射，编译期由联合放宽自动兼容）。

---

## 7. 风险与开放问题

- **进垃圾箱**：自托管实例的发信信誉是邮件系统固有属性。缓解：DEPLOY.md 补 SPF / DKIM / 中继建议；产品文案明示「正确发出不保证送达」。本方案最大体验风险，不构成阻断。
- **HTML 兼容**：Outlook 等客户端渲染坑。缓解：保守内联样式 + 纯文本备用 Part（决策 5）。
- **SSO / LDAP 用户无邮箱**：资料由身份源维护（`updateOwnProfile:143` 对非本地用户拒改），若 IdP 未同步邮箱，这些用户选 EMAIL 被保存拒绝——属可接受限制，错误文案引导联系管理员。
- **邮箱变更竞态**：钩子刷新失败（如库瞬断）只 warn，偏好留旧地址——下次任意通知仍发旧地址直到再次修改邮箱。缓解：刷新失败写 warn 日志；可接受（与 webhook 地址失效同级的既有容忍度）。
- **测试信打到管理员本人**（决策 8）：管理员未填邮箱时端点拒绝并提示先去个人资料填写——已在前端表单同步该提示。
- **nodemailer 错误对象映射**：SMTP 响应码在 `error.responseCode` / `error.code`，映射表按 §2.1-4 实现并附单测；未覆盖 code 一律按可重试处理（偏保守，重试有上限兜底）。
- **重复邮箱（存量数据）**：`user.email` 无 DB 唯一约束，且 `createUser` / 管理端 `updateUser` 均不查重——同一地址可能属于多个用户，邮件通知会各自投递到同一地址。不阻断本方案；如需收敛（唯一索引 + 应用层查重）另案。
- **开放问题**：邮件投递失败是否需要管理后台可见面——决策 1 已否（P2 提案项），本方案只保证 delivery 表可查。

---

## 8. 测试要点

- **契约与解析**：`parseNotificationChannel('EMAIL')` 放行、大小写 / 其他值拒绝；三处同改编译通过（`shared/contracts` + 后端 + 桌面）。
- **偏好**：选 EMAIL 保存 / 读取 / 测试三条路径；未填邮箱保存拒绝（文案）；切换 webhook→EMAIL 不要求填地址；EMAIL→钉钉要求填 webhook（既有规则不回退）；`get` 返回邮箱掩码。
- **邮箱变更刷新**：本地用户改邮箱 → 偏好密文更新（channel=EMAIL）；改为其他渠道 no-op；管理端改用户邮箱同样刷新；刷新失败不阻断资料更新（warn）。
- **发送器**（nodemailer transport stub）：双 Part（html + text）齐备；subject = text 首行；from 回落 smtpUser；超时 → retryable；535 / 550 → 不可重试；5xx → 可重试；`maskEmail` 边界（本地部分 1 字符、超长域名）。
- **投递链路**：任务终态 → EMAIL 分派（delivery 行 channel='EMAIL'、status 流转、attemptCount / nextRetryAt 与 webhook 同口径）；WS 抑制对 EMAIL 生效；metrics 按 channel 打点。
- **微信降级推送**：channel=EMAIL 时走 email sender，text 含降级头，card 被忽略，不抛错；**白名单放行后 DINGTALK / FEISHU 降级行为回归不变**。
- **设置与测试端点**：seed 行读取；enabled=0 时选 EMAIL 拒绝；test/smtp 未填邮箱拒绝、配置合并（overrides 覆盖已存）、发送成功 / 失败文案。
- **发送器边界**：SMTP 缺配置 / enabled=0 时发送 → 不可重试 + 「邮件通知未配置或已停用，请联系管理员」；transport 按配置重建（改 host/port/密码后下次发送即用新配置）。
- **邮箱边界**：用户清空邮箱 → channel=EMAIL 偏好密文被清空、`findEnabled` 返回 null、不再投递；钩子失败（密文仍是旧地址）后再次保存同渠道偏好 → 密文重算为当前邮箱。
- **前端**：渠道选项三选；EMAIL 分支隐藏 webhook 输入、展示目标邮箱与引导；保存不传 webhookUrl；ProfileView 文案在位；**门禁旁路**：EMAIL + 用户无邮箱时 `canSave`/`canTest` 为 false 并引导填邮箱，有邮箱时可保存 / 可测试。
- **回归**：DINGTALK / FEISHU 全量通知 spec 绿（偏好 / 调度 / 重试 / 双渠道发送 / 微信降级）；站内收件箱不受影响。

---

## 9. 落地清单

| 端 | 交付物 | 验收标准 |
|---|---|---|
| shared/contracts | `NotificationChannel += 'EMAIL'` | 三处同改编译通过 |
| backend-ts | V161 迁移 + 设置域 + test/smtp + email-sender + 注册 + 偏好分支 + 邮箱钩子 | §8 后端用例全绿；既有通知 spec 零回归 |
| desktop | 通知设置 EMAIL 分支 + 个人资料文案 + api 参数放宽 | 手工走通：选邮件→保存→收测试信→收任务通知 |
| admin | 邮件（SMTP）设置卡片组 + 测试连接 | 保存后即时生效（下次投递即按新配置）；测试连接到达管理员邮箱 |
| 文档 | CHANGELOG「管理后台 + 前端 + 后端」三条（版本号取实施时最新下一版；本方案编写时基线为 0.0.317@2026-10-20，预计 0.0.318）；DEPLOY.md 补 SMTP / SPF / DKIM 建议；mao-cli（skills/mao-cli/）同步通知渠道说明 | 按 AGENTS.md 发布前同任务写完 |
