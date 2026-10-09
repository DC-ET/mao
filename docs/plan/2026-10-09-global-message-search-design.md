# 全局消息全文检索（Global Message Search）技术方案

- 日期：2026-10-09
- 提案：`docs/proposals/2026-10-09-global-message-search.md`
- 状态：已实施（2026-10-09）

## 1. 共识决策记录

以下 9 项决策经逐条追问确认（另有一项范围决策提问未获答复，按建议项默认采纳并标注待确认）：

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 生产 MySQL 版本 | **确认 8.0+**，ngram FULLTEXT 方案成立 |
| 2 | P1 搜索范围 | **USER + ASSISTANT 消息正文**（⚠️ 提问未答，按建议默认采纳，**待确认**）；thinking_content 独立成列不纳入；TOOL 原文留 P3 开关灰度 |
| 3 | 索引构建方式 | **标准启动迁移**：V146 直接 `ALTER TABLE ADD FULLTEXT`，随发版重启时构建 |
| 4 | 多词语义 | **默认 OR**（空白分开的词项之间为 OR），支持 `+必须 -排除 "短语"`。每个词项先收成短语再交给 ngram（见 §5.2）。短于 `ngram_token_size` 的词项回退 LIKE |
| 5 | 结果呈现 | **按会话分组折叠**（多命中折叠为"N 条命中"可展开）+ 点击**定位到消息并高亮约 2 秒** |
| 6 | 筛选交互 | **筛选行**（Agent / 时间范围 / 会话类型）；Ctrl/Cmd+K 快捷键**已存在**（TopNav.vue:219），仅补"打开时聚焦输入框" |
| 7 | API 兼容 | **直接升级** `/v1/sessions/search` 响应结构，不保留旧字段过渡 |
| 8 | 里程碑 | **P1+P2 合并为一个迭代交付**；P3（TOOL 范围灰度、片段调优）后续 |
| 9 | 子代理会话 | **暂不纳入**搜索池（SUBAGENT 无独立导航入口，搜到无法跳转） |

### 1.1 对提案的两处修正

- **索引体积风险高估**：提案担心 ngram 索引为原文 30%~100%。本地实测（MySQL 8.0.46）：35MB 高随机正文 → 索引 2.5MB（~7%）；377MB 中等重复正文 → 索引 15MB（~4%）。真实值预计 5%~15%，远低于预期。详见 §7。
- **"可在线执行"不成立**：实测 `ADD FULLTEXT ... LOCK=NONE` 报 ERROR 1846（Fulltext index creation requires a lock），最低只能 `LOCK=SHARED`（阻塞写、不阻塞读）。且 InnoDB 需添加隐藏 `FTS_DOC_ID` 列，触发表重建（数据段 +15%）。对部署的影响见 §8。
- 另修正提案中"compact 脱敏消息"的表述：`admin-message-compact.ts` 是**管理端展示层截断**（内存转换，无 DB 写入），存储层无脱敏概念。搜索命中即存储原文，属主可见，符合隐私边界，无额外处理。

### 1.2 评审结论

需求可行，方案可行。范围就是「属主自己的 USER/ASSISTANT 原文 + 中文可用 + 点结果跳到那条消息」，不依赖向量库，和已否决的 RAG 不冲突。MySQL 8.0 的 ngram 全文索引、现有 `/v1/sessions/search`、以及无虚拟化的消息列表，都撑得起这个范围。

评审不推翻已确认的 9 项决策。下面几处若按原文实现会做错，已就地改掉：

- 布尔查询必须把每个词项收成短语，否则一个三字以上的中文词会被 ngram 拆成大数据 OR。
- `aroundMessageId` 的上界是**下一轮用户消息**，不是轮次起点 +1；否则助手回复（主需求）不在返回窗口里。
- 定位后的列表不是「最新一页」。不能走现有的尾部合并，要能回到最新，并且两个面板不能抢同一个 query。
- 健康检查默认 60 秒会在建索引过程中杀掉新进程，DDL 回滚，重跑也不会跳过 V146。必须先把等待时间加到长过预估构建时间。

## 2. 现状基线（代码事实）

