# 统一 Tool Contract（Descriptor / Invocation / Result）— 技术方案

> 状态：待评审
> 日期：2026-08-29
> 范围：backend-ts（`harness/tool/`、`harness/core/`、`harness/mcp/`、`session/ws/`）；不涉及 DB 迁移、admin、desktop、android、agent-cli
> 背景：基于《Mao-统一Tool-Contract改造评估报告》，并结合 Provider Adapter 已落地的现状对报告结论做修订

## 一、背景与现状核验

### 1.1 报告结论与代码现状的对照

外部评估报告（基于 commit `571a628`）的核心论断经逐条核验属实：

| 报告论断 | 代码现状 |
|---|---|
| `Tool.execute` 靠参数个数传语义 | `harness/tool/tool.ts:26-45`，`BaseTool.execute` 按 `arguments.length` 分派到 4 参链 |
| `ToolDispatcher.dispatch` 10 个位置参数 | `harness/tool/tool-dispatcher.ts:55-66`，`n<=2 / n===3 / n===5...` 分支猜测重载 |
| MCP 工具靠 `mcp__` 字符串前缀识别 | `tool-dispatcher.ts:17` 常量 + `:178`（`shouldRequireApproval`）用于审批判断；`McpToolAdapter.getRef()` 已能提供结构化信息但无人消费 |
| 工具结果是裸 string，错误靠启发式解析 | `session/ws/ws-streaming-event-listener.ts:218-222` `isErrorResult` 对结果字符串做 `JSON.parse` + 检查 `error` 键；`agent-loop.ts:541-543` 把执行异常转成 `'Tool execution failed: ' + message` 字符串，status 信息在执行层就已丢失 |
| Provider 工具格式转换缺独立边界 | **已被后续工作解决**（见 1.2） |

### 1.2 报告过时项：Provider Normalizer 已存在

`llm/` 下已落地三种协议 Adapter（见 `docs/plan/llm-provider-adapter-design.md` 与 `docs/plan/openai-responses-adapter-design.md`）：

- `openai-llm-adapter.ts`（Chat Completions，默认分支）
- `anthropic-llm-adapter.ts`（Messages API：工具出站转 `{name, description, input_schema}`，见 `:540-545`；入站 `tool_use` 事件归一化为 OpenAI 形状 delta，见 `:315-323`）
- `responses-llm-adapter.ts`（Responses API：工具出站平铺，见 `:780-787`；入站 `function_call` 归一化，见 `:964-969`）
- `llm-adapter-facade.ts` 按 `apiProtocol` 路由，未知值回落 openai

即每个 Adapter 本身就是报告设想的 "Provider-specific Tool Normalizer"，且统一以 OpenAI `ToolDefinition`（`chat-request.ts:54`）为内部规范形状。**报告的阶段 4（Provider Normalizer）从本方案中删除**，同时 descriptor 不再承担"喂给 Provider 做格式转换"的职责。

### 1.3 剩余的真实问题（本方案范围）

1. **调用上下文靠参数位置传递**：`dispatch()` 生产代码唯一调用点是 `agent-loop.ts:536`，泥潭已被封装，但新增上下文（callId 贯穿、执行模式、审批结果）仍要继续加位置参数。
2. **工具来源靠字符串约定**：MCP 判断依赖 `mcp__` 前缀；`SERVER_ONLY_TOOLS`、`WRITE_TOOLS` 是散落的常量集合，与工具实现分离维护。
3. **结果状态在执行层丢失**：错误/成功信息以字符串形态流经 `Dispatcher → AgentLoop → Listener → WS`，每一层各自猜测；事件 `status` 字段已存在（`ws-streaming-event-listener.ts:92`），但判定来源是 WS 层启发式而非执行层事实。

## 二、目标与边界

### 2.1 目标

三件事，全部是"加"，不动执行分流：

```text
ToolDescriptor   描述层：工具是谁、从哪来、在哪执行（供审批/审计/展示消费）
ToolInvocation   调用层：显式上下文对象取代位置参数
ToolResult       结果层：status/errorMessage/durationMs 结构化；content 字符串原样保留
```

### 2.2 明确不做

