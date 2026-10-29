# 逻辑 BUG 审查报告 · 第二轮（2026-10-29）

> 审查范围：本轮拉取的最新提交（8b876344 长文本消息文件化、2ff3a43e fetch 全部远端、c6a5cd81/0a275883 分支对比）+ agent-cli 本地运行时 + harness delegate/subagent 工具
> 审查方法：逐文件读源码（新拉取代码、agent-cli local 全模块、harness core/no-progress 双侧口径对比、shell 模块、usage 计价、task/feishu/dingtalk 工具），以「代码自身注释承诺的不变量 / 跨端同口径声明 / 对比路径」为证据链确认
> 验证方式：每个 BUG 编写「断言正确行为」的测试，测试失败即证明 BUG 真实存在；全部为**新增** BUG，与 `2026-10-29-logic-bug-audit.md`（第一轮）不重叠
> 测试文件：
> - `backend-ts/src/harness/tool/impl/background-subagent-tools.bugcheck.spec.ts`（5 个测试）
> - `agent-cli/test/local-shell-logic-bugs.spec.ts`（4 个测试）
>
> **修复状态（2026-10-30）**：BUG-R2-1 ～ R2-5 已全部修复（见 CHANGELOG 0.0.379），9 个验证测试现全部通过；文中"测试失败"的描述保留为审查时的历史证据。其中 BUG-R2-3c 测试随修复改写为「钳制上界」契约断言（原测试直接对 manager 断言 Infinity 行为，而修复点在工具层的换算与钳制）。

---

## 验证汇总

| 编号 | BUG 标题 | 文件 | 置信度 | 测试 |
|------|----------|------|--------|------|
| BUG-R2-1 | agent-cli read_file 的 offset/limit 用 `asInt` 截断小数，与云端 `asIntStrict` 口径分叉 | `agent-cli/src/local/tools/files.ts:261` | 高 | 2 个测试失败 |
| BUG-R2-2 | localShell `handleExec` 忽略 cd 结果，cd 失败后命令静默在旧目录执行 | `desktop/electron/localShell.cjs:722`、`agent-cli/vendor/localShell.cjs:722`（两份同源副本） | 高 | 1 个测试失败 |
| BUG-R2-3 | `wait_subagents` 超时校验两个数值洞：空串 → 0ms 即刻超时；1e308 → Infinity 永久阻塞 | `backend-ts/src/harness/tool/impl/background-subagent-tools.ts:213-220` | 高 | 3 个测试失败 |
| BUG-R2-4 | `cancel_subagent` 的 `Number(task_id)` 弱校验接受空串/布尔/数组 | `backend-ts/src/harness/tool/impl/background-subagent-tools.ts:181` | 高 | 2 个测试失败 |
| BUG-R2-5 | localShell `write_stdin`（无 pending 分支）漏调 `settleSession`，死会话占用会话数配额 | `desktop/electron/localShell.cjs:806-812`、`agent-cli/vendor/localShell.cjs`（同源） | 高 | 1 个测试失败 |

运行方法与输出见文末「附：验证测试运行方法」。第一轮报告的 5 个 BUG 在拉取最新代码后已复验，仍全部成立（`npx vitest run src/harness/core/logic-bug-audit.spec.ts` → 8 tests, 8 failed）。

---

## BUG-R2-1: agent-cli read_file 的 offset/limit 用 asInt 截断小数，与云端口径分叉

**文件**：`agent-cli/src/local/tools/files.ts` 行 260-266（关键行 261）

**错误代码**：
```ts
/**
 * 解析 offset / limit：只接受有限且非负的整数，与云端 read-file-tool.ts parseLineIndex 同口径。
 * ...
 */
function parseLineIndex(value: unknown, field: 'offset' | 'limit'): number {
  const n = asInt(value, Number.NaN);   // ← 用了 asInt（Math.trunc），不是 asIntStrict
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`参数 ${field} 必须是非负整数，收到 ${JSON.stringify(value) ?? String(value)}`);
  }
  return n;
}
```

**为何是 BUG**：

云端对照实现（`backend-ts/src/harness/tool/impl/read-file-tool.ts:157-164`）特意用 `asIntStrict` 并写明原因：
```ts
function parseLineIndex(value: unknown, field: 'offset' | 'limit'): number {
  // 严格整数：asInt 会 Math.trunc，1.5 会被当成 1、-0.5 会得到 -0 并绕过 n < 0。
  const n = asIntStrict(value, Number.NaN);
  ...
}
```

