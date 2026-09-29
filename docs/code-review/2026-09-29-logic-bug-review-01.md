# 代码审查报告：核心功能逻辑 BUG（2026-09-29）

> **修复状态（2026-09-29，0.0.219）**：BUG-1 ~ BUG-6 已全部修复并通过回归。
> 前端三条（BUG-2/3/5）改 `desktop/src/stores/session.ts`；后端三条改
> `harness/core/agent-loop.ts`、`settings/*`、`feishu/*` + 迁移 `V126__feishu_enrich_pending_and_thread_watermark.sql`。
> 发版说明见 `CHANGELOG.md` 0.0.219。

## 审查范围与方法

覆盖后端 `backend-ts/src`（harness 引擎、session、usage、auth、permission、settings、schedule、file、compaction、
path-sandbox、feishu 通道）与前端 `desktop/src`（stores、composables、utils），重点排查**逻辑 BUG**
（状态不一致、时序竞态、边界错误、数据丢失、安全边界），不涉及风格与注释问题。

本轮共核实 **6 个核心功能逻辑 BUG**（下文 BUG-1 ~ BUG-6）；另有一项同源问题并入 BUG-1，
6 项已确认属产品设计或误报（不作为 BUG，另见「已确认属于产品设计」一节）。

> **覆盖度声明（请连同结论一起看）**
> - `session/ws/streaming-ws-handler.ts`（1712 行）、`session/util/tool-result-summarizer.ts`（621 行）
>   规模较大，本轮**未逐行读完**，只交叉引用了其消费方。
> - `dingtalk/`（27 文件）、`weixin/`（24 文件）本轮**未完成覆盖**，属已知盲区，建议单开一轮专项审查。
> - BUG-1 ~ BUG-5 为第一轮结论；BUG-6 为补充审查（飞书入站链路）新增。
>   BUG-6 已由我回读源码复核关键路径（`inbound-processor.ts` 的 fire-and-forget 富化、
>   `message.service.ts` 的水位线过滤条件），不是仅采信子代理结论。
> - 初稿曾把「写工具不校验路径」「CLOUD 无审批」「浏览接口软链」列为 BUG-6，经确认三者均为既定产品设计，已撤销，
>   详见下方「已确认属于产品设计」一节。
>
> **二次复核（逐条对照源码后修订）**
> - **BUG-1 影响下调**：`return` 路径漏发 `onMessageEnd` / `onRoundEnd` 属实，但前端/飞书均有外层兜底
>   （`session_status` 终态事件、`runExecution` 的 `finally { listener.dispose() }`、飞书 `cardListener.cancel()`），
>   原「回合悬挂 / 恢复出错」描述过高，严重程度由高降为中低。原附录 A（取消轮用量仍计入）同源，并入本条。
> - **BUG-2 影响校正**：`requireSessionOwner` 为严格 `session.userId !== userId`，**不存在**跨账号内容泄露；
>   原「越权可见性」表述撤销，保留换号残留脏请求与 `reset()` 契约违背。
> - **附录 B、C 移除**：B 在取消语义下可接受（文档原已注明）；C 仅注释与实现表述相反、无运行时缺陷，
>   价值不高，不再单列。

### 已剔除的误报（记录以免重复排查）

| 候选 | 剔除原因 |
| --- | --- |
| 定时任务可越权绑定他人 `sessionId` | `createTask` 无 create 路由，仅由内置工具 `scheduled-task-tools.ts:87` 调用，`sessionId` 取自当前执行上下文，用户不可控；`scheduled-task.routes.ts` 亦对读/写做 owner 校验。 |
| `updatePhase` 计时存在时区错位 | `nowSql()` 写本地墙钟、`Date.parse` 按本地时区解析，两侧口径自洽，仅在部署机 TZ 与业务时区不一致时才偏移，属部署约定问题而非代码缺陷。 |
| `sortByFocusPriority` 的 `Number(id)` 可能 NaN | `FocusCandidate.id` 全部由 `String(数字 id)` 构造（`sessionToFocusCandidate` / `sideTaskToFocusCandidate`），不产生非数字输入。 |

