# 飞书自建应用机器人通道技术方案

## 1. 需求背景

Mao 目前通过「微信通道对话」支持用户在微信内与 AI Agent 对话并执行任务（`backend-ts/src/weixin/`：ilink 网关长轮询 → 入站处理 → Agent 执行 → 回复发送；每用户一个固定云端工作区与会话）。该通道使用体验良好，用户希望将同能力扩展到飞书。

本次需求：通过**飞书自建应用机器人**，在飞书内与 Mao Agent 对话并执行云端任务，覆盖**私聊**与**群聊@机器人**两种场景，并支持**在管理后台配置多个飞书机器人、为每个机器人绑定独立的 Agent 与模型**。飞书先行落地；钉钉后续参考飞书最佳实践再单独设计。

### 1.1 现状与差异

| 维度 | 微信通道（现状） | 飞书通道（本次） |
|------|------------------|------------------|
| 消息接入 | ilink 网关 HTTP 长轮询（`monitor.service.ts`） | 飞书开放平台 **WebSocket 长连接**（事件订阅长连接模式） |
| 机器人实例 | 单账号（设置页扫码绑定，`weixin_channel_account` 表） | **多机器人**：管理后台添加与管理（`feishu_bot` 表，DB 动态管理，长连接按机器人启停） |
| 身份绑定 | 设置页扫码绑定，`weixin_channel_account` 表 | **双入口绑定**（飞书内引导链接 + 桌面端设置页授权），以 `union_id`（跨应用全局一致）为身份锚，绑定一次全机器人通用 |
| Agent/模型 | 全局设置键 `weixin.agentId` / `weixin.modelId` | **每机器人独立**：`feishu_bot.agent_id` / `feishu_bot.model_id`，管理后台配置 |
| 工作区 | 每用户一个固定工作区+会话（`projectKey='weixin-bot'`） | 私聊：**机器人×用户**各一个工作区；群聊：**机器人×群**各一个共享工作区（独立命名空间） |
| 群聊上下文 | 不做 | 独立日志表全量持久化群消息，@触发时按需注入（不写会话消息表） |
| 消息类型 | 文本、图片、文件、语音 | 文本、图片（多模态）、文件（落工作区）；出站统一文本 |
| 已具备的基础 | — | 飞书 OAuth 登录（`feishu-auth.service.ts`，登录应用凭证 `app_id/app_secret` 已配置）、飞书 Webhook 通知、admin 管理后台（Vue3 + 权限体系） |

## 2. 需求描述

### 2.1 做（本期范围）

1. **多飞书机器人接入（WebSocket 长连接模式，管理后台管理）**
   - 机器人实例存 DB（`feishu_bot` 表），管理后台提供添加、编辑、启用/停用、删除（软删）能力；`app_secret` 加密存储。
   - 新增 `FeishuMonitorService`：周期扫描启用机器人（仿 `WeixinMonitorService` reconcile 机制），为每个机器人建立一条长连接：获取该应用的 `tenant_access_token`（`POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`，官方标准端点）→ 连接飞书事件长连接网关 → 分发事件。新增/启停热生效。
   - 每机器人一条长连接，独立断线重连（指数退避）、token 自动续期；长连接仅在后端单实例上运行（生产为单进程部署，见 `scripts/start-backend.sh`），通过全局配置开关控制是否启用。
   - 事件接收不需要 URL 验证与签名校验（长连接模式无回调地址；安全由 token 通道保证）。

2. **管理后台「飞书机器人」管理**
   - 新增 admin 页面与路由：机器人列表（名称、app_id、状态、绑定的 Agent/模型、绑定用户数、最近事件时间）、添加/编辑表单（名称、app_id、app_secret、Agent 下拉、模型下拉）、启用/停用、删除。
   - REST 接口（admin 鉴权，复用 `@RequirePermission` 权限体系）：`/v1/admin/feishu-bots` CRUD + 启停。
   - 每机器人独立 Agent/模型：`feishu_bot.agent_id` / `feishu_bot.model_id`（可空 → 回退默认 Agent / 默认模型）；配置修改后，会话复用时按新配置热切换（复用微信通道 session 切换 Agent/模型逻辑）。

