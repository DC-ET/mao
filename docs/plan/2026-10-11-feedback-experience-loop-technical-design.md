# 负反馈闭环（Feedback → Experience）技术方案

> 状态：已确认（待实施）
> 日期：2026-10-11
> 上游提案：[docs/proposals/2026-10-11-feedback-experience-loop.md](../proposals/2026-10-11-feedback-experience-loop.md)
> 覆盖端：管理后台 admin、后端 backend-ts、桌面端 desktop（无改动，见 §2.3）

---

## 1. 需求背景

点踩反馈的采集侧已两轮落地：桌面端每条助手回复可点踩并选原因（`message_feedback` 表，V123，原因枚举 `WRONG_RESULT` / `SLOW_RESPONSE` / `NOT_SOLVED` / `OTHER` / `NO_REASON`），飞书进度卡可点踩（V125 加 `source` 列，`toggleSessionDislike` 固定写 `NO_REASON`），管理后台有汇总统计与明细页（`feedback:read` 权限）。

**采集之后没有任何事情发生**：反馈只进表供管理员看，Agent 下次执行时提示词照旧，同一个错误反复重演。而 Agent 已有「最佳实践经验」载体（`agent_experiences`，注入 system prompt，见 [docs/plan/2026-07-09-agent-experience-design.md](2026-07-09-agent-experience-design.md)），该表今天只能由管理员在后台手工逐条录入。

本需求把「用户点踩」到「Agent 学到教训」之间的链路补上：LLM 基于点踩上下文起草经验，管理员编辑确认后写入 `agent_experiences`，反馈行标记处理态。

### 1.1 现状代码事实（实施前已核对）

| 事项 | 现状 | 本方案的用法 |
|---|---|---|
| `message_feedback` 列 | `id / message_id / session_id / user_id / agent_id / reason / source / created_at / updated_at`，`uk_message(message_id)` 唯一 | 加 4 列处理态，不改既有列 |
| `AgentExperienceService` | `MAX_CONTENT_LENGTH = 300` 硬校验 + `normalizeAndValidateContent()` + `create()` | 复校验逻辑；写入改走事务内轻量仓储（见 §5.2） |
| 敏感路径规则 | `isSensitive(path)` 导出于 `file/git-write-operation.service.ts`，已有单测（`file.service.spec.ts:318` 起） | 直接 import 复用，**不新增正则** |
| 运行轨迹读模型 | `RunTraceService.buildTrace(sessionId, {beforeRunId, limit, ...})` 按页取 run，无按 messageId 定位入口 | 新增 `locateRunByMessageId()`（见 §5.3） |
| 活动表 | `session_activity` 有 `target`(≤2048) / `summary`(≤512) / `detail_json` / `status` / `duration_ms`；`selectBySessionAll(sessionId)` 全量可取 | 由 run-trace 间接使用，本方案不直接查 |
| LLM 后台调用范式 | `GitCommitMessageService`：读系统设置模型 ID → 缺省回落 `resolveModel(null)`；`LlmCallContext.runAsync({scene, ...})` 包调用；`usageService.record(...)` 落用量 | 完全照搬该范式（见 §5.4） |
| `LLM_CALL_SCENES` | 已有 `GIT_COMMIT_MESSAGE` / `PROXY_APPROVE` / `MEMORY_EXTRACT` 等 | 新增 `FEEDBACK_EXPERIENCE_DRAFT` |
| 权限码注册范式 | V121 目录模式：`INSERT INTO permission` + `INSERT IGNORE INTO role_permission SELECT 1, id FROM permission WHERE code=?`（role_id=1 系统管理员） | V149 照此注册 `feedback:write` |
| 管理后台反馈页 | `admin/src/views/feedback/FeedbackView.vue`，汇总卡 + 明细表 + 原因/时间筛选 + 分页，移动端卡片态 | 在其上增强，不新建页面 |
| `Db.transaction(fn)` | 把连接包成新 `Db` 传入回调 | 事务内新建两个轻量仓储（见 §5.2） |

### 1.2 上游提案的修正（本方案对提案的实质变更）

