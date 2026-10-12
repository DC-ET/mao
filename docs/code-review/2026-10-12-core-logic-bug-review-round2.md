# 2026-10-12 核心功能逻辑 BUG 审查（round 2）

> 审查方式：通读 backend-ts / desktop / admin / agent-cli / shared 五端源码，对每个候选 BUG 先在当前代码完整推演触发路径，再补写可运行的测试用例验证「真实存在」。
> 所有验证用例均为「按正确语义断言、当前实现下失败」的探针（命名 `zz-review-*` 或追加在现有 spec 的 `review:` describe 中），修复后应转正为产品回归用例。
> 本文档只收录**有失败用例佐证**的逻辑 BUG，共 10 个；未经测试验证的推测统一放入文末「其他观察」，不计入正式结论。
> **更新（2026-10-12）**：10 个 BUG 已全部修复，探针用例全部转正为回归用例并通过，修复记录见「修复记录」节，回归结果见「回归验证」节。

## 核实结论（2026-10-12 复跑）

对 10 个 BUG 逐项复跑探针 + 重读当前源码复核根因：**全部真实存在，探针均按预期失败**；根因描述与代码现状一致，无需修正。修复价值评估：10 项均有明确用户可见损害（挂起 / 越权 / 静默失败 / 数据丢失 / 配置失效 / 统计不一致），**无一属于「不存在」或「价值不高」，全部保留并修复**。文末「其他观察」3 条维持原样（未验证 / 加固建议 / 测试基建提示），不计入正式结论。

| # | 探针复跑结果 | 核实结论 |
|---|---|---|
| BUG-1 | 2 失败 / 2 对照通过 | 存在，修复价值高（打印模式永久挂起） |
| BUG-2 | 1 失败 / 2 对照通过 | 存在，修复价值高（跨会话 shell 越权） |
| BUG-3 | 2 失败 / 1 对照通过 | 存在，修复价值高（错误目录静默执行） |
| BUG-4 | 2 失败 / 1 对照通过 | 存在，修复价值高（checks 翻倍幻影行） |
| BUG-5 | 4 失败 / 1 对照通过 | 存在，修复价值高（真实变化被吞） |
| BUG-6 | 1 失败 / 1 对照通过 | 存在，修复价值中高（用量与落库不一致） |
| BUG-7 | 1 失败 | 存在，修复价值中（重复气泡 / 步骤虚增） |
| BUG-8 | 1 失败 / 1 对照通过 | 存在，修复价值中高（部分回复唯一副本丢失） |
| BUG-9 | 2 失败 / 2 对照通过 | 存在，修复价值中高（配置优先级失效） |
| BUG-10 | 1 失败 / 1 已知风险通过 | 存在，修复价值中（深翻页重复/丢行，修复成本极低） |

## 结论概览

| # | 严重度 | 位置 | 问题一句话 | 验证用例 |
|---|---|---|---|---|
| BUG-1 | P1 | agent-cli `session/session-runner.ts:379-391` | 断线重连后终态 `session_snapshot` 无法结束本轮等待，打印模式永久挂起 | `agent-cli/test/zz-review-snapshot-terminal.spec.ts` |
| BUG-2 | P1 | backend-ts `harness/shell/shell-session-manager.ts:525-532` | shell session 复用不校验 conversationId，可跨会话操作他人 shell | `backend-ts/src/harness/shell/zz-review-shell-ownership.spec.ts` |
| BUG-3 | P1 | backend-ts `harness/tool/impl/shell-session-tool.ts:185` | workdir 的 `cd` 失败被完全丢弃，命令在错误目录静默执行 | `backend-ts/src/harness/tool/impl/zz-review-shell-workdir.spec.ts` |
| BUG-4 | P1 | backend-ts `signal/watcher.service.ts:317-350,446` | JSON 取值失败时一次轮询落两行 check，失败记录重复计数 | `backend-ts/src/signal/watcher.service.spec.ts`（追加 `review: JSON 取值失败只能落一行 check`） |
| BUG-5 | P1 | backend-ts `signal/watcher.service.ts:170-176` | 基线重置判定用原始入参而非归一化后的值，语义未变的编辑误清基线、吞掉真实变化 | `backend-ts/src/signal/watcher.service.spec.ts`（追加 `review: 归一化后无变化的编辑不得清基线`） |
| BUG-6 | P2 | backend-ts `harness/core/agent-loop.ts:423-425` | 手动压缩被取消时 `abortRound()` 把已完成并落库的轮次用量一并丢弃 | `backend-ts/src/harness/core/zz-review-manual-compaction-usage.spec.ts` |
| BUG-7 | P2 | desktop `components/chat/SideChatPanel.vue:529-533` + `stores/session/messages.ts` | 边路任务首发迁移丢掉流式气泡注册，重复空白 assistant 气泡、步骤数虚增 | `desktop/src/stores/session.review-bugs.test.ts` |
| BUG-8 | P2 | desktop `composables/useChat.ts:833` + `stores/session/messages.ts:156-177` | 文本流式中点「停止」，已流出的部分回复整体消失（服务端不落库，唯一副本被删） | `desktop/src/stores/session.review-bugs.test.ts` |
| BUG-9 | P2 | agent-cli `args.ts:367-373,424-430` + `config/config-store.ts:137-138` | CLI 默认值挤掉用户/项目配置，`permissionLevel`/`outputFormat` 永久失效 | `agent-cli/test/zz-review-config-defaults.spec.ts` |
| BUG-10 | P3 | backend-ts `audit/audit.repository.ts:67` | 审计分页 `ORDER BY created_at DESC` 缺唯一排序键，深翻页重复/丢行 | `backend-ts/src/audit/zz-review-audit-pagination.spec.ts` |

