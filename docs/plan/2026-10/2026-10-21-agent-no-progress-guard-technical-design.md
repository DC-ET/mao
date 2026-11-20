# Agent 无进展工具循环止损（方案 1）技术方案

- 状态：技术方案，已按 2026-10-21 评审补齐，待实施
- 评审结论：需求可行；原方案的 `shell` 结果漏报、长等待误杀、图片摘要、guard/压缩状态不同步等阻断项已在本版补齐。
- 日期：2026-10-21
- 评审记录：本版补齐了 shell 结果归一化、长等待调用豁免、图片结果摘要、guard 与历史重放的状态同步、接线顺序与安全日志等缺口；补齐项见 §4.2 / §4.3 / §4.4 / §4.6 / §4.7 / §6 / §7。
- 需求来源：主会话 2210「补充飞书机器人文档」死循环排查结论（同模型在 2207 复现）
- 范围：仅后端 Agent 循环内的「无进展」检测、提醒与中止；**不做**单轮最大轮次上限、**不做**模型切换/降级（需求方明确排除方案 2、3）
- 关联代码（当前 `main`，2026-10-21）：
  - `backend-ts/src/harness/core/agent-loop.ts`（执行循环，`while (true)` 在 177 行，工具轮收尾在 430-476 行）
  - `backend-ts/src/harness/core/no-progress-notice.ts`（新增：签名、扫描、渲染、按工具归一化）
  - `backend-ts/src/harness/core/no-progress-guard.ts`（新增：运行时状态机与终止异常）
  - `backend-ts/src/harness/core/agent-execution-context.ts`（新增 `noProgressNotices` / `noProgressTail`）
  - `backend-ts/src/harness/core/session-history-loader.ts`（`applyHistory` 重算提醒锚点与尾部状态）
  - `backend-ts/src/harness/core/prompt-engine.ts`（`buildRequest` 渲染提醒）
  - `backend-ts/src/harness/core/session-date-notice.ts`（同类模式参照：渲染期按持久化事实重算）
  - `backend-ts/src/harness/core/agent-event-listener.ts`（轮次与错误事件，本次不改接口）
  - `backend-ts/src/session/util/tool-result-summarizer.ts`（工具结果摘要，本次只复用口径，不改实现）
  - `backend-ts/src/session/ws/streaming-ws-handler.ts`（桌面/Web 执行入口与 FAILED 收尾，733 行；边路 1151 行）
  - `backend-ts/src/feishu/agent-inbound-handler.ts`（飞书入口 catch → 卡片失败文案，961 行 `feishuFailureText`）
  - `backend-ts/src/dingtalk/runtime.ts`（钉钉入口 `onExecutionFinished`，316 行）
  - `backend-ts/src/harness/delegate/background-subagent-manager.ts`（子代理 error → `后台子代理执行失败: …`，761 / 788 行）
  - `backend-ts/src/harness/delegate/subagent-visibility-service.ts`（catch 中显式 `composite.onError(e)`，183 行）

## 1. 背景

### 1.1 事故数据

会话 2210 只有 1 条用户消息，却产生了 440 轮执行：

| 指标 | 数值 |
|---|---|
| 执行区间 | 18:18:47 → 18:39:15（约 20.5 分钟） |
| 循环区间 | 18:20:24 → 18:39:15（约 19 分钟） |
| assistant / tool 消息 | 439 / 451 |
| LLM 调用 | 441 次（440 次 agent 调用与 440 轮 1:1，另 1 次标题生成） |
| prompt tokens | 约 2,912 万（缓存命中约 2,833 万） |
| 重复调用 | 416 次完全相同的 `grep_search`（`path=backend-ts/src/feishu`，`pattern=群名`） |
| 终止方式 | 用户手动取消（`Agent loop round 440 cancelled by user`），会话 `CANCELLED` |

同模型（`stepfun / step-5-preview`）会话 2207 复现同一形态：144 次完全相同的 `shell` 调用，12.6 分钟，198 次 LLM 调用、约 2,666 万 prompt tokens，同样人工取消。

### 1.2 根因判定

- 触发在模型：每轮 `tool_call_id` 都不同（`chatcmpl-tool-*`），441 次 `llm_call` 与 440 轮一一对应，不存在 harness 重复派发；assistant 消息与 tool 消息按 `tool_call_id` 配对 451/451 完整，工具结果确实回传；`prompt_tokens` 每轮递增约 84，请求逐轮重建，不是复用陈旧请求。
- 放大在 harness：`agent-loop.ts` 是 `while (true)`，除「连续空响应重试 10 次」外没有任何止损；模型连续 416 次看到同一个 `0 处匹配` 结果仍继续调用，唯一出口是用户点「停止」。

### 1.3 现有保护与缺口

| 机制 | 位置 | 能否覆盖本问题 |
|---|---|---|
| 空响应重试 | `agent-loop.ts:333` | 否，只处理「无 content 且无 tool_calls」 |
| 用户取消 | `cancelFlag` / `isCancelled` | 能，但依赖人工 |
| 上下文压缩 | `compaction-config` / `session-compaction-orchestrator` | 否，256k 窗口下 85k 上下文未触发，且压缩不改变重复行为 |
| 提示词约束 | `prompt-engine.ts:687`「工具返回 error 时不要重复调用」 | 否，不覆盖「返回空结果」 |
| 工具级幂等/去重 | 无 | 否 |

## 2. 目标与非目标

### 2.1 目标

1. 同一执行内，**同一组工具调用（工具名 + 参数）连续多轮得到完全相同的结果**时，第 5 轮结束时向模型注入一次系统提醒，提示换策略（模型在第 6 轮请求中看到）。
2. 仍无变化时，第 10 轮再提醒一次并预告「继续将被中止」。
3. 第 15 轮仍无变化时自动中止本次执行：会话置 `FAILED`，错误文案对桌面/Web/飞书/钉钉/子代理全部可见，不再产生 LLM 调用。
4. 覆盖所有走 `AgentLoop.execute` 的入口：桌面 WS、飞书/钉钉/微信入站、定时任务、边路会话、后台子代理。
5. 检测状态**按一次执行隔离**，同一 `AgentLoop` 实例并发跑多个会话时互不影响；执行开始时从历史扫描的尾部状态续算，避免崩溃恢复/压缩重载后阈值漂移。
6. 不改变正常执行的任何事件、消息落库与用量统计；长等待类调用（`shell await_async` / `write_stdin`、未完成的等待结果）不参与中止判定。
7. 明确边界：只覆盖「完全相同」的工具调用与结果；A/B 两轮交替、参数微变、不同工具做同一件事、纯文本重复不在本次保证范围（见 §2.2、§9）。