1. **删除「用户侧可见的回应」**（提案目标 4）：桌面端点踩后不加 toast，飞书卡片结构不改。点踩按钮自身的图标高亮已是充分反馈。理由：该提示对闭环无实质帮助，且需改前端提交面。
2. **轨迹原料来源变更**：提案写「复用 `recordActivity` 落库的工具名/目标/成败」，实施前核对发现 `ActivityService.listBySession` 默认 `limit=50` 且按 `id DESC` 取**最新** 50 条——用户时隔多日才点踩时取到的不是出事轮次。改用运行轨迹读模型并新增按 messageId 定位方法（§5.3）。
3. **脱敏范围收缩**：提案写「命中时目标字段摘要为 `[sensitive]`」，明确为**仅路径类敏感规则**（`isSensitive`），不做 shell 命令内容的正则脱敏。理由：与 git 提交信息口径完全一致、零新增正则；已知边界记录在 §9 风险。
4. **聚集判定口径**：按 `message_feedback.agent_id + reason` **快照口径**分组（不 JOIN session 取实时 Agent）。已知局限：会话更换 Agent 后同类反馈会被劈成两组，接受。
5. **写入目标 Agent**：由管理员在转经验向导里显式选择，默认预选该行 `agent_id`。提案隐含「写该 Agent」，本方案改为显式选择，以覆盖 Agent 已删 / 快照过期 / 教训归属另一 Agent 三种情况。
6. **P3 的「汇总页待处理矩阵」上移到 P2**：矩阵是转经验决策的直接依据，与状态筛选同期交付更有价值。

---

## 2. 需求描述

### 2.1 要做的

1. **反馈处理态**：`message_feedback` 新增 `status`（`PENDING` / `CONVERTED` / `DISMISSED`）、`handled_by`、`handled_at`、`experience_id` 四列。`PENDING` 是唯一入口态，`CONVERTED` 与 `DISMISSED` **均为终态，不可互相流转、不可回退**。
2. **状态可见与可筛**：管理后台明细表新增「状态」列与状态下拉筛选；汇总页新增「待处理反馈数」卡片与「Agent × 原因」待处理矩阵。
3. **同类聚集提示**：明细列表按 `agent_id + reason` 分组计数，行内展示「同类 N 条」；勾选同组多条后一次性进入转经验流程。
4. **经验起草**：选中 N 条反馈（N≥1）点「转为经验」→ 后端取「点踩原因 + 用户原话 + 被点踩的助手消息 + 该消息所在 run 的工具轨迹」调 LLM 起草 → 返回 1~2 条 ≤300 字中文经验草稿。**N=1 走单条 prompt，N≥2 走归纳 prompt**，由服务端按选中数量自动切换，前端无感。
5. **人工确认写入**：向导内可编辑草稿文字、增删条目、选择目标 Agent（默认预选）、确认写入。写入与反馈状态回写**同一事务**；成功后反馈行变 `CONVERTED` 并记录 `experience_id` 与处理人。
6. **忽略**：单选与批量忽略，二次确认，置 `DISMISSED` 终态并记录处理人。
7. **权限**：新增 `feedback:write` 权限码，管控草稿生成、确认写入、忽略三个动作；沿用 `feedback:read` 管控查询。默认均只授系统管理员角色（`role_id=1`）。
8. **可配置起草模型**：新增系统设置项 `feedback.draftModelId`，渲染于「系统设置 → Agent 与模型」分组的模型下拉，留空回落默认模型。
9. **脱敏**：轨迹 target 中命中 `isSensitive()` 的路径替换为 `[sensitive]`；不取工具结果全文；不用命令内容正则脱敏。

### 2.2 不做的

| 项 | 说明 |
|---|---|
| 桌面端 / 飞书点踩后的用户提示 | 图标高亮即反馈，不加 toast、不改卡片结构 |
| `DISMISSED` 恢复 | 终态，误判只能重新走流程 |
| 经验效果回溯 | 「转经验后同类反馈是否下降」属 Evals 范畴（已否决，不重启） |
| 全自动写入 | 不经人工确认直接写 `agent_experiences` 的路径不存在 |
| 草稿持久化 | 不建 `feedback_draft` 表、不用 sessionStorage；草稿只活在浏览器内存，刷新/误关即弃，重新生成 |
| 转经验入口按原因/来源过滤 | 全部 5 种原因、两种来源都允许进入流程，由模型判断价值 |
| 跨用户团队级反馈聚合 | 个人点踩数据按归属隔离，管理侧本就是全量视角 |
| `agent_experiences` 表结构与注入逻辑改造 | 只复用其写入通道与 300 字校验 |
| 经验条数硬上限 | 沿用 2026-07-09 方案记录：本期不设上限，靠向导内「该 Agent 现有 N 条经验」提示抑制堆量 |
| 聚集阈值的可配置化 | 固定按选中数量切换，不做阈值设置 |
| 并发预占 | 不做进入向导即锁定，仅在最终写入时 CAS |
| CLI 入口 | 本期只做管理后台；`mao-cli` 不加 feedback 转换命令 |

