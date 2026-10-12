# 提示词前缀缓存加固 —— 第 3 轮代码复审

- 分支：`feat/prompt-prefix-cache`（基于 `main 9d2c9966`）
- 审查 commit：`66cf6d7f` + `b7d16e72` + `36b4475e`（`git diff main..HEAD`，工作区 clean）
- 审查范围：仅功能逻辑代码，不含文档 / CHANGELOG / mao-cli
- 复审对象：第 2 轮报告阻塞项 B-1 的修复（`docs/code-review/2026-10-12-prompt-prefix-cache-round2.md`）

---

## 1. 总体结论

**可以合并（阻塞项 0 个，重要项 0 个）。**

第 2 轮的阻塞项 B-1 已被正确修复，且修复方式与设计文档 §4.5 第 3 点完全对齐。
本轮围绕用户提出的 3 个关注点做了针对性核查，**未发现可触发功能 bug 的问题**。

本轮仅记录 2 条「建议」级观察，均不构成功能缺陷，可按需处理。

---

## 2. 对用户 3 个关注点的核查结论

### 关注点 1：快照会话级存活后，`cloudSnapshot` Map 是否还有其他遗漏的清理路径？

**结论：清理路径已闭环，但 Map 无上限，存在理论上的缓慢增长。**

已确认的清理路径：
- `SessionService.deleteSession` → `onSessionDeleted` 回调 → `create-app.ts:778` `mcpSyncRef?.clearCloudSnapshot(sessionId)`。

已核实的清理覆盖：
- 普通会话：用户删除（`session.routes.ts:292` / `admin-session.routes.ts:161`）→ `deleteSession` → 清理 ✅
- 边路会话（sideSessionId）：与普通会话走同一 `deleteSession`，前端侧边树可删 ✅
- 子代理会话（childSessionId）：`subagent-visibility-service.ts` / `subagent-invocation.service.ts` 内**没有** `deleteSession` 调用，即子代理会话不由执行流程自动删除，只能由用户手动删除 → 用户删了就清，不删就留 ✅（与设计文档一致）

**残留风险（建议级）**：`McpToolsRegistry.cloudSnapshot` 是裸 `Map<number, McpToolRef[]>`，没有 `prompt-prefix-monitor.ts` 那样的 `MAX_SESSIONS` 上限与 LRU 淘汰。若大量短期会话（定时任务 / Webhook / 子代理）执行过 CLOUD MCP 且用户从不删除，条目会单调增长。增长速率受「有过 MCP 工具的成功执行」限制，且每条只存工具引用数组，实际内存压力很小。见 S-1。

### 关注点 2：`clearLocalSession` / `clearCloudSnapshot` 拆分后，原 `clear()` 调用方是否都仍然语义正确？

**结论：拆分正确，生产代码中已无 `mcpSyncService.clearSession` 调用方。**

逐项核对：

| 原调用点 | 改动后 | 语义核对 |
|---|---|---|
| `streaming-ws-handler.ts` `releaseSessionExecutionResources`（每次执行 finally） | `clearLocalSession` | ✅ 正确。每次执行结束回收桌面上报的 LOCAL 工具；CLOUD 快照跨执行保留。与 main 基线行为一致（main 上调 `clearSession` 同时清两维，但 LOCAL 会话根本不写 cloudSnapshot，CLOUD 会话不写 sessionTools，故 main 上等价于「只清了自己那一维」） |
| `streaming-ws-handler.ts` `syncMcpServersToClient` 4 处（servers 为空 / 无本地连接 / 超时 catch / 入口） | `clearLocalSession` | ✅ 正确。这 4 处都在「LOCAL 同步失败/无桌面连接」语境下回收桌面上报数据，本就不该动 CLOUD 快照 |
| `harness-service.ts` 三处 execute 出口 finally | 已移除 | ✅ 正确（B-1 修复本体） |
| `create-app.ts` `onSessionDeleted` | `clearCloudSnapshot` | ✅ 正确。会话删除时清 CLOUD 快照 |

