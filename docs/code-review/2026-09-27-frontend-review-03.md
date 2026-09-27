# 前端代码评审报告：desktop + admin（第 3 轮）

- 日期：2026-09-27
- 审查范围：
  - `desktop/src/`：任务侧栏（TaskIndexPanel / TaskInspector）、聊天链路（ChatPanel / ChatInput / QuestionPanel / ApprovalStack / QueuePanel / SideChatPanel）、中心 Tab、顶栏 TopNav
  - `admin/src/`：路由与首页兜底、`useBreakpoint` / `ResponsiveDialog` / `ResponsivePagination` 公共组件、反馈页、调用流水页、用户列表、飞书/钉钉机器人列表
- 审查维度：功能模块缺陷、UI 样式、交互逻辑
- 方法：静态源码审查（逐文件通读 + 与 `backend-ts/src/` 路由/服务交叉验证）。仓库内无 `desktop/dist`、`admin/dist` 构建产物，未做运行时/视觉验证；未运行 vue-tsc / 构建 / 单测。
- 与前两轮的关系：`2026-09-22-frontend-review-01.md`（12 条）与 `2026-09-21-frontend-review-01.md`（12 条）中的条目本轮**逐条回读源码核对**，其中 14 条在当前代码已修复，见文末「已排除」一节，本报告不再重复。
- 本轮初版提出 12 个问题，经逐条源码复核后移除 10 条假问题 / 非逻辑 bug 问题（详见文末「已移除」一节），保留 **2 个真逻辑 bug**：中 2。
- 以下行号对应当前 HEAD（`34d079c6`）。

---

## 严重度汇总

| # | 项目 | 问题 | 类别 | 严重程度 | 状态 | 位置 |
|---|------|------|------|:---:|:---:|------|
| 1 | admin | 调用流水页 keep-alive 返回后 `applyQueryFilters` 只增不清，残留旧筛选 | 功能 | 中 | ✅ 已修复 | `admin/src/views/llm-call/LlmCallView.vue:254-267,430-447` |
| 2 | admin | 点踩反馈页 `onMounted` + `onActivated` 无守卫，首屏重复请求两次 | 功能 | 中 | ✅ 已修复 | `admin/src/views/feedback/FeedbackView.vue:199-200` |

---

## 中

### 1. 调用流水页 keep-alive 返回后 `applyQueryFilters` 只增不清，残留旧筛选（admin）

- **位置**：`admin/src/views/llm-call/LlmCallView.vue:254-267`（`applyQueryFilters`）、`:430-434`（`onMounted`）、`:436-447`（`onActivated` 带 `firstActivation` 守卫）；正例 `admin/src/views/session/SessionListView.vue:210-217`
- **行为**：`applyQueryFilters` 只在 query 存在时赋值（`if (typeof q.scene === 'string' && q.scene) filters.scene = q.scene`），没有任何 else 分支。从带 `?scene=chat` 的入口进入本页后切到别的页面、再通过无 query 的侧边菜单/Tab 回来，`onActivated` 会重新调用 `applyQueryFilters`，但 `filters.scene` 仍是上次的 `chat`，列表继续按旧筛选拉数据，筛选控件却显示为空。
- **用户影响**：筛选框显示「全部」，实际数据被过滤，用户无法判断为什么看不到预期记录；与 `SessionListView` 已修复的同源问题行为不一致（那边是 `filters.userId = ... : null`）。
- **修复建议**：改为无条件赋值，缺省即 `null`/`''`：`filters.scene = typeof q.scene === 'string' ? q.scene : ''`，与 `SessionListView.applyRouteQuery` 保持一致。

### 2. 点踩反馈页 `onMounted` + `onActivated` 无守卫，首屏重复请求两次（admin）

