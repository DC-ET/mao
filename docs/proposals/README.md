# 提案目录（docs/proposals）

产品方向头脑风暴的产出。每份提案独立成文，评审通过后转入实施（届时可挪入 `docs/plan/` 或直接拆任务）。

## 已细化（2026-10-02）

| 提案 | 文档 | 一句话 | 建议优先级 |
|---|---|---|---|
| 跨会话长期记忆 | [2026-10-02-long-term-memory.md](2026-10-02-long-term-memory.md)（已转入实施，技术方案见 [docs/plan/2026-10-02-long-term-memory-technical-design.md](../plan/2026-10-02-long-term-memory-technical-design.md)） | 任务收尾自动沉淀用户/项目记忆，跨会话注入系统提示词，用户全权管理 | 高（留存价值最大） |
| Agent 资产化 | [2026-10-02-agent-asset-bundle.md](2026-10-02-agent-asset-bundle.md) | Agent 克隆 / bundle 导出导入 / 团队共享目录，配置即生态 | 低（工程量小，适合穿插） |
| 任务收件箱 | [2026-10-02-task-inbox.md](2026-10-02-task-inbox.md) | 聚合任务完成/提问/审批/子代理事件的站内通知中心，启用遗留 notification 表 | 高（补齐异步闭环） |

排期注意：记忆与收件箱都会动 `task-terminal.service.ts` 附近的相位收敛点，建议错开实施。

## 已评估、明确不做

- **知识库 / RAG**：需求真实但工程量大，与技能、工作区文件能力部分重叠；未来需求验证充分后可重启。
- **提示词回归评测（Evals）**：暂不做。

## 已排除的方向（与产品定位或约束冲突）

- 低代码工作流画布（README 明确"不是 Dify / n8n"）。
- 安卓原生推送（安卓壳约束不变；Web Push 作为收件箱 P3 的可选探索）。
- 语音输入、官方 SaaS、界面国际化（README 贡献边界已声明）。