| 环节 | 位置 | 现状 |
|---|---|---|
| 路由 | `backend-ts/src/session/session.routes.ts:203-208` | `GET /v1/sessions/search?keyword=`，无筛选/分页参数 |
| 服务 | `session.service.ts:691-743` `searchSessionsByUserMessage` | 关键词 1~100 字；候选会话 20 条；每会话取首条命中；返回**会话摘要**，无 messageId |
| 候选 SQL | `session.repository.ts:327-349` | `role='USER'` 写死 + `content LIKE '%kw%'`，JOIN session 按 user_id 过滤，session_type IN ('NORMAL','SIDE_TASK') |
| 命中 SQL | `session.repository.ts:609-628` | 同 LIKE，每会话前 5 条 |
| 边路解析 | `session.service.ts:750-784` `resolveSearchRoots` | SIDE_TASK 上溯根主会话（≤10 轮），孤儿剔除——**保留复用** |
| 契约 | `shared/contracts/src/session.ts:5-17` `MessageSearchItem` | 会话摘要结构。消费者两处：搜索浮窗，以及 `OpenApiView.vue` 的 Webhook 会话选择器（只要 `id` + `title`） |
| 前端 | `desktop/src/components/search/SessionSearchPopover.vue` | 300ms 防抖 + requestSeq/AbortController 双保险；↑↓/Enter/Esc 键盘；结果项 snippet 大小写不敏感高亮 |
| 快捷键 | `desktop/src/components/common/TopNav.vue:219` | Ctrl/Cmd+K 已注册 toggle 搜索浮窗 |
| 跳转 | `SessionSearchPopover.vue:209-234` | 只到会话 / 边路 Tab，**无消息级定位**。边路目标路由是根会话 `/tasks/:rootId`，边路会话 id 不在 path 上 |
| 消息定位能力 | `useChatScroll.ts` / `ChatRoundList.vue` | **不存在** scrollToMessage；消息无 DOM 锚点；列表无虚拟化（可安全加锚点） |
| 消息分页 | `session.routes.ts:421-441` + `getMessagesByRounds`（`session.service.ts:984-1020`） | 游标式轮次分页 `roundLimit/beforeMessageId` |
| 管理端搜索 | `listSessions` 关键词分支（`session.service.ts:452-486`）+ `selectFirstMatchingMessages`（`repository.ts:631-649`） | 另一条链路，**本方案不改动** |
| 迁移编号 | `backend-ts/db/migration/` 最大 V141 | 本次为 **V146** |
| Flyway | `create-app.ts:419` 启动时同步执行，失败抛错阻断启动（`flyway.ts:288`）；连接 `multipleStatements: true` | — |
| 消息表 | V001:162-175 | content MEDIUMTEXT；role VARCHAR(20)（USER/ASSISTANT/SYSTEM/TOOL）；无 user_id（归属走 session.user_id）；已有索引 idx_session / idx_created / idx_message_session_deleted_id |
| Agent 列表 | `GET /v1/agents`（`agent.routes.ts:75`） | 筛选器下拉直接复用，无需新接口 |
| 分享机制 | `session_share`（V136） | 只存 share_token + message_watermark，快照**实时生成**，无独立副本——不存在"分享快照落入索引池"问题 |

## 3. 总体设计

```
┌────────────────────────────────────────────────────────────┐
│ Desktop: SessionSearchPopover.vue（改版）                   │
│  筛选行(Agent/时间/类型) + 关键词(布尔操作符) + 分组折叠结果  │
│  点击命中 → /tasks/:id?locateMessageId=&locateSessionId=   │
└──────────────┬─────────────────────────────────────────────┘
               │ GET /v1/sessions/search?keyword&agentId&dateFrom&dateTo&sessionType&page&size
┌──────────────▼─────────────────────────────────────────────┐
│ Backend: session.service.ts searchMessages()（新）          │
│  ① 路径判定：短于 ngram / 非法布尔串 → LIKE；否则 FULLTEXT   │
│  ② 阶段1：命中会话聚合 + 分页；词项先收成短语再 MATCH        │
│  ③ 阶段2：页内每会话 Top5（ROW_NUMBER）                      │
│  ④ 装会话字段 + resolveSearchRoots + batchLoadAgents        │
└──────────────┬─────────────────────────────────────────────┘
               │ 返回 MessageSearchGroup[]（含 messageId）
┌──────────────▼─────────────────────────────────────────────┐
│ 定位：GET .../messages?aroundMessageId=:mid                 │
│  → 窗口含命中轮（上界=下一轮用户消息）+ hasNewer             │
│  → 锚点滚动高亮 2s；有更新消息时「回到最新」                  │
└────────────────────────────────────────────────────────────┘

MySQL: message 表 FULLTEXT INDEX ft_message_content (content) WITH PARSER ngram  (V146)
```

## 4. 数据库迁移（V146）

**文件**：`backend-ts/db/migration/V146__message_content_fulltext.sql`

