# 提案：任务模板 / Runbook —— 把重复的 SOP 从「每次重打一遍」变成「一次配置，多次运行」

- 状态：**已否决**（2026-10-19 评审：不做，存档勿再评审）
- 日期：2026-10-19
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

平台今天有四种「让 Agent 干活」的发起方式：手动发消息、定时任务（`schedule` 域）、信号哨兵变化触发（`signal` 域）、开放 API / 入站 Webhook（`openapi` 域）。它们的共同输入都是「一个 Agent + 一段提示词 + 一组运行配置」——但**没有任何东西把这三者的组合存下来复用**。

现状盘点：

1. **定时任务每次从零手填**。`scheduled-task.service.ts:14-46` 的字段是 name / prompt / cronExpression / once / retry / missedPolicy；`scheduled-task.routes.ts` 无任何模板端点。「每天早上跑一遍竞品价格巡检」「每周五出一份周报」「发版前三件套检查」这类高频 SOP，用户的做法是：第一次仔细写一遍 prompt，之后每次新建任务都把上次的 prompt 从历史任务里翻出来复制粘贴——或者更常见，**干脆只建一个任务反复改 prompt**。
2. **全库唯一的「模板」机制在哨兵里**。`signal/watcher.logic.ts:138-139` 的 `prompt_template` 支持 `{url}` / `{name}` / `{diff}` 占位符，变化时渲染后投递。这证明了「提示词参数化」的需求真实存在，但它锁在哨兵域内，定时任务与会话创建都享受不到。
3. **资产层各管一段，中间是空的**。`command` 域的 `user_commands`（userId + name + content，经 `#{name}#` 在 prompt 引擎展开）是**提示词级**复用；`agent-bundle` 是 **Agent 级**搬运；中间的**任务级**（哪个 Agent、用什么提示词、带什么参数、默认怎么调度）没有实体。`command.service.ts:17-26` 的可用列表 = 系统指令 + 个人指令，同样无参数化、无分类、无使用统计。
4. **团队场景断在这里**。定时任务可靠性（0.0.256）解决了「无人值守的可信」，但「无人值守的**标准化**」没有答案：运维负责人写好的巡检任务，没法作为团队资产发给其他人；新人入职配三个定时任务要靠口口相传。

相邻方向的边界：

- **不是低代码工作流画布**（README 明确「不是 Dify / n8n」）：一个模板 = 一个任务的参数化快照，不引入步骤、连线、分支。
- **不是多 Agent 编排**（已否决）：模板不含「先 A 后 B」的编排语义，只是单次运行的预制参数。
- **不是指令库的替代**：指令是会话内提示词增量（`#name#` 展开），模板是任务级预制菜（含 Agent 绑定与调度建议），两者互补——模板的 prompt 里本就可以引用指令。
- **不是技能蒸馏**（已否决）：模板由人编写和维护，不从轨迹自动生成。

## 2. 目标 / 非目标

**目标**

1. **模板实体**：用户可建「任务模板」——名称、描述、目标 Agent、提示词正文（含 `{{变量}}` 占位）、每个变量的说明与默认值、建议调度（cron 提示值，仅作预填）、默认通知渠道偏好（复用任务通知既有配置）。新建表 `task_template` + `task_template_variable`，对既有表零改动。
2. **从模板一键创建**：定时任务面板「从模板新建」→ 选模板 → 填变量值（有默认值的预填）→ 生成定时任务（cron 用模板建议值预填，可改）。P2 扩展到：从模板直接开一个一次性会话 / 一次性运行。
3. **变量渲染**：创建时把 `{{变量}}` 替换为当次填写值写入任务的 prompt（**渲染时机在创建时，不在每次触发时**——定时任务的 prompt 是固定文本，语义不变；触发时再渲染是哨兵的模式，不适合会累积历史的定时任务）。
4. **我的模板管理**：设置页或定时任务面板内的模板 CRUD（列表 / 新建 / 编辑 / 删除 / 用量：被几个任务引用）。
5. **分发（P3）**：模板导出 / 导入为 bundle 文件，对齐 `agent-bundle` 的导出导入 + `check-updates` 漂移检测模式（content_hash），作为团队共享的轻量通道——不新建 registry 服务，先做文件级搬运。

**非目标**

- 不做模板版本历史（P1 单最新版；编辑即覆盖，被引用任务的 prompt 已固化不受影响——语义上「模板是起点，不是活链接」）。
- 不做团队共享目录 / 上架审批（那套属于 agent 资产分发，P3 只做文件导入导出）。
- 不做变量类型系统（枚举 / 数字 / 日期选择器）——P1 全是文本变量 + 默认值。
- 不做「模板触发统计」（哪个模板被跑了几次）——任务与模板的引用关系在创建时快照，P1 只记录引用数。
- 不做在模板里预置技能 / MCP / 模型选择——Agent 已绑定这些，模板只负责「哪个 Agent + 说什么」。

## 3. 方案要点

### 3.1 数据模型（迁移号顺延，当前已到 V160）

```sql
CREATE TABLE IF NOT EXISTS `task_template` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`     BIGINT NOT NULL COMMENT '属主',
    `name`        VARCHAR(128) NOT NULL COMMENT '模板名称',
    `description` VARCHAR(500) NULL COMMENT '一句话说明用途',
    `agent_id`    BIGINT NOT NULL COMMENT '目标 Agent（创建时快照 id）',
    `prompt_template` TEXT NOT NULL COMMENT '提示词正文，含 {{变量}} 占位',
    `cron_hint`   VARCHAR(64) NULL COMMENT '建议调度（仅预填，可改）',
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_tpl_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务模板：可复用的任务预制参数';

