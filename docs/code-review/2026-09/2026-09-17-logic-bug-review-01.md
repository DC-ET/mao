# 核心功能逻辑 BUG 审查（2026-09-17 11:46）

审查范围：backend-ts 工具与待办、desktop 编辑重发/边路面板、agent-cli LOCAL 文件工具与超时控制、CLOUD/LOCAL 行尾一致性。方法：主审精读关键路径 + 分区并行探索；下列条目均已由主审回读源码核对。

本报告只列纯功能/状态机/并发/跨端一致性逻辑错误，不收录安全类问题。

**已排除（近期已有文档覆盖，勿与本报告混谈）**：
- `2026-09-17-logic-bug-review-02.md`：B01 子代理重试 untrack 窗口、B02 WS 重连 Promise 丢失、B03 待办/队列写错会话、B04 历史分页混文件变更、B05 聚焦列表未纳入新建会话、B06 角色权限保存覆盖、B07 重试结果 2000 字截断。
- `2026-09-10-logic-bug-review-01.md`：insert_message 不校验 PENDING、定时任务 QUEUED 永不完结等。

严重度：高 = 正常使用可静默丢数据/功能失效；中 = 特定交错或跨端不一致；低 = 统计口径偏差。

---

## BUG-1【高】`task_create` 的 `sortOrder` 从 0 重计，新待办会插入到既有列表中间而非追加

- **位置**：`backend-ts/src/harness/tool/impl/task-tools.ts:59-74`；对照排序 `backend-ts/src/harness/todo/session-todo.mapper.ts:15`

```ts
let count = 0;
for (const item of items) {
  // ...
  const todo: SessionTodo = {
    // ...
    sortOrder: count,   // ← 每次 create 都从 0 开始
  };
  await this.sessionTodoMapper.insert(todo);
  count++;
}
```

列表查询为 `ORDER BY sort_order ASC, id ASC`。

**根因**：创建时未读取会话当前最大 `sort_order`，新批次的 `0,1,2…` 与既有 `0,1,2…` 重叠，靠 `id` 做次级排序，导致新任务被插到旧任务中间。

**触发**：
1. 会话已有待办 A(sort=0)、B(sort=1)、C(sort=2)。
2. 模型再调用 `task_create` 写入 D、E。
3. D 写成 sort=0，E 写成 sort=1。

**影响**：列表展示为 A, D, B, E, C——新任务不在末尾，用户/模型按“列表顺序”推进工作时会打乱原计划。同一轮多次 `task_create` 也会互相穿插。

**验证**：主审直接读源码与 mapper 排序 SQL；模拟“已有 3 条 + 新建 2 条”得到交错顺序。未跑真实 DB。

**修复方向**：插入前取 `MAX(sort_order)`（同会话、`deleted=0`），新项从 `max+1` 递增；或用自增策略/单条事务内 `FOR UPDATE` 锁队尾（对齐 message_queue 的 `findLastPendingForUpdate`）。回归覆盖“已有待办后再 create”。

**历史区别**：历史报告中的 task 相关问题多在 `task_update` 状态竞态；本条是 **create 阶段 sortOrder 初始化错误**，与 update 无关。

---

## BUG-2【高】桌面端 `editAndResend` 失败回滚写入“当前会话”而非编辑目标会话

- **位置**：`desktop/src/composables/useChat.ts:596-697`，尤其 `:620` 快照、`:690-691` 回滚。

```ts
const sid = sessionId.value
const sidMessagesBeforeEdit = [...(sessionStore.getMessages(sid) ?? [])]
// ... await connect / sendEditMessage / pendingCallbacks ...
} catch (error: any) {
  sending.value = false
  if (sessionId.value) {
    sessionStore.setMessages(sessionId.value, sidMessagesBeforeEdit)  // ← 应用 sessionId.value，不是 sid
  }
}
```

**根因**：快照按入口 `sid` 捕获，回滚却写 `sessionId.value`。`requireCurrentSession` 只挡到发送前；执行期用户可自由切会话。