运行方式：`cd backend-ts && npx vitest run <上述 spec 路径>`；`cd agent-cli && npx vitest run test/<spec>`；`cd desktop && npx vitest run src/stores/session.review-bugs.test.ts`。这些用例最初按预期失败（即 BUG 复现），修复后已全部转正为回归用例并通过（见文末「回归验证」）。

---

## BUG-1 断线重连后终态 `session_snapshot` 无法结束本轮等待（agent-cli，P1）

**位置**：`agent-cli/src/session/session-runner.ts:379-391`（`handleWs` 的 `session_snapshot` 分支）

```ts
if (evt.type === 'session_snapshot') {
  const phase = String(evt.data?.phase ?? '');
  const eid = evt.data?.executionId != null ? String(evt.data.executionId) : null;
  this.snapshotPhase = phase;
  if (this.session) this.session.phase = phase;
  if (eid && !this.executionId && isRunningPhase(phase)) { ... }
  const snaps = this.snapshotWaiters.splice(0);
  for (const w of snaps) w();
  return;   // ← 没有像 session_status 分支那样置 terminal 并 flushWaiters
}
```

**根因**：`waitUntilSettled()`（`:615-630`）只在 `this.waiters` 上等待，只有 `flushWaiters()` 能唤醒；`session_status` 分支在终态时会 `this.terminal = { phase }; this.flushWaiters()`（`:393-404`），而 `session_snapshot` 分支只 flush 了 `snapshotWaiters`，终态相位被当作普通状态更新处理。

**触发场景**：
1. `mao-agent -p "..."` 打印模式执行中网络抖动断开（或 30s 静默超时主动 close）。
2. 断线窗口内任务已在服务端跑完。重连后服务端按设计回传终态快照（`backend-ts/src/session/ws/streaming-ws-handler.ts:433-443`，注释原话「即使任务已结束，也必须回传终态，避免完成事件恰好在断线期间丢失后界面永久停在『执行中』」）。
3. CLI 只更新了 `snapshotPhase`，`terminal` 永远为 null → `runPrompt` 永久挂起（未设 `--max-duration` 时没有任何出路）；REPL 里该轮永远显示「执行中」，Ctrl+C 走 `runner.cancel()` 只发 cancel 帧，服务端已无在途执行、不会回终态，同样卡死。

**对照**：desktop 对终态快照的处理是正确的（`desktop/src/composables/useStreamWS.ts:923-951`，终态分支与 `session_status` 一致地 setStreaming(false)/clearActiveExecution），注释亦写明「Subscribe also reconciles a terminal state missed while the socket was disconnected」。CLI 是漏修的一侧。

**验证用例**（`agent-cli/test/zz-review-snapshot-terminal.spec.ts`，复用 `test/session-runner.spec.ts` 的 FakeWs 夹具）：不发 `session_status`，只发重连后服务端校准用的终态快照，`Promise.race` 加 500ms 看门狗：

```ts
ws.emit({ type: 'session_snapshot', sessionId: 11, data: { phase: 'COMPLETED', executionId: send.data.eventId } });
const result = await hangGuard(p);
expect((result as { status: string }).status).toBe('COMPLETED');
```

实测：两个终态快照用例均以「runPrompt 未结算（挂起）」失败；对照组（`session_status` 终态、RUNNING 快照不提前结算）通过。

**修复方向**：快照分支里若 `TERMINAL_PHASES.has(phase)` 且 `eid == null || eid === this.executionId`，则 `this.terminal = { phase }` 并 `flushWaiters()`。

---

## BUG-2 shell session 复用不校验 conversationId，可跨会话操作他人 shell（backend-ts，P1）

**位置**：`backend-ts/src/harness/shell/shell-session-manager.ts:525-532`（`getOrCreate` 复用分支）

```ts
if (shellSessionId && this.sessions.has(shellSessionId)) {
  const existing = this.sessions.get(shellSessionId)!;
  if (existing.isAlive()) { existing.touch(); return existing; }  // 未比较 existing.conversationId !== conversationId
  this.removeSession(shellSessionId);
}
```

