# 核心功能逻辑 BUG 评审（2026-10-02）

- **日期**：2026-10-02
- **基线**：main @ `db4f07a7`（工作区仅新增本文档与 `repro-tests/` 验证用例），所有行号以当前源码实测核对。
- **范围**：`backend-ts/src`（harness 引擎、LLM 适配器、内置工具、feishu/dingtalk 通道）+ `agent-cli/src`（mao-agent）+ `desktop`（useStreamWS/composables）。
- **方法**：六路并行分模块通读源码出题（最新 6 个提交、harness/core、session/schedule 域、工具实现、LLM 适配器、agent-cli+desktop），逐条与 `docs/code-review/` 既有 200+ 篇文档 grep 去重；入选条目由本人逐条回读当前源码复核触发链。**与以往纯静态评审不同：本轮每一条 BUG 均配套可运行的测试用例（共 12 个）实际执行验证，全部失败且失败信息精确指向 BUG 行为**（运行方式见附录 A），杜绝误报。
- **结论**：确认 **7 个可复现的核心功能逻辑 BUG**（BUG-1 ~ BUG-7：3 中高 / 2 中 / 2 中低），另有约 18 条已核实但未附验证用例的次级问题列入附录 B 供后续修复参考；已排查确认不构成 BUG 的候选核销见附录 C。
- **修复状态（2026-10-02 同日）**：BUG-1 ~ BUG-7 已全部修复，回归用例迁入各模块正式测试套件（`repro-tests/` 目录与独立 vitest 配置已删除）。验证方式：backend-ts 2459 用例、desktop 245 用例全量通过；agent-cli 490 通过（`repl-slash /copy` 1 例失败为存量环境相关问题，已在干净工作树复现确认与本次改动无关）。注意：BUG-7 的验证夹具初版 `target` 未指向 socket 实例，帧根本没进 routeEvent——修正夹具后做了**双向验证**（还原修复→用例失败，恢复修复→通过），其余 6 条在修复前基线上的失败输出即为下文各条引用的证据。

---

## 结论表

| 编号 | 严重度 | 端/模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 中高 | backend-ts · grep_search | rg 分支完全不检查进程失败：非法正则/目标消失/超时被杀全部静默变成「0 命中成功」，模型在错误前提下继续推进（与 JS 回退分支行为相反） |
| BUG-2 | 中高 | desktop · useStreamWS | `session_already_running` 拒绝帧被 stale 过滤吞掉：占用方运行时本端发送假成功，消息既未执行也未入库，无任何报错 |
| BUG-3 | 中高 | backend-ts · responses 适配器 | `done` 带 call_id 而 `added` 不带时判重键不一致：工具完整参数在增量之后再发一遍，agent-loop 按 index 归并追加 → 参数翻倍成非法 JSON，工具派发必然失败 |
| BUG-4 | 中 | agent-cli · SessionRunner | `waitForCurrentRun` 无条件武装 `--max-duration`：CLI 旁观他人执行时超时会**取消占用方（桌面端/另一终端）正在跑的任务**，违反自身帮助文本与代码注释 |
| BUG-5 | 中低 | backend-ts · task 工具 | `task_update` 空 status 绕过白名单把 `''` 写库、`task_create` 无任何白名单：待办状态统计与 allDone 判定失真 |
| BUG-6 | 中低 | backend-ts · 通道入站文件 | `resolveChatFileTarget` 派生的「唯一名」自身不查占用：文件名恰好形如派生名时仍然互相覆盖，历史消息 `@{路径}@` 引用被篡改（恰是 9bbd1c83 修复承诺要防止的事） |
| BUG-7 | 中低 | agent-cli · lineEditor | cursor=0 且草稿以换行开头时 `lineStart` 返回 1：Ctrl+U 把首字符复制进草稿（越删越长）、Home 向右跳格 |

---

## BUG-1【中高】grep_search 的 rg 分支吞掉进程失败：非法正则静默变成「0 命中成功」

