# LLM 多协议 Provider Adapter（Anthropic Messages / OpenAI Responses）— 技术方案

> 状态：待评审
> 日期：2026-08-28
> 范围：backend-ts（`harness/llm/`、`model/`）+ admin 模型表单小改；不涉及 desktop / android / agent-cli / mao-cli
> 背景：基于《Mao-Provider-Adapter 改造评估报告》的结论，由"接入仅提供 Anthropic Messages API 的渠道"这一真实需求触发

## 一、需求背景

### 1.1 现状

- Mao 的 `LlmAdapter` 接口（`backend-ts/src/harness/llm/chat-request.ts:154-168`）定义了 `chat` / `stream` 两个统一入口，`AgentLoop` 仅依赖该接口（`backend-ts/src/harness/core/agent-loop.ts:56-57`），与具体传输已解耦。
- 全局唯一实现是 `OpenAiLlmAdapter`（`backend-ts/src/harness/llm/openai-llm-adapter.ts:70`，共 742 行），在 `create-app.ts:493` 直接实例化注入；统一请求/响应类型（`ChatRequest`/`ChatResponse`/`StreamChunk`/`ChatUsage`）以 OpenAI Chat Completions 形状为中心。
- 模型表已有 `provider` 字段（`backend-ts/src/model/types.ts:6`），但只是元数据，不参与运行时路由。
- 供应商相关逻辑已开始泄漏：`prompt-engine.ts:347` 按 `modelId` 前缀判断是否注入 `reasoning.effort`；`llm/json.ts:61-63`、`session-history-loader.ts:61` 处理 DeepSeek 的 `reasoning_content` 回传怪癖。
- 管理后台连通性测试走独立实现 `OpenAiChatClient`（`backend-ts/src/model/llm-chat.client.ts`，硬编码 `/chat/completions`），不经 `LlmAdapter`。
- admin 模型表单的「供应商」是自由文本框（`ModelFormDialog.vue:28`），列表筛选选项动态从 DB 拉取，后端无白名单校验。

### 1.2 触发需求

1. 接入一个**仅提供 Anthropic Messages API** 的 LLM 渠道（无 Chat Completions 兼容端点）。
2. 未来将接入 **OpenAI Responses API**。
3. 协议种类收敛为三种：OpenAI Chat Completions（现有）、Anthropic Messages（本次）、OpenAI Responses（预留）。

### 1.3 为什么不做协议网关

可在外部架协议网关（LiteLLM/one-api）将 Anthropic 转成 Chat Completions，Mao 零改动。但网关需双向转换 tool/thinking 格式，多轮工具循环容易翻车，且多一个自维护故障点。适合临时验证渠道，不作为正式方案。

## 二、需求描述

### 2.1 目标

将 `OpenAiLlmAdapter` 从"全局唯一实现"降级为"`provider` 路由的默认分支"，新增 Anthropic Messages 实现，协议差异全部在 Adapter 内消化。**AgentLoop、ToolDispatcher、WebSocket 协议、前端四端零改动。**

### 明确要做

| # | 事项 |
|---|------|
| 1 | 新增 `LlmAdapterFacade`：实现 `LlmAdapter` 接口，按 `LlmModelConfig.apiProtocol` 路由到具体 Adapter，未匹配值回落 OpenAI 兼容实现 |
| 2 | 新增 `AnthropicLlmAdapter`：完整实现 Messages API 的非流式 + 流式调用，含重试/退避/取消/超时，行为对齐现有 OpenAI 实现 |
| 3 | `create-app.ts` 改为组装 Facade 并注入；`weixin/voice-synthesis.service.ts` 依赖类型改为 `LlmAdapter` 接口 |
| 4 | 新增 `AnthropicChatClient`（连通性测试用），`ModelService.testConnectivity` 按 apiProtocol 选择客户端 |
| 5 | 新增 `api_protocol` DB 列承载协议路由；admin 模型表单「供应商」保持渠道名文本框，新增「API 协议」下拉（OpenAI 兼容 / `anthropic` / `openai-responses` 预留） |
| 6 | 新增 `anthropic-llm-adapter.spec.ts`、`llm-adapter-facade.spec.ts`，现有测试全量回归 |
| 7 | 根 CHANGELOG.md 记录本次用户可见变更（新协议支持） |

### 明确不做