| # | 事项 | 理由 |
|---|------|------|
| 1 | Provider Normalizer | 已由三个 LLM Adapter 自然实现（§1.2） |
| 2 | Skill 可执行化 | Skill 定位是 Prompt 知识注入（`harness-service.ts:340-390`），强转 Tool 会复杂化权限与 token，无真实需求 |
| 3 | 重做 ToolDispatcher 分流 | 现有 CLOUD/LOCAL/MCP/审批/后台 Shell 策略成熟，本次只换输入输出形状 |
| 4 | 修改 `Tool.execute` 签名、删除 `BaseTool` arity 兼容层 | 25+ 内置工具实现与 `callTool()`（`tool.ts:80-93`）兼容层工作正常，全量改签名无独立收益 |
| 5 | ToolResult 全量结构化（attachments/structuredContent/diff） | 牵动 DB `metadataJson`、前端断线重放与历史消息兼容，收益/风险比不划算，列入演进 |
| 6 | 改 WS 事件名与既有字段、改前端 | `tool_call_result.status` 字段已存在，本次只改其判定来源 |
| 7 | DB 迁移、descriptor 落库 | 第一阶段运行时对象足够，审计字段先落现有 activity 记录 |
| 8 | 改 LOCAL 桌面端执行协议（`sendToolRequest` 请求/响应形状） | 跨端协议变更需四端同步，与本次目标无关 |

### 2.3 决策共识记录

| 决策点 | 结论 |
|--------|------|
| `Tool.execute` 是否改签名 | 不改。Dispatcher 内部组装 Invocation，仍经 `callTool()` 兼容层调用旧签名；`BaseTool` 多参链继续工作 |
| 旧 `dispatch()` 去留 | 保留为兼容入口（内部组装 Invocation 转发 `dispatchInvocation`），生产代码停止直接调用；其 18 处 spec 调用不动 |
| ToolResult 推进到哪一层 | 执行层（Dispatcher）产生，AgentLoop/Listener 消费；WS 事件协议零变化，仅 `status` 判定来源变为执行层事实 |
| 前缀判断怎么办 | descriptor 判定优先，`mcp__` 前缀保留为 fallback（descriptor 缺失场景），不设删除期限 |
| MCP CLOUD/LOCAL 差异如何表达 | `McpToolAdapter` 构造时 `clientManager == null` 即 LOCAL（`mcp-tool-adapter.ts:26`），descriptor 据此区分 `executor`，不新增构造参数 |

## 三、总体设计

```text
AgentLoop.executeToolCalls（agent-loop.ts:461）
      │ 组装 ToolInvocation{callId, toolName, argumentsJson, executionMode,
      │                     sessionId, userId, executionUserId, workspace,
      │                     permissionLevel, modelConfig, sessionTools}
      ▼
ToolDispatcher.dispatchInvocation(invocation): Promise<ToolResult>   ← 新入口
      │ 1. resolveDescriptor(invocation)        ← 新增，见 4.1
      │ 2. 特例分发：ask_user_questions / SERVER_ONLY_TOOLS / LOCAL / 通用
      │    （分支逻辑与现 dispatchFull 完全一致，仅来源判断改用 descriptor）
      │ 3. 执行（callTool 兼容层 / LocalToolExecutor / McpClientManager，均不动）
      │ 4. normalizeToolResult(callId, raw): ToolResult   ← 新增，见 4.3
      ▼
AgentLoop：result.content 走既有链路（processToolResult / addToolResult / 持久化）；
           result.status 等 meta 传给 listener
      ▼
WsStreamingEventListener.onToolCallResult(id, result, meta?)：
      status 判定优先取 meta，isErrorResult 降级为 fallback
```

原则：Dispatcher 仍是唯一策略中心；Provider Adapter、LocalToolExecutor、McpClientManager、审批注册表全部零改动。

## 四、详细设计

### 4.1 ToolDescriptor（描述层）

新文件 `harness/tool/tool-descriptor.ts`：

```ts
export type ToolSource = 'builtin' | 'mcp';
export type ToolExecutor = 'server' | 'desktop' | 'mcp-server';

export interface ToolDescriptor {
  name: string;
  source: ToolSource;
  executor: ToolExecutor;
  /** source === 'mcp' 时：所属 MCP Server id 与原始工具名 */
  serverId?: number;
  originalName?: string;
}
```

字段刻意最小化：不做 capabilities/policy/streaming 等 speculative 字段，出现真实消费方再加。

落点：

1. `Tool` 接口（`tool.ts:6`）增加可选方法 `getDescriptor?(): ToolDescriptor`——可选方法不破坏任何现有实现。
2. `BaseTool`（`tool.ts:22`）提供默认实现：`{ name: this.getName(), source: 'builtin', executor: 'server' }`。全部继承 `BaseTool` 的内置工具自动获得，`harness/tool/impl/*.ts` 零改动。
3. `McpToolAdapter`（`mcp-tool-adapter.ts`）override：

