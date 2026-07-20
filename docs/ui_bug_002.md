# 前端问题排查报告（第二轮）

> 范围：`admin/`（Vue 3 + Element Plus 管理后台）与 `desktop/`（Electron + Vue 3 桌面客户端）。
> 方法：结合人工逐文件阅读源码 + 两个专项排查 Agent（分别针对 admin、desktop）的交叉验证，关键结论均已回查代码确认行号与逻辑。
> 去重说明：已排除 `docs/admin-frontend-issues.md` 中记录过的 32 项（含已修复与待修复）；桌面端已排除 `docs/desktop-layout-reflection.md` 中讨论的宏观布局/信息架构类论点，只收录**具体、可定位到代码**的功能/交互/UI/样式问题。
> 本文档仅记录问题，**本次不修改代码**。

---

## 一、桌面客户端（`desktop/`）

### 高优先级（可导致任务卡死、数据丢失或误判为成功）

#### 1. 边路任务（Side Task）工具审批 UI 完全不可见，Agent 会一直卡住
- **文件**：`desktop/src/components/chat/ChatPanel.vue`、`SideChatPanel.vue`、`desktop/src/components/center/CenterTabContainer.vue`
- **类型**：功能
- **描述**：`useChat` 中的审批队列 `pendingApprovals` 是全局的，但审批面板 `<ApprovalStack>` 只挂载在 `ChatPanel.vue` 里，且做了会话过滤：

```267:269:desktop/src/components/chat/ChatPanel.vue
const activePendingApprovals = computed(() =>
  pendingApprovals.value.filter(a => !a.sessionId || a.sessionId === sessionStore.activeSessionId)
)
```

  切到「边路任务」标签页时 `ChatPanel` 被卸载/隐藏，`SideChatPanel.vue` 又没有接入 `ApprovalStack`。一旦边路任务在 LOCAL 模式下触发需要审批的工具调用（shell/write_file/edit_file），用户在任何界面都点不到「执行/拒绝」按钮，该边路任务会永久挂起。

#### 2. 清空审批队列时未回传 Electron，主进程 Promise 永久挂起
- **文件**：`desktop/src/composables/useChat.ts`、`desktop/electron/main.cjs`
- **类型**：功能
- **描述**：`newSession()` / `cleanup()` 调用 `clearPendingApprovals()` 时只清空前端数组：

```852:857:desktop/src/composables/useChat.ts
function clearPendingApprovals() {
  for (const item of pendingApprovals.value) {
    if (item.sessionId) sessionStore.decrementPendingApproval(item.sessionId)
  }
  pendingApprovals.value = []
}
```

  但从未调用 IPC 把「已取消」回传给主进程。而 `main.cjs` 的 `requestToolApproval` 是**无超时**的裸 `Promise`：

```537:541:desktop/electron/main.cjs
function requestToolApproval(toolName, description, sessionId, dangerReason) {
  return new Promise((resolve) => {
    const requestId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    pendingApprovals.set(requestId, (approved) => {
```

  只有 renderer 端主动回传审批结果才会 `resolve`。用户在等待审批期间切换/关闭会话，会导致该次工具执行在 Electron 主进程里**永久阻塞**，占用的本地 shell/文件句柄不会释放，需重启应用才能恢复。

#### 3. WebSocket 重连只重新订阅主会话，边路任务的流式事件会丢失
- **文件**：`desktop/src/composables/useStreamWS.ts`
- **类型**：功能
- **描述**：断线重连后的 `onopen` 只对 `activeSessionId` 发起 `subscribe`：

```138:143:desktop/src/composables/useStreamWS.ts
if (sessionStore.activeSessionId) {
  const sid = sessionStore.activeSessionId
  send({ type: 'subscribe', sessionId: Number(sid) })
  refreshQueue(sid)
}
```

  边路会话只在 `side_session_created` 时订阅过一次，重连逻辑里没有对所有打开中的边路 session 重新订阅。网络抖动重连后，边路任务标签页会表现为「一直在执行中」的假死状态，`content_delta`/`tool_call_*`/`session_status` 都不会再到达。

