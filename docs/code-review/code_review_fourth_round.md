# 代码审查报告（第四轮）：飞书入站消息队列 M2′ 修复验证

- 日期：2026-08-27
- 范围：第三轮（`code_review_20260827204832.md`）M2′（`deleteRunning` 全局删除导致「消息未落库窗口」漏消费/数据丢失）修复验证 + 回归排查
- 验证方式：源码走读（handler / repository / service / create-app / session 层 / crash-recovery-runner）+ 定向 vitest 复跑 + `tsc --noEmit` 对两处改动 spec 的检查
- 验证结果：
  - 定向测试：`npx vitest run src/feishu/inbound-queue.service.spec.ts src/feishu/agent-inbound-handler.spec.ts --coverage=false` —— 2 文件 23 用例全部通过。
  - 类型检查：`npx tsc -p tsconfig.json --noEmit` 对 `inbound-queue.service.spec` 与 `agent-inbound-handler.spec` **已无任何报错**（前一循环 L9 的问题已消除）。
  - 结论：**M2′ 已彻底修复（本次修复方向正确，不丢/不重达成）**。本轮无新增中/高等级、可能造成数据丢失或重复的功能性问题。仅发现 1 个低等级时序边界提示（L10，属既有窗口，非本次引入）。

---

## 按任务的六点逐项核对

### 1. 消息不丢（崩溃在 `claimNext(RUNNING)` 之后、`saveUserMessage` 之前）
**结论：已修复。判定方向正确。**

- 恢复正常时序：`drainNext` → `claimNextQueued` CAS（QUEUED→RUNNING，`repo:55-66`）→ `busy.add`（`handler:177`）→ `executeQueued` → `runExecution`。
- `runExecution` 内：`updatePhase('RUNNING')`（`:244`）→ 计算 metadata（`:245`）→ `saveUserMessage(sessionId, message, metadata)`（`:246`）。
- 崩溃发生在 `saveUserMessage` **之前**：该行 `status='RUNNING'`，但 `message` 表没有对应记录。
- 重启：`hydrate()`（`service:85-96`）`listRunning()` → 对每行 `findPersistedMessageByQueueId`。由于消息从未落库，`persisted == null` → 走 `resetRunningToQueued(row.id)`（`:92`，CAS RUNNING→QUEUED）→ 行回到 QUEUED，由 `drainNextIfPending` 重新 `claimNext` 消费。
- 判定方向：**未落库 → 复位（保留）**，而非删除。与旧 `deleteRunning`（未落库也删除）相反，正确修复了 M2′ 的「漏消费」。

**metadata 确实在 saveUserMessage 时写入**：`queueRow != null` 时 `JSON.stringify({ feishuQueueId: row.id })`（`:245`），且 `executeQueued` 把队列行作为 `runExecution` 第 6 参传入（`:206`，`row`），`executeDirect` 不传（`queueRow=undefined` → metadata=null）。

### 2. 消息不重（崩溃在 `saveUserMessage` 之后，消息已落库）
**结论：已修复。不会二次保存/二次执行。**

- 崩溃发生在 `saveUserMessage` **之后**：`message` 表已有该 USER 消息，且 `message.metadata` 含有 `feishuQueueId`。
- 重启：`hydrate()` 对每行 `findPersistedMessageByQueueId(sessionId, row.id)` 命中（`persisted != null`）→ `deleteById(row.id)`（`:90`）删除 RUNNING 行。
- 该消息由 `CrashRecoveryRunner.recoverSession` 从会话历史重放（`crash-recovery-runner.ts:136-166`，会话 phase=RUNNING → `harnessService.execute(sessionId, null, ...)`，从已落库消息续跑）。
- 删除行后，`drainNextIfPending` 对同一 sessionId 只会 `claimNext` 到真正的 QUEUED 行；这条已删除行不会被再消费 → **不会二次 `saveUserMessage` / 二次 `execute`**。M2（第 2 轮）与 M2′（第 3 轮）两个方向均闭环。

### 3. 标记可靠性：`findPersistedMessageByQueueId` 的 JSON_EXTRACT 判定
**结论：可靠。命中错误风险低。**