```sql
-- V146: 消息正文全文索引（ngram 中文分词），支撑全局消息检索。
-- 注意：MySQL 8 FULLTEXT 创建不支持 LOCK=NONE，最低 LOCK=SHARED（阻塞写、不阻塞读），
-- 且需重建表添加隐藏 FTS_DOC_ID 列。启动时执行期间的写入阻塞影响见部署文档。
-- 空停用词表必须在同一连接、ALTER 之前设到会话上，索引内容按这个表固化。
CREATE TABLE IF NOT EXISTS `message_ft_stopword` (
  `value` VARCHAR(30) NOT NULL
) ENGINE=InnoDB;

SET @mao_ft_sw := CONCAT(DATABASE(), '/message_ft_stopword');
SET SESSION innodb_ft_user_stopword_table = @mao_ft_sw;

ALTER TABLE `message`
  ADD FULLTEXT INDEX `ft_message_content` (`content`) WITH PARSER ngram,
  ALGORITHM=INPLACE, LOCK=SHARED;
```

要点：

- **ngram_token_size 用默认 2**。ngram 解析器忽略 `innodb_ft_min_token_size` / `innodb_ft_max_token_size`，token 长度只由 `ngram_token_size` 决定。两字英文（`OK`、`go`）会被索引；短于 2 的词项不会。发版前在生产执行 `SHOW VARIABLES LIKE 'ngram_token_size'`，不是 2 就先改启动参数并重启，再发 V146。该变量改完必须重建索引，不能在索引建成后再改。
- **停用词表用空表。** 默认停用词里有一批长度正好为 2 的英文词（`to` / `is` / `in` / `of` / `or` / `at` / `be` / `as` / `it` / `on` / `by` 等）。ngram 会把英文词切成连续双字母，这些双字母一旦是停用词就不进索引，短语检索会缺 token。`history`、`database` 这类词会漏。中文双字不受影响。空表要在建索引的那条连接上设好；应用连接池每次取出连接后执行同一句 `SET SESSION innodb_ft_user_stopword_table`（库名用当前 database），查询期和索引期才能一致。不改 `my.cnf` 的全局停用词，避免碰到实例上以后别的全文索引。`SET SESSION ... = @mao_ft_sw` 若在 8.0 上报错，改成字面量 `'库名/message_ft_stopword'`。
- 索引对全表所有行生效（含 TOOL/SYSTEM，以及 `deleted=1` 的行）——**这是 MySQL FULLTEXT 的固有行为，无法只索引部分行**。逻辑删除不会把 token 移出索引，`WHERE deleted=0` 在命中之后过滤。索引体积含已删行，可接受。"只搜近 N 个月"只能查询侧过滤、不降低构建成本，故不采用。角色过滤发生在查询 WHERE 条件。
- 历史行由建索引时一次构建，新写入行 InnoDB 自动维护。
- 回滚预案：默认不回滚索引（DROP INDEX 同样要锁表）；应急时用功能开关把查询切回 LIKE（§8.3）。
- 构建前确认数据目录空闲空间不小于 `message` 表当前 `data_length`（重建会产生临时副本，再叠加全文索引）。空间不足时 DDL 失败回滚。

## 5. 后端设计

### 5.1 查询路径判定（`session.service.ts`）

在 `searchMessages` 入口对关键词做判定，输出 `path: 'FULLTEXT' | 'LIKE'`（随响应返回，便于线上诊断）：

| 条件 | 路径 |
|---|---|
| 任一词项字符数 < `ngram_token_size`（默认 2：单中文字、单符号） | LIKE |
| 布尔串非法，或含 ngram 不支持的 `*`、未闭合引号、悬空 `+`/`-` | 捕获全文语法错误后走 LIKE（原始关键词，筛选条件仍然生效），不要把 MySQL 错误抛成 500 |
| 其他 | FULLTEXT |

两字英文走全文，不因为 `innodb_ft_min_token_size=3` 去走 LIKE——ngram 不看这个变量。停用词表已是空表，不再为「整词都是默认停用词」单开一条回退；那条回退也盖不住英文词内部的双字母停用词。

设计取舍：不采用"全文零结果再重试 LIKE"——那会让每次无命中搜索都付一次全表扫描；路径判定是确定性的，零结果就是零结果。语法错误除外，那是查询串本身不能执行。

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
  AND (
    s.session_type = 'NORMAL'
    OR EXISTS (
      SELECT 1 FROM session p
      WHERE p.id = s.parent_session_id AND p.user_id = s.user_id AND p.deleted = 0
    )
  )
  AND MATCH(m.content) AGAINST (? IN BOOLEAN MODE)
  /* 可选：AND s.agent_id = ?  AND m.created_at >= ?  AND m.created_at < ?  AND s.session_type = ? */
