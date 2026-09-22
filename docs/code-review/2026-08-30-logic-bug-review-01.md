# 代码审查报告：核心功能逻辑 BUG 全量审查（2026-08-30）

- **审查方式**：主审通读核心引擎（agent-loop / harness-service / session.service）+ 5 个并行分域深度审查（核心引擎 19 文件、LLM 适配与 WS 流式层、工具实现与子代理委派层、桌面前端 + 终端 CLI、调度/飞书/微信/通知/TODO）。全部指定文件完整阅读、跨文件跟踪调用链、关键结论经源码二次验证。
- **去重说明**：对照 `docs/code-review/` 历史 30+ 份报告共 1122 个已报问题标题，凡历史已报告（含修复确认）的现象一律不重复收录；个别与历史问题"同族但不同代码路径/独有触发条件"的条目在正文注明区别。
- **筛选口径**：只收录能推导出具体触发序列的逻辑 BUG；不收录风格、性能优化建议、"建议加校验"类非缺陷。
- **总计**：32 个 BUG —— 高 3、中 13、低 16。高严重度 3 项均经主审源码实证确认。

---

## 一、高严重度（3）

### H-1【高·安全】用户技能 frontmatter `name` 未做格式校验，直接作为同步目标目录名 → 服务器任意路径写入与递归删除（路径穿越）

- **位置**：`backend-ts/src/harness/skill/skill-sync-service.ts:30-31、53-54、63`；根因 `backend-ts/src/harness/skill/skill-md.ts:41`（`validateSkillMd` 只校验 name/description 非空，不校验格式）
- **代码摘录**：

```ts
// skill-sync-service.ts syncToSession()
for (const [name, doc] of Object.entries(this.loadUserSkill sync...
```

- **触发路径（已实证）**：用户上传技能包，frontmatter 写 `name: "../../../../opt/mao/data/payload"`，上传接受；任意会话发一条消息即触发 `syncToSession()`（用户技能无条件全量合并，与 agent.skillNames 无关；`loadUserSkillDocs` 以 frontmatter 的 `name` 为 key 而非磁盘目录名）。`path.join(skillsDir, name)` 逃出 `runtime/{userId}/{sessionId}/skills`，整目录 `cpSync` 写入任意路径；技能删除后走 `:63` 的 `rmSync(recursive, force)` 分支可递归删除任意目录。`writeSyncZip` 还会把穿越路径写进 zip 条目（mao-cli 端 zip-slip）。
- **影响**：认证用户可向服务器任意可写路径植入文件，或递归删除任意目录。与历史已修复的"技能删除接口路径穿越"是不同代码路径（同步复制/清理链路，且新增写向量）。
- **建议修复**：`validateSkillMd` 强制 `name` 满足 slug 规则（如 `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`）；`syncToSession` 写入/删除前用 `path.relative(skillsDir, target)` 断言不逃逸。

### H-2【高】子代理恢复协调器绕过蓝绿部署 defer 守卫：部署窗口内同一会话双实例并发执行

- **位置**：`backend-ts/src/harness/core/crash-recovery-runner.ts:63-71`（`runPass`）；关联 `harness/delegate/subagent-recovery-coordinator.ts:19-35、42-47`
- **代码摘录**：

```ts
// crash-recovery-runner.ts runPass：schedule() 在部署检查之前无条件执行
const blocked = this.subagentCoordinator
  ? await this.subagentCoordinator.schedule((session) => this.recoverSession(session))
  : new Set<number>();
const candidates = deferred ? this.deferredCandidates : await this.collectCandidates(blocked);
const deployLock = readDeployLock(this.runtimeDir);
const deferAll = !deferred && shouldDeferAllRecoveryDuringDeploy(deployLock);   // ← 守卫在 schedule() 之后，形同虚设
```

