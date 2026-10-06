# 会话分享与导出技术方案：只读快照链接 + Markdown 导出

- 状态：技术方案，待实施
- 日期：2026-10-06
- 评审修订：2026-10-06（载荷层剥离 thinking；编辑重发语义修正；属主停用入校验链；创建并发幂等兜底；计数/水位/错误码/413 口径对齐代码现状）
- 提案来源：[docs/proposals/2026-10-06-session-share-export.md](../proposals/2026-10-06-session-share-export.md)

## 1. 需求背景

1. **没有只读出口**：任务产出（结论、代码变更、排查过程）给同事看只有截图 / 复制粘贴 / 开账号翻列表。渲染链路现成——`GET /v1/sessions/:id/messages`（`getMessagesByRounds` 按轮分页 + `toMessageVO`）与 desktop 的 `mapApiMessagesToChat → MessageBubble / ToolCallCard` 全链复用即可，缺的是一条带权限的只读路由。
2. **没有结构化导出**：现有导出仅 admin 的 LLM 调用 CSV 与 Agent Bundle。admin 全量消息端点（`admin-session.routes.ts` L134-157）已验证"导出走完整载荷（不 compact）+ roundLimit 50 逐页拼接"的拉取模式（`SessionDetailView.vue` L268-283），Markdown 导出有现成先例。
3. **审计口子**：HTTP 审计拦截器 `AUDITED_PREFIXES` 不含 `/v1/sessions` 用户路由——分享的创建 / 访问 / 撤销必须走 service 级审计（`auditService.record`，云终端 / SSO / outbound 已有三处装配层先例）。

## 2. 需求描述

### 2.1 目标（全部要做）

1. **只读快照链接**：会话属主生成分享链接（`/share/:token`），实例内登录用户可打开只读视图；快照 = 创建时刻的**消息水位**（弱冻结语义，见 §5.2 与决策 1），属主可刷新水位、可撤销。
2. **Markdown 导出**：属主把会话（含边路任务）导出为 .md（任务目标 / 最终结论 / 关键步骤 / 文件变更清单）。
3. **治理**：service 级审计（创建 / 访问 / 撤销）；访问计数；P3 可选带过期时间的匿名 token 链接（默认关闭）。

### 2.2 非目标（明确不做）

- 不做评论 / 协同编辑 / 分享页内的任何交互操作。
- 不做运行回放器。
- 不做飞书 / 钉钉消息附分享链接（P3 收窄为匿名 token 链接，见决策 7）。
- 不做导出格式除 Markdown 之外的（PDF / HTML）。
- 不做“仅结论”极简导出模板（提案开放问题收口：先不做，有使用反馈再议）。
- 不做 admin 端的分享管理页（审计日志已覆盖可见性）。

## 3. 范围界定：做 / 不做清单

### 3.1 做什么

| 层 | 内容 |
|---|---|
| backend-ts | V139（`session_share` 表）；`/v1/sessions/:id/share` POST/GET/PUT/DELETE（属主管理）；`/v1/share/:token` 只读视图载荷（登录用户，水位截断 + 分页）；`getMessagesByRounds` 增 `maxMessageId` 过滤；`/v1/sessions/:id/export/markdown`（属主，服务端模板渲染）；service 级审计 objectType `session.share` |
| desktop | 顶层路由 `/share/:token`（需登录，守卫重定向回跳）+ `ShareView.vue` 只读渲染；`TaskContextMenu.vue` 加"分享 / 导出 Markdown"入口 + `TaskIndexPanel` handler + 分享对话框 |
| admin / 安卓 / mao-agent | 无改动（安卓 WebView 远程加载 Web，自动获得分享页） |
| 文档 | CHANGELOG；skills/mao-cli 会话章节；README 核心能力表"协作"行补一句 |

### 3.2 不做什么（与"做"同等明确）

- 不新增 Playwright 用例（分享页渲染依赖登录态，手测 + Vitest 覆盖后端）。
- 不复制消息内容做物理快照（弱冻结，决策 1）。
- 分享视图不提供 diff 正文查看（文件变更只出路径 / 行数 summary，diff 查看留在会话内，决策 4）。
- 不暴露系统提示词、模型配置、Agent 配置。

## 4. 技术选型

零新增依赖。token 用 `node:crypto` 32 字节随机 hex（64 字符，URL 安全）；Markdown 为服务端字符串模板；只读渲染完全复用 desktop 既有消息映射与气泡组件。

## 5. 详细设计

### 5.1 V139 迁移