**触发**：
1. 在会话 A 上编辑最后一条用户消息并重发。
2. Agent 仍在跑时切换到会话 B。
3. A 执行失败 / 被拒 / 连接超时 → catch 触发。

**影响**：会话 B 的内存消息列表被整表替换成 A 编辑前的对话。catch 只 `fetchSession`（元数据）不拉消息，错内容会一直留在屏上，直到用户切走再切回。属于跨会话内容污染，比“显示了别人的待办”更重。

**验证**：主审复读快照/回滚/调用链；分区审查给出延迟响应 + 切会话的推演路径。未做真实浏览器 E2E。

**修复方向**：回滚与后续 `fetchSession`/`fetchMessages` 一律绑定捕获的 `sid`，禁止读 `sessionId.value`。成功路径 `durationMs`、`fetchMessages()`（`:670-683`）同属该家族，应一并按 `sid` 收口。回归：编辑 A → 切 B → A 失败，断言 B 消息未被改写。

**历史区别**：B03 是 todos/queue 的“请求 URL 用可变 sessionId”；本条是 **编辑重发失败路径的消息列表回滚**，对象与症状均不同。

---

## BUG-3【高】边路任务/子代理面板的停止与重试 fire-and-forget，失败后 UI 状态卡死

- **位置**：
  - `desktop/src/components/chat/SideChatPanel.vue:693-708`
  - `desktop/src/components/chat/SubagentChatPanel.vue:171-177`
  - 对照主聊天正确实现 `desktop/src/composables/useChat.ts:544-591`

```ts
// SideChatPanel — 停止
function handleStop() {
  const sid = realSessionId.value
  if (sid > 0) {
    cancel(String(sid))   // 未 await，结果丢弃
  }
  sending.value = false
}

// SubagentChatPanel — 重试
function handleRetryExecution() {
  if (retrying.value) return
  retrying.value = true
  retryExecution(sid.value)   // Promise<boolean> 被忽略
  sessionStore.ensureStreamingAssistantMessage(sid.value)
}
```

**根因**：`cancel` / `retryExecution` 底层是 `sendReliable`，断线或握手超时会返回 `false`。主聊天 `stopExecution`/`retryExecution` 会检查并 toast + 复位；两个面板既不检查也不复位。边路 `handleStop` 更是无条件 `sending=false`。

**触发**：
1. 边路任务 RUNNING，点停止：WS 短暂不可用 → `cancel` 失败，按钮已变回发送，任务仍在跑且停止入口消失。
2. 子代理 FAILED，点重试：WS 不可用 → `retrying=true` 卡死；phase 仍是 FAILED，不会进入 `RUNNING` 分支复位；KeepAlive 下切换 Tab 也不卸载实例。

**影响**：边路无法再停止；子代理重试按钮对该 Tab 生命周期永久禁用。用户只能等自然结束或刷新。

**验证**：主审对照源码确认未 await、未检查 boolean；主聊天同语义路径有完整错误处理，面板实现明显回归。

**修复方向**：两处均 `const ok = await cancel/retryExecution(...)`；失败则 toast，并回滚 `sending`/`retrying`。回归覆盖“WS down 时点停止/重试”。

**历史区别**：历史报告关注主聊天 cancel/retry 与 WS 可靠发送；本条是 **边路/子代理面板特有的状态机缺口**，主聊天路径本身正确。

---

## BUG-4【高】agent-cli LOCAL `edit_file`/`write_file` 无路径锁，并行工具调用可静默丢编辑

- **位置**：
  - `agent-cli/src/local/tools/files.ts:384-431`（edit）、`:268-301`（write）
  - 并发入口 `agent-cli/src/session/session-runner.ts:334`（`void this.opts.localExecutor?.handleEvent(evt)`）
  - 服务端并行 `backend-ts/src/harness/core/agent-loop.ts:531`（`Promise.all`）
  - 云端对照锁 `backend-ts/src/harness/tool/impl/edit-file-tool.ts:66` / `file-write-lock.ts`

```ts
// agent-cli — 无 withFileLock
const raw = fs.readFileSync(resolvedPath, 'utf-8');
const match = applyEditMatch(content, oldStr, newStr, ...);
fs.writeFileSync(resolvedPath, applyEol(updated, eol), 'utf-8');
```