GROUP BY m.session_id
ORDER BY maxScore DESC, MAX(s.updated_at) DESC
LIMIT ? OFFSET ?
```

配套 count 查询（同 WHERE、`COUNT(DISTINCT m.session_id)`）供分页 total。阶段 1 只产出 `sessionId / hitCount / maxScore`。会话标题、类型、父会话、阶段、状态、agentId 用当页 id 再查一次会话行（保持阶段 1 的排序，不要按 findByIds 的返回顺序）。`batchLoadAgents` 只补名称。

父会话已删除的一层孤儿在 SQL 里就排除（上面的 `EXISTS`，与现网候选 SQL 相同）。更深的断链仍交给 `resolveSearchRoots` 在页内剔除，这种页可能不足 `size`，total 也可能略大；P1 接受，不为深层孤儿做递归 SQL。

高频词触发 `FTS query exceeds result cache limit` 时，阶段 1 和 count 都要捕获并降级 LIKE（记日志）。缓存是全表的，不是按 user_id 先缩小后再计数。

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

**LIKE 兜底路径**：`escapeLike` 保留。不能复用现网 `selectMessageSearchCandidates` 的 `LIMIT 20`——那条 SQL 没有 agent / 时间 / 会话类型 / 分页，短词搜索会把筛选行静默丢掉。LIKE 的阶段 1 与全文同一套 WHERE（user、role、父会话 EXISTS、可选 agent/日期/类型）和同一套 `LIMIT/OFFSET`，排序用 `s.updated_at DESC, s.id DESC`（没有相关度）。阶段 2 用同一窗口函数，按 `m.id DESC` 取每会话 5 条。

**关键词→布尔串转换**（服务层）：

ngram 会把查询也切成连续 `ngram_token_size` 字的 token。布尔模式里没有操作符就是 OR。`数据库` 若不加引号会变成 `数据` OR `据库`，几乎所有含「数据」的消息都命中。所以每个词项都要收成短语，让这些 token 按顺序相邻：

- 按空白切分。已经用双引号包住的片段保持为短语；紧贴在词项前的 `+` / `-` 保留，并作用在短语上。
- 未加引号的词项包上一对双引号。`部署脚本 回滚` → `"部署脚本" "回滚"`；`+部署脚本 -测试` → `+"部署脚本" -"测试"`。词项内部的 `"` 和 `\` 先转义再包。
- 中文逗号、顿号不会被当成空白，`部署，脚本` 是一个短语。UI 提示：多个词用空格分开；`+` 必须、`-` 排除、引号表示原短语。
- 空片段丢掉。`*`、未闭合引号、悬空运算符不在服务层猜测语义，交给 §5.1 捕获错误后走 LIKE。

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

- 路由参数扩展：`agentId?`、`dateFrom?`（含当日）、`dateTo?`（含当日）、`sessionType?`（`NORMAL`|`SIDE_TASK`）、`page`（默认 1）、`size`（默认 20，上限 50）。`page < 1`、`size` 越界、`sessionType` 不是这两个值、`dateFrom > dateTo`、日期不是 `YYYY-MM-DD`，都返回 `PARAM_INVALID`。`OFFSET` 超过 10000 直接空结果，避免深分页把全文排序拖满。
- 日期按 Asia/Shanghai 的自然日解释，与连接时区 `+08:00` 一致：`created_at >= dateFrom 00:00:00` 且 `created_at < dateTo 的次日 00:00:00`。不要把日期当 UTC 零点。
- `MessageSearchItem` 旧类型删除（决策 7：直接升级，无过渡）。`desktop/src/types/chat.ts:157-158` 的别名同步更新。`OpenApiView.vue` 的会话选择器改为读 `items[].sessionId` / `title`，不展示命中片段。

### 5.4 snippet 生成

