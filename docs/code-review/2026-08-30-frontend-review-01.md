# 前端代码审查报告：admin 管理后台 + desktop 三端共用 UI

- 审查时间：2026-08-30
- 审查范围：`admin/src/` 全量（router / api / stores / components / views 共 16 个视图及其子组件）；`desktop/src/` 核心链路（useStreamWS / useChat / useCenterTabs / stores / components/chat / components/center / views / utils 等）
- 审查维度：功能模块缺陷、UI 样式、交互逻辑
- 方法：逐文件通读 + 与后端 `backend-ts/src/` 交叉验证权限/接口语义；关键结论（XSS、hash 路由跳转、send 丢消息、WS token、定时任务权限、MCP 输入防抖、双提交等）已由主代理二次抽查源码确认
- 共 **41 个问题**：高 6 / 中 20 / 低 15

---

## 汇总速览

| # | 项目 | 问题 | 类别 | 严重程度 | 位置 |
|---|------|------|------|:---:|------|
| A1 | admin | 会话聊天记录 Markdown XSS（无消毒 v-html） | 功能(安全) | 高 | `admin/src/views/session/composables/useMarkdown.ts:5-21` |
| A2 | admin | 定时任务管理页对他人任务启停/删除必然失败 | 功能 | 高 | `admin/src/views/scheduled-tasks/index.vue:58` |
| A3 | admin | 登录页回车触发两次登录请求 | 交互 | 中 | `admin/src/views/auth/LoginView.vue:15,26` |
| A4 | admin | 失效 token + 网络异常时 /login 与 / 重定向死循环 | 功能 | 中 | `admin/src/router/index.ts:136-150` |
| A5 | admin | keep-alive 无 include 且按 fullPath 作 key，缓存无界增长 | 功能(泄漏) | 中 | `admin/src/components/Layout.vue:57-60` |
| A6 | admin | SessionDetailView 首次打开重复请求两次 | 功能 | 中 | `admin/src/views/session/SessionDetailView.vue:202-206` |
| A7 | admin | 大量 fetch 无 catch，失败误报"页面发生异常" | 功能 | 中 | `DashboardView.vue:151` 等 14 个视图 |
| A8 | admin | 列表请求无竞态防护，慢响应覆盖新结果 | 功能 | 中 | `ModelListView.vue:326-356` 等 |
| A9 | admin | MCP 关键词每敲一个字符发一次请求，无防抖 | 功能/交互 | 中 | `admin/src/views/mcp/McpServerListView.vue:22` |
| A10 | admin | Agent 删除末页最后一条后停留空白页 | 功能 | 中 | `admin/src/views/agent/AgentListView.vue:135,174` |
| A11 | admin | 只读权限用户看到全部写操作按钮，点击必 403 | 功能(权限) | 中 | `ModelListView.vue:167-217` 等 |
| A12 | admin | 集成配置数值项无校验即可保存 | 功能 | 中 | `IntegrationConfigPanel.vue:167,185` |
| A13 | admin | 角色权限页切换角色直接覆盖未保存修改 | 交互(数据丢失) | 中 | `RolePermissionView.vue:31,142-145` |
| A14 | admin | 无 404 兜底路由，未知路径白屏 | 功能 | 低 | `admin/src/router/index.ts` |
| A15 | admin | Pinia store 内调用 useRouter()（隐性崩溃风险） | 功能 | 低 | `admin/src/stores/tabs.ts:14` |
| A16 | admin | 大量硬编码颜色绕过主题变量 | UI 样式 | 低 | `DashboardView.vue:172` 等 |
| A17 | admin | 统计卡片栅格缺平板断点适配 | UI 样式 | 低 | `DashboardView.vue:354-371` 等 |
| A18 | admin | 用户列表"状态"筛选不触发查询，与全站不一致 | 交互 | 低 | `UserListView.vue:32-38` |
| A19 | admin | 可点击卡片/标签关闭按钮不可键盘操作 | 交互(a11y) | 低 | `TabBar.vue:31-37` 等 |
| D1 | desktop | Markdown 渲染 XSS（link text 未转义 + 无 DOMPurify） | 功能(安全) | 高 | `desktop/src/composables/useMarkdown.ts:36-41` |
| D2 | desktop | Electron file:// hash 路由下"返回工作台"跳错地址白屏 | 功能 | 高 | `TopNav.vue:175-183`、`SettingsView.vue:48-56` |
| D3 | desktop | 主发送链路 send() 静默丢消息且永远返回 true | 功能 | 高 | `useStreamWS.ts:304-311,362-377` |
| D4 | desktop | 401 刷新排队请求在 refresh 失败时永久挂起 | 功能 | 中 | `desktop/src/api/index.ts:55-60,92-96` |
| D5 | desktop | useCenterTabs 已读 watch 随宿主卸载永久失效 | 功能 | 中 | `useCenterTabs.ts:58,108-135` |
| D6 | desktop | session store reset()/deleteSession() 清理不全 | 功能(泄漏) | 中 | `session.ts:1594-1625,993-1029` |
| D7 | desktop | 登录失败无任何错误提示 + 回车可重复提交 | 交互 | 中 | `desktop/src/views/auth/LoginView.vue:156-176` |
| D8 | desktop | FileViewer 文本读取无过期响应保护（PDF 有） | 功能(竞态) | 中 | `FileViewer.vue:165-175,192-247` |
| D9 | desktop | MarkdownContent 异步渲染竞态，流式内容回退 | 功能(竞态) | 中 | `MarkdownContent.vue:14-24` |
| D10 | desktop | 提问面板/审批卡片提交无防重 | 交互 | 中 | `QuestionPanel.vue:226-243`、`ApprovalStack.vue:97-101` |
| D11 | desktop | 边路任务删除失败仍本地删除 + window.confirm 风格割裂 | 功能/交互 | 中 | `TaskView.vue:576-596` |
| D12 | desktop | 边路首发乐观消息插在校验前，失败不回滚 | 功能 | 中 | `SideChatPanel.vue:554-566` |
| D13 | desktop | WS URL 携带明文 token | 功能(安全) | 中 | `useStreamWS.ts:171` |
| D14 | desktop | Web/安卓端 Markdown 外链点击静默无响应 | 交互(三端守卫) | 中 | `FileViewer.vue:118-137` |
| D15 | desktop | appendDelta 每 delta 复制整条消息数组 | 功能(性能) | 低 | `session.ts:1157-1164` |
| D16 | desktop | 卸载不 cleanup，KeepAlive 关 Tab 不退订 WS | 功能(泄漏) | 低 | `ChatPanel.vue:274,298` |
| D17 | desktop | 恢复期 mao:markdown-rendered 监听器残留 | 功能(泄漏) | 低 | `ChatPanel.vue:251-296` |
| D18 | desktop | routeEvent 中 terminal 分支死代码 | 功能 | 低 | `useStreamWS.ts:471-478` |
| D19 | desktop | ChatInput uploadingFiles 死状态，loading 分支不可达 | 交互 | 低 | `ChatInput.vue:319,775,956,1041` |
| D20 | desktop | 自动补全面板无显式触发符，误触发率高 | 交互 | 低 | `ChatInput.vue:826-871` |
| D21 | desktop | 暗色主题下 hover 反馈硬编码黑色透明 | UI 样式 | 低 | `MessageBubble.vue:742,891,910` |
| D22 | desktop | 快捷键作用域/resize 不响应/substr/复制带标记等杂项 | 交互 | 低 | 见正文 |