---

## 3. 技术选型

| 决策点 | 选型 | 理由 |
|---|---|---|
| 处理态存储 | `message_feedback` 加 4 列，不建新表 | 与消息一对一，无历史查询需求；避免新表与清理逻辑 |
| 草稿存储 | 纯后端一次性返回，前端内存持有 | 生成即评审，不落库；无僵死数据、无 TTL 清理 |
| 轨迹原料 | `RunTraceService` 新增 `locateRunByMessageId` | 复用已上线的归属口径（tool_call_id 挂轮、秒级时钟放宽、未挂到轮），不在 feedback 域重写 |
| LLM 调用范式 | 照搬 `GitCommitMessageService` | 设置读模型 → 回落默认、`LlmCallContext` 包 scene、`usageService.record` 落用量、一次纠错重试，四处已有先例 |
| 敏感规则 | 直接 import `isSensitive` | 已有实现与单测，与 git 提交信息同口径 |
| 事务实现 | `db.transaction()` 内新建轻量仓储 | `Db.transaction` 把连接包成新 `Db` 传回调；不能把全局单例 service 塞进事务 |
| 300 字校验 | 抽出共享纯函数供两处复用 | `AgentExperienceService` 与 feedback 事务内写入必须同口径，避免复制漂移 |
| 冲突控制 | 最终写入 CAS（`UPDATE ... WHERE status='PENDING'` 影响行数判定） | 零新增状态、无僵死 claim |
| 权限码 | `feedback:write`，V121 目录模式注册 | 与 `scheduled-task:write` / `budget:write` / `approval-rule:read` 惯例一致 |
| 聚集口径 | `agent_id + reason` 快照口径 | 与明细行展示同源，不 JOIN session 造成 UI 与数据不一致 |

---

## 4. 数据模型

### 4.1 V148：`message_feedback` 增加处理态

```sql
ALTER TABLE `message_feedback`
    ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING'
        COMMENT 'PENDING 待处理 / CONVERTED 已转为经验 / DISMISSED 已忽略；后两者为终态' AFTER `source`,
    ADD COLUMN `handled_by` BIGINT NULL COMMENT '处理人（管理员 user_id）' AFTER `status`,
    ADD COLUMN `handled_at` DATETIME NULL COMMENT '处理时间' AFTER `handled_by`,
    ADD COLUMN `experience_id` BIGINT NULL COMMENT 'CONVERTED 时关联的 agent_experiences.id' AFTER `handled_at`;

CREATE INDEX `idx_feedback_pending` ON `message_feedback` (`status`, `agent_id`, `reason`, `created_at`);
```

存量行经列默认值回填为 `PENDING`，无需数据订正（与 V125 `source` 列同款处理）。

### 4.2 V149：注册 `feedback:write`

