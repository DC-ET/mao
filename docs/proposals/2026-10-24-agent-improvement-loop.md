# 提案：Agent 改进闭环（Improvement Loop）—— 把反复出现的问题变成有证据、有负责人、有验证的改进项

> 团队每天都在用，但同一个坑踩第二次时，系统不该还从零开始。
>
> 这里的「团队」不需要新建组织模型：同一个 Agent 的所有使用者就是一个团队，一次修复对所有人同时生效。

- 状态：已否决（2026-10-24），存档勿再评审
- 日期：2026-10-24
- 提案总览：见 [docs/proposals/README.md](README.md)
- 规模：中~大（新域 + 管理后台新页面；不改 harness 执行链路）
- 关联：`message_feedback`、`notification`、`llm_call`、`agent_prompt_versions`、`agent_experiences`

## 1. 背景与现状

### 1.1 失败信号很多，但没有一个地方把它们变成「该修什么」

团队用久了，Agent 的问题会重复出现。系统里其实已经留下了足够多的痕迹：

| 信号 | 现有位置 | 今天怎么用 |
|---|---|---|
| 用户点踩 | `message_feedback`（`WRONG_RESULT` / `SLOW_RESPONSE` / `NOT_SOLVED` / `OTHER`） | 管理后台「点踩反馈」页查看、筛选、忽略 |
| 任务失败 | `notification` 的 `TASK_FAILED` + `payload_json.reason`（失败原因摘要） | 收件箱通知，点进去看会话 |
| 模型调用失败 / 重试 | `llm_call.success=0` / `error_message` / `retry_count` | 调用流水、用量分析 |
| 工具失败 / 绕路 | `run-trace.service` 从消息里现算 | 只能在单个会话的运行轨迹里看 |
| 成本 / 耗时异常 | `llm_call` + 轨迹阈值 | 单会话轨迹的「慢 / 贵」标记 |
| 用户取消 / 重问 | `session.phase='CANCELLED'`、消息序列 | 没有聚合 |

它们各自都有页面，但**没有按 Agent 聚合成「问题簇」**，也没有「影响多大、该谁修、修完有没有用」的闭环。管理员的实际动作仍然是：打开点踩页，一条条看，凭感觉改提示词或加一条经验——下一次是否变好，没人知道。

### 1.2 0.0.299 下线的「转经验」为什么没解决这个问题

0.0.299 移除了「点踩 → LLM 起草经验 → 确认写入」的转经验向导（CHANGELOG 有记录）。那条路径的问题是结构性的：

- **逐条处理**：一条点踩生成一条经验，管理员被淹没在个案里，看不到「这类问题本周出现了 23 次、影响 9 个用户」。
- **只管负面**：只有点踩，没有任务失败、模型错误、工具绕路，也没有成功样本。
- **没有验证**：经验写进去就算完成，不知道它是否降低了同类问题，甚至可能让 Agent 变差。
- **没有生命周期**：经验只增不减，过时、冲突、重复的经验长期留在提示词里。

本提案不是把「转经验」换个皮重上。**它管理的是「改进项」，经验只是可选修复手段之一；核心是聚合、排序、证据和验证。**

### 1.3 为什么现在做

- 团队使用越久，重复问题的占比越高；靠个案直觉改 Agent，边际收益越来越低。
- 反馈、失败、模型错误、成本数据都已落库，缺的只是「按 Agent 聚合 + 影响排序 + 修复后回看」。
- 这是「越用越精准」最直接的抓手：**先让系统知道哪里不准，再让每次修复可被证明。**

配套：修复动作会落到「经验」或「工具能力」上，分别由 [经验资产化](2026-10-24-experience-lifecycle.md) 与 [能力体检](2026-10-24-capability-health.md) 承接；本提案只负责发现、排序与验证。

### 1.4 一个真实场景

财务 Agent 每周被 6 个人使用。最近两周，4 个人在「季度对账」上点了 `WRONG_RESULT`，另有 2 次任务超时失败。今天管理员只能看到 4 条孤立的点踩和 2 条收件箱通知，不知道该先修哪个、修完有没有用。

