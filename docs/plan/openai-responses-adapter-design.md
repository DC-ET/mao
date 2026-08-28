# OpenAI Responses API 适配设计（openai-responses）

状态：已实现（2026-08-29）。本文档记录 `ResponsesLlmAdapter` 的关键协议语义与 Mao 侧映射决策。

## 一、总体

| 项 | 决策 |
|---|---|
| 端点 | `{baseUrl 去尾斜杠}/responses`（baseUrl 含 `/v1`，与 ChatCompletions/Anthropic 约定一致） |
| 认证 | `Authorization: Bearer {apiKey}`，`clientImpersonation` 头注入沿用 |
| 骨架 | 复制自 OpenAiLlmAdapter：重试循环、Retry-After、取消轮询、响应头超时、流 idle 超时、错误分类。`isRetryableNetworkFailure` 中 EOF 判据改为 `stream ended before response.completed` |
| 统一类型 | 输入输出均为 OpenAI Chat 形状（`ChatRequest`/`ChatResponse`/`StreamChunk`），上层（AgentLoop/CompactionService/连通性测试）零改动 |
| max_output_tokens | `RESPONSES_MAX_OUTPUT_TOKENS = 32768`（常量，不落库）。Responses 的该参数**含 reasoning token**，推理模型需预留思考预算，故大于 Anthropic 的 16384 |
| instructions | 首条（连续多条合并，`\n\n` 连接）→ 顶层 `instructions` 参数；中途 system 防御性降级为 user 文本 |

## 二、请求转换（convertMessages）

| Mao/Chat 形状 | Responses input item |
|---|---|
| 首条 system | 顶层 `instructions`（多条合并） |
| 中途 system | `{role:'user', content:[{type:'input_text'}]}`（防御降级） |
| user `content: string` | `{role:'user', content:[{type:'input_text', text}]}` |
| user `image_url`（data URL） | `{type:'input_image', image_url}`（仅 `supportsVision` 模型发送，否则占位符替换；与另两协议同逻辑） |
| assistant 文本 | `{role:'assistant', content:[{type:'output_text', text}]}` |
| assistant `toolCalls[i]` | `{type:'function_call', id, call_id, name, arguments}`（逐个平铺；`call_id` 为主键） |
| tool 消息 | `{type:'function_call_output', call_id, output}` |
| assistant `toolCalls[0].reasoning` | `{type:'reasoning', id, encrypted_content, summary:[]}`（见 §三） |

关键顺序约束（网关校验）：

1. **function_call 与 function_call_output 之间不得插入其他 item 类型**：连续 tool 消息先缓冲，遇到下一条非 tool 消息时统一冲刷输出（并行多工具也全部集中）。
2. **reasoning 项后必须紧跟 assistant 消息或 function_call**：reasoning 项插入本轮 assistant 内容（文本/function_call）之前；纯 reasoning 轮（无文本无 call）补一条空格 assistant 消息。
3. 无配对 call_id 的 tool 消息无法映射为 function_call_output，降级为 user 文本（正常历史经 message-history-normalizer 不会出现）。

请求体固定字段：`store:false`（无状态多轮，Mao 自管历史）、`include:['reasoning.encrypted_content']`（仅当历史存在 reasoning 引用；与 `previous_response_id` 互斥，Mao 不使用后者；空历史时下发 `[]`）、`stream`、`temperature`、`reasoning:{effort}`（PromptEngine 对 gpt-* 前缀注入 `{effort:'high'}`，Responses 网关模型同名前缀自然命中）。

## 三、reasoning 往返（stateless 思维链保持）

**问题**：Responses 网关在多轮 function calling 中要求：回传 `function_call` 项时必须携带**同轮的 reasoning 项**（`Item 'rs_xx' … provided without its required following item` / `function_call was provided without its required reasoning item` 类 400）。且 `store:false` 下 reasoning 上下文只能靠 `encrypted_content` 密文回传，须 `include:['reasoning.encrypted_content']` 换取。

**Mao 方案**（利用既有持久化，无 DB 迁移）：

