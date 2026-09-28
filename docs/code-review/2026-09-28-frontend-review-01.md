# 前端代码评审报告：desktop + admin（第 4 轮）

- 日期：2026-09-28
- 审查范围：
  - `desktop/src/`：聊天链路（ChatPanel / ChatRoundList / MessageBubble / ChatInput / QuestionPanel / ApprovalStack / QueuePanel / SideChatPanel / SubagentChatPanel 等）、任务侧栏与边路任务（TaskIndexPanel / TaskInspector / SideTaskList / SubagentList / ScheduledTaskPanel）、中心 Tab 与文件查看（CenterTabBar / FileViewer / FileDiffViewer / PdfViewer）、文件浏览 / 终端 / 搜索 / 技能 / 指令 / 布局导航、设置页与登录页、`composables/` 与 `utils/`
  - `admin/src/`：`views/` 全部页面（agent / analytics / audit / auth / dingtalk-bot / feedback / feishu-bot / llm-call / mcp / model / permission / scheduled-tasks / session / settings / skill / system-commands / user）、`components/`、`router/`、`stores/`、`composables/`、`utils/`
- 审查维度：功能模块缺陷、UI 样式、交互逻辑
- 方法：五路并行静态源码审查（逐文件通读）+ 与 `backend-ts/src/` 路由/服务交叉验证；成文前对全部关键条目的行号与代码证据逐条抽查复核。未运行 vue-tsc / 构建 / 单测，无运行时与视觉验证。
- **二次复核（本轮成文后）**：对全部 27 条正文 + 12 条待观察逐条对照当前源码重新核实存在性与修复价值，**移除不存在或修复价值过低的条目**，修正若干描述偏差，将 2 条待观察中已可确认且值得修的升级为正文。复核后保留 **22 个问题**：功能模块缺陷 14、UI 样式 4、交互逻辑 4。（另按产品范围说明剔除 1 条：安卓/iOS 不提供技能上传，原「webkitdirectory」条不适用。）
- 与前几轮的关系：`2026-09-21-frontend-review-01.md`（12 条）、`2026-09-22-frontend-review-01.md`（12 条）、`2026-09-27-frontend-review-03.md`（12 条）中确认已修复的条目不重复；与前轮「主动放弃」条目的重新评估见文末「已排除」一节。
- 与同日 `2026-09-28-frontend-review-02.md` 去重：系统设置未保存覆盖、点踩反馈每页条数以本文 #10、#8 为准（02 的独有补充已并入）；MCP「每次加载把页码打回第 1 页」以 02 为准，本文 #21 只保留「无二次确认、无 try/catch」。
- 以下行号对应当前工作区文件（含未提交改动）。

---

## 严重度汇总

| # | 端 | 问题 | 类别 | 严重程度 | 位置 |
|---|:---:|------|------|:---:|------|
| 1 | desktop | 删除会话行内确认无 in-flight 防护，连点发二次删除并弹「假失败」 | 功能 | 高 | `components/task/TaskIndexPanel.vue:1237-1243`、`stores/session.ts:1023-1054` |
| 2 | desktop | session store 列表拉取无并发/时序保护，恢复归档竞态可让会话从侧栏消失 | 功能 | 中 | `stores/session.ts:358-398,553-580,583-612` |
| 3 | desktop | 图片附件「最多 10 张」上限被异步入队绕过，超限发送变幽灵气泡 + OSS 孤儿 | 功能 | 中 | `components/chat/ChatInput.vue:1074-1107` |
| 4 | desktop | 重试被服务端 error 事件拒绝后 `sending` 永久卡死，会话变「幽灵运行中」 | 功能 | 中 | `composables/useChat.ts:595-610`、`composables/useStreamWS.ts:1020-1038` |
| 5 | desktop | 问卷提交失败后按钮永久「已提交」，Agent 分支永远等不到答案 | 功能 | 中 | `components/chat/QuestionPanel.vue:231-247`、`composables/useChat.ts:947-951` |
| 6 | desktop | 运行中耗时 / 相对时间是渲染时快照，无定时刷新，长任务显示陈旧 | 功能 | 中 | `components/task/TaskIndexPanel.vue:1194-1213`、`components/task/SideTaskList.vue:142-161` |
| 7 | desktop | 飞书/钉钉授权裸 `window.open` 无返回值检查，弹窗被拦截时永久「等待中」 | 功能 | 中 | `views/auth/LoginView.vue:255-261`、`views/settings/FeishuBotView.vue:117-124` |
| 8 | admin | 反馈页「每页条数」下拉选了不生效，显示/数据/页码三方不一致 | 功能 | 中 | `views/feedback/FeedbackView.vue:82-87,149` |
| 9 | admin | 用户页 `roleId` 只在 `onMounted` 解析，keep-alive 复用旧实例致角色提示过期/缺失 | 功能 | 中 | `views/user/UserListView.vue:481-498` |
| 10 | admin | 系统设置切走再切回，未保存的表单编辑被静默丢弃 | 功能 | 中 | `views/settings/SystemSettingsView.vue:447-449,246-255` |
| 11 | admin | MCP / Skills / Agent / Model 四个列表页 keep-alive 切回不刷新 | 功能 | 中 | `views/mcp/McpServerListView.vue:573`、`views/skill/SkillListView.vue:740` 等 |
| 12 | desktop | `isTouchDevice` 用触摸能力判定，触摸屏笔记本 Enter 不再发送消息 | 功能 | 中 | `components/chat/ChatInput.vue:387,841` |
| 13 | desktop | AgentSelector 拉取失败与「暂无可用智能体」同形，且可能带空 agentId 建会话 | 功能 | 中 | `stores/agent.ts:28-32`、`components/task/AgentSelector.vue:33` |
| 14 | desktop | 模型切换乐观更新无回滚，失败后 UI 与服务端模型不一致 | 功能 | 中 | `components/chat/ChatPanel.vue:736-742`、`stores/session.ts:988-997` |
| 15 | desktop | Git 徽章与「待审批」相位徽章硬编码十六进制色，暗色模式对比度 2.9–3.9:1 | UI 样式 | 中 | `components/task/GitChangeTreeNode.vue:169-173`、`components/task/TaskInspector.vue:1113-1116` |
| 16 | desktop | 聊天链路多处硬编码 `rgba(0,102,204,·)` 绕过主题变量 | UI 样式 | 低 | `components/chat/ChatInput.vue:1446` 等 |
| 17 | desktop | 会话搜索进行中完全没有加载态 | UI 样式 | 低 | `components/search/SessionSearchPopover.vue:42,150,162` |
| 18 | desktop | 一批图标按钮无可访问名称；安卓顶栏触摸目标 28–32px 低于 44px 约定 | UI 样式 | 低 | `components/common/TopNav.vue:6-41,466-476` |
| 19 | desktop | CenterTabBar 右键菜单未做视口钳制，横向越界且无滚动关闭 | 交互 | 中 | `components/center/CenterTabBar.vue:73-79` |
| 20 | desktop | 会话搜索 ↑/↓ 高亮不滚动到可见区域 | 交互 | 中 | `components/search/SessionSearchPopover.vue:176-199` |
| 21 | admin | MCP 停用/启用无二次确认、无 try/catch | 交互 | 低 | `views/mcp/McpServerListView.vue:528-533` |
| 22 | admin | 定时任务页四个筛选下拉无 `@change`，且 keep-alive 切回不刷新 | 交互 | 低 | `views/scheduled-tasks/index.vue:29-50,389-392` |

---

## 一、功能模块缺陷

### 1. 删除会话的行内确认无 in-flight 防护，连点确认钮会发二次删除并弹出「假失败」（desktop，高）

