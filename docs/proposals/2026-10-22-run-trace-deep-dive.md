# 提案：运行轨迹深度下钻（Run Trace Deep Dive）—— 借鉴 deepseek-harness Trajectory，把摘要看板升级为执行调试器

- 状态：P1 已实施（2026-10-22，0.0.336/0.0.337：时间概览条带 / 记录详情抽屉 / 计时补全 / CSV provider 列，技术方案见 [docs/plan/2026-10-22-run-trace-deep-dive-technical-design.md](../plan/2026-10-22-run-trace-deep-dive-technical-design.md)）；剩余项中「消息内容下钻 + 请求构成记录」（§3.3 扩展与 §3.6）已出技术方案待实施：[docs/plan/2026-10-25-run-trace-content-and-prompt-technical-design.md](../plan/2026-10-25-run-trace-content-and-prompt-technical-design.md)，搜索（§3.4）与拖选聚焦仍待排期
- 日期：2026-10-22
- 提案总览：见 `docs/proposals/README.md`
- 外部参照：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）的 Trajectory 视图（`packages/client/ui-trajectory`，注册进对话视图环、与 Chat 平级的标签页）

## 1. 背景与现状

运行轨迹自 2026-10-09 提案（[2026-10-09-run-trace-timeline.md](2026-10-09-run-trace-timeline.md)，已转入实施）上线以来，桌面端已具备「会话总览 → run → 轮次 → 工具行」的渐进下钻：慢/贵阈值、审批标记、编辑前/当前分段、旁路调用、子代理链接、上下文压缩标记、JSON/CSV 导出、执行中临时卡片。它回答的是「整体怎么样、哪一轮慢、哪个工具卡、花了多少钱」。

外部参照 deepseek-harness 把轨迹做成了三件套（其 README.zh.md 自称「按轮次组织的事件记录表加交互式时间概览」）：

1. **时间概览**：类 Chrome DevTools Network 的瀑布条带，按记录真实开始时间与耗时投影；助手记录分「首 token 延迟 / 解码」两段；悬停 500ms 看精确起止时刻与耗时；**横向拖选时间区间，记录表自动聚焦到该区间内活跃的记录**；滚轮缩放、右键平移；流式输出时视图跟随尾部，向上滚动暂停跟随。
2. **事件记录表**：按轮次 → 组（消息 / 第 N 步 / 压缩）→ 记录组织，类型覆盖系统提示词、用户消息、上下文注入、已压缩消息、助手消息、工具调用、嵌套子工具；工具栏提供时长/等宽切换、整轮/整助手调用折叠、**轨迹内搜索**（节流索引 + 命中高亮）；长表虚拟化 + 50 条/页「加载更早的历史」。
3. **记录详情检查器**：点开任何一条记录，看参数 JSON（换行切换 / 原样复制）、结果 JSON（树形）、Schema、计时（开始时间 / 总长 / TTFT / 解码 / 吞吐量 / 计时来源）、用量（输入 / 缓存读 / 缓存写 / 输出 / 推理，本次请求 vs 会话累计）、请求选项 JSON、系统提示词与工具目录快照及变更 diff、思考内容、附件（图片 / 文件带尺寸与灯箱）、重试进度与上次尝试错误、错误码；`run_code` 记录还展示带行号和语法高亮的源码。

对比结论：mao 轨迹强在**成本核算**（元 / 贵阈值 / 未配价不算贵）、**审批标记**、编辑前分段、导出与**服务端归属兜底**（tool_call_id 归拢、未挂到轮、迟到插入不重复计数）；deepseek-harness 强在**时间维度可视化、记录内容下钻、搜索、计时/用量维度**。本提案只补 mao 的差距，不动已上线部分。

差距清单（按排障价值排序）：

1. **时间不可见**：只有数字，看不出「谁在等谁、并行还是串行、首字慢还是解码慢」。
2. **记录不可钻**：工具行只有一行摘要（名称 / 目标 / 耗时），参数与结果要回聊天记录里翻。
3. **搜不到**：长会话定位某一轮 / 某个工具只能肉眼扫。
4. **维度不全**：无解码耗时、吞吐量、provider、请求编号、「累计至本轮」用量视角。
5. **构成不可见**：提示词 / 工具目录的变更不进轨迹，「这轮为什么行为变了」缺一环。

## 2. 目标 / 非目标

**目标**

