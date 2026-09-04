# Web 嵌入式对话 SDK（`sdk/embed`）评审报告

> 评审对象：`sdk/embed`（`@mao/chat-embed` v0.1.1，产物 `desktop/public/embed/mao-chat.js`）
> 评审日期：2026-09-04　评审方式：全量源码通读 + 后端契约逐条核对 + desktop 参考实现对比 + 9 批 Playwright 运行时验证
> 参考文档：`docs/plan/embed-sdk-technical-design.md`
> 本报告只做评审，未修改任何 SDK 源码。

## 0. 结论摘要

工程骨架与"轻量嵌入"这条主线做得扎实：Shadow DOM 隔离、包体、全局污染、销毁清理、多 tab 协调、上下文注入这些**嵌入式 SDK 特有的难点全部达标**，实测无一处翻车。

问题集中在**从 desktop 裁剪 WS 事件语义的那一层**。设计文档 §4.2 列了 5 条"必须继承的 desktop 行为"，实际只完整继承了 2 条：

| 设计文档 §4.2 要求 | 实现情况 |
|---|---|
| 30s 静默判定 + 心跳 | 完整继承，数值与 desktop 一致 |
| 重连后全量 re-subscribe | 继承，但发了两次 subscribe |
| executionId 去重（stale 丢弃） | 判定函数等价，但**终态后不记录 cancelledExecutionId**，旧轮次事件会被接受 |
| cancel 后会话级事件抑制 | **时序倒置**（先抑制后发帧）+ **终态自解抑制** |
| `session_snapshot` 终态对账（终结残留工具转圈） | **完全缺失** |

加上三处契约理解错误（会话失效判据、`tool_call_args_delta` 语义、追问 answers 形状），构成本次评审的 P0 主体。一个共性根因：**单测用人造 mock 固化了错误的契约假设**，反而让 bug 通过了测试（详见 §7）。

按用户可感知程度排序，最该先修的三件事：

1. `tool_call_args_delta` 累加导致工具参数渲染成乱码（每次工具调用必现）
2. localStorage 死会话 id 永不自愈（浏览器一旦命中就永久卡在错误横幅，只能手动清 storage）
3. 发送失败不回滚乐观气泡（断网发一次就留下一个永久闪烁的空气泡）

### 做得好的部分（实测确认）

- **Shadow DOM 隔离有效**：宿主注入 `!important` 全局样式不侵入浮窗（input font-size 保持 14px）；SDK 未向 `document.head` 注入任何样式，`css-injected-by-js` 正确注入到 Shadow Root 内。
- **全局污染最小**：只挂 `window.MaoChat` + `window.__maoChatInstance` 两个键。
- **单实例约束正确**：重复 `init()` 先 destroy 旧实例，DOM 中只留一个 host。
- **`destroy()` 干净**：移除 DOM、停重连、停心跳三项全部生效，无残留 timer。
- **多 tab 协调生效**：双 tab 同时初始化只 `POST /sessions` 一次（BroadcastChannel `inquire/claim` 按设计工作）。
- **上下文注入符合设计 §4.4**：首条消息带 `[页面上下文]`（url/title/data），用户气泡只显示纯净输入文本，上下文未变则不重复携带；8KB 截断不切断 UTF-8 多字节字符。
- **`position: 'left'` 与 `theme.primary` 生效**（`--mao-primary` 内联覆写路径正确）。
- **XSS 防护有效**：`javascript:` / `data:` 协议被清理，`onerror` / `onclick` 属性被清理，`<script>` 不执行。
- **布局健壮性**：长文本、超长无空格单词、宽表格均不产生横向溢出。
- **流式渲染性能可接受**：150 次 delta 全量 `marked` + `DOMPurify` 重解析共 648ms，未见卡顿。
- **连接层忠实复刻**：首帧 `{type:'auth',token,client:'embed'}` 正确；心跳 5s / 静默 30s / 退避 1s→30s 与 desktop 完全一致，且远快于服务端 90s idle 巡检；断线自动重连生效。
- **包体**：gzip 63.71 KB / 预算 200 KB，依赖红线守住（无 element-plus / tiptap / monaco / xterm / pdfjs），CI 有独立 `embed-sdk` job 跑 build + test + size。
- **契约假设大部分成立**：`content_delta.delta`、`thinking_delta.delta`、`tool_call_result.{tool_call_id,result,status,summary}`、`message_end`、`session_status.{phase,executionId}`、`session_snapshot`（后端已把 RESUMING 归一为 RUNNING）、`session_already_running.message`、`error.message`、`llm_waiting`、`llm_retry`、`ask_user_questions.{requestId,questions}`、`ask_user_questions_cancelled.requestId`，以及 REST 侧 `thinkingContent` 字段名与大写 role（`USER|ASSISTANT|TOOL|SYSTEM`）——全部核对无误。

## 1. 证据口径

报告中每条问题标注证据类型，请勿混用：

- **【实测】**——Playwright 在真实 Chromium 中复现，附实测数值。
- **【代码】**——源码/后端契约交叉核对得出，未构造运行时场景（多因触发条件依赖真实服务端时序）。

运行时验证共 9 批、约 100 项检查，宿主页 stub 了 `fetch` 与 `WebSocket`（保留 `WebSocket.OPEN` 等静态常量）。两个踩过的坑记录在此，供后续复验参考：替换 `window.WebSocket` 时若丢失静态常量，SDK 内 `readyState === WebSocket.OPEN` 判断会异常并抛 `Cannot read properties of null`，产生假失败；Playwright 真实点击会清除宿主 selection，测 selection 相关行为必须用 `page.evaluate` 派发合成事件。

## 2. P0 —— 影响正确性，建议全部修

### P0-1 `tool_call_args_delta.arguments` 是累积全量，被当增量 `+=`

**现象**【实测】三帧 `{"pa` → `{"path"` → `{"path":"a.ts"}` 在工具卡片里渲染成 `{"pa{"path"{"path":"a.ts"}`。工具调用越长，参数区越像乱码。

**根因** 后端 `agent-loop.ts:605-607` 的 `applyToolCallDelta` 已经做过字符串累加，`:230-236` 传出的是 `merged.function.arguments`（**累加后的全量**），`ws-streaming-event-listener.ts:163-169` 原样下发。形参名 `argumentsDelta` 有误导性，但语义是快照。

