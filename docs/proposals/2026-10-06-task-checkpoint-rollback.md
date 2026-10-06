# 提案：任务检查点与工作区回滚 —— 单任务时间轴上的"撤销"

- 状态：**已否决**（2026-10-06 评审：不做。本文仅存档）
- 日期：2026-10-06
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

Agent 干活免不了改错文件。用户今天的"撤销"手段只有：

1. **CLOUD 工作区手动 git**：`file.routes.ts` 提供的 git 能力是 status / diff / commit / pull / push（`workspace-git.service.ts`、`git-write-operation.service.ts`），没有 revert / reset / checkout 任何回退路由；且工作区不一定本来就是 git 仓库（新建 / 复用 / clone 三种来源）。
2. **LOCAL 靠用户自己的 git 习惯**，平台不参与。

而 harness 侧其实已经攒齐了地基：

- `message_file_change` 表（V037）逐消息记录文件变更（CREATED / MODIFIED、行数、diff）；
- `agent-loop.ts` 的 `rollbackIncompleteRound()` 已能在中断时回滚未完成的 tool 消息——"回滚"概念在消息侧已有先例；
- `workspace-git.service.ts` 证明服务端操作工作区 git 的管线成熟。

与两件已有/在办的事划清边界：

- **与 side-session fork（docs/plan/2026-10-06-side-session-fork-design.md）方向相反**：fork 是"向前"把上下文复制到新会话，检查点是"向后"把同一会话的文件与消息恢复到历史水位，互补不重叠。
- **与已否决的多 Agent 协作（Worktree 分支并行）无关**：本提案不引入并行执行宇宙，只是单任务时间轴上的 undo。

## 2. 目标 / 非目标

**目标**

1. CLOUD 任务执行过程中在轮次边界自动打检查点（工作区文件快照 + 会话消息水位），默认保留最近 N 个。
2. 会话检查器可查看检查点列表、预览"当前工作区 vs 检查点"的 diff，一键回滚：文件树恢复 + 删除该点之后的消息。
3. 回滚永远是显式人工动作，绝不自动触发。

**非目标**

- 不做 LOCAL 工作区回滚（用户本机自管 git；P3 仅做提示）。
- 不做自动回滚 / 失败自动重试策略。
- 不做检查点之间的分支比较（回到唯一时间轴）。

## 3. 技术方案

### 3.1 检查点采集（P1）

- 影子快照库：`git --git-dir=<data>/snapshots/<wsId>.git --work-tree=<workspace>` 提交全量快照。不污染工作区自身的 .git，非 git 目录（新建 / 复用来源）同样适用；git 对象天然增量，存储可控。
- 排除清单：node_modules / dist / .cache 等默认不进快照（复用 ignore 语义，清单可配）。
- 表 `task_checkpoint`（id, session_id, message_id, commit_sha, file_stats JSON, created_at）：每轮 assistant 消息落库后异步打点；上限滚动淘汰（如 20 个 / 7 天，可配）。

### 3.2 回滚执行（P2）

- 预检：`git diff-tree` 对比当前工作区与检查点 tree，产出只读 diff 预览（复用 FileChangePanel 渲染）。
- 确认后：`read-tree + checkout -f` 恢复文件；同事务删除 `message_id` 之后的消息与 `message_file_change` 行。
- 运行态锁：会话执行中禁止回滚（与现有忙时语义一致，给出明确报错）。

### 3.3 LOCAL 提示与清理（P3）

- LOCAL 任务完成时在文件变更面板提示"建议自行 git commit 固化本任务改动"（纯文案，不动用户目录）。
- 检查点保留策略生效：滚动淘汰 + 手动删除单个检查点。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 影子快照库 + 轮次自动打点 + 检查点列表展示 | 小~中 |
| P2 | diff 预览 + 一键回滚（文件 + 消息水位） | 中 |
| P3 | LOCAL 提示、保留策略、手动清理 | 小 |

## 5. 风险与开放问题

- **快照体积与 IO**：排除清单 + 滚动淘汰兜底；打点异步化不阻塞主循环；超大盘工作区（>1GB）可配关闭自动打点。
- **压缩后回滚语义**：若检查点之后发生过 compaction（`session_compaction.last_compacted_msg_id` 晚于检查点水位），消息侧回滚需要重建上下文。P2 先做两段式降级：压缩发生后只允许"仅回滚文件"，消息侧提示不可回滚；全量重建列为开放问题。
- **与用户手动 git 的冲突**：影子库只读工作区内容，不碰用户 .git；工作区本身是 git 仓库且有未提交改动时，预检页明示"回滚将覆盖以下未提交改动"。
- **开放问题**：interactive terminal 里用户手动改过的文件也会被 checkout 覆盖——预检 diff 是唯一防线，是否需要"回滚前自动把当前状态存为反向检查点"（建议做，成本为一个额外 commit）。

## 6. 测试要点

- 非 git 工作区 / git 工作区两种来源的打点一致性；排除目录不进快照。
- 回滚后文件树、消息数、`message_file_change` 三者与检查点水位一致。
- 压缩发生后回滚被降级拦截且文案明确。
- 执行中回滚被拒；越权会话回滚被拒。
- 快照库损坏（目录被删）时打点失败不阻塞任务，检查点标记不可用。
