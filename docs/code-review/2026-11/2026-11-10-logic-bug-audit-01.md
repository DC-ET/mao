# 逻辑 bug 审计 · 全域扫描（2026-11-10）

- 方法：并行派 5 个只读审计代理分别深查 schedule/openapi、harness core、file/path-sandbox、desktop 纯逻辑、usage/budget 域（其中 2 个因并发限流未完成，其余 3 个共产出 11 个候选）；随后**每条候选写成编码「正确契约」的复现测试，在当前代码上真实失败才算确认**。临时验证 spec（backend 4 例 + desktop 3 例）运行后已删除，仓库仅新增本报告。
- **复核记录（2026-11-10，第二双眼睛）**：对 7 条确认项逐条重建复现测试并在当前代码上重跑（backend-ts 8 例、desktop 4 例，含 3 个对照用例；临时 spec 运行后已删除）。**7 条全部真实失败，失败输出与断言机理均与报告一致，移除 0 条**；3 个对照用例（Bug 1 的 CANCELLED 结算对照、Bug 3 的 decrypt 正常对照、Bug 4 的入队路径机理佐证）全部通过，排除了「测试自身写错导致假失败」与「走了别的分支凑巧失败」两类误报。复核修正：Bug 1 错误分支行号精确为 1156-1159；Bug 2 改用全流程复现取得更完整证据；**Bug 3 降级 高→中**（触发面收窄，见该节复核注）；**Bug 5 降级 中→低**（桌面发送链路发送前 trim、复制路径自带 trim，实际影响面显著小于原判断，见该节复核注）。移除记录见文末。
- 结论：**确认 7 个逻辑 bug**（4 后端 + 3 desktop），全部有失败输出实证；其中 2 个经复核降级（Bug 3 高→中、Bug 5 中→低）。另有 4 条候选经审计复核否决（见文末）。
- 回归基线：审计期间 `backend-ts npm test`（469 文件 / 5826 用例）、desktop `npm run test:unit`（1885）、两端 build 全绿——以下 bug 全部位于既有测试的盲区。

## 确认清单

| # | 位置 | 严重度 | 一句话 |
|---|---|---|---|
| 1 | `backend-ts/src/schedule/scheduled-task.service.ts:1156-1159` | 高 | 一次性任务排队结算丢失用户改档：新档期永久丢失、任务被误标完结 |
| 2 | `backend-ts/src/harness/core/agent-loop.ts:887-896` | 高 | 流式 tool_call 合并：真实 id 首片不带 index 时拆成两条调用，用户命令实际从未执行 |
| 3 | `backend-ts/src/openapi/outbound-delivery.scheduler.ts:96-130` | 中（复核降级） | 抛出型投递失败（如 secret 解密持续抛错）永不终态、无界重试，违反「3 次重试后 FAILED」契约 |
| 4 | `backend-ts/src/openapi/open-run.service.ts:107,185` | 中 | 32000 字闸门以「字」计，忙会话入队落 `message_queue.content TEXT`（65535 字节）超限 500 |
| 5 | `desktop/src/utils/imageUrlAnnotation.ts:21-22` | 低（复核降级） | 尾随空行裁剪打破函数自己声明的「恒等」保证：非桌面来源的消息在编辑回填/重发中被静默裁掉尾随空行 |
| 6 | `desktop/src/utils/archive-entries.ts:105-112` | 中 | 分类以 `dot > 0` 取扩展名，`.gitignore`/`.editorconfig`/`Dockerfile`/`Makefile` 落入下载分支无法文本预览（集合成员意图不可达） |
| 7 | `desktop/src/utils/toolDisplay.ts`（多处 `slice(0, N)`） | 低 | 预览截断按 UTF-16 码元切，emoji 落在边界产出孤立代理项（半个字符） |

---

## Bug 1（高）：一次性任务排队结算丢失用户改档

