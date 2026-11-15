# 管理后台团队经验库管理界面重构技术方案

日期：2026-11-13。状态：已评审可行（同日子代理评审：文档代码事实引用全部核对命中、无事实性错误；评审发现的完善项已合入本文档），待实施。

## 0. 决策摘要

| # | 决策 | 说明 |
|---|------|------|
| D1 | 弹窗升级为独立路由页 `/experience` | 三栏工作台（库列表 / 文档列表 / 阅读编辑器）；AgentListView「经验库」按钮改为路由跳转，旧 Dialog 删除。理由：960px 弹窗放不下三栏，且用户诉求是"页面"级体验 |
| D2 | 不引入物理子目录，层级用元数据虚拟分组 | 文件系统 flat 是既有约束（basename 校验禁 `/`、scanDocs 只扫一层、Agent 按路标约定 flat 写入）；层级= Agent 库 → 月分组（默认，可切关键词分组/平铺） |
| D3 | 列表能力服务端化 | 分页/排序/搜索/筛选作为 `GET /docs` 的查询参数；实现为扫描一次 + 内存过滤排序分页（扫描本就全量，单库文档量级 ≤ 数百篇） |
| D4 | Markdown 渲染复用 `renderMarkdown` | 复用 `session/composables/useMarkdown.ts`（marked + DOMPurify + highlight.js + 代码复制），阅读器提供「渲染态 / 源码态」切换（仿 `WorkspaceFilePreviewDialog`） |
| D5 | 新增跨库总览端点 `overview` | 左栏库列表需要每库文档数/总大小/最近更新；顺带识别孤儿库（DB 中 Agent 已删但目录残留） |
| D6 | `INDEX.md` 行格式保持不变 | 它是 Agent 的 grep 检索协议（路标文案引导 grep 索引）；admin 侧仅做渲染展示，不解析改写，避免与 `indexLine` 格式耦合 |
| D7 | 权限沿用 `agent:read` / `agent:write` | 不新增权限码；页面路由 `agent:read`，写操作按钮级 `agent:write` 禁用；**新端点 overview 要求 `agent:read`**——跨库聚合是新增暴露面，不继承 GET docs 仅登录的旧口径（见 §4.1） |
| D8 | 搜索范围 v1 = 元数据 | fileName/title/keywords/summary/applicable 包含匹配；正文全文搜索列为后续可选（需读全文件，收益存疑） |
| D9 | URL 状态同步 | `/experience?agentId=&file=&page=` 可直达某篇文档，刷新/分享不丢上下文 |
| D10 | 索引展示独立端点 | `indexContent` 不再随 docs 列表返回（几百行文本每页都传浪费），拆 `GET …/experience-library/index` |

## 1. 背景与问题

### 1.1 现状

入口在 `AgentListView` 操作列「经验库」按钮（`admin/src/views/agent/AgentListView.vue:121`），打开 `AgentExperienceLibraryDialog.vue`（960px 弹窗）。后端六个接口见 `backend-ts/src/agent/agent-experience-library.routes.ts`（技术方案 2026-10-24 §4.1）。

### 1.2 用户痛点（本期逐条对应）

1. **文件多时列表失控**：`el-table` 一次平铺全库文档（`max-height=300`），无搜索、无筛选、无排序、无分页；几百篇时只能滚动肉眼找。
2. **看不了内容**：唯一的内容入口是「编辑」（textarea 原文），没有纯阅读视图；正文 Markdown 不渲染；`INDEX.md` 折叠在 `<pre>` 原文里，可读性差。
3. **不顺手、无层级**：一次只能看一个 Agent 的库（从列表页逐个点进去）；列表平铺无分组；编辑器内嵌弹窗底部与表格割裂；开关/刷新/新建/重建索引挤在一行工具条。

### 1.3 目标

- 独立页面承载：跨 Agent 库总览 → 单库文档浏览 → 单篇阅读/编辑，三级动线清晰。
- 列表具备搜索/筛选/排序/分组/分页全套能力（服务端实现）。
- 文档与索引均有渲染态阅读视图；编辑体验不回退（保留源码编辑 + 覆盖确认）。

### 1.4 非目标

