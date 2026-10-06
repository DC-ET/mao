# 上下文透视与手动治理技术方案：Context Manifest + 手动压缩 + 记忆注入可见

- 状态：技术方案，待实施（2026-10-06 修订：并入可行性评审修正——read_file 截断字段、空闲压缩 claim/合成 listener、SignalBus 生命周期与消费点位置、trigger_mode 显式传参、记忆开关生效口径；见决策 7、11-14）
- 日期：2026-10-06
- 提案来源：[docs/proposals/2026-10-06-context-inspector.md](../proposals/2026-10-06-context-inspector.md)

## 1. 需求背景

1. **有水位、无构成**：ws 事件 `context_window`（`ws-streaming-event-listener.ts` L157-160，payload `{ estimated, actual }`）→ `TaskInspector.vue` 的"上下文 N% "徽标（L59-68、L577-607）。但模型实际收到的内容是黑盒：`PromptEngine.buildSystemPrompt`（prompt-engine.ts L194-250）按 10 个节即时拼接（Agent 人格 / 最佳实践经验 / 长期记忆 / 工作环境 / 当前日期 / 工具指引 / 可用技能 / 任务管理与子代理 / embed 提示 / 工作区规则），中间产物不透出。
2. **压缩全自动、无人工干预**：`SessionCompactionOrchestrator.compact` 只有两个内部触发点——`HarnessService.buildContext` 末尾（request_start）与 `AgentLoop` 工具轮结束（mid_loop，agent-loop.ts L459-484）。`CompactionService.compactSession` 有阈值判定（`window × 0.8`，锚点实测优先），无任何外部入口。
3. **记忆注入丢弃选中信息**：`MemoryService.listForInjection`（memory.service.ts L216-234，USER 8 条 + PROJECT 12 条按 updated_at DESC）返回的 `MemoryHint { scope, projectKey, content }` **没有 id**，`longTermMemoriesHint` 直接拼 bullet 文本——"本次注入了哪些记忆条目"不可知，`MemoryView.vue` 里管理的是全量条目却无法与会话内注入对上号。
4. **截断不可见**：内容截断在各工具实现内完成，但标志形态不一——grep_search / glob_search / open_web_page / shell_session 的结果 JSON 自带顶层 `truncated` 字段；read_file（50000 字符上限）截断时只在 content 末尾追加文本标记 `\n... [output truncated]`，**没有**结构化字段（read-file-tool.ts L72-75）。loop 落库时不识别任何截断事实，前端 `ToolCallCard.vue` 只有自己本地 4000 字符截断（L203-213），后端截断没有徽标。

## 2. 需求描述

### 2.1 目标（全部要做）

1. **Context Manifest**：`buildRequest` 构建请求时同源产出上下文构成清单（系统提示分节 tokens、消息与交接摘要 tokens、注入记忆条目 id 列表），随 `context_window` 事件推送，检查器新"上下文"页签渲染。
2. **手动压缩**：新 ws 入站 `compact_now`——会话空闲立即压缩（越过阈值判定），运行中则在下一工具轮边界由 loop 执行；压缩事件 `trigger_mode='manual'`；摘要全文可读。
3. **单会话记忆注入开关**（默认开）+ 工具结果截断徽标（后端事实）。

### 2.2 非目标（明确不做）

- 不做上下文编辑 / 删除单条消息（只读透明化）。
- 不做检索增强（RAG 已否决）。
- 不做消息级 token 明细（先到分节级，见提案开放问题）。
- 不做跨会话上下文模板。
- 不改压缩策略默认值与既有自动触发行为。

## 3. 范围界定：做 / 不做清单

### 3.1 做什么

