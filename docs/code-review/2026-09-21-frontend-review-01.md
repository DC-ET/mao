# 前端问题审查报告（admin + desktop）

- 审查时间：2026-09-21
- 审查范围：`admin/src/`（管理后台，Vue3 + Element Plus）、`desktop/src/`（桌面 / Web / 安卓共用 UI，Vue3 + Pinia）
- 审查维度：功能模块、UI 样式、交互逻辑
- 方法：先按模块并行通读，再由主审查逐条回源码核验（含交叉验证 `backend-ts/` 的接口返回与枚举口径）。**本文只收录已核验成立的问题**；核验不成立的候选项集中记录在文末「已排除的误报」一节，避免后续重复排查。
- 与历史文档的关系：刻意避开 `2026-08-30-frontend-review-01.md`、`2026-09-01-frontend-review-02.md`、`2026-09-18-logic-bug-review-01.md` 等已记录条目，本文 17 条均为新问题。

## 严重度汇总

| # | 端 | 问题 | 类别 | 严重度 | 位置 |
|---|---|---|---|:---:|---|
| 1 | admin | 用量分析每次切换周期/子 Tab 都在顶栏新增一个「用量分析」标签 | 功能 | 高 | `stores/tabs.ts:22` + `components/Layout.vue:129` + `views/analytics/AnalyticsView.vue:317` |
| 2 | desktop | 新建 Markdown 的 diff 点「源码」永久空白 | 功能 | 高 | `components/center/FileDiffViewer.vue:9,226-234` |
| 3 | desktop | 审批卡片先移除再发送且不看发送结果，WS 失败后任务永久卡在待审批 | 功能 | 高 | `composables/useChat.ts:66-77` |
| 4 | desktop | 「关闭其他文件」连带关掉边路任务/子代理 Tab，且漏记关闭状态 | 功能/交互 | 中高 | `composables/useCenterTabs.ts:368-374` |
| 5 | admin | 用户详情抽屉 6 个并行请求共用一个 `loadingTab`，加载态错乱 | 交互 | 中 | `views/user/UserDetailDrawer.vue:190,234-243` |
| 6 | admin | 审计日志「自动刷新」切页后永久停摆，开关仍显示开启 | 功能 | 中 | `views/audit/AuditLogView.vue:205-220,285` |
| 7 | admin | 系统设置点刷新不同步已有字段，界面与数据库长期不一致 | 功能 | 中 | `views/settings/SystemSettingsView.vue:237-244` |
| 8 | desktop | 队列「立即发送」失败后阻塞**全部**插入按钮直到执行结束 | 交互 | 中 | `components/chat/QueuePanel.vue:193-197,128-147` |
| 9 | desktop | `@` 文件引用搜索无竞态保护，慢响应覆盖新结果 | 功能 | 中 | `components/chat/ChatInput.vue:625-655,1049-1058` |
| 10 | desktop | 微信绑定在 confirm 参数缺失时跳过确认请求仍提示「绑定成功」 | 功能 | 中 | `views/settings/WeixinBotView.vue:224-257` |
| 11 | admin | 移动端布局下「系统 Skills」删除按钮未校验 `agent:write` | 功能(权限) | 中 | `views/skill/SkillListView.vue:105,196` |
| 12 | admin | 调用流水页 keep-alive 返回后不刷新，长期展示陈旧数据 | 功能 | 中低 | `views/llm-call/LlmCallView.vue:430-434` |
| 13 | admin | 用户详情抽屉自造 `phaseLabel`，缺 IDLE/WAITING_APPROVAL 且与全站口径分叉 | 功能/一致性 | 低 | `views/user/UserDetailDrawer.vue:220-225` vs `utils/labels.ts:39` |
| 14 | desktop | 非桌面端点「在文件浏览器中打开」静默无反馈（同文件的终端入口有提示） | 交互(三端) | 低 | `components/task/TaskIndexPanel.vue:860-865` |
| 15 | admin | 用量分析 CSV 导出未挂 DOM 且同步 revoke，与同仓库另一处导出实现不一致 | 功能 | 低 | `views/analytics/utils/csv.ts:14-18` |
| 16 | desktop | 提问面板堆叠时 badge 显示总数，但只有最后一组可作答 | 交互 | 低 | `components/chat/QuestionPanel.vue:6,128-136` |
| 17 | admin | 用户详情抽屉 Git「Token」列恒为 `****`，占用 140px 无信息量 | UI 样式 | 低 | `views/user/UserDetailDrawer.vue:120` |

