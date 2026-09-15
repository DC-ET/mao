# 飞书话题群多会话（话题=会话）技术方案

## 一、需求背景

### 1.1 现状与痛点

飞书私聊已支持多会话并行（`docs/plan/feishu-p2p-multi-session-design.md`）：`---` 新建会话、引用消息切换会话。但私聊消息全部平铺在同一个聊天窗口中，用户查找历史会话的回复只能逐条翻聊天记录，体验不佳。

群聊方面，当前架构是**一个群 = 一个会话**（`feishu_chat` 表以 `(app_id, chat_id)` 唯一键绑定），所有 @机器人 的消息进入同一个 session，无法并行处理多个独立任务。

### 1.2 目标

利用飞书话题群（topic mode group）的天然结构，实现「**一个群 = 一个工作区，一个话题 = 一个会话**」：

- 用户在群内发起新话题 → 自动创建新 Mao 会话；
- 用户在话题内发送消息 → 自动路由到对应会话执行任务；
- 多个话题（会话）独立并行执行，互不干扰；
- 会话列表在 Mao 桌面端/Web 端自然呈现，无需额外 UI。

### 1.3 飞书话题群关键事实

来源：[飞书开放平台文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/thread-introduction)

| 概念 | 说明 |
|---|---|
| `chat_mode = topic` | 话题群：所有消息自动生成话题，回复只能在话题内进行 |
| `chat_mode = group` + `group_message_type = thread` | 话题格式群：普通群切换消息格式为话题，可切回对话模式 |
| `thread_id`（`omt_` 前缀） | 话题唯一 ID；消息事件中带此字段表示该消息属于某话题 |
| 话题内回复的 `parent_id` | **始终指向话题根消息的 `message_id`**（官方明确说明），非用户主动引用 |
| `im.chat.updated_v1` | 群配置变更事件，含 `group_message_type` 字段，可在群模式切换时感知 |

**关键区分**：

- 话题内普通回复：`parent_id === root_id`（均指向话题根消息）
- 话题内显式引用某条回复：`parent_id ≠ root_id`（`parent_id` 指向被引用消息，`root_id` 仍指向话题根）

## 二、需求描述

### 2.1 做（本期范围）

1. **话题 = 会话自动映射**：话题群内，`thread_id` 与 Mao session 一一映射。用户在新话题发消息 → 创建新会话；在已有话题发消息 → 路由到已有会话。
2. **`parent_id` 误判修复**：话题内消息的 `parent_id` 指向话题根，不应被当作「用户引用了某条消息」注入 `【引用的消息】`。仅当 `parent_id ≠ root_id`（显式引用话题内某条回复）时才注入。
3. **话题内消息无需 @机器人**：话题本身已隔离了上下文，用户在话题内发消息即视为触发，无需 @。
4. **群消息日志记录 `thread_id`**：`feishu_group_message_log` 表新增 `thread_id` 列，供话题内上下文按 `thread_id` 过滤。
5. **话题会话标题**：新建话题会话以首条消息前 20 字命名（复用 p2p 的 `awaitingFirstMessageTitle` 机制）。
6. **群模式变更感知**：订阅 `im.chat.updated_v1` 事件，在 `group_message_type` 切换时更新本地缓存。

### 2.2 明确不做的

| 不做项 | 说明 |
|---|---|
| 非话题群的改动 | `chat_mode = group` 且 `group_message_type = chat`（纯对话群）走现有逻辑，零改动 |
| 话题工作区隔离 | 所有话题共享群工作区（同一目录），与私聊多会话共享工作区策略一致 |
| 话题删除/归档联动 | 话题在飞书侧删除后，对应 Mao 会话保留，不自动清理 |
| 话题内进度卡片的 thread 定位 | 进度卡片/排队卡片发送到群 chat_id（reply 触发消息自动落入话题），不做额外 thread 定位 |
| 桌面/Web 端 UI 改动 | 多会话在现有会话列表自然呈现 |
| 安卓原生改动 | 无 |

## 三、技术方案

### 3.1 数据模型

#### 3.1.1 新表 `feishu_thread_session`

映射 `thread_id → session_id`，承载话题与会话的绑定关系。