**验收口径**：以「第 N 轮请求中包含提醒」为准（第 5 轮结束注入，第 6 轮请求可见），不以模型是否采纳提醒为准；中止以「第 15 轮消息已落库、会话 `FAILED`、不再发起第 16 次 LLM 调用」为准。

### 2.2 非目标（明确不做）

- 不做单轮最大轮次 / 单轮 token 预算（方案 2）。
- 不调整模型配置、不切默认模型、不向供应商反馈（方案 3）。
- 不新增数据库迁移、不改 WS 事件协议、不改前端 / admin / 安卓。
- 不对「纯文本重复」做检测（本次只覆盖工具调用循环）。
- 不覆盖 A/B 两轮交替（A,B,A,B…）、参数每轮微调但无进展、不同工具做同一件事等非精确重复形态；这些属于漏报，见 §9。
- 不做工具级结果缓存或调用去重（会掩盖问题，且影响副作用工具语义）。
- 不新增环境变量或后台配置项；阈值以常量沉淀，后续需要再配置化。

## 3. 方案总览

```
每轮工具执行完成
      │
      ▼
NoProgressGuard.observeCall(toolName, args, toolSave.content, attachment) × N
      │  轮签名 = Σ( toolName + canonicalArgs + resultDigest(call) )
      │  跳过工具级 / 调用级豁免（长等待、completed:false、超时等待）
      │  与上一轮相同 → streak++，否则 streak=1
      ▼
落库本轮消息 → closeRound()
      │
      ├─ nudge（streak = 5、10）
      │     → context.noProgressNotices.push({ afterToolCallId, text })
      │     → context.preparedRequest = null
      │     → 下一次 buildRequest 在锚点后插入 <system-notice>
      │
      ├─ abort（streak ≥ 15）
      │     → 取消竞态复查 → harnessLog(error) → throw NoProgressLoopException
      │
      └─ 继续下一轮

历史装载（每次执行 / 压缩重载）
      │  scanNoProgressNotices(context.messages, context.toolAttachments)
      │    → { notices, tail: { streak, lastRoundKey, nudgedAt } }
      ▼
context.noProgressNotices / context.noProgressTail
      │  AgentLoop 用 tail seed guard；压缩后 resetFrom(tail)
      ▼
buildRequest
      │  normalizeChatMessages 之后 applyNoProgressNotices(normalized, notices)
      ▼
请求副本与上一次执行逐字节一致 → 跨执行前缀可续
```

## 4. 详细设计

### 4.1 核心概念：无进展轮

以「轮」为单位比对，而不是单次调用：

- 一轮的工具调用集合按模型输出顺序排列；
- 每个调用取三元组 `toolName + 规范化参数 + 结果摘要`；
- 整轮三元组拼接成 `roundKey`；
- `roundKey` 与上一轮相同 → 视为「本轮无进展」，`streak + 1`；不同 → `streak = 1`。

按整轮比对而不是按单次调用，可以覆盖两种形态：

1. 单轮单调用（事故 2210 / 2207 的形态）；
2. 单轮固定多调用（如每轮固定 `grep A + grep B`，单个调用交替出现但整轮一致）。

代价是「多调用轮里只有一个调用在重复」不会触发——属于可接受的漏报，避免把「每次都换了别的工具」的探索行为误判成死循环。另需明确：A/B 两轮交替（`A,B,A,B…`）的周期循环也不会触发，这是本方案刻意的窄口径取舍，不在本次范围（见 §2.2、§9）。

### 4.2 参数规范化与结果摘要

**参数规范化**（`canonicalArgs`）：

1. `JSON.parse` 成功 → 递归按键名排序后 `JSON.stringify`；
2. 解析失败 → 去首尾空白、连续空白折叠为单个空格后的原文。

排序键是必须的：不同网关对 `arguments` 的键顺序不稳定，直接字符串比对会把同一调用误判成不同调用。

**结果摘要**（`resultDigest`）：入参不是裸字符串，而是 `{ toolName, argumentsJson, resultContent, attachment? }`，因为不同工具需要不同的语义归一化：

```ts
export interface NoProgressCall {
  toolName: string;
  argumentsJson: string;
  resultContent: string;
  /** 图片结果的可选附件（data_uri）；用于把图片字节纳入摘要。 */
  attachment?: ToolAttachment | null;
}
```

通用规则：

1. 对 `toolSave.content`（模型实际看到的、经 `processToolResult` 清洗后的内容）解析 JSON；
2. 递归剔除**确认非语义**的易变字段后再稳定序列化；`shell` / 图片走下面的专用归一化，不依赖这张清单：
   - `execution_id` / `request_id` / `trace_id`；
   - `timestamp` / `duration_ms` / `elapsed_ms` / `created_at` / `updated_at`；
   - `session_id` / `output_file` 只在 `shell` 等确认是传输字段的工具中剔除（`shell` 每轮新建会话时 `output_file` 是 `${shellSessionId}.out`，只剔 `session_id` 仍每轮不同——这是 2207 形态的关键）；
   - `child_session_id` / `task_id` **默认保留**：它们对子代理结果是语义身份，误删会让不同结果看起来相同；只有确认某工具把它们当纯传输字段时才按工具剔除；
3. 对稳定序列化结果取 `sha256`，截前 16 位十六进制；
4. 非 JSON 结果 → 原文去尾空白后取 `sha256` 前 16 位。

**按工具归一化（必须）**：

- `shell`：只取语义字段 `exit_code`、`output`、`truncated`、`completed`、`current_workdir`；不取 `session_id`、`output_file`、`message`。其中 `message` 在未完成时只是带会话 id 的等待提示，剔除不会丢失进展信息；`output` / `exit_code` / `completed` 已覆盖真实结果。
- 图片结果（`media_type === 'image'`）：`ToolImageResultProcessor` 会把 `data_uri` 从 `sanitizedContent` 删除，只比较 content 会把「同路径图片已更新」误判为无变化。若 `attachment?.dataUri` 存在，把 `sha256(dataUri)` 作为 `imageDigest` 纳入摘要；重放侧必须从持久化 metadata / `context.toolAttachments` 取同一份 data_uri，保证运行时与扫描同源。
- 其他工具：默认走通用易变字段清单；新增工具若结果带随机 id，必须逐项确认。

> 易变字段清单以常量 `VOLATILE_RESULT_KEYS` 维护，但**不要**把它当作唯一机制。黑名单的风险是双向的：漏补字段 → 漏报；误删语义字段（如把 `child_session_id` 当成纯随机会让不同子代理结果看起来相同）→ 误杀。新增字段必须逐项确认，优先使用按工具归一化。

不剔除 `exit_code`、`output`、`matches`、`total_matches`、`success`、`error` 等语义字段；结果变化即视为有进展。`roundSignature` 必须直接调用同一个 `resultDigest`，不要在 guard 内再手写拼接。