1. **run 内时间概览条带**：轮次与工具按真实开始时刻 + 耗时投影色条；助手轮次分「首字 / 解码」两段；悬停显示类型、起止时刻、耗时；点击色条定位对应行。
2. **记录详情下钻**：点工具行 / 轮次行开抽屉，按需拉取参数 JSON、结果 JSON、完整计时与请求元信息（provider / protocol / stream / effort / 重试 / 错误）；轨迹主 VO 不带正文，防载荷膨胀。
3. **轨迹内搜索**：对已加载页范围内的记录过滤 + 命中高亮 + 跳转。
4. **计时与用量补全**：解码耗时（durationMs − firstTokenMs）、吞吐量（输出 tok/s）、provider 展示、请求编号 #N 与「累计至本轮」用量（UI 层累计，零后端改动）。
5. **（P2，依赖埋点评估）请求构成记录**：提示词版本与工具目录变更进入轨迹。

**非目标**

- 不做外部可观测对接（OTLP / Prometheus）——沿用 2026-10-09 提案边界。
- 不做拖选聚焦 / 缩放平移等重交互——P1 只做悬停 + 点击定位；dsh 的 drag / zoom / pan 形态成熟但交互成本高，列为 P2 可选。
- **不为色条新建 started_at 列**：开始时刻沿用 `run-window.ts` 既有的「created_at − duration_ms」估算口径（秒级误差可接受，tooltip 标注「估算」）；「工具开始时刻」精确埋点列为开放问题。
- 不改归属口径；导出结构语义不变（新字段增量扩展）。
- 不做全会话服务端轨迹搜索——消息正文检索已有全局消息检索（[2026-10-09-global-message-search.md](2026-10-09-global-message-search.md)，已实施）覆盖；轨迹搜索定位在「已加载页快速过滤」。
- P1 只动桌面端 + 后端轨迹读模型；admin / android / mao-cli 不动。

## 3. 技术方案

### 3.1 数据增量（后端，`session` 域，零迁移）

`session-vo.ts` 的 `TraceRoundVO` / `TraceToolVO` 增加：

- `startedAtMs: number | null`——服务端用 `run-window.ts` 同款换算（`Date.parse(created_at) − duration_ms`）算出；`created_at` 已是 `DATETIME(3)`（V142 提升过），毫秒精度足够；历史秒级行照算，误差可接受。
- `provider: string | null`——`llm_call.provider` 是建表即有的冗余快照列（V113），直接透出，轮次行可显示。

`decodingMs` / 吞吐量不进 VO——前端用 `durationMs − firstTokenMs`、`completionTokens ÷ 解码秒` 现算（`firstTokenMs` 为 null 时显示「—」，不猜）。`run-trace.service.ts` 的 `toRoundVO` / `toToolVO` 补字段，`RunTraceQuery` 不变。

### 3.2 时间概览条带（桌面，P1 核心）

`RunTracePanel.vue` 在 **run 卡展开区顶部**渲染 SVG 条带（与该 run 时间域对齐；节点数 = 轮数 + 工具数，长 run 也可接受；dsh 的全局固定条带 + 虚拟化形态列为开放问题）：

- 横轴 = 该 run 的 `[最早开始, 最晚结束]`（复用 `wallClockMs` 同款采样点集合现算）。
- 每条轮次 / 工具一个色条：起点 `startedAtMs`、宽度 `durationMs`；助手轮次分两段（首字 `firstTokenMs` / 解码余量），与 dsh 的 TTFT / 解码分段对齐。
- 悬停 tooltip：类型 + 起止时刻（标注「估算」）+ 耗时；点击色条展开该 run 并滚动定位到对应行（复用现有 `expandedRuns` 与 DOM 滚动）。
- `startedAtMs` / `durationMs` 为 null 的行不画色条——与「未挂到轮」同口径，不猜；「未挂到轮」组的工具行照画（created_at 在窗内即可）。

### 3.3 记录详情下钻（P1）

- 新只读 API：`GET /sessions/:sessionId/trace/records/:toolCallId`——按 `tool_call_id` 从 `message` 表取该次调用的参数（助手消息 `tool_calls` 元素）与结果（TOOL 消息 content，含 metadata 的审批标记），并带出配对 `llm_call` 行的完整元信息（provider / protocol / stream / effort / retry_count / error_message / first_token_ms / duration_ms）。权限复用现有 `/sessions/:id/*` 会话归属校验，不新增泄露面；找不到返回空态。
- 桌面端右侧抽屉：面板内 absolute 定位，**不挂全局侧边栏**（0.0.3xx 修过轨迹 Tab 打开时边栏会话错配，勿复现问题）；tab = 参数（JSON，换行切换）/ 结果（JSON 树或文本）/ 计时与元信息（provider、协议、流式、effort、重试、错误、首字、解码、吞吐）。
- 轨迹主列表与导出仍不带正文——正文只走按需抽屉，导出结构不变。

