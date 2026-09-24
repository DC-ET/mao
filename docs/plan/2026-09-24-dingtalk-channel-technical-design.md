# 钉钉机器人通道技术方案

调研见 [docs/research/2026-09-24-dingtalk-channel-research.md](../research/2026-09-24-dingtalk-channel-research.md)。本文是落地设计，按当前飞书通道（`backend-ts/src/feishu/`）的分层来接，不新造执行引擎。

## 1. 背景

Mao 已有飞书自建应用机器人通道：管理后台多机器人、WebSocket 长连接、私聊与群 @、身份绑定、云端会话、入站排队、进度卡。钉钉用**企业内部应用机器人 + Stream 模式**走同一条链路。现有「任务完成通知」里的钉钉地址是自定义机器人 Webhook，只能往群里推文本，不扩展成通道。

钉钉和飞书的差异已经在调研里定过产品范围，本方案直接按那个范围实现。

## 2. 范围

### 2.1 要做

1. 管理后台配置多个企业内部机器人。每个机器人独立 Agent / 模型，Stream 随启停热生效。
2. 用户在桌面 / Web / 安卓设置页绑定、解绑钉钉身份。未绑定的人在钉钉里收到「点我绑定」卡，登录 Mao 后完成绑定，并重放刚才那条消息。
3. 私聊：文本、富文本、图片、文件。群：@ 机器人之后的文本、富文本、图片。
4. 回复走主动发送接口，不依赖 `sessionWebhook`。终态正文是一条 markdown；进度和排队用互动卡片。
5. 进度卡：执行中 / 完成 / 失败 / 取消，展示轮次摘要和耗时。按钮：取消、失败重试、打开网页会话。只允许原发送者点。
6. 会话忙时排队。排队卡：立即发送（打断当前任务）、取消本条。
7. 私聊 `---` 新建会话，并成为该私聊在钉钉侧的唯一活跃会话。执行中收到 `---` 先取消当前任务再新建。
8. 群上下文只注入本机器人收到的 @ 往来，加上本条自带的引用正文。
9. 已打开的网页 / 桌面 / 安卓会话跟上这一轮执行，复用现有 WebSocket 广播。

### 2.2 不做

| 不做 | 落地约定 |
|------|----------|
| `ask_user_questions` | 钉钉会话从工具列表去掉，与微信通道相同。不发提问卡，不把下一条文字解析成答案 |
| 列出会话、切换会话、引用切会话 | 没有 `会话` / `切换 N`。引用只注入正文，不改活跃会话 |
| 话题群、多 Thread 并行 | 不建话题表。群一个 `conversationId` 一个会话。私聊钉钉侧同时只有一个活跃会话 |
| 群内未 @ 消息 | 平台不推，不接入个人 IM 事件和消息菜单 |
| 出站引用回复 | 发送接口没有 reply 参数，回复是一条新消息 |
| 群文件 / 语音 / 视频 | 群 @ 收不到这些类型。单聊收到语音、视频时回复「暂不支持」，不把语音识别文本当任务 |
| 钉钉文档读取、组织架构注入 | 不调用文档和通讯录详情 |
| ECP 票闸门 | 钉钉绑定成功即可用。ECP 只服务飞书登录 |
| 自定义机器人 Webhook | 任务通知通道保持不动 |
| 多实例同时拉同一个 Client ID 的 Stream | 与飞书相同，只在单实例上跑 |
| 钉钉 OAuth 作为 Mao 登录方式 | 钉钉身份只做通道绑定，不创建用户 |

## 3. 架构