| 层 | 内容 |
|---|---|
| backend-ts | V138（`session.memory_injection_disabled` 列）；`PromptEngine.buildSystemPrompt` 分节 tokens 收集 + `buildRequest` 产出 `ContextManifest`；`AgentLoop` 三处 `onContextWindow` 触发点附带 manifest；`MemoryHint` 加 `id`；ws `context_window` payload 增 `manifest`；入站 `compact_now`（handler 属主校验）+ `CompactionSignalBus`（双向清理）+ `HarnessService.requestCompaction`（force 旁路阈值，全程持有 executionClaims）+ 空闲压缩合成 listener 下发事件 + `orchestrator.compact` 增显式 `triggerMode` 参数（manual 留痕）；`read_file` 结果补顶层 `truncated` 字段；`processToolResult` 嗅探结果 JSON `truncated:true` 写 metadata + meta 通道；`GET /v1/sessions/:id/compaction`（属主，摘要全文） |
| desktop | `TaskInspector.vue` 新"上下文"页签（分节占比 / 记忆条目跳转 / 手动压缩按钮 / 记忆注入开关）；`CompactionMarker.vue` 支持 manual 文案；`ToolCallCard.vue` 消费 metadata 截断徽标；`useStreamWS.ts` context_window payload 透传 |
| admin / 安卓 / mao-agent / mao-cli | 无改动（mao-cli 补文档说明） |
| 文档 | CHANGELOG；skills/mao-cli 检查器章节 |

### 3.2 不做什么（与"做"同等明确）

- 不新增独立 ws 事件类型（复用 `context_window` 通道加字段）。
- 不回填历史压缩摘要的展示（只读 `session_compaction` 现值）。
- 不做 `llm_call` 层面的分节 token 对账（锚点估算与真实计费 token 有口径差，UI 标注"估算"）。
- 不新增 Playwright 用例。

## 4. 技术选型

零新增依赖。分节 tokens 用现有 `TokenEstimator.countTokens`（UTF-8 字节 ÷ 4），纯内存计算；manifest 为 ≤ 15 个条目的小对象，随既有事件帧推送。手动压缩复用 mid-loop 既有挂点与 CAS 持久化，不引入与 loop 并发改 `context.messages` 的旁路。

## 5. 详细设计

### 5.1 V138 迁移与会话开关

```sql
ALTER TABLE `session`
    ADD COLUMN `memory_injection_disabled` TINYINT NOT NULL DEFAULT 0
    COMMENT '单会话关闭长期记忆注入：0=开启 1=关闭';
```

- 存取照 `permissionLevel` 模式：`UpdateSessionRequest` 加 `memoryInjectionDisabled?` → `session.routes.ts` PATCH handler 加一行 → `sessionService.updateMemoryInjectionDisabled`（`updateFields`）。
- 消费点：`HarnessService.loadMemories`（harness-service.ts L456-465）开头读 `session.memoryInjectionDisabled`，为 1 直接返回 null（`context.memories = null`，`longTermMemoriesHint` 自然不渲染）。
- **生效时机 = 下一次执行**：memories 在 `buildContext` 一次性装载进 `context.memories`（harness-service.ts L302），运行中的会话关闭开关后，本轮后续请求仍会注入、manifest 仍含记忆节——开关口径是"下一次执行生效"，不做请求级回读（每次 buildRequest 查库代价不成比例）。页签开关旁提示"将于下次任务开始时生效"，验收口径见 §11.2。

### 5.2 Context Manifest（与 buildRequest 同源）

```ts
interface ContextSectionStat { key: string; label: string; tokens: number; count?: number }
interface ContextManifest {
  sections: ContextSectionStat[];        // 系统提示各节 + messages + handoff 摘要
  memoryIds: number[];                   // 本次注入的记忆条目 id（开关关闭/无记忆时空数组）
  estimatedWindowTokens: number | null;  // 生效窗口（模型 contextWindowTokens 优先）
}
```