改进闭环会把它们合成两个问题簇：「结果错误」9 次、影响 4 人、约 ¥18 成本；「任务超时」2 次。管理员先处理结果错误簇，证据指向同一条已过时的经验；改完提示词、关联版本、进入 14 天观察，窗口结束后系统给出「同类点踩从 9 次降到 2 次，样本 46 次，VERIFIED」。下一次团队再遇到同类问题，修复是有据可查的。

普通用户不需要多点一个按钮，只会感到同一个问题第二次问时更少出错。

## 2. 目标 / 非目标

**目标**

1. 按 Agent 聚合信号（P1：点踩、任务失败、模型错误；P2 扩展工具失败、取消/重问），形成**问题簇**。
2. 每个问题簇给出**影响面**（出现次数、受影响用户数、成本/耗时）和**证据链**（会话、消息、轨迹、失败原因）。
3. 问题簇进入**改进项**工作流：待分诊 → 处理中 → 已上线 → 观察中 → 已验证 / 回退 / 无变化 / 已忽略。
4. 修复动作可关联到具体变更：提示词版本、经验条目、技能、MCP / 自定义工具、模型。
5. 上线后按窗口对比同类信号发生率，**用生产数据验证有没有变好**（不是离线评测）。
6. 周度质量摘要发给 Agent 负责人；用户可见「这个 Agent 最近改进了什么」（P2）。
7. 权限与隐私：默认只给管理员 / Agent 负责人看聚合与受限证据，不把某个用户的原话暴露给其他用户。

**非目标**

- 不做离线评测集、回归打分、模型 A/B（Evals 已在 2026-10-05 否决）。
- 不自动改写提示词、不自动写入经验、不自动提交代码；所有修复由人确认。**Agent 自我修改不可审计、也容易过拟合，本提案把「发现与验证」自动化，把「改」留给人。**
- 不做逐条点踩转经验（0.0.299 已下线的路径不再复活）。
- 不做团队共享记忆 / 知识库（2026-10-19 已否决团队知识层）。
- 不做全站 APM 或日志平台；只做「Agent 质量」这一条竖切。
- P1 不追求语义聚类；先用「Agent + 信号类型 + 原因码」这种可解释的粗聚类。

## 3. 与已否决 / 已下线方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 提示词回归评测 Evals（2026-10-05 否决） | 没有测试集、没有离线打分、没有模型并排；只观察生产信号在变更前后的变化 |
| 0.0.299 下线的「转经验」 | 不做逐条点踩→LLM 起草经验；按簇聚合、按影响排序、修复后验证，经验只是修复选项之一 |
| 团队知识层（2026-10-19 否决） | 不新增 TEAM 记忆 scope、不做用户经验提案通道；信号只用于管理员/负责人改进 Agent |
| 技能蒸馏（2026-10-11 否决） | 不产出 `SKILL.md`、不写技能目录、不做试跑；本提案不生成任何可执行资产 |
| 模型对照台（2026-10-12 否决） | 不做同一问题的多模型并排；质量数据只用于定位问题和验证变更 |
| 计划模式 / 执行前计划门（2026-10-09 否决） | 不拦执行、不改相位；改进闭环全部发生在任务结束后的离线聚合 |

## 4. 技术方案

### 4.1 信号采集：离线聚合，不动执行链路

**原则：不在 `task-terminal.service.ts` 的相位收敛点加逻辑。** 那条链路已经挤了记忆、收件箱、预算、引用，任何新增同步写入都会放大故障面。质量信号全部由**后台聚合任务**从既有表增量读取。

| 信号 | 来源表 | 采集字段 | 阶段 |
|---|---|---|---|
| 点踩 | `message_feedback` | `agent_id`、`reason`、`session_id`、`message_id`、`created_at` | P1 |
| 任务失败 | `notification`（`TASK_FAILED`，带 `payload_json.reason`）+ `session.phase='FAILED'` 兜底 | `session_id` → `session.agent_id`、失败原因、`dedup_key` / `updated_at` | P1 |
| 模型错误 | `llm_call`（`scene='agent'` 且 `success=0`） | `agent_id`、`session_id`、`provider`、`error_message`、`retry_count` | P1 |
| 工具失败 | 运行轨迹（按会话现算）或能力体检的 `tool_call_log` | 工具名、错误、耗时 | P2 |
| 取消 / 重问 | `session.phase='CANCELLED'`、消息序列（编辑重发 / 相似重问） | 会话、用户、时间 | P2 |

