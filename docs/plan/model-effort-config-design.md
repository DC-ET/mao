# 模型 Reasoning Effort 配置化 — 技术方案

> 状态：待评审
> 日期：2026-09-04
> 范围：backend-ts + admin + shared/contracts；不涉及 desktop / android / agent-cli

## 一、需求背景

当前系统在 `PromptEngine.buildRequest()` 中通过 `isGptModel()` 判断模型 ID 是否以 `gpt-` 开头来决定是否设置 `reasoning: { effort: 'high' }`。该判断存在以下问题：

1. **判断维度错误**：是否使用 reasoning effort 取决于模型协议（Responses API / ChatCompletions），而非模型名称前缀。名为 `my-gpt-proxy` 的非 GPT 模型会被误判。
2. **不可配置**：effort 值硬编码为 `high`，用户无法按模型调整推理力度。
3. **ChatCompletions 格式不匹配**：OpenAI ChatCompletions API 的参数名为 `reasoning_effort`（顶层字符串），而当前 `serializeChatRequest` 发送的是 `reasoning: { effort: "high" }`（对象），与官方 API 规格不一致。

## 二、需求描述

将 reasoning effort 改为**模型级显式配置项**，按协议类型驱动：

1. `llm_model` 表新增 `effort` 字段，支持值：`none`、`low`、`medium`、`high`、`xhigh`、`max`、留空。
2. PromptEngine 不再使用 `isGptModel()` 判断，改为按模型配置的 `apiProtocol` 和 `effort` 字段决定是否设置 reasoning 及其值。
3. 两种协议的序列化格式各自正确：ChatCompletions 发 `reasoning_effort`（字符串），Responses 发 `reasoning: { effort }`（对象）。Anthropic 协议不发。
4. 管理后台模型表单增加 effort 下拉选择，仅当协议为 OpenAI 兼容 / Responses 时显示。

### 明确要做

| # | 事项 |
|---|------|
| 1 | `llm_model` 表新增 `effort` 列（VARCHAR(10)，默认空字符串） |
| 2 | 共享契约 `ModelVO` 与后端 `LlmModel`、harness 层 `LlmModelConfig` 增加 `effort` 字段 |
| 3 | 后端创建/更新模型接口接收并严格校验 effort 值，非法值返回 `PARAM_INVALID` |
| 4 | `llmModelToConfig` 转换函数透传 effort 字段 |
| 5 | PromptEngine 删除 `isGptModel()` 判断，改为按 `apiProtocol` + `effort` 设置 `request.reasoning` |
| 6 | `serializeChatRequest`（ChatCompletions 序列化）改发 `reasoning_effort` 字符串，替代当前 `reasoning` 对象 |
| 7 | Responses 适配器 `buildResponsesBody` 注释更新（格式不变，仍发对象） |
| 8 | 管理后台模型表单增加 effort 下拉框，协议条件显示 |
| 9 | 更新受影响的现有单测，新增配置驱动的断言用例 |
| 10 | 根 CHANGELOG.md 记录本次用户可见变更 |

### 明确不做

| # | 事项 |
|---|------|
| 1 | 不改 Anthropic 适配器（Anthropic 协议不发 reasoning effort） |
| 2 | 不改辅助 LLM 调用（Git 提交信息、会话标题生成保持 `effort: 'none'` 硬编码） |
| 3 | 不改上下文压缩逻辑（透传源请求的 reasoning，行为不变） |
| 4 | 不在模型列表页新增列展示 effort 字段 |
| 5 | 不做按模型名称自动推断 effort |
| 6 | 不保留 `isGptModel()` 作为兜底逻辑 |
| 7 | 不改 desktop / android / agent-cli / mao-cli 任何代码 |
| 8 | 不做 effort 值的模型级子集校验（如某模型不支持 `none`），统一开放 6 个值 |

### 决策共识记录

