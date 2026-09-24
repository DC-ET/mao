# 钉钉机器人通道（dingtalk-bot）

通过**企业内部应用机器人 + Stream** 在钉钉里与 Agent 对话。支持多个机器人，每个可独立绑定 Agent 与模型。这和「任务完成通知」里的自定义机器人 Webhook 不是同一条路，不要混用。

## 功能特性

| 能力 | 说明 |
|------|------|
| 多机器人 | 管理后台配置多个企业内部应用，每个独立 Agent / 模型，Stream 随启停热生效 |
| 绑定 | 设置页绑定，或钉钉里点「点我绑定」短链。钉钉身份只绑定已有 Mao 用户，不创建账号，不要求 ECP 票 |
| 私聊 | 文本、富文本、图片、文件。`---`（3 个及以上 `-` 或 `—`）新建会话；执行中收到 `---` 先取消当前任务 |
| 群聊 | 只处理 @ 本机器人之后的文本、富文本、图片。上下文是最近的 @ 往来加上本条引用正文，不是完整群聊 |
| 进度卡 / 排队卡 | 执行中、完成、失败、取消；排队时可立即发送或取消本条。只允许原发送者点按钮 |
| 网页同步 | 已经打开的网页 / 桌面 / 安卓会话会跟上这一轮执行 |
| 工具 | 钉钉会话提供 `dingtalk_send_image` / `dingtalk_send_file`，不提供 `ask_user_questions` |

明确不做：会话列表、切换会话、引用切会话、话题群、群文件 / 语音 / 视频、出站引用回复、钉钉文档读取、用自定义机器人 Webhook 当通道。

## 角色与操作入口

| 角色 | 操作 | 入口 |
|------|------|------|
| 管理员 | 添加 / 编辑 / 启停 / 删除 / 重连 | 管理后台「能力 → 钉钉机器人」 |
| 普通用户 | 绑定 / 解绑 | 桌面 / Web / 安卓「设置 → 钉钉Bot」 |

## 使用流程

1. 开放平台创建企业内部应用，机器人收消息选 Stream 并发布。权限至少包括企业内机器人发送消息、卡片实例写、上传媒体。登录应用配置回调，并开通「根据 unionid 获取用户」和通讯录个人信息读。卡片平台发布进度卡、排队卡，按钮 actionId 为 `cancel`、`retry`、`run`。
2. 后端配置 `APP_DINGTALK_BOT_SECRET`、`DINGTALK_OAUTH_CLIENT_ID` / `DINGTALK_OAUTH_SECRET` / `DINGTALK_OAUTH_REDIRECT_URI`，打开 `DINGTALK_BOT_ENABLED`。登录应用必须和机器人在同一企业。
3. 管理后台添加机器人：内部 App Key、名称、Client ID、Client Secret、Robot Code、可选 Agent / 模型 / 模板 ID，然后启用。
4. 用户在设置页绑定，或在钉钉里给机器人发一条消息，按卡片短链登录后再授权。
5. 私聊直接发消息。群里把机器人拉进群后 @ 它。想开新会话就发 `---`。

## REST API

### 管理端（需管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/admin/dingtalk-bots` | 列表。不返回 `clientSecret`，只返回 `clientSecretConfigured` |
| GET | `/v1/admin/dingtalk-bots/:id` | 单个 |
| POST | `/v1/admin/dingtalk-bots` | 创建：`appKey`、`name`、`clientId`、`clientSecret`、`robotCode`、`agentId?`、`modelId?`、`progressCardTemplateId?`、`queueCardTemplateId?`、`enabled?` |
| PUT | `/v1/admin/dingtalk-bots/:id` | 更新。`clientSecret` 空串表示不改 |
| DELETE | `/v1/admin/dingtalk-bots/:id` | 软删除 |
| POST | `/v1/admin/dingtalk-bots/:id/enable` 与 `/disable` | 启停 |
| GET | `/v1/admin/dingtalk-bots/status` | 连接状态：`ready` / `reconnecting` / `failed` / `disabled` |
| POST | `/v1/admin/dingtalk-bots/:id/reconnect` | 仅已启用的机器人 |

### 用户端

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/dingtalk/binding` | 已登录时发起绑定，返回 `authUrl` |
| GET | `/v1/dingtalk/binding/status` | `bound`、`userid`、`unionId`、`boundAt` |
| DELETE | `/v1/dingtalk/binding` | 解绑。会话和工作区保留 |
| GET | `/v1/dingtalk/bind/:state` | 短链。无登录态时先到登录页，登录后再跳钉钉授权 |
| GET | `/v1/dingtalk/oauth/callback` | 钉钉授权回调 |

## 排障

- **保存机器人报「未配置 APP_DINGTALK_BOT_SECRET」**：先配密钥再重启。
- **钉钉里回复「管理员尚未配置钉钉登录」**：补齐 `DINGTALK_OAUTH_*`，回调地址要和开放平台「登录与分享」一致。
- **全员无法识别身份**：应用未发布，回调里没有 `senderStaffId`。发布后再测。外部群成员没有企业 userid，第一期不支持。
- **已绑定其他账号**：一个 userid 只能绑一个 Mao 用户，一个 Mao 用户只能绑一个钉钉身份。先解绑再绑，不会自动改绑。
- **有时没反应**：同一个 Client ID 只能有一条 Stream。本地调试用另一个应用。
- **进度卡没出来**：模板 ID 为空时任务仍会跑，只发一条「正在处理」，结束时另发 markdown。
- **群里看不到没 @ 的讨论**：这是平台限制。需要机器人看到某句时，引用那条或把原话写进 @ 内容。