- **位置**：`desktop/src/components/task/TaskIndexPanel.vue:1237-1255`（`confirmDelete`）；`desktop/src/stores/session.ts:1023-1054`（`deleteSession`）
- **行为**：`confirmDelete` 在 `await sessionStore.deleteSession(...)` 期间没有把 `confirmingDeleteId` 置空，确认按钮（✓）在整个请求期间保持可见可点。`sessionStore.deleteSession` 没有任何 in-flight 去重（同文件的 `archiveSession/unarchiveSession` 用了 `archivingIds`，`useScheduledTasks.toggleStatus` 用了 `togglingIds`，唯独删除没有）。快速连点 ✓ 两下：第一次成功后会话已删，第二次打到已删除的 id，`deleteSession` 返回 `false` → 弹出「删除失败，请稍后重试」，同时 API 拦截器再弹一条错误 toast——**删除其实成功了，用户却看到两条失败提示**。另一个次生症状：`confirmingDeleteId.value = null` 在 await 之后无条件执行，若用户在 A 的删除请求在途时对 B 点了删除，A 的 await 结束会把 B 的确认态一起清掉，B 的 ✓/✗ 按钮莫名消失。
- **证据**：
  ```ts
  // TaskIndexPanel.vue:1237-1243
  async function confirmDelete(e: MouseEvent, sessionId: string) {
    e.stopPropagation()
    const wasActive = sessionStore.activeSessionId === sessionId
    const deleted = await sessionStore.deleteSession(sessionId)
    confirmingDeleteId.value = null          // await 之后才清，请求期间按钮仍可点
    if (!deleted) {
      ElMessage.error('删除失败，请稍后重试')  // 二次点击打到已删 id → 假失败
  ```
- **用户影响**：误报失败引发重复操作与困惑；连点两次还可能让 `wasActive` 分支的跳转逻辑基于过期状态执行。
- **修复建议**：store 增加 `deletingIds: Set<string>`，入口处 `if (deletingIds.has(sid)) return false`（同时把 ✓ 按钮 `:disabled`）；组件侧把 `confirmingDeleteId.value = null` 移到 `await` 之前，并加 `if (confirmingDeleteId.value !== sessionId) return` 守卫，避免清掉别的会话的确认态。

### 2. session store 列表拉取无并发/时序保护，刷新与「恢复归档」竞态可让会话从侧栏整体消失（desktop，中）

- **位置**：`desktop/src/stores/session.ts:358-398`（`fetchSessions`）、`:553-580`（`unarchiveSession`）、`:583-612`（`fetchArchivedSessions`）；`desktop/src/components/task/TaskIndexPanel.vue:362`（「刷新已归档」按钮）
- **行为**：用户点顶栏刷新（`fetchSessions()` 在途，`loading=true`）→ 立即在「已归档」区对某会话点「恢复」→ `unarchiveSession` PUT 成功后内部又静默 `await fetchSessions(true)`（`silent=true` 不置 `loading`，刷新按钮的 `:disabled="loading || focusLoading"` 拦不住这第二个请求）。两个 `GET /sessions/groups` 并发，响应均整体覆盖 `standardSessionIds`（`standardSessionIds.value = ids`），**没有任何 requestSeq / 代次校验**。若刷新那次后到达，侧栏会用「恢复前」的快照重建标准列表——刚恢复的会话不在其中；而本地又已把它从 `archivedSessionIds` 移除。净效果：**该会话在两个列表里同时消失，直到下一次手动刷新才复活**。同模式影响已归档区：「刷新已归档」按钮没有 `:disabled="archivedLoading"`，连点即并发，后到的旧响应可覆盖新响应。
- **证据**：
  ```ts
  // stores/session.ts:383（无 seq 检查，直接整体覆盖）
  standardSessionIds.value = ids
  // stores/session.ts:569（静默刷新，loading 不变，按钮禁用态拦不住）
  await fetchSessions(true)
  ```
  对照：`useGitStatus.ts`、`useGitRepos.ts`、`useFileBrowser.ts`、`FileViewer.vue`、`PdfViewer.vue` 全都实现了 `requestSeq` 丢弃过期响应——session store 是唯一漏掉这套模式的取数路径。
- **用户影响**：会话「凭空消失」，用户误以为数据丢失；已归档区连点刷新也可能看到旧快照。
- **修复建议**：给 `fetchSessions` / `fetchArchivedSessions` / `fetchFocusSessions` 加模块级 `fetchSeq`，`await` 后 `if (seq !== fetchSeq) return`；给「刷新已归档」按钮补 `:disabled="archivedLoading"`。

### 3. 图片附件「最多 10 个」上限被异步入队绕过，超限消息发送后变成幽灵气泡 + OSS 孤儿（desktop，中）

- **位置**：`desktop/src/components/chat/ChatInput.vue:1095-1107`（`addPendingImage`）、`:1074-1087`（文件选择）、`:1164-1176`（拖拽）、`:698-719`（粘贴）；`backend-ts/src/session/ws/streaming-ws-handler.ts:400-403`（后端校验）
- **行为**：`addPendingImage` 的长度校验是同步的，但真正的 `push` 发生在 `checkFileSize()` 的 `.then()` 里，而 `checkFileSize` 内部 `await getUploadConfig()`（异步）。三个入口（文件选择、拖拽、粘贴）都是在同步 `for` 循环里调用 `addPendingImage`，循环期间 `pendingFiles.value.length` 始终是旧值，于是 `>= 10` 判断对同一批文件全部放行，粘贴循环里自己的 `>= 10` 兜底判断同样失效。用户在文件选择器一次选 12 张图 → 12 张全部入队、预览正常、`canSend` 为 true → 发送时 12 张图先上传到 OSS → 后端校验 `images.length > 10` 后回 `error` 事件并 return（该校验位于 `saveMessage` 之前，用户消息不落库）。
- **证据**：
  ```ts
  // ChatInput.vue:1095-1107
  function addPendingImage(file: File) {
    if (pendingFiles.value.length >= 10) {          // 同步检查，循环内长度不更新
      ElMessage.warning('最多上传 10 个附件')
      return
    }
    checkFileSize(file).then(({ ok, limitMb }) => { // await 之后才 push
      ...
      pendingFiles.value.push({ file, previewUrl: URL.createObjectURL(file) })
    })
  }
  ```
- **用户影响**：前端已插入 `msg_xxx_user` 乐观气泡且带 12 张图，随后 phase 被置 FAILED、错误横幅显示「单条消息最多支持 10 张图片」，但用户气泡作为幽灵残留在对话里（`user_message_saved` 从未到达，无法替换成真实 ID），12 张图成为 OSS 孤儿。用户视角是「UI 明明有 10 个附件的限制提示，却仍然发得出去并被拒」。
- **修复建议**：把「计数预算」与「入队」放进同一同步临界区：`addPendingImage` 先同步 push 占位，大小校验异步失败时再把占位移除并 revoke 预览 URL；三个入口改为串行 `for await` 并在每轮重新读长度，或在入口处一次性切片 `files.slice(0, 10 - pendingFiles.value.length)`。
- **同根因附注**：`addPendingFile`（非图片附件，`:1110-1128`）是同样的「同步长度检查 + 异步入队」结构，普通文件附件也可绕过 10 个上限，修复时应一并覆盖。
- **与前轮区别**：`2026-09-01-frontend-review-02.md` D28 记录的是「图片/文件合计计数导致提示文案误导」，本轮是「同步校验被异步入队绕过导致上限完全失效」，是不同的缺陷。

### 4. 重试被服务端以 error 事件拒绝后 `sending` 永久卡死，会话变成「幽灵运行中」（desktop，中）

