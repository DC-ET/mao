# 前端代码评审报告：desktop + admin（第 5 轮）

- 日期：2026-09-30
- 审查范围：
  - `admin/src/`：`views/` 全部页面、`api/`、`stores/`、`router/`、`composables/`、`components/`、`main.ts`
  - `desktop/src/`：`composables/`（useStreamWS / useChat / useCenterTabs 等）、`stores/`（auth / session / agent）、`components/chat/`、`components/task/`、`components/center/`、`utils/`、`views/`
- 审查维度：功能模块缺陷、交互逻辑、UI 样式、性能与可维护性
- 方法：两路并行逐文件静态审查 + 与 `backend-ts/src/` 交叉验证（含登录失败状态码链路核实）；高严重度条目在成文前逐一回读源码复核。未运行 vue-tsc / 构建 / 单测，无运行时与视觉验证。
- 与前几轮的关系：已与 `2026-09-21-frontend-review-01.md`、`2026-09-22-frontend-review-01.md`、`2026-09-28-frontend-review-01.md`（第 4 轮）、`2026-09-28-frontend-review-02.md` 逐条去重；有渊源但在本轮构成新问题的条目在各条「与历史评审的关系」中说明。
- 复核记录（2026-09-30 二次核对）：全部条目已逐条回读当前工作区源码确认存在。原 #14（每个 MessageBubble 挂 document 级 click 监听，handler 在弹层关闭时提前 return，每次点击仅 N 次空转调用，无可测量影响）与原 #15（session store upsert 全量拷贝 Map，仅批量刷新路径叠加成 O(n²)，实际会话规模下次毫秒级）经复核确认存在但修复价值过低，已从本报告移除；原 #16/#17/#18 顺延为 #14/#15/#16。
- 本轮共 **16 个问题**：高 4、中 8、低 4。
- 以下行号对应当前工作区文件。

---

## 严重度汇总

| # | 端 | 问题 | 类别 | 严重程度 | 位置 |
|---|:---:|------|------|:---:|------|
| 1 | admin | 用量分析模块级缓存跨账号泄漏，登出不清缓存 | 功能 | 高 | `views/analytics/composables/useScopeQuery.ts:15-19`、`stores/auth.ts:36-45` |
| 2 | desktop | WS 断线全程无 UI 反馈，`connected` 状态无人消费 | 交互 | 高 | `composables/useStreamWS.ts:31,1095` |
| 3 | desktop | 主会话图片/附件上传失败静默降级，可发出无图/空消息 | 功能 | 高 | `composables/useChat.ts:315,381-384,421` |
| 4 | desktop | 心跳判死后 `ws.close()` 无强制重连兜底，半开连接长时间悬挂 | 功能 | 高 | `composables/useStreamWS.ts:228-235,281` |
| 5 | admin | 系统设置两个子面板刷新语义互相矛盾：一个静默丢编辑、一个永不同步 | 功能 | 中 | `views/settings/components/CompanySsoConfigPanel.vue:61-71`、`IntegrationConfigPanel.vue:126-132` |
| 6 | admin | 登录失败双重提示（拦截器与页面 catch 各弹一次） | 交互 | 中 | `api/index.ts:54-57`、`views/auth/LoginView.vue:127-128` |
| 7 | admin | 多处未捕获 Promise rejection（MCP 删除 / 反馈分页 / 会话筛选项） | 功能 | 中 | `views/mcp/McpServerListView.vue:549-553` 等三处 |
| 8 | admin | Skill 系统分支 URL 未 `encodeURIComponent`，与个人分支不一致 | 功能 | 中 | `views/skill/SkillListView.vue:471,728` |
| 9 | admin | 用户详情抽屉切换用户不清空旧数据，短暂展示上一位用户明细 | 功能 | 中 | `views/user/UserDetailDrawer.vue:242-252` |
| 10 | admin | 会话导出：游离 `a.click()` + 同步 revoke 可静默失败；导出游标循环无上限 | 功能 | 中 | `views/session/SessionDetailView.vue:264-286` |
| 11 | desktop | 登出/换号时模块级状态残留：中心 Tab、待审批队列、关闭标记 | 功能 | 中 | `stores/auth.ts:62-74`、`composables/useCenterTabs.ts:14-15`、`composables/useChat.ts:37` |
| 12 | desktop | token 明文镜像进 localStorage，与文件头注释目标相悖，且写失败会炸掉登录 | 功能 | 中 | `utils/auth-storage.ts:1-25,48-56` |
| 13 | desktop | 消息列表无虚拟滚动、分页无上限，Markdown 重渲染与全局事件双重放大 | 性能 | 中 | `components/chat/ChatRoundList.vue:3-167`、`components/common/MarkdownContent.vue:23-37` |
| 14 | admin | 模型管理 Tab 用 `models.length === 0` 当「未加载」标记，空 Tab 反复请求 | 功能 | 低 | `views/model/ModelListView.vue:416-422` |
| 15 | admin | 硬编码颜色多处绕过 `--mao-*` 变量；`main.ts` 全量注册约 300 个图标 | UI 样式 | 低 | `views/model/ModelFormDialog.vue:22-94` 等、`main.ts:17-19` |
| 16 | desktop+admin | 超大组件/文件与松散类型：TaskIndexPanel 2288 行、`(window as any).electronAPI` 30+ 处、axios 拦截器往 Result 塞 headers | 可维护性 | 低 | 多处 |

