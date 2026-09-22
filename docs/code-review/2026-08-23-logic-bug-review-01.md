# 逻辑 BUG 审查报告

- **日期**：2026-08-23
- **项目**：mao（backend-ts / admin / desktop / android / agent-cli 五端）
- **范围**：后端 harness 引擎与领域服务、admin 管理后台、desktop 前端核心链路（useStreamWS/useChat/stores）、agent-cli 终端 CLI。android 为 Capacitor 原生壳（MainActivity/OTA 插件），本轮仅抽查，未发现逻辑缺陷。
- **方法**：人工逐行审查 + 两个并行 reviewer 子代理交叉验证（agent-cli/admin、desktop），关键竞态结论经独立脚本推演复核；每个 BUG 均核对到具体文件行号。
- **严重度**：P0 = 安全漏洞或功能完全不可用；高 = 特定条件下功能错误/数据不一致；中 = 边界条件触发的能力退化；低 = 弱网/并发窗口下的体验或幂等问题。

共确认 **14 个逻辑 BUG**（P0×2、高×4、中×4、低×4），远超"至少 5 个"的要求基线。

---

## BUG 清单总览

| 编号 | 严重度 | 模块 | 一句话描述 |
|------|--------|------|-----------|
| BUG-01 | P0 | backend-ts | `/v1/admin/**` 全部接口只校验登录不校验权限，任意普通用户可越权读取全平台数据 |
| BUG-02 | P0 | agent-cli | LOCAL 模式并行审批单槽竞态，首个审批 Promise 永久悬挂导致整个任务卡死 |
| BUG-03 | 高 | desktop | WS 心跳定时器竞态：旧连接迟到 onclose 清掉新连接心跳，死链不再被检测 |
| BUG-04 | 高 | backend-ts | edit_file 行数增删统计公式错误且与 write_file 口径不一，入库数字虚报 |
| BUG-05 | 高 | backend-ts | 消息队列 sortOrder 并发重复，出队/重排顺序不稳定 |
| BUG-06 | 高 | backend-ts | autoConsumeQueue 500ms 窗口竞态：队头消息被消费但永不执行 |
| BUG-07 | 中 | backend-ts | glob_search JS 回退遍历不过滤 node_modules/.git，rg 缺失时结果被依赖目录淹没 |
| BUG-08 | 中 | backend-ts | 流式工具名分片追加拼接，name 可能拼坏为 `read__file` 类错误值 |
| BUG-09 | 中 | backend-ts | 压缩请求 deriveRequest 丢失 thinking/enableThinking 字段 |
| BUG-10 | 中 | backend-ts | 后台子代理提交失败路径不投递结果，父代理永远不知道子代理失败 |
| BUG-11 | 中 | agent-cli | REPL 模式 resume 活跃会话时用户输入被静默吞掉 |
| BUG-12 | 低 | admin | 会话详情页无请求竞态防护；列表/监控页 keep-alive 首屏双请求 |
| BUG-13 | 低 | agent-cli | RestClient 对非幂等 POST 也自动重试，弱网下可能重复建会话 |
| BUG-14 | 低 | agent-cli | 取消指令走不可靠 ws.send，断线窗口内取消帧被静默丢弃 |

---

## BUG-01【P0 · 安全/越权】admin 全部接口缺少权限校验

- **模块**：backend-ts（管理后台 API）
- **位置**：
  - `backend-ts/src/session/admin-session.routes.ts:44`（及该文件所有 `/v1/admin/sessions*` 路由，均只有 `requireUserId(request)`）
  - `backend-ts/src/admin/admin.routes.ts:31`（analytics/runtime 同样）
  - 前端唯一防线：`admin/src/router/index.ts:120-133`（`meta.permission` 仅 UI 拦截）
- **代码片段**：

```ts
// backend-ts/src/session/admin-session.routes.ts:43-46
app.get('/v1/admin/sessions/options/users', async (request, reply) => {
  requireUserId(request);   // ← 只验证 JWT 有效，不校验任何权限/管理员角色
  const users = await userLookup.listOptions();
```

```ts
// admin/src/router/index.ts:126 —— 前端拦截可被直接绕过
if (permission && !authStore.hasPermission(permission)) { next('/forbidden') }
```