- 不改挂载目录：`<shareDir>/agent-experience/<agentId>/`（D10，2026-10-24 方案）。
- 不改经验文件内容结构：frontmatter 字段（title/keywords/summary/applicable/last_verified）与正文自由格式均不动；`INDEX.md` 行格式不动。
- 不做物理子目录/目录树、全文检索、向量检索、去重合并、回收站（延续原方案非目标）。
- 不动 Agent 侧路标文案与注入逻辑。

## 2. 现状盘点（代码事实）

- **数据层**（`backend-ts/src/harness/experience/experience-index.service.ts`）：
  - 库目录 = `dirFor(agentId)`；`listDocs`（L91-96）= `ensureFresh`（陈旧自愈重建）+ `scanDocs` 全扫（每文件只读头部 64KB 解析 frontmatter，L202-227）+ 按文件名倒序；单篇上限 1MB（L14）。
  - `scanDocs` 只收 `isFile()`，子目录天然被忽略；文件名校验 `isValidExperienceFileName`（L317-326）禁路径分隔符与 `..` → 物理层级不可行，虚拟分组是唯一出路。
  - frontmatter 宽松解析（`experience-frontmatter.ts`），缺字段回落空值。
  - `listDocs` 内部实际扫描两次（`ensureFresh` 一次 + 自身一次），本次顺带合并为一次。
- **路由层**（`agent-experience-library.routes.ts`）：GET `/docs` 无任何列表参数，一次返回全量 `docs + indexContent`；`requireAgentDir` 校验 Agent 存在（不存在 404）→ 孤儿库目录在现有接口下不可访问。
- **软删残留**：agent 表有软删列 `deleted`（V052 迁移）；`AgentRepository.findById/findByIds` 均过滤软删，`deleteAgent` 只软删 DB 行、**不清理**经验目录 → 软删 Agent 的库目录必然残留（overview 的 orphan 判定依据，见 §4.3）。
- **admin 渲染范本**：`session/composables/useMarkdown.ts` 导出 `renderMarkdown`（原始 HTML 转义、http(s) 链接白名单、代码块复制、缓存）；`WorkspaceFilePreviewDialog.vue` 已示范「渲染态/源码态」切换与 `.wfp-markdown` 样式。
- **列表范本**：`memory/components/MemoryManagePanel.vue`（inline 筛选表单 + `ResponsivePagination` + `Record` 汉化表）、`approval/ApprovalRuleView.vue`（`page/size → total` 服务端分页）。
- **菜单/路由**：`utils/menuNav.ts` `menuGroups` 静态定义；路由 meta `{ title, keepAlive, permission }`（`router/index.ts`）。
- 无 DB 迁移（本方案不新增列/表）；无新内置工具、无新 LLM 调用场景 → 不触发 tool-result-summarizer / no-progress-notice / LlmCallScene 三处同步。

## 3. 信息架构与交互设计

### 3.1 页面布局（桌面三栏，窄屏降级）

```
┌─────────────┬──────────────────────────────┬──────────────────────────────┐
│ 库列表(左栏) │ 文档列表(中栏)                │ 阅读器(右栏)                  │
│             │                              │                              │
│ [搜索库]     │ [关键词搜索][筛选][排序][分组] │ 元数据卡（title/keywords/     │
│ ┌─────────┐ │ ┌──────────────────────────┐ │  summary/applicable/last_    │
│ │ Agent A │ │ │ 2026-11 · 12 篇          │ │  verified/大小/更新时间）      │
│ │ 24篇 ●启 │ │ │  ├ doc1 …                │ │ ─────────────────────────── │
│ │ Agent B │ │ │ 2026-10 · 8 篇           │ │ [渲染态|源码态|编辑]          │
│ │ 3篇 ○停 │ │ │  ├ doc2 …                │ │  # MySQL 死锁排查实录        │
│ │ …       │ │ │ …（分页：‹ 1 2 3 ›）      │ │  （Markdown 渲染正文）        │
│ └─────────┘ │ └──────────────────────────┘ │                              │
│ [孤儿库折叠] │ 操作：新建/重建索引            │ 底部操作：保存/取消（编辑态）   │
└─────────────┴──────────────────────────────┴──────────────────────────────┘
```

- 栅格：`260px | minmax(420px, 34%) | 1fr`（CSS grid）；`<1280px` 右栏并入中栏下方（点击文档滚动定位）；移动端（`Layout` 的 `isMobile`）左栏收成顶部下拉选择器。
- 页头（三栏之上）：页名 + 选中库的启用开关（`el-switch`，写权限才可操作）+ 索引「重建」按钮 + 帮助提示（复用现有 alert 文案：INDEX.md 系统生成勿手改等）。