- **位置**：`desktop/src/composables/useChat.ts:595-610`（`retryExecution`）、`:722-731`（phase watcher）；`desktop/src/composables/useStreamWS.ts:1020-1038`（`error` 分支）；`desktop/src/components/chat/ChatPanel.vue:437-441`（`agentRunning`）、`:449-458`（打字指示器）；`desktop/src/components/chat/SubagentChatPanel.vue:174-185,310-321`
- **行为**：`retryExecution` 把 `sending` 置 true 后只依赖 `wsRetryExecution` 的返回值判断失败，而 WS 帧「发出去即算成功」。后端 `handleRetryExecution`（`streaming-ws-handler.ts:948`）在多个入口以 `error` 事件拒绝：非终态（956 行「任务尚未结束，无法重试」）、子代理重试不可用、LOCAL 桌面端未连接（998 行）等。前端 `error` 分支无条件 `updateSessionPhase(sid, 'FAILED')`——而触发重试时 phase 本来就是 FAILED，`sessionPhases` Map 写入同值，watcher 的 `if (phase === oldPhase) return` 直接跳过，`sending` 无人复位；`retryExecution` 也没有注册 pendingCallbacks，`error` 分支的 `cb.reject` 找不到回调，同样是空操作。
- **证据**：
  ```ts
  // useChat.ts:595-606
  async function retryExecution() {
    const sid = sessionId.value
    if (!sid) return
    sending.value = true                              // 599
    sessionStore.clearExecutionError(sid)
    const ok = await wsRetryExecution(sid)            // 603 帧发出即 true，服务端拒绝无从得知
  // useStreamWS.ts:1024（phase 已是 FAILED，无变化）
  sessionStore.updateSessionPhase(sessionId, 'FAILED' as TaskPhase)
  // useChat.ts:728-729
  // Skip if phase didn't actually change
  if (phase === oldPhase) return
  ```
- **用户影响**（主聊天）：`agentRunning = sending.value || ACTIVE(phase)` 恒为 true → 打字指示器永久转圈；`prepareAndSendMessage` 首行卫语句 `|| sending.value) return null` 把该会话之后所有发送**静默丢弃**（无任何错误提示）；错误横幅可再次点重试，但只要仍走 error 路径就继续卡。子代理面板同源问题更硬：`retrying` 只在 watcher 见到 `RUNNING`/`WAITING_APPROVAL` 时复位，error 路径下重试按钮永久禁用。
- **修复建议**：`retryExecution` 为本次 sid 注册 pendingCallbacks（与 `sendMessage` 同构），让 `error` 事件的 reject 落到本地 catch 里复位 `sending` 并提示；或在 `error` 分支判断「目标 phase 未变化且存在进行中的本地发送」时主动复位。子代理侧把 `retrying` 的复位条件扩展到「phase 进入终态或收到 error」。同时注意 `error` 分支无条件置 `FAILED` 的语义过宽（「任务尚未结束，无法重试」这类并非执行失败的错误也会把会话打成 FAILED），宜与本条一并设计，不单开条目。
- **与前轮区别**：`2026-09-17-logic-bug-review-01.md` 记录的是边路/子代理面板「WS 不可用时 `cancel`/`retryExecution` 返回值未检查」（已修），并明确「主聊天路径本身正确」；本轮是主聊天在**服务端 error 事件拒绝**路径上的卡死，是该前轮未覆盖的新路径。

### 5. 问卷（ask_user_questions）提交失败后按钮永久「已提交」，Agent 分支永远等不到答案（desktop，中）

- **位置**：`desktop/src/components/chat/QuestionPanel.vue:231-247`（`handleSubmit`）、`:228-229`（`submittedRequestIds`/`alreadySubmitted`）；`desktop/src/composables/useChat.ts:947-951`（`submitQuestionAnswer`）；`desktop/src/components/chat/SubagentChatPanel.vue:188-191`
- **行为**：`handleSubmit` 在 `emit` 之前就同步把 `currentRequestId` 写进 `submittedRequestIds`，之后完全不再关心发送结果；`submitQuestionAnswer` 拿到 `sendAskUserQuestionsResult` 的返回值后直接丢弃（无 try/catch、无判定）。WS 断线或重连超时时 `sendReliable` 返回 false，服务端从未收到答案。
- **证据**：
  ```ts
  // QuestionPanel.vue:231-235
  function handleSubmit() {
    if (!canSubmit.value || !currentRequestId.value) return
    if (submittedRequestIds.value.has(currentRequestId.value)) return
    submittedRequestIds.value = new Set([...submittedRequestIds.value, currentRequestId.value]) // 先标记后发送
    ...
    emit('submit', currentRequestId.value, answers)   // 247 结果无人校验
  }
  // useChat.ts:947-951
  async function submitQuestionAnswer(requestId: string, answers: QuestionAnswer[]) {
    if (!sessionId.value) return
    await sendAskUserQuestionsResult(sessionId.value, requestId, answers) // 返回值丢弃
  }
  ```
- **用户影响**：`alreadySubmitted` 为 true → 提交按钮永久显示「已提交」并被禁用，用户无法重试；面板只在服务端 `ask_user_questions_cancelled`（`useStreamWS.ts:1012-1016`）时才移除，而服务端不知道答案所以永远不会发这个事件 → 面板常驻、会话停在等待态，用户除了切走会话/刷新外无路可走。
- **修复建议**：`submitQuestionAnswer` 返回 `boolean` 并对 false 分支 `ElMessage.error('答案发送失败，请重试')`；`handleSubmit` 改为 `async`，发送成功后再写入 `submittedRequestIds`，失败回滚该标记让按钮恢复可点；父组件（ChatPanel/SideChatPanel/SubagentChatPanel 的 `@submit`）把结果回传给面板。

### 6. 运行中耗时 / 相对时间是渲染时快照，无定时刷新，长时间运行后显示陈旧（desktop，中）

- **位置（同一问题多处）**：`desktop/src/components/task/TaskIndexPanel.vue:246`（模板调用点）、`:816-845`（`focusStatusLabel`，RUNNING 分支在 `:834`）、`:1194-1213`（`formatTimeDiff`，`const now = Date.now()`）；`desktop/src/components/task/SideTaskList.vue:129-161`（`formatElapsed`）；`desktop/src/components/task/SubagentList.vue:46-60`
- **行为**：`focusStatusLabel` / `formatElapsed` 在渲染时取 `Date.now()` 计算相对时间，结果是普通模板函数的渲染快照（非响应式时钟）。列表项重新渲染只依赖 `session.phase / startedAt / pendingApprovals / pendingQuestions / sideTasks` 等 store 投影。而后端只在相位跃迁时广播 `session_status` / `session_list_update`（`streaming-ws-handler.ts:516,775,1057`），harness 执行期间无周期性状态推送，流式事件只改每会话消息状态、不触碰列表项依赖。
- **证据**：
  ```ts
  // TaskIndexPanel.vue:834
  if (session.phase === 'RUNNING') return `运行中 ${formatDurationSince(session.startedAt || ...)}`
  // :1194-1196
  function formatTimeDiff(time?: string) {
    const now = Date.now()   // 非响应式，无任何 ticker 驱动重算
  ```
- **用户影响**：聚焦模式打开一个长时间运行的任务 → 该会话持续执行但相位不变 → 「运行中 1分」在任务实际跑了 25 分钟后仍显示「1分」（标准模式「X小时前创建」同理；已完结项此后无任何事件，文案冻结）。用户无法从侧栏判断任务是否卡死，必须点进去看详情。三处实现重复（`SideTaskList.formatElapsed` 与 `TaskIndexPanel.formatTimeDiff` 逻辑几乎一致），也容易继续发散。
- **修复建议**：抽一个共享的 `useRelativeTime(timestamp)` composable，内部用 30–60s `setInterval`（组件卸载清理）或单一全局 ticker 驱动；同时消除三份重复实现。也可让后端对 RUNNING 会话按低频（如 60s）补发 `session_list_update`，两端任一即可见效。