- **触发路径（已实证）**：蓝绿部署期间（`deploy.lock` status=`starting`/`switched`）旧实例仍在 drain 并执行父会话 P，其 delegate 子代理 execution 为 RUNNING/PENDING；新实例启动 `run()` → `runPass` 第一步执行 `schedule()` → `recoverGroup` 中 `claimRecovering` 的 SQL `WHERE status IN ('RUNNING','RECOVERING')` 允许直接从 RUNNING claim 成功 → `cleanupIncompleteTail` 删除旧实例正在写的尾部消息 → `updatePhase('RESUMING')` → 新实例重启执行 P。`deploy-lock.ts` 注释自证 "new instances must not recover any RUNNING sessions during deploy"，但协调器恢复路径完全不做部署锁检查。
- **影响**：部署窗口内同一会话双跑：消息重复执行/交叉写库、子代理重复运行（LLM 成本翻倍、结果互相覆盖）、旧实例正在生成的消息被误删导致上下文损坏。
- **建议修复**：把 `schedule()` 移到部署锁判定之后；`deferAll`/skip 场景下不执行协调器恢复（推迟到 deferred pass）。与历史已报"claim 互斥性缺失"不同（独有点：绕过部署 defer + 误删旧实例消息）。

### H-3【高】纯文本 JSON 数组消息被误解析为多模态 content 数组 → 该会话每次执行必然 400 / 内容损坏

- **位置**：`backend-ts/src/harness/core/session-history-loader.ts:77-88`（`parseContent`）
- **代码摘录**：

```ts
function parseContent(raw: string | null | undefined): unknown {
  if (raw == null) return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { return raw; }   // 无元素结构校验
  }
  return raw;
}
```

- **触发路径（已实证）**：用户发送纯文本 `[1,2,3]`、`[]`、`["a","b"]` 等合法 JSON 数组文本 → `saveMessage` 原样存库 → 每次 `buildContext → toChatMessage → parseContent` 将其还原为数字/字符串数组并当作多模态 content part 数组 → `harness/llm/json.ts:20-30 serializeContentPart` 对非对象元素返回空对象 `{}` → 发给 OpenAI 兼容 API 的 content 变成 `[{}, {}, {}]`。
- **影响**：content part 缺 `type` 字段 → API 400 或内容静默丢失；每次执行都从 DB 重载历史，该会话从这条消息起永久无法正常执行。根因：纯文本与多模态数组在 DB 中无法区分且解析端无结构校验（`session.service.ts` 的 `extractVisibleText` 有校验，加载器没有）。
- **建议修复**：`JSON.parse` 成功后校验每个元素是含 `type`（text/image_url）的对象，任一不满足则按原始字符串返回；长期方案在存储侧加类型标记与纯文本区分。

---

## 二、中严重度（13）

### M-1【中·LLM/SSE】OpenAI 与 Responses 两个适配器的 SSE 解析只认 `data: `（带空格），违反 SSE 规范的网关整渠道不可用

- **位置**：`backend-ts/src/harness/llm/openai-llm-adapter.ts:276`、`backend-ts/src/harness/llm/responses-llm-adapter.ts:435`
- **代码摘录**：`if (!line.startsWith('data: ')) return false;`（两个适配器相同；Anthropic 适配器 `:297` 用 `startsWith('data:')` 是正确写法，可对照）
- **触发路径**：使用按 SSE 规范（`data:<空格>可选`）发送 `data:{...}`（无空格）的 LLM 网关/代理 → 两个适配器的行过滤器把所有数据行判为非数据行 → 每次调用流式解析结果为空 → 空响应重试 10 次后报"空响应耗尽"，该渠道整渠道不可用。
- **影响**：配置此类网关的用户完全无法使用对应模型（Anthropic 渠道不受影响）。
- **建议修复**：行过滤改为 `line.startsWith('data:')`，取 payload 时再剥掉可选的一个空格。

### M-2【中·WS】用户「停止」与新执行的竞态：取消标志注册前到达的 cancel 被静默丢弃

