# 前端问题审查报告（admin + desktop）

- 审查时间：2026-09-22
- 审查范围：`admin/src/`（管理后台）、`desktop/src/`（桌面 / Web / 安卓共用 UI）
- 审查维度：功能模块、UI 样式、交互逻辑
- 方法：按聊天、任务/文件/终端、设置页、管理后台列表分头读源码，再逐条回读调用方与相邻实现。本文只收录已对上源码的问题。
- 与历史文档的关系：避开 `2026-09-21-frontend-review-01.md` 已记录、且当前代码仍按原样存在的条目。该文档里「审批发送失败后卡片消失且无法重试」已有恢复逻辑，本文记的是恢复之后按钮仍锁死这一条新缺口。

## 严重度汇总

| # | 端 | 问题 | 类别 | 严重度 | 位置 |
|---|---|---|---|:---:|---|
| 1 | desktop | 审批发送失败后卡片回来了，但按钮永久禁用 | 功能 | 高 | `ApprovalStack.vue:43-49,87-94` + `useChat.ts:66-87` |
| 2 | desktop | 已绑定飞书时点「重新绑定」，约 2 秒就误报成功 | 功能 | 高 | `views/settings/FeishuBotView.vue:126-145` |
| 3 | desktop | 任务列表重命名点「取消」仍会保存 | 交互 | 高 | `components/task/TaskIndexPanel.vue:130,1057-1078` |
| 4 | admin | 只有 `model:read` 时，登录和「返回首页」在无权限页之间打转 | 功能 | 高 | `router/index.ts:6-12,32,179-181` |
| 5 | desktop | 保存尚未完成时切走再切回，输入框不清空，容易再发一次 | 功能 | 中高 | `components/chat/ChatPanel.vue:639-645,688-697` |
| 6 | admin | 用户「账号类型」只滤当前页，移动端卡片完全不滤 | 功能 | 中高 | `views/user/UserListView.vue:80,157,317-321` |
| 7 | admin | 会话列表的 URL 筛选在 keep-alive 下对不上 | 功能 | 中 | `views/session/SessionListView.vue:199-207,342-348` |
| 8 | desktop | 队列「编辑」在删除失败时仍把内容填回输入框 | 功能 | 中 | `ChatPanel.vue:569-570`、`SideChatPanel.vue:785-786` |
| 9 | desktop | 粘贴图片后立刻发送，图片可能没进这条消息 | 功能 | 中 | `components/chat/ChatInput.vue:1095-1106,1188-1199` |
| 10 | desktop | 边路任务在本地模式下，权限切换器点了没反应 | 交互 | 中 | `SideChatPanel.vue:82-100` |
| 11 | desktop | 边路任务的审批卡片不出现在主聊天 | 交互 | 中 | `ChatPanel.vue:416-428`、`CenterTabContainer.vue:16-20` |
| 12 | desktop | Git 凭证编辑时无法清空备注 | 功能 | 中 | `GitCredentialsView.vue:213-216` |
| 13 | desktop | 文件树在筛选结果里展开目录，清空筛选后展开丢失 | 功能 | 中 | `FileTree.vue:253-265,282-284` |
| 14 | desktop | 触控端终端 Tab 的关闭按钮默认不可见 | UI | 中 | `TerminalTabs.vue:112-130` |
| 15 | admin | 只有 `user:read` 时打不开用户详情 | 功能 | 中 | `UserListView.vue:120-150,193-214` |
| 16 | admin | 系统 Skills 上传区不校验 `agent:write` | 功能 | 中 | `SkillListView.vue:37-59,452-453` |
| 17 | admin | 非管理员顶栏永久钉着不可关的「用量分析」，Logo 也跳过去 | 交互 | 中 | `stores/tabs.ts:19-21`、`SideMenu.vue:158-160` |
| 18 | desktop | 个人信息点「移除头像」画面没有任何变化 | UI | 中低 | `ProfileView.vue:11-12,23-30,150-157` |
| 19 | admin | 多个列表 keep-alive 返回后不刷新 | 功能 | 中低 | Agent / 模型 / 用户 / Skills / 定时任务 |
| 20 | admin | 已登录但没有 `user:write` 的账号没有改自己密码的入口 | 功能 | 中低 | `Layout.vue:45,135` |
| 21 | admin | 会话详情导出 JSON 同步 revoke，部分环境下载无声失败 | 功能 | 低 | `SessionDetailView.vue:225-230` |
| 22 | desktop | 飞书「绑定时间」直接显示原始时间串 | UI | 低 | `FeishuBotView.vue:19` |