- **产出点 = 唯一真相源**：`buildSystemPrompt` 改为内部逐节构建 `sections: Array<{ key, text }>` 后 join——拼接结果与现输出**逐字节一致**（重构约束，单测锚定：join 后字符串 === 现 `buildSystemPrompt` 返回值）。每节 `tokens = TokenEstimator.countTokens(text)`。
- `buildRequest` 在组装完成后补两类节并写入 `context.contextManifest`（`AgentExecutionContext` 增可选字段）：
  - `messages`：以**最终 `request.messages`**（quick command 展开、媒体注入、`MessageHistoryNormalizer.normalizeChatMessages` 之后）扣除 system 消息，`TokenEstimator.estimateMessages` + count——禁止用组装前的 `context.messages` 口径（与 §8 漂移对策同一句话：manifest 只读最终请求对象）；
  - `handoff`：直接读 `context.sessionSummary`（`applyHistory` 已写入的结构化字段，agent-execution-context.ts L37），非空即含该节，token 按 `buildHandoffUserMessage(summary)` 产物估算，无则不含该节。不做"首条消息前缀嗅探"——用户首条消息恰好以 `## 会话任务交接` 开头会误判。
- `memoryIds`：`MemoryHint` 增 `id: number`（`memory.service.ts` `listForInjection` 返回行本就持有 id，纯透传，bullet 文本拼接不变）；`context.memories` 携带 id → manifest 收集。
- **推送**：`AgentLoop` 三处 `onContextWindow` 调用点（L229 请求前 / L296 onComplete / L468 mid-loop 判定）与 orchestrator `resetContextAnchor`（L133）扩展为 `onContextWindow(estimated, actual, manifest?)`（可选第三参，listener 接口向后兼容）；`ws-streaming-event-listener.ts` payload 变为 `{ estimated, actual, manifest? }`，`updateContextTokens` 副作用不变。
- desktop：`ContextWindowInfo` 类型加 `manifest?`；`useStreamWS.ts` 无需改分发（整体 data 透传 store）。

### 5.3 检查器"上下文"页签

- `TaskInspector.vue`：`inspectorActiveTab` 联合类型加 `'context'`（L6-30 按钮组 + L305 ref），新增页签内容：
  - **构成条形列表**：每个 section 一行（label + tokens + 占窗口百分比，进度条按 `maxTokens`（`useModelContext`）归一）；标注"估算口径"tooltip。分节合计只含系统提示 + messages + handoff，**不含工具定义**（`estimateRequestTokens` 的 tools 项），与 `context_window` 锚点实测水位（含 tools）天然有差——tooltip 说明该口径差，避免被当成 bug。
  - **记忆条目**：`memoryIds` 渲染 chip 列表（snippet 取 manifest 不够——直接按 id 调 `/v1/memory` 现有列表接口本地匹配 content），点击跳 `/settings/memory`；节头放"本会话注入"开关（el-switch，PATCH 会话字段，下一次执行起 manifest 无记忆节，见 §5.1 生效时机，开关旁提示生效时机）。
  - **手动压缩**：按钮"立即整理上下文"（运行中显示"将在本轮工具结束后执行"提示态）；下方"查看上次摘要"折叠面板，懒加载 `GET /v1/sessions/:id/compaction` 渲染 `summary_text` 全文 + compact_count / compact_model / 更新时间。
- CompactionMarker：`triggerLabel` 映射加 `manual → '手动整理上下文'`。

### 5.4 手动压缩（`compact_now`）