#### 4. `connect()` 未被 try/catch 保护，连接失败后发送按钮永久锁死
- **文件**：`desktop/src/composables/useChat.ts`
- **类型**：功能 / 交互
- **描述**：`sendMessageAndWaitForSave` 先把 `sending.value = true`，然后 `await connect()` 才进入 `try`：

```428:445:desktop/src/composables/useChat.ts
sending.value = true
// ...
const imageUrls = await uploadImages(files || [])
await connect()   // 若 reject，下面的 catch 根本进不去
try {
```

  若此时没有登录态或 WebSocket 首次连接失败，`connect()` 抛出的异常不会被任何 catch 捕获，`sending` 永远停在 `true`。表现为：发送按钮持续显示「停止」态，输入框被锁死，用户只能重启应用。

#### 5. 边路任务发送消息时完全忽略图片附件
- **文件**：`desktop/src/components/chat/SideChatPanel.vue`
- **类型**：功能
- **描述**：

```310:319:desktop/src/components/chat/SideChatPanel.vue
async function handleChatSend(text: string, _files: File[]) {
  if (!text.trim()) return
  // ...
  enqueueMessage(String(realSessionId.value), text.trim(), generateUUID(), [])
```

  形参 `_files` 从未被使用，无论用户在边路输入框里粘贴/选择了多少图片，入队与发送时都传空数组。UI 上图片预览正常显示，但实际不会上传也不会随消息发出，用户会误以为图片已经发给 Agent。

### 中优先级

#### 6. `ApprovalStack` 接收但从不展示 `dangerReason`，审批决策缺少关键上下文
- **文件**：`desktop/src/components/chat/ApprovalStack.vue`、`useChat.ts`、`useStreamWS.ts`
- **类型**：功能 / UI
- **描述**：后端 → WebSocket(`tool_execute`) → Electron IPC → `useChat.ts` 全链路都传递了 `dangerReason` 字段，`ApprovalStack.vue` 的 `ApprovalItem` 接口里也声明了该字段，但模板只渲染 `titleMap[item.toolName]` 与 `description`，`dangerReason` 从未被读取或展示。用户在批准一次「危险」操作时，完全看不到后端标注的危险原因说明。

#### 7. 边路任务「等待保存」超时后仍清空输入，与主会话逻辑不一致
- **文件**：`desktop/src/components/chat/SideChatPanel.vue`（对比 `ChatPanel.vue`）
- **类型**：交互
- **描述**：

```395:412:desktop/src/components/chat/SideChatPanel.vue
const finishWaiting = () => {
  // ...
  waitingForSave.value = false
  chatInputRef.value?.clearInput()
}
saveTimeoutId = setTimeout(finishWaiting, 5000)
```

  无论 5 秒超时还是保存成功，都会清空输入框；主会话（`ChatPanel.vue`）只有在收到 `saved === true` 时才清空。弱网或后端未及时回 `user_message_saved` 事件时，边路任务会把用户还没发送成功的草稿直接清掉，且用户无法区分「已发送」还是「丢失」。

#### 8. 等待消息保存超时后被当作发送成功
- **文件**：`desktop/src/composables/useChat.ts`、`ChatPanel.vue`
- **类型**：功能 / 交互
- **描述**：`sendMessageAndWaitForSave` 中等待 `onMessageSaved` 回调的 Promise 在 5 秒后会**无条件 resolve**，函数仍返回 `true`，父组件据此清空输入框、切换 UI 状态。如果消息实际没有落库成功（例如后端阻塞或断连），用户界面依然会表现为「发送成功」。