```sql
-- V114__feishu_thread_session.sql
CREATE TABLE IF NOT EXISTS `feishu_thread_session` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `app_id` VARCHAR(64) NOT NULL COMMENT '飞书 bot id',
  `chat_id` VARCHAR(128) NOT NULL COMMENT '群 ID (oc_xxx)',
  `thread_id` VARCHAR(64) NOT NULL COMMENT '话题 ID (omt_xxx)',
  `root_message_id` VARCHAR(64) NOT NULL COMMENT '话题根消息 message_id（reply API 的目标）',
  `session_id` BIGINT NOT NULL COMMENT '归属的 mao 会话 id',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_feishu_thread_session` (`app_id`, `thread_id`),
  KEY `idx_feishu_thread_session_chat` (`app_id`, `chat_id`),
  KEY `idx_feishu_thread_session_session` (`app_id`, `session_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '飞书话题→会话映射';
```

#### 3.1.2 `feishu_group_message_log` 新增 `thread_id` 列

```sql
ALTER TABLE `feishu_group_message_log` ADD COLUMN `thread_id` VARCHAR(64) NULL COMMENT '话题 ID (omt_xxx)';
ALTER TABLE `feishu_group_message_log` ADD KEY `idx_group_msg_thread` (`app_id`, `chat_id`, `thread_id`);
```

### 3.2 模块改动

| 模块 | 改动 |
|---|---|
| `event-normalizer.ts` | 提取 `thread_id` → `FeishuNormalizedMessage.threadId` |
| `types.ts` | `FeishuNormalizedMessage` 新增 `threadId?: string \| null`；`FeishuInboundContext` 继承自动获得 |
| `message.repository.ts` | 新增 `recordThreadSession`、`findThreadSession`；`appendGroupMessage` 写入 `threadId`；`listGroupMessages` 支持 `threadId` 过滤 |
| `message.service.ts` | 新增 `getOrCreateThreadSession`、`findThreadSession`；`buildGroupContext` 按 `threadId` 过滤 |
| `agent-inbound-handler.ts` | `onGroupMessage` 增加话题分支：`threadId` 存在时走话题路径（查映射→建会话→记录映射→执行） |
| `inbound-processor.ts` | 群聊路径：`threadId` 存在且命中话题会话映射时，跳过 `isBotMentioned` 门禁（话题内消息视为触发）；`resolveQuoted` 增加 `parent_id === root_id` 时不注入的守卫 |
| `create-app.ts` | 装配话题会话控制适配器；`sendFeishuText` 群聊路径保持 reply（自动落入话题）；`recordGroupMessage` 传入 `threadId` |
| `monitor.service.ts` | 注册 `im.chat.updated_v1` 事件处理器（可选，本期实现基础版） |

### 3.3 入站流程

```
群聊消息到达（chatType === 'group'）
  │
  ├─ threadId 为空 → 走现有 onGroupMessage 逻辑（零改动）
  │
  └─ threadId 非空 → 话题路径：
       │
       ├─ 1. 落群消息日志（含 threadId）
       │
       ├─ 2. 查 feishu_thread_session 映射
       │     ├─ 命中 → 取已有 session
       │     └─ 未命中 → 检查是否为话题根消息（parentId 为空）
       │           ├─ 是（用户发起新话题）→ 创建新 session + 记录映射
       │           └─ 否（话题内回复但映射缺失，如上线前消息）→ 降级：按现有群逻辑处理
       │
       ├─ 3. @门禁判定：
       │     └─ threadId 存在 → 跳过 isBotMentioned 检查（话题内消息视为触发）
       │        （未绑定用户仍走未绑定引导逻辑）
       │
       ├─ 4. 构建上下文（groupContext 按 threadId 过滤本话题内消息）
       │
       ├─ 5. 引用注入守卫：
       │     ├─ parentId == rootId 或 parentId == thread 根消息 id → 不注入（话题自动带的 parent_id）
       │     └─ parentId ≠ rootId → 用户显式引用了话题内某条回复 → 注入
       │
       └─ 6. 执行（复用现有 busy/队列/进度卡片逻辑，按 sessionId 粒度互斥）
```

### 3.4 `parent_id` 误判修复

这是最关键的修复点。当前 `resolveQuoted` 只检查 `parentId != null`：

```ts
// inbound-processor.ts 现状（简化）
private async resolveQuoted(accountId: string, event: FeishuNormalizedMessage): Promise<string | undefined> {
  if (event.parentId == null || event.parentId === '') return undefined;
  // ... 直接解析 parentId 对应的消息内容
}
```

**修复**：在话题场景下，增加守卫——`parentId === rootId` 时不注入。

```ts
// 修复后
private async resolveQuoted(accountId: string, event: FeishuNormalizedMessage): Promise<string | undefined> {
  if (event.parentId == null || event.parentId === '') return undefined;
  // 话题内回复：parent_id 指向话题根，非用户主动引用，跳过注入。
  // 仅当 parent_id ≠ root_id 时才是显式引用了话题内某条回复。
  if (event.threadId != null && event.parentId === event.rootId) return undefined;
  // ... 原有解析逻辑
}
```

注意：对于**非话题群**（纯对话群）中的普通引用回复，`rootId` 通常等于 `parentId`（引用的那条消息就是回复树的根）。因此守卫条件必须包含 `event.threadId != null`，避免误伤非话题场景。

### 3.5 上下文注入策略

话题会话的上下文构建与现有群聊不同：

| 维度 | 现有群聊 | 话题会话 |
|---|---|---|
| 上下文来源 | `feishu_group_message_log` 中该群的最近消息 | 同表但按 `thread_id` 过滤，仅取本话题内消息 |
| 增量水位线 | `feishu_chat.last_context_log_id`（群级） | 复用 `feishu_chat.last_context_log_id`（群级）——话题内消息仍走群日志，水位线按群推进 |
| 溢出摘要 | 按群过滤 | 按 `thread_id` 过滤 |
| 消息格式 | `[HH:mm] 发送人：内容` | 同格式，但只含本话题消息 |

**实现**：`listGroupMessages` 增加可选 `threadId` 参数。话题路径传 `threadId`，非话题路径不传（行为不变）。`buildGroupContext` 根据 context 中的 `threadId` 决定是否传入过滤参数。

### 3.6 出站回复策略

| 场景 | 发送方式 | 说明 |
|---|---|---|
| 话题内回复 | `message.reply({ message_id: rootMessageId })` | 回复话题根消息，自动落入话题。**无需 `reply_in_thread` 参数**——在话题群中，回复话题根消息即自动在话题内 |
| 非话题群回复 | `message.reply({ message_id: triggerMessageId })` | 现有逻辑不变 |
| 进度卡片/排队卡片 | `message.create({ receive_id: chatId })` 或 reply | 现有逻辑不变，卡片落在群中；话题群中用户看到卡片在话题外，可接受 |

**关键**：话题群中回复话题根消息时，飞书自动将回复归入该话题，不需要额外的 `thread_id` 参数。`sendFeishuText` 现有的群聊 reply 分支（`message.reply({ path: { message_id: event.messageId } })`）在话题场景下需要改为 reply **根消息**而非触发消息——因为话题内所有回复都挂在根消息下。

具体：话题路径的 `sendFeishuText` 应使用 `rootMessageId`（来自 `feishu_thread_session` 映射）而非 `event.messageId`。

### 3.7 群模式变更感知

注册 `im.chat.updated_v1` 事件（`monitor.service.ts`）：

```ts
'im.chat.updated_v1': async (data: unknown) => {
  const event = normalizeFeishuChatUpdatedEvent(data);
  if (event == null) return;
  // 更新本地缓存（群聊模式 / 消息格式）
  chatModeCache.set(event.chatId, {
    chatMode: event.afterChange.chatMode,
    groupMessageType: event.afterChange.groupMessageType,
  });
  // 若从 thread 切回 chat：话题映射保留（会话仍在），后续非话题消息走现有逻辑
  // 若从 chat 切到 thread：后续消息若带 threadId 走话题路径
}
```

本期实现基础版：仅更新缓存 + 日志。缓存用于 `isBotMentioned` 门禁的辅助判断（话题格式群中可放宽门禁），但核心路由逻辑以事件中 `thread_id` 是否存在为准，不依赖缓存。

## 四、详细设计

### 4.1 类型扩展

```ts
// types.ts
export interface FeishuNormalizedMessage {
  // ... 现有字段
  /** 话题 ID (omt_xxx)；非话题消息为 null/undefined。 */
  threadId?: string | null;
}
```

### 4.2 事件归一化

```ts
// event-normalizer.ts
parentId: firstString(message.parent_id, event.parent_id) ?? null,
rootId: firstString(message.root_id, event.root_id) ?? null,
threadId: firstString(message.thread_id, event.thread_id) ?? null,  // 新增
```

### 4.3 仓储层

```ts
// message.repository.ts 接口新增
export interface FeishuMessageRepository {
  // ... 现有方法

  /** 记录话题→会话映射（INSERT IGNORE 防重）。 */
  recordThreadSession(params: {
    appId: string; chatId: string; threadId: string;
    rootMessageId: string; sessionId: number;
  }): Promise<void>;

  /** 按话题 ID 查归属会话。 */
  findThreadSession(appId: string, threadId: string): Promise<{
    sessionId: number; rootMessageId: string; chatId: string;
  } | null>;

  /** 群消息日志按话题过滤（threadId 为 null 时不传此条件）。 */
  listGroupMessages(appId: string, chatId: string, limit: number, maxMinutes?: number, threadId?: string | null): Promise<FeishuGroupMessage[]>;
}
```

`appendGroupMessage` 的 `FeishuGroupMessage` 接口新增 `threadId?: string | null` 字段，INSERT 时写入。

### 4.4 服务层

```ts
// message.service.ts

/** 获取或创建话题→会话映射。映射存在返回已有；不存在创建新会话并记录映射。 */
async getOrCreateThreadSession(
  accountId: string, context: FeishuInboundContext,
): Promise<{ sessionId: number; rootMessageId: string; workspace: string | null } | null> {
  if (context.threadId == null || context.chatId == null) return null;
  const existing = await this.repository.findThreadSession(accountId, context.threadId);
  if (existing != null) return { sessionId: existing.sessionId, rootMessageId: existing.rootMessageId, workspace: null };
  // 仅话题根消息触发创建（parentId 为空即根消息，飞书根消息无回复目标）
  // 话题内回复但映射缺失（上线前消息）：降级不创建，返回 null 让调用方走现有逻辑
  const isRoot = context.parentId == null || context.parentId === '';
  if (!isRoot) return null;
  const session = await this.sessionFactory.create(accountId, context);
  await this.repository.recordThreadSession({
    appId: accountId, chatId: context.chatId, threadId: context.threadId,
    rootMessageId: context.messageId!, sessionId: session.sessionId,
  });
  return { sessionId: session.sessionId, rootMessageId: context.messageId!, workspace: session.workspace };
}
```

### 4.5 入站处理器

```ts
// agent-inbound-handler.ts

/** 群聊入站：话题分支 + 现有逻辑。 */
private async onGroupMessage(context: FeishuInboundContext): Promise<FeishuReply | null> {
  // 话题路径：threadId 存在且话题会话映射可解析
  if (context.threadId != null && this.options.threadSessionControl != null) {
    const threadSession = await this.options.threadSessionControl.getOrCreateSession(context.accountId, context);
    if (threadSession != null) {
      return this.executeWithSession(threadSession.sessionId, context);
    }
    // 映射未命中且非话题根消息：降级走现有群逻辑
  }
  // 现有逻辑不变
  return this.executeWithSession(
    (await this.options.sessionService.getOrCreateSession(context.accountId, context)).id,
    context,
  );
}
```

`executeWithSession` 为现有 `onGroupMessage` 中「取会话 → buildMessage → busy检查/入队/执行」逻辑的提取，避免重复。

### 4.6 上下文过滤

```ts
// message.service.ts - buildGroupContext
async buildGroupContext(accountId: string, context: FeishuInboundContext): Promise<FeishuGroupContext> {
  const conversation = await this.getOrCreateGroup(accountId, context);
  const messages = await this.repository.listGroupMessages(
    accountId, context.chatId!, this.contextWindow, this.maxMinutes,
    context.threadId ?? null,  // 话题路径传 threadId 过滤
  );
  // ... 后续逻辑不变
}
```

## 五、实现步骤

1. **迁移脚本**：`V114__feishu_thread_session.sql`（新表 + `feishu_group_message_log.thread_id` 列）。
2. **类型与归一化**：`types.ts` 新增 `threadId`；`event-normalizer.ts` 提取 `thread_id`。
3. **仓储层**：`message.repository.ts` 新增 `recordThreadSession` / `findThreadSession`；`appendGroupMessage` 写入 `threadId`；`listGroupMessages` 支持过滤。
4. **服务层**：`message.service.ts` 新增 `getOrCreateThreadSession`；`buildGroupContext` 支持 `threadId` 过滤。
5. **入站处理器**：`agent-inbound-handler.ts` 增加话题分支；提取 `executeWithSession` 公共方法；新增 `FeishuThreadSessionControl` 端口。
6. **引用守卫**：`inbound-processor.ts` 的 `resolveQuoted` 增加 `threadId && parentId === rootId` 守卫。
7. **群消息触发放宽**：`inbound-processor.ts` 群聊路径：`threadId` 存在且话题映射命中时跳过 `isBotMentioned` 检查。
8. **出站回复**：`create-app.ts` 的 `sendFeishuText` 群聊路径：话题场景使用 `rootMessageId` 回复。
9. **装配层**：`create-app.ts` 实现 `FeishuThreadSessionControl` 适配器。
10. **群模式感知（可选）**：`monitor.service.ts` 注册 `im.chat.updated_v1`。
11. **测试**：单测 + 回归（见第六节）。
12. **文档**：CHANGELOG；`skills/mao-cli/SKILL.md` 补充话题群用法。

## 六、测试计划

### 新增单测

- `event-normalizer.spec.ts`：
  - 话题消息提取 `threadId`；
  - 非话题消息 `threadId` 为 null。

- `agent-inbound-handler.spec.ts`：
  - 话题根消息触发：创建新 session、记录映射、正常执行；
  - 话题内回复：命中映射、路由到已有 session；
  - 话题内回复但映射缺失（非根消息）：降级走现有群逻辑；
  - 非话题群消息：`threadId` 为空，走现有逻辑（零行为变化）。

- `inbound-processor.spec.ts`：
  - `resolveQuoted` 守卫：`threadId + parentId === rootId` → 不注入引用；
  - `resolveQuoted` 守卫：`threadId + parentId ≠ rootId` → 正常注入引用；
  - `resolveQuoted` 守卫：无 `threadId`（非话题）→ 现有行为不变；
  - 话题消息无 @ 但映射命中 → 跳过 mention 门禁，正常触发；
  - 话题消息无 @ 且映射未命中（非根消息）→ 不触发。

- `message.service.spec.ts`：
  - `getOrCreateThreadSession`：映射存在返回已有；不存在且为根消息创建新会话；不存在且非根消息返回 null；
  - `buildGroupContext` 按 `threadId` 过滤。

### 回归

- `cd backend-ts && npm test`（feishu 全部 spec 全绿）；
- 非话题群行为零变化（现有用例不改动断言）。

## 七、落地清单

| # | 交付物 | 文件 |
|---|---|---|
| 1 | 迁移脚本 | `backend-ts/db/migration/V114__feishu_thread_session.sql` |
| 2 | 类型定义 | `backend-ts/src/feishu/types.ts` |
| 3 | 事件归一化 | `backend-ts/src/feishu/event-normalizer.ts` |
| 4 | 映射表仓储 | `backend-ts/src/feishu/message.repository.ts` |
| 5 | 话题会话服务 | `backend-ts/src/feishu/message.service.ts` |
| 6 | 入站话题分支 | `backend-ts/src/feishu/agent-inbound-handler.ts` |
| 7 | 引用守卫 + mention 放宽 | `backend-ts/src/feishu/inbound-processor.ts` |
| 8 | 装配层 | `backend-ts/src/create-app.ts` |
| 9 | 单测 | `agent-inbound-handler.spec.ts`、`inbound-processor.spec.ts`、`event-normalizer.spec.ts`、`message.service.spec.ts` |
| 10 | CHANGELOG | 根 `CHANGELOG.md` |
| 11 | 用户文档 | `skills/mao-cli/SKILL.md` |

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| 话题根消息 `parentId` 为空（飞书根消息无回复目标） | 创建映射条件：`parentId == null \|\| parentId === ''`；以 `threadId` 存在为主要判据 |
| 上线前话题的回复消息（无映射）走现有群逻辑，可能进入群级单会话 | 降级行为可接受：该消息进入群会话而非话题会话，用户下次在话题发消息时话题会话被创建 |
| `feishu_group_message_log` 存量行 `thread_id` 为 null | 话题路径 `listGroupMessages` 过滤 `thread_id = ?` 时存量行自然不命中；新消息从上线起记录 `thread_id` |
| 进度卡片/排队卡片发送到群（非话题内） | 本期接受：卡片在群中可见，不影响功能；后续可通过 reply 话题根消息让卡片落入话题 |
| 话题会话数无上限导致 session 膨胀 | 与私聊多会话同策略：不做上限，依赖用户自行管理 |
| 群模式从 thread 切回 chat 后，已有话题会话的后续消息不再带 `threadId` | 已有话题会话保留（通过 Mao 桌面端继续对话）；飞书侧话题内的后续回复仍会带 `threadId`（飞书侧话题结构不因群模式切换而解散） |

## 九、与私聊多会话的关系

| 维度 | 私聊多会话 | 话题群多会话 |
|---|---|---|
| 新建触发 | `---` 指令 | 发起新话题（自动） |
| 切换机制 | 引用消息 → 映射表定位 | 在话题内发消息 → `thread_id` 定位 |
| 活跃指针 | `feishu_chat.session_id` | 不需要（`thread_id` 即指针） |
| 消息映射表 | `feishu_p2p_message` | `feishu_thread_session` |
| 工作区 | 共享（`private-{userId}`） | 共享（`{chatId}`） |
| 上下文注入 | 全量注入 | 按 `thread_id` 过滤 |

两套机制独立运行，互不影响。私聊路径 `chatType === 'p2p'` 走 p2p 分支；话题群路径 `chatType === 'group' && threadId != null` 走话题分支；其余群聊走现有逻辑。