---

# 一、admin 管理后台（19 个）

## A1【高】会话聊天记录 Markdown 渲染存在 XSS 漏洞

- **类别**：功能（安全）
- **位置**：`admin/src/views/session/composables/useMarkdown.ts:5-21`；`MessageGroup.vue:41,54`
- **证据**：
  ```ts
  link({ href, text }) {
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`  // href 未转义
  }
  ```
  ```html
  <div class="assistant-text markdown-body" v-html="renderMarkdown(finalReply.content)" />
  ```
  marked v5 起已移除 `sanitize` 选项，项目也未接入 DOMPurify。
- **影响**：助手消息内容（LLM 输出、被提示注入的网页内容、MCP 工具结果）直接注入 DOM。`<img src=x onerror=...>`、`[x](javascript:...)`、属性逃逸（`http://a" onmouseover="...`）均可执行。管理后台 token、模型 API Key（编辑弹窗明文回显）全部暴露给攻击脚本。
- **修复建议**：引入 `dompurify` 在 `renderMarkdown` 返回前统一消毒；`link` renderer 对 `href` 做协议白名单（仅 http/https）+ 属性转义。

## A2【高】定时任务管理页：对他人任务的启停/删除必然失败

- **类别**：功能（前后端权限语义不一致，已交叉验证后端）
- **位置**：`admin/src/views/scheduled-tasks/index.vue:58,110,221`；后端 `backend-ts/src/schedule/scheduled-task.service.ts:148,180`
- **证据**：
  ```html
  <el-switch v-model="row.status" active-value="ACTIVE" inactive-value="PAUSED"
             :disabled="!!row.finished" @change="handleToggleStatus(row)" />
  ```
  列表来自 `/scheduled-tasks/all`（仅需 `session:read`，含所有用户的任务），但后端 `updateTask`/`deleteTask` 均先执行 `getTaskOwnedByUser(taskId, userId)`，仅任务归属人可改/删。
- **影响**：管理员在管理页看到的主要是其他用户的任务，点启停/删除得到 `SCHEDULED_TASK_ACCESS_DENIED`，开关回弹，功能形同虚设，且无任何原因提示。
- **修复建议**：后端为管理端增加管理员放行（或提供 `/admin/scheduled-tasks` 语义）；在此之前前端对非本人任务禁用操作并提示。

## A3【中】登录页按回车触发两次登录请求

- **类别**：交互（重复提交）
- **位置**：`admin/src/views/auth/LoginView.vue:15,26,35,70-92`
- **证据**：`<el-form @submit.prevent="handleLogin">` 包裹 `native-type="submit"` 按钮，同时输入框又绑 `@keyup.enter="handleLogin"`；`handleLogin` 无 `if (loading.value) return` 守卫。keydown 阶段原生 submit 触发第 1 次，keyup 又触发第 2 次。
- **影响**：每次回车登录并发两个 `POST /auth/login`，产生两个会话/token，登录审计记双条。
- **修复建议**：`handleLogin` 开头加 `if (loading.value) return`，或去掉输入框的 `@keyup.enter`。