### 7. 飞书/钉钉授权用裸 `window.open`，授权页打不开时界面永久「等待中」（desktop，中）

- **位置**：`desktop/src/views/auth/LoginView.vue:255-261`、`desktop/src/views/settings/FeishuBotView.vue:117-124`、`desktop/src/views/settings/DingtalkBotView.vue:82`、`:91-93`；对照 `desktop/src/utils/capacitor.ts:18-40`（项目自有的三端外链打开工具 `openExternalUrl()`）
- **行为**：三处授权流程都用 `window.open(url, '_blank', 'noopener,noreferrer')` 且不检查返回值。返回 `null`（弹窗被拦截 / Safari 在 `await` 之后丧失用户激活 / 安卓 Capacitor WebView 未开多窗口而不弹窗）时，代码照常进入轮询，UI 永远显示「请在打开的飞书页面中完成登录」「仍在等待钉钉授权完成…」，唯一的出路是用户自己找到「返回密码登录 / 取消」。`LoginView` 的 `window.open` 还在 `await authStore.startFeishuLogin()` 之后（异步缝隙），正是 Safari 最易拦截的写法。
- **证据**：
  ```ts
  // LoginView.vue:255-261
  } else {
    // Web / 安卓: 新窗口打开飞书授权页，轮询状态
    feishuStatusText.value = '请在打开的飞书授权页面中完成登录'
    window.open(authUrl, '_blank', 'noopener,noreferrer')
    startPolling(qr.pollInterval || 2)
  }
  // DingtalkBotView.vue:91-93
  function openAuthPage() {
    if (authUrl.value) window.open(authUrl.value, '_blank', 'noopener,noreferrer')
  }
  ```
- **用户影响**：弹窗被拦截时用户对着一个永远转圈的授权面板，没有任何错误提示；轮询持续到上限才停。
- **修复建议**：`const w = window.open(...)`，`if (!w) { 停止轮询 + ElMessage.error('授权页面被浏览器拦截，请允许弹窗后重试') }`；并把这三处改走 `openExternalUrl()`（Electron 分支已有 IPC 窗口不受影响），保证安卓壳内用 Capacitor 能力打开。
- **与前轮区别**：`2026-08-30-frontend-review-01.md` D14 讲的是「非 Electron 环境点外链无反应、安卓未走系统浏览器」（偏打开方式）；本轮是「打开被拦截后无检测、无反馈、无限等待」（偏失败路径），修复方向一致（都收敛到 `openExternalUrl`）。

### 8. 点踩反馈页「每页条数」下拉选了不生效，且显示与数据不一致（admin，中）

- **位置**：`admin/src/views/feedback/FeedbackView.vue:82-87`（模板）、`:149`、`:153-162`（`buildParams`）；对照 `admin/src/components/ResponsivePagination.vue:45-48`
- **行为**：`FeedbackView` 给 `ResponsivePagination` 只传了 `:page-size="pageSize"`，没有 `v-model:page-size`，也没有监听 `@size-change`；而 `pageSize` 是本地 `ref(20)`，只在 `buildParams()` 里被读取，全文无任何写入点。Element Plus 的 `pageSizeBridge` setter 在父组件持续传 `pageSize`（非 absent）时不会更新内部 `innerPageSize`，但下拉的 `handleChange` 会先改子组件自己的局部 ref——于是下拉显示 50/100，实际请求仍是 20，分页器页数也仍按 20 计算，出现「写着 50 条/页、实际 20 条、总页数还是按 20 算」的三方不一致。
- **证据**：
  ```vue
  <!-- FeedbackView.vue:82-87 -->
  <ResponsivePagination
    v-model:currentPage="page"
    :page-size="pageSize"        <!-- 单向传递，子组件改了父组件不知道 -->
    :total="total"
    @current-change="fetchList"
  />
  ```
- **用户影响**：运维想扩大每页条数批量查看点踩记录时操作无效，且界面自相矛盾。
- **修复建议**：补 `v-model:page-size="pageSize"` 与 `@size-change`（`@size-change` 里先 `page.value = 1` 再 `fetchList`，避免切到更小每页数时停留在越界页）。更稳妥的做法是给 `ResponsivePagination` 加约束性注释/类型约定：`page-sizes` 非空时父组件必须同时提供 `v-model:page-size`。若产品上不需要改每页条数，也可显式传 `layout="total, prev, pager, next"` 去掉 sizes 控件。
- **去重**：与 `2026-09-28-frontend-review-02.md` 原 #4 为同一缺陷，保留本文。

### 9. 从「角色权限 → 成员」跳到用户页，keep-alive 复用旧实例导致角色提示过期或不出现（admin，中）