**渠道会话不能只看收件箱**：飞书 / 钉钉 / 微信会话按设计不写 `notification`（`task-terminal.service.ts` 的 `recordInbox` 排除通道会话），只靠通知会漏掉团队大量真实失败。聚合器必须同时扫 `session.phase='FAILED'` 兜底：有通知的用通知原因，没有的归 `UNKNOWN`，`source_key` 用 `session:<id>:<updated_at>` 去重。

兜底口径的已知限制：会话失败后若被重试并转入其他相位，`updated_at` 水位可能漏采这一次。P1 接受该缺口；P2 增加 append-only 的 `session_terminal_event`（在终态处旁路上报，不改相位判定），补齐精确失败事件与质量分母。

聚合任务每 10 分钟跑一次，按每类信号的 `last_id` 水位增量读取；写入用 `source_key` 幂等（如 `feedback:123`、`notification:456`、`llm_call:789`），重复执行不产生重复信号。

### 4.2 数据模型（迁移按实施顺序顺延，当前最新 V168）

```sql
CREATE TABLE `agent_signal` (
  `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
  `agent_id`    BIGINT NOT NULL,
  `user_id`     BIGINT NULL,
  `session_id`  BIGINT NULL,
  `message_id`  BIGINT NULL,
  `kind`        VARCHAR(24) NOT NULL COMMENT 'FEEDBACK/TASK_FAILED/LLM_ERROR/TOOL_ERROR/CANCELLED/IMPLICIT',
  `reason_code` VARCHAR(48) NOT NULL COMMENT '原因码：反馈原因 / 失败分类 / 错误分类',
  `severity`    TINYINT NOT NULL DEFAULT 1 COMMENT '1 低 / 2 中 / 3 高',
  `detail`      VARCHAR(512) NULL COMMENT '脱敏摘要，不存正文',
  `cost_cents`  INT NULL,
  `source_key`  VARCHAR(64) NOT NULL COMMENT '来源表:主键，幂等',
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_signal_source` (`source_key`),
  KEY `idx_signal_agent_time` (`agent_id`, `created_at`),
  KEY `idx_signal_cluster` (`agent_id`, `kind`, `reason_code`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Agent 质量信号（脱敏聚合用）';

CREATE TABLE `improvement_item` (
  `id`               BIGINT PRIMARY KEY AUTO_INCREMENT,
  `agent_id`         BIGINT NOT NULL,
  `cluster_key`      VARCHAR(128) NOT NULL COMMENT 'kind:reason_code（P2 可扩展为语义簇）',
  `title`            VARCHAR(256) NOT NULL,
  `summary`          VARCHAR(1024) NULL,
  `status`           VARCHAR(16) NOT NULL DEFAULT 'OPEN'
                     COMMENT 'OPEN/TRIAGED/IN_PROGRESS/SHIPPED/OBSERVING/VERIFIED/REGRESSED/NO_CHANGE/DISMISSED',
  `fix_type`         VARCHAR(16) NULL COMMENT 'PROMPT/EXPERIENCE/SKILL/TOOL/MCP/MODEL/OTHER',
  `owner_id`         BIGINT NULL,
  `occurrence_count` INT NOT NULL DEFAULT 0,
  `affected_users`   INT NOT NULL DEFAULT 0,
  `impact_score`     DECIMAL(10,2) NOT NULL DEFAULT 0,
  `first_seen_at`    DATETIME NOT NULL,
  `last_seen_at`     DATETIME NOT NULL,
  `baseline_json`    JSON NULL COMMENT '修复前窗口的指标快照',
  `verify_due_at`    DATETIME NULL,
  `verify_result`    VARCHAR(16) NULL COMMENT 'VERIFIED/REGRESSED/NO_CHANGE/INSUFFICIENT',
  `change_ref_json`  JSON NULL COMMENT 'promptVersionId/experienceId/mcpServerId/modelId/note',
  `open_flag`        TINYINT NULL COMMENT '1=打开；NULL=关闭。唯一键只约束打开项',
  `created_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_item_open` (`agent_id`, `cluster_key`, `open_flag`),
  KEY `idx_item_agent_status` (`agent_id`, `status`, `impact_score`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Agent 改进项';

CREATE TABLE `improvement_evidence` (
  `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
  `item_id`    BIGINT NOT NULL,
  `signal_id`  BIGINT NOT NULL,
  `session_id` BIGINT NULL,
  `message_id` BIGINT NULL,
  `excerpt`    VARCHAR(512) NULL COMMENT '脱敏摘要',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_evidence_signal` (`item_id`, `signal_id`),
  KEY `idx_evidence_item` (`item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='改进项证据';
