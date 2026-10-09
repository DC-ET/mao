# 全局消息全文检索（Global Message Search）技术方案

- 日期：2026-10-09
- 提案：`docs/proposals/2026-10-09-global-message-search.md`
- 状态：已与需求方达成共识，待评审后实施

## 1. 共识决策记录

以下 9 项决策经逐条追问确认（另有一项范围决策提问未获答复，按建议项默认采纳并标注待确认）：

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 生产 MySQL 版本 | **确认 8.0+**，ngram FULLTEXT 方案成立 |
| 2 | P1 搜索范围 | **USER + ASSISTANT 消息正文**（⚠️ 提问未答，按建议默认采纳，**待确认**）；thinking_content 独立成列不纳入；TOOL 原文留 P3 开关灰度 |
| 3 | 索引构建方式 | **标准启动迁移**：V142 直接 `ALTER TABLE ADD FULLTEXT`，随发版重启时构建 |
| 4 | 多词语义 | **默认 OR**（布尔模式无操作符即 OR），支持 `+必须 -排除 "短语"`；单字 / 短 ASCII 词 / 停用词自动回退 LIKE |
| 5 | 结果呈现 | **按会话分组折叠**（多命中折叠为"N 条命中"可展开）+ 点击**定位到消息并高亮约 2 秒** |
| 6 | 筛选交互 | **筛选行**（Agent / 时间范围 / 会话类型）；Ctrl/Cmd+K 快捷键**已存在**（TopNav.vue:219），仅补"打开时聚焦输入框" |
| 7 | API 兼容 | **直接升级** `/v1/sessions/search` 响应结构，不保留旧字段过渡 |
| 8 | 里程碑 | **P1+P2 合并为一个迭代交付**；P3（TOOL 范围灰度、片段调优）后续 |
| 9 | 子代理会话 | **暂不纳入**搜索池（SUBAGENT 无独立导航入口，搜到无法跳转） |

### 1.1 对提案的两处修正

- **索引体积风险高估**：提案担心 ngram 索引为原文 30%~100%。本地实测（MySQL 8.0.46）：35MB 高随机正文 → 索引 2.5MB（~7%）；377MB 中等重复正文 → 索引 15MB（~4%）。真实值预计 5%~15%，远低于预期。详见 §7。
- **"可在线执行"不成立**：实测 `ADD FULLTEXT ... LOCK=NONE` 报 ERROR 1846（Fulltext index creation requires a lock），最低只能 `LOCK=SHARED`（阻塞写、不阻塞读）。且 InnoDB 需添加隐藏 `FTS_DOC_ID` 列，触发表重建（数据段 +15%）。对部署的影响见 §6.3。
- 另修正提案中"compact 脱敏消息"的表述：`admin-message-compact.ts` 是**管理端展示层截断**（内存转换，无 DB 写入），存储层无脱敏概念。搜索命中即存储原文，属主可见，符合隐私边界，无额外处理。

## 2. 现状基线（代码事实）