```
钉钉客户端（私聊 / 群 @）
        │ Stream
        ▼
backend-ts/src/dingtalk/
├─ monitor.service.ts         # 扫启用机器人，一机器人一个 dingtalk-stream 客户端
├─ event-normalizer.ts        # 收成内部消息
├─ token.ts                   # 新版 accessToken 与旧版 gettoken 分开缓存
├─ inbound-processor.ts       # 去重、绑定、下载、群上下文、交给 handler
├─ agent-inbound-handler.ts   # 排队、---、取消、进度卡、调用 HarnessService
├─ card-action.service.ts     # 卡片回调：取消、重试、排队
├─ card-client.ts             # 创建投放、按 outTrackId 更新变量
├─ message.service.ts         # 私聊指针、群会话、工作区
├─ send.service.ts            # 主动发送文本 / markdown
├─ media.ts                   # downloadCode 换链、媒体上传
├─ binding.routes.ts          # 设置页绑定 / 解绑 / OAuth 回调 / 短链
└─ admin.routes.ts            # 机器人 CRUD、连接状态、重连
        │
        ▼
SessionService / HarnessService / 现有 WebSocket 广播
```

依赖：`dingtalk-stream` 只负责长连接。OpenAPI 用 Node `fetch` 调 `api.dingtalk.com` 和 `oapi.dingtalk.com`，不引入 Tea SDK。

处理链路：

```
Stream 回调
  ├─ 立刻 ACK，Agent 放到后台
  ├─ (bot_id, msg_id) 去重
  ├─ 无 senderStaffId / 未绑定 → 绑定卡，结束
  ├─ 私聊 --- → 取消当前执行，新建会话，回复确认，结束
  ├─ 下载图片 / 文件
  ├─ 群：写入 @ 日志，拼「@ 往来 + 引用正文」
  ├─ 独立文件：只落盘，不跑 Agent
  └─ 会话空闲则执行，否则入队并发排队卡
执行过程更新进度卡，并把事件推到已连接的网页客户端
终态：更新进度卡 + 另发一条 markdown 正文
```

卡片回调同样先在 2 秒内返回新变量，取消 / 重试 / 插队的重活放在返回之后。回调处理过程中不调「更新卡片」接口。

## 4. 数据模型

迁移 `V120__dingtalk_bot_channel.sql`。身份、会话、队列都独立成表，不复用 `feishu_*`。

```sql
CREATE TABLE IF NOT EXISTS `dingtalk_bot` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `app_key`       VARCHAR(64)  NOT NULL COMMENT '内部唯一标识',
    `name`          VARCHAR(128) NOT NULL,
    `client_id`     VARCHAR(128) NOT NULL COMMENT 'Client ID / AppKey',
    `client_secret` VARCHAR(512) NOT NULL COMMENT 'AES-GCM',
    `robot_code`    VARCHAR(128) NOT NULL COMMENT '发送与下载使用，不假定等于 client_id',
    `agent_id`      BIGINT       NULL,
    `model_id`      BIGINT       NULL,
    `progress_card_template_id` VARCHAR(128) NULL,
    `queue_card_template_id`    VARCHAR(128) NULL,
    `enabled`       TINYINT      NOT NULL DEFAULT 1,
    `deleted`       TINYINT      NOT NULL DEFAULT 0,
    `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_bot_app_key` (`app_key`),
    UNIQUE KEY `uk_dingtalk_bot_client_id` (`client_id`)
);

CREATE TABLE IF NOT EXISTS `dingtalk_binding` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`    BIGINT       NOT NULL,
    `union_id`   VARCHAR(128) NOT NULL,
    `userid`     VARCHAR(128) NOT NULL COMMENT '企业内 senderStaffId',
    `deleted`    TINYINT      NOT NULL DEFAULT 0,
    `active_union_id` VARCHAR(128) GENERATED ALWAYS AS (IF(`deleted` = 0, `union_id`, NULL)) STORED,
    `active_userid`   VARCHAR(128) GENERATED ALWAYS AS (IF(`deleted` = 0, `userid`, NULL)) STORED,
    `active_user_id`  BIGINT       GENERATED ALWAYS AS (IF(`deleted` = 0, `user_id`, NULL)) STORED,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_binding_union_active` (`active_union_id`),
    UNIQUE KEY `uk_dingtalk_binding_userid_active` (`active_userid`),
    UNIQUE KEY `uk_dingtalk_binding_user_active` (`active_user_id`)
);

-- 私聊活跃指针与群会话共用。私聊 conversation_id 用钉钉回调里的 conversationId。
CREATE TABLE IF NOT EXISTS `dingtalk_chat` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `bot_id`        BIGINT       NOT NULL,
    `conversation_id` VARCHAR(128) NOT NULL,
    `chat_type`     VARCHAR(16)  NOT NULL COMMENT 'p2p / group',
    `session_id`    BIGINT       NOT NULL,
    `owner_user_id` BIGINT       NOT NULL,
    `workspace`     VARCHAR(512) NULL,
    `title`         VARCHAR(128) NULL COMMENT '群标题快照，可空',
    `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_chat` (`bot_id`, `conversation_id`)
);

CREATE TABLE IF NOT EXISTS `dingtalk_chat_member` (
    `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
    `bot_id`       BIGINT       NOT NULL,
    `conversation_id` VARCHAR(128) NOT NULL,
    `user_id`      BIGINT       NOT NULL,
    `userid`       VARCHAR(128) NOT NULL,
    `display_name` VARCHAR(128) NULL,
    `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_chat_member` (`bot_id`, `conversation_id`, `userid`)
);

