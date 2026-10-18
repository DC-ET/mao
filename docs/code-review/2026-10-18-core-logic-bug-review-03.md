# 2026-10-18 核心逻辑 BUG 审查（第 3 轮）

- 审查方式：源码通读 + **每个 BUG 均编写临时 spec 实际运行验证**，只收录跑出失败/越界行为的项；证伪候选统一列入「已排除」。
- 验证环境：`backend-ts`（Vitest）、`desktop`（Vitest + Pinia）。所有临时 spec 已删除，未修改任何源码或已有 spec。
- 结论：**确认 6 个真实功能逻辑 BUG**（后端 4 + 前端 2），其中 high 1 个、medium 5 个。**6 项已于 0.0.307 全部修复**，回归测试同批落地。
- 本轮修订（相对初稿）：初稿的「BUG 2 `filteredToolCallIds` 跨会话静默吞结果」经逐路径复现证伪——其成立前提（`tool_call_start` 被吞而 `tool_call_result` 通过）与 WS 帧门控的实现矛盾，已移入「已排除」并附证伪过程；其余 6 项均以本轮实测输出复核，结论不变。
- 后续修订：6 项全部修复完成（`CHANGELOG.md` 0.0.307），下文各节的「修复建议」已同步为「修复方式」并附回归测试落点。

## 结论表

| # | 严重级 | 位置 | 一句话现象 | 状态 |
|---|---|---|---|---|
| 1 | high | `backend-ts/src/harness/tool/impl/read-file-tool.ts:68` | `read_file` 不剥 BOM，带 BOM 文件的首行把 `\uFEFF` 泄漏给模型，模型据此编辑必然失败 | 已修复（0.0.307） |
| 2 | medium | `backend-ts/src/harness/tool/impl/read-file-tool.ts:66-67` | 负/零 `limit` 静默返回空 content 且不带 `error`，被判为「文件是空的」 | 已修复（0.0.307） |
| 3 | medium | `backend-ts/src/session/util/tool-result-summarizer.ts:253,279,297,310,319` | 文件/搜索类工具失败态在摘要里显示为成功，「0 处匹配」掩盖正则非法 | 已修复（0.0.307） |
| 4 | medium | `backend-ts/src/signal/watcher.service.ts:379,430` | 哨兵触发失败时落两行 check，且基线 hash 不推进导致同值反复触发 | 已修复（0.0.307） |
| 5 | medium | `backend-ts/src/schedule/scheduled-task.service.ts:908` | once 任务 PAUSED 期间收尾不收口，重新启用后会再跑一次 | 已修复（0.0.307） |
| 6 | medium | `desktop/src/utils/file-manager.ts:132-141` | `formatSize` 跨档四舍五入，显示 `1024 KB` / `1024 GB` | 已修复（0.0.307） |

---

## BUG 1【high】`read_file` 不剥离 BOM，带 BOM 文件无法按所见文本编辑

**位置**：`backend-ts/src/harness/tool/impl/read-file-tool.ts:68`

```ts
const allLines = splitLines(readFileSync(filePath, 'utf8'));
```

对比 `write-file-tool.ts:55` 与 `edit-file-tool.ts:76`——两侧都调了 `stripBom(raw)`，唯独读取侧没有。`file-eol.ts:3` 的注释自称与 agent-cli `local/tools/files.ts:266`（`splitLines(stripBom(...))`）「同语义」，实际读取侧并未对齐。

**错误输入**：`{"path":"bom.txt"}`，文件内容 `\uFEFFalpha\nbeta\ngamma\n`（UTF-8 with BOM + LF）

| | 预期 | 实际 |
|---|---|---|
| `content` | `"alpha\nbeta\ngamma"` | `"\uFEFFalpha\nbeta\ngamma"` |

**根因**：读取侧未走同目录 `file-eol.ts` 已导出的 `stripBom`。CLOUD 与 LOCAL 两条实现在同一文件上返回不同 `content`。