- **位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts:801-806`（handleCancel→abortRunningExecution）、`:316-318`（send 路径注册标志）、`:936`（autoConsume 500ms 延迟窗口）；`harness/core/agent-loop.ts:72-76`
- **代码摘录**：

```ts
// agent-loop.ts:72 —— 每次注册都新建 false 标志并覆盖旧值
registerCancelFlag(sessionId: number): AtomicBoolean {
  const flag = new AtomicBoolean(false);
  this.cancelFlags.set(sessionId, flag);
  return flag;
}
```

- **触发路径**：send 处理中 `requireOwnedSession → 模型校验 → executionClaims.add → LOCAL 连通性检查 → saveMessage` 任意 await 期间客户端发 `cancel`：此刻两处 cancelFlags 均无该会话条目（上轮 finally 已 remove），`set(true)` 全部空转，`finishCancelledSession` 见 phase 仍为上轮终态而早退；随后 send 同步注册全新 false 标志并提交执行 → 整回合照常跑完。autoConsume 路径在持 claim 后经 500ms 延迟才调用 handleSendMessage，窗口更大。
- **影响**：用户点「停止」后任务照常全量执行（消耗 token、执行工具），只能再次手动取消。
- **建议修复**：send/edit/autoConsume 在注册标志前检查 pending cancel 状态（如 executionClaims 延迟到注册标志之后添加，或为会话维护"待取消"标记，注册时立即消费）。

### M-3【中·WS】`autoConsumeQueue` 出队后 `saveMessage` 抛错时消息永久丢失

- **位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts`（autoConsumeQueue：出队 → saveMessage → handleSendMessage；回补逻辑仅覆盖提交失败分支）
- **触发路径**：出队成功（队列行已删）→ `saveMessage` 因 DB 抖动/内容超长抛错 → 异常未被回补，消息既不在队列也不在会话。
- **影响**：用户/飞书消息静默丢失。
- **建议修复**：出队后到执行提交之间的异常统一回补重入队（或先落库再出队，保证至少一次语义）。

### M-4【中·WS】`executionClaims` 在 `saveMessage`/`prepareMessage` 抛错时泄漏 → 会话永久"任务仍在运行"

- **位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts`（claim 添加后、finally 释放前的异常路径）
- **触发路径**：`executionClaims.add` 之后 `saveMessage`/`prepareMessage` 抛错且未走统一 finally → 该 sessionId 的 claim 永不移除。
- **影响**：后续所有 send/autoConsume 被误判 busy（拒绝或入队），会话实际已空闲却永久无法直接发消息，直至进程重启。
- **建议修复**：claim 的添加/移除收敛到 try/finally；对泄漏的 claim 增加 TTL 或在 `finishExecution` 终态时兜底清理。

### M-5【中·调度】定时任务执行期间的用户修改被执行结束时的整行回写覆盖（cron/prompt/名称/状态静默回退）

- **位置**：`backend-ts/src/schedule/scheduled-task.service.ts:216-222`（锁内快照）、`:277-284`（finally 整行回写）
- **代码摘录**：

```ts
// :275-284 整个执行结束后用「T0 快照对象」整行回写
} finally {
  if (!countThisRun) return;
  task.lastFireTime = formatDateTime(new Date());
  task.fireCount = (task.fireCount ?? 0) + 1;
  if (this.calculateNextFireTime(task.cronExpression!) == null) { task.finished = 1; ... }
  await this.store.updateById(task);   // 全列 SET，T0 快照的 name/prompt/cron/status/nextFireTime 一并覆盖
}
```

- **触发路径**：任务触发 → 按 cron A 算好 `nextFireTime` 落库 → 进入数分钟的 Agent 执行 → 期间用户 `PUT /v1/scheduled-tasks/:id` 把 cron 改为 B（updateTask 与执行无互斥，正常落库）→ 执行结束 finally 用 T0 快照整行 `updateById` → `cron_expression` 被写回 A、`prompt`/`name`/`status` 同理被还原。
- **影响**：用户配置被静默回滚，下次触发仍按旧 cron；`Db.updateById` 是全列 SET，快照所有字段都会覆盖库中新值，属用户可见数据丢失。
- **建议修复**：finally 收尾只做增量更新（仅 last_fire_time/fire_count/last_execution_status/finished 等执行结果字段），或收尾前重读并按字段合并。

### M-6【中·飞书】排队卡片「立即发送」与会话执行状态机脱节：会话空闲时无人消费（消息永久滞留）／接力认领窗口内反而把目标消息误取消

- **位置**：`backend-ts/src/feishu/card-action.service.ts:65-78`（handleRun 仅 PATCH 卡片 + interrupt）、`backend-ts/src/feishu/agent-inbound-handler.ts:101-106`（interrupt 空闲时 no-op）
- **触发路径 A（滞留）**：消息 A 执行中 B 入队；A 以 FAILED 终态结束（onMessage 的接力显式跳过 FAILED，会话转空闲）→ 用户点 B 的「立即发送」→ `jumpToFront` 成功、卡片改"🚀 已插队"→ `interrupt()` 查无 cancel flag → 空操作 → 没有任何组件再调度 `drainNext`，B 永久滞留。
- **触发路径 B（误取消）**：A 执行中点 B「立即发送」→ `patchCard` 等待飞书 API 往返的百毫秒窗口内 A 正常完成 → onMessage 的 `drainNext()` 认领队首（恰为被插队的 B）并开始执行 → 随后 `interrupt()` 命中 B 刚注册的 cancel flag → 用户主动要求立即执行的消息被本次点击亲手取消，队列行在 finally 中删除。
- **影响**：排队消息永久卡死或被误取消，卡片文案与事实不符。
- **建议修复**：`interrupt()` 未命中 cancel flag（会话空闲）时改为触发 `drainNextIfPending`；「插队+中断+接力」收敛为 handler 提供的原子操作，interrupt 前后核对队列行状态。

### M-7【中·委派】同步 `delegate` 异常路径不落终态（followup 有兜底、delegate 没有）→ execution 永久 RUNNING，子会话追问被永久阻塞

- **位置**：`backend-ts/src/harness/tool/impl/delegate-tool.ts:181-183`（对比 `:454-457` followup 的 `failCreatedSubagent()` 兜底）
- **代码摘录**：

```ts
      return toJson(response);
    } catch (e) {
      return errorJson((e as Error).message);   // :181-182 —— execution 已创建但无任何清理
    }
