# 技术方案：跨会话长期记忆（Memory 层）

- 状态：已评审定稿（已吸收 2026-10-02 技术评审补充），待实施
- 日期：2026-10-02
- 关联提案：`docs/proposals/2026-10-02-long-term-memory.md`（本方案为其技术细化，已吸收评审决策）
- 本期范围：提案 P1 + P2 全量交付；P3 工具化不做（见"明确不做清单"）

## 1. 需求背景

Mao 的 Agent 目前"每次见面都从零开始"：

- **单会话内**：ContextManager / CompactionService 负责上下文压缩，会话结束即遗忘。
- **跨会话**：唯一的记忆资产是 Agent"经验"（`backend-ts/src/agent/agent-experience.service.ts`，`agent_experiences` 表）——管理员手工维护、单条上限 300 字、Agent 级别而非用户级别。
- **注入点**：`backend-ts/src/harness/core/prompt-engine.ts` 的 `buildSystemPrompt()`（`prompt-engine.ts:194`）以 `## 最佳实践经验` 段落注入上述经验。

缺口：用户在会话里说过"我们仓库用 pnpm"、"报告用中文写"，下个会话、换个 Agent 就全部归零。这些信息已经躺在会话消息里，只是没有任何机制把它们沉淀下来。

## 2. 需求描述

### 2.1 目标（本期全部交付）

1. 用户可手工维护个人长期记忆：在设置页"我的记忆"（MemoryView）中新增、编辑、删除、忽略（DISMISS）记忆条目，条目分"用户级"与"项目级"两种作用域。
2. 任务完成收尾时自动沉淀"值得记住的长期事实"（用户偏好、项目事实）：服务端异步调用轻量 LLM 抽取，写入记忆库，与手工条目共用一套存储与去重。
3. 后续会话（跨 Agent、跨会话、全渠道）在系统提示词中自动注入相关记忆。
4. 用户对自己的记忆有完全的可见性与控制权：查看、编辑、删除、忽略、一键关闭自动收集（全局开关）。
5. 管理后台提供只读审计页：按用户查看记忆内容，注册独立权限码 `memory:read`。

### 2.2 记忆模型

两级自动记忆 + 一级既有经验，本期交付前两级：

| 级别 | 绑定维度 | 示例 | 来源 |
|---|---|---|---|
| USER | 用户，跨 Agent、跨工作区 | "输出报告用中文"、"习惯 pnpm" | 自动抽取 + 用户手写 |
| PROJECT | 项目（`session.projectKey`），跨 Agent | "该仓库测试用 Vitest" | 自动抽取 + 用户手写 |
| AGENT | Agent（现有"最佳实践经验"） | 该 Agent 的方法论 | 管理员手工（现状不变，本期不动） |

注入优先级：AGENT（现状段落）→ PROJECT → USER；注入文案显式声明"与用户当前消息冲突时以当前消息为准"。

## 3. 关键决策记录（已与需求方逐项确认；D11–D12 为 2026-10-02 技术评审补充拍板）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 本期范围 | P1（表+注入+手工管理 API+MemoryView）与 P2（自动抽取）本期全做；P3 `memory_save` 工具化不做 |
| D2 | 抽取触发条件 | 仅任务相位收敛到 `COMPLETED`；FAILED / CANCELLED 不抽取 |
| D3 | 拒绝语义 | DISMISS 为软拒：保留行、不再注入、再次抽取到相同内容时直接丢弃且不复活；DELETE 为物理删除：后续任务再次抽到相同事实时允许重新插入为新记忆 |
| D4 | 归属边界 | 记忆永远个人归属（`user_id` 隔离）；PROJECT 级只是"绑定到某项目的个人记忆"，不跨用户共享 |
| D5 | PROJECT 绑定键 | 复用现有 `session.projectKey`（`session.service.ts:1151` `deriveProjectKey`，即工作区路径尾段；CLOUD 下即 workspace slug），不引入路径 SHA-1 哈希；表结构省去 `workspace_label` 字段 |
| D6 | 抽取覆盖范围 | 主会话全渠道（Web/桌面/LOCAL/钉钉/微信/飞书/定时任务）；排除 `sessionType = SUBAGENT` 与 `SIDE_TASK`（主任务片段由主会话统一抽取，避免碎片化） |
| D7 | 容量限额 | 手工新增单条 ≤ 500 字；每用户 ACTIVE 状态记忆总量 ≤ 200 条；注入上限 USER 8 条 + PROJECT 12 条 |
| D8 | 抽取输入 | 仅取该会话最后一轮 USER 消息 + ASSISTANT 最终答复 |
| D9 | 自动收集开关粒度 | 仅一个用户级全局开关，MemoryView 页控制；不做按 Agent / 按会话粒度。（2026-10-02 实施调整：按需求方要求，默认值由"开"改为"**关**"——关闭状态下现有功能逻辑零影响，用户显式开启后才自动抽取） |
| D10 | 抽取模型 | settings 域新增 `memory.extractionModelId`，留空回落系统默认模型（跟随 `session.titleModelId` 模式） |
| D11 | 抽取短路 | 取到最后一轮 USER 消息后，规范化（trim + 连续空白折叠）不足 20 字直接跳过抽取、不调 LLM（阈值为代码常量），闲聊型短会话零成本 |
| D12 | 编辑语义 | 编辑条目 content 不改变 status；DISMISSED → ACTIVE 恢复须显式「恢复」操作 |

