# 模型与 Agent 解耦 — 会话级模型选择技术方案

> 将模型选择从 Agent 维度迁移到 Session 维度，支持创建会话时选择模型、会话进行中随时切换模型。

## 1. 背景与目标

**现状**：模型通过 `Agent.modelId` 绑定在 Agent 上，同一 Agent 的所有会话只能使用同一个模型。

**目标**：
- Agent 不再绑定模型，模型选择下沉到 Session 维度
- `llm_model` 表增加 `is_default` 字段，作为新建会话的默认模型
- 会话进行中支持随时切换模型（暂不处理上下文窗口差异）
- Admin 端移除 Agent 的模型选择，增加模型默认标记管理

## 2. 数据模型变更

### 2.1 Flyway 迁移 — `V034__session_model_decoupling.sql`

```sql
-- 1. session 表增加 model_id（可 NULL，NULL 表示使用默认模型）
ALTER TABLE `session` ADD COLUMN `model_id` BIGINT NULL COMMENT '当前会话使用的模型 ID，NULL 表示使用默认模型';

-- 2. llm_model 表增加 is_default
ALTER TABLE `llm_model` ADD COLUMN `is_default` TINYINT NOT NULL DEFAULT 0 COMMENT '是否默认模型：0=否 1=是';

-- 3. 将当前 Agent 绑定的模型设为默认（取第一个有 modelId 的 Agent 关联的模型）
UPDATE `llm_model` SET `is_default` = 1
WHERE `id` = (SELECT `model_id` FROM `agent` WHERE `model_id` IS NOT NULL LIMIT 1);

-- 4. 删除 agent 表的 model_id 列
ALTER TABLE `agent` DROP COLUMN `model_id`;
```

> 初版开发阶段，无需数据迁移兼容。直接 DROP agent.model_id 即可。

### 2.2 实体变更

| 实体 | 文件 | 变更 |
|---|---|---|
| `Session` | `backend/.../session/entity/Session.java` | 新增 `private Long modelId;` |
| `Agent` | `backend/.../agent/entity/Agent.java` | 删除 `private Long modelId;` |
| `LlmModel` | `backend/.../model/entity/LlmModel.java` | 新增 `private Integer isDefault;` |

### 2.3 SessionVO / AgentVO 变更

**SessionVO**（`SessionController.java` 内部类）新增：
```java
private Long modelId;
private String modelName;   // 关联查询填充
private Integer modelSupportsVision;  // 用于前端判断是否可发图片
```

**AgentVO**（`AgentController.java` 内部类）移除：
```java
// 删除以下两个字段
private Long modelId;
private String modelName;
```

## 3. 后端改动

### 3.1 HarnessService — 模型解析链路变更

**文件**：`backend/.../harness/core/HarnessService.java` 第 115-142 行

**改动前**：
```java
LlmModel llmModel = llmModelMapper.selectById(agent.getModelId());
```

**改动后**：
```java
// 优先使用 Session 级别的 modelId，fallback 到默认模型
Long modelId = session.getModelId();
LlmModel llmModel;
if (modelId != null) {
    llmModel = llmModelMapper.selectById(modelId);
} else {
    // 查找默认模型
    llmModel = llmModelMapper.selectOne(
        new QueryWrapper<LlmModel>().eq("is_default", 1).eq("status", 1));
}
if (llmModel == null) {
    throw new BusinessException(ErrorCode.MODEL_NOT_FOUND);
}
```

### 3.2 StreamingWsHandler — Vision 检查变更

**文件**：`backend/.../session/ws/StreamingWsHandler.java` 第 221-231 行、第 516-526 行

两处 vision 检查都需要改为从 Session 获取模型：

**改动前**（两处相同逻辑）：
```java
Agent agent = agentMapper.selectById(session.getAgentId());
if (agent != null) {
    LlmModel model = llmModelMapper.selectById(agent.getModelId());
    // ...
}
```

