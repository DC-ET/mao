# 任务台账跨压缩保留与动态注入技术方案

日期：2026-11-25　|　范围：backend-ts（harness）　|　状态：已评审修订（2026-11-25 评审结论：需求与方案均可行；本次修订含 P1 hook 语义修正、P2 刷新盲区、P3 短变体措辞、P4 并发时序、P5 装配路径勘误）

## 0. 结论

两处改动，全部在 backend-ts，无 DB 迁移、无前端/协议改动：

1. **改动一（压缩摘要保留台账）**：`buildHandoffInstruction` 的保留清单新增一条——会话用过 task_* 待办时，摘要必须原样保留当前任务台账（每项 id / content / status 与当前 in_progress 项），并以最近一次 task_* 工具结果为准。解决「压缩后台账消失、task_update 无从调用」。
2. **改动二（任务台账动态注入）**：仿照 no-progress 提醒的既有先例，新增「任务台账 `<system-notice>`」注入到请求副本尾部（不落库）。刷新点：`applyHistory`（覆盖执行开始 + 压缩重载两条路径）与 agent-loop 中 task_* 工具执行后（直接从工具结果解析，免查库）。刷新语义：task_* 结果**解析成功时一律以结果重建**（台账删空 → notice 置 null），仅解析失败 / 非 task 工具才保留旧值——避免删光后旧台账残留（评审 P1）。解决「未压缩的长任务里任务纪律不在场」与「压缩后立即恢复台账在场」。

预期效果：压缩/长程执行后模型始终能看到权威任务台账（含 id），补标 completed 有据可依；任务面板不再出现「长期 0/N 已完成」。模型遵从性仍是概率问题，收尾对账（原方案 3）不在本期。

## 1. 现状与根因

现象（2026-11-25 会话 #3066）：复杂目标型任务长时间执行、中途触发压缩，结束后任务面板 0/7 已完成，仅首个任务停在 in_progress。

根因链（详见当日会话分析）：

- 任务状态在模型侧只存在于历史消息中的 task_* 工具结果；`session_todo` 表有权威状态但从不回注上下文（context-manager / compaction-service / prompt-engine 均无 todo 引用）。
- 压缩后上下文 = system 提示 + `<handoff>` 摘要 + 边界后增量消息。摘要指令 `buildHandoffInstruction`（`backend-ts/src/harness/core/compaction-service.ts:391-404`）的保留清单未要求保留任务台账及其 id，压缩后 id 全部丢失。
- 系统提示中的任务纪律（`TOOL_USAGE_GUIDANCE`、`toolBehaviorHints`，`backend-ts/src/harness/core/prompt-engine.ts:37`、`:795-803`）是静态文案，不含动态清单；`task_update` 的「全部完成→写总结」引导只在模型已主动标完成后才出现。
- agent-loop 无轮次上限，循环直到模型纯文本收尾（`agent-loop.ts:442-449`）；收尾时无任务对账。长程执行中 flash 级模型指令遵循衰减（会话中出现 `sleep 180` 轮询即为证据），最终整场执行零补标。

## 2. 目标与非目标

### 2.1 目标

- G1：压缩发生后，模型在下一次请求中即可看到完整任务台账（含每项 id），可直接调用 `task_update` 补标。
- G2：未压缩的长任务中，任务台账与纪律在每次请求尾部持续在场（含进度）。
- G3：不破坏 system 提示前缀缓存：notice 处于请求尾部、内容确定性生成，状态不变时逐字节稳定。
- G4：台账以 DB / 最近工具结果为唯一权威，模型无需重建清单。

### 2.2 非目标

- 不做收尾自动对账 / 产物反推任务状态（原方案 3，另行评估）。
- 不改 task_* 工具语义、参数与结果结构，不改前端任务面板，不改 DB 表结构。
- 不解决弱模型的遵从率本身（本方案只提升可见性与纪律在场率）。

## 3. 方案

### 3.1 改动一：压缩摘要指令保留任务台账

文件：`backend-ts/src/harness/core/compaction-service.ts`，`buildHandoffInstruction`（约 :391-404）。

在保留清单（「- 用户目标…」至「- 工具调用产生的关键事实…」）后追加一条固定文案：

```text
- 若会话使用过 task_* 待办工具：必须以最近一次 task_* 工具结果为准，原样保留当前任务台账——每项的 id、content、status，以及当前处于 in_progress 的任务；已 completed 的项可只记标题与状态。压缩后你更新任务状态需要这些 id；会话未使用过待办工具时省略本节。
```