### 3.2 左栏：Agent 库列表（第一层）

- 数据来自新端点 `overview`（§4.3）：每库一行 = Agent 名 + 开关状态点 + 文档数 + 总大小 + 最近更新时间。
- 顶部库搜索框（前端本地过滤，库数量级小）。
- 选中态高亮；默认选中 URL `agentId` 指定的库，否则第一个库。
- **孤儿库**折叠分组置底：灰色标记「Agent 已删除」+ 文档数；v1 仅展示不支持打开（现有 docs 接口 `requireAgentDir` 404，维持），提示可联系管理员用脚本清理——不提供页面级删除整目录的危险操作。

### 3.3 中栏：文档列表（第二层）

工具条（自左向右）：

1. **关键词搜索**：`el-input` + 回车/防抖触发，服务端匹配 fileName/title/keywords/summary/applicable（大小写不敏感包含）。
2. **筛选**：
   - 关键词标签下拉（facets：服务端聚合全库 keywords 拆分后的 distinct tag + 计数，Top 50 按计数倒序；单选，选中即按该 tag 过滤）。拆分规则见 §4.2 实现要点（兼容中文逗号/顿号/分号——frontmatter 解析不强制分隔符，Agent 旁路写入中文标点必现）。
   - 最后验证日期范围（`el-date-picker daterange`，对应 `last_verified`）。
   - 更新时间日期范围（对应文件 mtime）。
   - 「异常文档」开关：筛无 frontmatter / 无 title 的文档（巡检 Agent 沉淀质量用）。
   - 重置按钮。
3. **排序**：字段选择（更新时间/文件名/标题/最后验证/大小）+ 升降序；默认「文件名 倒序」（与现列表行为一致，日期前缀=新在前）。
4. **分组**：`月（默认）| 关键词 | 平铺`。
   - `月`：按文件名日期前缀 `YYYY-MM` 分组（无前缀的归「未命名」组），组间月份倒序固定，组内按所选排序；组头显示 `YYYY-MM · N 篇`（N 为服务端返回的全量组计数，不受分页影响）。
   - `关键词`：按文档首关键词分组（无 keywords 归「未分类」）；同样组计数服务端全量返回。
   - `平铺`：无组头，全列表按所选排序。
5. **分页**：`ResponsivePagination`，`page/size`（默认 size=20，最大 100），服务端分页按文档粒度（分组只影响展示与组头计数，不改变分页粒度——保证翻页连续无重叠）。

   上限说明：`size` ≤100 与 facets Top 50 是响应体规模护栏（单库文档量级 ≤ 数百，100 已覆盖单页全览；tag 数远小于文档数，50 覆盖绝大多数库）。Top 50 之外的 tag 可在搜索框直接输入文本经 keyword 包含匹配命中；如需完整 tag 列表，后续提供 `facets=all` 再议。

   组头口径：组头恒展示（计数取 `groupCounts` 全量值），某组在本页零可见行时不渲染行、仅保留组头；关键词分组键 = 按拆分规则取第一个非空 tag，无则归「未分类」。

列表行（表格或紧凑列表，跟随 admin 表格风格）：文件名（无 title 时 fallback 展示）、标题、关键词（前 2 个 tag + `+N`）、摘要（单行截断 tooltip 全文）、最后验证（距今 >180 天追加「久未验证」灰标，可选实现）、大小、更新时间、操作（查看/编辑/删除）。行点击 = 右栏打开阅读（同时写 URL）。

空态：无任何文档 → 引导文案「Agent 完成复杂任务后会自行沉淀，也可点击新建」；筛选无结果 → 「清空筛选」快捷按钮。

### 3.4 右栏：阅读器（第三层）

- **元数据卡**：title、keywords（tag 形式，点击 tag 联动中栏筛选）、summary、applicable、last_verified、文件名、大小、更新时间。
- **双态切换**（仿 `WorkspaceFilePreviewDialog.vue:17-44`）：
  - **渲染态**（默认）：`renderMarkdown(content)` + `v-html`，样式沿用 `.wfp-markdown` 体系（marked + DOMPurify 产物、代码块复制）。
  - **源码态**：只读 `<pre>` 展示原文，方便看 frontmatter 与复制。
  - **编辑态**（写权限）：textarea 源码编辑 + 保存/取消；保存走既有 PUT；新建场景预填 frontmatter 模板 + 默认文件名 `YYYY-MM-DD-<slug>.md`（日期自动、slug 用户填）；新文件撞名覆盖确认保留现有交互（`ElMessageBox.confirm`）。
  - INDEX.md 只可阅读（渲染态/源码态），无编辑态。