**改动后**：
```java
LlmModel model = resolveSessionModel(session);
if (model == null || model.getSupportsVision() == null || model.getSupportsVision() != 1) {
    registry.send(userId, WsEvent.of("error", sessionId,
            Map.of("message", "当前模型不支持图片输入，请切换支持视觉的模型")));
    return;
}
```

抽取公共方法 `resolveSessionModel(Session session)` 复用 3.1 的逻辑。

### 3.3 AgentController — 移除模型相关逻辑

**文件**：`backend/.../agent/controller/AgentController.java`

- `CreateAgentRequest`：移除 `modelId` 字段
- `UpdateAgentRequest`：移除 `modelId` 字段
- `AgentVO`：移除 `modelId`、`modelName` 字段
- `toVO()` 方法：移除 `modelId` 和 `modelName` 的填充逻辑（第 87-97 行）
- `createAgent()` / `updateAgent()`：移除 `request.getModelId()` 参数传递

### 3.4 AgentService — 移除模型参数

**文件**：`backend/.../agent/service/AgentService.java`

- `createAgent()` 方法签名移除 `modelId` 参数
- `updateAgent()` 方法签名移除 `modelId` 参数

### 3.5 SessionController — 新增模型相关 API

**文件**：`backend/.../session/controller/SessionController.java`

#### 3.5.1 CreateSessionRequest 增加 modelId

```java
@Data
public static class CreateSessionRequest {
    private Long agentId;
    private String title;
    private String executionMode;
    private String workspace;
    private String permissionLevel;
    private Long modelId;       // 新增，可选
}
```

#### 3.5.2 UpdateSessionRequest 增加 modelId

```java
@Data
public static class UpdateSessionRequest {
    private String title;
    private String summary;
    private String projectKey;
    private String permissionLevel;
    private Long modelId;       // 新增，支持随时切换
}
```

#### 3.5.3 SessionVO 增加模型信息

```java
@Data
public static class SessionVO {
    // ... 现有字段 ...
    private Long modelId;
    private String modelName;
    private Integer modelSupportsVision;
}
```

#### 3.5.4 toVO() 方法增加模型信息填充

```java
private SessionVO toVO(Session session) {
    // ... 现有逻辑 ...
    if (session.getModelId() != null) {
        LlmModel model = llmModelMapper.selectById(session.getModelId());
        if (model != null) {
            vo.setModelId(model.getId());
            vo.setModelName(model.getName());
            vo.setModelSupportsVision(model.getSupportsVision());
        }
    } else {
        // 使用默认模型
        LlmModel defaultModel = getDefaultModel();
        if (defaultModel != null) {
            vo.setModelId(defaultModel.getId());
            vo.setModelName(defaultModel.getName());
            vo.setModelSupportsVision(defaultModel.getSupportsVision());
        }
    }
    return vo;
}
```

### 3.6 ModelController — 支持默认标记管理

**文件**：`backend/.../model/controller/ModelController.java`

- `CreateModelRequest` / `UpdateModelRequest` 增加 `isDefault` 字段
- `ModelVO` 增加 `isDefault` 字段
- 设置默认模型时，需先将其他模型的 `is_default` 置 0（应用层保证唯一性）

### 3.7 ModelService — 默认模型管理逻辑

**文件**：`backend/.../model/service/ModelService.java`

`createModel()` / `updateModel()` 中增加默认标记处理：
```java
if (isDefault != null && isDefault == 1) {
    // 清除其他默认标记
    LlmModel current = new LlmModel();
    current.setIsDefault(0);
    llmModelMapper.update(current, new QueryWrapper<LlmModel>().eq("is_default", 1));
}
```

## 4. 前端改动（Desktop）

### 4.1 Session Store — 类型与方法变更

**文件**：`desktop/src/stores/session.ts`

Session 接口新增：
```typescript
export interface Session {
  // ... 现有字段 ...
  modelId?: number
  modelName?: string
  modelSupportsVision?: number
}
```