-- 只有机器人收到的群消息（即 @）。不是完整群聊。
CREATE TABLE IF NOT EXISTS `dingtalk_group_message_log` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `bot_id`      BIGINT       NOT NULL,
    `conversation_id` VARCHAR(128) NOT NULL,
    `sender_userid` VARCHAR(128) NOT NULL,
    `sender_name` VARCHAR(128) NOT NULL,
    `direction`   VARCHAR(8)   NOT NULL COMMENT 'IN / OUT',
    `content`     TEXT         NULL,
    `message_id`  VARCHAR(128) NULL,
    `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY `idx_dingtalk_group_log` (`bot_id`, `conversation_id`, `id`)
);

CREATE TABLE IF NOT EXISTS `dingtalk_inbound_event` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `bot_id`     BIGINT       NOT NULL,
    `message_id` VARCHAR(128) NOT NULL,
    `chat_id`    VARCHAR(128) NULL,
    `status`     VARCHAR(16)  NOT NULL COMMENT 'CLAIMED / DONE / FAILED',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_inbound_event` (`bot_id`, `message_id`)
);

CREATE TABLE IF NOT EXISTS `dingtalk_inbound_queue` (
    `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
    `bot_id`          BIGINT       NOT NULL,
    `session_id`      BIGINT       NOT NULL,
    `message_id`      VARCHAR(128) NOT NULL,
    `out_track_id`    VARCHAR(128) NULL COMMENT '排队卡实例 ID',
    `sender_userid`   VARCHAR(128) NOT NULL,
    `mao_user_id`     BIGINT       NULL,
    `rank_no`         BIGINT       NOT NULL,
    `status`          VARCHAR(16)  NOT NULL DEFAULT 'QUEUED',
    `payload`         MEDIUMTEXT   NOT NULL,
    `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_queue_message` (`bot_id`, `message_id`),
    KEY `idx_dingtalk_queue_session` (`session_id`, `status`, `rank_no`)
);

CREATE TABLE IF NOT EXISTS `dingtalk_progress_card` (
    `session_id`    BIGINT PRIMARY KEY,
    `bot_id`        BIGINT       NOT NULL,
    `out_track_id`  VARCHAR(128) NOT NULL,
    `chat_type`     VARCHAR(16)  NOT NULL,
    `conversation_id` VARCHAR(128) NULL,
    `sender_userid` VARCHAR(128) NULL,
    `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS `dingtalk_oauth_state` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `state`      VARCHAR(64)  NOT NULL,
    `user_id`    BIGINT       NULL COMMENT '设置页发起时已有；钉钉内发起时先空，登录后再填',
    `status`     VARCHAR(16)  NOT NULL,
    `expires_at` DATETIME     NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_oauth_state` (`state`)
);

CREATE TABLE IF NOT EXISTS `dingtalk_pending_binding_message` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `state`      VARCHAR(64)  NOT NULL,
    `bot_id`     BIGINT       NOT NULL,
    `payload`    MEDIUMTEXT   NOT NULL,
    `status`     VARCHAR(16)  NOT NULL,
    `expires_at` DATETIME     NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_pending_state` (`state`)
);
```

去重语义对齐 `feishu_inbound_event`：`CLAIMED` 且超过 10 分钟，或 `FAILED`，允许再次认领；`DONE` 直接丢弃。处理失败要 `release`，避免一条消息卡死。

## 5. 连接

`DingtalkMonitorService` 对齐 `FeishuMonitorService`：`DINGTALK_BOT_ENABLED` 打开后按 5 秒扫 `dingtalk_bot`，启用的拉起 Stream，停用或软删的关掉。每个机器人：

- Topic `/v1.0/im/bot/messages/get` → 归一化后 `void processor.process()`，函数立刻返回。
- Topic `/v1.0/card/instances/callback` → 卡片动作。不注册 `*` 事件。
- SDK 负责心跳和重连。连续失败打日志，管理端能看到 `ready / reconnecting / failed / disabled`。
- 同一 Client ID 只保留这一条连接。本地调试用另一个应用。

管理端 `POST /v1/admin/dingtalk-bots/:id/reconnect` 只对已启用的机器人生效。

## 6. 收消息

归一化结果只保留通道内部字段：`chatType`（`p2p` / `group`）、`conversationId`、`messageId`、`senderUserid`、`senderUnionId`、`senderName`、`msgtype`、`text`、`downloadCodes`、`fileName`、`quotedText`。`senderId`（加密字段）丢弃。

| 回调 | 内部 |
|------|------|
| `conversationType=1` | `p2p` |
| `conversationType=2` | `group` |
| `senderStaffId` | `senderUserid` |
| `text.content` | trim。去掉 @ 后的前导空格 |
| `richText` | 拼接文本，图片段收集 `downloadCode` |
| `picture` / `file` | `content.downloadCode` |
| `text.isReplyMsg` + `repliedMsg`，或旧字段 `quoteMessage` | 有正文则写入 `quotedText`，没有则空。不读它做会话切换 |

群消息若 `isInAtList=false`，只记日志，不跑 Agent。

`senderStaffId` 为空（未发布、外部群、外部成员）：回复「当前无法识别你的钉钉身份」，不发绑定卡，不用加密 `senderId` 凑绑定。

## 7. 绑定

钉钉 OAuth **不是** Mao 登录。绑定把「当前已登录的 Mao 用户」和「钉钉 userid」连起来。一个 userid 对应一个 Mao 用户，一个 Mao 用户对应一个钉钉身份。冲突时提示已绑定其他账号，不自动改绑。解绑只把 `deleted` 置 1，会话和工作区保留。

OAuth 使用单独配置的登录应用（`DINGTALK_OAUTH_CLIENT_ID` / `SECRET` / `REDIRECT_URI`），与机器人 Stream 凭证分开。该应用必须和机器人在同一企业，否则 `根据 unionid 查询用户` 得不到 userid。可以把某个机器人的 Client ID 同时配成这三项。

流程：

1. 设置页（已登录）`POST /v1/dingtalk/binding` 生成 state（写入 `user_id`）和授权链接。
2. 钉钉内未绑定：发链接卡片，按钮 URL 是 Mao 短链 `/api/v1/dingtalk/bind/{state}`，3 分钟有效。短链上没有登录态时先到现有登录页，登录成功后再 302 到钉钉授权页。
3. 回调用 authCode 换用户 token，调「获取用户通讯录个人信息」（`unionId=me`），再用应用 token 把 unionId 换成 userid。
4. 写入 `dingtalk_binding`。若 state 挂着待重放消息，绑定成功后按原消息跑一次。
5. `GET /v1/dingtalk/binding/status`、`DELETE /v1/dingtalk/binding`。

入站匹配先 `userid`，没有再 `senderUnionId`。两处都没有则未绑定。

未配置 OAuth 三项时，设置页绑定返回明确错误；钉钉内只回复「管理员尚未配置钉钉登录，暂时无法绑定」，不发空按钮。

## 8. 会话与工作区

执行模式 `CLOUD`，权限 `FULL`。Agent / 模型取该机器人配置，空则默认。`executionUserId` 用触发者的 Mao 用户，群会话的 `session.userId` 用群内第一个完成绑定的成员。

| | 私聊 | 群 |
|--|------|----|
| 键 | `(bot_id, conversationId)` 一行，`session_id` 是活跃指针 | 同一张表，一个群一行 |
| projectKey | `dingtalk-{botId}-private-{maoUserId}`，同一用户的多个私聊会话共用，便于网页侧边栏分组 | `dingtalk-chat-{botId}-{conversationId}` |
| 工作区 | `{workspaceRoot}/dingtalk-chat/{botId}/p2p-{maoUserId}/`，`---` 换会话不换目录 | `{workspaceRoot}/dingtalk-chat/{botId}/{conversationId}/` |
| 成员 | 不使用 | 已绑定且 @ 过的人写入 `dingtalk_chat_member`。未入表的已绑定用户第一次 @ 时入表 |

`---` 只在私聊生效，判定与飞书相同：trim 后是 3 个及以上 `-` 或 `—`。群里的 `---` 当普通文本。

私聊 `---`：

1. 当前活跃会话正在执行：置取消标志，按飞书 `persistFeishuCancelIfIdle` 的策略收尾（内存里有循环就只靠标志，不提前写 CANCELLED）。
2. 新建 session 行，把 `dingtalk_chat.session_id` 指到它。旧会话留在网页端，钉钉不再投递。
3. 回复「已开启新会话，后续消息将在新的上下文中处理。」这条确认不进入 Agent。
4. 新建失败则回复失败文案，指针不动。

普通消息打到指针上的会话。指针不存在时懒创建。同一私聊不会有两条钉钉执行并行。

群会话忙时入队，不因为下一次 @ 取消当前任务。取消只来自进度卡「取消任务」或排队卡「立即发送」。

侧边栏分组在 `session-group-key.ts` 增加 `DINGTALK_PRIVATE:` / `DINGTALK_GROUP:`，规则照飞书：私聊按 agent 聚合，群按工作区路径一条。`ofMode` 把含 `/dingtalk-chat/` 的云端工作区排除在「临时工作区」之外。

## 9. 入站内容

下载：`POST https://api.dingtalk.com/v1.0/robot/messageFiles/download`，body 为 `downloadCode` + 该机器人的 `robotCode`，再拉 `downloadUrl`。下载码过期或与 robotCode 不匹配时，在文本末尾追加 `[以下文件接收失败：…]`，任务仍可继续。