- **入站**：`streaming-ws-handler.ts` dispatch 加 `case 'compact_now'` → `handleCompactNow`，复用 handler 既有属主校验（`session.userId !== userId` 即拒，同 L2004 先例）。
- **空闲路径**（`hasExecutionClaim(sessionId)` 为 false）：
  1. **先占 claim 再动作**：`executionClaims.add(sessionId)` 与空闲判定之间不留 await（Node 单线程内同拍完成），claim 全程持有、finally 释放——压缩期间 `send_message` 被既有 `session_already_running` 语义拒绝，消除 check-then-act 竞态，也避免压缩中途的 `clearContextAnchor` / 锚点重置被并发执行的锚点更新踩踏；
  2. `HarnessService` 新公开方法 `requestCompaction(sessionId, listener)`：
     - `buildContext(sessionId, listener, /*cancelFlag*/ null, /*skipAutoCompact*/ true)`（新增可选参数，跳过其末尾的阈值检查，避免"自动一次 + 手动一次"双重压缩）；
     - `orchestrator.compact(sessionId, context, preparedRequest, listener, config, /*compactCurrentTurn*/ false, null, activeTokensHint, /*force*/ true, /*triggerMode*/ 'manual')`；
     - 结束后回收 `buildContext` 连上的云 MCP：`closeBoundCloudMcp` 目前只在失败路径调用（harness-service.ts L439-442），手动压缩的成功路径同样要回收，否则连接泄漏；
     - 已知限制：压缩 LLM 调用不可取消（无既有取消通道；压缩为单次 LLM 调用的短任务，接受，文档标注）；
  3. **listener 必须存在**：空闲时并无执行级 `WsStreamingEventListener`，`handleCompactNow` 合成一个（`executionId = manual_compact_<ts>`、supportsVision=false，不影响 compaction_* / context_window 事件形态），结束 `dispose()`——否则压缩全程 UI 失明：无 compaction_start/end、消息区无分隔线、水位不刷新，§11.3 验收不成立；
  - `CompactionService.compactSession` 增 `force` 参数：跳过 `triggerThreshold` 判定（compaction-service.ts L93-96），其余流程（交接指令、纠偏重试、CAS 持久化、归档、锚点重置）完全复用；`harness.compaction.enabled=false` 时 manual 仍允许（自动关闭 ≠ 禁止人工动作，决策 6）。
- **运行中路径**：新 `CompactionSignalBus`（`Map<sessionId, true>`）——有 claim → `bus.signal(sessionId)` + ws 回执"已排队"；无 → 走空闲路径。
- **信号生命周期（与 cancelFlags 同款到底）**：信号在执行体外置位，必须双向清理——`AgentLoop.execute` 启动时丢弃陈旧信号（上一轮执行结束前未被消费的残留）、finally 随 `cancelFlags.delete` 一并 `bus.clear(sessionId)`；否则运行中置位后本轮走到最终回答（不再有工具轮边界）时信号残留，下一次执行首个工具轮边界会发生一次用户未请求的压缩。
- **loop 消费点在 `midLoopAllowed` 门槛之外**：`AgentLoop` 工具轮结束处、`if (midLoopAllowed && loopConfig)`（L464）判定**之前**先查 `bus.consume(sessionId)`，置位则无条件执行 `orchestrator.compact(..., compactCurrentTurn=true, force=true, triggerMode='manual')`（与 mid_loop 同挂点同互斥语义，压缩后重建 `preparedRequest`），随后继续原 mid_loop 判定。注意 L459-484 现有挂点整体在 `midLoopAllowed`（要求 `enabled && loopMidwayCompact && persistenceCallback && sessionId`）之内，而决策 6 规定 `enabled=false` 不禁止手动——消费点放错进门槛内会让手动压缩随自动开关一起失效。手动路径同样要求 `persistenceCallback != null && context.sessionId != null`，不满足时忽略信号（与空闲路径前提一致，属防御分支）。
- **trigger_mode 显式传递**：`orchestrator.compact` 追加显式 `triggerMode` 参数——现 L104 由 `compactCurrentTurn ? 'mid_loop' : 'request_start'` 推导，force 旁路后两条手动路径都会被写成错误的既有值（空闲=false→request_start、loop 内=true→mid_loop）。既有两处调用点分别补 `'request_start'`（buildContext L423）/ `'mid_loop'`（agent-loop L471），manual 两处显式传 `'manual'`；`session_compaction_event.trigger_mode` 为 VARCHAR(32) 无枚举约束，直接落库；`CompactionMarker` 前端映射同步。

### 5.5 压缩摘要读取端点

```
GET /v1/sessions/:id/compaction   （登录用户，requireSessionOwner）
```

- 返回 `{ summaryText, lastCompactedMsgId, compactCount, compactModel, updatedAt } | null`（无压缩记录时 data 为 null，不算错）。
- 摘要经站内同款脱敏视角输出：摘要由 LLM 从会话内容生成，若工具结果含 `$MAO_REDACTED` 脱敏标记则摘要继承该形态——不做二次脱敏，文档写明口径。

### 5.6 工具结果截断徽标