```ts
getDescriptor(): ToolDescriptor {
  return {
    name: this.getName(),
    source: 'mcp',
    executor: this.clientManager ? 'mcp-server' : 'desktop',
    serverId: this.ref.serverId,
    originalName: this.ref.toolName,
  };
}
```

4. `resolveDescriptor(toolName, sessionTools)`（Dispatcher 私有方法）兜底顺序：
   - registry / `sessionTools` 中按名取实例，`typeof tool.getDescriptor === 'function'` 则调用（覆盖未继承 `BaseTool` 的直接实现）；
   - 否则返回 `{ name: toolName, source: 'builtin', executor: 'server' }` 默认值（LOCAL 模式下大量桌面端工具无服务端实例，此兜底是常态路径）。

消费点——`shouldRequireApproval`（`tool-dispatcher.ts:174-198`）签名改为 `(descriptor, toolName, level, argumentsJson, modelConfig)`：

```ts
const isMcpTool = descriptor.source === 'mcp' || toolName.startsWith(MCP_TOOL_PREFIX);
```

`SERVER_ONLY_TOOLS` / `WRITE_TOOLS` 常量本阶段不动（它们语义是"必须在服务端执行/写操作"，与来源正交，迁入 descriptor 属演进项）。

### 4.2 ToolInvocation（调用层）

新文件 `harness/tool/tool-invocation.ts`：

```ts
export interface ToolInvocation {
  callId: string;
  toolName: string;
  argumentsJson: string;
  executionMode: string | null;
  sessionId: number | null;
  userId: number | null;
  executionUserId: number | null;
  workspace: string | null;
  permissionLevel: string | null;
  modelConfig: LlmModelConfig | null;
  sessionTools: Tool[] | null;
}
```

`callId` 与现有 `ToolCallContext`（`harness/tool/tool-call-context.ts`，AsyncLocal 传递，供 delegate/subagent 工具取用）冗余但显式化：Invocation 是跨层契约对象，不依赖隐式上下文。

Dispatcher 变更：

```ts
async dispatchInvocation(invocation: ToolInvocation): Promise<ToolResult> {
  const started = Date.now();
  try {
    const descriptor = this.resolveDescriptor(invocation.toolName, invocation.sessionTools);
    const raw = await this.dispatchFull(
      invocation.toolName, invocation.argumentsJson, invocation.executionMode,
      invocation.sessionId, invocation.userId, invocation.workspace,
      invocation.permissionLevel, invocation.modelConfig, invocation.sessionTools,
      invocation.executionUserId, descriptor,   // ← dispatchFull 末尾加一个显式参数，替代内部重猜
    );
    return normalizeToolResult(invocation.callId, raw, Date.now() - started);
  } catch (e) {
    return {
      callId: invocation.callId, status: 'error',
      content: 'Tool execution failed: ' + (e as Error).message,
      errorMessage: (e as Error).message, durationMs: Date.now() - started,
    };
  }
}

/** 兼容入口：生产代码停用，spec 与潜在外部调用继续可用 */
dispatch(toolName, argumentsJson, ...rest): Promise<string> | string {
  // 按原 arguments.length 分支组装 invocation（语义逐条镜像现实现），
  // 调 dispatchInvocation 后返回 .content
}
```

要点：

- `dispatchFull` 的全部分支逻辑（ask_user_questions 特例、SERVER_ONLY_TOOLS、LOCAL 审批/后台 Shell、CLOUD 通用路径）**逐行保留**，仅 `shouldRequireApproval` 改收 descriptor。
- `dispatchCloud`（`tool-dispatcher.ts:68-76`）等 2-3 参轻量路径同样组装 invocation 走新入口，保证 normalize 全覆盖。
- **异常语义变化**：现状 `AgentLoop.dispatchTool`（`agent-loop.ts:541-543`）catch 后拼字符串；新入口把异常归一为 `status:'error'` 的 ToolResult，`content` 保持与现字符串完全一致（模型上下文兼容），AgentLoop 不再自行 catch 语义化。

AgentLoop 变更（`agent-loop.ts:529-545`）：