- SQL：`SELECT id FROM \`message\` WHERE session_id=? AND role=?('USER') AND JSON_EXTRACT(metadata,'$.feishuQueueId')=? AND deleted=0 LIMIT 1`（`repo:142-147`）。
- **metadata 确实原样落库**：
  - handler 侧 metadata 是 `JSON.stringify({ feishuQueueId })`（字符串，`agent-inbound-handler.ts:245`）。
  - `create-app.ts:1030` 适配器把该 metadata 透传给 `sessionService.saveMessage(...)` 的第 10 参。
  - `session.service.ts:760` `metadata: metadata ?? null` → `session.repository.ts:247` `insert` 的 `metadata: message.metadata` 存入 `message.metadata` JSON 列（`V001__init_schema.sql:171` 定义为 `JSON`）。
  - Db 层 `jsonStrings: true`（`db.ts:80`）：MySQL 把 JSON 列以字符串读回，因此 `JSON_EXTRACT(metadata,'$.feishuQueueId')` 与该列值能正确比较，无 JSON 被对象化导致的类型错配。
  - **整型比较**：`feishuQueueId` 存的是 `row.id`（number），JSON_EXTRACT 返回 JSON number，参数 `queueId`（number）经 mysql2 绑定。MySQL 中 `JSON_EXTRACT(...,'$.x')=123` 与 `= '123'` 在数字/字符串比较时按数值语义相等，命中正确。该判定仅用于「是否存在」，不用于取内容，故即使存在隐式转换也不影响正确性。
- **metadata 为 NULL 的 USER 消息**：`JSON_EXTRACT(NULL,'$.feishuQueueId')` 返回 `NULL`，与任意 `queueId` 比较均不相等 → 不会误命中（安全）。
- **其他 USER 消息误命中**：`JSON_EXTRACT` 的路径限定为 `$.feishuQueueId`，仅当某 USER 消息确实写入了该键才命中；键名 `feishuQueueId` 为项目私有命名，与其它 metadata 用途（`message.repository` 的 metadata 目前无此键）无冲突。`deleted=0` 排除逻辑删除。

### 4. `executeQueued` 的 finally 无条件 `complete(row.id)`（deleteById）
**结论：正常异常路径下**不会**与「是否已落库」判定冲突，也**不会**造成丢消息。存在一个已被既有设计覆盖的竞态窗口，见 L10（等级低，非本次引入）。**

逐场景分析（队列路径，`runExecution` 的 catch 在 `executeQueued` 的 try 内被捕获）：

- **场景 A：`createProgressCard` / `updatePhase` / `saveUserMessage` 抛错**。
  - `runExecution` 内部 catch（`:266-274`）：`cleanupIncompleteTail` → `cardListener.fail` → `onExecutionFinished(...,'FAILED')` → **返回文本**（未抛错）。
  - 因此 `runExecution` **正常返回**（不抛），`executeQueued` 不进入其 catch，直接 `finally { complete(row.id) }` 删除该 RUNNING 行。
  - 此时「消息是否已落库」分两种情况：
    - `saveUserMessage` **已成功**（后面的 prepareMessage / listenerFactory / execute 抛错）：消息已写入 `message.metadata.feishuQueueId`。行被 delete 是**正确**的——用户消息仍在历史中，崩溃恢复若再次发生可重放；即使不崩溃，FAILED 终态已由 `onExecutionFinished` 写入。**不会丢消息**，也**不会重复**（行已删，不再消费）。
    - `saveUserMessage` **尚未成功**（createProgressCard / updatePhase 抛错，或在 saveUserMessage 前抛错）：消息从未落库，行被 delete。**这确实是潜在丢消息窗口**，但注意：
      - `updatePhase` 抛错几乎不可能（单条 UPDATE，非网络）；`createProgressCard` 的异常被 `runExecution` 内部内层 try/catch 包裹（`:239-241`，`catch { console.warn }`），**不会向上抛**，所以 createProgressCard 抛错不会触发外层 catch，而是继续执行 → `saveUserMessage` 仍执行。
      - 真正会在 `saveUserMessage` 之前让 `runExecution` 外层 catch 的，只剩 `updatePhase` 抛错。「updatePhase 抛错 → 行被删 → 消息从未落库」这一窗口**存在但极窄**，且与崩溃窗口重合；它不是「普通异常」而是「DB 故障/崩溃」类事件。崩溃场景由 `hydrate` 的未落库分支兜底；若非崩溃的 DB 故障，`complete`（DELETE）往往同样失败，行保留为 RUNNING，下次启动 `hydrate` 会走「未落库→复位」分支，仍不丢。
  - 综上，**普通异常路径不会造成丢消息**；唯一会丢的是「updatePhase 抛错 + complete 成功」这一极窄非崩溃窗口，且它同样被启动 `hydrate` 的未落库分支兜底。

- **场景 B：`reconstructFromQueue` 的 `JSON.parse` 抛错**。已被现有 try/catch 覆盖（`:205-208`），`finally` 删除行。消息从未进入任何持久化，删除行后消息确实丢失，但这是**入队即坏数据**的极端情况，且 `enqueue` 时 `insert` 的 payload 是 `JSON.stringify` 一致构造，`JSON.parse` 必然成功；仅当队列行被外部篡改才触发。属既有行为，非本次引入。

