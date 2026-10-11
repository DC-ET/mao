# 提案：负反馈闭环（Feedback Loop）—— 点踩了，然后呢？

- 状态：**已确认**（2026-10-11 评审通过，技术方案见 [docs/plan/2026-10-11-feedback-experience-loop-technical-design.md](../plan/2026-10-11-feedback-experience-loop-technical-design.md)，决策记录 16 条于 2026-10-11 逐条确认）
- 日期：2026-10-11
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

点踩反馈的采集侧已经做了两轮：桌面端每条助手回复可点踩并选原因（`WRONG_RESULT` / `SLOW_RESPONSE` / `NOT_SOLVED` / `OTHER`，`message_feedback` 表，V123），飞书进度卡也能点踩（V125 加 `source` 列区分来源），管理后台有汇总与明细页（`feedback:read` 权限）。

但**采集之后没有任何东西发生**：

1. **对 Agent 零影响**。反馈只进 `message_feedback` 表供管理员看，Agent 下次执行时提示词照旧。同一个错误会一遍遍重演——用户点踩的唯一作用是在管理后台多一行记录。
2. **对用户零回应**。用户在桌面端点了一个「结果错误」，没有任何反馈表明"我们收到了、会怎么处理"。今天点踩是单向的，点了就沉底。
3. **对管理员只是报表**。汇总页能看出"上周有 30 条结果错误"，但回答不了"哪个 Agent 在什么类型任务上反复错""有没有已经处理掉的"。
4. **与资产化的断层**。Agent 已经有「最佳实践经验」（`agent_experiences`，注入 system prompt，见 `docs/plan/2026-07-09-agent-experience-design.md`）——这正是"教 Agent 别再犯"的载体，但经验目前只能管理员手工在后台一条条敲。用户点踩踩出来的真实教训，没有任何路径流到这条已有管道里。

相邻方向的边界：

- **不是 Evals**（已否决）：不做数据集回归与量化评分，只做"单条反馈 → 单条经验草稿"的人工确认流，不追求自动化评测。
- **不是记忆**：长期记忆（`memory_item`）记的是用户偏好与项目事实，服务的是"了解用户"；本提案记的是"这个 Agent 在什么场景下怎么做得更好"，服务的是"提升 Agent 能力"，归属不同层。
- **不改提示词版本管理**：经验进 `agent_experiences` 走既有全量同步通道，不新增提示词版本体系（那是已否决方向）。

## 2. 目标 / 非目标

**目标**

1. **反馈可归类可处理**：管理后台明细页对每条反馈给出处理状态（未处理 / 已转为经验 / 已忽略），可按 Agent、原因、状态筛选，同类反馈能看出聚集度（同一 Agent 同一原因的条数）。
2. **一键转经验**：管理员在明细里选中一条反馈，触发 LLM 基于「点踩原因 + 原消息 + 对应的用户消息 + 当时的工具调用轨迹」起草一条 ≤300 字的经验草稿，人工编辑确认后写入该 Agent 的 `agent_experiences`（默认启用），反馈行标记为已处理并记录关联经验 ID。**人始终在环里**，不自动注入。
3. **聚集转经验**：对同一 Agent 同一原因的 N 条反馈（默认 ≥3）触发"归纳"路径——一次调用产出 1~2 条更通用的经验，而非逐条搬。逐条反馈的卡片上显示"同类还有 4 条"，可一键全选关联反馈一起转。
4. **用户侧可见的回应**：桌面端 / 飞书卡点踩后给出轻提示（如"已收到反馈，我们会据此改进"），不再点了没动静。不做"你的反馈已被处理"的个体回执（处理发生在管理侧，通知到个体用户成本高且无必要）。
5. **防注入口**：起草只读**摘要化**的轨迹（工具名、目标、成败，不含工具结果全文）；经验入 `agent_experiences` 前的既有 300 字硬限制与注入顺序不变。

**非目标**

