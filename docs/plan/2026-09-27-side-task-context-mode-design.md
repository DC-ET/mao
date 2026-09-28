# 边路任务上下文继承模式技术方案

- 日期：2026-09-27
- 状态：已与需求方达成共识，待实施
- 涉及端：backend-ts（后端）、desktop（桌面 / Web / 安卓共用 UI）
- 不涉及：admin（管理后台）、android 原生壳、agent-cli、Electron 主进程

---

## 1. 需求背景

当前新建边路任务时，用户通过一个 checkbox（"继承主任务上下文"）选择是否注入主任务的上下文摘要。该设计只有"注入摘要"和"不注入"两种状态，无法满足"完整继承主会话上下文并看到历史消息"的场景。

用户希望在新建边路任务时提供三选一的单选控件，将上下文继承策略扩展为三种模式：

| 模式 | 说明 |
| --- | --- |
| **Fork 主会话** | 物理复制主会话的全部消息、file_change、compaction 记录到边路会话，边路 Agent 获得完整上下文，用户在对话页面能看到历史消息 |
| **主会话摘要** | 保持现有注入逻辑：取主会话最近 10 条消息、每条截断 300 字，拼成摘要注入 system prompt |
| **不继承** | 全新对话，不注入任何上下文 |

---

## 2. 需求描述

### 2.1 要做的

1. **前端（desktop）**：
   - 将 `SideChatPanel.vue` 中现有的 `el-checkbox`（继承主任务上下文）替换为 `el-radio-group`，三个选项：Fork 主会话 / 主会话摘要 / 不继承。
   - 默认选中"不继承"。
   - 该选择器仅在边路任务首条消息发送前显示（`v-if="!hasRealSession && displayMessages.length === 0"`），发送后隐藏，与现有逻辑一致。
   - `useStreamWS.ts` 的 `createSideSession()` 函数参数从 `inheritContext: boolean` 改为 `contextMode: 'fork' | 'summary' | 'none'`，WS 消息 `data.inheritContext` 字段替换为 `data.contextMode`。
   - Fork 模式下，前端在收到 `side_session_created` 事件后需重新拉取边路会话的消息列表（`getMessagesByRounds`），以展示被复制过来的历史消息。

2. **后端（backend-ts）**：
   - `StreamingWsHandler.handleCreateSideSession()`：解析 `data.contextMode`（`'fork' | 'summary' | 'none'`），替换现有的 `data.inheritContext === true` 逻辑。
   - `HarnessService.executeSideFirstMessage()`：参数从 `inheritContext: boolean` 改为 `contextMode: string`，根据模式执行不同逻辑：
     - `fork`：调用新方法 `forkParentMessages()`，物理复制主会话全部消息、file_change、compaction 记录到边路会话，然后正常构建上下文执行（不额外注入摘要，因为消息已经在会话内）。
     - `summary`：保持现有 `generateContextSummary()` 逻辑不变。
     - `none`：跳过任何上下文注入。
   - 新增 `forkParentMessages(parentSessionId, sideSessionId)` 方法，在事务内复制：
     - 主会话全部 `messages`（维护 `messageIdMap` 映射旧 ID → 新 ID）
     - 主会话全部 `file_change`（通过 `messageIdMap` 重映射 `messageId`）
     - 主会话 `session_compaction` 记录（将 `sessionId` 替换为边路会话 ID）
   - Fork 完成后，再保存用户输入的边路任务指令消息，然后触发 Agent 执行。

### 2.2 明确不做的

| 不做项 | 说明 |
| --- | --- |
| 数据库 schema 变更 | 不在 sessions 表新增 context_mode 列，不新增 Flyway 迁移 |
| 旧字段 inheritContext 兼容 | 不保留旧字段，不做后端兼容映射，前后端同步替换 |
| Fork 消息来源标记 | 复制过来的消息与新消息无差别展示，不加"来自主会话"等视觉标记 |
| Fork 消息数量限制 | 不限制复制条数，有多少复制多少 |
| 摘要逻辑改动 | "主会话摘要"模式保持现有逻辑（最近 10 条、每条 300 字截断），不改用 LLM 生成 |
| promote 功能改动 | 不改动现有的 promoteSideTaskToMainSession 逻辑 |
| 边路任务删除/归档等周边 | 不做其他边路任务管理功能的调整 |
| admin 管理后台改动 | 不在管理后台展示或筛选 contextMode |

