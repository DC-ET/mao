# 代码审查报告：PROXY（替我审批）第五级权限

日期：2026-09-30
范围：本次需求全部未提交改动（PROXY 权限级、Jev 前置决策、审批模型配置、审批标记前端展示、「智能审批」改名「智能预审」）
结论：**未发现阻断性或高严重度功能 bug；发现 3 个低严重度问题**（均为枚举遗漏/漂移，当前无用户可见影响）。

## 已验证无问题的重点审查项

| 审查重点 | 结论 |
|---|---|
| PROXY 拒绝短路覆盖同步与异步 shell | 短路位于 `dispatchFullOutcome` LOCAL 分支内、`dispatchLocalShellAsync` 判断之前，两条路径都被覆盖（tool-dispatcher.ts:236-241） |
| 新旧 dispatch 路径行为一致性 | 生产代码中 `dispatchInvocation` 唯一调用点是 `AgentLoop.dispatchTool`；旧位置参数 `dispatch()` 仅单测使用。verdict 经 `DispatchOutcome` 正确透传，旧路径按设计丢弃 verdict 但拒绝短路照常生效 |
| Jev 前置层降级语义 | 未配置/异常/响应畸形一律返回 null，SMART 落到 DangerAssessor、PROXY 落到审批 LLM，与无前置层完全等价（tryJevPrefilter，tool-dispatcher.ts:442-451） |
| 审批标记双通道 | 实时：toolResultMeta → onToolCallResult → WS `approval_mark` → session.ts:1439 写入；历史：mergeApprovalMark 合并进 metadataJson → saveMessage 持久化 → session-vo `metadata` → chatMessage.ts 两轮匹配提取。两条通道均渲染正常 |
| 并发工具调用 | 并行路径各自 `dispatchTool` 构建快照，`buildApprovalContextSnapshot` 只读 `context.messages`（addToolResult 在 Promise.all 之后），无共享可变状态 |
| 子代理派发 | 子代理经各自 AgentLoop 的 dispatchInvocation 走同一链路；spawn_subagent 等 SERVER_ONLY 工具在权限分支之前分流，不受影响 |
| 单测真实性 | 新增断言均为实质断言（拒绝时断言 `localToolExecutor.execute` 未被调用、approvalMark 内容 toEqual、resolver 回落用 toBe 断言引用相等）；无误报绿 |
| 编译与回归 | backend `npm run build`（tsc）通过；backend 全量测试 2407 passed / 13 skipped；desktop `vue-tsc --noEmit` 通过 |
| migration V127 | 编号无冲突（前一版 V126），INSERT IGNORE 幂等，secret 行 is_secret=1 走既有加密/掩码通道 |
| admin 设置 | `approval.modelId` 复用模型 ID 校验分支与模型下拉；「审批」category 与 migration 一致 |
| SMART 语义 | MCP 仍一律人工审批、不过前置层（符合设计 2.3）；Jev 低风险跳过 DangerAssessor 是设计内的行为变更 |

## 发现的问题

### 1. [低] 边路任务级别白名单 `SIDE_PERMISSION_LEVELS` 未收录 `PROXY`

- 文件：`backend-ts/src/session/ws/streaming-ws-handler.ts:31`
- 现状：`const SIDE_PERMISSION_LEVELS = new Set(['READ_ONLY', 'READ_WRITE', 'SMART', 'FULL'])`，`sidePermissionLevel()`（:34-37）对不在集合中的请求级别静默回落到父会话级别。
- 影响分析：当前桌面端新建边路任务时，`SideChatPanel.vue` 传入的 `sidePermissionLevel` 总是等于父会话当前级别（新建时 side 不存在，取 `parentSession.permissionLevel`），因此父会话是 PROXY 时请求值虽被白名单拒绝、但回落值恰好也是 PROXY，**功能结果相同，无用户可见影响**。属于潜在不一致：一旦未来允许边路任务显式指定与父会话不同的级别，PROXY 会被静默丢弃。
- 建议修法：集合中加入 `'PROXY'`。

### 2. [低] session 域权限枚举 `session/permission-level.ts` 未加 `PROXY`，与 harness 枚举漂移

- 文件：`backend-ts/src/session/permission-level.ts:2-3`
- 现状：仓库存在两份权限枚举。本次只更新了 `harness/tool/permission-level.ts`（含 PROXY），session 域这份仍是四级。其唯一消费点是 `session.service.ts:1061` 的 `updatePermissionLevel`——`permissionFromString(permissionLevel)` 的返回值被丢弃（既有的无效校验调用），因此 PROXY 实际可正常存库，当前无功能影响。
- 影响分析：枚举漂移是隐患——任何未来对 session 域 `fromString` 的真实消费（如用它做入库值归一）都会把 PROXY 静默归为 READ_ONLY。
- 建议修法：`VALUES` 与类型加入 `'PROXY'`；或顺带清理 `updatePermissionLevel` 里丢弃返回值的死调用（改为用归一化结果入库或显式校验）。

### 3. [低/信息] agent-cli `--permission-level` 参数不接受 `PROXY`

- 文件：`agent-cli/src/args.ts:7`（PermissionLevel 类型）、`:63`（帮助文案）、parseEnum 校验（:299-304）
- 现状：mao-agent 传 `--permission-level PROXY` 会直接抛 `CliError: --permission-level 必须是 READ_ONLY|READ_WRITE|SMART|FULL`。
- 影响分析：设计文档 2.2 明确「agent-cli 全目录不改」「对 PROXY 级透明」，且 PROXY 会话的审批决策全部在后端完成，resume 已有 PROXY 会话不受影响；仅无法通过 CLI 新建 PROXY 会话。属设计声明范围内的取舍，记为信息级供确认。
- 建议修法：若希望 mao-agent 可发起 PROXY 会话，枚举与文案加入 PROXY 即可（后端已兼容）；否则保持现状。

## 附：本次审查覆盖的改动文件

- 后端：`tool-dispatcher.ts`、`agent-loop.ts`、`tool-result.ts`、`tool-invocation.ts`、`permission-level.ts`、`ws-streaming-event-listener.ts`、`settings.service.ts`、`llm-call-context.ts`、`create-app.ts`、`db/migration/V127__approval_settings.sql`，新增 `proxy-approver.ts`、`jev-risk-assessor.ts`、`approval-model-resolver.ts`、`approval-context-snapshot.ts` 及各自 spec。
- 前端：`PermissionLevelSwitcher.vue`、`ToolCallCard.vue`、`stores/session.ts`、`types/chat.ts`、`utils/chatMessage.ts`。
- admin：`SystemSettingsView.vue`。
- 跨端枚举引用点排查：session 域 permission-level.ts、streaming-ws-handler.ts、agent-cli args.ts、admin（无引用）、android（无引用）。