```ts
private async dispatchTool(tc: ToolCall, context: AgentExecutionContext): Promise<ToolResult> {
  if (!this.isToolAllowed(toolName, context)) {
    return { callId: tc.id ?? '', status: 'error',
             content: `Tool execution failed: 工具 '${toolName}' 不在当前允许的工具集内，无法调用。`,
             errorMessage: 'tool not allowed' };
  }
  return this.toolDispatcher.dispatchInvocation({ callId: tc.id ?? '', toolName, argumentsJson, ...contextFields });
}
```

`executeToolCalls`（`:461-520`）中 `rawResult: string` 换为 `result: ToolResult`：

- `result.content` 继续喂 `processToolResult` / `toolResults[tc.id]` / `context.addToolResult` / `pendingToolSaves`（全部零改动，因为它们消费的就是字符串）；
- `listener.onToolCallResult(tc.id, result.content, toMeta(result))`。

### 4.3 ToolResult（结果层）

新文件 `harness/tool/tool-result.ts`：

```ts
export interface ToolResult {
  callId: string;
  status: 'success' | 'error';
  /** 给模型上下文与持久化的字符串，与现状逐字节一致 */
  content: string;
  errorMessage?: string;
  durationMs?: number;
}

/**
 * 执行层唯一的"错误启发式"落点：JSON 解析含 error 键即 error。
 * 规则与现 ws-streaming-event-listener.isErrorResult 完全一致，仅位置从
 * 展示层前移到执行层，判定结果全体下游共享，不再各层重复猜。
 */
export function normalizeToolResult(callId: string, raw: string, durationMs?: number): ToolResult
```

`normalizeToolResult` 规则（对齐 `isErrorResult` 现行为，保证无回归）：

1. `JSON.parse` 成功且为对象、含 `error` 键 → `status:'error'`，`errorMessage` 取 `error` 值（string 时），`content` 仍为原始 `raw`；
2. 其余（含解析失败、普通文本）→ `status:'success'`。

覆盖现有 error 形态产出点：`McpClientManager.callTool`（`mcp-client-manager.ts:48-53`）、`LocalToolExecutor.execute`（`local-tool-executor.ts:24,63,67`）、Dispatcher 各错误分支——它们返回的 `{"error":...}` 字符串无需改动即被正确归类。

### 4.4 事件层消费（WS）

`AgentEventListener`（`core/agent-event-listener.ts:7`）：

```ts
onToolCallResult(toolCallId: string, result: string,
                 meta?: { status: 'success' | 'error'; errorMessage?: string; durationMs?: number }): void;
```

可选第三参：`NoopAgentEventListener`、token-estimator/agent-loop 等 spec 中的 fake listener 均零改动。

`WsStreamingEventListener.onToolCallResult`（`ws-streaming-event-listener.ts:78-113`）：

- `isError` 判定改为 `meta?.status === 'error' || (meta == null && isErrorResult(displayResult))`；
- `recordActivity` 的 `isError`、事件 `data.status` 均用上述结果——**WS 事件字段与形状零变化**，只是 `status` 从"猜测"变为"事实"；
- `isErrorResult` 函数保留为 fallback（ Invocation 无 meta 的旧路径/防御），标注注释不再新增消费方。

### 4.5 改动文件清单

| 文件 | 改动 | 规模 |
|---|---|---|
| `harness/tool/tool-descriptor.ts` | 新增类型 | ~20 行 |
| `harness/tool/tool-invocation.ts` | 新增类型 | ~20 行 |
| `harness/tool/tool-result.ts` | 新增类型 + normalizeToolResult + spec | ~50 行 |
| `harness/tool/tool.ts` | `Tool` 加可选 `getDescriptor?`；`BaseTool` 默认实现 | ~10 行 |
| `harness/mcp/mcp-tool-adapter.ts` | override `getDescriptor` | ~10 行 |
| `harness/tool/tool-dispatcher.ts` | `dispatchInvocation`、`dispatch` 转发、`resolveDescriptor`、`shouldRequireApproval` 参数化、`dispatchFull` 尾参 | ~80 行 |
| `harness/core/agent-loop.ts` | `dispatchTool`/`executeToolCalls`/`processToolResult` 消费 ToolResult | ~40 行 |
| `harness/core/agent-event-listener.ts` | `onToolCallResult` 可选 meta | ~5 行 |
| `session/ws/ws-streaming-event-listener.ts` | meta 消费、isErrorResult 降级 fallback | ~15 行 |
| 其余 `harness/tool/impl/*.ts`、`harness/mcp/mcp-client-manager.ts`、`harness/local/*`、前端四端 | **零改动** | — |

## 五、测试计划

新增：