---

## 一、功能模块缺陷

### 1. 用量分析模块级缓存跨账号泄漏，登出不清缓存（admin，高）

- **位置**：`admin/src/views/analytics/composables/useScopeQuery.ts:15-19`；`admin/src/stores/auth.ts:36-45`（`logout`）
- **证据**：
  ```ts
  // useScopeQuery.ts:15-19 —— 模块级单例，存活于整个 SPA 生命周期
  const cache = new Map<string, CacheSlot>()
  const inflight = new Map<string, Promise<unknown>>()
  const CACHE_TTL_MS = 5 * 60 * 1000
  ```
  ```ts
  // stores/auth.ts:36-45 —— logout 只清 token 后 router.push('/login')，不刷新页面
  async function logout() {
    try { await api.post('/auth/logout') } finally {
      token.value = null
      user.value = null
      localStorage.removeItem('token')
      localStorage.removeItem('refreshToken')
    }
  }
  ```
- **行为**：手动退出登录走 `router.push('/login')`（`components/Layout.vue:155-156`）而非整页刷新，模块级 `cache`/`inflight` 不销毁。下一个账号登录后打开用量分析，`fetchScope` 命中未过期缓存（TTL 5 分钟）时直接返回上一个账号视角的数据，期间不发请求、无任何提示。
- **影响**：A 账号（高权限管理员）登出、B 账号在同一标签页登录后，可在缓存 TTL 内直接看到 A 的用量明细。属于跨账号数据泄漏。
- **修复建议**：`logout()`/401 强制下线路径统一调用 `invalidateAnalytics()`（或提供 `resetEphemeralCaches()` 收口所有模块级缓存）；更彻底的做法是把缓存挂到可 dispose 的 store 上，登出时统一清理。

### 2. WS 断线全程无 UI 反馈，`connected` 状态无人消费（desktop，高）

- **位置**：`desktop/src/composables/useStreamWS.ts:31`（`const connected = ref(false)`）、`:1095`（导出）；全工程 grep 确认无任何组件从 `useStreamWS()` 解构 `connected`，`App.vue`/`Layout.vue`/`TopNav.vue` 均无断线横幅
- **行为**：断线后进入指数退避重连（最长 30s/次），期间界面完全无感知：流式输出静默停止、正在执行的会话看起来像「卡住」，用户只能等到主动发送失败时才收到 toast。
- **影响**：弱网、服务端重启、deploy 滚动发布期间，用户无法区分「Agent 还在跑」与「连接已断」，可能重复发送或误以为任务完成。
- **修复建议**：在 `Layout.vue` 或 `ChatPanel` 顶部消费 `connected`，断线超过数秒显示「连接已断开，正在重连…」横幅，并对输入框给出降级提示。

### 3. 主会话图片/附件上传失败静默降级，可发出无图/空消息（desktop，高）

- **位置**：`desktop/src/composables/useChat.ts:315`（`uploadChatImages`）、`:381-384`（`uploadPendingFiles`）、`:421`（照发）；对照组 `desktop/src/components/chat/SideChatPanel.vue:710-713`；`desktop/src/utils/chatFileUpload.ts:52-53`
- **证据**：
  ```ts
  // SideChatPanel.vue:710-713 —— 边路已有防线
  // If user attached images but all uploads failed, do not send a text-only message by mistake.
  if (files.length > 0 && imageUrls.length === 0) { return }
  ```
  主链路 `useChat.prepareAndSendMessage` 没有这道防线：`uploadImages`（`utils/imageUpload.ts:29-58`）逐张 catch 后返回部分 URL，主流程不校验 `imageUrls.length` 与 `files.length` 是否一致；`uploadPendingFiles` 在附件全败时返回原文（`chatFileUpload.ts:52-53`），原文为空时会把一条空 content 消息发给 Agent。
- **影响**：失败时虽有逐张的「图片 xx 上传失败」toast，但发送流程不中止：用户看到消息「发出去了」，实际 Agent 收到的是无图甚至空消息，任务结果南辕北辙。
- **修复建议**：把 SideChatPanel 的 guard 上移到 `prepareAndSendMessage`：附件全败时中止发送并提示；部分成功时弹确认（部分发送 or 取消）；`resolvedText` 为空且无附件成功时阻断发送。

### 4. 心跳判死后 `ws.close()` 无强制重连兜底，半开连接长时间悬挂（desktop，高）