CREATE TABLE IF NOT EXISTS `task_template_variable` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `template_id` BIGINT NOT NULL,
    `name`        VARCHAR(64) NOT NULL COMMENT '变量名（{{name}} 引用）',
    `label`       VARCHAR(128) NOT NULL COMMENT '填写时展示的中文名',
    `default_value` VARCHAR(500) NULL COMMENT '默认值（可空）',
    `sort_order`  INT NOT NULL DEFAULT 0,
    INDEX `idx_tpl_var_tpl` (`template_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务模板变量定义';
```

属主删除时的级联：随用户删除走既有用户级数据清理口径（对齐 user_commands 的处理）。

### 3.2 变量渲染

- 解析：`{{name}}` 形态（与哨兵的 `{name}` 单括号区分开，避免与提示词里可能出现的 JSON / 代码片段冲突——双括号 + 标识符约束 `[a-zA-Z_][a-zA-Z0-9_]*`）。
- 校验：模板保存时校验「正文里的每个 `{{x}}` 都有对应变量定义，反之每个变量都在正文出现过」——双边校验，防止存了个永远填不上的模板。
- 渲染：创建时纯字符串替换；未填且无默认值的变量 → 创建流程阻断（必填）。渲染逻辑是纯函数，单测覆盖。

### 3.3 创建链路

复用既有创建端点，不新开「模板化创建」端点家族：

- 定时任务：设置页 / 任务面板走既有 `POST /v1/scheduled-tasks`，只是前端多一层「选模板 → 填变量 → 预填表单 → 提交」的引导；任务行上记 `template_id`（定时任务表加一列可空引用，纯记录用途，P1 仅用于「被 N 个任务引用」统计）。

  **待确认**：`scheduled_task` 加引用列需要一个迁移（V16x），若评审希望零迁移，可降级为不记引用、只在前端传参——倾向保留引用列，成本一列、收益（用量统计、后续「模板改了影响哪些任务」提示）实在。
- 会话 / 一次性运行（P2）：`POST /v1/sessions` 带预渲染 prompt + agentId，前端在新建任务流程加「从模板开始」入口。

### 3.4 前端

- 定时任务面板（`desktop/src/components/ScheduledTaskPanel.vue`）顶部加「从模板新建」入口 → 模板选择器（名称 / 描述 / 所属 Agent）→ 变量表单（label + 默认值预填）→ 落入既有新建表单（name / cron 预填模板值）。
- 模板管理：设置页新增「任务模板」卡片（与「我的指令」并列），列表 + CRUD；变量编辑器为动态行（name / label / default）。
- CLI（P2 评估）：`mao-agent` 加 `--template` 参数意义不大（终端场景模板消费低频），**建议不做**，避免 CLI 面膨胀。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 两表 + 模板 CRUD + 变量双边校验与渲染 + 「从模板建定时任务」前端链路 + 设置页模板管理 | 中 |
| P2 | 从模板直接开会话 / 一次性运行；模板被引用数统计 | 小 |
| P3 | 模板 bundle 导出 / 导入（对齐 agent-bundle 文件格式与 drift 检测）；模板描述的建议 cron 智能预填评估 | 小~中 |

## 5. 风险与开放问题

- **范围蔓延到工作流**：模板是最容易滑向「多步编排」的概念。缓解：宪法级约束写进提案与技术方案——一个模板渲染出**一个**任务，评审时对任何「步骤 / 条件 / 并行」诉求一律拒收或转人工维护多个模板。
- **引用语义混淆**：用户改模板后期望「已建的任务也跟着变」是自然但错误的预期。缓解：产品文案明确「模板是起点，不是活链接」；任务创建后与模板脱钩（prompt 已固化）；`template_id` 仅用于统计。
- **Agent 删除**：模板引用的 Agent 被删后模板不可用。缓解：创建时快照 agentId + 展示时校验存在性，失效模板置灰并提示改绑。
- **变量注入**：模板属主即写入者，信任等级与 user_commands 相同（用户只能注自己的 prompt），无越权面；无需额外安全评审。
- **开放问题**：模板要不要支持「项目级 / 团队级」共享字段——P1 纯个人；P3 bundle 分发后再评估是否需要 DB 级的团队共享（与 agent 共享目录同评审）。
- **开放问题**：建议 cron（`cron_hint`）是否值得做「自然语言 → cron」的 LLM 辅助——与 `git_commit_message` 同属「小场景 LLM 辅助」，若做需按规范加 `LlmCallScene` 新成员（三处同改）；建议 P1 先手工填，P3 评估。

## 6. 测试要点

- 模型层：CRUD；属主隔离（看不到别人的模板）；Agent 失效后模板状态。
- 变量：双边校验（正文有变量无定义 / 有定义正文没用到，均拒绝保存）；渲染替换正确（含变量值里自带 `{{` 的转义边界——需定义：不做递归替换）；必填变量未填时创建阻断；默认值预填。
- 创建链路：从模板创建的定时任务字段正确（prompt 渲染结果、agent、cron 预填）；任务执行行为与手建任务完全一致（回归定时任务既有 spec）。
- 前端：模板选择 → 变量表单 → 提交全链路；模板管理 CRUD；引用数展示。
- 迁移：V16x 新表对既有 schedule / session 域零影响（跑既有全量 spec）。