### 4.3 状态机与阈值

常量（`no-progress-notice.ts` 定义、`no-progress-guard.ts` re-export，便于单测与后续调参）：

```ts
export const NO_PROGRESS_NUDGE_AT = [5, 10] as const;
export const NO_PROGRESS_ABORT_AT = 15;

/** 工具级豁免（当前为空）：整轮全是豁免工具时视为无工具轮。 */
export const NO_PROGRESS_EXEMPT_TOOLS = new Set<string>();

/**
 * 调用级豁免：长等待 / 显式未完成结果不参与 streak。
 * 2207 是普通 shell 循环，不能把 shell 整个工具豁免；这里只豁免等待动作。
 */
export const NO_PROGRESS_EXEMPT_CALLS: Array<(call: NoProgressCall) => boolean> = [
  (call) => call.toolName === 'shell' && isShellWaitAction(call.argumentsJson),
  (call) => call.toolName === 'shell' && isIncompleteResult(call.resultContent),
  (call) => call.toolName === 'wait_subagents' && isTimedOutResult(call.resultContent),
];
```

其中 `isShellWaitAction` 解析 `argumentsJson.action ∈ { await_async, write_stdin }`；`isIncompleteResult` 解析结果 `completed === false`；`isTimedOutResult` 解析 `timedOut === true`。长等待豁免不是无限通行证：用户仍可取消，后续可用总时长上限（§9）兜底。

> 模块归属：阈值 `NO_PROGRESS_NUDGE_AT` / `NO_PROGRESS_ABORT_AT`、`NO_PROGRESS_EXEMPT_TOOLS` / `NO_PROGRESS_EXEMPT_CALLS` / `isNoProgressExempt` 都放在 `no-progress-notice.ts`（scan 与 guard 共用）；`no-progress-guard.ts` 只保留状态机与异常，并 re-export 这些常量，避免 notice ↔ guard 循环依赖。

| streak | 动作 | 说明 |
|---|---|---|
| 1-4 | 无 | 正常探索，重复读同一文件/同一命令几次很常见 |
| 5 | `nudge` | 注入第一次提醒（同一 streak 只注入一次） |
| 6-9 | 无 | 给模型自我纠正的机会 |
| 10 | `nudge` | 第二次提醒，明确预告将在第 15 轮中止 |
| 11-14 | 无 | 继续观察 |
| ≥15 | `abort` | 抛异常中止本次执行 |

调用级豁免命中时，该调用不进入本轮签名；整轮全是豁免调用 → 按「无工具轮」处理并重置 streak（不会中止）。这样长构建的 `await_async` 不会在第 15 轮被杀，同时 2207 的普通 `shell` 循环仍会被检测。

选值依据：事故形态约 2.7-3.8 秒/轮，第 5 轮提醒约在 15-20 秒内，第 15 轮中止约在 40-60 秒内；相比 416 轮 / 19 分钟，止损率约 96%。阈值放宽到 5/15 是为了给「重复读同一文件、重跑同一命令」这类正常操作留出余量：重复 5 次才提醒，重复 15 次且结果完全一致没有合理场景。代价是比 3/10 多跑 5 轮（约 5 次 LLM 调用）。

`streak` 的重置条件：

- 出现任意不同的轮签名（换了工具、参数或结果变化）；
- 历史扫描遇到真实用户消息（新回合）→ tail 重置为 `null`；
- 执行开始：guard 用 `context.noProgressTail` **seed**，不是无条件清零；无新用户消息的崩溃恢复/续跑会继续计数；
- 压缩重载：`applyHistory` 重算 `tail`，`AgentLoop` 在 `compact()` 返回后 `resetFrom(tail)`；边界截断 streak 时 `tail=null`（等价重置），边界保留触发轮时续算；
- 用户取消导致的提前退出不涉及状态复用（guard 实例随执行销毁）。

### 4.4 系统提醒：渲染期确定性重放（对齐跨天提示）

提醒**不落库、也不写入 `context.messages`**，而是像 `<date-change>` 一样，在 `PromptEngine.buildRequest` 渲染请求副本时按位置插入。触发条件完全来自已持久化的工具轮消息，因此任何一次执行（同一轮、下一次用户对话、服务重启、压缩重载）都能重算出**逐字节相同**的请求，跨执行前缀缓存因此不会失效。

#### 4.4.1 三段式数据流

1. **历史装载**（`SessionHistoryLoader.applyHistory`）：消息从 DB 重建、`context.toolAttachments` 加载完成后，调用 `scanNoProgressNotices(context.messages, context.toolAttachments)`，顺序扫描所有工具轮，得到 `{ notices, tail }`。`notices` 是历史提醒锚点，`tail` 是窗口最后一轮的 `{ streak, lastRoundKey, nudgedAt }`；两者都写回 `context`。
2. **执行中**（`AgentLoop`）：`execute()` 开始时用 `context.noProgressTail` seed guard；命中 5 / 10 时把新提醒追加到 `context.noProgressNotices`、清空 `context.preparedRequest`（确保下一轮重新渲染），并记日志。压缩返回后同样用 `context.noProgressTail` 调 `guard.resetFrom(tail)`。
3. **渲染**（`PromptEngine.buildRequest`）：`normalizeChatMessages` 之后调用 `applyNoProgressNotices(normalized, context.noProgressNotices)`，在锚点 tool 消息之后插入一条 user 角色的 `<system-notice>`；只作用于请求副本。

#### 4.4.2 为什么用 tool_call_id 做锚点

提醒必须落在「触发轮最后一条 tool 结果」之后。用 `tool_call_id` 而不是数组下标，才能在媒体注入、工具组归一化、图片拆分之后仍落在同一位置；锚点找不到时跳过并记 warn，不阻断请求。

#### 4.4.3 扫描语义（与运行时 guard 共用同一套函数）

- 以真实用户消息为回合边界（`isRealUserMessage`，`compaction-service.ts:13`，已排除 `<system-notice>` 与交接模板）；遇到边界重置 streak / tail；
- assistant(tool_calls) + 其后按 id 配对的 tool 消息构成一轮，按 `roundSignature([...])` 计算；`resultDigest` 由 `toolName + content + attachment` 决定，和运行时完全同源；
- 与 guard 一样跳过 `NO_PROGRESS_EXEMPT_TOOLS` / `NO_PROGRESS_EXEMPT_CALLS`；整轮全是豁免调用则重置；
- 连续相同 streak = 5 / 10 时记录提醒，锚点为该轮最后一个 `tool_call_id`；扫描结束返回 `{ notices, tail }`，`tail.nudgedAt` 由扫描过程中已命中的提醒阈值组成（例如 streak=12 → `[5, 10]`）；
- 图片等带附件的结果从 `context.toolAttachments`（由 `ToolAttachmentLoader` 从持久化 metadata 重建）取，确保与运行时使用同一份 `data_uri`；
- 缺失 tool 输出的轮（取消 / 中断 / 孤儿消息）跳过，不参与 streak；
- 纯文本 assistant 消息不产生提醒。