agent-cli 这个函数的 docstring 自述「**与云端 read-file-tool.ts parseLineIndex 同口径**」，实际却用了 `asInt`——恰恰是云端注释里警告过的那个缺陷函数。且 `agent-cli/src/local/tools/params.ts` 的头注释明确要求：「必须两侧一致：LOCAL 与 CLOUD 执行同一份 LLM 生成的参数，解析口径分叉会让同一输入在本地与云端得到不同结果」。

**实际行为差异**（同一份模型参数）：
| 输入 | 云端（CLOUD） | 本地（LOCAL / agent-cli） |
|------|--------------|--------------------------|
| `offset: 1.9` | 报错「必须是非负整数」 | `Math.trunc(1.9)=1`，静默从第 1 行读 |
| `limit: '2.5'` | 报错 | `Math.trunc(2.5)=2`，静默读 2 行 |
| `offset: -0.5` | 报错（asIntStrict 落 fallback NaN → 抛错） | `-0`：`Number.isInteger(-0)=true` 且 `-0 < 0` 为 false，**绕过负数校验**直接放行 |

**影响**：同一 read_file 调用在 CLOUD 与 LOCAL 返回不同结果（一端报错、一端返回部分内容），模型据以做出不同后续决策；与 `params.ts` 声明的硬性约束直接冲突。

**测试证据**（`agent-cli/test/local-shell-logic-bugs.spec.ts`）：
```
× BUG-R2-1: read_file 的 offset 应与云端同口径拒绝小数（1.9 不得截断成 1）
  expected undefined to deeply equal StringContaining "必须是非负整数"
× BUG-R2-1b: read_file 的 limit 传小数字符串应报错而非静默截断
  expected undefined to deeply equal StringContaining "必须是非负整数"
```

**修复建议**：`files.ts` 的 `parseLineIndex` 改用与云端相同的严格解析（`/^-?\d+$/` 整数字符串 + `Number.isSafeInteger`，或从 `json.ts` 同步一份 `asIntStrict` 到 `params.ts`），保持注释承诺的「同口径」。

---

## BUG-R2-2: localShell handleExec 忽略 cd 结果，cd 失败后命令静默在旧目录执行

**文件**：`desktop/electron/localShell.cjs:721-723`、`agent-cli/vendor/localShell.cjs:721-723`（`diff` 确认两份副本逐字节一致，desktop 是 agent-cli vendor 的同源拷贝）

**错误代码**：
```js
injectToken(session)
if (workdirArg && workdir) {
  await executeWithMarker(session, protocol.chdir(workdir), WORKDIR_TIMEOUT_MS)   // ← 返回值被丢弃
}
```

**为何是 BUG**：

云端对照实现（`backend-ts/src/harness/tool/impl/shell-session-tool.ts:191-203`）对同一个 cd 步骤做了完整判定：
```ts
if (workdirArg && workdir) {
  const cd = await this.executeWithMarker(session, 'cd ' + shellSingleQuote(workdir), WORKDIR_TIMEOUT_MS);
  if (!cd.completed) {
    // cd 超时：会话里残留未结束的协议命令、状态未知，关闭回收，…
    this.closeOwned(session);
    return errorJson(`工作目录切换超时：${workdir}`);
  }
  if (cd.exitCode != null && cd.exitCode != 0) {
    // cd 失败（目录不存在等）：命令绝不能仍在错误目录里静默执行
    return errorJson(`工作目录切换失败：${workdir}${...}`);
  }
}
```

云端的注释是明确的不变量承诺：「**命令绝不能仍在错误目录里静默执行**」。LOCAL 侧的 localShell.cjs（desktop Electron 与 agent-cli 共用同一份运行时代码）丢弃了 `executeWithMarker` 的返回值：cd 失败（目录不存在）时 bash 打印错误、继续执行下一条 `echo <marker>`，读取器照常拿到 completed 结果——随后主命令在**旧工作目录**里执行并返回 `exit_code: 0`。