| 类型 | 行为 |
|------|------|
| 文本 | 直接进入任务 |
| 图片、富文本中的图片 | data URI 进多模态，并落在 `{workspace}/chat-files/{yyyy-MM-dd}/`。消息里附保存路径 |
| 私聊文件 | 只落盘并写一条带 `@{路径}@` 的用户消息，不跑 Agent。下一条文字再跑。只发文件、没有后续文字则保持静默 |
| 群里出现文件、语音、视频 | 平台通常不投递。若仍收到，回复「群聊暂不支持该类型，请私聊发送」，不跑 Agent |
| 私聊语音、视频 | 回复「暂不支持语音和视频」，不跑 Agent |
| 引用正文 | 放在用户文本前，标题用「引用的消息」。没有正文则省略。不切换会话 |

群 @ 触发时，在用户文本前附加：

```
【群内 @ 机器人的最近往来】（不是完整群聊）
[HH:mm] 张三：……
[HH:mm] 机器人：……（出站摘要，截断）
【引用的消息】
……
【用户消息】
……
```

窗口默认最近 10 条且 2 小时内，可用 `DINGTALK_BOT_GROUP_CONTEXT_MAX_ITEMS` / `MAX_MINUTES` 调整。出站成功后把回复摘要写入同一张日志，`direction=OUT`。这段文本不写入会话 message 表的历史，只附在本次触发消息上，避免污染标题和压缩。

