# 代码评审：核心功能逻辑 BUG（2026-09-28）

- 评审范围：backend-ts（harness 引擎、session/WS、tool、auth、file）+ desktop（useStreamWS/useChat/ApprovalStack）
- 评审方式：分模块通读源码，逐条从代码本身推演触发条件与后果；已与 docs/code-review 下既有 150+ 篇历史评审去重（特别是 2026-09-17 之后的 logic-bug / frontend 系列与 0.0.177–0.0.179 已修项），所有行号以当前 main（1f8ef067）实测核对。
- **复核结论（2026-09-28）**：逐条对照当前源码确认。保留 **7** 条真实且值得修复的问题；移除 5 条（不存在 / 路径不可达 / 价值不足 / 与同日 review-01 重复），见文末「复核移除」。其后又按当前源码重核这 7 条，触发链仍成立，没有再删。

## 问题总览

| # | 严重度 | 模块 | 摘要 |
|---|--------|------|------|
| B01 | P1 | streaming-ws-handler | insert_message / edit_and_resend 窗口期「停止」被当陈旧标记丢弃，CANCELLED 被 RUNNING 覆盖 |
| B02 | P1 | session.service | togglePin/updateTitle 等按过期快照整行回写，可把 COMPLETED 会话覆盖回 RUNNING |
| B05 | P1 | desktop useStreamWS | user_message_saved 对空内容乐观消息误判，多端场景远端消息被吞 |
| B07 | P1 | grep-search-tool | JS 回退遍历用 stat 跟随符号链接：断链炸全局搜索、软链环路、越界读取 |
| B08 | P1（条件） | auth/ecp/feishu | 过期时间写侧固定上海墙钟、读侧按服务器本地时区解析（0.0.179 只修了写侧） |
| B11 | P2 | streaming-ws-handler | 边路任务用 updateField('phase') 而非 updatePhase，startedAt 永不写入、elapsedMs 恒 0 |
| B12 | P2 | harness-service | buildContext 在 MCP 连接建立后抛压缩类异常，连接（含 STDIO 子进程）泄漏 |

---

## B01【P1】插队/编辑重发窗口期的「停止」被当陈旧标记丢弃，已落库的 CANCELLED 被 RUNNING 覆盖

