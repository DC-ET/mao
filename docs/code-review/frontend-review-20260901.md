# 前端代码审查报告（2026-09-01）

- **审查时间**：2026-09-01
- **审查范围**：`admin/src/`（管理后台全部视图/组件/store/路由）与 `desktop/src/`（桌面 / Web / 安卓三端共用 UI：聊天核心链路、设置与认证、技能与指令、任务与 Git、文件浏览、终端、中心区 Tabs）
- **审查维度**：功能模块缺陷 / UI 样式 / 交互逻辑（每条问题均已标注归属）
- **审查方法**：逐文件通读源码，每条问题附 `文件:行号` + 代码证据；权限类结论与 `backend-ts/src` 路由逐一交叉验证；已对照《frontend-ui-review-20260830.md》（41 项）排除已修复项，仅报增量问题
- **问题总数**：**60 条**（高 6 / 中 25 / 低 29）：admin 12 条（A20–A31）、desktop 48 条（D23–D70）
- **编号说明**：沿用 2026-08-30 报告的 A/D 前缀续号（admin A20 起、desktop D23 起），便于两份报告对照
- **复核说明**：三路并行审查（chat 核心链路 / desktop 设置与任务 / admin）产出的结论，主审已抽样 8 项逐行复核源码确认无误；各路附带的「已排查确认不成立的疑点」已合并至文末统一小节

---

## 与 2026-08-30 报告的关系

上一份报告 41 项（admin A1–A19 + desktop D1–D22）中，绝大多数已由提交 `42b4c75 fix(frontend): 修复前端 UI 审查报告 40 项问题（admin+desktop）` 修复。本轮逐项验证结果：

- **确认已修**（不再重复报）：A1/D1（XSS，dompurify 已接入双端 useMarkdown）、A4（401 死循环）、D2（hash 路由返回白屏，workbench-nav.ts）、D3（send 静默丢消息，sendReliable）、D4（401 排队挂起，pendingRequests reject）、D6（store reset 清理不全 + purgeSessionRuntime）、D9（MarkdownContent 竞态 renderGen）、D10（提问/审批防重）、D11（边路删除失败回滚）、D12（边路乐观消息时序）、D15（appendDelta 节流）、D16/D17（ChatPanel 卸载泄漏）、D20（补全误触发）、D22-1/2/4/5、D5（useCenterTabs effectScope）、D8（FileViewer loadFileSeq）、D14（外链兜底 openExternalUrl）、D18（routeEvent terminal 死代码已随重构消失）、D19（uploadingFiles 死状态已移除）、D21（MessageBubble hover 硬编码已修，但 TaskIndexPanel 出现同型新位置，见 D67）。
- **确认未修**：旧 D13（WS URL 携带明文 token）→ 本轮重编为 **D23**。
- **旧报告误判**：旧 A6 曾判定 RuntimeMonitorView 首次进入"写法正确"，实际仍存在双请求 bug → 本轮 **A21**。
- admin 侧 20260830 已修项的逐条核对结论见 A20–A31 各条及文末疑点小节第 3 条。

---

## 汇总速览

### admin（A20–A31，高 1 / 中 6 / 低 5）

| # | 问题 | 类别 | 严重度 | 位置 |
|---|---|---|---|---|
| A20 | 系统指令/用量分析/运行监控对非管理员自定义角色整页 403（前端权限码与后端 requireAdmin 不一致） | 功能 | **高** | admin/src/router/index.ts:76,82,94 |
| A21 | RuntimeMonitorView 首次进入重复请求两次（onActivated 跳过首次分支永不为真） | 功能 | 中 | views/runtime/RuntimeMonitorView.vue:229-243 |
| A22 | 系统设置页对 settings:read-only 角色展示全部可用写控件，点击必 403 | 功能 | 中 | views/settings/SystemSettingsView.vue:53-95 |
| A23 | IntegrationConfigPanel「清空密钥」标志被其他分组保存静默清除，清空语义丢失 | 功能 | 中 | views/settings/components/IntegrationConfigPanel.vue:248-298 |
| A24 | AuditLogView.showDetail 无 catch，失败时双重误报 | 功能 | 中 | views/audit/AuditLogView.vue:201-205 |
| A25 | UserFormDialog.fetchRoles / AgentFormDialog.loadOptions 无 catch，表单填充被跳过 | 功能 | 中 | views/user/UserFormDialog.vue:189-197 等 |
| A26 | 设置编辑弹窗保存失败仍关闭，输入内容丢失 | 交互 | 中 | views/settings/SystemSettingsView.vue:290-317 |
| A27 | AnalyticsView / AgentListView 列表竞态防护缺口 | 功能 | 低 | views/analytics/AnalyticsView.vue:122-129 等 |
| A28 | 文本筛选 clearable 无 @clear，点 × 不触发查询 | 交互 | 低 | views/runtime/RuntimeMonitorView.vue:34 等 |
| A29 | 统计卡片纯 @click 无键盘可达性 | 交互 | 低 | RuntimeMonitorView.vue:5-13 等 |
| A30 | SystemSettingsView 每次激活重复拉取 agents/models | 功能 | 低 | views/settings/SystemSettingsView.vue:319-322 |
| A31 | URL 类字段均无格式校验（baseUrl/LDAP/OAuth 回调） | 功能 | 低 | views/model/ModelFormDialog.vue:48 等 |

### desktop（D23–D70，高 5 / 中 19 / 低 24）

| # | 问题 | 类别 | 严重度 | 位置 |
|---|---|---|---|---|
| D23 | WS URL 携带明文 access token（旧 D13 未修） | 功能 | 中 | composables/useStreamWS.ts:171 |
| D24 | cancel/retry_execution/subscribe/unsubscribe 走不可靠 send，断线静默丢弃 | 功能 | 中 | composables/useStreamWS.ts:308-401 |
| D25 | updateTodoManually 死代码；Todo 清单只读不可操作 | 功能 | 中 | composables/useChat.ts:223-244 |
| D26 | sendMessage 与 sendMessageAndWaitForSave 近 130 行重复实现 | 功能 | 中 | composables/useChat.ts:282-669 |
| D27 | stopExecution 无条件本地置终态，与服务端不一致 | 交互 | 中 | composables/useChat.ts:671-693 |
| D41 | Git 凭证「创建/保存」无防重，双击可重复提交 | 功能 | **高** | views/settings/GitCredentialsView.vue:93,207-236 |
| D42 | 指令「创建/保存」无防重，可重复创建 | 功能 | **高** | components/command/CommandDrawer.vue:98,210-232 |
| D43 | 通知设置来回切换推送方式后「已配置」丢失，保存/测试按钮锁死 | 交互 | 中 | views/settings/NotificationSettingsView.vue:141-150 |
| D44 | McpServers/SkillDrawer/CommandDrawer/WeixinBot 多处拉取缺 catch → unhandledrejection | 功能 | 中 | views/settings/McpServersView.vue:285-303 等 |
| D45 | 飞书绑定弹窗 ESC/遮罩关闭后轮询不停止 | 交互 | 中 | views/settings/FeishuBotView.vue:32,121-135 |
| D46 | 微信Bot 绑定确认失败被吞，界面卡「绑定成功！」 | 交互 | 中 | views/settings/WeixinBotView.vue:207-239 |
| D47 | 登录页 Electron 飞书轮询无取消机制，卸载后仍可二次跳转 | 交互 | 中 | views/auth/LoginView.vue:264-291 |
| D48 | 4 个设置页弹窗固定 px 宽度，安卓/窄屏横向溢出 | UI | 中 | views/settings/McpServersView.vue:103 等 |
| D55 | 文件树请求全程无竞态防护，快速切会话显示上一个工作区内容 | 功能 | **高** | composables/useFileBrowser.ts:10-27 |
| D56 | showItemInFolder 无守卫，Web/安卓「在 Finder 中打开」直接 TypeError | 功能 | **高** | components/task/GitChangeList.vue:167-172 等 |
| D57 | 文件树筛选无防抖，逐字符触发 6 层全树并发请求风暴 | 功能 | **高** | components/file-browser/FileTree.vue:223-230 |
| D58 | 侧栏刷新链路完全无 catch，失败静默 | 功能 | 中 | components/task/TaskIndexPanel.vue:1039-1049 |
| D59 | 会话重命名失败输入框永久卡编辑态且无提示 | 交互 | 中 | components/task/TaskIndexPanel.vue:977-987 |
| D60 | 面板宽度 <200px 时右键删除静默失效 | 交互 | 中 | components/task/TaskIndexPanel.vue:568-572 |
| D61 | 边路任务编辑/删除/升级仅绑 contextmenu，触屏不可达 | 交互 | 中 | components/task/SideTaskList.vue:15,32-51 |
| D62 | loadSession 的 generation 守卫只覆盖第一个请求 | 功能 | 中 | views/task/TaskView.vue:810-906 |
| D63 | 非 Electron 环境「打开终端」展开永久空白面板 | 功能 | 中 | components/task/TaskIndexPanel.vue:799-805 |
| D64 | Inspector 自动重试 600ms 定时器无卸载清理 | 功能 | 中 | views/task/TaskView.vue:358-393 |
| D65 | 终端 resize 仅支持鼠标，触屏不可调且热区仅 6px | 交互/UI | 中 | components/terminal/TerminalPanel.vue:3,111-169 |
| D28 | 附件上限 10 为合计计数，提示文案误导 | 交互 | 低 | components/chat/ChatInput.vue:954-989 |
| D29 | filePreviewUrls 与 pendingFiles 下标隐式对齐 | 功能 | 低 | components/chat/ChatInput.vue:962-998 |
| D30 | QueuePanel 上/下移与编辑无防重、无失败回滚 | 交互 | 低 | components/chat/QueuePanel.vue:34-58 |
| D31 | ChatInput 硬编码品牌色，暗色主题不随 token | UI | 低 | components/chat/ChatInput.vue:1343-1369 |
| D32 | SideChatPanel 残留 Element 默认灰而非项目 token | UI | 低 | components/chat/SideChatPanel.vue:785-884 |
| D33 | ToolCallCard 4000 字截断后无查看/复制完整出口 | 交互 | 低 | components/chat/ToolCallCard.vue:211-217 |
| D34 | 上传入口 accept="" 不限类型，LOCAL 模式选完文件才报错 | 交互 | 低 | components/chat/ChatInput.vue:138,969-972 |
| D35 | macOS 红绿灯 78px 左缩进在 Web/Win/Linux 端浪费空间 | UI | 低 | components/common/TopNav.vue:342 |
| D36 | 权限级别切换失败只 console.error，本地已改不回滚 | 功能 | 低 | components/chat/ChatPanel.vue:695-703 |
| D37 | list.pop() 直接改 store 数组且未清 streamingAssistantMessageIds | 功能 | 低 | composables/useChat.ts:440-446,605-610 |
| D38 | FileReferencePanel/QuickCommandPanel 阴影硬编码双写明暗 | UI | 低 | components/chat/FileReferencePanel.vue:114-121 |
| D39 | ChatInput 文件搜索 debounce 卸载未清理 | 功能 | 低 | components/chat/ChatInput.vue:345,930-931,1247-1256 |
| D40 | 登录页飞书状态轮询单次失败即永久停止 | 交互 | 低 | views/auth/LoginView.vue:255-258 |
| D49 | 硬编码 rgba(0,102,204,0.08) 未走 --aw-accent-bg | UI | 低 | views/settings/SettingsView.vue:118-121 等 |
| D50 | 定时任务面板状态色用 Element 默认值未走 token | UI | 低 | components/ScheduledTaskPanel.vue:166-220 |
| D51 | 定时任务开关无 in-flight 防护，连点产生竞态 | 交互 | 低 | components/ScheduledTaskPanel.vue:58-63 |
| D52 | 「飞书登录」入口按钮无 loading/防重 | 交互 | 低 | views/auth/LoginView.vue:63-70 |
| D53 | 飞书授权 window.open 缺 noopener/noreferrer | 功能 | 低 | views/auth/LoginView.vue:220 |
| D54 | 安卓 OTA downloadProgress 监听器移除无效（addListener 返回 Promise） | 功能 | 低 | composables/useVersionCheck.ts:320-347 |
| D66 | 分组拖拽命令式 classList.add('dragging') 未清理 | UI | 低 | components/task/TaskIndexPanel.vue:1069-1099 |
| D67 | refresh-btn hover 与 SubagentList 状态点硬编码色、暗色缺覆盖 | UI | 低 | TaskIndexPanel.vue:1158; SubagentList.vue:106 |
| D68 | loadPrefs 双调用重复请求 + persistPrefs 静默失败 | 功能 | 低 | views/task/TaskView.vue:966-976 等 |
| D69 | 聚焦模式排序 O(n²) 回查，全量列表无虚拟滚动 | 性能 | 低 | TaskIndexPanel.vue:478; SideTaskList.vue:91-97 |
| D70 | 同一面板三种确认风格并存；边路改名/升级失败仅 console | 交互 | 低 | TaskView.vue:568-573 等 |

