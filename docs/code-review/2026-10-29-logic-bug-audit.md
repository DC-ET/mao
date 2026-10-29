# 逻辑 BUG 审查报告（2026-10-29 · 复审修订版）

> 审查范围：`backend-ts/src/` 全量业务逻辑
> 审查方法：并行派 agent 在 harness core / tool impls / domain services / frontend / agent-cli 五个子系统搜集候选 BUG，逐一读源码确认，编写验证测试证明真实存在
> 验证方式：每个 BUG 编写"断言正确行为"的测试，测试失败即证明 BUG 存在
> 测试文件：`backend-ts/src/harness/core/logic-bug-audit.spec.ts`
>
> **修复状态（2026-10-30）**：本报告确认的 BUG-3、BUG-4 已修复；「复审后移除的项」中的 BUG-1、BUG-2、BUG-5 也已按各节建议顺手治理（均为单点小改，见 CHANGELOG 0.0.379）。本文件 8 个验证测试现全部通过；文中"测试失败"的描述保留为审查时的历史证据。
>
> **2026-10-29 复审修订**：对初版的 5 个报告项逐条做了可达性与修复价值复查——
> 确认保留 2 项（BUG-3、BUG-4），移除 3 项（BUG-1 不可达、BUG-2 / BUG-5 修复价值不高，见「复审后移除的项」）。

---

## 验证汇总（保留项）

| 编号 | BUG 标题 | 文件 | 置信度 | 修复价值 | 测试 |
|------|----------|------|--------|----------|------|
| BUG-3 | background-task JSON 转义膨胀导致二次截断产生非法 JSON | `harness/core/background-task-manager.ts:139-154` | 高 | 高：常见输入可触发，破坏代码注释明示承诺 | 1 个测试失败 |
| BUG-4 | shell-session await_async 使用过期快照 pending.keepSession | `harness/tool/impl/shell-session-tool.ts:392` | 高 | 中：一行修复、零风险、与 write_stdin 路径对齐 | 1 个测试失败 |

运行 `npx vitest run src/harness/core/logic-bug-audit.spec.ts`：审查时 8 tests, 8 failed（BUG-3、BUG-4 各 1 个测试对应保留项，其余 6 个属于下方已移除项的行为演示）；**修复后（2026-10-30）8 个全部通过**。

---

## BUG-3: background-task JSON 转义膨胀导致二次截断产生非法 JSON

**文件**：`backend-ts/src/harness/core/background-task-manager.ts`
**行号**：134-157（关键行 139、145、149、153-154）

**错误代码**：
```ts
private normalizeResult(raw: string): string {
  const parsed = parseObject(raw);
  let text: string;
  if (parsed != null && typeof parsed.output === 'string') {
    // output 截断预留 JSON 头部与 error 字段开销
    const budget = MAX_RESULT_LENGTH - 400;  // ← 400 字符预算
    const payload: Record<string, unknown> = { ...parsed };
    const output = payload.output as string;
    payload.output = output.length > budget ? output.slice(0, budget) + '... [truncated]' : output;
    // ...
    text = JSON.stringify(payload, null, 2);  // ← JSON 转义膨胀，未计入预算
  } else {
    text = raw;
  }
  if (text.length > MAX_RESULT_LENGTH) {  // ← 二次截断
    text = text.slice(0, MAX_RESULT_LENGTH) + '... [truncated]';  // ← 在 JSON 字符串值中间切断
  }
  return text;
}
```

**为何是 BUG**：

第 139 行的 `budget = MAX_RESULT_LENGTH - 400`（= 9600）只预留了 JSON 键名等结构性开销，**没有计入 `JSON.stringify` 对 output 内容的转义膨胀**：每个引号（`"` → `\"`）、反斜杠（`\` → `\\`）、换行（`\n` → `\\n`）、控制字符都额外 +1 字符。实测 JSON 结构性开销约 200 字符、截断尾巴 `'... [truncated]'` 占 15 字符，因此只要 output（或其被截断后的前 9600 字符窗口）内转义字符数超过约 155 个，整体就会超过 `MAX_RESULT_LENGTH = 10000`，触发第 153-154 行的二次截断——在 JSON 字符串值中间切断，产出**非法 JSON**。

第 138 行注释明确承诺"保证重组后的完整 JSON 不再触发整体二次截断"，转义膨胀使该承诺失效。

**实测证据**（对真实实现探针验证，2026-10-29 复审补充）：

| 输出形态 | output 长度 | 转义字符数 | 结果 |
|----------|------------|-----------|------|
| 170 行 × 65 字符构建日志 | 15501 | 169（全换行） | 合法 JSON（贴线未超） |
| 120 行 JSON 依赖转储（引号密集） | 11799 | 数千 | **非法 JSON**，在 10015 处切断于 output 字符串中间 |
| `'x"'` × 4800（引号密集） | 9600 | 4800 | **非法 JSON**（单测同场景） |

二次截断把 JSON 尾部的 `current_workdir`、`output_file` 字段全部切掉——模型既拿到截断于半行的输出，又**失去完整日志的读取入口（output_file）**。这正是 140-142 行注释明确要防止的后果："模型会把被裁掉尾段的构建日志当成完整输出，也失去完整日志的读取入口"。

**触发条件**（复审后修正，比初版描述更宽）：output 超过 9600 字符、且前 9600 字符窗口内引号/反斜杠合计超过约 155 个（JSON 转储、含引号的配置/代码片段、Windows 路径日志都很容易满足）；或 output ≤ 9600 但转义后总长超过 10000。纯换行的长日志仅在"总量 >9600 且前 9600 字符内行数 >~155"时触发（短行逐文件输出可满足）。

**影响**：注入给模型的上下文不是合法 JSON，且必然丢失 `output_file` / `current_workdir` 尾部字段。下游解析方（no-progress-notice、tool-result-summarizer）对解析失败有兜底不会崩，但模型侧拿到的结果既残缺又失去续读入口，可能基于截断输出做错误推理。

**测试证据**（`logic-bug-audit.spec.ts`）：
```
× output 含大量引号时，归一化结果应仍是合法 JSON
  expected [Function] to not throw an error but
  'SyntaxError: Unterminated string in JSON at position 10015' was thrown