- 复用 `extractVisibleText`（`session.service.ts:786-821`，多模态 JSON 只取 text 段）抽取纯文本。
- 在现有 `buildSnippet`（:1303-1316）基础上把上下文从 25 字扩到 **前后各约 80 字**：定位**首个**关键词出现处居中截断，总长约 200 字封顶；LIKE 路径以原始关键词定位，FULLTEXT 路径按切分后的任一词项定位。
- 多词项高亮由前端完成（现有大小写不敏感区间切分逻辑扩展为多词项并集），后端不做 `<mark>` 注入。
- 全文索引打在原始 `content` 上，多模态 JSON 的键（`type`、`image_url`）也会命中。可见文本里找不到任何一个词项时，这条命中丢掉；一个会话的命中全部丢掉则不返回该组。`hitCount` 用丢掉之后的条数，避免「3 条命中」点开是空的。因此当页条数可能小于 `size`，`total` 仍是 SQL 的会话数，允许略大。分叉复制进边路的消息会在父会话和边路各出现一次，P1 不去重。

### 5.5 命中定位：`aroundMessageId`（`getMessagesByRounds` 扩展）

消息列表是游标式轮次分页，命中消息可能不在首屏窗口内。给现有能力加一个可选参数，**服务端直接返回包含命中消息的轮次窗口**，避免前端反复翻页：

- 路由 `GET /v1/sessions/:id/messages` 增加 `aroundMessageId?`（`session.routes.ts:421-441`）。分享页、导出、管理端不传这个参数。
- 现有上界是排他的：`selectUserStarts` / `selectRange` 都是 `id < beforeId`。`beforeId = roundStartId + 1` 会把该轮用户消息之后的助手回复和工具消息全部切掉，命中的 ASSISTANT 行不在窗口里。上界必须是**下一轮用户消息的 id**。
- 服务（`session.service.ts:984-1020`）options 增加 `aroundMessageId`：
  1. `findById` 校验消息存在且 `sessionId` 匹配且未删除，否则 `PARAM_INVALID`；
  2. 轮次起点 `roundStartId = MAX(id)`，条件 `role='USER' AND id <= aroundMessageId`（`selectRoundStartForMessage`）；
  3. 下一轮起点 `nextUserId = MIN(id)`，条件 `role='USER' AND id > roundStartId`（没有则为 null）；
  4. `beforeId = nextUserId`。为 null 时表示命中轮已经是最后一轮，`selectRange` 一直取到会话末尾。这样窗口的最后一轮包含该轮用户消息、助手回复和工具消息，命中行落在 `[roundStartId, nextUserId)` 内；
  5. 没有更早的 USER 消息时（`roundStartId` 为空）：下界用命中消息自身 id，上界仍是下一条 USER id 或会话末尾。窗口允许不满 5 轮，但必须包含命中行；
  6. `hasMore/nextBeforeMessageId` 语义不变，前端可继续向上翻页。响应增加 `hasNewer: boolean`（`nextUserId != null`）。不传 `aroundMessageId` 时不返回这个字段，行为与现网一致。
- 本迭代不做向下连续翻页。命中轮之后的消息靠 `hasNewer` + 前端「回到最新」一次拉回最新 5 轮（现有 `fetchMessages`）。

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

1. **传递目标**：query 同时带 `locateMessageId` 和 `locateSessionId`。主会话 `router.push({ path: '/tasks/:id', query: { locateMessageId, locateSessionId } })`。边路仍走 `addSideTask(rootId)` + `openSideTaskTabFor(rootId, sessionId)`，path 是根会话 `/tasks/:rootId`，`locateSessionId` 用边路会话 id，不能用根会话 id。
2. **谁消费**：主会话面板只在 `locateSessionId === 当前主会话 id` 时处理；边路面板只在 `locateSessionId === 当前边路会话 id` 时处理。另一个面板忽略，也不许清 query。边路正处在分叉预览时，先退出预览再拉真实消息。
3. **何时读**：用 `watch` 路由 query，不要只在挂载时读。已经停在同一条路由上时，`router.push` 不会重新挂载面板。query 由目标面板在发起定位之后再 `router.replace` 清掉。
4. **加载窗口**：目标消息已经在当前列表里时，直接滚动，保持「最新一页」模式，不重拉。不在列表里时，请求带 `aroundMessageId`（§5.5）。这次结果用 `setMessages` 整表替换，**不要**走 `applyFetchedMessages`：那个合并把 REST 当成最新尾页，会把本地已加载的最新消息和流式气泡接到历史窗口后面，中间缺一轮。替换后若 `hasNewer`，会话进入历史定位模式。
5. **历史定位模式**：可以继续向上翻更早的轮次。不把实时流式消息追加到这个窗口后面。列表底部（或顶部）放「回到最新」，点击后走现有 `fetchMessages`（最新 5 轮）并退出该模式。本迭代不做向下一页一页翻。
6. **DOM 锚点**：`MessageBubble.vue` 根元素加 `:id="'msg-' + msg.id"`（`ChatRoundList.vue` 按 round 渲染，无虚拟化，锚点安全）。同一消息 id 全局唯一；滚动时优先在目标面板内 `querySelector`，避免 `document.getElementById` 命中另一个隐藏面板。
7. **滚动与高亮**：`useChatScroll.ts` 新增 `scrollToMessage(messageId)`：`nextTick` 后把该节点 `scrollIntoView({ block: 'center' })`；命中消息加 `.message-locate-flash`，2 秒后移除（定时器，测试稳定）。安卓壳加载同一份 desktop 包，不另做原生；`scrollIntoView` 在 WebView 里可用。