同一缺失还在 `getSession(sessionId)`（`:550-556`，`write_stdin`/`await_async` 只按 id 取会话）与 `close(sessionId)`（`:558-560`，可关掉任意会话）。

**根因**：`ShellSession` 自带 `conversationId` 字段，`closeByConversation`/`removeSession` 也按它清理——归属是设计内的概念；但三条读取路径都不校验，`getOrCreate` 的 `conversationId` 参数在复用分支里是死参数。session id 虽含随机段，但会通过工具结果暴露给模型、再经模型输出暴露给用户，不属「不可猜测」凭证。

**触发场景**：会话 A（conversationId=1）`keep_session=true` 执行命令得到 `session_id`；会话 B（可能是另一用户的会话）的模型拿到该 id 后调用 `shell(action=exec, command="rm -rf build", session_id=...)` → 命中复用分支，命令以会话 A 的 cwd、HOME、GIT_TOKEN/MAO_TOKEN 环境执行，`refreshUserEnvironment` 还会把用户 B 的 token 写进 A 的 shell。

**验证用例**（`backend-ts/src/harness/shell/zz-review-shell-ownership.spec.ts`，真实 `ShellSessionManager` + `PathSandbox` + 临时目录）：

```ts
const a = manager.getOrCreate(1, 'sh-1-aaa', 1, join(dir, 'ws-a'), { 'github.com': 'token-a' });
let reusedSame = false;
try {
  const reused = manager.getOrCreate(2, 'sh-1-aaa', 2, join(dir, 'ws-b'), { 'github.com': 'token-b' });
  reusedSame = reused === a;
} catch { reusedSame = false; }   // 拒绝复用也是可接受的修复
expect(reusedSame).toBe(false);   // 当前实现直接返回会话 1 的 shell → 失败
```

实测：跨会话用例失败（复用了他人会话）；同会话复用、`getSession/close` 无归属参数两个对照组/说明用例通过。

**修复方向**：复用分支比较 `existing.conversationId !== conversationId` 时拒绝（或为调用方新建）；`getSession`/`close` 增加归属参数，由工具层传入当前 conversationId。

---

## BUG-3 workdir 的 `cd` 失败被完全丢弃，命令在错误目录静默执行（backend-ts，P1）

**位置**：`backend-ts/src/harness/tool/impl/shell-session-tool.ts:185`

```ts
if (workdirArg && workdir) {
  await this.executeWithMarker(session, 'cd ' + shellSingleQuote(workdir), WORKDIR_TIMEOUT_MS);
}   // ← 返回值（completed/exitCode/output）被完全丢弃
```

**根因**：`executeWithMarker`（`:399-404`）写入 `cd ...\necho __CMD_DONE__ $?` 并 `readUntilMarker`，cd 失败时返回 `{ completed: true, exitCode: 1, output: 'bash: cd: ...No such file...' }`——该返回值无人接收，`cd` 的报错既不在 output 里（被 marker 读取消费掉），也没进 output_file（`persist=false`）。随后命令在原 workspace 根目录执行，`current_workdir` 也是旧目录。

**触发场景**：模型调用 `shell(action=exec, command="cat build.gradle", workdir="/repo/sub")` 而 `/repo/sub` 不存在（或 5s 内没 cd 完）。工具描述明确承诺「传 workdir 时工具会自动 cd，无需在 command 里再写 cd」——承诺被静默破坏，相对路径在另一个目录解析，`cat`/`rm -rf`/`./gradlew` 会作用到错误文件上，而模型/用户看不到任何失败信号。超时分支同理，且残留的 pendingCommand 会被后续 `writeCommand` 覆盖，cd 输出被写进本次命令的 output_file。

**验证用例**（`backend-ts/src/harness/tool/impl/zz-review-shell-workdir.spec.ts`，mock `OutputManager.readUntilMarker` 第 1 次返回 cd 失败、第 2 次返回命令输出）：

```ts
const result = JSON.parse(await tool.execute(
  JSON.stringify({ action: 'exec', command: 'cat secret.txt', workdir: '/definitely/not/exist' }), 11, 7, '/tmp'));
expect(result.error).toMatch(/cd|工作目录|No such file/);          // 当前为 undefined → 失败
expect(result.output ?? '').not.toContain('workspace-root-file-content'); // 命令被放行执行 → 失败
```

实测：两个用例均失败；对照组（cd 成功）通过。

**修复方向**：接收 `executeWithMarker` 的返回值，`exitCode != 0` 或 `!completed` 时直接返回错误 JSON（如 `error: '工作目录切换失败：...'`）并中止本次 exec；async 分支同样处理。

---

## BUG-4 JSON 取值失败时一次轮询落两行 check（backend-ts signal，P1）

**位置**：`backend-ts/src/signal/watcher.service.ts:317-326`（先插 check 行）→ `:344-350`（catch 里 `markCheckError(checkId)` **又**调用 `recordFailure`）→ `recordFailure` 内部 `:446` 再次 `checkRepo.insert`。