#### 4.4.4 幂等与压缩

- `applyNoProgressNotices` 是纯函数，只读 notices、返回新数组；**同一输入**重复调用不会重复插入。它只应从 `context.messages` 构建的请求副本调用一次；不要对已经渲染过的数组再调用（否则会在锚点后重复插入）。
- `applyHistory` 在压缩重载时必须清空旧 notices，并按新窗口重算 `{ notices, tail }`；`AgentLoop` 在 `compact()` 返回后 `guard.resetFrom(tail)`。压缩边界截断 streak 时 `tail=null`（等价重置）；边界保留触发轮时 tail 续算，避免「扫描从 tail 算、guard 从 0 算」的漂移。
- 压缩边界之前的提醒随历史一起被裁掉，这是压缩重写前缀的既有语义；不追求压缩前后继续命中。
- 提醒文案模板必须稳定：模板变更会让在途会话发生一次分叉（与跨天提示文案变更同性质）。

#### 4.4.5 文案

第一次（streak = 5）：

```
检测到重复调用：最近 5 轮的工具调用与结果完全一致（工具：grep_search）。
继续重复不会产生新信息。请改变做法：调整参数/关键词/路径、改用其他工具，
或基于已有结果直接向用户说明结论与当前阻塞。
```

第二次（streak = 10）：

```
重复调用仍在继续：最近 10 轮的工具调用与结果完全一致（工具：grep_search）。
若继续无变化，系统将在第 15 轮自动中止本次执行。请立即换策略或直接给出结论。
```

文案只带工具名与轮数，不带参数原文（参数可能含路径、token、客户数据）。

### 4.5 中止

新增异常（与 `EmptyResponseExhaustedException` 同风格，`harness/core/no-progress-guard.ts` 内导出）：

```ts
export class NoProgressLoopException extends Error {
  constructor(toolNames: string[], streak: number) {
    super(`检测到 Agent 连续 ${streak} 轮重复执行同一组工具调用（${toolNames.join('/')}）`
      + '且结果没有任何变化，已自动中止本次执行以避免无限循环。请调整需求描述后重试。');
    this.name = 'NoProgressLoopException';
  }
}
```

中止点放在本轮消息**落库之后**、`closeRound()` 之后：

- 保证会话历史里能看到最后一次重复调用，便于复盘；
- 保证 `onRoundStart` / `onRoundEnd` 成对；
- 不在工具派发前预判，避免「结果本来会变化」的误杀；代价是第 15 次调用仍会真实执行。
- 抛出前再检查一次 `isCancelled(context)`：若用户在落库 / `closeRound()` 期间点了停止，只 `cancelFlag.set(true)` + `break`，让入口按 `CANCELLED` 收尾，不要记成 `FAILED`；此时消息与用量已落库，不回滚。

抛出后由各入口既有 catch 统一收尾，无需新增事件类型：

| 入口 | 表现 |
|---|---|
| 桌面 / Web（`streaming-ws-handler.ts:733`） | `error` 事件带文案，`finishFailedSession` 写 `runtime_status_json.executionError`，会话 `FAILED`；刷新后仍能看到失败原因 |
| 边路会话（`streaming-ws-handler.ts:1151`） | 同上，终态 `FAILED`，WS `error` |
| 飞书（`agent-inbound-handler.ts`） | `feishuFailureText(error)` 取异常 message，进度卡 `fail()`，卡片更新失败时回退文本回复；`onExecutionFinished(..., 'FAILED', text)` |
| 钉钉（`dingtalk/runtime.ts:316`） | `onExecutionFinished(..., 'FAILED', failureReason)`，卡片失败态 |
| 后台子代理（`background-subagent-manager.ts:761` / `:788`） | `collector.error` → `后台子代理执行失败: <message>` 落子会话 assistant 消息并回传父会话；`subagent_execution.status = FAILED` |
| 定时任务 | 执行记为 `FAILED`，按任务既有失败策略处理（连续失败暂停等），行为与其它执行异常一致 |

> 注：`subagent-visibility-service.ts:183` 在 catch 中会显式 `composite.onError(e)`，因此子代理路径的 `onError` 会被调用；§6.4 的「`onError` 未被调用」只适用于 `AgentLoop` 自身的单测，不要拿它断言子代理路径。

日志（便于线上巡检）：

```
[no-progress] nudge session=2210 round=5 streak=5 tools=grep_search digest=ab12cd34ef56 argsLength=42
[no-progress] abort session=2210 round=15 streak=15 tools=grep_search digest=ab12cd34ef56 argsLength=42
```

日志**不打印原始 args**：只记 `toolName`、`digest`、`argsLength`（必要时 `argsHash`）。工具参数可能包含 git token、HTTP header、飞书/钉钉密钥或客户数据，不能进日志。

### 4.6 接入点

三处接入 + context 字段，全部复用现有装配点：

1. **`agent-loop.ts`**：`execute()` 开始时用 `context.noProgressTail` 创建执行级 `NoProgressGuard`；`executeToolCalls` 增加 guard 参数，逐调用 `observeCall({ toolName, argumentsJson, resultContent, attachment })`；`closeRound()` 之后、**`consumeManualCompaction` 与 mid-loop compaction 之前** 执行 `endRound(anchorToolCallId)` + `takeAction()`：
   - `nudge` → `context.noProgressNotices.push({ afterToolCallId, text })` + `context.preparedRequest = null` + 日志；
   - `abort` → 先复查 `isCancelled`（取消竞态按 `CANCELLED` 收尾）→ `harnessLog('error', ...)` + `throw NoProgressLoopException`。
2. **`session-history-loader.ts`**：`applyHistory` 重建 `context.messages`、加载 `context.toolAttachments` 之后：

```ts
const { notices, tail } = scanNoProgressNotices(context.messages, context.toolAttachments);
context.noProgressNotices = notices;
context.noProgressTail = tail;
```

3. **`prompt-engine.ts`**：`buildRequest` 在 `normalizeChatMessages` 之后：

```ts
const normalized = MessageHistoryNormalizer.normalizeChatMessages(injected) ?? injected;
const rendered = applyNoProgressNotices(normalized, context.noProgressNotices);
```

后续 `request.messages` 与 `context.contextManifest` 都使用 `rendered`（manifest 必须与所发请求同源）。

`AgentExecutionContext` 增加两个字段：

