# 逻辑 BUG 审查报告（2026-11-07）

> 审查范围：backend-ts（harness/container、harness/tool+core、session/ws、schedule、signal、approval、summarizer）、desktop（composables/chat）、agent-cli（repl、session-runner、审批链）。基线 HEAD = `d3b80c4f`。
>
> 审查方法：六个分区并行逐行通读 + 与 `docs/code-review/` 既有 300+ 份报告逐条去重 + 每条入选 BUG 补充存在性证明用例并真实运行（先翻转断言抓真实失败，再固化为 expected-failure 保持 CI 绿）。
>
> 验证口径：所有用例断言「正确行为」，当前实现必然失败。默认 `it.fails` 固化；把 `bugIt` 改成 `it` 再运行即得真实失败输出（复现命令见下）。
>
> 复核（2026-11-07 晚，本次更新）：全部条目重新实跑复核——原 BUG-7 经真实 Chromium 实测**不成立**已移除（原 BUG-8 顺延为 BUG-7）；BUG-1 补第二触发点；候选清单收敛为「代码链路已核实且修复价值 ≥ 中」的 9 条。详见文末「复核记录」。
>
> 修复记录（2026-11-08，版本 0.0.475）：本报告全部 16 项（正榜 BUG-1 ~ BUG-7 + 补充核实候选 9 条）已全部修复并合入 main。两个存在性用例文件（`logic-bug-review-2026-11-07.spec.ts`、`repl-queue-drain.bugcheck.spec.ts`）已转正为常规回归测试（`bugIt = it`），直接运行即断言修复后的正确行为（backend 7 passed、agent-cli 2 passed）；下方「复现」章节的形态翻转步骤为历史记录（当时验证 BUG 存在性的方法），不再需要。逐项修复要点见文末「修复记录」与仓库 CHANGELOG「0.0.475」。
>
> 本次审查**不修改任何产品代码**，保留 2 个测试文件与 1 份报告（修复前以 expected-failure 固化；2026-11-08 修复后已转正，见上一条）：
> - `backend-ts/src/logic-bug-review-2026-11-07.spec.ts`（BUG-1 ~ BUG-6）
> - `agent-cli/test/repl-queue-drain.bugcheck.spec.ts`（BUG-7）

## 复现

```bash
# 形态一：真实失败（证明 BUG 存在）——9 个用例全部失败（backend 7 + agent-cli 2）
cd backend-ts
sed -i '' 's/^const bugIt = it.fails;$/const bugIt = it;/' src/logic-bug-review-2026-11-07.spec.ts
npx vitest run src/logic-bug-review-2026-11-07.spec.ts        # 7 failed（BUG-1 需环境装有 rg，无 rg 走 JS 回退不复现）
cd ../agent-cli
sed -i '' 's/^const bugIt = it.fails;$/const bugIt = it;/' test/repl-queue-drain.bugcheck.spec.ts
npx vitest run test/repl-queue-drain.bugcheck.spec.ts         # 2 failed

# 形态二：恢复 expected-failure（CI 绿色）
cd ../backend-ts
sed -i '' 's/^const bugIt = it;$/const bugIt = it.fails;/' src/logic-bug-review-2026-11-07.spec.ts
npx vitest run src/logic-bug-review-2026-11-07.spec.ts        # 7 passed (expected fail)
cd ../agent-cli
sed -i '' 's/^const bugIt = it;$/const bugIt = it.fails;/' test/repl-queue-drain.bugcheck.spec.ts
npx vitest run test/repl-queue-drain.bugcheck.spec.ts         # 2 passed (expected fail)
```

复核实跑记录（2026-11-07 晚，HEAD `07544295`）：真实形态 `7 failed (backend) + 2 failed (agent-cli)`；固化形态（`it.fails`）backend `7 passed (7)`、agent-cli `2 passed (2)`；`desktop` 全量（删除误报用例后）`182 files / 1753 passed`、`agent-cli` 全量 `60 files / 674 passed`，均 exit 0。首版全量回归（`backend-ts 5710 passed`）不受本次更新影响（未改后端产品代码与用例）。