- **位置**：`admin/src/views/user/UserListView.vue:481-498`（唯一入口 `onMounted`）、`:73-81`（提示 alert）、`:310-312`；配合 `admin/src/components/Layout.vue:61`、`admin/src/router/index.ts:39-42`、`admin/src/views/permission/RolePermissionView.vue:313-315`
- **行为**：`roleId` 的解析只写在 `onMounted` 里。Users 路由是 `keepAlive: true`，而 Layout 的 keep-alive key 用的是 `viewRoute.path`（不带 query），所以 `/users?roleId=5` 与 `/users` 命中同一个缓存实例。一旦用户之前访问过 `/users`，从角色页点「成员」跳过来时 `onMounted` 不会重跑：要么黄色提示条根本不出现，要么显示的是上一次那个角色的名字（`roleFilterName` 陈旧）。全文件只有这一个 `onMounted`，没有 `onActivated`、没有 `watch(() => route.query.roleId)`。
- **证据**：
  ```ts
  // UserListView.vue:481-489
  onMounted(async () => {
    // 支持 /users?roleId=x：后端暂不支持按角色过滤，仅解析意图给出提示
    const roleIdRaw = route.query.roleId
    if (roleIdRaw) {
      ...
      roleFilterName.value = rolesCache.value.find((r) => r.id === parsed)?.name || `#${parsed}`
  ```
  ```ts
  // RolePermissionView.vue:315
  router.push({ path: '/users', query: { roleId: String(role.id) } })
  ```
- **用户影响**：角色 A 的成员 → 返回角色页 → 角色 B 的成员：提示条仍写「按角色『A』筛选」，与地址栏 `?roleId=B` 矛盾。首次直接进 `/users` 再跳过来时，提示完全不显示，用户以为链接失效。
- **修复建议**：把 `roleId` 解析抽成 `applyRoleQuery()`，在 `onMounted` 与 `onActivated`（或 `watch(() => route.query.roleId)`）各调一次；`handleReset` 已正确清理 `roleFilterName` 并 `router.replace`，只需补激活时的同步。

### 10. 系统设置页切走再切回，未保存的表单编辑被静默丢弃（admin，中）

- **位置**：`admin/src/views/settings/SystemSettingsView.vue:447-449`（`onActivated`）、`:421-436`（`fetchSettings`）、`:246-255`（`syncPlainModel`）；同根因还影响 `settings/components/IntegrationConfigPanel.vue:147`、`CompanySsoConfigPanel.vue:61-71`、`EcpConfigPanel.vue:66-75`
- **行为**：`onActivated` 无条件 `void fetchSettings()`，拉回来后 `syncPlainModel()` 把所有非 SPECIAL_KEYS 的行整体覆写回 `plainModel`，并把 `pendingClearKeys` 一起清空。页面本身没有任何 dirty 标记或离开确认。无条件覆盖是早期为修「刷新对已渲染字段完全无效」而有意为之（`:243-245` 注释），不能简单改回「切回不刷新」。切回时整页还会闪一次 `v-loading`（`:16`）。
- **证据**：
  ```ts
  // SystemSettingsView.vue:447-449
  onActivated(() => {
    void fetchSettings()
  })
  // :246-254
  function syncPlainModel() {
    for (const row of settings.value) {
      if (SPECIAL_KEYS.has(row.settingKey)) continue
      plainModel[row.settingKey] = row.isSecret === 1 ? '' : (row.value ?? '')  // 无条件覆写
    }
    if (pendingClearKeys.value.size > 0) {
      pendingClearKeys.value = new Set()      // 连「待清空」标记一起丢
    }
  }
  ```
- **触发路径**：管理员改了 3 个字段还没保存 → 切到「模型管理」看点什么 → 切回「系统设置」→ 三次输入全部被服务端旧值覆盖。
- **用户影响**：静默丢数据且无任何提示；若之前点过某个 secret 的「清空」，连「待清空」意图也一起消失，下次保存会把旧 secret 原样留着。三个子面板靠 `watch(rowMap, …, { immediate: true })` 从父级 rows 同步，会被同一条链路一起覆写（`CompanySsoConfigPanel` 还带 `deep: true`）。
- **修复建议**：`onActivated` 里先做脏检查（比对 `plainModel` 与 `settings` 快照或维护 `dirty` ref）；有改动时弹 `ElMessageBox.confirm` 让用户选「丢弃并刷新」或「保留本地编辑」；至少刷新前 `ElMessage.warning` 提示。同时给首挂加 `firstActivation` 守卫避免与首屏请求重复。不要退回「切回一律不刷新」，否则会重新引入「刷新对已渲染字段无效」。
- **去重**：与 `2026-09-28-frontend-review-02.md` 原 #3 为同一缺陷，保留本文（含三个子面板与「有意覆盖」的历史原因）。

### 11. MCP / Skills / Agent / Model 四个列表页 keep-alive 切回不刷新（admin，中）

- **位置**：`admin/src/views/mcp/McpServerListView.vue:573`（`loadData()` 在 `<script setup>` 顶层直接执行，**无任何生命周期钩子**）、`admin/src/views/skill/SkillListView.vue:740`（仅 `onMounted`）、`admin/src/views/agent/AgentListView.vue:313`（仅 `onMounted`）、`admin/src/views/model/ModelListView.vue:509`（仅 `onMounted`）；对应路由均为 `keepAlive: true`
- **行为**：四个页面都没有 `onActivated` 激活刷新。而同目录的 `AuditLogView.vue:294-299`、`LlmCallView.vue:441-448`、`FeishuBotListView.vue:390-393`、`DingtalkBotListView.vue:313-316`、`SystemCommandListView.vue:583-585`、`SystemSettingsView.vue:447-449` 都有激活刷新——说明团队已知这个模式，只是漏改了这四个页面。
- **证据**：
  ```ts
  // SkillListView.vue:740
  onMounted(fetchActiveTab)
  // McpServerListView.vue:573 —— loadData() 在 <script setup> 顶层直接执行，无 onMounted/onActivated
  ```
- **用户影响**：Skills：用户在桌面端上传了新 Skill（或另一个管理员上传/删除），切回「Skills 管理」看不到，容易误判「上传失败了」；MCP/Agent/Model 同理，他人变更长期不同步。另一个副作用：MCP 页 300ms 防抖定时器（`:418-425`）没有 `onUnmounted` 清理，用户输入关键词后立刻切走，定时器仍会触发一次 `loadData()`，在后台打无效请求并把 `loading` 置 true——切回来时看到一次莫名的 loading 闪烁。
- **修复建议**：统一按 `SystemCommandListView` 的写法补 `onActivated`（用 `firstActivation` 守卫避免首屏重复请求，`onActivated` 在 keep-alive 首挂时也会紧跟 `onMounted` 触发）；建议抽成 `useKeepAliveRefresh(load)` composable 统一收口。MCP 页同时把顶层 `loadData()` 挪进 `onMounted` 并补防抖清理。
- **与前轮区别**：`2026-09-22-frontend-review-01.md` 曾以「本页保存成功后本页会重拉、没有另一处改数据时不是错误」放弃「多个列表 keep-alive 返回不刷新」；本轮列入的是**跨端/跨账号变更场景**（桌面端上传 Skill、另一管理员启停 MCP）下的陈旧，与该结论不重叠。

### 12. `isTouchDevice` 用「是否存在触摸事件」判定，触摸屏笔记本 / Electron 桌面端 Enter 不再发送消息（desktop，中）

- **位置**：`desktop/src/components/chat/ChatInput.vue:387`（定义）、`:820`、`:841`（Enter 行为分叉）
- **行为**：`isTouchDevice` 的判据是 `'ontouchstart' in window || navigator.maxTouchPoints > 0`。Chromium（含 Electron）在带触摸屏的 Windows 笔记本上两者均为 true。命中后 `:841` 的 `if (isTouchDevice || imeComposing) return false` 直接放行 Enter 给编辑器换行，桌面端最核心的「Enter 发送」静默失效，只能点发送按钮。这不是移动端专属逻辑，却用了设备能力而非输入形态做判据。
- **证据**：
  ```ts
  // ChatInput.vue:387
  const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)
  // :841
  if (isTouchDevice || imeComposing) return false
  ```
- **用户影响**：Surface 等触摸屏笔记本装 Electron 客户端或开 Web 端 → 输入消息按 Enter → 只插入换行不发送，无任何提示，用户反复按 Enter 后误以为发送成功（实际内容留在输入框）。
- **修复建议**：改为 `window.matchMedia('(pointer: coarse)').matches`（可加 `change` 监听保持响应式），或至少与 `isMobileViewport` 取并集，避免把「有触摸屏的桌面设备」当成手机。

### 13. AgentSelector 拉取失败与「暂无可用智能体」同形，且可能带空 agentId 建会话（desktop，中）

- **位置**：`desktop/src/stores/agent.ts:21-36`（`fetchAgents`）、`desktop/src/components/task/AgentSelector.vue:33,62-66`、`desktop/src/views/task/TaskView.vue:714-723`（`resolveNewTaskDefaults`）
- **行为**：`fetchAgents` 的 catch 把 `agents.value = []` 并静默吞错，不暴露 error 状态。网络失败时 UI 呈现「暂无可用智能体」，与「管理员确实没启用任何智能体」同形，且无重试入口。`resolveNewTaskDefaults` 失败时还会带着空 agentId 继续建会话。
- **证据**：
  ```ts
  // stores/agent.ts:28-32
  } catch {
    agents.value = []   // 吞错，error 与「真没配置」不可区分
  }
  // AgentSelector.vue:33
  v-if="filteredAgents.length === 0"  → 「暂无可用智能体」
  ```
- **用户影响**：弱网/服务端 5xx 时用户以为没配智能体，可能换账号/找管理员绕路；新建任务还可能落到无 Agent 的会话上。
- **修复建议**：store 暴露 `error`/`loading` 状态，选择器在 error 时渲染「加载失败 + 重试按钮」；`resolveNewTaskDefaults` 失败时阻止带空 agentId 建会话或明确提示。

### 14. 模型切换乐观更新无回滚，失败后 UI 与服务端模型不一致（desktop，中）

- **位置**：`desktop/src/components/chat/ChatPanel.vue:736-742`；`desktop/src/stores/session.ts:988-997`（`updateSessionModel`）
- **行为**：切换模型时先乐观写入 `newTaskModelId`，再 `await updateSessionModel`。store 的 `api.patch` 失败直接 throw，组件侧无 try/catch、无回滚。对照同文件权限级别切换（`:748-761`）有完整回滚逻辑，模型切换漏了。
- **证据**：
  ```ts
  // ChatPanel.vue:736-741（示意）
  sessionStore.xxx.newTaskModelId = newId   // 先写
  await sessionStore.updateSessionModel(...) // 失败直接 throw，无回滚
  ```
- **用户影响**：网络失败时界面显示已切换、服务端仍是旧模型，后续新建任务用错模型；异常冒泡为 unhandledrejection，无 toast。
- **修复建议**：与 `handlePermissionLevelChange` 对齐：try/catch，失败回滚 `newTaskModelId` 并 `ElMessage.error`。
- **来源**：原「四、待观察」#1，二次复核确认存在且对照已有回滚写法属遗漏，升级为正文。

---

## 二、UI 样式

### 15. Git 变更徽章与 +/- 统计、「待审批」相位徽章硬编码十六进制色，暗色模式无适配（desktop，中）

- **位置**：`desktop/src/components/task/GitChangeTreeNode.vue:169-173,205-206`；`desktop/src/components/task/TaskInspector.vue:1046-1047,1113-1116`；对照 `desktop/src/style.css:211-213,256-259`
- **行为**：这些颜色是 GitHub 亮色配方的硬编码副本，且两个文件的 `[data-theme="dark"]` 块都没有覆盖它们（`GitChangeTreeNode` 的暗色块只有 `:hover` 一条；`TaskInspector` 的暗色块不含 `.git-add/.git-del/.phase-badge`）。暗色底为 `--aw-surface/#252525`、`--aw-canvas/#1a1a1a`，实测对比度：`#1a7f37`≈3.0:1、`#cf222e`≈2.9:1、`#9a6700`≈3.2:1、`#b37400`≈3.9:1，均低于 WCAG AA 对 10–11px 文本的 4.5:1。尤其 `.phase-badge.waiting` 的 `#b37400` 是故意绕开设计令牌：`--aw-status-waiting` 在暗色下被特意提亮为 `#e6b84c`，同文件的 `.session-phase-dot.waiting` 用的就是令牌，右栏徽章却写死了暗琥珀色。
- **证据**：
  ```css
  /* GitChangeTreeNode.vue:169-173, 205-206 —— 无任何 dark 覆盖 */
  .git-type.created { color: #1a7f37; background: rgba(26, 127, 55, 0.12); }
  .git-type.modified { color: #9a6700; background: rgba(154, 103, 0, 0.12); }
  /* TaskInspector.vue:1113-1116 —— 令牌在暗色下是 #e6b84c，此处写死 #b37400 */
  .phase-badge.waiting { color: #b37400; background: rgba(179, 116, 0, 0.08); }
  ```