| 环节 | 位置 | 现状 |
|---|---|---|
| 路由 | `backend-ts/src/session/session.routes.ts:203-208` | `GET /v1/sessions/search?keyword=`，无筛选/分页参数 |
| 服务 | `session.service.ts:691-743` `searchSessionsByUserMessage` | 关键词 1~100 字；候选会话 20 条；每会话取首条命中；返回**会话摘要**，无 messageId |
| 候选 SQL | `session.repository.ts:327-349` | `role='USER'` 写死 + `content LIKE '%kw%'`，JOIN session 按 user_id 过滤，session_type IN ('NORMAL','SIDE_TASK') |
| 命中 SQL | `session.repository.ts:609-628` | 同 LIKE，每会话前 5 条 |
| 边路解析 | `session.service.ts:750-784` `resolveSearchRoots` | SIDE_TASK 上溯根主会话（≤10 轮），孤儿剔除——**保留复用** |
| 契约 | `shared/contracts/src/session.ts:5-17` `MessageSearchItem` | 会话摘要结构，唯一消费者 desktop |
| 前端 | `desktop/src/components/search/SessionSearchPopover.vue` | 300ms 防抖 + requestSeq/AbortController 双保险；↑↓/Enter/Esc 键盘；结果项 snippet 大小写不敏感高亮 |
| 快捷键 | `desktop/src/components/common/TopNav.vue:219` | Ctrl/Cmd+K 已注册 toggle 搜索浮窗 |
| 跳转 | `SessionSearchPopover.vue:209-234` | 只到会话 / 边路 Tab，**无消息级定位** |
| 消息定位能力 | `useChatScroll.ts` / `ChatRoundList.vue` | **不存在** scrollToMessage；消息无 DOM 锚点；列表无虚拟化（可安全加锚点） |
| 消息分页 | `session.routes.ts:421-441` + `getMessagesByRounds`（`session.service.ts:984-1020`） | 游标式轮次分页 `roundLimit/beforeMessageId` |
| 管理端搜索 | `listSessions` 关键词分支（`session.service.ts:452-486`）+ `selectFirstMatchingMessages`（`repository.ts:631-649`） | 另一条链路，**本方案不改动** |
| 迁移编号 | `backend-ts/db/migration/` 最大 V141 | 本次为 **V142** |
| Flyway | `create-app.ts:419` 启动时同步执行，失败抛错阻断启动（`flyway.ts:288`）；连接 `multipleStatements: true` | — |
| 消息表 | V001:162-175 | content MEDIUMTEXT；role VARCHAR(20)（USER/ASSISTANT/SYSTEM/TOOL）；无 user_id（归属走 session.user_id）；已有索引 idx_session / idx_created / idx_message_session_deleted_id |
| Agent 列表 | `GET /v1/agents`（`agent.routes.ts:75`） | 筛选器下拉直接复用，无需新接口 |
| 分享机制 | `session_share`（V136） | 只存 share_token + message_watermark，快照**实时生成**，无独立副本——不存在"分享快照落入索引池"问题 |

## 3. 总体设计

```
┌────────────────────────────────────────────────────────────┐
│ Desktop: SessionSearchPopover.vue（改版）                   │
│  筛选行(Agent/时间/类型) + 关键词(布尔操作符) + 分组折叠结果  │
│  点击命中 → router.push(/tasks/:id?locateMessageId=:mid)   │
└──────────────┬─────────────────────────────────────────────┘
               │ GET /v1/sessions/search?keyword&agentId&dateFrom&dateTo&sessionType&page&size
┌──────────────▼─────────────────────────────────────────────┐
│ Backend: session.service.ts searchMessages()（新）          │
│  ① 路径判定：短词/停用词/短ASCII → LIKE 兜底；否则 FULLTEXT  │
│  ② 阶段1 SQL：命中会话聚合(GROUP BY + MAX(MATCH)) + 分页    │
│  ③ 阶段2 SQL：页内会话每会话 Top5（ROW_NUMBER 窗口函数）     │
│  ④ resolveSearchRoots 解析边路根 + batchLoadAgents 补名称   │
└──────────────┬─────────────────────────────────────────────┘
               │ 返回 MessageSearchGroup[]（含 messageId）
┌──────────────▼─────────────────────────────────────────────┐
│ 定位跳转：GET /v1/sessions/:id/messages?aroundMessageId=:mid│
│  → 返回包含命中消息的轮次窗口 → 消息锚点滚动 + 高亮 2s        │
└────────────────────────────────────────────────────────────┘

MySQL: message 表 FULLTEXT INDEX ft_message_content (content) WITH PARSER ngram  (V142)
```

## 4. 数据库迁移（V142）

**文件**：`backend-ts/db/migration/V142__message_content_fulltext.sql`

```sql
-- V142: 消息正文全文索引（ngram 中文分词），支撑全局消息检索。
-- 注意：MySQL 8 FULLTEXT 创建不支持 LOCK=NONE，最低 LOCK=SHARED（阻塞写、不阻塞读），
-- 且需重建表添加隐藏 FTS_DOC_ID 列。启动时执行期间的写入阻塞影响见部署文档。
ALTER TABLE `message`
  ADD FULLTEXT INDEX `ft_message_content` (`content`) WITH PARSER ngram,
  ALGORITHM=INPLACE, LOCK=SHARED;
```