```sql
CREATE TABLE IF NOT EXISTS `session_share` (
    `id`               BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id`       BIGINT      NOT NULL,
    `share_token`      CHAR(64)    NOT NULL COMMENT '32 字节随机 hex',
    `message_watermark` BIGINT     NOT NULL DEFAULT 0 COMMENT '创建时的最大消息 id（水位）',
    `created_by`       BIGINT      NOT NULL,
    `view_count`       INT         NOT NULL DEFAULT 0,
    `last_viewed_at`   DATETIME    NULL,
    `expires_at`       DATETIME    NULL COMMENT 'P3 匿名 token 链接过期时间；登录链接恒为 NULL',
    `revoked_at`       DATETIME    NULL,
    `created_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_share_token` (`share_token`),
    KEY `idx_share_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='会话只读分享';
```

- `expires_at` 列随首版建表（避免 P3 二次迁移），登录态链接恒为 NULL。
- 编号说明：V139 为本轮并行方案的顺延占位（usage-cost V135/V136、approval-rules V135、context-inspector V138，见 proposals/README 排期注意）；实施时以当时实际空闲编号为准。

### 5.2 快照语义：水位 + 存活性过滤（弱冻结）

- 水位：创建（或刷新）时刻该会话的最大 `message.id`（在 `deleted = 0` 范围内取，空会话取 0）；读取范围 = `id ≤ watermark AND deleted = 0`。
- **不复制消息体**。语义后果（文档与分享对话框均明示）：
  - 属主此后新增消息 → 不出现在分享视图（水位截断）；
  - 属主编辑重发（`editMessageAndTruncate`，session.service.ts:1019：对最后一条 USER 消息**原地更新**内容 + 其后消息逻辑删，并非“旧删新增”）→ 被编辑消息在水位内以**新内容**同步呈现，其后的消息从分享视图消失；
  - 属主撤回单条消息（`deleteMessageById` 逻辑删）→ 对应内容从分享视图消失；属主删除会话 → 链接 404；
  - PUT 刷新水位在编辑重发截断后可能**回落**（`MAX(id) WHERE deleted = 0` 变小）——语义正确（截断产生的旧内容被挡在水位外），实现勿按“只增不减”写死。
- 取舍见决策 1：编辑撤回是属主意愿，分享跟随属主删除是治理上正确的方向；物理快照带来双份存储与一致性问题，不做。

### 5.3 属主管理端点（session 域内，复用 `requireSessionOwner`）

```
POST /v1/sessions/:id/share    创建；已有未撤销分享则原样返回（幂等，一会话一活跃链接）
PUT  /v1/sessions/:id/share    刷新水位至当前最大消息 id
GET  /v1/sessions/:id/share    查询当前分享（token/水位/访问数/创建时间）或 null
DELETE /v1/sessions/:id/share  撤销（置 revoked_at；token 即刻失效）
```

- `share_token = randomBytes(32).toString('hex')`；`message_watermark` 初始值 = `MAX(id) FROM message WHERE session_id = ? AND deleted = 0`（空会话取 0）。
- 幂等的并发兜底：表约束只有 `uk_share_token`，防不住并发 POST 双建活跃分享。创建在事务内对该会话的分享行 `SELECT ... FOR UPDATE`（或插入后按 session_id 复查、冲突则回滚并复用先建者），保证“一会话一活跃链接”在并发下成立。
- 边路任务同样可分享 / 导出（`requireSessionOwner` 不区分 session_type；分享只含边路自身消息，不带父会话上下文，提案开放问题按此收口）。

### 5.4 只读视图端点

```
GET /v1/share/:token?roundLimit=5&beforeMessageId=...
```

- **登录必需**（走全局 preHandler 鉴权，非公开路径）；实例内任意登录用户持有效 token 可读。
- 校验链（任一不满足 → 统一返回 `SHARE_NOT_FOUND` 业务码，不泄露存在性差异；本库业务异常走 HTTP 200 + body.code，照 `OPEN_HOOK_NOT_FOUND`(3040) 不暴露存在性先例，仅未登录是 1001/HTTP 401）：token 存在 → 未撤销 → 未过期（`expires_at` 非空时）→ 会话存在且 `deleted=0` → **属主账号状态正常**（读时判定 `user.status`，提案开放问题“快照 vs 权限”收口见决策 10；不做停用时反扫批量撤销的联动）。
- 返回：
  ```ts
  {
    session: { id, title, agentName, createdAt, sessionType },
    share: { createdAt, viewCount },        // 不回 token 本身
    messages: MessageVO[],                  // ≤ watermark 且 deleted=0，复用 getMessagesByRounds（增 maxMessageId 过滤参数）+ getFileChangeSummariesByMessageIds；thinkingContent 服务端置空
    hasMore, nextBeforeMessageId
  }
  ```