- **用户影响**：暗色主题下打开任务右栏 Git Tab 或看待审批任务，徽章文字暗、与相邻用令牌的元素出现可见色差。
- **修复建议**：改为语义令牌（如新增 `--aw-diff-add` / `--aw-diff-del` / 直接用 `--aw-status-waiting`，在 `style.css` 的亮/暗两套根作用域各给一个值），删除硬编码 hex。同类遗漏：`desktop/src/components/file-browser/FileTreeNode.vue:151` 也写死 `#b37400`，可一并修。

### 16. 聊天链路多处硬编码 `rgba(0, 102, 204, ·)` 绕过主题变量，深色主题下聚焦环/hover 底色失衡（desktop，低）

- **位置**：`desktop/src/components/chat/` 内实为 **8 处**（不止原文写的 6 处）：`ChatInput.vue:1446`、`:1456`、`ApprovalStack.vue:272`、`QueuePanel.vue:381`、`ModelSelector.vue:143`、`ChatPanel.vue:1057`、`SideChatPanel.vue:1015`、`MessageBubble.vue:626`（原文漏列）。同模式还散布在 `TaskIndexPanel` / `TaskInspector` / `FileViewer` / `FileDiffViewer` / `PdfViewer` / `TopNav` 等，全 desktop 约 20+ 处。
- **行为**：这些样式写在 `rgba(0, 102, 204, ...)` 即浅色主题主色 `#0066cc` 上，而同一批组件的其他样式都走 `var(--aw-primary)` / `var(--aw-primary-lighter)`（`style.css` 中 `:root[data-theme="dark"]` 对这套变量有覆写），硬编码值不随主题切换。
- **证据**：
  ```css
  /* ChatInput.vue:1444-1447 */
  .chat-input-card:focus-within {
    border-color: var(--aw-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.08);   /* 硬编码，无 dark 覆写 */
  }
  /* QueuePanel.vue:380-383 */
  .insert-btn:hover:not(:disabled) {
    background: rgba(0, 102, 204, 0.08);
    color: var(--aw-primary-focus);
  }
  ```
- **用户影响**：深色主题下输入框聚焦环、审批命令链接 hover 底色、队列「插入」按钮 hover、模型选项选中态、压缩指示器边框仍是浅色主题的亮蓝，在深色画布上过亮。影响偏视觉一致性，用户几乎无感。
- **修复建议**：统一改用语义变量（`--aw-primary-lighter` 或新增 `--aw-primary-ring` / `--aw-primary-hover`），修复时按变量**全量替换** desktop，不要只改点名的几处。

### 17. 会话搜索进行中完全没有加载态（desktop，低）

- **位置**：`desktop/src/components/search/SessionSearchPopover.vue:42`、`:150`、`:162`
- **行为**：`onKeywordInput` 防抖一开始就把 `status` 置为 `'loading'` 并清空旧结果，但模板把 loading 态整段排除渲染（`v-if="status !== 'idle' && status !== 'loading'"`），输入框也没有 prefix loading。每次搜索（300ms 防抖 + 请求耗时）界面只有输入框、正文空白，用户无法区分「没输完」和「在查」。
- **证据**：
  ```vue
  <!-- SessionSearchPopover.vue:42 -->
  <template v-if="status !== 'idle' && status !== 'loading'">
    <div class="search-summary"> ...
  ```
- **修复建议**：`status === 'loading'` 时渲染一行「搜索中…」或给 `el-input` 加 `:loading="status === 'loading'"`；最低成本是把 `v-if` 改为 `status !== 'idle'` 并在汇总行展示 loading 文案。

### 18. 一批图标按钮无可访问名称；安卓顶栏触摸目标 28–32px 低于代码库自身的 44px 约定（desktop，低）

