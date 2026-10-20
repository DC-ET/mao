# 提案：邮件通知渠道（Email Notification）—— 任务通知的第三种出口：飞书、钉钉、邮件

- 状态：**已确认**（2026-10-19 评审通过，范围收窄为出站通知渠道；技术方案见 [../plan/2026-10-19-email-notification-technical-design.md](../plan/2026-10-19-email-notification-technical-design.md)，决策记录 8 条于 2026-10-19 逐条确认）
- 日期：2026-10-19
- 提案总览：见 `docs/proposals/README.md`

> 范围说明：本提案由同日的「邮件渠道（入站 + 出站全渠道）」提案收窄而来。原提案的入站部分（IMAP 收信、线程映射进会话、Agent 邮箱、转发即任务）本次**不做**；本文件只覆盖**出站通知**——把邮件作为任务通知 / 运营摘要的第三种投递渠道，与飞书、钉钉并列。入站邮件若未来重启，按原存档文档的框架另案评审。

## 1. 背景与现状

平台的任务通知今天有两个出口：飞书、钉钉（Webhook 形态），外加站内收件箱。

代码事实：

1. **通知渠道枚举只有两个**。`shared/contracts/src/notification.ts:5` 的 `NotificationChannel = 'DINGTALK' | 'FEISHU'`；后端校验同样写死（`notification/task/types.ts` 的 `parseNotificationChannel` 只放行这两个值）。任务完成 / 失败 / 提问 / 审批待办 / 预算 WARN / 每日运营摘要，全部经这两个 Webhook 或站内收件箱送达。
2. **投递管线是渠道无关的，加渠道 = 加一个发送器**。`notification/task/` 域已有完整的偏好表（`user_task_notification_preference`：enabled / channel / webhookCiphertext）、投递表（`task_notification_delivery`：状态机 WAITING_WS→PENDING→SENDING→SUCCEEDED/FAILED、attemptCount、nextRetryAt、lastHttpStatus）、调度重试与 WS 抑制（用户正盯着桌面端时不打搅）、双渠道发送器分派。邮件渠道复用整条管线，**不动调度与重试语义**。
3. **`user.email` 从建库第一天就存在，却从未被使用**。`user` 表 `email` 列（`V001__init_schema.sql:7`）仅用于身份查找与唯一性约束；管理后台收集邮箱（`UserFormDialog.vue`），全项目没有任何邮件发送能力（SMTP / IMAP 零命中）。一个收集了从不用的字段，通常意味着一个没被满足的需求——大量企业的默认通知面是邮件：领导不看钉钉、外部协作方只认邮件、告警系统的默认出口也是邮件。
4. **密文与测试连接的基建都在**。系统设置的 secret 行有成熟的 AES-GCM 加密 + 掩码回显口径（`settings.service.ts` 的 `is_secret` 语义，`encryptAesGcmNonNull` / 掩码占位符）；`settings-test.service.ts` 已有 LDAP bind、飞书 OAuth 两类「保存前连通性测试」先例——SMTP 测试连接是同款交互。

相邻方向的边界：

- **不是入站邮件渠道**（原提案范围，本次不做）：不收邮件、不建会话、不给 Agent 配邮箱。本提案是**单向出口**。
- **不是营销 / 群发工具**：只发通知与摘要给本实例用户本人，无模板群发、无订阅管理。
- **不是 Webhook 的替代**：Webhook（JSON 推 HTTPS）给机器读，邮件给人读，两者并存；用户偏好三选一。
- **与出站订阅的分工**：出站订阅（openapi 域）是事件粒度的机器通道；邮件是同一事件的人读通道，内容形态不同（HTML 富文本 vs JSON）。

## 2. 目标 / 非目标

**目标**