未绑定的 @ 仍记一条入站日志，便于绑定重放前不丢上下文素材，但不创建群工作区。

## 10. 执行、排队、进度卡

`agent-inbound-handler` 的互斥、忙会话、入队、出队对齐飞书，差异只有三处：没有话题分支，没有引用切会话，`---` 会取消当前执行。

排队卡按钮：

- 「立即发送」：把该条插到队首并取消当前执行，然后出队。
- 「取消本次任务」：只取消这一条，不停止正在跑的任务。

进度卡在任务开始时 `createAndDeliver`，之后用「更新卡片」按 `outTrackId` 改 `cardParamMap`。不用 `PUT /v1.0/card/streaming`，避免 1KB / 3KB 的流式上限。正文不写进卡片。

投放场域：

- 私聊 `openSpaceId=dtv1.card//IM_ROBOT.{senderUserid}`，带 `imRobotOpenSpaceModel`。
- 群 `openSpaceId=dtv1.card//IM_GROUP.{conversationId}`，带 `imGroupOpenSpaceModel`。
- `callbackType=STREAM`。`userIdType` 使用企业 userid。

`dingtalk_progress_card` 记下 `session_id → outTrackId`。终态（完成、失败、取消）和进程重启后续跑，都更新这张卡。更新失败只打日志，不让任务失败。崩溃恢复沿用现有 Harness 恢复；恢复挂上监听后按该表找到卡片。内存里没有循环、库里仍是 RUNNING 时，进度卡取消走与飞书相同的「补写 CANCELLED 并排空队列」。