SDK `core/store.ts:123-127`：

```ts
case 'tool_call_args_delta': {
  // 后端字段：{tool_call_id, arguments}（arguments 为增量文本）  ← 注释即错误假设
  const tc = this.findToolCall(data);
  if (tc) tc.argsText += String(data.arguments ?? '');
}
```

**desktop 对比** `desktop/src/stores/session.ts:1314-1322` 是**覆盖赋值**：`call.input = JSON.parse(data.arguments)`。

**修复** 改为覆盖：`tc.argsText = String(data.arguments ?? '')`。同时修正注释。

**连带问题** `store.ts:115` 注释"后端 start 帧即携带完整初始 arguments"也不准确：`tool_call_start` 在 `mergeToolCall` 一拿到 name 时就发（`agent-loop.ts:565-583`），此时 `arguments` 常为空或仅首个分片；流结束时后端对完整 toolCall 再调一次，但被 listener 的 `alreadySent` 去重掉（`ws-streaming-event-listener.ts:60-74`），**不会补发完整值**。改成覆盖语义后这条自然被后续 delta 修正，但注释应改掉以免误导。

### P0-2 会话失效判据错误 —— localStorage 死会话 id 永不自愈

**现象**【实测】localStorage 存一个不存在的 sessionId（如 `999`），打开浮窗后 storage 值停在 `999` 不变，浮窗常驻 2 个错误横幅，刷新页面重复同样结果，用户唯一出路是手动清 localStorage。

**根因** `core/session-manager.ts:24-39` 用 HTTP 404 判定会话丢失：

```ts
} catch (err) {
  if (!(err instanceof Error) || (err as { status?: number }).status !== 404) {
    throw err;              // ← 永远走这条
  }
  this.clearStoredSessionId();
}
```

后端实际语义（`backend-ts/src/common/http-error.ts:48-55`、`common/error-code.ts:13`、`session/session.service.ts:398-404`）：

| 情况 | HTTP | body code |
|---|---|---|
| 会话不存在 | **200** | `3002` |
| 会话不归属当前用户 | **403** | `1002` |
| 未登录 | 401 | 1001 |

而 `core/rest-client.ts:60-62` 对 `code !== 0` 抛的是 `ApiError(resp.status, ...)`，即 `ApiError(200, '会话不存在')` —— `status` 永远不是 404，`clearStoredSessionId()` 是死代码。

**修复** 判据改为 `payload.code === 3002`（需让 `ApiError` 携带 `code` 字段），并把 HTTP 403 / `code 1002` 一并视为会话失效。

### P0-3 `session_snapshot` 终态对账缺失 —— 断线内容永久丢失 + 工具永久转圈

**现象**【实测】流式过程中断线，重连后收到 `session_snapshot: FAILED`，工具卡片仍显示"执行中"（1 个）、流式光标仍常亮（1 个）；且断线期间服务端产出的内容**不会补拉**（`GET /messages` 计数 1→1，无第二次请求）。用户必须刷新整页才能看到真实结果。

**根因** `core/store.ts:157-166` 只做了 phase 与 executionId 赋值：

```ts
case 'session_snapshot': {
  const phase = data.phase as WsTaskPhase | undefined;
  if (!phase) break;
  if (typeof data.executionId === 'string') this.activeExecutionId = data.executionId;
  this.phase.value = phase;
  if (TERMINAL_PHASES.includes(phase) && phase !== 'IDLE') this.activeExecutionId = null;
  break;
}
```

历史重拉这条路彻底断了：`ensureHistory` 有 `historyLoaded` 幂等锁（`store.ts:61`），而解锁用的 `markHistoryReloaded()`（`store.ts:70`）**全仓无任何调用方** —— 一次会话生命周期内永不重拉历史。

**desktop 对比** `desktop/src/composables/useStreamWS.ts:801-826` 在 snapshot 终态时：FAILED/CANCELLED 调 `finishInterruptedStreamingMessage`（终结 running/pending 工具改 error，写入"执行已被中止/执行失败中断"），并清 streaming / thinking / compacting / llmRetry / askQuestions；历史重拉由重连 onopen 的 `fetchFocusSessions(true)` 与 `useChat` 的 phase watcher（终态跃迁时 `fetchMessages()`）承担。

**修复** snapshot 终态复用已有的 `finishInterrupted()`（`store.ts:229`，代码已存在，只是 snapshot 分支没调）；重连成功后调 `markHistoryReloaded` 的反向操作（重置 `historyLoaded=false`）并重新 `ensureHistory`，或增设 `reloadHistory()` 强制重拉一次。

### P0-4 `tool_call_start` 无幂等 → 重复工具卡片

**现象**【实测】重放后卡片数变为 2；且实测「subscribe 实际发了 2 次」，意味着**首次打开浮窗就会触发两次重放**，无需断网即可复现。

**根因（两个因素叠加）**

1. 后端每次 `subscribe` 都无条件重放 `session_snapshot`，会话活跃时另重放全部 active `tool_call_start` 与全部 pending `ask_user_questions`（`streaming-ws-handler.ts:211-238`），且重放走 `registry.send(userId, …)` **按 userId 广播给该用户所有 socket**（`streaming-ws-registry.ts:144-146`），不区分是否新连接。
2. SDK `core/store.ts:109-121` 无条件 `msg0.toolCalls.push(tc)`，不按 `tool_call_id` 去重。

**放大器**：`boot()` 里 `await this.ws.connect()` 之后立刻 `this.ws.subscribe(session.id)`（`controller.ts:192-193`），而 `connected` 帧要一个 RTT 才到，到达时 `onAuthenticated` 又调 `resubscribe()`（`controller.ts:115-118`）。`resubscribe` 绕过 `subscribedSessionIds` 去重集合（`ws-client.ts:199-204`），于是**每次连接必发两次 subscribe**、触发两次重放。

**desktop 对比** `desktop/src/utils/chatMessage.ts:152-165` 按 id 先查后更（命中 existing 则更新 input/status 并 return）；且 desktop 在 `onopen` 内 auth 之后统一重建订阅，不存在双发。

**修复** `tool_call_start` 按 `tool_call_id` 查找已存在卡片，命中则更新而非 push。另外去掉 `boot()` 中的显式 `subscribe`，统一由 `onAuthenticated` 触发（订阅本就必须在 auth 之后才有效）。