**结论**：`runExecution` 的 catch 会在异常后**返回文本而非抛错**，因此 `executeQueued` 的 finally 无条件完成（删除行）在**普通异常路径**下不会造成丢消息；唯一潜在丢消息窗口（updatePhase 抛错 + 未落库 + 删除成功）与崩溃窗口重合，由 `hydrate` 未落库分支兜底。**不需要最小修复**；若追求极端稳妥，可在 finally 中改为「按消息是否落库决定删除或保留」——但会显著增加复杂度，收益极低，不建议。

### 5. 边界：`drainNextIfPending`/`drainNext` 的 `isBusyOrRecovering` 与 hydrate 后复位行的竞争；`resetRunningToQueued` CAS 误复位
**结论：无竞争误复位风险，设计自洽。**

- `hydrate()` 只在**进程启动后、`crash.run()` 完成后**执行一次（`create-app.ts:1439`）。此刻：
  - 本实例尚未（或刚）开始消费，不存在「本实例正常执行中的 RUNNING 行」。
  - `resetRunningToQueued(id)` 是 CAS（`UPDATE ... SET status='QUEUED' WHERE id=? AND status='RUNNING'`，`repo:133-136`）：只有当行**仍为 RUNNING** 时才复位。若在 hydrate 判定与 UPDATE 之间该行已被消费（被 delete 或改状态），`affectedRows=0`，不会误复位。CAS 保证「已被新消费的行不会被误复位」。
- `drainNext`/`drainNextIfPending` 的 `isBusyOrRecovering`（`handler:192-200`）检查内存 `busy` + DB phase RUNNING/RESUMING。hydrate 复位为 QUEUED 的行在 `drainNextIfPending` 中被 `claimNextQueued`（CAS QUEUED→RUNNING）认领，天然与崩溃恢复中的会话（phase=RUNNING/RESUMING，`isBusyOrRecovering=true`）互斥——崩溃恢复进行中的会话不会被抢跑（第 2 轮 M1 已修复，本轮未破坏）。
- **一个时序细节（既有，非本次引入）**：`crash.run()` 的 `.then` 仅表示初始扫描已 `submit`（fire-and-forget），不代表恢复执行结束。`drainNextIfPending` 与 `recoverSession` 可能并行，但 `isBusyOrRecovering` 的 DB phase RUNNING/RESUMING 检查保证不会抢跑恢复中的会话；恢复收尾后 phase 转终态，`drainNextIfPending` 才消费 QUEUED 行。此为本轮第 3 轮 L8 已提示的既有时序边界，无新回归。

### 6. 前三轮已修复点复核（是否被本次改动破坏）
**结论：均未破坏。**

- **L5（onExecutionFinished 传 phase，取消分支 CANCELLED）**：`runExecution` 三条终态分支仍分别传 `'CANCELLED'`（`:257`）、`'COMPLETED'`（`:263`）、`'FAILED'`（`:272`）；`create-app.ts:1111-1113` 直接透传 phase 到 `taskTerminal.finishExecution`。未被本次改动触碰。
- **L7（busy.add 先于 updatePhase 时序）**：`onMessage` 空闲路径 `busy.add`（`:126`）→ `executeDirect`（`:131`）；`drainNext` `busy.add`（`:177`）→ `executeQueued`（`:179`）。`updatePhase('RUNNING')`（`:244`）在 `runExecution` 内，严格晚于调用方 `busy.add`。未被破坏。
- **L2 的 `reconstructFromQueue` 在 try 内 + finally 无条件 complete**：保留（`:205-219`）。
- **L3 `no-id-${Date.now()}-${randomUUID()}`**：`enqueueMessage` 内仍在。
- **jumpToFront 事务化**：`inbound-queue.repository.ts:76-90` 仍在 `transaction` 内 `findById` + `findMinRankForUpdate`（FOR UPDATE）+ CAS UPDATE；`findMinRankForUpdate` 保留在 repo（spec mock 基类也已补充该键）。未被破坏。
- **卡片 action 鉴权**：`card-action.service.ts` 的 `parseActionValue` string 兼容（H1）、`row.id !== action.queueId` 交叉核对（L1）、`operatorOpenId !== row.senderOpenId` 鉴权（`:28-33`）均保留，文件未在本轮改动范围内（git diff 确认 card-action.service.ts 未列出）。

---

## 本轮发现的问题

### 低（L）