- 不做全自动"点踩→改提示词→上线"流水线（自动写提示词是失控面，人必须确认）。
- 不改 `agent_experiences` 表结构与注入逻辑（只复用写入通道）。
- 不做经验效果回溯（"转成经验后同类反馈是否下降"）——那是 Evals 范畴，已否决不重启。
- 不做跨用户的团队级反馈聚合（个人点踩数据严格按归属隔离，管理侧已是全量视角）。
- 不改飞书 / 钉钉 / 微信点踩的采集行为（本提案只在其后加环节）。

## 3. 技术方案

### 3.1 数据模型（迁移号顺延，当前已到 V147）

`message_feedback` 已有 `id / message_id / session_id / user_id / agent_id / reason / source / created_at / updated_at`，`uk_message(message_id)` 保证一条消息一条反馈。新增处理态字段：

```sql
ALTER TABLE `message_feedback`
    ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING'
        COMMENT 'PENDING 未处理 / CONVERTED 已转为经验 / DISMISSED 已忽略' AFTER `source`,
    ADD COLUMN `handled_by` BIGINT NULL COMMENT '处理人（管理员 user_id）' AFTER `status`,
    ADD COLUMN `handled_at` DATETIME NULL COMMENT '处理时间' AFTER `handled_by`,
    ADD COLUMN `experience_id` BIGINT NULL COMMENT 'CONVERTED 时关联的 agent_experiences.id' AFTER `handled_at`;

CREATE INDEX `idx_feedback_pending` ON `message_feedback` (`status`, `agent_id`, `reason`, `created_at`);
```

不新建反馈草稿表：草稿是**生成即评审**的瞬时物，落库前的一步，用 LLM 调用直接返回给管理后台编辑即可；只有确认写入的经验才落 `agent_experiences`。

### 3.2 后端：经验起草服务

新增 `src/feedback/experience-draft.service.ts`：

- `draftFromFeedback(feedbackIds: number[])`：读反馈行 + 关联消息（USER 消息与 ASSISTANT 消息正文）+ 该消息所在会话的活动轨迹摘要（复用 `recordActivity` 落库的工具名/目标/成败，`detail_json` 已含 `toolCallId` / `approvalMark`；**不取工具结果全文**）。
- prompt 约束：输出 1~2 条 ≤300 字的中文经验，形如「X 场景下优先 Y，避免 Z」，禁止臆测未在轨迹中体现的行为；输出走 JSON schema，解析失败一次纠错重试，仍失败返回可读错误（不降级为模板文案，对齐 git 提交信息的失败语义）。
- 用途标记：LLM 调用记 `scene=feedback_experience_draft`，成本与用量进现有 `llm_call` 体系（对齐 `git_commit_message` / `proxy_approve` 的做法）。
- 多选输入：`draftFromFeedback` 接受 ID 数组，单条与聚集（N 条同类）走同一实现，prompt 内区分"基于 N 条同类反馈归纳"。

确认落库路径：管理后台编辑草稿后调 `POST /v1/admin/feedback/:id/convert-experience`（或批量），服务端做：

1. 校验反馈存在且 `status=PENDING`（重复转返回 409，不覆盖）；
2. 复用 `AgentExperienceService` 的既有校验（≤300 字）写入目标 Agent 的经验；
3. 反馈行更新为 `CONVERTED` + `handled_by/at` + `experience_id`（事务内）。

另有 `POST /v1/admin/feedback/:id/dismiss`（标 `DISMISSED`，可批量）。

### 3.3 管理后台

`admin/src/views/feedback/`（现有明细页）增强：

- 明细表新增「状态」列与筛选（未处理 / 已转经验 / 已忽略）、「处理」操作列。
- 同类聚集：按 `agent_id + reason` 分组计数，行内显示「同类 N 条」，支持勾选同组多条。
- 「转为经验」向导：选中反馈 → 弹出抽屉（左侧原消息 + 轨迹摘要，右侧经验草稿编辑，可增删条目、可改文字）→ 确认写入 → 行状态刷新为已转经验并展示经验 ID。
- 「忽略」：单选与批量，二次确认。
- 汇总页新增「待处理反馈数」卡片与「按 Agent × 原因的待处理矩阵」，让"哪里在反复错"一眼可见。