`createSession` 方法增加 `modelId` 参数：
```typescript
async function createSession(agentId: string, executionMode: string, workspace?: string, modelId?: number) {
    const { data } = await api.post('/sessions', {
      agentId,
      executionMode,
      workspace: workspace || undefined,
      modelId: modelId || undefined
    })
    // ...
}
```

新增 `updateSessionModel` 方法：
```typescript
async function updateSessionModel(sessionId: string, modelId: number) {
    await api.patch(`/sessions/${sessionId}`, { modelId })
    // 更新本地 store
    const sid = String(sessionId)
    const idx = sessions.value.findIndex(s => String(s.id) === sid)
    if (idx !== -1) {
      sessions.value[idx].modelId = modelId
    }
}
```

### 4.2 Agent Store — 移除模型字段

**文件**：`desktop/src/stores/agent.ts`

Agent 接口移除：
```typescript
export interface Agent {
  // 删除以下两个字段
  // modelId?: number
  // modelName?: string
}
```

### 4.3 ChatInput — 模型名改为可交互选择器

**文件**：`desktop/src/components/chat/ChatInput.vue`

将第 94 行的纯展示 `<span>` 改为可点击的选择器：

```html
<div class="toolbar-right">
  <el-popover trigger="click" :width="280" v-model:visible="modelPopoverVisible">
    <template #reference>
      <span class="model-name clickable">{{ currentModelName }}</span>
    </template>
    <div class="model-selector">
      <div
        v-for="m in availableModels"
        :key="m.id"
        class="model-option"
        :class="{ active: m.id === currentModelId }"
        @click="handleModelSwitch(m.id)"
      >
        <span class="model-option-name">{{ m.name }}</span>
        <el-tag v-if="m.supportsVision" size="small" type="success">视觉</el-tag>
      </div>
    </div>
  </el-popover>
</div>
```

Props 变更：
```typescript
const props = defineProps<{
  // ... 现有 props ...
  modelId?: number
  modelName?: string
  modelSupportsVision?: number
}>()

const emit = defineEmits<{
  // ... 现有 events ...
  'update:modelId': [modelId: number]
}>()
```

新增逻辑：
- 加载可用模型列表（调用 `GET /v1/models?status=1`）
- 切换模型时 emit `update:modelId` 事件

### 4.4 TaskView — 模型数据源变更

**文件**：`desktop/src/views/task/TaskView.vue`

将模型数据源从 `agentStore.activeAgent` 改为 `sessionStore`：

```html
<!-- 改动前 -->
<ChatInput
  :model-name="agentStore.activeAgent?.modelName || ''"
/>

<!-- 改动后 -->
<ChatInput
  :model-id="currentSession?.modelId"
  :model-name="currentSession?.modelName || ''"
  :model-supports-vision="currentSession?.modelSupportsVision"
  @update:model-id="handleModelSwitch"
/>
```

`handleModelSwitch` 方法：
```typescript
async function handleModelSwitch(modelId: number) {
  if (!currentSession.value) return
  await sessionStore.updateSessionModel(currentSession.value.id, modelId)
  // 重新获取 session 详情以更新 modelName 等信息
  await sessionStore.fetchSession(currentSession.value.id)
}
```

### 4.5 新建会话流程 — 增加模型选择

在新建会话的 UI 流程中（`NewTaskFlow` 或类似组件），增加模型选择步骤：

- 展示可用模型列表（`GET /v1/models?status=1`）
- 默认选中 `isDefault=1` 的模型
- 用户可切换，选择结果传给 `sessionStore.createSession(..., modelId)`

## 5. 前端改动（Admin）

### 5.1 AgentFormDialog — 移除模型选择

**文件**：`admin/src/views/agent/AgentFormDialog.vue`

删除第 24-33 行的模型选择 `<el-form-item>`：
```html
<!-- 删除 -->
<el-form-item label="模型" prop="modelId">
  <el-select v-model="form.modelId" ...>
    ...
  </el-select>
</el-form-item>
```