**实测证据**（一次性探针，复现于 macOS + bash）：
```json
// 请求：{ action: 'exec', command: 'pwd', session_id: 'sh-1-…', workdir: '<dirA>/no-such-dir-r2' }
{
  "exit_code": 0,
  "output": "/var/folders/…/mao-probe-a-e39SJh\n",     ← dirA，即上一条命令的旧目录
  "completed": true,
  "current_workdir": "/var/folders/…/mao-probe-a-e39SJh"
}
```

**触发条件**：模型在已有会话上执行 `shell { command, workdir: <不存在/拼写错误的目录> }`（会话复用时 spawn 不会因 cwd 失败，cd 才是失败点）。cd 超时（挂起的网络盘等）同理被忽略：云端会关会话报错，LOCAL 照常往卡住的会话里追加命令，输出交织。

**影响**：LOCAL 模式下模型以为命令在目标目录执行，实际跑在旧目录——构建/测试结果与目录错位，模型基于错误的 cwd 做后续分析；同一输入在 CLOUD 报错、在 LOCAL 假成功，违反跨端同口径。

**测试证据**（`agent-cli/test/local-shell-logic-bugs.spec.ts`，真实 bash 集成测试）：
```
× BUG-R2-2: exec 的 workdir 不存在时应报错，不得静默在旧目录执行命令
  expected undefined to be defined
```

**修复建议**：localShell.cjs 的 `handleExec` 在 cd 后补齐与云端一致的判定（`!cd.completed` → 关会话 + 报「工作目录切换超时」；`cd.exitCode !== 0` → 报「工作目录切换失败」），并同步到两份副本（desktop/electron 与 agent-cli/vendor）。

---

## BUG-R2-3: wait_subagents 超时校验两个数值洞（空串 → 0ms；1e308 → Infinity 永久阻塞）

**文件**：`backend-ts/src/harness/tool/impl/background-subagent-tools.ts:213-220`（WaitSubagentsTool），配合 `backend-ts/src/harness/delegate/background-subagent-manager.ts:254-270`（waitForAll）

**错误代码**：
```ts
const rawTimeoutSeconds = args && args.timeout_seconds != null ? args.timeout_seconds : DEFAULT_WAIT_SUBAGENTS_TIMEOUT_SECONDS;
const timeoutSeconds = Number(rawTimeoutSeconds);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) return errorJson('参数 timeout_seconds 必须是非负数字');
…
const waitResult = await this.manager.waitForAll(
  sessionId,
  this.getCancelFlag?.(sessionId) ?? null,
  timeoutSeconds * 1000,        // ← 1e308 * 1000 = Infinity
);
```

**为何是 BUG**（两个独立洞，同一行校验）：

1. **空串变 0**：`timeout_seconds: ''` → `Number('') = 0` → `0 >= 0` 通过校验 → `waitForAll(…, 0)` 的 deadline 立即到期 → 工具**不等待任何子代理**、马上返回 `timed_out: true`。本仓库 `asInt` 的惯例（`agent-cli/src/local/tools/params.ts`、`backend-ts/src/harness/tool/json.ts`）对空串显式回落默认值；`''` 显然不是「非负数字」，却既没回落默认 1800s 也没报错，而是变成 0。
2. **有限数乘 1000 溢出为 Infinity**：`timeout_seconds: 1e308` 通过 `Number.isFinite` 校验，但 `1e308 * 1000 = Infinity`。`waitForAll` 里 `deadline = Date.now() + Infinity = Infinity`，`remaining = Infinity - Date.now()` 永远 `> 0`，`sleep(Math.min(300, Infinity))` 永久循环——校验自己防的「无限等待」被自己的换算绕开了。工具 schema 说「默认最多等待 30 分钟」，该输入使等待上界完全失效；只要有一个子代理挂住，整个 agent 循环的这轮工具调用就无限期阻塞（仅能靠用户取消 rescue）。

**影响**：模型误传空串/极大值（模板填充、幻觉数字都可能出现）时，要么瞬时假超时（子代理结果丢失，`waitResult.timedOut` 还附带 `progress` 快照诱导模型重试轮询），要么永久阻塞执行。

