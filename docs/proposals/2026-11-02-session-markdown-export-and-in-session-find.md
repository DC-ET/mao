# 提案：好不容易问明白的结论别沉底 —— 会话导出 Markdown 与长会话过滤补完

> 会话越来越长、积累的结论越来越多之后，用户在「把结果带走」和「在会话里回头找」两件事上各撞一堵墙：
> 1. **带不走可读文档**：右键会话只有「导出 JSONL」（一行一条机器 schema，给脚本消费的），而早在 [2026-10-06 会话分享与导出技术方案](../plan/2026-10-06-session-share-export-technical-design.md) §2.1 / §5.6 就设计定稿的「导出 Markdown」至今未落代码——用户想把一整段排查过程或报告沉淀到飞书文档 / Wiki / 本地笔记，只能一条条点气泡底部的复制再手工拼。
> 2. **长会话里找不着北**：跨会话搜索（`SessionSearchPopover`）无法限定「只搜当前会话」，且只有主会话和边路任务有「轮次目录（`RoundDirectory`）」，**只读分享页（`ShareView.vue`）和子代理面板连轮次目录都没有**；超过 20 轮的会话打开轮次目录还要在一长串列表里肉眼扫。

- 状态：**已否决，存档勿再评审**（2026-11-02 评审驳回）
- 日期：2026-11-02
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小~中（P1 Markdown 导出约 1.5 人日；P2 轮次目录搜索 + 分享页/子代理目录 + 单会话搜索约 1.5 人日；**零迁移**）
- 关联：`backend-ts/src/session/session-export.service.ts`、`backend-ts/src/session/session-share.routes.ts`、`desktop/src/utils/sessionShare.ts`、`desktop/src/components/task/TaskContextMenu.vue`、`desktop/src/components/task/SideTaskList.vue`、`desktop/src/components/chat/RoundDirectory.vue`、`desktop/src/views/share/ShareView.vue`、`desktop/src/components/search/SessionSearchPopover.vue`

## 1. 背景与现状

### 1.1 导出只停在「机器格式」，人类可读格式缺位（代码可查）

| 能力 | 现状 | 代码证据 |
|---|---|---|
| JSONL 导出 | ✅ `GET /v1/sessions/:id/export/jsonl`（首行 meta + 每行消息 JSON，供脚本与压缩归档同构消费） | `session-share.routes.ts:63-68`、`session-export.service.ts:29-42` |
| Markdown 导出 | ❌ 技术方案 `2026-10-06-session-share-export-technical-design.md` §5.6 已写明完整规格，但后端路由与前端菜单只落了 JSONL | `TaskContextMenu.vue:11,18`（仅「导出 JSONL」） |
| 分享页导出 | ❌ 同事打开 `/share/:token` 看到精彩排查，页面上没有任何「下载 Markdown / 复制全文」出口 | `ShareView.vue:6-37` |

### 1.2 长会话内部检索与导航的三处小断点

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 轮次目录（`RoundDirectory.vue`） | ✅ 主会话与边路任务右侧有把手，点开列出已加载轮次 | `ChatPanel.vue` / `SideChatPanel.vue` |
| 轮次目录内过滤 | ❌ 50 轮长会话展开目录后无搜索框，只能上下滚；也不标识哪一轮含代码块 / 表格 / 文件变更 | `RoundDirectory.vue` |
| 分享页 & 子代理面板的轮次目录 | ❌ `ShareView.vue` 与 `SubagentChatPanel.vue` 均未挂载 `RoundDirectory`，长分享链接只能盲滚「加载更多」 | `ShareView.vue:11-21`、`SubagentChatPanel.vue` |
| 全局搜索限定「当前会话」 | ❌ `SessionSearchPopover` 过滤器只有「Agent / 日期 / 主会话或边路」，在某个长会话里想搜一个三天前出现过的报错词，搜出来是全实例几十个会话的混合结果 | `SessionSearchPopover.vue:42-61`、`message-search.ts:26-37` |

## 2. 目标 / 非目标

