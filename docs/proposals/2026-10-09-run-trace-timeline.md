# 提案：任务运行轨迹透视（Run Trace）—— 每一轮"为什么慢、为什么贵、为什么失败"

- 状态：已转入实施（2026-10-09；技术方案见 [docs/plan/2026-10-09-run-trace-technical-design.md](../plan/2026-10-09-run-trace-technical-design.md)）。同日评审修订了技术方案：预算不进轨迹、文件变更不重复挂、排队消费是新 run、崩溃恢复不打段标记。实施以技术方案为准。
- 日期：2026-10-09
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

引擎的执行过程今天散落在四类互不相通的数据里，没有任何一处能回答"这一轮到底发生了什么"：

1. **LLM 调用**：`llm_call` 表（`usage/llm-call.repository.ts`）记录了 tokens、`duration_ms`、`retry_count`、`scene`、session/user/agent 维度——但它只服务管理后台的用量分析（`analytics` 域），是**管理视角的账本**，不是**任务视角的轨迹**；用户在自己会话里看不到任何一次调用的耗时与重试。
2. **工具调用**：`session_activity` 表（`session/activity.service.ts`）已经按工具落库（type / target / summary / status），桌面端也消费 `activity` WS 事件渲染动态——但 `ws-streaming-event-listener.ts:274` 落库时 `durationMs` 传的是 `null`，字段存在而数据缺失；且活动流是**平铺流水**，没有"第几轮、轮内顺序、轮间等待"的结构。
3. **压缩与预算事件**：`session_compaction_event` 有落库（`session-compaction-event.service.ts`），预算拦截、审批拒绝只在收件箱/WS 里出现一次，不参与任何可复盘视图。
4. **文件变更**：`message_file_change` 逐消息记录，但只看得到"改了哪些文件"，看不到"哪一轮、哪个工具、耗时多久改的"。

已上线的上下文透视（检查器「上下文详情」）解决的是**向未来看**——下一轮请求的容量与构成；本提案补上**向过去看**——已发生的轮次里时间与 token 花在了哪。两者共用"轮"的概念但方向相反，不重叠。与已否决的 Evals 的边界：本提案只呈现**事实**（耗时/token/成败），不做任何质量断言与版本回归。

## 2. 目标 / 非目标

**目标**

1. 按轮次聚合的执行时间线：每轮含 LLM 调用（模型、耗时、输入/输出/缓存 token、重试次数）、工具调用清单（名称、目标、状态、单项耗时）、文件变更、以及压缩/预算/审批/权限拒绝的事件标记。
2. 会话内「运行轨迹」面板：默认折叠为轮次摘要条，展开看轮内明细；失败轮次与重试高亮；超阈值轮次（慢/贵）给出可见标记。
3. 补齐工具耗时埋点：`session_activity.duration_ms` 从 `null` 变为真实值（执行层 `toolResultMeta` 已带 `durationMs`，只是没往下传）。
4. 导出：单会话轨迹可导出 JSON/CSV，供贴 issue 或团队复盘。

**非目标**

- 不做 OpenTelemetry / Prometheus 等外部可观测设施对接（P1 纯内循环，接口预留）。
- 不做提示词级 diff 与通过率报告（Evals 方向，已否决）。
- 不改 `llm_call` 历史口径，不动用量分析的管理后台视图。
- 不做跨会话的分布式追踪（traceId 串联子代理可由 P3 评估，P1 只做单会话主线 + 子代理汇总行）。

## 3. 技术方案

### 3.1 埋点补齐（P1 前置）

- `ws-streaming-event-listener.ts` 的 `recordActivity` 把 `toolResultMeta(result).durationMs` 透传进 `session_activity.duration_ms`；`activity` WS 事件同步带上 `duration_ms`。
- agent-loop 在轮边界发 `round_start` / `round_end` 事件（轮号、起止时间），listener 落 `session_activity` 新 type 或复用现有 round 概念；LLM 调用侧已有 `recording-llm-adapter` 记录，按 sessionId + 时间窗归属到轮。

### 3.2 轨迹读模型（P1）

- 新增 `trace` 域（或挂在 `session` 域下的 trace 服务）：以消息为主干（消息已含 `toolCalls` / `tokenCount` / `modelId`），左连接 `llm_call`（按 session + 时间窗）、`session_activity`（工具耗时）、`message_file_change`（文件变更）、`session_compaction_event`（压缩标记），聚合出 `RunRound[]` 结构。
- 关键设计：**读时聚合，不新建轮次事实表**。轮次归属的权威来源是消息序 + `llm_call.created_at` 时间窗，避免双写一致性问题；工具耗时与轮号在写入侧补齐即可。
- 分页：长会话（数百轮）按轮分页，默认取最近 N 轮，向上懒加载。

### 3.3 前端（P1）

- 桌面新增「运行轨迹」tab（对话区中心 tab，与边路对话 / 子代理 / 文件查看并列；入口在检查器徽标区）：轮次摘要条（轮号、模型、耗时、token、工具数、事件徽标：压缩/预算/审批/失败）→ 展开轮内明细。
- 失败与重试高亮；超时轮（超过用户可配阈值，默认 60s）标记。

### 3.4 聚合与导出（P2）

- admin 侧聚合视图：按 agent / 用户统计"最慢的轮""最贵的轮""失败率最高的工具"，数据源同一读模型加 WHERE 条件，不新铺管道。
- 会话轨迹导出 JSON（结构化轮次）/ CSV（扁平行），复用 `llm-call` 导出的 CSV 写法。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 工具耗时埋点 + 轮边界事件 + 轨迹读模型 API + 桌面轨迹 tab | 中 |
| P2 | admin 聚合视图 + JSON/CSV 导出 + 阈值配置 | 小~中 |
| P3 | 子代理 traceId 串联、外部 OTLP 导出（按需） | 中 |

## 5. 风险与开放问题

- **轮次归属的时序对齐**：`llm_call.created_at` 与消息写入时钟同源（同一进程），但压缩归档重载历史时消息与调用可能错位。缓解：归属以消息 `toolCalls` 内的 call 为权威，`llm_call` 仅按时间窗补 token/耗时，归属不上的轮显示"—"而非猜测。
- **写放大**：每条 `session_activity` 已有写入，本轮只是补一个字段，无新表写入；轮边界事件每轮两行，量级可忽略。
- **长会话性能**：读时聚合在大会话上可能慢。缓解：轮分页 + 默认最近 N 轮；若仍慢再考虑物化 `run_round` 汇总表（列入开放问题，P1 不做）。
- **开放问题**：轨迹数据是否要设保留期（与数据保留策略提案联动，见 `2026-10-09-data-retention-portability.md`）。

## 6. 测试要点

- 工具耗时落库：`session_activity.duration_ms` 非空且与执行层 `toolResultMeta` 一致；WS `activity` 事件带 `duration_ms`。
- 轮边界：一轮内多次工具调用归属同一轮；压缩触发轮有事件标记；预算/审批拒绝轮有标记。
- 轨迹面板数值与 `llm_call` 明细（同 session 同时间窗）一致；分页加载不重不漏。
- 导出 JSON 结构与 API 响应一致；CSV 列与 `llm-call` 导出口径对齐。