### 3.4 搜索（P2）

- 范围：当前已加载的 run 页（与翻页状态一致，翻页后重建匹配集）。
- 匹配字段：用户消息预览、工具名 / 目标、错误信息、模型名；命中行高亮 + 「上一个 / 下一个」跳转（复用现有展开 / 滚动定位逻辑）。
- 入口：`RunTracePanel` 顶部 toolbar（阈值输入区旁已有空间）加搜索框。

### 3.5 计时与用量补全（P1，UI 层为主）

- 轮次行增显：provider 徽标、解码耗时、吞吐量（分母为 0 显示「—」）。
- 请求编号：run 内 agent 轮次展示 `#seq`（VO 已有 `seq`）；跨 run 的会话累计编号与「累计至本轮 token」在 UI 层按已加载 runs 顺序累加（与后端 `totals` 交叉验证），零后端改动。
- 会话总览区可加「累计请求数」——纯 UI。

### 3.6 请求构成记录（P2，依赖埋点，先单独评估）

`llm_call` 今天不记提示词版本与工具目录（V113 建表列清单已确认：只有 provider / protocol / stream / effort 等调用元信息）。要做「这轮用了什么提示词、工具目录变了什么」，需在请求写入链路补埋点（prompt version id + 工具名清单），每请求多写数据且触及 harness 写入链路。**建议先落地 3.1–3.5，本节单独评审**；若做，落点建议是 `llm_call` 加两个轻列（`prompt_version_id`、`tools_digest`）而非新表，展示复用 3.3 抽屉的「请求构成」tab。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | VO 增量（startedAtMs / provider）+ 时间概览条带 + 记录详情下钻 API 与抽屉 + 解码 / 吞吐 / provider / 编号展示 | 中 |
| P2 | 轨迹内搜索 + 拖选聚焦 / 缩放（可选）+ 请求构成埋点与展示（单独评审） | 中 |

## 5. 风险与开放问题

- **开始时刻是估算值**：`created_at − duration_ms` 在工具并行 / 时钟偏差下有色条起点误差。缓解：tooltip 明确标注「估算」；不为色条新建列。开放问题：若未来要精确色条，在 tool 执行 WS 事件带 start timestamp 落 `session_activity`，自然获得精确起点。
- **历史数据退化**：秒级 `created_at` 的历史行、`first_token_ms` 为 null 的非流式调用，色条退化为单段 / 不画——与现有「未挂到轮」不猜口径一致，不做回填。
- **VO 增量兼容**：`startedAtMs` / `provider` 为增量字段；导出 CSV / JSON 是否追加新列在实施时定，并同步 `trace-export.ts` 与既有桌面测试（`trace-token.bugcheck.test.ts` 等）；旧版本桌面读新 VO 忽略新字段即可，无破坏性。
- **抽屉布局冲突**：中心 Tab 容器（`CenterTabContainer.vue`）内右侧抽屉需自理滚动与 z-index，不挂全局侧边栏。
- **正文下钻的敏感面**：参数 / 结果正文仅会话所属用户可见（复用现有权限），导出仍不带正文；负反馈转经验用过的 `[sensitive]` 路径替换规则不适用于下钻——那是给模型看的原料，不是给人看的排障视图。
- **开放问题**：请求构成埋点（3.6）的写入成本 vs 排障价值，需单独评审；P1 不依赖它。
- **开放问题**：时间条带放「run 展开区内」（P1 取此，零虚拟化成本）还是「总览下方的全局固定条带」（dsh 形态，需虚拟化）——若后续长 run 卡顿再评估全局化。

## 6. 测试要点

- VO：`startedAtMs` = `created_at` 换算 − `duration_ms`；`created_at` / `duration_ms` 缺失行为 null；`provider` 透出与 `llm_call.provider` 一致；历史秒级行换算不 NaN。
- 条带：并行工具色条互相重叠（不相加）；首字 / 解码两段宽度和 = 总宽；`startedAtMs` 为 null 的行不渲染色条；点击色条定位到对应行并展开。
- 解码 / 吞吐：`firstTokenMs` 为 null 时显示「—」；吞吐分母为 0 不除零。
- 下钻 API：会话归属校验（他人会话拒绝）；`tool_call_id` 不存在返回空态；参数 / 结果与 `message` 表原文一致；TOOL 消息 metadata 的审批标记带出。
- 搜索：命中高亮、无匹配空态、大小写不敏感、与翻页状态联动。
- 回归：导出 JSON / CSV 结构与既定口径一致；慢 / 贵阈值、编辑前分段、未挂到轮、执行中卡片、终态重拉行为不变。