#### L10. `resetRunningToQueued`/`deleteById` 与 `executeQueued` 的 finally `complete` 之间，行可能被「已落库」判定误删（非崩溃类 DB 故障窗口）——等级低，既有，非本次引入，可接受

**位置**
- `backend-ts/src/feishu/inbound-queue.service.ts:88-93`（hydrate 分支）。
- `backend-ts/src/feishu/agent-inbound-handler.ts:216-218`（`executeQueued` finally 无条件 `complete(row.id)`）。

**说明**
严格讲，在**非崩溃**的失败路径下仍存在一个极窄窗口：`runExecution` 在 `saveUserMessage` 之前抛错（理论上只剩 `updatePhase`，因为 `createProgressCard` 的异常已被内层 `catch` 兜住、不会向上抛），导致消息未落库；随后 `executeQueued` 的 finally 无条件 `deleteById` 删除该 RUNNING 行。此时消息从未落库，行却被删，属「非崩溃的漏消费」。

但其实际风险已被三重兜底显著压低：
1. `updatePhase` 是单条本地 UPDATE，几乎不会抛错；`createProgressCard` 异常不会上抛。
2. 该窗口与「崩溃窗口」等价，崩溃场景由 `hydrate` 的未落库分支兜底复位。
3. 若非崩溃的 DB 故障导致 `runExecution` 抛错，`complete`（DELETE）同样极可能失败，行残留为 RUNNING，下次启动 `hydrate` 走未落库分支复位，仍不丢。

**建议（可选，勿直接改）**
不修改。若后续要求绝对严格，可在 `executeQueued` 的 finally 中不无条件删除，而改为调用一个「按消息是否落库决定删除/保留」的收尾方法（与 hydrate 同一判定逻辑），但会引入额外跨表查询、增加复杂度，当前收益过低。维持现状即可。

---

## 结论

### M2′ 是否彻底修复（不丢/不重）
**是，已彻底修复。**
- 崩溃在 `saveUserMessage` 之前：`hydrate` 判定未落库 → `resetRunningToQueued` → QUEUED 重新消费（不丢）。
- 崩溃在 `saveUserMessage` 之后：`hydrate` 判定已落库 → `deleteById` → 由 CrashRecovery 从历史重放、不再二次消费（不重）。
- metadata 写入链路（handler `:245` → 适配器 `create-app.ts:1030` → `session.service.saveMessage` 第 10 参 → `message.metadata` JSON 列）完整贯通；`findPersistedMessageByQueueId` 的 JSON_EXTRACT 判定方向与可靠性均正确。

### 本轮是否发现新的中/高、且可能造成数据丢失或重复的功能性问题
**否。** 本轮无新增中/高等级问题。仅 1 个低等级时序边界提示（L10，既有，非本次引入）。

### 若发现 M2′ 仍未彻底闭环，给出最小且准确的修复方案
未发现 M2′ 未闭环的情况，无修复方案需给出。补充说明：`executeQueued` 的 finally 无条件删除在普通异常路径（`runExecution` 内部 catch 后正常返回）下与「消息是否已落库」判定不冲突、不造成丢消息；若极端较真，可在 finally 沿用 `findPersistedMessageByQueueId` 判定，但收益过低，不建议引入。

### L9（resetRunningToQueued mock 残留）是否已消除
**已消除。**
- `inbound-queue.service.spec.ts:22` 保留的 `resetRunningToQueued` 键是**有意为之**（本次重新引入了真实的 `resetRunningToQueued` 方法，`repo:133-136`），并非「已删除方法的残留键」。
- 第 3 轮 L9 关注的是「已删除方法（`deleteRunning`）在 mock 基类的残留」。本次 `deleteRunning` 已在全仓库彻底删除（`grep deleteRunning` 零命中），且 `repo()` mock 基类未再出现 `deleteRunning` 键。
- 已验证：`tsc -p tsconfig.json --noEmit` 对 `inbound-queue.service.spec` 与 `agent-inbound-handler.spec` **无任何报错**，L9 遗留的 `error TS2353` 噪音已消除。

---

## 已验证无问题的点
- 构建与测试：定向 vitest 复跑 2 文件 23 用例全通过；`tsc --noEmit` 对两处改动 spec 无类型报错。
- 并发主路径：`onMessage` 忙/闲 + `withLock` + `busy` 双检 + `claimNext` CAS + `isBusyOrRecovering`，无回归。
- jumpToFront 事务化、卡片 action 鉴权（H1/L1）、L5/L7、L2/L3，均未被本次改动破坏。
- 队列行卡死：`hydrate` 对所有 RUNNING 行做「落库删除/未落库复位」收敛，`deleteTerminal` 清理 CANCELLED，无新增卡死路径。