- **位置**：`desktop/src/composables/useStreamWS.ts:228-235`（心跳 interval）、`:281`（`scheduleReconnect` 只在 `onclose` 里调用）
- **证据**：
  ```ts
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return
    if (Date.now() - lastServerMessageAt > SERVER_SILENCE_TIMEOUT_MS) {
      ws.close()   // 重连完全依赖 onclose 触发
      return
    }
    ws.send(JSON.stringify({ type: 'ping' }))
  }, 5_000)
  ```
- **行为**：对半开 TCP（合盖休眠、拔线无 RST），`close()` 发出的关闭帧得不到对端应答，`onclose` 可能等 OS 级 TCP 超时（分钟级）才触发；而心跳 interval 在 `readyState !== OPEN` 时直接 return，此后再无任何看门狗。桌面/Web 端没有 `useForegroundRecovery`（仅限安卓）兜底。
- **影响**：检测到 30s 静默后反而可能进入比不检测更糟的「假死」状态——界面不重连、不报错，叠加第 2 条（无断线 UI）用户完全无感知。
- **修复建议**：`ws.close()` 后启动 2-5s 强制兜底定时器，`onclose` 未触发则主动置空并 `scheduleReconnect()`。

### 5. 系统设置两个子面板刷新语义互相矛盾：一个静默丢编辑、一个永不同步（admin，中）

- **位置**：`admin/src/views/settings/SystemSettingsView.vue:38-51`（三个面板均 `@saved="fetchSettings"`）；`admin/src/views/settings/components/CompanySsoConfigPanel.vue:61-71`；`admin/src/views/settings/components/IntegrationConfigPanel.vue:126-132,340`
- **证据**：
  ```ts
  // CompanySsoConfigPanel.vue:61-71 —— watch props.row，settings 数组一换就整体重置
  watch(() => props.row, (row) => {
    ...
    model.value = config
    domains.value = config.allowedDomains.join('\n')
    origins.value = config.allowedOrigins.join('\n')
  }, { immediate: true, deep: true })
  ```
  ```ts
  // IntegrationConfigPanel.vue:126-132 —— 只填未触碰过的 key
  function syncFromRows() {
    for (const row of visibleRows.value) {
      if (model[row.settingKey] === undefined) {
        model[row.settingKey] = row.isSecret === 1 ? '' : (row.value ?? '')
      }
    }
  }
  ```
- **行为**：任一面板保存成功 → 父组件 `fetchSettings()` 整体替换 `settings` 数组 → 公司 SSO 面板里**用户正在编辑但未保存的域名/Origin 白名单被静默重置**，无任何提示；而集成面板的 `syncFromRows` 只填 `undefined` 的 key，刷新后已触碰字段**永远停留在旧值**。同一页面上两个面板行为互相矛盾。
- **与历史评审的关系**：这是同一根因家族的两个新症状。`2026-09-21-frontend-review-01.md` #7 报的「刷新不同步已有字段」只在分类卡片修了（改为无条件覆盖），`IntegrationConfigPanel` 仍是修复前的旧语义；`2026-09-28-frontend-review-01.md` #10 报的「切走再切回丢编辑」触发点是 keep-alive `onActivated`，本条触发点是**兄弟面板保存**，且指出两个子面板之间存在方向相反的矛盾行为。
- **影响**：配置丢失，或陈旧配置被误保存——多人同时改配置时后者用陈旧值覆盖别人的修改（正是分类卡片注释里记载过的事故场景）。
- **修复建议**：三个面板统一对齐分类卡片的策略：刷新时无条件以服务端值覆盖；有未保存编辑时先弹「丢弃并刷新 / 保留本地编辑」确认。

### 6. 登录失败双重提示（拦截器与页面 catch 各弹一次）（admin，中）

- **位置**：`admin/src/api/index.ts:54-57`（`code !== 0` 时 `ElMessage.error(data.message)` 并 reject）；`admin/src/views/auth/LoginView.vue:127-128`
- **证据链（已与后端交叉核实）**：密码错误时后端抛 `BusinessException(ErrorCode.LOGIN_FAILED)`，`LOGIN_FAILED.code = 1005`（`backend-ts/src/common/error-code.ts:6`），`handleError` 只把 1001/401 映射为 HTTP 401、其余映射为 HTTP 200（`backend-ts/src/common/http-error.ts:68-77`）。因此登录失败走 **HTTP 200 + `code: 1005`**：拦截器成功分支先弹一次「用户名或密码错误」并以 `Error(data.message)` reject → `LoginView` catch 用同一个 message 再弹一次：
  ```ts
  // LoginView.vue:127-128
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || '登录失败')
  }
  ```
  同样的双重提示还存在于 `EcpConfigPanel.vue:85-86`、`EcpFeishuCallbackView.vue:41-44`、`LoginView.vue:144-147`（飞书登录启动）。