---

## 3. 技术选型

| 决策点 | 选型 | 理由 |
| --- | --- | --- |
| Fork 实现方式 | 物理复制消息 | 与现有 `promoteSideTaskToMainSession` 的消息复制逻辑一致，边路会话自包含，后续操作互不影响 |
| Fork 复制范围 | 全部消息 + file_change + compaction | 完整继承主会话上下文，Agent 和用户都能看到一致的历史 |
| 前端控件 | el-radio-group | 三选一场景最直观，比下拉省一次点击 |
| 默认选项 | 不继承 | 与现有 `inheritContext = ref(false)` 行为一致 |
| WS 字段 | `contextMode: 'fork' \| 'summary' \| 'none'` 直接替换 `inheritContext` | 同一套代码库前后端同步改，无需兼容旧客户端 |
| Fork 执行时机 | 用户发送边路任务指令时，后端先复制再执行 | 一气呵成，用户体验最好 |
| Fork 逻辑位置 | 后端 `HarnessService` | 与现有 `executeSideFirstMessage` 流程一致，前端只需传 mode |

---

## 4. 实现步骤

### 4.1 后端（backend-ts）

#### 步骤 1：修改 `HarnessService.executeSideFirstMessage`

**文件**：`backend-ts/src/harness/core/harness-service.ts:539-556`

将方法签名从：

```typescript
async executeSideFirstMessage(
  parentSessionId: number,
  sideSessionId: number,
  inheritContext: boolean,
  listener: AgentEventListener,
  cancelFlag?: AtomicBoolean | null,
): Promise<void>
```

改为：

```typescript
async executeSideFirstMessage(
  parentSessionId: number,
  sideSessionId: number,
  contextMode: 'fork' | 'summary' | 'none',
  listener: AgentEventListener,
  cancelFlag?: AtomicBoolean | null,
): Promise<void>
```

方法体逻辑：

```typescript
const context = await this.buildContext(sideSessionId, listener, cancelFlag);

if (contextMode === 'fork') {
  await this.forkParentMessages(parentSessionId, sideSessionId);
  // fork 后消息已在会话内，buildContext 已包含完整历史，无需额外注入
  // 但需要重建 context（因为 fork 后消息变了）
  context = await this.buildContext(sideSessionId, listener, cancelFlag);
} else if (contextMode === 'summary') {
  const contextSummary = await this.generateContextSummary(parentSessionId);
  if (hasText(contextSummary)) {
    context.systemPrompt = (context.systemPrompt ?? '')
      + '\n\n<主任务背景摘要>\n' + contextSummary + '\n</主任务背景摘要>\n'
      + '以上是主任务的最近对话摘要，本次边路任务的结果不需要反馈到主任务。';
    context.preparedRequest = null;
  }
}
// contextMode === 'none': 跳过任何注入

const persistenceCallback = this.createPersistenceCallback(sideSessionId, context);
await this.agentLoop.execute(context, listener, persistenceCallback);
if (cancelFlag != null) this.agentLoop.removeCancelFlag(sideSessionId);
```

#### 步骤 2：新增 `forkParentMessages` 方法

**文件**：`backend-ts/src/harness/core/harness-service.ts`

```typescript
/**
 * 物理复制主会话的全部消息、file_change、compaction 记录到边路会话。
 * 复制逻辑参考 promoteSideTaskToMainSession 中的消息复制。
 */
private async forkParentMessages(
  parentSessionId: number,
  sideSessionId: number,
): Promise<void> {
  // 1. 复制消息（维护 messageIdMap）
  const messages = await this.sessionService.getMessages(parentSessionId);
  const messageIdMap = new Map<number, number>();
  for (const m of messages) {
    const copy: Message = {
      sessionId: sideSessionId,
      role: m.role,
      content: m.content,
      thinkingContent: m.thinkingContent,
      toolCallId: m.toolCallId,
      toolCalls: m.toolCalls,
      tokenCount: m.tokenCount,
      modelId: m.modelId,
      metadata: m.metadata,
      sourceSessionId: parentSessionId,
    };
    const newId = await this.sessionService.saveMessage(
      sideSessionId, copy.role, copy.content, null,
      copy.toolCallId, copy.toolCalls, copy.tokenCount ?? 0, copy.modelId,
    );
    if (m.id != null && newId != null) messageIdMap.set(m.id, newId);
  }

  // 2. 复制 file_change（通过 messageIdMap 重映射 messageId）
  // 3. 复制 compaction 记录（将 sessionId 替换为 sideSessionId）
}
```

