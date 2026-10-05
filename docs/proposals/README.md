# 提案目录（docs/proposals）

产品方向头脑风暴的产出。每份提案独立成文，评审通过后转入实施（届时可挪入 `docs/plan/` 或直接拆任务）。

## 已细化（2026-10-02）

| 提案 | 文档 | 一句话 | 建议优先级 |
|---|---|---|---|
| 跨会话长期记忆 | [2026-10-02-long-term-memory.md](2026-10-02-long-term-memory.md)（已转入实施，技术方案见 [docs/plan/2026-10-02-long-term-memory-technical-design.md](../plan/2026-10-02-long-term-memory-technical-design.md)） | 任务收尾自动沉淀用户/项目记忆，跨会话注入系统提示词，用户全权管理 | 高（留存价值最大） |
| Agent 资产化 | [2026-10-02-agent-asset-bundle.md](2026-10-02-agent-asset-bundle.md) | Agent 克隆 / bundle 导出导入 / 团队共享目录，配置即生态 | 低（工程量小，适合穿插） |
| 任务收件箱 | [2026-10-02-task-inbox.md](2026-10-02-task-inbox.md)（已实施，技术方案见 [docs/plan/2026-10-02-task-inbox-technical-design.md](../plan/2026-10-02-task-inbox-technical-design.md)，0.0.235 发版） | 聚合任务完成/提问/审批/子代理事件的站内通知中心（实施时改为 V131 新建 notification 表：原表已在 V058 被 DROP） | 高（补齐异步闭环） |

排期注意：记忆与收件箱都会动 `task-terminal.service.ts` 附近的相位收敛点，建议错开实施。

## 第二批（2026-10-05，待评审）

背景：首批三件套（记忆 / 收件箱 / 资产化）已全部实施，本批为下一阶段方向。三个提案分别补三块拼图：**生态**（分发）、**编排**（Teams）、**集成**（开放 API）。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 资产分发闭环 | [2026-10-05-asset-distribution.md](2026-10-05-asset-distribution.md)（已转入实施，技术方案见 [docs/plan/2026-10-05-asset-distribution-technical-design.md](../plan/2026-10-05-asset-distribution-technical-design.md)） | 依赖一键补装、bundle URL 导入与更新检查、技能独立 bundle | 小~中 |
| 多 Agent 协作 | [2026-10-05-agent-teams-dag.md](2026-10-05-agent-teams-dag.md) | 任务 DAG 自动派发 + 队友信箱 + worktree 隔离（编排即工具调用，非画布） | 中 |
| 开放 API | [2026-10-05-open-api-webhook.md](2026-10-05-open-api-webhook.md)（已转入实施，技术方案见 [docs/plan/2026-10-05-open-api-webhook-technical-design.md](../plan/2026-10-05-open-api-webhook-technical-design.md)） | API Token + 入站 Webhook 触发器 + 出站事件订阅，让外部系统驱动 Agent | 中 |

排期注意：资产分发 P2 的 bundle URL registry 是开放 API 之外唯一的对外暴露面，若两个提案都做，安全评审合并做一次。

## 已评估、明确不做

以下两项已复审定案，**不再重启、不再提案**（存档文档已标否决，勿再评审）：

- **知识库 / RAG**：2026-10-02 首评暂缓，2026-10-05 二次提案后仍定不做（与技能/工作区文件能力重叠、工程量大、需新增 embedding 设施）。存档：[2026-10-05-knowledge-rag.md](2026-10-05-knowledge-rag.md)。
- **提示词回归评测（Evals）**：2026-10-05 提案后定不做。存档：[2026-10-05-agent-evals.md](2026-10-05-agent-evals.md)。

## 已排除的方向（与产品定位或约束冲突）

- 低代码工作流画布（README 明确"不是 Dify / n8n"）。
- 安卓原生推送（安卓壳约束不变；Web Push 作为收件箱 P3 的可选探索）。
- 语音输入、官方 SaaS、界面国际化（README 贡献边界已声明）。