- **影响**：每次输错密码弹两条相同的错误 toast，观感粗糙。
- **修复建议**：登录/回调类请求在拦截器中按 URL 白名单或 config 标记（如 `skipErrorToast`）跳过自动提示，交由页面自行处理。另注：`api/index.ts:99` `forceLogout` 硬编码 `window.location.href = '/admin/login'`，与 `import.meta.env.BASE_URL` 解耦失败时即 404，建议一并改为 `BASE_URL + 'login'`。

### 7. 多处未捕获的 Promise rejection（删除失败无反馈、控制台报错）（admin，中）

- **位置与证据**：
  ```ts
  // views/mcp/McpServerListView.vue:549-553 —— 同文件其他操作都有 try/catch，唯独删除漏了
  async function handleDelete(row: any) {
    await api.delete(`/mcp-servers/${row.id}`)   // 无 try/catch
    ElMessage.success('删除成功')
    await loadData()
  }
  ```
  - `views/feedback/FeedbackView.vue:243-252`：`fetchList` 只有 `try/finally` 无 `catch`，且被模板直接调用（`:124-125 @current-change="fetchList"`、`:264-267 handleSizeChange` 裸调用）。
  - `views/session/SessionListView.vue:281-288`：`fetchOptions` 用 `Promise.all` 拉用户/Agent 两个下拉，无 try/catch，在 `:375 onMounted` 裸调用——**任一接口失败则两个下拉同时为空**，且没有任何兜底提示。
- **影响**：请求失败时拦截器虽弹了 toast，但 rejection 继续上抛成为 unhandledrejection（污染监控/控制台）；`fetchOptions` 场景还直接造成功能性缺陷。
- **与历史评审的关系**：`2026-09-28-frontend-review-01.md` #21 报的是同文件 `toggleStatus` 无确认/无 try/catch，本条是 `handleDelete`，不重复；#8 报的是反馈页每页条数不生效，本条是 `fetchList` 缺 catch，不重复。
- **修复建议**：补齐 try/catch（与同文件其他函数一致的「拦截器已提示」注释模式即可）；`fetchOptions` 改用 `Promise.allSettled` 或分别 catch。

### 8. Skill 系统分支 URL 未 `encodeURIComponent`，与个人分支不一致（admin，中）

- **位置**：`admin/src/views/skill/SkillListView.vue:471`（查看）、`:728`（删除）
- **证据**：
  ```ts
  // 个人分支（:468、:726）已正确编码
  await api.get(`/admin/user-skills/${row.userId}/${encodeURIComponent(row.name)}`)
  // 系统分支直接拼接
  const { data } = await api.get(`/skill-docs/${row.name}`)
  await api.delete(`/skill-docs/${row.name}`)
  ```
- **影响**：Skill 名含 `?`、`#`、`/`、空格等字符时，系统分支请求路径被截断/错位，返回 404 或删错对象。
- **修复建议**：系统分支同样 `encodeURIComponent(row.name)`。

### 9. 用户详情抽屉切换用户不清空旧数据，短暂展示上一位用户明细（admin，中）

- **位置**：`admin/src/views/user/UserDetailDrawer.vue:242-252`（`handleOpen`）；抽屉复用同一组件实例（`UserListView.vue:242-246`）
- **证据**：
  ```ts
  function handleOpen() {
    activeTab.value = 'sessions'
    sessionsPage.value = 1
    tasksPage.value = 1
    void loadSessions()   // sessions/tasks/commands/skills/gitCredentials/mcpServers 旧值未清空
    void loadTasks()
    ...
  }
  ```
- **行为**：打开用户 B 时，六个数据数组仍是用户 A 的数据；`v-loading` 遮罩有透明度，加载期间能看到上一位用户的明细行。
- **影响**：管理场景下的越权视觉泄漏（接口数据正确，但渲染层短暂展示了别人的数据），并造成「数据错乱」困惑。
- **与历史评审的关系**：`2026-09-21-frontend-review-01.md` #5/#13/#17 报的分别是 `loadingTab` 共用、自造 `phaseLabel`、Token 列占位，与本条不重复。
- **修复建议**：`handleOpen` 开头清空六个数组并重置 `sessionsTotal/tasksTotal`。

### 10. 会话导出：游离 `a.click()` + 同步 revoke 可静默失败；导出游标循环无上限（admin，中）

- **位置**：`admin/src/views/session/SessionDetailView.vue:280-286`（下载）、`:264-273`（导出循环）
- **证据**：
  ```ts
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `session-${id}-....json`
  a.click()                  // 未 appendChild
  URL.revokeObjectURL(url)   // 同步 revoke
  ```
  对照 `admin/src/views/analytics/utils/csv.ts:18-22` 的注释：「必须挂到 DOM 再点击，且 revoke 延后到下一个宏任务：游离节点 click() 与同步 revokeObjectURL 在部分浏览器/WebView 下会让下载无声失败」——项目自己已经踩过并修了 csv.ts，但 SessionDetailView 没对齐。导出循环 `for (;;)` 仅以后端 `hasMore` 为退出条件，若后端游标异常（重复返回同一 `nextBeforeMessageId`）将无限循环请求；导出海量会话时也无进度反馈。