## 汇总

| 编号 | 标题 | 位置 | 严重度 | 用户可见后果 |
|------|------|------|--------|--------------|
| BUG-1 | grep_search rg 分支把 `-` 开头的 pattern 当 flag：静默 0 命中 / 误报搜索失败 | `harness/tool/impl/grep-search-tool.ts:97`；同型缺陷另见 `agent-cli/src/local/tools/search.ts:274` | 高 | 模型搜 `-n`、`--force` 等字面串得到「0 命中成功」，在错误前提下继续推进（触发前提：环境装有 rg） |
| BUG-2 | 容器 read_bytes 把 0 字节文件判成读取失败 | `harness/container/docker-tool-router.ts:131` | 高 | docker 用户发送/编辑空文件（如 `touch` 的占位文件）必报「容器内文件读取失败」，host 模式却正常 |
| BUG-3 | 哨兵复制（copyFrom）在 headers 键未下发时静默丢弃源哨兵全部请求头 | `signal/watcher.service.ts:780-782` | 高 | 官方 CLI 文档示例复制的哨兵无凭据，401 错误页被当成正常基线，哨兵静默失效 |
| BUG-4 | 重试入口不消费 pendingCancels：提交前窗口的「停止」被静默吞掉 | `session/ws/streaming-ws-handler.ts:1577-1587` | 高 | FAILED 会话点「重试」后立刻点「停止」，任务照常全量执行 |
| BUG-5 | 容器 agent 重连后 connectionDead 永不清除：健康容器被强制重建 | `harness/container/container-registry.ts:639,648-652` | 高 | 一次通道抖动（已自动重连）后，下次工具调用把健康容器 stop+rm+run，shell/PTY/后台任务/MCP stdio 全部丢失 |
| BUG-6 | 工具结果摘要失败/超时语义失真（wait_subagents 谎报完成、ask_user 即时失败标成超时） | `session/util/tool-result-summarizer.ts:790-797,403-410` | 中 | 轨迹、活动记录、admin 会话详情读到失真摘要：30 分钟超时显示「已完成」 |
| BUG-7 | `/resume` 切入运行中会话后，等待期间排队的输入永不消费 | `agent-cli/src/repl/repl.ts:167-169,190-198,360-362` | 高 | 排队消息静默滞留；下一条消息提交后旧消息反被先行发出（乱序），全程无提示 |

与既有报告的关系：每条均已对照 `docs/code-review/` 全部既有文档查重（含 2026-10-02 / 11-04 对 grep 的两轮、2026-11-07 容器隔离 round1/2/4、2026-11-06 多端审批 review），均为未报告过的新问题。

---

## BUG-1【高】grep_search rg 分支：pattern 以 `-` 开头被 rg 当成命令行 flag

**位置**：`backend-ts/src/harness/tool/impl/grep-search-tool.ts:97`；**同型第二触发点**：`agent-cli/src/local/tools/search.ts:274`（LOCAL 模式的本地 grep 分支，同一 argv 构造，修复时须两处同步）

```ts
cmd.push(pattern, scope.rgTarget);   // pattern 与目标路径之间没有 -e / -- 分隔
```

**触发条件 → 期望 vs 实际**（前提：运行环境装有 ripgrep；无 rg 时走 JS 回退分支、不复现——本机以 ripgrep 13.0.0 复核复现）：模型搜索以 `-` 开头的字面串/正则（搜 CLI 输出、diff、配置注释极常见：`-n`、`-i`、`-v`、`--force`）。期望按该 pattern 搜索；实际 rg 按 clap 约定把首个 `-` 开头参数解析为 flag：

- pattern=`-n`（合法 flag）→ `-n` 被吃成 line-numbers，`rgTarget` 被降级为 pattern，**path 位空缺**。而 `spawnSync` 的 stdin 默认是管道 → rg 读空 stdin 立即 EOF → exit 1（无匹配，不算失败）→ **静默返回「0 命中成功」**，无 error、无 truncated。本机实测 `spawnSync('rg', ['--json','-n','.'])` → `status=1`、`bytes_searched=0`；同目录 `rg --json -e '-n' .` 正确命中 1 行；
- pattern=`--foo`（非法 flag）→ rg exit 2 → 走 ：104-108 抛「ripgrep 搜索失败（exit 2）：rg: unrecognized flag --foo」，把合法搜索请求报成工具故障。