**影响场景（已实测的连锁故障）**：模型把 `read_file` 展示的首行 `"\uFEFFalpha"` 原样复制进 `old_string` 调 `edit_file`，得到 `{"success":false,"error":"文件中未找到 old_string"}`——因为 `edit-file-tool.ts:76` 匹配前做了 `stripBom`，磁盘上没有 BOM，模型给的字符串里却有。编辑必然失败且报错无法指向真实原因。同一文件 LOCAL 模式可编辑、CLOUD 模式不可编辑，行为分裂。

**复现测试**（临时 spec，已删除）：对 `\uFEFFalpha\nbeta\n` 断言 `content === 'alpha\nbeta'`，并以读到的首行作为 `old_string` 走一遍 `edit_file`。

**运行结果**：

```
read_file content 首字符 = \uFEFF      ← 断言失败（预期 alpha）
edit_file => {"success":false,"replacements":0,"error":"文件中未找到 old_string"}
 Test Files  1 failed (1)
```

**修复方式**（0.0.307）：`read-file-tool.ts:68` 改为 `splitLines(stripBom(readFileSync(filePath, 'utf8')))`，与 agent-cli 及本目录写回侧对齐。回归测试落点 `file-tools.spec.ts` 的 `strips the BOM so read and edit agree on the first line`——覆盖 read→edit 往返与「写回仍保留原 BOM/CRLF」；`keeps a BOM-only first line from shifting the line count` 锁定 BOM-only 文件与空文件同口径。既有 spec `file-tools.spec.ts:210` 只覆盖了「写回保留 BOM」一侧，读取侧此前无任何 BOM 断言，属覆盖盲区。

---

## BUG 2【medium】`read_file` 负/零 `limit` 静默返回空内容，被判为「文件是空的」

**位置**：`backend-ts/src/harness/tool/impl/read-file-tool.ts:66-67`

```ts
const offset = args && 'offset' in args ? Math.max(0, asInt(args.offset, 0)) : 0;
const limit = args && 'limit' in args ? Math.max(0, asInt(args.limit, Number.MAX_SAFE_INTEGER)) : Number.MAX_SAFE_INTEGER;
```

`Math.max(0, ...)` 把负数钳到 0，`asInt`（`harness/tool/json.ts:17-24`）对不可解析值回落 `Number.MAX_SAFE_INTEGER`（读全文件）——同一个非法入参族有三种互相矛盾的口径。

**错误输入 A**：`{"path":"big.txt","limit":-5}`，文件 100 行
**预期**：报错，或至少不返回空 content
**实际**：`{"content":"","total_lines":100}`——无 `error` 键，`normalizeToolResult` 判为 **success**

**错误输入 B**：`{"path":"big.txt","limit":0}`，文件 3 行
**实际**：`{"content":"","total_lines":3}`，同样被判 success

**根因**：`Math.max(0, asInt(...))` 只钳制不校验，负值静默坍缩为 0 行窗口；返回值不带 `error` 键，绕过 `tool-result.ts:60-66` 的失败判定。

**影响场景**：模型偶发输出负数 `limit`（或把 `limit` 与别的字段混淆）时，拿到「空 content + success + total_lines=100」。上下文里没有行内容也没有失败标记，模型极易推断「该文件为空」，进而用 `write_file` 整体覆写清空它——数据丢失。agent-cli `local/tools/files.ts:264-265` 的注释明确写过这个动机（「返回空 content 会让模型误判文件为空，进而在 write_file 里整体覆写清空它」），但只防了「非法回落」一侧，没防「合法但为零/负」这一侧。

**复现测试**（临时 spec，已删除）：100 行文件分别以 `limit:-5` / `limit:0` / `limit:'abc'` 调用，断言 content 非空或带 error 键。

**运行结果**：

```
limit:-5  => {"content":"","total_lines":100}   status=success
limit:0   => {"content":"","total_lines":3}     status=success
limit:abc => content 长度 1400+（读全文件）
 Test Files  1 failed (1)
```