---

# 一、高

## 1. 审批发送失败后卡片回来了，但按钮永久禁用（desktop）

**位置**：`desktop/src/components/chat/ApprovalStack.vue:41-50,87-94`，`desktop/src/composables/useChat.ts:66-87`

**根因**：点击「执行 / 拒绝」时，卡片立刻把 `requestId` 写进 `handledIds`，按钮 `:disabled="handledIds.has(...)"`。这个集合只增不减。

上层 `confirmApproval` 在 WebSocket 发送失败时会把审批项塞回队列，并弹出「审批发送失败，请重试」：

```77:86:desktop/src/composables/useChat.ts
      if (!sent) {
        if (!pendingApprovals.value.some(a => a.requestId === requestId)) {
          const restored = pendingApprovals.value.slice()
          restored.splice(Math.min(index, restored.length), 0, item)
          pendingApprovals.value = restored
          sessionStore.incrementPendingApproval(item.sessionId)
        }
        ElMessage.error('审批发送失败，网络连接不可用，请重试')
```

塞回来的仍是同一个 `requestId`，`handledIds` 已经记住它，两个按钮保持灰色，`confirm()` 开头也会直接 return。

**触发**：CLOUD 会话（Web / 安卓 / 桌面云端）在断线或重连窗口里点审批。

**影响**：toast 让用户重试，卡片也还在，但点不了。会话停在 `WAITING_APPROVAL`，前端没有第二次提交的入口，只能刷新页面。

**建议**：`confirmApproval` 在 `sent === false` 时通知 `ApprovalStack` 去掉对应 `handledIds`（或把「已处理」改成卡片内部的提交中状态，失败时复位）。

---

## 2. 已绑定飞书时点「重新绑定」，约 2 秒就误报成功（desktop）

**位置**：`desktop/src/views/settings/FeishuBotView.vue:27-29,126-145`；对照 `backend-ts/src/feishu/binding.routes.ts:12-16`、`binding.repository.ts:10-15`

**根因**：按钮在已绑定状态下文案是「重新绑定」，点下去只是再要一次授权链接并开始轮询。轮询把「当前已经绑定」当成「这次授权完成」：

```136:145:desktop/src/views/settings/FeishuBotView.vue
    try {
      const { data } = await api.get<FeishuBindingStatus>('/feishu/binding/status')
      if (data?.bound === true) {
        clearPollTimer()
        authorized.value = true
        // ...
        dialogVisible.value = false
        ElMessage.success('飞书账号绑定成功')
```

`POST /v1/feishu/binding` 只返回二维码 / 授权地址，不会解绑、也不会写入「等待新授权」状态。`getStatus` 只要库里还有 `union_id` 就返回 `bound: true`。已绑定用户首轮轮询（间隔 2 秒）必然命中。

**触发**：设置 → 飞书机器人 → 已绑定 → 「重新绑定」。

**影响**：弹窗打开后马上提示成功并关掉，用户还没在飞书里完成新授权。旧 union_id 原样留着，换绑实际上没发生。微信绑定走的是带 `sessionKey` 的扫码状态，不会把「早已绑定」当成这次成功。

**建议**：发起重新绑定前记下当前 `unionId`（或后端返回一个 binding attempt id）。轮询只在 `unionId` 发生变化，或 attempt 被确认后，才走成功收尾。

---

## 3. 任务列表重命名点「取消」仍会保存（desktop）

**位置**：`desktop/src/components/task/TaskIndexPanel.vue:124-131,148-153,1057-1078`（聚焦区、归档区等同文件还有两处 `@blur="confirmEdit()"`）