要点：

- 固定文案、逐字节稳定，只出现在压缩请求的追加 user 消息里，不影响常规请求前缀。
- 摘要 token 预算（`maxSummaryTokens`）内新增约 50 tokens 文案 + 台账本体（7 项约 100-200 tokens），可接受。
- 明确「以最近一次 task_* 结果为准」，避免摘要模型从多条历史结果中抄出中间态。
- 不要求摘要模型调用工具（既有约束保留：压缩响应出现 tool calls 即整体作废）。

### 3.2 改动二：任务台账 `<system-notice>` 请求副本注入

仿照 no-progress 提醒（`backend-ts/src/harness/core/no-progress-notice.ts`）的分层：纯函数模块 + 上下文字段 + 刷新点 + 渲染点。

#### 3.2.1 纯函数模块（新增）

文件：`backend-ts/src/harness/core/todo-state-notice.ts`（新增）+ `todo-state-notice.spec.ts`。

- `buildTodoStateNotice(todos: SessionTodo[]): string | null`：入参按 `sort_order ASC, id ASC`（mapper 查询口径）渲染；todos 为空返回 null。输出确定性、无时间戳，形如：

```text
当前任务台账（系统注入的权威状态，不要向用户复述本条）：
- #12 completed 实现后端流式读取与快照写入
- #13 in_progress 实现 Docker / LOCAL 服务端窗口拉取协议
- #14 pending 实现下载票据与 Range 协议
进度：0/3 已完成。
请维持任务纪律：每完成一项，立即用 task_update 将该项标记为 completed（带上对应 id），并将下一项置为 in_progress；不要批量补标，也不要重复本清单。
```

  全部 completed 时输出**中性短变体**：`任务台账：N/N 已完成。`。不含「请直接撰写最终总结」类催收尾修辞——该修辞保留在 `task_update` 结果 hint（`task-tools.ts:234-247`，仅在实际发生 completed 流转的那一轮随工具结果出现一次）。台账 notice 是每轮在场：若沿用催收尾措辞，用户发来无关新消息的执行首请求、以及全 completed 后的补验证轮，都会被每轮催促收尾，对弱模型是收尾偏向（评审 P3）。
- 渲染硬化：content 单行折叠（换行折叠为空格）并截断（超过 80 字符截断加 `…`）。`task_create` 对 content 无长度/格式限制，多行/超长标题会撑爆清单可读性与 token 预算；截断不破坏确定性（同输入同输出）。id 渲染用模板插值（`#${id}`），不依赖 JSON 序列化——工具结果路径（解析 JSON）与查库路径（`Db.query` 经 `toCamelList`）的 id 数值/字符串形态差异不影响输出字节。
- `noticeFromTaskToolResult(toolName, resultContent): { ok: true, notice: string | null } | null`：toolName ∈ {task_create, task_update, task_list, task_delete} 且结果 JSON 含 `todos` 数组（四种工具结果均返回 todos，`task-tools.ts:89`、`:126`、`:231`、`:323`）时返回 `{ ok: true, notice }`——notice 按结果重建，**台账删空时为 null，调用方必须覆盖旧值**；解析失败或非 task 工具返回外层 null（调用方保留旧值）。禁止「成功也返回 null 再靠 `??` 兜底」的写法：那会把「删空清空」与「解析失败」混为一谈——删光全部待办后旧台账（含已删除 id）会持续在场，而 `task_update` 对已删除 id 是 0 行静默成功（`updateFields` 无报错、仍回 `已将任务 #N 更新为 completed`，`task-tools.ts:223-228`），模型会对幽灵台账持续假补标（评审 P1，必须修）。

#### 3.2.2 上下文字段

`backend-ts/src/harness/core/agent-execution-context.ts` 新增：

```ts
/** 当前任务台账 notice 文案（null = 无待办 / 尚未构建）。请求副本注入用，不落库。 */
todoStateNotice: string | null = null;
```

#### 3.2.3 刷新点（不变式：进入下一次 buildRequest 前，notice 与权威状态一致）

