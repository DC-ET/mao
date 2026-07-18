# 管理后台前端问题梳理与整改记录

> 范围：仅覆盖 `admin/`（Vue 3 + Element Plus 管理后台），不涉及 `desktop/` 客户端。
> 状态图例：✅ 已修复 ｜ 🔍 已核实非 bug ｜ ⬜ 待修复 ｜ 🆕 本轮新增发现

---

## 第一轮排查（已整改）

### 功能缺陷

| # | 问题 | 文件 | 状态 | 说明 |
|---|------|------|------|------|
| 1 | 数据看板「运行监控」指标恒为 0 | `DashboardView.vue` | 🔍 已核实非 bug | 后端 `AdminAnalyticsService.summary()` 把 `runningSessions/waitingSessions/failedSessions/cancelledSessions` 放进 `overview`，前端 `governance.value = data?.overview` 实际能取到。原代码重复赋值冗余，已简化为统一引用 `overview`，消除歧义。 |
| 2 | Agent 列表分页形同虚设、标签筛选在内存做 | `AgentListView.vue` | ✅ 已修复 | 后端 `/agents` 返回**纯数组（无分页）**，原代码把 `total=data.length` 且把 `page/size` 传给后端（被忽略），分页是假的。改为：加载全量到 `allAgents`，标签筛选基于全量，前端 `computed` 内做切片分页，`total` 取筛选后总数。 |
| 3 | 通知列表不支持分页 | `NotificationListView.vue` | ✅ 已修复 | 后端 `/notifications` 实际支持 `page/size/records/total`，原前端硬编码 `page:1,size:50` 且无分页控件。已补齐 `currentPage/pageSize/total` 与 `el-pagination`，并重置页码。 |
| 4 | 角色权限保存后清空当前选中角色，体验断裂 | `RolePermissionView.vue` | ✅ 已修复 | `saveRole`/`savePermissions` 成功后不再清空 `currentRole`；保存权限后按 id 重新选中该角色，勾选状态保持同步。 |
| 5 | 会话详情时间字段可能显示 `undefined` | `SessionDetailView.vue` | ✅ 已修复 | `lastActivityAt || updatedAt` 两者皆空时渲染字符串 `undefined`。新增 `formatTime()` 并对空值兜底为 `-`。 |
| 6 | 模型删除后可能停留在空白页 | `ModelListView.vue` | ✅ 已修复 | 原逻辑仅在「当前页仅剩 1 条且页码>1」时回退。改为按删除后总数与每页大小计算 `maxPage`，若当前页已空且超出则跳到 `maxPage`。 |

### 交互 / 逻辑

| # | 问题 | 文件 | 状态 | 说明 |
|---|------|------|------|------|
| 7 | 侧边菜单在会话详情页高亮失效 | `Layout.vue` | ✅ 已修复 | `activeMenu` 原取 `route.path`，进入 `/sessions/:id` 时与菜单 `index="/sessions"` 不匹配。改为按第一段路径（`/sessions`）匹配。 |
| 8 | 标签栏关闭逻辑跳到「最后一个」 | `stores/tabs.ts` | ✅ 已修复 | 关闭当前页时改为跳到相邻页（优先左侧），符合多标签后台习惯。 |
| 9 | 已登录访问 `/login` 不拦截；刷新后用户名丢失 | `router/index.ts` / `main.ts` | ✅ 已修复 | 路由守卫：已携带 token 访问 `/login` 时重定向到 `/`；`main.ts` 启动时若有 token 则调用 `authStore.fetchUserInfo()` 恢复用户信息。 |
| 10 | 关键词回车/清空触发查询不一致 | `skill/session/audit` 列表 | ✅ 已修复 | `SessionListView`、`AuditLogView` 关键词框补充 `@keyup.enter="handleSearch"`；`ModelListView` 各 `el-select` 补充 `@change="handleSearch"` 实现选即查。Skill 列表为前端实时过滤，保持 live 过滤即可。 |
| 11 | 筛选条件刷新后不保留 | 各列表 | ⬜ 待修复（低优） | 组件内 `reactive` 状态，刷新/keep-alive 切换后重置。属体验优化，建议后续用 query 参数或 store 持久化，本轮未改。 |
| 12 | `SkillFormDialog` 为死代码 | `SkillFormDialog.vue` | ✅ 已修复 | 全仓无引用（`grep` 0 命中），`SkillListView` 用内联 dialog 查看详情。已删除该文件。 |

