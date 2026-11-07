# 逻辑 BUG 审查报告（2026-11-07）

> 审查范围：backend-ts（harness/container、harness/tool+core、session/ws、schedule、signal、approval、summarizer）、desktop（composables/chat）、agent-cli（repl、session-runner、审批链）。基线 HEAD = `d3b80c4f`。
>
> 审查方法：六个分区并行逐行通读 + 与 `docs/code-review/` 既有 300+ 份报告逐条去重 + 每条入选 BUG 补充存在性证明用例并真实运行（先翻转断言抓真实失败，再固化为 expected-failure 保持 CI 绿）。
>
> 验证口径：所有用例断言「正确行为」，当前实现必然失败。默认 `it.fails` 固化；把 `bugIt` 改成 `it` 再运行即得真实失败输出（复现命令见下）。
>
> 本次审查**不修改任何产品代码**，只新增 3 个测试文件与 1 份报告：
> - `backend-ts/src/logic-bug-review-2026-11-07.spec.ts`（BUG-1 ~ BUG-6）
> - `desktop/src/composables/searchJumpFocus.bugcheck.test.ts`（BUG-7）
> - `agent-cli/test/repl-queue-drain.bugcheck.spec.ts`（BUG-8）

## 复现

```bash
# 形态一：真实失败（证明 BUG 存在）——9 条全部失败
cd backend-ts
sed -i '' 's/^const bugIt = it.fails;$/const bugIt = it;/' src/logic-bug-review-2026-11-07.spec.ts
npx vitest run src/logic-bug-review-2026-11-07.spec.ts        # 7 failed
cd ../desktop
sed -i '' 's/^const bugIt = it.fails$/const bugIt = it/' src/composables/searchJumpFocus.bugcheck.test.ts
npx vitest run src/composables/searchJumpFocus.bugcheck.test.ts  # 1 failed
cd ../agent-cli
sed -i '' 's/^const bugIt = it.fails;$/const bugIt = it;/' test/repl-queue-drain.bugcheck.spec.ts
npx vitest run test/repl-queue-drain.bugcheck.spec.ts         # 2 failed

# 形态二：恢复 expected-failure（CI 绿色）
cd backend-ts
sed -i '' 's/^const bugIt = it;$/const bugIt = it.fails;/' src/logic-bug-review-2026-11-07.spec.ts
npx vitest run src/logic-bug-review-2026-11-07.spec.ts        # 7 passed
cd ../desktop
sed -i '' 's/^const bugIt = it$/const bugIt = it.fails/' src/composables/searchJumpFocus.bugcheck.test.ts
npx vitest run src/composables/searchJumpFocus.bugcheck.test.ts  # 1 expected fail
cd ../agent-cli
sed -i '' 's/^const bugIt = it;$/const bugIt = it.fails;/' test/repl-queue-drain.bugcheck.spec.ts
npx vitest run test/repl-queue-drain.bugcheck.spec.ts         # 2 passed (expected fail)
```

本机实跑记录：真实形态 `7 failed (backend) + 1 failed (desktop) + 2 failed (agent-cli)`；固化形态后全量回归 `backend-ts 5710 passed`、`desktop 1753 passed + 1 expected fail`、`agent-cli 674 passed`（均含各自 expected-fail），三端 `npm test` 与 backend/agent-cli `tsc` 构建全部 exit 0。

## 汇总

| 编号 | 标题 | 位置 | 严重度 | 用户可见后果 |
|------|------|------|--------|--------------|
| BUG-1 | grep_search rg 分支把 `-` 开头的 pattern 当 flag：静默 0 命中 / 误报搜索失败 | `harness/tool/impl/grep-search-tool.ts:97` | 高 | 模型搜 `-n`、`--force` 等字面串得到「0 命中成功」，在错误前提下继续推进 |
| BUG-2 | 容器 read_bytes 把 0 字节文件判成读取失败 | `harness/container/docker-tool-router.ts:131` | 高 | docker 用户发送/编辑空文件（如 `touch` 的占位文件）必报「容器内文件读取失败」，host 模式却正常 |
| BUG-3 | 哨兵复制（copyFrom）在 headers 键未下发时静默丢弃源哨兵全部请求头 | `signal/watcher.service.ts:780-782` | 高 | 官方 CLI 文档示例复制的哨兵无凭据，401 错误页被当成正常基线，哨兵静默失效 |
| BUG-4 | 重试入口不消费 pendingCancels：提交前窗口的「停止」被静默吞掉 | `session/ws/streaming-ws-handler.ts:1577-1587` | 高 | FAILED 会话点「重试」后立刻点「停止」，任务照常全量执行 |
| BUG-5 | 容器 agent 重连后 connectionDead 永不清除：健康容器被强制重建 | `harness/container/container-registry.ts:639,648-652` | 高 | 一次通道抖动（已自动重连）后，下次工具调用把健康容器 stop+rm+run，shell/PTY/后台任务/MCP stdio 全部丢失 |
| BUG-6 | 工具结果摘要失败/超时语义失真（wait_subagents 谎报完成、ask_user 即时失败标成超时） | `session/util/tool-result-summarizer.ts:790-797,403-410` | 中 | 轨迹、活动记录、admin 会话详情读到失真摘要：30 分钟超时显示「已完成」 |
| BUG-7 | 搜索跳转「停驻判定」被不可聚焦点击永久卡住：切会话后输入框不再自动聚焦 | `desktop/src/composables/searchJumpFocus.ts:39-41` | 中 | 搜索跳转后点侧栏切会话，焦点停在顶栏搜索按钮上，键入无落点（0.0.471 引入回归） |
| BUG-8 | `/resume` 切入运行中会话后，等待期间排队的输入永不消费 | `agent-cli/src/repl/repl.ts:167-169,190-198,360-362` | 高 | 排队消息静默滞留；下一条消息提交后旧消息反被先行发出（乱序），全程无提示 |

