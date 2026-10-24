# 提案：经验资产化（Experience Lifecycle）—— 让 Agent 的经验有来源、有命中、有成败、会退休

> 经验不是写进提示词就生效；它需要被证明、被维护，也需要被淘汰。
>
> 这里的「团队」不需要新建组织模型：同一个 Agent 的所有使用者就是一个团队，一条经验的好坏对所有人同时生效。

- 状态：已否决（2026-10-24），存档勿再评审
- 日期：2026-10-24
- 提案总览：见 [docs/proposals/README.md](README.md)
- 规模：中（后端归因 + 管理后台经验体检；不改执行引擎）
- 关联：`agent_experiences`、`message_feedback`、`agent_signal`、`context-manifest`、Agent Bundle

## 1. 背景与现状

### 1.1 经验是今天唯一的「提示词级学习资产」，但它几乎是裸奔的

`agent_experiences`（V053）是每个 Agent 的一组短经验：`content` ≤ 300 字、`sort_order`、`enabled`。`PromptEngine` 把它们拼成「最佳实践经验」段落注入系统提示词（`resolveExperiences`），所有使用该 Agent 的用户都会受影响。

它的管理方式只有一种：管理员在 `AgentFormDialog` 里手工增删改，或用「一行一条、`#` 开头表示停用」的文本模式批量粘贴。导出 Agent Bundle 时，经验正文与启用状态一起打包；导入时超过 300 字的条目被跳过。

除此之外，经验没有：

- **来源**：不知道是管理员凭经验写的、来自某条点踩、还是从别的 Agent 抄来的；
- **命中**：不知道哪些经验真的进了某次请求、被哪些用户/会话用到；
- **成败**：不知道命中它的任务更容易成功还是更容易被点踩；
- **健康**：不知道它是否过时、与另一条矛盾、和别的条目重复；
- **生命周期**：只增不减，停用只是把 `enabled` 置 0，历史与理由不留。

### 1.2 0.0.299 下线的「转经验」留下了什么

0.0.299 移除了「点踩 → LLM 起草经验 → 确认写入」的向导，理由是逐条处理、无法验证、只增不减。存量数据还在：`message_feedback.status='CONVERTED'` 与 `experience_id` 保留可查，但闭环已经断开。

今天的状态是：**经验还在被注入，但没有任何机制判断它是否值得留下。** 团队用得越久，经验越多，提示词越臃肿，冲突与过时的概率越高——Agent 可能不是「越用越准」，而是「越用越背着历史包袱」。

### 1.3 为什么现在做

- 经验是团队唯一能直接改变 Agent 行为的轻量资产；它不缺「写」的入口，缺的是「证明与维护」。
- Agent 改进闭环（[2026-10-24-agent-improvement-loop.md](2026-10-24-agent-improvement-loop.md)）会把「该修什么」摆到桌面上；经验是最常用的修复手段之一，必须有配套的质量治理，否则改完无法验证。
- 这项工作不需要新模型能力、不需要向量库、不需要执行引擎改动，投入产出比高。

### 1.4 一个真实场景

一个运营 Agent 用了半年，积累了 34 条经验。其中 7 条最近 60 天从未命中，3 条互相矛盾（一条要求「先确认再执行」，另一条要求「直接执行」），还有 5 条内容高度重复；「最佳实践经验」段落已经占了约 1800 token。

今天管理员只能凭印象删改，删掉后也不知道会不会变差。经验体检会把「零命中」「重复」「冲突」「token 超预算」列成待处理项，并给出命中与成败数据；管理员合并/退休后，经验段落降到 900 token，同类点踩率没有上升——这才叫「越用越准」，而不是「越用越背」。

普通用户不会看到这些统计，只会感到 Agent 的提醒越来越贴团队的做法，而不是几条经验互相打架。

## 2. 目标 / 非目标

**目标**

1. 每条经验有**来源**（手工 / 点踩 / 改进项 / 挖掘 / 导入）与**作者**。
2. 记录**命中**：哪次会话、哪个用户、哪个 Agent 的请求注入了哪些经验。
3. 把命中与结果信号（点踩、任务失败、改进项）关联，给出**观察性成败指标**。
4. 自动标记健康问题：**过时、重复、冲突、可能有害、条目过多/过长**。
5. 提供**生命周期操作**：编辑生成新版本、暂停、退休、合并；退休保留历史与理由。
6. P2 支持从**反复出现的问题簇**挖掘经验候选，管理员确认后才写入；不是逐条点踩转经验。
7. Agent Bundle 导出/导入兼容：只搬运经验正文与启用状态，不搬运实例内的健康统计。