| # | 事项 |
|---|------|
| 1 | 不引入 ProviderCapabilities 能力矩阵、不做 Provider 抽象框架（三种协议皆为已知，无需泛化） |
| 2 | 不改统一类型 `ChatRequest`/`StreamChunk`/`ChatUsage`/`LlmAdapter`，不新增 DB 列、不做存量数据迁移 |
| 3 | 不动 AgentLoop / ToolDispatcher / PromptEngine / ContextManager / WebSocket 协议 / 四端任何代码 |
| 4 | 不启用 Anthropic extended thinking 主动开启（`thinking` 请求参数），签名（signature）回传问题不在本期解决 |
| 5 | 不实现 OpenAI Responses API（仅预留 `openai-responses` 协议 code） |
| 6 | 不对 `provider` 做白名单强校验，不迁移存量 provider 值 |
| 7 | 不引入任何 LLM SDK 依赖，继续使用 Node 原生 http/https（与现有实现一致） |
| 8 | 不做 LOCAL 模式适配、不做第二套工具执行循环 |
| 9 | 语音 / 文生图模型不支持配置 anthropic 协议（这两类模型继续走 OpenAI 兼容） |

### 决策共识记录

| 决策点 | 结论 |
|--------|------|
| 路由键 | 独立新增 `api_protocol` 字段承载协议路由（小写：`anthropic` / `openai-responses` / `openai-compatible`，空 = openai-compatible）；`provider` 保持渠道名语义（展示/分组），**不参与路由**。**修订（2026-08-28）**：初版曾把 `provider` 升级为协议 code，因用户以 provider 存放渠道名、无法区分模型来源，改为字段拆分方案 |
| 存量兼容 | 路由前对 apiProtocol 做 `trim + toLowerCase`；未命中或为空一律回落 openai-compatible，存量模型协议为空行为不变，无需数据迁移 |
| 校验策略 | 写入口（POST/PUT /models）对 apiProtocol 白名单校验（空 / `openai-compatible` / `anthropic`；`openai-responses` 无实现，写入口暂拒绝以避免"写入了但运行时静默回落错误协议"，真实接入时放开），非法值返回 PARAM_INVALID；运行时路由对未知值仍静默回落默认实现 |
| 骨架复用方式 | 复制而非抽基类：HTTP/重试/取消骨架从 OpenAiLlmAdapter 复制到新 Adapter，现有 742 行与其测试零改动；将来接第三个协议时再评估合并 |
| max_tokens（Anthropic 必填） | Adapter 内常量默认 16384，不落库 |
| thinking | 不主动开启；响应中若出现 thinking block 则解析为 `reasoningContent` 兼容 |
| 认证头 | 同时携带 `x-api-key` 与 `Authorization: Bearer`（同值），兼容官方与网关类渠道 |
| Responses API | 已实现（0.0.67）：`ResponsesLlmAdapter` + `ResponsesChatClient`，写入口白名单与 admin 下拉已放开 `openai-responses`。详见 `docs/plan/openai-responses-adapter-design.md` |
| 展示名 | **修订（2026-08-28）**：初版"供应商展示与协议 code 合一"决策作废。`provider` 保持渠道名自由文本（如 "OpenAI"、"Anthropic"、渠道商名），协议由独立的「API 协议」下拉承载 |

## 三、总体设计

```text
AgentLoop（零改动，仍依赖 LlmAdapter 接口）
        │
LlmAdapterFacade implements LlmAdapter          ← 新增，~30 行
        │ 按 provider 路由
        ├── 'anthropic'           → AnthropicLlmAdapter      ← 新增
        ├── 'openai-responses'    → （预留，暂无实现 → 回落）
        └── 其他/空/'openai-compatible' → OpenAiLlmAdapter    ← 现有，零改动
```

边界原则（承接评估报告 §4.3）：

- Adapter 负责：认证注入、URL/协议差异、请求体构造、system/工具/thinking 格式转换、SSE 事件解析、stop_reason 与 usage 归一、错误分类重试、取消。
- Adapter 不负责：Agent Loop、上下文压缩、工具权限与执行、会话持久化、WebSocket 推送、审批。

统一类型保持 OpenAI 形状不变——Anthropic 的差异（system 顶层参数、content blocks、tool_use/tool_result、事件流）全部在 Adapter 内双向转换，上层无感知。