**位置**：`backend-ts/src/harness/tool/impl/grep-search-tool.ts:90-97`（`searchWithRg` 全函数无任何 `spawned.status` / `spawned.error` / `spawned.stderr` 检查）

```ts
const spawned = spawnSync(cmd[0], cmd.slice(1), {
  cwd: scope.cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
});
...
for (const line of (spawned.stdout ?? '').split('\n')) {   // 只看 stdout，失败即空
```

**代码事实与触发链**（服务器装有 ripgrep 时，`isRgAvailable()` 恒为 true）：

1. 模型调用 `grep_search`，`pattern` 为非法正则（如 `[abc`，LLM 输出正则类 pattern 并不罕见）→ `rg --json '[abc' <dir>` 退出码 2，错误只写 stderr，stdout 为空；
2. `searchWithRg` 对空 stdout 零命中循环 → 返回 `{ matches: [], truncated: false, total_matches: 0 }`，经 `:71` 判为 **success**；
3. 模型据此得出「代码里不存在该模式」的错误结论并继续推进。

同根因的另两个触发面：搜索目标在 stat 之后被删除（exit 2）；大工作区超过 30s timeout 或 10MB maxBuffer，进程被杀，**部分** stdout 被当作完整结果返回且 `truncated=false`。

**预期 vs 实际**：无 rg 的机器走 JS 回退分支，`new RegExp('[abc')` 在 `:133` 抛 SyntaxError → 外层 catch（`:72-76`）返回 error JSON。同一输入在两台机器上一台报错、一台静默「成功 0 命中」。

**验证**（`backend-ts/repro-tests/bug01-grep-rg-failure-swallowed.spec.ts`，mock `spawnSync`）：

```
FAIL … 非法正则（rg exit 2）应返回 error，而不是干净的 0 命中成功
AssertionError: expected undefined to be truthy        ← 实际输出无 error 字段
FAIL … rg 被超时/缓冲上限杀死且有部分 stdout 时，truncated 应为 true
AssertionError: expected false to be true              ← 实际 truncated=false
```

**修复方向**：`spawnSync` 后检查 `spawned.error != null` 或 `spawned.status !== 0`：stdout 为空时读 stderr 返回 error JSON（对齐 JS 分支）；`error.code === 'ETIMEDOUT'/'ENOBUFS'` 且有部分 stdout 时至少置 `truncated: true`。

---

## BUG-2【中高】desktop 吞掉 `session_already_running` 拒绝帧：发送假成功、消息静默丢失

**位置**：

- 过滤门禁：`desktop/src/composables/useStreamWS.ts:543`（`session_already_running` 在 `:94` 被列入 `STREAM_EVENT_TYPES`，先过 `isStaleExecution` 门禁）
- 过滤逻辑：`useStreamWS.ts:76-88`（`data.executionId !== active` 即判 stale 丢弃）
- 不可达的拒绝处理：`useStreamWS.ts:764-772`（`case 'session_already_running'` 内 `cb.reject`）
- 发送时序：`desktop/src/composables/useChat.ts:477`（发送**前** `setActiveExecution(sid, 新eventId)`）
- 后端帧形状：`backend-ts/src/session/ws/streaming-ws-handler.ts:1764-1770`（`data.executionId = this.runningExecutionIds.get(sessionId)`，**总是携带占用方的 executionId**）

**触发链**：

1. 会话被其他端占用（飞书/微信/另一台桌面/CLI 正在跑同一会话；或本端「停止」后旧执行尚未收尾的窗口内立即重发）；
2. 本端发送前 `setActiveExecution(sid, 'evt-new')` → `activeExecutionIds = evt-new`；
3. 服务端回 `session_already_running{executionId: 'exec-remote'}` → `'exec-remote' !== 'evt-new'` → **帧被当 stale 丢弃**；
4. `:769` 的 `cb.reject` 永不触发；随后占用方执行收尾的 `session_status`（不在 `STREAM_EVENT_TYPES`，不受过滤）把等待中的 callback 按**成功**路径 resolve；
5. 结果：乐观用户消息永远停在 `msg_*` 临时 ID、内容从未执行也从未入库，`sending=false`、输入框解锁——用户看到的是「发送成功但没有任何反应」，无任何报错。