---

# 一、高

## 1. 用量分析每次切换周期/子 Tab 都在顶栏新增一个「用量分析」标签（admin）

**位置**：`admin/src/stores/tabs.ts:21-41`、`admin/src/components/Layout.vue:129-131`、`admin/src/views/analytics/AnalyticsView.vue:278-317`

**根因**：三处独立正确的设计组合出了缺陷。标签页以 `route.fullPath`（含 query）作为唯一键：

```21:28:admin/src/stores/tabs.ts
  function addTab(route: RouteLocationNormalized) {
    const path = route.fullPath
    const existing = tabs.value.find(t => t.path === path)
    if (existing) {
      activeTabPath.value = path
      return
    }
```

`Layout` 对任何路由变化都无条件建标签：

```129:131:admin/src/components/Layout.vue
watch(route, (newRoute) => {
  tabStore.addTab(newRoute)
}, { immediate: true })
```

而用量分析页把 tab / period / view / conn / modelId 全部同步进 URL，每次变更都 `router.replace`：

```317:317:admin/src/views/analytics/AnalyticsView.vue
  router.replace({ query })
```

**触发**：进入用量分析（管理后台首页），切换统计周期或子 Tab（总览/趋势/模型/用户/Agent）若干次。

**影响**：每一个 query 组合都被当成一个新页面，顶栏堆积多个同名「用量分析」标签（`closable: true`，与固定的 `/analytics` 默认标签并存）。正常使用几分钟就能刷出十几个标签，标签栏被挤满、无法分辨、只能逐个关闭。

> 补充核验：`Layout.vue:57-63` 的 `keep-alive` 是按 `viewRoute.path` 做 key 的（仅 `SessionDetail` 用 fullPath），所以本问题**不会**额外放大组件缓存数量，影响面仅限标签栏。

**建议**：`addTab` 改用 `route.path`（或 `route.name`）作为唯一键，标签内记录最近一次 `fullPath` 用于点击时还原 query。这样同一页面的筛选变化只更新现有标签，不再新增。

---

## 2. 新建 Markdown 的 diff 点「源码」永久空白（desktop）

**位置**：`desktop/src/components/center/FileDiffViewer.vue:9,48,81-83,120-131,226-234`

**根因**：新建 Markdown 文件的 diff 提供「预览 / 源码」切换，源码视图的 Monaco 容器由 `v-if` 控制：

```9:9:desktop/src/components/center/FileDiffViewer.vue
    <div v-if="mode === 'SNAPSHOT' && showSource" ref="diffContainer" class="monaco-diff-container"></div>
```

但组件里唯一的 `watch` 只盯 `props.change` 和 `isDark`，**没有任何 watch 监听 `viewMode` / `showSource`**：

```226:234:desktop/src/components/center/FileDiffViewer.vue
watch(
  [() => props.change, isDark],
  () => {
    // Reset view mode when file changes
    viewMode.value = 'preview'
    void syncViewer()
  },
  { deep: true, flush: 'post', immediate: true },
)
```

`immediate` 那次运行时 `viewMode` 为 `'preview'`，`showSource` 为 false，容器不在 DOM 中，`syncViewer` 在这里直接退出：

```129:131:desktop/src/components/center/FileDiffViewer.vue
  if (mode.value === 'SNAPSHOT') {
    disposePatchEditor()
    if (!diffContainer.value) return
```

于是 diff 编辑器从未被创建。用户点「源码」后容器虽然挂载，却没有任何代码再调用 `syncViewer`。

**触发**：Agent 新建一个 `.md` 文件 → 在文件变更列表点该文件打开 diff Tab → 点「源码」。