进度变量（值全部是字符串，布尔用 `"true"` / `"false"`）：

| 变量 | 含义 |
|------|------|
| `title` | 正在处理 / 处理完成 / 处理失败 / 任务已取消 |
| `body` | 轮次、耗时、最近工具摘要、失败时的 `error.message`。控制在 1500 字以内 |
| `status` | `running` / `completed` / `failed` / `cancelled`，给模板做按钮显隐 |
| `sessionUrl` | `{网页 origin}/tasks/{sessionId}`。origin 与飞书进度卡相同，取 ECP `desktopCallbackUrl`；取不到则空，模板隐藏按钮 |

按钮回传参数带 `sessionId` 与 `senderUserid`。点击者的 `userId` 必须等于 `senderUserid`，否则 toast「仅消息发送者可操作」，卡片不变。

- 取消、重试的语义与飞书进度卡相同：重试不插入新的用户消息，会话正在执行或已结束时 toast 不可用。
- 「会话详情」是打开链接，不走回调。

排队卡变量：`title`、`preview`（用户文本截断）、`status`（`queued` / `started` / `cancelled`）。回传参数带 `queueId` 和 `senderUserid`。

模板 ID 优先用机器人行上的 `progress_card_template_id` / `queue_card_template_id`，空则用环境变量。两处都空：任务照跑，进度退化为一条「正在处理」文本，终态仍发 markdown。不因此失败。

卡片平台需要发布两张模板，变量名与上表一致。按钮 actionId 固定为 `cancel`、`retry`、`run`。结构变更要重新发布模板；文案和摘要走变量，不用改模板。

## 11. 出站

凭证：

- 发消息、下载、投放卡片：`POST https://api.dingtalk.com/v1.0/oauth2/accessToken`，请求头 `x-acs-dingtalk-access-token`。提前刷新。
- 上传媒体：`GET https://oapi.dingtalk.com/gettoken`。另一套缓存，不混用。