```

**修复建议**：对 output 做转义感知的截断——先测 `JSON.stringify(output).length`，按**转义后长度**确定截断点（而非按原始长度切 9600）；或者把"整体二次截断"改为收敛循环：stringify 后若超 10000，则按超出量回退 output 预算并重新 stringify，直到整体不超限，保证产出永远是合法 JSON。

---

## BUG-4: shell-session await_async 使用过期快照 pending.keepSession

**文件**：`backend-ts/src/harness/tool/impl/shell-session-tool.ts`
**行号**：378、384、387、392

**错误代码**：
```ts
// handleAwaitAsync 方法
const pending = session.pendingCommand;                    // ← line 378: 锁前快照
// ...
const releaseCommand = await session.acquireCommand?.() ?? (() => undefined);  // ← line 384: 拿锁
try {
  // 拿锁可能排队，期间命令可能已被并行调用方收取完毕；按旧快照续读只会登记假 marker 卡死会话
  const livePending = session.pendingCommand;              // ← line 387: 锁后实时（正确重读）
  if (!livePending) return errorJson('该会话没有未结束的命令：' + shellId);
  const result = await this.outputManager.readUntilMarker(session, livePending.marker, yieldTimeMs, waitFor);
  const workdirNow = await this.resolveCurrentWorkdir(session, result);
  const payload = this.formatResult(session, result, workdirNow);
  this.settleSession(session, result, pending.keepSession);  // ← line 392: BUG！用了过期快照
  return toJson(payload);
} finally { releaseCommand(); }
```

**为何是 BUG**：

代码注释（line 386）明确说明"拿锁可能排队，期间命令可能已被并行调用方收取完毕"，因此 line 387 重新读取 `livePending` 用于**续读**。但 line 392 调用 `settleSession` 时传入的却是 `pending.keepSession`（锁前快照）而非 `livePending.keepSession`（锁后实时值）。

对比 write_stdin 路径（line 331）正确使用实时值：
```ts
this.settleSession(session, answered, livePending.keepSession);  // ← write_stdin 正确
```

`settleSession`（line 265-267）在 `result.completed && !keepSession` 时关闭会话。当锁等待期间命令被替换（旧命令完成、`keep_session: true` 的新命令开始），过期快照的 `keepSession=false` 会让本应保留的会话被错误关闭。

**触发条件**：需要同一会话上的并行工具调用按特定顺序交错——A 快照旧命令（keep=false）→ 等锁期间旧命令完成、B 以 `keep_session: true` 发起新命令并超时让出锁 → A 拿到锁续读新命令至完成 → 用旧快照的 false 关闭了 B 要保留的会话。概率低，但一旦发生，会话的工作目录、环境变量等状态全部丢失，下轮调用被迫重建。

**修复价值（复审结论）**：保留。虽然触发概率低，但这是同一函数簇内两条路径的口径分叉（write_stdin 用实时值、await_async 用快照），修复是单参数替换、行为仅在"快照过期"这一本就异常的分支上变化，零回归风险——属于"顺手就该修对"的一致性修正。

**测试证据**：
```
× await_async 应使用 livePending.keepSession 而非 stale pending.keepSession
  expected "spy" to not be called at all, but actually been called 1 times
  Received: 1st spy call: ["sh-1", { conversationId: 11 }]