## A4【中】失效 token + 网络异常时，路由守卫在 /login 与 / 之间死循环

- **类别**：功能
- **位置**：`admin/src/router/index.ts:136-150`
- **证据**：
  ```ts
  if (to.path === '/login' && token) { next('/'); return }      // 有 token 强制离开登录页
  try { await authStore.fetchUserInfo() } catch { next('/login'); return }  // 失败踢回登录页但不清 token
  ```
- **影响**：token 存在但接口不可达（断网/后端抖动）时无限重定向，vue-router 检测到循环后中止——既进不了后台也看不到登录页，页面卡死。catch 未清理 token。
- **修复建议**：fetchUserInfo 失败时区分错误：401 类清理 token 后进 `/login`；网络错误允许停留，或放行 `/login` 不做 token 回跳。

## A5【中】keep-alive 无 include 且按 fullPath 作 key：缓存无界增长

- **类别**：功能（内存泄漏）
- **位置**：`admin/src/components/Layout.vue:57-60`
- **证据**：
  ```html
  <keep-alive>
    <component :is="Component" :key="viewRoute.fullPath" />
  </keep-alive>
  ```
  路由里给每个页面写的 `meta.keepAlive: true` 从未被消费，是死配置。
- **影响**：所有路由组件全量缓存；每打开一个 `/sessions/{id}` 详情页（含全部消息、图片 dataURI）就永久多缓存一个实例；TabBar 关闭标签页也不会释放对应实例。长会话排障场景内存持续上涨。
- **修复建议**：`<keep-alive :include="cachedNames">` 与 tab store 联动（关 Tab 移除缓存名）；详情类路由不缓存或用 `max` 限制。

## A6【中】SessionDetailView 首次打开重复请求两次

- **类别**：功能
- **位置**：`admin/src/views/session/SessionDetailView.vue:202-206`
- **证据**：
  ```ts
  onMounted(fetchDetail)
  let mountedOnce = false
  onMounted(() => { mountedOnce = true })
  onActivated(() => { if (mountedOnce) fetchDetail() })
  ```
- **影响**：keep-alive 组件首次挂载钩子顺序为 onMounted（全部执行完，`mountedOnce` 已为 true）→ onActivated，导致首次打开连发两次 `fetchDetail`（4 个请求变 8 个），与注释意图相反。`SessionListView` / `RuntimeMonitorView` 用 `activatedOnce` 初始 false 的写法是对的，本页写反。
- **修复建议**：仿照 SessionListView 的 `activatedOnce` 模式。

## A7【中】大量请求函数 try/finally 无 catch：失败误报"页面发生异常"

- **类别**：功能（错误处理缺失）
- **位置**（代表）：`DashboardView.vue:151-158`；同型还有 Agent/Model/User/Session/Mcp/RolePermission/Settings/IntegrationConfigPanel/Audit/Analytics/Runtime/Skill/FeishuBot 等视图
- **证据**：
  ```ts
  try { const { data } = await api.get('/admin/analytics/summary', ...) }
  finally { loading.value = false }   // 无 catch，异常继续上抛
  ```
- **影响**：请求失败时拦截器已 toast"请求失败"，rejection 继续上抛到 `App.vue:15-19` 的 `onErrorCaptured`，再弹一次"页面发生异常，请刷新重试"——两条矛盾提示，且"页面异常"其实只是接口失败。`system-commands` 与 `scheduled-tasks` 写了 catch，是正确范例。
- **修复建议**：统一封装列表请求 hook（内置 catch + loading + 竞态防护），或每个 `try/finally` 补 `catch {}`。

## A8【中】服务端分页列表普遍缺少请求竞态防护

- **类别**：功能
- **位置**：`ModelListView.vue:326-356` 及 User/Session/Audit/Runtime 各 fetch 函数
- **证据**（ModelListView）：
  ```ts
  const { data } = await api.get('/models', { params })
  tabStates[tab].models = data?.records || []     // 无序号/无 AbortController
  ```
- **影响**：快速修改筛选或快速翻页时，先发出的慢响应会后到并覆盖列表（"查 A 得 B"）。
- **修复建议**：每个列表维护自增 seq（`SessionDetailView` 已有 `latestFetchSeq` 模式可复用）或 AbortController。

## A9【中】MCP 关键词输入每敲一个字符发一次请求，无防抖

- **类别**：功能/交互
- **位置**：`admin/src/views/mcp/McpServerListView.vue:22`
- **证据**：
  ```html
  <el-input v-model="keyword" clearable placeholder="名称 / 描述"
            @input="loadData()" />
  ```
- **影响**：输入"filesystem"连发 10 个请求；叠加 A8 无竞态防护，最终列表大概率是乱序响应之一，结果不可预期，且形成请求风暴。
- **修复建议**：改为 `@keyup.enter`/查询按钮触发，或 300ms debounce + 请求序号。

## A10【中】AgentListView 删除末页最后一条后停留在空白页