```ts
} catch (e) {
  // JSON 解析 / 路径提取失败：check 行已落，改为失败口径
  await this.markCheckError(checkId, e);
  await this.recordFailure(watcher, e, result.httpStatus, result.durationMs);   // recordFailure 里又 insert 一行
  return;
}
```

**根因**：`recordFailure` 不接收也不复用已有 checkId，无条件新建一行。同文件 `:434-437` 的 doc 注释还写着一个签名里并不存在的参数 `existingCheckId`（「`existingCheckId` 为 null 时新建一行」）——重构没改完的直接证据，原设计意图就是失败记账复用已落的那行。探针本身失败（`ok=false`）路径只插一行，行为正确；只有「取值计算失败」这条路径重复。

**影响**：checks 历史与 `countByWatcher` 总数翻倍、分页出现幻影行、`signal-check-cleanup` 的保留条数被放大、UI 上同一次失败轮询显示两条。现有测试 `watcher.service.spec.ts:410-429` 只用 `h.checks.some(c => c.error?.includes('JSON'))` 断言，两行也满足，所以漏过了这个 bug。

**验证用例**（追加在 `backend-ts/src/signal/watcher.service.spec.ts`）：

```ts
const h = harness({
  watcher: watcher({ compareMode: 'JSON_FIELD', jsonPath: 'v', lastValueHash: sha256('1') }),
  probe: () => probeResult({ body: 'not-json', bodyBytes: Buffer.from('not-json', 'utf8') }),
});
await h.service.runCheck(1);
expect(h.checks).toHaveLength(1);        // 当前实现为 2
expect(h.checks[0]!.error).toContain('JSON');
expect(await h.service.listChecks(1, 1, 20)).toHaveLength(1);
```

实测：JSON 解析失败、jsonPath 取不到值两个用例均失败（落了两行）；对照组（探针本身失败只落一行）通过；该文件原有 48 个用例不受影响。

**修复方向**：`recordFailure` 增加可选 `existingCheckId` 参数，命中时改为 `markError(existingCheckId, ...)` 而不是新插一行（与注释描述的原设计对齐）。

---

## BUG-5 基线重置判定用原始入参而非归一化后的值（backend-ts signal，P1）

**位置**：`backend-ts/src/signal/watcher.service.ts:170-176`（`resetBaseline` 计算）

```ts
const resetBaseline = AFFECTS_BASELINE.some((field) => {
  const next = effective[field];   // ← 原始入参：'get' / 'hash' / ' data.price ' / 'https://Example.com/api'
  return next !== undefined && JSON.stringify(next) !== JSON.stringify(existingRaw(existing, field, this));  // ← 库内归一化值
});
```

**根因**：`normalizeInput`（`:486-549`）会把 method/compareMode `trim().toUpperCase()`、jsonPath `trim()`、url 经 `assertProbeUrl` 规范化（主机转小写等），落库值与库内一致、存储内容零变化；但 `resetBaseline` 只对 headers 做了归一化比对（`canonicalHeaders`），其余字段直接拿原始入参与库内归一化值比较。`:167-169` 的注释写明的意图（「用本次实际生效的值而非原始入参」）没有贯彻到这几个字段。

**触发场景与影响**：哨兵已建立基线，用户编辑时回传 `{"method": "get"}`（或 `{"compareMode": "hash"}`、`{"jsonPath": " data.price "}`、`{"url": "https://Example.com/api"}`）→ 判定「判定字段变化」→ 基线被清 → 下一轮轮询走「首轮只建基线」分支，**从上一次成功轮询到这次编辑之间目标发生的真实变化被静默吞掉，不触发告警**——哨兵核心功能（变化告警）失效。现有测试 `:686-695` 已用 `method: 'post'` 触达该路径，但只断言了 `stored.method`，没有断言基线保留，所以漏报。

**验证用例**（追加在 `backend-ts/src/signal/watcher.service.spec.ts`）：

```ts
const h = harness({ watcher: watcher({ method: 'GET', lastValueHash: 'abc', lastValueSnippet: 'OLD', lastChangedAt: '2026-10-11 10:00:00' }) });
await h.service.update(7, 1, { method: 'get' });
expect(h.watchers.get(1)!.method).toBe('GET');
expect(h.watchers.get(1)!.lastValueHash).toBe('abc');   // 当前实现为 null → 失败
```

实测：小写 method、小写 compareMode、jsonPath 首尾空白、URL 主机大小写四个用例均失败（基线被误清）；对照组（url 真实变化仍重置基线）通过。

**修复方向**：`resetBaseline` 改用 `normalized[field]`（headers 仍走 `canonicalHeaders`）与 `existingRaw(...)` 比较，即「落库值 vs 库内值」。

---

## BUG-6 手动压缩被取消时丢弃已完成轮次的用量（backend-ts harness，P2）