**根因**：云端已用 `withFileLock` 串行化同路径 RMW；CLI LOCAL 实现没有等价物。`handleEvent` 以 `void` 调度，同轮多工具真实并发。

**触发**：LOCAL 会话；模型在同一轮对同一文件发出两个 `edit_file`（或 edit+write）。

**影响**：后写者基于旧内容覆盖，先写者的改动被静默丢失。云端有锁、本地无锁，同一模型输出在两种执行模式下结果不一致。

**验证**：主审核对 CLI 文件工具无任何 lock 字样，云端 `withFileLock` 明确；并发入口为 fire-and-forget。

**修复方向**：在 agent-cli 本地实现路径复用与云端同语义的 per-path Promise 锁；或让 LOCAL 写工具经统一串行队列。回归：并行双 edit 同文件，断言两次修改都落盘。

**历史区别**：`2026-09-02-code-review-02.md` 记录的是 CLI 无 BOM/CRLF/二进制探测等能力缺口；**并行 RMW 竞态**是新增逻辑洞，与能力清单无关。

---

## BUG-5【高】CLOUD `write_file`/`edit_file` 不保留原文件 CRLF/BOM，与 LOCAL 行为分叉

- **位置**：
  - 云端 `backend-ts/src/harness/tool/impl/write-file-tool.ts:53-56`、`edit-file-tool.ts:70-80`
  - CLI 故意保留 `agent-cli/src/local/tools/files.ts:218-224,282,416`

```ts
// CLOUD — 模型给什么写什么
writeFileSync(filePath, content);
writeFileSync(filePath, match.updated);

// LOCAL — 识别并回写原 EOL/BOM
function applyEol(content: string, eol: Eol): string {
  if (eol.crlf) out = out.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  if (eol.bom && ...) out = `\uFEFF${out}`;
  return out;
}
const toWrite = fileExisted ? applyEol(content, detectEol(rawBefore)) : content;
```

**根因**：模型输出恒为 LF/无 BOM。CLI 显式做了 detect+apply；CLOUD 工具链没有对应步骤。`grep` 确认 `write-file-tool.ts`/`edit-file-tool.ts` 无 `detectEol`/`applyEol`。

**触发**：CLOUD 会话工作区中存在 CRLF 文件（Windows 检出或 `.gitattributes eol=crlf`），模型执行任意 edit/write。

**影响**：整文件行尾被翻成 LF，git diff 显示“每一行都变了”，CI/EOL 检查失败；同一 prompt 在 LOCAL 与 CLOUD 得到不同文件字节。

**验证**：主审对照两端源码；云端写路径直接 `writeFileSync(modelString)`。

**修复方向**：将 CLI 的 `detectEol`/`stripBom`/`applyEol` 抽到共享工具，CLOUD write/edit 同样应用。回归：CRLF 文件做最小 edit，断言仍为 CRLF 且 diff 行数正确。

**历史区别**：历史文档多记 CLI 缺 EOL 处理（当时 CLI 也未做）；当前 CLI 已补齐，**缺口转移到 CLOUD**，是跨端一致性回归，不是旧问题的重复。

---

## BUG-6【中】`--max-duration` 在等待占用方之前武装，超时会取消他人执行且自身随后不再限时

- **位置**：`agent-cli/src/session/session-runner.ts:136-165`、`:249-276`、`:292-305`

```ts
this.startedAt = this.now();
this.armMaxDuration();                 // 计时开始
if (wasActive) {
  await this.handleAlreadyActive(...); // printMode wait：可能等很久
}
for (let attempt = 0; ; attempt++) {
  this.resetRound();                   // ← 清 timedOutFlag，且不再 arm
  this.executionId = randomUUID();
  // send + wait —— 无墙钟限制
}
```

`armMaxDuration` 超时回调对整个 session 发 `cancel`（不区分本进程 executionId）。