**位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts`
- `handleCancel` pendingCancels 分支：L1102–1118
- `handleSendMessage` 消费 pendingCancels：L446–471（`sendStartedAt` 取值：L346–347）
- `handleInsertMessage`：L1179（`executionClaims.add`）→ L1199–1205（调 handleSendMessage，**未传** `autoConsumeStartedAt`）
- `handleEditAndResend`：L665（claim）→ L677（`editMessageAndTruncate`）→ L687（注册 flag，**全程无 pendingCancels 消费**）

**代码事实**：

```ts
// handleSendMessage L346-347
const autoConsumeStartedAt = typeof data.autoConsumeStartedAt === 'number' ? data.autoConsumeStartedAt : null;
const sendStartedAt = autoConsumeStartedAt != null ? autoConsumeStartedAt : Date.now();
// L447-449
const pendingCancelAt = this.pendingCancels.get(sessionId);
this.pendingCancels.delete(sessionId);
if (pendingCancelAt != null && pendingCancelAt >= sendStartedAt) { /* 取消生效 */ }
```

**推演**（以 insert 路径为例）：
1. 插队任务在 L1179 `executionClaims.add(sessionId)` 后还要依次 `saveMessage`（DB await）、`delete`、`sendQueueUpdated` 等，之后才进入 `handleSendMessage`；L1164 的 `pendingCancels.delete` 只覆盖 claim 之前的取消。
2. 用户在 claim 添加之后、`handleSendMessage` 入口之前的窗口点「停止」：`handleCancel` L1108 走 `pendingCancels.set(sessionId, T1)`；`inFlight` 因 `executionClaims.has(sessionId)` 为 true → `finishCancelledSession` **写入 DB phase=CANCELLED**，客户端收到 `cancelled {pending:true}`。
3. `handleSendMessage` 恢复执行，入口计算 `sendStartedAt = Date.now()`（T2 > T1，因为 insert 未传 `autoConsumeStartedAt`，M-2 修复只补了 autoConsumeQueue 一条路）；L449 判定 `T1 >= T2` 为 false → 取消被当陈旧标记**静默清除**，flag 不置位，执行照常提交。
4. `runExecution` L523 `updatePhase(sessionId,'RUNNING')` 把刚写的 CANCELLED **覆盖回 RUNNING**；AgentLoop 的 DB 终态兜底检查此时查到 RUNNING，也不再取消。

`handleEditAndResend` 更直接：从 L665 加 claim 到 L687 注册 flag 之间完全没有 pendingCancels 消费逻辑，窗口期取消必然被丢。

**后果**：用户明确点了「停止」（客户端已收到 cancelled 事件），任务却回到 RUNNING 并完整跑完到 COMPLETED，DB 状态 CANCELLED→RUNNING→COMPLETED 翻转。这是 autoConsume 路径同类竞态（M-2）漏掉的两个入口。

**修复方向**：insert 路径在 L1179 记录时刻并经 `data.autoConsumeStartedAt` 传入；`handleEditAndResend` 在 `registerCancelFlag` 后补与 L447–471 相同的 pendingCancels 消费。

**复核**：源码已核对，竞态成立。与 `2026-09-28-logic-bug-review-01.md` B07（`executePersistedUserPrompt` 不消费 pendingCancels）是同一族竞态的不同入口，不重复。

---

## B02【P1】SessionService 单字段更新按过期快照整行回写，与执行终态并发时丢更新

**位置**：
- `backend-ts/src/session/session.service.ts`：L747–770（togglePin/toggleFavorite/archive/unarchive）、L1021–1050（updateSummary/updateProjectKey/updateTitle/updatePermissionLevel/updateModelId）
- `backend-ts/src/session/session.repository.ts` L101–135：`updateById` 无条件回写**全部**字段，含 `phase`、`startedAt`、`elapsedMs`、`unread`、`runtimeStatusJson`

**代码事实**：

```ts
async updateTitle(sessionId: number, title: string): Promise<void> {
  const session = await this.getSession(sessionId);   // 读整行快照
  session.title = title;
  await this.sessionRepo.updateById(session);         // 整行回写
}
```

**推演**：
1. 会话 RUNNING 中，这些 REST 路由不校验活跃 phase，用户可同时改名/置顶/归档。
2. 用户请求读到快照（phase=RUNNING、unread=0、runtimeStatusJson=旧值）；同一瞬间执行完成，`updatePhase`（session.service.ts:982–1011）用 `updateFields` 部分列写入 phase=COMPLETED、startedAt=NULL、elapsedMs 累计、unread=1。
3. 用户的 `updateById` 后提交，把步骤 2 的旧快照整行写回——**COMPLETED 被覆盖回 RUNNING**，unread/elapsedMs/失败原因一并回滚。DB 层无版本号、无条件更新（`db.ts` 的 `updateById` 逐字段 SET）。

**后果**：会话永久卡「执行中」——`handleSendMessage`（active 检查）与重试（要求终态）都会拒绝，用户只能靠「停止」自愈；未读标记、执行耗时、runtimeStatusJson 的 executionError 全部可能被旧值回滚。对照组：`editMessageAndTruncate` 与 compaction 持久化都专门用了 `lockActiveSessionById` 行锁，这批 helper 完全没有防护。

**修复方向**：这批单字段更新改走 `updateFields`（部分列写入）或条件更新。

**复核**：源码已核对，`updateById` 整行回写与 `updatePhase` 部分列写入并存，竞态成立。触发窗口窄但后果（会话永久卡 RUNNING）严重，修复成本极低，值得修。

---

## B05【P1】user_message_saved 对「内容为空」的乐观消息误判，多端场景远端消息被吞

**位置**：`desktop/src/composables/useStreamWS.ts` L777–792

**代码事实**：

```ts
const lastUser = [...list].reverse().find(m => m.role === 'user')
const isLocalOptimistic = lastUser != null
  && sessionStore.isOptimisticUserId(String(lastUser.id))
  && (lastUser.content === content || lastUser.content.trim() === '')   // ← 不校验远端 content