**探针验证**：`r3-local-mode-leak.spec.ts` 静态扫描 10 个生产文件，`mcpSyncService.clearSession` 出现次数为 0（`create-app.ts` 里的 `feishuAskFormStore.clearSession` 是飞书表单存储，与 MCP 无关）。

`McpSyncService.clearSession` / `McpToolsRegistry.clear` 方法本身保留（全清语义），目前无生产调用方，仅测试在用——保留是合理的，便于后续「会话维度整体回收」场景使用。

### 关注点 3：边路会话与子代理会话的快照生命周期是否合理？

**结论：合理。**

- 边路会话：`executeSideFirstMessage(sideSessionId)` → `buildContext(sideSessionId)` → `connectForCloud(sideSessionId, ...)`。边路会话是用户可见、可删除的独立会话，快照随其删除而回收。若边路会话被 `promoteSideTaskToMainSession` 提升为主会话，`promoteSideTaskToMainSession`（`session.service.ts:579`）**不删**原边路会话行（只改 sessionType/parentSessionId），所以快照键仍是同一个 sessionId，继续有效——语义正确。探针 `r3-side-snapshot.spec.ts` 静态核对了这一点。
- 子代理会话：`delegate-tool.ts:222 buildContext(childSession.id)` → `executePrepared`。子代理会话同样由用户手动删除后回收。子代理是一次性短任务，跨执行沿用快照的意义不大，但保留也无害（键不冲突、随删除回收）。

---

## 3. B-1 修复本体核对

### 已确认正确的点

1. **`harness-service.ts` 三处 finally 清理已移除，`clearCloudMcpSnapshot` 私有方法已删除** ✅
   - `execute`（`:95`）只保留 `removeCancelFlag`；`executePrepared`（`:263`）与 `executeSideFirstMessage`（`:635`）恢复为顺序语句。
2. **`McpToolsRegistry` 新增 `clearCloudSnapshot` / `clearLocalSession`，与 `clear` 三法并存且互不越界** ✅
   - 探针 `r3-clear-local-snapshot.spec.ts` 验证：`clearLocalSession` 只删 `sessionTools`、`clearCloudSnapshot` 只删 `cloudSnapshot`、`clear` 删两者。
3. **`create-app.ts` 的 `onSessionDeleted` 同时清定时任务与 CLOUD 快照，用 `mcpSyncRef` 延迟引用** ✅
   - `SessionService` 构造器仍为 15 参，未新增参数位；与既有 `terminalManagerRef` 模式一致。
4. **`agent-loop.ts:522` 的 `mcpClientManager.closeSession(sessionId)` 未改动** ✅
   - 正确：断的是「连接」，不是「工具集记忆」。
5. **核心收益真正生效**：新测试 `mcp-cloud-snapshot-lifecycle.spec.ts` 用真实 `McpSyncService` + `McpToolsRegistry` + `HarnessService` 组装链路，第二轮 github 连接失败时断言 tools 与第一轮逐字节一致、`second.messages` 含「当前不可用」，且 `connectAndListTools` 共 6 次（含执行内 buildContext）。这条测试正是第 2 轮 B-1 探针的实验组，现已转正。

### 第 2 轮 B-1 修复后未引入的新问题

- **MCP 配置变更后的快照收窄**：探针 `r3-stale-snapshot.spec.ts` 验证——agent 解绑 server、用户级禁用 server 后，下一轮 `connectForCloud` 的 `staleRefs` 过滤（`configured.has(ref.serverId)`）都能把旧 server 正确剔除，快照不会无限累积旧工具。✅
- **LOCAL / CLOUD 维度不串味**：LOCAL 会话只走 `getLocalSessionTools`，不写 `cloudSnapshot`；反之亦然。`clearLocalSession` 不会误伤 CLOUD 快照。✅

---

## 4. 测试与构建验证

- `cd backend-ts && npm test` → **Test Files 303 passed | 1 skipped（304），Tests 3800 passed | 14 skipped（3814）**
- `npx tsc -p tsconfig.build.json --noEmit` → **exit 0**
- 5 个探针共 19 条用例：**19 passed / 0 failed**
  - `r3-clear-local-snapshot.spec.ts`（4）：拆分后各清理方法边界
  - `r3-stale-snapshot.spec.ts`（4）：配置变更收窄 + Map 无上限事实核对
  - `r3-side-snapshot.spec.ts`（3）：边路/子代理清理路径静态核对
  - `r3-local-mode-leak.spec.ts`（4）：生产代码无 `mcpSyncService.clearSession` 残留调用方
  - `r3-cancel-flag.spec.ts`（4）：见 S-2