- **与历史评审的关系**：`2026-09-21-frontend-review-01.md` #15 报的是 analytics `csv.ts`（已修），本条是同一坑在 SessionDetailView 的未修副本，另新增「游标循环无上限」。
- **修复建议**：改用 csv.ts 同款下载 helper（appendChild + 延迟 revoke）；循环加「nextBeforeMessageId 与上轮相同则中断」的防御和最大轮次。

### 11. 登出/换号时模块级状态残留：中心 Tab、待审批队列、关闭标记（desktop，中）

- **位置**：`desktop/src/stores/auth.ts:62-74`（`clearLocalSession`）；`desktop/src/composables/useCenterTabs.ts:14-15`；`desktop/src/composables/useChat.ts:37`；`desktop/src/utils/side-task-tabs.ts:1,28`
- **证据**：`clearLocalSession()` 依次 disconnect WS、reset 了 session/draft store 和 terminal，但：
  1. `useCenterTabs` 的 `sessionTabsMap`/`currentSessionId` 没有任何登出清理入口（全工程仅 `removeSessionTabsFor` 在删除单个会话时调用）；
  2. `useChat.ts:37` 的模块级 `pendingApprovals` 只在 `newSession`/`cleanup` 按会话清理，登出路径从未调用 `clearPendingApprovals()` 全量清理——残留审批项中 `sessionId` 为空的条目会被 `ChatPanel.vue:435` 的过滤条件（`!a.sessionId || a.sessionId === parentId`）透传进新账号的审批栈，`confirmApproval` 会向旧工具调用回包；
  3. `side-task-tabs.ts` 的 localStorage 关闭标记 key 为 `mao:closed-side-tasks:{sessionId}`，不含用户维度，同机换号后数字 sessionId 碰撞会错误隐藏新账号的边路 Tab，且 key 只增不减。
- **影响**：SPA 登出不刷新页面，B 账号登录后若会话 ID（服务端自增数字）与 A 碰撞，会复活 A 的中心 Tab 条 / 收到 A 的待审批 / 看不到自己的边路 Tab。
- **与历史评审的关系**：`2026-09-01-frontend-review-01.md` F2 报的「删除会话后 Tab 状态残留」已修（`removeSessionTabsFor`），本条是**登出路径**无清理，不重复。
- **修复建议**：`clearLocalSession()` 增加 `sessionTabsMap`/`currentSessionId` 复位与 `clearPendingApprovals()` 全量调用；`closed-side-tasks` key 加用户 ID 维度或登出时批量清除。

### 12. token 明文镜像进 localStorage，与文件头注释目标相悖，且写失败会炸掉登录（desktop，中）

- **位置**：`desktop/src/utils/auth-storage.ts:1-25`（`mirrorToLocalStorage`）、`:48-56`（`setTokens`）
- **证据**：
  ```ts
  /**
   * Auth token storage.
   * Electron 环境...统一由主进程写入 userData/auth.json，避免依赖 localStorage...
   */
  function mirrorToLocalStorage() {
    if (tokenCache) { localStorage.setItem('token', tokenCache) }  // Electron 下照样镜像
    ...
  }
  ```
- **行为**：注释声明「避免依赖 localStorage」，但 `mirrorToLocalStorage()` 无条件把 accessToken/refreshToken 写进 localStorage（Electron 亦然）——XSS 一旦发生 token 直接被偷，且 devtools 一眼可见，安全边界反而扩大。另：`localStorage.setItem` 无 try/catch（对比 `stores/session.ts:152-159` 的 `persistLastSession` 有兜底），存储被禁用/配额满时抛 `SecurityError/QuotaExceededError`，而 `setTokens()` 在写 Electron 主进程**之前**先调用 mirror → 异常直接导致 `applyLogin` 失败，登录假失败。
- **修复建议**：Electron 下去掉 mirror（或只镜像非敏感标记位）；所有 localStorage 写操作统一收口一个 `safeSetItem` 工具函数包 try/catch。

### 13. 消息列表无虚拟滚动、分页无上限，Markdown 重渲染与全局事件双重放大（desktop，中）

- **位置**：`desktop/src/components/chat/ChatRoundList.vue:3-167`（全量 `v-for`，无窗口化）；`desktop/src/composables/useChat.ts:210-237` + `desktop/src/stores/session.ts:1214-1220`（`loadOlderMessages` → `prependMessages` 只增不裁）；放大器 `desktop/src/components/common/MarkdownContent.vue:23-37`
- **证据**：
  ```ts
  // MarkdownContent.vue:23-37 —— 每个气泡每次内容变化都 new Marked + Monaco 高亮 + DOMPurify
  watch([() => props.content, isDark], async ([content]) => {
    const next = content ? await renderMarkdown(content, isDark.value) : ''
    ...
    nextTick(() => { window.dispatchEvent(new CustomEvent('mao:markdown-rendered')) })  // 全局广播
  }, { immediate: true })
  ```