### P0-5 发送失败 / `session_already_running` 不回滚乐观消息

**现象**【实测】断网后发送：气泡数 0 → 2（残留 1 条用户消息 + 1 个空助手气泡），流式光标常亮 1 个，且这个空气泡永远不会收口。后续对话全部接在这个假回合后面。错误横幅文案实测为"发送失败：连接不可用，请稍后重试"（可读）。

**根因** `controller.ts:309-327`：`appendLocalUserMessage` 内部还会顺带 `ensureStreamingAssistant()` 建一个 streaming 气泡（`store.ts:205-216`），而 `ok === false` 分支只写 `ui.sessionError`，既不摘用户气泡也不收口助手气泡：

```ts
this.store.appendLocalUserMessage(content);
const ok = await this.ws.sendMessage(sid, full, eventId);
if (!ok) {
  this.ui.sessionError = '发送失败：连接不可用，请稍后重试';
  this.emitEvent({ type: 'error', message: this.ui.sessionError });
}
```

`session_already_running`（`store.ts:196-198`）同样只写 sessionError，不收口气泡。embed 不做排队，这条路径在双端同时对话时很容易命中。

**desktop 对比** `desktop/src/stores/session.ts:1183-1196` 的 `removeTrailingEmptyAssistant` + `fetchSession` 重新对账 + toast 三件套；`editAndResend` 还有整表快照回滚。

**修复** `ok === false` 时移除刚 push 的乐观 user 气泡与空 assistant 气泡（store 增加一个 `rollbackLocalUserMessage()`）；`session_already_running` 至少要收口 streaming 气泡。

### P0-6 `ui.connected` 只有置 true、没有置 false —— 断线后 UI 说谎

**现象**【实测】**已连接后再断线**（socket close 1006）时：标题栏连接指示灯**仍是绿的**；Composer 的"连接已断开，发送时将自动重连"横幅**不出现**；输入框**未禁用**，placeholder 仍是正常态文案。用户在断网时得不到任何提示。（注：从未连接成功过的首次 boot 场景下输入框是正确禁用的，因为 `ui.connected` 初值为 false——错的只是"true 之后回不到 false"。）

**根因** `controller.ts:208-210` 是唯一写 `true` 的地方（`connected` 帧），全仓**无写 false 的路径**（除 `boot()` 开头 `controller.ts:171` 的初始化）。`ws-client.ts:35/121` 的 `connected` ref 有完整双向状态，但**没有任何 watch 订阅它**，属死状态。

后果面积比看起来大：`ChatPanel.vue:39` 的 `inputDisabled = !props.connected || running` 与 `Composer.vue:66` 的断连横幅都依赖它。

**修复** 在 controller 里 `watch(this.ws.connected, v => { this.ui.connected = v })`，删掉 `case 'connected'` 里的手写赋值（`connected` 帧仍用于触发 `onAuthenticated`）。注意：ws 的 `connected` 语义是 socket OPEN，而 UI 想表达的是"已鉴权可用"，严格起来应引入 `authenticated` 状态（OPEN 后到 `connected` 帧之间也不该显示绿灯）。

### P0-7 追问 answers 形状与后端工具 outputSchema / desktop 不一致

**现象**【实测】提交追问时实际发出的 answers 是 `[[{"label":"A","description":"甲"}]]`。服务端不报错、UI 无异常，属**静默错误**：LLM 收到的是裸选项对象数组，丢失了 question 与答案的对应关系、丢失 `selectedLabels` 语义，`customInput` 通道完全缺失。

**根因** 工具 outputSchema 期望每项为 `{question, selectedLabels: string[], customInput}`（`backend-ts/src/harness/tool/impl/ask-user-questions-tool.ts:56-71`）；desktop 正是这么发的（`desktop/src/components/chat/QuestionPanel.vue:235-245`，类型 `desktop/src/types/chat.ts:110-114`）。

SDK `ui/QuestionCard.vue:42-51` 构造的是嵌套选项数组：

```ts
const answers = props.pending.questions.map((q, qi) => {
  const sel = Array.from(choices.value[qi].indexes).sort((a, b) => a - b);
  return sel.map((oi) => ({ label: q.options[oi].label, description: q.options[oi].description ?? null }));
});
```

服务端只校验"是数组"，随后原样 `JSON.stringify({answers})` 喂给 LLM（`streaming-ws-handler.ts:583-591`）。类型系统没拦住是因为契约把 answers 声明为 `unknown[]`（`shared/contracts/src/ws.ts:63-67`）。

**修复** 按 outputSchema 构造 `{question: q.question, selectedLabels: [...], customInput: ''}`。建议同时把 `shared/contracts` 里的 `answers` 从 `unknown[]` 收紧为具体类型，让 desktop 与 embed 共享同一约束。

**连带问题** `controller.answer()`（`controller.ts:337-342`）提交即本地清空 `pendingQuestion`，且**不检查 `sendReliable` 的返回值** → 断网时答案静默丢失，卡片也没了，用户无从重试。desktop 的做法是"提交后保留卡片、禁止重复提交、等服务端 `ask_user_questions_cancelled` 才移除"。

## 3. P1 —— 明显影响体验，建议尽快修

### P1-8 cancel 抑制时序倒置 + 终态自解抑制

**现象**【实测】断线后点"停止"：错误横幅正确显示"停止失败：连接不可用"，但 SDK 已进入抑制态 —— 之后恢复连接、服务端续推同轮 `content_delta` 时，内容**被丢弃不显示**（消息区停在断线前的内容）。用户看到的是"停不掉，而且什么都不动了"。抑制要等下一轮 `session_status: RUNNING`（新 executionId）才解除（这一点实测正常）。

**根因** `controller.ts:329-335` **先抑制后发帧**：

```ts
async stop() {
  const sid = this.store.sessionId();
  if (sid == null) return;
  this.store.markCancelled();          // ← 先置 suppressStreamEvents = true
  const ok = await this.ws.cancel(sid);
  if (!ok) this.ui.sessionError = '停止失败：连接不可用';   // ← 失败了也不撤销抑制
}
```

desktop 是**先 await 成功才抑制**，失败直接 return、不改任何状态（`desktop/src/composables/useChat.ts:530-557`）。