- **位置**：`backend-ts/src/schedule/scheduled-task.service.ts:1156-1159`（`settleQueuedExecution` 的 COMPLETED / FAILED-无重试分支；整个 once 分支为 1148-1165）
- **触发条件**：once=1 固定日期任务触发时会话忙 → 消息入队（`nextFireTime` 置 null，设计如此）→ 用户在排队等待期间 `updateTask` 把 cron 换成另一个一次性日期 → 队列消息消费完成（COMPLETED，或 FAILED 且重试耗尽）。
- **错误行为 vs 声明契约**：`updateTask`（:455-457 注释）明确声明「只要仍是『有未结算工作的一次性任务』，下一档就保持为空……**新档期由旧档期的收尾链按最新 cron 重排**」；直跑/重试收尾链（:802-817）确实兑现——专门有「执行/重试期间用户改过档期：新档期是用户的明确意图，不能被旧档期的收尾抹掉」分支。但**队列结算分支无条件 `finished=1, nextFireTime=null`**，不看 cron 是否被改过：新计划永不触发、任务被误标 finished。同函数 CANCELLED 分支反而按最新 cron 重排，佐证这是遗漏。
- **验证**（`scheduled-task-reliability.spec.ts` 的 MemoryStore/serviceFor 脚手架）：入队 QUEUED → `updateTask(1, 7, null, null, '0 0 8 21 2 *')` → `settleQueuedExecution(1, 'COMPLETED')`，断言「新档期重排」：

  ```ts
  await svc.settleQueuedExecution(1, 'COMPLETED');
  const task = await store.selectById(1);
  expect(task?.nextFireTime).not.toBeNull(); // 新档期由收尾链按最新 cron 重排
  expect(task?.finished).toBe(0);            // 不是「误标完结」
  ```

  实际失败输出：`AssertionError: expected null not to be null`（且 `finished` 为 1）。对照用例：同场景结算 `CANCELLED` 会重排（既定行为），COMPLETED/FAILED 分支漏了同一处理。
- **复核（第二双眼睛）**：按同脚手架重建复现，主用例在完全相同断言上失败（`expected null not to be null`），CANCELLED 对照用例通过——失败原因与报告机理一致（settle 分支无条件收口，而非别的分支凑巧失败）。触发路径已核实：队列消费收尾确实走 `app-ws-handler.ts` 的 `onScheduledTaskQueueConsumed → settleQueuedExecution`，与直跑收尾链是两条路径；`updateTask` 在 `pendingOnceWork` 时确实只存新 cron、不排档。
- **为什么既有测试没抓住**：reliability.spec 测了「待重试时改 cron」「重试运行中改 cron」两个直跑场景，service.spec 测了 settle 的基础收口，没有用例把「入队 → 改 cron → settle」两半契约拼在一起。
- **修复方向**：settle 的 COMPLETED / FAILED-无重试分支复用直跑收尾的 `latestCron !== cronUsedForAdvance` 重排判断（结算时 cronUsedForAdvance 取自结算的 run.fireTime 对应档期；或对比结算快照的 cron 与当前行 cron）。

## Bug 2（高）：流式 tool_call 合并——真实 id 首片不带 index 时拆成两条调用

- **位置**：`backend-ts/src/harness/core/agent-loop.ts:887-896`（`findMergeTarget` 的 `delta.id` 分支），契约注释 :851-853
- **触发条件**：首片 tool_call 分片**无 id、带 index**（代码合成占位 id 并记入 `provisionalIds`），随后某分片**带回真实 id 但不带 `index` 字段**——`{id:'call-real', function:{arguments:…}}`。这正是 :851-853 注释点名要防的形态（「否则只带 id、不带 index 的参数分片对不上，命令会被截断并拆成第二条调用」）。
- **错误行为**：`findMergeTarget` 在 `delta.id` 分支里 byId 落空（占位 id ≠ call-real）后，仅当 `delta.index != null` 才按 index 回查；id 无 index 直接 `return undefined` → push 分支当成第二条新调用。结果：占位调用持有被截断的参数且真实 id 未写回，新调用只有参数尾巴且 `function.name` 为 undefined；两条都进 `pendingToolCalls`（第一条以截断参数+占位 id 派发，真实网关上 JSON 解析必败；第二条在工具集校验即被拒），用户命令实际从未执行，且合成占位 id 落库。
- **验证**（直接驱动 `AgentLoop.prototype.mergeToolCall`，方法体不依赖构造状态）：

  ```ts
  loop.mergeToolCall(existing, { index: 0, function: { name: 'shell', arguments: '{"command":' } }, listener, emitted, provisionalIds);
  loop.mergeToolCall(existing, { id: 'call-real', function: { arguments: '"pwd"}' } }, listener, emitted, provisionalIds);
  expect(existing).toHaveLength(1);                                  // 整条只派发一次
  expect(existing[0]!.id).toBe('call-real');                         // 真实 id 写回
  expect(existing[0]!.function?.arguments).toBe('{"command":"pwd"}'); // 参数完整
  ```

  实际失败输出：`AssertionError: expected [ { index: +0, …(2) }, …(1) ] to have a length of 1 but got 2`。