**目标**

1. **P1 会话导出为 Markdown（补齐 2026-10-06 方案遗留）**：
   - 新增 `GET /v1/sessions/:id/export/markdown`（复用 `SessionExportService.loadAllMessages` 的全量分页拉取与 5MB 体积护栏，零新依赖）；
   - 输出结构清晰、可直接贴入飞书文档 / GitHub Issue / Obsidian 的 `.md` 文件：会话元信息头（标题 / Agent / 时间 / 工作区）→ 按轮次展开「用户提问 + 工具步骤摘要（复用已落库的 `tool_calls[].summary`）+ 助手回答（剥离内部 marker，保留 `[n]` 引用上标并在轮末附来源链接列表）」→ 末尾汇总「文件变更清单（路径 / 类型 / ±行数）」；
   - 任务列表右键菜单、边路任务右键菜单新增「导出 Markdown」（与「导出 JSONL」并列）；只读分享页 `ShareView.vue` 顶栏新增「导出 Markdown」按钮（按分享水位截断导出，登录链接与公开链接同享）。
2. **P2 长会话内快速定位**：
   - `RoundDirectory.vue` 顶部增加轻量关键词过滤框（纯前端内存过滤已加载轮次的提问与回答摘要，零后端请求），并在轮次行尾显示小图标提示该轮是否含「文件变更 / 代码块」；
   - `ShareView.vue` 与 `SubagentChatPanel.vue` 同步接入 `RoundDirectory`；
   - `SessionSearchPopover.vue` 在当前正处于某个会话时，过滤栏增加「仅当前会话」快捷切换（后端 `/v1/sessions/search` 的 `SearchListParams` 增加可选 `sessionId` 过滤，下推 `s.id = ?`，10 行代码以内）。

**非目标**

- 不做 PDF / Word / HTML 导出（已在 2026-10-06 方案中明确排除，服务端无排版引擎依赖，Markdown 是最通用且零依赖的交付格式）。
- 不重启 0.0.358 已移除的「任务列表标题过滤」与「只看回复开关」——本提案解决的是**单个长会话内部**的定位与导出，不碰左侧会话列表头部。
- 不做「交付物中心」（2026-10-24 已否决）——不建表、不登记资产，只是会话自身的即时流式下载。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 交付物中心（2026-10-24 否决） | 不建 `artifact` 表、无跨会话聚合、无内置工具；只是既有 `SessionExportService` 增加一种 `.md` 序列化格式。 |
| 结构化回复卡片（2026-10-19 否决） | 不改消息协议与气泡渲染。 |
| 0.0.358 移除的「只看回复」开关 | 不隐藏对话流里的 DOM 节点（曾引发流式自动跟随冲突），而是在侧边 `RoundDirectory` 抽屉与导出文件里做结构化提炼，零滚动副作用。 |

## 4. 方案设计

### 4.1 P1：`SessionExportService.renderMarkdown` 与路由

- **完全复用取数链路**：`SessionExportService` 已有 `loadAllMessages(sessionId, parentId)`、`withoutParentCopies`、`changesForMessages`、`aggregateChanges` 与 `EXPORT_MAX_BYTES`（5MB 413 护栏）。只需新增 `renderMarkdown(session): Promise<{ filename: string; markdown: string }>`：
  - 文件名复用 `sanitizeExportFileName`，后缀改为 `.md`；
  - 用户消息：走与前端一致的剥离图片注入行口径，保留干净正文；
  - 助手消息：剥离 `thinkingContent`（与 JSONL 导出及分享视图一致，内部思考不外泄）；若 `metadata.citations` 非空，将正文中的 `[^n^]` 转为标准 Markdown 链接或末尾「参考来源」列表（让导出的 Markdown 离开 Mao 后引用依然可点！）；
  - 工具调用：默认折叠在 `<details><summary>执行了 N 个步骤</summary>...</details>` 块内，逐行输出 `tool_calls[].summary`（GHub / 飞书 / 语雀 / Notion 均原生支持 `<details>` 折叠，既保留排查证据，又不让几百行工具调用淹没正文结论）。