1. **`applyHistory` 末尾**（`backend-ts/src/harness/core/session-history-loader.ts`，与 `scanNoProgressNotices` 重算同点，:69-74）：注入 `SessionTodoMapper` 依赖，查 `listBySession(context.sessionId)` 重建 `context.todoStateNotice`；查库失败降级为 null 并记 warn，不阻断（与 `resolvePreviousUserYmdBefore` 同构容错）。该函数同时被执行开始（`harness-service.ts:442`）与压缩重载（`session-compaction-orchestrator.ts:116`）调用，一个钩子覆盖两条路径。
2. **agent-loop task_* 工具执行后**（`backend-ts/src/harness/core/agent-loop.ts`，`executeToolCalls` 的单调用分支与并行分支的处理循环内，与 :739/:758 的 summarizer 挂点同位置；解析对象取 `processToolResult` 改写之前的 `rawResult` 原始 JSON）：解析成功（外层非 null）才赋值，`context.todoStateNotice = parsed.notice`（notice 为 null 时同样赋值，即清空）；解析失败 / 非 task 工具不赋值，保留旧值。直接用工具结果免查库。

   并发时序注（评审 P4）：同轮多个 task_* 经 `Promise.all` 并发执行，各结果的 `todos` 是各自执行后的 DB 快照，最后处理的调用未必对应最后一次 DB 操作，notice 可能落后一个操作——下一轮 task_* / 下一次 applyHistory 自愈，属可接受降级，spec 勿对多 task 并发轮做 notice 字节级强断言。

preparedRequest 一致性：mid-loop 压缩成功后 `preparedRequest` 在 :587 重建，晚于上述两个刷新点，天然包含新 notice；未压缩时 `preparedRequest` 为 null，下一轮 :244 全新构建。无需额外失效逻辑（与后台结果注入 :224/:241 的既有约束不同源，勿混淆）。

#### 3.2.4 渲染点

`backend-ts/src/harness/core/prompt-engine.ts` `buildRequest`：在 `applyNoProgressNotices`（:228）之后，若 `context.todoStateNotice != null`，追加尾消息：

```ts
rendered.push({ role: 'user', content: wrapNotice(context.todoStateNotice) });
```

`wrapNotice` 复用 `no-progress-notice.ts:251` 的 `<system-notice>` 包裹。

缓存与既有机制兼容性：

- notice 处于请求尾部；`prompt-prefix-monitor` 既有约定「尾部追加不告警」（:253-255 注释），状态不变时逐字节稳定，前缀缓存只在状态变化时于尾部失效一小块。
- 以 `<system-notice>` 开头 → `isRealUserMessage` 判 false（`compaction-service.ts:41`），不会被误当真实用户消息；notice 只存在于请求副本，不落库、不进 `context.messages`，与压缩边界判定无交集。
- 压缩摘要请求 `deriveRequest` 复制的是 `context.messages`（无 notice），摘要生成依赖改动一；压缩后 `applyHistory` 刷新 notice，:587 的 preparedRequest 立即携带。
- manifest 不新增分节：notice token 计入「会话消息」行（`buildContextManifest` 按 finalMessages 估算，自动包含）。

## 4. 改动文件

| 文件 | 改动 |
| --- | --- |
| `backend-ts/src/harness/core/compaction-service.ts` | 改动一：`buildHandoffInstruction` 追加一条保留清单 |
| `backend-ts/src/harness/core/todo-state-notice.ts`（新增） | 改动二：纯函数 `buildTodoStateNotice` / `noticeFromTaskToolResult` |
| `backend-ts/src/harness/core/todo-state-notice.spec.ts`（新增） | 纯函数用例 |
| `backend-ts/src/harness/core/agent-execution-context.ts` | 新增 `todoStateNotice` 字段 |
| `backend-ts/src/harness/core/session-history-loader.ts` | `applyHistory` 末尾刷新 notice；构造注入 `SessionTodoMapper` |
| `backend-ts/src/harness/core/agent-loop.ts` | task_* 工具执行后从结果重建 notice |
| `backend-ts/src/harness/core/prompt-engine.ts` | `buildRequest` 尾部注入 notice |
| `backend-ts/src/create-app.ts` | `todoMapper`（:571 已有实例）线程进 `LlmEngineDeps` |
| `backend-ts/src/app-llm-engine.ts` | `SessionHistoryLoader` 构造（:120，全仓唯一构造点）补 `SessionTodoMapper` 参数 |
| 对应 spec | `compaction-service.spec.ts`、`session-history-loader.spec.ts`、`agent-loop.spec.ts`、`prompt-engine.spec.ts` 补用例 |