- **复核（第二双眼睛）**：改用**完整 AgentLoop.execute 流式链路**复现（复刻 `agent-loop.spec.ts:644` 用例、唯一差别是真实 id 分片去掉 index）：`AssertionError: expected [ { index: +0, …(3) }, …(1) ] to have a length of 1 but got 2`，且 `dispatchInvocation` 收到的实参为 `argumentsJson: '{"command":'`（截断）、`callId: 'call-<uuid>'`（合成占位）——「拆两条 + 命令从未执行 + 占位 id 落库」全链条实证，与报告机理一致。无 index 的 id 分片与首片无 id 分片均为代码注释自认的真实网关形态（:851-853、:864-874），组合触发面成立。
- **为什么既有测试没抓住**：`agent-loop.spec.ts:644`「merges a late id-bearing delta」里带回 id 的分片始终带 `index: 0`（走 byIndex 归并）；:686 的「id-only 分片」用例里真实 id 早已由前一片（id+index）写回，byId 能命中。唯独「首个带 id 的分片不带 index 且占位尚未写回」无覆盖。
- **修复方向**：`findMergeTarget` 的 `delta.id` 分支在 byId/byIndex 均落空、且 existing 中恰有一条 provisional 占位调用时归并到该占位（或 push 前按 index 前缀匹配）。

## Bug 3（中，复核降级）：出站投递抛出型失败永不终态、无界重试

- **位置**：`backend-ts/src/openapi/outbound-delivery.scheduler.ts:96-130`（`deliver` 的整体 try/catch 只 `console.error`），关联 `openapi.repository.ts:300-305`（`recoverInterrupted` 复位 SENDING→PENDING 不推进 `attempt_count`）
- **触发条件**：`deliver()` 在拿到 `OutboundSendResult` 之前**持续**抛异常——最现实的是 `:112` `cipher.decrypt` 持续抛（订阅 secret 加密密钥轮换后未重加密；`decryptAesGcm` 失败即 throw 已核实）。瞬时异常（如一次 DB 抖动）会被恢复器自愈，不构成触发。
- **错误行为 vs 声明契约**：文件头（:8）声明「重试退避 1/5/25，共 3 次重试后终态 FAILED」。实际：decrypt 抛出 → 整个 catch 只打日志，行停在 SENDING → 恢复器把它复位回 PENDING（attempt_count 不变）→ 重新认领 → 再抛……恢复器节流为每分钟一次（首轮恢复还需等 `created_at` 过 5 分钟卡死线），此后以约 60 秒为周期**无限循环**，既到不了终态 FAILED、`attempt_count` 恒 0、502 审计（`recordFailedAudit` 只在 markFailed 路径，装配层 `app-lifecycle.ts` 落 `status: 502` 审计）也永不触发。
- **验证**（Fake 仓库复刻 SQL 语义：claim= PENDING→SENDING、recoverInterrupted= SENDING→PENDING 不动 attempt）：

  ```ts
  for (let tick = 0; tick < 6; tick += 1) {   // 6 轮 × 每轮 2 次扫描
    await scheduler.dispatchDueDeliveries();
    await new Promise((r) => setTimeout(r, 5));
    await scheduler.dispatchDueDeliveries();
  }
  expect(markFailed).toHaveBeenCalled();      // 3 次尝试后必须终态 FAILED
  expect(status).toBe('FAILED');
  ```

  实际失败输出：`AssertionError: expected "spy" to be called at least once`——12 次调度后 `markFailed`/`scheduleRetry`/`markSucceeded` 一次都没被调用。