| 场景 | 接口 | 寻址 |
|------|------|------|
| 私聊 | `POST /v1.0/robot/oToMessages/batchSend` | `userIds: [senderUserid]` |
| 群 | `POST /v1.0/robot/groupMessages/send` | `openConversationId=conversationId` |

文本回复用 `sampleMarkdown`（`title` 取首行截断，`text` 为正文）。默认最多 2000 字，超出截断并追加「…（回复过长已截断）」，配置项 `DINGTALK_BOT_REPLY_MAX_LENGTH`。若接口返回内容过长，再降到 500 字重试一次，仍失败则在进度卡 `body` 写入失败原因。

不使用 `sessionWebhook`。绑定引导、错误提示、`---` 确认也走主动发送。

图片和文件由工具发送，见第 12 节。上传 `https://oapi.dingtalk.com/media/upload` 拿到 `media_id`。图片 `sampleImageMsg` 的 `photoURL` 使用上传后钉钉可识别的地址；若该字段不接受 `media_id`，则图片消息改用文档中接受 `media_id` 的图片模板，实现时以当时的「企业机器人发送消息类型」为准，并补一条契约测试挡住发不出去的参数。文件 `sampleFile`，扩展名只允许 xlsx、pdf、zip、rar、doc、docx，最大 20MB。

## 12. 工具

`HarnessService.filterToolsForSession` 增加钉钉分支，判定与飞书对称：`projectKey` 匹配 `^dingtalk-\d+-private-\d+$`，或工作区路径含 `/dingtalk-chat/`。

该分支去掉：

- `ask_user_questions`
- 微信通道工具
- 飞书通道工具

其他会话去掉钉钉通道工具。子代理继续去掉 `ask_user_questions`，并去掉钉钉通道工具。

新增两个内置工具，标记为钉钉通道工具，只在钉钉会话出现：

| 工具 | 行为 |
|------|------|
| `dingtalk_send_image` | 读工作区图片并发送。成功返回文件名 |
| `dingtalk_send_file` | 读工作区文件并发送。扩展名或大小不合法时返回失败原因，不抛到任务失败 |

同步 `tool-result-summarizer.ts` 和 `desktop/src/utils/toolDisplay.ts` 的中文名、参数预览，以及成功、失败、缺参数的回归测试。不注册 `dingtalk_read_doc`。

`generate_image` / `edit_image` 的工具说明里补一句结果可交给 `dingtalk_send_image`。

## 13. 管理端与设置页

管理后台在「飞书机器人」旁增加「钉钉机器人」，页面照 `FeishuBotListView.vue`。接口要求管理员：

| 方法 | 路径 |
|------|------|
| GET | `/v1/admin/dingtalk-bots` |
| GET | `/v1/admin/dingtalk-bots/:id` |
| POST | `/v1/admin/dingtalk-bots` |
| PUT | `/v1/admin/dingtalk-bots/:id` |
| DELETE | `/v1/admin/dingtalk-bots/:id` |
| POST | `/v1/admin/dingtalk-bots/:id/enable` 与 `/disable` |
| GET | `/v1/admin/dingtalk-bots/status` |
| POST | `/v1/admin/dingtalk-bots/:id/reconnect` |

列表不返回 `clientSecret`，只返回 `clientSecretConfigured`。更新时 secret 空串表示不改。未配置 `APP_DINGTALK_BOT_SECRET` 时创建和修改 secret 返回「未配置 APP_DINGTALK_BOT_SECRET」。

设置页在「飞书Bot」旁增加「钉钉Bot」，桌面 / Web / 安卓共用，不改安卓原生。展示绑定状态、绑定、解绑。

实现时同步：

- 根 `CHANGELOG.md` 顶部版本说明（后端、管理后台、前端）。
- `skills/mao-cli/SKILL.md` 索引与 `skills/mao-cli/reference/dingtalk-bot.md`（能力、REST、排障）。
- 不改任务通知的 Webhook 校验。

## 14. 配置