要点：

- **ngram_token_size 用默认 2**（覆盖中文常用词；英文数字按词元切分，`innodb_ft_min_token_size=3` 导致 2 字符英文词不被索引，由 LIKE 兜底覆盖，见 §5.1）。
- 索引对全表所有行生效（含 TOOL/SYSTEM 角色）——**这是 MySQL FULLTEXT 的固有行为，无法只索引部分行**；"只搜近 N 个月"只能查询侧过滤、不降低构建成本，故不采用。角色过滤发生在查询 WHERE 条件。
- 历史行由建索引时一次构建，新写入行 InnoDB 自动维护。
- 回滚预案：默认不回滚索引（DROP INDEX 同样要锁表）；应急时用功能开关把查询切回 LIKE（§6.2）。

## 5. 后端设计

### 5.1 查询路径判定（`session.service.ts`）

在 `searchMessages` 入口对关键词做判定，输出 `path: 'FULLTEXT' | 'LIKE'`（随响应返回，便于线上诊断）：

| 条件 | 路径 |
|---|---|
| 任一词项 UTF-8 字符数 < 2（单中文字符、单符号） | LIKE |
| 任一词项为纯 ASCII 且字符数 < 3（如 `OK`、`go`，不被 InnoDB 索引） | LIKE |
| 未显式写布尔操作符，且所有词项均为 InnoDB 默认停用词（`INFORMATION_SCHEMA.INNODB_FT_DEFAULT_STOPWORD`，启动时拉取缓存） | LIKE |
| 其他 | FULLTEXT |

设计取舍：不采用"全文零结果再重试 LIKE"——那会让每次无命中搜索都付一次全表扫描；路径判定是确定性的，零结果就是零结果。

### 5.2 FULLTEXT 路径 SQL（`session.repository.ts` 新增）

**阶段 1：命中会话聚合 + 分页**（新增 `selectMatchingSessions`）

```sql
SELECT m.session_id AS sessionId,
       COUNT(*) AS hitCount,
       MAX(MATCH(m.content) AGAINST (? IN BOOLEAN MODE)) AS maxScore
FROM message m
JOIN session s ON s.id = m.session_id
WHERE m.deleted = 0
  AND m.role IN ('USER', 'ASSISTANT')
  AND s.user_id = ? AND s.deleted = 0
  AND s.session_type IN ('NORMAL', 'SIDE_TASK')
  AND MATCH(m.content) AGAINST (? IN BOOLEAN MODE)
  /* 可选：AND s.agent_id = ?  AND m.created_at >= ?  AND m.created_at < ?  AND s.session_type = ? */
GROUP BY m.session_id
ORDER BY maxScore DESC, MAX(s.updated_at) DESC
LIMIT ? OFFSET ?
```

配套 count 查询（同 WHERE、`COUNT(DISTINCT m.session_id)`）供分页 total。

**阶段 2：页内会话每会话 Top 5**（新增 `selectHitMessages`，MySQL 8 窗口函数）

```sql
SELECT sessionId, messageId, role, content, createdAt, score FROM (
  SELECT m.session_id AS sessionId, m.id AS messageId, m.role AS role,
         m.content AS content, m.created_at AS createdAt,
         MATCH(m.content) AGAINST (? IN BOOLEAN MODE) AS score,
         ROW_NUMBER() OVER (
           PARTITION BY m.session_id
           ORDER BY MATCH(m.content) AGAINST (? IN BOOLEAN MODE) DESC, m.id DESC
         ) AS rn
  FROM message m
  WHERE m.deleted = 0
    AND m.role IN ('USER', 'ASSISTANT')
    AND m.session_id IN (?, ?, ...)
    AND MATCH(m.content) AGAINST (? IN BOOLEAN MODE)
) t
WHERE t.rn <= 5
ORDER BY t.sessionId, t.score DESC, t.messageId DESC
```

以上两段 SQL 形态已在 MySQL 8.0.46 实测通过（含 `MAX(MATCH(...))` 聚合与窗口函数 ORDER BY 中的 MATCH 表达式）。