- 响应侧：`output` 中的 `reasoning` 项（id + encrypted_content）在**有 function_call 的轮**挂到 `toolCalls[0].reasoning`（`ReasoningItemRef`，`chat-request.ts` 新增可选字段）；纯文本轮不挂（reasoning 项后紧跟 assistant message 亦合法，但纯文本轮无回传必要性的场景占多数，且避免污染普通展示数据）。
- 持久化侧：`ToolCall.reasoning` 随 `tool_calls` JSON 列入库（JSON 列容量足够，MEDIUMTEXT 更无虞）；崩溃恢复/compaction 重载时 `session-history-loader.toChatMessage` 还原 `reasoningContent` 的路径保留—— Responses 轮的 `thinking_content` 存的是 `__mao_responses_reasoning__:{json}` 前缀的引用 blob（`REASONING_REF_PREFIX`），`extractReasoningRef` 解析还原。恢复后本轮 toolCalls 已含 `reasoning` 字段（toolCall 优先），blob 仅兜底。
- 请求侧：见 §二，reasoning 项 + assistant 文本 + function_call 按序回传。
- **展示隔离**：适配器流式回调不下发 reasoning summary delta 的 `reasoningContent`？——下发。前端 thinking 面板展示的是 summary 摘要文本（网关不下发原文 reasoning content，summary 是官方唯一的可读输出）；`onStreamReset` 重试时上层已有清空逻辑。
- **其他协议隔离**：`reasoning` 字段仅 Responses 适配器写入/读取；`serializeChatMessage` 的 `reasoning_content` 透传对 ChatCompletions 模型不变（DeepSeek 链路），Responses 的 blob 前缀不会被其他适配器解析，无串扰。

## 四、流式事件映射

| Responses SSE 事件 | 输出 |
|---|---|
| `response.output_text.delta` | `onChunk`（`delta.content`） |
| `response.reasoning_summary_text.delta` | `onChunk`（`delta.reasoningContent`，复用 thinking 展示/持久化链路） |
| `response.output_item.added`（function_call） | `onChunk`（`delta.toolCalls` id/function.name，聚合键为 **call_id**，缺失退回 item.id/`__idx_{output_index}`） |
| `response.function_call_arguments.delta` | `onChunk`（`delta.toolCalls` function.arguments 增量；item_id 经映射表转回 call_id 键） |
| `response.output_item.done`（function_call） | 仅当该键**未收到过 arguments.delta** 时下发完整参数（兼容不增量下发 arguments 的网关；重复下发会被 AgentLoop 拼接两遍） |
| `response.completed` | 终态：usage（`input_tokens`/`output_tokens`/`total_tokens`/`input_tokens_details.cached_tokens`）+ status |
| `response.incomplete` | 终态：`incomplete_details.reason=max_output_tokens` → finishReason=length |
| `response.failed` / `error` | `StreamErrorEventException`（error.code → statusCode，限流/5xx 可重试） |

- 终态判定：Responses SSE 无 `[DONE]`，`response.completed`/`response.incomplete` 即收流完成；两者均未出现视为流被截断（有输出 → `StreamInterruptedAfterOutputException` 禁止自动重试，无输出 → EOF 可重试）。
- **思考截断**：`length`（incomplete/max_output_tokens）且无 content/toolCalls → `StreamThinkingTruncatedException`，整轮流重试并 `onStreamReset`（对齐另两协议）。
- finishReason 映射：`completed → stop`、`incomplete → length`。

## 五、非流式响应（parseResponsesChatResponse）

`output` 数组遍历：`message` 项拼接 `output_text`；`function_call` 项转 `ToolCall`（**call_id 优先作为 id**，工具结果回传靠它配对）；`reasoning` 项挂到首个 toolCall（若有）。`status`/`incomplete_details` → finishReason；usage 见 §四。

## 六、连通性测试与接线

- `model/responses-chat.client.ts`：`LlmChatClient` 实现，`store:false` + `include:[]` + `max_output_tokens=32768` 非流式探测，消息转换复用主 Adapter 的 `convertMessages`。
- `create-app.ts`：`llmChatClients` Map 注册 `openai-responses → ResponsesChatClient`；`LlmAdapterFacade` delegates 注册 `openai-responses → ResponsesLlmAdapter`。
- mid-system 探测对 `openai-responses` 跳过（Responses 无中途 system 语义）。
- 写入口白名单放开 `openai-responses`；admin 下拉启用该选项。

## 七、明确不做 / 已知边界

| 项 | 说明 |
|---|---|
| `previous_response_id` | 不使用（与 Mao 自管历史冲突；`include` 加密往返是 stateless 正道） |
| reasoning signature 持久化 | Responses 无签名问题（密文自带完整性），无需 Anthropic 式 signature 设计 |
| 内置工具（web_search/code_interpreter 等） | 不使用，仅 function 工具 |
| 纯文本轮的 reasoning 引用 | 不挂 toolCall、不持久化引用（blob 前缀除外），网关对纯文本轮回传 reasoning 不做强校验 |
| 多 responses 轮共享 reasoning | 每轮 reasoning 独立挂靠该轮 toolCalls；网关按 `function_call → 所在轮 reasoning` 配对 |
| `__idx_` 兜底键 | 网关不下发 call_id/item_id 时 tool 结果回传可能无法配对（极罕见），属可接受降级 |