#### 9. 「关闭所有文件」菜单项实际会一并关闭边路任务标签页，文案与行为不符
- **文件**：`desktop/src/composables/useCenterTabs.ts`、`CenterTabBar.vue`
- **类型**：功能 / 交互
- **描述**：右键菜单文案是「关闭所有文件」，但实现是：

```197:201:desktop/src/composables/useCenterTabs.ts
function closeAllFileTabs() {
  const state = getSessionState()
  state.tabs = []
  state.activeTabId = 'chat'
}
```

  `side_task` / `diff` / `file` 类型的标签会被一起清空，且直接置空 `tabs` 数组，没有走 `closeTab` 应有的收尾（如 `markSideTaskClosed`）。用户点击「关闭所有**文件**」，结果连正在进行的边路任务标签也被强制关闭，超出预期。

#### 10. Tab 状态变更部分路径缺少 `notifyTabsChanged()` 调用，可能导致标签列表不同步
- **文件**：`desktop/src/composables/useCenterTabs.ts`
- **类型**：功能 / UI
- **描述**：代码注释里已经写明「Map 内部对象变更不会自动触发 computed，需要替换 Map 引用后调用 `notifyTabsChanged()`」，但 `openFileTab` 的新建分支、`activateTab`、`closeAllFileTabs`、`closeOtherTabs` 均未调用该方法，而 `openDiffTab`/`openSideTaskTab`/`closeTab` 会调用。在依赖 Map 引用刷新触发响应式更新的场景下，会出现标签列表或激活态不刷新的情况。

#### 11. `ChatInput` 的 `disabled` prop 未生效；resize 拖拽手柄是纯装饰
- **文件**：`desktop/src/components/chat/ChatInput.vue`
- **类型**：功能 / UI
- **描述**：组件声明了 `disabled` prop，但 `canSend`、TipTap 编辑器配置、发送逻辑均未读取该值，外部无法真正禁用输入框。另外输入框右下角的 `.resize-handle` 元素带有 `title="拖拽调整大小"` 样式提示，却没有绑定任何 `mousedown`/拖拽处理逻辑（对比 `TaskInspector.vue`、`TerminalPanel.vue` 均有完整的 resize 实现），属于「看起来能拖但拖不动」的误导性 UI。

#### 12. 发送消息未检测中文输入法组合状态，可能误触发发送
- **文件**：`desktop/src/components/chat/ChatInput.vue`
- **类型**：功能 / 交互
- **描述**：`handleKeyDown` 中判断发送的条件仅为：

```664:670:desktop/src/components/chat/ChatInput.vue
if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
  if (isTouchDevice) return false
  event.preventDefault()
  handleSend()
  return true
}
```

  没有检查 `event.isComposing`（或 `keyCode === 229`）。使用拼音/日文等输入法时，用户按 Enter 确认候选字/候选词，也会被当作「发送」处理，导致消息在还没打完时被提前发出。这是聊天类产品常见但容易被忽略的输入法兼容问题。

#### 13. 复制按钮无成功/失败反馈，且未处理 clipboard 异常
- **文件**：`desktop/src/components/chat/ApprovalStack.vue`（`copyText`）、`desktop/src/components/chat/ToolCallCard.vue`（`copyText`）
- **类型**：交互
- **描述**：两处 `copyText` 均直接 `navigator.clipboard.writeText(text)`，既没有成功时的 Toast 提示（“已复制”），也没有 `.catch` 处理。在非安全上下文（如非 HTTPS/非 localhost）或用户拒绝剪贴板权限时，该调用会静默 reject，用户点击「复制」后不会有任何反馈，也不知道操作是否失败。

#### 14. 桌面端 `FileChangePanel` 文件变更类型映射不全，且与管理后台的同类修复不一致
- **文件**：`desktop/src/components/chat/FileChangePanel.vue`、`desktop/src/types/chat.ts`
- **类型**：功能 / UI
- **描述**：`admin-frontend-issues.md` 的 #31 记录了管理后台曾修复「文件变更类型映射不全」问题，把 `FileChangeType` 扩展为 `'CREATED' | 'MODIFIED' | 'DELETED' | 'RENAMED' | 'COPIED' | string`，并补齐了对应的标签与配色。但桌面端类型定义仍停留在修复前的状态：