### 6.3 API 层

- `desktop/src/api/index.ts:302-310` `searchSessions` 增加筛选/分页参数，返回 `MessageSearchResult`。
- `desktop/src/types/chat.ts:157-158` 别名改为 `MessageSearchGroup`。
- `desktop/src/views/settings/OpenApiView.vue`：Webhook 会话选择器改读 `sessionId` / `title`。这里只选会话，不展示命中片段，也不带筛选。

## 7. 测试设计

### 7.1 后端单测（`backend-ts`，Vitest，mock 仓库层）

- **路径判定**（`session.service.spec.ts` 扩展，现有用例 :270-365 同址改造）：单字符 → LIKE；两字中文、两字英文、显式布尔操作符 → FULLTEXT。`数据库` 转成 `"数据库"`，`部署脚本 回滚` 转成 `"部署脚本" "回滚"`，`+部署 -测试` 转成 `+"部署" -"测试"`。非法布尔串 / `*` 捕获后走 LIKE，且 agent、日期、会话类型、分页参数仍传入。
- **SQL 编排**：阶段 1/2 参数拼接（userId 恒有、agentId/dateFrom/dateTo/sessionType 可选、分页 LIMIT/OFFSET 计算）；`role IN ('USER','ASSISTANT')` 恒存在；父会话 `EXISTS` 恒存在。阶段 1 之后按返回顺序装会话字段，不按二次查询的行序。
- **snippet**：多模态 JSON 只取 text 段；首词居中截断边界；前后省略号。可见文本不含词项的命中丢弃，整组丢光则该会话不出现，`hitCount` 与展示条数一致。
- **边路解析**：`resolveSearchRoots` 复用后的 rootSessionId 正确性（含孤儿剔除）。
- **aroundMessageId**：助手消息命中时，窗口包含该助手行（上界是下一轮 USER id，不是轮次起点 +1）；命中轮是最后一轮时上界为 null 且 `hasNewer=false`；后面还有轮次时 `hasNewer=true`；消息不存在 / 不属于该会话 → `PARAM_INVALID`；不传时行为不变、响应无 `hasNewer`（回归）。
- **权限**：userId 过滤恒定存在；用户 A 搜不到 B（现有口径保持）。

### 7.2 前端单测（`desktop`，Vitest）

- 面板：分组渲染与折叠展开、筛选行状态→请求参数、防抖与过期响应丢弃、键盘导航。
- 高亮：多词项并集切分（大小写不敏感）。
- 定位：`locateMessageId` + `locateSessionId` → 只有会话 id 匹配的面板发 `aroundMessageId`；已在列表中则不重拉；不在列表中则 `setMessages` 替换（不走 `applyFetchedMessages`）；`hasNewer` 时出现「回到最新」，点击后恢复最新一页。`scrollToMessage` 调用 `scrollIntoView({block:'center'})` 并加/移除高亮 class。
- OpenAPI 会话选择器：新响应映射为 `{ id: sessionId, title }`，选项能选中。

### 7.3 E2E（`tests/desktop.spec.ts:428-465` 改造）

- `mockLoggedInDesktopApi` 的搜索 mock 改用新响应结构（分组 + messageId）；断言改为分组计数、snippet 高亮。
- 新增：点击命中 → URL 带 `locateMessageId` → 消息列表出现高亮消息（`.message-locate-flash` 可见）。
- 现有两条用例（主会话跳转 / 边路 Tab 打开）的跳转断言保持。

### 7.4 性能基准（发版前记录，写入 CHANGELOG 或本文档）

- 本地探针实测（MySQL 8.0.46，供参照）：LIKE 全表扫 377MB 正文 ≈ 0.36s 且随数据量线性增长；FULLTEXT 稀有词 ≈ 0.08s（35MB 表）；命中数过万时 FTS 排序变慢——查询必须带 LIMIT 且 stage1 先分页。
- 发版后在管理后台或 mysql CLI 记录生产：`SELECT table_name, ROUND(data_length/1024/1024), ROUND(index_length/1024/1024) FROM information_schema.tables WHERE table_name='message'`，与正文体积对比，验证 §1.1 的 5%~15% 预估。