**修复方式**（0.0.307）：`read-file-tool.ts` 新增 `parseLineIndex(value, field)`，只接受有限且非负的整数，非法值抛错并由 `executeWithWorkspace` 的既有 catch 转成 `readError`（带 `error` 键，下游据此判失败态）。`limit === 0` 仍是合法空窗，不报错。回归测试落点 `file-tools.spec.ts`：`rejects a negative limit instead of silently returning an empty window`、`rejects a negative offset and a non-numeric limit`、`treats limit 0 as a legal empty window without erroring`。

---

## BUG 3【medium】工具结果摘要对文件/搜索类工具的失败态完全不可见

**位置**：`backend-ts/src/session/util/tool-result-summarizer.ts:253`（`summarizeReadFile`）、`:279`（`summarizeWriteFile`）、`:297`（`summarizeEditFile`）、`:310`（`summarizeGlobSearch`）、`:319`（`summarizeGrepSearch`）

五个函数均无 `has(node,'error')` 分支（以 read 为例）：

```ts
const node = asObj(parseJson(result));
if (!node) return `读取 ${displayPath}`;
const totalLines = has(node, 'total_lines') ? Number(node.total_lines) : 0;
...
return `读取 ${displayPath} (${totalLines} 行)`;   // 错误结果走到这里
```

对照组：同文件 `:230-243`（`summarizeShell`）、`:186-196`（`summarizePageTool`）都有失败分支，说明模式在仓库内是既有约定。

**错误输入与实测输出**：

| 工具 | result（真实失败形状） | 预期 | 实际 |
|---|---|---|---|
| `read_file` | `{"content":"错误：文件不存在","error":"...","total_lines":0}` | `读取 missing.ts (失败)` | `读取 missing.ts` |
| `read_file`（带 offset/limit） | 同上 | `读取 a.ts (失败)` | `读取 a.ts (0~10行)` |
| `edit_file` | `{"success":false,"replacements":0,"error":"old_string 在文件中出现 2 次…","occurrences":2}` | `编辑 a.ts (失败)` | `编辑 a.ts` |
| `write_file` | `{"success":false,"bytes_written":0,"error":"EACCES: permission denied"}` | `写入 etc/passwd (失败)` | `写入 etc/passwd` |
| `glob_search` | `{"files":[],"error":"Search path does not exist"}` | `搜索文件 (失败)` | `搜索文件 (0 个文件)` |
| `grep_search` | `{"matches":[],"error":"ripgrep 搜索失败（exit 2）"}` | `搜索内容 (失败)` | `搜索内容 (0 处匹配)` |

**复现测试**（临时 spec，已删除）：6 个失败形状 + 4 个对照组。

**运行结果**：

```
S1=读取 a.ts
S2=编辑 a.ts
S3=写入 a.ts
S4a=unknown_tool (错误)          ← 对照组：generic 分支能识别
S4b=点击页面元素 (失败: 元素不存在)  ← 对照组：page 分支能识别
S4c=搜索 q (0 条结果)
S4d=打开网页
S5 status=error err=错误：文件不存在：a.ts   ← normalizeToolResult 已正确判 error，仅摘要丢失
 Test Files  1 passed (1)
```

（测试按当前实际行为编写以固化证据，全部 passed；对照组证明缺陷只在这五个函数。）

**根因**：`summarize` 的 switch 对文件/搜索类工具只解析成功字段（`total_lines`/`files`/`total_matches`/`file_change`），没有像 `summarizePageTool` 那样先查 `error` 键。`ws-streaming-event-listener.ts:133-146` 把 `summary` 同时发给前端卡片并写入 `activity.summary`，而 `status` 是从 `meta` 单独取的——摘要文本与状态字段因此脱节。

**影响场景**：模型路径写错、`edit_file` 匹配歧义、grep 正则非法、rg 崩溃——这些最高频的工具失败，在会话摘要、运行轨迹（`run-trace`）与活动流里全部显示成一次正常的「读取 X」「编辑 X」「搜索内容 (0 处匹配)」。用户巡检轨迹时无法从摘要区分成功与失败；「0 处匹配」还会被误读为「搜过了，确实没有」，而真实原因是正则非法导致搜索从未执行。