JS 回退分支（`new RegExp(pattern)`）对同一输入行为正确，rg 分支行为分叉且失败形态是「静默错结果」——与本文件既有防线（rg 失败不吞成 0 命中，2026-10-02 已修；负参数显式报错，11-04 已修）的「宁可见错误不要静默错结果」口径相悖。

**验证证据**（真实形态实跑输出）：

```
AssertionError: expected [] to have a length of 1 but got +0
```

工具对含 `hello -n world` 的文件搜 `pattern:"-n"`：返回 `matches: []`、无 error——真实存在的匹配被静默丢掉。

**修复方向**：`cmd.push('-e', pattern, scope.rgTarget)`（或先 `--` 再 pattern）。修复后该用例转正为回归测试。

---

## BUG-2【高】容器 read_bytes 把 0 字节文件判成读取失败

**位置**：`backend-ts/src/harness/container/docker-tool-router.ts:131`

```ts
if (!response.ok || !response.base64) {
  throw new Error(response.error ?? '容器内文件读取失败');
}
```

**触发条件 → 期望 vs 实际**：容器侧 `container-tool-executor.ts:206-207` 对空文件返回 `{ ok: true, base64: '' }`（`readFileSync(空文件).toString('base64')` 就是空串，且 `''` 是 base64 的合法编码结果）。docker 用户经 send 工具（feishu/dingtalk/wechat 发文件、edit_image）读取 0 字节文件（如刚 `touch` 的占位文件）：期望与 host 模式一致返回空 Buffer（`send-file-bytes.ts:96-103` 对空文件正常返回，`loadSendFileBytes` 无非空预检）；实际 `!response.base64` 把空串当失败，抛「容器内文件读取失败」——error 字段还是 undefined，文案固定误导归因。

**验证证据**：

```
Error: 容器内文件读取失败
❯ DockerToolRouter.readBytes src/harness/container/docker-tool-router.ts:132:13
```

**修复方向**：改 `if (!response.ok || response.base64 == null)`（协议类型 `runtime-channel-protocol.ts:72` 本来就是 `base64?: string`，字段缺失才应走失败分支）。

---

## BUG-3【高】哨兵复制（copyFrom）headers 键未下发时静默丢弃源哨兵全部请求头

**位置**：`backend-ts/src/signal/watcher.service.ts:780-782`（`applyCopyInheritance`）

```ts
const headers = input.headers != null
  ? this.restoreMaskedHeaders(input.headers, storedHeaders)
  : null;
```

**触发条件 → 期望 vs 实际**：`input.headers` 缺省（undefined，键未下发）与显式 null 走同一分支 → 副本 `headers = null` 落库。对比同函数对 body 的处理（:783-786）：`body === undefined` 时继承源行解密 body——**headers 漏了同样的「未下发=继承」分支**。

触发路径是官方文档承诺的支持方式：`skills/mao-cli/reference/signal-watcher.md:75-77` 的示例即不带 `--headers` 的复制：

```
# 复制已有哨兵：敏感请求头与请求体由后端从源行解密继承，CLI 不接触明文
mao signal-watcher create --name '库存监控 副本' ... --copy-from 12
```

CLI 侧 `signal-watcher.js:187-188` 只有传了 `--headers` 才带 headers 键；后端 `create()` 注释（watcher.service.ts:169-171）同样承诺「敏感请求头与 body 从源行解密继承」。桌面端复制流程预填掩码表单所以不受影响，但 CLI 是文档明示路径。

后果：副本探针无 Authorization 打到目标 → 401/未授权页。由于探针「任何完成响应的状态码都是合法判定输入」，这个 401 响应体被当作**正常基线**建立（首轮只建基线不触发），此后哨兵永远在监控 401 页面：HASH/STATUS_CODE 模式下没有失败计数、没有告警，目标真实变化也永远检测不到——静默失效。