```17:22:desktop/src/types/chat.ts
export interface FileChange {
  path: string
  type: 'CREATED' | 'MODIFIED'
  ...
```

  模板中也只有二元判断 `change.type === 'CREATED' ? '新建' : '修改'`，CSS 只定义了 `.created`/`.modified` 两种配色（`#2d8a2d`/`#b87a00`，且未做暗色模式适配）。后端 `message_file_change.change_type` 字段是自由字符串，一旦后续新增删除/重命名类工具（当前 harness 的 `write_file`/`edit_file` 尚未覆盖，但设计上是可扩展的），桌面端会把这些变更全部误标为「修改」，与管理后台的展示不一致。

#### 15. 桌面端多个组件是完全未被引用的死代码
- **文件**：`desktop/src/components/chat/WorkspaceBar.vue`、`desktop/src/components/task/NewTaskDialog.vue`、`desktop/src/components/task/ProgressChecklist.vue`、`desktop/src/components/task/TaskHeader.vue`、`desktop/src/components/task/ActivityFeed.vue`（及其唯一使用者 `ActivityLine.vue`）
- **类型**：代码质量
- **描述**：经全仓 `grep` 确认，以上组件在 `desktop/src` 中没有任何 `import`/模板引用（`ActivityFeed.vue` 本身也未被任何页面引用，其内部使用的 `ActivityLine.vue` 因此也一并成为死代码）。这些应是历史迭代（如「进度清单」「新任务弹窗」旧版实现）留下的残留文件，建议清理，避免误导后续开发者认为它们仍在生效。

#### 16. 「立即删除」队列消息没有二次确认
- **文件**：`desktop/src/components/chat/QueuePanel.vue`
- **类型**：交互
- **描述**：待发送消息队列的删除按钮 `@click="emit('delete', msg.id)"` 直接触发删除，没有 `ElMessageBox.confirm` 之类的二次确认，也没有撤销机制。用户在队列中手滑点错「删除」（尤其与旁边的「上移/下移/立即发送」按钮距离很近）会直接丢失一条排队消息。

### 低优先级 / 补充问题

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| 17 | 右键菜单未做边界检测 | `CenterTabBar.vue` | `contextMenu.x/y` 直接取 `e.clientX/clientY`，靠近窗口右侧右键会导致菜单超出可视区域被裁切 |
| 18 | 非文件类标签标题过长无 tooltip | `CenterTabBar.vue` | `<el-tooltip>` 仅在 `tab.filePath` 存在时渲染，对话/边路任务/无 filePath 的 diff 标签超长截断后无法查看完整标题 |
| 19 | 问题面板「其他」输入框不支持 Enter 提交 | `QuestionPanel.vue` | `other-field` 没有绑定 `@keyup.enter`，必须用鼠标点击「确定/提交」按钮，键盘操作路径不完整 |
| 20 | 用户长消息折叠仅按换行数判断 | `MessageBubble.vue` | `isUserLong` 只看 `\n` 数量 `> 10`；单段超长无换行文本不会触发「展开全部」，气泡会被异常拉高，而多行但每行很短的文本却会被强制折叠 |
| 21 | 图片预览 ObjectURL 组件销毁时未统一释放 | `ChatInput.vue` | `removeFile`/`clearInput` 会 `revokeObjectURL`，但 `onBeforeUnmount` 里没有对 `filePreviewUrls` 做统一清理，组件在还有未移除文件时被销毁会造成内存泄漏风险 |

---

## 二、管理后台（`admin/`）

### 高优先级

