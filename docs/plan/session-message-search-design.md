# 会话消息搜索（顶部栏搜索浮窗）技术方案 v2

> 状态：待评审（已按评审意见 v1 → v2 修订）· 关联代码：`desktop/src/components/common/TopNav.vue`、`backend/.../session/`、`desktop/src/composables/useCenterTabs.ts`
> 本文档只描述实现方案，不包含任何代码改动。评审通过后再进入实施。

## 1. 需求背景

客户端目前定位历史会话只有一条路径：左侧任务栏按工作区分组预览（每组默认 5 条），会话多了之后很难找到"当初聊过某件事"的会话。现有 `GET /v1/sessions` 的 `keyword` 参数只按**会话标题**模糊匹配，无法按消息内容检索；而用户真正记住的往往是说过的一句话。

要解决这个问题，需要在顶部操作栏增加一个搜索入口：输入关键词，按**用户发送的消息内容**匹配会话，快速跳转。搜索必须由后端完成——前端内存只缓存已打开会话的消息（`sessionMessages` 按会话按需加载），不持有全量消息，纯前端过滤必然漏结果。

## 2. 需求描述（已确认的决策）

1. **入口**：顶部操作栏（`TopNav` 右侧按钮区）新增放大镜图标；同时支持 `Ctrl/Cmd + K` 快捷键唤起/关闭浮窗（与现有 `Ctrl+\`` 终端快捷键互不冲突）。
2. **浮窗**：锚定放大镜图标的下拉浮窗，内含搜索输入框；打开时自动聚焦；点击外部或按 `Esc` 关闭。
3. **匹配语义（明确）**：只匹配该会话中**角色为 user 的消息「用户可见文本内容」**，`包含搜索词`（子串匹配）即算命中。图片 URL、多模态 JSON 结构字段（`type`、`image_url`、`text` 等）**不参与匹配**（详见 3.1）。
4. **搜索范围**：`NORMAL` 主会话 + `SIDE_TASK` 边路会话；**排除** `SUBAGENT` 子代理会话；**排除** `ARCHIVED` 已归档会话（只搜 `ACTIVE`）。
5. **排序**：按 `session.updated_at` 倒序（消息落库时 `SessionService.saveMessage` 会刷新 `updated_at`），`updated_at` 相同按 `id` 倒序保证稳定。
6. **条数上限**：最多返回 **20 条**，服务端硬性封顶；**接口不暴露 `limit` 参数**（需求固定 20 条，无需可配）。
7. **结果条目内容**：会话标题 + 类型标签（主会话 / 边路）+ 最近更新时间 + 命中消息文本片段（围绕关键词生成，总长约 50～80 字，必然包含关键词，前端高亮）。
8. **跳转**：
   - 主会话命中项 → 路由 `/tasks/{id}`；
   - 边路会话命中项 → 路由 `/tasks/{parentSessionId}`（父会话），并在该会话页面内打开对应边路任务 Tab。
   - **不做**"跳转后自动滚动定位到命中消息"——只跳会话页面。
9. **键盘交互**：浮窗内 `↑`/`↓` 移动选中项、`Enter` 跳转、`Esc` 关闭。

### 明确不做

- 不搜索 `SUBAGENT` 子代理会话、不搜索 `ARCHIVED` 归档会话、不搜索孤儿边路会话（父会话不存在 / 非 ACTIVE / 非同用户 / 非 NORMAL）。
- 不匹配 `ASSISTANT` / `TOOL` 角色消息。
- 不匹配图片 URL、JSON 结构字段（见 3.1 的二次校验）。
- 不做分词、全文索引（FULLTEXT）、Elasticsearch。
- 不做结果分页 / "加载更多" / 搜索历史 / 热门词 / 收藏过滤。
- 不做"点击结果后定位到具体消息"。
- 搜索接口**不暴露 limit**，固定 20。

## 3. 技术选型

### 3.1 后端检索：MySQL `LIKE` 候选 + Java 纯文本二次校验（定）

**检索方式**：MySQL `LIKE '%kw%'` 子串匹配（大小写不敏感由库表 collation 保证），配合**两层过滤**保证语义正确：