```sql
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '处理点踩反馈', 'feedback:write', '将点踩反馈转为 Agent 经验或忽略'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'feedback:write');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` = 'feedback:write';
```

### 4.3 新增 scene 常量

`backend-ts/src/usage/llm-call-context.ts` 的 `LLM_CALL_SCENES` 增加 `FEEDBACK_EXPERIENCE_DRAFT: 'feedback_experience_draft'`。同时 `LlmUsageService` 的场景常量需对齐（与 `SCENE_GIT_COMMIT_MESSAGE` 并列）。

---

## 5. 实现设计

### 5.1 后端目录与文件

| 文件 | 动作 | 职责 |
|---|---|---|
| `backend-ts/src/feedback/experience-draft.service.ts` | 新建 | 原料装配、prompt 构建、LLM 调用、解析与一次纠错 |
| `backend-ts/src/feedback/feedback.service.ts` | 修改 | 新增 `convertToExperience` / `dismiss` / 待处理矩阵查询；扩 `listDetails` 支持 status/agentId 筛选 |
| `backend-ts/src/feedback/feedback.repository.ts` | 修改 | 新增状态列映射、`casMarkConverted` / `markDismissed`、`countPendingGroupBy`、筛选条件扩展 |
| `backend-ts/src/feedback/feedback.routes.ts` | 修改 | 新增 4 个管理端点（§5.6） |
| `backend-ts/src/agent/agent-experience.service.ts` | 修改 | 抽出 `normalizeAndValidateContent` 为导出纯函数 |
| `backend-ts/src/session/run-trace.service.ts` | 修改 | 新增 `locateRunByMessageId`（§5.3） |
| `backend-ts/src/settings/settings.service.ts` | 修改 | 新增 `FEEDBACK_DRAFT_MODEL_ID_KEY = 'feedback.draftModelId'` 常量与渲染分类 |
| `backend-ts/src/create-app.ts` | 修改 | wiring：装配 `ExperienceDraftService`、事务内仓储、新路由 deps |
| `admin/src/views/feedback/FeedbackView.vue` | 修改 | 状态列/筛选、同类聚集、待处理矩阵、转经验向导、忽略 |
| `admin/src/api.ts`（或页面内） | 修改 | 新增 4 个端点调用 |

### 5.2 事务与校验复用（关键实现约束）

`Db.transaction()` 把连接包成一个新 `Db` 传入回调，因此事务内必须用**该 `Db` 新建的仓储实例**，不能复用全局单例。实现：

```ts
// feedback.service.ts
async convertToExperience(operatorId: number, input: ConvertInput): Promise<{ experienceId: number }> {
  // 1. 事务外预校验：反馈存在、status=PENDING、目标 Agent 存在
  //    （预校验失败直接抛，不进事务，避免无谓开事务）
  // 2. 事务内：CAS 抢占 → 写经验 → 回写反馈
  return this.db.transaction(async (tx) => {
    const feedbackRepo = new FeedbackRepository(tx);
    const experienceRepo = new AgentExperienceRepository(tx);
    const claimed = await feedbackRepo.casMarkConverted(input.feedbackIds, operatorId);
    if (claimed !== input.feedbackIds.length) {
      throw new BusinessException(ErrorCode.FEEDBACK_ALREADY_HANDLED);
    }
    const ids: number[] = [];
    for (const item of input.experiences) {
      const content = normalizeAndValidateContent(item.content); // 共享纯函数，超 300 字抛 AGENT_EXPERIENCE_CONTENT_INVALID
      ids.push(await experienceRepo.insert({ agentId: input.agentId, content, sortOrder: item.sortOrder ?? 0, enabled: 1 }));
    }
    await feedbackRepo.bindExperience(input.feedbackIds, ids[0], operatorId);
    return { experienceId: ids[0] };
  });
}
```

要点：

- **CAS 先行**：`UPDATE message_feedback SET status='CONVERTED', handled_by=?, handled_at=NOW(3) WHERE id IN (...) AND status='PENDING'`，`affectedRows` 与传入数量不等即抛 `FEEDBACK_ALREADY_HANDLED`。CAS 放在事务内第一行，使并发冲突在开事务后立即失败并回滚。
- **多经验与 `experience_id` 的对应关系**：一次转换可能写 1~2 条经验，`experience_id` 只记**第一条**的 id（单值列，不做 JSON）。第二条的追溯通过 `handled_by/at` + 时间邻近性在后台人工判断，不建关联表。
- **共享校验**：把 `AgentExperienceService.normalizeAndValidateContent` 改为导出纯函数 `normalizeExperienceContent(content)`，`AgentExperienceService` 与 feedback 事务内写入都调它，错误码统一为 `AGENT_EXPERIENCE_CONTENT_INVALID`。

### 5.3 轨迹定位：`RunTraceService.locateRunByMessageId`

现有 `buildTrace` 按 `beforeRunId + limit` 翻页。新增：

```ts
async locateRunByMessageId(sessionId: number, messageId: number): Promise<RunTraceVO | null>
```

实现复用既有私有逻辑，不重写归属口径：

1. `selectUserStarts(sessionId, null, Number.MAX_SAFE_INTEGER)` 取全部用户消息锚点（与 `selectUserStamps` 同源，可只取 id + createdAt）；
2. 二分找到满足 `anchor.id <= messageId < upperId` 的那个锚点；找不到（messageId 不属于本会话 / 是用户消息之前的系统消息）返回 `null`；
3. 以该锚点为 `beforeRunId` 的**上界锚**，按 `buildTrace` 里组装单个 run 的同一段逻辑（消息区间 `selectRange` + LLM 窗口 `selectBySessionWindow` + `selectBySessionAll` 活动 + 压缩事件 + `declByCallId` 挂轮）产出**一个** run 的 VO；
4. 返回的 VO 结构与 `buildTrace` 单页内的 run 元素完全一致，前端可复用同一渲染（本方案前端只用其文本摘要，但结构一致便于后续扩展）。

代价：约 40 行 + 单测。收益：原料精确落在出事轮次，不依赖翻页。

### 5.4 经验起草服务

`ExperienceDraftService.draft(feedbackIds: number[], agentId: number | null)`：

**原料装配**（每个反馈一项）：

```
- 点踩原因：reason 中文标签（复用 REASON_LABELS）
- 用户原话：该 run 的 anchor（USER 消息）content，截断 1000 字
- 被点踩回复：message_id 对应 ASSISTANT 消息 content，截断 2000 字
- 工具轨迹：locateRunByMessageId 得到的 run，序列化为紧凑文本：
    round 1: shell_session → "npm run build" (SUCCESS, 3.2s)
    round 1: read_file → "/repo/.env" (SUCCESS)   ← 经 isSensitive 脱敏为 [sensitive]
    round 2: write_file → "/repo/src/a.ts" (ERROR)
  （只取 name / target / status / durationMs；不取工具结果正文）