**位置**：`backend-ts/src/harness/core/agent-loop.ts:420-425`（纯文本收尾；工具轮边界的 `:479-482` 是同一模式）

```ts
closeRound();
if (await this.consumeManualCompaction(context, listener, persistenceCallback, cancelFlag ?? null)) {
  abortRound();   // abortRound = context.totalUsage = usageBeforeRound + closeRound()
}
break;
```

**根因**：`abortRound` 的契约（`:189-193` 注释）是「丢弃**本轮未完成**用量（消息已 rollback，不应记为正常完成）」。但这条路径上：`onComplete` 已 `context.addUsage(usage)`（`:291`）、`afterStream` 里的 `onSaveAssistantMessage` 已被 await（`:319`）、tokenCount 已写入 message 表——消息没有 rollback、轮次已正常收尾、用量已入库。取消的是「压缩」这个附带动作，却把「本轮回答」的计量一并回滚，随后 `listener.onMessageEnd(context.totalUsage)`（`:512`）把「零增量」报给客户端，会话用量统计少记一轮、与 DB 里已持久化的 tokenCount 不一致。

**验证用例**（`backend-ts/src/harness/core/zz-review-manual-compaction-usage.spec.ts`，真实 `CompactionSignalBus` + stub 装配）：在 LLM stream 回调中置位手动压缩信号（模拟用户输出期间点击「压缩」），`orchestrator.compact` 以 `CompactionCancelledException` 拒绝：

```ts
llmAdapter.stream.mockImplementation(async (_r, _c, callback) => {
  compactionSignalBus.signal(11);
  callback.onChunk(contentChunk('hello'));
  callback.onComplete({ promptTokens: 1200, completionTokens: 80, totalTokens: 1280 });
});
await agentLoop.execute(ctx, l, p);
expect(p.onSaveAssistantMessage).toHaveBeenCalledWith('hello', null, [], expect.objectContaining({ totalTokens: 1280 }));
expect(ctx.totalUsage.totalTokens).toBe(1280);   // 当前为 0 → 失败（expected +0 to be 1280）
```

实测：用例失败且失败信息正是 `expected +0 to be 1280`——消息已落库（前一断言通过）而用量被回滚；对照组（无压缩信号）通过。

**修复方向**：`consumeManualCompaction` 返回「已取消」时不要调用 `abortRound()`（本轮已 closeRound、已落库，用量应保留）；或让 abortRound 只回滚「未落库」的部分。

---

## BUG-7 边路任务首发迁移丢掉流式气泡注册（desktop，P2）

**位置**：`desktop/src/components/chat/SideChatPanel.vue:529-533`（sideSessionId watcher 的迁移）+ `desktop/src/stores/session/messages.ts:109-113`（`setMessages` 删注册）、`:523-527`（`clearMessages` 删注册）、`:284-315`（`ensureStreamingAssistantMessage` 的复用条件）。

**根因**：首发时乐观消息和占位 assistant 气泡都挂在占位 key（`tabId`）下，且 `streamingAssistantMessageIds` 注册了该占位气泡。迁移用 `setMessages(newId, [...tempMsgs])` + `clearMessages(placeholderKey)` 整体搬运——两个 action 都会 `streamingAssistantMessageIds.delete(sid)`，注册丢失。随后 `user_message_saved` 只替换乐观用户 ID；首个 `content_delta` → `ensureStreamingAssistantMessage(真实sid)`：末条确实是 assistant（迁移来的占位气泡），但 `streamingAssistantMessageIds.get(sid) !== lastMsg.id` → **新建第二个气泡**。fork 模式因 watcher 结尾会 `fetchMessages()` 收尾而不受影响，仅非 fork 首发复现。

**触发场景**：主会话点「新建边路任务」选非 fork 模式，输入消息发送 → 流式气泡上方多出一个空白 assistant 气泡，该轮折叠头显示「已执行 N+1 个步骤」（`useMessageRounds` 把两个 assistant 气泡都计为一个步骤），终态 REST 重拉后才消失。

**验证用例**（`desktop/src/stores/session.review-bugs.test.ts`，store 级复刻迁移时序）：

```ts
store.addUserMessage('tab-7', { id: 'side_user_1', role: 'user', content: '帮我审查', createdAt: '...' });
const bubble = store.ensureStreamingAssistantMessage('tab-7');
store.setMessages('42', [...store.getMessages('tab-7')]);   // 迁移
store.clearMessages('tab-7');
store.updateLastMessageId('42', 'user', '501');
store.appendDelta('42', '第一段回复');
expect(store.getMessages('42').map(m => m.role)).toEqual(['user', 'assistant']);  // 当前实际 ['user','assistant','assistant'] → 失败
```

实测：失败，`expected [ 'user', 'assistant', 'assistant' ] to deeply equal [ 'user', 'assistant' ]`。