**测试证据**（`backend-ts/src/harness/tool/impl/background-subagent-tools.bugcheck.spec.ts`）：
```
× BUG-R2-3: wait_subagents 的 timeout_seconds 传 1e308 不得放大成 Infinity 超时
  expected false to be true                       ← 下发给 waitForAll 的毫秒超时是 Infinity
× BUG-R2-3b: wait_subagents 的 timeout_seconds 传空串应回落默认 30 分钟而非 0ms
  expected +0 to be 1800000                       ← 下发的是 0
× BUG-R2-3c: waitForAll 收到 Infinity 超时会永久阻塞（影响证明）
  expected 'still-waiting' to be 'returned'       ← 500ms 后仍卡在等待循环
```

**修复建议**：入参解析复用 `asInt`（空串/非数字自然回落默认），并在换算后钳制上界（如 `Math.min(timeoutSeconds * 1000, 24 * 60 * 60 * 1000)`）或校验 `Number.isSafeInteger`；两处一起改才能同时堵住 0 与 Infinity 两个洞。

---

## BUG-R2-4: cancel_subagent 的 Number(task_id) 弱校验接受空串/布尔/数组

**文件**：`backend-ts/src/harness/tool/impl/background-subagent-tools.ts:180-182`（CancelSubagentTool）

**错误代码**：
```ts
const args = parseObject(argumentsJson);
if (!args || args.task_id == null) return errorJson('缺少必填参数: task_id');
const taskId = Number(args.task_id);            // ← Number('') = 0、Number(false) = 0、Number([]) = 0、Number([5]) = 5
if (!Number.isInteger(taskId)) return errorJson('参数 task_id 必须是整数');
return toJson(await this.manager.cancel(sessionId, taskId));
```

**为何是 BUG**：

`task_id == null` 挡不住空串/布尔/数组，而 `Number()` 对它们的转换全部通过 `Number.isInteger`：
- `Number('') = 0`、`Number(false) = 0`、`Number([]) = 0` → 以 `taskId = 0` 调用 `manager.cancel(sessionId, 0)`，`findById(0)` 必然落空，回传误导性的「后台子代理不存在或不属于当前会话: 0」；
- `Number([5]) = 5` → **类型混淆的入参被当成真 id**，直接取消了 #5 号子代理。

同仓库 `task-tools.ts:193-198` 对同一类问题已有成熟修法并在注释里写明教训：「Number(null)/Number('')/Number([]) 都是 0，能通过 Number.isFinite 校验，把『待办 #0』当成真实任务回报假成功。asIntStrict 对 null/''/非数字/小数回落 0，配合 > 0 显式校验一并拒掉」——`CancelSubagentTool` 没有套用同一口径。schema 声明 `task_id` 是 `integer`，`''`/`false`/`[]` 都不是整数。

**影响**：校验失效。轻则以 taskId=0 查询出误导性错误，重则 `[5]` 这类错误入参真实取消了一个子代理（`manager.cancel` 内部会置取消标记并等待终态）。

**测试证据**：
```
× BUG-R2-4: cancel_subagent 应拒绝空串/布尔/数组形式的 task_id
  expected undefined to deeply equal StringContaining "必须是整数"   ← 无 error，工具继续执行
× BUG-R2-4b: cancel_subagent 的 task_id 数组 [5] 不得被 Number() 静默转成 5
  expected undefined to deeply equal StringContaining "必须是整数"
```

**修复建议**：改用 `asIntStrict(args.task_id, 0)` 并加 `> 0` 校验（与 task-tools 同口径），非整数类型一律报「参数 task_id 必须是整数」。

---

## BUG-R2-5: localShell write_stdin（无 pending 分支）漏调 settleSession，死会话占用配额

**文件**：`desktop/electron/localShell.cjs:806-812`、`agent-cli/vendor/localShell.cjs`（同源副本）

**错误代码**（vendor 的 handleWriteStdin 尾部）：
```js
  injectToken(session)
  // 输入本身不带结束标记，必须额外回显 marker，否则只能空等到超时
  const marker = newMarker()
  writeCommand(session, input, marker, true, false)
  const result = await readUntilMarker(session, marker, yieldTimeMs, waitFor)
  const currentWorkdir = await resolveCurrentWorkdir(session, result)
  return formatExecResult(session, result, currentWorkdir)      // ← 没有 settleSession
}
```

**为何是 BUG**：