- **INDEX.md 入口**：中栏工具条最右侧固定一个「索引」页签式按钮，右栏切换为索引视图（同样渲染态/源码态；渲染后为 bullet 列表）。不做前端表格化解析——避免与后端 `indexLine` 格式（`experience-index.service.ts:265-273`）耦合，格式未来调整不需要前端跟改（D6）。
- 编辑保存成功后：局部刷新当前文档元数据 + 中栏列表 + 左栏计数（写接口后端已 `ensureFresh`，索引自动更新，无需手动重建）。
- **大文档渲染策略**：接近 1MB 文档首次渲染为主线程同步解析（百毫秒级卡顿，接受）；单代码块超 8000 字符自动退化为纯转义（无高亮、可复制）为 `useMarkdown` 既有行为。v1 不做分块/懒渲染；如需优化，后续用「超过 200KB 默认打开源码态」实现。
- **新建保存成功**：新 fileName 写回 URL `file` 参数（配合 §3.5 失效处理）。

### 3.5 状态与 URL 同步

- 同步进 query 的状态（`router.replace` 防历史堆积）：`agentId`、`file`、`page`，以及全部筛选/排序/分组条件（`keyword`/`tag`/`verifiedFrom`/`verifiedTo`/`updatedFrom`/`updatedTo`/`abnormal`/`sort`/`order`/`groupBy`；不筛不写的字段不带）——直达与刷新完整还原上下文；渲染态/源码态不入 URL。
- 直达 `/experience?agentId=3&file=2026-10-24-mysql-deadlock.md`：加载库 → 选中文档 → 右栏打开。
- **keepAlive 与 watch 守卫**：页面自身写 URL 会再触发 `watch(route.query)`，必须做「query 值与当前状态一致则跳过」守卫，防自触发循环与覆盖用户输入；keep-alive 组件 key 是 `route.path`（同 path 换 query 不重建组件），composable 用 `watch(() => route.query, …, { immediate: true })` 单向同步；`onActivated` 参考 `AgentListView.vue:491-501` 先例——首次激活跳过（onMounted 已拉），后续激活轻刷新 overview 计数。
- **file 参数失效处理**：删除当前打开文档 → 右栏回默认态并 `replace` 移除 `file`；新建保存成功 → 新 fileName 写入 `file`；直达 URL 的 file 不存在 → 拦截器统一 toast，右栏回默认态并移除 `file`，不白屏（重命名场景不存在：existing 时文件名禁改，沿现状）。
- keep-alive LRU 上限 `:max="8"`（`Layout.vue`）可能逐出本页——筛选状态已入 query，复活/刷新可完整还原。

### 3.6 加载与错误

- 沿用全局 `api` 拦截器 toast（组件内不重复弹错）。
- 左栏 overview / 中栏列表 / 右栏内容三块独立 loading（骨架或 v-loading），互不阻塞。

## 4. 后端设计

### 4.1 API 总表（`agent-experience-library.routes.ts`）

| 方法 | 路径 | 权限 | 变化 |
|------|------|------|------|
| GET | `/v1/agents/:id/experience-library/docs` | 登录 | **改**：新增查询参数（分页/排序/搜索/筛选/分组），响应去掉 `indexContent` |
| GET | `/v1/agents/:id/experience-library/index` | 登录 | **新**：返回 `{ fileName: 'INDEX.md', content, docCount }`；docCount 取索引头 `<!-- count: N -->`（`readIndexCount`），缺失回 0，不额外扫描 |
| GET | `/v1/agents/experience-library/overview` | 登录 + `agent:read` | **新**：跨库汇总 + 孤儿库识别；无权限 403（`requirePermission`，与文件内 `requireAgentWrite` 同风格） |
| GET | `/v1/agents/:id/experience-library/docs/content?file=` | 登录 | 不变 |
| PUT | `/v1/agents/:id/experience-library/docs/content` | agent:write | 不变 |
| DELETE | `/v1/agents/:id/experience-library/docs?file=` | agent:write | 不变 |
| POST | `/v1/agents/:id/experience-library/index/rebuild` | agent:write | 不变 |
| PATCH | `/v1/agents/:id/experience-library` | agent:write | 不变 |