### UI / 样式

| # | 问题 | 文件 | 状态 | 说明 |
|---|------|------|------|------|
| 13 | 聊天区最大高度 `calc(100vh - 360px)` 硬编码 | `SessionDetailView.vue` | ✅ 已修复 | 改为 flex 布局：`.session-detail` 纵向 flex 占满，`.chat-card` flex:1，`.chat-container` 内部滚动，自适应不同分辨率/折叠态。 |
| 14 | 趋势图无数据时空态缺失 | `DashboardView.vue` | ✅ 已修复 | `trends` 为空时渲染 `el-empty` 占位，与「Agent 使用排行」空态风格一致。 |
| 15 | 指标卡数值取「当前页」却无标注 | `RuntimeMonitorView.vue` / `SessionListView.vue` | ✅ 已修复 | 标签统一加「(当前页)」后缀，明确语义；运行监控「重点会话」原用 `total`（全量）与其余（当前页）不一致，已统一为当前页。 |
| 16 | `.card-header` 语义混用 | 多视图 | ⬜ 待修复（低优） | 列表页（左右分布）与单行标题复用同一 class，权重/间距不一。建议拆分 `page-title` 与 `card-toolbar`，本轮未改。 |
| 17 | 窄屏下列宽溢出 / 固定列对齐 | 多列表 | ⬜ 待修复（低优） | 操作列 `fixed=right` 且较宽，窄屏横向滚动表现需结合真机验证，本轮未改。 |
| 18 | 代码高亮 `.hljs` 样式风险 | `useMarkdown.ts` | 🔍 已核实非 bug | `highlight.js` 已在 `package.json` 依赖中，`useMarkdown.ts` 已 `import 'highlight.js/styles/github-dark.css'` 且渲染输出带 `hljs` class，样式正常。 |
| 19 | 登录页空字段无反馈 | `LoginView.vue` | ✅ 已修复 | 原 `handleLogin` 校验失败仅 `return`。已补充 `ElMessage.warning('请输入用户名和密码')`，并补 `catch` 防止静默失败。 |
| 20 | 状态色板（info/danger/primary）不统一 | 多视图 | ⬜ 待修复（低优） | 不同模块「关/未启用」用 `info` 与 `danger` 含义不一。建议全局定义状态色板，本轮未改。 |

---

## 第二轮排查（🆕 新增发现，部分已修复）