**LIKE 兜底路径**：保留现有 `selectMessageSearchCandidates` + `selectMessagesForSearch` 实现与 `escapeLike` 转义，仅把 `role='USER'` 放宽为 `role IN ('USER','ASSISTANT')`，聚合排序改为 `s.updated_at DESC, s.id DESC`（现状口径），阶段 2 复用同一窗口函数 SQL（LIKE 版无 score，按 `m.id DESC` 取每会话 5 条）。

**关键词→布尔串转换**（服务层）：

- 按空白切分为词项；用户已写 `+`/`-`/`"` 的片段原样保留（高级用户意图优先，不判停用词）。
- 普通词项原样拼接（布尔模式无操作符 = OR），不做 `+` 前缀。
- 过滤空片段；词项中的 `@+-()<>~*"` 等布尔保留字符若用户非意图使用会改变语义——在 UI 提示文案中说明，P1 不做转义猜测。

### 5.3 响应契约（`shared/contracts/src/session.ts` 重写）

```ts
/** 单条命中消息 */
export interface MessageSearchHit {
  messageId: number;
  role: string;            // 'USER' | 'ASSISTANT'
  snippet: string;         // 关键词居中截断（前后各约 80 字），高亮由前端按词项切分
  createdAt: string | null;
}

/** 按会话分组的搜索结果 */
export interface MessageSearchGroup {
  sessionId: number;
  title?: string | null;
  sessionType?: string | null;        // 'NORMAL' | 'SIDE_TASK'
  parentSessionId?: number | null;
  rootSessionId?: number | null;      // 边路会话的根主会话 id；主会话即自身 id
  updatedAt?: string | null;
  phase?: string | null;
  status?: string | null;
  agentId?: number | null;
  agentName?: string | null;
  hitCount: number;                   // 该会话总命中消息数
  hits: MessageSearchHit[];           // 每会话最多 5 条
}

export interface MessageSearchResult {
  items: MessageSearchGroup[];
  total: number;                      // 命中会话总数
  page: number;
  size: number;
  path: 'FULLTEXT' | 'LIKE';          // 实际查询路径（诊断用）
}
```

- 路由参数扩展：`agentId?`、`dateFrom?`（含当日）、`dateTo?`（含当日，SQL 用 `< dateTo+1day`）、`sessionType?`（`NORMAL`|`SIDE_TASK`）、`page`（默认 1）、`size`（默认 20，上限 50）。
- `MessageSearchItem` 旧类型删除（决策 7：直接升级，无过渡）。`desktop/src/types/chat.ts:157-158` 的别名同步更新。

### 5.4 snippet 生成

- 复用 `extractVisibleText`（`session.service.ts:786-821`，多模态 JSON 只取 text 段）抽取纯文本。
- 在现有 `buildSnippet`（:1303-1316）基础上把上下文从 25 字扩到 **前后各约 80 字**：定位**首个**关键词出现处居中截断，总长约 200 字封顶；LIKE 路径以原始关键词定位，FULLTEXT 路径按切分后的任一词项定位。
- 多词项高亮由前端完成（现有大小写不敏感区间切分逻辑扩展为多词项并集），后端不做 `<mark>` 注入。

### 5.5 命中定位：`aroundMessageId`（`getMessagesByRounds` 扩展）

消息列表是游标式轮次分页，命中消息可能不在首屏窗口内。给现有能力加一个可选参数，**服务端直接返回包含命中消息的轮次窗口**，避免前端反复翻页：

- 路由 `GET /v1/sessions/:id/messages` 增加 `aroundMessageId?`（`session.routes.ts:421-441`）。
- 服务（`session.service.ts:984-1020`）options 增加 `aroundMessageId`：
  1. `findById` 校验消息存在且 `sessionId` 匹配，否则 `PARAM_INVALID`；
  2. 求命中所在轮次起点：`SELECT MAX(id) FROM message WHERE session_id=? AND role='USER' AND deleted=0 AND id <= ?`（新增仓库方法 `selectRoundStartForMessage`）；
  3. 以 `beforeId = roundStartId + 1` 复用现有 `selectUserStarts(sessionId, beforeId, limit+1)` + `selectRange(...)`，返回以命中轮次为**最后一轮**的窗口（默认仍 5 轮，可调）；
  4. `hasMore/nextBeforeMessageId` 语义不变，前端可继续向上翻页。
