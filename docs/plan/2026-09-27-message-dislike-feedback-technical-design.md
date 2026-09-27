# 任务执行结果消息「点踩反馈」技术方案

- 日期：2026-09-27
- 状态：已与需求方达成共识，待实施
- 涉及端：backend-ts（后端）、desktop（桌面 / Web / 安卓共用 UI）、admin（管理后台）
- 不涉及：android 原生壳、agent-cli、Electron 主进程

---

## 1. 需求背景

用户在使用 Agent 执行任务后，如果执行结果不符合期望（结果错误、处理速度慢、问题未解决），目前没有任何反馈渠道，运营/管理侧无法感知 Agent 执行质量，只能事后通过人工翻会话发现。本需求在任务执行结果消息上提供「点踩」入口，把不满信号沉淀为结构化数据，并在管理后台提供记录查看与统计能力，形成质量反馈闭环。

## 2. 需求描述

### 2.1 要做的

1. 桌面端（Electron / Web / 安卓三端共用 desktop UI）：
   - 在 assistant 文本消息底部的消息操作栏（`message-footer`，与复制按钮同一行、复制按钮左侧）增加「大拇指朝下」点踩按钮。
   - 显示时机与复制按钮完全一致：assistant 消息、有文本内容、非流式执行中（`!isAssistantRunning`）、非编辑态。历史轮次的消息一直保留点踩按钮，会话出现新轮次后不消失。
   - 点击后弹出轻量 popover，提供 4 个固定原因单选：结果错误 / 处理速度慢 / 问题未解决 / 其他。
   - 选中原因即提交，popover 自动关闭，按钮变为高亮态（已点踩）。
   - 已点踩的消息再次点击按钮：popover 中当前原因处于选中态，支持「取消点踩」操作，取消后恢复默认态。
   - 每条消息最多 1 条点踩记录，可反复切换/取消，最终态唯一。
   - 覆盖聊天场景：主聊天面板（ChatPanel）与边路任务对话（SideChatPanel）；SubagentChatPanel（查看后台子代理对话）不显示点踩按钮。
   - 生成/复现的消息（分支轮次等历史消息重新加载）需正确回显已点踩状态。

2. 后端（backend-ts）：
   - 新增 `feedback` 领域，提供提交点踩、取消点踩接口；提交时校验消息存在、属于当前登录用户本人的会话、角色为 ASSISTANT。
   - 每条消息唯一一条点踩记录（数据库唯一键兜底，重复提交为覆盖更新原因）。
   - 新增管理后台接口：点踩汇总统计（总数、按原因分布、按时间趋势）与分页明细列表（含消息内容摘要、用户、会话、Agent、原因、时间），支持按原因、时间范围筛选。
   - 新增权限点 `feedback:read`（查看点踩反馈），通过 Flyway 迁移写入权限目录并默认授予系统管理员（role_id=1）。
   - 提交/取消点踩仅需登录态，不新增用户侧权限点；后端校验「消息所属会话的 user_id == 当前用户」，防止越权给他人消息点踩。

3. 管理后台（admin）：
   - 新增顶级菜单「点踩反馈」，菜单项受 `feedback:read` 权限控制，无该权限的管理员不可见、接口不可调。
   - 页面结构：顶部汇总卡片（点踩总数、原因分布）+ 明细表格（时间、用户、会话 ID、Agent、原因、消息内容摘要），支持按原因和时间范围筛选，分页默认第一页。

### 2.2 明确不做的