---

## BUG-1：取消/异常路径漏发回合结束与消息结束事件（协议不对称）

- **严重程度**：中低（外层已有兜底，剩余为状态残留与卡片轮次展示缺口）
- **位置**：`backend-ts/src/harness/core/agent-loop.ts:173-175`、`:379-381`、`:456-459`、`:466`
- **修复**：`execute()` 内用 `closeRound` / `abortRound` 统一收口；取消路径补发 `onRoundEnd` 并走到 `onMessageEnd`，同时回滚本轮未完成用量。回归见 `agent-loop.spec.ts`。

### 问题

`execute()` 的 while 循环内多处退出路径收尾事件不完整。3 处 `return` 同时绕过
`onRoundEnd` 与 `onMessageEnd`：

```ts
// L169：每轮开始必发 onRoundStart
listener.onRoundStart?.(round);
...
if (await this.isCancelled(context)) {
  cancelFlag?.set(true);
  return;                              // ← 缺口 1：漏发 onRoundEnd / onMessageEnd
}
...
if (bgSubagentManager?.hasRunning(...)) {
  await bgSubagentManager.waitForAll(...);
  if (await this.isCancelled(context)) {
    cancelFlag?.set(true);
    return;                            // ← 缺口 2：同上
  }
}
...
} catch (e) {
  if (e instanceof CompactionCancelledException) {
    cancelFlag?.set(true);
    return;                            // ← 缺口 3：同上
  }
}
...
listener.onMessageEnd(context.totalUsage);   // L466，上述三条 return 全部绕过
```

另外两条取消 `break` 路径（LLM 流 `Cancelled by user` L355-357、工具轮取消 L397-405）会走到
`onMessageEnd`，但同样**不调用 `onRoundEnd`**。同文件空响应重试 L373、子代理等待 L385、
正常结束 L388、工具轮结束 L437 都显式调用了 `listener.onRoundEnd?.(round)`，并在 L372/L384
写下注释「**start/end 必须成对，否则前端回合状态错乱**」——上述路径恰恰绕过了这条不变量。

### 触发路径

用户在回合进行中点击「停止」，且取消发生在轮首检查、子代理等待或 mid-loop 压缩任一环节
（3 处 `return`）；或取消发生在 LLM 流/工具执行阶段（2 处 `break`，缺 `onRoundEnd`）。

### 影响（二次复核后）

代码不对称属实，但**原「前端回合悬挂」结论过高**，外层已兜底：

- **WS 桌面/Web**：`streaming-ws-handler.ts` 的 `runExecution` 在 `executeFromEvent` 返回后按
  `cancelFlag` 走 `finishCancelledSession` → `task-terminal.service` 下发 `session_status: CANCELLED`；
  前端 `useStreamWS` 该分支会 `finishInterruptedStreamingMessage`、清 streaming/thinking/compacting、
  结束未完成工具卡片。且 `runExecution` 的 `finally` **必定** `listener.dispose()`，尾部 delta 会被 flush。
  因此**不会**出现「生成中」悬挂或工具卡永久转圈。
- **`persistRuntimeStatus(null)` 确实被跳过**：`runtimeStatusJson` 可能残留 `compacting` / `llmWaiting`。
  但 `applyRuntimeStatus` 仅在 `session.running` 为真时消费该字段，终态会话直接忽略，**不会**导致恢复出错；
  只是脏数据留库，下次成功执行覆盖前无害。
- **飞书卡片**：`FeishuCardProgressListener` 本就不实现/不依赖 `onMessageEnd`；取消时
  `agent-inbound-handler` 会调用 `cardListener.cancel()` 终态化。缺 `onRoundEnd` 的影响仅是
  最后一轮的 content/tools 未先 flush 到卡片 RUNNING 更新（终态文案仍会发出），属展示缺口。
