# 提案：团队知识层 —— 让一个成员踩过的坑，变成整个团队的 Agent 能力

- 状态：**已否决**（2026-10-19 评审：不做，存档勿再评审）
- 日期：2026-10-19
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

Mao 有三层「Agent 知识资产」：长期记忆（`memory` 域）、最佳实践经验（`agent_experiences`，经 prompt 引擎「最佳实践经验」分节注入）、指令库（`command` 域）。三层今天全部**孤岛化**，且方向完全相反：

| 层 | 归属 | 谁能写 | 谁能被注入 |
|---|---|---|---|
| 长期记忆 | 每用户私有（`MEMORY_SCOPES = ['USER','PROJECT']`，`memory/types.ts:89`） | 本人（LLM 自动抽取默认关，可手动） | 仅本人 |
| 最佳实践经验 | Agent 级 | **仅管理员**（写入口绑 `agent:write`，`agent/agent.routes.ts:69-73`） | 用该 Agent 的所有人 |
| 指令 | 用户级 / 系统级（userId=0，admin 广播） | 本人 / admin | 本人 / 全员 |

三个代码事实说明缺口：

1. **「项目级」记忆也是私有的**。`memory.repository.ts:106-114` 的 `listActiveProject` SQL 是 `WHERE user_id = ? AND scope='PROJECT' AND project_key=?`——PROJECT scope 只是把同一个人的记忆按项目分组，**不产生任何跨用户共享**。同在一个 workspace 项目的甲乙两人，各自攒各自的「这个项目用 pnpm」。
2. **普通用户踩的坑进不了任何 Agent**。经验表写权限是 `agent:write`（管理侧），普通用户在会话里发现「这个 Agent 总是忘记先跑 lint」，除了点踩没有出口。而点踩的闭环刚刚被拆除：负反馈转经验 0.0.276 上线、**0.0.299（三天前）整体下线**（`V157__remove_feedback_draft_setting.sql` 注释「后续重新设计后再上线」），今天管理员对着点踩明细只能点「忽略」（`feedback.routes.ts:136-140`）——踩过的坑既不进行为、也不进资产。
3. **平台其余部分全是团队形态**。角色权限、审计日志、用户预算、管理后台统计——都为多人部署而建，唯独「知识」这一层停留在单机玩具状态。

对一个自托管、以团队部署为目标的平台，这意味着：**Agent 的集体智能停在管理员一个人身上**。运维负责人离职 = 经验表停更；新人上手 = 从零攒记忆；甲乙两人的会话里各自重复发现同一个坑。

相邻方向的边界：

- **不是 RAG / 知识库**（两次否决）：不建语料检索与 embedding，只在既有记忆 / 经验注入管道上加 scope 与流转。
- **不是技能蒸馏**（已否决）：不从轨迹自动生成技能；本提案的知识流入全部人工发起（提升 / 提案），LLM 只做可选的起草辅助。
- **不是重接被拆除的反馈闭环**：0.0.299 下线的是「点踩明细 → LLM 起草 → 转经验」这一条窄路径（且移除决定是「后续重新设计后再上线」）。本提案是更广的重新设计——**任何会话消息可发起经验提案**，不依赖点踩；且 TEAM 记忆是与经验并行的新资产，不是它的替代。
- **不是多租户隔离**：TEAM scope 是实例内共享（单租户自托管假设），不引入组织树。

## 2. 目标 / 非目标

**目标**

1. **TEAM 级记忆（P1）**：`memory_item` 新增 `TEAM` scope——实例内所有登录用户可见、可注入。注入走既有 `MemoryHint` 管道（`memory.service.ts:213-230` 组装 hints → prompt 引擎「长期记忆」分节），新增 TEAM 段的注入条数上限（与 USER 8 条 / PROJECT 12 条并列预算，默认 8，可配）。
2. **个人 → 团队提升流（P1）**：设置页「长期记忆」里，用户可把一条自己的记忆「提升为团队记忆」——提升即对全员可见（显式确认 + 审计留痕，写 `audit` 域）。反向不提供（团队记忆不可私有化，避免扩散失控）。
3. **经验提案通道（P2）**：普通用户可对「任意一条助手消息」发起「这值得成为经验」提案（消息操作菜单新入口，类似点踩的入口位置），选择目标 Agent，附一句自己的批注；提案进管理员审核队列——管理后台新页 + 收件箱新 kind（`EXPERIENCE_PROPOSAL`，三处同改：`backend-ts/src/inbox/types.ts` 白名单、`@mao/contracts` 的 `InboxKind`、桌面抽屉图标与通知偏好）。批准 → 写入既有 `agent_experiences`（**运行时注入链路零改动**，prompt 引擎的「最佳实践经验」分节原样消费）；驳回 → 通知提议人并可附理由。
4. **审核队列管理（P2）**：管理后台「经验提案」页：待审 / 已批 / 已驳列表、批量批准、按 Agent 筛选；提案含来源会话深链（跳转到原消息，对齐分享 / 轨迹的跳转模式）。
5. **可观测（P3）**：提案通过率、各 Agent 经验条目数趋势（管理后台用量分析同款图表模式）；TEAM 记忆的注入命中（上下文透视 manifest 已按 id 收集注入记忆，TEAM 段天然可区分）。

