# 代码审查报告：会话内切换 Agent（第一轮）

- 日期：2026-10-30
- 分支：`feat/in-session-agent-switch`（git worktree 未提交改动）
- 需求文档：`docs/plan/2026-10-29-in-session-agent-switch-technical-design.md`
- 审查范围：backend-ts（PATCH agentId / reopen-with-agent / AgentHandoverService）、desktop（AgentSwitcher / AgentReopenDialog / TaskView / store）、shared contracts、admin/desktop llmCallLabels
- 审查方式：逐文件读 diff + 关键链路溯源 + 临时 vitest 用例复现（验证后已删除，未改动任何业务代码）

## 确认的 Bug

### Bug 1（严重度：高）接手说明永远生成失败：消息角色大小写不匹配，transcript 恒为空

**位置**：`backend-ts/src/session/agent-handover.service.ts:76-82`（`collectTranscript`）

```ts
if (row.role === 'user') {          // ← 小写比较
  if (!isRealUserMessage({ role: 'user', content: row.content ?? '' })) continue;
  picked.unshift({ role: 'user', content: clip(text) });
} else if (row.role === 'assistant') {   // ← 小写比较
  picked.unshift({ role: 'assistant', content: clip(text) });
}
```

**问题**：`collectTranscript` 的消息来源是 `messageRepo.listBySession(sessionId)`（`session.repository.ts:574`），即 `SELECT * FROM message ...` 的**原始 DB 行，不做任何角色归一化**。而生产库中 `message.role` 存的是大写：

- 表结构：`db/migration/V001__init_schema.sql:165` — `` `role` VARCHAR(20) NOT NULL COMMENT 'USER / ASSISTANT / SYSTEM / TOOL' ``，普通 VARCHAR 原样存取；
- 全部写入端均为大写：桌面 WS 用户消息 `streaming-ws-handler.ts:671/1179/1756/1957` 写 `'USER'`，助手消息 `harness-service.ts:199/237` 写 `'ASSISTANT'`（以及 `subagent-result-delivery.service.ts` 等）；
- 消费侧需显式小写化的旁证：`harness/core/session-history-loader.ts:115` 的 `toChatMessage` 用 `role: message.role?.toLowerCase()` 转换后才供 harness 使用。

因此 `row.role === 'user'` / `=== 'assistant'` 永远不成立 → `picked` 恒为空 → `generateHandoverNote` 走 `transcript.length === 0` 分支恒返回 `null`，**LLM 根本不会被调用**。

**后果**：P2「用其他 Agent 重开」的接手说明（需求的核心产出之一，独立 LLM 场景 `agent_handover_summary`）在真实环境**永远为 null**；用户每次重开都只会看到「接手说明生成失败，可直接描述需求」的 toast。会话创建/归档主流程不受影响（null 有兜底），故失效是静默的。

**为何现有测试没拦住**：`agent-handover.service.spec.ts` 构造的 mock 消息行全部用小写角色（`row(1, 'user', ...)`），恰好与实现共享同一个错误假设，测试全绿但与生产行为脱节。

**验证（临时用例已复现，验证后删除）**：在 `backend-ts` 下以 `AgentHandoverService` + mock `listBySession` 复现——
- 用生产形态的大写行（`'USER'`/`'ASSISTANT'`/`'TOOL'`，内容非空、含真实用户消息）调用 `generateHandoverNote`，断言应返回说明正文且 `llmAdapter.chat` 被调用 1 次 → **实际返回 `null`、`chat` 未被调用，断言失败**（`expected null to be '接手说明正文'`），bug 成立；
- 对照组：同样的消息内容改用小写角色行 → 返回说明正文、LLM 调用 1 次，断言通过。两组对照证明失败仅由角色大小写引起。

**修复方向提示**（仅指路，未改代码）：与 `session-history-loader.toChatMessage` 同口径，取回后做 `row.role?.toLowerCase()` 归一化（或 SQL 侧 `LOWER(role)`），并同步修正 spec 的 mock 角色为大写形态以贴近生产。

---

## 边界观察（未列入确认 bug 清单）