- **类别**：功能（边界条件）
- **位置**：`admin/src/views/agent/AgentListView.vue:135-137,174-183`
- **证据**：
  ```ts
  const filteredAgents = computed(() => {
    total.value = allAgents.value.length        // ← computed 内产生副作用
    return allAgents.value.slice((currentPage.value-1)*pageSize.value, ...)
  })
  // handleDelete 后 fetchAgents() 未做 currentPage 回退
  ```
- **影响**：第 3 页仅剩 1 条时删除它，`currentPage` 仍为 3，列表空白且分页信息矛盾。`ModelListView.vue:476-483` 已有"回退页码避免空白页"逻辑，本页缺失。另外 `total.value` 赋值写在 computed 内是副作用反模式。
- **修复建议**：删除成功后按 ModelListView 的 maxPage 算法回退页码；`total` 赋值移出 computed。

## A11【中】只读权限用户能看到全部写操作按钮，点击后必然 403

- **类别**：功能（权限控制遗漏，已交叉验证后端）
- **位置**：`ModelListView.vue:167-217`（测试/复制/编辑/停用/删除列）；路由 `router/index.ts:38-42` 仅 `permission: 'model:read'`；后端 PUT/PATCH/DELETE/test 均要求 `model:write`
- **证据**：操作列按钮无任何 `model:write` 判断；`handleCopy/handleEdit` 无 loading、无错误处理，连点并发多次请求。
- **影响**：只有 `model:read` 的账号看到 5 个按钮，点停用/删除/测试全部 403；编辑弹窗能打开、保存才失败——"注定失败的入口"。User/Agent 页同样存在（`user:read` 下展示 `user:write` 操作）。
- **修复建议**：仿照 SideMenu 的 `canSee`，用 `authStore.hasPermission('xxx:write')` 控制操作列按钮显隐；编辑/复制加 loading 防连点。

## A12【中】集成配置数值项无任何校验即可保存

- **类别**：功能（表单校验缺失）
- **位置**：`admin/src/views/settings/components/IntegrationConfigPanel.vue:167,185,267-285`
- **证据**：`file.maxSizeMb`（单文件上限 MB）、`oss.sts.expire`、`oss.sts.maxSizeMb` 均为纯文本 el-input；`saveGroup/runTest` 同样 try/finally 无 catch。
- **影响**：可输入 `abc`、`-5`、`1e10` 并保存成功（按字符串存储），直接影响上传/STS 行为；LDAP/飞书 URL 无格式校验；失败时叠加"页面发生异常"误报。
- **修复建议**：数值字段改 `el-input-number` + min/max；URL 字段加 pattern 校验；补 catch。

## A13【中】角色权限页：切换角色直接覆盖勾选，未保存修改无提示丢失

- **类别**：交互（数据丢失）
- **位置**：`admin/src/views/permission/RolePermissionView.vue:31,142-145`
- **证据**：
  ```ts
  function selectRole(role: Role) {
    currentRole.value = role
    selectedPermissionIds.value = [...(role.permissionIds || [])]   // 直接覆盖
  }
  ```
- **影响**：为角色 A 勾选权限还没点"保存"，点到角色 B 即被覆盖，无确认/脏标记；表格也无 `highlight-current-row`，选中的角色只能靠右侧标题辨认，加剧误操作。
- **修复建议**：记录脏状态，row-click 时如脏则 `ElMessageBox.confirm`；表格加 `highlight-current-row`。

## A14【低】无 404 catch-all 路由，未知路径白屏

- **类别**：功能
- **位置**：`admin/src/router/index.ts`（routes 末尾仅 forbidden）
- **影响**：访问 `/admin/xxx`（误书签/旧链接）无路由匹配，router-view 渲染为空，整页空白无提示。
- **修复建议**：添加 `{ path: '/:pathMatch(.*)*', ... }` 兜底（NotFound 或 redirect dashboard）。

## A15【低】Pinia store 内调用 useRouter()（反模式）

- **类别**：功能（健壮性）
- **位置**：`admin/src/stores/tabs.ts:14`
- **证据**：`defineStore` setup 内 `const router = useRouter()`——仅在 store 首次于组件 setup 内实例化时才有值。
- **影响**：当前恰好由 Layout.vue 首次实例化才没炸；一旦在路由守卫/单测/main.ts 先调用 `useTabStore()`，`removeTab/setActiveTab` 里 `router.push` 直接抛错。
- **修复建议**：store 内改 `import router from '../router'`（项目已有单例导出）。

## A16【低】大量硬编码颜色绕过主题变量

- **类别**：UI 样式
- **位置**：`DashboardView.vue:172,176,316,320,338-343`；`AnalyticsView.vue:146,152,155`；`RuntimeMonitorView.vue:253`；`UserListView.vue:276-296`；`AuditLogView.vue:253-257`
- **证据**：`color: #303133`、`#909399`、`border-bottom: 1px solid #f0f0f0`、`.clickable-card.is-active { border-color: #409eff }`（Element 默认蓝，非 `--mao-accent #0066cc`）。
- **影响**：`style.css` 已定义 `--mao-ink/--mao-muted/--mao-border/--mao-accent`，但多个视图写死 Element 默认灰/蓝，同页文字灰度不一致；将来做暗色主题这些硬编码全部漏网。
- **修复建议**：统一替换为 `var(--mao-*)` / `var(--el-text-color-*)`。