**同一处的第二个问题**【代码】`finishInterrupted` 内有 `this.suppressStreamEvents = false`（`store.ts:238`），而它由未过 executionId 门禁的 `session_status: CANCELLED` 触发 —— 等于把刚建立的抑制拆掉，抑制只剩 executionId 比对兜底。

**第三个问题**【代码】不处理 stale `CANCELLING`：本地已收口后，服务端补发的 `CANCELLING` 会把 UI 打回执行中。desktop 有防护（`useStreamWS.ts:619`：`phase === 'CANCELLING' && !activeExecutionIds.has(sid)` → 丢弃）。

**修复** 调换顺序：`await ws.cancel()` 成功后才 `markCancelled()`，失败只报错不改状态；把 `finishInterrupted` 里的解抑制移除（解抑制的唯一时机应是新 executionId 的 RUNNING）。

### P1-9 点击停止后按钮不立即切回发送态

**现象**【实测】cancel 帧已发出，但"停止"按钮仍在，要等服务端 `session_status: CANCELLED` 回来才变回发送按钮。网络稍慢时用户会重复点击。

**根因** `controller.stop()` 无乐观 phase 更新。desktop 的 `stopExecution` 有 `updateSessionPhase(sid, 'CANCELLED')`（`useChat.ts:551`）。

**修复** cancel 成功后本地乐观置 `phase = 'CANCELLED'`。

### P1-10 关闭引用 chip 后消息仍携带引用

**现象**【实测】点掉引用 chip（chip 确实消失了），随后发送，消息**仍然包含** `[用户选中文本]` 块。用户明确表达的"不要引用这段"被忽略。

**根因** `controller.clearSelection()`（`controller.ts:345-347`）只清 `ui.quotedSelection`（纯展示状态），而 `send()` 走的是 `this.selectionTracker?.peek()`（`controller.ts:315`）—— 直接重读 `window.getSelection()`，与 UI 状态无关：

```ts
clearSelection() {
  this.ui.quotedSelection = null;   // 只清了显示
}
```

**注** 早期一次验证中同名检查曾 PASS，原因是 Playwright 真实点击顺带清除了宿主 selection；用不触碰 selection 的方式即稳定复现。

**修复** 增加 `selectionDismissed` 标志（或让 SelectionTracker 支持 `dismiss()` 把当前选中文本记为已忽略），`send()` 时尊重该标志。

### P1-11 浮窗内选中文本被误当页面引用

**现象**【实测】用鼠标选中助手气泡里的文字 → Composer 出现 1 个"讨论：xxx"引用 chip。用户复制助手回答这种常规操作会污染下一条消息。

**根因** `context/selection.ts` 监听 `document.selectionchange` + `window.getSelection()`。Shadow DOM 内的选中同样触发 `document` 上的 `selectionchange`，且 Chromium 下 `window.getSelection()` 能取到 shadow 内的文本。文件顶部注释声称"仅跟踪宿主文档，浮窗内部选中不触发"，与实际不符。

**修复** 用 `sel.anchorNode` 判断选区是否落在 SDK host 之内（`host.contains(node)` 或比较 `getRootNode()`），命中则忽略。

### P1-12 `llm_retry` / `llm_waiting` 提示不清除

**现象**【实测】收到 `llm_retry` 后紧接着收到 `content_delta`（说明重试已成功），"LLM 重试中（… 第 2/5 次）"横幅**仍挂着**，一直留到本轮终态。

**根因** SDK 只在 `session_status` 终态清 `llmRetryText`（`store.ts:152`）。desktop 在 `content_delta` / `thinking_start|end|delta` / `tool_call_start` / `message_end` 全部调 `clearLlmRetry`（`useStreamWS.ts:551,560,709,714,721,771`），断线时还有 `clearAllLlmRetry()`（`:277`）。

**修复** 在上述几个事件分支里清 `llmRetryText`；断线（ws close）时也清。

### P1-13 `llm_stream_reset` 不清工具卡片、无守卫

**现象**【实测】reset 后残留 1 张孤儿工具卡片。

**根因** 后端 reset 时同步清空 `toolCallInfo` + `activeToolCalls`（`ws-streaming-event-listener.ts:153-157`），SDK `store.ts:188-195` 只清 content / thinking：

```ts
case 'llm_stream_reset': {
  const m = this.lastAssistant();     // ← 取"最后一条助手消息"而非"当前流式气泡"
  if (m) { m.content = ''; m.thinking = ''; }
}
```

两个缺陷：不清 `toolCalls`；用 `lastAssistant()` 而非"当前流式气泡"，若 reset 早于本轮气泡创建，会**误擦历史里最后一条助手消息的内容**。

**desktop 对比** `desktop/src/stores/session.ts:1222-1238` 的 `resetStreamingAssistantMessage` 清 content / thinkingContent / **toolCalls / segments**，并先校验目标是登记过的流式气泡。

**修复** 加 `m.streaming` 守卫，并清 `toolCalls`。

### P1-14 移动端 375px 视口浮窗横向溢出

**现象**【实测】375px 宽视口下浮窗 `x=-51, w=402`，左侧被裁掉 51px（关闭按钮尚在，但内容区被压）。

**根因** `ui/style.css:67-72` 固定宽度 + 固定右距：`.mao-panel { width: 400px; }` 配 `right: 24px`。高度已经用了 `min(620px, calc(100vh - 120px))` 做自适应，宽度没有。

**设计文档口径** §6.3 明确把"移动端宿主适配与全屏模式"列为一期不做。但"不做移动端适配"与"窄视口下布局破损"是两件事 —— 一行 `width: min(400px, calc(100vw - 32px))` 即可避免可见破损，不算功能扩张。

### P1-15 终态未记录 cancelledExecutionId、无会话级抑制

**现象**【代码】终态后 `activeExecutionId = null` 且 `cancelledExecutionId = null` → `isStale()` 返回 false → **旧轮次的迟到事件（含服务端 subscribe 重放）全部被接受**，能在已收口的气泡后重新拉出流式气泡与工具卡。只有"用户本地点停止"这条路径因 `markCancelled` 写过 `cancelledExecutionId` 而侥幸拦住。

**根因** `store.ts:147-153` 终态只置 `activeExecutionId = null`。desktop `clearActiveExecution`（`useStreamWS.ts:65-72`）在终态时把 `activeExecutionIds` 里的值转存进 `cancelledExecutionIds`，并 `suppressedStreamSessions.add(sessionId)`。

