# Agent 无进展工具循环止损（no-progress guard）代码审查报告（Round 01）

- 审查日期：2026-10-21
- 审查范围：`git status` 未提交改动（新增 `no-progress-notice.ts` / `no-progress-guard.ts` 及三个 spec、修改 `agent-execution-context.ts` / `session-history-loader.ts` / `prompt-engine.ts` / `agent-loop.ts` / `agent-loop.spec.ts`），逐条对照 `docs/plan/2026-10-21-agent-no-progress-guard-technical-design.md`。
- 不在范围：`CHANGELOG.md` / `AGENTS.md` 等文档改动。
- 只读审查，未修改任何业务代码；验证用临时 spec 已全部删除。

## 1. 总体结论

**可以合并。** 阻塞项 0，重要（功能）问题 0，低优先级设计一致性偏差 1。

核心验收口径均已实测通过：

- 第 5 / 10 轮结束注入提醒，第 6 / 11 轮请求可见；提醒不落库、不进 `context.messages`（真实 `PromptEngine` + `AgentLoop` 端到端验证）。
- 第 15 轮抛 `NoProgressLoopException`、第 15 轮消息已落库、`onRoundStart/onRoundEnd` 成对、不再发起第 16 次 LLM 调用。
- 运行时 guard 与历史扫描口径同源（含 shell 归一化、图片附件、豁免轮、空轮、单轮多调用、参数键序、tail seed）。
- 跨执行 / 重启后 `buildRequest` 的 messages 结构一致（只有与线协议无关的对象键序、`senderYmd` 差异）。
- 日志不打印原始参数（仅 `toolName` / `digest` / `argsLength`）。

## 2. 问题列表

### 2.1 [建议] 压缩重载后 `tail` 从 `null` 变为 `null` 时不会重置 guard，与设计 §4.4.4「tail=null 等价重置」不一致

- 位置：`backend-ts/src/harness/core/agent-loop.ts:517`（快照）、`:551-553`（比较后 reset）
- 相关：`backend-ts/src/harness/core/session-history-loader.ts:67-69`（`applyHistory` 重算 tail）

**问题描述**

`AgentLoop` 用「`context.noProgressTail` 的引用是否变化」判断压缩是否真的重载了历史：

```ts
const noProgressTailBeforeCompaction = context.noProgressTail;
...
if (context.noProgressTail !== noProgressTailBeforeCompaction) {
  noProgress.resetFrom(context.noProgressTail);
}
```

`applyHistory` 每次都会重新扫描新窗口：窗口内有完整工具轮时返回新对象（引用必变，正常 reset），窗口内没有完整工具轮时返回 `null`。因此 **压缩前 tail 为 `null`、压缩后重算结果仍为 `null`** 时，引用比较为 `null === null`，`resetFrom(null)` 被跳过，运行时 streak 继续保留；而设计 §4.4.4 / §4.3 明确要求「压缩边界截断 streak 时 `tail=null`（等价重置）」。

**触发条件（可复现）**

1. 本次执行开始时历史里没有完整工具轮（`buildContext` 扫描 tail=null，例如新会话的第一次执行）；
2. 模型连续重复同一组工具调用，runtime streak 累积到 N（>0）；
3. 中途触发 mid-loop compaction（或手动压缩），且压缩边界推进到覆盖本轮全部工具消息，`applyHistory` 重扫后的新窗口没有完整工具轮 → 写回 `tail=null`；
4. 由于引用未变，guard 不 reset，继续用 N 计数 → 第 15 轮仍会中止。

**影响**

- 设计一致性：压缩重写窗口后运行时状态与「重放扫描结果」分叉（重启/重试时该会话从新窗口重新从 0 计数，当前执行却沿用旧 streak）。
- 用户可见影响有限：中止发生在这 15 轮重复确实真实发生过的执行里，属于「偏严格」而非误杀正常任务；但会让压缩后第 15 轮提前失败，与设计声明的「截断即重置」语义不一致。

**修复建议**

不要用 `null`/引用比较来推断「是否 reloaded」，改为显式事件：

1. `AgentExecutionContext` 增加 `noProgressEpoch = 0`，`applyHistory` 末尾自增；`AgentLoop` 在压缩块前后比较 epoch，epoch 变化即 `noProgress.resetFrom(context.noProgressTail)`（`tail` 为 null 也重置）。
2. 或让 `scanNoProgressNotices` 的返回值经 `applyHistory` 包装为新的 tail 容器（`{ tail }` 恒为新对象），压缩后按容器引用重置；`null` 语义只用于 `lastRoundKey`/`streak`。
3. 最小改动版：`const reloaded = context.noProgressTail !== before || context.noProgressReloaded`（由 `applyHistory` 置位并消费），避免用 `null` 当哨兵。

**验证方式（临时 spec，已删除）**

复制 `agent-loop.spec.ts` 的 harness，新增用例：`ctx.noProgressTail = null` + mid-loop compaction mock 中执行 `compacted.noProgressTail = null; compacted.noProgressNotices = []`，连续 16 轮相同 `grep_search`。预期（按设计）正常跑完 16 轮后以文本收尾；实际抛出 `NoProgressLoopException: 检测到 Agent 连续 15 轮…`，证明 reset 未发生。

## 3. 已核对且未发现问题的关键点