- **位置**：`admin/src/views/feedback/FeedbackView.vue:183-185`（`refreshAll` = summary + list 两个请求）、`:199-200`（`onMounted(refreshAll)` + `onActivated(refreshAll)`）；正例 `admin/src/views/llm-call/LlmCallView.vue:436-447` 与 `admin/src/views/session/SessionDetailView.vue:328-337`（`activatedOnce` 守卫）
- **行为**：本路由 `meta.keepAlive: true`。keep-alive 组件首次挂载时 `onActivated` 紧随 `onMounted` 触发，于是 `fetchSummary` + `fetchList` 各发两遍。另外 `filters` 里的 `dateRange` 会传给 summary 接口，而后端 `getSummary` 已按日期过滤（`backend-ts/src/feedback/feedback.service.ts:94-107`、`feedback.repository.ts:65-78`），意味着两次请求都是带筛选的全量统计。
- **用户影响**：首屏多一次汇总 + 一次分页查询；`total` 与各 reason 卡片会闪一下旧值/新值。用量不大但属于可避免的重复请求，且与其他 keep-alive 页面的写法不一致。
- **修复建议**：加模块级 `let firstActivation = true`，`onActivated` 首次直接置 false 返回；或只保留 `onActivated`（本页初次也会触发）。

---

## 已排除：历史评审中已修复、本轮不再重复的条目

以下条目来自 `2026-09-21-frontend-review-01.md` 与 `2026-09-22-frontend-review-01.md`，本轮逐条回读源码确认**已修复**，仅列出以备追溯：

| 历史条目 | 现状（本轮核对） |
|---|---|
| 09-22 #2 任务列表重命名「取消」仍保存 | 已修复：`TaskIndexPanel.vue:1270-1277` 的 `onEditBlur` 已加 `.session-item-actions` 判断 |
| 09-22 #5 用户「账号类型」只滤当前页 | 已修复：`backend-ts/src/user/user.routes.ts:41-42` 已读 `authSource`；`UserListView.vue:344` 传参，移动端卡片 `:150` 遍历的就是过滤后的 `users` |
| 09-22 #3 只有 `model:read` 时打转 | 已修复：`admin/src/utils/home.ts:4` 已含 `model:read` 分支；守卫 `admin/src/router/index.ts:188-194` 走 `pickHomePath` |
| 09-21 #3 审批卡片先移除再发送 | 已修复：`useChat.ts:81-87` 失败时 `splice` 放回并 `incrementPendingApproval` + 错误提示 |
| 09-21 #2 新建 Markdown diff 点「源码」空白 | 已修复：`FileDiffViewer.vue:243` 的 watch 已含 `showSource` |
| 09-21 #4 「关闭其他文件」连带关边路 Tab | 已修复：`useCenterTabs.ts:373` 已过滤非 file/diff Tab |
| 09-21 #6 审计日志自动刷新切页停摆 | 已修复：`AuditLogView.vue:294-298` 已有 `onActivated` 重启 |
| 09-21 #7 系统设置刷新不同步字段 | 已修复：`SystemSettingsView.vue:246-250` 改为无条件覆盖 |
| 09-21 #8 队列「立即发送」失败阻塞全部插入 | 已修复：`QueuePanel.vue:207-216` 有 8s 兜底定时器 |
| 09-21 #9 `@` 文件引用搜索竞态 | 已修复：`ChatInput.vue:627-665` 有 `fetchFilesSeq` 序号校验 |
| 09-22 #8 边路 LOCAL 权限切换无响应 | 已修复：`SideChatPanel.vue` 已传 `permission-level` 并监听 update，失败回滚 |
| 09-21 #11 移动端 Skills 删除未校验权限 | 已修复：`SkillListView.vue` 删除按钮已统一 `:disabled="!canWrite"` |
| 09-21 #1 用量分析切换周期新增 Tab | 已修复：`admin/src/stores/tabs.ts:28-31` 以 `route.path` 作身份键 |
| 09-22 #7 队列「编辑」删除失败仍回填 | 已修复：`ChatPanel.vue`/`SideChatPanel.vue` 的 `handleQueueEdit` 均 `if (!deleted) return` |

## 已移除：初版提出经复核不成立的条目