**验证证据**：

```
AssertionError: expected null not to be null
```

create 源哨兵（带 `Authorization: Bearer SECRET`）后不带 headers 键复制，副本 `headersJson` 落库为 null。

**修复方向**：`copyFrom != null && input.headers === undefined` 时整体继承源 headers（掩码行仍走 `restoreMaskedHeaders`），与 body 的 undefined=继承语义对齐。

---

## BUG-4【高】重试入口不消费 pendingCancels：提交前窗口的「停止」被静默吞掉

**位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts`（`handleRetryExecution`，:1577-1587 registerCancelFlag 前无 `takePendingCancel`）

**触发条件 → 期望 vs 实际**：五个执行入口中四个都接了 M-2 竞态修复的 `takePendingCancel`——`handleSendMessage`(:826)、`executePersistedUserPrompt`(:1028)、`handleEditAndResend`(:1132)、`handleCreateSideSession`(:1392)——**唯独重试入口漏了**。而重试在占 claim（:1524）到注册 cancelFlag（:1579）之间隔着多个真实 await 窗口：SUBAGENT 的 `beginRetry` 落库、LOCAL 的 `prepareLocalTarget`/`isConnected`、`cleanupIncompleteTail` 全量扫描、`updatePhase(RESUMING)`。

用户在此窗口点「停止」：`handleCancel`（:1804）登记 `pendingCancels`（设计注释明言这正是给「尚未注册取消标志的在途提交」用的）；随后重试照常注册全新 flag 并提交执行，标记一直挂到 `runRetryExecution` finally（:1683）被**无条件抹掉**——用户的取消被完全吞掉，任务跑完才能再停。

**验证证据**：预置 `pendingCancels.set(11, Date.now())` 后走真实 `retry_execution` 分发：

```
AssertionError: expected "spy" to not be called at all, but actually been called 1 times
  1st spy call: [11, "fad0b133-…", WsStreamingEventListener { … }]