- 该参数为纯增量，不影响现有分页行为与单测。

## 6. 前端设计（desktop）

### 6.1 搜索面板改版（`components/search/SessionSearchPopover.vue`）

- **筛选行**（关键词框下方，常驻）：
  - Agent 下拉：`GET /v1/agents` 复用，选项 `{ id, name }`；
  - 时间范围：`el-date-picker` daterange → `dateFrom/dateTo`；
  - 会话类型：分段控件（全部 / 主会话 / 边路）。
  - 筛选变化即触发重新搜索（与关键词同等防抖 300ms）。
- **结果分组**：每组头部 = 标题 + 已归档/边路标签 + Agent 名 + 相对时间 + "N 条命中"；默认折叠展示前 2 条命中 snippet，点击组头或"展开"显示全部（≤5）；snippet 多词项高亮（复用现有区间切分，扩展为多词）。
- **键盘**：↑↓ 在**展开后的命中项**间移动，Enter 跳转，Esc 关闭（现有逻辑适配分组结构）。
- **状态机/竞态**：保留现有 idle/loading/empty/error/results + requestSeq + AbortController。
- 打开时聚焦输入框（配合已有 Cmd+K）。

### 6.2 定位跳转（核心新增能力）

1. **传递目标**：跳转时 `router.push({ path: '/tasks/:id', query: { locateMessageId } })`；边路会话走现有 `addSideTask(rootId)` + `openSideTaskTabFor(rootId, sessionId)` 后，由对应 Tab 的面板消费同一 query。
2. **加载窗口**：`ChatPanel.vue` / 边路面板挂载后读取 `route.query.locateMessageId`，消息请求带 `aroundMessageId`（§5.5），拿回包含命中消息的轮次。
3. **DOM 锚点**：`MessageBubble.vue` 根元素加 `:id="'msg-' + msg.id"`（`ChatRoundList.vue` 按 round 渲染，无虚拟化，锚点安全）。
4. **滚动与高亮**：`useChatScroll.ts` 新增 `scrollToMessage(messageId)`：`nextTick` 后 `document.getElementById('msg-'+id)?.scrollIntoView({ block: 'center' })`；`ChatRoundList.vue` 对命中消息加 `.message-locate-flash` class，CSS 关键帧 2 秒后移除（`animation` + `animationend` 监听，或用 2s 定时器移除，测试用定时器更稳）。
5. 消费后从 URL 移除 query（`router.replace` 清 `locateMessageId`），避免刷新重复定位。

### 6.3 API 层

- `desktop/src/api/index.ts:302-310` `searchSessions` 增加筛选/分页参数，返回 `MessageSearchResult`。
- `desktop/src/types/chat.ts:157-158` 别名改为 `MessageSearchGroup`。

## 7. 测试设计

### 7.1 后端单测（`backend-ts`，Vitest，mock 仓库层）

- **路径判定**（`session.service.spec.ts` 扩展，现有用例 :270-365 同址改造）：单中文字符 / 单符号 / 2 字符 ASCII / 纯停用词 → LIKE；2 字中文 / 混合词 / 显式布尔操作符 → FULLTEXT。
- **SQL 编排**：阶段 1/2 参数拼接（userId 恒有、agentId/dateFrom/dateTo/sessionType 可选、分页 LIMIT/OFFSET 计算）；`role IN ('USER','ASSISTANT')` 恒存在。
- **snippet**：多模态 JSON 只取 text 段；首词居中截断边界；前后省略号。
- **边路解析**：`resolveSearchRoots` 复用后的 rootSessionId 正确性（含孤儿剔除）。
- **aroundMessageId**：窗口包含命中消息；消息不存在 / 不属于该会话 → `PARAM_INVALID`；不传时行为不变（回归）。
- **权限**：userId 过滤恒定存在；用户 A 搜不到 B（现有口径保持）。

### 7.2 前端单测（`desktop`，Vitest）