与既有报告的关系：每条均已对照 `docs/code-review/` 全部既有文档查重（含 2026-10-02 / 11-04 对 grep 的两轮、2026-11-07 容器隔离 round1/2/4、2026-11-06 多端审批 review），均为未报告过的新问题。

---

## BUG-1【高】grep_search rg 分支：pattern 以 `-` 开头被 rg 当成命令行 flag

**位置**：`backend-ts/src/harness/tool/impl/grep-search-tool.ts:97`

```ts
cmd.push(pattern, scope.rgTarget);   // pattern 与目标路径之间没有 -e / -- 分隔
```

**触发条件 → 期望 vs 实际**：模型搜索以 `-` 开头的字面串/正则（搜 CLI 输出、diff、配置注释极常见：`-n`、`-i`、`-v`、`--force`）。期望按该 pattern 搜索；实际 rg 按 clap 约定把首个 `-` 开头参数解析为 flag：

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

## BUG-7【中】搜索跳转「停驻判定」被不可聚焦点击永久卡住（desktop，0.0.471 引入）

**位置**：`desktop/src/composables/searchJumpFocus.ts:39-41`；消费点 `desktop/src/components/chat/ChatInput.vue:1234`；触发面 `desktop/src/components/task/TaskSessionGroupList.vue:97-107`（`.session-item` 是**无 tabindex 的 div**）

**触发条件 → 期望 vs 实际**：让位窗口（jumpInFlight）会正常关闭；问题在第二个条件 `document.activeElement === searchToggle`——它以「焦点停在触发按钮」代理「用户尚未移焦」。但 Chromium 里**点击不可聚焦元素不移动 activeElement**，而搜索跳转后的最高频后续操作恰是点侧栏会话项（生产 DOM 是无 tabindex 的 div，点击不产生焦点迁移）：

1. 全局搜索跳转 → `restoreFocus()` 把焦点落到触发按钮；
2. 点侧栏另一会话 → activeElement 仍在触发按钮；
3. 会话切换联动最终汇入 `ChatInput.focusInput` → `shouldDeferFocusToSearchJump()` 仍 true → **直接 return**，输入框不聚焦、键入无落点；
4. 在用户点到任何可聚焦元素之前，**后续每一次切会话/新建态的自动聚焦都被静默吞掉**。

`searchJumpFocus.ts` 头注释声明的语义「用户一旦移焦，条件自然失效」在该路径上不成立。round2 review 的「无误伤」穷举只覆盖了可聚焦目标（其回归测试用 `<button>` 建模侧栏项），测试建模与生产 DOM 背离，恰好漏掉这条路径。

**验证证据**（真实形态实跑输出）：

```
AssertionError: expected true to be false // Object.is equality
```

jsdom 下对无 tabindex 的 div 派发 click 后，停驻判定仍返回 true。

**修复方向**：停驻态加一次性清除——「跳转完成后首次 pointerdown/keydown 即清除停驻判定」，或给停驻加短 TTL；只让「联动晚于 restoreFocus」的窄窗口受益。

---

## BUG-8【高】`/resume` 切入运行中会话后，等待期间排队的输入永不消费（agent-cli）

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

## 未列入正榜的候选（分区审查发现，未写验证用例，供后续复查）

以下候选经代码链路核实「结构与触发面成立」，但本轮未补存在性用例，不计入已验证结论：