3. **用户身份绑定（双入口，以 union_id 为身份锚）**
   - 身份锚说明：飞书 `open_id` 是**应用维度**（同一用户在不同机器人下 open_id 不同），`union_id` 是**跨应用全局一致**。绑定以 `union_id` 关联到 Mao 用户，绑定一次，所有机器人通用；机器人事件侧利用 `sender_id` 中的 `union_id` 解析 Mao 用户。
   - 入口一：飞书内引导。未绑定用户在飞书内私聊机器人（或在群里@机器人）时，机器人回复绑定引导消息（含绑定链接）。点击后走现有飞书 OAuth 授权回调（登录应用），完成绑定。
   - 入口二：桌面端设置页新增「飞书机器人」绑定项，展示各启用机器人的绑定状态，提供绑定/解绑。
   - 绑定映射：新增 `feishu_binding` 表，`union_id（唯一）↔ userId`，并冗余登录应用侧 `open_id / user_id` 便于调试。
   - 一个飞书身份（union_id）绑定一个 Mao 用户；解绑后原工作区与会话保留（对齐微信通道解绑语义）。

4. **私聊场景（机器人 × 用户 固定工作区）**
   - 用户与机器人私聊，逻辑对齐微信通道：每个（机器人 app_key, 用户）一个固定云端工作区与会话（`projectKey='feishu-{appKey}-private'`，CLOUD、FULL 权限），不随消息数增长重复建会话；同一会话串行执行，新消息到达时按代际取消当前执行并纠偏（复用 `AgentWeixinInboundHandler` 的 generation/sessionLock 机制）。
   - Agent/模型来自该机器人配置（`feishu_bot.agent_id` / `feishu_bot.model_id`）。

5. **群聊场景（机器人 × 群 共享工作区）**
   - 群内成员 @机器人 触发任务对话；未@机器人不触发 Agent，但消息全量持久化（见第 6 条）。
   - 工作区：每个（机器人 app_key, 群）一个独立目录 `{workspaceRoot}/feishu-chat/{appKey}/{chatId}/`（独立命名空间，不挂任何普通用户目录）；`feishu_chat` 表维护 `app_id+chat_id ↔ 会话/工作区`，`feishu_chat_member` 表维护群成员白名单。
   - 会话归属：`session.userId` 记为群内**首位完成绑定的成员**（负责人），工作区文件落群独立目录；权限校验在飞书入站处理器内完成：触发者必须是已绑定成员且在群成员白名单中，否则按「未绑定处理」逻辑响应。
   - 首次群内触发：懒创建 `feishu_chat` 记录、工作区目录与群会话；此后复用。
   - 群消息处理同样采用代际取消 + 串行锁，同一时刻仅执行一条触发消息。

6. **群聊上下文持久化与注入**
   - 新增 `feishu_group_message_log` 表，全量持久化群内消息（含未@机器人的），字段含 app_id、chat_id、发送人 open_id/显示名、类型、内容、飞书 file_key/image_key、消息 ID、是否@机器人、时间。
   - @机器人触发时，注入「最近 30 条 / 最近 2 小时（取两者较小的窗口，可配置）」的群聊记录，拼接为群聊上下文附在本次触发消息之前，格式：`[HH:mm] 发送人显示名：内容`（图片标注 `[图片]`、文件标注 `[文件:名称]`）。
   - **不写入 session 的 message 表**：非触发消息不进会话历史，避免污染标题生成、上下文压缩与消息展示。
   - Agent 感知用户关系的范围：仅发送人标记（显示名+时间），不调用飞书通讯录 API 获取职位/部门。

7. **消息类型与媒体**
   - 入站：文本（直接处理）；图片（通过 `im/v1/messages/{message_id}/resources/{file_key}?type=image` 下载，转 data URI 走多模态，复用微信 `media.service` 思路）；文件（下载后保存到对应工作区（私聊→该机器人用户工作区，群聊→该机器人群工作区），消息内容以 `@{路径}@` 引用，供 Agent 读取）。
   - 出站：统一文本。群聊以**引用回复**（`reply_id` 指向触发消息）发送，私聊直接文本发送；单条回复超过 2000 字截断并追加「…（回复过长已截断）」。
   - 回复目标：私聊 `receive_id=open_id`；群聊 `receive_id=chat_id`；按触发消息所在机器人路由（各机器人用自己的 tenant_access_token 发送）。