- **复核（第二双眼睛）**：重建复现并补两组对照以排除假失败：(1) 同一 fake 接线下 decrypt 正常、sender 返回可重试失败 → `scheduleRetry`/`markFailed` 正常可达、终态 FAILED（对照通过，证明 fake 接线无误、失败确由「result 之前抛出」分支导致）；(2) decrypt 持续抛出时统计 claim 次数 = 6（每轮被复位回 PENDING 重新认领，`attempt_count` 恒 0、状态回到 PENDING），无界循环实证。**降级 高→中 的理由**：触发需要持久性抛出（现实来源仅密钥轮换一类，且解密失败时投递本就不可能成功），bug 的边际危害是「无界循环 + 永无终态/审计」的可观测性损失与契约违背，无数据错乱，重新录入 secret 即自愈。另注：同构的 `notification/task/delivery.scheduler.ts` 存在相同的「catch 只打日志 + 恢复不推进 attempt」形态，修复时不应以「对齐现状」为由搁置，两处宜同改。
- **为什么既有测试没抓住**：sender 是注入的 Fake 只返回 `OutboundSendResult` 永不 throw，「result 之前抛出」分支无覆盖；恢复器测试也不校验 attempt_count。
- **修复方向**：`deliver` 的 catch 内按 attempt+1 走与 result 失败相同的收口（`retryIndex < 3 ? scheduleRetry : markFailed + audit`）；`recoverInterrupted` 对超期 SENDING 行顺带把 `attempt_count = attempt_count + 1`。

## Bug 4（中）：开放触发 32000 字闸门与队列列宽（TEXT 65535 字节）契约不匹配

- **位置**：`backend-ts/src/openapi/open-run.service.ts:107`（校验「message 需为 1~32000 字」）与 :185（忙会话路径把原消息 `enqueue` 进 `message_queue`）；`db/migration/V032__add_message_queue.sql:5`（`content TEXT NOT NULL`，V108/V133/V145 均未扩容）；`message-queue.repository.ts` 的 insert 为裸参数化 INSERT、无截断。
- **触发条件**：API Token / Webhook / 定时重放向**正在执行（busy）的绑定会话**投递 21846~32000 个 CJK 字符的消息（utf8mb4 每字 3 字节 ≈ 65538~96000 字节 > TEXT 上限 65535）。同一条消息：会话空闲时直跑落 `message.content MEDIUMTEXT`（16MB）成功；会话忙时 `enqueue` 在 MySQL 8 默认 strict 模式抛 `Data too long for column 'content'` → 非业务异常冒泡 → 调用方 500、流水记 rejected。成败随会话忙闲分裂。
- **验证**（契约证明测试——校验上限必须以字节口径装进队列列）：

  ```ts
  expect(OPEN_RUN_MESSAGE_MAX_LENGTH).toBe(32000);
  const bytes = Buffer.byteLength('汉'.repeat(OPEN_RUN_MESSAGE_MAX_LENGTH), 'utf8');
  expect(bytes).toBeLessThanOrEqual(65535); // 所有合法消息必须装得进 message_queue.content
  ```

  实际失败输出：`AssertionError: expected 96000 to be less than or equal to 65535`。
- **复核（第二双眼睛）**：字节算术单测同断言失败（96000 > 65535）；另补忙会话路径的机理佐证（fake deps，`isSessionBusy=true`）：`svc.run` 走 enqueue 分支且 `enqueue` 收到的 content 为完整 96000 字节原文、无任何截断——结合 `message-queue.repository.ts` 裸参数化 INSERT 与 V032 `content TEXT`，strict 模式 500 是确定性结论。该佐证用例通过（它证明的是「入队不截断」这一机理，而非 bug 不存在；bug 的失败断言是上面的字节契约）。
- **为什么既有测试没抓住**：单测用短消息 + 内存 fake（不模拟列宽），无用例触及队列列的字节上限。
- **修复方向**：三选一（按字节口径收紧校验为 `Buffer.byteLength ≤ 65535`、或列改 MEDIUMTEXT 迁移、或入队前按字节截断）——任一都消除「同输入随忙闲成败分裂」。

## Bug 5（低，复核降级）：`stripImageUrlLines` 的尾随空行裁剪打破自声明的「恒等」保证

- **位置**：`desktop/src/utils/imageUrlAnnotation.ts:21-22`（`.replace(/[\r\n]+$/, '')` 无条件裁尾）
- **触发条件**：任意**不含注入行**但以换行结尾的文本，如 `"正文\n\n"`。
- **错误行为 vs 声明契约**：函数注释（:19）写明「对不含注入行的内容是恒等操作（`replace` 无匹配即原样返回），纯文本消息零影响」。实测 `stripImageUrlLines('正文\n\n')` 返回 `'正文'`。同一恒等声明还复制在 `stores/session/messages.ts:704`（乐观回显比对，两侧同裁故配对不受影响）；`useStreamWS.ts:1076` 的比对同样两侧同裁不受影响。**受影响的是展示面**：`userVisibleText` 消费于气泡、编辑框回填（`MessageBubble.vue:397/409`）、引用（`selection-quote.ts:163`）。
- **验证**：

  ```ts
  expect(stripImageUrlLines('正文\n\n')).toBe('正文\n\n')   // 实际 '正文'
  expect(userVisibleText('第一行\n\n')).toBe('第一行\n\n')   // 实际 '第一行'
  ```

  实际失败输出：`AssertionError: expected '正文' to be '正文\n\n'`。