**影响**：源码视图**恒为空白**，且反复切换预览/源码都无法恢复，只能改用「打开当前文件」绕过。这条路径在 Mao 里很常见（Agent 写 Markdown 方案/报告后用户想看原文）。此外该 watch 是 `deep` 的，Git 状态刷新导致 `change` 更新时会把 `viewMode` 强制打回 `preview`，即便修好了空白问题，也会打断用户阅读。

**建议**：把 `showSource` 加入 watch 源（`watch([() => props.change, isDark, showSource], ...)`），并只在 `props.change.path` 真正变化时才重置 `viewMode`，避免同文件刷新打断阅读。

---

## 3. 审批卡片先移除再发送且不看发送结果，WS 失败后任务永久卡在待审批（desktop）

**位置**：`desktop/src/composables/useChat.ts:66-77`

**根因**：确认审批时，UI 状态在网络请求**之前**就被清掉，且 `sendToolApproval` 的返回值被丢弃：

```66:77:desktop/src/composables/useChat.ts
  async function confirmApproval(requestId: string, approved: boolean) {
    const item = pendingApprovals.value.find(a => a.requestId === requestId)
    if (item?.sessionId) sessionStore.decrementPendingApproval(item.sessionId)
    pendingApprovals.value = pendingApprovals.value.filter(a => a.requestId !== requestId)
    if (requestId && isElectron) {
      await (window as any).electronAPI.respondToolApproval(requestId, approved)
    }
    if (item?.sessionId) {
      const { sendToolApproval } = useStreamWS()
      await sendToolApproval(item.sessionId, requestId, approved)
    }
  }
```

`sendToolApproval` 是 `sendReliable` 的封装，返回 `Promise<boolean>`，发送失败返回 `false`（`useStreamWS.ts:485-492`）。这里既不判断也不回滚。

**触发**：CLOUD 会话（Web / 安卓 / 桌面云端模式，此时 `isElectron` 分支的 IPC 兜底不存在）在 WS 瞬断、重连窗口或超时时点「执行 / 拒绝」。

**影响**：审批卡片消失、待审批计数减一，但服务端从未收到决议，会话永远停在 `WAITING_APPROVAL`。用户界面上已无任何审批入口，无法重新决策，只能刷新页面或放弃该会话。与之对照，`ApprovalStack.vue:90-94` 已经用 `handledIds` 做了"保留卡片到服务端响应前"的防重设计，注释也明确写着「审批卡片保留到服务端响应前」——但上层的 `confirmApproval` 直接把卡片删了，让这个设计失效。

**建议**：先标记为"提交中"，等 `sendToolApproval` 返回 `true` 后再从 `pendingApprovals` 移除并 `decrementPendingApproval`；返回 `false` 时恢复卡片并 `ElMessage.error` 提示重试。

---

# 二、中

## 4. 「关闭其他文件」连带关掉边路任务/子代理 Tab，且漏记关闭状态（desktop）

**位置**：`desktop/src/composables/useCenterTabs.ts:368-374`、`desktop/src/components/center/CenterTabBar.vue:41-43`

**根因**：菜单文案是「关闭其他**文件**」，实现却是"只留当前一个 Tab"，不区分类型：

```368:374:desktop/src/composables/useCenterTabs.ts
function closeOtherTabs(tabId: string) {
  const state = getSessionState()
  const tab = state.tabs.find(t => t.id === tabId)
  state.tabs = tab ? [tab] : []
  state.activeTabId = tabId
  notifyTabsChanged()
}
```

对比同文件的两个兄弟函数可见这是疏漏：`closeAllFileTabs`（359-366）明确只过滤 `file` / `diff`；`closeTab`（261-272）在关闭 `side_task` 时会调用 `markSideTaskClosed` 记录"用户主动关过"。`closeOtherTabs` 两件事都没做。

**触发**：在任意非 chat Tab 上右键 → 「关闭其他文件」。