**修复方式**（0.0.307）：`tool-result-summarizer.ts` 新增共享辅助 `failureSuffix(node)`（`has(node,'error')` 时返回 ` (失败: ${truncate(String(node.error),40)})`），五个函数在解析成功字段前统一判失败态，复用 `summarizePageTool` 的既有写法。回归测试落点 `session-utils.spec.ts`：`surfacesFailuresForFileAndSearchTools`（6 个失败形状，含「带 offset/limit 的读取失败也不得退回区间文案」）、`doesNotMarkSuccessfulFileToolResultsAsFailed`（成功形状不被误加后缀）、`truncatesLongErrorMessagesInTheSummary`。

---

## BUG 4【medium】signal watcher 触发失败时落两行 check，且基线 hash 永不推进

**位置**：

- `backend-ts/src/signal/watcher.service.ts:379` — `await this.deps.checkRepo.markChanged(checkId);`
- `backend-ts/src/signal/watcher.service.ts:430` — `await this.recordFailure(watcher, failure, result.httpStatus, result.durationMs);`
- 对比：成功分支 `:417-423` 才 `markChecked({ lastValueHash: valueHash, ... })`

```ts
// 变化：先写 changed 标记，再判频次上限
await this.deps.checkRepo.markChanged(checkId);
...
if (sessionId != null) {
  await this.deps.checkRepo.markTriggered(checkId, sessionId);
  await this.deps.watcherRepo.markChecked(watcher.id, { lastValueHash: valueHash, ... });
  return;
}
// 触发失败：只 recordFailure，不复用已落的 check 行，也不推进 lastValueHash
await this.recordFailure(watcher, failure, result.httpStatus, result.durationMs);
```

**错误输入**：watcher `lastValueHash='oldhash'`、`intervalMinutes=60`、`compareMode='HASH'`、`status='ACTIVE'`；探针返回 `body='new-body'`（判定值变化）；`openRun.run()` 抛 `Error('budget blocked')`（预算 BLOCK / Agent 停用 / 会话创建失败均可）。

| | 预期 | 实际 |
|---|---|---|
| check 行数 | 1 行（`changed=1`，`error` 记失败原因，`triggered_session_id=null`） | **2 行**：第一行 `changed=1, error=null`（`markChanged` 已写），第二行 `changed=0, error='budget blocked'`（`recordFailure` 内 `existingCheckId` 默认 null → 新建） |
| 基线 hash | 推进到新值 | 仍是 `oldhash`，下一轮同值再次判为「变化」 |

**复现测试**（临时 spec，已删除）：mock 依赖后跑 1 轮与 3 轮。

**运行结果**：