## 4. 技术选型

| 选型点 | 结论 | 理由 | 放弃的方案 |
|---|---|---|---|
| 记忆检索 | 规范化去重 + 条数截断（`updated_at` DESC 取 top N） | MVP 规模下精确去重够用，零新增基础设施 | 向量库 / embedding 检索（规模上来后另立提案评估） |
| PROJECT 绑定键 | 现有 `projectKey` | 已有字段（`AgentExecutionContext.projectKey`），注入匹配零成本；可读、用户可见；同一仓库 clone 到不同本地路径/换机器记忆仍跟随 | 规范化路径 SHA-1 前 16 位（提案原文）：换路径即失配、不可读、需额外展示名字段 |
| 用户开关存储 | preference 域新增 `user_memory_preference` 专表 | 该域既有模式即"每个偏好一张专表"（`user_weixin_preference`、`user_task_panel_preference`） | 通用 KV 表（域内不存在该模式）；塞进 `memory_item`（概念不符） |
| 抽取模型配置 | settings 域 `memory.extractionModelId`（V130 预置行） | 与 `session.titleModelId`（V078）、`git.commitMessageModelId` 完全同构，admin `SystemSettingsView.vue:183` 的 `MODEL_SELECT_KEYS` 加入即渲染为模型下拉 | 为抽取单独建模型路由 |
| 抽取挂点 | `task-terminal.service.ts` `finishExecution()` 内追加异步派发 | 该方法是所有执行入口（主链路/钉钉/微信/飞书/定时任务/崩溃恢复）收敛到终态的必经点，一处挂点覆盖全渠道 | 各渠道分别挂点（遗漏风险高）；LlmAdapter 流式回调里挂（与任务终态语义解耦差） |
| 抽取执行方式 | 构造函数注入 executor 的 fire-and-forget 异步（模式同该类现有 `notificationExecutor`） | 任务完成语义绝不被抽取拖累或破坏；测试可注入同步 executor | 队列/定时批处理（一期过重） |
| 新后端域 | `backend-ts/src/memory/`（routes/service/repository/spec） | 领域划分惯例 `src/<domain>/*.{routes,service,repository,spec}.ts` | 塞进 session 域（跨会话、跨 Agent，独立生命周期） |

## 5. 详细设计

### 5.1 数据模型与迁移

**V129（P1 交付）：`backend-ts/db/migration/V129__memory_item.sql`**