8. **未绑定成员的群聊处理**
   - 未绑定成员 @机器人：引用回复「请先完成账号绑定后再使用」，附绑定引导链接；不执行 Agent、不创建群工作区/会话；该条触发消息仍写入群日志（作为上下文素材）。

### 2.2 不做（本期明确排除）

- **不做钉钉**：仅飞书落地；钉钉后续参考飞书最佳实践另行设计。
- **不做群聊组织架构/职位信息注入**：不调用通讯录 API，Agent 仅通过发送人标记感知成员。
- **不做出站媒体/富交互卡片**：Agent 回复一律文本（不出图、不出文件、不做 interactive card）。
- **不做语音**：飞书语音消息入站不支持，收到后提示暂不支持。
- **不做主动推送**：机器人仅回复触发消息，不主动向用户/群推送任务进展。
- **不做私聊多会话切换**：每个（机器人, 用户）固定一个工作区一个会话。
- **不做多实例长连接分发**：长连接单实例运行（生产单进程），不引入分布式锁/选主。
- **不做群权限管理后台**：群成员白名单自动维护（触发过机器人且已绑定的成员自动入表），管理后台不提供群成员手工增删。
- **不做机器人级资源配额**：不限制单机器人并发/用量。

## 3. 技术选型

| 组件 | 选型 | 说明 |
|------|------|------|
| 事件接入 | 飞书开放平台 WebSocket 长连接 | 无需公网回调地址；服务端常驻连接 + 自动重连；每机器人一条连接 |
| 机器人管理 | admin 管理后台 + `feishu_bot` 表 | DB 动态管理，长连接 reconcile 热生效 |
| HTTP/API 客户端 | 内置 `fetch`（Node 22） | 与现有 `feishu-auth.service.ts` 一致，不引入飞书官方 SDK |
| token 获取 | 每机器人 `tenant_access_token`（官方标准端点） | 用各自 app_id/app_secret |
| 入站处理 | 新增 `backend-ts/src/feishu/` 模块 | 仿 `weixin/` 分层：监控、长连接、绑定、入站、会话、发送、文件 |
| 会话/Agent 执行 | 复用 `SessionService` / `HarnessService` / `AgentLoop` | 不重造执行引擎 |
| 数据库 | MySQL 8 + Flyway 迁移（V084） | 表结构见 §5 |
| 敏感配置 | `app_secret` 加密存储 | 复用 `crypto/aes-gcm.ts`，密钥来自新增配置 `APP_FEISHU_BOT_SECRET` |

## 4. 总体架构

```
飞书客户端（私聊 / 群聊@机器人，多机器人各自独立）
        │ 消息（im.message.receive_v1）
        ▼
飞书开放平台事件网关
        │ WebSocket 长连接（服务端主动连接，每机器人一条）
        ▼
backend-ts/src/feishu/
├─ feishu-monitor.service.ts      # reconcile：扫描启用机器人 → 启动/停止长连接（仿 weixin monitor）
├─ long-connection.service.ts     # 单机器人长连接生命周期：token 获取/续期、连接、心跳、断线重连
├─ event-dispatcher.ts            # 事件分发：识别 im.message.receive_v1，路由到私聊/群聊处理器
├─ binding.service.ts             # 绑定：绑定链接生成、OAuth 回调落库（union_id 锚）、解绑
├─ private-chat.handler.ts        # 私聊处理：union_id→用户 → 会话/工作区 → Agent 执行 → 回复
├─ group-chat.handler.ts          # 群聊处理：@检测 → 日志持久化 → 白名单校验 → 上下文注入 → Agent 执行 → 引用回复
├─ group-context.service.ts       # 群日志读写 + 注入窗口组装
├─ session.service.ts             # 私聊/群会话与工作区的获取/创建（仿 weixin/session.service.ts）
├─ inbound-processor.ts           # 入站消息标准化：文本/图片/文件下载
├─ send.service.ts                # 发送：文本、引用回复
├─ media.service.ts               # 飞书资源下载（image/file）→ data URI / 工作区落盘
├─ admin.routes.ts                # 管理后台 REST：机器人 CRUD + 启停 + Agent/模型配置
└─ feishu.routes.ts               # 设置页绑定 REST 接口
        │
        ▼
复用现有能力：SessionService / HarnessService（AgentLoop、ToolRegistry）/ admin 权限体系 / 文件存储
```