```

**脱敏点**：对每个 tool 的 `target` 调 `isSensitive(target)`，命中则替换为 `[sensitive]`。只做路径匹配，**不做命令内容正则脱敏**（§2.2、§9）。

**prompt**：

- system：声明只输出 JSON、产出 1~2 条 ≤300 字中文经验、形如「X 场景下优先 Y，避免 Z」、禁止臆测轨迹未体现的行为、禁止 Markdown 围栏。
- user：N=1 时附「基于以下单次点踩」；N≥2 时附「基于以下 N 条同类点踩归纳更通用的经验」。附该 Agent 现有经验条数（`listByAgentId(agentId).length`），提示模型避免与既有经验重复。
- 输出 schema：`{ "experiences": [{ "content": string }] }`，条数钳制 1~2。

**调用与纠错**（照搬 `GitCommitMessageService`）：

- `resolveDraftModel()`：读 `feedback.draftModelId`，非法/不存在回落 `resolveModel(null)`；都无则抛 `MODEL_NOT_FOUND`。
- 包 `LlmCallContext.runAsync({ scene: FEEDBACK_EXPERIENCE_DRAFT, userId: operatorId, sessionId: null, agentId })`。
- 60s 超时（`withTimeout` + `cancelFlag`），失败分类：`LLM_TIMEOUT` / `LLM_CALL_FAILED`。
- 解析失败或条数/字数不符 → 带错误信息重试一次 → 仍失败抛 `LLM_CALL_FAILED`，**不降级为模板文案**。
- `finally` 里 `usageService.record(operatorId, null, model.id, SCENE_FEEDBACK_EXPERIENCE_DRAFT, usage, success)`。注意 userId 用操作的管理员（不是点踩用户），因为这是管理动作。

### 5.5 忽略

`dismiss(operatorId, feedbackIds)`：`UPDATE ... SET status='DISMISSED', handled_by=?, handled_at=NOW(3) WHERE id IN (...) AND status='PENDING'`。影响行数小于传入数量时抛 `FEEDBACK_ALREADY_HANDLED`（与 convert 同码，前端统一提示「部分反馈已被处理，请刷新」）。批量场景下**不要求全部成功**的口径需评审确认——本方案采取**全或无一视同仁**，失败即整体不写，避免批量里混入已处理行时状态不一致。

### 5.6 API

统一 `Result<T>`，均需登录 + `feedback:write`（查询类沿用 `feedback:read`）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/v1/feedback/admin/list` | `feedback:read` | **扩展**：新增 `status`、`agentId` 查询参数；响应行新增 `status` / `handledByName` / `experienceId` / `sameGroupCount`（同类聚集数） |
| GET | `/v1/feedback/admin/summary` | `feedback:read` | **扩展**：响应新增 `pendingCount` 与 `pendingMatrix: Array<{agentId, agentName, reason, count}>` |
| POST | `/v1/feedback/admin/draft` | `feedback:write` | body `{ feedbackIds: number[], agentId?: number }` → `{ experiences: Array<{content}> }` |
| POST | `/v1/feedback/admin/convert` | `feedback:write` | body `{ feedbackIds: number[], agentId: number, experiences: Array<{content, sortOrder?}> }` → `{ experienceId }` |
| POST | `/v1/feedback/admin/dismiss` | `feedback:write` | body `{ feedbackIds: number[] }` → `{ updated: number }` |