- **载荷最小化**：返回前在服务端将 `messages[].thinkingContent` 置空——`MessageVO` 默认透传 thinking（session-vo.ts:298），前端 `hideThinking` 只是隐藏渲染、devtools 可见，“分享视图不含 thinking”必须在载荷层成立。其余与站内 messages 端点同口径：`toolCalls` 参数与 `metadata` 原样透传（风险节已披露）；多模态 `images` 保留，`/uploads/` 公开 GET 可正常显示。
- `view_count` 递增与 `last_viewed_at` 更新 fire-and-forget，且仅对无 `beforeMessageId` 的首页请求计数（翻页不重复灌水）；审计 `action='READ', objectType='session.share', objectId=token 前 8 位 + shareId`。
- `getMessagesByRounds` 改造：签名增可选 `options.maxMessageId`，下推到 message 查询 `AND id <= ?`；既有调用方不传时行为不变。

### 5.5 desktop 只读页

- **路由**：顶层路由 `/share/:token`（与 `/login` 平级，不套 Layout 侧栏），`meta` 不加 public → 守卫无 token 时跳登录并带 `redirect` 回跳（分享场景登录后回到分享页，符合预期）。
- **`ShareView.vue`**：
  - 顶部条：会话标题 + agentName + "来自 xx 的只读分享"（无操作按钮）；
  - 消息渲染：`mapApiMessagesToChat` + `mapMessagesWithFileChanges` 现有映射 → `MessageBubble`（`canEdit:false, forkEnabled:false, dislikeEnabled:false, hideThinking:true, sessionId:''`）+ `ToolCallCard`；分页加载复用 useChat 的滚动加载模式（或简化为"加载更多"按钮，实施取简）。
  - **文件变更为 summary 列表**（path / change_type / ±行数），不渲染 diff 正文——`FileChangePanel.vue` inject 了 sessionStore / useCenterTabs / workspace provider，只读页不做降级改造，新写一个无依赖的轻量列表（决策 4）。
  - thinking 不展示（§5.4 载荷层已剥离，`hideThinking` 仅作前端兜底）；
  - ToolCallCard 只读复用安全（仅 store 只读查询、inject 均有 noop 默认值），但 delegate 类工具的“查看过程”按钮会静默无效，只读页需隐藏该按钮；
  - 错误态：按 body.code = `SHARE_NOT_FOUND`（HTTP 200 + body.code）判定并展示“链接不存在或已撤销”占位页，勿按 HTTP 状态码判定。
- **入口**：`TaskContextMenu.vue` 加"分享…"与"导出 Markdown"两项（归档区菜单同样生效）；分享对话框：链接展示 + 复制、刷新快照、撤销（撤销需二次确认）、访问计数展示。

### 5.6 Markdown 导出

```
GET /v1/sessions/:id/export/markdown   （requireSessionOwner）
→ Content-Disposition: attachment; filename="<会话标题>-<yyyymmdd>.md"（文件名 sanitize：去路径分隔符与控制字符，非 ASCII 走 filename* RFC 5987）
```

- 渲染模板（服务端 `session-export.service.ts`）：

  ```
  # <会话标题>
  元信息：Agent 名称 / 创建时间 / 导出时间 / 消息轮数
  ## 任务目标        ← 首条 USER 消息全文
  ## 最终结论        ← 最后一条非空 ASSISTANT 消息全文
  ## 关键步骤        ← 按 tool_calls[].summary 逐条列点（≤ 500 条，超出截断并注明）
  ## 文件变更        ← message_file_change 按 path 聚合（路径、CREATED/MODIFIED、±行数合计）
  ```
- **步骤摘要复用持久化产物**：`ToolResultSummarizer.summarize` 的结果在 `agent-loop.ts` L554/L572 已挂到 `tool_calls[].summary` 并随消息落库——导出直接读，不维护第二套工具名/参数映射（决策 6）；summary 为空的旧消息回退后端极简预览（**新写 helper**：后端无现成函数，口径对齐前端 `desktop/src/utils/toolDisplay.ts` 的 `getToolInputPreview`——取 `command`/`path`/`query` 首参，≤ 60 字符）。
- 拉取：`getMessagesByRounds` 全量分页循环（roundLimit 50，照 admin 导出先例）；`thinking_content` 不导出；多模态 content 只导出 text 部分（`toMessageVO` 同款解析）。
- 大小护栏：最终结论与目标全文不截断；步骤数上限 500；单会话导出体 > 5MB 时返回 413 提示改用分享链接——`handleError` 现无 413 分支（全库亦无业务 413 先例），需在 `common/http-error.ts` 增一处错误码→413 映射（如 `EXPORT_TOO_LARGE`）。
- 文件名：复用 `file.routes.ts` 的 `contentDisposition` 工具函数（已处理 attachment 与 RFC 5987 filename*），sanitize 口径与既有下载一致。

