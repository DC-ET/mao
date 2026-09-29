# 代码审查报告：核心功能逻辑 BUG（2026-09-29）

## 审查范围与方法

覆盖后端 `backend-ts/src`（harness 引擎、session、usage、auth、permission、settings、schedule、file、compaction、
path-sandbox、feishu 通道）与前端 `desktop/src`（stores、composables、utils），重点排查**逻辑 BUG**
（状态不一致、时序竞态、边界错误、数据丢失、安全边界），不涉及风格与注释问题。

本轮共核实 **6 个核心功能逻辑 BUG**（下文 BUG-1 ~ BUG-6），另有 3 项中低优先级问题列在附录、
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

### 已剔除的误报（记录以免重复排查）

| 候选 | 剔除原因 |
| --- | --- |
| 定时任务可越权绑定他人 `sessionId` | `createTask` 无 create 路由，仅由内置工具 `scheduled-task-tools.ts:87` 调用，`sessionId` 取自当前执行上下文，用户不可控；`scheduled-task.routes.ts` 亦对读/写做 owner 校验。 |
| `updatePhase` 计时存在时区错位 | `nowSql()` 写本地墙钟、`Date.parse` 按本地时区解析，两侧口径自洽，仅在部署机 TZ 与业务时区不一致时才偏移，属部署约定问题而非代码缺陷。 |
| `sortByFocusPriority` 的 `Number(id)` 可能 NaN | `FocusCandidate.id` 全部由 `String(数字 id)` 构造（`sessionToFocusCandidate` / `sideTaskToFocusCandidate`），不产生非数字输入。 |

---

## BUG-1：取消/异常路径漏发回合结束与消息结束事件，前端回合状态悬挂

- **严重程度**：高
- **位置**：`backend-ts/src/harness/core/agent-loop.ts:173-175`、`:379-381`、`:456-459`、`:466`

### 问题

`execute()` 的 while 循环内共 4 处退出路径，只有 1 条发全了收尾事件：

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

同文件里另外 3 条路径（空响应重试 L373、子代理等待 L385、正常结束 L388、工具轮结束 L437）都显式调用了
`listener.onRoundEnd?.(round)`，并在 L372/L384 两处写下注释「**start/end 必须成对，否则前端回合状态错乱**」。
这 3 处 `return` 恰恰绕过了这条被自己反复强调的不变量。

### 触发路径

用户在回合进行中点击「停止」，且取消发生在轮首检查、子代理等待或 mid-loop 压缩任一环节。

### 影响

- `WsStreamingEventListener` 不会收到 `onRoundEnd` / `onMessageEnd`，前端回合停留在「生成中」，
  已发出的 `tool_call_start` 卡片不收尾（`onMessageEnd` 内部还有 `dispose()` 会 flush 尾部 delta 并
  `persistRuntimeStatus(null)`，一并被跳过，`runtimeStatusJson` 残留 `compacting` / `llmWaiting` 等中间态）。
- 刷新页面后前端依赖 `runtimeStatusJson` 恢复执行态，残留字段会导致恢复出错。
- `agent-loop.ts` 的 `finally` 块仍会清理 cancelFlags 与 shell 会话，所以后端不泄漏，**纯粹是事件协议不对称**。

### 建议修复

在 `execute()` 的 `finally` 之前统一收口，例如用 `try/finally` 包裹循环，用 `roundEnded` 标志保证
`onRoundEnd` 只发一次，并在 `return` 路径补发 `onMessageEnd`；或将这 3 处 `return` 统一改为
`listener.onRoundEnd?.(round); break;`。

---

## BUG-2：桌面端登出未清除「最后查看会话」，换号登录恢复到他人会话

- **严重程度**：高（越权可见性 + 换号数据串号）
- **位置**：`desktop/src/stores/session.ts:1727-1769`（`reset`）、`:146`、`:744`、`desktop/src/stores/auth.ts:71`

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
// auth.ts:66-72 logout()
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

### 影响

- B 端向服务端请求 A 的会话详情。后端 `session.routes.ts` 的 `requireSessionOwner` 会拒绝越权读取，
  因此**不会泄露内容**；但会表现为登录后一次无意义的失败请求与侧栏空态。
- 若 A、B 同处一个团队/共享工作区且后端 owner 判定较宽，则存在看到他人会话的真实风险——取决于
  `fetchSession` 的鉴权实现，本次未逐行确认，**建议按此复核**。
- 违反 `reset()` 自身注释声明的「避免换号登录后残留幽灵流式气泡/已读错乱」。