- **复核（第二双眼睛）**：重建复现同断言失败，存在性无疑。**降级 中→低 的理由（触发面经核实显著收窄）**：(1) 桌面发送链路发送前已 trim（`ChatInput.vue:1195-1196`），桌面来源消息不可能以换行结尾；(2) 复制路径 `copyMessage` 走 `displayText` 且自带 `.trim()`（`MessageBubble.vue:850-854`），尾随空行本就不保留，不构成额外损失；(3) 剩余实际影响为**非桌面来源（API/Webhook/定时）且以空行结尾的消息，编辑重发回填时尾随空行被静默裁掉**——纯空白改写、无语义损失；(4) 后端同款实现（`backend-ts/src/session/util/image-url-annotation.ts`，逐字节一致）对裁尾行为无恒等声明，故「注释错 vs 功能错」存在二义，最小修复也可能只是修正注释。保留原因：行为与两处文档注释矛盾是实打实的，验证成本为零的修复值得做。
- **为什么既有测试没抓住**：`imageUrlAnnotation.test.ts` 有标题就叫 "is the identity for content without injected lines" 的用例，但所有样例都不带尾随换行。
- **修复方向**：恒等承诺只在「有注入行被剥离」时才收敛尾空行——`return stripped === text ? text : stripped.replace(/[\r\n]+$/, '')`；或修正注释并接受改写语义（二选一，当前代码与注释必有一错）。

## Bug 6（中）：压缩包点文件分类不可达——`.gitignore` 等无法文本预览

- **位置**：`desktop/src/utils/archive-entries.ts:105-112`（`dot > 0` 才取扩展名）与 :95-103（`TEXT_EXTENSIONS` 含 `'gitignore'/'gitattributes'/'editorconfig'/'dockerfile'/'makefile'`）
- **触发条件**：zip 内预览 `.gitignore`（`lastIndexOf('.') === 0`）、`.editorconfig` 或无扩展名的 `Dockerfile`/`Makefile`。
- **错误行为 vs 集合成员意图**：ext 取空串 → 返回 `'other'` → 只能整包下载；而把这些名字放进「常见文本格式」集合的唯一合理解释就是让对应文件进 `<pre>` 预览——`'gitignore'/'gitattributes'/'editorconfig'` 作为扩展名**没有任何真实文件名能命中**（只有 `x.gitignore` 这种不存在的命名）。旁证：`file-preview-format.ts:21-27` 同样的点文件规则但注释明说「点文件返回空」且集合里没有这些成员——archive-entries 是两处口径没对齐的疏漏。
- **验证**：

  ```ts
  expect(classifyArchiveEntry('.gitignore')).toBe('text')    // 实际 'other'
  expect(classifyArchiveEntry('.editorconfig')).toBe('text') // 实际 'other'
  expect(classifyArchiveEntry('Dockerfile')).toBe('text')    // 实际 'other'
  expect(classifyArchiveEntry('Makefile')).toBe('text')      // 实际 'other'
  ```

  实际失败输出：`AssertionError: expected 'other' to be 'text'`（tsx 探针同样复现）。
- **复核（第二双眼睛）**：重建复现四例同失败（`expected 'other' to be 'text'`），与 `archive-entries.test.ts` 既有用例（`Makefile.old`/`noext`/`archive.zip` → other）交叉确认分类语义无误、失败确由点文件规则导致。集合成员意图证据成立，修复方向唯一且零风险（点文件/无扩展名按整名小写匹配集合）。浏览代码类 zip 时 `.gitignore`/`Dockerfile` 是高频条目，保持 中。
- **为什么既有测试没抓住**：`archive-entries.test.ts:144-147` 只测 `Makefile.old`、`noext`、`archive.zip`，没测点文件。
- **修复方向**：分类前对 dot-file / 无扩展名文件按 `name.toLowerCase()` 整名匹配集合（`'.gitignore'` 等），或集合键改为整名与扩展名双口径。