- **第一层（SQL）**：`message.content LIKE '%kw%'` 取候选（覆盖纯文本消息与多模态 JSON 原文），同时过滤 `s.user_id`、`session_type IN ('NORMAL','SIDE_TASK')`、`status='ACTIVE'`、`m.role='USER'`、`m.deleted=0`。
- **第二层（Java 内存）**：对候选会话的命中消息逐条解析 `content`，提取用户可见纯文本（JSON 数组 → 拼接 `text` 部分，图片 URL 丢弃；纯文本直接使用），做**真实子串校验**。文本真正命中才产出结果与 snippet；否则跳过该消息继续查下一条候选，全无文本命中则剔除该会话。

这样确保：图片 URL / JSON 字段名造成的 SQL 假命中不会进入结果，snippet 必然包含关键词，前后端高亮一致。

**明确接受的边界**：SQL 第一层可能多取少量假命中候选，第二层过滤后最终结果可能**不足 20 条**（"最多 20 条"，允许不足）。候选查询 `LIMIT 20` 后过滤，不额外放宽候选数。

**大小写规则**：数据库侧 `utf8mb4` 默认 collation 不区分大小写（`A`= `a`）；Java 侧用大小写不敏感定位（`indexOf` 前对文本与关键词做 `toLowerCase`），英文关键词行为一致，中文无大小写问题。

**关键词安全**：
- 缺少 `keyword`：参数错误（400）。
- trim 后为空：返回空列表（`data.items=[]`），便于前端空态。
- 长度 > 100 字符：参数错误（400）；前端输入框设 `maxlength=100`。
- `%`、`_`、`\` 以反斜杠转义（防通配符注入），SQL 显式 `ESCAPE '\\'`；参数一律 MyBatis `#{}` 绑定，禁止 `${}`。

**孤儿边路保护**（边路会话必须可达）：命中 `SIDE_TASK` 需满足其父会话存在且 `user_id` 相同、`deleted=0`、`status='ACTIVE'`、`session_type='NORMAL'`（`SessionService.deleteSession` 目前不级联删边路会话，孤儿保护必要）。

### 3.2 命中片段（snippet）生成（定）

**不取消息开头前 50 字**（关键词可能位于长消息中段），改为围绕首次命中位置生成：

1. 提取该消息纯文本；
2. 大小写不敏感定位首次命中位置；
3. 命中词前后各保留约 25 字上下文（命中词本身完整保留）；
4. 总长度控制在约 50～80 字；前后被截断时补 `…`。

示例：`……前面的上下文 登录页面为什么报 500 错误 后面的上下文……`

"取哪条消息"：取该会话 `message.id ASC` 中第一条**文本真正命中**的 user 消息（第二层校验通过的那条），保证 snippet 与命中一致。

### 3.3 接口：新增 `GET /api/v1/sessions/search`（定）

- 放在 `SessionController`，按认证主体 `userId` 硬过滤。
- 入参：`keyword`（必填，行为见 3.1）；**无 `limit` 参数**，服务端固定 `LIMIT 20`。
- 出参：`Result<SessionSearchVO>`：

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "id": 123,
        "title": "修复登录 Bug",
        "sessionType": "NORMAL",
        "parentSessionId": null,
        "updatedAt": "2026-08-07 10:30:00",
        "phase": "COMPLETED",
        "agentName": "默认 Agent",
        "snippet": "……前面的上下文 登录页面为什么报 500 错误 后面的上下文……"
      }
    ]
  }
}
```

### 3.4 前端：`SessionSearchPopover.vue` + 模块级 Tab 打开函数（定）

- 新组件 `desktop/src/components/search/SessionSearchPopover.vue`，挂 `TopNav` 的 `nav-right`（放大镜图标，风格与现有图标按钮一致）。
- `ElPopover` 承载浮窗 + `ElInput` 输入框；输入防抖 300ms；空关键词不发请求。
- **搜索竞态控制（必做，见 4.6）**：递增 request sequence + `AbortController` 取消旧请求，保证旧响应不覆盖新结果。
- 边路跳转：`desktop/src/composables/useCenterTabs.ts` 导出**模块级函数** `openSideTaskTabFor(parentSessionId, sideSessionId, title, phase)`，**始终按显式 `parentSessionId` 写模块级单例 `sessionTabsMap`，不依赖模块级 `currentSessionId`**（`router.push` 完成 ≠ 页面 `loadSession` 完成，但 Tab Map 是模块级单例、与路由加载解耦，见 4.8）。
- 深色主题与安卓 WebView：沿用 `--aw-*` CSS 变量；移动端保留图标点击入口（快捷键不注册，见 4.7）。

### 3.5 权限说明（修正）

接口要求登录（Spring Security 提供 `userId`），**数据隔离靠 SQL 硬过滤 `s.user_id = #{userId}`**。`PermissionInterceptor` 会经过该路径，但接口**不添加 `@RequirePermission`**，因此不会执行细粒度权限码校验（`PermissionInterceptor` 无注解时直接放行，见 `PermissionInterceptor.java:25`）；`AuditInterceptor` 正常记录审计。**不**给客户端接口加 `@RequirePermission("session:read")`——该权限码主要用于管理侧，未保证授予所有普通用户。