#### 1. Agent 列表按标签筛选后，翻页可能显示空白（前端分页越界）
- **文件**：`admin/src/views/agent/AgentListView.vue`
- **类型**：功能
- **描述**：`filteredAgents` 在标签筛选后于前端做 `slice` 分页：

```128:135:admin/src/views/agent/AgentListView.vue
const filteredAgents = computed(() => {
  const list = tagFilter.value
    ? allAgents.value.filter(agent => (agent.tags || []).includes(tagFilter.value))
    : allAgents.value
  total.value = list.length
  const start = (currentPage.value - 1) * pageSize.value
  return list.slice(start, start + pageSize.value)
})
```

  但切换「标签」下拉框（`el-select` 未绑定 `@change`）时并不会把 `currentPage` 重置为 1。若当前停在第 3 页，切换到一个结果只有 1 页的标签，`slice` 起点越过数组长度，表格直接渲染为空，而分页组件显示的 `total` 已经变小，用户会误以为「该标签下没有 Agent」。

#### 2. 会话详情会静默丢弃「无前置 user 消息」的 assistant 消息
- **文件**：`admin/src/views/session/SessionDetailView.vue`
- **类型**：功能
- **描述**：消息分轮逻辑只在遇到 `role === 'user'` 时才开启新的一轮（`currentTurn`），随后才会把 `assistant` 消息挂到 `currentTurn` 上。如果消息序列以 `assistant`/`system` 开头，或者存在不紧跟在某个 user 消息之后的孤立 assistant 消息（例如系统自动触发的继续执行），这些消息会因为 `currentTurn` 为空而被整段跳过，不会渲染。管理员在会话详情页排查问题时，可能看不到完整的回复内容和工具调用过程，影响故障定位。

### 中优先级

#### 3. `hide-on-mobile` 用在 `el-table-column` 的 `class` 上不生效
- **文件**：`admin/src/views/agent/AgentListView.vue`、`ModelListView.vue`、`SkillListView.vue`、`RuntimeMonitorView.vue`；样式定义在 `admin/src/styles/responsive.css`
- **类型**：UI / 样式
- **描述**：多处代码写的是 `<el-table-column class="hide-on-mobile" />`。Element Plus 的表格列要隐藏表头/单元格应使用 `class-name`（和 `label-class-name`）属性，普通的 `class` 不会被透传到渲染出的 `<th>`/`<td>` 上。也就是说 `.hide-on-mobile { display: none }` 这条规则实际匹配不到任何真实 DOM 节点，窄屏下这些「本该隐藏」的列依然会挤在表格里——这是一个属性用法层面的 bug，而不是需要真机验证的体验优化项。

#### 4. 会话详情页在 keep-alive 下不会随会话状态变化刷新
- **文件**：`admin/src/views/session/SessionDetailView.vue`、`admin/src/components/Layout.vue`
- **类型**：功能 / 交互
- **描述**：`Layout.vue` 对所有子路由做了 `<keep-alive>`，但 `SessionDetailView` 只在 `onMounted` 里拉取数据，既没有 `onActivated` 钩子，也没有 `watch(() => route.params.id)`。列表页的同类问题（`admin-frontend-issues.md` #21）已经用 `onActivated` 修复，但详情页没有跟进：从标签栏切走再切回同一个会话详情时，看到的仍是缓存的旧快照，会话的最新阶段/消息不会更新。

#### 5. Skill 列表「状态」列恒为「可用」，与「校验」列结论矛盾
- **文件**：`admin/src/views/skill/SkillListView.vue`
- **类型**：功能 / 文案
- **描述**：列表中「校验」列会依据是否存在 `filePath`/`folderPath` 判断并可能显示「异常」，但「状态」列的模板是写死的 `<el-tag type="success">可用</el-tag>`，完全不读取行数据。同一行技能可能「校验」列显示异常、「状态」列却显示可用，两列信息互相矛盾，容易误导运维人员。