- **问题描述**：管理后台全部数据接口（全量会话、聊天记录、运行监控、用量分析）仅有 JWT 登录态一道门，没有调用项目里已有的 `requirePermission`/管理员角色校验。对比正确用法：`backend-ts/src/user/user.routes.ts:107` 的用户管理接口是有 `requirePermission(..., 'user:write')` 的；前端 router 的 `meta.permission` 只是菜单级 UI 拦截，安全模型被寄托在可绕过的前端层。
- **触发场景**：任意普通用户登录拿到自己的 token 后，直接 `curl -H "Authorization: Bearer <自己的token>" https://…/api/v1/admin/sessions`，即可拉取**全平台所有用户**的会话列表、聊天记录、Token 用量分析。
- **修复建议**：在 `/v1/admin/**` 路由统一挂 `requirePermission(userId, 'session:read')` 或 `isAdmin` 中间件（`permissionService.hasPermission` 已存在，user.routes 已有正确用法可复用）；前端路由拦截仅保留作体验优化。

---

## BUG-02【P0 · 竞态/卡死】LOCAL 并行工具调用的审批单槽覆盖，首个审批永久悬挂

- **模块**：agent-cli（LOCAL 工具审批）
- **位置**：`agent-cli/src/tui/ink-renderer.ts:232-250`；调用方 `agent-cli/src/local/executor.ts:86-91`；对照后端并行分发 `backend-ts/src/harness/core/agent-loop.ts:482`（`Promise.all(pendingCalls.map(runOne))`）
- **代码片段**：

```ts
// agent-cli/src/tui/ink-renderer.ts:232-243
requestApproval(req, reason): Promise<'allow'|'deny'|'always'> {
  return new Promise((resolve) => {
    if (this.modal?.type === 'ask') { this.resolveAsk(this.modal.requestId, []); }
    this.approvalResolver = resolve;        // ← 无条件覆盖上一个 resolver
    this.modal = { type: 'approval', request: req, reason };
    this.flush();
  });
}
resolveApproval(choice) {
  this.modal = null; this.flush();
  const resolve = this.approvalResolver;    // 只解析当前槽位
  this.approvalResolver = null;
  if (resolve) resolve(choice);
}
```

- **问题描述**：`approvalResolver` 是单槽变量。一轮并行分发 ≥2 个需审批的工具时（后端 `agent-loop.ts:482` 是 `Promise.all` 并行），第二个 `requestApproval` 会无条件覆盖第一个的 resolver——第一个审批的 Promise 没有任何路径被 resolve，对应 `executor.ts` 的 `await askApproval(...)` 永久悬挂，整轮工具调用无法完成。
- **触发场景**：CLOUD 下发一轮含多个需 LOCAL 审批工具调用的响应（如同时 `write_file` + `run_command`），桌面端转发到 mao-agent 本地执行，用户批准了第二个弹窗后任务再无任何进展。
- **修复建议**：`approvalResolver` 改为 FIFO 队列（数组），`resolveApproval` shift 出队解析；modal 展示层串行化（后续审批排队等前一个关闭后再显示）。

---

## BUG-03【高 · 竞态】WS 心跳定时器被旧连接迟到事件清除，死链不再检测

- **模块**：desktop（useStreamWS，Web/Electron/安卓共用）
- **位置**：`desktop/src/composables/useStreamWS.ts:204-211`（onopen 直接赋值心跳）、`:222-224`（onclose 无条件清理）
- **代码片段**：

```ts
// useStreamWS.ts:172 —— 重连直接覆盖模块级 ws 变量
ws = new WebSocket(url)
...
// :204-211 onopen 里直接 setInterval，未先 stopHeartbeat()
heartbeatTimer = setInterval(() => { ... }, 5_000)
...
// :222-224 onclose 无条件执行清理
ws!.onclose = () => {
  connected.value = false
  stopHeartbeat()
```

- **问题描述**：网络闪断时 `scheduleReconnect` 在 1s 后调用 `connect()` 创建**新** WebSocket 并覆盖模块级 `ws` 变量；旧 socket 的 `onclose` 事件此后才迟到触发。由于 `onclose` 处理器不校验 `event.target` 是否是当前活跃连接，它会：① 执行 `stopHeartbeat()` 清掉**新连接刚建好**的心跳定时器（且无人再恢复）；② 把 `connected.value` 置 false 污染 UI 状态；③ 可能再排一次多余重连。后果是新连接不再有心跳保活，服务端静默断链（半开连接）永远不会被检测和重连。
- **触发场景**：移动网络/VPN 抖动导致快速断开-重连序列，旧连接的 close 事件晚于新连接 open 到达——弱网环境下概率不低。
- **修复建议**：① `onopen` 先 `stopHeartbeat()` 再建新 interval；② `onclose`/`onerror` 处理器开头校验 `event.target === ws`（当前活跃 socket）才执行清理与重连调度。