## 8. 部署与运维

### 8.1 发版序列与写入阻塞窗口（重要）

蓝绿部署（`scripts/lib/blue-green.sh` `bg_deploy`）先启动**新实例**、旧实例继续服务，新实例在 `create-app.ts:419` 同步跑 Flyway。V146 的 `LOCK=SHARED` 会**阻塞全表写入**，影响面：

1. 新实例启动 → 执行 V146 构建（期间 message 表写阻塞）；
2. **旧实例仍在服务**，其消息写入同样被阻塞——用户端表现为发消息/流式落库卡住（读取不受影响）；
3. 构建完成后新实例 listen → 健康检查通过 → nginx 切换 → 旧实例 drain。

因此：**首次含 V146 的发版必须安排低峰窗口**。构建耗时按本地实测线性外推（377MB ≈ 12 分钟）；生产数据量未知，发版前在生产库做两件只读检查：

```sql
SHOW VARIABLES LIKE 'ngram_token_size';
SELECT COUNT(*) AS rows,
       SUM(LENGTH(content))/1024/1024 AS content_mb
FROM message WHERE deleted = 0;
```

`ngram_token_size` 必须已是 2。耗时按约 30MB/分钟估算。数据目录空闲空间不小于 `message.data_length`（见 §4）。

### 8.2 健康检查必须盖住整段 DDL

Flyway 在 `listen` 之前同步执行（`create-app.ts`）。健康检查要等端口应答，默认 60 次 × 1s = **60s**（`blue-green.sh:11-12`）。构建超过 60 秒时的实际顺序是：

1. 新进程卡在 `ALTER TABLE`，端口还没开；
2. 健康检查失败，`bg_stop_port` 杀掉新进程；
3. 连接断开，MySQL 中止这条 DDL 并回滚。`flyway_schema_history` 的成功行是在 SQL 返回之后才插入的（`flyway.ts`），进程在这之前被杀，**不会**留下 V146 记录，索引也不会留下；
4. 立刻重跑会再次从 ALTER 开始，再次在 60 秒被杀。写锁每次只持有到进程死亡，但发版永远完不成。

所以不是「失败后重跑就会跳过」。发版前先把等待拉到长过预估构建时间，例如内容 400MB、按 30MB/分钟约 15 分钟，则 `MAO_BLUE_GREEN_HEALTH_RETRIES` 至少 15×60 再加几分钟余量（间隔仍是 1 秒）。mysql2 这条连接没有语句超时，进程活着，DDL 就可以跑完。

只有日志已经打出 `Flyway migrated V146__message_content_fulltext.sql` 之后，迁移才算完成。若这行已经出现、随后却在别的原因上健康检查失败，那时重跑才会跳过 V146。

运维 Runbook（写入 DEPLOY.md）：

1. 低峰前先做 §8.1 的两项只读检查，设好 `MAO_BLUE_GREEN_HEALTH_RETRIES`，确认数据目录空间；
2. 执行 `bash scripts/restart-backend.sh`；
3. 看到 `Flyway migrated V146__message_content_fulltext.sql`，然后健康检查通过、nginx 切流；
4. 切流后抽查：两字中文（应变短语命中，而不是拆开 OR）、一个三字以上的词、一次助手消息跳转并出现「回到最新」（若该条不在最新几轮）。

### 8.3 功能开关

- `SEARCH_FULLTEXT_ENABLED`（默认 `true`，`backend-ts/src/config/app-config.ts` 增加）：置 `false` 时查询强制走 LIKE 路径（索引仍在，不DROP）。用于全文查询异常的应急降级，改后需重启。
- 开关值透传到响应 `path` 字段，便于线上确认实际路径。

## 9. 风险与缓解