> 具体实现需参考 `session.service.ts:530` 中 `promoteSideTaskToMainSession` 的事务内复制模式，通过 `sessionRepo.transaction()` 在单事务内完成全部复制操作。

#### 步骤 3：修改 `StreamingWsHandler.handleCreateSideSession`

**文件**：`backend-ts/src/session/ws/streaming-ws-handler.ts:773`

将：

```typescript
const inheritContext = data.inheritContext === true;
```

改为：

```typescript
const contextMode = data.contextMode === 'fork' || data.contextMode === 'summary'
  ? data.contextMode
  : 'none';
```

并将 `handleCreateSideSession` 中传递给 `executeSideFirstMessage` 的参数从 `inheritContext` 改为 `contextMode`：

**文件**：`backend-ts/src/session/ws/streaming-ws-handler.ts:859`

```typescript
await this.deps.harnessService.executeSideFirstMessage(
  parentSessionId, sideSessionId, contextMode, listener, flag
);
```

#### 步骤 4：修改 `StreamingWsHandler` 的接口定义

**文件**：`backend-ts/src/session/ws/streaming-ws-handler.ts:53`

```typescript
executeSideFirstMessage(
  parentId: number, sideId: number,
  contextMode: 'fork' | 'summary' | 'none',
  listener: AgentEventListener,
  cancelFlag: { get(): boolean; set(v: boolean): void }
): Promise<void>;
```

#### 步骤 5：更新测试

**文件**：`backend-ts/src/harness/core/harness-service.spec.ts:384-390`

- 将现有 `executeSideFirstMessageAppendsParentSummary` 测试中的 `true` 参数改为 `'summary'`，断言不变。
- 新增测试 `executeSideFirstMessageForkCopiesMessages`：传入 `'fork'`，断言 `getMessages` 被调用于 parent，消息被复制到 side session。
- 新增测试 `executeSideFirstMessageNoneDoesNotInject`：传入 `'none'`，断言 systemPrompt 不含"主任务背景摘要"。

**文件**：`backend-ts/src/session/ws/streaming-ws-handler.spec.ts:243,414,441`

- 将 `inheritContext: true` 改为 `contextMode: 'summary'`（或对应的 `'fork'` / `'none'`）。

### 4.2 前端（desktop）

#### 步骤 1：修改 `SideChatPanel.vue` 模板

**文件**：`desktop/src/components/chat/SideChatPanel.vue:77-81`

将：

```html
<div v-if="!hasRealSession && displayMessages.length === 0" class="inherit-bar">
  <el-checkbox v-model="inheritContext" size="small">
    继承主任务上下文
  </el-checkbox>
</div>
```

替换为：

```html
<div v-if="!hasRealSession && displayMessages.length === 0" class="inherit-bar">
  <el-radio-group v-model="contextMode" size="small">
    <el-radio value="none">不继承</el-radio>
    <el-radio value="summary">主会话摘要</el-radio>
    <el-radio value="fork">Fork 主会话</el-radio>
  </el-radio-group>
</div>
```

#### 步骤 2：修改 `SideChatPanel.vue` 脚本

**文件**：`desktop/src/components/chat/SideChatPanel.vue:176`

将：

```typescript
const inheritContext = ref(false)
```

改为：

```typescript
const contextMode = ref<'none' | 'summary' | 'fork'>('none')
```

**文件**：`desktop/src/components/chat/SideChatPanel.vue:655`

将 `inheritContext.value` 改为 `contextMode.value`：