**修复方向**：迁移时把 `streamingAssistantMessageIds` 的条目从占位 key 改注册到真实 sid（或迁移后对末条 assistant 重新注册）。

---

## BUG-8 文本流式中点「停止」，已流出的部分回复整体消失（desktop，P2）

**位置**：`desktop/src/composables/useChat.ts:833`（终态 `fetchMessages()` 未传 `preserveLiveStream`）+ `desktop/src/stores/session/messages.ts:156-177`（`applyFetchedMessages` 尾部规则：assistant 仅当 `preserveStreamingAssistant && isStreamingAssistant` 才保留）+ `:492-512`（`finishInterruptedStreamingMessage` 保留气泡但删除注册）。

**根因**：后端被中止的轮次**从不落库**文本（`backend-ts/src/harness/core/agent-loop.ts:386-390`：流中途取消时 `onComplete` 不触发，assistant 消息落库只发生在 onComplete 与工具轮后）。桌面停止时 `finishInterruptedStreamingMessage` 特意保留气泡（`tool-spinner-stuck.test.ts:70` 场景 D 正是断言中断态可见——意图就是让用户看到中断现场），但删掉了流式注册；随后终态重拉以无 preserve 模式合并，把这条未注册的尾部 assistant 气泡丢弃，而服务端又没落过库——**唯一副本被删，内容永久丢失**，刷新页面依然没有。自相矛盾之处：若停止发生在**工具执行中**，`onComplete` 已落库，部分文本能从 REST 拿回来、不丢；同一种用户操作（中止一轮）两种结果。

**验证用例**（`desktop/src/stores/session.review-bugs.test.ts`）：

```ts
store.ensureStreamingAssistantMessage('9');
store.appendDelta('9', '好的，这是快速排序实现：');
store.finishInterruptedStreamingMessage('9', '执行已被中止');
store.applyFetchedMessages('9', [{ id: '100', role: 'user', content: '写个快排', createdAt: '...' }]);
expect(store.getMessages('9').map(m => m.role)).toEqual(['user', 'assistant']);  // 当前实际 ['user'] → 失败
```

实测：失败，`expected [ 'user' ] to deeply equal [ 'user', 'assistant' ]`；对照组（正常完成后按 REST 覆盖）通过。

**修复方向**（任一侧）：桌面终态路径对「有内容的中断气泡」保留（`finishInterruptedStreamingMessage` 不删注册 + 终态重拉传 `preserveLiveStream`），或后端取消时落库部分文本。

---

## BUG-9 CLI 默认值挤掉用户/项目配置，`permissionLevel`/`outputFormat` 永久失效（agent-cli，P2）

**位置**：`agent-cli/src/args.ts:367-373`（`outputFormat` 用 `parseEnum(..., 'text', lower)`，不传 flag 也永远返回 `'text'`）、`:424-430`（`permissionLevel` 同理永远至少 `'READ_WRITE'`）+ `agent-cli/src/config/config-store.ts:137-138`（`resolveConfig` 优先级链 `cli.x || project.x || user.x || 默认`）+ `agent-cli/src/main.ts:75-82`。

**根因**：`parseEnum` 在 raw 为 undefined 时返回 fallback，所以 `parseCliConfig` 对未显式下发的这两个字段也填入默认值；`resolveConfig` 的 `||` 链永远命中 CLI 默认，project/user 两级是死代码（`commands/chat.ts:314` 的 `cfg.permissionLevel || resolved.permissionLevel` 同样是死兜底）。`--help` 的帮助文本（`args.ts:488`）明确写着优先级「命令行 > 环境变量 > 项目配置 > 用户配置 > 内置默认」，且既有单测 `test/config-store.spec.ts:66-88` 就是在断言「CLI 不传时用户配置文件生效」——该测试之所以通过，是因为它绕过了 `parseCliConfig`；真实链路里配置被挤掉。旁证：同为配置项的 `baseUrl`、`ui.verboseTools/asciiOnly/queuedInput` 未传 flag 时都正确返回 `undefined`，只有这两个字段破坏约定。

**触发场景**：`~/.mao/agent-cli/config.json` 写 `{"permissionLevel": "FULL"}`，运行 `mao-agent --local -p "ls"`（不传 `--permission-level`）→ 实际建会话用 READ_WRITE，LOCAL 审批按 READ_WRITE 放行/询问；`outputFormat: "json"` 同理被忽略。

**验证用例**（`agent-cli/test/zz-review-config-defaults.spec.ts`）：

```ts
const cfg = parseCliConfig([], tty);
expect(cfg.permissionLevel).toBeUndefined();   // 当前为 'READ_WRITE' → 失败
expect(cfg.outputFormat).toBeUndefined();      // 当前为 'text' → 失败
```

实测：两个用例失败（`expected 'READ_WRITE' to be undefined` / `expected 'text' to be undefined`）；显式下发、环境变量两个对照组通过。