- **前置（工具侧唯一改动）**：`read_file` 截断时结果补顶层 `truncated: true`（现仅 content 尾部 `[output truncated]` 文本标记，read-file-tool.ts L72-75；与 grep/glob/open_web_page/shell_session 口径对齐，read-file spec 同步补断言）。
- **嗅探**：`AgentLoop.processToolResult`（agent-loop.ts L582-597）落库前嗅探：结果文本可 JSON parse 且顶层 `truncated === true` → `metadataJson` 合并 `{ resultTruncated: true }`（与 `approvalMark` 同走 `mergeMetadata` 通道；嗅探失败静默跳过）。
- **实时通道**：嗅探结果由 `processToolResult` 随 `ToolMessageSave` 带回（增布尔字段），`executeToolCalls` 写入 `ToolCallResultMeta`（增可选 `resultTruncated`）。注意 approvalMark 先例（listener L126 `meta?.approvalMark`）取的是 ToolResult→meta 执行层通道，**不是**落库 metadataJson——两条通道各管一半：实时事件走 meta、历史回放走 metadata，勿混写。`ws-streaming-event-listener.ts` `tool_call_result` payload 增 `result_truncated`（取 `meta.resultTruncated`）。
- `ToolCallCard.vue` 结果区加"输出已截断"徽标（区别于本地 4000 字符截断的"展开完整输出"——两者可并存：徽标表示后端截断，展开按钮展示的仍是落库后的已截断文本）。
- 消息历史回放：`toMessageVO` 的 metadata 原样 JSON 透传（session-vo.ts L301 已核实），前端从 `message.metadata` 解析即可，无后端改动。

## 6. 实施步骤

### P1：Manifest 与上下文页签（backend + desktop）

1. `buildSystemPrompt` 分节化重构（逐字节等价单测先行）+ manifest 组装 + `MemoryHint.id` 透传。
2. `onContextWindow` 第三参 + ws payload + desktop 类型/store。
3. `TaskInspector` 上下文页签（构成列表 + 记忆 chips + 跳转）。

### P2：手动压缩（backend + desktop）

1. `compact_now` 入站 + `CompactionSignalBus`（双向清理）+ `requestCompaction`（force / skipAutoCompact / claim 持有 / 合成 listener / MCP 回收）+ loop 边界消费（`midLoopAllowed` 门外）+ `orchestrator.compact` 显式 `triggerMode` 参数。
2. `GET /v1/sessions/:id/compaction`；CompactionMarker manual 文案；页签内按钮与摘要面板。

### P3：记忆开关与截断徽标（backend + desktop）

1. V138 + PATCH 链路 + `loadMemories` 短路 + 页签开关（含生效时机提示）。
2. `read_file` 补 `truncated` 字段（含 spec）+ `processToolResult` 嗅探（metadata + meta 双通道）+ ws 透传 + ToolCallCard 徽标。

## 7. 测试方案（全部 Vitest）

- **等价性锚定**：`buildSystemPrompt` 分节 join 后与重构前快照逐字节一致（各通道组合：普通 / embed / 微信 / LOCAL / CLOUD；含 memories 有/无、experiences 有/无、AGENTS.md 200 行截断分支）。
- manifest：分节 tokens 合计 ≈ 系统提示总估算（容差 = 节数 × 每条 overhead）；handoff 节有/无两态（以 `sessionSummary` 驱动）；`memoryIds` 与 `listForInjection` 选中行一致；开关关闭后 memories=null 且 manifest 无记忆节。
- ws：`context_window` 带 manifest 的 payload 结构与 size 上限（manifest 序列化 ≤ 8KB，超限裁剪 memoryIds）。
- 手动压缩：空闲（force 越过阈值，trigger_mode='manual'，锚点重置 + `onContextWindow(requestTokens, 0)`，合成 listener 下发 compaction_start/end/marker）；运行中（signal → 下一个工具轮边界执行 → `preparedRequest` 重建 → 本轮后续请求 token 下降）；enabled=false 时 manual 仍可执行；CAS 冲突路径不受影响。
- 并发与生命周期：空闲压缩期间 `send_message` 被 `session_already_running` 拒绝、压缩结束 claim 释放；执行结束未消费的陈旧信号在下一次执行启动被丢弃、不触发压缩；trigger_mode 显式传参后既有 `request_start` / `mid_loop` 不回归。
- `compact_now` 越权（他人会话）拒绝；重复点击去抖（signal 幂等）。
- 摘要端点：属主校验、无记录返回 null、越权 403。
- 截断：read_file 截断结果含顶层 `truncated:true`（新字段 spec）；结果含顶层 `truncated:true` → metadata 落库 + meta 通道 + ws 透传；非 JSON / 无标志不落；与 `approvalMark` 共存不互覆。