- **行为**：`renderMarkdown`（`useMarkdown.ts:64-75`）每次调用都 `new Marked(...)` 并 await Monaco 高亮；每个气泡渲染完都广播全局 `mao:markdown-rendered` 事件，而 ChatPanel/SideChatPanel/SubagentChatPanel 都监听它并执行滚动。历史加载几十轮后：DOM 节点数、Monaco colorize 调用、全局事件分发全部线性增长；流式期间的 150ms 节流（`session.ts:1327-1335`）只缓解当前轮，不解决历史累积。
- **修复建议**：折叠的历史轮次对不可见内容不挂载 Markdown；长期引入虚拟滚动或对 `messages` 做窗口裁剪；`mao:markdown-rendered` 改为带 sessionId/消息 ID 的定向回调，避免每次渲染唤醒所有面板。

### 14. 模型管理 Tab 用 `models.length === 0` 当「未加载」标记，空 Tab 反复请求（admin，低）

- **位置**：`admin/src/views/model/ModelListView.vue:416-422`
- **证据**：
  ```ts
  function handleTabChange() {
    const tab = activeTab.value
    if (tabStates[tab].models.length === 0) {
      fetchModels()
    }
  }
  ```
- **行为**：① 某 Tab 真实数据为 0 条时，每次切入都重复发请求；② 已加载过的 Tab 在同一次页面激活期间永远不会因 Tab 切换而刷新，与其他页面「切 Tab 即刷新」的直觉不一致。
- **修复建议**：为每个 TabState 增加显式的 `loaded: boolean` 标记替代 `length === 0` 判断。

---

## 二、UI 样式

### 15. admin 硬编码颜色多处绕过 `--mao-*` 变量；`main.ts` 全量注册约 300 个图标（admin，低）

- **硬编码颜色**：`admin/src/style.css` 已定义 `--mao-danger/--mao-warn/--mao-success/--mao-muted` 等变量，但未使用的位置包括：
  - `views/model/ModelFormDialog.vue:22-23,49,68,86,90,94` — 内联样式 `style="margin-left: 8px; color: #909399; font-size: 12px;"` 重复 6 次（内联样式滥用 + 硬编码双料问题；项目多个组件各自 scoped 重复声明了同款 `.form-hint` 类，应抽成全局类统一复用）；
  - `views/analytics/tabs/SessionTab.vue:328,386` — `color: #ff3b30`；`views/analytics/tabs/OverviewTab.vue:341,463` — `color: #c9252d`（同为「告警红」却用两个不同色值）；
  - `views/session/components/FileChangePanel.vue:187-225` — `#2d8a2d / #b87a00 / #d94141 / #6b46c1` 等 6 处；
  - `components/TabBar.vue:146,155` — 焦点框 `rgba(0,102,204,0.28)`（即 `--mao-accent` 的硬编码 rgba 版）、`background: #d2d2d7`；
  - `views/user/ResetPasswordDialog.vue:164`、`views/permission/RolePermissionView.vue:447` — `#606266` / `#909399`。
- **影响**：主题色调整或将来接入暗色主题时这些点全部遗漏；同为「红」用了三个不同色值，视觉不一致。
- **修复建议**：统一收敛到 `--mao-*` 变量（缺失的语义色先在 style.css 补变量）；`ModelFormDialog` 的 6 处内联样式抽成公共类。
- **图标全量注册**：`admin/src/main.ts:17-19`
  ```ts
  for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
    app.component(key, component)
  }
  ```
  约 300 个图标组件进主包，实际用到的不到 20 个；echarts 已按需注册（`utils/echarts.ts`），图标应对齐为按需 import。
- **与历史评审的关系**：desktop 侧的硬编码色（GitChangeTreeNode / TaskInspector / ChatInput 的 `rgba(0,102,204,·)`）已由 `2026-09-28-frontend-review-01.md` #15/#16 覆盖；本条只列 admin 侧，不重复。desktop 侧另存的 `SideTaskList.vue:463-599`（27 处 hex，深色覆盖块与 `--aw-*` 变量体系不一致）、`TaskIndexPanel.vue:1662-2286`（41 处 hex）、`CenterTabBar.vue:244-245`（`background: #fff` 死声明 + 浅色 fallback）建议一并纳入本条的收敛范围处理。

---

## 三、可维护性

### 16. 超大组件/文件与松散类型（desktop + admin，低）