- **位置**：`desktop/src/components/common/TopNav.vue:6`（返回）、`:11`（左侧面板）、`:22`（右侧面板）、`:30`（终端）、`:41`（刷新/更新）——均为 `<div class="theme-toggle" @click>` 仅挂 `el-tooltip`；`FileViewer.vue:41`（`<button class="refresh-btn">` 只有图标，连 title 都没有）；`FileTree.vue:14`（`el-icon` 直接当按钮）；`ChatInput.vue:138`（移除待发文件的 Close 图标）。触摸目标：`TopNav.vue:466-476`（`.theme-toggle { width: 28px; height: 28px }`）、`style.css:163-167`（安卓仅放大到 32px）、`SessionSearchPopover.vue:274-284`（`.search-toggle { 28px }`，无任何安卓/粗指针覆盖）；对照正例 `style.css:202-205`（`.terminal-keybar-btn { min-width: 44px }`）、`TaskIndexPanel.vue:1938-1948`（resize-handle 在 `(pointer: coarse)` 下放大到 44px）
- **行为**：这些元素是纯图标 + `@click`，无 `role`/`aria-label`/`title`；`el-tooltip` 只在悬浮后写入 `aria-describedby`，不提供可访问名称。同为图标开关，`TopNav` 内主题按钮有 `aria-label`（`:50,63`）、`SessionSearchPopover` 搜索钮也有，其余多个没有，属同一批组件内的不一致。触摸目标方面，安卓壳把顶栏做成紧凑单行，6 个图标按钮 + 用户头像挤在一行（`nav-right` gap 仅 2px），实际触摸区 28–32px，低于 Material/WCAG 建议的 44–48dp，项目自己在终端按键条和侧栏拖拽手柄上都执行了 44px，顶栏是遗漏的一处。
- **用户影响**：读屏/键盘用户 Tab 到顶栏听到一排无名称按钮；安卓用户点顶栏「终端 / 刷新 / 右侧面板」容易点空或误触相邻按钮。
- **修复建议**：统一补 `role="button"` + `aria-label`（文案与现有 tooltip 一致）；`FileTree.vue:14` 的 `el-icon` 改为 `<button>` 包裹。给 `.search-toggle` 与顶栏 `.theme-toggle` 补 `@media (pointer: coarse)` / `html.android-capacitor` 覆盖，触摸区放大到 ≥44px（可用负 margin 或 `::before` 扩展热区保持视觉紧凑）。

---

## 三、交互逻辑

### 19. CenterTabBar 右键菜单未做视口钳制，横向越界；且缺少滚动关闭（desktop，中）

- **位置**：`desktop/src/components/center/CenterTabBar.vue:73-79`（定位）、`:28-45`（Teleport 菜单）、`:97`（`overflow-x: auto`）
- **行为**：`onContextMenu` 直接 `contextMenu.x = e.clientX; contextMenu.y = e.clientY`，菜单 `position: fixed; min-width: 160px` 且无任何边界修正。Tab 条右端通常紧贴视口右缘，菜单会向右溢出屏幕，「关闭所有文件 / 关闭其他文件」被裁切或点到屏幕外。这是同一代码库里唯一不做钳制的右键菜单：`SideTaskList.vue:173-179`、`TaskIndexPanel.vue:609-618`、`GitContextMenu.vue:62-82`（还会量实际 `getBoundingClientRect()`）都有完整钳制。附带问题：`TaskIndexPanel` 用 capture 阶段 scroll 监听在滚动时关闭菜单，CenterTabBar 只有 click 关闭；横向滚动 Tab 条后 fixed 菜单会停留在失效坐标处。
- **证据**：
  ```ts
  // CenterTabBar.vue:73-79
  function onContextMenu(e: MouseEvent, tab: Tab) {
    if (tab.type === 'chat') return
    contextMenu.x = e.clientX
    contextMenu.y = e.clientY
  ```
- **修复建议**：复用 `GitContextMenu` 的做法——`await nextTick()` 后取 `getBoundingClientRect()`，按 `window.innerWidth/innerHeight - margin` 钳制；并补一个 capture 阶段的 scroll 监听关闭菜单。

### 20. 会话搜索 ↑/↓ 高亮不滚动到可见区域（desktop，中）

- **位置**：`desktop/src/components/search/SessionSearchPopover.vue:176-199`（`onPanelKeydown`）、`:407-412`（`.search-body` 限高滚动）
- **行为**：结果区 `.search-body` 一屏约放 5~6 条，后端最多返回 20 条。`↑/↓` 只改 `activeIndex`，全文件没有任何 `scrollIntoView` / `scrollTop` 调整。按到第 7 条之后高亮项移出视口，界面毫无变化，用户既看不到选中项，此时按 Enter 还会跳转到一个看不见的会话。
- **证据**：
  ```ts
  // SessionSearchPopover.vue:176-199（只改 activeIndex，无滚动调整）
  function onPanelKeydown(e: KeyboardEvent) {
    ...
    if (e.key === 'ArrowDown') { ... activeIndex.value = (activeIndex.value + 1) % len }
  ```
  ```css
  /* :407-412 */
  .session-search-dialog .search-body {
    max-height: min(440px, calc(100vh - 260px));
    overflow-y: auto;
  ```
- **修复建议**：`watch(activeIndex)` 里对当前 `li` 调 `scrollIntoView({ block: 'nearest' })`。
- **复核修订**：原文还写「Esc 仅输入框聚焦时生效」。二次复核发现 `el-dialog` 未关闭 `close-on-press-escape`（Element Plus 默认 `true`），点结果区后 Esc 多半仍能关对话框，该子项证据不足，已从标题与修复建议中移除。

### 21. MCP 服务器停用/启用无二次确认、无 try/catch（admin，低）

- **位置**：`admin/src/views/mcp/McpServerListView.vue:528-533`（`toggleStatus`）
- **行为**：`toggleStatus` 直接发 PUT，既没有 `ElMessageBox.confirm`，也没有 `try/catch`。同文件的删除有 `el-popconfirm`，同项目的飞书机器人启停也有一级确认（`FeishuBotListView.vue:366-377`）——这里不一致。
- **证据**：
  ```ts
  // McpServerListView.vue:528-533
  async function toggleStatus(row: any) {
    const next = row.status === 'ENABLED' ? 'DISABLED' : 'ENABLED'
    await api.put(`/mcp-servers/${row.id}/status`, { status: next })
    ElMessage.success(next === 'ENABLED' ? '已启用' : '已停用')
    await loadData()
  }
  ```
- **用户影响**：误触「停用」立即生效（停用一个全局 MCP 服务器会影响所有 Agent 的工具可用性），无挽回机会；失败时 promise rejection 直接冒泡成未处理拒绝，界面无任何反馈。
- **修复建议**：`toggleStatus` 外层加 `ElMessageBox.confirm`（文案与 `FeishuBotListView.handleEnabledChange` 对齐），包 `try/catch`。
- **去重**：`loadData()` 无条件 `currentPage.value = 1`、停用/删除后被弹回第 1 页，见 `2026-09-28-frontend-review-02.md` #6，不在本条重复。

### 22. 定时任务页四个筛选下拉没有 `@change`，且 keep-alive 切回不刷新（admin，低）

- **位置**：`admin/src/views/scheduled-tasks/index.vue:29-50`（四个 select 无 `@change`）、`:389-392`（仅 `onMounted`）
- **行为**：用户/Agent/状态/完结四个下拉只有 `v-model`，改完不会自动查询，必须手动点「查询」按钮；而同项目的 `AuditLogView.vue:23,33,46,58`、`LlmCallView.vue:20,25,42,59,77,88,91`、`FeedbackView.vue:34,47` 全部是「选完即查」。另外该页无 `onActivated`，而定时任务的 `nextFireTime`/`fireCount`/`finished` 是持续变化的。
- **用户影响**：改完条件下拉表格不动，用户以为筛选项失效；切回页面看到过期的「下次触发」时间。
- **修复建议**：四个 select 补 `@change="handleSearch"`；补 `onActivated` 刷新（该页数据时效性强，优先级比 Agent/Model 更高）。

## 四、复核后移除的条目

二次复核对以下原文条目判定为**不存在**或**修复价值过低**，不再列入正文：