- **附带（原附录 A）**：工具轮取消后 `break` 仍走 `onMessageEnd(context.totalUsage)`，
  `rollbackIncompleteRound` 已丢弃本轮消息，但 `totalUsage` 仍含本轮增量——取消被记为「正常完成」
  且用量偏高。与本条同源。

后端 `finally` 仍会清理 cancelFlags 与 shell/MCP 会话，不泄漏资源。

### 建议修复

在 `execute()` 统一收口：用 `try/finally` 或 `roundEnded` 标志保证 `onRoundEnd` 只发一次，
`return` 路径补发 `onMessageEnd`（或改为 `onRoundEnd` + `break`）；同时在取消分支把本轮未完成
用量从 `totalUsage` 中剔除或不调用 `onMessageEnd` 的用量上报。

---

## BUG-2：桌面端登出未清除「最后查看会话」，换号登录发起他人会话请求

- **严重程度**：中（换号残留脏请求；**无内容泄露**）
- **位置**：`desktop/src/stores/session.ts:1727-1769`（`reset`）、`:146`、`:744`、`desktop/src/stores/auth.ts:71`
- **修复**：`reset()` 末尾补 `forgetLastSession()`。回归见 `session.test.ts`。

### 问题

`mao_last_session_id` 持久化在 `localStorage`，`reset()` 逐项清空了 30+ 个内存态与两个非响应式容器，
却漏掉了它：

```ts
// session.ts:1727 reset()
function reset() {
  sessionEntities.value = new Map();
  ...                                   // 逐项清空所有内存态
  streamingAssistantMessageIds.clear();
  filteredToolCallIds.clear();
  viewingSideTaskId.value = null;
  // ← 缺少 persistLastSession(null) / forgetLastSession()
}
```

```ts
// auth.ts:66-72 clearLocalSession()（登出与 401 强制下线共用）
useStreamWS().disconnect();
useTerminalWS().disconnect();
await useTerminal().reset();
useSessionStore().reset();              // ← 走上面的 reset()，localStorage 残留
useDraftStore().reset();
```

对照可见作者是有意识的：`deleteSession` 就专门处理了同一场景——

```ts
// session.ts:1057-1059
// 若删除的是持久化的最后查看会话，一并清除，避免下次冷启动恢复一个已删除会话
if (getLastSessionId() === sid) { forgetLastSession() }
```

**删除**路径补了，登出路径漏了。

### 触发路径

用户 A 登录并进入会话 42 → 登出 → 用户 B 登录 → `TaskView.vue:922` 的 `navigateToLatestSession()`
调用 `getLastSessionId()` 读到 `"42"` → 侧栏不含该会话 → 走 `fetchSession("42")` 校验。

### 影响（二次复核后）

- B 端向服务端请求 A 的会话详情。`session.routes.ts` 的 `requireSessionOwner` 为严格
  `session.userId !== userId`，**必然拒绝，不会泄露标题或内容**；团队/共享工作区不放宽该判定。
- 表现为登录后一次无意义的 403 失败请求、`forgetLastSession()` 兜底后回退列表首项，属脏请求与体验噪音。
- 违反 `reset()` 自身注释声明的「避免换号登录后残留幽灵流式气泡/已读错乱」的清理契约。

### 建议修复

在 `reset()` 末尾补 `forgetLastSession()`；更稳妥的做法是把 `mao_last_session_id` 改为按用户 id 分键存储
（如 `mao_last_session_id:{userId}`），从根上消除跨账号残留。

---

## BUG-3：消息去重在「已分页加载历史」时会误删用户真实历史消息

- **严重程度**：中（静默丢消息）
- **位置**：`desktop/src/stores/session.ts:1130-1135`（`earlier` 构造），对比 `:1142-1146`（tail 分支）
- **修复**：`earlier` 过滤补上 `isOptimisticUserId`，与 tail 分支一致。回归见 `session.test.ts`。

### 问题

同一个去重意图在函数内写了两遍，**两遍的条件不对称**：tail 分支有「乐观 ID」判定，`earlier` 分支没有。