**预期 vs 实际**：拒绝帧应送达调用方（reject → useChat catch 提示「该任务仍在运行」，输入保留可重试）；实际被 stale 门禁吞掉、回合假成功。agent-cli 侧同场景依赖同一字段实现了「等占用方结束后重发」（session-runner.ts 的 `session_already_running` 分支**不按自身 executionId 过滤**，并注明「其 data.executionId 指向占用方，不能走按自身 executionId 的过滤」），desktop 端漏了同样的豁免。

**验证**（`desktop/repro-tests/bug07-already-running-rejected-frame-swallowed.test.ts`，复用 useStreamWS.test.ts 的 FakeWebSocket 设施）：

```
FAIL … 注册的 pendingCallbacks.reject 必须被调用
AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
```

**修复方向**：`session_already_running`（以及同样携带他人 executionId 的 `error` 类帧）从 stale 过滤中豁免，或 `isStaleExecution` 仅按 `cancelledExecutionIds`/suppressed 精确判定；可参考 CLI 补「等占用方结束后重发一次」的收敛。

---

## BUG-3【中高】responses 适配器 done/added 聚合键不一致：工具参数翻倍成非法 JSON

**位置**：`backend-ts/src/harness/llm/responses-llm-adapter.ts`

- `:333-334`（added：`call_id` 缺失时聚合键退回 `item.id`，映射表登记被跳过）
- `:350-353`（arguments.delta：增量参数记在键 `fc_1` 名下）
- `:380-383`（done：用 `resolveCallKey(item.call_id)` 解析出**另一个键**，判重失效后全量参数重发）
- `:279-285`（`resolveCallKey`：未知键原样返回）
- 消费端：`backend-ts/src/harness/core/agent-loop.ts:666-679`（`findMergeTarget` 按 id 落空后按 index 命中同一条）、`:692-694`（`applyToolCallDelta` 对 arguments **追加**拼接）

**触发链**（`output_item.added` 不带 `call_id` 而 `output_item.done` 带规范 `call_id` 的网关形状——适配器 `:333` 注释明言「网关未下发 call_id 时退回 item.id 兜底」，即该形状在预期支持范围内；现有 spec 夹具全部 added/done 都带 call_id，未覆盖此分支）：

1. added `{id:'fc_1'}`（无 call_id）→ 聚合键 `fc_1`；`rememberCallKeyMapping('fc_1','fc_1')` 因键值相等被跳过，映射表为空；
2. arguments.delta（item_id `fc_1`）→ 增量参数记入 `keysWithArgsDelta = {'fc_1'}`；
3. done `{id:'fc_1', call_id:'call_x', arguments:'{"q":"bj"}'}` → `resolveCallKey('call_x')` 查映射表落空、原样返回 `call_x`；`keysWithArgsDelta.has('call_x') === false` → **完整参数以新 id 再发一次**；
4. agent-loop：新 id 按 id 落空、按 index 命中同一条调用 → 完整参数**追加**到增量之后。

**预期 vs 实际**：最终 arguments 应为 `{"q":"bj"}`；实际为 `{"q":"bj"}{"q":"bj"}` → `JSON.parse` 失败 → 该轮工具派发必然报参数错误（且网关侧 done 与 added 的 id 双写不改变 delta 已记键的事实，属确定性复现）。

**验证**（`backend-ts/repro-tests/bug04-responses-done-callid-double-args.spec.ts`，真实 SSE 流夹具）：