**修复** 终态时把 `activeExecutionId` 转存到 `cancelledExecutionId` 后再清空。

### P1-16 `user_message_saved` 被忽略 + 自己的消息被计未读

**现象**【实测】自己发出的消息触发的 `user_message_saved` 会在浮窗收起时产生红点（"你有新消息"其实是你自己刚发的）。

**根因** `store.ts:174-175` 是空实现（`case 'user_message_saved': break;`），`controller.ts:211-217` 把它与 `message_end` 一并计未读。

desktop 用这个事件做三件事（`useStreamWS.ts:776-799`）：把乐观的 `msg_*` 临时 id 换成 DB 真实 id（`updateLastMessageId`，`desktop/src/stores/session.ts:1412-1425`）；`source === 'weixin' | 'scheduled'` 时把外部渠道进来的用户消息补插上屏；触发 `messageSavedCallbacks` 解锁输入框（`useChat.ts:480-500`，含 **60s 超时按发送失败处理**）。

**embed 侧后果**（按严重度）：

1. 没有"服务端已落库"确认 —— "发送成功"等价于"帧写进了 socket"。实测服务端完全静默 3s 后，SDK 无任何超时提示、光标继续常亮。
2. 定时任务 / 微信等服务端触发的用户消息不显示，用户只看到凭空出现的助手回复。
3. 本地气泡永远是客户端 `u_*` id，将来引入增量历史合并或"编辑重发"会直接撞车。
4. 自己的消息计未读（上述现象）。

**修复** 至少先做两件低成本的：`user_message_saved` 不计未读（只有 `message_end` 或带 `source` 的才计）；补一个发送后的落库超时兜底提示。

## 4. P2 —— 交互与可用性优化

### P2-17 流式期间强制滚底，用户上滚被打断

**现象**【实测】上滚到顶部（scrollTop=0）后，新到的 delta 把 scrollTop 拉到 2706 —— 用户想回看前文时被反复拽回底部。

**根因** `ui/ChatPanel.vue:41-49` 的 watch 回调无条件 `el.scrollTop = el.scrollHeight`（`:46`），缺少"仅当已接近底部才跟随"的判断。

**修复** 滚动前判断 `scrollHeight - scrollTop - clientHeight < 阈值`（如 40px），否则不跟随；配一个"回到底部"按钮更佳。

### P2-18 思考过程默认折叠，流式中完全不可见

**现象**【实测】流式思考期间用户只能看到"思考过程"这个折叠标题，看不到任何进度 —— 长思考场景下界面像卡住了。

**根因** `ui/MessageBubble.vue:17` `const thinkingOpen = ref(false)`，且无"流式期间自动展开、结束后自动折叠"的逻辑。

**修复** 流式中（`message.streaming && !message.content`）默认展开，`message_end` 后折叠。

### P2-19 助手输出的链接无 `target="_blank"` / `rel="noopener"`

**现象**【实测】渲染出的 `<a>` 的 `target` 与 `rel` 均为 null。宿主页面内点击会**直接跳走**，用户丢失当前业务上下文（嵌入场景下这个代价比独立站点大得多）。

**修复** DOMPurify `afterSanitizeAttributes` 钩子里给外链统一加 `target="_blank" rel="noopener noreferrer"`。

### P2-20 无障碍与键盘交互缺失

【实测】Escape 不能关闭浮窗；打开浮窗后不自动聚焦输入框（activeElement 仍停在 launcher 按钮上，用户必须再点一次）；无 focus trap；消息区无 `aria-live`，屏幕阅读器不播报新消息。

现有 aria 只有 3 处：`ChatPanel.vue:57` 的 `role="dialog" aria-label`、`Composer.vue:49` 的 `aria-label="移除引用"`、`Launcher.vue:18` 的 `aria-label="Mao 助手"`。

**修复优先级**：自动聚焦输入框与 Escape 关闭成本最低、收益最直接，建议先做；`aria-live="polite"` 加在 `.mao-messages` 上也是一行。

### P2-21 单选题用 checkbox 且缺自定义输入

【实测】`multiSelect: false` 的问题渲染出的是 `type="checkbox"`（逻辑上做了互斥，但视觉语义错误，用户不知道只能选一个）。另外后端 outputSchema 有 `customInput` 字段、desktop 有"其他/自定义输入"输入框，embed 完全没有该控件 —— 用户被限制在预设选项里。

**根因** `ui/QuestionCard.vue:65-69`。与 P0-7 是同一处代码，建议一并修。

### P2-22 WS 鉴权失败横幅不自动消失

【实测】WS close 1003 时正确提示"登录凭据已失效，请刷新页面重新登录"（文案准确）；但重连并重新鉴权成功后横幅**不自动消失**，需用户手动点"重试"。

**修复** `onAuthenticated` 时清空 `sessionError`（仅当它是鉴权类错误）。

### P2-23 "新对话"不退订旧会话

【实测】`unsubscribe` 发送次数为 0 —— 旧会话的事件仍会被服务端推来，靠 `store.handleEvent` 首行的 sessionId 过滤兜住（`store.ts:88-90`），因此无可见 bug，但属于不必要的流量与状态残留。

**根因** `controller.newSession()`（`controller.ts:277-289`）只 `ws.subscribe(new)`，没有 `ws.unsubscribe(old)`。注意 `WsClient.unsubscribe()` 已实现但无调用方（见 §8）。

### P2-24 `pendingSends` 队列永不 flush

【代码】`ws-client.ts:47` 声明、`:257-260` push、`:195` disconnect 清空 —— **没有任何消费者**。socket 未 OPEN 时 `subscribe` / `unsubscribe` 帧进队即静默丢弃。subscribe 靠 `onAuthenticated` 的 resubscribe 侥幸补上（也正是 P0-4 的双发来源），`unsubscribe` 则永久丢失。

**修复** 要么在 `onAuthenticated` 里 flush 队列，要么删掉这个未完成的机制、改为显式丢弃并记日志。

### P2-25 `getToken()` 首次失败留下僵尸连接

【代码，运行时未复现】`ws-client.ts:83-96`：只有成功分支才 `startHeartbeat()`；失败分支清了 timeout 与 connectPromise，但**不 close socket** —— socket 停在 OPEN 且未鉴权，`connected.value` 仍为 true。下次 `connect()` 首行 `readyState === OPEN` 判断直接 resolve，业务帧发到未鉴权连接，被服务端 `close(1003)`。