---
## 一、desktop 聊天核心链路（D23–D40）

范围：`ChatInput / ChatPanel / MessageBubble / useChat / useStreamWS / stores/session / QueuePanel / ToolCall* / MarkdownContent / LoginView`。

#### D23. WS URL 仍携带明文 access token（旧报告 D13 未修）
- **类别**：功能模块缺陷（安全）
- **位置**：`desktop/src/composables/useStreamWS.ts:171`
- **证据**：
```ts
const url = `${wsBase}/ws/stream?token=${token}&client=${client}`
```
- **影响**：access token 进入 URL，会被 Nginx/网关 access log、浏览器历史记录留存。2026-08-30 报告已列 D13，本轮确认仍未修复。
- **建议**：连接建立后首帧发送 auth 消息完成鉴权，或改用一次性短时 ticket 换取连接资格。

#### D24. `cancel` / `retry_execution` / `subscribe` / `unsubscribe` 仍走不可靠 `send()`
- **类别**：功能模块缺陷（断线丢操作）
- **位置**：`desktop/src/composables/useStreamWS.ts:308-314`（send）、`395-397`（cancel）、`399-401`（retryExecution）、`350-357`（subscribe）、`359-364`（unsubscribe）
- **证据**：
```ts
function cancel(sessionId: string) {
  send({ type: 'cancel', sessionId: Number(sessionId) })
}
function retryExecution(sessionId: string) {
  send({ type: 'retry_execution', sessionId: Number(sessionId), data: {} })
}
```
而 `send()` 在非 OPEN 状态只 `console.warn('[ws] send dropped (not open)')`。
- **影响**：D3 的修复（sendReliable）只覆盖了发消息类操作，停止/重试/订阅仍会被静默丢弃。与 D27 叠加后，断线时点「停止」UI 显示已停止而服务端仍在跑；「重试」只发不管结果，还提前 `ensureStreamingAssistantMessage` 造出空占位气泡。
- **建议**：四者改用 `sendReliable` 并把失败回传给调用方（提示"操作未送达，请检查连接"并保持原状态）。

#### D25. `useChat.updateTodoManually` 等导出为死代码；Todo 清单只读不可操作
- **类别**：功能模块缺陷（死代码/功能缺失）
- **位置**：`desktop/src/composables/useChat.ts:223-244`（updateTodoManually）、`useChat.ts:1080-1081`（导出）、`components/task/TodoChecklist.vue`（全文件）
- **证据**：全仓 grep `updateTodoManually` 仅在 `useChat.ts` 内出现（定义 + 导出），无任何调用方；`TodoChecklist.vue` 只有 `props.todos` 与 `completedCount/progressPercent` 两个 computed，模板无任何 `@click`/emit；`TaskInspector.vue:142` 仅 `<TodoChecklist :todos="todos" />`。
- **影响**：`start/complete/delete` 三种手动操作及对应 REST（`PATCH /sessions/{id}/todos/{todoId}`、`DELETE ...`）完全不可达，属半成品；用户在 Inspector 看到清单但无法勾选。
- **建议**：接通 TodoChecklist 交互（checkbox + 删除按钮），或删除 `updateTodoManually` 死代码。

#### D26. `sendMessage` 与 `sendMessageAndWaitForSave` 近 130 行重复实现
- **类别**：功能模块缺陷（可维护性/一致性风险）
- **位置**：`desktop/src/composables/useChat.ts:282-458`（sendMessage）、`useChat.ts:464-669`（sendMessageAndWaitForSave）
- **证据**：两者从「LOCAL+非 Electron 拦截 → uploadChatImages → connect → requireCurrentSession → createSession（11 个参数）→ uploadPendingFiles → resolveFileRefPaths → collectLocalUnsyncedSkills → collectAgentsMdContent → clearTodos/clearExecutionError → addUserMessage → ensureStreamingAssistantMessage → subscribe → setActiveExecution → wsSendMessage」逐行雷同，仅结尾等待策略不同（前者等 pendingCallbacks 完成，后者等 `onMessageSaved` 且 60s 超时）。
- **影响**：任何发送链路改动需改两处，极易漏改产生行为分叉。且 `sendMessage` 仅被 `sendMessageWithQueue`（useChat.ts:866）在非活跃时调用，`ChatPanel.handleSend` 实际走 `sendMessageAndWaitForSave`，两条主发送路径并存。
- **建议**：抽出 `prepareAndSend()` 公共前置流程，只保留等待策略差异。

#### D27. `stopExecution` 无条件本地置终态，与服务端不一致
- **类别**：交互逻辑（兼功能）
- **位置**：`desktop/src/composables/useChat.ts:671-693`
- **证据**：
```ts
function stopExecution() {
  clearActiveExecution(sid)
  wsCancel(sid)            // 无返回值、可能被丢弃（见 D24）
  sending.value = false
  sessionStore.updateSessionPhase(sid, 'CANCELLED')
  ...
  cb.resolve?.()
}
```
- **影响**：点「停止」后 UI 立刻变 CANCELLED 并出现「继续」按钮（ChatPanel 的 `canContinue` 依赖 phase==='CANCELLED'），但 Agent 实际可能仍在运行，后续流式事件会与本地终态冲突。
- **建议**：等 cancel 送达确认或服务端 phase 回执后再改本地态；发送失败时提示「停止失败」并保持运行态。

#### D28. 附件上限 10 是"合计"而非分别计数，提示文案误导
- **类别**：交互逻辑
- **位置**：`desktop/src/components/chat/ChatInput.vue:954-966`（addPendingImage）、`969-989`（addPendingFile）
- **证据**：两函数都判断 `if (pendingFiles.value.length >= 10)`，但一个提示「最多上传 10 张图片」，另一个提示「最多上传 10 个文件」，而 `pendingFiles` 是图片+文件混装的同一个数组（`handleSend` 才按 `f.type.startsWith('image/')` 拆分）。
- **影响**：已传 10 个文档再传图片会得到「最多上传 10 张图片」的错误归因提示，用户无法理解。
- **建议**：统一文案为「最多 10 个附件」，或图片/文件分别计数。

#### D29. `filePreviewUrls` 与 `pendingFiles` 用下标隐式对齐，易错且已出现所有权特例
- **类别**：功能模块缺陷（健壮性）
- **位置**：`desktop/src/components/chat/ChatInput.vue:962-965`、`986-988`、`992-998`（removePendingFileAt）、`1247-1256`（onBeforeUnmount）
- **证据**：`const idx = pendingFiles.value.length; pendingFiles.value.push(file); filePreviewUrls.value[idx] = URL.createObjectURL(file)`；非图片写 `''` 占位；卸载时按 `draftStore.getDraft(key)` 是否存在决定要不要 revoke（注释：「预览 URL 所有权已随草稿转移」）。
- **影响**：两个数组靠约定同步，`restoreContent`/`clearInput`/`removePendingFileAt`/草稿转移四处都要维持不变式，任一分支漏改即 blob 泄漏或预览错位。
- **建议**：合并为 `{ file, previewUrl }[]` 单一结构。

#### D30. QueuePanel 上/下移与编辑按钮无防重、无失败回滚
- **类别**：交互逻辑
- **位置**：`desktop/src/components/chat/QueuePanel.vue:42-50`（reorder）、`34`（edit）；对比 `handleInsert`（187-188）已有 `insertingQueueId` 防重
- **证据**：reorder/edit 直接 `@click="emit('reorder', item.msg.id, 'up')"`，无 disabled；`useChat.reorderQueueMessage`（useChat.ts:911-916）失败只 `ElMessage.error`，不回滚本地顺序。
- **影响**：连点上移会连发多次 WS；插入按钮已做防重而排序没做，体验不一致。
- **建议**：排序期间禁用该行按钮，或按 seq 忽略过期响应。

#### D31. ChatInput 硬编码品牌色，暗色主题与主题 token 双轨
- **类别**：UI 样式
- **位置**：`desktop/src/components/chat/ChatInput.vue:1343(#0066cc)`、`1348(#7c3aed)`、`1353(#0d9488)`、`1358(#5b9bd5)`、`1363(#a78bfa)`、`1368(#2dd4bf)`、`1369(#134e4a)`；`FileReferenceTag.vue:46,51,52` 同色重复
- **影响**：`#0066cc` 就是 `--aw-primary` 的字面值，暗色主题下这些标签色不随主题切换；同一套 Tag 配色在两个文件各写一遍。
- **建议**：抽为 `--aw-tag-skill/-command/-file` 等 token 并在 `[data-theme="dark"]` 覆盖。

#### D32. SideChatPanel 残留 Element 默认灰而非项目 token
- **类别**：UI 样式
- **位置**：`desktop/src/components/chat/SideChatPanel.vue:785(color: #909399)`、`796(--el-border-color-lighter, #ebeef5)`、`884(color: #c0c4cc)`
- **证据**：同文件 776 行已正确写成 `var(--aw-ink-muted-48, #909399)`，说明 785/884 是漏改。
- **影响**：边路任务空态文字与空态图标在暗色主题下对比度不足，与主聊天空态灰度不一致。
- **建议**：统一 `var(--aw-ink-muted-48)` / `var(--aw-hairline)`。

#### D33. ToolCallCard 4000 字符截断后无"查看完整/复制完整"出口
- **类别**：交互逻辑
- **位置**：`desktop/src/components/chat/ToolCallCard.vue:211-217`（truncatedResult）、模板 49-53（复制按钮传 `displayResultText`）
- **证据**：
```ts
const truncatedResult = computed(() => {
  const r = props.toolCall.result || ''
  const max = 4000
  if (r.length <= max) return r
  return r.slice(0, max) + '\n…（输出已截断）'
})
```
- **影响**：长工具输出（如 grep/shell 全量结果）用户既看不到也复制不到完整内容，复制按钮复制的是被截断文本，静默丢数据。
- **建议**：复制按钮复制 `toolCall.result` 原文，或提供「展开完整输出」。

#### D34. 上传入口 `accept=""` 不限类型，LOCAL 模式选完文件才报错
- **类别**：交互逻辑
- **位置**：`desktop/src/components/chat/ChatInput.vue:138`、`969-972`（addPendingFile）
- **证据**：
```html
<input type="file" multiple :accept="''" :disabled="disabled" @change="handleFileSelect" style="display: none" />
```
`addPendingFile` 开头：`if (props.executionMode === 'LOCAL') { ElMessage.warning('本地模式不支持文件上传…'); return }`
- **影响**：LOCAL 模式下「+」按钮依然可点、可弹系统文件选择器，选完才被拒——注定失败的入口。
- **建议**：LOCAL 模式下 `+` 只接受图片（或禁用非图片入口）并加 tooltip 说明。

#### D35. TopNav 的 macOS 红绿灯 78px 左缩进在 Web/Windows/Linux 端浪费空间
- **类别**：UI 样式（三端适配）
- **位置**：`desktop/src/components/common/TopNav.vue:342`（`padding-left: 78px; /* space for macOS traffic lights */`）
- **证据**：仅 `desktop/src/style.css:140-143` 为安卓做了 `html.android-capacitor .nav-left { padding-left: 0 !important; }`；浏览器端与 Windows/Linux Electron 无任何覆盖。Electron 主进程 `desktop/electron/main.cjs:983-984` 用 `titleBarStyle: 'hiddenInset'` + `trafficLightPosition`（macOS 专属）。
- **影响**：Web 端和非 macOS 桌面端顶栏左侧恒空出 78px，窄窗口下挤压左侧面板按钮。
- **建议**：按平台（`process.platform`/UA）加 class 条件化该 padding。

#### D36. ChatPanel 权限级别切换失败只 console.error，本地已改不回滚
- **类别**：功能模块缺陷
- **位置**：`desktop/src/components/chat/ChatPanel.vue:695-703`
- **证据**：
```ts
sessionStore.updateSession(sessionStore.activeSessionId, { permissionLevel: level })
try {
  await api.patch(`/sessions/${...}`, { permissionLevel: level })
} catch (e) {
  console.error('Failed to update permission level:', e)
}
```
- **影响**：先改本地再请求，失败仅打日志（拦截器会 toast「请求失败」但无归因），UI 显示新权限级别而服务端仍是旧值——权限相关的状态不一致，用户以为已切到 ACCEPT_EDITS 实际仍 READ_ONLY。
- **建议**：失败回滚本地并明确提示「权限级别切换失败」。

#### D37. `editAndResend`/`sendMessage` 的 `list.pop()` 直接改 store 数组
- **类别**：功能模块缺陷（状态管理规范）
- **位置**：`desktop/src/composables/useChat.ts:440-446`、`605-610`
- **证据**：`const list = sessionStore.getMessages(sessionId.value); const lastMsg = list[list.length-1]; if (lastMsg?.role === 'assistant' && !lastMsg.content && !(lastMsg.toolCalls?.length)) { list.pop() }`
- **影响**：绕过 store 的 setter 直接 mutate 内部数组，且 `streamingAssistantMessageIds`（session.ts 内普通 Map）未同步清理，被 pop 掉的占位消息 id 残留其中，后续 `ensureStreamingAssistantMessage` 的身份判断依据变脏。
- **建议**：走 store 方法（如 `removeTrailingEmptyAssistant(sid)`）并同步清 `streamingAssistantMessageIds`。