同时清理 `form` 中的 `modelId` 字段、`loadOptions` 中的模型加载（如果仅用于 Agent 表单）、`resetForm` 中的 `modelId` 重置。

### 5.2 ModelListView — 增加默认标记列

**文件**：`admin/src/views/model/ModelListView.vue`

表格增加"默认"列：
```html
<el-table-column label="默认" width="80" align="center">
  <template #default="{ row }">
    <el-tag :type="row.isDefault ? 'warning' : 'info'" size="small">
      {{ row.isDefault ? '默认' : '' }}
    </el-tag>
  </template>
</el-table-column>
```

### 5.3 ModelFormDialog — 增加默认开关

**文件**：`admin/src/views/model/ModelFormDialog.vue`

表单增加"设为默认"开关：
```html
<el-form-item label="默认模型">
  <el-switch v-model="form.isDefault" />
</el-form-item>
```

`form` 增加 `isDefault: false` 字段，提交时转为 `0/1`。

## 6. 改动文件清单

### 后端（10 个文件）

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `V034__session_model_decoupling.sql` | 新增 | Flyway 迁移脚本 |
| `Session.java` | 修改 | 增加 `modelId` 字段 |
| `Agent.java` | 修改 | 删除 `modelId` 字段 |
| `LlmModel.java` | 修改 | 增加 `isDefault` 字段 |
| `HarnessService.java` | 修改 | 模型解析链路：Session 优先，fallback 默认 |
| `StreamingWsHandler.java` | 修改 | Vision 检查改为从 Session 获取模型 |
| `SessionController.java` | 修改 | Request/VO 增加 modelId，toVO 填充模型信息 |
| `AgentController.java` | 修改 | 移除 modelId 相关字段和逻辑 |
| `AgentService.java` | 修改 | 移除 modelId 参数 |
| `ModelController.java` / `ModelService.java` | 修改 | 增加 isDefault 管理逻辑 |

### 前端 Desktop（5 个文件）

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `desktop/src/stores/session.ts` | 修改 | Session 接口增加模型字段，createSession 增加 modelId 参数，新增 updateSessionModel |
| `desktop/src/stores/agent.ts` | 修改 | Agent 接口移除 modelId/modelName |
| `desktop/src/components/chat/ChatInput.vue` | 修改 | 模型名改为可交互选择器 |
| `desktop/src/views/task/TaskView.vue` | 修改 | 模型数据源改为 session 维度 |
| `desktop/src/components/task/NewTaskFlow.vue`（或类似） | 修改 | 新建会话增加模型选择步骤 |

### 前端 Admin（3 个文件）

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `admin/src/views/agent/AgentFormDialog.vue` | 修改 | 移除模型选择下拉 |
| `admin/src/views/model/ModelListView.vue` | 修改 | 增加默认标记列 |
| `admin/src/views/model/ModelFormDialog.vue` | 修改 | 增加默认模型开关 |

## 7. 不改动的部分

以下模块只需消费 `LlmModelConfig`，不感知模型来源，**无需改动**：

- `AgentLoop.java` — 从 `AgentExecutionContext.getModelConfig()` 取配置
- `PromptEngine.java` — 只构建 messages 和 tools
- `LlmAdapter.java` / `OpenAiLlmAdapter.java` — 只认 `LlmModelConfig`
- `CompactionService.java` — 从 context 取 `modelConfig.getModelId()`

## 8. 注意事项

1. **默认模型唯一性**：应用层保证 `is_default=1` 只有一条记录。设置新默认时先清除旧默认。
2. **Session 无 modelId 的 fallback**：`HarnessService.buildContext()` 中，当 `session.getModelId()` 为 NULL 时，查询 `is_default=1` 的模型。如果没有任何默认模型，抛出 `MODEL_NOT_FOUND` 异常。
3. **切换模型后的即时生效**：切换模型后，下一次 Agent Loop 使用新模型。无需重启会话。
4. **vision 检查的时效性**：切换到不支持 vision 的模型后，前端应根据 `modelSupportsVision` 字段禁用图片上传按钮。
