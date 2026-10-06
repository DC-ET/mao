# 提案目录（docs/proposals）

产品方向头脑风暴的产出。每份提案独立成文，评审通过后转入实施（届时可挪入 `docs/plan/` 或直接拆任务）。

## 已细化（2026-10-02）

| 提案 | 文档 | 一句话 | 建议优先级 |
|---|---|---|---|
| 跨会话长期记忆 | [2026-10-02-long-term-memory.md](2026-10-02-long-term-memory.md)（已转入实施，技术方案见 [docs/plan/2026-10-02-long-term-memory-technical-design.md](../plan/2026-10-02-long-term-memory-technical-design.md)） | 任务收尾自动沉淀用户/项目记忆，跨会话注入系统提示词，用户全权管理 | 高（留存价值最大） |
| Agent 资产化 | [2026-10-02-agent-asset-bundle.md](2026-10-02-agent-asset-bundle.md) | Agent 克隆 / bundle 导出导入 / 团队共享目录，配置即生态 | 低（工程量小，适合穿插） |
| 任务收件箱 | [2026-10-02-task-inbox.md](2026-10-02-task-inbox.md)（已实施，技术方案见 [docs/plan/2026-10-02-task-inbox-technical-design.md](../plan/2026-10-02-task-inbox-technical-design.md)，0.0.235 发版） | 聚合任务完成/提问/审批/子代理事件的站内通知中心（实施时改为 V131 新建 notification 表：原表已在 V058 被 DROP） | 高（补齐异步闭环） |

排期注意：记忆与收件箱都会动 `task-terminal.service.ts` 附近的相位收敛点，建议错开实施。

## 第二批（2026-10-05）

背景：首批三件套（记忆 / 收件箱 / 资产化）已全部实施，本批为下一阶段方向。本批评审结果：资产分发闭环与开放 API 已转入实施；多 Agent 协作不做（见下方台账）。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 资产分发闭环 | [2026-10-05-asset-distribution.md](2026-10-05-asset-distribution.md)（已转入实施，技术方案见 [docs/plan/2026-10-05-asset-distribution-technical-design.md](../plan/2026-10-05-asset-distribution-technical-design.md)） | 依赖一键补装、bundle URL 导入与更新检查、技能独立 bundle | 小~中 |
| 开放 API | [2026-10-05-open-api-webhook.md](2026-10-05-open-api-webhook.md)（已转入实施，技术方案见 [docs/plan/2026-10-05-open-api-webhook-technical-design.md](../plan/2026-10-05-open-api-webhook-technical-design.md)） | API Token + 入站 Webhook 触发器 + 出站事件订阅，让外部系统驱动 Agent | 中 |

排期注意：资产分发 P2 的 bundle URL registry 是开放 API 之外唯一的对外暴露面，若两个提案都做，安全评审合并做一次。

## 第三批（2026-10-06）

背景：第二批两件转入实施后，基于代码现状摸底（工具并行已支持、用量无成本概念、审批无规则记忆、无会话分享/导出、压缩用主模型）产出的五个方向。本批评审结果（2026-10-06）：**检查点回滚不做**（存档勿评审）；**其余四件转入实施**，技术方案见 `docs/plan/2026-10-06-*-technical-design.md`。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 任务检查点与工作区回滚 | [2026-10-06-task-checkpoint-rollback.md](2026-10-06-task-checkpoint-rollback.md)（已否决，存档） | 轮次边界自动快照工作区+消息水位，Agent 改错文件可一键退回 | — |
| 用量成本核算与预算管控 | [2026-10-06-usage-cost-budget.md](2026-10-06-usage-cost-budget.md)（已转入实施，技术方案见 [docs/plan/2026-10-06-usage-cost-budget-technical-design.md](../plan/2026-10-06-usage-cost-budget-technical-design.md)） | 模型价格→成本落账，用户/Agent 月度预算软提醒硬拦截；开放 API/Webhook 时代给费用装闸门 | 中 |
| 工具审批规则 | [2026-10-06-approval-rules.md](2026-10-06-approval-rules.md)（已转入实施，技术方案见 [docs/plan/2026-10-06-approval-rules-technical-design.md](../plan/2026-10-06-approval-rules-technical-design.md)） | 审批弹窗第三选项"本会话总是允许"+用户级 allowlist，在逐次审批与 FULL 档之间给中间态 | 中 |
| 上下文透视与手动治理 | [2026-10-06-context-inspector.md](2026-10-06-context-inspector.md)（已转入实施，技术方案见 [docs/plan/2026-10-06-context-inspector-technical-design.md](../plan/2026-10-06-context-inspector-technical-design.md)） | 检查器展示模型实际收到的上下文构成（分节/记忆条目/压缩摘要），支持手动压缩与单会话记忆开关 | 中 |
| 会话分享与导出 | [2026-10-06-session-share-export.md](2026-10-06-session-share-export.md)（已转入实施，技术方案见 [docs/plan/2026-10-06-session-share-export-technical-design.md](../plan/2026-10-06-session-share-export-technical-design.md)） | 只读快照链接（水位冻结）+ Markdown 导出，让任务结果走出会话列表 | 中 |

排期注意：预算 WARN 结算挂在 `task-terminal.service.ts` 的 `finishExecution`（记忆/收件箱曾动过的相位收敛点），与在途同类改动错开实施；上下文透视动 prompt-engine / agent-loop / compaction 链路，审批规则动 tool-dispatcher 判门，两者与分享（session 域 + desktop）互不冲突。迁移号 V135 起按实施顺序顺延。

## 已评估、明确不做

以下各项已复审定案，**不再重启、不再提案**（存档文档已标否决，勿再评审）：

- **知识库 / RAG**：2026-10-02 首评暂缓，2026-10-05 二次提案后仍定不做（与技能/工作区文件能力重叠、工程量大、需新增 embedding 设施）。存档：[2026-10-05-knowledge-rag.md](2026-10-05-knowledge-rag.md)。
- **提示词回归评测（Evals）**：2026-10-05 提案后定不做。存档：[2026-10-05-agent-evals.md](2026-10-05-agent-evals.md)。
- **多 Agent 协作（任务 DAG / 队友信箱 / Worktree）**：2026-10-05 提案后定不做（现有子代理 + wait 汇合已覆盖当前需求，编排语义引入的失控面与调试成本大于收益）。存档：[2026-10-05-agent-teams-dag.md](2026-10-05-agent-teams-dag.md)。

## 已排除的方向（与产品定位或约束冲突）

- 低代码工作流画布（README 明确"不是 Dify / n8n"）。
- 安卓原生推送（安卓壳约束不变；Web Push 作为收件箱 P3 的可选探索）。
- 语音输入、官方 SaaS、界面国际化（README 贡献边界已声明）。