```
W1 checks=2 openRunCalls=1
  check#100 changed=1 error=null triggered=null
  check#101 changed=0 error="budget blocked" triggered=null
  baselineHash=oldhash
W2 polls=3 checks=6 openRunCalls=3
  baselineHash=oldhash failures=0
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

（断言按当前实际行为编写以固化证据。）

**影响场景**：① 哨兵轮询记录列表一次失败显示两行（一行黄色「变化」无触发链接、一行红色「失败」），轮询次数虚高且两行自相矛盾。② 失败原因持续性时（预算 BLOCK、Agent 停用、目标会话创建失败），目标值不变 → 每轮都判为「变化」→ 每轮都重新发起 `openRun.run()`。虽有退避（`interval * min(2^failures, 32)`）与 5 次失败自动停用兜底，但 `intervalMinutes=1` 时前 5 轮间隔为 1/2/4/8/16 分钟，期间重复触发 5 次 Agent 运行（5 个会话 / 计费），每次都重复插两行 check。

**修复方式**（0.0.307）：触发失败分支改为「先 `markCheckError(checkId, failure)` 把失败原因补在同一行，再 `markChecked` 把 `lastValueHash` 推进到本次读到的值（`lastChangedAt` 保持原值——这一次没有真正通知用户），最后 `recordFailure(..., checkId)` 传入已落的 checkId」。两处都做了：既消除双行，也消除同值反复触发。回归测试落点 `watcher.service.spec.ts` 的 `reuses the check row and advances the baseline when the trigger fails`——断言只落 1 行、`changed=1`、`error` 含失败原因、基线 hash 推进到 `sha256('new-body')`、`lastChangedAt` 未被刷新，并追加第二轮同值轮询验证不再触发。

---

## BUG 5【medium】`settleQueuedExecution` 对 PAUSED 的一次性任务不收口，重新启用后会再跑一次

**位置**：`backend-ts/src/schedule/scheduled-task.service.ts:908`

```ts
if (task.once === 1 && task.status === 'ACTIVE') {
  if (status === 'CANCELLED') { patch.finished = 0; ... }
  else if (status === 'COMPLETED' || (status === 'FAILED' && !willRetry)) { patch.finished = 1; ... }
  else if (status === 'FAILED' && willRetry) { patch.finished = 0; ... }
}
```

**错误输入**：`once=1`、`cronExpression='0 * * * * *'`、`status='PAUSED'`、`finished=0`、`nextFireTime=null`，存在一条 `status='QUEUED'` 的 run（busy 入队后用户暂停任务，队列消息随后执行到终态）。调用 `settleQueuedExecution(1, 'COMPLETED')`。

| | 预期 | 实际 |
|---|---|---|
| 收口 | `finished=1`、`nextFireTime=null` | `status !== 'ACTIVE'` 导致整个 once 分支被跳过，只写 `lastExecutionStatus='COMPLETED'`；任务停在 `finished=0`、`nextFireTime=null` |

**根因**：once 收口条件把 `task.status === 'ACTIVE'` 与 `task.once === 1` 耦合。暂停只是用户侧「别再开新档」，不应影响「已在队列里的这一档是否算跑完」。

**影响场景**：定时任务「一次性」+ 会话 busy 入队 + 排队期间被暂停 + 队列消费到终态 → 任务既不在列表显示「已完结」也无档期；用户之后从 PAUSED 重新启用（`updateTask(..., status='ACTIVE')`）时 `reactivate` 分支命中（`scheduled-task.service.ts:448-458`，判据是 `nextFireTime == null && status === 'ACTIVE'`，与 `finished` 无关）→ 重开下一档 → **once 任务被执行第二次**，once 语义被打破。CANCELLED 同样不收口。已有 spec `scheduled-task.service.spec.ts:834-868` 只覆盖 `status='ACTIVE'` 一种组合（该组合下行为正确）。

**复现测试**（临时 spec，已删除）：断言按正确语义编写，含 ACTIVE 对照组。

**运行结果**：

```
S1 once+PAUSED -> COMPLETED : status=PAUSED finished=0 nextFireTime=null lastExecutionStatus=COMPLETED
S2 once+PAUSED -> CANCELLED : status=PAUSED finished=0 nextFireTime=null lastExecutionStatus=CANCELLED
S3 once+ACTIVE -> COMPLETED : status=ACTIVE finished=1 nextFireTime=null   ← 对照组：ACTIVE 口径正确
S4 once+PAUSED -> FAILED(可重试) : status=PAUSED finished=0 nextFireTime=null
 Tests  4 passed (4)
