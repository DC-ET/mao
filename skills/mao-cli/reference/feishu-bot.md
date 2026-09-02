# 飞书机器人通道（feishu-bot）

通过**飞书自建应用机器人**在飞书内与 Agent 对话：支持多个机器人并行接入（WebSocket 长连接），用户可在私聊直接对话或在群里 @ 机器人触发。绑定以飞书 `union_id` 为身份锚，绑定一次对所有机器人通用。

## 功能特性

| 能力 | 说明 |
|------|------|
| 多机器人 | 管理后台配置多个飞书自建应用机器人，每个可独立绑定 Agent 与模型 |
| 长连接 | 服务端与飞书建立 WebSocket 长连接，自动重连与退避 |
| 私聊 | 用户直接给机器人发消息即触发 Agent（需先绑定飞书账号） |
| 群聊 @ | 群里 @ 机器人触发；自动注入最近群聊讨论作为上下文（`[HH:mm] 发送人：内容`） |
| 图片 / 文件入站 | 图片转多模态 image_url 并落盘会话工作区 `chat-files/{yyyy-MM-dd}/`（0.0.77 起，含 post 富文本内嵌图片），消息附保存路径提示；文件下载同目录归档，以 `@{路径}@` 引用 |
| 未绑定引导 | 未绑定的用户收到绑定引导文案（含绑定链接） |
| 解绑保留 | 解绑后机器人无法识别身份，原工作区与会话保留 |

## 角色与操作入口

| 角色 | 操作 | 入口 |
|------|------|------|
| 管理员 | 添加/编辑/启停/删除机器人，配置每个机器人的 Agent/模型 | 管理后台「飞书机器人」（[admin.md](admin.md)） |
| 普通用户 | 绑定/解绑飞书账号、查看绑定状态 | 桌面端「设置 → 飞书Bot」（[desktop.md](desktop.md)） |

## 使用流程

1. **飞书开放平台**：创建自建应用，获取 App ID / App Secret；开通机器人能力与所需权限（至少：消息与群组相关、**获取用户 union_id**——未开通则无法识别发送者，全员按未绑定处理）。
2. **管理后台**：「飞书机器人」→ 添加机器人（内部唯一键、名称、App ID、App Secret、Agent、模型）→ 启用。保存 App Secret 需后端已配置 `APP_FEISHU_BOT_SECRET`（AES-GCM 加密存储）。
3. **用户绑定**：桌面端「设置 → 飞书Bot」→ 绑定飞书账号（扫码/内嵌窗口授权）→ 状态变为已绑定。
4. **使用**：私聊机器人直接发消息；群聊把机器人拉进群后 @ 机器人。
5. **解绑**：设置页「解绑」，不影响既有工作区与会话。

## REST API

### 管理端（需管理员权限）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/admin/feishu-bots` | 机器人列表（`appSecret` 不返回，仅 `appSecretConfigured`） |
| GET | `/v1/admin/feishu-bots/:id` | 单个机器人 |
| POST | `/v1/admin/feishu-bots` | 创建：`appKey`、`name`、`appId`、`appSecret`、`agentId?`、`modelId?`、`enabled?` |
| PUT | `/v1/admin/feishu-bots/:id` | 更新（`appSecret` 传空串不修改） |
| DELETE | `/v1/admin/feishu-bots/:id` | 软删除 |
| POST | `/v1/admin/feishu-bots/:id/enable` / `disable` | 启用 / 停用 |

### 用户端（需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/feishu/binding` | 发起绑定，返回授权链接 `authUrl`（未启用飞书登录返回空） |
| GET | `/v1/feishu/binding/status` | 绑定状态：`bound`、`unionId`、`boundAt` |
| DELETE | `/v1/feishu/binding` | 解绑 |

## 排障

- **保存机器人报「未配置 APP_FEISHU_BOT_SECRET」**：后端未配置加密密钥，配置后重启。
- **全员提示未绑定**：飞书应用未开通「获取用户 union_id」权限。
- **群聊 @ 不触发**：确认机器人已进群、@ 的是本机器人（同群多个机器人时以 App ID 精确匹配）、管理员已启用该机器人。
- **长连接频繁断开**：查看 `FEISHU_BOT_RECONNECT_*` 退避参数与 `FEISHU_BOT_MAX_CONSECUTIVE_FAILURES` 告警阈值。