```ts
// L1130-1135 头部：按「内容相同」直接删本地消息
const earlier = firstFetchedIndex > 0
  ? local.slice(0, firstFetchedIndex).filter(m => !newlyFetchedUsers.some(fetched =>
      fetched.content === m.content
      && JSON.stringify(fetched.images ?? []) === JSON.stringify(m.images ?? [])))
  : []

// L1142-1146 尾部：同样的内容匹配，但多了一层 isOptimisticUserId 约束
const isReplacedOptimisticUser = message.role === 'user'
  && isOptimisticUserId(String(message.id))     // ← 头部缺这一条
  && newlyFetchedUsers.some(fetched => fetched.content === message.content && ...)
```

内容相同**本不足以判定两条是同一条**——用户在一条会话里完全可能两次发出「继续」这类相同指令。
只有本地那条带乐观 ID（尚未落库、等着被 REST 回显替换）时，按内容匹配才是安全的。
且乐观消息几乎总在尾部，`earlier` 段本不该做内容去重；一旦触发，删的是真实历史。

### 触发路径

会话内已通过分页加载了更早的历史 → 用户再次发送消息触发 `fetchMessages` 回填 →
若新消息内容与某条**更早的真实历史用户消息**完全一致（重复指令、相同图片），该历史消息被从头部静默剔除。

### 影响

已加载的历史消息从视图永久消失，直到下次完整 REST 覆盖才恢复；与该函数注释「避免消息区内容塌陷」的
目标自相矛盾——它确实没塌陷，但丢的是用户真实消息。

### 建议修复

给 `earlier` 的过滤条件补上 `isOptimisticUserId(String(m.id))`（补上后该段实际不再误删），与 tail 分支保持一致。

---

## BUG-4：系统配置批量保存无事务，中途失败留下半截配置

- **严重程度**：中
- **位置**：`backend-ts/src/settings/settings.service.ts:177-200`（`updateBatch`）
- **修复**：写入循环包进 `settingRepo.transaction`；`SystemSettingRepository` 新增 `transaction`。回归见 `settings.service.spec.ts`。

### 问题

校验阶段是全或无的，写入阶段不是：

```ts
async updateBatch(items) {
  const rows = [];
  for (const item of items) { /* 存在性 + 可编辑性 + 取值校验，任一失败即 throw */ rows.push({setting, next}) }
  const result = [];
  for (const { setting, next } of rows) {          // ← 逐条落库，无事务
    if (next == null) { result.push(this.masked(setting)); continue }
    setting.value = next;
    await this.settingRepo.updateById(setting);    // ← 第 N 条抛错时，前 N-1 条已提交
    result.push(this.masked(setting));
  }
  return result;
}
```

`settingRepo.updateById` 最终走 `Db.updateById`（`backend-ts/src/db/db.ts:38`），是连接池上的单条 UPDATE，
没有事务包裹。方法上方的注释「先对全部条目做校验，任一失败则整体失败；**校验通过后逐条落库**」准确描述了
现状——但它把「校验通过」当成了「写入必然成功」。

### 触发路径

管理后台 settings-cards 一次保存多项配置，循环中途 DB 报错（值超长、连接中断、锁等待超时）。

### 影响

系统配置进入**部分应用**状态，例如飞书凭据已更新、LDAP 未更新，行为难以推断，需人工逐项核对。

### 现有测试为何没抓到

`settings.service.spec.ts:384-394` 只断言了「校验阶段失败时 `updateById` 未被调用」，
**恰好绕开了写入阶段**。

### 建议修复

用已有的 `Db.transaction()`（`db.ts:47`）包裹写入循环，或给 `SystemSettingRepository` 增加 `updateMany`。

---

## BUG-5：分组分页 offset 用本地投影条数计算，漏会话

- **严重程度**：中
- **位置**：`desktop/src/stores/session.ts:406-418`（`loadMoreInGroup`），配合 `:757-780`（`updateSession`）
- **修复**：`SessionGroupMeta.loadedCount` 记账服务端已返回条数；`loadMoreInGroup` 用它作 offset，深链注入不计入。回归见 `session.test.ts`。