```

`open_flag` 是为了绕开 MySQL 不支持部分唯一索引：打开项固定为 `1`，关闭项置 `NULL`，唯一键 `(agent_id, cluster_key, open_flag)` 保证同一簇只有一个打开项，同时保留历史项。

### 4.3 聚类与影响分

P1 用**可解释的粗聚类**：

- 点踩：`(agent_id, FEEDBACK, reason)`；
- 任务失败：`(agent_id, TASK_FAILED, normalizeFailureReason(failureReason))`，先映射成 `TIMEOUT / MODEL_ERROR / TOOL_ERROR / BUDGET_BLOCK / NO_PROGRESS / OTHER` 这类粗类；
- 模型错误：`(agent_id, LLM_ERROR, provider + normalizeError(error_message))`；
- 工具失败（P2）：`(agent_id, TOOL_ERROR, tool_name + error_code)`。

同一会话内同一错误码的连续重试按一次计（按 `session_id + reason_code + 10 分钟窗口` 去重），避免适配器重试把影响分放大。

影响分只用于排序，不对外宣称因果：

```
impact = occurrences_7d × (1 + distinct_users_7d) × severity_weight
       + min(50, cost_cents_7d / 100)
```

- `severity_weight`：`WRONG_RESULT / NOT_SOLVED = 3`，`TASK_FAILED / LLM_ERROR = 2`，`SLOW_RESPONSE / OTHER = 1`。
- UI 同时展示原始计数与用户数，避免一个加权分掩盖事实。

P2 再评估语义聚类（同一意图的不同说法归为一簇）；那需要 LLM 抽样，单独评审成本与隐私，不在 P1 范围。

### 4.4 改进项工作流与验证

**状态机**

```
OPEN（新簇 / 复发）
  → TRIAGED（已分诊、定负责人）
  → IN_PROGRESS（在改）
  → SHIPPED（已上线，记录变更引用）
  → OBSERVING（观察窗口，默认 14 天）
  → VERIFIED / REGRESSED / NO_CHANGE / INSUFFICIENT
  ↘ DISMISSED（确认不修，需填原因）