**修复方向**：`parseCliConfig` 对未显式指定的 `permissionLevel`/`outputFormat` 返回 `undefined`（env 已在 parseEnum 内折叠，保持现状即可），或 `main.ts` 只在显式设置时才传给 `resolveConfig`。注意改默认值后需同步更新 `args.spec.ts` 中断言缺省值的既有用例与 `config-store.spec.ts:56-57`。

---

## BUG-10 审计分页排序键不唯一，深翻页重复/丢行（backend-ts audit，P3）

**位置**：`backend-ts/src/audit/audit.repository.ts:67`

```sql
SELECT * FROM audit_log ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?
```

**根因**：`audit_log.created_at` 是秒级 DATETIME（`db/migration/V048__admin_governance_console.sql:15`，无小数位），而 `audit.interceptor.ts` 对 `/v1/agents`、`/v1/models`、`/v1/users` 等写方法**每个请求落一行**——管理员连续点两下保存、或任何并发请求，就会在同一秒产生 `created_at` 完全相同的多行。`ORDER BY created_at DESC` 在 audit_log 上不是全序，MySQL 对并列行返回顺序不保证稳定；带 `WHERE user_id = ?` 等条件时优化器无法用 `idx_audit_created` 直接满足排序，会退化成 filesort，两次查询的并列行顺序可以不同。**实际行为**：第 2 页重复出现第 1 页已给出的审计行，同时另一行在任何页都不出现——审计留痕在分页列表里静默丢失。

**同一根因的其他命中点**（建议一并修）：`user/user.repository.ts:144`、`session/session.service.ts:483`（`listSessionsForAdmin`）、`command/command.repository.ts:54`（`listPersonalPaged`，另 15/22/45 三处同款）。对照：`session.repository.ts:379`（`ORDER BY updated_at DESC, id DESC`）、`llm-call.repository.ts:214`（`ORDER BY id DESC`）都带唯一 tiebreaker，说明这是遗漏而非约定。

**验证用例**（`backend-ts/src/audit/zz-review-audit-pagination.spec.ts`，Db stub 捕获 SQL）：

```ts
await repo.selectPage(1, 20, {});
const sql = String(db.query.mock.calls[0]![0]);
expect(sql).toMatch(/ORDER BY created_at DESC, id DESC/);   // 当前 SQL 无 id tiebreaker → 失败
```

实测：失败，`expected 'SELECT * FROM audit_log  ORDER BY cre…' to match /ORDER BY created_at DESC, id DESC/`。

**修复方向**：四处排序统一补 `, id DESC`（或 `, id ASC`，与现有 session.repository 口径一致）。

---

## 修复记录（2026-10-12）

| # | 修复方式 | 探针转正 |
|---|---|---|
| BUG-1 | `session/session-runner.ts` 快照分支：`TERMINAL_PHASES.has(phase)` 且 executionId 匹配（或任一方为 null）时置 `terminal` 并 `flushWaiters()` | `zz-review-snapshot-terminal.spec.ts` 4 例全过 |
| BUG-2 | `shell-session-manager.ts` `getOrCreate` 归属不一致时不复用（为调用方新建会话、他人 shell 原样不动）；`getSession`/`close` 增加可选 `conversationId` 归属参数，工具层 `exec/write_stdin/await_async/close` 全链路传入 | `zz-review-shell-ownership.spec.ts` 全过（跨会话新建、他人会话不受影响） |
| BUG-3 | `shell-session-tool.ts` `handleExec` 接收 `executeWithMarker` 返回值：`cd` 超时或 `exitCode != 0` 即返回错误 JSON 并关掉自有会话，不再放行命令 | `zz-review-shell-workdir.spec.ts` 全过（失败目录不再静默执行） |
| BUG-4 | `watcher.service.ts` `recordFailure` 增加可选 `existingCheckId`，取值失败路径改为 `markError` 复用已落的那行 | `watcher.service.spec.ts` 追加 3 例全过（该文件共 149 例） |
| BUG-5 | `resetBaseline` 改用 `normalizeInput` 归一化后的值（headers 仍走 `canonicalHeaders`）与库内归一化值比较 | `watcher.service.spec.ts` 追加 5 例全过 |
| BUG-6 | `agent-loop.ts` 三处 `consumeManualCompaction` 取消分支去掉 `abortRound()`（轮次已 closeRound、消息已落库，用量保留）；`abortRound` 仍只服务真正的取消路径 | `zz-review-manual-compaction-usage.spec.ts` 全过 |
| BUG-7 | `stores/session/messages.ts` `setMessages` 识别占位 id（`msg_*_assistant`）的末条 assistant，把流式注册从占位 key 改注册到真实 sid，首个 `content_delta` 复用原气泡 | `session.review-bugs.test.ts` 3 例全过 |
| BUG-8 | `finishInterruptedStreamingMessage` 给气泡打 `interrupted` 标记；`applyFetchedMessages` 对「有内容的中断气泡」在尾部与中段均保留，不被无 preserve 的 REST 合并丢弃；`ChatMessage` 新增 `interrupted?: boolean` | `session.review-bugs.test.ts` 同文件中断用例全过，正常完成仍按 REST 覆盖 |
| BUG-9 | `args.ts` `parseCliConfig` 对未显式下发的 `permissionLevel`/`outputFormat` 返回 `undefined`；`main.ts` 回填 `resolveConfig` 结果，恢复「cli > env > 项目 > 用户 > 默认」优先级 | `zz-review-config-defaults.spec.ts` 8 例全过（含既有缺省值断言同步更新） |
| BUG-10 | audit / user / session / command 五处分页与列表排序补 `, id DESC` 唯一 tiebreaker | `zz-review-audit-pagination.spec.ts` 全过 |