**影响**：两层问题。其一，正在查看的边路任务、子代理 Tab 被一起关掉，与菜单文案不符。其二，因为漏调 `markSideTaskClosed`，这些边路 Tab 在下一次 `restoreSideTaskTabs`（289-302，按 `getClosedSideTaskIds` 过滤）时会**自己冒出来**——用户明确关掉的 Tab 又回来了，行为不可预期。

**建议**：与文案对齐，只关闭 `file` / `diff` 类型（复用 `closeAllFileTabs` 的过滤条件，保留当前 Tab）；若确实想保留"关闭全部其他"的语义，则必须补上对 `side_task` 的 `markSideTaskClosed` 记账。

---

## 5. 用户详情抽屉 6 个并行请求共用一个 `loadingTab`，加载态错乱（admin）

**位置**：`admin/src/views/user/UserDetailDrawer.vue:190,234-243,246-316`

**根因**：`loadingTab` 是单个字符串 ref，6 个 Tab 的 loading 全靠它区分（`v-loading="loadingTab === 'sessions'"` 等），但打开抽屉时 6 个请求是并行发出的：

```234:243:admin/src/views/user/UserDetailDrawer.vue
function handleOpen() {
  activeTab.value = 'sessions'
  sessionsPage.value = 1
  tasksPage.value = 1
  void loadSessions()
  void loadTasks()
  void loadCommands()
  void loadSkills()
  void loadGitCredentials()
  void loadMcpServers()
}
```

每个 loader 都是"进门写自己的名字、出门清空"（`loadingTab.value = 'xxx'` … `finally { loadingTab.value = '' }`）。后发起的覆盖先发起的，最先返回的那个把值清空。

**触发**：打开任意用户的详情抽屉。

**影响**：能看到 loading 的只可能是最后一个赋值的 Tab（`mcp`），而默认展示的「会话」Tab 几乎永远不显示加载骨架；只要有一个请求先返回，其余仍在途的 Tab 也都失去 spinner，表格空着像"无数据"。

**建议**：改为 `reactive<Record<string, boolean>>` 按 Tab 独立记录加载态。

---

## 6. 审计日志「自动刷新」切页后永久停摆，开关仍显示开启（admin）

**位置**：`admin/src/views/audit/AuditLogView.vue:205-220,285-287`

**根因**：路由 `audit-logs` 的 meta 是 `keepAlive: true`（`router/index.ts:80`），组件离开时只会 deactivate。代码在 deactivate 时停掉了定时器，却没有任何 `onActivated` 把它重新拉起：

```285:287:admin/src/views/audit/AuditLogView.vue
onDeactivated(stopAutoRefresh)

onBeforeUnmount(stopAutoRefresh)
```

而 `autoRefresh` 这个 ref 本身随 keep-alive 一起被缓存，仍然是 `true`。

**触发**：打开审计日志 → 打开「自动刷新」→ 切到其他菜单 → 切回来。

**影响**：开关明明是开启状态，列表却再也不会每分钟刷新。审计场景下用户会以为自己在实时盯监控，实际看的是几十分钟前的快照——这种"静默失效"比功能缺失更危险。

**建议**：补 `onActivated(() => { if (autoRefresh.value) startAutoRefresh() })`，并把启停逻辑抽成 `startAutoRefresh` / `stopAutoRefresh` 一对。

---

## 7. 系统设置点刷新不同步已有字段，界面与数据库长期不一致（admin）

**位置**：`admin/src/views/settings/SystemSettingsView.vue:237-244`

**根因**：把服务端返回灌进表单模型时，只填还没有值的键：

```237:244:admin/src/views/settings/SystemSettingsView.vue
function syncPlainModel() {
  for (const row of settings.value) {
    if (SPECIAL_KEYS.has(row.settingKey)) continue
    if (plainModel[row.settingKey] === undefined) {
      plainModel[row.settingKey] = row.isSecret === 1 ? '' : (row.value ?? '')
    }
  }
}
```

首次加载没问题，但之后每次 `fetchSettings()` → `syncPlainModel()` 都不会覆盖任何已存在的键。

**触发**：在系统设置页点头部「刷新」；或在某个分类保存成功后触发父级重新拉取（此时其他分类的输入框保持旧值）。