**根因**：输入框在失焦时直接提交，取消按钮只挂了 `@click`：

```124:131:desktop/src/components/task/TaskIndexPanel.vue
                <input
                  v-if="editingSessionId === session.id"
                  v-model="editingTitle"
                  class="session-title-input"
                  @keydown="onEditKeydown"
                  @click.stop
                  @blur="confirmEdit()"
                />
```

点「取消」时，浏览器先让输入框 blur，`confirmEdit()` 同步拿到 id 和新标题并发出 `renameSession`，随后 click 才执行 `cancelEdit()` 清编辑态。请求已经在飞，清状态取消不了它。

同仓库边路列表已经避开这个顺序：

```279:284:desktop/src/components/task/SideTaskList.vue
function onEditBlur(task: SideTaskItem) {
  nextTick(() => {
    if (editingId.value !== task.id) return
    const active = document.activeElement
    if (active?.closest('.side-task-item-actions')) return
```

**触发**：任务侧栏点重命名 → 改标题 → 点叉号取消。

**影响**：标题被改掉。「取消」和 Esc（Esc 走 `cancelEdit`，不经过 blur 提交）行为不一致。

**建议**：主列表复用边路的 `onEditBlur`：焦点落到确认/取消按钮上时不提交。

---

## 4. 只有 `model:read` 时，登录和「返回首页」在无权限页之间打转（admin）

**位置**：`admin/src/router/index.ts:6-12,32,133-135,176-181`，`admin/src/views/auth/ForbiddenView.vue:5`，`admin/src/components/SideMenu.vue:108,158-160`

**根因**：布局根路由写死跳到用量分析，用量分析是 `adminOnly`。非管理员会被 `pickHomePath` 改道，但这个函数没有 `model:read`：

```6:12:admin/src/router/index.ts
function pickHomePath(isAdmin: boolean, hasPermission: (p: string) => boolean): string {
  if (isAdmin) return '/analytics'
  if (hasPermission('session:read')) return '/sessions'
  if (hasPermission('agent:read')) return '/agents'
  if (hasPermission('user:read')) return '/users'
  if (hasPermission('settings:read')) return '/settings'
  return '/forbidden'
}
```

侧栏却把「模型管理」放给 `model:read`。未知路径的兜底也是 `redirect: '/analytics'`。无权限页的「返回首页」是 `router.push('/')`，又回到同一条 redirect。

**触发**：账号只有模型读权限 → 登录；或在无权限页点「返回首页」/ 点 Logo。

**影响**：落地页是「无权限访问」。点「返回首页」或 Logo 会再被送回无权限页。侧栏里的「模型管理」仍然可点，所以不是完全出不去，但默认入口和首页按钮是坏的。

**建议**：`pickHomePath` 补上 `model:read → /models`。Forbidden 的「返回首页」、Logo、`/` 与 404 兜底都走 `pickHomePath`，不要写死 `/analytics`。

---

# 二、中

## 5. 保存尚未完成时切走再切回，输入框不清空（desktop）

**位置**：`desktop/src/components/chat/ChatPanel.vue:639-645,675-697`

**根因**：首条消息（非入队）会记下 `sendGeneration`，等保存成功且代数没变才 `clearInput`。切回聊天 Tab 时，只要还停在「正在保存」，就把代数加一，故意作废这一轮的清框：

```639:645:desktop/src/components/chat/ChatPanel.vue
onActivated(() => {
  userScrolledUp.value = false
  if (waitingForSave.value) {
    waitingForSave.value = false
    sendGeneration++
  }
```

保存成功的分支因此跳过 `clearInput`。草稿槽位仍会被清掉，但编辑器里的原文还在，发送按钮也已经解锁。

**触发**：发出第一条消息，在「正在保存」期间打开文件或边路 Tab，保存完成前再回到主聊天。

**影响**：界面像没发出去。用户再按一次发送，同一段话会再走一遍。慢网或创建会话较慢时容易碰上。

**建议**：作废 UI 时区分「用户已经改过输入」和「仍是刚发出的原文」。后者在保存成功后仍要清空；或者切回时如果保存已成功，按消息 id 对一下再清。