初版提出 12 个问题，经逐条源码复核后移除以下 10 条（假问题或非逻辑 bug）：

| 初版 # | 标题 | 移除原因 |
|---|---|---|
| 1 | 无 `analytics:read` 的账号访问未知路径，会被 404 兜底打到无权限页 | **假问题**：404 redirect → `/analytics` → 守卫 `router/index.ts:188-194` 在 `to.path === '/analytics'` 且无 `analytics:read` 时走 `pickHomePath` 找首个有权限页面，全部无权限才进 `/forbidden`。404 路径已被守卫正确处理。 |
| 2 | 多组提问堆积时只能答第一组，其余组的 Agent 分支永久等待 | **非逻辑 bug**：这是「答完一组后服务端移除该项，面板自动接上下一组」的设计选择。代码注释和 badge tooltip（`title="共 N 组提问待回答，答完当前一组后自动进入下一组"`）已明确说明。 |
| 3 | 审批卡片堆叠时只有最顶组可交互，第 4 张以后完全不可见 | **非逻辑 bug**：非顶层卡片 `pointer-events: none` 是设计行为，处理完顶层后服务端移除并自动露出下一张。第 4 张 `opacity: 0` 是纯视觉堆叠效果，不影响功能。 |
| 6 | 分组重命名失焦即提交，与 Esc「取消」语义不一致 | **非逻辑 bug**：文档自身承认「Esc 本身是安全的」。失焦即提交是交互设计选择（别名保存在本地偏好，走防抖 PUT），非逻辑错误。 |
| 7 | TaskInspector 标题编辑失焦即提交，Esc 后仍会发出重命名 | **非逻辑 bug**：文档自身承认「当前实现下 Esc 是安全的」（`confirmEdit` 第一行 `if (!editing.value) return`）。失焦提交是交互设计选择。 |
| 8 | `ResponsiveDialog` 写死 `destroy-on-close` + 移动端全屏 + `$attrs` 全量透传 | **非逻辑 bug**：组件配置选择与改进建议，`destroy-on-close` 是表单弹窗的合理默认，`$attrs` 透传是 Vue 3 组件封装常见模式。 |
| 9 | `ResponsivePagination` 移动端 layout 写死，丢失 total/jumper | **非逻辑 bug**：移动端精简分页布局是常见设计选择，5 个 computed 是薄封装不影响逻辑。属 UI 改进建议。 |
| 10 | 反馈页 `byDay` 请求了但 UI 未使用（死数据） | **非逻辑 bug**：未使用字段属代码质量 / 可维护性问题，不影响运行时行为。 |
| 11 | 顶栏终端快捷键在终端不可用时 `preventDefault` 后静默 return，吞掉按键 | **假问题**：Ctrl+` 没有浏览器默认行为，`preventDefault` 不会"吞掉"任何有意义的按键。终端不可用时 `toggleTerminal` 直接 return 是合理的无操作。 |
| 12 | 图标按钮普遍无键盘可达性 | **非逻辑 bug**：可访问性改进建议，非逻辑 bug。 |

## 其他已检查、未写入正文的点

- `admin/src/views/user/UserListView.vue:73-81` 的「按角色筛选」alert 已如实说明后端不支持 `roleId`（`backend-ts/src/user/user.routes.ts:38-42` 只读 keyword/status/authSource），文案与实现一致，不算缺陷。
- `desktop/src/components/task/TaskIndexPanel.vue:673-674` 的右键菜单位置估算用固定 `menuWidth=140 / menuHeight=80`：分组菜单项数动态（重命名/重置别名 1~2 项）时高度估算偏大，仅在紧贴窗口右下角触发时可见偏差，且不会遮挡菜单项文字，故列为观察项而非正式问题。
- `desktop/src/components/chat/ChatInput.vue:145-147` 上传 `title` 写「上传图片或文件」而 LOCAL 模式 `accept` 收窄为 `image/*`：文案与 accept 存在轻微不一致，但已在同一行注释说明动机，且不会导致上传失败，列为观察项。