#### 6. 登录页无法通过键盘 Enter 提交
- **文件**：`admin/src/views/auth/LoginView.vue`
- **类型**：交互 / 可用性
- **描述**：表单绑定了 `<el-form :model="form" @submit.prevent="handleLogin">`，但登录按钮没有设置 `native-type="submit"`（`el-button` 默认渲染为 `type="button"`），密码输入框也没有单独绑定 `@keyup.enter`。由于表单内没有真正的 submit 触发源，且有两个文本输入框（用户名+密码），浏览器不会在按 Enter 时自动提交表单，`@submit.prevent` 处理函数实际永远不会被触发。用户在密码框按 Enter 期望登录，没有任何反应，只能改用鼠标点击「登录」按钮。

#### 7. 前端完全没有基于权限的菜单/路由控制
- **文件**：`admin/src/components/SideMenu.vue`、`admin/src/stores/auth.ts`、`admin/src/router/index.ts`
- **类型**：功能 / 权限
- **描述**：`UserInfoVO` 及 auth store 里都没有权限/角色字段，侧边栏菜单是写死的全量菜单项，路由守卫也只检查是否携带 token，不检查具体权限。后端已经有完善的角色-权限体系（`RolePermissionView.vue` 可分配权限），但前端没有对接：低权限用户依然能在侧边栏看到所有功能入口，点进去才会被后端 403 拦截，体验割裂，也与「角色权限管理」这个功能本身的价值相悖。

#### 8. 系统设置里的布尔类配置用纯文本输入框编辑，容易填入非法值
- **文件**：`admin/src/views/settings/SystemSettingsView.vue`
- **类型**：交互 / UI
- **描述**：列表展示时，`settingKey` 以 `enabled` 结尾的配置项会用 `el-tag` 显示「已启用/未启用」（基于 `value === 'true'` 判断），但点击「编辑」进入弹窗后，除了两个下拉选择的特例（`weixin.agentId`/`weixin.modelId`）之外，其余全部走 `<el-input v-model="settingValue" />` 纯文本输入。管理员很容易填成 `True`/`1`/`yes` 等非严格的 `'true'`/`'false'` 字符串，保存后列表页的「已启用/未启用」判断逻辑就会失效，且没有任何提示告诉用户「这里必须填 true 或 false」。

#### 9. 保存配置/发布通知/保存角色权限均无 loading 态，可重复点击触发多次请求
- **文件**：`SystemSettingsView.vue`（`saveSetting`）、`NotificationListView.vue`（`saveNotification`）、`RolePermissionView.vue`（`saveRole`/`savePermissions`）
- **类型**：功能 / 交互
- **描述**：这几处保存类操作的按钮都没有绑定 `:loading` 状态，函数体里也没有防重复提交的标志位。网络较慢时用户快速多次点击「保存/发布」，会连续发出多个相同的写请求；发布通知场景下甚至可能因此创建出多条重复通知。

#### 10. 发布通知 / 新建角色表单没有任何必填校验
- **文件**：`NotificationListView.vue`、`RolePermissionView.vue`
- **类型**：功能
- **描述**：「发布通知」弹窗的标题、内容输入框都是裸的 `el-input`，没有配 `el-form` 的 `rules`；「新建/编辑角色」弹窗的名称、编码同样没有校验规则。两处点击保存都会直接 `api.post`/`api.put`，可以提交标题为空的通知、名称/编码为空的角色，产生脏数据。

#### 11. 审计日志 / 通知管理的筛选下拉框缺少「选即查」，与其他已修复列表页交互不一致
- **文件**：`admin/src/views/audit/AuditLogView.vue`（“动作”“结果”两个 `el-select`）、`admin/src/views/notification/NotificationListView.vue`（“类型”“状态”两个 `el-select`）
- **类型**：交互
- **描述**：`admin-frontend-issues.md` 的 #10 已经把 `ModelListView.vue` 里的下拉筛选统一加上了 `@change="handleSearch"`（选即查），但这次排查发现 `AuditLogView` 和 `NotificationListView` 的下拉筛选并没有同步跟进——选择「动作」或「结果」后表格不会自动刷新，必须再点一次「查询」按钮，和用户在其他列表页养成的「选完即生效」习惯不一致。同类问题在 `RuntimeMonitorView.vue` 的关键词搜索框上也存在（缺少 `@keyup.enter`）。

