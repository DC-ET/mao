# 提案：术语学习（Term Learning）—— 从每次追问和纠错里，学会团队自己的说法

> 每一次追问和纠正，都是团队在教 Agent 说话；别让它们随会话消失。
>
> 「团队」仍然指同一个 Agent 的所有使用者：一个人纠正过的说法，下次所有人受益。

- 状态：已否决（2026-10-24），存档勿再评审
- 日期：2026-10-24
- 提案总览：见 [docs/proposals/README.md](README.md)
- 规模：中（学习事件 + 候选聚合 + 审核页；不自动改词典）
- 关联：[业务词典](2026-10-24-business-glossary.md)、[模糊指令解析](2026-10-24-intent-resolution.md)、`term_resolution_log`、`ask_user_questions`

## 1. 背景与现状

### 1.1 词典和解析都是「静态」的，团队的说法却在变

[业务词典](2026-10-24-business-glossary.md)解决「词可能是什么意思」，[模糊指令解析](2026-10-24-intent-resolution.md)解决「这句话里选哪个」。但两者都需要人预先配置：

- 新业务词出现（新的促销类型、新的结算口径、新的服务商政策）时，词典不会自己长；
- 「出货额」默认按本月、含税，是某个管理员的理解，不一定是团队多数人的习惯；
- 同一个词在不同渠道/角色下含义不同（运营看渠道，财务看结算主体），静态默认值会顾此失彼；
- 用户每次纠正「不是这个推单」「按不含税」，如果不记录下来，下一个人还要再教一遍。

### 1.2 今天这些信号在哪里消失了

- `ask_user_questions` 的答案只存在于该轮工具结果与消息里，没有结构化沉淀；
- 用户下一句纠正（「不是」「我说的是」「按含税」）只是普通消息，没有和被纠正的解析关联；
- 点踩/任务失败只进反馈页与质量信号，不与「当时把某个词理解成了什么」关联；
- 管理员只能凭感觉改词典，改完不知道澄清次数有没有下降。

结果：词典靠人猜，解析靠规则，团队真实说法没有回流——「越用越懂」缺了最后一环。

### 1.3 为什么现在做

- 前两份提案已经产出结构化术语、解析决策与日志；学习只差「把答案/纠正配对回日志」。
- 术语学习是**小样本、强结构**的：不需要训练模型、不需要向量库，只需要计数、阈值与人工审核。
- 它直接对应「越用越精准」：澄清次数下降、默认值更贴团队、错误理解更少。

**依赖**：本提案以[模糊指令解析](2026-10-24-intent-resolution.md)的 `term_resolution_log` 为锚点；解析器尚未上线时，P1 只能从消息旁路做粗配对，效果有限，建议先落解析 P1（哪怕只记「检测到哪些术语、决策是什么」）。

## 2. 目标 / 非目标

**目标**

1. 记录三类学习事件：**澄清回答**、**用户纠正**、**弱接受**（任务完成且无纠正/无点踩）。
2. 按「术语 × 含义 × 槽位 × 取值」聚合，达到阈值后生成**默认值候选**。
3. 生成**别名候选**与**歧义候选**：用户换个说法、或同一个词在不同语境下稳定指不同含义时，提示补别名/加区分规则。
4. 管理员在「术语学习」页审核候选：看支持量、影响用户数、证据摘要、预计收益；批准后写回词典并升版本，可回滚。
5. 提供前后对比：应用默认值/别名后，该术语的澄清率、纠正率、首次回答接受率变化。
6. 全程不自动改词典、不存用户原文、不做用户提案通道。

**非目标**

- 不做团队共享记忆 / 知识库：只处理结构化术语与槽位取值，不存自由文本。
- 不做用户发起的经验/术语提案：候选由系统从解析日志聚合，管理员审核。
- 不做离线评测 / A/B：只做生产数据的前后观察。
- 不做自动应用：批准必须由 `glossary:write` 持有者完成。
- 不做完整语义聚类：P1 按术语/槽位/取值做计数；别名与歧义挖掘放 P2/P3。
- 不改变解析器的 P1 决策逻辑；学习结果只写回词典（默认值、别名、优先级）。