**非目标**

- 不做 TEAM 记忆的 LLM 自动收集（P1 仅手动创建 + 个人提升；自动收集的误判在团队尺度上是放大镜——开放问题留 P3）。
- 不做经验提案的 LLM 自动起草 / 聚类去重（0.0.299 下线路径的核心教训就是「LLM 起草 + 人确认」的交互成本不划算；P2 先做纯人工流转，P3 评估批量去重辅助）。
- 不做团队记忆的可见性分组（按角色 / 部门可见）——实例内全员可见一种形态；敏感内容靠提升前的显式确认与审计约束。
- 不做「经验的反投票 / 衰减」——agent_experiences 的既有生命周期管理（管理员编辑 / 删除）不变。
- 不动 `LlmCallScene.feedback_experience_draft` 枚举成员的存废（下线后残留的枚举项按契约清理惯例另行处理，不在本提案）。

## 3. 方案要点

### 3.1 数据模型（迁移号顺延，当前已到 V160）

P1（TEAM 记忆）：

- `memory_item` 无表结构变化（scope 是字符串列），只需代码侧 `MEMORY_SCOPES` 扩为 `['USER','PROJECT','TEAM']`——**零迁移**。TEAM 行 `user_id` 仍记提升人（审计用），`project_key` 为空。
- 注入查询新增 `listActiveTeam(limit)`（无 userId 条件）；hints 组装时 USER → PROJECT → TEAM 顺序（与既有「顺序稳定化保前缀缓存」的纪律一致，`memory.repository.ts:100-101` 的 ORDER BY id ASC 同款）。

P2（经验提案）：