### 低优先级 / 补充问题

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| 12 | 模型「测试」按钮无 per-row loading | `ModelListView.vue` | `handleTest` 没有针对单行的 loading 状态，可以对同一行连续点击「测试」并发出多个连通性测试请求，且用户看不出请求是否还在进行 |
| 13 | Agent/Model 表单弹窗未使用 `ResponsiveDialog` | `AgentFormDialog.vue`（760px）、`ModelFormDialog.vue`（580px） | 用户/角色/通知等表单已统一改用 `ResponsiveDialog`（窄屏自适应/可全屏），这两个表单仍是裸 `el-dialog` 固定宽度，移动端长表单的滚动与操作体验明显落后于其他弹窗 |
| 14 | 会话管理页顶部指标卡窄屏未适配 | `SessionListView.vue` | 四个 `el-col :span="6"` 的统计卡没有 `@media` 响应式规则；同结构的 `DashboardView.vue`/`RuntimeMonitorView.vue` 已经在窄屏下改为两列布局，这里没有跟进 |
| 15 | 多个列表桌面端缺少空态 | `AgentListView.vue`/`ModelListView.vue`/`NotificationListView.vue`/`SkillListView.vue`/`AnalyticsView.vue` 等 | 目前只有 User/Session/Audit 的移动端卡片视图配了 `el-empty`，桌面端表格无数据时只剩表头，没有任何空态提示 |
| 16 | 通知类型展示为英文枚举值 | `NotificationListView.vue` | 表格与筛选框里的 `SYSTEM`/`TASK`/`MODEL` 直接原文展示，没有对应的中文标签，普通管理员不易理解 |
| 17 | 标签栏无键盘/无障碍支持 | `admin/src/components/TabBar.vue` | 标签项用 `div` + `click` 实现，没有 `role="tab"`、没有方向键切换、没有 `Ctrl+W` 类关闭快捷键 |
| 18 | 未被引用的死代码组件 | `admin/src/views/session/components/MessageItem.vue` | 全仓搜索无任何 `import`/模板引用，属于历史迭代遗留，建议随手清理 |

---

## 三、总结与建议

**问题总量**：桌面端 21 项（5 高 + 11 中 + 5 低），管理后台 18 项（2 高 + 9 中 + 7 低），合计 **39 项新发现问题**，均为本轮排查、`admin-frontend-issues.md` 未记录过的问题。

**建议的修复优先级**：

1. **P0（会导致任务卡死/数据丢失，建议最先修）**：桌面端 #1～#5（边路任务审批不可见、审批 Promise 永久挂起、边路 WS 重连丢事件、connect 失败锁死发送、边路发图片被吞）。这五项直接影响「边路任务（Side Task）」这个核心功能的可用性，且用户几乎无法自行恢复，只能重启应用。
2. **P1（数据展示错误/权限体系不完整，建议尽快修）**：管理后台 #1、#2（分页越界、消息丢失）以及 #6、#7（登录 Enter 失效、前端无权限控制）。
3. **P2（一致性与体验类，可按排期修复）**：其余中优先级问题，多为「同类问题在一处修了、另一处忘了同步」（如桌面端 `FileChangePanel` 类型映射、管理后台的筛选选即查、保存按钮 loading 态等），建议在下次统一走查时批量对齐。
4. **P3（低优先级）**：附录表格中的死代码清理、a11y、空态补齐等，可作为日常技术债处理，不阻塞功能验收。