**非目标**

- 不做可执行技能（Skill）：不产出 `SKILL.md`、不写技能目录、不做试跑（技能蒸馏 2026-10-11 已否决）。
- 不做 TEAM 级共享记忆 / 知识库 / 用户经验提案通道（团队知识层 2026-10-19 已否决）。
- 不做向量检索 / RAG：冲突与重复检测只在单个 Agent 的少量经验上做规则或小批量 LLM 判断，不建 embedding 设施。
- 不做离线评测（Evals 已否决）；所有成败都是生产数据的观察性关联。
- 不自动写入经验、不自动退休；P1 只标记，操作由管理员确认。
- 不治理长期记忆：记忆已有 `dedup_hash`、条数上限、忽略/删除；记忆的冲突与时效另做，不与经验混在一起。
- 不改变「经验 ≤ 300 字、纯文本、注入系统提示词」的产品形态。

## 3. 与已否决 / 已下线方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 技能蒸馏（2026-10-11 否决） | 不生成任何可执行技能、不改文件、不做试跑；只治理已有的 300 字提示词经验 |
| 团队知识层（2026-10-19 否决） | 不新增 TEAM scope、不做共享记忆、不做用户发起的经验提案；仍是每个 Agent 自己的经验资产 |
| 0.0.299 下线的「转经验」 | 不做「一条点踩 → 一条经验」；挖掘必须达到复发阈值、带证据、经人工确认，且写入后有命中/成败/退休机制 |
| RAG / 知识库（2026-10-02、10-05 否决） | 不建文档库、不切块、不做向量检索；相似度只在单个 Agent 的经验列表内做文本比较 |
| Evals（2026-10-05 否决） | 没有测试集与离线打分；只看生产会话的命中与结果关联 |

## 4. 技术方案

### 4.1 数据模型（迁移按实施顺序顺延，当前最新 V168）

```sql
ALTER TABLE `agent_experiences`
  ADD COLUMN `source`        VARCHAR(16)  NOT NULL DEFAULT 'MANUAL'
      COMMENT 'MANUAL/FEEDBACK/IMPROVEMENT/MINING/IMPORT' AFTER `enabled`,
  ADD COLUMN `source_ref`    VARCHAR(128) NULL COMMENT '来源引用：feedback:123 / item:45' AFTER `source`,
  ADD COLUMN `author_id`     BIGINT       NULL AFTER `source_ref`,
  ADD COLUMN `version`       INT          NOT NULL DEFAULT 1 AFTER `author_id`,
  ADD COLUMN `supersedes_id` BIGINT       NULL COMMENT '被本版取代的旧经验 id' AFTER `version`,
  ADD COLUMN `hit_count`     INT          NOT NULL DEFAULT 0 AFTER `supersedes_id`,
  ADD COLUMN `last_hit_at`   DATETIME     NULL AFTER `hit_count`,
  ADD COLUMN `health_flags`  JSON         NULL COMMENT 'STALE/DUPLICATE/CONFLICT/HARMFUL/TOO_MANY' AFTER `last_hit_at`,
  ADD COLUMN `health_checked_at` DATETIME NULL AFTER `health_flags`,
  ADD COLUMN `retired_at`    DATETIME     NULL AFTER `health_checked_at`,
  ADD COLUMN `retire_reason` VARCHAR(256) NULL AFTER `retired_at`;

CREATE TABLE `experience_hit` (
  `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
  `experience_id` BIGINT NOT NULL,
  `agent_id`      BIGINT NOT NULL,
  `session_id`    BIGINT NOT NULL,
  `user_id`       BIGINT NULL,
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_exp_session` (`experience_id`, `session_id`),
  KEY `idx_hit_session` (`session_id`),
  KEY `idx_hit_agent_time` (`agent_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='经验命中（每会话每经验一行）';