---

## 6. 用户「账号类型」只滤当前页，移动端卡片完全不滤（admin）

**位置**：`admin/src/views/user/UserListView.vue:49-59,80,157,317-321,331-347`

**根因**：注释写明后端 `listUsers` 没有 `authType`。桌面表格用前端计算属性滤当前页：

```317:321:admin/src/views/user/UserListView.vue
const displayedUsers = computed(() => {
  if (!filters.authSource) return users.value
  return users.value.filter((u) => (u.authSource || 'LOCAL') === filters.authSource)
})
```

`fetchUsers` 不把 `authSource` 放进请求，分页 `total` 仍是服务端全量。移动端卡片遍历的是 `users`，不是 `displayedUsers`：

```157:157:admin/src/views/user/UserListView.vue
        <el-card v-for="row in users" :key="row.id" class="user-card" shadow="hover">
```

下拉还有 `@change="handleSearch"`，所以一选类型就会重新请求，但请求参数里没有这个条件，看起来像筛过了。

**触发**：用户管理选「本地」或「LDAP」后翻页；或把窗口缩到移动布局再选类型。

**影响**：桌面某一页可能被滤成空表，总条数却不变，翻页结果对不上。移动端选了类型，列表纹丝不动。

**建议**：筛选下推到列表接口。在接口就绪前，移动端至少改绑 `displayedUsers`，并在分页旁说明「仅过滤本页」。

---

## 7. 会话列表的 URL 筛选在 keep-alive 下对不上（admin）

**位置**：`admin/src/views/session/SessionListView.vue:199-207,332-348`；`admin/src/components/Layout.vue:58-62`

**根因**：keep-alive 的 key 是 `path`，query 变化不会重建组件。筛选只在 `onMounted` 从 query 写入，而且只赋值、不清除：

```199:207:admin/src/views/session/SessionListView.vue
function applyRouteQuery() {
  const q = route.query
  if (typeof q.userId === 'string' && q.userId) filters.userId = Number(q.userId)
  if (typeof q.agentId === 'string' && q.agentId) filters.agentId = Number(q.agentId)
  // ... query 缺字段时不会把已有筛选清掉
}
```

再次激活只 `fetchSessions()`，不读当前 URL。

**触发**：先打开会话列表，再从用户详情或别的页面进 `/sessions?userId=`；或列表已带筛选时，从侧栏再进不带 query 的「会话管理」。

**影响**：地址栏是一个人，表格仍按上次的内存筛选请求。深链筛选失效，或 URL 已经没有条件、列表还在过滤。

**建议**：`watch(() => route.query)` 或在 `onActivated` 里调用 `applyRouteQuery()`，query 缺省时把对应筛选项清空后再请求。

---

## 8. 队列「编辑」在删除失败时仍把内容填回输入框（desktop）

**位置**：`desktop/src/components/chat/ChatPanel.vue:548-571`，`desktop/src/components/chat/SideChatPanel.vue:748-752,764-787`，`desktop/src/composables/useChat.ts:803-808`

**根因**：删除失败只 toast，函数不返回成败：

```803:808:desktop/src/composables/useChat.ts
  async function deleteQueueMessage(queueId: string) {
    if (!sessionId.value) return
    await connect()
    if (!await wsDeleteQueueMessage(sessionId.value, queueId)) {
      ElMessage.error('操作失败，网络连接不可用，请重试')
    }
  }
```

调用方无条件回填：

```569:570:desktop/src/components/chat/ChatPanel.vue
  await deleteQueueMessage(msg.id)
  chatInputRef.value?.restoreContent(msg.content, files)
```

边路面板是同一结构（`SideChatPanel.vue:785-786`）。

**触发**：执行中的队列点「编辑」，WebSocket 删除失败。

**影响**：队列里那条还在，输入框又有一份。再发送会多出一条内容相同的队列消息。

**建议**：`deleteQueueMessage` 返回 boolean，失败时不要 `restoreContent`。

---

## 9. 粘贴图片后立刻发送，图片可能没进这条消息（desktop）