```

- **触发路径**：CLOUD 会话 `delegate` → `createDelegate` 事务已提交（execution=RUNNING、子会话已建、前端已弹 Tab）→ `buildSubContext()` 内 `buildContext()` 因 DB/压缩记录异常抛出（位于 execution 插入之后）→ 落入 catch 仅返回 errorJson。
- **影响**：execution 永久 RUNNING；此后对该子会话的 `subagent_followup` 每次都走 RUNNING→纠偏等待 30s 超时失败，不可用直至进程重启（恢复还会整体重跑子代理，重复消耗 LLM）。
- **建议修复**：为 delegate 增加与 followup 相同的失败兜底：catch 中若 execution 已创建则 `markExecutionTerminal(FAILED)` + `finishSubagent(FAILED)`，并清理 local 注册与 cancel flag。

### M-8【中·工具】`generate_image` 的 HTTP 请求注册了 `timeout` 选项但无 `timeout` 监听 → 180s 超时完全不生效，请求可永久挂起

- **位置**：`backend-ts/src/harness/tool/impl/generate-image-tool.ts:110-129`
- **代码摘录**：

```ts
    const req = lib.request({ ... timeout: 180_000 }, (res) => { ... });
    req.on('error', reject);     // :126 没有 req.on('timeout', ...)