## 四、详细设计

### 4.1 apiProtocol 路由约定（Facade）

`backend-ts/src/harness/llm/llm-adapter-facade.ts`（新增）：

```ts
export class LlmAdapterFacade implements LlmAdapter {
  constructor(
    private readonly delegates: Map<string, LlmAdapter>,
    private readonly fallback: LlmAdapter,
  ) {}

  private pick(config: LlmModelConfig): LlmAdapter {
    const code = config.apiProtocol?.trim().toLowerCase();
    return (code != null && this.delegates.get(code)) || this.fallback;
  }

  chat(request, config, cancelFlag?, callback?) { return this.pick(config).chat(request, config, cancelFlag, callback); }
  stream(request, config, callback, cancelFlag?) { return this.pick(config).stream(request, config, callback, cancelFlag); }
}
```

- 路由对 apiProtocol 做 `trim + toLowerCase`，防止手填 `Anthropic` 不命中；`provider` 是渠道展示名，不参与路由。
- `create-app.ts` 组装：`new LlmAdapterFacade(new Map([['anthropic', anthropicAdapter]]), openAiAdapter)`，注入点（`create-app.ts:493`）与 AgentLoop 构造签名不变。
- `weixin/voice-synthesis.service.ts:36` 的依赖类型 `OpenAiLlmAdapter` 改为 `LlmAdapter`（语音模型协议不会是 anthropic，行为不变）。

### 4.2 AnthropicLlmAdapter

新文件 `backend-ts/src/harness/llm/anthropic-llm-adapter.ts`（预计 ~500 行），端点为 `{baseUrl 去尾斜杠}/messages`（对齐现有约定：baseUrl 含 `/v1`，如 `https://api.anthropic.com/v1`）。

#### 4.2.1 协议无关骨架（从 OpenAiLlmAdapter 复制，逻辑不变）

`chat()` / `stream()` 重试循环、`awaitResponse()`（原生 http/https、响应头超时、idle 超时、cancelFlag 轮询）、`resolveRetryDelaySeconds`（Retry-After）、`isRetryableNetworkFailure`、`networkReason`、`cancelledException`、`isCancelled`、`isRetryableStatus`（429/5xx）、`readErrorBody`、`StreamInterruptedAfterOutputException`/`StreamThinkingTruncatedException`/`StreamErrorEventException` 异常类、空响应耗尽（`EmptyResponseExhaustedException` 语义）。

#### 4.2.2 请求转换（OpenAI 形状 → Messages API）

| OpenAI 形状（`ChatRequest`） | Anthropic Messages |
|---|---|
| `messages[0].role === 'system'` | 拆出拼接为顶层 `system` 参数（多段以 `\n\n` 连接） |
| 非首条 system 消息（防御） | 降级为 user 文本消息（Anthropic 禁止中途 system） |
| user `content: string` | `{role:'user', content:[{type:'text', text}]}` |
| `content` 中 `image_url`（data URL） | `{type:'image', source:{type:'base64', media_type, data}}`（仅 `supportsVision` 模型发送，否则沿用现有占位符替换逻辑） |
| assistant `toolCalls: [{id, function:{name, arguments}}]` | `{type:'tool_use', id, name, input: JSON.parse(arguments)}` |
| `role:'tool'` 消息（`toolCallId` + content） | 合并为 user 消息中的 `{type:'tool_result', tool_use_id, content:[{type:'text', text}]}` |
| `tools: [{type:'function', function:{name, description, parameters}}]` | `{name, description, input_schema: parameters}` |
| `temperature` | `temperature` |
| — | `max_tokens: 16384`（常量默认） |

**消息合并规则（关键）**：Anthropic 要求相邻消息 role 交替，且 `tool_result` 必须位于 user 消息 block 序列**最前**。转换时遍历消息序列：

1. 连续多条 `role:'tool'` 消息 → 合并为**一条** user 消息：全部 `tool_result` block 集中在前段（顺序不变），tool 消息携带的图片等其余 block 追加在后段（`tool_result` 之后的 image/text 块是官方允许的）；
2. `tool` 消息后紧跟的 user 消息 → 并入同一条 user 消息（`tool_result` 在前、文本在后）；
3. 连续 assistant 消息 → 合并为一条 assistant 消息（text 与 tool_use block 顺序按原序保留）；
4. assistant `toolCalls` 中缺失 `function.name` 的项不跳过（跳过会产生悬空 `tool_result` 导致 400），兜底为空名占位 `tool_use`。