| 风险 | 评估 | 缓解 |
|---|---|---|
| 构建期间写入阻塞，且 60 秒健康检查会把 DDL 杀掉并回滚 | 高影响、一次性 | §8.1 窗口 + §8.2 先加长健康检查，不要未完成就重跑 |
| 索引体积超预期（含已逻辑删除行和 TOOL 正文） | 低（实测 4%~7%，生产以 information_schema 为准） | 发版后观测；超 30% 再评估（默认不回滚索引，先切开关） |
| 超高频词触发 `FTS query exceeds result cache limit`（实测 30 万行全命中即触发；缓存按全表计，不按用户） | 中 | stage1 与 count 都捕获后降级 LIKE 并记日志；查询串上限 100 字（现有） |
| 单字漏检 | 已知限制 | 短于 `ngram_token_size` 走 LIKE（§5.1）；UI 提示过短关键词走模糊匹配 |
| 未加引号时三字以上中文被拆成 OR | 高（不做短语包装时搜索不可用） | §5.2 每个词项收成短语；非法布尔串回退 LIKE |
| 默认停用词吃掉英文双字母 | 中 | §4 空停用词表，索引连接和查询连接用同一设置 |
| 多词 OR 结果过多 | 中 | 分页 + 按会话分组；相关度相同按会话最近更新排序 |
| 定位窗口切掉助手回复，或历史窗口被当成最新尾页 | 高 | §5.5 上界用下一轮 USER id；§6.2 整表替换 + 「回到最新」，定位期间不拼接流式消息 |
| 主面板和边路面板抢 query | 中 | query 带 `locateSessionId`，只有目标面板消费并清除 |

## 10. 分阶段

- **本次（合并 P1+P2）**：V146（含空停用词表）+ FULLTEXT/LIKE 双路径 + 短语布尔串 + 筛选分页 + 响应结构升级 + 面板改版 + 定位跳转（含回到最新）+ 单测/E2E。
- **P3（后续，另立小议题）**：
  1. TOOL 消息原文纳入范围（查询侧加 role 过滤 + 开关灰度，索引无需变动）——价值高（报错栈/命令输出）但噪声与排序权重要评估；
  2. snippet 相关度调优（词项权重、位置加权）；
  3. 高频词 FTS 缓存上限的降级策略完善；
  4. 子代理 transcript 纳入（依赖先补父会话内子代理视图的导航能力）。

## 11. 文档同步清单（随任务完成）

- `CHANGELOG.md`：新增版本小节（后端：全文检索双路径/筛选分页/响应结构/aroundMessageId；前端：面板改版/分组折叠/定位高亮；附部署注意：V146 构建窗口）。
- `README.md` / `DEPLOY.md`：搜索能力描述 + §8.2 Runbook。
- `skills/mao-cli/`：产品知识库同步搜索能力说明。

## 12. 变更文件清单

**后端**

- `backend-ts/db/migration/V146__message_content_fulltext.sql`（新增，含空停用词表）
- `backend-ts/src/db/db.ts`：连接取出后 `SET SESSION innodb_ft_user_stopword_table`
- `backend-ts/src/session/session.repository.ts`：新增 `selectMatchingSessions`、`selectHitMessages`、`selectRoundStartForMessage`、下一轮 USER id；LIKE 阶段 1 同步筛选与分页，不再用写死的 `LIMIT 20`
- `backend-ts/src/session/session.service.ts`：新增 `searchMessages`（路径判定 / 短语布尔串 / 分页编排 / snippet）；`getMessagesByRounds` 增 `aroundMessageId` 与 `hasNewer`
- `backend-ts/src/session/session.routes.ts`：`/v1/sessions/search` 参数扩展；`/v1/sessions/:id/messages` 增 `aroundMessageId`
- `backend-ts/src/config/app-config.ts`：`SEARCH_FULLTEXT_ENABLED`
- `shared/contracts/src/session.ts`：契约重写（§5.3）
- `backend-ts/src/session/session.service.spec.ts`：搜索用例改造 + 新增覆盖（§7.1）

**前端**

- `desktop/src/components/search/SessionSearchPopover.vue`：筛选行/分组折叠/多词高亮/键盘适配；跳转带 `locateSessionId`
- `desktop/src/api/index.ts`、`desktop/src/types/chat.ts`：API 与类型
- `desktop/src/views/settings/OpenApiView.vue`：会话选择器改读 `sessionId`
- `desktop/src/components/chat/ChatPanel.vue`、`SideChatPanel.vue`：按 `locateSessionId` 消费；历史定位用 `setMessages`；「回到最新」
- `desktop/src/stores/session/messages.ts`：历史定位模式，该模式下不把流式消息接到窗口尾部
- `desktop/src/components/chat/MessageBubble.vue`：消息锚点 + 高亮 class
- `desktop/src/components/chat/ChatRoundList.vue`：高亮 class 绑定与移除
- `desktop/src/composables/useChatScroll.ts`：`scrollToMessage`
- `desktop/src/components/common/TopNav.vue`：打开搜索时聚焦（快捷键已有）
- `tests/desktop.spec.ts`：搜索 E2E 改造 + 定位断言