```

**验证口径**

- 基线窗口：`SHIPPED` 前 14 天；观察窗口：`SHIPPED` 后 14 天。
- 主指标：同类信号每 1000 次 Agent 会话的发生率；辅助指标：点踩率、任务失败率、单次成功任务成本。
- 样本不足（任一窗口 < 20 次会话）→ `INSUFFICIENT`，自动延长一个窗口，不强行下结论。
- 下降 ≥ 30% → `VERIFIED`；上升 ≥ 30% → `REGRESSED`；其余 `NO_CHANGE`。
- `VERIFIED` 后 7 天内同类信号再出现 ≥ 3 次 → 自动重开为 `OPEN`，并在项上标注「复发」。

**变更引用**

`change_ref_json` 记录至少一项，否则不允许 `SHIPPED`：

- 提示词：`{ "promptVersionId": 123 }`（复用 `agent_prompt_versions`）；
- 经验：`{ "experienceId": 45 }`（内容快照另存，防后续编辑改变证据）；
- 技能 / MCP / 自定义工具 / 模型：记录 id 或名称 + 操作（启用/停用/替换）；
- 其他：自由文本说明，必须写清改了什么。

P1 由管理员手动关联；P2 可在「保存提示词 / 保存经验」后 10 分钟内自动推荐关联，减少手工。

### 4.5 前端

- **Agent 列表新增「质量」入口**（`admin/src/views/agent/AgentListView.vue`），打开 `/admin/agents/:id/quality`。
- **质量总览**：近 7 / 30 天的会话数、任务失败率、点踩率、模型错误率、单次成功任务成本；一条按天的趋势线（P2）。
- **改进项看板**：按 `impact_score` 排序，列 = 状态 / 问题簇 / 出现次数 / 影响用户 / 最近出现 / 负责人 / 修复类型 / 验证结果；支持按状态、信号类型筛选。
- **证据抽屉**：该簇最近 N 条信号的脱敏摘要 + 会话跳转（admin 会话详情）+ 轨迹跳转；点踩证据只显示原因与消息摘要，不展示完整对话。
- **修复动作**：`去改提示词`（打开 Agent 编辑 / 提示词历史）、`加经验`（打开经验编辑）、`调技能 / MCP / 工具`（对应管理页）、`标记已忽略`（必须填原因）。P2 可按簇生成「修复建议草案」（建议 `fix_type`、指出相关提示词片段或候选经验），管理员采纳/改写后才落库，系统不自动改 Agent。
- **验证卡**：SHIPPED 后显示基线 / 观察窗口、样本量、当前结果；`REGRESSED` 高亮并提示回滚入口（提示词版本回滚已有）。
- **周度摘要（P2）**：每周一给 Agent 负责人发一条站内收件箱（新 kind `AGENT_QUALITY_DIGEST`，按规范三处同改：`@mao/contracts` 的 `InboxKind`、`backend-ts/src/inbox/types.ts`、桌面抽屉图标与偏好）；内容 = 新增/已修/复发 Top 5 + 待处理项。
- **用户侧（P2）**：Agent 选择器 / 详情卡显示「最近改进」短列表（只显示 `VERIFIED` 项标题）；任务失败时可在收件箱提示「已记录，将用于改进」，不承诺具体修复时间。

### 4.6 权限与隐私

- 质量页与写操作复用 `agent:write`；查看点踩明细复用 `feedback:read`；跳转会话复用 `session:read`。P1 不新增权限码，避免权限目录扩散。
- `agent_signal.detail` 只存脱敏摘要（错误码、失败分类、反馈原因），不存用户原话与工具结果正文。
- 证据抽屉按权限决定是否可跳转；无权限时只显示聚合计数。
- 不做跨用户原文对比；「受影响用户数」只给计数，不给名单（P2 如需名单，单独做权限评审）。

## 5. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | `agent_signal` + `improvement_item` + `improvement_evidence` + 三类信号聚合 + 影响分 + 质量页 + 手动状态流转 + 忽略 | 8-10 人日 |
| P2 | 观察窗口与自动验证、复发重开、周度摘要、工具失败 / 取消 / 重问信号、证据抽屉增强、按簇生成修复建议草案（只草案，人工采纳） | 6-8 人日 |
| P3 | 语义聚类、变更自动关联、用户侧改进日志、按团队/Agent 的质量排行 | 6-8 人日 |

P1 即可回答三个问题：「哪个 Agent 问题最多」「最该先修什么」「修完有没有用（手动触发验证）」。

**改动面（P1）**

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| 后端 | 新域 `backend-ts/src/quality/`（signal repository / aggregator / item service / verifier / routes） | 信号采集、聚类、影响分、状态机、验证 |
| 后端 | `session` / `feedback` / `usage` 只读查询 | 按水位读既有表，不改造写入链路 |
| 管理后台 | 新 `views/agent/AgentQualityView.vue` + router + AgentListView 入口 | 质量总览、改进看板、证据抽屉 |
| 迁移 | `V169__agent_quality_signal.sql` / `V170__improvement_item.sql` | 三表 + 索引 |
| 文档 | `CHANGELOG.md` / `skills/mao-cli/` / `USER_GUIDE.md` | 质量页与工作流说明 |

## 6. 风险与开放问题

| 问题 | 风险 | 推荐默认 |
|---|---|---|
| 信号噪声（误点踩、用户取消不是失败） | 中 | 取消单独低权重；点踩按原因加权；影响分只排序，不宣称因果 |
| 粗聚类把不同问题混在一起 | 中 | P1 只用可解释粗类；证据抽屉让人判断；P2 再做语义聚类 |
| 管理员仍然不处理 | 中 | 影响分排序 + 周度摘要 + 逾期提醒；默认只推 Top 5，不刷屏 |
| 验证被流量/模型变化污染 | 高 | 记录同期会话量、模型、流量来源；样本不足不下结论；UI 标注「观察性对比」 |
| 隐私（证据含用户原话） | 中 | 只存脱敏摘要；原文跳转受 `session:read` 限制；不展示用户名单 |
| 指标被「优化」 | 低 | 同时看失败率、点踩率、成本；不把单一指标当唯一真相 |
| 聚合任务重跑重复计数 | 中 | `source_key` 唯一键 + 水位；任务幂等 |
| 数据量 | 低 | 信号保留 180 天，之后归档/删除；聚合项长期保留 |

**待确认决策**

1. 质量页给谁看？建议 P1 仅管理员 + `agent:write` 持有者；Agent 负责人若不是管理员，P2 再开细粒度权限。
2. 验证窗口 14 天是否合适？建议默认 14 天，可按 Agent 流量配置 7/14/30。
3. 点踩被「忽略」后是否还计入质量趋势？建议计入趋势，但不新开改进项。
4. 用户取消是否算失败？建议不算，只作为低权重信号，且不与「任务失败」同簇。
5. 是否允许把改进项标记为「无法修复」？建议用 `DISMISSED` + 原因，不新增状态。

## 7. 测试要点

- 信号采集：三类来源各造 2 条，重复跑聚合任务不产生重复 `agent_signal`；水位推进正确；源数据删除/更新不破坏已采集信号。
- 聚类：同 Agent 同原因归簇；不同 Agent 不串；`open_flag` 唯一键保证只有一个打开项；关闭后同簇复发新建项。
- 影响分：权重、用户去重、成本上限、排序稳定；空数据不出现 NaN。
- 状态机：合法流转与非法流转（如 OPEN 直接 VERIFIED）被拒；`SHIPPED` 必须有关联变更；`DISMISSED` 必须填原因。
- 验证：基线/观察窗口计算、样本不足、下降/上升/无变化阈值、复发重开各一组用例。
- 权限：无 `agent:write` 不能看质量页/改状态；无 `feedback:read` 看不到点踩明细；证据跳转按 `session:read` 收口。
- 回归：点踩反馈页、收件箱、用量分析、运行轨迹行为不变；聚合任务异常不影响主服务。

## 8. 验收标准与观察指标

**验收**

1. 某 Agent 在 7 天内有 3 条 `WRONG_RESULT` 点踩 + 2 次任务失败，质量页出现两个问题簇，出现次数、影响用户数、证据条数正确。
2. 把「点踩」簇标为 `SHIPPED`，关联一次提示词版本变更；观察窗口结束后，系统给出 `VERIFIED / REGRESSED / NO_CHANGE / INSUFFICIENT` 之一，并展示前后发生率与样本量。
3. 关闭的簇在 7 天内再次出现 3 次，自动重开并标注「复发」。
4. 无权限账号看不到质量页与证据明细。
5. 聚合任务重复执行、主服务重启后，信号与改进项不重复、不丢失。

**指标（上线后 8 周）**

- 问题簇从首次出现到分诊的中位时长；
- 已上线改进项数量、验证通过率、复发率；
- 被改进 Agent 的点踩率 / 任务失败率趋势；
- 管理员每周处理改进项的时间（定性），以及「凭感觉改 Agent」的比例是否下降。