**位置**：`desktop/src/components/chat/ChatInput.vue:693-711,1095-1106,1180-1199`

**根因**：图片先走异步体积检查，通过后才 `push` 进待发列表。粘贴处理函数同步返回，不等这个 Promise：

```1095:1106:desktop/src/components/chat/ChatInput.vue
function addPendingImage(file: File) {
  if (pendingFiles.value.length >= 10) {
    ElMessage.warning('最多上传 10 个附件')
    return
  }
  checkFileSize(file).then(({ ok, limitMb }) => {
    if (!ok) { /* ... */ return }
    pendingFiles.value.push({ file, previewUrl: URL.createObjectURL(file) })
  })
}
```

`handleSend` 当场读取 `pendingFiles`。输入框里已经有文字时 `canSend` 为 true，Enter 不会等图片入库。选择文件、拖拽走的是同一函数。

**触发**：输入框已有文字，粘贴或拖入图片后马上发送（上传配置接口较慢时更容易）。

**影响**：消息发出去了，图片过一会儿才出现在待发区，等于没带上。只贴图、没有文字时 `canSend` 要等图片进列表才变 true，这条路径不会提前发出。

**建议**：`addPendingImage` 改为 await，发送前若仍有未完成的体积检查则先等完，或在检查完成前禁用发送。

---

## 10. 边路任务在本地模式下，权限切换器点了没反应（desktop）

**位置**：`desktop/src/components/chat/SideChatPanel.vue:82-100`；对照 `ChatPanel.vue:32,45,740-746`，`ChatInput.vue:199-203,351`

**根因**：`ChatInput` 在 `executionMode === 'LOCAL'` 时渲染权限切换器，当前值来自 prop，默认 `READ_ONLY`。切换只向外 emit。主会话把 prop 和事件都接上了，并发 `PATCH /sessions/:id`。边路这块没传 `permission-level`，也没听 `@update:permission-level`：

```82:100:desktop/src/components/chat/SideChatPanel.vue
      <ChatInput
        ref="chatInputRef"
        :execution-mode="parentExecutionMode"
        :model-id="currentModelId"
        ...
        @update:model-id="handleModelSwitch"
      />
```

切换器是受控组件，父组件不改 prop，徽章就停在「只读」。

**触发**：父会话为本地模式 → 打开边路任务 → 点权限下拉。

**影响**：控件看起来能改，点完没有任何变化，也不会写到会话上。边路实际按哪一级权限跑，界面始终显示「只读」。

**建议**：边路复用主会话的权限读写（继承父级或边路自己的 `permissionLevel`），把 prop 和更新事件接上。若边路不允许单独改，就不要渲染这个切换器。

---

## 11. 边路任务的审批卡片不出现在主聊天（desktop）

**位置**：`desktop/src/components/chat/ChatPanel.vue:416-428`，`desktop/src/components/center/CenterTabContainer.vue:3-20`，`desktop/src/components/chat/SideChatPanel.vue:62-66,274`

**根因**：主聊天的审批列表只放行「无 sessionId / 当前主会话 / 子代理」：

```424:428:desktop/src/components/chat/ChatPanel.vue
  return pendingApprovals.value.filter(a => {
    if (!a.sessionId || a.sessionId === parentId) return true
    // 子代理 Tab 未激活时，仍在主聊天展示其 LOCAL 审批，避免卡死
    return subIds.has(String(a.sessionId))
  })
```

边路会话 id 不在 `subIds` 里。边路自己的 `ApprovalStack` 写在 `SideChatPanel` 上，而该面板只在边路 Tab 处于激活时挂载（`v-else-if="activeTab?.type === 'side_task'"`）。

**触发**：本地边路进入待审批，人还停在主会话 Tab。

**影响**：主聊天没有审批按钮。侧栏能看到「待审批」，但要点开边路 Tab 才能操作。子代理已经为「Tab 没打开也会卡死」做了兜底，边路没有。切到文件 / Diff Tab 时，主会话自己的审批卡片也会跟着 `ChatPanel` 一起离开视口，聊天 Tab 上没有待审批标记。