#### D38. FileReferencePanel / QuickCommandPanel 阴影用硬编码 rgba 双写明暗
- **类别**：UI 样式
- **位置**：`desktop/src/components/chat/FileReferencePanel.vue:114,121`、`QuickCommandPanel.vue:156,163`
- **证据**：`box-shadow: 0 -4px 16px rgba(0,0,0,0.1)` 与暗色下 `rgba(0,0,0,0.4)` 两套硬编码。
- **影响**：与 `QuestionPanel.vue:293`、`ApprovalStack.vue:135` 的阴影值各不相同，浮层层级视觉不统一。
- **建议**：抽 `--aw-shadow-popover` token。

#### D39. ChatInput 文件搜索 debounce 卸载未清理
- **类别**：功能模块缺陷（卸载后回调仍执行）
- **位置**：`desktop/src/components/chat/ChatInput.vue:345`（声明）、`523-525`（closeFilePanel 清理）、`930-931`（设置）、`1247-1256`（onBeforeUnmount）
- **证据**：grep 全文件仅上述 6 处出现；`onBeforeUnmount` 只做了 `saveDraft`、revoke 预览 URL、`editor.destroy()`，没有 `clearTimeout(fileSearchDebounce)`。
```ts
fileSearchDebounce = setTimeout(() => { fetchWorkspaceFiles(afterAt) }, 300)
```
- **影响**：组件卸载时若 300ms 防抖尚未触发，回调仍会执行 `fetchWorkspaceFiles`，访问已销毁组件作用域内的状态并发起无意义请求（切会话/关面板瞬间必现一次）。
- **建议**：`onBeforeUnmount` 内补 `if (fileSearchDebounce) clearTimeout(fileSearchDebounce)`。

#### D40. 登录页飞书状态轮询单次网络失败即永久停止
- **类别**：交互逻辑
- **位置**：`desktop/src/views/auth/LoginView.vue:255-258`（checkFeishuStatus:238 的 catch）
- **证据**：
```ts
} catch (error) {
  clearPollTimer()                      // 一次请求失败即永久停表
  feishuStatusText.value = '登录状态获取失败'
  showError(error, '飞书登录状态获取失败')
}
```
- **影响**：Web/安卓飞书登录轮询中，任一次 `/feishu/login/status` 请求因网络抖动失败就 clearInterval，轮询不再恢复；用户停在「登录状态获取失败」状态，必须重新点击飞书登录。对比 Electron 路径的 `pollFeishuResult` 对失败是 continue polling，行为不一致。
- **建议**：catch 内不 clearPollTimer（保留轮询），仅连续 N 次失败或明确 EXPIRED/FAILED 才停止。

---

## 二、desktop 设置 / 认证 / 技能 / 命令（D41–D54）

范围：`views/settings/*`、`views/auth/LoginView.vue`、`components/{skill/SkillDrawer,command/CommandDrawer,ScheduledTaskPanel,search/SessionSearchPopover}.vue`、`composables/{useScheduledTasks,useVersionCheck,useSkillDrawer,useCommandDrawer}.ts`。


### 严重程度：高

#### D41. Git 凭证「创建/保存」无防重，双击可重复提交
- **类别**：功能模块缺陷（双提交/无防重）
- **位置**：`desktop/src/views/settings/GitCredentialsView.vue:93`（按钮）、`:207-236`（handleSubmit）
- **证据**：
```html
<button class="dialog-btn dialog-btn-confirm" :disabled="!canSubmit" @click="handleSubmit">
  {{ isEditing ? '保存' : '创建' }}
</button>
```
```ts
async function handleSubmit() {
  if (!canSubmit.value) return

  try {
    if (isEditing.value && editingId.value != null) {
      ...
      await api.put(`/user/git-credentials/${editingId.value}`, payload)
    } else {
      await api.post('/user/git-credentials', {
```
- **影响**：组件内没有 `submitting/loading` 状态，按钮仅在 `canSubmit` 上禁用；请求在途时按钮仍可点击，双击或慢网下重复点击会并发发出多个 POST `/user/git-credentials`，创建重复凭证记录（同域名多条），编辑场景则并发 PUT 互相覆盖。对比同目录 ProfileView（`saving` + `if (saving.value) return`）已正确防护。
- **建议**：增加 `submitting` ref，`handleSubmit` 入口 `if (submitting.value) return`，按钮 `:disabled="!canSubmit || submitting"`。

#### D42. 指令「创建/保存」无防重，可重复创建指令
- **类别**：功能模块缺陷（双提交/无防重）
- **位置**：`desktop/src/components/command/CommandDrawer.vue:98`（按钮）、`:210-232`（handleSubmit）
- **证据**：
```html
<button class="dialog-btn dialog-btn-confirm" :disabled="!canSubmit" @click="handleSubmit">
  {{ isEditing ? '保存' : '创建' }}
</button>
```
```ts
async function handleSubmit() {
  if (!canSubmit.value) return

  try {
    if (isEditing.value) {
      await api.put(`/user-commands/${editingId.value}`, {...})
    } else {
      await api.post('/user-commands', {
```
- **影响**：与问题 1 同模式，无 `submitting` 状态。双击「创建」并发 POST `/user-commands` → 产生重复指令；从聊天消息「添加为指令」自动打开的创建弹窗（`watch(prefillContent)`）同样走此入口。编辑时并发 PUT 后写覆盖。
- **建议**：同问题 1，补 `submitting` 守卫并禁用按钮。

---

### 严重程度：中

#### D43. 消息通知：来回切换推送方式后「已配置」状态丢失，保存/测试按钮被锁死
- **类别**：交互逻辑（状态管理）
- **位置**：`desktop/src/views/settings/NotificationSettingsView.vue:141-150`（handleChannelChange）、`:122-125`（hasUsableWebhook）
- **证据**：
```ts
function handleChannelChange(value: string | number | boolean) {
  const next = value as NotificationChannel
  form.webhookUrl = ''
  showWebhook.value = false
  webhookError.value = ''
  if (next !== savedChannel.value) {
    preference.webhookConfigured = false
```
```ts
const hasUsableWebhook = computed(() => {
  return form.webhookUrl.trim().length > 0
    || (preference.webhookConfigured && form.channel === savedChannel.value)
})
```
- **影响**：用户在 钉钉→飞书→钉钉 来回切换后：切走时 `webhookConfigured` 被置 false，切回钉钉时 `next === savedChannel` 不触发任何恢复逻辑，本地「已配置」标志永久丢失。此时 `hasUsableWebhook=false` → `canSave=false`、`canTest=false`，保存与测试按钮禁用，必须刷新页面或重新粘贴 URL 才能保存——而服务端实际仍保存着钉钉的 webhook，用户并未想改动它。
- **建议**：在本地缓存已配置渠道集合；`handleChannelChange` 切回 `savedChannel` 时恢复 `preference.webhookConfigured/maskedWebhook`，或改为仅在保存成功后按服务端返回值重置。

#### D44. 多处列表/状态拉取缺 catch → unhandledrejection
- **类别**：功能模块缺陷（错误处理/未处理 Promise rejection）
- **位置**：
  - `desktop/src/views/settings/McpServersView.vue:285-303`（load，`onMounted(load)`；`:372-398` handleSubmit 内 `await load()` 也未捕获）
  - `desktop/src/components/skill/SkillDrawer.vue:298-304`（watch→fetchAll→fetchSkills/fetchSystemSkills）
  - `desktop/src/components/command/CommandDrawer.vue:165-181`（watch→fetchCommands）
  - `desktop/src/views/settings/WeixinBotView.vue:131-142`（fetchBindingStatus，onMounted 调用）
- **证据**：
```ts
async function load() {
  loading.value = true
  try {
    const [prefs, mine] = await Promise.all([getMcpServerPreferences(), getMyMcpServers()])
    ...
  } finally {
    loading.value = false
  }
}
```
```ts
watch(visible, (val) => { if (val) fetchAll() })
async function fetchAll() {
  await Promise.all([fetchSkills(), fetchSystemSkills(), fetchLocalSkills()])
}
```
- **影响**：四处均为「只有 finally 没有 catch」且调用方（onMounted / watch 回调 / @click 的 async handler）也不捕获。任一接口 500/网络错误时 rejection 一路上抛 → `unhandledrejection`（控制台报错、破坏全局错误监控信噪比）；页面停留在空态，除拦截器 toast 外无失败态呈现。MCP 提交成功后 `await load()` 失败还会使 handleSubmit 整体 reject。
- **建议**：为上述 try 补 catch（拦截器已统一 toast，catch 体保持空即可）；`fetchAll` 外层整体 try/catch。

#### D45. 飞书绑定：ESC/遮罩关闭弹窗后轮询不停止
- **类别**：交互逻辑（定时器未清理）
- **位置**：`desktop/src/views/settings/FeishuBotView.vue:32`（el-dialog 未监听关闭事件）、`:121-135`（startPolling/setInterval）、`:165-168`（closeDialog 仅挂在「取消」按钮）
- **证据**：
```html
<el-dialog v-model="dialogVisible" title="绑定飞书账号" width="460px" append-to-body>
```
```ts
function closeDialog() {
  dialogVisible.value = false
  clearPollTimer()
}
```
- **影响**：el-dialog 默认 `close-on-press-escape` 与 `close-on-click-modal` 均开启，但组件只给「取消」按钮绑了 `closeDialog`。用户按 ESC 或点遮罩关闭弹窗时 `dialogVisible` 置 false，`clearPollTimer()` 不会执行——之后每 2 秒继续请求 `/feishu/binding/status`，最长 5 分钟；期间若扫码完成，还会在弹窗已关闭的状态下弹「绑定成功」并再次置 `dialogVisible=false`。仅离开页面（onUnmounted）才兜底清理。
- **建议**：给 el-dialog 加 `@closed="clearPollTimer"`，将清理逻辑与关闭路径解耦。

#### D46. 微信Bot 扫码确认：绑定确认失败被吞，界面卡在「绑定成功！」
- **类别**：交互逻辑（错误处理）
- **位置**：`desktop/src/views/settings/WeixinBotView.vue:205-225`（confirmed 分支）、`:232-238`（pollStatus catch）
- **证据**：
```ts
    if (data.status === 'confirmed') {
      stopStatusPolling()
      // 确认绑定
      if (data.botToken && data.baseUrl && data.ilinkUserId) {
        await api.post('/weixin/binding/confirm', null, {...})
      }
      ElMessage.success('微信Bot绑定成功！')
      dialogVisible.value = false
      await fetchBindingStatus()
    }
  } catch (error) {
    console.error('查询扫码状态失败:', error)
    if (pollingActive) { statusPollingTimer = window.setTimeout(pollStatus, 3000) }
  }
```
- **影响**：`scanStatus.value = data.status`（:205）在进入分支前已置 `confirmed`，模板随即渲染「绑定成功！」；而 `stopStatusPolling()` 已执行（`pollingActive=false`），若 `/weixin/binding/confirm` 或 `fetchBindingStatus()` 抛错，catch 只 `console.error` 且因 `pollingActive=false` 不会重试。结果：确认 POST 失败时（拦截器可能弹过一个 toast），弹窗不关、绑定实际未建立，但界面永久停留「绑定成功！」且无任何重试入口，用户被卡死在假成功状态。
- **建议**：把 confirm POST 单独 try/catch；仅确认成功后再置 `scanStatus='confirmed'`、弹成功并关弹窗，失败时 `ElMessage.error` 并保留「重新获取/重试」路径。

#### D47. 登录页 Electron 飞书登录轮询无取消机制，卸载后仍执行并可二次跳转
- **类别**：交互逻辑（组件卸载后回调仍执行）
- **位置**：`desktop/src/views/auth/LoginView.vue:264-291`（pollFeishuResult）、`:293-298`（backToPasswordLogin）、`:319-321`（onBeforeUnmount 仅 clearPollTimer）
- **证据**：
```ts
async function pollFeishuResult(state: string) {
  await new Promise(resolve => setTimeout(resolve, 1500))
  let attempts = 0
  const maxAttempts = 30
  while (attempts < maxAttempts) {
    attempts++
    try {
      const result = await authStore.pollFeishuLogin(state)
      if (result.status === 'SUCCESS') {
        feishuStatusText.value = '登录成功'
        await finishLogin()
        return
      }
```
- **影响**：该循环基于 `await sleep` 而非 `pollTimer`，`clearPollTimer()`、`backToPasswordLogin()`、`onBeforeUnmount` 都停不掉它（循环也不检查 `feishuState` 是否已被清空）。用户点「返回密码登录」或离开登录页后，循环仍继续轮询至多 30 次（约 60s+），期间若服务端回调完成，会在用户已改用密码登录后执行 `finishLogin()` → `router.replace`，把用户从当前页面强行再跳一次。
- **建议**：增加模块级 `pollCancelled` 标志，循环每轮开始检查；`backToPasswordLogin` 与 `onBeforeUnmount` 中置位。