```sql
CREATE TABLE IF NOT EXISTS `memory_item` (
    `id`                BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`           BIGINT NOT NULL,
    `scope`             VARCHAR(16) NOT NULL COMMENT 'USER/PROJECT',
    `project_key`       VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'PROJECT 级绑定 session.projectKey；USER 级为空串',
    `content`           TEXT NOT NULL,
    `source`            VARCHAR(16) NOT NULL DEFAULT 'MANUAL' COMMENT 'AUTO=Agent 抽取 / MANUAL=用户手写',
    `status`            VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE/DISMISSED',
    `dedup_hash`        CHAR(40) NOT NULL COMMENT 'SHA-1(scope|project_key|规范化 content)',
    `origin_session_id` BIGINT NULL COMMENT 'AUTO 抽取来源会话',
    `created_at`        DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_memory_dedup` (`user_id`, `dedup_hash`),
    INDEX `idx_memory_user` (`user_id`, `scope`, `status`),
    INDEX `idx_memory_project` (`user_id`, `project_key`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `user_memory_preference` (
    `user_id`              BIGINT PRIMARY KEY,
    `auto_capture_enabled` TINYINT(1) NOT NULL DEFAULT 1,
    `created_at`           DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 管理后台只读审计权限码（模式同 V121，无对应 write 码：admin 仅只读）
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看用户记忆', 'memory:read', '只读查看指定用户的长期记忆内容（审计用途）'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'memory:read');
```

- 去重哈希把 scope 与 projectKey 算进内容：`dedup_hash = SHA1("{scope}|{projectKey ?? ''}|{规范化 content}")`，规范化为 `content.trim()` 后连续空白折叠为单空格。同一事实在用户级与项目级各自独立去重。
- 项目级索引按 `(user_id, project_key, status)` 设计：查询永远带 `user_id`（D4 个人归属），不存在跨用户按项目查询。
- LOCAL 会话不再存路径原文：`projectKey` 本身就是路径尾段（如 `mao`），不含本机用户名等敏感片段，提案中的"路径哈希化 + 展示名"机制随之不需要。
- 迁移号占用说明：V129/V130 归本方案；任务收件箱方案顺延占 V131，Agent 资产包方案顺延占 V132（2026-10-02 评审统一定号，收件箱/资产包文档已同步）。
- 可选加固（非必须）：`session` 表现有索引无 `(user_id, project_key)` 组合，`GET /api/v1/memory/projects` 的 distinct 查询走 `idx_user` 在个人会话量级下可接受；实施时若顺手，可在 V129 内对 `session` 补 `INDEX idx_session_user_project (user_id, project_key)`。

**V130（P2 交付）：`backend-ts/db/migration/V130__memory_extraction_model_setting.sql`**

```sql
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('memory.extractionModelId', '', '记忆', '记忆自动抽取使用的模型 ID，留空则使用默认模型', 1);
```

### 5.2 注入路径

**`backend-ts/src/harness/core/agent-execution-context.ts`**：新增字段 `memories: MemoryHint[] | null`。`MemoryHint` 定义 `{ scope: 'USER' | 'PROJECT'; projectKey: string | null; content: string }`，放在 memory 域并由此处引用。

**`backend-ts/src/harness/core/harness-service.ts`** `buildContext()`（`harness-service.ts:261` 起）：在 `context.experiences` 赋值（:297）之后追加：

1. 解析当前 `session.projectKey`；为 null（如微信渠道会话）时只查 USER 级。
2. 查询：USER 级 `status='ACTIVE'` 按 `updated_at` DESC 取 8 条；PROJECT 级按 `(userId, projectKey, 'ACTIVE')` 同序取 12 条。
3. 整段 try-catch：查询失败仅记 warn 日志、`memories` 置 null，**不阻断会话启动**。注意 `harness-service.ts:281-287` 的技能同步 try-catch 仅覆盖 CLOUD 分支（LOCAL 的技能同步在 `streaming-ws-handler.ts:560-567`，失败会话直接失败）——记忆查询的降级须独立实现，勿"对齐"该样板。

**`backend-ts/src/harness/core/prompt-engine.ts`** `buildSystemPrompt()`：在"## 最佳实践经验"段（:199-206）之后新增段落；`memories` 为空/null 时不产生该段落：

```
## 长期记忆
以下是关于这位用户与当前项目的已确认记忆；与用户当前消息或工作区规则冲突时，以用户当前消息为准：
- [项目:mao] 该仓库测试用 Vitest
- [用户] 输出报告用中文
```

- `[项目:xxx]` 的 xxx 即 `projectKey`；USER 级显示 `[用户]`。
- CLOUD / LOCAL 均走服务端注入（buildContext 两模式共用），无执行边界差异。