```
FAIL … arguments 应恰好等于完整参数（增量与 done 全量不得拼接两遍）
SyntaxError: Unexpected non-whitespace character after JSON at position 10
  ← '{"q":"bj"}{"q":"bj"}' 第 10 个字符正是第二个 '{'
```

**修复方向**：done 先用 `item.id` 查映射表换算聚合键再查 `keysWithArgsDelta`（或对 `call_id` 与 `item.id` 两个候选键都查判重集合）。

---

## BUG-4【中】agent-cli `waitForCurrentRun` 武装 `--max-duration`：超时取消占用方的执行

**位置**：`agent-cli/src/session/session-runner.ts`

- `:200-215`（`waitForCurrentRun`：`:208` 无条件 `armMaxDuration()`）
- `:287-296`（`armMaxDuration`：到期回调 `sendCancel()` → 向会话发 `{type:'cancel'}`）
- 对照组（同一语义的正确实现）：`:141` 注释「等占用方期间不武装 --max-duration：超时不应取消他人执行」；`:188-198` `awaitBusyRun` → `:300-315` `waitOccupantWithOptionalTimeout`（到期只 `flushWaiters` 结束本地等待，**不发 cancel**）
- 语义承诺：`agent-cli/src/args.ts:66`「自己这次执行的墙钟上限；**等占用方时超时只结束本地等待，不 cancel 对方**」

**触发链**：会话正在桌面端执行 → 用户跑 `mao-agent --max-duration 30 resume <sid>`（resume 无 prompt 进入 REPL 时 `repl.ts:152/162` 调 `waitForCurrentRun`）→ 本地并未发起任何执行、只是旁观 → 30 秒到期 → `sendCancel` 把**别人的执行**取消，桌面端任务中断，本地以超时收尾。

**预期 vs 实际**：`--max-duration` 在等待占用方场景只应结束本地等待；`runPrompt` 的同场景（`handleAlreadyActive` → `waitOccupantWithOptionalTimeout`）已按此实现，`waitForCurrentRun` 是同一语义的漏改路径。

**验证**（`agent-cli/repro-tests/bug06-wait-for-current-run-cancels-occupier.spec.ts`，注入 stub WsClient + fake timers）：

```
FAIL … 等待占用方期间 max-duration 到期，不得发出 cancel 帧
AssertionError: expected [ { type: 'cancel', sessionId: 42 } ] to have a length of +0 but got 1
```

**修复方向**：`waitForCurrentRun` 改调 `waitOccupantWithOptionalTimeout()`（与 `awaitBusyRun` 对齐），删除 `:208` 的无条件 `armMaxDuration()`。

---

## BUG-5【中低】task 工具 status 校验缺口：空串写库 + create 无白名单

**位置**：`backend-ts/src/harness/tool/impl/task-tools.ts`

- `:186-199`（task_update：`asText('')` 返回 `''`（非 null，见 `harness/tool/json.ts:17-22`），`:188` 白名单条件 `newStatus != null && newStatus !== '' && !includes(...)` 对空串恒假——恰好跳过校验；`:198` `if (newStatus != null) fields.status = newStatus` 把 `''` 写入 UPDATE 列）
- `:62`（task_create：`const status = asText(item.status) ?? 'pending'`，**无任何白名单**）

**触发链**：模型参数抖动输出 `{"items":[{"id":1,"status":""}]}`（与仓库在 `ask-user-questions-normalize` 等处专门防御的空串抖动同类）→ `UPDATE session_todo SET status = ''` → 该任务从 `task_list` 的 completed/inProgress 统计、`task_update` 的 `allDone`（`every(status==='completed')`）视图中消失。同族：`task_create` 传 `status:"done"` 等任意串直接入库（schema 只声明三种状态；update 侧的白名单是 08-30 审查后补的，create 侧漏掉）。

**预期 vs 实际**：空串应与非法值同样报错（或视为未提供跳过赋值）；create 应与 update 同一白名单口径。