### 问题

offset 的语义应是「服务端该分组已返回的条数」，但这里统计的是**本地投影**：

```ts
// L414-418：offset 来自本地 standardSessionIds 的条数
const offset = standardSessionIds.value.filter(id => {
  const s = sessionEntities.value.get(id)
  return s && cloudGroupKey(s) === key
}).length
...
const { data } = await api.get('/sessions', { params: { groupKey: key, offset, limit } })
```

而 `updateSession` 会把**不在分组预览内**的会话直接塞到投影头部：

```ts
// L757-780
if (!existing && updates.executionMode && next.status !== 'ARCHIVED') {
  // Deep-link / loadSession for a session outside the current group preview：
  if (!standardSessionIds.value.includes(sid)) {
    standardSessionIds.value = [sid, ...standardSessionIds.value]   // ← 凭空 +1 条（L777）
  }
  ...
}
```

这两段组合后，offset 比服务端实际已返回的条数**偏大**，直接跳过了服务端结果中对应位置的会话。

### 触发路径

分组预览只返回前 N 条（`DEFAULT_GROUP_PREVIEW`）→ 用户通过深链/通知跳转到同组但排在第 50 位的会话 →
该会话被 unshift 进投影头部 → 用户点「加载更多」，此时 `offset = N + 1`，服务端下标 N 处的那条会话被整条跳过。

### 影响

分组列表静默丢失会话（且丢失条数固定等于注入条数），用户只能靠翻页或搜索找回。深链跳转 + 加载更多
是产品内的常规组合路径，触发成本低。

### 建议修复

用服务端返回的 `groupMeta.total` / 维护一个独立的 `loadedCountByGroup` 记录已加载条数作为 offset，
不要从本地投影长度反推；或让 `updateSession` 的注入逻辑同步登记该会话已从服务端加载（则不应再计入 offset）。

---

## 已确认属于产品设计、本次不作为 BUG 的事项

以下三条初稿曾被列为缺陷，经与维护者确认或查阅设计文档后**撤销**，记录在此以免重复上报。

**(a) `write_file` / `edit_file` 不校验工作区路径** —— **预期需求，不改。**
`PathSandbox.resolveLenient`（`path-sandbox.ts:47-56`）不做 `isUnder` 约束是刻意为之：Agent 需要写入工作区
之外的路径。初稿中「与 `glob`/`grep`/`read_file` 使用严格 `resolve()` 不一致」的观察属事实描述，但不构成缺陷。

**(b) CLOUD 模式下写工具不触发审批** —— **既定设计，不改。**
`shouldRequireApproval` 仅在 `tool-dispatcher.ts:172-188` 的 LOCAL 分支调用，CLOUD 走 L190-196 的
`callTool` 直通。初稿曾据此推断「CLOUD 下写操作完全无管控」，但
`docs/plan/2026-08-04-android-app-technical-design.md:51` 已明确记载：「工具审批弹窗…CLOUD 模式工具在
服务端执行，不产生 `tool_execute` 事件，**无审批需求**；`WAITING_APPROVAL` 仅 LOCAL 模式存在」，
`:200` 再次列入「明确不做事项」。

**(c) 目录浏览/打包不拦工作区内的符号链接** —— **产品已确认可接受，不改。**
`workspace-browse.service.ts` 中单文件接口（`downloadFile` / `readPdfFile` / `readFile`）用 `lstatSync` +
`assertRealPathInWorkspace` 拒绝了符号链接，而目录接口（`listDirectory` L64-72、`zipDirectory` L174-183）
只做 `statSync(...).isDirectory()`。初稿按「读侧应收紧」判其为越权缺陷，但维护者确认**软链视为用户自己的
内容，允许访问**——工作区内的软链由用户自己创建，指向何处属其自主选择，与 (a) 同源。