---

## BUG-04【高 · 数据口径】edit_file 行数增删统计公式错误，且同轮两种工具口径不一

- **模块**：backend-ts + desktop electron（同一错误两处实现）
- **位置**：`backend-ts/src/harness/tool/impl/edit-file-tool.ts:78-87`；`desktop/electron/main.cjs:281-290`（writeEditedFile 同公式）。对照组：write_file 用 LCS 精确计算（`main.cjs:73-101` computeLineDelta；后端侧 `FileChangeDiffUtil` 同类实现）
- **代码片段**：

```ts
// backend-ts/src/harness/tool/impl/edit-file-tool.ts:78-87
const oldLines = oldString.split('\n').length;
const newLines = newString.split('\n').length;
return toJson({
  success: true,
  replacements: match.replacements,
  file_change: {
    path: filePathArg,
    type: 'MODIFIED',
    lines_added: newLines * match.replacements,     // ← 错误公式
    lines_deleted: oldLines * match.replacements,   // ← 错误公式
  },
```

- **问题描述**：把"被替换文本整体行数 × 替换次数"既算删又算加。例：`"foo"` → `"bar\nbaz"` 替换 1 处，报 `lines_added=2, lines_deleted=1`，而真实 diff 约为 +1/-0（或按修改对账口径 +1/-1）。同一轮里 `write_file` 走 LCS 精确计算、`edit_file` 走这套粗略公式，两种工具产出的 file_change 数字口径互相矛盾。这些数字经 `harness-service.ts saveFileChanges` 入库并在前端"文件变更"面板展示。
- **触发场景**：任意成功的 edit_file 调用（几乎每轮编码任务都有），变更统计长期虚报。
- **修复建议**：删除手算公式，复用已有的 `FileChangeDiffUtil.buildDiff` 结果（或 computeLineDelta）从真实 diff 计算增删行，两端口径对齐 write_file。

---

## BUG-05【高 · 并发】消息队列 sortOrder 读-改-写竞态，产生重复排序值

- **模块**：backend-ts（消息排队）
- **位置**：`backend-ts/src/session/message-queue.service.ts:6-19`（enqueue）；`backend-ts/src/session/message-queue.repository.ts:38-50`（findLastPending/findHeadPending 均无二级排序、无锁）
- **代码片段**：

```ts
// message-queue.service.ts:6-19 —— 先查 max 再插入，无事务无锁
async enqueue(sessionId, userId, content, images): Promise<MessageQueue> {
  const last = await this.repo.findLastPending(sessionId);
  const maxOrder = last?.sortOrder ?? 0;
  const item: MessageQueue = { ..., sortOrder: maxOrder + 1, status: 'PENDING' };
  await this.repo.insert(item);
```

```sql
-- message-queue.repository.ts:47 —— 出队无 id 二级排序，并列时不稳定
SELECT * FROM message_queue WHERE session_id = ? AND status='PENDING'
ORDER BY sort_order ASC LIMIT 1
```

- **问题描述**：enqueue 是典型的"读 max → +1 → 写入"，两个并发 enqueue（例如队列自动补充与用户手动排队几乎同时触发）会读到相同 `maxOrder`，插入两条相同 `sort_order` 的记录。此后 `findHeadPending` 仅按 `sort_order ASC LIMIT 1` 出队，并列时命中哪条取决于存储引擎返回顺序，不稳定；`reorder` 的上/下邻居查询（findNeighborUp/Down）在并列时同样错乱，可能把顺序彻底搅乱。
- **触发场景**：同一会话并发排队请求；或应用层重试导致的重复 enqueue。
- **修复建议**：任选其一并建议组合：① enqueue 包事务 + `SELECT ... FOR UPDATE` 锁住该会话队尾；② `sort_order` 相同则以自增 `id` 作二级稳定排序（`ORDER BY sort_order ASC, id ASC`）；③ 直接用单调自增序列（单独计数表或 `MAX(sort_order)+1` 下沉到 INSERT 语句内原子完成）。