```

（按当前实际行为编写以固化证据；S3 证明缺陷只在 PAUSED 组合。）

**修复方式**（0.0.307）：once 收口判据从 `task.once === 1 && task.status === 'ACTIVE'` 改为只看 `task.once === 1`；`status` 降级为只决定「取消时是否重开档期」——`CANCELLED` 且 `status === 'ACTIVE'` 才 `calculateNextFireTime`，PAUSED 下置 `nextFireTime = null`。`COMPLETED` / 重试耗尽的 `FAILED` 一律置 `finished=1`。回归测试落点 `scheduled-task.service.spec.ts`：`settles a paused one-shot task instead of leaving it to re-run`（PAUSED + COMPLETED 收口）、`settles a paused one-shot task on CANCELLED without reopening a slot`（PAUSED + CANCELLED 不重开档期）、`still reopens the next slot for an active one-shot task on CANCELLED`（ACTIVE 对照组，行为不变）。

---

## BUG 6【medium】`formatSize` 单位跨档四舍五入，显示 `1024 KB` 而非 `1.0 MB`

**位置**：`desktop/src/utils/file-manager.ts:132-141`

```ts
let value = bytes / 1024
let i = 0
while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
```

**根因**：循环退出条件是 `value >= 1024`，展示层对 `value >= 100` 用 `Math.round`。退出循环时 `value ∈ [100, 1024)`，`Math.round` 可进位到 `1024`，与 `while` 的判档阈值脱节。项目内另一处同类函数 `usageFormat.ts` 的 `pickTokenUnit` 已专门处理该边界（`abs / divisor >= 999.95` 时升档，注释「读数不出现 1000K 这种跨档数字」），此处遗漏。

**错误输入 / 预期 / 实际**：

```ts
formatSize(1023.5 * 1024)        // 1_048_064 B
// 预期：'1.0 MB'    实际：'1024 KB'
formatSize(1023.96 * 1024 ** 3)
// 预期：'1.0 TB'    实际：'1024 GB'
```

**复现测试**（临时 spec，已删除）：2 个边界用例 + 边界扫描 + 常规用例对照。

**运行结果**：

```
E1 formatSize(1023.5*1024) = 1024 KB
E2 formatSize(1023.96*1024**3) = 1024 GB
E3 1048064 => 1024 KB      1048524.8 => 1024 KB      1048565.76 => 1024 KB
E3 1048576 => 1.0 MB       1099511627776 => 1.0 TB    1125888911726346 => 1024 TB
E4 0 => 0 B   1 => 1 B   1023 => 1023 B   1024 => 1.0 KB   1536 => 1.5 KB
E4 1048576 => 1.0 MB   104857600 => 100 MB   1047527424 => 999 MB
```

（E4 证明常规区间全部正确，越界只发生在 `[1023.5, 1024)` 这一段窄窗口。）

**影响场景**：文件管理器/文件树对体积恰在单位上限附近的文件显示 `1024 KB` / `1024 GB`，属可见的展示错误。已有 `file-manager.test.ts:203` 只覆盖到 `100 MB`，未触及该边界。评 medium：不影响功能与数据，仅展示越界，但用户可轻易撞见（大文件常见）。

**修复方式**（0.0.307）：`file-manager.ts` 的 `formatSize` 在展示前按 `Math.round` 的实际进位点再判一次档——`if (value >= 1023.5 && i < units.length - 1) { value /= 1024; i++ }`。阈值取 `1023.5` 而非 `1000`：`1000` 会把 `1000~1023.4` 这段本应显示「1000 KB」~「1023 KB」的读数提前升档。TB 是最高档，没有上级可升，`1023.99 * 1024^4` 仍显示 `1024 TB`（与 `pickTokenUnit` 到 T 档后不再进位同口径，不伪造单位）。回归测试落点 `file-manager.test.ts` 的 `formatSize 贴近单位上限时升档，不出现 1024 KB / 1024 GB`，同时锁定「未触及上限不提前升档」。

---

## 已检查但未发现问题（跑过测试证伪，或为设计口径）

为避免误报，以下候选均编写测试实测后排除：

1. **`filteredToolCallIds` 只增不消导致 result 帧丢失后同 id 被跨会话静默吞掉**（初稿列为 high，本轮证伪）：复现脚本必须先违反帧序——即会话 B 只发 `tool_call_result` 而不发对应的 `tool_call_start`。而 `ws-streaming-event-listener.ts:106-118` 的 `onToolCallStart` 与 `:120-146` 的 `onToolCallResult` 走同一个 `send()`（`:277-281`），后者给所有帧统一注入同一 `executionId`；前端 `useStreamWS.ts:569-570` 对 `STREAM_EVENT_TYPES` 内全部帧（含 start 与 result）用同一 `isStaleExecution` 判定。因此「start 被吞、result 通过」需要二者被判为不同 executionId，协议上不可达。实测五条路径：B 会话 start+result 齐备 → 卡片正常显示（B=1）；同会话 task 结果丢失后同 id 复用 → 正常显示（A=1）；task 工具自身的 start+result → 按设计过滤（A=0，`purgeSessionRuntime` 后仍是 0，符合预期）；同 id 跨工具（task→read_file）→ 正常显示。**残留 id 的唯一可观测后果**是：某个 task 工具的 result 帧永久丢失时，该 id 一直留在 Set 里，之后任何会话复用该 id 的非 task 工具结果都会被误吞——但这要求 start 帧丢失，已被帧门控排除。Set 无会话维度确属清理不对称（`purgeSessionRuntime` 不清、只有 `reset()` 清），但在不可达前提下不构成功能 BUG，降级为代码卫生待改进项。
2. **`grep_search` JS 回退分支 before 上下文超限时命中行丢失**：`probe-bugs.spec.ts` A1-A4 复现了「before 第一条就超 `max_output_chars` → 命中行未 push、`total_matches=0`」的现象（`{"truncated":true,"total_matches":0}`），但 A4 对照证明 after 行超限路径计数正确。进一步核查确认这是 `max_output_chars` 触顶后的**统一截断语义**（两条路径都在超限处停），非独立逻辑错误，不单列。
3. **`glob_search` 单文件 scope 下多级 pattern 失配**：`{"pattern":"src/**/*.ts","path":"src/a.ts"}` 返回 `{"files":[]}` 而目录模式能命中。实测确认为 `candidates=[basename]` + `matchBase:true` 的已知设计取舍（单级 pattern 正常命中，B2/B3 对照），且 `search_root` 输出为文件父目录已有 spec 固化口径，不列为 BUG。
4. **`grep_search` rg 路径与 JS 路径输出预算口径不一致**（`entrySize` 重复计费 path+content，rg 实际只返回约一半结果）：确认为实现分歧，但 `docs/code-review/2026-10-13-code-review-01.md:411` 与 `2026-10-16-logic-bug-review-01.md:265` 已两次记录为「环境相关分裂，不列为 bug」，本轮不重复收录。
5. **`detectEol` 不识别 CR-only 行尾**，`edit_file` 会把经典 Mac 文件整体改写成 LF：确认为实现缺口，但 `read_file` 早已把 CR 显示为 LF，模型编辑前无法察觉原行尾形态，触发面窄；且 `file-eol.ts` 注释声明的契约只覆盖 BOM/CRLF。列为已知限制，不纳入本轮 BUG。
6. **`usage` 分页小数直达 SQL**（`queryInt` 不 floor，`page=1.5&size=2.5` → `LIMIT 2.5 OFFSET 1.25`）：实测复现（`probe-c2.spec.ts` C1-C3 全过：`queryInt(1.5)===1.5`、`listForAdmin` 回显 `size:2.5`、SQL 尾参 `[2.5,1.25]`）。但同源的 `memory.routes.ts:29-37` 已有正确 `parsePage`（floor + 兜底），且 admin/desktop 前端固定传整数，属内部接口的入参健壮性问题；MySQL 对非整数 LIMIT 的行为依版本/驱动而异。记录为待改进项，未计入 6 个 BUG。
7. **`getMessagesByRounds` 翻页游标重复返回上页首条**：实测 R1-R3 全部正确（`selectRange` 上界排他 `id < beforeId`，`nextBeforeMessageId` 指向本页最旧一条）；首轮观察到的「重复」是 mock 上界写错所致，已修正后证伪。
8. **`formatDateTime` 对非法输入抛 `RangeError`**：`new Date('invalid')` / `'garbage'` / `''` 均抛。但全部生产调用点（`inbox.cleanup`、`digest.scheduler`、`openapi.*` 等 30 处）传入的都是 `new Date(...)` 或 DB 读出的合法串，不可达；列为健壮性缺口，非功能 BUG。
9. **`session-share.readView` 翻页游标未扣除 `withoutParentCopies` 过滤行**（初稿列为「待修复项」，本轮维持）：SIDE_TASK 会话首页过滤掉父副本后 `nextBeforeMessageId` 仍指向被过滤的 id（`session-share.service.ts:143` 过滤、`:174` 直接透传 `page.nextBeforeMessageId`），客户端翻页会重复。实测确认为缺陷，但仅影响 SIDE_TASK 会话分享翻页且数据不错乱；修复需要在过滤后重算游标，改动面超出「局部修正」范围，记录为待修复项。
10. **`SubAgentResultCollector.onToolCallStart` 清空 content**：`probe-o.spec.ts` O1-O4 确认 `getResult()` 只返回最后一段正文、工具轮后无新正文时返回空（background manager 会写「(子代理未产生文本输出)」）。这是注释明示的跨轮累计语义，非 BUG。
11. **`MessageHistoryNormalizer` 重复 `toolCallId` / 孤儿 TOOL**：`probe-n.spec.ts` 确认同 id 保留最后一条、孤儿丢弃、占位填充均符合注释声明，且有既有 spec 覆盖。
12. **`cost-micros` / `run-window` / `token-estimator` / `message-jsonl` / `scheduled-task-missed` / `deploy-lock` / `citation-markers` / `usageFormat` / `focusSort` / `chatMessage` / `mergeFileChanges` / `backgroundNotice` / `toolDisplay` / `retargetTabPath` / `discardAbortedStreamTail`**：probe-F/G/H/I/K/L/M/P 系列全部通过，未发现越界或口径错误。其中 `pickTokenUnit`/`formatPercentValue` 的 999.95 进位、`computeCostMicros` 的双重钳制与 NULL 语义、`collectMissedPoints` 的环形缓冲与二分定位均正确。
13. **`formatDateTime`（Asia/Shanghai）与 `nowSql()`（进程本地墙钟）口径差异**：docs 记录为遗留不一致，且本机/生产系统时区均为 Asia/Shanghai，当前部署不触发。

---

## 修复与验证记录（0.0.307）

6 项全部按上述顺序修复完毕，均为局部修改，不涉及协议、迁移或跨端契约。

| # | 改动文件 | 回归测试 |
|---|---|---|
| 1 + 2 | `backend-ts/src/harness/tool/impl/read-file-tool.ts` | `file-tools.spec.ts`：BOM read→edit 往返、BOM-only 文件口径、负 limit、负 offset、非数字 limit、零 limit 空窗 |
| 3 | `backend-ts/src/session/util/tool-result-summarizer.ts` | `session-utils.spec.ts`：5 个工具失败形状、成功形状不误判、错误文案截断 |
| 4 | `backend-ts/src/signal/watcher.service.ts` | `watcher.service.spec.ts`：复用 check 行、基线推进、同值不再触发 |
| 5 | `backend-ts/src/schedule/scheduled-task.service.ts` | `scheduled-task.service.spec.ts`：once+PAUSED+COMPLETED、once+PAUSED+CANCELLED、ACTIVE 对照组 |
| 6 | `desktop/src/utils/file-manager.ts` | `file-manager.test.ts`：单位上限升档、TB 最高档不伪造单位、未触及上限不提前升档 |

验证结果：

- `cd backend-ts && npm run build` — 通过
- `cd backend-ts && npm test` — 4209 passed | 14 skipped（354 files）
- `cd desktop && npx vitest run` — 662 passed（74 files）
- `cd desktop && npm run build` — 通过（`vue-tsc -b && vite build`）
- `./scripts/changelog-extract.sh sync-desktop` — `desktop/package.json` 与 lock 同步到 `0.0.307`

CHANGELOG 已按仓库规范在顶部新增 `## 0.0.307 (2026-10-18)`，按「后端 / 前端」分节记录用户可见的展示与行为修正。