**影响**：「刷新」按钮对普通字段实际无效——既不丢弃本地未保存的编辑，也不拉取服务端最新值，用户以为自己看到的是最新配置。多人同时改配置时更糟：A 打开页面、B 修改并保存、A 点刷新（无变化）后再保存，会用陈旧值覆盖 B 的修改。

**建议**：`syncPlainModel` 无条件以服务端值覆盖（secret 字段仍置空表示"不修改"）。若想保护未保存的编辑，则应显式提示"有未保存修改，刷新将丢弃"，而不是静默跳过同步。

---

## 8. 队列「立即发送」失败后阻塞全部插入按钮直到执行结束（desktop）

**位置**：`desktop/src/components/chat/QueuePanel.vue:121,128-147,193-197`

**根因**：in-flight 标记是"全局单值 + 提前 return"：

```193:197:desktop/src/components/chat/QueuePanel.vue
function handleInsert(queueId: string) {
  if (insertingQueueId.value) return
  insertingQueueId.value = queueId
  emit('insert', queueId)
}
```

复位只有两条路径：队列里该条消息消失（128-133），或会话进入终态 `CANCELLED/COMPLETED/FAILED/IDLE`（143-147）。而失败时上游只弹 toast，既不改队列也不改 phase：

```795:801:desktop/src/composables/useChat.ts
  async function insertQueueMessage(queueId: string) {
    if (!sessionId.value) return
    await connect()
    if (!await wsInsertMessage(sessionId.value, queueId)) {
      ElMessage.error('操作失败，网络连接不可用，请重试')
    }
  }
```

**触发**：Agent 执行中（phase 长期 `RUNNING`）点「立即发送」，WS 发送失败。

**影响**：注意 `if (insertingQueueId.value) return` 判的是"有没有任何一条在途"而非"是不是这一条"，所以一次失败会让**整个队列**的「立即发送」按钮全部失效（失败那行显示「处理中...」且 disabled，其余行点击无响应），直到本轮执行结束。用户看到 toast 让他重试，却怎么点都没反应。

**建议**：`insertQueueMessage` 返回成败，`handleInsert` 在失败时立即清空 `insertingQueueId`；并参考同文件 `handleReorder`（200-207）已有的 2s 超时兜底做法，给插入也加一个兜底复位。

---

## 9. `@` 文件引用搜索无竞态保护，慢响应覆盖新结果（desktop）

**位置**：`desktop/src/components/chat/ChatInput.vue:625-655,1049-1058`

**根因**：过滤词变化时按 300ms 防抖重新请求，但并发响应没有任何顺序校验，谁最后返回谁写入：

```630:639:desktop/src/components/chat/ChatInput.vue
      const result = await (window as any).electronAPI.listWorkspaceFiles(props.workspace, filter || undefined, 20)
      workspaceFiles.value = result || []
    } else {
      // CLOUD mode — call backend API
      const sessionId = sessionStore.activeSessionId
      if (sessionId) {
        const { data } = await api.get('/files/workspace-list', {
          params: { sessionId, filter: filter || undefined, limit: 20 },
        })
        workspaceFiles.value = data?.files || []
```

防抖只能合并连续输入，跨越 300ms 的两次输入仍会产生两个在途请求。同仓库的 `FileViewer.vue` 已经用 `loadFileSeq` 做了这类过期响应保护，这里缺失。

**触发**：`@` 后较快地改写过滤词（如 `@ser` → 退格 → `@doc`），或在弱网/大工作区下搜索。

**影响**：文件候选列表短暂显示上一次过滤词的结果，用户据此按回车会引用**错误的文件**；引用后路径被写进消息发给 Agent，属于会产生实际后果的误操作。`filePanelLoading` 也会被先返回的请求提前置 false。

**建议**：加请求序号（`const seq = ++fetchSeq`，回写前比对 `seq === fetchSeq`），与 `FileViewer` 的 `loadFileSeq` 保持一致做法。

---

## 10. 微信绑定在 confirm 参数缺失时跳过确认请求仍提示「绑定成功」（desktop）

**位置**：`desktop/src/views/settings/WeixinBotView.vue:224-257`

