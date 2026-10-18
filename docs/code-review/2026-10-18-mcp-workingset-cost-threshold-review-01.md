# MCP 工作集 / 运行轨迹成本阈值 代码审查（2026-10-18）

- 审查对象：`mao` 工作区未提交改动（MCP 工作集 + run-trace「贵」成本阈值）
- 参照设计：`docs/plan/2026-10-18-mcp-working-set-design.md`、`docs/plan/2026-10-18-run-trace-expensive-cost-threshold-design.md`
- 结论：**发现 3 个问题，最高严重程度 medium**，无阻塞项（业务主链路可用，现有测试/构建均通过）
- 已验证：backend-ts `npx vitest run` 全量 4188 passed / 14 skipped；desktop 三个相关 spec 31 passed；backend-ts / desktop / admin / agent-cli `npm run build` 均通过

## 问题列表

### 1. [medium] 全量注入模式也被 `readOnlyHint` 免审，偏离「全量模式行为与改造前一致」

- 文件：`backend-ts/src/harness/tool/tool-dispatcher.ts:289-291`、`:510-519`；装配点 `backend-ts/src/create-app.ts:1511-1516`
- 现象：LOCAL 分支对**任意** `mcp__{server}__{tool}` 调用都会执行 `mcpReadOnlyLookup`，只要会话工具清单里该工具 `annotations.readOnlyHint === true`，`shouldRequireApproval` 在 `READ_ONLY` / `READ_WRITE` 级返回 `needApproval: false`。该判断不区分「工作集 / 全量」模式，而 `ToolDispatcher` 也拿不到 load mode。
- 与设计冲突：`docs/plan/2026-10-18-mcp-working-set-design.md` §5.6 明确「消费点仅两处：工作集文本里的 [只读] 标记，以及 5.7 的审批判定。**全量模式不使用该字段，行为与现在完全一致**」；§5.5 也要求全量路径逐字保留。
- 影响：安全 / 用户。显式选择「全量注入（旧行为）」的 LOCAL 会话（桌面端 / `mao-agent`）中，服务端标注 `readOnlyHint` 的 MCP 工具会跳过原先必弹的审批卡；服务端可自称只读的工具变多，等于放宽了旧模式的审批面。最终是否可接受需产品确认，但当前实现与设计文本不一致。
- 复现 / 测试验证（已实际运行，临时脚本已删除）：构造 `ToolDispatcher`，`mcpReadOnlyLookup` 对 `mcp__fs__read_file` 返回 true，以 `executionMode='LOCAL'`、`permissionLevel='READ_WRITE'`、**全量模式（即直接调用 `mcp__fs__read_file`，不是 `mcp_call`）** 分发：

```ts
const calls: unknown[][] = [];
const localToolExecutor = { execute: async (...a: unknown[]) => { calls.push(a); return 'ok'; } } as never;
const sessionMapper = { selectById: async () => ({ executionMode: 'LOCAL', permissionLevel: 'READ_WRITE' }) } as never;
const dispatcher = new ToolDispatcher(
  { getTool: () => undefined } as never, localToolExecutor, stub, sessionMapper, stub, stub, stub, stub,
  null, null, null, null, null, null, null, null, null,
  (_sid, full) => full === 'mcp__fs__read_file',
);
await dispatcher.dispatch('mcp__fs__read_file', '{"path":"a.txt"}', 'LOCAL', 7, 9, 'w', 'READ_WRITE', null);
// 实际输出：execute 的第 5 个参数为 false（needApproval=false）
// [7, "mcp__fs__read_file", "{\"path\":\"a.txt\"}", "w", false, null]
```

改造前该分支 `writableMcp` 不存在，`READ_WRITE` 下 MCP 工具一律 `needApproval: true`，因此可稳定复现差异。
- 修复建议：把「当前会话是否工作集模式」传入 `ToolDispatcher`（例如 `ToolInvocation` 增加 `mcpLoadMode`，或注入按 session 查询模式的解析器），仅在 `working_set` 模式下做 `readOnlyHint` 免审；全量模式保持 `mcpReadOnly=false`。若产品确认全量模式也要免审，则需同步修订设计 §5.6 与 CHANGELOG 文案，避免「行为与改造前一致」的承诺失真。

