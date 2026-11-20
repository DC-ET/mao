# 管理后台会话列表：活跃时间窗筛选与关键词搜索超时治理

- 状态：已实施（2026-11-06，0.0.460）
- 需求来源：用户反馈「会话列表关键词搜索一直超时，是否增加时间范围筛选（以活跃时间为准、默认最近 7 天），并给该字段加索引」（飞书对话 2026-11-06）
- 影响范围：`backend-ts`（管理端会话列表查询、迁移 V188）、`admin`（会话管理筛选）、`skills/mao-cli`（`admin-session list` 参数与文档）
- 不涉及：用户侧消息搜索（`/v1/sessions/search`，仍走 ngram 全文索引）、桌面端、agent-cli

## 1. 问题与实测

现象：管理后台「会话管理」输入关键词（如 `push_once`，搜索范围＝全部消息）查询 30s 后报「网络错误」（前端 axios 超时 30s）。

生产库只读实测（message 表 68 万行、正文 1.5GB；session 表 2.3k 行）：

| 查询 | 耗时 |
|---|---|
| 当前实现（关键词 `push_once`，筛选同截图）count / 分页 | 82s / 73s |
| 只把 `last_activity_at >= 最近7天` 加进现有 SQL（写法不变） | 74s（无效） |
| 单独执行 FULLTEXT 子查询 | 74s（0 命中关键词也要 17s） |
| FULLTEXT + JOIN 限制到 7 天内会话 | 74s（FT 无法被下游条件缩小） |
| 单字符关键词走 LIKE 全表兜底 | 27s |
| 会话表纯筛选 + 排序分页（无关键词） | 0.03s |

结论：慢的不是 `session` 表，而是**消息匹配路径**。

1. `id IN (SELECT ... MATCH(m.content) AGAINST ...)` 是全局全文检索：MySQL 先跑完 FT 再与会话条件求交，会话侧的过滤传不进子查询；ngram 2 字分词下常见二元组 postings 极大，且随正文体量增长。
2. 单字符关键词走 `content LIKE '%x%'` 全表扫描，同样超时。
3. 因此**只加筛选项 / 只加索引都无法解决超时**，必须同时把关键词匹配收敛到已筛选的会话集合内。

## 2. 方案（已实施）

- **关键词改为窗口内相关子查询**：去掉全局 `IN (SELECT ... MATCH ...)` 与全表 LIKE 兜底，改为

  ```sql
  (title LIKE ? OR summary LIKE ? OR EXISTS (
     SELECT 1 FROM message m
     WHERE m.session_id = `session`.id AND m.deleted = 0
       [AND m.role IN ('USER','ASSISTANT')]      -- messageScope=CONVERSATION（默认）
       AND m.created_at >= ? AND m.created_at < ?  -- 与活跃时间窗同窗
       AND m.content LIKE ? ESCAPE '\\'
  ))
  ```

  实测 1.5~2.2s（视搜索范围、窗口内消息量）。管理端列表不再使用 ngram 全文索引；该索引在 message 表上的性能问题另行立项。
- **活跃时间窗参数**（`GET /v1/admin/sessions`）：
  - `range=7D|30D|90D`（大小写不敏感）：最近 N 天，含今天，按 Asia/Shanghai 日历；
  - `range=ALL`：全部时间（不限窗）；
  - `dateFrom` / `dateTo`（`YYYY-MM-DD`，含首尾日，可单边）优先于 `range`；
  - 什么都不传：默认最近 7 天（后端兜底，避免任何客户端直连 API 再次触发慢查询）。
- **同窗口径**：会话按 `last_activity_at` 过滤，关键词消息按 `created_at` 过滤；命中片段（`matchSnippet`）同样限定窗口，避免截到窗口外命中的片段。
- **索引**：`ALTER TABLE session ADD INDEX idx_session_last_activity (last_activity_at, id)`（迁移 V188）。该列此前无索引，既作范围条件又是列表排序键（`ORDER BY last_activity_at DESC, id DESC`）；当前 2.3k 行下收益可忽略（无索引也 0.03s），价值在会话量增长后避免全表扫描 + filesort。
- **前端**（会话管理筛选）：新增「活跃时间」档位 最近 7 天（默认）/ 30 天 / 90 天 / 自定义 / 全部时间；预设档位只传档位名、由后端按上海日历计算窗口，避免浏览器时区造成边界漂移；地址栏支持 `range` / `dateFrom` / `dateTo` 深链。

## 3. 已知边界

- `last_activity_at` 为空的存量会话（约 2.6%）在带时间窗时不可见，仅在「全部时间」下可见。
- 「全部时间 + 关键词」不再有窗口约束，仍会扫描全部消息（实测约 27s），由调用方自行承担；管理后台保留该档位供反查历史。
- 关键词搜索不再享受全文索引的召回增强（如整词/短语语义），改为纯子串匹配：更确定，但长词在超大窗口下会变慢。
- FT 在 message 表上的 74s 性能问题（重建索引 / ngram 配置 / 迁移 ES）不在本次范围。

## 4. 验证

- 生产库只读复现与改写对比（见 §1）。
- 单测：`resolveActivityWindow`（默认 7 天、预设、ALL、显式区间、非法值）、服务层 SQL 拼装（无 `MATCH`、含同窗条件与参数顺序）、片段查询窗口参数、路由参数透传、前端档位→参数映射。
- `backend-ts` 全量 vitest、`admin` 全量 vitest 与 `npm run build` 通过。