| 不做项 | 说明 |
| --- | --- |
| 点赞（大拇指朝上）按钮 | 本期只有点踩，无正向反馈；后续如需单独立项 |
| 点踩原因备注 / 自由文本输入 | 只有 4 个固定原因单选，不提供任何文本输入 |
| 点踩率指标 | 不计算任何比率（会话级或消息级），汇总只展示绝对数量与分布 |
| SubagentChatPanel 点踩入口 | 查看后台子代理对话的面板不显示按钮 |
| 后台子代理 / 边路之外的入口 | 不做工具调用卡片、思考块上的点踩 |
| 明细弹窗看完整上下文 | 明细列表直接内嵌消息摘要，不做抽屉/弹窗详情 |
| 导出报表 / 定时推送 | 不做 CSV 导出、不做飞书/钉钉推送 |
| 多次点踩累计计数 | 一条消息仅保留最终一条点踩记录 |
| 触达 Agent 侧 | 点踩数据不进入 PromptEngine / AgentLoop，不影响执行 |

## 3. 技术选型

沿用项目现有架构，不引入新框架、新依赖：

- 后端：NestJS + Fastify，领域目录 `backend-ts/src/feedback/`（`feedback.routes.ts` / `feedback.service.ts` / `feedback.repository.ts` / `feedback.spec.ts`），遵循 `Result<T>`（code=0）响应约定；权限校验复用 `requireRequestPermission`。
- 数据库：MySQL8 + Flyway 迁移，新增 `backend-ts/db/migration/V123__message_feedback.sql`（当前最新为 V122，落地时以实际最新版本号顺延）。
- 权限：沿用 `permission` / `role_permission` 表模型，参照 `V121__admin_permission_catalog.sql` 的写法插入 `feedback:read` 并授予 ADMIN 角色。
- 桌面端：Vue3 `<script setup>` + Element Plus，弹层用 `el-popover`，图标用 `@element-plus/icons-vue` 现有点踩语义图标（若无合适图标则用内联 SVG，与现有 `edit-btn`/`copy-btn` 样式规格保持一致）；状态经 Pinia store，请求走现有 API client。
- 管理后台：Vue3 + Element Plus，路由注册于 `admin/src/router/index.ts`，视图放 `admin/src/views/feedback/`；接口权限控制方式与现有 admin 视图一致。
- 安卓：无原生改动，随 desktop UI 自动生效（远程加载 Web）。

## 4. 数据模型

新增表 `message_feedback`（列名 snake_case，BIGINT 自增，created_at/updated_at）：