设计说明：

- **draft 与 convert 分离**：draft 只读不写，可反复生成（换模型、改原料重试）；convert 才是写入。draft 接收可选 `agentId`，传入时用于「既有经验条数」提示与目标预判，不传入则用反馈行快照 agent_id。
- **convert 不带草稿 ID**：因为草稿不落库，前端把编辑后的 `experiences` 数组直接随 convert 提交。服务端重新执行全部校验（内容非空、≤300 字、条数 1~2、agentId 存在、反馈仍为 PENDING）。
- **不做逐条 convert 端点**：批量是主场景（聚集），单条是批量的特例（数组长度 1）。

### 5.7 管理后台交互

`FeedbackView.vue` 增强（保持现有汇总卡 + 明细表 + 移动端卡片态的结构）：

1. **汇总卡**：在「点踩总数」后插入「待处理」项（`pendingCount`），越线变色（>0 即有语义）。
2. **待处理矩阵**：汇总卡下方新增一张小表（Agent × 原因 → 待处理数），点击单元格把明细筛选设为该 Agent + 该原因 + `status=PENDING` 并滚到明细区。移动端折叠为「按 Agent」单维列表。
3. **明细筛选**：新增「状态」下拉（待处理 / 已转经验 / 已忽略，默认待处理）与「Agent」下拉（选项来自待处理矩阵的 agentId 集合 + 现有数据，用 `clearable`）。
4. **同类聚集**：行内 Agent 列旁展示「同类 N 条」徽标（`sameGroupCount`）；表格开启多选，勾选 ≥2 条时顶部工具条显示「已选 N 条 · 转为经验」。
5. **转经验向导**（抽屉，宽 720px）：
   - 左列：所选反馈的原消息 + 用户原话 + 原因 + 时间；
   - 右列：目标 Agent 下拉（默认预选快照 agent_id，若该 Agent 已删则下拉为空并要求必选）+ 经验草稿编辑区（每条一个 textarea，实时显示 `x/300`，可增删条目，最多 2 条）；
   - 底部：「重新生成」（再调一次 draft）、「取消」、「确认写入」；
   - 生成中右列 loading，左列可滚动查看；
   - 写入成功后关闭抽屉、刷新明细、`ElMessage.success` 提示「已写入 N 条经验」。
6. **忽略**：行内「忽略」按钮 + 批量「忽略」，均 `ElMessageBox.confirm` 二次确认（说明「忽略后不可恢复」）。
7. **已处理行**：`CONVERTED` 行显示经验 ID（点击跳 Agent 编辑弹窗不可行——后台无该深链，改为 tooltip 展示经验正文前 50 字）；`DISMISSED` 行操作列禁用。

---

## 6. 实现步骤

| 步骤 | 内容 | 产出 |
|---|---|---|
| 1 | V148 / V149 两个迁移 | 表结构 + 权限码 |
| 2 | `normalizeExperienceContent` 抽出 + `AgentExperienceService` 改造 | 共享校验 |
| 3 | `RunTraceService.locateRunByMessageId` + 单测 | 轨迹定位 |
| 4 | `ExperienceDraftService`（原料装配 + 脱敏 + prompt + 调用 + 纠错）+ 单测 | 起草服务 |
| 5 | `FeedbackService` / `FeedbackRepository` 扩展（状态机、CAS、矩阵、筛选）+ 单测 | 领域层 |
| 6 | 4 个管理端点 + 权限校验 + 路由单测 | API |
| 7 | `feedback.draftModelId` 设置项（常量 + 渲染分类 + admin 系统设置页下拉） | 配置面 |
| 8 | `create-app.ts` wiring + `LLM_CALL_SCENES` / `LlmUsageService` 场景常量 | 装配 |
| 9 | 管理后台 `FeedbackView.vue` 增强 | UI |
| 10 | 全量单测 + `npm run build` | 质量门 |

建议顺序：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10（先数据与领域，再 API，最后 UI）。

---

## 7. 落地清单

### 7.1 后端 backend-ts