**建议**：主聊天的过滤条件并入当前父会话下未关闭的边路 sessionId；或在中心 Tab 上给待审批一个可点的标记，点进去再审批。

---

## 12. Git 凭证编辑时无法清空备注（desktop）

**位置**：`desktop/src/views/settings/GitCredentialsView.vue:213-220`；`backend-ts/src/user/git-credential.service.ts:104-106`

**根因**：空备注被收成 `undefined`，请求体里等于没传这个字段：

```213:216:desktop/src/views/settings/GitCredentialsView.vue
      const payload: { accessToken?: string; description?: string } = {
        description: form.value.description.trim() || undefined
      }
```

后端只在 `description != null` 时更新，并明确支持空串表示清空（`trim() === ''` 写成 `null`）。`undefined` 被当成「不修改」。

**触发**：编辑已有凭证 → 删掉备注 → 保存。

**影响**：提示「凭证已更新」，列表里的备注还是旧的。Token 留空表示不改，这个语义是对的；备注被套用了同一套「空则省略」，把「清空」和「不改」混在一起。

**建议**：编辑时始终提交 `description: form.value.description.trim()`（允许空串）。新建时再省略空备注。

---

## 13. 文件树在筛选结果里展开目录，清空筛选后展开丢失（desktop）

**位置**：`desktop/src/components/file-browser/FileTree.vue:253-265,271-284`；`desktop/src/composables/useFileBrowser.ts:80-100`

**根因**：筛选时目录节点被展开成新对象，子节点也是新数组：

```259:260:desktop/src/components/file-browser/FileTree.vue
      if (node.name.toLowerCase().includes(lower) || filteredChildren.length > 0) {
        result.push({ ...node, children: node.children ? filteredChildren : node.children, expanded: filteredChildren.length > 0 ? true : node.expanded })
```

模板把这份拷贝交给 `handleToggleDir` → `expandDir(node)`。`expandDir` 改的是入参上的 `expanded` / `children`，也就是拷贝，不是 `treeData` 里的原节点。展示用的是 `node.expanded`（`FileTreeNode.vue:12,34`），不是 `expandedPaths`。

**触发**：文件树输入至少两个字 → 展开一个还没加载完的目录 → 清空筛选。

**影响**：筛选期间加载的子节点挂在临时对象上。清空后原树仍是折叠、没有 children，需要再点一次才重新请求。筛选过程中改过的展开状态也不会回到原树。

**建议**：展开、加载都按 `path` 写回 `treeData` 里的原节点。筛选视图只负责挑哪些 path 可见。

---

## 14. 触控端终端 Tab 的关闭按钮默认不可见（desktop）

**位置**：`desktop/src/components/terminal/TerminalTabs.vue:112-130`；对照 `desktop/src/components/center/CenterTabBar.vue:171-176`。安卓会打开终端面板（`TerminalPanel.vue:307` `showKeyBar = isAndroidCapacitor()`）。

**根因**：关闭钮 `opacity: 0`，只在 `:hover` 时显示。中心区文件 Tab 已经对触控做了例外：

```171:176:desktop/src/components/center/CenterTabBar.vue
@media (max-width: 768px), (hover: none) {
  .tab-close {
    opacity: 1;
  }
}
```

终端 Tab 没有这段。

**触发**：安卓或没有稳定 hover 的设备上打开终端，新建多个 Tab，想关掉其中一个。

**影响**：单个 Tab 的关闭钮点不到。面板右上角能关掉整个终端，不能关掉其中一个会话。

**建议**：把中心 Tab 的 `(hover: none)` / 窄屏规则抄到 `.terminal-tab-close`。

---

## 15. 只有 `user:read` 时打不开用户详情（admin）

**位置**：`admin/src/views/user/UserListView.vue:118-150,192-214`

**根因**：路由允许 `user:read` 进入用户管理，但「详情」和编辑、重置密码、启停放在同一个 `v-if="canWrite"` 里。`canWrite` 是 `user:write`。没有写权限时，桌面操作列是「—」，移动端卡片没有任何按钮。