---

## BUG-06【高 · 竞态】autoConsumeQueue 出队后 500ms 窗口内被手动发送抢占，消息被消费但永不执行

- **模块**：backend-ts（WS 流处理 / 排队消费）
- **位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts:845-873`（autoConsumeQueue；延迟执行在 ：868-872）
- **代码片段**：

```ts
// streaming-ws-handler.ts:852-855 —— 占用检查只在出队“之前”做一次
if (this.executionClaims.has(sessionId) || this.runningTasks.has(sessionId)) {
  await this.sendQueueUpdated(sessionId, userId); return;
}
const head = await this.deps.messageQueueService.dequeue(sessionId);   // ← 此刻起队列项已删
...
await this.deps.sessionService.saveMessage(sessionId, 'USER', messageContent, ...);  // ← 消息已落库
...
// :868-872 —— 500ms 后才真正尝试执行
this.deps.agentExecutor(async () => {
  await new Promise((r) => setTimeout(r, 500));
  await this.handleSendMessage(userId, { sessionId, data: { content, ... } }, true);
});
```

- **问题描述**：dequeue（标记 DELETED）与 saveMessage（落一条 USER 消息）完成后，要等 500ms 定时器到期才调用 `handleSendMessage`。在这个窗口内若用户手动 `send_message` 抢先通过 phase 检查并占用了 executionClaims，则自动消费路径的 `handleSendMessage` 会因 claims 冲突返回 `session_already_running` 而**没有任何补偿**——队列项已删除、USER 消息已入库，但内容永远不会被执行。用户看到消息发出去了，Agent 却毫无反应。
- **触发场景**：会话 RUNNING 结束瞬间队列有积压消息，auto-consume 出队后 500ms 内用户恰好手动发送新消息（自动化测试/脚本场景尤其容易撞上）。
- **修复建议**：① auto-consume 路径在 dequeue **之前**原子占位 claims，占不到就不出队（与 ：852 的检查合并为同一步并保持到执行结束）；② 或 `handleSendMessage` 失败分支识别 `isAutoConsume` 来源时将消息重新入队（插回队头）。

---

## BUG-07【中 · 能力退化】glob_search JS 回退不忽略 node_modules/.git，rg 缺失时结果全被依赖目录淹没

- **模块**：backend-ts（harness 内置工具）
- **位置**：`backend-ts/src/harness/tool/impl/glob-search-tool.ts:87-104`（searchWithJs 的 walk）。对照组：`desktop/electron/main.cjs` globWithNode 与 `agent-cli/src/local/tools/search.ts` 的 walk 都有 `if (entry.name === 'node_modules' || entry.name === '.git') continue`，唯独后端回退实现缺失
- **代码片段**：

```ts
// backend-ts/src/harness/tool/impl/glob-search-tool.ts:93-103 —— 无任何目录过滤
for (const name of entries) {
  if (files.length >= headLimit) return;
  const full = path.join(dir, name);
  let st;
  try { st = statSync(full); } catch { continue; }
  if (st.isDirectory()) walk(full);
  else if (st.isFile()) {
    const relative = path.relative(scope.cwd, full);
    if (matcher.test(relative) || matcher.test(name)) files.push(relative);
  }
}
```

- **问题描述**：rg 可用时走 `rg --files --glob`，遵守 .gitignore，不会进 node_modules；rg 缺失时的 JS 回退裸遍历整个目录树。node_modules 里动辄数十万个匹配文件，headLimit=100 的配额全部被依赖目录消耗，返回 `truncated: true` 但业务文件一个都搜不到。同一段逻辑在三端有三份拷贝，行为却不一致。
- **触发场景**：云端会话服务器未安装 ripgrep 时，Agent 调用 glob_search 基本不可用。
- **修复建议**：walk 内跳过忽略目录集合（`file.service.ts` 已有同名 IGNORED_DIRS 集合可直接复用），至少包含 node_modules、.git、dist。

---

## BUG-08【中 · 兼容性】流式工具名分片追加拼接，name 可能被拼坏

- **模块**：backend-ts（harness AgentLoop 流式聚合）
- **位置**：`backend-ts/src/harness/core/agent-loop.ts:557-566`（applyToolCallDelta）
- **代码片段**：

```ts
// agent-loop.ts:560-565
if (delta.function.name) {
  if (!target.function.name) {
    target.function.name = delta.function.name;
  } else if (delta.function.name !== target.function.name) {
    target.function.name += delta.function.name;   // ← 追加拼接
  }
}
```

- **问题描述**：OpenAI 规范上工具名不应分片传输，但部分兼容网关会把长工具名切成多个 delta（`"read_"` + `"_file"`）。当前实现遇到与已累积名不同的分片就追加，得到 `read__file`；而如果网关每片都发完整名（另一种常见行为），又因相等判断被去重侥幸正确。两种上游行为的处理混在一个分支里，前者必错。拼坏的名字进入 ToolDispatcher 后查不到工具，整轮工具调用失败。
- **触发场景**：经由对 tool_call.delta 做分片/改写的 LLM 网关或代理访问模型时。
- **修复建议**：name 只允许在为空时赋值一次（`if (!target.function.name) target.function.name = delta.function.name`），不做追加；arguments 保持现有累加逻辑不变。

---

## BUG-09【中 · 功能丢失】压缩请求派生丢失 thinking/enableThinking 字段

- **模块**：backend-ts（上下文压缩 CompactionService）
- **位置**：`backend-ts/src/harness/core/compaction-service.ts:111-122`（deriveRequest）；字段定义见 `backend-ts/src/harness/llm/chat-request.ts:60-69`；序列化会发送：`backend-ts/src/harness/llm/json.ts:84-85`
- **代码片段**：

```ts
// compaction-service.ts:111-122 —— 只透传了 tools/temperature/reasoning/audio
deriveRequest(source: ChatRequest, appendedUserContent: string): ChatRequest {
  const messages: ChatMessage[] = source.messages ? [...source.messages] : [];
  messages.push({ role: 'user', content: appendedUserContent });
  return {
    messages,
    tools: source.tools,
    temperature: source.temperature,
    stream: true,
    reasoning: source.reasoning,
    audio: source.audio,
  };   // ← thinking / enableThinking 丢失
}
```

- **问题描述**：ChatRequest 支持 `thinking`/`enableThinking` 思考开关字段且正常请求会发送给模型，但压缩（compaction）用的派生请求只透传四个字段，思考开关被静默丢弃。对依赖 thinking 的模型，压缩摘要质量下降（压缩恰恰是长上下文场景的高价值环节），且用户配置的模型偏好未生效。
- **触发场景**：任意触发上下文压缩的长会话，且所用模型配置了 thinking/enableThinking。
- **修复建议**：deriveRequest 补齐透传 `thinking: source.thinking, enableThinking: source.enableThinking`。

---

## BUG-10【中 · 结果丢失】后台子代理提交失败路径不投递结果，父代理无从感知

- **模块**：backend-ts（后台子代理 BackgroundSubagentManager）
- **位置**：`backend-ts/src/harness/delegate/background-subagent-manager.ts:356-371`（submitExecution catch 分支）；结果收集结构 `resultsByParent`（:72）
- **代码片段**：

```ts
// background-subagent-manager.ts:356-371 —— catch 分支只做 DB + 独立 WS 通知
} catch (e) {
  this.untrackRunning(execution.parentSessionId, execution.id);   // ← 从 running 集合摘除
  await this.deps.subagentExecutionMapper.updateById(execution.id, {
    status: 'FAILED', result: '后台子代理执行提交失败: ' + ..., deliveryStatus: 'SUPPRESSED', ...
  });
  await this.deps.visibilityService.finishSubagent(child.id, child.userId, 'FAILED', '');
  return { ok: false, error: '后台子代理执行提交失败，请稍后重试' };
}
// 注意：全程没有向 resultsByParent 投递任何条目
```

- **问题描述**：agentExecutor 队列满拒绝提交时，该路径 untrack + DB 标 FAILED + 单独 WS 事件，但不往 `resultsByParent` 写入失败条目。父代理侧 `waitForAll` 收集循环以 `runningByParent`/`resultsByParent` 判定：untrack 之后 `hasRunning=false`、`hasPendingResults=false`，循环当作"一切正常且无产出"直接结束。父代理的对话上下文中这个子代理就像从未存在过（LLM 拿不到失败信息，无法重试或向用户解释），失败只见于 DB 和一条独立的可见性事件。
- **触发场景**：并发子代理较多打满 executor 队列时，spawn 的 submit 被 reject。
- **修复建议**：catch 分支同步 push 一条 `{ taskId, status: 'FAILED', error }` 进 `resultsByParent`，让 waitForAll 正常收集并把失败作为工具结果回给父代理。

---

## BUG-11【中 · 输入丢失】REPL 模式 resume 活跃会话时用户输入被静默吞掉

- **模块**：agent-cli（会话运行器）
- **位置**：`agent-cli/src/session/session-runner.ts:269`（死代码三元）、`:255-270`（handleAlreadyActive 的 REPL 分支空操作）、`:289-330`（handleAlreadyRunningEvent 非 printMode 直接终止）
- **代码片段**：

```ts
// session-runner.ts:269 —— 三元两个分支完全相同，等于什么都没做
this.executionId = this.session?.phase === 'RUNNING' || phase === 'RUNNING' ? this.executionId : this.executionId;