## 8. 风险与对策

- **"所见即所发"漂移（最高风险）**：manifest 必须在 `buildRequest` 构建路径内产出，禁止事后重建；等价性快照单测 + `messages` 节取自最终 `request.messages`（注入与归一化之后）双保险。
- **buildSystemPrompt 重构回归面**：10 个节的条件组合多（embed/微信/LOCAL 分支）。对策：重构纯机械（收集-拼接分离），快照测试覆盖全部通道组合后再接 manifest。
- **空闲手动压缩的并发面（本轮评审新增）**：压缩全程持有 executionClaims（判定与占坑之间无 await），发送被 `session_already_running` 拒绝；SignalBus 双向清理防陈旧信号在下次执行意外触发压缩；合成 listener 保证压缩事件可见；成功路径回收云 MCP 连接。
- **运行中压缩的共享状态**：坚持 loop 边界消费 signal，不旁路并发改 `context.messages`；`CompactionSignalBus` 仅布尔信号，无数据面。
- **估算偏差**：分节 token 为字节估算，与计费 prompt_tokens 有差（锚点法同源），UI 明示"估算"；分节合计不含工具定义，与水位有口径差，tooltip 说明。对账需求明确为非目标。
- **摘要敏感信息**：摘要来自会话内容（含被脱敏工具结果的形态），读取端点限属主 + 前端折叠默认收起，不新增脱敏管线。
- **manifest 推送频率**：与 `context_window` 同频（每轮 1-2 次），payload 小；长会话 memoryIds 有上限（8+12），无膨胀。

## 9. 落地清单

- [ ] `buildSystemPrompt` 分节化 + 等价性快照测试
- [ ] `ContextManifest` 产出与推送（含 `MemoryHint.id`；messages/handoff 以最终请求与 `sessionSummary` 为源）
- [ ] TaskInspector 上下文页签（构成 / 记忆 chips / 跳转 / 开关生效时机提示 / 水位口径 tooltip）
- [ ] `compact_now` + SignalBus（双向清理）+ `requestCompaction`（claim 持有 + 合成 listener + MCP 回收）+ loop 边界消费（`midLoopAllowed` 门外）+ `triggerMode` 显式参数 + manual 留痕
- [ ] `GET /v1/sessions/:id/compaction` + 摘要面板 + CompactionMarker manual 文案
- [ ] V138 + 会话记忆开关全链路（下一次执行生效口径）
- [ ] `read_file` 补顶层 `truncated` 字段（含 spec）+ `processToolResult` 截断嗅探（metadata + meta 双通道）+ ToolCallCard 徽标
- [ ] CHANGELOG + skills/mao-cli 同步 + proposals 状态更新

## 10. 决策记录（相对提案的修正与确认）