权限口径：既有 GET docs/content 维持仅登录现状（不收紧，是否统一收紧另开任务再议）；**overview 是新增跨库聚合端点，暴露面从单库扩大到全库（多角色 admin 直调 API 可枚举全部 Agent 库元数据），不继承旧口径**，要求 `agent:read`。

**注册顺序注意**：`overview`（4 段路径，第 2 段为静态字面量 `experience-library`）与现有 `:id` 参数路由同前缀。find-my-way 静态段优先于参数段是 Fastify 保证；且经盘点 `/v1/agents` 下现有 4 段 GET 路由（`:id/prompt-versions`、`:agentId/experiences`）尾段均为与 `overview` 不同的静态字面量、5-6 段路由段数不符，实际冲突为零（仓内已有 `POST /v1/agents/avatar` 与 `POST /v1/agents` 静态/集合共存先例）；仍保留回归用例锁死。

### 4.2 GET /docs 参数化

Query 参数（全部可选）：

| 参数 | 类型/取值 | 默认 | 说明 |
|------|-----------|------|------|
| `page` | int ≥1 | 1 | |
| `size` | int 1-100 | 20 | |
| `sort` | `fileName\|title\|updatedAt\|sizeBytes\|lastVerified` | `fileName` | title/lastVerified 空值排该方向末尾 |
| `order` | `asc\|desc` | `desc` | |
| `keyword` | string ≤200 | — | fileName/title/keywords/summary/applicable 包含匹配，大小写不敏感 |
| `tag` | string ≤60 | — | keywords 拆分后的精确 tag 匹配（与 keyword 包含匹配互补）；拆分规则见下方实现要点 |
| `verifiedFrom`/`verifiedTo` | `YYYY-MM-DD` | — | `last_verified` 闭区间；空值文档不命中 |
| `updatedFrom`/`updatedTo` | `YYYY-MM-DD` | — | 文件 mtime |
| `abnormal` | `no-frontmatter\|no-title` | — | 异常文档巡检筛选 |
| `groupBy` | `none\|month\|keyword` | `none` | 只影响响应的 `groupCounts` |

响应：

```jsonc
{
  "enabled": true,
  "total": 47,          // 过滤后总数（分页用）
  "page": 1,
  "size": 20,
  "docs": [ /* ExperienceDocMeta[]，字段不变 */ ],
  "groupCounts": [ { "key": "2026-11", "count": 12 } ],  // groupBy!=none 时：过滤后全量分组计数
  "keywords": [ { "tag": "mysql", "count": 9 } ]          // 全库（未过滤）tag facets，Top 50
}
```

实现要点：

- **keywords 拆分规则**：按 `[\s]*[,，、;；][\s]*` 切分（兼容中文逗号/顿号/分号），过滤空串后去重；单 tag 保留原始大小写、匹配时大小写不敏感。
- 复用 `ExperienceIndexService.listDocs` 扫描产物做内存 filter → sort → paginate → group 聚合；`groupCounts`/`keywords` 聚合都在同一份扫描数组上完成，无额外 IO。
- **排序比较器**：fileName/title 用 `localeCompare`（中文主场景，与现 `listDocs` 一致）；updatedAt（ISO 串）/lastVerified（YYYY-MM-DD）字典序、sizeBytes 数值比较；title/lastVerified 空值排该方向末尾。`sort`/`order`/`groupBy` 必须服务端白名单枚举校验（不校验会透传进比较器）。
- 顺带重构：`listDocs` 重复扫描合并——现状新鲜路径 2 次扫描、陈旧路径 3 次（`ensureFresh` 扫 → `rebuild` 扫 → `listDocs` 再扫），收敛为 1 次：`ensureFresh` 无论是否触发重建都返回扫描产物复用。重构不影响 `writeDoc`/`deleteDoc`/`refreshIfUnderRoot`/会话挂载等只依赖「刷索引」副作用的调用方（已核实 `listDocs` 仅 admin 路由一处消费）。
- 参数非法（`size>100`、日期格式错、枚举外取值）→ `PARAM_INVALID`，与现有错误风格一致。

### 4.3 新增 GET /v1/agents/experience-library/overview