- 面板：分组渲染与折叠展开、筛选行状态→请求参数、防抖与过期响应丢弃、键盘导航。
- 高亮：多词项并集切分（大小写不敏感）。
- 定位：`locateMessageId` query → 请求带 `aroundMessageId`；`scrollToMessage` 调用 `scrollIntoView({block:'center'})` 并加/移除高亮 class。

### 7.3 E2E（`tests/desktop.spec.ts:428-465` 改造）

- `mockLoggedInDesktopApi` 的搜索 mock 改用新响应结构（分组 + messageId）；断言改为分组计数、snippet 高亮。
- 新增：点击命中 → URL 带 `locateMessageId` → 消息列表出现高亮消息（`.message-locate-flash` 可见）。
- 现有两条用例（主会话跳转 / 边路 Tab 打开）的跳转断言保持。

### 7.4 性能基准（发版前记录，写入 CHANGELOG 或本文档）

- 本地探针实测（MySQL 8.0.46，供参照）：LIKE 全表扫 377MB 正文 ≈ 0.36s 且随数据量线性增长；FULLTEXT 稀有词 ≈ 0.08s（35MB 表）；命中数过万时 FTS 排序变慢——查询必须带 LIMIT 且 stage1 先分页。
- 发版后在管理后台或 mysql CLI 记录生产：`SELECT table_name, ROUND(data_length/1024/1024), ROUND(index_length/1024/1024) FROM information_schema.tables WHERE table_name='message'`，与正文体积对比，验证 §1.1 的 5%~15% 预估。

## 8. 部署与运维

### 8.1 发版序列与写入阻塞窗口（重要）

蓝绿部署（`scripts/lib/blue-green.sh` `bg_deploy`）先启动**新实例**、旧实例继续服务，新实例在 `create-app.ts:419` 同步跑 Flyway。V142 的 `LOCK=SHARED` 会**阻塞全表写入**，影响面：

1. 新实例启动 → 执行 V142 构建（期间 message 表写阻塞）；
2. **旧实例仍在服务**，其消息写入同样被阻塞——用户端表现为发消息/流式落库卡住（读取不受影响）；
3. 构建完成后新实例 listen → 健康检查通过 → nginx 切换 → 旧实例 drain。

因此：**首次含 V142 的发版必须安排低峰窗口**。构建耗时按本地实测线性外推（377MB ≈ 12 分钟）；生产数据量未知，发版前建议先在生产库执行只读估算：

```sql
SELECT COUNT(*) AS rows, SUM(LENGTH(content))/1024/1024 AS content_mb FROM message WHERE deleted = 0;
```

按约 30MB/分钟留出窗口。

### 8.2 健康检查超时与重试

健康检查为 60 次 × 1s = **60s**（`blue-green.sh:11-12`，可用 `MAO_BLUE_GREEN_HEALTH_RETRIES` 调大）。若构建超过 60s：

- 新实例健康检查失败 → restart.sh 停掉新实例、deploy 锁标记 `failed`；
- **但 V142 已成功写入 `flyway_schema_history`**，索引已建成；
- 处理：确认旧实例写入已恢复后，**重跑一次 restart.sh**——此次 V142 已跳过，秒级启动，部署正常完成。

运维 Runbook（写入 DEPLOY.md）：

1. 低峰执行 `bash scripts/restart-backend.sh`；
2. 观察新实例日志出现 `Flyway migrated V142__message_content_fulltext.sql`；
3. 若脚本报 failed 且日志显示 V142 已迁移 → 直接重跑 restart.sh；
4. 切流后抽查一次搜索（中文两字词 + 布尔操作符）与一次命中跳转定位。

### 8.3 功能开关

- `SEARCH_FULLTEXT_ENABLED`（默认 `true`，`backend-ts/src/config/app-config.ts` 增加）：置 `false` 时查询强制走 LIKE 路径（索引仍在，不DROP）。用于全文查询异常的应急降级，改后需重启。
- 开关值透传到响应 `path` 字段，便于线上确认实际路径。

## 9. 风险与缓解