```typescript
const created = await createSideSession(
  parentSessionId,
  resolvedText,
  contextMode.value,  // 替换原来的 inheritContext.value
  currentModelId.value,
  localSkills,
  agentsMdContent,
  imageUrls,
  sidePermissionLevel.value
)
```

#### 步骤 3：修改 `useStreamWS.ts`

**文件**：`desktop/src/composables/useStreamWS.ts:494-510`

将 `createSideSession` 的参数从 `inheritContext: boolean` 改为 `contextMode: 'fork' | 'summary' | 'none'`，WS payload 中 `inheritContext` 替换为 `contextMode`：

```typescript
async function createSideSession(
  parentSessionId: string,
  content: string,
  contextMode: 'fork' | 'summary' | 'none',
  modelId?: number,
  localSkills?: LocalSkillReport[],
  agentsMdContent?: string,
  images?: string[],
  permissionLevel?: string
): Promise<boolean> {
  const payload = {
    type: 'create_side_session',
    sessionId: Number(parentSessionId),
    data: {
      content,
      contextMode,
      images: images || [],
      // ... 其余字段不变
    },
  };
  // ...
}
```

#### 步骤 4：Fork 模式下刷新消息列表

**文件**：`desktop/src/components/chat/SideChatPanel.vue`（`handleChatSend` 中 `createSideSession` 返回后的逻辑）

当 `contextMode.value === 'fork'` 时，在收到 `side_session_created` 事件后，调用消息分页接口重新拉取边路会话消息，以展示被复制的历史消息。现有逻辑在 `side_session_created` 后已有 `fetchMessages` 调用，需确认该调用能正确加载 fork 过来的消息。

---

## 5. 落地清单

### 5.1 后端改动文件

| 文件 | 改动 |
| --- | --- |
| `backend-ts/src/harness/core/harness-service.ts` | `executeSideFirstMessage` 签名改为 `contextMode`，新增 `forkParentMessages` 方法 |
| `backend-ts/src/harness/core/harness-service.spec.ts` | 修改现有测试参数，新增 fork 和 none 模式测试 |
| `backend-ts/src/session/ws/streaming-ws-handler.ts` | `handleCreateSideSession` 解析 `contextMode`，接口定义更新 |
| `backend-ts/src/session/ws/streaming-ws-handler.spec.ts` | WS 测试中 `inheritContext` 改为 `contextMode` |

### 5.2 前端改动文件

| 文件 | 改动 |
| --- | --- |
| `desktop/src/components/chat/SideChatPanel.vue` | checkbox → radio-group，`inheritContext` → `contextMode`，Fork 模式下刷新消息 |
| `desktop/src/composables/useStreamWS.ts` | `createSideSession` 参数和 WS payload 字段替换 |

### 5.3 不改动的文件

| 文件 | 说明 |
| --- | --- |
| `backend-ts/db/migration/` | 无数据库 schema 变更 |
| `backend-ts/src/session/session.service.ts` | `promoteSideTaskToMainSession` 不改，但 `forkParentMessages` 会复用其消息复制模式 |
| `admin/` | 不涉及管理后台 |
| `agent-cli/` | 不涉及终端 CLI |
| `android/` | 不涉及安卓原生壳 |

### 5.4 验证方式

| 验证项 | 方法 |
| --- | --- |
| 后端单测 | `cd backend-ts && npm test`（harness-service.spec.ts + streaming-ws-handler.spec.ts） |
| 前端构建 | `cd desktop && npm run build`（vue-tsc 类型检查） |
| 手动验证 - Fork | 新建边路任务选 Fork → 对话页面显示主会话历史消息 → Agent 执行时上下文包含历史 |
| 手动验证 - 摘要 | 新建边路任务选主会话摘要 → 对话页面无历史消息 → Agent system prompt 含摘要 |
| 手动验证 - 不继承 | 新建边路任务选不继承 → 全新对话 → Agent 无主会话上下文 |

### 5.5 CHANGELOG

在 `CHANGELOG.md` 顶部 `## x.y.z` 的 **前端** 小节新增：

> 边路任务新建时上下文继承方式从勾选框改为三选一单选：Fork 主会话（完整继承历史消息）/ 主会话摘要 / 不继承。