```

**为什么按会话而不是按 LLM 调用记录**：一次执行会多轮调用模型，按轮记录会把命中数放大数倍且无意义；按会话 `INSERT IGNORE` 一行，既能回答「这条经验被多少次任务用到」，又不制造写放大。

迁移时做一次存量回填：`message_feedback.experience_id` 能对上的历史经验，`source='FEEDBACK'`、`source_ref='feedback:<id>'`，让 0.0.299 之前沉淀的经验保留来源；对不上的保持 `MANUAL`。

### 4.2 命中归因：把经验 id 带进请求

今天 `AgentExecutionContext.experiences` 是 `string[]`，`ContextManifest` 只有经验条数（`sections[].count`），没有 id。改造分三步：

1. **上下文携带 id**：`HarnessService` 装配上下文时，除了 `experiences: string[]`，新增 `experienceIds: number[]`（与内容同序）；`PromptEngine` 仍只读内容，不改变提示词字节。
2. **Manifest 暴露 id**：`ContextManifest` 增加 `experienceIds: number[]`，与 `memoryIds` 同口径参与 8KB 裁剪；上下文抽屉可看到「本次注入了哪几条经验」（P2）。
3. **执行开始记一次命中**：`ExperienceAttributionService.recordSessionHits(sessionId, agentId, userId, ids)` 在每次执行装配上下文后调用，`INSERT IGNORE`；失败只告警，不影响任务。

归因是**观察性**的：命中了某条经验的任务更容易成功，不等于这条经验导致了成功。UI 必须标注「关联，不代表因果」。

按会话去重是有意选择：一次会话内经验集合通常稳定，按轮记录会把命中数放大数倍。若 P2 需要按任务统计，改为 `(experience_id, session_id, execution_id)`，并在 Harness 层透传 `executionId`。

### 4.3 健康检查

后台任务按天/周扫描单个 Agent 的 ACTIVE 经验（数量通常 ≤ 50），写入 `health_flags`：

| 标记 | 判定 | 建议动作 |
|---|---|---|
| `STALE` | 创建 ≥ 14 天、60 天内零命中，且该 Agent 同期 ≥ 20 次会话（避免低流量误判） | 复查是否已被新经验覆盖 / 退休 |
| `DUPLICATE` | 同 Agent 内两条经验归一化文本相似度 ≥ 0.85（分词 Jaccard 或编辑距离） | 合并为一条 |
| `CONFLICT` | P2：小批量 LLM 判断两条经验是否给出相反指引（如「必须先确认」vs「直接执行」） | 人工裁决，停用其一 |
| `HARMFUL` | 命中 ≥ 20 次会话，且点踩率 / 失败率比该 Agent 基线高 ≥ 10 个百分点 | 优先复查，可先暂停 |
| `TOO_MANY` | ACTIVE 经验 > 30 条，或经验段落估算 token > 1500 | 清理、合并、退休 |

P1 只做 `STALE` / `DUPLICATE` / `TOO_MANY` 与命中统计；`CONFLICT` / `HARMFUL` 放 P2，因为需要 LLM 判断或足够样本，先把数据攒起来。

**不自动停用**：健康标记只做提示。P2 可对 `HARMFUL` 且样本足够的条目提供「一键暂停」并通知作者，但仍由人确认。

### 4.4 生命周期

- **编辑 = 新版本**：修改正文不原地覆盖，新建一行 `version + 1`、`supersedes_id = 旧 id`，旧行 `retired_at` 置位、`enabled = 0`。这样命中与成败统计不会跨版本混在一起。
- **暂停**：`enabled = 0`，保留命中与健康数据，可随时恢复。
- **退休**：`retired_at` + `retire_reason`，不再注入，保留历史；Agent Bundle 默认不导出退休项。
- **合并**：新建一条合并后的经验，旧条目退休，`source_ref` 保留来源链。
- **排序**：沿用 `sort_order`；健康列表可按影响排序，但不改变注入顺序（避免一次整理改变提示词前缀）。

### 4.5 经验候选挖掘（P2）

只从「反复出现」的信号里挖，不逐条点踩转经验：

- 来源：Agent 改进项（[提案一](2026-10-24-agent-improvement-loop.md)）或 `agent_signal` 中同一 Agent、同一原因码的簇；若提案一未实施，直接从 `message_feedback` + `notification` 做同样的 Agent × 原因粗簇，不依赖新表；
- 正向补充（P2）：同一类任务在多个用户、多次会话中稳定成功（无点踩、无失败）时，也可提炼「怎么做」的候选；同样要复发/一致性阈值与人工批准，不做单次成功即沉淀；
- 阈值：14 天内 ≥ 3 次、影响 ≥ 2 个用户；
- 产物：`experience_candidate`（id、agent_id、content、evidence_json、status `DRAFT/APPROVED/REJECTED`、reviewed_by/at）；
- 起草：LLM 调用场景新增 `experience_mining`（按规范三处同改：`shared/contracts/src/usage.ts` 的 `LlmCallScene`、`backend-ts/src/usage/llm-call-context.ts` 的 `LLM_CALL_SCENES`、desktop/admin 的 `llmCallLabels.ts`）；
- 审核：管理员看到候选正文、证据摘要、预计影响（同类问题近 14 天次数/用户数），可编辑后批准；批准写入 `agent_experiences`，`source='MINING'`，并回填候选状态。

```sql
CREATE TABLE `experience_candidate` (
  `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
  `agent_id`     BIGINT NOT NULL,
  `content`      VARCHAR(300) NOT NULL,
  `evidence_json` JSON NOT NULL COMMENT '来源簇 / 会话 / 反馈 id 与计数',
  `status`       VARCHAR(16) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT/APPROVED/REJECTED',
  `reviewed_by`  BIGINT NULL,
  `reviewed_at`  DATETIME NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_candidate_agent_status` (`agent_id`, `status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='经验候选（P2）';
```

**与旧「转经验」的差异**：旧版一条点踩就能起草、直接写入、无验证；新版要求复发阈值、跨用户证据、人工批准、写入后进入命中/成败/退休生命周期。

### 4.6 前端

- **Agent 编辑弹窗（表格形态）**：新增「来源 / 命中 / 最近命中 / 健康」列；行操作增加「查看证据」「暂停 / 恢复」「退休」。文本形态保持一行一条 + `#` 停用，不显示统计，避免破坏批量粘贴习惯。
- **「经验体检」页签**：位于 Agent 编辑弹窗或独立页；顶部显示 ACTIVE 数、经验 token 估算、命中覆盖率（有经验注入的会话占比）、STALE/DUPLICATE/HARMFUL 数；下方为待处理列表（按健康标记与影响排序），支持批量暂停/退休/合并。
- **证据抽屉**：显示来源（手工 / 点踩 / 改进项 / 挖掘）、命中次数、最近命中、关联会话跳转（需 `session:read`）、点踩/失败关联计数；不展示用户原话。
- **上下文抽屉（P2）**：在「最佳实践经验」分节下展开本次注入的经验标题/摘要，让管理员或用户知道「这次参考了哪些经验」。
- **改进闭环联动**：改进项的「加经验」动作可直接打开候选起草，带上证据；保存后回填 `improvement_item.change_ref_json`。

### 4.7 Agent Bundle 兼容

- 导出：只导出未退休经验（`retired_at IS NULL`），保留 `content / sort_order / enabled`；新增 `source` 作为可选元数据，不导出 `hit_count / last_hit_at / health_flags`（实例内观测数据不跨实例搬运）。
- 导入：`source='IMPORT'`、`version=1`、统计清零、健康为空；同名/同内容按现有规则处理，超 300 字跳过。
- 文本模式：仍按 `#` 前缀解析停用；来源与统计只在表格形态维护，不引入新的文本语法。

## 5. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | 表结构 + 命中归因 + Manifest id + STALE/DUPLICATE/TOO_MANY + 经验体检页 + 生命周期操作 + Bundle 兼容 | 7-9 人日 |
| P2 | HARMFUL / CONFLICT + 证据抽屉 + 挖掘候选 + `experience_mining` 场景 + 改进项联动 | 6-8 人日 |
| P3 | 上下文抽屉展示注入经验、跨 Agent 复制（带来源）、按经验的成本/成功率趋势 | 4-6 人日 |

**改动面（P1）**

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| 后端 | `agent/agent-experience.service.ts` / `agent.repository.ts` | 新字段读写、版本/退休/合并 |
| 后端 | `harness/core/prompt-engine.ts` / `harness-service.ts` / `context-manifest.ts` | 携带并输出经验 id、记录会话命中 |
| 后端 | 新 `experience/` 或并入 `agent/` 的健康检查任务 | STALE/DUPLICATE/TOO_MANY 计算 |
| 后端 | `agent/agent-bundle.service.ts` / `types.ts` | 导出过滤退休项、导入来源与统计处理 |
| 管理后台 | `views/agent/AgentFormDialog.vue` + 新「经验体检」视图/路由 | 健康列、操作、待处理列表 |
| 迁移 | `V171__experience_lifecycle.sql` | 经验字段 + `experience_hit` |
| 文档 | `CHANGELOG.md` / `skills/mao-cli/` / `USER_GUIDE.md` | 经验生命周期与 Bundle 变化 |

## 6. 风险与开放问题

| 问题 | 风险 | 推荐默认 |
|---|---|---|
| 归因是相关性，不是因果 | 高 | UI 明确「关联，不代表因果」；`HARMFUL` 只提示，不自动停用 |
| 小样本误判 | 中 | 所有健康规则带最小会话数门槛；低流量 Agent 只显示计数不下结论 |
| 编辑产生版本导致数量膨胀 | 中 | 旧版退休但保留；体检页默认只看最新版；按 Agent 归档旧版 |
| 经验合并改变提示词前缀 | 中 | 合并/退休是低频人工操作；一次操作尽量批量完成，减少前缀缓存失效 |
| 冲突检测误报 | 中 | P2 LLM 判断只做「疑似冲突」提示，最终由人裁决；保留判断理由 |
| Bundle 跨实例携带统计会误导 | 中 | 只搬运正文与启用状态；统计/健康不入包 |
| 文本模式与表格模式字段不一致 | 低 | 文本模式只维护正文与停用；来源/统计只读展示在表格模式 |
| 经验候选重新变成「批量灌经验」 | 中 | 复发阈值 + 跨用户证据 + 人工批准 + 写入后验证，缺一不可 |

**待确认决策**

1. `STALE` 的 60 天 / 20 次会话门槛是否合适？建议默认值可配置。
2. 编辑是否必须生成新版本？建议是（统计不跨版本）；批量小改可接受一次版本跳变。
3. `HARMFUL` 是否允许自动暂停？建议 P2 只提示，人工确认后暂停。
4. 退休经验是否还出现在 Agent Bundle 里？建议默认不导出。
5. 是否允许普通用户看到「本次注入了哪些经验」？建议 P2 只在检查器展示标题/摘要，不展示完整正文与统计。
6. 经验是否需要按工作区 / 项目作用域？建议 P1 保持 Agent 级；P3 再评估（避免与团队知识层混淆）。

## 7. 测试要点

- 迁移：新字段默认值正确；存量经验 `source='MANUAL'`、`version=1`、统计为 0；`enabled` 与 `retired_at` 不冲突。
- 命中：同一会话同一经验只写一行；不同会话累加；记录失败不影响任务；`hit_count/last_hit_at` 汇总正确。
- 归因：Manifest 的 `experienceIds` 与注入内容同序；8KB 裁剪时不出现孤立 id；无经验时为空数组。
- 健康规则：STALE 的低流量豁免、DUPLICATE 阈值边界、TOO_MANY 的条数/token 两条口径；健康任务幂等。
- 生命周期：编辑生成新版本且旧版退休；暂停/恢复；退休原因必填；合并后旧条目全部退休。
- Bundle：导出不含退休项与统计；导入来源为 IMPORT、统计清零；文本模式 `#` 仍生效。
- 权限：无 `agent:write` 不能改经验；证据跳转受 `session:read` 限制。
- 回归：提示词「最佳实践经验」段落字节不变（除新增/退休导致的内容变化）；Agent 编辑文本模式保存行为不变。

## 8. 验收标准与观察指标

**验收**

1. 给一个 Agent 配 5 条经验，跑 10 次会话后，每条经验的命中会话数正确，最近命中时间正确。
2. 两条高度相似的经验被标记 `DUPLICATE`；一条 60 天零命中且 Agent 流量足够的经验被标记 `STALE`。
3. 编辑一条经验后生成 v2，旧版退休且不再注入；统计从 v2 重新开始。
4. 退休一条经验后，Agent Bundle 不再导出它；导入到另一实例后统计为空、来源为 IMPORT。
5. 上下文抽屉（P2）能看到本次注入的经验标题，与 Manifest 的 `experienceIds` 一致。

**指标（上线后 8 周）**

- 每 Agent ACTIVE 经验数、经验段落 token 占比（上下文构成已有口径）；
- 经验命中覆盖率（有经验注入的会话占比）；
- STALE/DUPLICATE/CONFLICT 标记数与处理率；
- 命中经验 vs 未命中经验的点踩率/任务失败率（观察性对照）；
- 经验编辑/退休后提示词体积变化与单次任务成本变化。