| 决策点 | 结论 |
|--------|------|
| Responses 协议默认 effort | `high`（留空时） |
| OpenAI 兼容协议 | 也发 effort，修正为正确的 `reasoning_effort` 字符串格式 |
| Anthropic 协议 | 不发 reasoning effort |
| effort 解析位置 | PromptEngine.buildRequest()（与当前 isGptModel 同层替换） |
| 数据库字段 | VARCHAR(10) DEFAULT ''，留空 = 使用协议默认值 |
| 辅助调用 | 保持 `effort: 'none'` 硬编码，不读模型配置 |
| UI 显示条件 | 仅协议为 openai-responses / openai-compatible 时显示 effort 下拉 |
| UI 默认选项 | "默认（high）" 对应空字符串 |
| 后端校验 | 严格白名单：none / low / medium / high / xhigh / max / 空字符串 |
| effort 枚举值 | none, low, medium, high, xhigh, max（与 OpenAI 官方一致） |

## 三、技术选型

- **存储**：MySQL 8 + Flyway 版本化迁移（`backend-ts/db/migration/V103__*.sql`）。VARCHAR(10) 足够容纳最长值 `xhigh`（6 字符），与现有 `api_protocol` 列风格一致。
- **类型契约**：`@mao/contracts` 的 `ModelVO` 增加 `effort?: string | null` 字段，前后端单一事实源。
- **协议感知序列化**：各 LLM 适配器已有独立的请求体构建函数（`serializeChatRequest` for ChatCompletions、`buildResponsesBody` for Responses），在各自函数内按协议格式序列化，无需引入新抽象。
- **UI**：Element Plus `el-select`，与同表单已有的「API 协议」下拉框交互一致。

## 四、详细设计

### 4.1 数据库迁移（V103）

`backend-ts/db/migration/V103__add_llm_model_effort.sql`：

```sql
-- 模型新增 reasoning effort 配置字段。
-- 留空表示使用协议默认值（openai-responses 默认 high）。
-- 仅 openai-responses / openai-compatible（空 api_protocol）协议生效，anthropic 协议忽略。
ALTER TABLE `llm_model`
    ADD COLUMN `effort` VARCHAR(10) NOT NULL DEFAULT ''
        COMMENT 'reasoning effort: none/low/medium/high/xhigh/max，留空=协议默认'
        AFTER `api_protocol`;
```

### 4.2 共享契约与类型定义

**`shared/contracts/src/model.ts`** — `ModelVO` 增加字段：

```ts
export interface ModelVO {
  // ... 现有字段 ...
  effort?: string | null;  // 新增
}
```

**`backend-ts/src/model/types.ts`** — `LlmModel` 增加：

```ts
export interface LlmModel {
  // ... 现有字段 ...
  effort?: string | null;  // 新增
}
```

**`backend-ts/src/harness/llm/chat-request.ts`** — harness 层 `LlmModelConfig` 增加：

```ts
export interface LlmModelConfig {
  // ... 现有字段 ...
  effort?: string | null;  // 新增
}
```

### 4.3 后端模型服务

#### 4.3.1 校验函数

`backend-ts/src/model/model.service.ts` 新增 `normalizeEffort`：

```ts
const EFFORT_VALUES = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function normalizeEffort(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (!(EFFORT_VALUES as readonly string[]).includes(trimmed)) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID.code,
      `effort 只能是 ${EFFORT_VALUES.join(' / ')} 或留空`,
    );
  }
  return trimmed;
}
```

#### 4.3.2 创建/更新模型

`createModel` 和 `updateModel` 方法增加 `effort` 参数，调用 `normalizeEffort` 校验后写入。

#### 4.3.3 路由层

`model.routes.ts` 的 `CreateModelRequest` 增加字段：

```ts
interface CreateModelRequest {
  // ... 现有字段 ...
  effort?: string;
}
```

`toVO` 函数增加 `effort: entity.effort`。

#### 4.3.4 仓储层

`model.repository.ts` 的 `insert` 和 `updateById` 增加 `effort` 字段映射。

### 4.4 模型配置转换

`backend-ts/src/harness/deps.ts` 的 `llmModelToConfig` 透传：

```ts
export function llmModelToConfig(model: LlmModel): LlmModelConfig {
  return {
    // ... 现有映射 ...
    effort: model.effort ?? undefined,  // 新增
  };
}
```

### 4.5 PromptEngine 改造