实测该路径未复现（stub 环境下 `getToken` 在 connect 之前的 REST 阶段就已失败，socket 数为 0），但代码缺陷成立。同时确认：token 端点 500 时错误提示可读（"host token endpoint 500"），点"重试"可恢复。

**修复** 失败分支补 `socket.close()` 并置 `connected.value = false`。

### P2-26 连接失败横幅文案是英文技术串

【实测】WS 首连失败时横幅显示 `WebSocket closed`；`serverUrl` 非法时显示 `Failed to construct 'URL': Invalid URL`。异常被正确捕获（无未捕获错误）、输入框正确禁用，但文案直接暴露了内部错误消息。

**根因** `controller.boot()` 的 catch 用 `err.message` 兜底（`controller.ts:194-201`）。

**修复** 对连接类异常映射为中文文案（如"无法连接到助手服务，请检查网络后重试"），保留原始 message 走 `onEvent` 给宿主埋点。

### P2-27 每个会话在服务器落一个工作区目录

【代码】CLOUD 会话未传 workspace 时，后端走 auto 分支创建 `{workspaceRoot}/{userId}/{sessionId}` 并 mkdir（`session.service.ts:127-142,195-200`）。embed 的"新对话"不删旧会话（`session-manager.ts:51-55`），目录持续累积。embed 场景本身不需要工作区。

**建议** 设计文档 §6.3 已把 `source=embed` 隔离标记列为二期；此处至少值得记一笔运维影响，或二期评估 embed 会话跳过工作区初始化。

### P2-28 上下文变更检测的三个边界问题

【代码】`context/collector.ts` 主体逻辑正确（stableStringify 键排序、FNV-1a、UTF-8 安全截断都实测无误），但有三处边界：

1. **hash 只覆盖 `data`，不含 url/title**（`collector.ts:77-78`）。注入的引用块里明明有 `url:` 和 `title:` 两行，但 SPA 路由切换后若宿主 `context()` 返回值恰好不变，新 url 不会被重新注入 —— Agent 拿到的是首次注入时的 url。建议 hash 覆盖 `{url, title, data}` 整体。
2. **"整体上限 8KB"未严格成立**（设计文档 §4.4）。`truncated` 按含 url/title 的完整序列化判断，但截断只作用于 `data`（留 512 字节余量）；且选中文本块另有独立的 `CONTEXT_LIMIT_BYTES / 2` 配额（`:96`）。两块相加最坏情况约 12KB。建议改为对拼装后的总前缀做一次统一上限。
3. **hash 在发送失败时不回退**（`:80`）。`lastHash` 在拼装阶段就更新了，若随后 `sendMessage` 失败（P0-5 场景），用户重发的那条消息将**不再携带页面上下文**。修 P0-5 时应一并把 hash 回滚。

## 5. 需要改后端的项（唯一一处）

### CORS `allowedHeaders: '*'` 不覆盖 `Authorization`

**根因** `backend-ts/src/create-app.ts:319-326` 配置 `{ origin: true, credentials: true, allowedHeaders: '*', maxAge: 3600 }`。`@fastify/cors@11.3.0`（`index.js:246-257`）在 `allowedHeaders` 非 null 时**直接写字面量、不再反射 `access-control-request-headers`**。而 `Authorization` 是 CORS non-wildcard request-header，`*` 对它无效、必须显式列出。

**实测确认** `curl -X OPTIONS ... -H 'Access-Control-Request-Headers: authorization,content-type'` → 响应头为 `access-control-allow-headers: *`。

**影响** embed 的每个 REST 请求都带 `Authorization`（`core/rest-client.ts:37-42`）且跨源 → 必触发预检 → **第三方域名下 embed 的 REST 调用存在被浏览器拒绝的风险**（浏览器实现严格程度不一，需在真实第三方域名下验证）。生产 Nginx 的 `/api/` 是纯 proxy_pass、不注入 CORS 头（`skills/mao-cli/reference/deploy.md:170-194`），故完全由后端决定。

**修复** `allowedHeaders` 显式含 `Authorization, Content-Type`，或改回默认 `null` 让插件反射请求头。改动一行，无副作用。

## 6. 安全边界（需在接入文档中显式声明）

以下三项**均为既定设计**，不是 bug，但接入方必须知情，建议写入 README 的 Embed SDK 接入章节：

1. **WS 无 origin 校验**。握手回调连 `request` 参数都不接收（`backend-ts/src/session/ws/attach-websocket.ts:15-52`），`/ws/` 在公开前缀内，鉴权完全靠首帧 `auth`。结合 CORS 反射任意 origin，**安全边界全部落在 token 发放侧**。
2. **后端无 agent 归属校验**。`AGENT_ACCESS_DENIED(3005)` 在 `common/error-code.ts:16` 有定义但**全仓无使用点**，`agentLookup.findById` 直连 repo（`create-app.ts:1621-1625`）→ 任何已登录用户可用任意 agentId 建会话。embed 的权限边界只靠 agentId 保密。
3. **access token 默认 24 小时**，与设计文档 §2.3 的"宿主只下发短期 token"预期不符：`backend-ts/config/application.yml:24-28`、`config/app-config.ts:133-137,333-335`（`expiration: 86400000`，且**无环境变量开关**）。接入文档必须明确要求宿主自行签发更短有效期的专用 token，不要直接把登录接口返回的 access token 丢给页面。

## 7. 测试覆盖缺口

现状：`cd sdk/embed && npm test` → 3 文件 22 测试全绿（`store.spec.ts` 115 行 / `session-manager.spec.ts` 92 行 / `collector.spec.ts` 90 行）。全绿但**没有拦住任何一个 P0**，原因值得单独说明。

### 7.1 两处 mock 固化了错误的契约假设

这是本次评审最需要纠正的工程问题：**测试不是漏测，而是主动确认了错误行为**。

`store.spec.ts:59-71` 把 `tool_call_start` 与 `tool_call_args_delta` 的 arguments 写成人造的互补片段：

```ts
store.handleEvent(ev('tool_call_start', 1, { ..., arguments: '{"q"' }));
store.handleEvent(ev('tool_call_args_delta', 1, { ..., arguments: ':"mao"}' }));
expect(tc.argsText).toBe('{"q":"mao"}');     // ← 断言了错误的累加语义
```

