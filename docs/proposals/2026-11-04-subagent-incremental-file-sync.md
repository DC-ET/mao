# 提案：子代理改了一半文件却还没落盘 —— 增量同步与待回传看护

> 后台子代理干活时，文件变更是子代理完成后才一次性拷回父会话的（`copyFileChanges` 全量拷贝 + `fileChangeCopyKey` 去重）。问题是：用户在子代理「还在干活请稍等」阶段打开父会话，看到的是父会话在子代理启动那一刻的「旧快照」，子代理改到一半的文件以及「改了几行、改了哪个文件」完全不可见；一旦子代理进程崩了、被取消、或被超时，父会话要么拿到全部、要么什么都拿不到——半成品变更无法接手。

- 状态：**已否决，存档勿再评审**（2026-11-04 评审驳回）
- 日期：2026-11-04
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：中（增量同步约 2 人日；待回传看护视图约 1 人日；**零迁移**）
- 关联：`backend-ts/src/harness/delegate/background-subagent-manager.ts`（`copyFileChanges` 挂点）、`backend-ts/src/harness/delegate/file-change-copy.ts`、`backend-ts/src/harness/delegate/subagent-result-delivery.service.ts`（`deliveryStatus` 状态机）、`desktop/src/components/chat/SubagentChatPanel.vue`

## 1. 背景与现状

### 1.1 已有积木全在，唯独缺「半成品接手」的增量出口（代码可查）

| 能力 | 现状 | 代码证据 |
|---|---|---|
| 后台子代理模型 | ✅ 子代理跑在独立子会话里，有自己的 agent / 记忆 / `file_change`，父会话只在完成时收到回执 | `background-subagent-manager.ts` |
| 全量拷贝回父会话 | ✅ 子代理完成且 `deliver` 后 `copyFileChanges` 把 `fileChangesAfterMessage` 过的子会话变更按 `fileChangeCopyKey` 去重拷回父会话；已拷过的靠集合去重不重复写 | `background-subagent-manager.ts:948-960`、`file-change-copy.ts:4` |
| 增量/半成品 | ❌ 无：父会话在子代理运行中看不到子会话改了哪些文件；「运行中增量透出」「崩溃后把半成品拷回父会话」均不存在 | — |
| 交付状态机 | ✅ `deliveryStatus` 有 `PENDING → DELIVERED`，被抑制时置 `SUPPRESSED`；终态三种 `COMPLETED / FAILED / CANCELLED` 都走 `SUBAGENT_DONE` 站内通知 | `subagent-result-delivery.service.ts:57-70, 194-255` |
| 子代理崩溃兜底 | ✅ 子代理崩溃有恢复（`crash-recovery`），但仅完成结果交付那一套；`execution.executionStartMessageId` 的恢复语义不覆盖半成品文件的拷回 | `2026-08-16 background-subagent`（已实施） |
| 子代理 UI | ✅ `SubagentChatPanel.vue` 只显示 banner 和完成后的结果，用户看不到子代理正在改的文件 | 子代理面板（完成时 banner 展示结果） |

### 1.2 真实痛点

1. **等待时间是黑盒**：用户看到「子代理在干活」，等了几分钟、十几分钟等来的只有一句「已完成」——中间改了哪些文件、改了没有、报错在哪，全都是看不见的。
2. **崩溃后和半成品没有接手机制**：子代理在半路崩了（超时被杀、模型连接失败）、父会话收到的只有失败通知，能干活的半成品文件变更全在子会话里拿不回来——用户想「我继续干完这个」还得重新捋。
3. **子代理干活期间父会话用户正在同步改同一批文件时没有提示**：子代理产出的变更已存在文件系统，父会话的 `listBySession` 视图里却不出现，用户会以为「文件没动」，自己误改了之后子代理完成后拷回来才发现冲突——拷贝时的父会话「已拷过」集合仅能防重复，不能防覆盖。

## 2. 目标 / 非目标

**目标**

1. **运行中增量透出**：子代理运行期间，父会话能看到子会话「已改文件数 / 总数、最近改的文件名」——由子会话 `file_change` 推派生，只读列表 API 加聚合端点，不改执行时序。
2. **崩溃兜底把半成品拷回父会话**：子代理崩溃/被取消后，再做一次 `copyFileChanges` 调用的语义——把已产出的子代理半成品文件变更带回父会话，并在收回通知里注明「子代理中途终止，已带回 N 个半成品文件变更」。不重跑子代理已做的工作，仅接手产出。