| 核对项 | 结论与依据 |
|---|---|
| 运行时 vs 历史扫描同源 | 用随机/组合轮次（单调用、多调用、顺序交换、豁免轮、全豁免轮、tail seed）做差分：guard 的 streak / nudge 序列 / 锚点与 `scanNoProgressNotices` 完全一致（临时差分 spec 5 组全过）。两处都调用同一个 `roundSignature` / `resultDigest` / `buildNoProgressNotice` / `isNoProgressExempt`。 |
| shell 归一化（2207 形态） | `SHELL_SEMANTIC_KEYS` 只取 `exit_code/output/truncated/completed/current_workdir`，实测仅 `session_id`/`output_file` 变化的连续 15 轮在真实 `AgentLoop` 中触发中止（端到端临时 spec 通过）。 |
| 图片附件同源 | 用真实 `SessionHistoryLoader.loadHistoryAfterBoundary` + `ToolAttachmentLoader`（`metadata.attachments[].data_uri`）重放 5 轮同图，扫描得到的 `lastRoundKey` 与运行时 `roundSignature`（含 attachment digest）逐字节相等；渲染时提醒位于最后一条 tool 之后、合成图片消息之前。 |
| 空轮 / 豁免轮 | guard 与 scan 对「整轮全豁免」都按重置处理；`shell await_async/write_stdin`、`completed:false`、`wait_subagents timed_out` 均不参与签名（spec + 差分验证）。 |
| 缺失 tool 输出的轮 | 扫描整轮跳过且不改变 streak（spec 覆盖）；运行时取消路径在 `endRound` 之前 break，二者不会产生不同状态。 |
| 提醒锚点与幂等 | 锚点为该轮最后一个 `tool_call_id`（guard 与 scan 同口径）；`applyNoProgressNotices` 纯函数、不改入参、对已渲染数组重复调用不重复插入；锚点缺失只 warn 不阻断。 |
| nudge / abort 时序 | 落库 → `closeRound()` → `endRound/takeAction` → 手动压缩 → mid-loop 压缩；nudge 时清空 `preparedRequest`；abort 前复查 `isCancelled`，命中时置 cancelFlag 并 break（入口按 CANCELLED 收尾，已落库不回滚）。现有集成用例 + 端到端 request 序列验证第 6/11 次请求分别看到 1/2 条提醒。 |
| 跨执行 / 重启一致 | 真实 `AgentLoop` 跑 12 轮重复 + 真实 `SessionHistoryLoader.applyHistory` 重建后 `buildRequest`：messages 条数与顺序、两条提醒的锚点与文本一致；差异仅 `senderYmd`（仅渲染期字段，不进入协议请求体）与对象键序（适配器自建 payload，不影响线上字节）。 |
| 日志脱敏 | 只记录 `sessionId/round/streak/toolNames/digest/argsLength`；异常文案只带工具名与轮数；`applyNoProgressNotices` 的 warn 只记 `toolCallId`。无参数原文。 |
| 取消竞态 | 第 15 轮落库期间置 cancelFlag → `execute` 正常返回、终态 CANCELLED、已落库轮次不回滚（现有用例覆盖）。 |

## 4. 残余风险（设计边界内，非本次实现 bug）

1. `NO_PROGRESS_EXEMPT_TOOLS` 为空集合：`check_subagent` / `task_list` 等轮询工具若连续 15 轮结果完全一致也会被中止。工具描述已明确要求「不要用 `check_subagent` 配合 sleep 轮询」，且设计 §4.3 明确当前不设工具级豁免，属已知取舍；后续若出现误杀再补工具级豁免或分级阈值。
2. 通用易变字段黑名单会递归删除任意层级的 `timestamp` / `created_at` 等键；对返回任意 JSON 的 MCP 工具，理论上可能吞掉语义字段（误杀）或漏掉新增随机字段（漏报）。设计已把这一点列为维护约束（AGENTS.md 已同步）。
3. `shell` 归一化未纳入 `matched`（`wait_for` 命中标记）：若两次调用仅 `matched` 不同且 `completed:true`、`output` 相同，会被视为同一轮。实际 `wait_for` 命中通常伴随输出变化，影响面很小。
4. `scanNoProgressNotices` 在每次 `buildContext` 全量重算摘要（含 sha256），大历史会话有一次性 O(n) 开销；设计已接受。
5. 单测强度：`agent-loop.spec.ts` 的 nudge 用例断言 `ctx.preparedRequest` 为 null，但下一轮开头本来就会把 `preparedRequest` 置空，该断言无法单独证明「nudge 清空了预构建请求」；功能本身已由端到端 request 序列验证，可后续加强测试（非功能 bug）。

## 5. 已运行验证命令与结论

| 命令 | 结论 |
|---|---|
| `cd backend-ts && npx vitest run src/harness/core/no-progress-notice.spec.ts src/harness/core/no-progress-guard.spec.ts src/harness/core/no-progress-render.spec.ts src/harness/core/agent-loop.spec.ts` | 4 files / 87 tests 全过 |
| `cd backend-ts && npm test` | 376 files passed（1 skipped），4586 passed / 14 skipped，无失败 |
| `cd backend-ts && npm run build` | `tsc -p tsconfig.build.json` 通过 |
| 临时差分 spec（已删） | runtime guard vs scan 5 组场景 streak / nudge 序列 / 锚点一致 |
| 临时真实 loader spec（已删） | 图片附件重放 digest 与运行时一致；提醒位于 tool 组与合成图片之间 |
| 临时端到端 spec（已删） | 13 次请求中第 6/11 次分别出现 1/2 条提醒；2207 形态第 15 轮中止；提醒不落库 |
| 临时重启重放 spec（已删） | 持久化历史重建后的请求 messages 与执行中最后请求结构一致（忽略 `senderYmd` 与对象键序） |
| 临时压缩 spec（已删） | 复现 §2.1 的 `null → null` 不重置问题（唯一失败项） |
| `git status --short` | 临时文件已清理，工作区仅保留本次需求原有改动 |

> 结论补充：除 §2.1 的低优先级设计一致性偏差外，未发现会破坏业务功能的阻塞 / 重要 bug；该偏差修复与否不影响本期上线，建议随下一次后端迭代一并收敛。
