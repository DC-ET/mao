# 提案：多 Agent 协作 —— 任务 DAG 与队友信箱

- 状态：提案，未评审
- 日期：2026-10-05
- 提案总览：见 `docs/proposals/README.md`
- 出处：`docs/research/agent-improvement-recommendations.md` P3（s07 任务 DAG / s09 Agent Teams / s12 Worktree），本文为收窄后的落地方案

## 1. 背景与现状

子代理基建已经很厚：spawn_subagent / subagent_followup / check_subagent / cancel_subagent / wait_subagents 五个工具，DELEGATE / BACKGROUND / FOLLOWUP 三种调用形态，default / explorer / worker / reviewer 角色注册（`harness/delegate/agent-definition-registry.ts`），后台子代理管理与崩溃恢复，文件变更聚合回父会话（`file-change-copy.ts`）。

缺的是"编排"这一层语义：

1. **依赖关系靠主 Agent 脑补**。wait_subagents 只能汇合等待，表达不了"B 等 A 的产物、C 只依赖 A"这类 DAG；主 Agent 只能轮询或串行，长任务浪费轮次与 token。
2. **后台子代理之间无法通信**。两个并行 worker 想对齐口径，只能各自把结论写回父会话让主 Agent 转达。
3. **编排状态不持久**。崩溃恢复能救单个子代理执行，但"计划了 8 步、完成到第 3 步"的图没有落点。

## 2. 目标 / 非目标

**目标**

1. 主 Agent 可一次性创建带依赖关系的任务图，系统按拓扑序自动派发后台子代理、回填结果、解锁下游。
2. 运行中的子代理可通过信箱互发消息，主 Agent 与子代理都能读。
3. 任务图持久化，崩溃恢复后可续跑。

**非目标（定位红线）**

- **不做可视化编排画布 / DSL**——README 明确"不是 Dify / n8n"。编排由主 Agent 用工具即席构建，图就是它的计划，用户在 TaskInspector 里看即可。
- 不做跨会话常驻"团队"实体（队友 = 按需 spawn 的子代理，角色沿用 agent-definition-registry）。
- 不引入新的调度守护进程（挂进现有 subagent 管理与恢复机制）。

## 3. 技术方案

### 3.1 任务 DAG（P1）

- 复用 todo 域升级：todo 表加 `blocked_by JSON`（上游节点 id 数组）与 `graph_id`；现有 task_create/list/update 工具不动，新增 `task_graph_create(nodes[])` 一次建图。
- 派发器：`harness/delegate/` 新增 graph-scheduler——节点完成事件（task_update 或子代理终态回填）触发下游解锁；就绪节点自动 spawn BACKGROUND 子代理（prompt = 节点描述 + 上游产物摘要），复用 background-subagent-manager。
- 上游产物传递：把上游节点最终回复摘要注入下游 prompt（硬性长度上限，摘要策略与 tool-result-summarizer 同源）。
- 持久化即 todo 表本身；崩溃恢复沿用 subagent-execution-recovery，图状态由 todo 状态重推，不需要独立的图状态机表。

### 3.2 队友信箱（P2）

- 表 `agent_mailbox`（id, to_session, from_session, graph_id, body, created_at, read_at）。
- 工具 `teammate_send(target, body)` / `teammate_inbox()`；新消息在收件方**下一轮 observe 时注入**（不打断进行中的工具调用），主 Agent 的 check_subagent 返回值附带"有未读信件"标记。

### 3.3 Worktree 隔离（P3，可选）

- 云端工作区 git 已就绪：并行写文件的 worker 子代理各 checkout 一个 git worktree，完成后由主 Agent 决定合并顺序。
- 需适配 `file-change-copy.ts` 的路径回写（worktree 前缀映射回主工作区）。
- LOCAL 模式暂不做（本地仓库形态多样，风险大于收益）。

## 4. 安全与治理

- 图规模上限：节点 ≤ 20、深度 ≤ 5、并发运行子代理数沿用现有上限，`task_graph_create` 超限拒绝。
- 无环校验：建图时拓扑排序失败即拒绝。
- 失败语义：FAILED 节点不自动重试、下游全部冻结，写收件箱（QUESTION_PENDING 形态）提示用户接管。
- 信箱消息作为工具调用记录进审计。

## 5. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | todo 表扩展 + `task_graph_create` + graph-scheduler + TaskInspector 图视图（TodoChecklist 样式展示依赖） | 中 |
| P2 | agent_mailbox + 两个信箱工具 + 收件方轮内注入 | 中 |
| P3 | 云工作区 worktree + file-change 路径映射（可选） | 中 |

## 6. 风险与开放问题

- **编排失控**（循环派发、子代理风暴）：图只允许有限状态流转（PENDING → READY → RUNNING → DONE/FAILED/CANCELLED）；失败冻结待人；所有派发走审计。
- **上下文膨胀**：上游产物注入有硬上限；实施时复用压缩服务同类策略。
- **调试难度**：图视图是 P1 必做而非可选——没有可视状态，用户无法理解 Agent 在干什么，这是本提案的 UX 底线。
- **开放问题**：失败节点是否允许"自动重试一次"（倾向 P1 不做，人工触发）；信箱是否允许跨图通信（倾向不允许，graph_id 隔离）。

## 7. 测试要点

- 建图：环检测、超限拒绝、blocked_by 引用不存在节点。
- 派发：拓扑序正确、上游失败下游冻结、崩溃恢复后续跑不重复派发已完成节点。
- 信箱：读后置已读、收件方下一轮可见、跨图隔离。
- 工具回归：`task_graph_create` / `teammate_send` / `teammate_inbox` 成功/失败/缺参 + summarizer + toolDisplay 同步（AGENTS.md 规范）。