```sql
CREATE TABLE IF NOT EXISTS `experience_proposal` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`      BIGINT NOT NULL COMMENT '目标 Agent',
    `proposer_id`   BIGINT NOT NULL COMMENT '提议人',
    `content`       VARCHAR(500) NOT NULL COMMENT '经验正文（对齐 agent_experiences 300 字上限取 500）',
    `note`          VARCHAR(500) NULL COMMENT '提议人批注：为什么这是经验',
    `origin_session_id` BIGINT NULL COMMENT '来源会话（深链）',
    `origin_message_id` BIGINT NULL COMMENT '来源消息（深链）',
    `status`        VARCHAR(16) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING / APPROVED / REJECTED',
    `reviewer_id`   BIGINT NULL COMMENT '审核人',
    `review_note`   VARCHAR(500) NULL COMMENT '驳回理由',
    `experience_id` BIGINT NULL COMMENT '批准后写入的 agent_experiences 行 id',
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    `reviewed_at`   DATETIME NULL,
    INDEX `idx_proposal_status` (`status`, `created_at`),
    INDEX `idx_proposal_agent` (`agent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='经验提案：普通用户 → 管理员的经验流入通道';
```

- 批准即调既有 `agent-experience.service.ts` 的创建路径（`agent:write` 校验对**审核动作**保留——管理员本就是持权方；提议人不碰该权限）。
- 并发保护：同一提案只允许一次审核（状态机 PENDING → APPROVED/REJECTED，UPDATE 带 status 前置条件，对齐一次性定时任务收口的状态机修法）。

### 3.2 权限

- 提升个人记忆为 TEAM：登录态即可（改的是自己的行 scope 字段）。
- 提案：登录态即可（写 proposal 表，不碰经验表）。
- 审核 / 管理 TEAM 记忆：`agent:write`（与经验管理同权）；TEAM 记忆的删除收在管理员侧（设置页只读展示 + 提升入口，管理后台可删）。
- 注入：TEAM 记忆对所有会话生效（与 USER/PROJECT 同管道，无新增开关——P1 不为 TEAM 单独开会话级开关，保持模型简单；开放问题留 P3）。

### 3.3 前端

- 桌面设置页「长期记忆」：每条记忆行加「提升为团队」按钮（二次确认：明文 + 「全员可见」警示）；TEAM 段独立分区展示（只读，管理员可删）。
- 消息操作菜单（`MessageBubble.vue` 点踩同级）：新增「提为经验」→ 选 Agent（下拉，默认当前会话 Agent）+ 批注 → 提交；提交后 toast 说明「等待管理员审核」。
- 管理后台：「经验提案」菜单（运行组，与点踩反馈并列）——待审队列 + 筛选 + 批量批准 + 深链；收件箱新 kind 的列表项与偏好开关。
- 上下文透视：TEAM 记忆段在 manifest 里可区分（scope 已有，透视 UI 加一行「团队记忆 N 条」——对齐既有分节展示，零新机制）。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | TEAM 记忆 scope（零迁移）+ 注入管道与上限 + 提升流（设置页 + 审计）+ 上下文透视分区 | 小~中 |
| P2 | 经验提案全链路（消息入口 + proposal 表 + 审核页 + 收件箱 kind 三处同改 + 批准写经验） | 中 |
| P3 | 提案通过率 / 经验趋势看板；TEAM 记忆自动收集评估；批量去重辅助评估 | 小 |

## 5. 风险与开放问题

- **注入预算膨胀**：USER(8) + PROJECT(12) + TEAM(8) = 28 条封顶，prompt 体积可控但挤压空间。缓解：TEAM 上限默认 8 可配；上下文透视使占用可见；超限时按 id ASC 截断（既有纪律）。
- **前缀缓存抖动**：TEAM 段顺序必须稳定（id ASC），任何人提升记忆都改变所有人的前缀——这是**共享资产的固有代价**，与 USER 段自己攒记忆等价，不引入新问题类；manifest 与 warn 观测已能定位。
- **隐私与合规**：个人记忆提升 = 把可能含私人信息的内容广播给全员。缓解：提升时展示全文 + 显式确认；审计留痕（谁提升了哪条）；TEAM 记忆列表对全员只读——**这是产品决策不是技术决策**：自托管小团队场景下「全员可见」是可接受默认，若评审要求按角色可见，P1 范围需重估（+1 个规模档）。
- **审核队列淤积**：提案没人审 = 通道死亡。缓解：收件箱实时提醒 + 待审数量进管理后台概览（对齐审批待办的呈现模式）；批量批准降低操作成本。
- **滥用面**：提议无门槛意味着噪声提案。缓解：提议人可见自己的历史与驳回理由（声誉自调节）；单用户每日提议上限（默认 20，可配）防刷。
- **开放问题**：TEAM 记忆要不要会话级开关（对齐 USER 记忆的会话开关）——P1 不做（模型复杂度），P3 按反馈评估。
- **开放问题**：经验批准后，提议人是否收到「已生效」通知——建议发（收件箱，零成本），P2 顺手做。
- **开放问题**：`agent_experiences` 单条 300 字上限（`agent-experience.service.ts:24`）对提案是否够用——建议提案也钳 300，与经验表对齐；500 列宽只是留余量。

## 6. 测试要点

- 模型层：TEAM 记忆跨用户可见与注入（A 提升 → B 的会话注入）；TEAM 行不进 USER/PROJECT 查询；注入上限截断顺序（id ASC）。
- 提升流：提升后原 USER 行如何处理（建议：原行标记 DISMISSED 或直接改 scope——评审定，两者都要有用例）；审计记录完整；非本人不能提升别人的记忆。
- 提案：创建（含必填校验、来源深链字段）；审核状态机（重复审核第二次失败）；批准 → 经验行落库且内容一致 + prompt 注入生效（端到端：建提案 → 批准 → 新会话系统提示含该经验）；驳回 → 提议人通知。
- 注入回归：TEAM 段加入后 USER/PROJECT 注入行为不变；manifest 分节计数正确；既有记忆 spec 全绿。
- 契约：`InboxKind` 加成员后 contracts / inbox types.ts / 桌面图标与偏好三处编译期穷尽通过（按 AGENTS.md 三处同改规范）。
- 前端：提升确认流；消息菜单提案流；管理后台队列（筛选 / 批量 / 深链跳转）。