1. **实例级 SMTP 配置**：管理后台「系统设置 → 通知与消息」新增「邮件（SMTP）」组——host / 端口 / 用户名 / 密码（secret 行，加密 + 掩码回显）/ 发件人地址 / TLS 开关 / 启用开关。落 `system_setting` 新行（V161 seed，对齐 V160 的 seed 范式），保存前可「测试连接」（对齐 LDAP 测试交互）。
2. **第三渠道类型**：`NotificationChannel` 扩 `'EMAIL'`（三处同改：contracts 联合、后端 `parseNotificationChannel`、桌面通知设置 UI 的渠道单选）。用户选择「邮件」时，目标地址 = 本人资料邮箱（`user.email`）——**这个字段第一次被真正用起来**；未填邮箱时保存拒绝并引导去个人资料补全。
3. **邮件形态**：HTML 邮件——标题（任务名 / 事件类型）、正文摘要（终端相位、会话标题、耗时 / 成本关键指标）、深链按钮（跳桌面 / Web 端对应会话）。深链 base 地址取实例配置（若无则 P1 先只展示文本信息，见开放问题）。
4. **全链路复用**：偏好读写与测试端点（`/v1/user-preferences/task-notification` 的 GET/PUT/test 原样扩展，channel=EMAIL 时不校验 webhookUrl、改校验 SMTP 已配置 + 本人有邮箱）；投递走既有 delivery 表 / 调度器 / 重试 / WS 抑制，channel 列存 `EMAIL`，失败重试与观测口径与 Webhook 完全一致。
5. **每日运营摘要的邮件出口（P2）**：摘要域（digest）现有投递是收件箱 + 出站订阅；P2 增加邮件形态（章节结构对齐飞书摘要卡：成败 / 定时 / 哨兵 / 审批 / 成本 Top），用户在通知设置里与任务通知同开关或独立开关（倾向同开关，少一个概念）。

**非目标**

- **不做入站邮件**：不收信、不建会话、不给 Agent 配邮箱、不做「转发即任务」。原存档框架保留，未来另案。
- **不做主动外发**：Agent 不能在会话里给任意地址发邮件（那是数据外发边界问题，与已否决的出网边界提案同源，不碰）。
- **不做邮件模板系统 / 群发 / 退订**。
- **不做 SPF / DKIM / DMARC 自动配置**：部署文档写清建议（自托管实例要不容易进垃圾箱，这些是运维动作），产品内只做凭据配置与连通性测试。
- **不做多收件人 / 抄送 / 通讯录**。

## 3. 方案要点

### 3.1 设置与数据

- `system_setting` 新行（V161 seed，`editable=1`，密码行 `is_secret=1`）：`notify.email.smtpHost` / `notify.email.smtpPort` / `notify.email.smtpUser` / `notify.email.smtpPassword`（secret）/ `notify.email.fromAddr` / `notify.email.useTls` / `notify.email.enabled`。缺行 / 未启用 = 邮件渠道不可用（选 EMAIL 时保存拒绝，提示联系管理员）。
- **零业务表迁移**：偏好表 channel 列是字符串（存 `EMAIL` 即可）；delivery 表同。唯一迁移是 V161 的设置 seed。
- 契约：`NotificationChannel = 'DINGTALK' | 'FEISHU' | 'EMAIL'`（ contracts 一处、后端 parse 一处、桌面 UI 一处，编译期穷尽兜底）。

### 3.2 发送器（`notification/task/email-sender.ts`）

- 依赖选择：倾向 `nodemailer`（SMTP 客户端生态标准，TLS / 认证 / HTML 全覆盖）；若评审希望零新依赖，可降级裸 `node:net`/`tls` 实现最小 SMTP——**列为评审决策点**（倾向 nodemailer，后端已有 ldapts 等三方依赖先例）。
- 发送接口对齐既有 `WebhookSendResult` 形态（success / retryable / httpStatus→SMTP 响应码 / providerCode / error），使 delivery 的重试判定（retryable）无需改动——5xx / 超时判可重试，4xx 认证失败判不可重试。
- HTML 渲染：保守表格布局（邮件客户端兼容性优先），标题 + 关键指标 + 深链按钮；纯文本备用 Part（多 Part 邮件，对齐企业邮件客户端习惯）。