**触发**：只有用户读权限的账号打开用户管理，想看某人的会话、技能或 Git 凭证。

**影响**：列表看得见，详情抽屉进不去。读权限名不副实。

**建议**：「详情」放到 `user:read` 下。编辑、重置、启停继续要求 `user:write`。

---

## 16. 系统 Skills 上传区不校验 `agent:write`（admin）

**位置**：`admin/src/views/skill/SkillListView.vue:37-59,249,452-466`

**根因**：同一页的删除按钮已经 `:disabled="!canWrite"`（含移动端，注释写明曾漏过系统 Tab）。上传区没有对应判断，`uploadFiles` 也不看权限：

```452:453:admin/src/views/skill/SkillListView.vue
async function uploadFiles(files: File[]) {
  if (uploading.value) return
```

**触发**：只有 `agent:read` 的用户，在桌面宽度打开系统 Skills，拖入或点选目录。

**影响**：上传区可点，走完选择后请求失败才看到错误。和删除按钮的权限表现不一致。

**建议**：`v-if="canWrite"` 包住上传区；`uploadFiles` 开头再挡一次。

---

## 17. 非管理员顶栏永久钉着不可关的「用量分析」（admin）

**位置**：`admin/src/stores/tabs.ts:19-21,46`，`admin/src/components/SideMenu.vue:158-160`

**根因**：标签仓库的初始状态写死一条不可关闭的用量分析，和当前用户是否管理员无关：

```19:21:admin/src/stores/tabs.ts
  const tabs = ref<TabItem[]>([
    { path: '/analytics', fullPath: '/analytics', title: '用量分析', name: 'Analytics', closable: false }
  ])
```

`closable` 的例外也只认这条 path（`path !== '/analytics'`）。Logo 的 `goHome()` 固定 `router.push('/analytics')`。非管理员点进去会被守卫软跳回自己的首页，标签还在。

**触发**：非管理员登录后看顶栏；或点左上角 Logo。

**影响**：多一个永远关不掉、点开又会跳走的标签。有会话 / Agent / 用户权限的账号不会掉进问题 4 的无权限循环，但这个空标签一直占着。

**建议**：登录后按 `pickHomePath` 生成第一条不可关闭标签。Logo 跳这个首页，而不是 `/analytics`。

---

# 三、低

## 18. 个人信息点「移除头像」画面没有任何变化（desktop）

**位置**：`desktop/src/views/settings/ProfileView.vue:11-12,23-30,150-157`

**根因**：头像地址是 `previewUrl || authStore.user?.avatarUrl`。移除只把 `removeAvatarFlag` 设为 true，并清掉预览 URL，于是又落回当前头像。移除按钮的显示条件是「已有头像且没有预览」，点完之后条件仍成立，按钮也还在。

**触发**：个人信息 → 已有头像 → 「移除头像」。

**影响**：点击没有反馈，容易再点一次或以为坏了。真正保存时会把 `avatarUrl` 传成空串，头像会被删掉，和点击当下看到的不一致。

**建议**：移除后用占位图替换预览，按钮改成「撤销移除」，保存前不要再显示旧头像。

---

## 19. 多个列表 keep-alive 返回后不刷新（admin）

**位置**（均 `keepAlive: true`，且没有 `onActivated` 重新拉取）：

- `admin/src/views/agent/AgentListView.vue:245` `onMounted(fetchAgents)`
- `admin/src/views/model/ModelListView.vue:509`
- `admin/src/views/user/UserListView.vue:478`
- `admin/src/views/skill/SkillListView.vue:496`
- `admin/src/views/scheduled-tasks/index.vue:388`

同目录里会话列表、调用流水、审计日志、飞书机器人、系统指令、系统设置已经在 `onActivated` 里刷新。

**触发**：改完一条 Agent / 模型 / 用户后，切到别的菜单再点回来（标签未关，且还在 keep-alive 的 8 个名额里）。

**影响**：列表停在离开前的数据。别的菜单已经会刷新，这几页不会，用起来像有的页面「不更新」。