| 原编号 | 原标题 | 移除理由 |
|---|---|---|
| 原 16 | admin 用量分析图表色硬编码 | 代码事实成立，但 **admin 无暗色主题**，字面量与 CSS 变量值当前完全一致，用户零感知；属主题化时再收口的一致性债 |
| 原 23 | 会话详情导出 JSON / CSV 同步 revoke | 与 `csv.ts` 约定不一致属实，但**实际下载失败从未复现**；现代 Chrome/Electron 下游离锚点 `click()` 通常可用。前轮已以「未证实会失败」放弃，本轮维持：更适合并入未来 `utils/download.ts` 统一时随手带上，不配独立缺陷条 |
| 原 26.1 | 钉钉绑定跳转缺参卡「正在跳转」 | 存在，但仅缺参/配置缺失的窄路径触发；降为「其他已检查」 |
| 原 7 | 技能上传依赖 webkitdirectory（安卓/iOS） | **产品范围外**：安卓/iOS 不提供技能上传功能，该问题不适用，整体移除 |
| 原 26.3 | 技能上传中再选文件被静默丢弃 | 存在但影响极小，且技能上传不在安卓/iOS 范围内，不单开 |
| 原 26.4 | `TERMINAL_FORBIDDEN` 只 warn | 代码注释写明是**有意吞掉**重连窗口内过期帧；非重连场景才哑，属增强而非缺陷 |
| 原 26.5 | 两个设置页首屏无 catch | 存在，拦截器仍会 toast，仅日志噪音 + 空态误显示；降为「其他已检查」 |
| 原 23 | FileViewer KeepAlive 激活不重载 | 按本轮范围忽略：有手动刷新兜底，跨会话/ git 改动才陈旧 |
| 原 24 | 边路创建事件不校验 parentSessionId | 按本轮范围忽略：触发窗口极窄的竞态 |
| 原 25 | 定时任务面板无刷新机制 | 按本轮范围忽略：离开再进即刷新，用户短暂停留为主 |
| 待观察 2 | `error` 无条件置 FAILED 语义过宽 | 并入正文 #4 一并设计，不单开 |
| 待观察 3 | 审批先回 IPC 再发 WS | 部分存在但「永不重建等待」未坐实，需 Electron 实机验证，无实证不升条 |
| 待观察 4 | FileChangePanel 显示错会话数据 | **前提不成立**：变更列表来自 `props.changes` 而非 `activeSession`，原文表述有误 |
| 待观察 5 | `useMessageFeedback` 登出不重置 | 纯展示态且 key 为服务端 sessionId，换账号后一般不可见 |
| 待观察 6 | wheel-up 误标 `userScrolledUp` | 体验细节、误触概率低 |
| 待观察 7 | `useTaskPanelPrefs` 的 `loaded` 闩锁 | 存在但时序极窄（路由守卫 + 前台恢复通常已规避）；一行修复可随手带，不单开 |
| 待观察 8 | 会话列表双触发多一次请求 | 存在但仅多一次全量列表请求，弱网下连续 loading；可随手 200ms 去重，不单开 |
| 待观察 9 | `sendMessageWithQueue` 恒 true / `durationMs` 用错列表 | 非活跃分支当前不可达；`durationMs` 用活跃列表是漏改的同类问题，保留为潜在备注不进正文 |
| 待观察 10 | 列表全量重算重排无虚拟化 | 当前规模非必现，属可扩展性隐患 |
| 待观察 11 | 全局快捷键不判来源/模态 | 产品取舍，不造成数据损坏 |
| 待观察 12 | `useScopeQuery` force 覆盖 inflight | 调用方有守卫且间隔大，窗口极窄 |

---

## 五、已排除：与前轮评审的关系说明

- **`useStreamWS.subscribe()` 失败后被永久标记已订阅**（`useStreamWS.ts:406-414`）：`2026-09-21-logic-bug-review-01.md` 已记录，结论是「`onopen`（`:207-214`）会把集合内所有会话整体重订阅，下一次成功连接即恢复，不构成持久错误」。本轮维持该结论，不重复开条；仅建议在失败路径补 `subscribedSessionIds.delete(sid)` 与 `console.warn` 作为稳健性收尾。
- **多个列表 keep-alive 返回不刷新**：`2026-09-22-frontend-review-01.md` 曾主动放弃。本轮重新评估后，仅在**跨端/跨账号变更**（正文 #11）与**导航意图/未保存输入丢失**（正文 #9、#10）两种与之不重叠的场景下列入，「本页保存后本页会重拉」的场景维持原结论。
- **同日 02 去重**：系统设置未保存覆盖（02 原 #3 → 本文 #10）、点踩反馈每页条数（02 原 #4 → 本文 #8）已从 02 移除。MCP 页码重置留在 02 #6，本文 #21 不再写「跳回第一页」。
- **导出同步 `revokeObjectURL`**：`2026-09-22-frontend-review-01.md` 以「未证实会失败」放弃。本轮二次复核后**维持放弃**，理由见上表原 23。
- **附件 10 张上限**：`2026-09-01-frontend-review-02.md` D28/D29 记录的是「合计计数文案误导」与「双数组下标隐式对齐」（后者已重构为 `{ file, previewUrl }[]`）；本轮 #3 是「同步校验被异步入队绕过导致上限完全失效」，是不同的缺陷。
- **删除会话**：`2026-09-01-frontend-review-01.md` F2 记录的是「删除后 Tab 状态永久残留」（已修复，当前代码调用 `removeSessionTabsFor`）；本轮 #1 是「连点确认发二次删除并弹假失败」。
- **授权外链打开**：`2026-08-30-frontend-review-01.md` D14 记录的是「非 Electron 环境点外链无反应、安卓未走系统浏览器」；本轮 #7 是「打开被拦截后无检测、无反馈、无限等待」。
- 以下历史条目本轮回读源码确认已修复，不再重复：`@` 文件引用竞态、队列「立即发送」失败阻塞、审批卡片失败回滚、`sendMessageAndWaitForSave` sid 竞态、「关闭其他文件」连带边路 Tab、审计日志自动刷新切页停摆、系统设置刷新不同步字段、`applyQueryFilters` 残留、任务重命名「取消」仍保存、聚焦列表 O(n²) 重构、MessageBubble 点踩气泡受控模式等。

## 六、其他已检查、未写入正文的点

- `desktop/src/components/chat/ChatInput.vue:145-147` 上传 `title` 写「上传图片或文件」而 LOCAL 模式 `accept` 收窄为 `image/*`：轻微不一致但同行有注释说明动机，且不会导致上传失败。
- `desktop/src/components/task/TaskIndexPanel.vue:673-674` 右键菜单位置估算用固定 `menuWidth=140/menuHeight=80`：分组菜单项数动态时高度估算偏大，仅在紧贴窗口右下角触发时可见偏差。
- `admin/src/views/mcp/McpServerListView.vue:166-171`「测试连接」弹窗漏了 `append-to-body`，与同文件其他弹窗不一致：`.el-dialog` 默认 teleport 到 body，功能上无影响。
- `admin/src/views/user/ResetPasswordDialog.vue`、`ModelListView.vue:177-182` 用裸 `el-dialog` 而非 `ResponsiveDialog`：`admin/src/styles/responsive.css:39-42` 有全局宽度兜底，移动端不会溢出，属风格不一致。
- `desktop/src/components/file-browser/FileTreeContextMenu.vue:50` 的 `showLocalActions` prop 声明后模板未使用：死属性，无用户可见影响。
- `admin/src/views/agent/AgentPromptHistoryDialog.vue:95-96` 的 `data[0]`：后端该路由永远返回数组，当前不可触发；建议加 `data ?? []` 兜底。
- `admin/src/views/agent/AgentFormDialog.vue:296` 用 `document.querySelector('.experience-text-editor')` 做滚动同步：当前该 class 全局唯一，实践中不会取错；属隐式全局契约。
- 原 26.1 钉钉绑定跳转缺参 / 原 26.5 两个设置页首屏无 catch：复核确认存在，但触发窄或仅日志噪音，不单开条目，可在错误态收口时顺手补。
