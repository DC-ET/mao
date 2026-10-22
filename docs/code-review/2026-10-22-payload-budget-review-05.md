# 第五轮复查报告（最终确认）：会话压缩「请求体体积」触发 + 图片前置压缩

- 复查时间：2026-10-22
- 仓库/分支：`/opt/mao-data/workspace/feishu-chat/2/oc_fb9ef40b6ff5b0c8cae6814f97c59a94/mao`，`main`（改动仍全部未提交）
- 复查对象：第 4 轮 `R4-L1 ~ L6` 的处理
- 复查方式：逐文件阅读 + 全量单测 + 目标 spec 重复运行 + `admin` / `desktop` 的 `vue-tsc -b`
- 前置结论沿用：V167 未被任何环境应用，checksum 风险解除。

## 一、结论摘要

- **严重问题：0 个**
- **中等问题：0 个**
- **轻微问题：1 个**（设计 §4.2 表格行仍写「WeakMap 缓存」，未带「每轮新建数组时命中率为 0」的限定；§4.3 已补，属文档一致性小尾巴）
- **待确认：0 个**
- **最终结论：可以合并、可以上线。** 第 4 轮 6 项均已闭环；本轮改动只涉及测试、注释、一个布尔哨兵和文档，没有引入功能性变化。

### 本轮验证

| 验证项 | 结果 |
|---|---|
| `npx tsc -p tsconfig.build.json --noEmit` | 通过（0 error） |
| `npx vitest run`（全量） | 394 passed / 1 skipped（395 files），4701 passed / 14 skipped，与提交说明一致 |
| `harness-service.spec.ts` + `compaction-service.spec.ts` 连跑 3 次 | 每次通过，无抖动 |
| `admin` `npx vue-tsc -b` | 通过（exit 0） |
| `desktop` `npx vue-tsc -b` | 通过（exit 0） |

## 二、R4 六项闭环确认

### R4-L1（重点）harness-service 的「读压缩前值」测试——**已真正闭环**

- 文件：`backend-ts/src/harness/core/harness-service.spec.ts:577-649`
- 正向用例（`:577-613`）：`compact` mock 现在会在返回前执行 `c.lastRequestBytes = 100`，模拟真实 orchestrator 压缩成功后的重建覆盖；`promptEngine` 始终重建为 2000。
  - 走新实现：`bytesBeforeCompact` 在 compact 之前取到 2000 → `2000 >= 1000` → `payloadCompactionDone = true`，断言通过。
  - 走旧实现（在 compact 之后读 `context.lastRequestBytes`）：读到 mock 写入的 100 → `100 < 1000` → `payloadCompactionDone = false` → **断言会失败**。这条测试现在能真正锁住 R2-L1。
- 反向用例（`:615-649`）：压缩前 500 < 阈值 3000 → 断言 `false`，作为补充。需要说明的是：该用例里 `compact` mock 在低于阈值时也返回 `true`（真实路径下压缩服务会返回 false），所以它主要锁住的是「体积比较」，不构成独立的回归网；关键保护来自正向用例，这一点已经达成。

### R4-L2 工具 schema 缓存注释——**已闭环（代码注释 + §4.3）**

- `backend-ts/src/harness/core/request-size.ts:99-103`：注释已如实写明「调用方每轮 `buildToolDefinitions()` 新建数组时命中率为 0，40 工具/168KB 约 0.5ms，可忽略」。
- 设计 §4.3 `docs/plan/...:167` 已同步同一口径。
- 还剩一处文档小尾巴，见下方 R5-L1。

### R4-L3 provider 剥图边界——**已闭环**

- `backend-ts/src/harness/core/compaction-service.spec.ts:390-423`（未到线 `734_463` 保留图片）与 `:425-459`（恰好到线 `734_464` 剥图）构成精确边界对；上限 800,000、64KiB 余量 65,536 的算术与代码一致。
- 若把余量改成其他值或把 `>=` 改成 `>`，这对用例至少有一条会红。

### R4-L4 weixin「原值未改写」断言——**已闭环**

- `backend-ts/src/weixin/agent-inbound-handler.spec.ts:49-68`：先保存 `const original`，再断言 `url !== original` 且 `ctx.imageDataUris[0] === original`；同时保留「输出 ≤300KB」的压缩断言。现在能同时锁住「压缩接线」和「不改写入参」。

### R4-L5 cap 日志哨兵——**已闭环**

- `backend-ts/src/harness/core/agent-execution-context.ts:72-73` 新增 `payloadCompactionCapLogged = false`；`agent-loop.ts:557-564` 用 `if (!context.payloadCompactionCapLogged)` 打一次 warn。
- `payloadCompactionAttempts` 不再被 +1，字段语义恢复为「实际发起的次数」，字段注释与实现一致；达到上限后仍保持 2 次调用、一条告警。

### R4-L6 设计 §6.4 运维建议——**已闭环**

- `docs/plan/2026-10-22-session-compaction-payload-budget-technical-design.md:339-340` 已补「未填上限时剥图线固定 40MiB；提前压缩不会提前剥图；32MB 级通道请填真实上限」，与代码行为一致。

## 三、轻微问题

### R5-L1. 设计 §4.2 的 `tools` 表格行仍写「WeakMap 缓存」，未带命中率限定
- 文件：`docs/plan/2026-10-22-session-compaction-payload-budget-technical-design.md:131`（§4.2 表格）、`:142`（§4.3 代码块注释）
- 现状：§4.3 第 167 行已经写明「调用方每轮新建数组时命中率为 0（40 工具约 0.5ms，可忽略）」，但 §4.2 的表格行仍是「一次执行内不变，`WeakMap` 缓存」，§4.3 代码块注释也仍是「WeakMap 缓存」。只读 §4.2 的人仍会以为缓存有效。
- 影响：纯文档一致性；不影响代码行为。
- 修复建议：把 §4.2 表格该格改成「按数组引用 `WeakMap` 缓存；调用方每轮新建数组时命中率为 0（见 §4.3）」，§4.3 代码块注释同样加半句即可。

## 四、本轮改动是否引入新问题

**没有发现新问题。** 本轮 diff 只有：
- 测试：`harness-service.spec.ts`（新增/改写两条）、`compaction-service.spec.ts`（新增精确边界一条、改写一条）、`weixin/agent-inbound-handler.spec.ts`（断言收紧）；
- 注释：`request-size.ts` 的缓存说明；
- 生产代码：`agent-execution-context.ts` 新增一个布尔字段、`agent-loop.ts` 用布尔替代 `MAX+1` 哨兵（无行为变化，仍是「达到上限后不再调用、只告警一次」）；
- 文档：设计 §4.3 / §6.4。

布尔哨兵按执行上下文初始化、不跨执行复用（`buildContext` 每次 `new AgentExecutionContext()`），不存在跨轮/跨会话残留问题。

## 五、最终结论

**可以合并、可以上线。** 严重 0、中等 0；唯一剩余的 R5-L1 是设计文档 §4.2 表格行的措辞，不影响代码与运维行为，可在合并时顺手改掉。前四轮的阻塞/中等项（S1、S2、R2-M1/M2/M3、R3-M1）均已闭环，回归测试已能覆盖对应路径。