## 3. 与已否决方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 团队知识层（2026-10-19 否决） | 不新增 TEAM 记忆 scope、不存自由文本、不做用户提案；只聚合结构化槽位取值 |
| 经验资产化（本日已驳回） | 不写自然语言经验；输出是词典字段（默认值/别名/优先级）的候选 |
| 技能蒸馏（2026-10-11 否决） | 不生成技能、不改文件；只改术语配置 |
| Evals（2026-10-05 否决） | 没有测试集与离线打分；只看生产澄清/纠正率的前后变化 |
| 模型对照（2026-10-12 否决） | 不做多模型并排；学习对象是术语语义，不是模型 |
| 业务词典 / 模糊指令解析（本批提案一、二） | 那两份负责「配置」与「运行时决策」；本提案只负责「从真实使用中提出修改建议」 |

## 4. 技术方案

### 4.1 学习事件

```sql
CREATE TABLE `term_learning_event` (
  `id`             BIGINT PRIMARY KEY AUTO_INCREMENT,
  `resolution_id`  BIGINT NOT NULL COMMENT 'term_resolution_log.id',
  `session_id`     BIGINT NOT NULL,
  `term_id`        BIGINT NOT NULL,
  `meaning_id`     BIGINT NULL,
  `kind`           VARCHAR(16) NOT NULL COMMENT 'ANSWER/CORRECTION/ACCEPT',
  `slot`           VARCHAR(32) NULL COMMENT 'timeRange/dimension/tax/entity/meaning',
  `value_json`     JSON NULL COMMENT '结构化取值，如 {"timeRange":"THIS_MONTH"}',
  `evidence`       VARCHAR(256) NULL COMMENT '脱敏短摘要，如「用户改口：按不含税」',
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_event_resolution` (`resolution_id`),
  KEY `idx_event_term_time` (`term_id`, `created_at`),
  KEY `idx_event_kind` (`kind`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='术语学习事件';
```

**ANSWER（澄清回答）**

- 解析器在 `ask_user_questions` 的 `metadata` 里带 `termResolutionId`；工具返回 `answers` 后，由工具结果后置钩子把「问题 → 选项/自定义输入」映射成槽位取值，写 `ANSWER` 事件。
- 若模型没带 metadata，P2 用「同一会话、上一轮提问、下一轮用户回答」的保守配对兜底；配不上就不记，不猜。

**CORRECTION（纠正）**

解析后的下一条用户消息（10 分钟内）命中以下模式时记 `CORRECTION`：

- 否定：不是 / 不对 / 错了 / 我说的是 / 我要的是；
- 改口径：按含税 / 按不含税 / 按渠道 / 按客户 / 本月 / 上周 / 实际成交额；
- 换含义：不是这个推单 / 是执行推单 / 不是流水，是计算；
- 编辑重发：走既有 `edit_and_resend` 路径时，把编辑前的解析标为被纠正。

**工具路径一致性（P2）**

解析选择了含义 A，但后续实际执行的 shell 命令落在含义 B 的 `data_source`（例如解析成「查推单状态」却调了 `push early-push execute`），记一条「含义纠正」候选；反过来，实际命令落在 A 的 `data_source`，记弱接受。命令到含义的映射来自词典的 `data_source_json`（skill + command），只解析命令串，不读工具结果正文。

P1 用关键词 + 槽位词典抽取；P2 对无法规则判定的纠正做 LLM 分类（场景 `term_correction`，低频、抽样）。

**ACCEPT（弱接受）**

任务 `COMPLETED`、24 小时内无纠正、无点踩 → 记一条低权重 `ACCEPT`。它不是「用户满意」，只作为「默认值没被立刻推翻」的弱信号；权重低于 ANSWER/CORRECTION。

### 4.2 候选聚合

```sql
CREATE TABLE `term_learning_candidate` (
  `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
  `term_id`         BIGINT NOT NULL,
  `meaning_id`      BIGINT NULL,
  `kind`            VARCHAR(16) NOT NULL COMMENT 'DEFAULT/ALIAS/DISAMBIGUATION',
  `slot`            VARCHAR(32) NULL,
  `value_json`      JSON NULL COMMENT '建议值，如 {"timeRange":"THIS_MONTH"}',
  `support_count`   INT NOT NULL DEFAULT 0,
  `distinct_users`  INT NOT NULL DEFAULT 0,
  `contexts_json`   JSON NULL COMMENT '渠道/Agent/角色分布，用于判断是否只适用于某场景',
  `status`          VARCHAR(16) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT/APPROVED/REJECTED',
  `reviewed_by`     BIGINT NULL,
  `reviewed_at`     DATETIME NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_candidate_status` (`status`, `created_at`),
  KEY `idx_candidate_term` (`term_id`, `slot`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='术语学习候选';
```

**默认值候选（DEFAULT）**

- 维度：`(term_id, meaning_id, slot, value)`；
- 阈值（可配）：14 天内 `support_count ≥ 5`、`distinct_users ≥ 2`、主导取值占比 ≥ 70%、覆盖 ≥ 3 天；
- 生成文案：「出货额 · timeRange 默认建议改为 本月（8/10 次，3 位用户；当前默认：上周）」；
- 如果同一 slot 在不同渠道/角色下主导值不同 → 不生成全局默认，生成 `DISAMBIGUATION` 候选（建议按上下文拆分）。

**别名候选（ALIAS，P2）**

- 来源：纠正文本里出现的新说法（「我说的出货金额」「我们叫出库额」）；
- 条件：同一新说法 ≥ 3 次、跨 ≥ 2 用户，且能映射到已有术语；
- 生成文案：「把‘出库额’加为‘出货额’的别名？」；批准后写 `business_term_alias`，weight 默认低于标准名。

**歧义候选（DISAMBIGUATION，P2）**

- 同一术语的两个含义都有稳定支持（各自 ≥ 30% 且 ≥ 5 次），且纠正集中在含义选择上；
- 建议：调整 `priority`、补上下文规则（按 Agent/渠道/角色）、或拆分术语；
- 不自动拆；由管理员决定。

### 4.3 审核与应用

- 管理后台「业务词典 → 术语学习」：
  - 候选列表：类型、术语、含义、槽位、建议值、支持量/用户数、上下文分布、状态；
  - 详情：证据摘要（脱敏）、影响估算（「同类追问约 12 次/周」）、当前配置、建议配置 diff；
  - 操作：批准 / 编辑后批准 / 拒绝（必填原因）；批量批准同术语的多个默认值。
- 批准后：
  - 写回 `business_term_meaning.defaults_json` / `business_term_alias` / `priority`；
  - `business_term.version += 1`，写审计日志；解析器索引按 version 刷新；
  - 记录 `applied_by/applied_at` 与回滚所需的旧值（P2 历史表或 JSON 快照）。
- 回滚：一键恢复到上一版本；回滚也升版本，避免索引缓存歧义。

### 4.4 观测与前后对比

- 每个术语展示：解析次数、澄清率（有 ASK 的解析 / 总解析）、纠正率、首次回答接受率、平均澄清轮次。
- 应用候选后 14 天对比前 14 天：澄清率、纠正率、接受率；样本不足标 `INSUFFICIENT`。
- 不做 A/B：同一团队无法随机分组，明确标注「观察性对比，可能受流量/业务变化影响」。
- 候选页显示「预计收益」时用支持量做粗估，不承诺具体降幅。

### 4.5 隐私与权限

- `term_learning_event.evidence` 只存脱敏短摘要（≤256 字），不存用户原文；`value_json` 只存结构化槽位值。
- 候选页默认只显示计数与脱敏摘要；需要看关联会话时走 `session:read`，且不展示其他用户原文。
- `glossary:write` 才能批准/拒绝；`glossary:read` 只能看。
- 不做用户名单展示；`distinct_users` 只给计数。
- 学习事件保留 180 天，候选保留 365 天；清理任务与现有 runtime 清理同范式。

## 5. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | `term_learning_event` + ANSWER/CORRECTION/ACCEPT 采集 + 术语观测面板（澄清率/纠正率） | 5-6 人日 |
| P2 | `term_learning_candidate` + DEFAULT 聚合 + 审核/批准/回滚 + 前后对比 | 5-7 人日 |
| P3 | ALIAS / DISAMBIGUATION 挖掘 + LLM 纠正分类 + 按 Agent/渠道的默认值 | 5-7 人日 |

**改动面（P1/P2）**

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| 后端 | 词典域新增 `learning-event.service.ts` / `learning-aggregator.ts` / `learning.routes.ts` | 事件采集、聚合、候选、审批 |
| 后端 | `ask_user_questions` 结果后置钩子 | 按 `metadata.termResolutionId` 写 ANSWER |
| 后端 | 会话消息保存路径（旁路） | 识别纠正/编辑重发，写 CORRECTION；不改消息语义 |
| 管理后台 | 词典页新增「术语学习」Tab | 观测、候选、审批、回滚 |
| 迁移 | `V171__term_learning.sql` | 事件表 + 候选表 |
| 文档 | `CHANGELOG.md` / `skills/mao-cli/` / `USER_GUIDE.md` | 学习机制与审核说明 |

## 6. 风险与开放问题

| 问题 | 风险 | 推荐默认 |
|---|---|---|
| 小样本误判 | 中 | 最小 5 次 / 2 用户 / 3 天；不满足只展示不下结论 |
| 默认值自我强化 | 中 | 默认值应用后继续观察纠正率；定期（90 天）重新验证；保留回滚 |
| 概念漂移（业务口径变了） | 中 | 纠正率上升自动提示复查；候选页显示趋势 |
| 纠正识别误报 | 中 | P1 只认高置信模式；P2 LLM 分类只做候选，不直接改配置 |
| 渠道/角色差异被平均掉 | 中 | 上下文分布显示；主导值分化时生成 DISAMBIGUATION 而非全局默认 |
| 隐私（纠正文本） | 中 | 只存结构化值与脱敏摘要；不存原文；权限收口 |
| 候选积压 | 中 | 按影响排序；同术语合并；周度摘要；不做逐条通知 |
| 管理员误批准 | 中 | 批准前展示 diff 与影响；支持回滚；审计记录操作人 |

**待确认决策**

1. 默认阈值 5 次 / 2 用户 / 70% 是否合适？建议可配，按术语流量自适应。
2. `ACCEPT` 是否计入支持量？建议只做弱信号，权重 0.5，不单独触发候选。
3. 是否允许按渠道/角色生成不同默认值？建议 P3 再做，P1/P2 先全局默认 + 歧义提示。
4. 别名候选是否允许管理员直接手填？建议允许（词典编辑已有别名），候选只是加速。
5. 学习事件是否需要展示给普通用户？建议不展示；只在管理后台与解析日志中可见。

## 7. 测试要点

- ANSWER：`ask_user_questions` metadata 带 resolutionId → 答案正确映射到槽位；无 metadata 不误配；多问题/多选/自定义输入各一组。
- CORRECTION：否定、改口径、换含义、编辑重发四类样例；10 分钟窗口边界；无关消息不误判。
- ACCEPT：任务完成 + 无纠正 + 无点踩才记；有点踩/失败不记；24 小时窗口。
- 聚合：阈值边界；同一 slot 多值分布；跨渠道分化生成 DISAMBIGUATION；重复跑聚合幂等。
- 审批：批准写回正确字段、version+1、索引刷新；拒绝需原因；回滚恢复旧值并升版本。
- 前后对比：样本不足标记；14 天窗口计算正确；不出现因果表述。
- 隐私/权限：evidence 无原文；无 `glossary:write` 不能审批；关联会话受 `session:read` 限制。
- 回归：解析器决策不变（学习只写词典）；词典无变更时行为不变。

## 8. 验收标准与观察指标

**验收**

1. 「出货额」10 次澄清里 8 次选「本月」、3 位用户 → 生成 DEFAULT 候选；批准后下一次「看出货额」默认本月，回答首行写明假设。
2. 用户连续纠正「不是这个推单」→ 生成 DISAMBIGUATION 候选，管理员调整优先级/补上下文规则后，同类纠正下降。
3. 候选详情能看到支持量、用户数、上下文分布与脱敏证据，但看不到用户原文。
4. 批准后词典 version+1，解析器索引刷新；回滚恢复旧默认值。
5. 无 `glossary:write` 的账号看不到审批按钮，接口 403。

**指标（上线后 8 周）**

- 高频术语的澄清率、纠正率、首次回答接受率（应用默认值前后对比）；
- 候选生成数、批准率、回滚率；
- 因「理解错术语」导致的失败/点踩占比；
- 管理员维护词典的时间变化（定性），以及「靠猜改默认值」的比例是否下降。