```ts
/** 渲染期重放的提醒锚点（不落库）。执行开始/压缩重载时由历史扫描重建，运行中增量追加。 */
noProgressNotices: NoProgressNotice[] = [];
/** 历史扫描得到的尾部状态：执行开始/压缩重载时 seed guard，避免运行时与重放分叉。 */
noProgressTail: NoProgressTail | null = null;
```

执行循环内的接线：

```ts
const noProgress = new NoProgressGuard(context.noProgressTail);

// executeToolCalls 内，每个 toolSave 生成之后：
noProgress.observeCall({
  toolName: tc.function?.name ?? '',
  argumentsJson: tc.function?.arguments ?? '',
  resultContent: toolSave.content,
  attachment: tc.id ? context.toolAttachments.get(tc.id) ?? null : null,
});

// closeRound() 之后，consumeManualCompaction / mid-loop compaction 之前：
const anchorToolCallId = pendingCalls[pendingCalls.length - 1]?.id ?? '';
noProgress.endRound(anchorToolCallId);
const action = noProgress.takeAction();
if (action?.kind === 'nudge') {
  harnessLog('warn', `[no-progress] nudge session=${context.sessionId} round=${round} `
    + `streak=${noProgress.streak} tools=${noProgress.toolNames.join(',')} `
    + `digest=${noProgress.digest} argsLength=${noProgress.argsLength}`);
  context.noProgressNotices.push({ afterToolCallId: action.afterToolCallId, text: action.text });
  context.preparedRequest = null;
}
if (action?.kind === 'abort') {
  if (await this.isCancelled(context)) {
    cancelFlag?.set(true);
    break; // 已落库、已 closeRound；不回滚用量，入口按 CANCELLED 收尾
  }
  harnessLog('error', `[no-progress] abort session=${context.sessionId} round=${round} `
    + `streak=${noProgress.streak} tools=${noProgress.toolNames.join(',')} `
    + `digest=${noProgress.digest} argsLength=${noProgress.argsLength}`);
  throw new NoProgressLoopException(noProgress.toolNames, noProgress.streak);
}
```

如果不想改 `executeToolCalls` 签名，也可以在它返回后按 `toolCallId` 配对 `pendingCalls` 与 `pendingToolSaves`（两个分支的顺序都与 `pendingCalls` 一致）；取消路径不要调用 `endRound`。

压缩路径（`consumeManualCompaction` / mid-loop compaction）返回后，循环里再执行 `noProgress.resetFrom(context.noProgressTail)`；不要在 `SessionHistoryLoader` 内直接拿 guard（它拿不到）。

`observeCall` 只累积本轮调用，`endRound` 才计算 `roundKey` 并推进 streak——保证同一轮内多个调用的顺序与数量差异能被整体识别。命中 `NO_PROGRESS_EXEMPT_TOOLS` / `NO_PROGRESS_EXEMPT_CALLS` 的调用不参与签名；整轮全是豁免调用时按「无工具调用」处理并重置 streak。

### 4.7 关键代码骨架

模块拆成两个文件，保证「运行时判定」和「历史重放」共用同一套签名：

```ts
// no-progress-notice.ts —— 纯函数，PromptEngine / SessionHistoryLoader 可直接依赖
export interface NoProgressCall {
  toolName: string;
  argumentsJson: string;
  resultContent: string;
  /** 图片结果的可选附件（data_uri）；用于把图片字节纳入摘要。 */
  attachment?: ToolAttachment | null;
}

export interface NoProgressNotice {
  /** 触发轮最后一个 tool_call_id：渲染时插在该 tool 消息之后。 */
  afterToolCallId: string;
  text: string;
}

export interface NoProgressTail {
  streak: number;
  lastRoundKey: string;
  nudgedAt: number[];
}

export interface NoProgressScanResult {
  notices: NoProgressNotice[];
  tail: NoProgressTail | null;
}

export function roundSignature(calls: NoProgressCall[]): string; // Σ toolName + canonicalArgs + resultDigest(call)
export function scanNoProgressNotices(
  messages: ChatMessage[],
  attachments?: Map<string, ToolAttachment> | null,
): NoProgressScanResult;
export function applyNoProgressNotices(
  messages: ChatMessage[], notices: NoProgressNotice[],
): ChatMessage[]; // 返回新数组，不修改入参
export function buildNoProgressNotice(streak: number, toolNames: string[]): string;
export function canonicalArgs(raw: string): string;
export function resultDigest(call: NoProgressCall): string;
export function isNoProgressExempt(call: NoProgressCall): boolean;
```

```ts
// no-progress-guard.ts —— 运行时状态机 + 终止异常
export type NoProgressAction =
  | { kind: 'nudge'; afterToolCallId: string; text: string }
  | { kind: 'abort' };

interface NoProgressSnapshot {
  streak: number;
  toolNames: string[];
  digest: string;
  argsLength: number;
}

// shortHash(key) = sha256(key).slice(0, 16)，仅用于日志比对，不参与判定

export class NoProgressGuard {
  private lastRoundKey: string | null = null;
  private roundToolNames: string[] = [];
  private roundCalls: NoProgressCall[] = [];
  private _streak = 0;
  private nudgedAt = new Set<number>();
  private anchorToolCallId = '';
  private snapshot: NoProgressSnapshot | null = null;

  constructor(tail?: NoProgressTail | null) {
    this.resetFrom(tail);
  }

  resetFrom(tail?: NoProgressTail | null): void {
    this.lastRoundKey = tail?.lastRoundKey ?? null;
    this._streak = tail?.streak ?? 0;
    this.nudgedAt = new Set(tail?.nudgedAt ?? []);
    this.roundToolNames = [];
    this.roundCalls = [];
    this.anchorToolCallId = '';
    this.snapshot = null;
  }

  observeCall(call: NoProgressCall): void {
    if (isNoProgressExempt(call)) return;
    this.roundCalls.push(call);
    this.roundToolNames.push(call.toolName);
  }

  endRound(anchorToolCallId: string): void {
    if (this.roundCalls.length === 0) {
      this.resetFrom(null);
      return;
    }
    const key = roundSignature(this.roundCalls);
    if (key === this.lastRoundKey) this._streak += 1;
    else {
      this.lastRoundKey = key;
      this._streak = 1;
      this.nudgedAt.clear();
    }
    this.anchorToolCallId = anchorToolCallId;
    this.snapshot = {
      streak: this._streak,
      toolNames: [...this.roundToolNames],
      digest: shortHash(key),
      argsLength: this.roundCalls.reduce((n, c) => n + c.argumentsJson.length, 0),
    };
    this.roundToolNames = [];
    this.roundCalls = [];
  }

  takeAction(): NoProgressAction | null {
    if (this.snapshot == null) return null;
    if (this.snapshot.streak >= NO_PROGRESS_ABORT_AT) return { kind: 'abort' };
    const streak = this.snapshot.streak;
    if ((NO_PROGRESS_NUDGE_AT as readonly number[]).includes(streak) && !this.nudgedAt.has(streak)) {
      this.nudgedAt.add(streak);
      return {
        kind: 'nudge',
        afterToolCallId: this.anchorToolCallId,
        text: buildNoProgressNotice(streak, this.snapshot.toolNames),
      };
    }
    return null;
  }
  // getters: streak / toolNames / digest / argsLength 均从 snapshot 取
}
```