输入含 `exit`/`exec` 时 bash 直接退出，marker 永远不会出现，`readUntilMarker` 走「进程已死」分支返回 `completed: true, shellExited: true`。此时返回 payload 的文案是「shell 进程已退出，**会话已关闭**」，但代码从未调用 `settleSession`——死会话仍留在 `sessions` Map 里，继续占用 `maxSessionsPerConversation`（30）配额，最长 60s 后才被 `cleanupExpiredSessions` 周期兜底回收。

云端对照实现（`backend-ts/src/harness/tool/impl/shell-session-tool.ts:343-349`）对同一分支**专门修过这个问题**并留下注释：
```ts
// 与 exec / pending 分支一致：输入含 exit 让 bash 退出时必须回收会话，
// 否则返回文案说「会话已关闭」而死会话仍占着会话数配额。
this.settleSession(session, result, true);
```
vendor 文件内部也不一致：`handleExec`（739 行）与 `handleAwaitAsync`（768 行）都调用了 `settleSession`，唯独 `write_stdin` 的无 pending 分支漏掉——是遗漏而非设计。

**影响**：模型在 LOCAL 会话里用 `write_stdin` 交互式执行并以 `exit` 结束（常见模式）时，每个死会话占住配额最长 60s；脚本化场景下连续创建+退出 30 个会话即触发「Maximum number of shell sessions (30) reached」假性配额耗尽。

**测试证据**（真实 bash 集成测试）：
```
× BUG-R2-5: write_stdin 触发 bash 退出后死会话应被立即回收
  expected 1 to be +0        ← write_stdin 'exit' 后 getActiveSessionCount() 仍为 1
```

**修复建议**：在返回前补 `settleSession(session, result, true)`（与同文件另两个分支及云端实现对齐），并同步两份副本。

---

## 本轮排除项（查过、有证据、不成立）

为避免误报，以下候选经查证后**主动排除**：

- **`no-progress-notice` 扫描与运行时 guard 口径分叉**：逐分支对比（全豁免轮重置、不完整轮跳过、nudgedAt 清理时机、锚点取最后一个 tool_call_id），语义一致；
- **`dump_user_messages` 新工具四处同步**：SERVER_ONLY_TOOLS（tool-dispatcher.ts:73）、toolDisplay 名称/预览、tool-result-summarizer、no-progress-notice（有意保留路径、有测试背书）全部就位；47 个注册工具机械化交叉核对无遗漏；
- **`glob-search` head_limit 拒绝数字字符串**：`file-tools.spec.ts:548` 明确断言该行为（`'2'` 必须报错），是有测试背书的既定口径；
- **`getRecentUserMessages` 批式游标扫描**：break 条件、beforeId 推进、reverse 语义均正确；
- **`cost-micros` 计价**：token 钳制、缺价整行 NULL、整数域范围分析均无问题；
- **`String(createdAt).slice(0,10)` 取日期**：DB 连接全局 `dateStrings: true`，输入恒为 `YYYY-MM-DD HH:mm:ss` 字符串；
- **`agent-cli` truncate.ts 转义感知预算 / sandbox.ts / approval.ts / executor.ts 审批链**：逐函数推演无缺陷；
- **localShell 并行 await_async「伪造 exit_code:0」路径**：推演所有微任务交错后不可达（第一调用方在恢复后同步完成整个读取），仅留下「等待满 yield 超时才报『已被并行调用收取』」的延迟问题，不构成独立 BUG。

---

## 附：验证测试运行方法

```bash
# 后端（BUG-R2-3 / R2-4）
cd backend-ts && npx vitest run src/harness/tool/impl/background-subagent-tools.bugcheck.spec.ts
# 当前：5 tests, 5 passed（审查期间 5 failed）

# agent-cli（BUG-R2-1 / R2-2 / R2-5，R2-2 与 R2-5 为真实 bash 集成测试）
cd agent-cli && npx vitest run test/local-shell-logic-bugs.spec.ts
# 当前：4 tests, 4 passed（审查期间 4 failed）
```

审查期间 BUG-R2-3c 直接对 `BackgroundSubagentManager.waitForAll` 断言 Infinity 超时行为以证明影响链；修复落在工具层的换算与钳制后，该测试改写为断言工具输出被钳制到 24h 上界。

第一轮报告的复验：`npx vitest run src/harness/core/logic-bug-audit.spec.ts` 在拉取最新代码后 8/8 失败（5 个 BUG 均仍存在），两轮修复后全部通过。