#### 4.2.3 流式响应转换（Messages SSE → `StreamCallback`）

| Anthropic SSE 事件 | 输出 |
|---|---|
| `message_start`（含 usage.input_tokens，可含 cache_read_input_tokens） | 记录输入 usage |
| `content_block_start`（type=text / thinking / tool_use） | 标记当前 block 类型；tool_use 时回调 `tool_call_start`（映射出 OpenAI 形状的 `{index, id, function:{name}}`） |
| `content_block_delta` — `text_delta` | `onChunk`（`choices[0].delta.content` 形状） |
| `content_block_delta` — `thinking_delta` | `onChunk`（`delta.reasoningContent` 形状，复用现有 thinking 聚合/展示/持久化链路） |
| `content_block_delta` — `input_json_delta` | 累积为 tool arguments 分片（`delta.toolCalls` 形状） |
| `message_delta`（stop_reason + output_tokens） | 记录 finishReason 与输出 usage |
| `message_stop` | 组装 `ChatUsage` 回调 `onComplete` |
| `error` 事件 | 抛 `StreamErrorEventException`（复用可重试判定） |

usage 归一：`promptTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`（Anthropic 的 `input_tokens` 不含缓存部分，与 OpenAI `prompt_tokens` 全量口径对齐）、`completionTokens = output_tokens`、`promptTokensDetails.cachedTokens = cache_read_input_tokens`、`totalTokens = prompt + completion`。流式事件中 `message_start` 与 `message_delta` 的 usage 按字段级"有值即覆盖"合并（兼容部分网关仅在 `message_delta` 下发真实值的场景），流结束后统一折算。

stop_reason 映射：`end_turn → stop`、`tool_use → tool_calls`、`max_tokens → length`、`stop_sequence → stop`。

#### 4.2.4 认证与 thinking

- 请求头：`x-api-key`、`Authorization: Bearer {apiKey}`、`anthropic-version: 2023-06-01`、`Content-Type`。`clientImpersonation` 头注入逻辑沿用（anthropic 模型一般配 `none`）。
- 不发送 `thinking` 参数；响应中若出现 thinking block（网关默认开启的场景）按 4.2.3 解析为 `reasoningContent`。
- **注意**：启用 extended thinking 后，多轮请求中带 `tool_use` 的 assistant 消息必须回传含有效 `signature` 的 thinking block，而 Mao 持久化的 `reasoningContent` 无签名。因此主动开启 thinking 需先设计 signature 持久化，见 §八。

### 4.3 连通性测试链路

`ModelService.testConnectivity`（`model.service.ts:190-220`）当前经 `OpenAiChatClient` 硬编码调 `/chat/completions`，Anthropic 模型会误报失败。改造：

- 新增 `backend-ts/src/model/anthropic-chat.client.ts`（~80 行）：实现 `LlmChatClient` 接口，仅非流式 `chat`，POST `{baseUrl}/messages`，解析首个 `text` block 返回。头部复用 §4.2.4。
- `ModelService` 按 `config.apiProtocol`（trim+lowercase）选择客户端：`anthropic` → AnthropicChatClient，否则现有 OpenAiChatClient。
- mid-system-message 检测：对 anthropic 协议跳过（Anthropic 不支持中途 system，测试无意义），结果标记为不适用而非失败。
- audio/voice 测试分支不受影响（语音模型不配 anthropic）。

### 4.4 admin 表单

`ModelFormDialog.vue`「供应商」保持 `el-input` 渠道名自由文本（例如: OpenAI, Anthropic）；其下新增「API 协议」`el-select`：空值（OpenAI 兼容）/ `anthropic` / `openai-responses`（后者标注"规划中"置灰）。列表筛选（`ModelListView.vue:39`）基于 provider 渠道名动态从 DB 拉取，无需改动。

### 4.5 接线点清单