**根因**：这段轮询代码的注释明确声明了不变量——「confirmed 需等 confirm POST 成功后再置：失败重试期间不能误显示『绑定成功』」，并为 POST 失败写了完整的重试分支。但确认请求被包在一个参数完整性判断里，缺参数时整块被跳过，直接落到成功收尾：

```224:257:desktop/src/views/settings/WeixinBotView.vue
      if (data.botToken && data.baseUrl && data.ilinkUserId) {
        try {
          await api.post('/weixin/binding/confirm', null, { /* ... */ })
        } catch (confirmError) {
          /* ... 重试，并 return ... */
          return
        }
      }

      scanStatus.value = data.status
      stopStatusPolling()
      ElMessage.success('微信Bot绑定成功！')
      dialogVisible.value = false
      await fetchBindingStatus()
```

**触发**：状态接口返回 `status === 'confirmed'`，但 `botToken` / `baseUrl` / `ilinkUserId` 任一为空（后端字段变更、部分下发、字段名调整等）。

**影响**：绑定请求从未发出，但界面弹「微信Bot绑定成功！」并关闭弹窗；紧随其后的 `fetchBindingStatus()` 仍会显示未绑定。用户拿到互相矛盾的两个信号，且需要重新扫码却不知道原因。这是"声明的不变量被一个分支绕过"的典型缺口。

**建议**：把参数缺失当作异常路径处理——走与 POST 失败相同的重试分支，或 `ElMessage.error('绑定信息不完整，请重新扫码')` 后停止轮询，不要复用成功收尾。

---

## 11. 移动端布局下「系统 Skills」删除按钮未校验 `agent:write`（admin）

**位置**：`admin/src/views/skill/SkillListView.vue:105,196`

**根因**：桌面表格里系统 Skills 的删除按钮按写权限禁用：

```105:105:admin/src/views/skill/SkillListView.vue
                <el-button type="danger" link size="small" :disabled="!canWrite">删除</el-button>
```

移动端卡片却把权限判断写成"只有个人 Tab 才校验"：

```196:196:admin/src/views/skill/SkillListView.vue
                <el-button type="danger" link :disabled="activeTab === 'personal' && !canWrite">删除</el-button>
```

系统 Tab（`activeTab !== 'personal'`）时前半个条件为 false，整个表达式恒为 false，按钮始终可点。

**触发**：只有 `agent:read`、没有 `agent:write` 的用户，在窄屏/手机布局下打开 Skills 管理 → 系统 Skills。

**影响**：只读用户看到可点的删除按钮，走完二次确认后才被后端 403 拒绝。同一功能在桌面与移动端两种权限表现，属于权限 UI 收口不一致。

**建议**：移动端改为 `:disabled="!canWrite"`，与桌面端统一。

---

## 12. 调用流水页 keep-alive 返回后不刷新，长期展示陈旧数据（admin）

**位置**：`admin/src/views/llm-call/LlmCallView.vue:430-434`

**根因**：路由 meta 为 `keepAlive: true`（`router/index.ts:92`），但组件只有 `onMounted`，没有 `onActivated`：

```430:434:admin/src/views/llm-call/LlmCallView.vue
onMounted(() => {
  applyQueryFilters()
  fetchRecords()
  fetchFilterOptions()
})
```

**触发**：打开调用流水 → 切到其他菜单 → 再切回来。

**影响**：列表停留在离开前的数据与分页。调用流水是持续增长的实时流水表，陈旧视图会让人误判"最近没有调用"。同文件第 254-268 行只从 `route.query` 读入筛选，也不会因 URL 变化重新加载。对照本仓库 `FeishuBotListView.vue:382-385` 已经使用 `onActivated` 重新拉取，属于同类页面的处理不一致。

**建议**：补 `onActivated` 重新 `fetchRecords()`（可加"距上次加载超过 N 秒才刷新"避免频繁请求）。

---

# 三、低

## 13. 用户详情抽屉自造 `phaseLabel`，缺 IDLE/WAITING_APPROVAL 且与全站口径分叉（admin）