> 说明：日志里的 `digest` 由整轮 key 再哈希得到（`shortHash` = `sha256` 前 16 位），只用于人工比对同一条循环，不参与判定。`takeAction` 只读 `snapshot`，不会碰到 `endRound` 已清空的 round 字段；`roundSignature` 由 guard 与 scan 共用，禁止在 guard 内另写一套拼接。

### 4.8 与现有机制的关系

| 机制 | 交互 |
|---|---|
| 用户取消 | 每轮开头检查一次；guard 抛异常前再检查一次。落库后检测到取消只 `cancelFlag.set(true)` + `break`，入口按 `CANCELLED` 收尾，不回滚已落库用量 |
| 空响应重试 | 空响应轮不产生工具调用，`endRound` 不推进 streak；空响应耗尽仍走原异常 |
| 上下文压缩 | `applyHistory` 重建 `context.messages`、重算 `{ notices, tail }`；`AgentLoop` 在 `compact()` 后 `resetFrom(tail)`；边界截断则 `tail=null`，保留触发轮则续算，避免运行时与扫描分叉 |
| 长等待 / 后台任务 / 子代理 | `shell await_async` / `write_stdin`、`completed:false`、`wait_subagents` 超时走调用级豁免，不参与 streak；普通 `shell` 循环仍会被检测，不会因为豁免整个 `shell` 工具而放过 2207 |
| 图片 / 媒体 | 图片摘要纳入 `data_uri` 哈希；运行时从 `context.toolAttachments`、扫描从持久化 metadata 取同一份附件，保证运行时与重放同源 |
| 边路 / 子代理 | 各自独立执行、独立 guard 实例，互不串扰 |
| 跨天提示 | 同一渲染管线：`<date-change>` 注入 user 消息头，提醒注入 tool 组之后，位置与判定互不干扰 |

### 4.9 对前缀缓存的影响

结论：**不破坏前缀缓存；跨执行（下一次对话、服务重启）也能保持逐字节一致**，唯一例外是压缩边界（既有语义）。

1. **system / tools 零改动**：`prompt-prefix-monitor` 只对 system sections + tools 做指纹，提醒不触碰这两部分；`prompt_cache_key`（`mao-session-<id>`）保持不变。
2. **同一执行内**：`context.messages` 正常路径只增不改（取消回滚 / 压缩重写除外），渲染结果单调延长，上一轮请求是新请求的严格前缀。
3. **跨执行 / 重启**：提醒不是「存下来的文本」，而是「从持久化消息确定性重算出来的渲染结果」。这与 `<date-change>` 完全同构——`senderYmd` 来自 DB 的 `created_at`，标签本身不落库，但每次重建都得到相同的字节。因此新请求与上一次请求在提醒位置不会分叉，前缀可延续到上一次末尾。
   - 前提：提醒文案模板稳定；图片摘要依赖的 attachment / metadata 也必须同源（运行时 `context.toolAttachments`、重放持久化 metadata）；发版改文案会让在途会话发生一次分叉（`<date-change>` 同性质）。
4. **压缩边界**：压缩会裁剪历史并按新窗口重算提醒 + `tail`；若边界截断 streak，`tail=null`、边界后的提醒可能不再出现；若保留触发轮，`tail` 续算。压缩本身已重写前缀，属既有语义；不追求压缩前后继续命中。
5. **净效果**：事故形态下缓存读写从 440 轮降到 15 轮，约降 96.6%；「提醒不落库」不再带来任何额外的跨轮 miss。

> 与「持久化提醒消息」的差别：不新增 message 行、不污染 desktop / admin / 飞书历史与分享导出；代价是需要一套与 guard 同源的扫描 / 渲染函数（见 §4.7、§5）。这也解释了为什么不需要在 tool 消息 metadata 上打标——触发条件本身就能从消息序列重算。

## 5. 代码改动清单

| 文件 | 类型 | 内容 |
|---|---|---|
| `backend-ts/src/harness/core/no-progress-notice.ts` | 新增 | `NoProgressCall` / `NoProgressNotice` / `NoProgressTail` / `NoProgressScanResult`、`roundSignature`、`scanNoProgressNotices`、`applyNoProgressNotices`、`buildNoProgressNotice`、`canonicalArgs` / `resultDigest(call)`、`isNoProgressExempt`、`NO_PROGRESS_NUDGE_AT` / `NO_PROGRESS_ABORT_AT`、`NO_PROGRESS_EXEMPT_TOOLS` / `NO_PROGRESS_EXEMPT_CALLS`、`VOLATILE_RESULT_KEYS`、`shell` / 图片归一化 |
| `backend-ts/src/harness/core/no-progress-notice.spec.ts` | 新增 | 签名归一化、扫描、渲染幂等、图片/`shell` 归一化与跨执行一致性（见 §6） |
| `backend-ts/src/harness/core/no-progress-guard.ts` | 新增 | `NoProgressGuard`（含 `resetFrom`）、`NoProgressLoopException`；re-export 阈值与豁免常量 |
| `backend-ts/src/harness/core/no-progress-guard.spec.ts` | 新增 | 状态机单测（见 §6） |
| `backend-ts/src/harness/core/agent-execution-context.ts` | 修改 | 新增 `noProgressNotices: NoProgressNotice[]` 与 `noProgressTail: NoProgressTail \| null` |
| `backend-ts/src/harness/core/agent-loop.ts` | 修改 | 用 `context.noProgressTail` 创建 guard；`executeToolCalls` 传入 guard；`closeRound()` 后、压缩前 nudge / abort；取消竞态复查；日志脱敏 |
| `backend-ts/src/harness/core/session-history-loader.ts` | 修改 | `applyHistory` 重建 messages、加载 attachments 后 `scanNoProgressNotices`，写回 notices + tail |
| `backend-ts/src/harness/core/prompt-engine.ts` | 修改 | `buildRequest` 归一化后 `applyNoProgressNotices`，manifest 使用渲染后的数组 |
| `backend-ts/src/harness/core/agent-loop.spec.ts` | 修改 | 集成用例：提醒锚点、达到阈值抛异常、结果变化不触发、长等待豁免、取消竞态、压缩 seed |
| `CHANGELOG.md` | 实施时补 | 后端条目：新增无进展工具循环自动止损（见 §8） |