- [ ] `db/migration/V148__message_feedback_status.sql`
- [ ] `db/migration/V149__feedback_write_permission.sql`
- [ ] `agent/agent-experience.service.ts`：抽出导出 `normalizeExperienceContent`
- [ ] `session/run-trace.service.ts`：新增 `locateRunByMessageId` + 单测（命中 run / messageId 不属于会话 / 用户在首条之前的系统消息）
- [ ] `feedback/experience-draft.service.ts`：新建 + 单测
- [ ] `feedback/feedback.service.ts`：`convertToExperience` / `dismiss` / `getSummary` 扩展 / `listDetails` 扩展
- [ ] `feedback/feedback.repository.ts`：状态列映射、`casMarkConverted`、`bindExperience`、`markDismissed`、`countPendingGroupBy`、筛选扩展
- [ ] `feedback/feedback.routes.ts`：4 个新端点 + 2 个既有端点扩展 + 权限校验 + 单测
- [ ] `usage/llm-call-context.ts` + `usage/llm-usage.service.ts`：新 scene 常量
- [ ] `settings/settings.service.ts`：`feedback.draftModelId` 常量与分类
- [ ] `create-app.ts`：装配 `ExperienceDraftService`、事务内仓储、路由 deps
- [ ] `common/error-code.ts`：新增 `FEEDBACK_ALREADY_HANDLED`（HTTP 409）

### 7.2 管理后台 admin

- [ ] `views/feedback/FeedbackView.vue`：状态列/筛选、同类聚集徽标、多选批量、待处理卡片与矩阵、转经验向导、忽略确认
- [ ] 系统设置页「Agent 与模型」分组：`feedback.draftModelId` 模型下拉（若该分组由 schema 驱动则只需后端加分类；否则加表单项）

### 7.3 不做

- [ ] 不改桌面端 `desktop/` 任何文件
- [ ] 不改飞书卡片与点踩采集链路
- [ ] 不加 `mao-cli` 命令
- [ ] 不建 `feedback_draft` 表
- [ ] 不做 `DISMISSED` 恢复入口

---

## 8. 测试要点

### 8.1 状态机与并发

- `PENDING → CONVERTED`：成功后 `status/handled_by/handled_at/experience_id` 四列均正确，经验行写入目标 Agent 且 `enabled=1`。
- `PENDING → DISMISSED`：三列正确，`experience_id` 为 NULL。
- 重复 convert：第二次返回 `FEEDBACK_ALREADY_HANDLED`，且不重复写经验。
- 并发 convert 同一批：只有一个事务成功，另一个 `affectedRows` 不符而回滚，最终经验条数 = 草稿条数（不翻倍）。
- 经验内容超 300 字：抛 `AGENT_EXPERIENCE_CONTENT_INVALID`，事务回滚，反馈仍为 `PENDING`（可重试）。
- convert 与 dismiss 混批（部分已处理）：整体失败，无部分写入。

### 8.2 起草服务

- N=1 产出 1 条；N≥2 产出 1~2 条且措辞更通用。
- prompt 输入**不含**工具结果正文（断言序列化原料中无 `tool_result` 内容）。
- 脱敏：轨迹含 `.env` / `*.pem` / 含 `token`/`secret` 的文件名时，原料中该 target 为 `[sensitive]`。
- 模型返回非法 JSON / 条数越界 / 超 300 字：纠错一次；二次仍失败抛 `LLM_CALL_FAILED`，且不写任何状态。
- LLM 超时 / 调用失败：抛 `LLM_TIMEOUT` / `LLM_CALL_FAILED`，反馈状态不变。
- 模型解析：`feedback.draftModelId` 未配置 / 配了不存在的 id / 配了非法值 → 回落默认模型；默认模型也没有 → `MODEL_NOT_FOUND`。
- 用量：`llm_call` 落一行，`scene='feedback_experience_draft'`、`user_id`= 操作管理员、`agent_id`= 目标 Agent、`success` 正确；计入成本与预算口径（与 `git_commit_message` 一致）。

### 8.3 轨迹定位

- messageId 落在某 run 内 → 返回该 run，轮次/工具/成败与 `buildTrace` 同页结果一致。
- messageId 属于其他会话 → 返回 `null`，draft 报「反馈关联消息不可用」。
- messageId 早于第一条用户消息（纯系统消息）→ 返回 `null`。
- 会话被压缩过 → 仍能返回压缩边界之后的 run；早于边界的返回 `null` 或该 run 的压缩后形态（按既有 `buildTrace` 口径，不新造语义）。

### 8.4 API 与权限

- 非 `feedback:write` 调 draft/convert/dismiss → 403；`feedback:read` 不可调这三个。
- `listDetails` 的 `status` / `agentId` 筛选正确；`sameGroupCount` 与矩阵口径一致（同 `agent_id + reason + status=PENDING`）。
- `summary` 的 `pendingCount` / `pendingMatrix` 与明细筛选结果总数一致。
- convert 的 `agentId` 不存在 / 已删 → `AGENT_NOT_FOUND`，不写任何东西。