| 候选 | 位置 | 置信度 | 摘要 |
|------|------|--------|------|
| 容器内单槽 currentEnvelope 最后写赢 | `container-tool-executor.ts:57,174-191`、`shell-session-manager.ts:518-524` | 中 | 同容器多会话并发时 envVars 串号（workspace 级变量）；11-04 的 envelopeRef 修复只防「提前清空」，不防「后到覆盖在途」 |
| 容器内 MCP stdio connect 无超时、失败不清理 | `container-mcp-bridge.ts:42-59`（对照宿主机 `mcp-client-manager.ts:24-25,66-83`） | 中低 | 挂死的 MCP server 每轮泄漏一个子进程，`--pids-limit 512` 下逐渐耗尽 |
| updateTask 换 cron 绕过 pendingOnceWork 不变量 | `schedule/scheduled-task.service.ts:438-457,791-795` | 中 | 一次性任务待重试期间换 cron：无条件开新档期，随后被旧档期重试链杀掉，新计划从不触发 |
| deleteSession 运行中拒删守卫是 check-then-act | `session/session.service.ts:645-653` | 中 | 锁后不复查相位，执行启动窗口内可删掉运行中会话（同文件 `promoteSideTaskToMainSession`:717-727 是正确写法） |
| POST 探针恒 chunked 且用户无法自救 | `signal/probe-client.ts:100-103` + `probe-validate.ts:12` | 中 | 对要求 Content-Length 的目标必败（411/400 → 连败停用，或错误页建假基线）；服务端明知 body 长度却不代填 |
| 失败退避用 MySQL NOW() 与 Node 时钟混用 | `signal/signal.repository.ts:215-226` vs `:142-151` | 中低（条件性） | MySQL 时区非 +08:00 时退避整体漂移 8h，`interval ≤ 4min` 的哨兵失败后被高频重试 |
| edit_file/write_file 混合行尾整文件归一 | `harness/tool/impl/file-eol.ts:11-13` + `edit-file-tool.ts:78-90` | 中低 | 只要含一行 CRLF，整文件（含 LF 行）被改写成 CRLF；file_change 行数与 git diff 严重不符 |
| SideChatPanel 收尾无条件 clearInput+clearDraft | `desktop/src/components/chat/SideChatPanel.vue:885-896,1040-1048` | 中高 | 等待上传/重连期间继续打字被静默清掉；主会话已有 `clearInputIfUnedited` 守卫，边路面板未跟进 |
| useChat.sendMessage 完成回调按「当前活跃会话」收尾 | `desktop/src/composables/useChat.ts:585-612` | 中 | 2026-10-13 以「无生产调用方」豁免，实际 `sendMessageWithQueue` 一直在生产调用；切会话后完成回调对 B 做非 preserve 重拉，丢已流出的回复 |
| 打印模式（text / 非 stream json）丢弃 `error` 帧内容 | `agent-cli/src/render/json-renderer.ts:24-28`、`text-renderer.ts:8-16` | 中高 | FAILED 终态无任何错误信息（stream-json 有 `case 'error'`，两个打印 renderer 落空），脚本消费方无法诊断 |
| 审批模态「已提交」态吞掉 Ctrl+C，回声永久丢失时无键盘逃生 | `agent-cli/src/tui/modal-controller.ts:250-251` + `ink-renderer.ts:279-289` | 中 | 投票上行后回声不到（后端在投票与回声间重启）时，收敛前数分钟内 Ctrl+C 完全无效，只能 Ctrl+\ / kill |
| `switchTo` markRead 等待窗口内旧会话相位帧回填 snapshotPhase | `agent-cli/src/session/session-runner.ts:263-316,480-491,737-738` | 中低（竞态） | 切换瞬间旧会话 eid-less `session_status` 在途 → `waitForSnapshot` 短路沿用旧相位：旧相位 RUNNING 时 REPL 卡在「续接当前输出」且 busy=true |
| MCP HTTP `tools/call` 无超时，与 stdio 路径（120s）口径分叉 | `agent-cli/src/local/tools/mcp.ts:269-293` | 低 | 病态 HTTP MCP server（持续 trickle body）可无限挂住，tool_result 永不上行 |

## 审查覆盖度与边界

- **已逐行通读**：harness/container 全部 12 个文件、harness/terminal、harness/tool（dispatcher/invocation/registry + 12 个内置工具）、harness/core（agent-loop/context-manager/compaction/no-progress）、session/ws/streaming-ws-handler（2814 行全文）、schedule、signal、approval、summarizer、desktop composables/chat 关键文件、agent-cli/src 约 30 个文件（重点 repl、session-runner、审批链、local tools、render）。
- **agent-cli 审批三路投票已核对无新问题**：`raceVoteAndEcho`/`finalizeApproval`/`submitApprovalVote` 无重复上行；`serializePayload` 二分截断终态有 maxBytes 兜底；read_file offset/limit、glob head_limit、edit_file replace_all 与云端同口径；frames 契约与 backend 一致。
- **已核查并排除**（避免重复投入）：容器快照链三轮修复（ba80b030/ea621d48/b2df53ba）未发现新缺口；agent-loop mergeToolCall 迟到 id 归并链完整；shell-session-tool 锁与 pendingCommand 生命周期自洽；no-progress 双侧口径一致；compaction 触发/溢出窗口未再混用模型窗口；file-write-lock 双 key 无死锁；recoverFailedSessions 并发防护修复成立；技能视图物化竞态已收口；跨通道接力（e2ae07a8）busy 检查点位正确；`/resume` 面板窗口、回挂、草稿态收口已被 2026-11-06 专项报告三轮覆盖且修复成立。
- 本报告全部条目已与既有 300+ 份 review 文档（2026-08-23 ~ 2026-11-07）逐条去重。