- **超大文件**：
  - `desktop/src/components/task/TaskIndexPanel.vue` — 2288 行（列表 + 分组 + 右键菜单 + 拖拽 + 面板 resize + 聚焦模式 + 归档区）
  - `desktop/src/components/chat/ChatInput.vue` — 2097 行（编辑器 + 快捷指令 + 文件引用 + 拖拽上传 + 草稿 + 移动端适配）
  - `desktop/src/stores/session.ts` — 1998 行（实体缓存 + 消息缓存 + 队列 + 边路 + 子代理 + 文件变更 + 审批计数）
  - `admin/src/views/agent/AgentFormDialog.vue` — 937 行，且 `:296` 用 `document.querySelector('.experience-text-editor')` 做组件内全局 DOM 查询（依赖「同时只有一个弹窗」的隐式假设），`:307` 以 80ms 轮询同步 scrollTop（textarea 打开期间常驻，即使无滚动）
  - 建议：按域拆分（ChatInput 拆出快捷指令/文件引用 composable；session store 拆出消息缓存模块）；AgentFormDialog 的 DOM 查询改模板 ref、轮询改 `@scroll` 事件。
- **`(window as any).electronAPI` 绕过类型声明**：`desktop/src/types/electron.d.ts:295` 已声明 `Window.electronAPI`，`utils/auth-storage.ts:29` 也在用类型化访问，但仍有 13 个文件、33 处 `(window as any).electronAPI.xxx`（如 `useStreamWS.ts:172,328,919`、`useChat.ts:44,73`、`ChatInput.vue`、`SkillManager.vue:327-484`）。any 链上方法改名/签名变更编译期不报错，preload.cjs 与 d.ts 漂移时无法发现。建议统一改类型化访问 + `isElectronClient()` 守卫，并对 preload.cjs 与 d.ts 做一次对齐审计。
- **axios 拦截器往 Result 信封塞 headers**：`admin/src/api/index.ts:60-62`
  ```ts
  if (data && typeof data === 'object') {
    return Object.assign(response.data, { headers: response.headers })
  }
  ```
  业务侧靠 `const { data, headers } = await api.get(...)`（如 `SystemCommandListView.vue:412`）解构 `x-total-count`，把 axios 实现细节泄漏进「Result 信封」这一应用层契约：后端若在 Result 里加 `headers` 字段会直接冲突，且类型上完全不可见。建议改为自定义响应包装（始终返回 `{ result, headers }`）或单独提供带总数的分页请求 helper。
- **admin 侧 `any` 约 98 处**（各列表页 `ref<any[]>`、`row: any`、`catch (error: any)` 为主），后端已有 `@mao/contracts` 可逐步对齐；其中 `LoginView.vue:127` 的 `error: any` 正是第 6 条双重提示的直接原因之一。
- **零散项**（确认存在、修复成本低，不展开）：
  - `admin/src/views/llm-call/LlmCallView.vue:397-440`：`doExportCsv` 完成后无成功提示，导出防抖期间重复点击被静默忽略；
  - `admin/src/views/scheduled-tasks/index.vue:334-342`：`handleToggleStatus` 的 el-switch 无二次确认（同项目模型/Agent 启停都有确认），快速连续拨动无竞态保护；
  - `admin/src/views/permission/RolePermissionView.vue`：路由 `keepAlive: true` 但无 `onActivated` 刷新（其他页面均已补 firstActivation 模式）；
  - `admin/src/views/auth/LoginView.vue:95`：setup 顶层每次挂载执行 `localStorage.removeItem('rememberedPassword')`，属历史遗留清理代码；
  - `admin/src/views/api-key/`：空目录残留，无任何引用；
  - `desktop/src/utils/theme.ts:87`、`desktop/src/composables/useVersionCheck.ts:68,358`、`desktop/src/utils/side-task-tabs.ts:28,37`：localStorage 写操作无 try/catch（`setTheme` 在存储不可用时切换主题直接抛错），正面范例 `stores/session.ts:152-159`。

---

## 四、复核说明

- **已回读源码复核的高严重度条目**：#1（模块级 cache 与 logout 逻辑、Layout.vue 的 `router.push('/login')` 导航）、#2（`connected` 全工程无消费方，grep 确认）、#3（主链路无 guard、SideChatPanel 有 guard 对照）、#4（心跳与 scheduleReconnect 调用点）、#5（两个面板的 watch/syncFromRows 与父组件 `@saved="fetchSettings"`）、#6（后端 `handleError` 状态码映射 + `LOGIN_FAILED.code=1005` → HTTP 200，确认触发双重提示而非 401 强刷）、#8（两个分支编码差异）、#9（handleOpen 无清空、UserListView 复用同一抽屉实例）、#11（clearLocalSession 清理范围、clearPendingApprovals 仅按会话调用）、#12（mirror 无 try/catch 且在写主进程之前）。
- **二次核对后移除的条目**（确认存在但修复价值过低，不再跟踪）：
  - 原 #14「每个 MessageBubble 挂 document 级 click 监听」：`MessageBubble.vue:556-564` 属实且有配对清理，但 handler 在弹层关闭时第一行即 return，每次文档点击的实际开销是 N 次布尔判断，任何现实会话规模下都无可测量影响；建议的修复（按弹层可见性动态注册）引入的复杂度大于收益。
  - 原 #15「session store upsert 全量拷贝 Map」：`session.ts:497-504` 属实，但 O(n²) 仅出现在 `fetchSessions` 批量路径，按现实会话规模（几十到几百）折算为次毫秒级的指针拷贝，WS 事件路径每次也只拷贝一次；不构成用户可感知的性能问题。