**位置**：`admin/src/views/user/UserDetailDrawer.vue:210-225` vs `admin/src/utils/labels.ts:39-41`

仓库已有统一的标签工具 `utils/labels.ts`（`phaseLabel` 覆盖 IDLE / RUNNING / WAITING_APPROVAL / COMPLETED / FAILED / CANCELLED，见 `PHASE_OPTIONS:56-63`），但抽屉里重新实现了一份残缺版本：

```220:225:admin/src/views/user/UserDetailDrawer.vue
function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    RUNNING: '运行中', COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消'
  }
  return labels[phase] || phase || '-'
}
```

**影响**：会话处于 `IDLE` 或 `WAITING_APPROVAL` 时，标签直接显示英文枚举（如 `WAITING_APPROVAL`），与会话管理页的中文「待审批」不一致。紧邻的 `phaseTagType`（210-218）也没有 `WAITING_APPROVAL` 分支，会落到 `info` 灰色，丢失"需要关注"的视觉权重。

**建议**：改为 `import { phaseLabel } from '../../utils/labels'`，删除本地实现。

---

## 14. 非桌面端点「在文件浏览器中打开」静默无反馈（desktop）

**位置**：`desktop/src/components/task/TaskIndexPanel.vue:860-865`

同一文件里紧邻的两个入口，三端守卫处理方式不同。打开文件夹是静默 return：

```860:865:desktop/src/components/task/TaskIndexPanel.vue
function openGroupFolder(group: { key: string }) {
  const workspace = group.key.startsWith('LOCAL:') ? group.key.substring(6) : ''
  if (workspace && window.electronAPI?.openFolder) {
    window.electronAPI.openFolder(workspace)
  }
}
```

打开终端则有明确提示：

```867:871:desktop/src/components/task/TaskIndexPanel.vue
function openTerminal(group: { key: string }) {
  if (typeof window === 'undefined' || !window.electronAPI?.openTerminal) {
    ElMessage.info('终端仅在桌面客户端可用')
    return
  }
```

**触发**：Web 或安卓端展开 LOCAL 分组，点文件夹图标。

**影响**：点击完全无响应，看起来像坏掉。按钮本身也没有隐藏或置灰。

**建议**：与终端入口对齐，补 `ElMessage.info('在文件浏览器中打开仅在桌面客户端可用')`，或在非 Electron 端直接不渲染该图标。

---

## 15. 用量分析 CSV 导出未挂 DOM 且同步 revoke（admin）

**位置**：`admin/src/views/analytics/utils/csv.ts:14-18`

```14:18:admin/src/views/analytics/utils/csv.ts
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
```

同仓库 `LlmCallView.vue:390-396` 的导出用的是更稳妥的写法（`appendChild` → `click` → `removeChild` → `revoke`）。游离节点 `click()` 在主流 Chromium 下可用，但 `URL.revokeObjectURL` 紧跟 `click()` 同步执行，在部分浏览器/WebView 里会在下载真正开始前失效。

**影响**：模型/用户/Agent Tab 的「导出 CSV」在部分环境下偶发无文件产出，且无任何报错。

**建议**：与 `LlmCallView` 统一——挂载到 `document.body` 后点击再移除，`revokeObjectURL` 放进 `setTimeout(..., 0)`。

---

## 16. 提问面板堆叠时 badge 显示总数，但只有最后一组可作答（desktop）

**位置**：`desktop/src/components/chat/QuestionPanel.vue:6,128-136`

模板头部为多条待答复准备了数量 badge（`v-if="items.length > 1"`，第 6 行），但内容区只取最后一项：

```128:136:desktop/src/components/chat/QuestionPanel.vue
const currentRequestId = computed(() => {
  const last = props.items[props.items.length - 1]
  return last?.requestId
})

const currentQuestions = computed<Question[]>(() => {
  const last = props.items[props.items.length - 1]
  return last?.questions ?? []
})
```

store 侧确实是按 `requestId` 去重后**追加**的多元素列表（`stores/session.ts:1629-1637`），并有独立的 `removeAskQuestion`，说明"同时存在多组提问"是被数据层支持的状态。