```

带待取消标记时执行仍被提交（`harnessService.executeFromEvent` 被调用）。

**修复方向**：`registerCancelFlag` 前补 `if (this.takePendingCancel(sessionId, Date.now(), flag)) { …收敛 CANCELLED 并 return; }`，与其余四入口同口径；同时 :1683 的无条件 delete 应保留（兜底清理无害）。

---

## BUG-5【高】容器 agent 重连后 connectionDead 永不清除：健康容器被强制重建

**位置**：`backend-ts/src/harness/container/container-registry.ts:639`（markConnectionDead 只置 true）；全仓仅 `createAndStart`/`dockerStart` 成功路径清 false（:866/:942）；`reportAgentHello`（:648-652，容器内 agent 重连回调）只更新 runtimeBuild，**从不清该标志**。

**触发条件 → 期望 vs 实际**：字段自己的文档（:47）写「连接断开（**容器内 agent 未重连**）时置 true，下次 ensureRunning 触发重建」。但「重连与否」对 registry 完全不可见：任何一次通道 drop（心跳 3 次未回约 60-90s、宿主机卡顿、帧解码失败）都置 `connectionDead=true`，容器内 agent 随后自动重连成功（hello 到达），下一次 `ensureRunning`（每次工具调用/终端/MCP 都会走）落入 ：442-446 兜底分支，把**刚恢复健康的容器** stop + rm + docker run——shell 会话/PTY/后台任务/MCP stdio 子进程全部丢失。

且与 pty-bridge 的重连设计自相矛盾：`pty-bridge.ts:9-13/158-169` 特意给 20s 宽限「agent 退避重连（同一容器内 pty 仍活着）……bindConnection 成功即恢复」，保住的终端随后被这次重建整批杀掉（重建换 `startedAtMs` → `app-utils.ts:162` 世代比对失配 → hub.dispose）。

**验证证据**（真实形态实跑输出）：ensureRunning → markConnectionDead → reportAgentHello(7,5,'b1') → ensureRunning：

```
AssertionError: expected [ …(3) ] to deeply equal []
+ [
+   "stop -t 10 mao-user-7-agent-5",
+   "rm -f mao-user-7-agent-5",
+   "run -d --name mao-user-7-agent-5 …（完整 docker run argv）
+ ]
```

重连成功后仍触发整容器重建。修复后（hello 清标志）该用例转正。

**修复方向**：`reportAgentHello` 内清 `entry.connectionDead = false`；另注意 `runtime-channel-server.ts:177-183` 替换旧连接路径的 `previous.close()` 会同步触发 `drop` 对新连接误发 onConnectionDead，需把「替换」与「真断开」区分（`previous.close()` 前先从 map 摘除，或给 drop 传 replaced 标志）。

---

## BUG-6【中】工具结果摘要失败/超时语义失真（两处）

**位置**：`backend-ts/src/session/util/tool-result-summarizer.ts:790-797`（`summarizeWaitSubagents`）、`:403-410`（`summarizeAskUserQuestions`）

**触发条件 → 期望 vs 实际**：

1. `wait_subagents` 等满超时且尚无子代理完成：结果里现成的 `timed_out: true`（`background-subagent-tools.ts:235`）被完全忽略，只看 completed 计数 → 摘要返回**「后台子代理已完成 (0 个结果)」**——语义上谎报完成态。该摘要经 `onToolCallResult` 写入 `data.summary` 并随 `tc.summary` 持久化进 assistant 消息（`agent-loop.ts:739-741/758-760`）、落 `session_activity`，是轨迹审计与回放的权威文案；桌面卡片因 richSummary 碰巧纠正了展示，但活动记录、REST 轨迹、admin 会话详情读到的都是失真摘要。与 11-07 `b1005d4c` 修复的 richSummary 同族、未覆盖此函数。
2. `ask_user_questions` 对**任意**顶层 `error` 一律返回「向用户提问 (超时或取消)」。但 dispatcher 的 error 形态还包括参数非法（`questions 不能为空`）、`Session not found`、通道拒绝（`当前通道不支持向用户提问`）——这些是即时失败，根本没进入等待，却全部被标成超时/取消。

**验证证据**：

```
AssertionError: expected '后台子代理已完成 (0 个结果)' to contain '超时'
AssertionError: expected '向用户提问 (超时或取消)' not to contain '超时或取消'
```

**修复方向**：wait_subagents 按 `timed_out === true` 返回「等待后台子代理 (已超时，N 个结果)」；ask_user 按 `node.cancelled === true` 才标超时/取消，其余 error 标「(错误)」（与 cancel_subagents 等函数的 `(错误)` 口径一致）。

---

## BUG-7【高】`/resume` 切入运行中会话后，等待期间排队的输入永不消费（agent-cli）

**位置**：`agent-cli/src/repl/repl.ts`——排队承诺在 `handleSubmit`（:120-127，`isRunning()` 即入队并提示「已排队（第 n 条）」）；**唯一的排水循环**在直发分支尾部（:130-142）；而 `resumeActiveRun`（:190-198，启动分支 :163-169 与 `/resume` 切换分支 :360-362 共用）`await waitForCurrentRun()` 结束后直接返回——两条路径结束后都无人消费队列。

**触发条件 → 期望 vs 实际**：`isRunning()` 就是 `busy`（session-runner.ts:89），而 `waitForCurrentRun` 全程 `busy=true`（:209-222）。`mao-agent resume <运行中会话>` 或 REPL 内 `/resume` 切到 RUNNING 会话（752b6ebf 明确支持的一级路径）后，等待期间输入一条消息 → 提示已排队（/help 语义：本轮结束自动发送）→ 占用方执行结束。期望队列自动发出；实际**消息静默滞留**。更糟的是乱序：用户下一条消息提交时 `handleSubmit` 直发新消息，随后的 drain 循环反而把滞留的**旧消息**先行发出——先后顺序颠倒且全程无提示。

**为什么是 bug**：排水逻辑只存在于「由 `runOne` 开启的那次 `handleSubmit`」的 while 循环里；`resumeActiveRun` 是在 `handleSubmit`/`runOne` 之外 await 的，排队承诺（hint 文案与 `/help`）对这两条路径没有兑现。与 2026-08-23 BUG-11（旧「REPL resume 吞输入」，busy-retry 已修）根因不同，与 2026-11-06 REPL 专项报告的面板/回挂问题也无重叠。

**验证证据**（真实形态实跑输出，两条路径各一条）：

```
AssertionError: expected "spy" to be called with arguments: [ 'hello', undefined ]
AssertionError: expected "spy" to be called with arguments: [ 'hello', 9 ]
```

占用方执行结束后，`runPrompt` 从未被调用——排队消息留在队列里。

**修复方向**：`runRepl` 启动分支与 `handleSlash` 的 `/resume` 分支在 `resumeActiveRun` 返回后复用 `handleSubmit` 同款 drain 循环（提取为公共函数）；或 `resumeActiveRun` 自己收尾排水。

---

## 补充核实（代码链路已核实，未固化用例）

以下条目在本次复核中经代码链路逐条核实成立（未补存在性用例），修复价值 ≥ 中，按价值排序，并注明配套条件与已兜底边界：

| 条目 | 位置 | 修复价值 | 摘要（复核后表述） |
|------|------|----------|------|
| 边路面板收尾无条件清空输入 | `desktop/src/components/chat/SideChatPanel.vue:885-896,1040-1048` | 高 | 边路发送收尾无条件 `clearInput()`+`clearDraft()`：上传/连接/等待保存窗口（上限 60s）内继续打字被静默清空且不可恢复；主会话已有 `clearInputIfUnedited` 守卫（`ChatPanel.vue:765-767,781`），边路未跟进 |
| 容器内 MCP stdio connect 无超时、失败不清理 | `backend-ts/src/harness/container/container-mcp-bridge.ts:42-59` | 中 | connect/listTools 无超时、抛错不关 transport：能 spawn 但不响应 initialize 的 server 每轮执行泄漏一个子进程（对照宿主机 `mcp-client-manager.ts:24-25,49-101` 有 60s 连接超时与失败清理） |
| updateTask 换 cron 绕过 pendingOnceWork 不变量 | `backend-ts/src/schedule/scheduled-task.service.ts:438-457,789-806` | 中 | 一次性任务待重试/重试运行中（`next_retry_at` 已清）改 cron——包括改成另一个一次性日期——无条件开新档期，随后被旧档期重试链抹掉：新计划永不触发、任务被标 finished |
| deleteSession 运行中拒删是 check-then-act | `backend-ts/src/session/session.service.ts:645-653` | 中 | 锁前判相位、锁后不复查（且 `lockActiveSessionById` 的行锁在事务外、语句即释放）：执行体被池排队/等锁期间 phase 仍为 IDLE，会话可被删掉，执行继续在已删会话上跑（对照 `promoteSideTaskToMainSession:717-729` 的事务内复查写法） |
| POST 探针恒 chunked 且用户无法自救 | `backend-ts/src/signal/probe-client.ts:100-103` + `probe-validate.ts:12` | 中 | 有 body 时从不写 Content-Length（恒 chunked），且该头在禁填名单：对要求 Content-Length 的目标必败（411；错误页会被建成假基线），服务端明知 body 长度却不代填 |
| 失败退避用 MySQL NOW() 与 Node 时钟混用 | `backend-ts/src/signal/signal.repository.ts:215-226` vs `:142-151` | 中（条件性） | 失败退避 `DATE_ADD(NOW(), …)`（DB 钟）、成功回写与到期比较用 Node 钟，`db.ts` 未钉 MySQL 会话时区：DB 时区 ≠ +08:00 时退避整体漂移（落后→退避被旁路、约每 30s 重试；超前→一次失败后静默停摆）。需在生产连接核验 `SELECT @@session.time_zone` |
| 打印模式丢弃 error 帧内容 | `agent-cli/src/render/json-renderer.ts:24-28`、`text-renderer.ts:8-16` | 中 | text / 非 stream json 打印模式丢弃 `error` 帧、`RunResult.error` 也未回填（`session-runner.ts:644-648`）：FAILED 终态 stdout 无任何原因文本（stream-json 有 `case 'error'`），脚本消费方无法诊断 |
| 审批模态「已提交」态吞掉 Ctrl+C | `agent-cli/src/tui/modal-controller.ts:250-251` + `ink-renderer.ts:279-289` | 中 | 投票上行后（submittedFlag）吞掉全部按键含 Ctrl+C；回声丢失时无键盘逃生。后端未重启由服务端 900s 超时兜底收敛；后端在投票与回声间重启时该轮永不收敛 |
| MCP HTTP `tools/call` 无超时 | `agent-cli/src/local/tools/mcp.ts:269-293` | 中 | HTTP 分支 fetch 无超时（stdio 路径 120s）：病态 trickle 响应可让本地 fetch 永不返回、tool_result 永不上行（服务端 900s 超时只让该轮失败，CLI 侧连接/Promise 泄漏仍在） |

## 复核记录（2026-11-07 晚，本次更新）

- **原 BUG-7（搜索跳转「停驻判定」）不成立，已移除**：真实 Chromium（本机 Chrome 153，Playwright 实测）点击不可聚焦元素会移动焦点——mousedown 时焦点仍在触发按钮、click 事件到达时已落到 `body`，「焦点停驻」条件在该路径上随后自然失效，`ChatInput.focusInput` 不会被吞。原用例以 jsdom + 合成 `click` 事件建模（jsdom 不实现点击焦点迁移），与真实浏览器行为背离，属测试建模误报；对应测试文件已删除。0.0.471 的让位机制本身按原样保留。
- **BUG-1 补第二触发点**：agent-cli 本地工具存在同一 argv 构造缺陷（`agent-cli/src/local/tools/search.ts:274`），修复须两处同步（已并入 BUG-1 与汇总表）。
- **候选清单剔除 4 条**（不成立或修复价值低于「中」）：容器 envelope「后到覆盖在途」（仅同容器同 user+agent 的 workspace 级 envVars、需同 socket chunk 多帧或抢锁窗口）；edit/write 行尾整文件归一（跨端刻意对齐的移植语义、需混合行尾前提）；useChat.sendMessage 按活跃会话收尾（`!isActive` 分支生产不可达，2026-10-13 豁免仍成立）；`switchTo` 旧相位回填（窗口仅数十 ms、且有二次 Ctrl+C 逃生）。
- 保留条目全部重新实跑：真实形态 `7 failed (backend) + 2 failed (agent-cli)`；固化形态 `7 + 2` 全绿；`desktop` / `agent-cli` 全量套件均绿。

## 修复记录（2026-11-08）

全部 16 项已修复并合入 main（版本 0.0.475）。逐项修复要点：

| 条目 | 修复 |
|------|------|
| BUG-1 | `grep-search-tool.ts`：pattern 改以 `-e` 显式绑定（`cmd.push('-e', pattern, scope.rgTarget)`）；agent-cli `local/tools/search.ts` 同型处同步修复 |
| BUG-2 | `docker-tool-router.ts`：`if (!response.ok \|\| !response.base64)` → `response.base64 == null`（空串是 0 字节文件的合法编码） |
| BUG-3 | `watcher.service.ts` `applyCopyInheritance`：headers 键未下发（undefined）→ 继承源行解密值；显式 null 仍为清空（对齐 body 语义） |
| BUG-4 | `streaming-ws-handler.ts` `handleRetryExecution`：注册 cancelFlag 前 `takePendingCancel(sessionId, retryStartedAt, …)`，命中走取消收敛（`rollbackSubagentRetry(…, 'CANCELLED')` + `finishCancelledSession`） |
| BUG-5 | `container-registry.ts` `reportAgentHello` 重连成功即清 `connectionDead`；`runtime-channel-server.ts` 替换旧连接先 `connections.delete(key)` 再 close（drop 不再误报） |
| BUG-6 | `tool-result-summarizer.ts`：wait_subagents 按 `timed_out === true` 返回「等待后台子代理 (已超时，N 个结果)」；ask_user 仅 `cancelled/timed_out` 标「超时或取消」、其余 error 标「(错误)」；`ask-user-questions-registry.ts` 超时结果补 `timed_out: true` |
| BUG-7 | `repl.ts`：提取公共 `drainQueuedPrompts`；启动续接分支与 `/resume` 分支在 `resumeActiveRun` 后排水（`handleSlash` 增可选排水回调） |
| 候选-1 | `SideChatPanel.vue`：两处发送收尾对齐主会话 `clearInputIfUnedited`（输入未改才清空）；`ChatInput.getPlainText` 已有、未改 |
| 候选-2 | `container-mcp-bridge.ts`：connect/listTools 包 60s 超时；失败路径先摘 map 再 `closeQuietly`（子进程不再泄漏） |
| 候选-3 | `scheduled-task.service.ts/store.ts`：`pendingOnceWork` 补 `hasRunningRun`；守门改 `!(pendingOnceWork && task.once === 1)`；收尾链把「cron 已变且 ACTIVE」判断提前、按新 cron 重排 |
| 候选-4 | `session.service.ts/repository.ts`：拒删判据移入事务（`findByIdForUpdate` 复查相位 + `logicalDelete` 原子）；移除管线尾部事务外逻辑删除 |
| 候选-5 | `probe-client.ts`：有 body 时按 utf8 字节数内部代填 `Content-Length`（仍在用户禁填名单之外由服务端代填） |
| 候选-6 | `signal.repository.ts`：失败退避 `last_checked_at = ?`（Node 时钟算好传参），不再 `DATE_ADD(NOW(), …)` |
| 候选-7 | `session-runner.ts` 记录 `lastErrorMessage` 并回填 `RunResult.error`；json-renderer 两个 finish 分支带出 `error`；text-renderer FAILED 时 stderr 输出「执行失败：…」 |
| 候选-8 | `ink-renderer.ts`：审批「已提交」态 30s 兜底定时器（`APPROVAL_ECHO_FALLBACK_MS`），回声不到按本地选择收尾；deliver/abort/dispose 清理定时器 |
| 候选-9 | `agent-cli/local/tools/mcp.ts`：HTTP 分支 fetch 加 `AbortSignal.timeout`（`MCP_CALL_TIMEOUT_MS`），超时给友好文案 |

验证（2026-11-08）：`backend-ts` 全量 `5716 passed`、`desktop` 全量 `183 files / 1761 passed`、`agent-cli` 全量 `60 files / 686 passed`，均 exit 0；两个存在性用例文件转正后直接运行（`bugIt = it`）：backend `7 passed`、agent-cli `2 passed`。

## 审查覆盖度与边界

- **已逐行通读**：harness/container 全部 12 个文件、harness/terminal、harness/tool（dispatcher/invocation/registry + 12 个内置工具）、harness/core（agent-loop/context-manager/compaction/no-progress）、session/ws/streaming-ws-handler（2814 行全文）、schedule、signal、approval、summarizer、desktop composables/chat 关键文件、agent-cli/src 约 30 个文件（重点 repl、session-runner、审批链、local tools、render）。
- **agent-cli 审批三路投票已核对无新问题**：`raceVoteAndEcho`/`finalizeApproval`/`submitApprovalVote` 无重复上行；`serializePayload` 二分截断终态有 maxBytes 兜底；read_file offset/limit、glob head_limit、edit_file replace_all 与云端同口径；frames 契约与 backend 一致。
- **已核查并排除**（避免重复投入）：容器快照链三轮修复（ba80b030/ea621d48/b2df53ba）未发现新缺口；agent-loop mergeToolCall 迟到 id 归并链完整；shell-session-tool 锁与 pendingCommand 生命周期自洽；no-progress 双侧口径一致；compaction 触发/溢出窗口未再混用模型窗口；file-write-lock 双 key 无死锁；recoverFailedSessions 并发防护修复成立；技能视图物化竞态已收口；跨通道接力（e2ae07a8）busy 检查点位正确；`/resume` 面板窗口、回挂、草稿态收口已被 2026-11-06 专项报告三轮覆盖且修复成立。
- 本报告全部条目已与既有 300+ 份 review 文档（2026-08-23 ~ 2026-11-07）逐条去重。