后端真实下发的是 `{"q"` → `{"q":"mao"}`（累积全量），正确结果应为覆盖。这条断言让 P0-1 通过了测试。

`session-manager.spec.ts:23,66` 的 mock 直接 `throw new ApiError(404, ...)`，而真实 `RestClient` 抛的是 `ApiError(200, '会话不存在')` —— mock 制造了一个后端不存在的错误形态，让 P0-2 通过了测试。

**结论**：涉及外部契约的单测，mock 必须复刻**真实响应体**（HTTP status + body code），而不是复刻"我以为的"错误对象。修 P0-1 / P0-2 时应同步改这两处断言。

### 7.2 UI 层与 controller / ws-client 零覆盖

`vitest.config.ts:13` 用 `environment: 'node'` + 手工 stub window/document，没装 jsdom/happy-dom → 8 个 Vue 组件、`controller.ts`（355 行）、`ws-client.ts`（269 行）**完全无单测**。本次报告里的 P0-3 / P0-4 / P0-5 / P0-6 全部落在这两个文件里，全靠 Playwright 手工验证才发现。

**建议** 补 `happy-dom` 环境（体积远小于 jsdom），优先覆盖三类：

1. `ws-client`：连接/重连/心跳/`sendReliable` 失败路径（用 fake WebSocket，**记得保留静态常量**）。
2. `controller`：`boot()` 的失败分支、`send()` 的 `ok === false` 回滚、`stop()` 的失败不抑制、`ui.connected` 的双向同步。
3. `store`：subscribe 重放幂等、snapshot 终态对账、终态 cancelledExecutionId 转存。

### 7.3 缺少一个"契约回归"测试

三个 P0 都源于 SDK 对后端事件语义的理解偏差。建议在 `shared/contracts` 或 backend-ts 侧建立一份**事件 payload 样例集**（真实抓包或从 `ws-streaming-event-listener` 的单测复用），让 embed 与 desktop 的 store 都跑同一份样例。这比各自写 mock 更能防协议漂移 —— 这本来也是设计文档选型表里"新建协议类型包，防 desktop / SDK 协议漂移"的初衷，但类型包只约束了字段名，没约束**语义**（增量 vs 全量正是类型无法表达的那类差异）。

## 8. 死代码与工程化清理

### 死代码（可直接删除）

| 位置 | 内容 |
|---|---|
| `src/ui/MessageList.vue`（13 行） | 整个文件无任何引用 |
| `src/types.ts:66-77` | `ChatUiState` 接口无引用（实际用的是 `controller.ts` 的 `UiState`） |
| `src/types.ts:94-97` | `normalizeClientType()` 无引用（后端侧有自己的实现） |
| `src/core/store.ts:40` | `busy` computed 无引用 |
| `src/core/store.ts:70-72` | `markHistoryReloaded()` 无调用方（正是 P0-3 的一部分——应该有调用方） |
| `src/core/ws-client.ts:213-220` | `unsubscribe()` / `trackedSessionIds()` 无调用方（`unsubscribe` 应该被 P2-23 用上） |
| `src/core/token-provider.ts:29-31` | 静态 `isAuthError()` 无调用方 |
| `src/types.ts:38` | `MaoChatEvent` 声明了 `{type:'unread'}` 但从不发出（实测宿主 `onEvent` 收到的事件数组里无此类型）——要么实现，要么从公开类型里删掉 |

注意区分：`markHistoryReloaded` 与 `unsubscribe` 属"写了但忘了接"，删之前应先判断是否该补上调用方（前者是 P0-3、后者是 P2-23）。

### 代码小瑕疵

- `store.ts` 未处理 `CANCELLING` phase → `busy` 会短暂变 false（按钮闪烁）。
- `session_already_running` 未纳入 `STREAM_EVENT_TYPES` 门禁（`store.ts:8-21`），desktop 纳入了（`useStreamWS.ts:88-93`）—— 影响 cancel 后该事件是否被抑制。
- `ChatPanel.vue:33-38` / `RootApp.vue:21-23` 的 `running` 包含 `WAITING_APPROVAL`，但设计文档明确 embed 会话为 CLOUD、无审批环节，属冗余分支。
- `findToolCall`（`store.ts:295-301`）在 `tool_call_id` 缺失时回退到"最后一张卡"，可能把结果贴到错误的卡上；desktop 严格按 id 匹配。
- `tool_call_result` 找不到对应 id 时直接丢弃；desktop 会用 `tool_name` 建占位卡（`desktop` 侧更稳）。
- 忽略 `tool_call_result.preview` → 图片类工具结果在浮窗内完全不可见。
- 历史消息忽略 `images` 字段（`session-vo.ts:295-306` 会把多模态 content 拆成 `content` + `images`）→ 历史图片静默丢失，不报错。
- `ChatPanel.vue:51-53` 的 `onEmptySlot()` 函数式包装可用 computed；`Composer.vue:66` 内联 `style="padding: 6px 0 0"` 与"样式集中在 style.css"的组织原则不一致。
- `MessageBubble.vue:9` 的 `marked.setOptions` 在组件模块顶层执行（全局副作用），应移到模块初始化处或改用局部实例。
- `roundLimit: 20`（`controller.ts:178`）是**轮次**不是条数（`session.routes.ts:360-362`、`session.service.ts:798-818`，服务层钳到 [1,50]）：先取最近 20 个 USER 消息作轮起点，再拉区间内全部角色消息。功能正确，但首屏条数可能远超 20，对浮窗偏重。
- `.mao-root` 用了 `all: initial`（`style.css:17`），但同一规则内自定义属性声明在 `all: initial` 之前——实测样式正常（未被重置），但依赖声明顺序，写法脆弱，建议把 `all: initial` 提到规则首行。

### 后端侧小不一致（仅影响统计/日志）

`streaming-ws-registry.ts:268-273` 的 `normalizeClientType` 不识别 `'embed'`、归一为 `browser`，而 `streaming-ws-handler.ts:1384-1390` 的 `normalizeClient` 识别 `embed`（并有单测 `streaming-ws-handler.spec.ts:402-404`）。两处口径不一致，embed 连接在注册表统计里被记成 browser。

### 构建与产物