```

- **触发路径**：图像 API 完成握手但长时间不返回（服务僵死/中间代理黑洞）。Node 的 `timeout` 选项只发 `'timeout'` 事件，不注册监听器则既不中止也不 reject → Promise 永不 settle，整轮对话无限等待；后端无 stale session 扫描兜底。同批 `web-search-tool.ts:118` 有正确的 timeout 监听可对照。
- **影响**：会话永远停在运行中，无任何错误反馈。
- **建议修复**：补 `req.on('timeout', () => req.destroy(new Error('timeout')))`。

### M-9【中·任务状态】`task_update` 先 reset 后更新、无事务/存在性/枚举校验 → 不存在的 id 会清掉真实 in_progress 标记，并发可出现双 in_progress

- **位置**：`backend-ts/src/harness/tool/impl/task-tools.ts:185-194`（配合 `harness/todo/session-todo.mapper.ts:36-44`）
- **代码摘录**：

```ts
const newStatus = asText(item.status);                          // 未做枚举校验
if (newStatus === 'in_progress' && sessionId != null) {
  await this.sessionTodoMapper.resetInProgress(sessionId, id);  // 先无条件降级其它 in_progress
}
...
await this.sessionTodoMapper.updateFields(id, sessionId, fields); // 后更新（0 行也无所谓）
```

- **触发路径**：① 单次调用 `items=[{"id":999,"status":"in_progress"}]`（id 不存在）→ 真实 in_progress 被降级、目标更新 0 行 → 全部任务变 pending；② 同轮两个并行 `task_update` 各自 set in_progress，交错后出现两条 in_progress 或全部清空；③ `status:'done'` 等非法值被原样持久化，列表计数失真。
- **影响**：任务板状态机错乱，误导后续任务调度。
- **建议修复**：`resetInProgress + updateFields` 包进同一事务且仅在目标存在（影响 1 行）时才 reset；status 做白名单校验。

### M-10【中·前端】编辑重发的乐观截断无回滚，失败后消息列表残缺

- **位置**：`desktop/src/composables/useChat.ts:731-733`（乐观截断）、`:761`（先截断后才建连）、`:786-801`（catch 仅删空占位）
- **代码摘录**：

```ts
sessionStore.truncateMessagesAfter(sid, messageId)   // :731 乐观截断在建连之前
...
try { await connect() ... }                          // :761 失败会抛出
catch (error) {
  const lastMsg = list[list.length - 1]
  if (lastMsg?.role === 'assistant' && !lastMsg.content ...) list.pop()   // 只删空占位
  ...sessionStore.fetchSession(sessionId.value)      // 只 upsert 会话实体，不回填消息
}
```

- **触发路径**：WS 断开状态下用户「编辑并重发」→ 截断已执行 → `connect()` reject（initialConnect 分支）→ catch 只 pop 空占位并 fetchSession。
- **影响**：被编辑消息之后的所有消息从 UI 永久消失（服务端完好），直到刷新页面；期间用户基于残缺列表继续操作。
- **建议修复**：乐观截断延迟到 `connect()` 成功后；或失败分支用快照整体回滚消息列表。

### M-11【中·前端】WS 首次连接失败后不排自动重连，推送静默失效

- **位置**：`desktop/src/composables/useStreamWS.ts:232-248`
- **代码摘录**：

```ts
ws!.onclose = (event) => {
  if (initialConnect && !isReconnecting) {
    initialConnect = false
    connectPromise = null
    reject(new Error('WebSocket connection failed'))   // 不调 scheduleReconnect
  } else if (!intentionalClose) { ... scheduleReconnect() }
}
```

- **触发路径**：应用启动后首次 `connect()` 恰逢后端暂不可用 → reject 且不进入重连循环；应用启动无兜底建连，`useForegroundRecovery` 对"从未连成功"也跳过。
- **影响**：后端恢复后服务端所有主动推送（会话状态、后台完成、未读、Side Task 事件）静默丢失，仅当下次主动发消息才重建连接。与"连过再断"（有自动重连）行为不一致。
- **建议修复**：首连失败的 onclose 分支同样 `scheduleReconnect()`（connectPromise 已置空，安全）；仅未登录时放弃。

### M-12【中·CLI】REPL TTY 问答题数字前缀解析吞掉自定义文本/误选选项

- **位置**：`agent-cli/src/repl/repl.ts:352-361`
- **代码摘录**：

```ts
const nums = raw.split(/[,，\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
if (nums.length > 0) { ... selectedLabels.push(opt.label) ... }
if (selectedLabels.length === 0 && raw) customInput = raw;
```

- **触发路径**：用户想"选 1 并补充说明"输入 `1 补充说明文字` → `Number("补充说明文字")=NaN` 被 filter → `nums=[1]` → 说明文本被静默丢弃；单选下输入纯数字 `2` 想自定义回答（"预计 2 天完成"）会被当成选项 2 的 label 提交，语义相反。
- **影响**：问答答案语义错误且无提示，Agent 拿到残缺/错误答案继续执行。
- **建议修复**：仅当 raw 完全解析为合法序号（每段都是 1..options.length 整数）才走序号分支，否则整段作 customInput。

### M-13【中·引擎】快速命令标记替换写回 context.messages，多轮 buildRequest 逐层展开导致同一消息上下文漂移

- **位置**：`backend-ts/src/harness/core/prompt-engine.ts:82-120`（`replaceQuickCommandMarkers`），调用点 `:62`
- **代码摘录**：

```ts
replaced = replaced.slice(0, m.index) + command.content + replaced.slice(m.index + m[0].length);
...
messages[i] = { role: 'user', content: replaced };   // ← 展开结果写回 context.messages
```

- **触发路径**：命令内容嵌套引用其他标记（如 `deploy` 内容含 `#{check}#`）→ 轮 1 展开并把结果写回 messages → 轮 2（mid-loop compaction / preparedRequest 重建等每轮 buildRequest）把上轮展开产生的标记再次展开 → 同一执行内逐层展开。
- **影响**：同一条用户消息在同一次执行的不同 LLM 请求中内容不同，漂移程度取决于执行轮数、不可复现；与崩溃恢复后从 DB 原始内容单遍展开的首轮内容不一致。
- **建议修复**：替换基于消息原始内容副本，不写回 `context.messages`，保证 buildRequest 幂等。

---

## 三、低严重度（16）

### L-1【低·飞书】`claimNextQueued` 的 CAS 失败被当作"队列已空"，与卡片取消竞态时后续排队消息停止消费

- **位置**：`backend-ts/src/feishu/inbound-queue.repository.ts:56-66`、`agent-inbound-handler.ts:185-186`
- **触发路径**：drainNext SELECT 队头得到 B → 用户几乎同时点 B「取消」→ CAS（QUEUED→CANCELLED）先落库 → drainNext 的 UPDATE 影响 0 行返回 null → 本轮接力终止 → C 仍 QUEUED 却无消费触发点，滞留到下一条新消息。
- **建议修复**：CAS 失败时循环重取下一条 QUEUED，区分"队列空"与"该行 CAS 失败"。

### L-2【低·调度】`executeTask` 的 catch 无条件 `finishExecution(FAILED)`：忙时入队失败会把同会话正在运行的其它执行误标为 FAILED

- **位置**：`backend-ts/src/schedule/scheduled-task.service.ts:236-238、268-274`
- **触发路径**：任务触发时会话被交互式任务占用（busy）→ `enqueue` 因瞬时 DB 错误抛出 → catch 无条件 `finishExecution(sessionId,'FAILED')` → 正在运行的交互式执行被改写 FAILED、WS 推送失败状态、可能误发 webhook 通知，通道 busy 判定失真。
- **建议修复**：仅当本次确实进入执行阶段才 `finishExecution`；busy 入队失败单独 `markTaskResult('FAILED')`。

### L-3【低·飞书】群聊溢出摘要的截断口径与"已摘要"记账口径不一致，最旧溢出消息被静默排除却按全覆盖推进水位

- **位置**：`backend-ts/src/feishu/message.service.ts:100-125、172-197`
- **触发路径**：溢出消息渲染超 16000 字符（100 条很容易超）→ `renderOverflowRecord` 丢弃最旧行 → 摘要只基于剩余行生成 → `contextSummaryLogId` 却记到全部溢出行最大 id → 最旧消息从此既不增量注入也不进溢出查询，永久丢失于上下文。
- **建议修复**：以实际保留的最大 id 记账，或动态化 `maxTotalChars` 并与 `overflowWindow` 相互约束。

### L-4【低·安全】微信绑定接口不校验 `baseUrl`，服务端以用户提供的任意 URL 发起周期请求（盲 SSRF 面）

- **位置**：`backend-ts/src/weixin/qr-login.service.ts:104-133`
- **触发路径**：任意已登录用户 `POST /v1/weixin/binding/confirm` 传 `baseUrl=http://169.254.169.254/...` → 保存成功 → monitorLoop 周期性向该地址发起带 Authorization 头的 POST。
- **建议修复**：https + 域名白名单（或禁止私网/环回/链路本地地址），token 非空校验；与 `WebhookUrlValidator` 做法一致。

### L-5【低·微信】`qrcodeSessionMap` 永不清理 + `getQrcodeStatus` 网络错误吞成 `wait` 导致无限轮询

- **位置**：`backend-ts/src/weixin/qr-login.service.ts:55、88-101`
- **触发路径**：每次 GET /v1/weixin/qrcode 写入一条，仅 confirm 成功才删除；放弃扫码/刷新/过期均泄漏。ilink 持续 5xx 时前端无限轮询且无错误提示。
- **建议修复**：sessionKey 加过期惰性淘汰；连续非超时错误上抛或返回明确 error 状态。

### L-6【低·LLM】`json.ts parseUsage` 缺 `total_tokens` 记 0，与 Responses 侧兜底口径不一致

- **位置**：`backend-ts/src/harness/llm/json.ts`（parseUsage）
- **影响**：部分网关只回 prompt/completion 时 total 记 0，用量统计口径分裂。
- **建议修复**：与 Responses 侧一致做 `prompt+completion` 兜底。

### L-7【低·LLM】非流式 `chat()` 不解析 200 响应体内嵌 `error`，被误判为空响应空转重试

- **位置**：`backend-ts/src/harness/llm/`（各适配器非流式分支）
- **触发路径**：网关返回 200 + body 内 `{error:{...}}` → 被当空响应，触发空响应指数退避重试 10 次，报错原因被掩盖。
- **建议修复**：非流式分支解析 body 内嵌 error 并直接抛业务错误。

### L-8【低·引擎】skill_sync_done 无轮次标识，迟到信号可错误放行新一轮技能同步

- **位置**：`backend-ts/src/session/ws/`（技能同步等待逻辑）；MCP 侧已修，技能侧未对齐
- **建议修复**：与 MCP 侧一致加轮次/序号标识。

### L-9【低·CLI】HTTP MCP 传输不遵循 Streamable HTTP 会话协商，连接规范服务器必失败

- **位置**：`agent-cli/src/local/tools/mcp.ts:137-166`
- **代码摘录**：

```ts
const res = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json',
  accept: 'application/json, text/event-stream' }, body: ... initialize ... });
const list = await fetch(server.url, {
  method: 'POST', headers: { 'content-type': 'application/json' },   // ① 无 accept；② 丢弃 Mcp-Session-Id
  body: ... tools/list ... });
```

- **触发路径**：规范实现的服务器在 initialize 响应头返回 `Mcp-Session-Id` 并校验后续请求 → tools/list 未携带该头且缺 Accept → 400/404 → HTTP 型 MCP 全部连接失败（STDIO 不受影响）。
- **建议修复**：回传 `res.headers.get('mcp-session-id')`；两个 POST 统一 Accept 头。

### L-10【低·工具】`buildUnifiedPatch` 纯插入场景丢失一条共享上下文行，且 hunk 头行数与实际输出不一致

- **位置**：`backend-ts/src/harness/tool/file-change-diff-util.ts:118-119、139、145-147`
- **触发路径**：编辑 >512KB 文件（PATCH 模式）且为纯插入 → 尾部匹配循环使新旧尾指针错开 → `sharedTailStart` 取 max 后按旧序号切片，恰好一条未变更共享行被丢弃；hunk 头 oldCount/newCount 大于实际输出行数。
- **影响**：持久化的 patch_content 缺行、头计数错误，严格 diff 解析器错位渲染。
- **建议修复**：尾部上下文统一按旧序号输出，count 按实际输出行数累计。

### L-11【低·工具】`write_file` 的 `bytes_written` 返回字符数而非字节数

- **位置**：`backend-ts/src/harness/tool/impl/write-file-tool.ts:60`
- **代码摘录**：`bytes_written: content.length,`（UTF-16 码元数，非磁盘字节数；同族 `size_bytes` 用 `Buffer.length` 口径不一）
- **建议修复**：改 `Buffer.byteLength(content, 'utf8')`。

### L-12【低·工具】glob JS 回退的 `**` 不支持零段匹配，与 rg 语义分叉导致漏文件

- **位置**：`backend-ts/src/harness/tool/impl/glob-search-tool.ts:130-137`
- **代码摘录**：

```ts
.replace(/\*\*/g, '::DS::')...
.replace(/::DS::/g, '.*');   // src/**/x → src/.*/x，要求再出现一个 '/'
```

- **触发路径**：rg 不可用走 JS 回退时 `src/**/*.ts` 无法匹配 `src/foo.ts`，rg 路径可以 → 降级环境工具结果静默漏报。
- **建议修复**：`**/` 翻译为 `(?:.*/)?`；补双端一致性用例。

### L-13【低·委派】`interruptRunningForCorrection` 的 check-then-act 窗口：正常完成的执行被改写为 CANCELLED，且遗留 cancel flag

- **位置**：`backend-ts/src/harness/delegate/background-subagent-manager.ts:401-423`
- **触发路径**：后台子代理收尾时并发 `subagent_followup` 纠偏 → findRunning 读到 RUNNING → 结果被 SUPPRESSED 吞掉或已 DELIVERED → settled 后 `:416` 无条件把 COMPLETED 记录改写为 CANCELLED（result 覆写为"因纠偏中断"），执行历史与已落库完成通知矛盾；同时新注册 set(true) 的 cancel flag 无人清理。
- **建议修复**：`:416` 改写加状态条件（仅 RUNNING/RECOVERING 可置 CANCELLED），或 settled 后重读 status 再决定。

### L-14【低·前端】会话删除/登出未清理流式与瞬时状态 Map

- **位置**：`desktop/src/stores/session.ts:238、1013-1022、1594-1631`
- **触发路径**：deleteSession 清理清单缺 11 个运行态 Map（sessionPhases/sessionStreaming/sessionThinking/.../delegateToolCallBindings），迟到 WS 事件可把已删 sid 条目写回；reset() 未清 `streamingAssistantMessageIds`（普通 Map），跨登录周期驻留。
- **影响**：无功能性错误（会话 ID 不复用），主要是内存驻留与"幽灵"状态。
- **建议修复**：抽 `clearSessionRuntimeState(sid)` 供 delete/reset 复用并补齐清单。

### L-15【低·前端】CJK 内容下 markdown 重绘回退行数按码点数计算，旧文本残留

- **位置**：`agent-cli/src/util/ansi.ts:69-78`、`agent-cli/src/render/repl-renderer.ts:331-333`
- **触发路径**：TTY 下流式输出较长中文 markdown → `countVisualRows` 按 code point 估宽（CJK 按 1 列），实际按 2 列 wrap → 回退行数低估 → 终端残留旧文字与重绘内容拼接错乱。
- **建议修复**：改用 `ui/width.ts` 的 `displayWidth` 计算行宽。

### L-16【低·引擎】shell exec 超时未完成被摘要为 `(exit -1)`，与 write_stdin 分支的 `(未完成/超时)` 文案不一致

- **位置**：`backend-ts/src/session/util/tool-result-summarizer.ts:151-173`
- **触发路径**：shell exec 超时 → `resolveExitCode` 返回 -1 → 摘要显示"执行 xxx (exit -1)"，模型/用户误以为真实退出码 -1（信号语义），write_stdin 同场景却显示"(未完成/超时)"。
- **建议修复**：exec 分支同样在 `completed===false` 时返回"(未完成/超时)"。

---

## 四、已排查确认无问题（避免后续重复排查）

- **compaction 链路**：`session-compaction.mapper.ts` CAS 占位符对位一致；`compaction-service.ts` streamError 已修、事件配对完整；`session-compaction-orchestrator.ts` 分支与 anchor 时序正确；`active-context-calculator.ts` fallback 正确。
- **调度队列**：cron 时区统一 Asia/Shanghai；inFlight + nextFireTime 先行落库已消除重复触发；`claimNextQueued` CAS 本身、飞书事件去重键、进度卡片 flush/PATCH/终态清理、通知 `eventKey` 幂等与退避重试均正确。
- **飞书/微信**：`is_at_me`、引用注入位置、`describeMessageText` 单一实现、thumb_media AES key 回退、语音临时目录清理均无问题。
- **工具**：read-file offset/limit 边界与双端 clamp 正确；edit-file-match 唯一匹配与 replace_all 计数（含重叠边界）正确；computeLineDelta 各分支经推算正确；OutputManager 持久化水位与互斥正确；subagent-invocation `FOR UPDATE` 抢占、claimRecovering 互斥、updateTerminal 条件写正确；path-sandbox/cloud-workspace-resolver 白名单可阻断穿越。
- **前端**：CLI 跨轮文本累积不成立（onMessageEnd 循环外单次）；desktop message_end 双气泡不成立（useMessageRounds 合并）；quick-command-parser 的 slice(15) 正确；`local/truncate.ts` 由 serializePayload 二次截断自愈。
- **历史修复复核**：上轮报告的 N-1（clearedSecrets watch 写反）、N-2（OSS sts 测试合并）等修复有效，未发现回归。

## 五、修复优先级建议

1. **立即修**（数据破坏/安全）：H-1（任意路径写入/删除）、H-2（部署窗口双跑）、M-5（用户配置静默回滚）、M-1（SSE 渠道不可用）。
2. **发版前修**（用户可见故障）：H-3、M-2、M-3、M-4、M-6、M-7、M-8、M-10、M-11、M-12。
3. **排期修**：其余中低项，优先 M-9、M-13 与低项中影响统计口径的 L-3、L-6、L-10、L-11。