### 3.3 前端

- 管理后台：系统设置「邮件（SMTP）」卡片组（对齐既有 settings 分组交互：保存前校验 + 测试连接按钮 + 密码掩码回显）。
- 桌面通知设置（`NotificationSettingsView.vue`）：渠道单选加「邮件」；选中后隐藏 Webhook 输入，展示「将发送到：`{user.email}`」（未填时提示去个人资料填写 + 快捷入口）；「发送测试」按钮复用既有 test 端点（channel=EMAIL 分支）。
- 个人资料：邮箱字段补一句用途说明「用于接收任务通知邮件」（`UserFormDialog` / 桌面个人信息）。

### 3.4 失败与观测

- SMTP 未配置 / 未启用：偏好保存拒绝（PARAM_INVALID，文案指向管理员）；test 端点同理。
- 投递失败：既有重试 + 达次数后 FAILED，delivery 表留 `failureReason`；管理后台通知投递观测（若已有 Webhook 投递流水页则并列展示 channel=EMAIL 行；P1 若无处展示，至少 delivery 表可查——**待确认**：现有 Webhook 投递失败是否有管理端可见面，没有则 P1 只保证库内可查，UI 列 P2）。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | V161 设置 seed + SMTP 配置 UI 与测试连接 + `NotificationChannel='EMAIL'` 三处同改 + email-sender + 偏好 / 投递 / 测试全链路 + 桌面通知设置与个人资料引导 | 小~中 |
| P2 | 每日运营摘要邮件出口 + 管理后台投递流水（含 EMAIL 行）+ 深链 base 地址配置 | 小 |

## 5. 风险与开放问题

- **进垃圾箱**：自托管实例发信的信誉问题是邮件系统的固有属性。缓解：部署文档写清 SPF / DKIM / 中继建议；产品文案管理预期（「正确发出」不保证「送达」）。这是本提案最大的体验风险，但不构成阻断。
- **HTML 兼容性**：Outlook 等客户端的渲染坑。缓解：保守表格布局 + 纯文本备用 Part，不做花哨样式。
- **`user.email` 质量**：历史数据里邮箱可能未填 / 是占位值。缓解：保存偏好时校验存在与格式；未填引导补全；发送前再校验一次（防保存后被清空）。
- **评审决策点**：SMTP 客户端依赖（nodemailer vs 裸实现）——倾向 nodemailer。
- **开放问题**：深链 base 地址——实例是否有「外部访问地址」设置项？若无，P1 邮件里不放按钮（或放 Web 根域配置项一并做），P2 补。
- **开放问题**：摘要邮件是否与任务通知同开关——倾向同开关（少一个概念），若评审认为摘要频率低应独立则拆。
- **开放问题**：投递失败是否需要收件箱新 kind 提醒用户「你的邮件通知发失败了」——P1 不加（失败在 delivery 表可查），按反馈再评估。

## 6. 测试要点

- 契约与解析：`NotificationChannel='EMAIL'` 三处编译期穷过；`parseNotificationChannel('EMAIL')` 放行、其他值拒绝。
- 偏好：选 EMAIL 保存 / 读取；未填邮箱拒绝；SMTP 未配置拒绝；test 端点两条路径（成功 / 认证失败）；webhookUrl 在 EMAIL 下不参与校验。
- 投递：任务终态 → EMAIL 分支分派正确；delivery 行 status / attemptCount / nextRetryAt 口径与 Webhook 一致；可重试与不可重试失败（5xx vs 4xx）的退避行为；WS 抑制（用户在线不打搅）对 EMAIL 同样生效。
- 设置：密码行加密落库、掩码回显、value='' 清空语义；测试连接的成功 / 失败文案。
- 渲染：HTML 与纯文本双 Part；中文主题与正文；超长任务名 / 摘要截断。
- 回归：DINGTALK / FEISHU 两渠道行为零改动；站内收件箱不受影响。