消息处理链路（与微信通道对齐）：

```
reconcile 扫描 feishu_bot → 每机器人一条长连接收事件 → event-dispatcher（按事件 app 定位机器人）
  ├─ 私聊：union_id 解析用户 → 绑定校验 → 懒创建/复用该机器人该用户工作区与会话
  │        → 保存 USER 消息 → prepareMessage
  └─ 群聊：写入 group_message_log → 检测是否@机器人
        ├─ 未@：仅持久化，结束
        └─ @：union_id 解析用户 → 白名单校验（未绑定→引导回复）→ 懒创建/复用该机器人该群工作区与会话
             → 组装群聊上下文 + 触发消息 → 保存 USER 消息 → prepareMessage
Agent 执行（代际取消 + 串行锁，复用 weixin handler 机制）
发送：私聊直接文本 / 群聊引用回复（截断 2000 字），走对应机器人 tenant_access_token
```

## 5. 数据库设计（Flyway `V084__feishu_bot_channel.sql`）

```sql
-- 飞书机器人配置（管理后台管理；多机器人）
CREATE TABLE IF NOT EXISTS `feishu_bot` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `app_key`     VARCHAR(64)  NOT NULL COMMENT '内部唯一标识（如 feishu-bot-1）',
    `name`        VARCHAR(128) NOT NULL COMMENT '机器人显示名称',
    `app_id`      VARCHAR(128) NOT NULL COMMENT '飞书应用 app_id（唯一）',
    `app_secret`  VARCHAR(512) NOT NULL COMMENT '飞书应用 app_secret（AES-GCM 加密存储）',
    `agent_id`    BIGINT       NULL COMMENT '绑定 Agent（可空→默认 Agent）',
    `model_id`    BIGINT       NULL COMMENT '绑定模型（可空→默认模型）',
    `enabled`     TINYINT      NOT NULL DEFAULT 1,
    `deleted`     TINYINT      NOT NULL DEFAULT 0,
    `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_app_key` (`app_key`),
    UNIQUE KEY `uk_app_id` (`app_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='飞书机器人配置';

-- 用户绑定：以 union_id（跨应用全局一致）为身份锚，绑定一次全机器人通用
CREATE TABLE IF NOT EXISTS `feishu_binding` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`     BIGINT       NOT NULL COMMENT 'Mao 系统用户ID',
    `union_id`    VARCHAR(128) NOT NULL COMMENT '飞书 union_id（全局唯一）',
    `open_id`     VARCHAR(128) NULL COMMENT '登录应用侧 open_id（调试冗余）',
    `user_id_fs`  VARCHAR(128) NULL COMMENT '登录应用侧 user_id（调试冗余）',
    `deleted`     TINYINT      NOT NULL DEFAULT 0,
    `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_union_id` (`union_id`),
    UNIQUE KEY `uk_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='飞书用户绑定（union_id 锚）';