## Bug 7（低）：预览截断按 UTF-16 码元切，emoji 落在边界产出孤立代理项

- **位置**：`desktop/src/utils/toolDisplay.ts`（`getToolInputPreview` 的多处 `text.slice(0, 20/30/60)`；`create_scheduled_task`/`create_signal_watcher` 的 `slice(0, 30)`、`generate_image` 的 `slice(0, 60)` 等）、同族 `backgroundNotice.ts:36`（`slice(0, 120)`）
- **触发条件**：命令/提示词中 emoji（任何 BMP 外字符）恰好横跨截断边界。实证：`prompt = 'x'.repeat(59) + '😀' + 'y'.repeat(10)` → `getToolInputPreview('generate_image', { prompt })` 返回 `'xxx…\ud83d...'`（第 60 码元是 😀 的高位代理，低位被切走）。
- **错误行为 vs 意图**：截断本意是「超出 N 字加省略号」，实际在边界渲染出孤立代理（U+FFFD 或空白字符），工具卡参数摘要、通知摘要在中文+emoji 环境可实际触发。
- **验证**：

  ```ts
  const preview = getToolInputPreview('generate_image', { prompt });
  expect(!/[\uD800-\uDBFF]$/.test(preview.replace(/\.{3}$/, ''))).toBe(true); // 不得以孤立高位代理收尾
  ```

  实际失败输出：`AssertionError: expected false to be true`；tsx 探针输出字面量 `'xxx…\ud83d...'`。
- **复核（第二双眼睛）**：重建复现同断言失败；`backgroundNotice.ts:36` 截断点核实存在（`NOTICE_EXCERPT_CHARS = 120`，前置的 `\s+` 归一不移除非 BMP 字符，emoji 边界同样可切）。影响限于展示观感、无数据错乱，维持 低；但中文+emoji 环境真实可触发，修复（统一码点安全截断）成本低、无契约风险，值得顺手做。
- **为什么既有测试没抓住**：toolDisplay 相关测试全部使用 ASCII 样例。
- **修复方向**：统一一个 `truncateByCodePoints(text, max)`（`Array.from`/`codePointAt` 回退到码点边界）替换各处裸 `slice`。

---

## 审计过但未确认的候选（避免复看时重复提报）

1. **selection-quote 闭合围栏不容忍行尾空白**（`isClosingFence` 逐字符全等）：序列化侧不产生尾随空格，仅手工编辑/粘贴的引用会降级为普通文本，且不影响信息不丢——把握不足，不列。
2. **quick-command-parser 重叠标记不去重**：数学上三套标记（`@{…}@`/`#{…}#`/`${…}$` 的 body 均排除 `}`）的匹配区间**不可能重叠**（SKILL/COMMAND 匹配必含 `}`，FILE body 必不含 `}`），缺失的重叠检查是死防御而非 bug；代理演示的 `@{#{a}#}@` 拆分实为 FILE 模式对含 `}` 路径不匹配，不构成契约违背。否决。
3. **parseDateTime 对 date-only ISO 串按 UTC 解析**（负时区日期倒退）：全仓检索未找到 date-only 实证调用方。否决（无入口）。
4. **API Token 失败计数为固定锚点窗口而非列注释声明的「滚动 1h 窗口」**（`openapi.repository.ts:99-110` 的 IF 条件）：方向性成立（跨锚点边界的突发失败系统性低计），但该逻辑是 SQL IF 语义，单元环境无法连库复现「真实失败」，按本报告的验证门槛暂不列入；建议补 DB 级测试后再定。
5. **file/path-sandbox 与 usage/budget 两域**：审计代理因并发限流未完成，本报告不覆盖这两域（schedule/openapi/harness-core/desktop-utils 的覆盖率以本轮为准）。

## 复核移除

复核（第二双眼睛）逐条重建复现后**移除 0 条**：7 条确认项全部在当前代码上按报告机理真实失败（3 个对照用例通过，排除假失败与「凑巧失败」两类误报），未发现描述与代码不符到需要除名的条目。复核做的调整是**降级而非移除**：Bug 3 高→中（触发面收窄为持久性抛出、边际危害为可观测性损失）、Bug 5 中→低（桌面发送/复制链路均有 trim，实际影响收窄为非桌面来源消息编辑重发的空白改写），理由详见各 bug 小节的「复核」注。审计阶段否决的 4 条候选维持否决（见上节）。