**验证**（`backend-ts/repro-tests/bug02-task-status-empty-bypass.spec.ts`，stub mapper 捕获写入参数）：

```
FAIL … task_update 传 status="" 应报错或不写 status
AssertionError: expected false to be true      ← 实际 updateFields 收到 { status: '' }
FAIL … task_create 传非法状态值 "done" 应报错或归一为 pending
AssertionError: expected false to be true      ← 实际 insert 收到 status: 'done'
```

**修复方向**：update 侧 `newStatus === ''` 时跳过赋值（或与非法值同样报错）；create 侧补与 update 相同的白名单。

---

## BUG-6【中低】通道入站文件「唯一名」派生分支不查占用：历史引用仍可被覆盖

**位置**：`backend-ts/src/feishu/chat-files.ts:21-28`（调用点：`dingtalk/runtime.ts` 与 `create-app.ts` 的飞书/钉钉入站落盘，两通道共用）

```ts
const target = resolve(dir, fileName);
if (!existsSync(target)) return target;      // 只查原名
...
return resolve(dir, `${stem}-${messageId}${indexSuffix}${ext}`);   // ← 派生名不再 existsSync
```

**触发链**（同日同会话目录）：

1. 消息 1001 发来文件名**恰好为** `报价-2002.docx` 的文件 → 原名未占用，落盘 `报价-2002.docx`，历史消息以 `@{…/报价-2002.docx}@` 持久化；
2. 目录里此前已有 `报价.docx`；
3. 消息 2002 发来 `报价.docx` → 原名命中 → 派生名 `报价-2002.docx` → **该路径已被步骤 1 占用但不再检查** → `writeFile` 覆盖；
4. 消息 1001 历史里的 `@{路径}@` 引用从此指向消息 2002 的文件内容。

**预期 vs 实际**：函数注释承诺「历史消息里的 @{路径}@ 引用因此不会被后到的同名文件篡改」；实际唯一性只有一层，派生名被占用时静默覆盖（同消息多文件的 `-2` 序号派生名同样不查占用）。概率低但完全确定性，且正是 e6d6f8fb/9bbd1c83 一轮修复承诺要杜绝的后果。

**验证**（`backend-ts/repro-tests/bug03-chat-file-derived-name-collision.spec.ts`，tmpdir 预置两个文件）：

```
FAIL … 派生名 {stem}-{messageId}{ext} 已被占用时，应继续避让而不是返回已存在路径
AssertionError: expected true to be false       ← 实际返回已存在路径
FAIL … 同消息多文件序号派生名（-2 后缀）同样不查占用
AssertionError: expected true to be false
```

**修复方向**：对派生名循环 `existsSync` 追加序号（或直接统一 `stem-{messageId}-{n}` 递增）。

---

## BUG-7【中低】lineEditor 在 cursor=0 且草稿以换行开头时行首计算错误：Ctrl+U 复制草稿

**位置**：`agent-cli/src/tui/line-editor.ts:103-106`（`lineStart`），受害方 `:113-115`（`moveHome`/Home）、`:127-131`（`killToStart`/Ctrl+U）、`moveVertical` 列宽计算

```ts
export function lineStart(text: string, cursor: number): number {
  const idx = text.lastIndexOf('\n', Math.max(0, cursor - 1));
  return idx === -1 ? 0 : idx + 1;
}
```

**触发链**：多行草稿首行为空（如 Ctrl+J 先插入换行再输入，`text='\nfoo'`）→ Home 回行首、再 ← 得 `cursor=0` →

- `lastIndexOf('\n', max(0, -1))` = `lastIndexOf('\n', 0)` 命中**下标 0 处的换行符** → 返回 1 而非 0——把「光标前没有字符」误判成「光标前有个换行」；
- Ctrl+U（`killToStart`）：`text.slice(0,1) + text.slice(0)` = `'\n' + '\nfoo'` = `'\n\nfoo'`，**草稿越删越长**，首字符被复制；
- Home（`moveHome`）：光标已在行首反而向右跳到 1。