## A17【低】统计卡片栅格只适配了 ≤768px，平板区间过挤

- **类别**：UI 样式（响应式缺失）
- **位置**：`DashboardView.vue:354-371`；`AnalyticsView.vue:174-188`；`RuntimeMonitorView.vue:288-294`
- **证据**：`<el-col :span="6">` 固定 25%，media query 只有 `max-width: 768px` 一个断点；`useBreakpoint` 已有 `isTablet` 但未使用。
- **影响**：769–1023px（iPad 竖屏）下 4 张卡片每张约 180px，"24px 加粗数字 + 长标签"换行挤压；图表区 `span=14/span=10` 在窄平板被压扁。
- **修复建议**：用 Element 响应式属性 `:xs="24" :sm="12" :md="6"`（IntegrationConfigPanel 已是正确写法）。

## A18【低】用户列表"状态"筛选不触发查询，与全站行为不一致

- **类别**：交互
- **位置**：`admin/src/views/user/UserListView.vue:32-38`
- **证据**：状态 el-select 无 `@change="handleSearch"`；ModelListView/AuditLogView/RuntimeMonitorView 的筛选下拉均即时生效。
- **影响**：选择"禁用"后必须再点"查询"才生效，用户会以为筛选失效。
- **修复建议**：补 `@change="handleSearch"`。

## A19【低】可点击卡片/标签关闭按钮不可键盘操作（a11y）

- **类别**：交互（键盘可用性）
- **位置**：`DashboardView.vue:16-23`；`TabBar.vue:31-37`
- **证据**：8 张跳转卡片纯 `@click` 无 role/tabindex；标签关闭按钮 `tabindex="-1"` 永不获焦，键盘唯一关闭方式是聚焦标签条后 Ctrl+W，难被发现。
- **修复建议**：卡片加 `role="button" tabindex="0" @keydown.enter`；关闭按钮改 `tabindex="0"` 并响应 Enter/Space。

### 附：已排查、确认不成立的疑点
- 模型 API Key 掩码回填覆盖密钥：后端 PUT 与 revealApiKey 同权限，能保存的人一定拿到明文回显，不构成数据破坏（按钮显隐问题见 A11）。
- 无定时器/监听器泄漏：全站仅 `useBreakpoint.ts` 注册 matchMedia 且有引用计数清理，正确。

---

# 二、desktop 三端共用 UI（22 个）

## D1【高】Markdown 渲染链路存在 XSS 注入点