| 风险 | 评估 | 缓解 |
|---|---|---|
| 构建期间写入阻塞（低峰窗口） | 高影响、一次性 | §8.1 窗口 + 只读预估算 + 重试 runbook |
| 索引体积超预期 | 低（实测 4%~7%） | 发版后 information_schema 观测；超 30% 再评估（默认不回滚索引，先切开关） |
| 超高频词触发 `FTS query exceeds result cache limit`（实测 30 万行全命中即触发） | 中 | stage1 先 `GROUP BY + LIMIT` 分页；查询串长度上限 100 字（现有）；若仍触发，catch 该错误降级 LIKE 并记日志（P1 实现时加） |
| 单字/短词漏检 | 已知限制 | 路径判定走 LIKE 兜底（§5.1）；UI 提示"过短关键词走模糊匹配" |
| 多词 OR 结果过多 | 中 | 分页 + 按会话分组；相关度相同按会话最近更新排序 |
| 定位跳转落在未渲染消息 | 低 | `aroundMessageId` 服务端开窗保证命中消息在返回窗口内；锚点无虚拟化 |
| 边路会话跳转链路 | 中 | 复用现有 `addSideTask` + `openSideTaskTabFor`，仅追加 locateMessageId 传递 |

## 10. 分阶段

- **本次（合并 P1+P2）**：V142 迁移 + FULLTEXT/LIKE 双路径 + 路径判定与停用词 + 响应结构升级 + 筛选分页 + 面板改版（分组折叠/筛选行/聚焦）+ 定位跳转高亮 + 单测/E2E。
- **P3（后续，另立小议题）**：
  1. TOOL 消息原文纳入范围（查询侧加 role 过滤 + 开关灰度，索引无需变动）——价值高（报错栈/命令输出）但噪声与排序权重要评估；
  2. snippet 相关度调优（词项权重、位置加权）；
  3. 高频词 FTS 缓存上限的降级策略完善；
  4. 子代理 transcript 纳入（依赖先补父会话内子代理视图的导航能力）。

## 11. 文档同步清单（随任务完成）

- `CHANGELOG.md`：新增版本小节（后端：全文检索双路径/筛选分页/响应结构/aroundMessageId；前端：面板改版/分组折叠/定位高亮；附部署注意：V142 构建窗口）。
- `README.md` / `DEPLOY.md`：搜索能力描述 + §8.2 Runbook。
- `skills/mao-cli/`：产品知识库同步搜索能力说明。

## 12. 变更文件清单

**后端**

- `backend-ts/db/migration/V142__message_content_fulltext.sql`（新增）
- `backend-ts/src/session/session.repository.ts`：新增 `selectMatchingSessions`、`selectHitMessages`、`selectRoundStartForMessage`；`selectMessagesForSearch` / `selectMessageSearchCandidates` 的 role 放宽
- `backend-ts/src/session/session.service.ts`：新增 `searchMessages`（路径判定/布尔串构建/分页编排/snippet 80 字上下文）；`getMessagesByRounds` 增 `aroundMessageId`；停用词启动缓存
- `backend-ts/src/session/session.routes.ts`：`/v1/sessions/search` 参数扩展；`/v1/sessions/:id/messages` 增 `aroundMessageId`
- `backend-ts/src/config/app-config.ts`：`SEARCH_FULLTEXT_ENABLED`
- `shared/contracts/src/session.ts`：契约重写（§5.3）
- `backend-ts/src/session/session.service.spec.ts`：搜索用例改造 + 新增覆盖（§7.1）

**前端**

- `desktop/src/components/search/SessionSearchPopover.vue`：筛选行/分组折叠/多词高亮/键盘适配
- `desktop/src/api/index.ts`、`desktop/src/types/chat.ts`：API 与类型
- `desktop/src/components/chat/ChatPanel.vue`、边路面板：消费 `locateMessageId`
- `desktop/src/components/chat/MessageBubble.vue`：消息锚点 + 高亮 class
- `desktop/src/components/chat/ChatRoundList.vue`：高亮 class 绑定与移除
- `desktop/src/composables/useChatScroll.ts`：`scrollToMessage`
- `desktop/src/components/common/TopNav.vue`：打开搜索时聚焦（快捷键已有）
- `tests/desktop.spec.ts`：搜索 E2E 改造 + 定位断言