**代价与边界（供后续知情，当前不改）**：上述口径意味着一个登录用户可在自己工作区内建软链
（如经 `shell` 工具或 `git clone` 带入），进而通过 `workspace-download-zip` 打包下载工作区之外的目录
（`/etc`、其他用户工作区、`/opt/mao/keystore` 等），读侧不经过审批故无拦截。这是**已知的接受风险**，
非疏漏。若日后需要收敛，建议单独立项而非当作 BUG 修补——它会同时与 (a) 的「写路径放开」冲突。

---

## BUG-6：飞书群消息后置富化与上下文水位线推进竞态，图片/文件内容永远进不了群上下文

- **严重程度**：中（功能静默失效）
- **位置**：`backend-ts/src/feishu/inbound-processor.ts:93`、`:119`、`:162-196`
- **修复**：`V126` 增加 `enrich_pending` 与话题水位线；注入与水位线遇未富化行即停、不跳洞；话题/群水位线分维度。回归见 `message.service.spec.ts`。

### 问题

群消息先落「占位符」行，再 fire-and-forget 地异步下载图片并回填内容；但水位线推进与富化之间无互斥：

```ts
// inbound-processor.ts:93：不 await，且未占 chat 序锁
void this.enrichGroupMessage(accountId, normalized ? logId : logId, normalized);

// :196：下载完成才回填真实内容
await this.options.messageService?.updateGroupMessageContent(logId, content);
```

而下一条 @bot 触发的上下文读取在序锁内按 id 水位线过滤：

```ts
// message.service.ts:237-245
const messages = await this.repository.listGroupMessages(...);
const filtered = messages.filter((m) => ... && (m.id ?? 0) > watermark);
...
if (maxLogId > watermark) { await this.repository.updateGroupContextWatermark(accountId, context.chatId!, maxLogId); }
```

`recordGroupMessage` 与 `buildGroupContext` 走 `runInChatOrder` 保序，**但 `enrichGroupMessage` 不在锁内**。
序锁只保证「占位行先于后续触发被读到」，不保证「内容已富化完毕」。

### 触发路径

群友 A 发一条**不带 @** 的图片消息（落占位符行）→ 富化线程开始下载（数秒~数十秒）→
群友 B 紧接着 @bot → `buildGroupContext` 读到的是**占位符**，并把水位线推进到该行 id →
下载完成后内容才被改写，但该 id 已 ≤ 水位线，被过滤条件 `(m.id ?? 0) > watermark` **永久排除**。

### 影响

图片/文件已下载落盘、`updateGroupMessageContent` 也成功了，但 Agent **永远只见过占位符文本**，
`@{}@` 引用形同虚设。`inbound-processor.ts:34-35、88-89` 的注释声称该设计正是为了避免此问题——
但序锁只覆盖了「日志行写入」，没有覆盖「内容富化」，修复实际未生效。

### 附带发现（同类根因，中高）

`feishu_chat.last_context_log_id` 是 **(app_id, chat_id)** 粒度，而 `listGroupMessages` 在
`threadId != null` 时会 `AND thread_id = ?` 过滤。混用话题的群里，一次非话题触发会把水位线推过话题消息的 id
（`maxLogId` 取自未按 thread 过滤的全量窗口），导致话题内消息在两条注入路径上（`> watermark` 与溢出查询）
都取不到，静默丢失。

### 建议修复

富化完成后**原子地**推进水位线（如在回填的同一事务内以「内容已就绪」为条件更新），
或让水位线同时记录 `(logId, enriched)` 状态，未富化完成的行不参与水位线推进；
话题场景则需把水位线按 `(chat_id, thread_id)` 分维度存储。

---

## 建议修复顺序

1. **BUG-3**（静默丢用户消息，改动 1 行，数据正确性）
2. **BUG-2**（换号残留脏请求，改动 1 行）
3. **BUG-5**（分页漏会话，触发路径常规）
4. **BUG-6**（飞书群图片/文件上下文静默失效）
5. **BUG-4**（配置部分应用，触发概率较低但恢复成本高）
6. **BUG-1**（事件协议不对称 + 取消轮用量偏高；外层已有兜底，优先级最低）