1. **manifest 与 buildRequest 同源产出是硬不变量**：提案写"数据全部来自同一路径"，本方案落为"分节文本收集后 join，join 结果逐字节等于系统提示"的快照测试；事后重建被明确禁止。
2. **复用 `context_window` 事件加字段，不新增事件类型**：前端 `STREAM_EVENT_TYPES`、store 分发、冷启动兜底（TaskView 拉 `meta.contextTokens`）全部不用动。
3. **`MemoryHint` 加 id 是记忆透视的前置**：注入选中信息目前被丢弃（`MemoryHint` 无 id），本方案在透传层补齐，bullet 文本与注入行为零变化。
4. **手动压缩走 loop 工具轮边界，不做旁路并发**：`context.messages` / `preparedRequest` 是 loop 的活跃可变状态，旁路压缩会产生竞态；运行中信号化 + 边界消费与 mid_loop 既有机制同构。
5. **`force` 旁路只作用于阈值判定**：交接指令、纠偏重试、物理前缀校验、CAS 持久化、归档、锚点重置全部复用，手动压缩没有第二条压缩实现。
6. **`harness.compaction.enabled=false` 不禁止手动压缩**：该开关语义是"自动整理"，manual 是用户显式动作；文档标注。
7. **截断标识以"结果 JSON 顶层字段"为唯一嗅探口径，loop 层统一落标识**：grep/glob/open_web_page/shell_session 已自带 `truncated`；`read_file` 需补齐该字段（首轮方案误记其已具备——它目前只有 content 尾部 `[output truncated]` 文本标记，无结构化字段，read_file-tool.ts L72-75 已核实）；非 JSON 结果（纯文本工具输出）不产生徽标，属已知边界。
8. **token 均为估算口径**：分节估算与锚点估算同源（TokenEstimator），与计费 token 的偏差不在本方案解决，UI 标注。
9. **检查器用新页签而非 workspace 分区**：构成 + 记忆 + 压缩操作已超出"任务信息"区块的密度，独立页签与 workspace/filetree/git 平级，导航成本最低。
10. **记忆条目跳转不做高亮定位**：P1 先做页级跳转（`/settings/memory`），行级定位（query 带 id 滚动定位）等使用反馈再定。
11. **空闲手动压缩全程持有 executionClaims 并合成 listener**（本轮评审补充）：空闲判定与占坑之间不留 await 窗口，压缩期间发送被既有 `session_already_running` 语义拒绝；压缩事件经合成 `WsStreamingEventListener`（合成 executionId、结束 dispose）下发，UI 不失明；成功路径回收云 MCP。
12. **SignalBus 双向清理 + loop 消费点置于 `midLoopAllowed` 之外**（本轮评审补充）：执行启动丢弃陈旧信号、finally 清理；`enabled=false` 只关自动，手动消费点不得落入 `midLoopAllowed` 门槛（否则手动压缩随自动开关一起失效）。
13. **`trigger_mode` 显式参数化**（本轮评审补充）：`compact()` 现按 `compactCurrentTurn` 推导 trigger mode，对两条 manual 路径必然写错值，改为调用点显式传入；既有调用点同步补参。
14. **记忆开关口径为"下一次执行生效"**（本轮评审补充）：memories 在 buildContext 一次性装载，运行中会话不回灌、不做请求级回读；UI 提示生效时机（修正首轮验收 2"下一轮请求"的不准确表述）。

## 11. 验收口径

1. 长会话运行中打开检查器"上下文"页签：可见系统提示各节与消息的 token 占比，记忆条目 chip 与设置页条目一一对应，点击可跳转管理。
2. 关闭"本会话注入"后**下一次执行**的系统提示不含 `## 长期记忆` 节，manifest 同步消失；重开后恢复。运行中会话关闭不回灌本轮（开关旁有"下次任务开始时生效"提示）。
3. 会话空闲点击"立即整理上下文"→ 生成 trigger_mode='manual' 的压缩事件、消息区出现"手动整理上下文"分隔线、上下文水位下降，且 compaction_start/end 过程事件实时可见（合成 listener）；压缩进行中发送消息被 `session_already_running` 拒绝、结束后恢复。运行中点击 → 本轮工具结束后执行，无竞态异常。
4. "查看上次摘要"可读全文；无压缩历史的会话显示空态。
5. read_file 大文件后对应 ToolCallCard 出现"输出已截断"徽标（grep_search / open_web_page 截断同样出徽标）；普通工具卡片无变化。
6. 全量 `cd backend-ts && npm test` 通过，含 `buildSystemPrompt` 等价性快照；新增 spec 覆盖 §7 全部用例。