- 实现：`readdirSync(experienceRoot)` 收数字目录名 → 逐库 `scanDocs` 统计（docCount/totalBytes/lastUpdatedAt）→ `AgentRepository.findByIds` 批量取名称与 `experienceLibraryEnabled`（`findByIds` 含 `notDeleted()` 过滤，与 `getAgent` 同口径）。
- 响应：`{ libraries: [{ agentId, agentName, enabled, docCount, totalBytes, lastUpdatedAt }], orphans: [{ agentId, docCount, totalBytes, lastUpdatedAt }] }`。**orphan 口径**：目录存在但 `findByIds` 查不到的 Agent——含行不存在的硬孤儿与软删 Agent（`deleted=1`，软删库残留是常态产物）；orphan 不带 agentName。
- 「软删可恢复」与「彻底不存在」的细分 v1 不做，如需另开迭代。
- 性能：所有库全扫。单库数百篇 × 64KB 头读可接受；跨库总量增长后如需优化再缓存，v1 不做。
- 目录名非纯数字（人为误建）忽略；符号链接目录忽略（`ensureRealDir` 同款防御）。

### 4.4 约束（保持不变）

- 目录结构、frontmatter 字段、`INDEX.md` 行格式与生成逻辑、basename 校验、1MB 上限、INDEX.md 禁写/禁删、写后 `ensureFresh` 自愈——全部不动。
- Agent 侧（路标、挂载、写工具回调）零改动。

## 5. admin 前端设计

### 5.1 路由与菜单

- 路由（`router/index.ts`）：`{ path: 'experience', name: 'ExperienceLibrary', component: () => import('../views/experience/ExperienceLibraryView.vue'), meta: { title: '经验库管理', keepAlive: true, permission: 'agent:read' } }`。
- 菜单（`utils/menuNav.ts`）：`capability` 组内追加 `{ index: '/experience', label: '经验库管理', permission: 'agent:read' }`，置于「Agent 管理」之后；icon 选 `menuNav.ts` 已引入图标之一（如 `Collection`）或新增 `Notebook` import（二选一，实施时定）。
- `AgentListView` 两处「经验库」按钮（L121/L174）改为 `router.push('/experience?agentId=' + row.id)`；删除 `AgentExperienceLibraryDialog.vue` 及相关挂载代码（L209-216、L243）。

### 5.2 组件拆分（`views/experience/`）

```
ExperienceLibraryView.vue        # 页面骨架：三栏 grid、URL 状态、页头开关/重建
components/
  LibrarySidebar.vue             # 左栏：库列表 + 库搜索 + 孤儿库折叠
  DocListPanel.vue               # 中栏：工具条 + 分组列表 + 分页
  DocViewer.vue                  # 右栏：元数据卡 + 渲染/源码/编辑三态
composables/
  useExperienceLibrary.ts        # overview/docs/index 状态与加载、筛选条件、URL 同步
```

### 5.3 复用清单

- `renderMarkdown`（`session/composables/useMarkdown.ts`）——直接跨目录 import（`WorkspaceFilePreviewDialog` 已开先例）；如评审希望目录整洁，可提升到 `utils/` 并同步 session 两处 import（无行为变化，二选一，实施时定）。
- `.wfp-markdown` 文档正文样式：从 `WorkspaceFilePreviewDialog` 抽到公共 style（如 `src/styles/markdown-doc.css`）或复制精简版，避免跨视图 `:deep` 泄漏。
- `ResponsivePagination`、`ResponsiveDialog`（编辑态在小屏可用弹窗）、`formatDateTimeColumn`（`utils/datetime`）。
- 筛选表单交互仿 `MemoryManagePanel.vue`。

### 5.4 交互防回退清单（保留现有保障）

- 新建撞名覆盖确认（原 L188-198 逻辑迁移到 DocViewer 编辑态）。
- 新建场景前端拦截：content 为空串时提示「正文不能为空」不发请求（后端现状校验 `body.content == null` 会放行空串，错误消息与实际行为不符——后端不改，前端收口）。
- 文件名前端校验（`.md` 结尾、无路径分隔符）与后端校验并存。
- 删除二次确认；开关/重建按钮写权限禁用；INDEX.md 禁编辑提示。
- 图标按钮一律带 `aria-label`/`title`（AGENTS.md 规范）。

## 6. 被否决的备选方案