`backend-ts/src/harness/core/prompt-engine.ts`：

**删除** `isGptModel()` 函数及其调用，**替换**为：

```ts
// reasoning effort：按协议类型驱动。Anthropic 协议不支持 reasoning effort，跳过。
// 留空 effort 使用默认值 high。
const protocol = context.modelConfig?.apiProtocol?.trim().toLowerCase();
if (protocol !== 'anthropic') {
  const effort = context.modelConfig?.effort?.trim() || 'high';
  request.reasoning = { effort };
}
```

逻辑说明：
- `apiProtocol` 为空字符串（OpenAI 兼容）或 `openai-responses` → 设置 reasoning
- `apiProtocol` 为 `anthropic` → 不设置 reasoning
- effort 留空 → 默认 `high`

### 4.6 序列化层改造

#### 4.6.1 ChatCompletions（`json.ts`）

`serializeChatRequest` 修改 reasoning 字段的序列化方式：

```ts
// 改前
if (request.reasoning != null) body.reasoning = request.reasoning;

// 改后
if (request.reasoning != null) body.reasoning_effort = request.reasoning.effort;
```

ChatCompletions API 的参数名为 `reasoning_effort`（顶层字符串），而非 `reasoning`（对象）。

#### 4.6.2 Responses API（`responses-llm-adapter.ts`）

`buildResponsesBody` 格式不变，仍发送对象：

```ts
if (request.reasoning != null) {
  body.reasoning = { effort: request.reasoning.effort ?? 'high' };
}
```

仅更新注释，移除关于 `gpt-*` 前缀判断的描述。

### 4.7 管理后台 UI

`admin/src/views/model/ModelFormDialog.vue`：

- `form` reactive 对象增加 `effort: ''` 字段
- 增加条件渲染的 `el-select`：

```vue
<el-form-item v-if="isTextType && supportsEffort" label="推理力度">
  <el-select v-model="form.effort" style="width: 100%">
    <el-option label="默认（high）" value="" />
    <el-option label="None" value="none" />
    <el-option label="Low" value="low" />
    <el-option label="Medium" value="medium" />
    <el-option label="High" value="high" />
    <el-option label="X-High" value="xhigh" />
    <el-option label="Max" value="max" />
  </el-select>
  <span style="margin-left: 8px; color: #909399; font-size: 12px;">
    控制 reasoning token 预算，留空使用协议默认值
  </span>
</el-form-item>
```

- `supportsEffort` 计算属性：协议非 `anthropic` 时为 `true`
- `resetForm` 和 `watch` 初始化时设置 `effort: props.modelData?.effort || ''`
- 提交时 `payload` 包含 `effort` 字段

### 4.8 数据链路总览

```
模型表单 (admin UI)
  → POST/PUT /v1/models (model.routes.ts, CreateModelRequest.effort)
  → ModelService.createModel/updateModel (normalizeEffort 校验)
  → MysqlLlmModelRepository.insert/updateById (持久化)
  → SELECT 时读出 LlmModel.effort
  → llmModelToConfig (deps.ts, 透传 effort → LlmModelConfig.effort)
  → AgentExecutionContext.modelConfig
  → PromptEngine.buildRequest (按协议 + effort 设置 request.reasoning)
  → LlmAdapterFacade.pick (按 apiProtocol 路由适配器)
  → OpenAiLlmAdapter: serializeChatRequest → body.reasoning_effort = "high" (字符串)
  → ResponsesLlmAdapter: buildResponsesBody → body.reasoning = { effort: "high" } (对象)
  → AnthropicLlmAdapter: 不发 reasoning (request.reasoning 为 undefined)
```

### 4.9 辅助 LLM 调用（不变）

以下调用保持硬编码 `reasoning: { effort: 'none' }`，不读模型配置：

- `backend-ts/src/file/git-commit-message.service.ts:159`
- `backend-ts/src/session/session-title.service.ts:163`

这些场景不需要推理，禁用可节省 token。

### 4.10 上下文压缩（不变）

`compaction-service.ts` 的 `deriveRequest` 透传 `source.reasoning`，行为不变。因为 PromptEngine 已正确设置 reasoning，压缩继承的值也正确。