// :289-293 —— REPL 模式收到 session_already_running 直接终止本轮
private async handleAlreadyRunningEvent(runningEid?: string): Promise<void> {
  if (!this.opts.printMode) {
    this.terminal = { phase: 'ALREADY_RUNNING' };
    this.flushWaiters();
    return;
  }
```

- **问题描述**：REPL 向一个仍在执行的会话发送消息时：`handleAlreadyActive` 的非 printMode 分支只有一个自我赋值的死三元，实际是空操作；随后服务端的 `session_already_running` 事件走 `handleAlreadyRunningEvent`，非 printMode 直接把本轮置为 `ALREADY_RUNNING` 终止。printMode 尚有 pendingContent 保存 + 重试逻辑，REPL 什么都没有——用户敲进去的消息既没发出也没有任何提示，静默丢失。
- **触发场景**：mao-agent REPL 连接着一个正在 RUNNING 的会话（例如另一个终端/桌面端正在跑同一会话），此时在 REPL 里继续输入。
- **修复建议**：REPL 分支参照 printMode：保存 pendingContent，等待会话 settle 后自动重发；至少应向 stderr 打印明确提示"会话忙，本次输入未送达"。

---

## BUG-12【低 · 竞态/重复请求】admin 会话详情页无请求竞态防护；列表/监控页首屏双请求

- **模块**：admin（Vue3 视图）
- **位置**：`admin/src/views/session/SessionDetailView.vue:127-141`（fetchDetail 无序号/AbortController）；`admin/src/views/session/SessionListView.vue:245-252`、`admin/src/views/RuntimeMonitorView.vue:207-208`（watch(params) + onActivated 因 keep-alive 首屏同时触发）
- **代码片段**：

```js
// SessionDetailView.vue:127-135 —— 快慢请求交错时旧响应覆盖新数据
async function fetchDetail() {
  const id = route.params.id
  loading.value = true
  try {
    const [sessionRes, messagesRes] = await Promise.all([
      api.get(`/admin/sessions/${id}`),
      api.get(`/admin/sessions/${id}/messages`, { params: { roundLimit: ROUND_LIMIT } })
    ])
    sessionInfo.value = sessionRes.data      // ← 不校验 id 是否仍是当前路由
```

- **问题描述**：详情页在路由参数变化（watch）与组件激活（onActivated，keep-alive）时可并发触发两次 fetchDetail，无请求序号也无 AbortController，先发后至的旧会话响应会覆盖当前应显示的会话数据。列表页与运行监控页因 watch 和 onActivated 在首次激活时都会命中，必然重复请求同一接口两次。
- **触发场景**：keep-alive 下快速切换会话详情；首次进入列表/监控页（抓包即可看到重复请求）。
- **修复建议**：fetchDetail 记录 `const reqId = ++latestReqId`（或 AbortController），响应落地前校验是否仍是最新请求；列表/监控页用"watch + immediate"或去抖统一入口消除首屏双发。

---

## BUG-13【低 · 幂等】RestClient 对非幂等 POST 也自动重试，弱网下可能重复建会话

- **模块**：agent-cli（REST 客户端）
- **位置**：`agent-cli/src/rest/rest-client.ts:134-141`（网络异常重试）、`:195-203`（5xx 重试）——两处均不看 method
- **代码片段**：

```ts
// rest-client.ts:134-141 —— 网络错误一律重试 2 次，POST 也不例外
} catch (err) {
  clearTimeout(timer);
  const netRetries = options._retriedNet ?? 0;
  if (netRetries < 2) {
    await sleep(200 * 2 ** netRetries);
    return this.request<T>(method, apiPath, { ...options, _retriedNet: netRetries + 1 });
  }
```

- **问题描述**：请求超时/连接中断/5xx 时对所有 method 一律重试。若第一次请求实际已被服务端接收并处理（只是响应未回来），`createSession` 这类非幂等 POST 会重复建会话，客户端拿到的却是第二次的新会话，第一次成为孤儿数据。
- **触发场景**：弱网/超时边缘下执行登录后的首个创建类操作。
- **修复建议**：自动重试限定 GET/HEAD/PUT/DELETE 等幂等方法；POST 的重试交给调用方显式声明幂等键或由用户决策。

---

## BUG-14【低 · 可靠性】取消指令走不可靠 ws.send，断线窗口内被静默丢弃

- **模块**：agent-cli（会话控制）
- **位置**：`agent-cli/src/session/session-runner.ts` 多处（`:175-178`、`:261`、`:344`、`:536`、`:547` 等），均为 `this.opts.ws.send({ type: 'cancel', ... })`；对照：同类关键帧已有 `sendReliable`（sendMessage 即使用它）
- **代码片段**：

```ts
// session-runner.ts:261 —— Ctrl+C 取消直接裸发
this.opts.ws.send({ type: 'cancel', sessionId: this.sessionId });
```

- **问题描述**：WS 断线重连窗口内 `send()` 要么抛异常要么写入已关闭的 socket，取消帧被静默丢弃且无重发。用户按 Ctrl+C 以为已停止，服务端任务却跑满全程（持续消耗 Token、写文件等副作用照常发生）。项目里已有可靠发送通道 `sendReliable`，却未用于这种关键控制帧。
- **触发场景**：网络抖动瞬间执行取消；或取消恰逢自动重连过程中。
- **修复建议**：cancel 帧改走 `sendReliable`（带确认/重发），或在 send 抛错/返回失败时降级为 REST 取消接口兜底。

---

## 附 A：已排查、确认无问题的点

以下重点怀疑对象经逐项核查确认逻辑正确，记录避免后人重复排查或误报：

- **WsClient 重连后重放订阅**（agent-cli）：订阅集合在重连后重放，语义正确。
- **admin api 客户端 401 单飞刷新**（admin）：并发 401 只触发一次刷新令牌。
- **serializePayload 二分截断**（agent-cli）：大 payload 截断边界处理正确。
- **files.ts 的 applyEditMatch 匹配算法**：唯一/多处替换判定正确。
- **computeLineDelta（LCS 行差计算）**：write_file 侧统计准确（BUG-04 的对照组）。
- **agent-cli search.ts 的 globWithNode/grepWithNode**：walk 均跳过 node_modules 与 .git，与 rg 路径行为一致（注意：BUG-07 仅后端实现缺失此过滤）。
- **agent-loop 空 anchor / 取消 flag 双 Map 链路**：均有兜底，无悬空引用。
- **waitForAll 无超时但有 cancelFlag 兜底**；side-task 取消亦有 flag 兜底。
- **ApprovalRegistry 的 Set 语义**：并发审批登记本身正确（问题出在 CLI 渲染层单槽，见 BUG-02）。
- **ask_user_questions 超时闭环**、**cleanupIncompleteTailList**、**scheduled-task executeTask 的 inFlight 防护**：均自洽。
- **statistics getModelStats**：messageTokens 与 backgroundTokens 来源不同，无双算。
- **persistToolRound 事务双重校验**、**stopExecution 乐观更新 + session_snapshot 自愈**：正确。

## 附 B：遗留隐患（不计入 BUG）

- **updatePhase elapsedMs 依赖服务器时区**：内部使用 `Date.parse` 解析本地格式时间字符串，隐式要求部署环境 TZ=Asia/Shanghai。当前部署一致故不构成缺陷；若未来容器/宿主机改为 UTC 将出现耗时计算偏差。建议统一存 UTC 时间戳或显式带偏移量。
- **三份搜索工具 JS 回退实现拷贝**（backend-ts / desktop main.cjs / agent-cli search.ts）：BUG-07 正是拷贝间漂移的产物。建议抽公共实现或至少加一致性测试。