### 8.5 回归

- `feedback:read` 明细查询的既有字段与排序不变（新增列不影响旧消费方）。
- 桌面端 / 飞书点踩写入仍走 `uk_message` 幂等（`upsert` 未改）。
- `AgentExperienceService` 既有 CRUD 与 `syncExperiences` 行为不变（抽出纯函数不改语义）。
- `buildTrace` 现有翻页行为零变化（只新增方法）。

---

## 9. 风险与开放问题

1. **shell 命令内的明文密钥会进 prompt**（已知边界，评审已确认接受）：`isSensitive` 只匹配路径，`shell_session` 的 target 是完整命令串，其中如 `curl -H "Authorization: Bearer sk-xxx"` 会原样进入 prompt 并发送到模型服务。缓解：原料只含 target 与成败、不含 stdout；管理后台使用者是受信任管理员；起草模型由运维自选。**不做**命令内容正则脱敏（与 git 提交信息口径一致）。
2. **草稿质量不可控**：轨迹只有工具名/目标/成败，模型可能写出泛泛而谈的经验。缓解：必须人工编辑确认；prompt 要求引用轨迹中的具体对象；写入后可随时在后台编辑或停用（既有能力）。
3. **提示词膨胀**：一次转换最多写 2 条，`agent_experiences` 无硬上限。缓解：draft 时把「该 Agent 现有 N 条经验」给模型并要求避免重复；向导内展示该数字。条数硬上限留待后续（2026-07-09 方案已记录）。
4. **`experience_id` 只记第一条**：一次转换写 2 条时，第二条无法从反馈行直接追溯。缓解：`handled_by/at` 时间邻近 + Agent 经验列表人工比对；不建关联表（低频操作，不值得）。
5. **快照口径的分裂**：会话更换 Agent 后，同类反馈按快照 agent_id 被劈成两组，聚集数与矩阵都会分裂。缓解：接受（文档记录）；后续如需可按会话实时 agent_id 归并，属独立改动。
6. **飞书点踩行不稳定**：飞书是 toggle 语义，取消点踩会物理删行；若该行已 `CONVERTED`，删行后经验不回滚（写入即独立资产）。此行为符合预期，不做级联删除。
7. **批量全或无**：批量 convert/dismiss 中若有一行已被处理，整体失败。管理员需刷新后重试。这是为避免部分写入导致状态不一致而采取的口径，若评审认为应支持部分成功，改为逐行 CAS + 返回 `{updated, skipped}`。

---

## 10. 已确认决策摘要

| # | 决策 |
|---|---|
| 1 | `DISMISSED` 为终态，不可恢复；`CONVERTED` 同为终态 |
| 2 | 全部来源（desktop/feishu）、全部 5 种原因都允许进入转经验流程，无前置过滤 |
| 3 | 目标 Agent 由管理员在向导里显式选择，默认预选反馈行快照 `agent_id` |
| 4 | 起草模型可配置：新增系统设置 `feedback.draftModelId`，留空回落默认模型 |
| 5 | 聚集按 `feedback.agent_id + reason` 快照口径分组 |
| 6 | 单条 / 归纳由服务端按选中数量自动切换（N=1 单条，N≥2 归纳），前端无感 |
| 7 | 写经验与回写反馈状态严格同事务（`db.transaction` 内新建轻量仓储） |
| 8 | 并发冲突仅在最终写入时 CAS 判定，进入向导不预占、无中间状态 |
| 9 | 桌面端点踩提示不做（图标高亮即反馈）；飞书卡片不改 |
| 10 | 权限拆分为 `feedback:read`（既有）+ `feedback:write`（新增，V149，默认授 role_id=1） |
| 11 | 草稿纯前端内存持有，不建表、不用 sessionStorage |
| 12 | 轨迹原料改用 run-trace，新增 `RunTraceService.locateRunByMessageId` 精确定位 |
| 13 | 脱敏仅复用 `isSensitive` 路径规则，不做 shell 命令内容正则脱敏 |
| 14 | 汇总页加「待处理数」卡片 + Agent×原因待处理矩阵，并入 P2 |
| 15 | 迁移拆两个：V148 改表结构、V149 插权限码 |
| 16 | 一次转换写多条经验时，`experience_id` 只记第一条 |