| 变量 | 默认 | 作用 |
|------|------|------|
| `DINGTALK_BOT_ENABLED` | `false` | 总开关 |
| `DINGTALK_BOT_RECONCILE_INTERVAL_MS` | `5000` | 扫表间隔 |
| `APP_DINGTALK_BOT_SECRET` | 空 | 机器人 secret 的 AES-GCM 密钥，不复用飞书那一项 |
| `DINGTALK_OAUTH_CLIENT_ID` / `SECRET` / `REDIRECT_URI` | 空 | 绑定用登录应用 |
| `DINGTALK_PROGRESS_CARD_TEMPLATE_ID` | 空 | 进度卡模板，可被机器人行覆盖 |
| `DINGTALK_QUEUE_CARD_TEMPLATE_ID` | 空 | 排队卡模板 |
| `DINGTALK_BOT_REPLY_MAX_LENGTH` | `2000` | markdown 截断 |
| `DINGTALK_BOT_GROUP_CONTEXT_MAX_ITEMS` | `10` | @ 往来条数 |
| `DINGTALK_BOT_GROUP_CONTEXT_MAX_MINUTES` | `120` | @ 往来时间窗 |

开放平台侧每个机器人：企业内部应用、机器人选 Stream、发布（否则没有 `senderStaffId`）、权限包含企业内机器人发送消息、卡片实例写、上传媒体。登录应用配置与 `REDIRECT_URI` 一致的回调，并有「根据 unionid 获取用户」和通讯录个人信息读。卡片平台发布进度卡和排队卡。联调应用与线上应用分开。

## 15. 测试

`cd backend-ts && npm test`，至少覆盖：

- 归一化：单聊 / 群、@ 空格、富文本图片、引用有正文 / 无正文、丢弃加密 senderId。
- 去重：重复 `msgId` 不跑第二次；`FAILED` 可再认领。
- 未绑定发短链卡；无 staffId 不发绑定卡。
- 私聊 `---`：空闲时只换指针；执行中先取消再换指针；群里的 `---` 当文本。
- 引用不改变 `dingtalk_chat.session_id`。
- 独立文件不触发执行；下一条文字会触发。
- 群上下文标题含「不是完整群聊」，且不含未 @ 消息。
- 排队插队与取消本条；非发送者点按钮被拒绝。
- 进度卡终态更新；恢复时能按 `outTrackId` 找到卡。
- `filterToolsForSession`：钉钉会话没有 `ask_user_questions`、没有飞书工具；飞书会话没有钉钉工具。
- `dingtalk_send_image` / `dingtalk_send_file` 的成功、失败、缺参数，以及展示名。

不新增 Playwright。卡片模板和真实 Stream 用手动联调：发布后的机器人、绑定、私聊、群 @、取消、排队、`---`。

## 16. 实现顺序

1. 迁移、机器人仓储、加密、管理端 API 与页面。开关默认关闭。
2. token、Stream、归一化、去重。能在日志里看到消息。
3. OAuth 绑定、短链、待重放。
4. 会话指针、工作区、文本入站、主动回复。
5. 图片和文件、群 @ 日志与注入。
6. 排队卡、进度卡、取消与重试、网页端同步。
7. 出站图片 / 文件工具、展示名、CHANGELOG 与 mao-cli。

## 17. 风险

| 风险 | 处理 |
|------|------|
| 同一 Client ID 两条 Stream 抢消息 | 单实例；本地用另一个应用 |
| 未发布没有 userid | 日志区分「无 staffId」和「未绑定」；发布后再测绑定 |
| markdown 长度文档不一致 | 先按 2000 截断，接口报过长再降到 500 |
| 卡片回调超过 2 秒会弹回 | 回调只改状态并返回变量 |
| 模板未发布 | 退化为纯文本进度，任务继续 |
| 内容安全拒发 | 失败写进进度卡 |
| 图片 `photoURL` 与 `media_id` 的实际字段 | 实现时对文档，用契约测试固定能发出去的参数 |