### 2. [low] LOCAL 工作集的 MCP 连接失败未进入 `mcpWarnings` 尾部 `system-notice`

- 文件：`backend-ts/src/harness/core/harness-service.ts:359-370`（LOCAL 分支只把 `getLocalConnectionErrors` 传给工作集生成器）、`:386`（仅 CLOUD 分支 `mcpWarnings.push(...cloudResult.warnings)`）
- 现象：LOCAL 会话工作集模式下，失败 server 的原因只出现在「MCP 工作集」section 的 `当前不可用：{原因}` 标题里；`mcpWarnings` 数组不会被写入，因此不会生成设计要求的尾部 `<system-notice>`（该 notice 在 `harness-service.ts` 的 `mcpWarnings.length > 0` 分支统一追加）。
- 与设计冲突：设计 §5.2「连接失败的 server 仍列出，标题追加『当前不可用：{原因}』，**同时由 harness-service 走现有 mcpWarnings → 尾部 system-notice 通道说明**」；§5.5「`mcpWarnings`（连接失败提示）两种模式都走」。
- 影响：用户 / 模型可观测性。模型仍能从 section 标题看到不可用原因，功能不中断；但少了一层与 CLOUD 一致的显式提示，且 Local 失败原因不会进入会话通知区。属与设计约定不一致的缺陷，非主链路阻塞。
- 复现 / 测试验证（建议补在 `harness-service.spec.ts`，利用现有 `makeHarness`）：构造 LOCAL 会话、`loadAgentServers` 返回一台 server、`getLocalSessionTools` 返回 `[]`、`getLocalConnectionErrors` 返回 `[{ serverId: 5, serverName: 'fs', reason: '连接超时' }]`、`mcpLoadModeResolver.resolve` 返回 `working_set`，断言 `context.mcpWorkingSet.servers[0].unavailableReason === '连接超时'`，同时断言 `context.messages` 中不存在包含「相关 MCP 工具不可用或调用可能失败」的 `<system-notice>`（当前实现满足前半、不满足后半）。
- 修复建议：LOCAL 工作集分支在调用 `applyMcpWorkingSet` 后，把 `getLocalConnectionErrors(sessionId)` 中每台 server 格式化为 `"{serverName}: {reason}"` 推入 `mcpWarnings`（与 CLOUD 的 `cloudResult.warnings` 口径一致，注意去重），再由现有 notice 逻辑统一提示。

### 3. [low] 设置页切换加载模式失败时回滚无效（`previous` 在 v-model 已更新后才读取）

- 文件：`desktop/src/views/settings/McpServersView.vue:337-349`
- 现象：`el-radio-group v-model="loadMode" @change="handleLoadModeChange"`。Element Plus 在触发 `change` 前已先 `emit('update:modelValue', val)`，因此进入 `handleLoadModeChange` 时 `loadMode.value` 已等于 `next`；第 339 行 `const previous = loadMode.value` 取到的是新值，`catch` 中 `loadMode.value = previous` 等于把失败后的选择又设回新值，回滚无效。
- 影响：用户。保存失败（400 / 网络错误）时，界面停留在用户刚选中的模式，而后端仍是旧模式；用户会误以为切换已生效，直到新会话行为不符或刷新页面才发现。无数据 / 安全问题。
- 复现 / 测试验证（建议组件测试）：mock `getMcpLoadMode` 返回 `'FULL'`、`saveMcpLoadMode` reject；挂载页面后选择「工作集」，等待 promise 结束，断言单选框回显应为 `'FULL'`（当前实现会停留在 `'WORKING_SET'`）。
- 修复建议：用一个独立的「已持久化值」记录上次保存成功/加载得到的模式（如 `persistedLoadMode`），在 `catch` 中回滚到它；或把 `@change` 换成先记录旧值再赋值的处理（例如用 `@update:model-value` 接管赋值），失败时重新 `getMcpLoadMode()` 回显。

## 已检查但未发现问题的方向