## 五、实现步骤

### Step 1：数据库迁移

创建 `backend-ts/db/migration/V103__add_llm_model_effort.sql`。

### Step 2：后端类型与数据层

1. `shared/contracts/src/model.ts`：`ModelVO` 增加 `effort` 字段
2. `shared/contracts/src/model.d.ts`：同步 `.d.ts` 声明
3. `backend-ts/src/model/types.ts`：`LlmModel` 增加 `effort`
4. `backend-ts/src/harness/llm/chat-request.ts`：`LlmModelConfig` 增加 `effort`
5. `backend-ts/src/model/model.repository.ts`：insert/updateById 增加 effort
6. `backend-ts/src/model/model.service.ts`：增加 `normalizeEffort`，createModel/updateModel 接收 effort
7. `backend-ts/src/model/model.routes.ts`：CreateModelRequest 增加 effort，toVO 增加映射，create/update 调用传参
8. `backend-ts/src/harness/deps.ts`：`llmModelToConfig` 透传 effort

### Step 3：核心逻辑改造

1. `backend-ts/src/harness/core/prompt-engine.ts`：删除 `isGptModel()`，替换为协议+effort 判断
2. `backend-ts/src/harness/llm/json.ts`：`serializeChatRequest` 改发 `reasoning_effort` 字符串
3. `backend-ts/src/harness/llm/responses-llm-adapter.ts`：更新注释

### Step 4：管理后台 UI

1. `admin/src/views/model/ModelFormDialog.vue`：增加 effort 下拉框，条件显示，表单初始化与提交

### Step 5：测试更新

1. `backend-ts/src/harness/core/prompt-engine.spec.ts`：替换 `isGptModel` 断言为协议+effort 断言
2. `backend-ts/src/harness/llm/openai-llm-adapter.spec.ts`：更新 reasoning 序列化断言（`reasoning_effort` 字符串格式）
3. `backend-ts/src/model/model.service.spec.ts`：增加 effort 校验测试

### Step 6：CHANGELOG 与文档

1. 根 `CHANGELOG.md` 记录变更
2. 更新 `skills/mao-cli/SKILL.md` 中模型管理相关描述（如有涉及）

## 六、落地清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `backend-ts/db/migration/V103__add_llm_model_effort.sql` | 新增 | 数据库迁移 |
| `shared/contracts/src/model.ts` | 编辑 | ModelVO 增加 effort |
| `shared/contracts/src/model.d.ts` | 编辑 | 同步声明 |
| `backend-ts/src/model/types.ts` | 编辑 | LlmModel 增加 effort |
| `backend-ts/src/model/model.repository.ts` | 编辑 | insert/updateById 增加 effort |
| `backend-ts/src/model/model.service.ts` | 编辑 | normalizeEffort + create/update 传参 |
| `backend-ts/src/model/model.routes.ts` | 编辑 | CreateModelRequest + toVO + 路由传参 |
| `backend-ts/src/harness/llm/chat-request.ts` | 编辑 | LlmModelConfig 增加 effort |
| `backend-ts/src/harness/deps.ts` | 编辑 | llmModelToConfig 透传 effort |
| `backend-ts/src/harness/core/prompt-engine.ts` | 编辑 | 删除 isGptModel，替换为协议+effort 逻辑 |
| `backend-ts/src/harness/llm/json.ts` | 编辑 | serializeChatRequest 改发 reasoning_effort 字符串 |
| `backend-ts/src/harness/llm/responses-llm-adapter.ts` | 编辑 | 更新注释 |
| `admin/src/views/model/ModelFormDialog.vue` | 编辑 | 增加 effort 下拉框 |
| `backend-ts/src/harness/core/prompt-engine.spec.ts` | 编辑 | 更新断言 |
| `backend-ts/src/harness/llm/openai-llm-adapter.spec.ts` | 编辑 | 更新序列化断言 |
| `backend-ts/src/model/model.service.spec.ts` | 编辑 | 增加 effort 校验测试 |
| `CHANGELOG.md` | 编辑 | 记录变更 |