## 4. 实现步骤

### 后端（`backend/`）

**4.1 `SessionMapper` 新增两条查询（MyBatis 注解，`#{}` 绑定）**

查询一（候选会话，`LIMIT 20`）：

```sql
SELECT DISTINCT s.id, s.title, s.session_type, s.parent_session_id, s.phase, s.updated_at, s.agent_id
FROM session s
JOIN message m ON m.session_id = s.id AND m.deleted = 0
WHERE s.user_id = #{userId} AND s.deleted = 0
  AND s.session_type IN ('NORMAL', 'SIDE_TASK')
  AND s.status = 'ACTIVE'
  AND m.role = 'USER'
  AND m.content LIKE CONCAT('%', #{escapedKeyword}, '%') ESCAPE '\\'
  AND (
    s.session_type = 'NORMAL'
    OR EXISTS (
      SELECT 1 FROM session p
      WHERE p.id = s.parent_session_id
        AND p.user_id = s.user_id
        AND p.deleted = 0
        AND p.status = 'ACTIVE'
        AND p.session_type = 'NORMAL'
    )
  )
ORDER BY s.updated_at DESC, s.id DESC
LIMIT 20
```

> 说明：`OR EXISTS` 语义——`NORMAL` 会话直接满足；`SIDE_TASK` 必须存在有效父会话（同用户、未删、ACTIVE、NORMAL），孤儿边路不返回。（v1 的 `NOT EXISTS` 写法逻辑写反，v2 已修正。）

查询二（候选会话的命中消息，一次取回避免 N+1，`LIMIT 200` 兜底）：

```sql
SELECT m.session_id, m.id, m.content
FROM message m
WHERE m.deleted = 0 AND m.role = 'USER'
  AND m.session_id IN (#{candidateIds})
  AND m.content LIKE CONCAT('%', #{escapedKeyword}, '%') ESCAPE '\\'
ORDER BY m.id ASC
```

**4.2 `SessionService` 新增 `searchSessionsByUserMessage(Long userId, String keyword)`**