if (isLocalOptimistic && remoteMsgId != null) {
  sessionStore.updateLastMessageId(sid, 'user', remoteMsgId)            // 只换 ID，不追加
} else if (hasRemoteEcho) { /* 远端消息应走 addUserMessage 追加 */ }
```

**推演**：
1. 桌面端发送纯图片消息（`useChat.ts:403–409` 插入 `content: ''` 的乐观消息）。
2. 本端确认帧到达前，同一会话的其他端（微信/飞书/另一标签页——注释明确支持这些来源）发出一条文字消息，广播的 `user_message_saved` 带 `content: "任意文字"`。
3. 判定：`lastUser.content === content` 为 false，但 `lastUser.content.trim() === ''` 为 true → 误判为本地乐观消息 → 走换 ID 分支，**远端消息内容被直接丢弃**，不追加。
4. 同时 `updateLastMessageId` 把本地纯图片乐观消息的临时 ID 换成**远端那条消息的 DB ID**——本地图片气泡从此顶着别人的 messageId，后续点踩会打到错误消息上。

`|| lastUser.content.trim() === ''` 想覆盖「纯图片乐观消息」，但漏掉远端 `content` 也必须为空的对称校验。

**修复方向**：空内容匹配只对远端 `content === ''`（纯图片事件）生效；远端带文字时必须走追加分支。

**复核**：条件判定写死，多端并发 + 本地纯图场景成立。后果是丢远端消息 + messageId 串台，值得修。

---

## B07【P1】grep_search JS 回退路径用 stat 跟随符号链接：断链炸全局搜索、软链环路、越界读取

**位置**：`backend-ts/src/harness/tool/impl/grep-search-tool.ts` L219–231（`collectFiles`，L149–152 消费，L68–70 在 rg 不可用时走此路径）

**代码事实**：

```ts
async function* collectFiles(dir: string, globRe: RegExp | null, root: string): AsyncGenerator<string> {
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    const st = await stat(full);        // 跟随符号链接，且无 try/catch
    if (st.isDirectory()) { if (IGNORED_DIRS.has(name)) continue; yield* collectFiles(full, ...); }
    else if (st.isFile()) { ... yield full; }
  }
}
```

三个独立后果（工作区出现一个符号链接即可触发；`rg` 非 backend-ts 依赖，未装 rg 的宿主上这是唯一执行路径）：
1. **悬空软链 → 整个搜索失败**：`stat` 抛 ENOENT，无 try/catch，异常沿 `for await` 冒泡到 execute 的 catch，返回 `{matches:[], error}`——任何一个失效软链（pnpm/构建产物常见）让全部 grep_search 报错，而不是跳过该文件。
2. **软链环路 → 无限递归**：`ln -s . loop` 后每层 readdir 永远成功，直到栈溢出或长时间空转。
3. **软链指向工作区外 → 越界读取**：`searchWithJs` 用 `createReadStream` 读链接目标并把匹配行返回给模型。与同仓库防护直接矛盾：`workspace-browse.service.ts:124/225` 显式拒绝符号链接并做 realpath 校验；同目录 `glob-search-tool.ts:95` 写明「不跟随符号链接，避免递归环路及遍历到搜索目录之外」——同一个搜索族里 glob 防了、grep 没防。

**修复方向**：`stat` 改 `lstat`，符号链接一律跳过；`readdir`/`stat` 加 per-entry try/catch 跳过坏项。

**复核**：`stat` 无 try/catch、glob 同族已防护，对照成立。未装 rg 的宿主上是唯一路径，值得修。

---

## B08【P1·条件为宿主时区≠+08:00】ECP/飞书过期时间写侧固定上海墙钟、读侧按服务器本地时区解析

**位置**（写侧）：
- `backend-ts/src/auth/auth.service.ts:90–97` `formatShanghaiDateTime`，注释自证设计意图：「墙钟字符串，固定 Asia/Shanghai，与库内 expires_at 的字符串比较同一时钟」
- `backend-ts/src/auth/ecp-auth.service.ts:192–194`（state 过期）、`ecp-session.repository.ts:72,112`（票据过期）、`feishu-auth.service.ts:418–427`

**读侧（全部用服务器本地时区解析，不是字符串比较）**：

```ts
// ecp-session.repository.ts:36（判定 ECP 票是否可用）
if (new Date(row.expiresAt).getTime() <= now) return false;
// ecp-credentials-injector.ts:27（注入 ECP_TOKEN 前的有效性判断）
if (new Date(row.expiresAt).getTime() <= Date.now()) { ... }
// ecp-auth.service.ts:176-178 / feishu-auth.service.ts:367-372（登录二维码 state 过期）
return new Date(oauthState.expiresAt).getTime() <= Date.now();
```

**背景**：0.0.179（30c81cff）修过同族问题（当时是写本地时区、比对上海时间，UTC 容器上刚签发即过期），但只统一了**写侧**为上海墙钟；读侧的 `new Date('YYYY-MM-DD HH:mm:ss')`（无时区后缀）按引擎语义解析为**服务器本地时间**，失配仍然存在、只是方向翻转。

**推演**（宿主为 UTC，容器部署默认值）：
1. ECP 票据真实过期后被判多「活」8 小时：`isUsableEcpSession`/`injectForUser` 继续发放对端已作废的 token；若宿主时区更靠东则反向——续期调度器（`ecp-renew.scheduler.ts` 的 `listDueForRenew` 用 `expires_at <= ?` 字符串比较、时钟正确）还没续、注入端已拒发，出现「明明在续期却拿不到票」的间歇故障。
2. 登录二维码 state 有效期从 300 秒变成约 8 小时，state 可重放窗口放大约 96 倍。

**修复方向**：读侧统一改为与写侧同时钟——要么字符串比较（同 `listDueForRenew`），要么提供 `parseShanghaiDateTime` 把墙钟按 +08:00 解析。

**复核**：写侧 `formatShanghaiDateTime`/`formatDateTime` 固定 Asia/Shanghai，读侧 `new Date(naive)` 按进程本地时区，失配成立。当前若部署 TZ=Asia/Shanghai 则不触发；0.0.179 说明 UTC 容器是真实部署面，条件性问题仍值得修。

---

## B11【P2】边路任务启动用 updateField('phase') 而非 updatePhase，startedAt 永不写入、elapsedMs 恒 0

**位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts` L849；`backend-ts/src/session/session.service.ts` L805–822（updateField）与 L994–1015（updatePhase）