-- 群会话映射：机器人×群 → 会话/工作区/负责人
CREATE TABLE IF NOT EXISTS `feishu_chat` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `app_id`        VARCHAR(128) NOT NULL COMMENT '飞书应用 app_id（机器人维度）',
    `chat_id`       VARCHAR(128) NOT NULL COMMENT '飞书群 open_chat_id',
    `session_id`    BIGINT       NOT NULL COMMENT 'Mao 会话ID',
    `owner_user_id` BIGINT       NOT NULL COMMENT '群内首位绑定成员（session.userId 归属）',
    `workspace`     VARCHAR(512) NULL COMMENT '群工作区路径',
    `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_app_chat` (`app_id`, `chat_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='飞书群会话映射';

-- 群成员白名单：自动维护（已绑定成员触发过即入表）
CREATE TABLE IF NOT EXISTS `feishu_chat_member` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `app_id`        VARCHAR(128) NOT NULL,
    `chat_id`       VARCHAR(128) NOT NULL,
    `user_id`       BIGINT       NOT NULL COMMENT '绑定后的 Mao 用户ID',
    `open_id`       VARCHAR(128) NOT NULL COMMENT '该机器人应用下成员 open_id',
    `display_name`  VARCHAR(128) NULL COMMENT '飞书显示名快照',
    `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_app_chat_member` (`app_id`, `chat_id`, `open_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='飞书群成员白名单';

-- 群聊消息日志：全量持久化（含未@消息），@触发时按窗口注入
CREATE TABLE IF NOT EXISTS `feishu_group_message_log` (
    `id`             BIGINT PRIMARY KEY AUTO_INCREMENT,
    `app_id`         VARCHAR(128) NOT NULL,
    `chat_id`        VARCHAR(128) NOT NULL,
    `sender_open_id` VARCHAR(128) NOT NULL,
    `sender_name`    VARCHAR(128) NOT NULL COMMENT '飞书显示名快照',
    `msg_type`       VARCHAR(32)  NOT NULL DEFAULT 'text' COMMENT 'text/image/file',
    `content`        TEXT         NULL COMMENT '文本内容；图片/文件为名称或摘要',
    `file_key`       VARCHAR(255) NULL COMMENT '飞书 file_key/image_key',
    `message_id`     VARCHAR(128) NULL COMMENT '飞书消息ID（引用回复用）',
    `is_mention`     TINYINT      NOT NULL DEFAULT 0 COMMENT '是否@机器人',
    `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY `idx_app_chat_time` (`app_id`, `chat_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='飞书群聊消息日志';
```

说明：
- `session` 表不改结构：群会话 `userId` 记 `owner_user_id`，`workspace` 记群独立目录，`projectKey` 记 `feishu-chat-{appKey}-{chatId}`；私聊 `projectKey` 记 `feishu-{appKey}-private`。
- 私聊不新增表：`feishu_binding` 解析用户后，按 `projectKey` 查询/创建会话（对齐微信通道 `findActiveByUserAndProjectKey`）。

## 6. 模块详细设计

### 6.1 机器人监控与长连接（`feishu-monitor.service.ts` + `long-connection.service.ts`）

- `FeishuMonitorService`（仿 `WeixinMonitorService`）：
  - `start()`：全局开关 `cfg.feishu.bot.enabled && longConnection.enabled` 时启动；`reconcile` 周期（默认 5s）扫描 `feishu_bot` 中 `enabled=1` 的机器人：新增的启动长连接、被停用/删除的停止连接；热生效。
  - `shutdown()`：关闭全部机器人连接。
- `LongConnectionService`（单机器人实例）：
  - 生命周期：用该机器人 app_id/app_secret（解密后）获取 `tenant_access_token`（缓存至过期前 5 分钟自动续期）→ 连接飞书事件长连接网关 → 收事件 JSON → 交 `event-dispatcher`（带 app 标识）。
  - 断线重连：指数退避（1s/2s/4s/…上限 30s），连续失败超过阈值告警日志；token 无效时强制刷新后重连。
  - 心跳：长连接自带心跳（按飞书协议），本地超时兜底主动断开重连。
  - 具体连接端点与握手协议以飞书开放平台官方文档为准，实现时对账官方文档，不在此臆测。

### 6.2 事件分发（`event-dispatcher.ts`）

- 解析事件：`event.type === 'im.message.receive_v1'` 时取 `event.message.chat_type`（p2p / group）、`event.sender.sender_id`（`open_id` + `union_id`）、`event.message.message_id`、`message_type`、`content`（JSON 字符串）。
- 路由：p2p → 私聊处理器；group → 群聊处理器；其他事件类型（如加群、欢迎）记录日志后忽略。
- 解析 @机器人 提及：飞书文本消息 `content` 中提及元素（`mention`）含 `key`（机器人自身 key 以应用 id 标识），命中即 `is_mention=true`；同时从 `content` 剔除 @ 语法残留，保留正文。

### 6.3 绑定服务（`binding.service.ts`）

- 身份解析：事件侧 `union_id`（全局一致）→ `feishu_binding` 命中 → Mao 用户；未命中 → 未绑定。
- 绑定链接：设置页或飞书内引导链接携带 `state`（复用 `feishu_oauth_state` 机制）；OAuth 回调成功后以 union_id 写入 `feishu_binding`。
- 解绑：置 `deleted=1`（保留历史），私聊会话与工作区保留。
- 设置页接口（`feishu.routes.ts`，需登录）：
  - `GET  /v1/feishu/binding/status`：绑定状态（bound、union_id、绑定时间）
  - `POST /v1/feishu/binding`：生成绑定链接（OAuth 授权）
  - `DELETE /v1/feishu/binding`：解绑
- 飞书内引导：未绑定用户私聊/群聊触发时，机器人回复绑定引导文本（含链接），绑定完成后可正常使用；群内成员绑定后下次触发时自动登记进该群 `feishu_chat_member`。

### 6.4 管理后台（`admin.routes.ts` + admin 前端）

- REST（admin 鉴权，复用 `@RequirePermission`）：
  - `GET    /v1/admin/feishu-bots`：列表（含绑定用户数、enabled、agent/model 名称）
  - `POST   /v1/admin/feishu-bots`：添加（app_key 唯一、app_id 唯一；app_secret 加密入库）
  - `PUT    /v1/admin/feishu-bots/:id`：编辑（名称、app_secret、agent_id、model_id）
  - `DELETE /v1/admin/feishu-bots/:id`：软删（停用并移除长连接）
  - `POST   /v1/admin/feishu-bots/:id/enable` / `/disable`：启停（reconcile 热生效）
- Agent/模型下拉数据源：现有 agent / model 服务列表接口。
- admin 前端：新增「飞书机器人」页面（列表 + 表单弹窗），路由挂管理后台菜单（对齐现有 admin 页面风格，Vue3 `<script setup>`）。

### 6.5 会话与工作区（`session.service.ts`，仿 `weixin/session.service.ts`）

- 私聊：`getOrCreatePrivateSession(userId, appKey)` —— `projectKey='feishu-{appKey}-private'`，`executionMode='CLOUD'`，`permissionLevel='FULL'`，Agent/模型取该机器人 `feishu_bot.agent_id/model_id`（空→默认）；`workspace=null` 交给 `SessionService.initializeCloudWorkspace` 按用户目录创建；`withUserLock(userId)` 串行化创建；复用时按机器人配置热切换 Agent/模型（对齐微信通道切换逻辑）。
- 群聊：`getOrCreateGroupSession(appId, chatId, ownerUserId)` —— 查 `feishu_chat`（app_id+chat_id）命中则复用；未命中则创建会话（`userId=ownerUserId`，`projectKey='feishu-chat-{appKey}-{chatId}'`，`workspace=null`），创建后把 `workspace` 更新为 `{workspaceRoot}/feishu-chat/{appKey}/{chatId}/`（独立命名空间目录，`ensureWorkspaceDirectory`），写入 `feishu_chat`；`withChatLock(appId, chatId)` 串行化。
- 权限：群聊处理器在触发时校验 `feishu_chat_member`（已绑定成员自动登记）；非成员/未绑定按 §2.1.8 响应。

### 6.6 入站处理（`inbound-processor.ts`）

- 文本：`content` 解析 → 正文（剔除 @ 残留）。
- 图片：`message_type=image` → `im/v1/messages/{message_id}/resources/{file_key}?type=image` 下载 → data URI（走多模态，对齐微信 `imageDataUris`）。
- 文件：`message_type=file` → 下载 → 保存到会话工作区（私聊→该机器人用户工作区；群聊→该机器人群工作区）→ 消息内容 `@{路径}@` 引用（对齐微信 `InboundFile` 语义）。
- 下载失败：文本消息中追加 `[以下文件接收失败：…]` 通知（复用 `appendDownloadErrorNotice` 语义）。
- 空消息（无文本无媒体）直接丢弃并记日志。

### 6.7 群聊上下文（`group-context.service.ts`）

- 写入：所有群消息（含未@、含未绑定成员发言）异步写 `feishu_group_message_log`（fire-and-forget，不阻塞长连接收包）。
- 注入：@触发时查询该（app_id, chat_id）下「最近 30 条且 2 小时内」的记录，组装：

  ```
  [群聊上下文，以下为群内最近讨论]
  [09:31] 张三：今天把接口文档先看一遍
  [09:32] 李四：我这边模型联调还没完
  ---
  （触发者李四）请基于上面讨论继续处理：…
  ```

- 不写 `message` 表；注入发生在 `prepareMessage` 之前，作为当次 USER 消息的前缀。
- 窗口参数 `cfg.feishu.bot.groupContext.maxItems=30`、`maxMinutes=120` 可配置。

### 6.8 发送服务（`send.service.ts`）

- 文本：`POST /open-apis/im/v1/messages?receive_id_type=chat_id|open_id`，`msg_type=text`，使用**触发消息所属机器人**的 `tenant_access_token`。
- 引用回复：`content` 携带 `reply_id`（触发消息 message_id，群聊时必带；私聊不带）。
- 截断：回复文本 > 2000 字截断并追加提示。
- 发送失败记日志（不对用户重试轰炸）。

### 6.9 配置（`application.yml` 新增 `feishu.bot` 段）

```yaml
feishu:
  bot:
    enabled: ${FEISHU_BOT_ENABLED:false}          # 全局总开关
    app-secret-key: ${APP_FEISHU_BOT_SECRET:}     # feishu_bot.app_secret 加解密密钥
    long-connection:
      enabled: ${FEISHU_BOT_LC_ENABLED:true}
      reconcile-interval-ms: ${FEISHU_BOT_RECONCILE_INTERVAL_MS:5000}
      reconnect-base-ms: 1000
      reconnect-max-ms: 30000
      max-consecutive-failures: 5
    group-context:
      max-items: ${FEISHU_BOT_GROUP_CONTEXT_MAX_ITEMS:30}
      max-minutes: ${FEISHU_BOT_GROUP_CONTEXT_MAX_MINUTES:120}
    reply:
      max-length: ${FEISHU_BOT_REPLY_MAX_LENGTH:2000}
    file:
      max-inbound-file-mb: ${FEISHU_BOT_MAX_INBOUND_FILE_MB:100}
```

`AppConfig` 接口同步扩展 `feishu.bot` 结构（对齐 `weixin.bot` 风格；机器人实例本身存 DB，不进配置）。

## 7. 实现步骤

### 阶段一：数据与配置底座
1. `V084__feishu_bot_channel.sql`：建 5 张表（§5）。
2. `AppConfig` 扩展 `feishu.bot` 配置段 + 默认值 + 示例配置（`application-example.yml`）。

### 阶段二：管理后台与绑定
3. `feishu-http.ts`：封装 `tenant_access_token` 获取与通用请求（仿 `weixin-http.ts`）。
4. `feishu_bot.repository.ts` + `admin.routes.ts`：机器人 CRUD/启停 + app_secret 加密（`crypto/aes-gcm.ts`）。
5. admin 前端「飞书机器人」页面与路由。
6. `binding.service.ts` + `feishu_binding.repository.ts`：双入口绑定（OAuth 回调落库 + 绑定链接生成）。
7. `feishu.routes.ts` 设置页绑定接口 + 桌面端设置页「飞书机器人」绑定项。

### 阶段三：长连接与私聊链路
8. `long-connection.service.ts` + `feishu-monitor.service.ts`：reconcile、连接、心跳、重连、停机。
9. `session.service.ts`：`getOrCreatePrivateSession`。
10. `inbound-processor.ts`：文本/图片/文件入站标准化。
11. `private-chat.handler.ts`：union_id 解析 → 会话 → 保存消息 → Agent 执行（代际取消/串行锁）→ 回复。
12. 事件分发接通 p2p。

### 阶段四：群聊链路
13. `group-chat.handler.ts` + `group-context.service.ts` + `feishu_chat/feishu_chat_member/feishu_group_message_log` 仓储。
14. 群日志全量持久化 + @检测 + 白名单校验 + 上下文注入 + 引用回复。
15. 群工作区独立命名空间创建与复用。

### 阶段五：收尾
16. 单测（长连接重连、绑定匹配、群上下文注入窗口、@解析、发送截断、机器人 CRUD）、集成测试（仿 weixin 模块 spec 风格）。
17. CHANGELOG 记录、README/DEPLOY 补充配置与运维说明、mao-cli 手册补充「飞书机器人」小节。

## 8. 落地清单

| 序号 | 任务项 | 模块 | 优先级 |
|------|--------|------|--------|
| 1 | V084 迁移脚本（5 张表） | backend-ts/db/migration | P0 |
| 2 | AppConfig 扩展 feishu.bot 配置段 + 示例配置 | backend-ts/src/config | P0 |
| 3 | feishu-http.ts（tenant_access_token 封装） | backend-ts/src/feishu | P0 |
| 4 | feishu_bot.repository.ts + admin.routes.ts（机器人 CRUD/启停/加密） | backend-ts/src/feishu | P0 |
| 5 | admin 前端「飞书机器人」管理页面与路由 | admin/src | P0 |
| 6 | binding.service.ts + feishu_binding.repository.ts（双入口绑定） | backend-ts/src/feishu | P0 |
| 7 | feishu.routes.ts 设置页绑定接口 + 桌面端设置页绑定项 | backend-ts/src/feishu + desktop | P0 |
| 8 | long-connection.service.ts + feishu-monitor.service.ts（reconcile/连接/重连/停机） | backend-ts/src/feishu | P0 |
| 9 | session.service.ts（私聊/群会话与工作区获取创建，机器人配置热切换） | backend-ts/src/feishu | P0 |
| 10 | inbound-processor.ts（文本/图片/文件入站） | backend-ts/src/feishu | P0 |
| 11 | private-chat.handler.ts（私聊链路） | backend-ts/src/feishu | P0 |
| 12 | event-dispatcher.ts 接通 p2p 分发 | backend-ts/src/feishu | P0 |
| 13 | group-chat.handler.ts（@检测/白名单/触发处理） | backend-ts/src/feishu | P0 |
| 14 | group-context.service.ts（日志读写 + 窗口注入） | backend-ts/src/feishu | P0 |
| 15 | send.service.ts（文本/引用回复/截断/按机器人路由） | backend-ts/src/feishu | P0 |
| 16 | 未绑定用户引导回复链路 | backend-ts/src/feishu | P1 |
| 17 | 单测 + 集成测试（仿 weixin spec 风格） | backend-ts/src/feishu | P1 |
| 18 | CHANGELOG / README / DEPLOY / mao-cli 手册更新 | 文档 | P1 |

## 9. 风险与应对

| 风险 | 等级 | 应对 |
|------|------|------|
| 飞书长连接协议/端点与预期不符 | 中 | 实现前对账飞书开放平台官方文档；接口层抽象隔离（feishu-http），便于调整 |
| tenant_access_token 过期导致事件断流 | 中 | 提前续期（过期前 5 分钟）+ 失败强制刷新重连 + 监控日志 |
| OAuth 侧与事件侧 ID 类型不一致 | 中 | 以 union_id（跨应用全局一致）为唯一身份锚，避免 open_id 应用维度差异 |
| app_secret 泄露风险 | 中 | AES-GCM 加密存储，密钥走 `APP_FEISHU_BOT_SECRET` 环境变量，不入 git |
| 多机器人长连接资源开销 | 低 | reconcile 启停热生效；停用机器人即断开连接；机器人数量由管理后台控制 |
| 群日志表无限增长 | 低 | 窗口注入限制 + 定期清理（如保留 30 天，落地清单补充清理任务） |
| 图片/文件下载失败 | 低 | 复用微信通道的错误通知语义，不中断 Agent |
| 单实例长连接抖动 | 低 | 指数退避重连 + 连续失败告警日志；生产单进程部署天然适配 |

## 10. 验收标准

1. 管理后台可添加/编辑/启停/删除多个飞书机器人，app_secret 加密存储，Agent/模型独立绑定并热生效。
2. 用户在飞书私聊任一启用机器人：未绑定收到引导；绑定后（绑定一次，所有机器人通用）可对话执行云端任务；不同机器人私聊工作区相互独立、上下文不串。
3. 桌面端设置页可查看各机器人绑定状态、完成绑定/解绑。
4. 群内@机器人触发任务；未@消息被持久化且不触发 Agent；@触发时 Agent 能看到最近群讨论（含发送人标记）。
5. 未绑定成员@机器人收到引导回复，不创建群工作区。
6. 同一群在不同机器人下工作区独立；同一机器人下不同群工作区独立。
7. 图片可被多模态模型理解；文件落对应工作区可被 Agent 读取。
8. 长连接断网后可自动恢复；后端重启后按 `feishu_bot` 表自动恢复各机器人连接；停用机器人后连接断开。
9. 后端 `npm run build && npm test` 通过；无 Playwright 依赖。

## 11. 后续规划（不做，仅记录方向）

- **钉钉机器人通道**：参考飞书落地的最佳实践（长连接/回调选择、绑定、群上下文注入、工作区划分、多实例管理）再行设计。
- 出站媒体/富卡片、语音、主动推送、多实例长连接分发、机器人级资源配额：视运营反馈评估。