**影响**：一旦堆积两组提问，badge 显示「2」，但较早的那组既看不到也无法作答，其 `requestId` 在 UI 上不可达，对应的 Agent 分支会一直等待。

**建议**：要么渲染成可切换的多组（与 badge 语义一致），要么取 `items[0]`（先到先答）并在答完后自动展示下一组。

---

## 17. 用户详情抽屉 Git「Token」列恒为 `****`（admin）

**位置**：`admin/src/views/user/UserDetailDrawer.vue:120`

```120:120:admin/src/views/user/UserDetailDrawer.vue
            <el-table-column prop="accessToken" label="Token" width="140" />
```

后端对该字段做了硬编码脱敏，管理端接口也走同一个 `toVO`：

```59:64:backend-ts/src/user/git-credential.routes.ts
function toVO(credential: GitCredential) {
  return {
    id: credential.id,
    domain: credential.domain,
    accessToken: '****',
```

**说明**：这里**不存在**凭证泄露风险（初审曾疑似，已核验排除）。问题纯粹是 UI：一列 140px 的固定宽度用来显示恒定的 `****`，在本就横向紧张的抽屉表格里挤占了「备注」等有效信息的空间。

**建议**：删除该列，或改为「已配置 / 未配置」状态标签并压缩到 80px。

---

# 四、已排除的误报（核验不成立，勿重复排查）

初审提出但经回源码核验**不成立**的条目，记录在此避免后续重复投入：

| 候选问题 | 排除依据 |
|---|---|
| 管理端用户详情泄露 Git `accessToken` 明文 | `backend-ts/src/user/git-credential.routes.ts:59-64` 的 `toVO` 硬编码 `accessToken: '****'`，管理端与用户端共用，不存在明文下发。仅剩 UI 占位问题（见问题 17） |
| `ApprovalStack` 的 `expandedSet` 原地 `add`/`delete` 不触发视图更新 | Vue 3 的 reactive 代理已插桩 `Set` 的 `add`/`delete`/`has`/`size`，`ref(new Set())` 的原地变更能正常触发重渲染 |
| `ChatInput` 输入邮箱（`user@example.com`）会误弹文件引用面板 | `ChatInput.vue:1033-1036` 要求 `@` 位于开头或前接空白字符，邮箱中 `@` 前是字母，直接 `closeFilePanel()` 返回，不会误触发 |
| `FileChangePanel` 在边路/子代理会话里绑定主会话，导致 diff 打开错文件 | 子会话继承父会话工作区（`harness/delegate/subagent-invocation.service.ts:37` `workspace: parent.workspace`），路径解析结果一致；中心区 Tab 本身也按父会话维度管理，无用户可见错位 |
| admin 缺少 404 兜底路由导致未知路径白屏 | `admin/src/router/index.ts:134` 已有 `/:pathMatch(.*)*` catch-all（历史文档 A14 已修复） |
| `FileViewer` 文本读取缺少过期响应保护 | 已有 `loadFileSeq` 序号校验（历史文档 D8 已修复） |

---

# 五、修复优先级建议

1. **先修问题 3、2**：两者都会让用户陷入"无法继续"的死局（审批无入口、源码恒空白），且改动局部、风险低。
2. **再修问题 1、4**：影响日常导航与 Tab 管理，用户感知强；问题 1 的 `addTab` 改键需回归验证标签的打开/关闭/激活链路。
3. **问题 5-12 批量处理**：多为"加载态 / 刷新时机 / 竞态 / 权限守卫"的同类疏漏，建议合并成一个收敛任务，顺手统一 `onActivated` 刷新与请求序号两种模式。
4. **问题 13-17 作为清理项**：与既有工具函数/实现对齐即可（`labels.ts`、`LlmCallView` 的导出写法、终端入口的三端提示）。

改动涉及用户可见行为，按 `CLAUDE.md` 约定需同步写入根 `CHANGELOG.md` 顶部版本小节（前端共用 UI 记入「前端（桌面 / Web / 安卓）」，管理后台记入「管理后台」）。