| 文件 | 改动 |
|---|---|
| `create-app.ts:111-114、493` | import Facade 与新 Adapter；实例化并注入 |
| `weixin/voice-synthesis.service.ts:36` | 依赖类型改 `LlmAdapter` |
| `model/model.service.ts` | 注入两个 ChatClient，testConnectivity 按协议路由 + mid-system 跳过 |
| `feishu/group-context-summarizer.ts` | 溢出摘要 LLM 调用同样按 apiProtocol 协议路由（构造参数改为 `(config) => client` 路由函数，模型解析补传 `apiProtocol`），避免 anthropic 默认/会话模型时摘要静默失效 |
| `admin/src/views/model/ModelFormDialog.vue` | 供应商保持文本框，新增 API 协议下拉 |
| 根 `CHANGELOG.md` | 顶部新版本记录 |

## 五、测试计划

新增（沿用现有 QueueServer 本地回放模式，见 `openai-llm-adapter.spec.ts`）：

- `anthropic-llm-adapter.spec.ts`：非流式响应解析；流式文本；thinking_delta；单/多工具调用；input_json_delta 分片合并；请求体断言（system 拆分、tool_use/tool_result 转换、连续 tool 消息合并、max_tokens、双认证头）；stop_reason 与 usage（含 cache）映射；429/5xx 重试与 Retry-After；error 事件；流中断；取消；空响应耗尽；非首条 system 降级；vision 图片转换。
- `llm-adapter-facade.spec.ts`：大小写/空白归一路由；未知与空 apiProtocol 回落；provider 渠道名不参与路由；chat/stream 均透传。
- `model` 层：anthropic 模型连通性测试走新客户端；mid-system 跳过。

回归：`cd backend-ts && npm test` 全量（现有 openai-llm-adapter.spec.ts、agent-loop.spec.ts、ws-streaming-event-listener.spec.ts 零改动通过）。

验收（真实渠道联调）：正常对话、thinking 展示、MCP/内置工具多轮循环、上下文压缩后继续、限流重试、中途取消、usage 入库、WebSocket 客户端无任何 provider 特判。

## 六、实施顺序

1. `LlmAdapterFacade` + `create-app.ts`/weixin 接线 + Facade 单测（行为零变化，先行合入）
2. `AnthropicLlmAdapter` + 完整 spec
3. `AnthropicChatClient` + 连通性测试路由 + model 层测试
4. admin 表单：供应商保持文本框，新增 API 协议下拉
5. 真实渠道端到端联调（§五验收清单）
6. CHANGELOG 发版记录

## 七、风险与应对

| 风险 | 应对 |
|---|---|
| 网关类"Anthropic 兼容"渠道在路径/认证头上的差异 | 双认证头同发；路径 `/messages` 与 baseUrl 约定（含 `/v1`）与现有 OpenAI 链路一致，必要时联调阶段按渠道微调 |
| tool_result 合并规则覆盖不全导致多轮循环 400 | spec 对合并规则做请求体级断言；联调覆盖多轮工具 + 压缩后恢复场景 |
| 消息交替校验在其他场景（如编辑重发历史）出现连续同 role | 转换层统一做同 role 合并（§4.2.2 规则 3），不依赖上游保证 |
| max_tokens 16384 对个别模型过小 | 第一版常量；出现截断投诉后再考虑模型级配置（不预留） |
| Facade 路由后 audio/image 模型误配 anthropic | 不加校验，误配时请求自然失败并在连通性测试暴露；文档与表单选项引导规避 |

## 八、后续演进（本期不实施）

1. **OpenAI Responses API**：协议 code `openai-responses` 已预留，接入时按 §4.2 模式新增 Adapter，仅需请求体构造与 SSE 事件映射两块协议层实现。
2. **Anthropic extended thinking**：需持久化 thinking block 的 `signature` 并在多轮请求回传，涉及 `session` 表与历史恢复链路，单独立项。
3. **能力声明**：若未来协议/模型数量增长导致 `isGptModel`（`prompt-engine.ts:347`）类前缀判断扩散，再引入 `ProviderCapabilities` 由 Adapter 声明能力，替换名称猜测。
4. **骨架合并**：第三个协议落地时，重试/HTTP 骨架已存在 OpenAI/Anthropic 两份副本，抽取共享基类；同时把 `provider` 路由逻辑（trim+lowercase+回落）收敛为单一共享工厂——当前存在 `LlmAdapterFacade.pick`、`ModelService.chatClientFor`、`create-app.routeChatClient` 三处手写副本（第 2 轮 code review N-2），接入 `openai-responses` 前必须先收敛，避免多协议时遗漏同步。