### 观察 1（严重度：低）reopen 端点同步耗时上限与桌面 axios 全局 30s 超时重合，超时后重试会产生重复新会话

说明：以下为代码常量推演结论，**无法用单测确定性复现**（触发依赖线上 LLM 实际时延），按「避免误报」的要求不计入上面的确认清单，仅作记录。

- `backend-ts/src/session/agent-handover.service.ts:12`：`HANDOVER_TIMEOUT_MS = 30_000`（接手说明 LLM 的上限）；
- `session.routes.ts` reopen 处理器：`createSession`（含工作区环境探测）→ `generateHandoverNote`（≤30s）→ `archiveSession` **串行执行**；
- `desktop/src/api/index.ts:18`：axios 实例全局 `timeout: 30000`，`reopenSessionWithAgent`（`api/index.ts:803-811`）未单独放宽。

当下游 LLM 耗时接近 30s 时，端点总耗时必然超过 30s，客户端 axios 先超时（无 response → 拦截器 toast「网络错误」），但服务端会继续执行完建会话与归档。`AgentReopenDialog.vue` 的 catch 分支保持弹层打开「供重试」，用户点重开会**再次**执行 createSession + archiveSession（后端对已归档旧会话无状态校验、无幂等键），同一工作区将出现两个新会话，先建的那个成为无标题孤儿。

可选的收窄方向（供参考，不构成建议）：端点内对旧会话已归档的幂等处理，或该请求单独放宽客户端超时。

---

## 审查通过、确认无问题的部分（简列）

- PATCH `/v1/sessions/:id` 的 `agentId` 分支：仅在字段非 null 时进入，不传时行为与现状一致（route spec 有回归断言）；`parseEntityId` 对 number/string/null 的口径经 `desktop` store 发 number 也兼容。
- `assertAgentSwitchable` 校验口径（存在 / `enabled === 0` 拒 / `clientVisible === 0` 拒）与设计 §4.1-2、新建列表口径一致；`MysqlAgentRepository.findById` 为 `SELECT *`，`clientVisible` 字段可达。
- reopen 逐位传参（`userId/agentId/title/executionMode/workspace/permissionLevel/isGit/…/modelId/cloudProjectKey/workspaceMode/source`）与 `createSession` 16 参签名逐位核对一致，route spec 有逐位断言；CLOUD + 非空 workspace 时 `projectKey` 取显式 `cloudProjectKey`，飞书私聊工作区 projectKey 不会被路径推导改写。
- `AgentHandoverService` 其余部分（超时 race、取消位、模型解析链、40 条/1500 字裁剪、压缩摘要与 `<system-notice>` 过滤、多 part 内容抽取）与 `session-title.service.ts` 镜像一致；`backend-ts npm run build` 通过。
- 桌面端：`vue-tsc -b --force` 通过；AgentSwitcher 在新建任务态/边路任务态不渲染（`v-if="agentId"` 且 ChatPanel 仅主会话传值）；确认弹层、store 本地更新（`normalizeId` 归一）、失败不落本地变更均有测试覆盖；重开后草稿预填键 `s:${id}` 与 `ChatPanel.currentDraftKey` 口径一致，`restoreDraft` 随 draftKey watch 触发，机制与既有「新建态预填」同构。
- 三处同改（contracts `LlmCallScene`、`LLM_CALL_SCENES`、desktop/admin 两份 labels）与 `zz-logicbug-probe.test.ts` 穷尽断言齐备；后端 `src/session src/usage` 全量单测除上述临时 bugcheck 用例外全部通过（812 passed）。

## 验证环境备注

- 后端：`npm run build` 通过；`npx vitest run src/session src/usage` 57 文件 812 用例通过（唯一失败为本次审查的临时复现用例，验证后已删除）。
- 桌面：`npx vue-tsc -b --force` 通过；`npx vitest run src/stores/session-agent-switch.test.ts src/utils/zz-logicbug-probe.test.ts` 通过。
- 未执行任何业务代码修改、未执行 git add/commit；临时测试文件已删除，工作区仅新增本报告。