- 工作集模式下 `context.tools` 仅含 `mcp_call` / `mcp_describe`，不注入逐工具 schema（`harness-service.spec.ts` 新用例通过）。
- 无 MCP server 时：工作集工具被显式过滤、`mcpWorkingSet` 保持 null、section 不渲染，与改造前一致（有单测）。
- `mcp_call` LOCAL 还原全名 / 拆内层 arguments / 审批规则按全名匹配 / 还原失败保守审批（`tool-dispatcher.spec.ts` 新用例通过）。
- `mcp_describe` LOCAL 清单来源（`getSessionTools`）与 CLOUD 清单来源（`getCloudSnapshot`）正确。
- CLOUD / LOCAL / docker 容器三条 annotations 透传链（`toToolRefs`、`normalizeMcpToolRef`、桌面 `main.cjs`、`agent-cli`、`container-mcp-bridge` + `routing-mcp-client-manager`）均落到 `McpToolRef.annotations`。
- 失败 server 标注数据源（`connectForCloud.failedServers`、`handleMcpToolsReport` 的 `connected:false` 收集）正确；仅存在上述「未进 mcpWarnings」的缺口。
- V159 迁移、`user_mcp_load_mode` 读写与「用户偏好 → 全局 `mcp.loadMode` → working_set」回落、`GET/PUT /v1/mcp-servers/load-mode` 实现均正确（相关单测通过）。
- 工作集提示词确定性：server / tool 排序稳定、无时间戳，同一数据两次构建系统提示逐字节一致（`prompt-engine.spec.ts` 用例通过）。
- 运行轨迹「贵」阈值：`expensiveCost` 浮点解析与钳制、`Math.round(cost * 1e6)` 单位换算、`costMicros` 为 null 时一律不算贵、localStorage 换 key（v2）、`clampCost` 保留小数、输入框单位/精度/上下限均与设计一致；相关后端与桌面单测通过，未发现逻辑问题。

## 复查轮次（2026-10-18，第一轮修复后）

复查范围：`mcp-read-only-lookup.ts`（新增）及其 spec、`tool-dispatcher.ts` lookup 异步化、`create-app.ts` 注入、`harness-service.ts` LOCAL 失败提示、`McpServersView.vue` 回滚状态。验证：backend-ts 相关 7 个 spec（143 tests）全部通过；backend-ts / desktop `npm run build` 通过。

| 原问题 | 结论 | 复查说明 |
|---|---|---|
| 1. 全量模式 `readOnlyHint` 免审（medium） | **已修复** | `createMcpReadOnlyLookup` 先按会话用户解析 load mode，仅 `working_set` 才查 `readOnlyHint`；全量 / 解析异常 / 会话缺失一律 false（`mcp-read-only-lookup.ts:20-34`）。`ToolDispatcher` 的 lookup 改为 `boolean \| Promise<boolean>` 并 `await`（`tool-dispatcher.ts:128,289-291`），全量模式的 `mcp__*` 调用恢复「一律审批」；spec 覆盖工作集 true / 全量 false / 未标注 false / 缺失与异常 false。异步改造只影响 LOCAL 分支这一处调用，其余路径无变化。 |
| 2. LOCAL 工作集失败未进 system-notice（low） | **已修复** | LOCAL 工作集分支把 `getLocalConnectionErrors` 逐条格式化为 `{serverName}: {reason}` 推入 `mcpWarnings`（`harness-service.ts:365-375`），重复消息用 `includes` 去重；notice 渲染仍是原有统一路径。新增用例同时断言 `unavailableReason` 与 `context.messages` 的 system-notice 含失败原因。full 模式与 CLOUD 路径未受影响，无重复/误报（同一报告内同 server 同 reason 去重）。 |
| 3. 设置页回滚无效（low） | **已修复** | 新增 `savedLoadMode` 记录最近一次加载/保存成功的值（`McpServersView.vue:316-320,343-352`），`change` 时用 `savedLoadMode` 作旧值，保存成功后才更新它，失败回滚到该值；`loadModeSaving` 仍保证保存期间不可再次切换。模式接口失败单独 catch，不拖垮列表加载。 |

**复查结论：3 个问题均已修复，未发现新问题。**