单期交付，无分期。

## 5. 测试与验收

单测（`cd backend-ts && npm test`，输出先落盘再 grep 摘要）：

- `compaction-service.spec.ts`：扩展 `handoffInstructionMentionsArchiveAndForbidsFabricatedPath` 风格断言，指令含新条目关键词（task_、id、status、in_progress）。
- `todo-state-notice.spec.ts`：空列表 → null；同输入两次输出逐字节一致（确定性）；含 id/content/status/进度行；全 completed 中性短变体（不含催收尾修辞，评审 P3 回归）；content 多行折叠 / 超长截断；`noticeFromTaskToolResult` 对四种工具结果形状均返回 `{ ok: true, notice }`，其中 task_delete 删空 → `{ ok: true, notice: null }`（评审 P1 回归），非 task 工具 / 坏 JSON → 外层 null。
- `session-history-loader.spec.ts`：`applyHistory` 后 `context.todoStateNotice` 来自 mapper 数据；mapper 抛错 → null 且不抛出、历史装载不受影响。
- `agent-loop.spec.ts`：task_update 执行后下一请求副本尾部出现 `<system-notice>` 台账；非 task 工具轮 notice 保持不变；task_delete 删光全部待办后下一请求不再含台账 notice（覆盖旧值路径，评审 P1 回归）；notice 状态不变时两次 buildRequest 渲染结果逐字节一致（前缀缓存验证）；多 task 并发轮不做 notice 字节级强断言（评审 P4，见 §3.2.3 时序注）。
- `prompt-engine.spec.ts`：notice 渲染在最终消息末尾；无 notice 时请求与现状逐字节一致（回归兜底）。

验收口径（对照本次事故）：

- 构造「建 7 项任务 → 数百轮执行 → 强制压缩 → 继续执行」的集成用例（复用 agent-loop.spec 既有压缩测试脚手架），压缩后首个请求的副本含完整台账，模型可在无历史 task 结果的情况下依据 id 调用 task_update 成功。
- 不在验收范围（已知盲区，见 §6）：任务面板经 `PATCH/DELETE /v1/sessions/:id/todos/:todoId` 在执行中改台账，notice 到下一次 task_* / applyHistory 才对齐。
- Playwright 不涉及（无 UI 改动）。

## 6. 风险与待确认

- **模型复述台账**：notice 文案已含「不要向用户复述本条」；若实测仍复述，再收敛为「仅在状态变化轮注入」的次级方案（默认不做，保持每轮在场）。
- **摘要与 notice 短暂不一致**：摘要由模型抄写，可能有出入；notice 以 DB/工具结果为权威，摘要仅供叙事。不改摘要生成路径之外的逻辑。
- **面板改台账的刷新盲区（已知限制，评审 P2）**：任务面板可经 `PATCH/DELETE /v1/sessions/:id/todos/:todoId`（`backend-ts/src/session/session.routes.ts:745/:761`）在执行中改台账，两个刷新点都覆盖不到，notice 与 DB 脱钩，直到下一次 task_* 调用或下一次 `applyHistory`（下一执行开始）才对齐、自愈。§3.2.3 的「进入下一次 buildRequest 前 notice 与权威状态一致」仅在「DB 变更均来自 task_* 工具」时全域成立。本期不加 REST 侧 hook，代价窗口小。
- **token 成本**：每请求尾部约 150-250 tokens（7 项规模），可接受；manifest「会话消息」行会如实反映。
- **遵从率不保证 100%**：本方案消除「台账不可见」这一结构性根因；flash 级模型长程遵循仍可能漂移，收尾对账（原方案 3）与产物挂钩（原方案 4）留作后续。
- **依赖注入变更**：`SessionHistoryLoader` 构造签名变化，既有测试需同步补参（与 workspace-rules-snapshot 可选注入先例同款处理，可考虑带默认值保持旧测试零改动）。

## 7. 文档同步

- `changelog/unreleased/2026-11-25-task-todo-retention.md`：backend-ts 小节，写用户可见效果（压缩/长任务后任务进度可正常推进，不再出现长期 0/N）。
- README.md / DEPLOY.md：无部署与运维变化，不需要改。
- skills/mao-cli/SKILL.md：实现时核对该文档是否描述任务面板行为，如无描述则不改。
- 打包/发版前在 main 上跑 `./scripts/changelog-cut.sh`（既有流程，不在本任务内）。