**预期 vs 实际**：cursor=0 位于第 0 行行首，`lineStart` 应返回 0。

**验证**（`agent-cli/repro-tests/bug05-line-editor-cursor-at-zero.spec.ts`，纯函数用例）：

```
FAIL … lineStart("\nfoo", 0) 应返回 0
AssertionError: expected 1 to be +0
FAIL … cursor=0 时 Ctrl+U 不应复制首字符
AssertionError: expected { text: '\n\nfoo', cursor: 1 } to deeply equal { text: '\nfoo', cursor: +0 }
```

**修复方向**：`if (cursor <= 0) return 0;` 提前返回。

---

## 附录 A：复现测试套件说明（用例已迁入正式套件）

评审当时，所有验证用例存放在三个端的 `repro-tests/` 目录并各配独立 vitest 配置（include 只指向 `repro-tests/`，不影响 `npm test` 与 CI），在修复前基线（`db4f07a7`）上三套 12 个用例全部失败，失败信息即上文各 BUG 的「实际」行为。

2026-10-02 同日完成修复后，用例已迁入正式测试套件，repro 目录与独立配置已删除：

| BUG | 迁入位置 |
| --- | --- |
| BUG-1 | `backend-ts/src/harness/tool/impl/grep-search-tool.spec.ts`（另补「rg exit 1=无匹配不是失败」的正交用例） |
| BUG-2 | `desktop/src/composables/useStreamWS.test.ts` |
| BUG-3 | `backend-ts/src/harness/llm/responses-llm-adapter.spec.ts` |
| BUG-4 | `agent-cli/test/session-runner.spec.ts`（与既有「runPrompt 等待占用方不 cancel 对方」用例同风格） |
| BUG-5 | `backend-ts/src/harness/tool/impl/task-tools.spec.ts` |
| BUG-6 | `backend-ts/src/feishu/chat-files.spec.ts` |
| BUG-7 | `agent-cli/test/line-editor.spec.ts` |

## 附录 B：本轮核实的次级问题（未附验证用例，供后续修复参考）