- **类别**：功能（安全）
- **位置**：`desktop/src/composables/useMarkdown.ts:36-41`；`components/common/MarkdownContent.vue:2`
- **证据**：
  ```ts
  link({ href, text }) {
    if (isExternalMarkdownLink(href)) {
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`  // text 未转义
    }
    return `<a href="${escapeHtml(href)}">${text}</a>`   // 内链也无 rel="noopener"
  }
  ```
  `MarkdownContent.vue`：`<div v-html="html">`，全链路无 sanitize；`href` 也未过滤 `javascript:` 协议。
- **影响**：assistant 消息（LLM 输出，可能被 prompt 注入回显恶意内容）经 marked 后直接 `v-html`。`[<img src=x onerror=alert(1)>](http://a)` 即注入。
- **修复建议**：link/text 一律 `escapeHtml`；`href` 协议白名单；渲染结果统一过 DOMPurify。

## D2【高】Electron（file:// hash 路由）下"返回工作台"整页跳转指向错误地址

- **类别**：功能
- **位置**：`desktop/src/components/common/TopNav.vue:175-183`、`desktop/src/views/settings/SettingsView.vue:48-56`
- **证据**：
  ```ts
  function goBackFromSettings() {
    if (active) { window.location.href = `/tasks/${active.id}`; return }
    window.location.href = '/'
  }
  ```
  而 `router/index.ts:68-72`：`file:` 协议下用 `createWebHashHistory()`；`utils/login-redirect.ts:37` 注释明确写着"必须用 vue-router（Hash 模式下写死 window.location.href 会打错地址）"。
- **影响**：Electron 打包后 hash 路由，`location.href = '/tasks/1'` 指向 `file:///tasks/1`，设置页点"返回工作台"直接白屏。旧版安卓本地包（hash 路由）同样受影响。两个文件重复实现且都错。
- **修复建议**：改用 `router.push('/tasks/' + id)`，两处合并为一个工具函数。

## D3【高】主消息发送链路静默丢消息：不可靠 send() + 永远返回 true

- **类别**：功能（断线重连）
- **位置**：`desktop/src/composables/useStreamWS.ts:304-311（send）、362-377（sendMessage）、379-407、434-450`
- **证据**：
  ```ts
  function send(msg: any) {
    if (ws?.readyState === WebSocket.OPEN) { ws.send(...) }
    else { console.warn('[ws] send dropped (not open):', ...) }
  }
  async function sendMessage(...): Promise<boolean> {
    send(payload); return true   // 无论是否发出都返回 true
  }
  ```
  `enqueueMessage/insertMessage/deleteQueueMessage/reorderQueueMessage/createSideSession` 同样只走 `send()`；而已有 `sendReliable` 仅用于审批/提问回执。
- **影响**：`connect()` resolve 后到执行 send 之间 WS 可能再次断开（30s 静默主动 close），消息被静默丢弃但返回 true → `useChat.sendMessage` 乐观上屏并显示发送成功，服务端从未收到，无任何错误反馈。
- **修复建议**：`sendMessage/sendEditMessage/enqueueMessage/createSideSession` 改用 `sendReliable` 并把 `false` 传导给调用方（保留输入与草稿、提示失败）；队列操作失败回滚 UI。

## D4【中】401 刷新排队请求在 refresh 失败时永远挂起

- **类别**：功能
- **位置**：`desktop/src/api/index.ts:55-60,92-96`
- **证据**：
  ```ts
  if (isRefreshing) {
    return new Promise((resolve) => { pendingRequests.push((newToken) => { ... resolve(api(originalRequest)) }) })
  }
  } catch { pendingRequests = []      // 只清数组，不 reject 排队的 Promise
  ```
- **影响**：并发请求触发刷新、refresh 失败时，队列中每个 Promise 既不 resolve 也不 reject，调用方 `await` 永久挂起（按钮 loading 卡死、内存泄漏）。
- **修复建议**：队列改为 `{ resolve, reject }` 结构，catch 分支统一 `reject(error)`。

## D5【中】useCenterTabs 的"边路任务已读"watch 随首个宿主组件卸载而永久失效

- **类别**：功能
- **位置**：`desktop/src/composables/useCenterTabs.ts:58,108-135`
- **证据**：
  ```ts
  if (!sideTaskReadWatchRegistered) {
    sideTaskReadWatchRegistered = true
    watch(() => ({...activeTab.value...}), (sid) => { ...setViewingSideTask / markSideTaskRead... }, { immediate: true })
  }
  ```
- **影响**：watch 注册在首次调用者（TaskView）作用域；Layout 的 router-view 无 keep-alive，切到 Settings 即卸载 → watch 停止但模块标志仍为 true，再次进入 TaskView 不再注册：`viewingSideTaskId` 不更新、边路任务圆点已读逻辑失效。
- **修复建议**：把该 watch 移到模块级独立 `effectScope()`（在单例入口 ensure），或改为 store 内维护。

## D6【中】session store 的 reset()/deleteSession() 清理不全，登出后残留状态

- **类别**：功能（状态不一致/泄漏）
- **位置**：`desktop/src/stores/session.ts:1594-1625（reset）、993-1029（deleteSession）、238、253、1190`
- **证据**：`reset()` 重置了所有响应式 Map，但未触碰 `streamingAssistantMessageIds`（普通 Map）、`filteredToolCallIds`（普通 Set）、`viewingSideTaskId`；`deleteSession` 未清理 `sessionLlmRetry/sessionStreaming/sessionThinking/sessionPhases/sessionPendingApprovals/sideTaskCache/subagentCache/sessionExecutionErrors/delegateToolCallBindings`。
- **影响**：登出→换账号登录后流式占位 ID/边路"正在查看"标志残留，出现幽灵流式气泡与已读错乱；删除会话后运行态缓存滞留，慢性内存增长。
- **修复建议**：`reset()` 补齐非响应式容器；`deleteSession` 集中一个 `purgeSessionCache(sid)` 统一清理。

## D7【中】登录失败无任何错误提示，且回车可重复提交

- **类别**：交互
- **位置**：`desktop/src/views/auth/LoginView.vue:156-176,35,47`；`desktop/src/api/index.ts:50-53`
- **证据**：`handleLogin` 的 `try { await authStore.login(...) } finally {...}` 无 catch；拦截器对 `/auth/*` 的 401 只 reject 不弹 toast；输入框 `@keyup.enter="handleLogin"` 不检查 `passwordLoading`。
- **影响**：密码错误时界面无任何提示（unhandled rejection）；快速连按 Enter 并发多次登录请求。
- **修复建议**：handleLogin 加 catch 弹错（或拦截器对 /auth/login 401 特判）；入口加 `if (passwordLoading.value) return`。

## D8【中】FileViewer 文本读取无过期响应保护（PDF 有、文本没有）

- **类别**：功能（竞态）
- **位置**：`desktop/src/components/center/FileViewer.vue:165-175,192-247`
- **证据**：`loadPdfPreview` 用 `const seq = ++pdfPreviewSeq; ... if (seq !== pdfPreviewSeq) return` 防竞态；`loadFile()` 直接 `await props.provider.readFile(...)` 无序号校验。
- **影响**：切换会话（provider 变化）或文件变更触发重载时两个 readFile 并发，慢的旧响应后到会覆盖新文件渲染内容，Tab 显示错文件。
- **修复建议**：为 `loadFile` 增加与 PDF 相同的 seq 守卫（或 AbortController）。

## D9【中】MarkdownContent 异步渲染竞态，流式场景内容可能回退

- **类别**：功能（竞态）
- **位置**：`desktop/src/components/common/MarkdownContent.vue:14-24`、`useMarkdown.ts:52-58`
- **证据**：
  ```ts
  watch([() => props.content, isDark], async ([content]) => {
    html.value = content ? await renderMarkdown(content, isDark.value) : ''
  ```
- **影响**：流式输出时 watch 高频触发，`renderMarkdown` 内部 colorizeCode 走 Monaco 较慢且 marked 为 async，前一帧慢渲染后到会覆盖后一帧新内容，气泡文本闪回旧版本。
- **修复建议**：引入 generation 序号（`if (gen !== latestGen) return`），或对高频 delta 合并/防抖渲染。

## D10【中】提问面板与审批卡片提交无防重

- **类别**：交互
- **位置**：`desktop/src/components/chat/QuestionPanel.vue:226-243`、`ApprovalStack.vue:97-101`、`useChat.ts:57-68`
- **证据**：`handleSubmit` 直接 `emit('submit', ...)` 无 settled/loading 态；面板保留到服务端 `ask_user_questions_cancelled` 才移除，期间可反复点击；`confirmApproval` 中 `pendingApprovals` 先移除但响应发送无幂等保护。
- **影响**：重复提交答案/重复审批，服务端收到多份 `ask_user_questions_result`，报错或重复消费。
- **修复建议**：submit 后置 submitting 态禁用按钮直到面板移除；ApprovalStack 按钮点击后立即禁用。

## D11【中】边路任务删除：API 失败仍本地删除 + 原生 confirm 风格不一致

- **类别**：功能/交互
- **位置**：`desktop/src/views/task/TaskView.vue:576-596`
- **证据**：
  ```ts
  try { await api.delete(`/sessions/${sideSessionId}`) }
  catch (e) { console.warn('[side-task] Failed to delete side task:', e) }  // 吞掉失败
  if (tab) { closeTab(tab.id); draftStore.clearDraft(tab.id) }
  sessionStore.removeSideTask(parentSessionId, sideSessionId)               // 照常删本地
  ```
- **影响**：删除失败（网络/权限）时 UI 已移除 Tab 与列表项，刷新后任务"复活"；删除无确认弹窗，晋升用 `window.confirm`，与全局 ElMessageBox 风格割裂。
- **修复建议**：失败时 `ElMessage.error` 并保留本地；删除加确认框；与 archiveSession 的"API 成功再动本地"策略对齐。

## D12【中】边路任务首发：乐观消息插入在父会话校验之前，失败不回滚

- **类别**：功能
- **位置**：`desktop/src/components/chat/SideChatPanel.vue:554-566`
- **证据**：
  ```ts
  if (isFirstSideSend) {
    sessionStore.addUserMessage(placeholderCacheKey.value, {...})
    sessionStore.ensureStreamingAssistantMessage(placeholderCacheKey.value)
    const parentSessionId = sessionStore.activeSessionId
    if (!parentSessionId) { ...; return }   // 幽灵用户消息已上屏，输入框未清、无提示
  ```
- **影响**：无主会话时占位缓存留下一条从未发送的用户消息 + 空 assistant 占位，用户误以为已发出。
- **修复建议**：先校验 `parentSessionId` 再插入乐观消息；失败时 `ElMessage.warning`。

## D13【中】WS URL 携带明文 token

- **类别**：功能（安全）
- **位置**：`desktop/src/composables/useStreamWS.ts:171`
- **证据**：``const url = `${wsBase}/ws/stream?token=${token}&client=${client}` ``
- **影响**：access token 进入 URL，会被 Nginx/网关 access log、浏览器历史记录，泄露面扩大。
- **修复建议**：连接后首帧发送 auth 消息，或用一次性短时 ticket 换取连接。

## D14【中】Web/安卓端 Markdown 文件内外链点击静默无响应

- **类别**：交互（三端守卫缺失）
- **位置**：`desktop/src/components/center/FileViewer.vue:118-137`
- **证据**：
  ```ts
  if (isExternalMarkdownLink(href)) {
    await window.electronAPI?.openExternal(href)
    return
  }
  ```
- **影响**：非 Electron 环境 `window.electronAPI` 为 undefined，点击外链无任何反应无提示；安卓 Capacitor 未走系统浏览器。三端共用 UI 但守卫只覆盖 Electron。
- **修复建议**：Electron 用 openExternal；安卓用 Capacitor App/Browser 插件；Web 用 `window.open(href, '_blank', 'noopener')` 兜底。

## D15【低】流式 appendDelta 每 delta 复制整条消息数组 + 替换 Map

- **类别**：功能（性能）
- **位置**：`desktop/src/stores/session.ts:1157-1164`
- **证据**：`appendDelta` 中 `sessionMessages.value.set(sid, [...list])`；`appendThinkingDelta`、`appendToolCallStart/Result` 同模式。
- **影响**：字符级 delta 触发 O(n) 数组复制与全列表 computed 重算，消息多时流式卡顿。
- **建议**：数组元素已深层响应式，直接改 `lastMsg.content`，确需触发处用 `triggerRef` 或节流替换引用。

## D16【低】组件卸载不调用 useChat cleanup，WS 订阅与审批残留

- **类别**：功能（泄漏）
- **位置**：`desktop/src/components/chat/ChatPanel.vue:274,298`（仅 watch 内调用）；CenterTabContainer KeepAlive max=20
- **影响**：切到 Settings 时 ChatPanel 不 unsubscribe/clearPendingApprovals；关闭的边路 Tab 依赖 KeepAlive LRU 淘汰才触发退订（≤20 个内一直保留订阅）。
- **建议**：ChatPanel 增加 `onUnmounted(cleanup)`；关闭边路 Tab 时主动 unsubscribe。

## D17【低】ChatPanel 恢复期 `mao:markdown-rendered` 监听器可能残留

- **类别**：功能（泄漏）
- **位置**：`desktop/src/components/chat/ChatPanel.vue:251-296`
- **证据**：监听器在 restore 完成回调里注册，仅 `finishMarkdownRestore` 中移除；恢复期间组件被卸载则监听器残留且 `markdownRenderTimer` 不清理。
- **建议**：`onUnmounted` 统一移除监听与 timer。

## D18【低】routeEvent 中 terminal 分支的二次 isStaleExecution 判断是死代码

- **类别**：功能（代码质量）
- **位置**：`desktop/src/composables/useStreamWS.ts:471-478`
- **证据**：入口（:321）已对 `STREAM_EVENT_TYPES` 统一 `isStaleExecution` 拦截，terminal 分支内的同名判断永远为 false。
- **建议**：删除死分支，避免误导维护（看似二道防线，实际没有）。

## D19【低】ChatInput 的 uploadingFiles 是死状态，"上传中"分支永不触发

- **类别**：交互
- **位置**：`desktop/src/components/chat/ChatInput.vue:319,775,956,980,1041,128`
- **证据**：全文件只有 `= false` 赋值，无任何 `= true`；`if (uploadingFiles.value.some(Boolean)) {...}` 不可达，模板 loading 图标分支不可达。
- **建议**：删除死状态，或发送等待保存期间用 `waitingForSave` 做上传占位展示。

## D20【低】自动补全面板误触发率高（无显式触发符）

- **类别**：交互
- **位置**：`desktop/src/components/chat/ChatInput.vue:826-871`
- **证据**：
  ```ts
  const recentText = textBefore.slice(-20)
  matched = allCommands.filter(cmd =>
    cmd.name.toLowerCase().includes(recentText.toLowerCase())
    || cmd.description?.toLowerCase().includes(recentText.toLowerCase()))
  ```
- **影响**：用户未按 `/`/`、`，只要最近输入的 ≥2 字符恰好是任一技能名/描述子串（如"测试""部署"这类常见词），即自动弹面板并劫持 Enter/方向键，输入被频繁打断。
- **建议**：仅当"最后一个词整体匹配名称前缀"时触发，或提高阈值并支持 Esc 记忆关闭。

## D21【低】暗色主题下 hover 反馈硬编码黑色透明

- **类别**：UI 样式
- **位置**：`desktop/src/components/chat/MessageBubble.vue:742,891,910`（`.copy-btn:hover`、`.edit-btn:hover`、`.add-command-btn:hover` 均 `background: rgba(0, 0, 0, 0.04)`）
- **影响**：暗色主题下黑色 4% 叠在深色背景上几乎不可见，hover 反馈缺失（TopNav 同类场景都补了 `[data-theme="dark"]` 覆盖，此处遗漏）。
- **建议**：统一改用 `color-mix(in srgb, var(--aw-ink) 5%, transparent)` 类 token。

## D22【低】快捷键/杂项（合并列出）

- `TaskView.vue:448-454`：Ctrl+` 终端快捷键注册在 TaskView 作用域，切到 Settings 后失效，但 TopNav:60 的 tooltip"终端 (Ctrl+`)"仍可见 → 应移到 Layout 层常驻注册。
- `usePanelLayout.ts:4-8`：`isMobileDevice()` 只在模块加载时求值一次决定 `rightCollapsed`，窗口 resize 不响应（桌面拉窄窗口右侧面板不折叠）。
- `useStreamWS.ts:988`：`Math.random().toString(36).substr(2, 9)` 使用已废弃的 `substr`。
- `MessageBubble.vue:408-412`：`copyMessage` 直接复制 `message.content`，会把 `@{...}@`、`${...}$` 等内部标记一起复制给用户。
- `ChatInput.vue:651-657`：粘贴图片超过 10 张时 `break` 跳出循环，后续图片静默丢弃且只提示一次。
- `useTerminal.ts:96-104`：`MutationObserver` 创建后永不 `disconnect` 且未保存引用（HMR/重复初始化会叠加泄漏）；WebglAddon 未监听 `onContextLoss` 做 canvas 回退。

---

## 修复优先级建议

1. **安全**：A1 / D1（两处 XSS，同一类修法可一起做——引入 DOMPurify + 协议白名单）
2. **核心可用性**：D2（Electron 设置页返回白屏）、D3（发消息静默丢失）、A2（定时任务管理页操作必然失败）、A4（登录死循环）
3. **高频体验**：A3 / D7（登录双提交与无反馈）、A9（MCP 请求风暴）、D4（请求永久挂起）
4. **批量收敛**：A7 + A8 适合用统一列表请求 hook（内置 catch + seq 竞态防护）一次解决；A16/A17、D15/D16/D17 可按迭代批量清理。