## 验证产物

- 审计轮临时复现 spec：`backend-ts/src/zz-logic-bug-verify.spec.ts`（4 例全失败）、`desktop/src/utils/zz-logic-bug-verify.test.ts`（3 例全失败），取证后已删除。
- 复核轮临时验证 spec：`backend-ts/src/zz-review-verify.spec.ts`（8 例：5 例按预期失败 + 3 例对照/机理佐证通过）、`desktop/src/utils/zz-review-verify.test.ts`（4 例全失败），取证后已删除；仓库仅本报告被修改。
- 复现测试代码已逐条内嵌于上文，可直接粘回对应 spec 文件复跑。

## 修复记录（2026-11-10，复核结论执行）

7 条全部修复，复现用例转为正式回归测试入仓（下方用例数为净增）；两端 `npm run build` + 全量测试全绿。版本 0.0.495（CHANGELOG）。

| # | 修复位置 | 方案 | 回归测试 |
|---|---|---|---|
| 1 | `scheduled-task.service.ts` `settleQueuedExecution` COMPLETED/FAILED-无重试分支 | 零迁移改档判定：新增 `cronFiresAt`（croner `nextRun(fireTime-1s)` 判队列行 fireTime 是否仍是当前 cron 的触发点——队列行不快照旧 cron 时的等价判据），改档且 ACTIVE 时按最新 cron 重开档期（next 为空的防御性完结），未改档/PAUSED 保持原完结行为；与直跑收尾「latestCron !== cronUsedForAdvance」同语义 | `scheduled-task-reliability.spec.ts` +3（改档重排、FAILED-无重试改档、未改档对照） |
| 2 | `agent-loop.ts` `findMergeTarget` | `provisionalIds` 传入；byId/byIndex 都落空且恰有一条未写回真实 id 的占位调用时归并到它（多条占位时无法判定归属，保持旧行为不猜） | `agent-loop.spec.ts` +1（id 首片不带 index 的全流程派发用例） |
| 3 | `outbound-delivery.scheduler.ts` `deliver` catch | 抛出型失败与 result 失败同口径收口：按 attempt+1 走 1/5/25 分钟退避，耗尽后 `markFailed` + 审计；收口自身再抛兜底日志 | 新建 `outbound-delivery.scheduler.spec.ts` 3 例（解密抛出→退避、4 轮→终态+审计、成功对照） |
| 4 | 新迁移 `V190__message_queue_content_mediumtext.sql` | `message_queue.content` TEXT→MEDIUMTEXT，与 message.content（V001）对齐；32000 字门禁行为不变（选扩列而非收紧门禁/截断：不破坏 API 契约、不丢用户正文） | `open-run.service.spec.ts` +2（门禁不变、门禁×列宽契约钉住） |
| 5 | `desktop/src/utils/imageUrlAnnotation.ts` | 双契约拆分：`userVisibleText`（展示/编辑回填/复制）无注入行时恒等（新增无 g 标志的单行探测正则，规避 `.test()` 的 lastIndex 残留）；`stripImageUrlLines`（回声去重比对）保持恒收敛——服务端有图时剥行+收敛落库/广播，乐观侧收敛，两边各自收敛才能判等 | `imageUrlAnnotation.test.ts` +4（恒等、含注入行仍剥、无状态探测、比对契约钉住） |
| 6 | `desktop/src/utils/archive-entries.ts` `classifyArchiveEntry` | 匹配键改为：`x.ext`→ext、`.ext`（点文件）→去点整名、无点→整名；`:95-103` 集合成员 gitignore/dockerfile 等意图可达（裸名 log/env 等进文本预览为有意副作用） | `archive-entries.test.ts` +1（.gitignore/.env/Dockerfile/Makefile、多重点号与隐藏文件边界） |
| 7 | `desktop/src/utils/toolDisplay.ts` + `backgroundNotice.ts` | 新增 `clipByCodePoint`（切点为高代理项时回退一位保住完整码点），替换 10 处长度截断裸 slice；`:64` 分隔符切分、`:92` 数组截取非截断语义不动 | `toolDisplay.test.ts` +2、`backgroundNotice.test.ts` +1（切点恰为代理对、长度语义不变、noticeExcerpt） |