**代码事实**：

```ts
// L849：边路任务任务体
await this.deps.sessionService.updateField(sideSessionId, 'phase', 'RUNNING');
// updateField('phase') 只补 lastActivityAt，不写 startedAt
// updatePhase('RUNNING') 才有 if (session.startedAt == null) fields.startedAt = nowSql();
// 终态累计 elapsedMs 的前提是 session.startedAt != null
```

**推演**：边路任务每次执行都走 L849；终态经 `taskTerminalService.finishExecution` → `updatePhase`，此时 `startedAt` 为 NULL → 累计分支不成立 → `elapsedMs` 永不加算，边路任务执行时长统计恒为 0。对照：同文件主会话路径 L523 与重试路径均用 `updatePhase`，行为正确——说明 L849 是调用错位而非有意设计。

附带：任务体在提交线程池后**无启动前取消复查**——排队期间被 `cancel_side_task` 取消（写 CANCELLED 终态）的任务被调度后会先覆盖为 RUNNING 并白做一次 fork 全量复制（`forkParentMessages`），随后 agentLoop 首轮才收敛回 CANCELLED，客户端看到 CANCELLED→RUNNING→CANCELLED 翻转。对照 `background-subagent-manager.ts:556–576` 的 `runBackground` 有启动前复查守卫，此处缺失。

**修复方向**：L849 改 `updatePhase(sideSessionId,'RUNNING')`；任务体开头（改 RUNNING 前）补 `if (flag.get()) { finishExecution(CANCELLED); return; }`。

**复核**：`updateField('phase')` 确实不写 startedAt，主路径对照用 `updatePhase`。后果仅统计失真 + 排队期取消翻转，修复一行，保留 P2。

---

## B12【P2】buildContext 在 MCP 云端连接建立之后抛压缩类异常，MCP 连接（含 STDIO 子进程）泄漏

**位置**：
- `backend-ts/src/harness/core/harness-service.ts` L336–350（connectForCloud）、L414–419（压缩异常 rethrow）
- `backend-ts/src/harness/core/agent-loop.ts` L455–463（execute 的 finally 是正常释放点，buildContext 抛错时不会进入）
- `backend-ts/src/harness/core/crash-recovery-runner.ts` L276–286（finally 只清 cancelFlag/heartbeat/onExecutionFinished，无 MCP 回收）

**代码事实**：

```ts
} else if (this.mcpClientManager) {
  const cloudResult = await this.mcpSyncService.connectForCloud(sessionId, mcpServers, this.mcpClientManager);
  for (const ref of cloudResult.tools) sessionTools.push(new McpToolAdapter(ref, this.mcpClientManager));
  ...
}
// 之后若压缩抛出 CompactionContextOverflowException / CompactionCancelledException / CompactionStateReloadException：
throw e;   // buildContext 直接抛出，agentLoop.execute 从未进入，其 finally 的 closeSession 不会执行
```

**推演**：MCP 批量回收入口只有 `mcpClientManager.closeSession(sessionId)`，调用点仅 agentLoop.execute 的 finally 与 WS handler 的 `releaseSessionExecutionResources`。`buildContext` 在 L336 完成连接后、进入 agentLoop 前的抛出路径（L414–419 的压缩异常——「大上下文」会话最容易命中，且崩溃恢复时会原样复现；以及 `cleanupIncompleteTailAfterId`/`loadContextAnchor` 等未包裹的 DB 故障）会让连接泄漏：STDIO 型泄漏子进程句柄，SSE 型泄漏 socket。走 CrashRecoveryRunner（飞书/微信/钉钉通道恢复）时无人调用 `releaseSessionExecutionResources`，重试按异常次数累积。WS 主路径因 finally 兜底幸免——这正是该问题在日常主链路测试中暴露不出来的原因。