#### D48. 设置页弹窗固定 px 宽度，安卓/窄屏横向溢出
- **类别**：UI 样式（响应式/移动端适配缺失）
- **位置**：`desktop/src/views/settings/McpServersView.vue:103、168`（640px）、`GitCredentialsView.vue:57`（480px）、`WeixinBotView.vue:50`（480px）、`FeishuBotView.vue:32`（460px）
- **证据**：
```html
<el-dialog
  v-model="formVisible"
  :title="isEdit ? `编辑服务器：${form.name}` : '新增 MCP 服务器'"
  width="640px"
  class="mcp-server-dialog"
```
- **影响**：项目已为安卓准备了全局适配（`style.css`：`html.android-capacitor .management-dialog { width: calc(100vw - 24px) !important; ... }`），SkillDrawer/CommandDrawer 的弹窗都带 `management-dialog` class 命中该规则；但上述 4 个 settings 弹窗未带该 class 且固定 px 宽度。安卓 Capacitor 远程加载同一份 UI（视口 360-412px），弹窗远超屏幕宽度，表单/按钮被裁切、需横向滚动才能操作。
- **建议**：为这 4 个 el-dialog 补 `management-dialog` class（或将 width 改为 `min(640px, calc(100vw - 24px))` 形式）。

---

### 严重程度：低

#### D49. 硬编码主题色 rgba(0,102,204,0.08) 未走 --aw-accent-bg，暗色主题失真
- **类别**：UI 样式（硬编码颜色未走主题变量）
- **位置**：`desktop/src/views/settings/SettingsView.vue:118-121`、`desktop/src/views/settings/WeixinBotView.vue:449-451`
- **证据**：
```css
.settings-nav-item.active {
  color: var(--aw-primary);
  background: rgba(0, 102, 204, 0.08);
  font-weight: 500;
}
```
```css
.retry-btn:hover {
  background: rgba(0, 102, 204, 0.08);
}
```
- **影响**：`style.css` 已定义 `--aw-accent-bg`（亮色 `rgba(0,102,204,0.08)`，暗色 `rgba(41,151,255,0.12)`）。硬编码导致 `[data-theme="dark"]` 下设置导航选中态、微信重试按钮悬停态仍用亮色蓝 8% 底色，与暗色主题 accent 体系不一致、对比度偏低。
- **建议**：替换为 `var(--aw-accent-bg)`；主色文字可同步评估 `--aw-primary` → `--aw-accent`（暗色下为 #2997ff）。

#### D50. 定时任务面板状态色使用 Element 默认色值，未走主题 token
- **类别**：UI 样式（硬编码颜色未走主题变量）
- **位置**：`desktop/src/components/ScheduledTaskPanel.vue:166-176`（状态点）、`:208-220`（执行状态文字）
- **证据**：
```css
.status-dot.active { background: #67c23a; }
.status-dot.paused { background: #909399; }
.status-dot.finished { background: #c0c4cc; }
...
.exec-completed { color: #67c23a; }
.exec-failed { color: #f56c6c; }
```
- **影响**：项目 token 已有 `--aw-success: #34c759`、`--aw-danger: #ff3b30`、`--aw-warning: #ff9f0a`，此处硬编码 Element 默认色（#67c23a/#f56c6c/#e6a23c/#409eff/#909399），与全站成功/失败/警告色不一致；`.cron` 亦用裸 `monospace` 而非 `--aw-font-mono`。
- **建议**：替换为对应 `--aw-*` token；字体改 `var(--aw-font-mono)`。

#### D51. 定时任务开关无 in-flight 防护，快速连点产生并发 PUT 竞态
- **类别**：交互逻辑（请求竞态）
- **位置**：`desktop/src/components/ScheduledTaskPanel.vue:58-63`（el-switch 无 loading）、`desktop/src/composables/useScheduledTasks.ts:44-52`（toggleStatus）
- **证据**：
```html
<el-switch
  :model-value="task.status === 'ACTIVE'"
  size="small"
  :disabled="task.finished"
  @change="toggleStatus(task)"
/>
```
```ts
async function toggleStatus(task: ScheduledTask) {
  const newStatus = task.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'
  try {
    await api.put(`/scheduled-tasks/${task.id}`, { status: newStatus })
    task.status = newStatus
```
- **影响**：开关在请求期间不禁用，连点会并发发出 PUT PAUSED / PUT ACTIVE；两个响应到达顺序不确定，本地 `task.status` 以最后到达者为准，可能与服务端最终状态相反（显示「进行中」实际已暂停），需刷新才能纠正。
- **建议**：仿照 McpServersView 的 `savingId + :loading` 模式，toggle 期间禁用/加载该开关，或按 seq 丢弃过期响应。

#### D52. 登录页「飞书登录」入口按钮无 loading/防重，双击可重复发起授权
- **类别**：交互逻辑（双提交）
- **位置**：`desktop/src/views/auth/LoginView.vue:63-70`（feishu-entry 按钮）
- **证据**：
```html
<el-button
  v-if="authStore.features.feishuEnabled"
  class="feishu-entry"
  size="large"
  plain
  @click="startFeishuLogin"
>
```
- **影响**：`startFeishuLogin` 内部会置 `feishuLoading`（:199），但该按钮未绑定 `:loading`（面板内的按钮 ：81 绑了，两个入口行为不一致）；双击（在 `mode` 切换重渲染前）会并发两次调用 → 重复创建授权 state、弹出两个授权窗口。
- **建议**：补 `:loading="feishuLoading"`（或入口处 `if (feishuLoading.value) return`）。

#### D53. 登录页飞书授权 window.open 缺 noopener/noreferrer
- **类别**：功能模块缺陷（安全/三端一致性）
- **位置**：`desktop/src/views/auth/LoginView.vue:220`
- **证据**：
```ts
      // Web / 安卓: 新窗口打开飞书授权页，轮询状态
      window.open(authUrl, '_blank')
```
- **影响**：与 `FeishuBotView.vue:116` 的 `window.open(authUrl.value, '_blank', 'noopener,noreferrer')` 不一致；新开页可通过 `window.opener` 反向操控本页（reverse tabnabbing），且新页与登录页同源引用关系带来性能/安全隐患。
- **建议**：统一加第三参 `'noopener,noreferrer'`。

#### D54. 安卓 OTA：downloadProgress 监听器移除无效（addListener 返回 Promise）
- **类别**：功能模块缺陷（事件监听未清理，仅安卓）
- **位置**：`desktop/src/composables/useVersionCheck.ts:320-323`、`:345-347`
- **证据**：
```ts
const listener = plugin.addListener?.('downloadProgress', (data: { percent?: number }) => {
  appUpdateStatus.value = 'downloading'
  appUpdateProgress.value = data?.percent ?? null
})
...
} finally {
  listener?.remove?.()
}
```
- **影响**：`AppUpdatePlugin` 经标准 `registerPlugin(AppUpdatePlugin.class)` 注册（`android/.../MainActivity.java:91`），Capacitor JS 侧 `addListener` 返回 `Promise<PluginListenerHandle>` 而非同步句柄，`listener?.remove?.()` 对 Promise 是 no-op → 每次下载安装尝试新增一个 `downloadProgress` 监听且永不移除，反复触发更新时监听器持续累积。
- **建议**：`const handle = await plugin.addListener(...)`，finally 中 `await handle?.remove?.()`；或退出前 `plugin.removeAllListeners?.()`。

---


---

## 三、desktop 任务 / Git / 文件浏览 / 终端 / 中心区（D55–D70）

范围：`views/task/TaskView.vue`、`components/{task,file-browser,terminal,center}/*.vue`、`composables/{useTerminal,useGitStatus,useGitRepos,useFileBrowser,useCenterTabs,usePanelLayout,useTaskPanelPrefs,useForegroundRecovery}.ts`。


### 高

#### D55. 文件树请求全程无竞态防护，快速切换会话会显示上一个工作区的内容
- **类别**：功能模块缺陷（请求竞态）
- **位置**：`desktop/src/composables/useFileBrowser.ts:10-27`、`194-197`
- **证据**：
```ts
async function loadRoot() {
  if (!provider.value) { treeData.value = []; return }
  loading.value = true
  try {
    const result = await provider.value.listDirectory('')   // 无 seq / 无 AbortController
    if (result.error) treeData.value = [{ name: '', path: '', isDirectory: false, error: result.error }]
    else treeData.value = (result.entries || []).map(entryToNode)
  } catch (e: any) { ... } finally { loading.value = false }
}
watch(provider, () => { expandedPaths.value.clear(); loadRoot() }, { immediate: true })
```
- **影响**：`provider` 来自 `useWorkspaceFileProvider` 的 computed，`sessionId`/`workspace` 任一变化即产生**新对象**，watch 必然重触发。A→B 快速切会话时，A 的 `listDirectory('')` 若晚于 B 返回，会直接覆写 `treeData`，用户在 B 会话里看到 A 的目录树；点开其中文件还会按 B 的 provider 去读路径，导致"文件不存在"。`loading` 也被旧请求的 `finally` 提前置 false。`loadChildren`/`refresh` 同样无守卫。同文件的姊妹 composable `useGitStatus.ts`/`useGitRepos.ts` 都已实现 `requestSeq`，此处属遗漏而非设计取舍。
- **建议**：模块内加 `let requestSeq = 0`，`loadRoot/loadChildren/refresh` 各自 `const seq = ++requestSeq`，await 后 `if (seq !== requestSeq) return` 再写 `treeData`/`node.children`，`finally` 中 `if (seq === requestSeq) loading.value = false`；provider 变更时先 `treeData.value = []` 清空占位。

#### D56. `window.electronAPI.showItemInFolder` 无守卫，Web/安卓端右键"在 Finder 中打开"直接 TypeError
- **类别**：功能模块缺陷（三端守卫）
- **位置**：`desktop/src/components/task/GitChangeList.vue:167-172`、`desktop/src/components/file-browser/FileTree.vue:138-142`
- **证据**：
```ts
// GitChangeList.vue:167
function handleOpenInFinder() {
  if (!ctxMenu.node) return
  const path = ctxMenu.node.kind === 'file' ? ctxMenu.node.file.path : ctxMenu.node.path
  window.electronAPI.showItemInFolder(getAbsolutePath(path))   // 无可选链、无兜底
}
```
```html
<!-- GitChangeList.vue:61 —— 非 CLOUD 即显示该菜单项，与"是否 Electron"无关 -->
:show-open-in-finder="executionMode !== 'CLOUD'"
```
- **影响**：菜单显隐条件是**执行模式**（`executionMode !== 'CLOUD'`），而 API 存在性取决于**运行壳**。安卓 Capacitor 远程加载同一份 UI、或浏览器直接访问 `https://mao.etarch.cn` 打开一个 LOCAL 会话时，`window.electronAPI` 为 `undefined`，点击菜单项抛 `Cannot read properties of undefined`——不是静默失败，而是中断当前事件处理（菜单也不会关闭）。同文件 `TaskIndexPanel.vue:794` 已用 `if (workspace && window.electronAPI?.openFolder)` 正确守卫，`SkillDrawer.vue:264` 用 `!!window.electronAPI?.listLocalSkills` 判定环境，说明规范存在但这两处漏了。
- **建议**：菜单显隐条件改为 `executionMode !== 'CLOUD' && !!window.electronAPI?.showItemInFolder`；调用处用可选链 + `ElMessage.info('当前环境不支持在文件管理器中打开')` 兜底。同型扩散点：`components/chat/FileChangePanel.vue:173`（范围外，建议一并修）。