- 探针目录 `backend-ts/src/zz-probe/` 已删除，`git status --short` 干净（除本报告）

---

## 5. 建议级观察（不阻塞合入）

### S-1 `cloudSnapshot` Map 无上限，无 LRU 淘汰

- **文件:行**：`backend-ts/src/harness/mcp/local/mcp-tools-registry.ts:11`
- **问题描述**：`private readonly cloudSnapshot = new Map<number, McpToolRef[]>()` 只在 `clearCloudSnapshot`（会话删除）时删条目，没有容量上限。同文件的 `sessionTools` 与 `prompt-prefix-monitor.ts:38` 的 `snapshots` 也是这个形态，但后者有 `MAX_SESSIONS = 512` + LRU。
- **影响**：大量短期会话（定时任务 / Webhook 触发器 / 子代理）执行过 CLOUD MCP 且用户从不删除时，条目单调增长。每条只存工具引用数组（通常几条到几十条），实际内存压力很小，属理论风险。
- **修复建议**：如需收敛，可仿 `prompt-prefix-monitor.ts` 加容量上限 + 按插入序淘汰；或在 `releaseSessionExecutionResources` 里对「非 SIDE_TASK / SUBAGENT 的短生命周期会话」补一次清理。当前不影响功能，可列为后续优化。
- **验证用例**：`r3-stale-snapshot.spec.ts` 用例「风险 B」——连续 1000 个 sessionId 各执行一次，`cloudSnapshot.size === 1000`，无淘汰（通过，用于确认事实）。

### S-2 `executeSideFirstMessage` 抛错时 `removeCancelFlag` 不执行（与 main 基线一致，非本轮引入）

- **文件:行**：`backend-ts/src/harness/core/harness-service.ts:635-636`
- **问题描述**：round3 把 `executeSideFirstMessage` 的 `try/finally` 展开成顺序语句后，`agentLoop.execute` 抛错时不会调 `removeCancelFlag(sideSessionId)`。`execute`（`:95`）仍保留 finally，行为两者不一致。
- **影响评估**：**不构成本轮回归**。核对 `git show main:...harness-service.ts` 确认 main 上 `executeSideFirstMessage` 就是无 try/finally 的顺序语句（`:652`），round3 只是把它从 round1/round2 引入的 finally 恢复回了 main 原样。实际调用方 `streaming-ws-handler.ts:1154` 外层有自己的 finally，且按 flag 对象身份归属回收（`:1163-1168` 会调 `this.deps.agentLoop.removeCancelFlag(sideSessionId)`），所以主路径上不会残留。仅当 `HarnessService` 被 WS handler 之外的调用方直接使用且执行抛错时，才可能残留一条 `AgentLoop.cancelFlags` 条目。
- **修复建议**：若希望与 `execute` 严格对齐，可把 `removeCancelFlag` 包回 try/finally。属一致性改进，非功能缺陷。
- **验证用例**：`r3-cancel-flag.spec.ts` 4 条——`executeSideFirstMessage` 抛错时 `removeCancelFlag` 未被调用（通过，确认事实）；`execute` 抛错时仍被调用（通过）；`executePrepared` 抛错时无此语义（通过）；`executeSideFirstMessage` 成功时正常调用（通过）。

---

## 6. 结论

- **阻塞项 0 个，重要项 0 个。**
- 第 2 轮 B-1 已正确修复：快照改为会话级存活期，核心收益（某 server 第二轮连接失败时 tools 逐字节一致 + 不可用 notice）在主路径上真正生效，并有端到端测试覆盖。
- 用户 3 个关注点均已核查：清理路径闭环（建议级 S-1 为无上限 Map 的理论风险）；`clear()` 拆分后无残留错误调用方；边路/子代理快照生命周期合理。
- **建议合入。**