**根因**：
1. 计时器在“等别人跑完”之前就启动；
2. 超时发送会话级 cancel，会杀掉占用方；
3. 等待结束后 `resetRound()` 清掉 `timedOutFlag`，一次性 timer 未重新 arm。

**触发**：`mao-agent --max-duration 30 -p "..." --if-running wait`，另一客户端已占用会话且等待超过 30s。

**影响**：
- 取消了本进程从未拥有的对方任务；
- 随后新 prompt **无超时**继续跑，自动化脚本可能永久挂起，且不会以 TIMEOUT(124) 退出。

**验证**：主审按 runPrompt / armMaxDuration / resetRound / handleAlreadyActive 顺序通读确认。

**修复方向**：仅在真正 send 自己的 execution 后再 arm；already-active 等待用独立超时；超时 cancel 应带本进程 executionId 或只结束本地等待。回归：占用中启动带 max-duration 的 print 任务，覆盖超时与未超时两条路径。

**历史区别**：`2026-08-24-logic-bug-review-02.md` 讲的是无 max-duration 时 error 帧导致无限等；本条是 **已有 max-duration 时的武装时机与作用域错误**。

---

## BUG-7【中】行增删统计的 `splitLines` 末尾空行口径云端与 CLI 不一致

- **位置**：
  - 云端 `backend-ts/src/harness/tool/file-change-diff-util.ts:159-162`（不 pop 末尾空串）
  - CLI `agent-cli/src/local/tools/files.ts:78-82`（pop 末尾空串），注释却写“与后端同口径”（`:118`）

```ts
// backend
return text.split(/\r\n|\n|\r/);           // "hello\n" → ["hello", ""]

// agent-cli
const lines = raw.split(/\r\n|\r|\n/);
if (lines[lines.length - 1] === '') lines.pop();  // "hello\n" → ["hello"]
```

**根因**：文件末尾有无换行时，两边把同一编辑算成不同 `lines_added/deleted`。

**具体用例**：`"hello\n"` → `"hello"`
- 云端：`{linesAdded:0, linesDeleted:1}`
- CLI：`{linesAdded:0, linesDeleted:0}`

**触发**：任意只增删文件末尾换行的 edit/write。

**影响**：`file_change` 事件与前端变更统计在 LOCAL/CLOUD 不一致；“本次是否改了行”类判断错误。

**验证**：主审直接对照两处 `splitLines` 实现并手工推演上述输入。

**修复方向**：统一口径（建议与 `read-file-tool`/CLI 一致：末尾换行不产生空行），并在两端补同一组表驱动用例。

**历史区别**：`2026-08-28-logic-bug-review-01.md` 提到过 read 路径 splitLines 问题；本条明确落在 **FileChangeDiffUtil 与 CLI computeLineDelta 的跨端不一致**，且 CLI 注释已声称同口径但实现未对齐。

---

## 修复优先级建议

| 优先级 | 条目 | 理由 |
| --- | --- | --- |
| P0 | BUG-2 | 跨会话消息污染，用户可见数据错乱 |
| P0 | BUG-4 | LOCAL 并行编辑静默丢改动 |
| P0 | BUG-3 | 边路停止/重试不可用 |
| P1 | BUG-1 | 待办顺序错乱，影响多步任务推进 |
| P1 | BUG-5 | CLOUD/LOCAL 文件结果分叉，污染 git |
| P1 | BUG-6 | 误杀他人任务 + 自身超时失效 |
| P2 | BUG-7 | 统计口径，影响 UI 行数 |

## 验证与边界

1. 全部条目由主审在 worktree `mao-code-review-20260917`（分支 `chore/code-review-logic-bugs-20260917`，基线 `2460d86b`）回读源码核对。
2. 分区探索（harness / session-WS / desktop / agent-cli）并行完成；未纳入报告的候选未做主审终核，不计入本清单。
3. 未跑全仓测试、未做浏览器 E2E、未连真实 DB/模型。现有单测未覆盖上述交错条件。
4. 仅新增本报告，未改业务代码，无需 CHANGELOG。
5. 文件名 `2026-09-17-logic-bug-review-01.md` 创建前已确认与 `docs/code-review/` 既有文件不重名。