- 构建通过：`sdk/embed/dist/mao-chat.js` 181.44 kB / **gzip 63.71 kB**（预算 200 KB，余量充足）。
- 三份产物 md5 一致（`3e0180f2d21c9ac43427c3f734431ce3`）：`sdk/embed/dist/mao-chat.js`、`desktop/public/embed/mao-chat.js`、`desktop/public/embed/mao-chat.v0.1.1.js`。接线正确（`desktop/package.json` 的 `prebuild: node scripts/build-embed-sdk.cjs`）。
- **构建产物入 git**：`desktop/public/embed/*.js` 两份共约 360 KB 已被 git 跟踪。`.gitignore` 有全局 `dist/` 规则但未覆盖 public 下的产物。这会让每次 SDK 改动都产生大 diff，且存在"产物与源码不同步"的风险。建议改为部署时构建（`scripts/deploy-desktop.sh` 目前无 embed 相关校验，可加一步产物存在性/版本校验）。
- `vite.config.ts:16` 与 `vitest.config.ts:9` 都用了 `__dirname`，vite 8 构建/测试时各有一条警告（`configLoader: 'native'` 不支持），建议改 `import.meta.dirname`。
- `sdk/embed/.npmrc` 设了 `legacy-peer-deps=true`，建议注明原因或移除。
- **`docs/plan/embed-sdk-technical-design.md` 首行状态仍写"设计定稿，未开工"**，而实现已完成并上线产物。按 CLAUDE.md 的文档同步约定应更新状态。

## 9. 功能设计缺口对照设计文档

区分"按 §6.3 有意不做"与"应该做但漏了"：

| 项 | 设计文档口径 | 实现 | 判定 |
|---|---|---|---|
| `session_title_updated` 渲染 | §4.2 列为"保留并渲染" | store / controller 均无分支，标题永远停在"网页助手" | **漏实现**，但当前无实际影响：embed 创建会话时传的是非占位标题 `'网页助手'`（`session-manager.ts:41-48`），后端 `isEligible()` 只对 `未命名会话` / `任务` 占位符生成标题（`session-title.service.ts:14-15,120-128,184-190`）→ **后端根本不会发这个事件**。属"死代码级"遗漏，修的时候顺手加分支即可 |
| `session_snapshot` 终态对账 | §4.2 "必须继承"，明确写了"终结残留工具转圈" | 缺失 | **漏实现**（P0-3） |
| cancel 后会话级抑制 | §4.2 "必须继承" | 时序倒置 + 自解抑制 | **实现有偏差**（P1-8） |
| executionId 去重 | §4.2 "必须继承" | 判定函数等价，终态处理缺失 | **实现不完整**（P1-15） |
| `tool_approval` 发送帧 | §4.2 列在保留帧里，但 §2.2 明确说明 embed 为 CLOUD、无审批 | 未实现 | 正确（文档 §4.2 与 §2.2 自相矛盾，建议删掉 §4.2 里的 `tool_approval`） |
| 移动端适配 / 全屏 | §6.3 不做 | 未做，但 375px 下横向溢出 | 不做是对的，**破损应修**（P1-14） |
| 消息排队 / 图片上传 / 历史会话切换 / 重试执行 / 编辑重发 | §6.3 不做 | 未做 | 正确 |
| 暗色主题 / 完整主题 API | §6.3 不做 | 只有 `theme.primary` | 正确 |
| `metadata.context` 后端注入 | §6.3 二期 | 走文本拼装（§4.4） | 正确 |
| `source=embed` 会话隔离 | §6.3 二期 | 未做 | 正确，但连带 P2-27 的工作区累积问题 |
| Playwright e2e | §6.3 不做（仓库 CI 惯例） | 未做 | 正确；本次评审的运行时验证脚本为一次性产物，未入库 |

另外 §6.4 验收标准第 3 条「断网 30s 内恢复后…`session_snapshot` 对账，无残留转圈」**实际未达成**（P0-3 实测残留转圈），说明验收标准当时未被真正执行。

## 10. 修复优先级建议

**第一批（正确性，建议一次性做完）**

1. P0-1 `tool_call_args_delta` 改覆盖 + 同步修正 `store.spec.ts` 断言与注释（1 行代码 + 1 处测试）
2. P0-2 会话失效判据改 `code === 3002` + 兼容 403/1002 + 修 `session-manager.spec.ts` mock（需给 `ApiError` 加 `code` 字段）
3. P0-5 发送失败回滚乐观气泡（store 加 `rollbackLocalUserMessage`，并回滚 collector 的 `lastHash`）
4. P0-6 `ui.connected` 改为 watch `ws.connected`（顺带解决 UI 说谎面积最大的一处）
5. P0-4 `tool_call_start` 按 id 幂等 + 去掉 `boot()` 里的重复 subscribe

**第二批（断线恢复与中止链路）**

6. P0-3 snapshot 终态调 `finishInterrupted` + 重连后重拉历史
7. P1-8 cancel 时序改为"先成功后抑制" + 移除 `finishInterrupted` 里的解抑制
8. P1-15 终态转存 `cancelledExecutionId`
9. P1-12 / P1-13 `llm_retry` 清除时机 + `llm_stream_reset` 清工具卡与加守卫

**第三批（追问链路，一次性改完 QuestionCard）**

10. P0-7 answers 形状改 `{question, selectedLabels, customInput}` + 收紧 `shared/contracts` 类型
11. P2-21 单选改 radio + 补 customInput 输入框
12. `controller.answer()` 检查发送结果、失败保留卡片

**第四批（体验与工程化）**

13. P1-10 / P1-11 selection 两处（清引用生效 + 排除浮窗内选中）、P2-28 上下文 hash 覆盖 url/title
14. P1-9 停止按钮乐观切换、P1-14 窄视口宽度、P2-17 滚动跟随、P2-18 思考默认展开、P2-19 链接 target、P2-20 Escape + 自动聚焦 + aria-live
15. CORS `allowedHeaders`（后端一行）
16. 死代码清理、`embed-sdk-technical-design.md` 状态更新、README 接入章节补安全声明（§6 三条）

**建议先行的基建**：补 `happy-dom` 测试环境。第一、二批的绝大多数修复都落在 controller / ws-client / store 上，没有测试环境的话每一条都只能靠手工验证，而这次评审已经证明手工验证的成本（9 批脚本）远高于补一次环境。