```sql
CREATE TABLE IF NOT EXISTS `message_feedback` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `message_id`  BIGINT NOT NULL COMMENT '被点踩的 assistant 消息 ID',
    `session_id`  BIGINT NOT NULL COMMENT '冗余会话 ID，便于统计',
    `user_id`     BIGINT NOT NULL COMMENT '点踩用户（消息所属会话的用户）',
    `agent_id`    BIGINT COMMENT '冗余会话使用的 Agent，便于统计，可为空',
    `reason`      VARCHAR(32) NOT NULL COMMENT 'WRONG_RESULT / SLOW_RESPONSE / NOT_SOLVED / OTHER',
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_message` (`message_id`),
    INDEX `idx_created` (`created_at`),
    INDEX `idx_reason` (`reason`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

要点：
- `reason` 使用 VARCHAR 存枚举字符串，不新建字典表，前端映射中文文案（结果错误/处理速度慢/问题未解决/其他）。
- `user_id`/`agent_id` 为提交时从 session 冗余写入的快照，统计查询不做多表 JOIN 历史回溯；明细列表展示用户昵称/账号时 JOIN `user` 表实时查询。
- 不在 `message` 表加列，点踩状态由 feedback 表存在性决定，历史数据零迁移。

## 5. API 设计

### 5.1 用户侧（desktop 调用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| PUT | `/api/v1/feedback/messages/:messageId/dislike` | 提交/覆盖点踩，body: `{ "reason": "WRONG_RESULT" }` |
| DELETE | `/api/v1/feedback/messages/:messageId/dislike` | 取消点踩 |
| GET | `/api/v1/feedback/messages/disliked-ids?sessionId=` | 返回当前用户该会话内已点踩的 messageId 列表，用于前端回显 |

- 校验：消息存在、`role=ASSISTANT`、消息所属 session 的 user 等于当前登录用户；`reason` 必须为 4 个枚举值之一。校验失败返回 `Result` 非 0 code 与明确 message。
- 重复 PUT 同一消息：覆盖更新 `reason`（幂等）。
- 会话历史加载时，前端在拉取会话消息后调用一次 `disliked-ids` 批量回显，避免在消息列表接口上做逐条查询。

### 5.2 管理侧（admin 调用，均要求 `feedback:read`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/feedback/admin/summary?startDate=&endDate=` | 汇总：点踩总数、按原因分布、按日趋势数组 |
| GET | `/api/v1/feedback/admin/list?reason=&startDate=&endDate=&page=&pageSize=` | 分页明细：时间、用户昵称/账号、sessionId、agentId/名称、原因、消息内容摘要（取 content 前 100 字符，去除 markdown 符号，后端截断） |

- 与现有 statistics/admin 路由一致，走 `requireRequestPermission(deps.permissionService, req, 'feedback:read')`。
- 内容摘要后端做净化（剥离内部标记语法 `${skill}$`、`#{cmd}#`、`@{file}@`）后截断，防止把内部语法和超长文本透给后台。

## 6. 实现步骤

### 6.1 后端

1. 新建迁移 `V123__message_feedback.sql`：建表 + 权限点 `feedback:read`（名称「查看点踩反馈」，INSERT WHERE NOT EXISTS 防重）+ INSERT IGNORE 授予 role_id=1。
2. 新建 `backend-ts/src/feedback/`：
   - `feedback.repository.ts`：upsert（ON DUPLICATE KEY UPDATE reason）、delete by (message_id)、exists 列表查询、summary 聚合（GROUP BY reason / DATE(created_at)）、分页明细（JOIN message/session/user/agent）。
   - `feedback.service.ts`：参数与权限语义校验（消息归属、角色、reason 枚举）、写库、汇总/明细查询。
   - `feedback.routes.ts`：注册上述 5 个接口到 `/api/v1/feedback/**`，模块在 `app.module.ts` 挂载。
   - `feedback.spec.ts`（Vitest）：提交/覆盖/取消/越权拒绝/非法 reason 拒绝/管理端聚合与明细。
3. 审计：提交与取消走现有 Audit 拦截器，无需额外处理（`/v1/**` 自动纳入）。

### 6.2 桌面端

1. API client：新增 `submitDislike(messageId, reason)`、`removeDislike(messageId)`、`fetchDislikedIds(sessionId)`。
2. 状态：会话 store（或新建轻量 composable `useMessageFeedback`）按 sessionId 维护 `Set<dislikedMessageId>`；会话消息加载完成时拉取一次 disliked-ids。
3. `MessageBubble.vue`：
   - `message-footer` 中、复制按钮之前增加点踩按钮；显示条件复用现有 footer 的显示链（`message.content && showCopy && !isAssistantRunning && !isEditing` 且 `role === 'assistant'`）。
   - 点击展开 `el-popover`：4 个原因 radio 列表；点击原因即提交并关闭；已点踩状态popover 顶部显示「取消点踩」文字按钮。
   - 样式：与 `copy-btn` 同规格（尺寸、间距、hover 变色），点踩后图标变为主题色/警示色高亮。
   - 通过现有 props/emit 链路传递（若 ChatPanel 与 SideChatPanel 都直接渲染 MessageBubble，则各自接入同一 composable，SubagentChatPanel 不接入，天然不显示）。
4. 类型：`ChatMessage` 相关类型与 API 返回类型补充，保持严格 TS，`vue-tsc` 通过。

### 6.3 管理后台

1. `admin/src/router/index.ts`：新增顶级路由「点踩反馈」（icon + 权限标识 `feedback:read`），复用现有菜单权限渲染机制。
2. 新建 `admin/src/views/feedback/FeedbackIndex.vue`：
   - 顶部统计卡片：点踩总数、原因分布（4 个原因各一张小卡或进度条）。
   - 明细表格列：时间、用户、会话 ID、Agent、原因（Tag 展示中文文案）、消息内容摘要；顶部筛选：原因下拉、日期范围；分页组件，默认第一页。
3. admin API client 增加对应两个接口封装。

### 6.4 文档与 CHANGELOG（同任务完成）

1. 根 `CHANGELOG.md` 顶部新增版本小节，记录：新增任务结果消息点踩、管理后台点踩反馈页、新权限点 `feedback:read`。
2. `README.md`（或功能说明章节）补充点踩功能说明；`skills/mao-cli/SKILL.md` 如有 admin 接口清单章节则同步补充 `/api/v1/feedback/admin/*`。
3. 本方案文档落在 `docs/plan/2026-09-27-message-dislike-feedback-technical-design.md`。

## 7. 落地清单

| # | 交付物 | 位置 | 端 |
| --- | --- | --- | --- |
| 1 | 建表 + 权限迁移 | `backend-ts/db/migration/V123__message_feedback.sql` | 后端 |
| 2 | feedback 领域（routes/service/repository/spec） | `backend-ts/src/feedback/` | 后端 |
| 3 | 模块挂载 | `backend-ts/src/app.module.ts` | 后端 |
| 4 | 点踩/取消/回显 API client | `desktop/src/api/`（现有 client 目录结构内） | 桌面 |
| 5 | 点踩状态 composable | `desktop/src/composables/useMessageFeedback.ts` | 桌面 |
| 6 | 点踩按钮 + popover | `desktop/src/components/chat/MessageBubble.vue` | 桌面 |
| 7 | 边路会话接入（同一组件自动生效，验证 SideChatPanel） | `desktop/src/components/chat/SideChatPanel.vue` | 桌面 |
| 8 | SubagentChatPanel 不接入的验证 | `desktop/src/components/chat/SubagentChatPanel.vue`（只验证不改） | 桌面 |
| 9 | 路由与菜单 | `admin/src/router/index.ts` | 后台 |
| 10 | 点踩反馈页面 | `admin/src/views/feedback/FeedbackIndex.vue` | 后台 |
| 11 | CHANGELOG + 文档同步 | `CHANGELOG.md`、`README.md`、`skills/mao-cli/SKILL.md` | 全局 |

## 8. 验证方案

1. 后端：`cd backend-ts && npm test > /tmp/feedback-test.log 2>&1`，确认新增 `feedback.spec.ts` 全部通过且无存量用例回归；`npm run build` 通过。
2. 桌面：`cd desktop && vue-tsc`（随 build）通过；本地起 dev server 手动验证：提交点踩 → 高亮 → 切换原因 → 取消 → 刷新会话回显；边路会话同样可点；SubagentChatPanel 无按钮。
3. 管理后台：Playwright 冒烟（如纳入 e2e，使用 `login()` admin/admin123，断言菜单可见、汇总卡片与明细行渲染）；权限验证：用 USER 角色账号确认菜单不可见且接口 403。
4. 迁移：本地 e2e 库（`bash scripts/e2e-setup.sh` 流程）执行迁移成功，确认权限点与角色授予生效。
5. 安卓：确认 Capacitor 远程加载模式下按钮与 popover 可正常交互（远程 Web 无需原生改动，抽查即可）。

## 9. 风险与边界

- 消息被删除（会话级联删除）后 feedback 记录残留：本期不做级联清理，明细查询 JOIN message 取不到内容时摘要显示「（消息已不存在）」；如需清理另立需求。
- 已点踩消息所在的会话被归档不影响回显（feedback 按 message_id 关联，与会话状态无关）。
- `feedback:read` 仅默认授予系统管理员，其他管理员角色如需查看，由超管在「角色管理」中手动勾选，本期不做自动授权扩散。