- **分享页导出**：`GET /v1/share/:token/export/markdown`（及公开链接 `/v1/share/public/:token/export/markdown`），校验链 100% 复用 `shareService.requireReadable + requireLiveSession`，消息上界传入 `maxMessageId: share.messageWatermark`，确保水位之后的消息绝不泄漏。

### 4.2 P2：轮次目录增强与「仅当前会话」检索

- **`RoundDirectory.vue`**：
  - 当轮次数 `>= 5` 时顶部显示紧凑搜索框 `筛选本会话轮次…`，实时匹配该轮用户提问文本与助手回复文本；
  - 挂载到 `ShareView.vue` 与 `SubagentChatPanel.vue`（组件本身只接收 `messages` 数组与 `@select="scrollToMessage"` 事件，无强耦合 store）。
- **`/v1/sessions/search` 支持 `sessionId`**：
  - `normalizeSearchListParams` 增加可选正整数 `sessionId`；`searchWhere` 在 `sessionId != null` 时追加 `AND s.id = ?`；
  - `SessionSearchPopover.vue` 打开时若 `route.params.id` 存在，过滤栏显示「仅当前会话」胶囊按钮（点击一键锁定/解锁当前会话 ID），查全篇历史不必再从几十个会话里翻。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | `session-export.service.ts` 新增 `renderMarkdown`；`session-share.routes.ts` 新增 `/v1/sessions/:id/export/markdown` 与分享导出端点；`message-search.ts` / `session.repository.ts` 搜索可选 `sessionId` 参数 |
| desktop | `sessionShare.ts` 新增 `downloadSessionMarkdown`；`TaskContextMenu.vue` / `SideTaskList.vue` / `ShareView.vue` 加导出入口；`RoundDirectory.vue` 加内联筛选与挂载到分享页/子代理；`SessionSearchPopover.vue` 加「仅当前会话」切换 |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 超长会话导出拼接撑爆内存 | 沿用 `SessionExportService` 既有 200 页 × 50 轮上限与 `EXPORT_MAX_BYTES = 5MB` 硬护栏，超限返回 413 提示 |
| 分享链接导出绕过水位截断或属主状态校验 | 分享导出端点强制复用 `shareService` 同款 `requireReadable` + `requireLiveSession` + `maxMessageId: share.messageWatermark` |
| 用户消息里的内部注入标记（如 `[图片 1] http...`）漏进 Markdown | 复用后端既有的可见文本提取与引用剥离工具函数，单测断言不含内部标记与 `thinkingContent` |

## 7. 测试要点

1. Markdown 导出结构快照：含元信息、多轮对话、`<details>` 工具步骤摘要、引用来源链接、文件变更汇总表；不含 `thinkingContent` 与图片内部注入行；超过 5MB 抛 `EXPORT_TOO_LARGE`（413）。
2. 边路任务导出：不含父会话复制过来的历史消息（复用 `withoutParentCopies`）。
3. 分享导出：水位之后新增的消息不出现在导出的 Markdown 中；已撤销 / 过期 / 属主停用的分享 token 导出返回 404 / `SHARE_NOT_FOUND`。
4. 搜索 `sessionId` 过滤：传入 `sessionId` 时只返回该会话内的命中消息；跨用户 `sessionId` 因既有 `s.user_id = ?` 约束返回空结果，不越权。

## 8. 待确认决策

1. 右键菜单里「导出 Markdown」与「导出 JSONL」是并列两项（推荐，直观），还是合并为「导出 ▸ Markdown / JSONL」二级菜单？
2. Markdown 导出里的工具调用步骤：默认用 `<details>` 折叠块包裹（推荐，兼顾可读性与完整性），还是纯列表平铺？
3. 分享页（`ShareView.vue`）顶栏是否允许访客点击「导出 Markdown」下载当前分享快照？（建议**允许**：访客本就可读全文，提供下载能显著提升分享链接在团队周报/复盘中的实用度）。