### 3.4 桌面端与渠道端

- 桌面端点踩成功后 toast 轻提示「已收到反馈」；飞书卡点踩回调沿用现有卡片刷新，toast 文案由飞书侧给（不改卡片结构）。
- 不做个体回执通知（见非目标）。

### 3.5 权限

- 草稿生成与确认写入：`feedback:write`（新权限码，与既有 `feedback:read` 并列，迁移内插入并授给管理员角色）。
- 草稿内容来自点踩用户的会话数据，仅管理员可见——与现有明细页的数据面一致，不扩大可见范围。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | `message_feedback` 状态字段 + 管理后台状态列/筛选/同类聚集 + 忽略动作 | 小 |
| P2 | 经验起草服务（单条 + 聚集）+ 转经验向导（草稿编辑 + 确认写入 + 关联回写） | 中 |
| P3 | 汇总页待处理矩阵 + 桌面端点踩轻提示 + 草稿 prompt 调优 | 小 |

## 5. 风险与开放问题

- **草稿质量不可控**：轨迹摘要只含工具名/目标/成败，LLM 可能写出泛泛而谈的"经验"。缓解：草稿必须人工编辑确认；prompt 明确要求引用轨迹中的具体对象（文件名/命令模式）；转经验后可随时在后台编辑或停用（既有能力）。
- **提示词膨胀**：一次归纳可能产出 2 条经验，`agent_experiences` 条数增长会推高每轮 system prompt（该风险在 2026-07-09 方案已记录，本期不做条数硬上限）。缓解：向导里明示"该 Agent 现有 N 条经验"，鼓励归纳而非逐条堆量。
- **敏感内容进 prompt**：轨迹摘要不含工具结果全文，但工具名与目标（如文件名）会进 prompt——与 git 提交信息的敏感文件过滤同类问题。缓解：复用同一套敏感文件名规则（`git-commit-message.service.ts` 内的固定规则），命中时目标字段摘要为 `[sensitive]`。
- **重复转经验**：同一反馈并发转两次。缓解：`status=PENDING` 前置校验 + 唯一推进（`UPDATE ... WHERE id=? AND status='PENDING'` 影响行数判断），冲突返回 409。
- **开放问题**：转经验是否同时给原反馈用户一条"你的反馈已帮助我们改进了 Agent"的通知——成本是新增 inbox kind 与用户对"改进"的预期管理，倾向不做（见非目标），评审确认。
- **开放问题**：聚集阈值默认 3 是否合理，是否可按 Agent 分别配置——P1 用固定默认，配置化留后续。

## 6. 测试要点

- 状态机：PENDING → CONVERTED / DISMISSED；重复 convert 返回 409 且不重复写经验；dismiss 后可重新 convert（或保持终态，按实现口径断言）。
- 草稿服务：单条反馈产出 1 条 ≤300 字经验；N 条同类反馈产出 1~2 条更通用经验；输出非法 JSON 时纠错一次、二次失败返回可读错误；LLM 失败不写任何状态。
- 敏感过滤：轨迹中含 `.env` / `*.pem` 等敏感文件时，草稿 prompt 中对应目标为 `[sensitive]`，不含内容。
- 确认写入：经验内容超 300 字被 `AgentExperienceService` 拒绝且反馈状态不变；成功后 `experience_id` 正确回写、事务一致。
- 权限：非 `feedback:write` 账号调 convert/dismiss 返回 403；用户端接口不暴露任何处理态字段（个人只看自己的点踩回显，现状不变）。
- 管理后台：同类聚集计数正确；批量勾选同组后草稿 prompt 输入包含全部选中反馈；汇总矩阵口径与明细一致。
- 回归：`feedback:read` 明细查询行为不变（新增列不影响旧字段）；飞书 / 桌面点踩写入仍走 `uk_message` 幂等。