```

**修复建议**：将 line 392 的 `pending.keepSession` 改为 `livePending.keepSession`，与 write_stdin 路径（line 331）保持一致。

---

## 复审后移除的项

以下 3 项初版曾列为 BUG，经逐条复查后从 BUG 清单移除。对应的测试仍保留在 `logic-bug-audit.spec.ts` 中并继续失败，作为这些（降级后的）行为差异的可复现证据。

### BUG-1（移除）：TokenEstimator.contentToString 跳过无 type 字段的文本 part —— 当前代码不可达

初版判断"历史数据、流式响应解析、外部 API 返回中可能出现无 type 的 part"。复查结论：**全库不存在这样的生产者**——

1. 类型定义（`harness/llm/chat-request.ts`）中 `ContentPart.type` 确实可选，`serializeContentPart`（`harness/llm/json.ts:27`）也确实不要求 type，两处口径不一致属实；
2. 但数组 content 进入 `ChatMessage` 的全部路径都保证有 type：
   - DB 历史加载：`session-history-loader.parseContent` 只在 `isMultimodalContentParts(parsed)` 通过时才按数组解析，而该函数（`common/multimodal-content.ts`）要求**每个** part `type === 'text' || type === 'image_url'`，否则整段按纯文本字符串处理——无 type 的数组根本进不了 content 数组；
   - 全部生产者（dingtalk/feishu/weixin 三个 inbound-handler、tool-media-injector、image-url-annotation）均显式写 `type: 'text'` / `type: 'image_url'`，逐点核对无一例外；
3. 影响面也有限：压缩触发优先采信真实 prompt usage（`compaction-service.ts:158`，`activeTokensHint > 估算值时用前者`），估算器只是兜底信号，且低估会在下一轮被真实用量纠正。

结论：作为代码不一致是真实的（两个测试如实演示了 `contentToString` 与序列化口径的分叉），但**当前没有任何可达输入**，属于潜在隐患而非现存 BUG。若日后新增 content 生产者，建议顺手把 `contentToString` 的条件从 `o.type === 'text' && o.text != null` 放宽为 `o.text != null`（与 `serializeContentPart` 对齐），在此之前不构成修复需求。

### BUG-2（移除）：scheduled-task Number() 校验接受 null/空串 —— 实际影响仅为错误文案

初版记录"task_id: null/'' 以 taskId=0 继续执行，工具返回 success"。复查修正：

1. **真实系统中不存在假成功**：`updateTask(0)/deleteTask(0)` 走到 `getTaskOwnedByUser` → `selectById(0)` 返回 null → 抛 `BusinessException(SCHEDULED_TASK_NOT_FOUND)`，工具 catch 后返回 errorJson。初版测试里"返回 success"是测试 mock 了 service（`updateTask: vi.fn(async () => ({ id: 0 }))`）造成的外观；真实失败模式是**错误文案不准确**（"任务不存在"而非"缺少必填参数"）。
2. 无数据破坏：id 0 永不存在，不会误操作任何真实任务；`[5]` → 5 的宽松转换恰好落在模型本意目标上，属"宽容解析"而非误伤。
3. 触发要求模型对必填 integer 参数显式传 `null`/`''`，概率低；即便发生，模型拿到的仍是明确的 error 结果，可自行纠正。

结论：存在（测试可复现）但修复价值低——收益仅是错误文案更准确，代价是改一处校验并同步测试。不列为待修 BUG；若顺手治理，可复用 `task-tools.ts:196` 的 `asIntStrict` + `> 0` 口径。

### BUG-5（移除）：wechat fileName 空串未兜底 —— 触发罕见且失败可见可恢复

初版记录 `asText(args.filename) ?? file.split(...).pop() ?? 'file'` 不兜底空串。复查结论：

1. 两条触发路径中"file 以 / 结尾"一条已确认**不可达**（`loadSendFileBytes` 会先因文件不存在而失败，初版文档自己已注明）；
2. 剩余唯一触发是模型对**可选**参数显式传 `filename: ''`，概率很低；
3. 下游影响有限：上传桥接层（`weixin/wechat-tool-bridge.ts:43`）完全忽略 fileName（`_fileName` 未使用），空串只会进入 `send.service.sendFile` 的协议字段 `file_name: ''`，发送失败以 `success: false` **可见地**返回，模型可重试——无静默损坏、无崩溃。

结论：作为与 dingtalk 同类代码（`dingtalk-tools.ts:96` 正确用了 `||`）的不一致属实，但预期损失接近零，修复价值不高。若顺手治理，把 `??` 链改为 `||` 链即可（单字符修改）。

---

## 附：验证测试运行方法

```bash
cd backend-ts
npx vitest run src/harness/core/logic-bug-audit.spec.ts
```

当前输出：**8 tests, 8 passed**（2026-10-30 修复后）。审查期间为 8 failed——BUG-3、BUG-4 各 1 个失败对应保留的待修 BUG；BUG-1（2 个）、BUG-2（3 个）、BUG-5（1 个）共 6 个失败演示的是「复审后移除的项」的行为差异，现已随顺手治理一并转为通过。

初版报告的方法说明：候选来自五个子系统的并行搜集，逐一读源码确认后以"断言正确行为"的测试验证；本轮复审在此基础上补充了可达性分析（全库生产者排查、下游行为探针）与修复价值评估。