### 5.3 手工管理 API（用户域，登录态，`Result<T>` code=0）

新增 `backend-ts/src/memory/memory.routes.ts`，全部归属校验为 `user_id = 当前登录用户`，越权/不存在一律 404：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/memory` | 分页列表（page/pageSize），支持 `scope` / `projectKey` / `status` 过滤，按 `updated_at` DESC |
| POST | `/api/v1/memory` | 手工新增：`{scope, content, projectKey?}`。PROJECT 级必填 projectKey（≤128 字符）；content 必填且 ≤500 字；超出 200 条总量上限时报业务错误码提示清理 |
| PATCH | `/api/v1/memory/:id` | 编辑 content（重算 dedup_hash，与新 hash 冲突时返回业务错误码；编辑不改 status，见 D12）；或切换 status（ACTIVE ↔ DISMISS 双向允许，DISMISSED 恢复为显式操作） |
| DELETE | `/api/v1/memory/:id` | 物理删除 |
| GET | `/api/v1/memory/settings` | 返回 `{autoCaptureEnabled}`（无偏好行时视为 false，即默认关闭，见 D9 实施调整） |
| PATCH | `/api/v1/memory/settings` | 更新自动收集开关 |
| GET | `/api/v1/memory/projects` | 手写 PROJECT 级记忆的项目下拉数据源：该用户历史会话出现过的 projectKey 去重集合，排除机器人渠道特殊值（`WEIXIN_PROJECT_KEY` 及飞书渠道 key，判定逻辑复用 `task-terminal.service.ts:56` 同款） |

新增 `memory.service.ts`（校验、限额、去重哈希计算）与 `memory.repository.ts`（MySQL 实现）。注册进 `create-app.ts` 路由表；`/v1/**` 已在鉴权拦截器排除清单之外，登录态即生效，无需新增权限配置。

### 5.4 管理后台只读审计

- 后端：`backend-ts/src/admin/admin.routes.ts` 新增 `GET /api/v1/admin/memory?userId=&page=&pageSize=&scope=&status=`，路由前 `await requireRequestPermission(deps.permissionService, req, 'memory:read')`（模式同现有 admin 路由）。仅查询，不提供任何写接口。
- 前端：新增 `admin/src/views/memory/MemoryAuditView.vue`（按 userId 搜索 + 分页表格，仅查看），`admin/src/router/index.ts` 新增路由并带 `meta: { permission: 'memory:read' }`。页面顶部固定提示"本页面用于审计用户记忆内容，仅供治理用途"。

### 5.5 前端 MemoryView（桌面 / Web / 安卓共用 UI）

- 新增 `desktop/src/views/settings/MemoryView.vue`：
  - 顶部：自动收集开关（D9 全局唯一开关）+ "新增记忆"按钮。
  - 列表：scope 过滤页签（全部 / 用户 / 项目）+ 状态过滤（默认只看生效中，可切换查看已忽略）；每行显示内容、来源徽标（自动 / 手动）、项目名（PROJECT 级）、更新时间；行内编辑、忽略/恢复、删除。
  - 新增弹窗：scope 选择；选"项目"时项目下拉数据来自 `GET /api/v1/memory/projects`；内容 textarea（500 字计数上限）。
- `desktop/src/router/index.ts` settings children 新增 `/settings/memory`；`SettingsView.vue` 左侧导航新增入口（router-link 模式同现有子页）。
- `desktop/src/api/index.ts` 新增记忆接口封装。
- 安卓 / Web 因共用 desktop UI 自动获得，无原生改动。
- 会话内不新增任何 UI：Agent 记住了什么，用户去设置页看（保持聊天界面克制）。

### 5.6 自动抽取（P2）

**挂点**：`backend-ts/src/session/task-terminal.service.ts` `finishExecution()`（:25 起，任务通知派发在 :62），在 `updatePhase` / `markLastMessageFinished` 完成后追加派发；**直接复用方法内已查得的 session 对象（userId / projectKey / sessionType 均在手），不再追加查询**。触发条件全部满足才派发：

1. `phase === 'COMPLETED'`（D2）；
2. `session.sessionType !== 'SUBAGENT' && session.sessionType !== 'SIDE_TASK'`（D6，判断沿用 :79-84 现有 sessionType 分支惯例）；
3. 用户开关开启（无偏好行视为关闭，即默认不抽取；见 D9 实施调整）。

派发方式：构造函数注入 `memoryExecutor: (fn) => void`，默认实现 fire-and-forget（模式同现有 `notificationExecutor` :20-23），抽取全程异常只记日志 + 计数，**绝不影响任务完成事件链**。

**`backend-ts/src/memory/memory-extraction.service.ts` 流程**：

1. 取输入（D8）：`selectLastUserMessage(sessionId)`（现有，`session.repository.ts:417`）+ 新增 `selectLastAssistantMessage(sessionId)`（同文件按同模式新增，取最后一条 role=ASSISTANT 且正文非空的消息）。任一缺失则跳过。随后做短路判断（D11）：USER 消息规范化后不足 20 字直接返回，不调 LLM。
2. 构造抽取 prompt，系统指令要点：
   - 只提取"明确的长期事实/偏好"（用户偏好、项目事实），猜测、闲聊、一次性任务细节一律不抽；
   - 为每条标注 `type`：`user`（用户个人偏好）或 `project`（关于当前项目/仓库的事实）；
   - 输出 JSON 数组 `[{"type":"user|project","content":"..."}]`，每条 ≤120 字，最多 3 条；没有值得记的输出 `[]`；
   - content 保持用户原话的语言。
3. 模型解析（D10）：读 `settings` 域 `memory.extractionModelId`，为空回落系统默认模型（同 `session-title.service.ts:109` 的回落链）；调用经 LlmAdapter，超时 30 秒。
4. 结果处理，任一发生则整体静默放弃并记日志计数：非法 JSON、输出为空数组（正常无事发生）、条目数 >3。单条 content 为空或规范化后 >120 字时仅丢弃该条，不影响其他条目。
5. 落库（逐条）：
   - `type=project` 但当前会话无有效 projectKey（为空或机器人渠道特殊值）时，降级为 USER 级存储；
   - 计算 `dedup_hash`，按 `uk_memory_dedup` 判重：
     - 未命中 → INSERT（`source='AUTO'`，`origin_session_id=sessionId`）；并发插入撞唯一键时转为下述更新分支；
     - 命中且现有行 `status='ACTIVE'` → 仅 UPDATE `updated_at`（视为"再次确认"，利于排序）；
     - 命中且现有行 `status='DISMISSED'` → 跳过，不更新不复活（D3）；
   - 写入前检查该用户 ACTIVE 总量 ≥200（D7）则放弃并记日志计数。
6. 同会话并发串行：MemoryExtractionService 内按 sessionId 做进程内互斥（Map<sessionId, Promise> 链），避免同会话并发任务重复抽取。

### 5.7 对既有代码的改动边界

- `agent_experiences` / "最佳实践经验"链路：**零改动**（提案非目标）。
- `prompt-engine.ts` / `harness-service.ts` / `agent-execution-context.ts`：仅按 5.2 追加，不改既有段落行为。
- `task-terminal.service.ts`：仅追加一个满足 5.6 条件后的异步派发调用与一个注入的 executor 参数，不改既有事件顺序。
- 工具注册表 / `tool-result-summarizer.ts` / `toolDisplay.ts`：本期不动（P3 不做）。

## 6. 实施步骤

P1、P2 为两个可独立上线的里程碑，按序交付。

**P1：记忆存储 + 注入 + 手工管理（先让用户能攒记忆、Agent 能用上）**

1. V129 迁移（memory_item、user_memory_preference、`memory:read` 权限码）。
2. memory 域骨架：repository / service / routes（列表、增删改、DISMISS、开关、项目下拉），注册路由。
3. 注入链：AgentExecutionContext.memories、harness-service buildContext 查询与降级、prompt-engine 注入段落。
4. admin 只读审计 API + MemoryAuditView + 路由权限。
5. desktop MemoryView + settings 入口 + api 封装。
6. 测试补齐（见第 8 节 P1 部分）+ CHANGELOG/文档同步。
7. 部署验证：Flyway 执行、注入段落在真实会话可见、三端设置页可用。

**P2：任务收尾自动抽取**

1. V130 迁移（`memory.extractionModelId` 预置行）。
2. `selectLastAssistantMessage` repo 方法。
3. MemoryExtractionService（prompt、模型回落、解析护栏、去重、DISMISSED 跳过、限额、同会话串行）。
4. task-terminal 挂点接入（条件过滤 + executor 注入）。
5. admin SystemSettingsView 的 `MODEL_SELECT_KEYS` 加入 `memory.extractionModelId`。
6. 测试补齐（见第 8 节 P2 部分）+ CHANGELOG/文档同步。
7. 部署验证：完成任务后记忆落库、重复任务命中去重、关闭开关后不再抽取。

排期约束：与提案五（任务收件箱）错开实施——两者都动 `task-terminal.service.ts` 收敛点，避免并行改同一段代码。

## 7. 落地清单

### 7.1 后端（backend-ts）

| 文件 | 动作 | 内容 |
|---|---|---|
| `db/migration/V129__memory_item.sql` | 新增 | memory_item、user_memory_preference、memory:read 权限码 |
| `db/migration/V130__memory_extraction_model_setting.sql` | 新增 | memory.extractionModelId 预置行 |
| `src/memory/types.ts` | 新增 | MemoryHint、DTO、常量（限额数值、scope/status/source 枚举） |
| `src/memory/memory.repository.ts` | 新增 | MySQL 实现（含 selectLast 复用不涉及；分页/判重/计数） |
| `src/memory/memory.service.ts` | 新增 | 校验、去重哈希、限额、开关读写 |
| `src/memory/memory-extraction.service.ts` | 新增（P2） | 抽取全流程 + 同会话互斥 |
| `src/memory/memory.routes.ts` | 新增 | 5.3 全部端点 |
| `src/memory/*.spec.ts` | 新增 | 第 8 节用例 |
| `src/session/session.repository.ts` | 修改 | 新增 `selectLastAssistantMessage()` |
| `src/session/task-terminal.service.ts` | 修改 | COMPLETED 主会话派发抽取 + memoryExecutor 注入 |
| `src/harness/core/agent-execution-context.ts` | 修改 | `memories` 字段 |
| `src/harness/core/harness-service.ts` | 修改 | buildContext 查询记忆 + 降级 |
| `src/harness/core/prompt-engine.ts` | 修改 | `## 长期记忆` 段落 |
| `src/settings/settings.service.ts` | 修改 | 新增 `MEMORY_EXTRACTION_MODEL_ID_KEY` 常量与 modelId 校验 |
| `src/admin/admin.routes.ts` | 修改 | 只读审计端点 |
| `src/create-app.ts` | 修改 | 装配 memory 域依赖与路由 |

### 7.2 管理后台（admin）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/views/memory/MemoryAuditView.vue` | 新增 | 只读审计页（含用途提示） |
| `src/router/index.ts` | 修改 | 新路由 + `meta.permission: 'memory:read'` |
| `src/views/settings/SystemSettingsView.vue` | 修改（P2） | `MODEL_SELECT_KEYS` 加入 `memory.extractionModelId` |

### 7.3 前端（desktop，三端共用）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/views/settings/MemoryView.vue` | 新增 | 我的记忆页（5.5） |
| `src/router/index.ts` | 修改 | settings children 新增 `/settings/memory` |
| `src/views/settings/SettingsView.vue` | 修改 | 左侧导航入口 |
| `src/api/index.ts` | 修改 | 记忆接口封装 |

### 7.4 文档与流程同步（随对应里程碑同任务完成）

- 根 `CHANGELOG.md`：P1、P2 上线前各写入顶部发版说明（前端（桌面 / Web / 安卓）与后端小节）。
- `README.md`：功能介绍补充"长期记忆"能力与用户入口。
- `skills/mao-cli/SKILL.md`：补"我的记忆"使用问答与 `/api/v1/memory` 端点说明。
- `docs/proposals/2026-10-02-long-term-memory.md`：状态行更新为"已转入实施，技术方案见本文档"。
- `docs/proposals/README.md`：记忆条目补充技术方案链接。

## 8. 测试要点

**P1**

- prompt-engine spec：注入顺序（最佳实践经验之后）、USER 8 条 / PROJECT 12 条截断、空列表不产生段落、冲突声明文案存在、projectKey 为 null 时仅注入 USER 级。
- harness-service spec：记忆查询抛异常时会话正常启动（memories=null）。
- memory.routes spec：跨用户操作 404、`Result` 错误码、分页、500 字上限、PROJECT 级缺 projectKey 报错、200 条上限报错、DISMISS ↔ ACTIVE 双向切换、PATCH 编辑后 dedup_hash 重算与冲突报错、编辑 DISMISSED 条目 status 保持不变（D12）、settings 开关默认 true。
- repository spec：dedup 唯一约束、规范化空白后哈希一致。

**P2**

- task-terminal spec：COMPLETED 主会话触发且仅触发一次、FAILED/CANCELLED 不触发、SUBAGENT/SIDE_TASK 不触发、抽取异常不影响 finishExecution 既有事件链（用注入同步 executor 断言）。
- MemoryExtractionService spec：最后一轮 USER 消息不足 20 字短路不调 LLM（D11）、LLM 返回非法 JSON 放弃、空数组无事发生、超 3 条整体放弃、单条超 120 字仅丢弃该条、命中 ACTIVE 去重仅更新 updated_at、命中 DISMISSED 跳过不复活、开关关闭不调 LLM、200 条上限放弃、project 消息无有效 projectKey 降级 USER、同会话并发串行、抽取模型留空回落默认模型。

**E2E（根目录 Playwright，desktop.spec.ts 追加）**

- 桌面设置页进入"我的记忆"：新增一条用户级记忆、列表可见、删除成功；自动收集开关切换状态保持。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 记忆污染：错误事实被固化后反复注入 | 来源与 origin_session_id 可追溯；注入条数上限兜底；DISMISS 一步达成且永不复活（D3）；抽取 prompt 强调"只抽明确事实" |
| projectKey 同名碰撞：同用户两个同名目录的不同项目串记忆 | 概率低；注入文案声明"与用户当前消息冲突时以当前消息为准"；规模上来后评估引入 git slug 加固 |
| 抽取成本：每次完成任务多一次 LLM 调用 | 输入仅最后一轮（成本固定）；异步执行不阻塞；专用轻量模型配置项；超时 30 秒放弃 |
| 去重质量：精确哈希挡不住同义改写 | 一期接受该粗糙度；条数上限 + 注入截断兜底；`updated_at` 再确认排序让高频事实稳定占据注入名额 |
| 隐私 | 记忆对用户全可见可删可忽略可关停；admin 仅只读且页面明示审计用途；projectKey 不含本机敏感路径片段 |
| 与任务收件箱提案的合并冲突 | 排期错开（第 6 节约束）；收件箱为 `finishExecution` 新增的 `notifySource` 参数与本方案的抽取派发追加互不干扰 |
| 蓝绿发布窗口双实例并存（restart.sh 9080↔9081 交替），进程内同会话互斥跨实例失效，同会话可能各抽一次 | dedup 唯一键兜底不产生重复行，最多多花一次 LLM 调用，可接受 |

## 10. 明确不做清单

1. **`memory_save` 工具化（提案 P3）**：不做。隐式抽取已覆盖主要价值，工具化需同步动 tool-registry、tool-result-summarizer、toolDisplay 三处并补全套回归，收益边际小；待自动抽取效果验证后另立提案评估。
2. **embedding / 向量检索**：不做，一期用规范化去重 + 条数截断。
3. **FAILED / CANCELLED 任务的教训沉淀**：不做，仅 COMPLETED。
4. **跨用户 / 组织级记忆共享**：不做，记忆永远个人归属。
5. **自动遗忘 / 过期衰减**：不做，仅用户手动删除与忽略。
6. **按 Agent / 按会话粒度的收集开关**：不做，仅全局开关。
7. **会话内记忆 UI**（聊天界面提示"已记住"等）：不做，入口收敛在设置页。
8. **改 `agent_experiences`（管理员手工经验）的结构与交互**：不做，维持现状，与本方案互补。
9. **记忆导出 / 批量操作**：不做，行内单条操作即可。
10. **mao-agent（agent-cli）侧任何改动**：不需要——注入在服务端完成，agent-cli 经后端运行自然受益。