## 6. 实施步骤

### P1：只读分享（backend + desktop）

1. V139；share service（创建/刷新/撤销/查询 + 幂等 + 审计）+ `getMessagesByRounds.maxMessageId`。
2. `/v1/share/:token` 视图端点（校验链 + 分页 + 计数）。
3. desktop：路由 + `ShareView.vue` + 上下文菜单入口 + 分享对话框。

### P2：Markdown 导出（backend + desktop）

1. `session-export.service.ts` 模板渲染 + 端点 + 护栏；单测锚定结构。
2. 上下文菜单"导出 Markdown" + 下载（复用 Blob 下载工具）。

### P3：匿名 token 链接（backend + admin）

1. settings `share.tokenLinksEnabled`（默认 false，category=分享）；POST body 增 `publicLink/expiresInDays`（settings 关闭时 400）。
2. `GET /v1/share/public/:token` 加入 `PUBLIC_PREFIXES`（同步静态前缀，照 agent-bundle registry §5.7 先例），开关关闭 404；`expires_at` 判定 + 审计。

## 7. 测试方案（全部 Vitest）

- 分享管理：创建幂等（重复 POST 返回同一 token）、并发创建仅产生一条活跃分享（事务/锁兜底）、刷新水位前进、编辑重发截断后刷新水位回落、撤销后 token 失效、边路任务可分享；越权（他人会话）403。
- 视图：校验链逐环返回同一 `SHARE_NOT_FOUND` 业务码（不存在/已撤销/已过期/会话已删/**属主已停用**——响应不可区分，断言 body.code 而非 HTTP 状态）；水位截断（创建后新消息不出现）；弱冻结语义锚定——撤回的消息消失、**编辑重发后被编辑消息以新内容呈现且其后消息消失**；载荷不含 `thinkingContent`（服务端剥离断言）；仅首页请求递增 view_count、翻页不计数；分页与 `hasMore`；`MessageVO` 形状与站内历史接口一致（thinkingContent 除外）。
- token 熵：`share_token` 64 hex、唯一键冲突重试。
- 导出：模板结构快照（元信息/目标/结论/步骤/变更四节）；`tool_calls[].summary` 复用与空回退；步骤 500 上限；thinking 不出现；多模态只导 text；文件名 sanitize；>5MB 413。
- 审计：CREATE/READ/DELETE 三类 `session.share` 记录落库（service 级，非 HTTP 拦截器）。
- 权限：`/v1/share/:token` 未登录 401；P3 公开端点在 settings 关闭时 404、开启后免登录可达、过期 404。

## 8. 风险与对策

- **敏感信息扩散（最高风险）**：分享视图 = 消息 + 文件变更 summary，不含工作区文件本体、系统提示词、模型/Agent 配置、thinking；工具结果按落库内容展示（密钥类已 `$MAO_REDACTED` 脱敏，与站内同口径，无新增脱敏面）；对话框展示"任何登录用户持链接可读"的明示文案。
- **弱冻结的预期管理**：分享对话框固定文案说明"源会话撤回/删除消息后分享内容同步消失，编辑重发会以新内容呈现并隐藏其后消息"；不做物理快照（决策 1）。
- **属主生命周期**：属主停用后链接随校验链即时失效（读时判定 `user.status`），无需停用联动、无时序缝隙（决策 10）。
- **token 泄露**：64 hex 随机（≥ 256 bit）；审计记录每次访问（token 前缀 + shareId）；撤销即刻生效。
- **导出体量**：步骤上限 + 5MB 护栏 + 全量分页拉取的内存峰值可控（admin 全量导出先例同量级）。
- **`getMessagesByRounds` 改造回归**：新参数可选、默认不传行为不变；既有用户端 / admin 端 / compaction 事件组装的 spec 全量回归。

## 9. 落地清单

- [ ] V139（session_share）
- [ ] share service（创建/刷新/撤销/幂等 + 并发兜底/审计）+ `getMessagesByRounds.maxMessageId`
- [ ] `/v1/share/:token` 视图端点（校验链含属主状态；载荷剥离 thinkingContent；首页计数口径）
- [ ] desktop：`/share/:token` 路由 + ShareView + 菜单入口 + 分享对话框
- [ ] `session-export.service.ts` + `/v1/sessions/:id/export/markdown` + 下载入口
- [ ] P3：token 链接 settings 开关 + 公开端点 + PUBLIC_PREFIXES
- [ ] CHANGELOG + skills/mao-cli + README"协作"行；提案回改（冻结口径改弱冻结、开放问题三项收口——已随本轮评审完成）

## 10. 决策记录（相对提案的修正与确认）

1. **弱冻结（水位 + 存活性过滤）而非物理快照**：不复制消息体。属主增删改同步反映到分享视图——注意 `editMessageAndTruncate` 为原地更新 + 其后逻辑删，故被编辑消息以新内容呈现、其后消息消失（并非编辑的消息本身消失）；编辑撤回是属主意愿，跟随删除是治理上正确的方向；物理快照的双份存储与"撤回仍可读"的治理矛盾成本更高。对话框文案明示语义。
2. **一会话一活跃链接 + POST 幂等**：避免链接 proliferation；"纳入新消息"用显式的刷新水位动作（PUT），语义清晰可审计。
3. **复用 `getMessagesByRounds` 加 `maxMessageId`**：不新建序列化路径，分享载荷与站内历史接口同构（MessageVO + fileChanges summaries），前端映射零新代码。
4. **分享页不渲染 diff 正文**：`FileChangePanel` 深度耦合 sessionStore/useCenterTabs/workspace provider，只读降级改造的成本与风险高于价值；summary 列表 + "在会话中查看"（属主）已覆盖"了解改了什么"的诉求。
5. **thinking 不进分享视图（载荷层剥离，而非仅前端隐藏）**：模型内部推理属过程性内容，对阅读者价值低、误读风险高。`MessageVO` 默认透传 `thinkingContent`（session-vo.ts:298），`hideThinking` 只是前端不渲染、响应体仍可见——share 端点在服务端置空该字段后承诺才成立；导出侧本就不导出 thinking。
6. **导出步骤摘要复用持久化的 `tool_calls[].summary`**：`ToolResultSummarizer` 产物已落库，避免维护第二套工具名/参数预览映射（AGENTS.md 的 toolDisplay 同步约定只覆盖前端展示，导出走后端持久化产物天然一致）。
7. **P3 收窄：去掉"通道消息附分享链接"**：分享链接需登录态，飞书/钉钉点开的用户多数未登录，转化链路断裂；Markdown 导出（P2）对"贴进文档/周报"的通道场景覆盖更好。P3 仅保留匿名 token 链接（默认关闭、带过期、PUBLIC_PREFIXES 先例照搬 registry 方案的 404 不暴露语义）。
8. **service 级审计而非依赖 HTTP 拦截器**：`AUDITED_PREFIXES` 不含 `/v1/sessions`；照云终端/SSO/outbound 装配先例显式记录 CREATE/READ/DELETE，objectId 用 token 前 8 位 + shareId（避免全量 token 进日志）。
9. **边路任务可分享/导出但不含父会话上下文**：提案开放问题收口——父上下文属另一会话的授权域，级联暴露需父会话属主同意机制，先不做。
10. **属主停用 → 链接失效走校验链读时判定**：提案开放问题“快照 vs 权限”收口。视图校验链按 `user.status` 判定，一处查询覆盖所有停用路径，拒绝与其他失效原因不可区分；不做“停用时反扫 session_share 批量撤销”联动（需侵入用户管理链路且存在时序缝隙）。

## 11. 验收口径

1. 会话右键"分享…"生成链接；另一账号登录打开 `/share/:token` 可只读浏览全部消息与文件变更清单，无输入区/操作按钮；属主撤销后原链接 404。
2. 分享后属主继续对话 → 分享视图无新消息；点"刷新快照"后新消息可见；属主撤回某条消息 → 分享视图同步消失；属主编辑重发 → 分享视图中该消息变为新内容、其后消息消失。
3. 分享视图与导出物中不存在系统提示词、thinking（分享接口响应体亦无 `thinkingContent`）、`$MAO_REDACTED` 以外的密钥类内容。
4. 右键"导出 Markdown"得到含任务目标/最终结论/关键步骤/文件变更四节的 .md；边路任务可单独导出。
5. `audit_log` 可查 session.share 的创建/访问/撤销记录；普通用户访问他人分享管理端点 403。
6. 属主账号被停用后，原分享链接不可用且与其他失效原因不可区分；撤销后原链接 404。
7. 全量 `cd backend-ts && npm test` 通过，新增 spec 覆盖 §7 全部用例。