#### D57. 文件树筛选输入无防抖，每敲一个字符触发 6 层全树并发展开 → 请求风暴且不可取消
- **类别**：功能模块缺陷 / 性能
- **位置**：`desktop/src/components/file-browser/FileTree.vue:223-230`，配合 `useFileBrowser.ts:199-218`
- **证据**：
```ts
let filterSeq = 0
watch(filterText, async (val) => {
  const keyword = val.trim()
  if (!keyword) return
  const seq = ++filterSeq
  await loadAllDirectories(treeData.value, 0, 6)   // 无防抖：逐字符触发
  if (seq !== filterSeq) return
  filterVersion.value++
})
```
```ts
// useFileBrowser.ts:199 —— 对每个未加载目录并发 expandDir，递归到 6 层
for (const node of nodes) {
  if (node.isDirectory && !node.isSymlink && !node.children) {
    tasks.push(expandDir(node).then(async () => { ... await loadAllDirectories(node.children, depth + 1, maxDepth) }))
  }
}
await Promise.all(tasks)
```
- **影响**：输入 "index" 5 个字符 = 5 轮全树深度展开；每个目录一次 `listDirectory`（CLOUD 走 HTTP，LOCAL 走 IPC）。中等仓库（node_modules 未过滤时更甚）单轮就是数百请求，累计上千，表现为界面卡死、后端被打满。`filterSeq` 只保护 `filterVersion` 递增，**已发出的请求无法取消**。另外 `loadAllDirectories` 内 `expandDir(node)` 后又把 `node.expanded = false` 复原，而 `expandDir` 内部会执行 `compactSingleChildDirs` 改写 `node.name/path`，与用户手动展开操作交织时可致树结构错乱。
- **建议**：① 对 `filterText` 加 250-300ms 防抖，且仅当 `keyword.length >= 2` 才触发；② 深度从 6 降到 2-3 或改为"按需逐层懒加载 + 后端搜索接口"；③ 给 provider 的 `listDirectory` 透传 `AbortSignal`，筛选词变更时 abort 上一轮；④ 若必须保留，加并发闸门（如同时最多 6 个请求）。

---

### 中

#### D58. 侧栏刷新链路完全无 catch，失败静默 + unhandled rejection
- **类别**：功能模块缺陷（缺 catch）
- **位置**：`desktop/src/components/task/TaskIndexPanel.vue:1039-1049`，store 侧 `stores/session.ts:356`（`fetchSessions`）、`581`、`613`
- **证据**：
```ts
async function refreshSessions() {
  expandedCounts.value = new Map()
  await sessionStore.fetchSessions()                       // 无 try/catch
  if (sessionStore.focusLoaded) await sessionStore.fetchFocusSessions(true)
  if (sessionStore.archivedLoaded) await sessionStore.fetchArchivedSessions(true)
}
```
```ts
// stores/session.ts:356 —— try { ... } finally { loading = false }，无 catch，异常直接上抛
async function fetchSessions(silent = false) {
  if (!silent) loading.value = true
  try { const { data } = await api.get('/sessions/groups', { params: { previewLimit: DEFAULT_GROUP_PREVIEW } })
```
- **影响**：网络抖动/401/500 时，用户点刷新只看到图标转一下就恢复，列表仍是旧数据，**没有任何错误提示**；控制台产生 unhandled rejection。且第一个 await 抛错后，后面的聚焦/归档刷新被跳过，出现"部分刷新"不一致状态。同文件 `loadFocus()` 有 catch 写 `focusError`、`loadArchive()` 有 catch，唯独主刷新裸奔。
- **建议**：`refreshSessions` 包 `try/catch`，catch 内 `ElMessage.error('刷新失败，请稍后重试')`；三个 fetch 之间改为 `Promise.allSettled` 以避免一个失败拖垮其余。

#### D59. 会话重命名失败时输入框永久卡在编辑态且无提示
- **类别**：交互逻辑（失败态处理）
- **位置**：`desktop/src/components/task/TaskIndexPanel.vue:977-987`，`stores/session.ts:975-976`
- **证据**：
```ts
async function confirmEdit(e?: MouseEvent) {
  e?.stopPropagation()
  const id = editingSessionId.value
  const title = editingTitle.value.trim()
  if (!id || !title) { cancelEdit(); return }
  await sessionStore.renameSession(id, title)   // 抛错 → 下面两行永不执行
  editingSessionId.value = null
  editingTitle.value = ''
}
```
```ts
// stores/session.ts:975
async function renameSession(id: string, title: string) {
  const { data } = await api.patch(`/sessions/${id}`, { title })   // 无 try/catch
```
- **影响**：PATCH 失败（离线、无权限、标题超长被后端拒）后 `editingSessionId` 不复位，该行一直停在输入框状态，用户反复回车都无反应也无报错；只能靠切窄面板（触发 M3 的 watch 清理）或刷新页面脱困。`confirmDelete` 同样无 catch（失败无提示，但不会误改本地状态）。
- **建议**：`confirmEdit` 用 `try { await ... } catch { ElMessage.error('重命名失败') } finally { editingSessionId.value = null; editingTitle.value = '' }`；或保留编辑态但显示行内错误样式，二者择一，不要"既不成功也不退出"。

#### D60. 面板宽度 < 200px 时右键菜单"删除"静默失效
- **类别**：交互逻辑
- **位置**：`desktop/src/components/task/TaskIndexPanel.vue:568-572`、`701`、`749-755`、模板 `119` / `212`
- **证据**：
```ts
function menuDelete() {
  const id = contextMenu.sessionId
  closeContextMenu()
  if (id) confirmingDeleteId.value = id      // 只置标记，UI 由 session-item-actions 呈现
}
const showItemActions = computed(() => effectivePanelWidth.value >= ACTION_BUTTONS_MIN_WIDTH) // 200
watch(showItemActions, (show) => { if (!show) { confirmingDeleteId.value = null; ... } })
```
```html
<div v-if="showItemActions" class="session-item-actions">   <!-- 勾/叉确认按钮的唯一宿主 -->
```
- **影响**：删除是"行内二次确认"模式，确认按钮只存在于 `session-item-actions` 内，而该容器在窄面板下被 `v-if` 移除。用户把侧栏拖窄（<200px）后右键→删除，什么都不会发生，也没有提示；操作被静默吞掉。窄面板是常见布局（尤其安卓/小屏）。
- **建议**：`menuDelete()` 在 `!showItemActions.value` 时改走 `ElMessageBox.confirm` 直接执行删除；或菜单项在窄面板下禁用并给出提示。更彻底的做法见 D70（统一确认风格）。

#### D61. 边路任务列表的编辑/删除/升级仅绑 `contextmenu`，触屏与安卓端完全不可达
- **类别**：交互逻辑（移动端）
- **位置**：`desktop/src/components/task/SideTaskList.vue:15`、`32-51`
- **证据**：
```html
<div ... @click="handleClick(task)" @contextmenu.prevent="openContextMenu($event, task)">
```
```html
<div class="side-task-item-actions">
  <template v-if="confirmingDeleteId === task.id"> ...勾/叉... </template>
  <template v-else-if="editingId === task.id"> ...勾/叉... </template>
  <template v-else></template>      <!-- 常态下动作区为空：无 hover 入口 -->
</div>
```
- **影响**：常态列表项没有任何操作按钮，全部入口（重命名 / 删除 / 升级为主任务）只能靠右键。安卓 Capacitor WebView 与触屏设备**不产生 `contextmenu` 事件**，也未实现长按（`touchstart` + 计时）；即边路任务在移动端只能打开、无法管理。`TaskIndexPanel` 的注释写着"桌面右键 / 移动端长按"，但代码同样只绑了 `@contextmenu.prevent`，长按未实现。对照 `CenterTabBar.vue` 已有 `@media (max-width: 768px), (hover: none) { .tab-close { opacity: 1 } }` 的正确适配。
- **建议**：抽一个 `useLongPress`（`touchstart` 500ms 触发、`touchmove`/`touchend` 取消）与 `@contextmenu` 共用同一 `openContextMenu`；同时在 `@media (hover: none)` 下把 `.side-task-item-actions` 常显一个"更多"按钮。

#### D62. `loadSession` 的 generation 守卫只覆盖第一个请求，后两段与 `initialLoading` 复位无保护
- **类别**：功能模块缺陷（请求竞态）
- **位置**：`desktop/src/views/task/TaskView.vue:810-817`、`874`、`908`
- **证据**：
```ts
async function loadSession(sid: string) {
  const gen = ++loadGeneration
  try { const { data } = await api.get(`/sessions/${sid}`)
        if (gen !== loadGeneration) return          // ← 仅此一处校验
  ...
  const res = await api.get(`/sessions/${sid}/side-tasks`)      // 无 gen 校验
  ...
  if (items.length > 0) restoreSideTaskTabs(sid, items.map(st => ({ id: st.id, title: st.title || '任务' })))
  ...
  initialLoading.value = false                                  // 无 gen 校验，旧请求也会执行
}
```
- **影响**：快速切会话（A→B）时，A 的 `loadSession` 在被"作废"后仍继续跑完两段请求：① `restoreSideTaskTabs(A, ...)` 会为**已离开的 A** 恢复 Tab，污染中间区 Tab 栏；② 末尾 `initialLoading.value = false` 让 B 的加载态提前结束，而 `isNewTaskMode = computed(() => !sessionIdParam && !initialLoading)` 依赖它，会出现"骨架/新任务态"闪烁。
- **建议**：两段请求 await 之后同样 `if (gen !== loadGeneration) return`；末尾改 `if (gen === loadGeneration) initialLoading.value = false`。

#### D63. 非 Electron 环境点"打开终端"会展开一个永远空白的终端面板
- **类别**：功能模块缺陷（三端守卫）
- **位置**：`desktop/src/components/task/TaskIndexPanel.vue:799-805`，`composables/useTerminal.ts:116`
- **证据**：
```ts
function openTerminal(group: { key: string }) {
  const workspace = group.key.startsWith('LOCAL:') ? group.key.substring(6) : ''
  if (!terminalOpen.value) { terminalOpen.value = true }   // 先无条件打开面板
  createTerminal(workspace || undefined)                   // 再尝试创建
}
```
```ts
// useTerminal.ts:115
async function createTerminal(cwd?: string): Promise<string | null> {
  if (!isElectron()) return null      // 直接返回，无任何反馈
```
- **影响**：LOCAL 分组在 Web/安卓端同样会渲染（分组来自后端会话数据，不按运行壳过滤），点击终端按钮后底部撑开一块空白面板，没有 tab、没有报错、没有提示，且 `terminalOpen` 已持久化为 true，下次进入还是空白。返回值 `null` 也被丢弃（未 void 标注、未判空）。
- **建议**：`openTerminal` 首行加 `if (!window.electronAPI?.createTerminal) { ElMessage.info('终端仅在桌面客户端可用'); return }`；或按钮本身用同一条件 `v-if` 隐藏。并把 `createTerminal` 的 `null` 返回纳入判断，创建失败时回滚 `terminalOpen = false`。

#### D64. Inspector 元数据自动重试的 600ms 定时器无卸载清理，组件销毁后仍发请求
- **类别**：功能模块缺陷（卸载后回调仍执行）
- **位置**：`desktop/src/views/task/TaskView.vue:358-368`（meta）、`386-393`（todos）
- **证据**：
```ts
} catch (e) {
  console.warn(`[inspector] Failed to fetch meta for sub-session ${sid}:`, e)
  pendingInspectorMeta.delete(sid)
  if (!autoRetriedMeta.has(sid) && inspectorSessionId.value === sid) {
    autoRetriedMeta.add(sid)
    await new Promise(resolve => setTimeout(resolve, 600))   // 无 handle 保存、无 onUnmounted 清理
    if (inspectorSessionId.value === sid) await ensureInspectorMeta(sid, viewType, parentId)
  }
}
```
- **影响**：请求失败后 600ms 内用户离开 `/tasks/:id`（组件卸载），定时器仍会 fire。`inspectorSessionId` 是组件内 ref，卸载后其值仍等于 `sid`，条件成立 → 对已销毁组件继续发起 API 调用并写 store，产生无意义流量与"幽灵状态"。若失败原因是 401，还会触发一次多余的登录跳转。
- **建议**：保存 timer handle 到组件级数组，`onUnmounted` 统一 `clearTimeout`；或加 `let disposed = false; onUnmounted(() => disposed = true)`，重试前判 `if (disposed) return`。更佳：用 `AbortController` 串联请求与延时。

#### D65. 终端面板 resize 仅支持鼠标，触屏无法调整高度且热区仅 6px
- **类别**：交互逻辑 / UI 样式（触控）
- **位置**：`desktop/src/components/terminal/TerminalPanel.vue:3`、`111-116`、`161-169`
- **证据**：
```html
<div class="terminal-resize-handle" @mousedown="startResize" />
```
```ts
function startResize(e: MouseEvent) {
  e.preventDefault()
  const startY = e.clientY
  ...
  function onMove(e: MouseEvent) { ... }   // 只监听 mousemove/mouseup
```
```css
.terminal-resize-handle { position: absolute; top: -3px; left: 0; right: 0; height: 6px; cursor: row-resize; }
```
- **影响**：触屏/安卓端无法拖动改变终端高度（`touchstart` 未绑定）。6px 热区在 coarse pointer 下也几乎点不中。对照 `TaskIndexPanel.vue:743-746` 的 resize 已同时绑 `touchmove/touchend` 并在 `@media (pointer: coarse)` 下加宽热区，本组件属遗漏。
- **建议**：把 `startResize` 参数改为 `MouseEvent | TouchEvent`、统一取 `clientY`（`'touches' in e ? e.touches[0].clientY : e.clientY`），补 `@touchstart.prevent`；样式加 `@media (pointer: coarse) { .terminal-resize-handle { top: -8px; height: 16px } }`。

---

### 低