**非目标**

- 不做子代理运行时的文件实时同步（不逐个文件流式回放，只在父会话视图上聚合显示）。
- 不增加子代理与父会话的文件冲突合并/解决逻辑。
- 不碰 `deliver` 的交付状态机语义与 `deliveryStatus` 字段。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 任务模板 / Runbook | 不沉淀模板，不新增资产组。 |
| 工作区环境模板 | 不涉及环境预装，谈的是「接手已产出的文件」。 |
| 多 Agent 协作（DAG/队伍/Worktree） | 仅复用已有子代理交付链路，不引入协作语义。 |
| 执行中引导（Run Steering） | 不改「跑的过程中改方向」，只加「崩溃后把半成品接手」。 |

## 4. 方案设计

### 4.1 运行中增量透出

- **新增只读端点**：`GET /v1/subagents/:executionId/file-changes`，复用子会话 `file_change` 的 `listBySession`（按 `messageId > executionStartMessageId` 限定），返回 `{ totalChanges, recent: [{path, changeType, linesAdded, linesDeleted}] }`。聚合口径与 `copyFileChanges` 用的 `fileChangesAfterMessage` 一致，不造新口径。
- **桌面展示**：`SubagentChatPanel.vue` 的 banner 增加「子代理已改 N 个文件（最近：`a.ts`）」一行；点击切换到该子会话看详情（不另外起文件浏览）。
- **不新增轮询**：只在用户点开子代理执行详情时取一次，不起周期扫描。

### 4.2 崩溃兜底半成品回拷

- **挂点**：`subagent` 崩溃收敛后，复用既有 `copyFileChanges` 方法把已产出的子代理半成品文件变更拷回父会话（去重逻辑 `fileChangeCopyKey` 不动）。
- **通知文案**：`SUBAGENT_DONE` 站内通知补「中途终止，已带回 N 个半成品文件变更」，用户点进去即可在父会话文件变更列表看到。
- **语义护栏**：零新迁移、零状态机改动；`deliveryStatus` 的 `PENDING → SUPPRESSED` 路径不触发本提案。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | `GET /v1/subagents/:executionId/file-changes` 只读聚合端点（子会话 `listBySession` + `fileChangesAfterMessage` 限定）；崩溃收敛后复用 `copyFileChanges` 把半成品拷回父会话 |
| desktop | `SubagentChatPanel.vue` banner 增量一行（已改文件数 + 最近文件名） |
| admin | **无改动** |
| skills/mao-cli | 补桌面端说明（子代理状态条） |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 父会话已拷过的子代理半成品在崩溃兜底时重复写 | `fileChangeCopyKey` 去重集合在拷回前先 `listBySession(parentSessionId)`，命中即跳过，与正常完成路径同口径 |
| 子代理运行中文件变更列表频繁变化，桌面列表抖动 | 只展示 banner 汇总数与最近文件，点击详情才取完整列表；不新起 WS 推送 |
| 半成品回拷把失败子代理写一半的文件以「成功」名义注入父会话 | 通知文案明示「中途终止」并在文件变更标 `半成品` 徽标；不标为「已完成」的回执 |

## 7. 测试要点

1. 运行中聚合端点：`totalChanges` 计数正确、限定语义与 `copyFileChanges` 一致、多用户隔离、`recent` 取最近的 N 条。
2. 崩溃兜底：子代理崩溃后父会话拿到半成品变更 + 通知文案「中途终止」；已拷过的去重不重复。
3. 桌面：子代理 banner 增量行数字正确，点击跳转子会话详情。
4. 回归：子代理正常完成/取消路径不重复拷文件；父会话文件变更列表行为不变。

## 8. 待确认决策

1. 增量行是否需要 `totalChanges` 的实时 WS 推送，还是仅打开详情时取一次——建议只在详情取一次（不新起推送通道）。
2. 半成品文件徽标的文案与归属（是否进入父会话的「已完成文件变更」列表靠徽标区分）——建议同列表 + 「半成品」徽标。