delegate / background-subagent 的 `buildSubContext` 同样直接 `buildContext`，失败清理只摘 cancelFlag/localRegistry，同样不关 MCP。

**修复方向**：`buildContext` 在 MCP 连接建立之后用 try/catch 包裹，异常路径调 `this.mcpClientManager.closeSession(sessionId)` 后再 rethrow；或把连接时机挪到压缩成功之后。

**复核**：WS 主路径 `runExecution` finally 有 `releaseSessionExecutionResources`，安全；CrashRecoveryRunner finally（L436–446）确实只清 cancelFlag/heartbeat，无 MCP 回收。条件（配了 MCP + 压缩异常）下成立，保留 P2。

---

## 已排查、确认为非问题的易疑点（勿重复报告）

- `findMergeTarget` 的 index 兜底绑定、空响应 10 次退避与 `EmptyResponseExhaustedException` 透传、mid-loop compaction 后 anchor 重置时序、`file-write-lock`/`computeLineDelta` 边界：均有 spec 覆盖。
- `dispatchAskUserQuestions` 的 `feishuChannel` 分支不可达：飞书屏蔽提问是有意终态（ff1ba575），有测试固定。
- `path-sandbox.resolve` 的 `..` 归一化、`workspace-browse` 的 realpath 符号链接防护、`sanitizeBaseName` 编码类穿越：正确。
- `PermissionService.changeRolesWithAdminGuard` 的 FOR UPDATE 最后管理员保护、`ApprovalRegistry` 的同步段判定、`WebhookDeliveryScheduler` 的 SENDING 恢复 CAS：正确。
- admin 各列表页（User/Session/Audit/LlmCall/Agent）均有 `seq` 竞态守卫 + 分页重置，未发现新问题。
- `useStreamWS` 的 `suppressedStreamSessions` 门控、`useTaskPanelPrefs` 乐观锁重试、`useCenterTabs` Map 引用替换、`useChatScroll` generation 帧控制：代码层面自洽。

---

## 复核移除（2026-09-28，逐条对照源码后删除）

| 原编号 | 原摘要 | 移除原因 |
|--------|--------|----------|
| B03 | ask_user_questions 归一化为 0 个问题时不快速失败，整轮挂起 15 分钟 | **与 `2026-09-28-logic-bug-review-01.md` B09 完全重复**（同入口 `tool-dispatcher.ts` 空 questions 只 warn 不 return）。问题本身属实、值得修，但已有独立条目跟踪，本篇不再重复开列。 |
| B04 | 审批发送失败放回重试的入口被 handledIds 永久禁用 | **与 `2026-09-28-logic-bug-review-01.md` B08 完全重复**（同为 `ApprovalStack.vue` handledIds 只增不减 + `useChat.confirmApproval` 失败放回）。问题属实，跟踪见 review-01。 |
| B06 | sendMessage 等待期间切会话写错会话 | **生产 UI 路径不可达**。`ChatPanel` 仅在 `isActive` 时走 `sendMessageWithQueue`→`enqueueMessage`，非活跃走已修的 `sendMessageAndWaitForSave`（L541–558 按 sid 取消息）；`editAndResend` 亦已按 sid 收尾。带缺陷的 `sendMessage` 只被 `sendMessageWithQueue` 的 `!isActive` 分支调用，而该分支当前无调用方。姊妹路径已修，此为死代码残留，价值低。 |
| B09 | waitForAnswer 成功路径不清超时 timer，停服卡 15 分钟 | **后果不成立**。`main.ts` 的 SIGTERM/SIGINT 收尾在 `mao.close()`/`nestApp.close()` 后强制 `process.exit(0)`，pending timer 不会拖延退出；deploy-drain 同样 `process.exit`。残留 15 分钟 timer 本身存在，但内存与退出影响可忽略，属代码卫生，价值低。 |
| B10 | uploadIncomingFile 命名去重 TOCTOU，并发同名互相覆盖 | **误报**。`uniqueIncomingName` 的 `existsSync` 到 `writeFileSync` 之间是纯同步段、无 `await`；Node 单线程事件循环下两个请求不可能同时进入该段，后写方必然看到先写方的文件并取 `-2` 序号。经典 TOCTOU 需要多线程/多进程交错，此处不适用。 |