| 备选 | 否决理由 |
|------|----------|
| 物理子目录/目录树 | 违反 basename 校验与 scanDocs 单层扫描；破坏 Agent 写入约定与 INDEX.md 检索协议；目录属"挂载目录"约束范围 |
| 弹窗内增强（保持列表页+弹窗模式） | 三栏与长列表需要整页空间；用户明确要"页面"；memory 页已有独立页先例 |
| 前端本地分页/过滤 | 与 admin 既有服务端分页风格不一致；数据虽小但接口一次返回全量 docs 的带宽浪费现状正是痛点之一 |
| INDEX.md 前端解析成表格 | 与后端 indexLine 格式强耦合，格式演进要双端同步；直接 Markdown 渲染已够读 |
| 正文全文搜索 | 需读全文件（每库最坏数百 MB IO）；元数据搜索覆盖高频场景；列为后续可选 |

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| overview 全库扫描慢（库多且大） | v1 接受（与现单库扫描同量级 ×N）；如慢再引入短 TTL 缓存或按需扫描；接口独立可降级 |
| docs 接口 breaking（去 indexContent、响应结构变化） | 旧 Dialog 同任务删除，无其他调用方；AGENTS.md 重构不考虑存量兼容 |
| `overview` 与 `:id` 路由匹配冲突 | Fastify 静态段优先；加回归用例 |
| 虚拟分组键不稳定（关键词拆分质量依赖 Agent 沉淀） | 默认分组=月（仅依赖文件名日期前缀约定，最稳）；关键词分组为可选视图 |
| 无 last_verified 的文档在验证筛选下不可见 | 符合预期（筛"已验证过的"），另设 abnormal 筛选兜底巡检 |
| 孤儿库误判（Agent 软删/重建场景） | v1 仅展示统计不提供操作；打开行为维持 404 原状 |
| 渲染 XSS | 复用 renderMarkdown（DOMPurify + 原始 HTML 转义 + 链接协议白名单），不新造渲染器 |
| overview 每次打开页面即全库扫描并写审计留痕（`/v1/**` 在审计前缀内、不分方法） | 属既有审计类别（现有 GET docs 同样留痕），频度上升可接受；如日志量扰民，v2 参照 `AUDITED_READ_EXCLUDES` 模式做读取型豁免 |

## 8. 测试计划（Vitest + Playwright）

- `agent-experience-library.routes.spec.ts` 扩展：docs 分页/排序/搜索/tag（含中文逗号拆分）/日期区间/abnormal 各参数 happy path 与非法值 400（点名 `sort`/`order`/`groupBy` 白名单校验、`page/size` 0/负数/超限）；groupCounts 与 keywords 聚合正确性；overview（含 orphan 识别——软删 Agent 归 orphan、非数字目录忽略）与无权限 403；`/experience-library/overview` 不被 `:id` 路由吞掉的回归。
- `experience-index.service.spec.ts`：单次扫描重构后行为不变（陈旧自愈——含删除引发 count 不符——排序、frontmatter 容错回归）；`writeDoc/deleteDoc/refreshIfUnderRoot/会话挂载` 的 `ensureFresh` 行为回归。
- admin Playwright（`tests/admin.spec.ts` 风格）：新页面挂载、库切换、搜索过滤、文档打开渲染态、直达 URL `?agentId=&file=`、旧入口按钮跳转、URL file 指向已删文档的降级。
- 手工验收：窄屏降级布局、编辑保存后索引自动刷新、孤儿库展示、新建空内容拦截。

## 9. 文档同步清单（实施任务内完成，按 AGENTS.md 规范）

- `changelog/unreleased/2026-11-13-experience-library-admin-ux.md`：backend-ts（接口参数化 + 两个新端点）、admin（新页面 + 入口迁移）小节。
- `README.md` / `DEPLOY.md`：经验库管理入口描述如提及旧弹窗则同步。
- `skills/mao-cli/SKILL.md`：如涉及后台经验库问答则补充。
- 本方案与历史 review 文档不回改。

## 10. 工作量与分期

- **P1 后端**（docs 参数化 + listDocs 单扫描重构 + index/overview 两端点 + 测试）：约 1 人日。
- **P2 admin**（路由/菜单 + 四组件 + composable + 复用样式抽取 + 旧弹窗删除 + Playwright）：约 1.5~2 人日。
- **P3 后续可选**：正文全文搜索、批量删除/批量打标、库级快照导出、孤儿库清理、last_verified 过期提醒升级为正式功能。