**建议**：与会话列表一样，首次激活跳过，之后 `onActivated` 再拉一次。

---

## 20. 没有 `user:write` 的账号不能改自己的密码（admin）

**位置**：`admin/src/components/Layout.vue:45,135`；`admin/src/views/user/ChangePasswordDialog.vue:114-128`；`backend-ts/src/user/user.routes.ts:95-97`

**根因**：头像菜单的「修改密码」要求 `user:write`。对话框提交的是当前登录用户自己的 id：`PUT /users/${userId}/password`。这条接口同样 `requirePermission(..., 'user:write')`，和「重置别人的密码」是同一个权限。

**触发**：能登录管理后台、但角色里没有用户写权限的账号，打开头像菜单。

**影响**：菜单里没有改密项。即便把按钮放开，现有接口也会 403。自助改密被绑在管理他人的权限上。

**建议**：增加仅修改自己密码的接口（登录即可），菜单对所有已登录用户显示。重置他人密码继续要求 `user:write`。

---

## 21. 会话详情导出 JSON 同步 revoke（admin）

**位置**：`admin/src/views/session/SessionDetailView.vue:224-230`

```224:230:admin/src/views/session/SessionDetailView.vue
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `session-${id}-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
```

`<a>` 没有挂到 `document.body`，`revokeObjectURL` 紧跟 `click()`。调用流水的导出已经是先挂载、点击、移除、再异步 revoke。这里在部分 WebView 里会在下载开始前失效，且没有失败提示（成功 toast 在 revoke 之后照样弹出）。

**建议**：与调用流水导出同一套写法。

---

## 22. 飞书「绑定时间」直接显示原始时间串（desktop）

**位置**：`desktop/src/views/settings/FeishuBotView.vue:19,85-90`

绑定成功后模板是 `绑定时间：{{ boundAt }}`，`boundAt` 来自接口的 `updatedAt`，没有本地化。微信绑定页对同一类字段使用了 `formatTime`（`WeixinBotView.vue:22,127`）。

**影响**：飞书页可能看到 `2026-09-22T04:30:00.000Z` 这类字符串，和微信页、后台其它时间列不一致。

**建议**：复用桌面端已有的时间格式化函数。

---

# 四、已排除的误报

| 候选 | 排除依据 |
|---|---|
| 执行中输入框有内容时，停止按钮变成「加入队列」 | 有意设计：执行中输入为空才停止，有草稿则同一按钮改为加入队列。2026-09-22 复核后移出问题清单 |
| 审批卡片「展开」点击不刷新（`expandedSet` 原地 `add`/`delete`） | Vue 3 的 reactive `Set` 会追踪 `add`/`delete`。`2026-09-21` 审查已核验排除，本次代码仍是原地修改，不重复列入 |
| 审批失败后卡片彻底消失、无法重试 | 当前 `confirmApproval` 已在 `sent === false` 时把项放回队列。剩下的问题是按钮锁死，见问题 1 |
| 会话「更多筛选」改下拉不立即查询 | 页上有明确的「查询」按钮，关键词也支持回车。这是操作方式差异，不是失效 |
| 修改密码按钮若只放开就会成功 | 后端 `PUT /users/:id/password` 同样要求 `user:write`。问题在自助改密缺少独立入口，见问题 20 |

---

# 五、修复优先级建议

1. **先修问题 1、2、3**：审批无法重试、飞书换绑误报成功、取消重命名仍保存，都是点了之后结果和界面承诺相反，改动范围也局部。
2. **问题 4**：只读模型管理员的首页要连同 Logo、404 兜底和 Forbidden 按钮一起改，避免只补 `pickHomePath` 一处。
3. **问题 5–13**：发送竞态、筛选错位、权限控件和文件树，按「会发出错误数据」优先于「展开状态丢失」。
4. **问题 14–22**：触控关闭钮、权限按钮、列表刷新和导出写法，可以按页面合并修。

改动涉及用户可见行为时，按仓库约定写入根 `CHANGELOG.md`：共用 UI 记入「前端（桌面 / Web / 安卓）」，管理后台记入「管理后台」。