配套回归：`shell-session-tool.spec.ts` 既有 close 断言同步改为带 `conversationId`，并新增「每次会话查询都带归属 id」用例；`agent-loop` 相关既有用例不受影响。

---

## 回归验证

修复后全量回归（本机 macOS，2026-10-12）：

| 套件 | 结果 | 说明 |
|---|---|---|
| backend-ts `npm test` | 3735 passed / 0 failed / 13 skipped | 全部探针转正通过，无既有用例被破坏 |
| agent-cli `npm test` | 498 passed / 1 failed | 唯一失败为既有环境依赖（见下），与本审查无关 |
| desktop `npx vitest run` | 583 passed / 0 failed | 探针转正通过 |
| desktop `npm run build` | 通过 | `vue-tsc -b && vite build` |

- agent-cli 那个既有失败 `test/repl-slash.spec.ts > handleSlash /copy > falls back to printing the reply when no clipboard command exists` 与本审查无关：本机存在 `/usr/bin/pbcopy`，「无剪贴板命令时回退打印」分支不会进入，属环境依赖的既有现象（单独跑该文件同样失败）。
- 探针文件统一以 `zz-review-` 前缀命名（或追加在现有 spec 的 `review:` describe 中），现已全部转正为产品回归用例，保留原名继续承担回归职责。

## 测试文件清单（修复后均为回归用例）

| BUG | 测试文件 |
|---|---|
| BUG-1 | `agent-cli/test/zz-review-snapshot-terminal.spec.ts` |
| BUG-2 | `backend-ts/src/harness/shell/zz-review-shell-ownership.spec.ts` |
| BUG-3 | `backend-ts/src/harness/tool/impl/zz-review-shell-workdir.spec.ts` |
| BUG-4 | `backend-ts/src/signal/watcher.service.spec.ts`（追加 3 个用例） |
| BUG-5 | `backend-ts/src/signal/watcher.service.spec.ts`（追加 5 个用例） |
| BUG-6 | `backend-ts/src/harness/core/zz-review-manual-compaction-usage.spec.ts` |
| BUG-7 | `desktop/src/stores/session.review-bugs.test.ts` |
| BUG-8 | `desktop/src/stores/session.review-bugs.test.ts` |
| BUG-9 | `agent-cli/test/zz-review-config-defaults.spec.ts` |
| BUG-10 | `backend-ts/src/audit/zz-review-audit-pagination.spec.ts` |

## 其他观察（未经测试验证，不计入正式结论）

1. **digest 跨午夜竞态（推测，触发窗口窄）**：`digest/scheduler.ts:50-70` 的 tick 用 tick 时刻算 `yesterday` 并做 `hm >= pushTime` 门控，而 `digest/service.ts:142-166` 的 `processUser` 内部用**新的** `this.now()` 重算 `coveredDateOf()`。用户推送时间设为 `23:59` 时，tick 在 `23:59:59.8x` 放行、`processUser` 在 `00:00:00.2x` 执行到 `coveredDateOf()`，会把「刚开局的新一天」标成已处理，而调度器下一轮又按这个错误标记跳过真正的昨天——昨日摘要永久丢失。用户量大或 DB 慢时窗口可拉宽到秒级。修复方向：`processUser` 接受调度器传入的 coveredDate。**此条未写测试验证，列为待确认。**
2. **分页 size 无上限**：`audit.routes.ts:18-19`、`user.routes.ts:37-38`、`admin-session.routes.ts:84-85` 用 `queryInt(request, 'size', 20)`，而 `common/request.ts:19-23` 只校验 `n > 0` 没有上限；`size=1000000` 会直接拼进 `LIMIT`。对照 `usage/llm-call.service.ts:332`、`session.service.ts:291` 都有钳制。属加固建议。
3. **测试基建提示**：`ShellSessionManager.createSession` 在 workspace 目录不存在时 spawn 失败，vitest worker 退出时会挂起（审查过程中定位到：bash spawn ENOENT 后 worker 不退出）。产品路径 workspace 必存在，但写 shell 相关测试时需先建目录，否则用例会假死。