| # | 问题 | 文件 | 状态 | 说明 |
|---|------|------|------|------|
| 21 | 列表→详情返回后数据不刷新（实比「状态丢失」更严重） | `SessionListView.vue` / `RuntimeMonitorView.vue` | ✅ 已修复 | 原担心筛选丢失，实际经核查：keep-alive 下列表组件未销毁，筛选/页码**已保留**；真实问题是返回后列表不重新拉取，详情页的变更（如删除会话）不反映。已给两列表加 `onActivated` 重新拉取（保留筛选与页码）。 |
| 22 | `RuntimeMonitorView` 与 `SessionListView` 高度重复 | `RuntimeMonitorView.vue` | ⬜ 待修复（建议重构） | 两页表格/筛选/指标卡结构几乎一致，可抽为共享组件。 |
| 23 | Dashboard 无 loading 态、Token/用户表无空态 | `DashboardView.vue` | ✅ 已修复 | 整页加 `v-loading`；Token 消耗排行 / 用户活跃度表补 `el-empty` 空态。 |
| 24 | `AnalyticsView` 切换周期无 loading | `AnalyticsView.vue` | ✅ 已修复 | 根容器加 `v-loading="loading"`，`fetchSummary` 包裹 try/finally。 |
| 25 | 表单 dialog 关闭后未重置滚动位置 | 多个 FormDialog | ⬜ 待修复（低优） | `UserFormDialog` 等已 `clearValidate`；长表单滚动位置未复位，体验轻微，且 dialog 滚动容器在 teleport 内，复位较繁琐。 |
| 26 | `ModelFormDialog` 编辑时明文回显 apiKey 且必填 | `ModelFormDialog.vue` | ✅ 已修复 | 编辑态不再回显明文 key；`apiKey` 规则改为「新建必填、编辑非必填」；提交时若编辑态且 key 为空则从 payload 删除，避免覆盖。 |
| 27 | `SkillListView` 上传无 loading 反馈 | `SkillListView.vue` | ✅ 已修复 | 上传区加 `v-loading="uploading"` + `element-loading-text="上传中..."`，阻断重复点击并提供视觉反馈。 |
| 28 | 审计详情长文本（错误/参数）溢出 | `AuditLogView.vue` | ✅ 已修复 | 详情内容包 `audit-detail` 容器，`.el-descriptions__content` 加 `word-break/overflow-wrap`，长串可换行。 |
| 29 | 列表写操作后整页 loading 闪烁 | 多个列表 | ⬜ 待修复（低优） | 删除等写操作后 `fetchXxx()` 触发全表 loading，体验略重；可局部 loading。 |
| 30 | `App.vue` 无全局错误边界 | `App.vue` | ✅ 已修复 | 加 `onErrorCaptured` 兜底，渲染异常时提示并避免整页白屏。 |
| 31 | `FileChangePanel` 文件变更类型映射不全 | `FileChangePanel.vue` / `types/chat.ts` | ✅ 已修复 | 原仅 `CREATED`→新建、其余→修改，`DELETE`/`RENAME` 等被误标。扩展 `FileChangeType`，新增 `changeTypeLabel/changeTypeClass` 映射（新建/修改/删除/重命名/复制），并补 deleted/renamed badge 配色；删除类型本就带 `linesDeleted` 故统计正常展示。 |
| 32 | `HelloWorld.vue` 为脚手架残留死代码 | `components/HelloWorld.vue` | ✅ 已修复 | 全仓无引用，连同其独占的 `assets/hero.png`、`assets/vite.svg`、`assets/vue.svg` 一并删除。 |

---

## 整改总结

- **P0（数据错误）**：原 #1 经核查后端实际会把治理指标放入 `overview`，前端能取到，故非 bug；Agent 列表分页（#2）确为后端无分页导致的假分页，已改为可靠的前端分页。
- **第一轮已修复 14 项**：#2 #3 #4 #5 #6 #7 #8 #9 #10 #12 #13 #14 #15 #19（含 2 项核实非 bug：#1 看板指标、#18 代码高亮）。
- **第二轮已修复 6 项**：#23 #24 #26 #27 #28 #30。
- **第三轮已修复 3 项**：#21（列表返回刷新）#31（文件变更类型）#32（删除脚手架死代码）。
- **累计已修复 21 项 / 核实非 bug 2 项 / 待后续 9 项**（#11 #16 #17 #20 #22 #25 #29 等，多为体验优化与重构建议）。
- **验证**：所有改动通过 `vue-tsc` 类型检查与 `npm run build` 生产构建（无错误）。

> 说明：以上基于对源码与后端 Controller 的静态阅读 + 前端类型检查 + 生产构建验证。剩余项（#11 #16 #17 #20 #22 #25 #29）为低优先级体验优化/重构/脚手架清理，需结合浏览器实测或单独排期，不阻塞当前功能正确性。
>
> 管理后台前端可见的「功能/交互/UI」类明确缺陷已基本清零；后续可聚焦 #22 列表页组件抽象复用与 #16 状态色板统一等结构性优化。