- **已核查且无问题、不再重复报告的方向**：desktop 的 XSS 防线（DOMPurify + `isSafeHref`，全工程唯一 `v-html` 输入源即 sanitize 结果）；WS 竞态（迟到 onclose/onopen 守卫、executionId 过滤、占位气泡回滚）；发送互斥（`sending` 门 / `sendInFlight` 门 / `waitingForSave` 超时）；监听器清理（各面板 window/document 监听均有配对移除）；无 console.log 残留。
- **审查方法声明**：本轮为静态源码审查，未运行 vue-tsc / 构建 / 单测，未做运行时与视觉验证；行号对应当前工作区文件，后续提交可能导致偏移。

## 五、修复优先级建议

1. **第一梯队（数据正确性/安全）**：#1 用量分析缓存跨账号泄漏、#3 上传失败静默降级、#11 登出状态残留、#12 token 镜像。
2. **第二梯队（可用性硬伤）**：#2 断线无反馈、#4 半开连接悬挂（两条建议一起修，断线横幅依赖稳定的状态机）、#5 设置面板丢编辑、#6 登录双重提示、#10 会话导出下载。
3. **第三梯队（健壮性与一致性）**：#7 未捕获 rejection、#8 URL 编码、#9 抽屉脏数据、#14 Tab 加载标记。
4. **第四梯队（性能与可维护性，随迭代顺带做）**：#13 虚拟滚动、#15 颜色变量收敛 + 图标按需、#16 组件拆分与类型收口。

## 六、修复状态（2026-09-30，随 0.0.224 落地）

- **已修复**：#1（logout/clearAuth 调用 `invalidateAnalytics()`）、#2（新增 `ConnectionBanner`，消费 `connected`+新增 `everConnected`，挂在 Layout）、#3（`guardUploadsBeforeSend` 覆盖 prepareAndSendMessage 与入队路径，SideChatPanel 防线扩展到文件附件）、#4（心跳判死后 3s 强制重连兜底，含回归测试）、#5（新增 `useServerSyncGuard` 统一三个面板语义；IntegrationConfigPanel 改为按 key 基线跟随）、#6（拦截器支持 `skipErrorToast`，登录/ECP 链路调用点已接入；`forceLogout` 改用 BASE_URL）、#7（三处补齐 catch / allSettled）、#8（系统分支补 encodeURIComponent）、#9（handleOpen 清空六类数据）、#10（新增 `utils/download.ts`，csv.ts/SessionDetailView/LlmCallView 共用；游标同值中断 + 200 轮上限）、#11（`resetCenterTabs` + 全量 `clearPendingApprovals()` + `clearAllClosedSideTasks()` 接入 `clearLocalSession`）、#12（Electron 不再镜像 localStorage 并清理历史残留；新增 `utils/safe-storage.ts` 收口写操作）、#14（TabState 增加 `loaded` 标记）、#15（颜色收敛到 `--mao-*`，新增 `--mao-danger-bg/--mao-accent-ring/--mao-renamed/--mao-chip`；全局 `.form-hint`/`.form-hint-inline`；图标全局注册收窄到 7 个）。
- **#13 部分修复**：Marked/inline 实例按主题复用（`useMarkdown.ts`）。虚拟滚动 / 历史消息窗口裁剪 / `mao:markdown-rendered` 定向化属架构级改动，本轮未动，后续单独立项。
- **#16 部分修复**：已完成——LlmCallView 导出补成功提示并换用 downloadBlob；定时任务启停加二次确认（改 `:model-value` 语义，确认前不翻转）；RolePermissionView 补 `onActivated` 刷新；删掉 LoginView 历史遗留 `rememberedPassword` 清理与空目录 `views/api-key/`；AgentFormDialog 改模板 ref + scroll 事件（去掉 80ms 轮询与全局 querySelector）；axios 拦截器不再往 Result 塞 headers，改 `apiGetWithHeaders()` 专用通道（SystemCommandListView 已切换）。**未做**：超大文件拆分（TaskIndexPanel/ChatInput/session store）、`(window as any).electronAPI` 30+ 处类型化收口、admin 侧 ~98 处 `any` 对齐 `@mao/contracts`——均为大面重构，建议单独迭代。