1. 关键词预处理：`trim`；空 → 返回空列表；>100 字符 → 抛参数错误；`%`/`_`/`\` 转义。
2. 查询一取候选会话（≤20）。
3. 查询二按候选 `session_id IN (...)` 一次取回命中消息（同一关键词转义值）。
4. 内存处理：按 `session_id` 分组，按 `id ASC` 逐条解析 `content`（JSON 数组 → 拼接 text，图片 URL 丢弃）→ 大小写不敏感子串校验 → 第一条文本命中的消息生成 snippet（围绕命中词，前后各 ~25 字，截断补 `…`，总长 ~50-80 字）；无文本命中剔除该会话。
5. 按 `updated_at DESC, id DESC` 返回（候选已排序，过滤后保持原序）。
6. 批量加载 `agentName`（复用 `batchLoadAgents` 逻辑或传 agentId 列表）。

**4.3 `SessionController` 新增 `GET /v1/sessions/search`**

- `@AuthenticationPrincipal Long userId` + `@RequestParam String keyword`；
- keyword 校验按 3.1 规则；
- 返回 `Result<SessionSearchVO>`（`items`）。

**4.4 单测**（`backend/src/test/`，随 `mvn test` 运行）：

- 命中 user 消息返回会话；未命中返回空。
- 边路会话命中（父会话 ACTIVE）返回；**孤儿边路**（父已删 / 父 ARCHIVED / 父非 NORMAL / 父属其他用户）不返回。
- 子代理会话不返回；归档会话不返回。
- 上限 20 条；`updated_at` 倒序、同时间按 id 倒序。
- 关键词转义：单独 `%`、单独 `_`、单独 `\`、组合 `\%`、`\_` 均按普通字符匹配，不透配。
- 空关键词返回空列表；缺参抛参数错误；超长关键词抛参数错误。
- **多模态假命中**：图片消息 content 含 `"image_url"`/图片 URL，但纯文本不含关键词 → 不返回；图片消息文本部分含关键词 → 返回且 snippet 为纯文本。
- snippet 生成：关键词位于消息中段时片段包含并高亮关键词；纯文本与 JSON 数组两种 content 形态。
- 英文大小写命中与 collation 一致（`Login` 命中 `login`）。
- 消息 `deleted=1` 不参与匹配。

**4.5 性能验证（上线前必做）**

- 用接近真实数据量执行 `EXPLAIN ANALYZE`，确认 `message(session_id, ...)`、`session(user_id)` 索引被利用（`LIKE '%kw%'` 本身无法走内容索引，但 session/message 关联与过滤条件应走索引）。
- 记录典型用户消息量下的 P95 响应时间并写入实现记录。
- 若性能不达标，按序评估（**不在本次实现，仅记录预案**）：`message(session_id, deleted, role, id)` 复合索引 → `session(user_id, status, session_type, updated_at, id)` 复合索引 → 独立可搜索纯文本列 → 全文检索。
- 已识别权衡：查询按**单个用户隔离**（不是"系统只有单用户"）；候选查询最多 20 条 + 一次消息批量查询，**共 2 次 SQL**，无 N+1（v1 的逐会话查片段方案已废弃）。

### 前端（`desktop/`）

**4.6 搜索竞态控制（必做）**

- 组件内维护 `requestSeq` 自增计数：每次发起请求 `const seq = ++requestSeq`，仅 `seq === requestSeq` 的响应（成功或失败）允许更新状态；
- 同时用 `AbortController` 取消旧请求（axios 支持 `signal`）；
- 关闭浮窗 / 清空输入 / `onUnmounted` 时：清除防抖定时器、`abort()` 在途请求、`requestSeq++` 使旧响应失效；
- 空关键词：立即清空结果并 `requestSeq++` 失效旧请求；
- 错误响应只更新当前有效请求的错误态。

**4.7 快捷键与未登录规则（定）**

- 全局 `keydown` 监听（`onMounted` 注册、`onUnmounted` 移除）：
  - 忽略 `event.repeat`；
  - `e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)`；
  - 浮窗已打开 → 关闭；
  - 浮窗未打开 → 打开并 `e.preventDefault()`（**不依赖普通输入框是否聚焦**；`contenteditable`/代码编辑器等特殊区域的让位策略：v1 不做特判，统一拦截，如后续发现与编辑器快捷键冲突再单独处理）；
- Android（Capacitor）不注册桌面键盘入口，保留图标按钮；
- **未登录（无 token）时无法进入主界面**：路由守卫会重定向到 `/login` 登录页，顶栏与搜索入口不存在，自然不发起搜索请求。（v1 设计中的「唤起登录对话框」已随登录页改造移除。）

**4.8 `useCenterTabs.ts` 模块级边路跳转（定）**

- 新增导出模块级函数 `openSideTaskTabFor(parentSessionId: string, sideSessionId: number, title: string)`：
  - 按 `parentSessionId` 取/建单例 `SessionTabState`（**不用模块级 `currentSessionId`**）；
  - 先调 `unmarkSideTaskClosed(parentSessionId, sideSessionId)`（v2 新增，见 4.9），清除"用户曾关闭"记录——否则刷新后 `restoreSideTaskTabs` 会因关闭记录跳过该 Tab；
  - 已存在同名 `side_task` Tab（按 `sideSessionId` 匹配）→ 仅激活；否则 push 新 Tab 并激活；
  - 替换 Map 引用触发响应式（`notifyTabsChanged` 等价逻辑）；
  - **不设置 `activeTabId='chat'`**；`restoreSideTaskTabs` 后续执行时按 `sideSessionId` 去重、不覆盖已激活 Tab（该函数当前不写 `activeTabId`，基础可用）。
- `SideTaskItem` 记录：搜索组件同时调 `sessionStore.addSideTask(parentId, { id, title, phase: item.phase || 'IDLE', modelId })`——**phase 用搜索结果真实值**（v1 硬编码 `'IDLE'` 会让运行中/已完成/待审批的边路任务显示错误状态）；**不传 `createdAt`**（搜索结果只有 `updatedAt`，不得用更新时间冒充创建时间）。

**4.9 `side-task-tabs.ts` 新增 `unmarkSideTaskClosed`**

与 `markSideTaskClosed` 对称：从 `localStorage` 的关闭记录中移除该 `sideSessionId`。搜索打开边路 Tab 前调用。

**4.10 `SessionSearchPopover.vue`（新组件）**

- 状态机：`closed` / 空关键词空态（"输入关键词搜索会话"）/ `loading` / `empty`（"未找到相关会话"）/ `error` / `results`。
- 交互：300ms 防抖；`↑`/`↓` 循环移动选中、`Enter` 跳转选中项、`Esc` 关闭；点击条目跳转；跳转后关闭浮窗并清空输入。
- 跳转：
  - `NORMAL`：`router.push('/tasks/' + item.id)`。
  - `SIDE_TASK`：若当前路由已在父会话则直接 `openSideTaskTabFor`；否则 `await router.push('/tasks/' + parentSessionId)` 后调用（`loadSession` 异步完成与否不影响——Tab Map 模块级、按显式 parentSessionId 写入）。
- **高亮（不用 `v-html`，防 XSS）**：对 snippet 与关键词做大小写不敏感 `indexOf` 计算匹配区间，生成"普通文本段 / 命中段"数组，模板用插值 + `<mark>` 渲染；服务端 snippet 只作纯文本展示。
- 相对时间：**不声称复用公共工具**（现有 `formatElapsed` 内联在 `TaskIndexPanel.vue` 且基于 `createdAt`，与搜索的 `updatedAt` 语义不同）；搜索组件内自建简单实现（刚刚 / N分 / N小时 / N天 / N月 / N年），展示 `updatedAt`。
- 响应式尺寸（安卓窄屏适配）：

```css
width: min(420px, calc(100vw - 24px));
max-height: min(480px, calc(100vh - var(--aw-nav-height) - 24px));
```

- 安卓软键盘场景验证：输入框可见、结果列表可滚动、点击结果不被键盘遮挡、safe-area 正常。

**4.11 `TopNav.vue` 集成**

- `nav-right` 首部插入放大镜图标按钮（tooltip "搜索会话 (Ctrl+K)"），绑定 `ElPopover`；
- 接入 4.6/4.7 的快捷键与未登录处理。

**4.12 E2E**（`tests/desktop.spec.ts`，修正 v1 描述）

- 现有文件**没有 `login()` 辅助函数**，采用 `mockDesktopApiFallback`（`page.route('**/api/v1/**')`）mock API：
  - 在 fallback 中**显式增加 `/sessions/search` 分支**（pathname `includes('/sessions/search')`，返回构造的搜索结果）；注意与既有 `endsWith('/sessions')` 判断互斥——`/sessions/search` 以 `/search` 结尾不会误命中 `/sessions` 分支，但需显式注册避免落到 `data: null` 兜底；
  - 预置登录 token（`page.addInitScript` 写 localStorage，参考现有主题测试注入方式）或复用当前文件已有认证方式；
- 用例：点击图标/触发快捷键打开浮窗 → 输入关键词 → 断言请求参数（`keyword`）→ 断言结果渲染、关键词高亮 → 断言主会话跳转路由；
- 边路会话跳转用例：断言父路由 `/tasks/{parentId}` 且边路 Tab 被激活；
- 未登录用例：断言未登录访问 `/` 停在 `/login`，且不发起 `/sessions/search` 请求。

**4.13 收尾**

- 更新根目录 `CHANGELOG.md`：`### 后端`（搜索接口）、`### 前端（桌面 / Web / 安卓）`（顶部搜索浮窗）各记一条。
- 后端重启由用户执行（Agent 不重启服务）；前端走 `deploy-desktop.sh` 部署。