| 位置 | 问题 |
| --- | --- |
| `grep-search-tool.ts:116` vs `:140` | rg 分支 entrySize 把 path/content 在 `JSON.stringify` 之外**再计一遍**（≈2 倍虚耗），实际输出约为 `max_output_chars` 承诺量的一半，与 JS 分支口径不一致 |
| `responses-llm-adapter.ts:325,340,1030-1032,973` | 单 response 内多个 reasoning 项：流式只挂第一个、非流式把最后一项错挂到第一个 function_call、回传只回一条 → 要求配对的严格网关 400 |
| `responses-llm-adapter.ts:398-408` + `llm/json.ts:259-270` | 流中 SSE error 的字符串 code（官方 `context_length_exceeded` 等）→ `statusCode=null` → 不可重试错误被退避重试 10 次；与 anthropic 适配器的 `anthropicErrorTypeToStatus` 映射策略不一致 |
| `agent-loop.ts:675-676` | `findMergeTarget` 的 `existing[delta.index]` 位置兜底在「index 乱序 + 分片缺 id」叠加时错并参数（低置信备案，e6d6f8fb 修复未覆盖的残余分支） |
| `agent-loop.ts:366-378` | 最终轮 `onSaveAssistantMessage` 持久化失败路径无 `closeRound()`：onRoundStart/onRoundEnd 不配对（「空响应耗尽」已知问题在正常持久化失败路径上的泛化面） |
| `background-task-manager.ts:57-71` | 已完成的后台任务条目只能被「其他会话的轮询」按 30min 阈值回收，单会话实例上永久驻留（内存卫生问题） |
| `wechat-tools.ts:111-115,123-132` | `send_wechat_file` 本地路径零大小上限（`MAX_FILE_BYTES` 只约束 URL 分支），且通道工具本地分支一律「先整读后检查」：GB 级路径先撑爆内存 |
| `wechat-tools.ts:112` | URL 以 `/` 结尾时 `split(/[\\/]/).pop() ?? 'file'` 得空串（`??` 不拦空串；feishu 同位置用 `\|\|` 是对的） |
| `glob-search-tool.ts:57-60` | `head_limit` 传字符串数字直接报错，与同族数值参数 `asInt` 宽容口径相反 |
| `task-tools.ts:276-282` | task_delete 的「已删除 N 个」计数不校验命中，删不存在/已删的 id 也计入 |
| `write-file-tool.ts:54-56,74` | CRLF 文件上 `file_change_diff` 的 before（磁盘 CRLF）/after（模型 LF）口径不一致（中置信：Monaco 视觉影响待实测） |
| `workspace-browse.service.ts:342-345` | UTF-8 截断只回退 continuation 字节不回退前导字节，末字符可能解码成 U+FFFD |
| `web-search-tool.ts:156` | `req.on('timeout')` 只 reject 不 `req.destroy()`，socket 挂后台 |
| `file.routes.ts:350` | 非 `file` 字段名的第一个 multipart 文件也会被采纳为主文件 |
| `streaming-ws-handler.ts:1394-1402` | 插队补偿「回补队首」后无消费泵：补偿成功的消息滞留队列直到下次手动发送（对照同提交对入口取消复查的消费标准） |
| `agent-cli/src/tui/keydecode.ts:174-176` | `ESC[1n~` 前缀匹配把 F1–F8（`\x1b[11~` 等）全部解码成 Home |
| `agent-cli/src/rest/rest-client.ts:128-153` | REST 响应体读取不受 `--timeout-ms` 约束（headers 一到即解除 abort 武装） |
| `desktop/electron/main.cjs:1653-1687` | `list-workspace-files` 的 `walkDir` 同步递归无深度/节点上限：过滤器无命中时遍历全树，主进程冻结、全部 IPC 停摆 |
| `desktop/electron/main.cjs:2366-2383` | desktop `grepWithRg` 把 rg 失败当「零匹配」且上下文行计入 `total_matches`，与后端/CLI 修复后口径分叉（三端同源实现中唯一未同步的） |

## 附录 C：已排查、确认不构成 BUG 的候选（节选）

- **harness/core 引擎**：压缩 start/end 事件在 service/orchestrator 三段互斥路径上配对无缺口；`normalizeChatMessages` 丢无 id TOOL 消息不可达（全部生产方保证 id 非空）；`addUsage` NaN 不可达；cancelFlags/heartbeat/toolAttachments/skillDocMap 生命周期均有界。该目录经 250+ 篇历史评审后剩余可触发缺陷已很稀薄。
- **PROXY/SMART 审批链**（dispatcher/proxy-approver/jev-risk-assessor）：2026-09-30 专项审查结论逐项复核成立，未发现新缺口。
- **41528cbe/e6d6f8fb/9bbd1c83/2fb1d04d 修复本体**：取消收敛的簿记身份判定、管理员守卫事务化、open_web_page urlSlug、feishu 进度卡 carriedContent 等修复经复核成立（BUG-3/BUG-6 是其邻域遗漏，非修复错误）。
- **desktop 其他疑点**：`removeLastUserMessage` 有乐观 ID 前缀守卫；`applyEol`/CRLF 处理与后端口径一致；`serializePayload` 截断、断线 settle 句柄、分页保留等均有既有修复覆盖。
- 另注：`backend-ts/src/harness/core/repro5.spec.ts` 是历史遗留的调试用 repro 文件（当前可通过，不影响 CI），建议随下次清理删除。

---

*评审人：ZCode（GLM）。所有条目均经源码逐行复核 + 可运行用例验证；测试文件与本基线的 diff 仅新增 `repro-tests/`、三个 `vitest.repro.config.ts` 与本文档，未改动任何业务代码。*