不新增迁移、不改 `AgentEventListener` 接口、不改 `ToolDispatcher`、不改前端与渠道代码、不落库任何提醒文本。`session-compaction-orchestrator` 无需改接口：`applyHistory` 已写入 `context.noProgressTail`，压缩后由 `AgentLoop` 调用 `resetFrom(tail)`。

## 6. 测试计划

### 6.1 纯函数单测（`no-progress-notice.spec.ts`）

| 用例 | 断言 |
|---|---|
| 参数键顺序不同 | `canonicalArgs` 输出一致 |
| `shell` 结果仅 `session_id` 不同 | `resultDigest` 一致（`output` 相同） |
| `shell` 结果仅 `output_file` / 未完成 `message` 不同 | `resultDigest` 一致（覆盖 2207 形态） |
| `shell` `await_async` 返回 `completed:false` | `isNoProgressExempt` 为 true，不参与签名 |
| 图片同路径、`data_uri` 不同 | `resultDigest` 不同；`data_uri` 相同 → 一致 |
| 连续 5 轮相同 | `scanNoProgressNotices` 返回 1 条，锚点为第 5 轮最后一个 `tool_call_id`，`tail.streak=5` |
| 连续 10 轮相同 | 返回 2 条（5 / 10），`tail.streak=10` |
| 结果变化 | 不产出提醒，`tail` 重置 |
| 单轮多调用顺序 | `[A,B]` 重复 → 命中；`[A,B]` 与 `[B,A]` → 不命中 |
| A/B 两轮交替 | 不产出提醒（已知边界，见 §2.2） |
| 渲染幂等 | 同一输入调用两次输出相同；不修改入参数组与消息对象；不要对已渲染数组再调用 |
| 锚点缺失 | 跳过该条提醒，不抛异常 |
| 非 JSON 结果 | 尾部空白差异不破坏判定 |

### 6.2 跨执行一致性（重点）

1. **运行时 vs 重放**：用同一组消息，一次走 guard 运行路径（从同一 `tail` seed，`context.noProgressNotices` 增量追加），一次走 `applyHistory` + `scanNoProgressNotices` 重算；断言两次 `buildRequest` 的 `messages` 序列化结果逐字节一致。
2. **模拟服务重启**：丢弃 context 后重新 `buildContext` → `applyHistory` → `buildRequest`，与重启前最后一次请求逐字节比对（重点看提醒是否在同一 `tool_call_id` 之后）。
3. **归一化扰动**：构造媒体注入 / tool 组重排的输入，断言提醒仍落在同一 tool 消息之后，不插进 `assistant(tool_calls)` 与 `tool_result` 之间。注意 `ToolMediaInjector` 会在 tool 组之后插入 synthetic user 图片消息；按 `tool_call_id` 插入会落在最后一条 tool 与图片消息之间，语义可接受，但测试要明确这个位置。
4. **压缩边界**：构造边界截断 streak 的历史，断言边界前的提醒消失、边界后按新窗口重算，且不出现重复插入；边界保留触发轮时 `tail.streak` 续算，边界截断时 `tail=null`。
5. **图片附件同源**：同一图片结果，运行时 `context.toolAttachments` 与历史 metadata 载入的 attachment 生成相同 digest；同路径不同 `data_uri` 生成不同 digest。
6. **tail 与 guard 一致**：同一组消息，一次逐步 `observeCall`，一次从 `scan.tail` 构造 guard；断言 `streak` / `lastRoundKey` / `nudgedAt` 一致，后续 `takeAction()` 序列也一致。

### 6.3 状态机单测（`no-progress-guard.spec.ts`）

| 用例 | 断言 |
|---|---|
| 连续 5 轮相同 | 第 5 轮 `takeAction()` = `nudge`，第 6-9 轮 = `null`，第 10 轮再次 `nudge`，第 11-14 轮 = `null`，第 15 轮 = `abort` |
| 同一 streak 只提醒一次 | 第 5 轮后重复调用 `takeAction()` 不再返回 `nudge` |
| 结果变化 | 第 2 轮 digest 不同 → streak 重置为 1，后续 3 轮才重新触发 |
| 参数键顺序不同 | 判定为相同；参数值不同 → 重置 |
| 空轮 | `endRound()` 无调用 → 重置 |
| 工具级豁免 | 整轮为 `NO_PROGRESS_EXEMPT_TOOLS` 中的工具 → 视为无调用并重置 |
| 调用级豁免 | `shell await_async` pending / `wait_subagents` 超时 → 不参与签名；整轮全豁免 → 重置 |
| 从 tail seed | `tail.streak=4` → 下一次相同轮 = 5，`takeAction()` = `nudge`；`tail.streak=14` → 下一次 = `abort` |
| `resetFrom` 压缩 | 传入新 tail 后 `streak` / `lastRoundKey` / `nudgedAt` 完全替换，不保留旧值 |

### 6.4 集成测试（`agent-loop.spec.ts`）

沿用现有 `llmAdapter.stream` mock 方式：

1. **提醒写入锚点**：mock 连续 5 轮返回同一 `grep_search` 调用、`dispatchInvocation` 返回同一结果 → 断言 `context.noProgressNotices` 增加 1 条、锚点等于第 5 轮最后一个 `tool_call_id`，且 `context.messages` 中**没有**提醒文本（不落上下文）。
2. **中止**：同样 mock 连续 15 轮 → `await expect(execute(...)).rejects.toBeInstanceOf(NoProgressLoopException)`；断言持久化回调收到 15 轮消息、`onRoundStart` 与 `onRoundEnd` 次数相等、`onError` 未被调用（仅针对 `AgentLoop` 自身；子代理路径见 §4.5 注）。
3. **结果变化不触发**：前 3 轮结果依次为 `0 处匹配`、`1 处匹配`、`0 处匹配` → 不新增锚点、不抛异常。
4. **长等待不中止**：mock `shell` `await_async` 连续 15 轮 `completed:false` → 不抛异常，streak 不推进。
5. **取消竞态**：第 15 轮落库 / `closeRound()` 后置 `cancelFlag=true` → `execute` 正常返回（不抛 `NoProgressLoopException`）且 `cancelFlag` 置位；入口层另测终态为 `CANCELLED`。
6. **压缩 seed**：mid-loop compaction 后继续相同调用 → guard 从 `context.noProgressTail` 续算，不重新从 0 开始；`preparedRequest` 使用带提醒的新请求。

### 6.5 手工验证

1. 本地起后端，用会连续输出相同工具调用的模型/提示词复现 2210 形态，确认：
   - 第 5 轮结束注入，第 6 轮请求可见；`message` 表没有新增提醒行、消息列表不显示提醒；
   - 第 15 轮会话变 `FAILED`，错误文案为中文，刷新后仍在；
   - 日志出现 `[no-progress] nudge` / `[no-progress] abort`，且不包含原始 args。
