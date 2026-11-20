# 提案：Agent 评测与提示词回归（Evals）

- 状态：**已否决**（2026-10-05 复审：明确不做，不再提案）。本文仅存档，勿再评审。
- 日期：2026-10-05
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

Agent 的提示词已有版本化（`agent_prompt_versions`，可回滚）与点踩反馈（feedback 域 + admin 反馈视图），但"改提示词"仍是开环操作——没有任何机制回答"这次改动有没有让 Agent 变差"。

资产化之后问题被放大：共享目录上架的 Agent 会被更新、bundle 会被跨实例分发，所有这些改动都没有质量参照。

上一批评估结论是"暂不做"。当时评测缺三个挂靠点：没有提示词版本化、没有反馈数据、没有可复用的批量执行通道。

## 2. 为什么重启 / 为什么是现在

1. **版本化就位**：PromptHistory 支持任意版本回滚，评测结果可以逐版本归档对比。
2. **批量执行通道就位**：schedule 域已验证"复用主 harness loop 批量/排队跑会话"可行（会话忙时 messageQueue 排队），评测 runner 是同一模式的受控变体。
3. **资产化的质量缺口**：共享目录上架目前无任何质量信息；评测是未来"上架建议分"的数据来源（本文不做强制门槛）。

## 3. 目标 / 非目标

**目标**

1. 管理员可为 Agent 建评测集（用例 = 输入 + 断言），一键批量跑，出通过率报告。
2. 提示词新版本发布前可跑回归：新旧版本通过率对比一目了然。
3. 断言支持三类：规则断言（包含/正则/JSON 路径）、工具调用断言（"必须调用过 web_search"）、LLM 评审（按 rubric 打分）。

**非目标**

- 不做 CI 强制门禁 / 自动阻断（报告仅供参考，是否采用新版本由人决定）。
- 不做线上流量回放、不做 A/B。
- 不做面向普通用户的功能（纯管理员向）。

## 4. 技术方案

### 4.1 数据模型（迁移号顺延）

```sql
eval_suite    (id, agent_id, name, max_turns, judge_model_id, created_by, created_at, updated_at)
eval_case     (id, suite_id, name, input TEXT, seed_context TEXT, assertions JSON, enabled, created_at)
eval_run      (id, suite_id, prompt_version, status, pass_rate, token_usage, started_at, finished_at)
eval_run_case (id, run_id, case_id, status, final_reply, tool_trace JSON, assertions_result JSON, latency_ms)
```

### 4.2 Runner

- 新域 `backend-ts/src/eval/`：runner 以**影子会话**跑 HarnessService 主循环（source=EVAL）。
- 隔离是硬约束：影子会话不出现在用户会话列表；`task-terminal.service.ts` 的 finishExecution 对 source=EVAL 跳过记忆抽取与经验写入（挂点已有 source 过滤先例：SCHEDULED）。
- 成本护栏：每 run 并发 ≤ 2、每用例 max_turns 受 suite 配置约束、run 级 token 预算上限，超预算熔断；跑完经任务收件箱通知（TASK_COMPLETED，source=EVAL）。
- LLM 评审用独立便宜模型（judge_model_id），评审失败不阻塞规则断言统计。

### 4.3 断言求值

- 规则断言：contains / not_contains / regex / json_path，对最终回复或指定轮次求值。
- 工具断言：tool_trace（会话工具调用记录的投影）断言"调用过 / 未调用某工具、调用次数 ≤ N"。
- LLM 评审：rubric 文本 + 1~5 分，分数与理由落 `eval_run_case`。

### 4.4 界面落点

- admin：Agent 详情新增"评测"页签——用例 CRUD、发起运行、历史 run 通过率趋势、run 详情逐用例展开（复用 session 回放的 ToolCallCard / MessageBubble 组件）。
- 版本对比：选两个 prompt_version 的 run，输出用例级通过/失败 diff（哪些用例从挂变过、从过变挂）。
- desktop 不加东西：评测是治理动作，入口在 admin。
- P2 顺手项：feedback 点踩样本一键转为评测用例（用例来自真实会话，减少过拟合）。

## 5. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 四张表 + runner + 规则断言 + admin 用例管理与运行报告 | 中 |
| P2 | 工具断言 + LLM 评审 + 版本对比视图 + 点踩转用例 | 中 |
| P3 | 共享目录上架时展示"最近评测通过率"（仅展示，不设门槛） | 小 |

## 6. 风险与开放问题

- **评测不稳定性**：模型漂移/温度导致同版本重跑结果不同。缓解：报告以"趋势 + 用例级 diff"呈现而非单一绝对分数；run 记录模型与时间，跨模型比较需显式确认。
- **成本失控**：run 预算熔断 + 每套件每日运行次数配额（简单计数，不做限流框架）。
- **为评测而过拟合**：文档明确建议用例来源以真实会话为主（P2 点踩转用例就是为这个）。
- **开放问题**：影子会话是否完全绕开 agent_experiences 写入（必须绕开，与记忆抽取同一挂点处理）；用例里若含密钥/敏感数据，保存时提示脱敏。

## 7. 测试要点

- 断言求值纯函数单测：规则、工具、评审分数归一化。
- runner：影子会话不出现在会话列表、不触发记忆/经验写入、预算熔断、并发上限。
- 版本对比 diff 正确性；`eval:*` 权限码仅管理员角色可见。
- 与 schedule 的共存：影子会话不占用用户会话的排队队列。