#### D66. 分组拖拽手动 `classList.add('dragging')` 未清理，拖完残留半透明
- **类别**：UI 样式
- **位置**：`desktop/src/components/task/TaskIndexPanel.vue:1069-1075`、`1099`
- **证据**：
```ts
function onGroupDragStart(e: DragEvent, index: number) {
  dragIndex.value = index
  ...
  const target = e.target as HTMLElement
  target.classList.add('dragging')      // 命令式加类
}
function onGroupDragEnd() { dragIndex.value = null; dragOverIndex.value = null }   // 未移除
```
- **影响**：模板上已有 `:class="{ 'dragging': dragIndex === index }"` 由 Vue 管理；命令式再加同名类后，Vue 的 diff **不会移除它**（Vue 只管自己渲染出的 class 集合，且 `e.target` 可能是子元素而非绑定 class 的分组根节点）。结果拖拽结束后该元素或其子元素永久保留 `dragging` 半透明样式，直到列表重渲染。
- **建议**：删掉 `target.classList.add('dragging')`，完全依赖 `dragIndex` 的响应式绑定（本已存在）；如确需作用到 `e.target`，在 `onGroupDragEnd` 里保存引用并 `remove`。

#### D67. 硬编码颜色 + 暗色缺覆盖：`.refresh-btn:hover` 与 `SubagentList` 整体
- **类别**：UI 样式（主题变量）
- **位置**：`desktop/src/components/task/TaskIndexPanel.vue:1158-1160`（暗色区 `1639-1843` 共 21 条 `[data-theme="dark"]` 规则，无一条覆盖 `.refresh-btn:hover`）；`desktop/src/components/task/SubagentList.vue:106-108`（全文无 `[data-theme="dark"]` 块）
- **证据**：
```css
/* TaskIndexPanel.vue:1158 */
.refresh-btn:hover:not(:disabled) { background: rgba(0, 0, 0, 0.06); color: var(--aw-primary); }
```
```css
/* SubagentList.vue:106 */
.subagent-phase-dot.waiting   { background: #d4a017; }
.subagent-phase-dot.completed { background: #3a8f5c; }
.subagent-phase-dot.failed    { background: #c44; }
```
- **影响**：① 暗色主题下面板顶部三个按钮（模式切换/刷新/新任务）的 hover 反馈是"黑上叠黑"，几乎不可见——与旧报告 D21 同型但位置不同（D21 指 MessageBubble），属未覆盖到的新位置。② `SubagentList` 的状态点用字面色值，暗色下 `#3a8f5c`、`#c44` 对比度不足，且与 `TaskIndexPanel` 的 `.session-phase-dot.waiting #b37400`、`SideTaskList` 的同语义点**三处不同色值**，同一状态在三个列表里颜色不一致。
- **建议**：`.refresh-btn:hover` 改用 `var(--aw-surface-pearl)` / 补 `[data-theme="dark"] .refresh-btn:hover:not(:disabled) { background: rgba(255,255,255,0.08) }`；把 waiting/completed/failed 提取为 `--aw-status-waiting/success/danger` 全局变量并在暗色块给值，三个列表统一引用。

#### D68. `loadPrefs()` 被 TaskView 与 TaskIndexPanel 各调一次，首屏重复 GET
- **类别**：功能模块缺陷（冗余请求）
- **位置**：`desktop/src/views/task/TaskView.vue:966-976`、`desktop/src/components/task/TaskIndexPanel.vue:758`、`composables/useTaskPanelPrefs.ts:9`、`62-71`
- **证据**：
```ts
// TaskView.vue:967
async function loadTaskIndex() {
  if (!getToken()) { await loadPrefs(); initialLoading.value = false; return false }
  try { await sessionStore.fetchSessions(); await loadPrefs(); return true } catch { ... }
}
```
```ts
// TaskIndexPanel.vue:757
onMounted(() => { void loadPrefs() ... })
```
```ts
// useTaskPanelPrefs.ts:9 —— loaded 存在但 loadPrefs 从不检查它
const loaded = ref(false)
async function loadPrefs() { if (!getToken()) { ... } loading.value = true; try { const { data } = await api.get('/user-preferences/task-panel') ...
```
- **影响**：每次进入任务页发两次 `GET /user-preferences/task-panel`；两次响应有先后，后到者覆写 `groupOrder`/`collapsedGroups`，若期间用户已拖动排序则该操作被回滚。另 `persistPrefs` 是 `.catch(() => {})` 静默失败，保存失败后本地已改、服务端未改，下次 `loadPrefs` 用旧值覆盖，表现为"排序莫名丢失且无提示"。
- **建议**：`loadPrefs` 首行 `if (loaded.value) return`，并用模块级 `let loadPromise` 做 in-flight 去重（并发调用共享同一 Promise）；`persistPrefs` 失败时至少 `ElMessage.warning('面板偏好保存失败')`。

#### D69. 聚焦模式排序 O(n²) 回查 + 每项状态重算，全量列表无虚拟滚动
- **类别**：性能
- **位置**：`desktop/src/components/task/TaskIndexPanel.vue:478-481`、`desktop/src/components/task/SideTaskList.vue:91-97`
- **证据**：
```ts
// TaskIndexPanel.vue:478
const focusedSessions = computed<Session[]>(() =>
  sortByFocusPriority(sessionStore.focusedSessions.map(sessionToFocusCandidate))
    .map(c => sessionStore.focusedSessions.find(s => String(s.id) === String(c.id)))   // O(n²)
    .filter((s): s is Session => !!s)
)
```
```ts
// SideTaskList.vue:94
return sortByFocusPriority(list.map(sideTaskToFocusCandidate)).map(
  c => list.find(t => String(t.id) === String(c.id))!    // O(n²) + 非空断言
)
```
- **影响**：`fetchFocusSessions` 拉的是**全量 ACTIVE 会话（无分页）**，聚焦模式下 `focusMainSessions`/`historySessions` 还各自再遍历一次，`focusStatusLabel`/`focusStatusClass` 每个可见项都调 `sessionStore.getSideTasks(...)` 并做多次 `Math.max`。会话数上千时每次 store 变更（WS 推送很频繁）都触发整链重算，滚动与输入明显掉帧。列表本身无虚拟滚动。
- **建议**：先建 `const byId = new Map(list.map(s => [String(s.id), s]))` 再 `map(c => byId.get(c.id))`，把 O(n²) 降为 O(n)；`focusStatusLabel/Class` 的结果用一个 `computed` 预计算成 `Map<id, label>`；列表超过 ~200 项时接入 `el-virtual-list` 或自实现窗口化。

#### D70. 同一任务面板并存三种确认风格，且边路任务改名/升级失败只打 console
- **类别**：交互逻辑（一致性）
- **位置**：`TaskIndexPanel.vue:120-128`（行内勾叉确认）vs `TaskView.vue:577`（`ElMessageBox.confirm` 删除边路任务）vs `TaskInspector.vue` `runGitOperation`（commit/pull/push 无确认）；`TaskView.vue:568-570`
- **证据**：
```ts
// TaskView.vue:568 —— 重命名失败仅 console，与 delete 已有的 ElMessage.error 风格不一致
} catch (e) {
  console.warn('[side-task] Failed to rename side task:', e)
}
```
- **影响**：用户在同一屏内会遇到三种删除/确认交互（行内勾叉、模态框、直接执行），心智负担与误操作风险；边路任务重命名、升级为主任务失败时**界面无任何反馈**（本地标题可能已乐观更新，看起来"成功了"，刷新后回退）。注：旧报告 D11 已把边路任务删除从 `window.confirm` 改为 `ElMessageBox`（全范围已无 `window.confirm` 残留），本条是余下的一致性问题。
- **建议**：统一为 `ElMessageBox.confirm`（或统一为行内确认），破坏性操作一律走同一封装；`handleEditSideTaskTitle` / `handlePromoteSideTask` 的 catch 补 `ElMessage.error(...)`，与 `handleDeleteSideTask` 对齐。

---


---

## 四、admin 管理后台（A20–A31）

范围：`views/settings/SystemSettingsView.vue` + `components/IntegrationConfigPanel.vue`（重点）、`views/{user,model,agent,skill,system-commands,feishu-bot,permission,audit,analytics,runtime}`、`components/*.vue`、`stores/*.ts`、`api/index.ts`、`router/index.ts`；权限类结论已与 `backend-ts/src` 路由逐行交叉验证。


### 高

#### A20. 非管理员角色进入「系统指令 / 用量分析 / 运行监控」必然整页 403（前端权限门禁与后端 requireAdmin 不一致）

- **类别**：功能模块缺陷（权限）
- **位置**：`admin/src/router/index.ts:76,82,94`；`admin/src/components/SideMenu.vue:119,121,137`；后端 `backend-ts/src/command/admin-system-command.routes.ts:33,50,72,99`、`backend-ts/src/admin/admin.routes.ts:30,38`
- **证据**（router/index.ts:73-83,91-94）：
  ```ts
  { path: 'runtime',   name: 'RuntimeMonitor', meta: { ..., permission: 'session:read' } },
  { path: 'analytics', name: 'Analytics',      meta: { ..., permission: 'session:read' } },
  { path: 'system-commands', name: 'SystemCommands', meta: { ..., permission: 'user:write' } },
  ```
  SideMenu.vue:119/121/137 用同一批权限码控制菜单可见；而后端对应接口全部是角色级校验：
  ```ts
  // command/admin-system-command.routes.ts:33（GET/POST/PUT/DELETE 同）
  app.get('/v1/admin/system-commands', async (request, reply) => {
    await requireAdmin(permissionService, request);
  // admin/admin.routes.ts:30,38
  app.get('/v1/admin/analytics/summary', async (req, reply) => {
    await requireAdmin(deps.permissionService, req);
  ```
- **影响**：管理员可在角色权限页把 `user:write` / `session:read` 授予自定义角色，这些账号能通过路由守卫、菜单可见，但页面上**所有**请求返回 403「需要管理员权限」——系统指令页整页不可用，用量分析/运行监控只有报错和空表。与 20260830 报告 A2（定时任务页）同类，本次核实为另外三个页面的同类缺口。
- **建议**：三选一：① 后端将这批 `/v1/admin/*` 端点改为权限码校验（如新增 `admin:read`）并补迁移；② 前端将这三个路由/菜单改为 `adminOnly: true`（feishu-bots 已是此模式，可直接对齐）；③ 至少在页面捕获 403 时跳转 `/forbidden` 并提示原因，避免"看得见用不了"。

---

### 中

#### A21. RuntimeMonitorView 首次进入重复请求两次（onMounted 先消费 activatedOnce，onActivated 的"跳过首次"分支永不为真）

- **类别**：功能模块缺陷（重复请求）
- **位置**：`admin/src/views/runtime/RuntimeMonitorView.vue:229-243`
- **证据**：
  ```ts
  // keep-alive 下首次挂载 onMounted 与 onActivated 同时触发，跳过首次避免重复请求
  let activatedOnce = false
  onMounted(() => {
    if (!activatedOnce) { activatedOnce = true; applyRouteQuery(); fetchSessions() }
  })
  onActivated(() => {
    if (!activatedOnce) { activatedOnce = true; return }
    fetchSessions()
  })
  ```
- **影响**：keep-alive 下首次挂载钩子顺序为 onMounted → onActivated，进入 onActivated 时 `activatedOnce` 已被 onMounted 置 true，`if (!activatedOnce)` 恒为 false，于是首次进入连发 2 个相同的 `GET /admin/runtime/sessions`，注释意图完全落空。20260830 报告 A6 曾判定本页写法"是对的"，当前代码实际仍有此 bug。
- **建议**：为 onActivated 单独设标志：`let firstActivation = true; onActivated(() => { if (firstActivation) { firstActivation = false; return } fetchSessions() })`；或删掉 onMounted、把 `applyRouteQuery()` 挪进 onActivated。

#### A22. 系统设置页对 settings:read-only 角色展示全部可用的写控件（开关/编辑/保存/测试连接），点击必 403