### 建议修复

在 `reset()` 末尾补 `forgetLastSession()`；更稳妥的做法是把 `mao_last_session_id` 改为按用户 id 分键存储
（如 `mao_last_session_id:{userId}`），从根上消除跨账号串号。

---

## BUG-3：消息去重在「已分页加载历史」时会误删用户真实历史消息

- **严重程度**：中（静默丢消息）
- **位置**：`desktop/src/stores/session.ts:1130-1135`（`earlier` 构造），对比 `:1142-1146`（tail 分支）

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

### 触发路径

会话内已通过分页加载了更早的历史 → 用户再次发送消息触发 `fetchMessages` 回填 →
若新消息内容与某条**更早的真实历史用户消息**完全一致（重复指令、相同图片），该历史消息被从头部静默剔除。

### 影响

已加载的历史消息从视图永久消失，直到下次完整 REST 覆盖才恢复；与该函数注释「避免消息区内容塌陷」的
目标自相矛盾——它确实没塌陷，但丢的是用户真实消息。

### 建议修复

给 `earlier` 的过滤条件补上 `isOptimisticUserId(String(m.id))`，与 tail 分支保持一致。

---

## BUG-4：系统配置批量保存无事务，中途失败留下半截配置

- **严重程度**：中
- **位置**：`backend-ts/src/settings/settings.service.ts:177-200`（`updateBatch`）

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

### 触发路径

群友 A 发一条**不带 @** 的图片消息（落占位符行）→ 富化线程开始下载（数秒~数十秒）→
群友 B 紧接着 @bot → `buildGroupContext` 读到的是**占位符**，并把水位线推进到该行 id →
下载完成后内容才被改写，但该 id 已 ≤ 水位线，被过滤条件 `(m.id ?? 0) > watermark` **永久排除**。

### 影响

图片/文件已下载落盘、`updateGroupMessageContent` 也成功了，但 Agent **永远只见过占位符文本**，
`@{}@` 引用形同虚设。`inbound-processor.ts:76-80` 的注释声称该设计正是为了避免此问题——
但序锁只覆盖了「日志行写入」，没有覆盖「内容富化」，修复实际未生效。

### 附带发现（同类根因，中高）

`feishu_chat.last_context_log_id` 是 **(app_id, chat_id)** 粒度，而 `listGroupMessages` 在
`threadId != null` 时会 `AND thread_id = ?` 过滤。混用话题的群里，一次非话题触发会把水位线推过话题消息的 id，
导致话题内消息在两条注入路径上（`> watermark` 与溢出查询）都取不到，静默丢失。

### 建议修复

富化完成后**原子地**推进水位线（如在回填的同一事务内以「内容已就绪」为条件更新），
或让水位线同时记录 `(logId, enriched)` 状态，未富化完成的行不参与水位线推进；
话题场景则需把水位线按 `(chat_id, thread_id)` 分维度存储。

---

## 附录：中低优先级问题（未计入 6 项）

| # | 问题 | 位置 | 说明 |
| --- | --- | --- | --- |
| A | 工具轮被取消时 `break` 仍会走到 `onMessageEnd(totalUsage)` | `agent-loop.ts:396-405`、`:466` | `rollbackIncompleteRound` 已丢弃本轮消息，但 `context.totalUsage` 仍含本轮增量，取消被记为「正常完成」且用量偏高。与 BUG-1 同源，建议一并修。 |
| B | 工具执行中途取消时已完成的结果不落上下文 | `agent-loop.ts:527-533`、`:543-545` | 取消语义下可接受（随后 `rollbackIncompleteRound` 会清理），记录备查。 |
| C | 快速命令倒序替换的注释与实现行为相反 | `prompt-engine.ts:149-158` | 注释称「展开内容含 `#{...}#` 时错乱」，但倒序 + `matchAll` 快照恰恰使嵌套标记不再展开。当前无运行时 BUG，但会误导后续维护者改成前向替换而引入真实越界。 |

## 建议修复顺序

1. **BUG-1**（事件协议不对称，影响所有取消场景，且会污染 `runtimeStatusJson` 恢复逻辑）
2. **BUG-2**（越权可见性风险，改动量最小，1 行）
3. **BUG-3**（静默丢用户消息）
4. **BUG-5**（分页漏会话）
5. **BUG-6**（飞书群图片/文件上下文静默失效）
6. **BUG-4**（配置部分应用，触发概率较低但恢复成本高）