## 5. 落地清单（验收标准）

| # | 验收项 | 判定 |
|---|--------|------|
| 1 | 后端 `GET /v1/sessions/search` 可用且单测全绿 | `mvn test` 通过 |
| 2 | 顶部栏出现放大镜图标，点击弹出搜索浮窗 | 手动验证 |
| 3 | `Ctrl/Cmd+K` 开/关浮窗，与终端快捷键互不干扰；Android 不注册快捷键 | 手动验证 |
| 4 | 输入关键词（防抖 300ms）自动搜索，命中 user 消息文本 | 手动验证 |
| 5 | 最多 20 条，按 `updated_at` 倒序、同时间按 id 倒序 | 手动 + 单测 |
| 6 | 仅主会话 + 有效边路会话；子代理、归档、孤儿边路（父删/父归档/父非 NORMAL/父属他人）不出现 | 单测覆盖 |
| 7 | 结果条目含标题 / 类型标签 / 相对时间 / 命中片段（围绕关键词生成，必然包含并高亮） | 手动验证 |
| 8 | 关键词位于长消息中段时，snippet 仍包含并高亮关键词 | 单测 + 手动 |
| 9 | 多模态消息不会因图片 URL / JSON 字段产生不可解释的命中 | 单测覆盖 |
| 10 | 点击主会话跳转 `/tasks/{id}` 并加载 | 手动验证 |
| 11 | 点击边路会话跳转父会话并打开对应边路 Tab，phase 显示真实值 | 手动验证 |
| 12 | 主动搜索打开曾关闭的边路 Tab 后，刷新仍保持可恢复（`unmarkSideTaskClosed` 生效） | 手动验证 |
| 13 | 连续快速输入时旧请求不覆盖新结果；关闭浮窗后在途请求返回不重新弹窗 | 手动 + 单测（组件逻辑） |
| 14 | `↑`/`↓`/`Enter`/`Esc` 键盘交互、点击外部关闭 | 手动验证 |
| 15 | 空关键词 / 无结果 / 加载中 / 接口异常四态明确；空关键词不发请求 | 手动验证 |
| 16 | `%`、`_`、`\` 按普通字符匹配（ESCAPE 生效） | 单测 |
| 17 | 英文大小写匹配与数据库 collation 一致 | 单测 |
| 18 | 未登录访问 `/` 停在登录页，不直接调用搜索接口 | E2E |
| 19 | 关键词命中消息已逻辑删除时不返回 | 单测 |
| 20 | 深色主题与安卓窄屏 / 软键盘场景布局正常（`min()`/`max()` 尺寸） | 手动验证 |
| 21 | 上线前 `EXPLAIN ANALYZE` 与典型数据量 P95 响应记录到位 | 实现记录 |
| 22 | Playwright 搜索用例（含边路跳转、未登录）通过 | `npm test` |
| 23 | `CHANGELOG.md` 已记录后端与前端条目 | 文件检查 |

## 6. 风险与边界

- **搜索性能**：`LIKE '%kw%'` 无法走内容索引，但限定单用户 + 候选 `LIMIT 20` + 仅 2 次 SQL（无 N+1），当前量级可控；上线前按 4.5 做 `EXPLAIN ANALYZE` 与 P95 记录，预案见 4.5。
- **多模态假命中的残余影响**：SQL 第一层可能多取假命中候选，第二层纯文本校验剔除后结果可能不足 20 条（需求为"最多 20 条"，允许）。若未来出现"搜索带图消息的文本但结果被 JSON 字段抢占候选名额"的体验问题，可再评估独立可搜索纯文本列（预案，不在本次）。
- **孤儿边路**：`SessionService.deleteSession` 不级联删边路会话，搜索侧已用 `EXISTS` 父会话校验兜底，跳转路径不会落到不存在的父会话。
- **跳转竞态**：边路跳转先用 `router.push` 再用显式 `parentSessionId` 写模块级 Tab Map，与 `TaskView` 的 `loadSession` 解耦；`restoreSideTaskTabs` 只合并不覆盖激活 Tab。
- **XSS**：snippet 仅作纯文本插值渲染，高亮用区间计算 + `<mark>`，不使用 `v-html`。