- **类别**：功能模块缺陷（权限）
- **位置**：`admin/src/views/settings/SystemSettingsView.vue:53-95`；`admin/src/views/settings/components/IntegrationConfigPanel.vue:20-33`；后端 `backend-ts/src/settings/settings.routes.ts:35-52`（PUT batch / PUT :key / test/* 均要求 `settings:write`）
- **证据**（SystemSettingsView.vue:53-59,95；IntegrationConfigPanel.vue:26,32）：
  ```html
  <el-switch v-if="isBooleanSetting(row.settingKey)"
    :model-value="row.value === 'true'" :disabled="row.editable !== 1" ... />
  <el-button type="primary" link size="small" :disabled="row.editable !== 1" @click="handleEdit(row)">编辑</el-button>
  <!-- IntegrationConfigPanel：保存/测试连接无任何权限或 editable 判断 -->
  <el-button ... :loading="testing === group.name" @click="runTest(group)">测试连接</el-button>
  <el-button type="primary" size="small" :loading="savingKeys.has(group.name)" @click="saveGroup(group)">保存</el-button>
  ```
  后端：`settings.routes.ts:37,45,52` 三处 `await requirePermission(permissionService, userId, 'settings:write')`；`V093__settings_integration_config.sql:46-53` 仅把 `settings:read`+`settings:write` 同时授给管理员角色。
- **影响**：`settings:read` 与 `settings:write` 是独立权限码。只有 `settings:read` 的自定义角色能打开本页（路由 `permission: 'settings:read'`），但看到的所有开关、下拉、编辑/保存/测试按钮全部可用，任何保存或测试请求都 403。IntegrationConfigPanel 甚至没有 `row.editable` 判断（当前种子数据全为 editable=1 暂未触发，但防护缺失）。这是 20260830 A11（Model/User/Agent 已修 canWrite）在设置页的残留同类问题。
- **建议**：SystemSettingsView 计算 `canWrite = authStore.hasPermission('settings:write')`，据此禁用开关/下拉/编辑按钮并隐藏 IntegrationConfigPanel 的保存/测试按钮（以 prop 传入）。

#### A23. IntegrationConfigPanel 的「清空密钥」标志会被其他分组的保存静默清除，清空语义丢失

- **类别**：功能模块缺陷（数据语义）
- **位置**：`admin/src/views/settings/components/IntegrationConfigPanel.vue:248-251（clearSecret）、276-280（secret 分支判定）、298（成功后清空全部标志）`
- **证据**：
  ```ts
  function clearSecret(key: string) {
    model[key] = ''
    clearedSecrets.value = new Set([...clearedSecrets.value, key])
  }
  // saveGroup 内：
  return { key, value: clearedSecrets.value.has(key) ? '' : null }   // 278 行
  ...
  clearedSecrets.value = new Set()   // 298 行：任意分组保存成功即清空全部标志
  ```
- **影响**：在 LDAP 分组点「清空」但未保存 → 切到 OSS 分组保存成功 → `clearedSecrets` 被整体重置 → 回到 LDAP 点「保存」时提交 `null`（不修改）而非 `''`（清空）。输入框显示为空、看起来已清空，但服务端旧密码仍然生效——本意是清除凭据却静默未生效，属安全相关偏差。
- **建议**：保存成功后只移除**本组**已处理的 key（`for (const item of items) clearedSecrets.value.delete(item.key)`），不要 `new Set()` 全量重置；或把清空标志并入 per-group 状态。

#### A24. AuditLogView.showDetail 无 catch：详情接口失败时「请求失败」+「页面发生异常」双重误报

- **类别**：功能模块缺陷（错误处理）
- **位置**：`admin/src/views/audit/AuditLogView.vue:201-205`（模板调用 :67,:100）
- **证据**：
  ```ts
  async function showDetail(row: any) {
    const { data } = await api.get(`/audit/logs/${row.id}`)
    currentLog.value = data
    detailVisible.value = true
  }
  ```
- **影响**：模板事件处理器返回的 Promise 被 Vue 的 `callWithAsyncErrorHandling` 捕获并送入 `App.vue:11-19` 的 `onErrorCaptured`。请求失败时拦截器先 toast「请求失败」，随后再弹「页面发生异常，请刷新重试」，两条矛盾提示，且详情弹窗不打开。本页 `fetchLogs` 已有 catch+seq，唯独 `showDetail` 漏掉。
- **建议**：补 `try { ... } catch { /* 拦截器已提示 */ }`。

#### A25. 弹窗打开时选项接口无 catch：UserFormDialog.fetchRoles / AgentFormDialog.loadOptions(skill-docs) 失败 → 表单填充被跳过 + unhandled rejection

- **类别**：功能模块缺陷（错误处理）
- **位置**：`admin/src/views/user/UserFormDialog.vue:189-197`；`admin/src/views/agent/AgentFormDialog.vue:262-272`
- **证据**：
  ```ts
  // UserFormDialog.vue:189-197
  async function fetchRoles() {
    const { data } = await api.get('/roles')      // 无 try/catch
    roleOptions.value = data || []
  }
  watch(() => props.visible, async (val) => {
    if (!val) return
    await fetchRoles()                            // 失败则后续填充全部跳过
  // AgentFormDialog.vue:262-263
  async function loadOptions() {
    const { data } = await api.get('/skill-docs') // 无 try/catch（mcp 那段反而有）
  ```
- **影响**：`/roles` 或 `/skill-docs` 失败时 watch 回调中断：UserFormDialog 编辑态字段停留在上次值或空白、角色下拉为空；AgentFormDialog 的 Skills 下拉为空、表单不初始化。且 watch 回调中 await 之后的异常不会进入 `onErrorCaptured`，成为 unhandledrejection，用户只有一条拦截器 toast，表单却"坏了"没有解释。
- **建议**：两个函数内部 try/catch 并置空兜底（AgentFormDialog 对 `/mcp-servers/enabled` 的写法已是正确范例，保持一致）。

#### A26. SystemSettingsView 编辑弹窗保存失败仍关闭，输入内容丢失

- **类别**：交互逻辑
- **位置**：`admin/src/views/settings/SystemSettingsView.vue:290-308（persist 吞错）、310-317（saveSetting 无条件关闭）`
- **证据**：
  ```ts
  async function persist(row: any, value: string | null) {
    ...
    try { await api.put(...); ... }
    catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ }
    finally { saving.value = false }
  }
  async function saveSetting() {
    ...
    await persist(currentSetting.value, value)   // 失败也被吞掉
    dialogVisible.value = false                  // 无条件关闭
  }
  ```
- **影响**：保存失败（网络错误/403/后端校验）时只弹一条 toast，弹窗照常关闭，用户输入的配置值全部丢失，需重新打开重输；secret 项还可能让人误以为已保存。
- **建议**：`persist` 返回布尔，`if (await persist(...)) dialogVisible.value = false`，失败时保留弹窗与输入。

---

### 低

#### A27. 列表竞态防护残留缺口：AnalyticsView.fetchSummary 与 AgentListView.fetchAgents

- **类别**：功能模块缺陷（请求竞态）
- **位置**：`admin/src/views/analytics/AnalyticsView.vue:11,122-129`；`admin/src/views/agent/AgentListView.vue:25,130-139`
- **证据**：
  ```ts
  async function fetchSummary() {
    loading.value = true
    try {
      const { data } = await api.get('/admin/analytics/summary', { params: { days: days.value } })
      summary.value = data || {}            // 无 seq/AbortController
    } finally { loading.value = false }
  }
  ```
- **影响**：快速切换统计周期（7/30/90）或连点「查询」时，慢的旧响应后到会覆盖新结果；AnalyticsView 还会出现 loading 提前复位（先完成的请求把 v-loading 关掉）。User/Model/Audit/Runtime 列表均已加 seq 守卫，这两处是同类遗漏。
- **建议**：照 `fetchSessions`/`fetchUsers` 的 `seq` 模式补齐。

#### A28. 文本筛选框 clearable 但无 @clear，点 × 清空后不触发查询

- **类别**：交互逻辑
- **位置**：`admin/src/views/runtime/RuntimeMonitorView.vue:34`（关键词）；`admin/src/views/audit/AuditLogView.vue:32`（对象）
- **证据**：
  ```html
  <el-input v-model="filters.keyword" clearable placeholder="标题/摘要" style="width: 180px" @keyup.enter="handleSearch" />
  <el-input v-model="filters.objectType" clearable placeholder="users / agents" style="width: 160px" @keyup.enter="handleSearch" />
  ```
- **影响**：与 UserListView（`@clear="handleSearch"`）、ModelListView 的行为不一致。用户点 × 后以为已按空条件刷新列表，实际结果仍是旧过滤条件，需再点「查询」。
- **建议**：补 `@clear="handleSearch"`。

#### A29. 统计卡片纯 @click 无键盘可达性

- **类别**：交互逻辑（a11y）/ UI 样式
- **位置**：`admin/src/views/runtime/RuntimeMonitorView.vue:5-13`；`admin/src/views/analytics/AnalyticsView.vue:20`
- **证据**：
  ```html
  <el-card shadow="hover" class="clickable-card"
    :class="{ 'is-active': filters.phase === item.phase }"
    @click="selectPhase(item.phase)">
  <!-- AnalyticsView.vue:20 同型 @click="go(item.path)" -->
  ```
- **影响**：键盘用户无法通过 Tab 聚焦触发筛选/跳转；20260830 A19 只修了 Dashboard 卡片与 TabBar，这两页的同类卡片遗漏。
- **建议**：卡片加 `role="button" tabindex="0"` 并响应 `@keydown.enter/.space`。

#### A30. SystemSettingsView 每次激活重复拉取 agents/models

- **类别**：功能模块缺陷（性能/冗余请求）
- **位置**：`admin/src/views/settings/SystemSettingsView.vue:319-322（onActivated）`、`262-272（fetchSettings 内部 Promise.all 再拉一次）`
- **证据**：
  ```ts
  onActivated(async () => {
    await Promise.all([fetchAgents(), fetchModels()])   // 第 1 次
    await fetchSettings()
    // fetchSettings 内部：Promise.all([api.get('/system-settings'), fetchAgents(), fetchModels()]) 第 2 次
  })
  ```
- **影响**：每次进入/返回设置页共 5 个请求，其中 `/agents`、`/models/active` 各重复 1 次；保存配置后 `emit('saved') → fetchSettings` 又是一轮重复。
- **建议**：`fetchSettings` 不再内联拉 agents/models（保留独立刷新入口），或 onActivated 只调 `fetchSettings`。

#### A31. URL 类字段均无格式校验

- **类别**：功能模块缺陷（表单校验缺失）
- **位置**：`admin/src/views/model/ModelFormDialog.vue:48（baseUrl）、141-145（rules 无 baseUrl）`；`admin/src/views/settings/components/IntegrationConfigPanel.vue:147,164,183（ldap.url / feishu.redirectUri / upload.baseUrl 仅 placeholder/hint 提示）`
- **证据**：
  ```ts
  const rules = computed<FormRules>(() => ({
    name: [{ required: true, message: '请输入模型名称', trigger: 'blur' }],
    modelId: [{ required: true, message: '请输入模型标识', trigger: 'blur' }],
    apiKey: isEdit.value ? [] : [...],   // 无 baseUrl 规则
  }))
  ```
- **影响**：可保存 `abc`、`ftp://x` 等任意字符串作为 API 地址 / LDAP 服务地址 / OAuth 回调地址，问题要到调用或联调测试时才暴露（模型「测试」失败、飞书回调跳转失败），排障成本高。数值校验已补（saveGroup 有 min/max + el-input-number），URL 是剩余缺口。
- **建议**：`baseUrl` 加 `type: 'url'` 或 `pattern: /^https?:\/\//` 规则；IntegrationConfigPanel 对 URL 字段加 pattern 校验（ldap://|ldaps://、https?://）。

---


---

## 五、已排查确认不成立的疑点

以下疑点经源码逐行排查后**确认不成立或不构成问题**，列出以避免后续重复排查。各审查路（设置/任务/admin）的完整疑点清单附后。

**主审（chat 核心链路）排查结论：**

1. **`openWorkspace` 的 `window.open('file://...')` 兜底**（ChatInput.vue:1073）——该分支仅在非 Electron 且无 `openFolder` 时到达，浏览器/安卓 WebView 会拦截 https 页面对 `file://` 的打开请求，属无害死分支，未计入问题。
2. **`useVersionCheck` 的 `_androidDownloadUrl/_androidIsForced/_androidManifestVersionCode` 为函数作用域变量**——全仓仅 TopNav 一个调用方（grep 证实），多实例错位目前不会发生；如未来新增调用方需先把这三个变量提升为模块级，故只作提示不计问题。
3. **旧 D18（routeEvent terminal 分支死代码）**——当前 `routeEvent` 的 case 清单中已无任何 terminal 分支，随重构消失。
4. **旧 D19（uploadingFiles 死状态）**——已修：现为 `waitingForSave` prop 驱动保存态，`uploadingFiles` 已不存在。
5. **旧 D21（MessageBubble hover 硬编码黑）**——已修：hover 样式已全部走 `var(--aw-*)`/color-mix（新位置 TaskIndexPanel 见 D67）。
6. **旧 D14（Web/安卓外链无兜底）**——已修：`utils/capacitor.ts` 的 `openExternalUrl` 覆盖 Electron IPC / Capacitor Browser / window.open 三路径。
7. **SubagentChatPanel 全文件审查**——订阅/退订与 scroll/markdown 监听在 `onMounted/onUnmounted` 正确配对；`shouldPreserveLiveStream`/乐观消息判断自洽；`handleRetryExecution` 有 `retrying` 防重；未发现问题。模板中有未使用的 `.banner-label` 样式类（banner 实际未用该类），纯冗余 CSS，不计问题。

**desktop 设置路（399）排查结论：**



1. **Git 凭证列表「Token: {{ item.accessToken }}」疑似明文泄露** —— 后端 `toVO` 已掩码（`backend-ts/src/user/git-credential.routes.ts:38` 返回 `accessToken: '****'`），前端展示的是掩码值，非泄露。
2. **LoginView 密码登录双提交**（form submit + `@keyup.enter` 双触发 handleLogin）—— `passwordLoading` 守卫有效（validate 的微任务先于 keyup 宏任务完成），属项目此前已修复项。
3. **SessionSearchPopover 搜索竞态** —— 已有 `requestSeq` + `AbortController` + 300ms 防抖 + `onClosed`/`onUnmounted` 的 `invalidatePending()`，关闭/清空/卸载路径全覆盖，实现完备。
4. **SkillDrawer 技能详情 Markdown 注入** —— 详情经 `MarkdownContent` 渲染，项目已接入 dompurify。
5. **useVersionCheck Web/Electron 路径定时器/监听器泄漏** —— `startPolling/stopPolling`、`startAppUpdater/stopAppUpdater` 与 TopNav `onMounted/onUnmounted` 配对，`removeAppUpdaterListeners` 均被移除（缺口仅 D54 安卓路径）。
6. **McpServersView handleToggle / WeixinBotView handleVoiceReplyChange 失败不回滚本地状态** —— 两者失败路径均正确回滚（先存 `previous` / `voiceReply.value = !next`）。
7. **ProfileView 头像预览 objectURL 泄漏** —— 选图、移除、保存清理、`onBeforeUnmount` 四处路径均有 `revokeObjectURL`。
8. **抽屉/对话框安卓适配全面缺失** —— SkillDrawer、CommandDrawer 均带 `management-drawer`/`management-dialog` class，命中 `style.css` 的 `html.android-capacitor` 全局适配（缺口仅 D48 的 4 个 settings 弹窗）。
9. **直接裸调 window.electronAPI 无三端兜底** —— 范围内各调用点（LoginView、FeishuBotView、SkillDrawer、useVersionCheck）均使用可选链 + Web/安卓分支，未发现裸调。
10. **window.confirm/alert 与全局 ElMessageBox 风格割裂** —— 审查范围内未发现 `window.confirm/alert`；删除操作均有确认（el-popconfirm / 两步按钮确认 / ElMessageBox.confirm）。


1. **旧报告 D5**（`useCenterTabs` 已读 watch 注册在错误作用域）——已修：`useCenterTabs.ts:58-81` 现用模块级 `effectScope(true)` + `ensureSideTaskReadWatch()` 在 detached scope 注册，附有说明注释。
2. **旧报告 D8**（FileViewer 文本读取竞态）——已修：`FileViewer.vue` 已有 `loadFileSeq` / `isStaleLoad(seq)`，`readFile` 与 catch 分支均判 stale。
3. **旧报告 D22 之 `useTerminal` MutationObserver 叠加**——已修：`useTerminal.ts:71` 模块级 `themeObserver`，随 `listenersInitialized` 只创建一次；WebglAddon 也已加 `onContextLoss(() => webgl.dispose())`。
4. **旧报告 D22 之 Ctrl+` 快捷键作用域**——已修：TaskView.vue 两处注释说明已移至 TopNav 常驻注册。
5. **旧报告 D22 之 `usePanelLayout` 不响应窗口 resize**——已修：`usePanelLayout.ts:10-20` 已加 passive `resize` 监听并在跨移动断点时自动折叠右侧。
6. **旧报告 D11**（边路任务删除失败仍改本地状态 + `window.confirm`）——已修：现为 `ElMessageBox.confirm`，API 失败 `ElMessage.error` 后 `return`，不动本地。全范围已无 `window.confirm` 残留。
7. **`useGitStatus.ts` / `useGitRepos.ts` 竞态与 loading**——防护完整：均有 `requestSeq`，`finally` 内 `if (seq === requestSeq) loading = false`（旧请求被顶掉时由新请求负责复位，正确）；`load()` 的早退分支在 `loading = true` 之前，不会卡 loading；`useGitRepos` 的 provider watch 用 `flush: 'sync'` 先清空再刷新，catch 保留上次数据。**无需修改。**
8. **`PdfViewer.vue` 的 observer / pdfDoc 泄漏**——不成立：`onDeactivated`/`onUnmounted`/重载路径三处都 `observer?.disconnect()`、`resizeObserver?.disconnect()`、`cancelAllRenders()`、`pdfDoc?.destroy()` 并置 null；另有 `loadSeq`、`MAX_CANVAS_PIXELS` 限幅、`isEvalSupported: false`。`onActivated` 的 `hasLoadedOnce` 判断顺序正确（非 admin A6 式写反）。仅"逐页串行 `getPage` 预取尺寸"在千页 PDF 下偏慢，属可接受的低价值优化，未计入问题。
9. **`useForegroundRecovery.ts`**——逻辑与注释一致：`initialized` 单例、冷启动 3s 保护、10s 防抖，仅在 `readyState` 为 CLOSING/CLOSED 时刷新；`visibilitychange` 不移除符合模块级单例设计。**无缺陷。**
10. **`GitContextMenu.vue` / `FileTreeContextMenu.vue` 的 document click 监听**——均已在 `onUnmounted` 正确 `removeEventListener`；item click 冒泡导致的重复 `emit('hide')` 幂等无害。`adjustedX/Y` 的 watch 在 `!visible` 时早退，正确。
11. **git 破坏性操作缺确认**——范围内**不存在** discard/reset/checkout 入口：`GitContextMenu` 仅有复制绝对/相对路径、在 Finder 中打开、添加到聊天、下载文件。`TaskInspector.runGitOperation` 的 commit/pull/push 无二次确认属产品取舍，已并入 L5 而非单列。
12. **`CenterTabBar.vue` 触屏适配**——已有 `@media (max-width: 768px), (hover: none) { .tab-close { opacity: 1 } }`；`.tab-close:hover` 也有暗色覆盖。**无需修改。**
13. **`TodoChecklist.vue` 的 `--aw-accent-bg` / `--aw-accent-rgb` 未定义**——不成立：`desktop/src/style.css:52-54`（亮色）与 `228-230`（暗色）均已定义，fallback 分支不会生效。
14. **`AgentSelector.vue` 疑似死代码**——不成立：被 `components/chat/ChatInput.vue:5,221` 实际引用。其 `onMounted` 内 `fetchAgents()` 无 catch、硬编码 `rgba(0,102,204,0.08)`，量级低于上表各项，未计入名额。
15. **`TaskInspector.vue` 中 `watch(statusProviderRef, () => { gitFiles.value = [] })` 直接改 composable 内部 ref**——属封装度问题（composable 未暴露 `clearFiles()`），无功能缺陷，仅建议后续重构时收口。
16. **`CenterTabContainer.vue` 的 `<KeepAlive :max="20">` 关闭 Tab 不释放缓存实例**——确实存在（`closeTab` 只从 `state.tabs` 移除，KeepAlive 按 key 缓存，需 LRU 溢出才淘汰；`FileViewer` 的 key 含 `version`，重开同文件即新增 key，加速抖动），但旧报告 D16 已作为附带说明记录，按"已记录不重复报"原则未单列；若要修，建议 `closeTab` 时通过 `KeepAlive` 的 `:exclude` 动态排除已关闭 key 以触发销毁。
17. **`FileDiffViewer.vue` 的 deep watch 无 generation 守卫**——理论竞态：`syncViewer` 内 `await loadMonaco()`，同一 tab 内 `openDiffTab` 就地更新 `existing.fileChange` 会重触发 deep watch，两次调用可能都走到 `monaco.editor.createModel` 并互相 dispose 共享的模块级 `originalModel`。但组件由 `:key="activeTabId"` 控制、切 tab 即重建，实际触发窗口极窄，且无线上现象佐证，按"宁少勿滥"未列入正式问题；建议加一个 `let syncGen = 0` 守卫作为防御性改动。


1. **模型 API Key 掩码回填覆盖密钥**：`model.routes.ts:146-159` `toVO(entity, revealApiKey)`，编辑/复制弹窗仅在 `canWrite(model:write)` 下打开（此时 revealApiKey 为真返回明文），预填真实 key，不会把 `****abcd` 存回。
2. **IntegrationConfigPanel 数值校验缺失（20260830 A12 数值半边）**：已修——`saveGroup`（:265-274）有 min/max 校验 + `el-input-number`，不再报。
3. **20260830 已修项不复报**：404 兜底与守卫死循环（A4/A14，router 已区分 401/403 与网络错误分支）、keep-alive 无上限（A5，Layout 已 `:max="8"`）、tabs store `useRouter`（A15，已改 router 单例导入）、Agent 删除末页空白 + computed 副作用（A10，已有 maxPage 回退）、Model/User/Agent 操作列权限（A11，均已 `canWrite`）、RolePermission 脏切换覆盖（A13，已有 `confirmDiscardUnsaved` + `highlight-current-row`）、用户状态筛选（A18，已 `@change`）、TabBar 键盘关闭（A19，已 role/tabindex/keydown）。
4. **api/index.ts 401 并发刷新**：`refreshing ?? refreshAccessToken()` 单飞 + `_retried` 防循环 + 刷新失败 `forceLogout` 后仍 `Promise.reject`，不存在 desktop D4 式永久挂起路径。
5. **clearSecret 后输入新值**：`saveGroup:277` `raw !== ''` 优先返回新值，"输入新值自动覆盖清空标记"的注释语义成立。
6. **IntegrationConfigPanel 未保存编辑被父页重拉冲掉**：`syncFromRows` 只填 `undefined` 键，onActivated 重拉后未保存编辑可存活。
7. **Analytics 卡片跳 `/runtime?phase=x` 失效**：Layout keep-alive 按 `fullPath` 区分实例，新 query 会重新挂载并 `applyRouteQuery`，功能不失效（副作用仅是 TabBar 可能出现两个"运行监控"标签，轻微体验问题，未列为缺陷）。
8. **Skills 页上传/删除对 agent:read 用户可用**：后端 `/v1/skill-docs/upload|delete` 仅 `requireUserId`（skill.routes.ts:67-84），前端路由/菜单一致用 `agent:read`，无"点按钮必 403"问题；反向的后端权限缺口（任意登录用户可改全局 Skill；同理 `/v1/audit/logs`、`GET /v1/roles` 亦仅登录校验、无权限码）属后端问题，建议后端补齐。
9. **定时器/监听器泄漏**：范围内仅 SystemSettingsView 的 IntersectionObserver 一处监听，`onBeforeUnmount` 已 disconnect；keep-alive 停用期间元素脱离文档不触发回调，LRU 驱逐时正常清理。useBreakpoint 的 matchMedia 有引用计数清理。
10. **删除无确认/双提交**：所有删除均有 popconfirm 或 ElMessageBox；全部提交入口有 `submitting`/`saving`/`loadingDetail`/`testingId`/`savingKeys` 防重守卫。
11. **分页边界**：AgentListView 删除末页回退已实现且 `total` 无 computed 副作用；ModelListView 同；User/Audit 为服务端分页只读列表无删除入口。
12. **RuntimeMonitorView 移动端 media query 强制 metric 卡 50% 与 `:xs="24"` 冲突**：视觉为两列卡片布局，疑似有意设计，未列为缺陷。
13. **弹窗双 emit（ResponsiveDialog `@close` + `update:model-value`）**：幂等，无副作用。

**desktop 任务路（401）排查结论：**

**admin 路（400）排查结论：**

---

## 六、修复优先级建议

1. **P0（尽快修，6 条高）**：
   - A20 权限门禁不一致——涉及三整页不可用 + 权限模型口径，需前后端对齐（建议方案②前端 adminOnly 或方案①后端权限码化）。
   - D41/D42 双提交——用户可自造重复数据（重复凭证/重复指令），修复成本一个 ref。
   - D55/D56/D57 文件树三连——同一模块（useFileBrowser + FileTree）一次性修：竞态 seq + electronAPI 守卫 + 筛选防抖，避免三次回归。
2. **P1（安全与状态一致性，中）**：D23（WS token 改首帧鉴权，需后端配合）、D24+D27（停止/重试可靠送达与状态回执）、A23（清空密钥语义）、D46（微信假成功）、D47（登录轮询失控跳转）、A21/A22（admin 权限与重复请求）、D45（弹窗关闭停轮询）、D43/D44/D48/D58-D65 按模块顺带修。
3. **P2（低，批量清理）**：UI token 化（D31/D32/D38/D49/D50/D67）可一次 PR 统一替换；交互细节（D28/D30/D33/D34/D40/D51/D52/D60/D70）按触点顺手修；性能项（D69）在会话量上千前不紧迫。
4. **建议的模块化修复顺序**：useFileBrowser/FileTree（D55-D57）→ 设置类双提交与弹窗（D41/D42/D48）→ WS 可靠性（D23/D24/D27）→ admin 权限（A20-A22）→ 其余按 P2 批量。