2. 重启后续跑：同一会话再发一条消息，观察 `llm_call.cached_tokens` 占比与前一轮同级，不出现「整段历史重算」。
3. 飞书通道：同形态触发后进度卡进入失败态并发出失败文案，而不是无限「思考中」。
4. 2207 形态：构造每次 `shell` 结果仅 `session_id` / `output_file` / 未完成 `message` 不同的连续调用，确认第 15 轮进入 `FAILED`，而不是漏报。
5. 长构建：`shell await_async` 连续 pending 15 轮，确认不中止；构建完成后模型继续正常执行。
6. 图片：同一路径图片内容更新后重复读取不触发；内容相同连续读取 15 次触发。
7. 正常长任务回归：`edit_file → npm test → edit_file`（参数不同）与 `sleep` 轮询（结果不同）各跑一次，确认不触发。

### 6.6 回归命令

```bash
cd backend-ts && npm test
cd backend-ts && npm run build
```

## 7. 风险与取舍

| 风险 | 影响 | 处理 |
|---|---|---|
| 误杀合法长等待（`shell await_async` 长构建、`wait_subagents` 超时） | 第 15 轮中止 | 调用级豁免 `NO_PROGRESS_EXEMPT_CALLS`：`shell` 的 `await_async` / `write_stdin`、`completed:false`、`wait_subagents` 超时不计入 streak；不要把整个 `shell` 加入工具级豁免（会放过 2207） |
| 工具结果含未登记随机字段 | 漏报 | 优先按工具归一化；`VOLATILE_RESULT_KEYS` 只删确认非语义的字段，新增字段逐项确认 |
| 误删语义字段（如 `child_session_id`） | 不同结果被当成相同 → 误杀 | 同上；id 只有在确认「纯传输 / 每轮新建」时才剔除 |
| 同路径图片内容更新 | 图片 digest 相同 → 误杀 | 图片结果纳入 `data_uri` 哈希；运行时与扫描都从 attachment / metadata 取同一份 |
| 单轮多调用里只有部分重复 | 漏报 | 只按整轮签名比对，避免误判探索行为 |
| A/B 两轮交替、参数微变 | 漏报 | 已知边界（§2.2 / §9），本次不覆盖 |
| 提醒被 mid-loop 压缩吞掉 | 提醒失效 | 中止逻辑不依赖提醒是否可见；压缩后 tail seed 续算 |
| 慢工具（单次数分钟）触发中止偏晚 | 止损变慢 | 阈值是常量，后续可按工具耗时分级 |
| 终态由 `CANCELLED` 变为 `FAILED` | 定时任务可能按失败策略重试；订阅方收到 `task.failed` | 属预期语义；抛异常前复查取消，用户主动停止仍记 `CANCELLED` |
| 用户看到的是错误而非「AI 主动结束」 | 体验略硬 | 文案明确说明「已自动中止以避免无限循环」，并给出重试指引 |
| 提醒文案变更 | 在途会话一次前缀分叉 | 与 `<date-change>` 同性质；避免在长任务执行期间发版改文案 |
| 压缩边界截断 streak | 边界后的提醒可能不再出现 | `tail=null` 等价重置；保留触发轮时 tail 续算；不追求压缩前后继续命中 |
| 历史扫描成本 | 每次装载多一次 O(n) 摘要计算 | 只在 `applyHistory` 执行一次，执行中增量 O(1)；大历史用单测压一遍 |
| 锚点失效（tool 消息被归一化丢弃） | 该条提醒不渲染 | 跳过 + warn，不阻断请求；单测覆盖 |
| 运行时与重放不一致 | 提醒重复/缺失 → 前缀分叉 | 共用 `roundSignature` / `resultDigest` / `buildNoProgressNotice`；scan 用 `toolAttachments`，guard 用 tail seed；6.2 逐字节比对兜底 |
| 日志泄露参数 | token / 密钥进日志 | 只记 `toolName` / `digest` / `argsLength`；不打印原始 args |

## 8. 上线与回滚

- 纯后端逻辑，无 DB 迁移、无前端发版、无配置变更。部署在 `/opt/mao` 执行：`git pull`、`cd backend-ts && npm ci && npm run build`、`bash scripts/restart-backend.sh`；`scripts/deploy-*` 只用于 admin / desktop，不部署后端。
- 实施时在 `CHANGELOG.md` 顶部当前版本「后端」小节补一条：完全相同的工具调用与结果连续多轮出现时，第 5/10 轮提示模型换策略、第 15 轮自动中止并标记失败，避免模型退化性重复消耗 token；长等待调用不参与中止。
- 同步在 `AGENTS.md` 的「规范」补一行：新增内置工具若结果含随机 id / 图片附件 / 传输字段，必须同步 `no-progress-notice.ts` 的按工具归一化与 `VOLATILE_RESULT_KEYS`，并补成功/失败用例。
- 回滚：revert 本次提交即可；无数据兼容问题。

## 9. 遗留与后续（不在本次范围）

1. 单轮最大轮次与 token 预算（方案 2）。
2. 模型侧：`step-5-preview` 的退化性重复需向供应商反馈或调整默认模型（方案 3）。
3. 若后续需要按工具类型差异化阈值（例如轮询类工具只提醒不中止），再把常量升级为工具级配置；本次已先做调用级豁免。
4. 可观测性增强：把 `[no-progress]` 计数接入用量/巡检看板，统计各模型的重复率。
5. 压缩摘要携带 streak：当前靠 `applyHistory` 重算 `tail`；若未来压缩边界把触发轮裁掉但仍希望连续提醒，才需要把 `tail` 写入压缩摘要。
6. A/B 两轮交替、参数微变、不同工具同语义的循环检测；需要更通用的周期检测或语义等价判断，不在本次范围。

## 10. 实施顺序

1. 先落 `no-progress-notice.ts` 纯函数与单测：`canonicalArgs`、`resultDigest(call)`（含 `shell` / 图片归一化）、`roundSignature`、`scanNoProgressNotices`（返回 `{ notices, tail }`）、`applyNoProgressNotices`、阈值与豁免常量。
2. 再落 `no-progress-guard.ts` 与状态机单测：`resetFrom` / seed、调用级豁免、5/10/15 动作序列。
3. 接 `agent-execution-context.ts`、`session-history-loader.ts`、`prompt-engine.ts`，先跑 §6.2 的运行时/重放逐字节一致测试。
4. 接 `agent-loop.ts`：`executeToolCalls` 传 guard、`closeRound()` 后压缩前的 nudge/abort、取消竞态复查、日志脱敏；跑 §6.4 集成用例。
5. 手工验证 §6.5 的 2210 / 2207 / 长构建 / 图片四类场景，再补 `CHANGELOG.md` 与 `AGENTS.md`。