- `tool-result.spec.ts`：error JSON / 含 error 键的非字符串值 / 普通 JSON / 纯文本 / 非法 JSON 的归类；durationMs 透传。
- `tool-descriptor` 相关（并入 dispatcher spec）：BaseTool 默认 descriptor；McpToolAdapter CLOUD（`mcp-server`）/ LOCAL（`desktop`）executor；无 descriptor 实例与无实例（LOCAL 桌面工具）兜底。
- `tool-dispatcher.spec.ts` 增补：`dispatchInvocation` 与旧 `dispatch` 对同一用例结果逐条镜像（现有 18 处 dispatch 用例参数化复用）；LOCAL MCP 审批判定改由 descriptor 驱动后 READ_ONLY/READ_WRITE/SMART/FULL 行为不变；异常 → `status:'error'` 且 content 与旧字符串一致。
- `agent-loop.spec.ts` 增补：listener 收到 meta 且与 dispatch 结果一致；tool not allowed → error ToolResult。
- `ws-streaming-event-listener.spec.ts` 增补：有 meta 时事件 status 取 meta；无 meta 时回退 isErrorResult（行为不变）。

回归：`cd backend-ts && npm test` 全量；现有 `tool-dispatcher.spec.ts`、`agent-loop.spec.ts`、`ws-streaming-event-listener.spec.ts` 用例**零修改通过**是本方案"行为等价"的硬验收标准。

## 六、实施顺序

1. **类型与 descriptor**：`tool-descriptor.ts` / `tool-invocation.ts` / `tool-result.ts` + `BaseTool`/`McpToolAdapter` 实现 + 独立 spec（零行为变化，先行合入）。
2. **新执行入口**：`dispatchInvocation` + `dispatch` 转发 + `shouldRequireApproval` descriptor 化 + dispatcher/agent-loop spec（行为等价）。
3. **结果结构化贯通**：AgentLoop/Listener meta 消费（行为增量：`status` 判定来源前移）。
4. **收尾**：`isErrorResult`、`MCP_TOOL_PREFIX` 判定处标注 "fallback, do not add new consumers"；根 CHANGELOG 如无用户可见行为变化则不记。

每步独立可合入、可回滚，任一步失败不影响前三步已落地价值。

## 七、风险与应对

| 风险 | 应对 |
|---|---|
| `dispatch()` 旧参数分支语义在转发时遗漏（10 参重载历史复杂） | 转发逻辑逐分支镜像现实现；现有 dispatch spec 全量保留作为等价性回归；两入口对拍用例写进 spec |
| 工具合法结果恰好含 `error` 键被误判为失败 | 归类规则与现 WS 层 `isErrorResult` 完全一致，线上行为无变化；如确有此形态工具，本就已在前端被误标，属既有问题非本次引入 |
| 直接 `implements Tool` 而未继承 `BaseTool` 的实现缺 descriptor | `resolveDescriptor` 兜底默认 builtin；`getDescriptor` 为可选方法，编译期不强制 |
| `onToolCallResult` 加参影响其他 listener 实现 | 第三参可选，TS 层面兼容；现存实现（Noop、WS listener、spec fakes）全部核对过 |
| 并行工具调用下的 durationMs 计时 | 每个 `runOne` 独立包裹计时（`executeToolCalls` 并行批量场景天然隔离），无共享状态 |
| MCP CLOUD/LOCAL executor 判断依赖 `clientManager == null` 隐式约定 | 在 `McpToolAdapter.getDescriptor` 处注释显式化该约定；若未来注入方式变化此处是唯一修改点 |

## 八、后续演进（本期不实施）

1. **ToolResult 全量结构化**：`structuredContent` / `attachments`（图片、diff、文件变更、后台任务句柄）——需同步设计 DB `metadataJson` 双格式兼容与前端断线重放，单独立项。
2. **常量集合迁入 descriptor**：`SERVER_ONLY_TOOLS`、`WRITE_TOOLS` 改为 descriptor `executor` / policy 字段推导，消除名称集合与工具实现的两处维护。
3. **移除字符串约定 fallback**：观察一个版本后删除 `isErrorResult` 与 `mcp__` 前缀判定。
4. **admin 工具治理**：管理后台基于 descriptor 展示工具来源/执行器清单（需 descriptor 汇聚接口，当前无消费方不做）。
5. **取消信号贯通**：`ToolInvocation` 增加 `signal?: AbortSignal`，打通 LLM 层取消与工具执行中断（现有 `AtomicBoolean` 轮询机制保留）。
