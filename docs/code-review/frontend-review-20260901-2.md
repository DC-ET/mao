# 前端代码 Review（2026-09-01，2026-09-02 复核修订）

审查范围：`admin/src`（管理后台，Vue3 + Element Plus）与 `desktop/src`（桌面/ Web / Android 共用前端，Vue3 + Pinia）。

审查维度：功能模块缺陷、UI 样式、交互逻辑。

> **复核说明**：初版收录 34 条。2026-09-02 对全部条目逐一与当前代码核对，移除 17 条不存在或无修复价值的问题（F3 / F9 / F11 / F13 / F14 / F15 / F19 / F20 / F22 / F23 / F25 / F29 / F30 / F31 / F32 / F33 / F34，其中 F29 / F30 / F33 / F13 等已在近期代码中修复），保留 17 条并重新编号。
>
> 主要移除理由备忘：
> - 原 F3：`openEdit` 实际已回填 `parseArgs(server.argsJson)`（McpServersView.vue:362），「编辑必失败」前提不成立
> - 原 F9：`pendingCallbacks` 的 key 是 sessionId 本身，watcher 内同步 set 无竞态；切换会话不影响 `get(sid)` 命中
> - 原 F11：ChatPanel 仅在 `isActive` 分支调用 `sendMessageWithQueue`，`await sendMessage(); return true` 为不可达死路径
> - 原 F13：`retryExecution` 已走 `sendReliable` 并在失败时复位 `sending` + toast（useChat.ts:569-574）
> - 原 F22：`load()` 实际有 `catch`（拦截器统一 toast），「无 catch 静默」断言错误
> - 原 F25：四处区块的输入框均 `v-if="editingSessionId === session.id"`，全局唯一实例，`querySelector` 不会命中错误行
> - 原 F29 / F30 / F33：FileTree 已有 300ms 防抖 + 2 字符下限；聚焦排序已用 Map O(n)；TopNav 已有 `.is-mac` 条件类

本文档共收录 **17 条**问题。

## 分级统计

| 级别 | 数量 | 编号 |
|---|---|---|
| **P0** | 3 | F1 F2 F3 |
| **P1** | 10 | F4 … F13 |
| **P2** | 4 | F14 … F17 |

| 类别 | 数量 |
|---|---|
| 功能模块 | 10 |
| 交互逻辑 | 7 |

---

# 一、P0：功能不可用 / 数据错乱 / 安全

## 问题 F1：`disconnect()` 不清 `connectPromise`，后续所有 `connect()` 返回永不 settle 的死 Promise

- **位置**：`desktop/src/composables/useStreamWS.ts`（`disconnect`）、`connect()` 开头 `if (connectPromise) return connectPromise`、`onclose` 早退分支
- **级别**：**P0**
- **类别**：功能模块
- **现象**：WS 处于 `CONNECTING` 时触发 `disconnect()`（登出、401 强制下线都会走 `authStore.clearLocalSession()` → `useStreamWS().disconnect()`），`ws` 被置 `null`，但 `connectPromise` 仍指向旧 socket 的 pending Promise。旧 socket 的 `onclose` 因 `event.target !== ws` 提前 `return`，**既不 resolve 也不 reject**。之后任意 `connect()` 都命中 `if (connectPromise) return connectPromise`，返回这个死 Promise，导致所有裸 `await connect()`（useChat.ts 多处、SideChatPanel.vue:519）永久挂起：**输入框锁死在 sending 态、消息发不出去、无任何报错与提示**，只能刷新页面。`sendReliable` 内部虽有 `withTimeout(connect(), 15_000)` 兜底，但 useChat 中的裸 `await connect()` 不受保护。
- **代码**：
```ts
  function disconnect() {
    intentionalClose = true
    isReconnecting = false
    stopHeartbeat()
    ...
    if (ws) {
      ws.close()
      ws = null          // ← connectPromise 未复位
    }
```
```ts
    ws!.onclose = (event) => {
      if (event.target !== ws) {
        initialConnect = false
        return             // ← 既不 resolve 也不 reject
      }
```
- **建议**：`disconnect()` 中同步 `connectPromise = null`，并在 `onclose` 的早退分支里对仍持有的 `connectPromise` 做 reject；同时清空 `pendingCallbacks` / `activeExecutionIds` / `cancelledExecutionIds` / `suppressedStreamSessions` / `messageSavedCallbacks` / `pendingSkillSyncDones`，避免换号登录后残留跨用户状态。

---

## 问题 F2：删除会话后 Tab 状态永久残留，`sessionTabsMap` 无界增长

- **位置**：`desktop/src/composables/useCenterTabs.ts:360`（定义）、`desktop/src/components/task/TaskIndexPanel.vue`（`confirmDelete`，未清理）
- **级别**：**P0**
- **类别**：功能模块
- **现象**：`removeSessionTabs(sessionId)` 已导出，但全仓库 **grep 无任何调用方**。用户每删除一个会话，该会话的 `SessionTabState`（文件 Tab、diff Tab、边路任务 Tab）永远残留在模块级单例 `sessionTabsMap` 中。长期使用的客户端 Map 无界增长；更严重的是再次用同一 sessionId 打开时（恢复归档 / 深链回跳）会直接看到上一个已删除会话遗留的旧 Tab，出现「会话 A 里挂着会话 B 的文件标签」的错乱。
- **代码**：
```ts
  // useCenterTabs.ts:360 导出了清理函数，但全仓库无调用方
  function removeSessionTabs(sessionId: string) {
    sessionTabsMap.value.delete(sessionId)
  }
```
- **建议**：在 `TaskIndexPanel.vue` 的 `confirmDelete` 里，删除成功后调用 `removeSessionTabs(sessionId)`；同时 `removeSessionTabs` 内部应替换 Map 引用（`sessionTabsMap.value = new Map(...)`）以触发 computed，当前只 `delete` 不触发通知。

---

## 问题 F3：Markdown 渲染白名单放行 `onclick`，用户上传的 SKILL.md 存在注入面

- **位置**：`desktop/src/composables/useMarkdown.ts:62-72`、`admin/src/views/session/composables/useMarkdown.ts:44-46`；消费点 `desktop/src/components/common/MarkdownContent.vue`、`admin/src/views/session/components/MessageGroup.vue:41,54`
- **级别**：**P0**
- **类别**：功能模块（安全）
- **现象**：两处 `DOMPurify.sanitize(result, { ADD_ATTR: ['onclick', 'target'] })` 显式把 `onclick` 加进属性白名单，理由只是保留代码块「复制」按钮的内联 `onclick`。`ADD_ATTR` 会合并进 `ALLOWED_ATTR` 白名单并在事件属性过滤前生效，因此 **`onclick` 确实会被保留**。技能包是用户自助上传的不可信输入（SKILL.md → v-html 渲染），这是「为局部便利牺牲全局安全默认值」。缓解因素是 marked 的 `html` renderer 被重写为 `escapeHtml`，直接注入标签已被转义，当前实际风险有限，但该白名单对渲染管线的任何未来改动都是隐患。
- **代码**：
```ts
// onclick 为代码块复制按钮自带，内容侧已全部转义
const SANITIZE_OPTIONS = { ADD_ATTR: ['onclick', 'target'] }
return DOMPurify.sanitize(result, SANITIZE_OPTIONS)
```
- **建议**：改为事件委托——渲染 `<button class="code-copy-btn" data-code="...">`（不带 onclick），在容器上监听 click 用 `e.target.closest('.code-copy-btn')` 读取 `textContent` 复制。这样 DOMPurify 保持默认严格配置，同时能加复制成功/失败反馈。

---

# 二、P1：明显体验缺陷 / 高频路径错误

## 问题 F4：微信扫码轮询无总时长上限，网络持续失败时无限轮询

- **位置**：`desktop/src/views/settings/WeixinBotView.vue`（`pollStatus`）
- **级别**：P1
- **类别**：交互逻辑
- **现象**：`pollStatus` 在 `wait` / `scaned` / **以及 `catch`** 分支都无限 `setTimeout` 重新排队，**没有任何总时长上限**（对比 `FeishuBotView` 有 `pollStartedAt` + 5 分钟总超时保护）。网络持续失败时轮询会一直在后台打 `/weixin/qrcode/status`。正常流程（confirmed / expired）会终止，但 `catch` 分支（网络错误）无失败次数上限也无总超时。
- **代码**：
```ts
  } catch (error) {
    console.error('查询扫码状态失败:', error)
    // 超时或网络错误时继续轮询，不中断等待流程
    if (pollingActive) {
      statusPollingTimer = window.setTimeout(pollStatus, 3000)
    }
  }
```
- **建议**：仿 `FeishuBotView` 增加 `pollStartedAt` + 总超时（如 5 分钟）后 `stopStatusPolling()` 并提示「二维码已过期，请重新获取」；`catch` 中连续失败 N 次后停止。

---

## 问题 F5：快捷指令面板自动弹出后，Enter 被劫持，用户无法正常发送

- **位置**：`desktop/src/components/chat/ChatInput.vue:713`（Enter 分支）、`:851-895`（`detectAutoComplete`）
- **级别**：P1
- **类别**：交互逻辑
- **现象**：输入 ≥2 字符且是指令名前缀的词（`commit`、`deploy`、`review` 等）时，面板**自动弹出**（`panelVisible.value = true`，无需用户触发），`selectedIndex` 默认为 0。用户按 Enter 想发送，`confirmSelection()` 会插入指令节点而不是发送消息。用户被迫先按 Esc 才能正常发送。
- **代码**：
```ts
        if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
          if (imeComposing) return false
          event.preventDefault()
          quickCommandPanelRef.value?.confirmSelection()   // ← 自动弹出的面板吃掉 Enter
          return true
        }
```
- **建议**：加 `userNavigated` 标志——`moveUp/moveDown` 时置 true，`detectAutoComplete` 打开面板时置 false；Enter 分支改为 `if (userNavigated) confirm() else { closePanel(); handleSend() }`。

---

## 问题 F6：`detectAutoComplete` 未排除 URL / 路径，粘贴链接必定触发面板

- **位置**：`desktop/src/components/chat/ChatInput.vue:851`
- **级别**：P1
- **类别**：交互逻辑
- **现象**：以空格分词取最后一个词做前缀匹配。粘贴 `https://github.com/...`、邮箱、文件路径 `src/components/chat.vue` 时，只要该词恰好是某技能名前缀（`co` → `commit`、`de` → `deploy`），面板就弹出并劫持 Enter 与方向键。聊天里贴链接是极高频操作。
- **代码**：
```ts
  const currentWord = textBefore.split(/\s/).pop() ?? ''
  ...
  matched = allCommands.filter(cmd => cmd.name.toLowerCase().startsWith(lower))
```
- **建议**：若 `currentWord` 含 `/`、`.`、`@`、`:` 或以协议开头则直接 `closePanel(); return`；或默认关闭自动补全、只保留 `/` 显式触发。

---

## 问题 F7：模型编辑弹窗回填明文 API Key，权限判据不同步时掩码串会被写回

- **位置**：`admin/src/views/model/ModelFormDialog.vue:169`（`apiKey: props.modelData.apiKey || ''`）、`:201-203`；配合 `backend-ts/src/model/model.routes.ts`（reveal 判据）
- **级别**：P1
- **类别**：功能模块
- **现象**：后端按 `model:write` 权限决定是否 reveal 明文（`toVO(m, reveal)`），否则返回 `maskApiKey(...)`（`****xxxx`）。前端**无条件回填**服务端返回值。正常路径下编辑按钮仅对 `canWrite` 用户可见、后端返回明文，回填后原样 PUT 回去（无害但明文往返）；而一旦权限刚被移除（前端 `canWrite` computed 尚未感知，或列表数据是旧的掩码对象），**掩码串会被当成新密钥写回**，导致该模型调用全部鉴权失败，且界面无任何提示。
- **代码**：
```ts
      apiKey: props.modelData.apiKey || '',
```
```ts
    if (isEdit.value && !form.apiKey) {
      delete payload.apiKey      // 非空一律提交（包括掩码串）
    }
```
- **建议**：`apiKey` 初始值恒为 `''`，placeholder 用「已设置，留空表示不修改」；提交前加防御 `if (/\*{3,}/.test(form.apiKey)) { ElMessage.error('API Key 含掩码，请重新填写'); return }`。

---

## 问题 F8：401 刷新 token 的 `finally` 时机错误，晚到的 401 请求永久挂起

- **位置**：`desktop/src/api/index.ts:98-119`
- **级别**：P1
- **类别**：功能模块
- **现象**：`return api(originalRequest)` 在 try 内返回 Promise，`finally` 要等该重试请求完成才执行，即 `isRefreshing` 在重试期间仍为 true。这段窗口内到达的其它 401 请求会走 `if (isRefreshing)` 分支 push 进 `pendingRequests`，但 `pendingRequests.forEach(resolve)` 已经执行过 → 这些晚到的请求永远不会被 resolve/reject，对应请求永久 pending（列表 loading 不结束、页面空白）。
- **代码**：
```ts
        pendingRequests.forEach(cb => cb.resolve(newToken))
        pendingRequests = []
        originalRequest.headers.Authorization = `Bearer ${newToken}`
        return api(originalRequest)      // finally 要等它完成
      } catch (refreshError) { ... }
      } finally {
        isRefreshing = false
      }
```
- **建议**：把 `isRefreshing = false` 提到 `await doRefreshToken()` 之后、发起重试之前（finally 只包住 refresh 本身）。

---

## 问题 F9：`editAndResend` 早退不回滚已执行的乐观截断/改写

- **位置**：`desktop/src/composables/useChat.ts:612-639`（截断/改写 → 早退）
- **级别**：P1
- **类别**：功能模块
- **现象**：乐观截断、内容改写、assistant 占位插入发生在 `await collectLocalUnsyncedSkills()` / `await collectAgentsMdContent()` **之前**；若这两段 await 期间会话被切走（LOCAL 模式下有真实 IPC 耗时窗口），函数在 `requireCurrentSession` 失败处直接 `return`：既不发消息、也不回滚 → 该会话后续消息被永久截断、原消息内容已被改成新内容。用户看到历史「少了一截」，且无提示（回滚逻辑只写在 catch 里，`return` 不经过 catch）。
- **代码**：
```ts
      sessionStore.truncateMessagesAfter(sid, messageId)
      sessionStore.updateMessageContent(sid, messageId, newContent, ...)
      sessionStore.appendMessage(sid, placeholderMsg)
      ...
      const localSkills = await collectLocalUnsyncedSkills(...)
      const agentsMdContent = await collectAgentsMdContent(...)
      if (!requireCurrentSession(sid)) {
        sending.value = false
        return                    // ← 已截断/已改写，却不回滚
      }
```
- **建议**：把 `requireCurrentSession` 校验提前到 truncate 之前；或把回滚抽成 `rollbackEdit(sid, sidMessagesBeforeEdit)`，在早退分支与 catch 分支都调用。

---

## 问题 F10：MCP 编辑弹窗不重置校验状态，上一次的红色错误残留到下次打开

- **位置**：`desktop/src/views/settings/McpServersView.vue:100-107`（`el-dialog`）、`:355-369`（`openEdit`）
- **级别**：P1
- **类别**：交互逻辑
- **现象**：`el-dialog` 无 `destroy-on-close`、无 `@closed` 清理，`formRef` 的校验状态在关闭后保留。操作路径：打开新增 → 名称留空点保存 → 出现「请输入名称」→ 关闭 → 再点「编辑」某服务器 → **弹窗一打开就带着上一次的红色错误**。`openEdit` 也未调用 `clearValidate()`。
- **代码**：
```vue
    <el-dialog
      v-model="formVisible"
      :title="isEdit ? `编辑服务器：${form.name}` : '新增 MCP 服务器'"
      width="640px" class="mcp-server-dialog" :close-on-click-modal="false"
    >
```
- **建议**：加 `@closed="onFormClosed"`，在其中 `formRef.value?.clearValidate()` 并重置 `form`；`openCreate/openEdit` 里也先 `nextTick(() => formRef.value?.clearValidate())`。

---

## 问题 F11：SkillDrawer 上传无任何文件类型/大小/数量校验，失败后提示不明确

- **位置**：`desktop/src/components/skill/SkillDrawer.vue:563-590`
- **级别**：P1
- **类别**：功能模块
- **现象**：`uploadFiles` 直接把所有 `File` 塞进 `FormData`，没有单文件大小上限、总大小上限、数量上限、扩展名过滤；拖入目录时 `readEntryRecursive` 会无差别递归读取全部文件。用户拖入含 `node_modules` 的技能目录会构造出几十上百 MB 的请求；后端限流返回 413/400 时前端 `catch` 为空、依赖拦截器泛化提示，用户不知道是文件太大。
- **代码**：
```ts
  const formData = new FormData()
  for (const file of files) {
    const relativePath = (file as any).webkitRelativePath || file.name
    formData.append('files', file, relativePath)
  }
```
- **建议**：上传前校验单文件 ≤ 5MB、总数 ≤ 200、总大小 ≤ 50MB，排除 `node_modules/`、`.git/` 等目录；超限用 `ElMessage.error` 明确提示并中断。

---

## 问题 F12：CommandDrawer 预填内容会强行覆盖用户正在编辑的表单

- **位置**：`desktop/src/components/command/CommandDrawer.vue:122-131`
- **级别**：P1
- **类别**：交互逻辑
- **现象**：`watch(prefillContent)` 一旦有新内容就无条件重置 `form` 并打开弹窗。场景：用户正在「编辑指令 A」的弹窗里改内容，此时从聊天消息点「添加到指令」→ 弹窗内容被瞬间替换，用户未保存的编辑**静默丢失**。
- **代码**：
```ts
watch(prefillContent, (content) => {
  if (content) {
    activeTab.value = 'personal'
    isEditing.value = false
    editingId.value = null
    form.value = { name: '', content }      // ← 无条件覆盖当前编辑
    dialogVisible.value = true
```
- **建议**：进入前判断 `if (dialogVisible.value) return`（或提示先关闭当前编辑）；或把预填内容暂存，等当前弹窗 `@closed` 后再打开新弹窗。

---

## 问题 F13：ProfileView 邮箱字段完全没有校验

- **位置**：`desktop/src/views/settings/ProfileView.vue:53-55`
- **级别**：P1
- **类别**：功能模块
- **现象**：邮箱输入框没有 `type="email"`、没有 `rules`、没有 `maxlength`。用户输入 `abc` 点保存，请求发出后才收到后端 `邮箱格式不正确` 的 toast。后端 `user.service.ts` 有完整的 `EMAIL_PATTERN` + 128 长度 + 唯一性校验，前端完全没复用。
- **代码**：
```vue
        <el-form-item label="邮箱">
          <el-input v-model="form.email" :disabled="!isLocalUser" placeholder="请输入邮箱" />
        </el-form-item>
```
- **建议**：改用 `el-form :rules`（`{ type: 'email' }`、`max: 128`）并在保存前 `await formRef.validate()`；或至少加 `:maxlength="128"` + 失焦正则校验。

---

# 三、P2：一般优化

## 问题 F14：MessageBubble 编辑态未做 IME 判断，中文确认候选词即提交

- **位置**：`desktop/src/components/chat/MessageBubble.vue:48-53`
- **级别**：P2（中文用户体感 P1）
- **类别**：交互逻辑
- **现象**：`@keydown.enter.ctrl/meta="handleConfirm"` 未做 `event.isComposing` 检查——用户在输入法组合态按 Ctrl+Enter 上屏候选词时会**误触发提交**。同理 Esc 在组合态（取消候选）也会直接退出编辑态，未保存的内容丢失。同项目 `ChatInput.vue:670` 附近已有正确的 IME 处理，此处是遗漏。
- **代码**：
```vue
      <textarea ref="editInput" v-model="editContent" class="edit-textarea"
        @keydown.escape="$emit('cancelEdit')"
        @keydown.enter.ctrl="handleConfirm"
        @keydown.enter.meta="handleConfirm"
```
- **建议**：三个 handler 首行均加 `if (event.isComposing || event.keyCode === 229) return`；Esc 取消编辑前判断内容是否已修改。

---

## 问题 F15：右键菜单不随面板滚动关闭，坐标残留在旧位置

- **位置**：`desktop/src/components/task/TaskIndexPanel.vue:714-717`（只监听 `click` / `keydown`）
- **级别**：P2
- **类别**：交互逻辑
- **现象**：没有监听 `scroll`。用户在会话列表右键弹出菜单后滚动面板，菜单是 `position: fixed` 不会跟随，悬停在一条完全无关的会话上方，点击后对该会话执行了错误操作（删除 / 归档）。
- **代码**：
```ts
  onMounted(() => {
    document.addEventListener('click', onGlobalClick)
    document.addEventListener('keydown', onGlobalKeydown)   // ← 无 scroll / resize
  })
```
- **建议**：补充 `window.addEventListener('scroll', closeContextMenu, true)`（capture 捕获内部滚动）与 `resize`。`CenterTabBar.vue` 的 tab 右键菜单同样缺失。

---

## 问题 F16：FileDiffViewer 的 syncViewer 无并发保护，快速切换文件时显示旧内容

- **位置**：`desktop/src/components/center/FileDiffViewer.vue:219-227`（watch 配置）、`:117-155`（`syncViewer`）
- **级别**：P2
- **类别**：功能模块
- **现象**：watch 源 `[() => props.change, isDark]` 且 `deep: true`，`syncViewer` 是 async（含 `await loadMonaco()`，首次加载数百毫秒）。快速切换文件时两次 `syncViewer` 并发，**后触发的一次先完成、先触发的一次后完成**，最终 `setModel` 用先触发的旧 `props.change` 内容覆盖新内容——diff 面板显示的是上一个文件的 diff，直到再次切换才恢复。（复核修正：model 在创建前均有 dispose（:144-145），**不存在泄漏**，实际缺陷是乱序覆盖显示错误内容。）
- **代码**：
```ts
  watch(
    [() => props.change, isDark],
    () => { viewMode.value = 'preview'; void syncViewer() },   // 无并发/乱序保护
    { deep: true, flush: 'post', immediate: true },
  )
```
- **建议**：加 `let syncSeq = 0`，`syncViewer` 开头 `const seq = ++syncSeq`，每个 `await` 之后 `if (seq !== syncSeq) return`。

---

## 问题 F17：PdfViewer 串行 `getPage` 预取 + 全量 DOM slot，大 PDF 卡死

- **位置**：`desktop/src/components/center/PdfViewer.vue:25-33`（`v-for idx in numPages`）、`:296-306`（加载循环）
- **级别**：P2
- **类别**：UI样式 / 性能
- **现象**：为**每一页**创建 slot div + canvas。500 页 PDF 瞬间创建 1000 个 DOM 节点；加载期还有一个 `for (let i = 1; i <= doc.numPages; i++) await doc.getPage(i)` 的**串行**预取，500 次要串行 await，加载期间进度条长时间停留。
- **代码**：
```vue
  <div v-for="idx in numPages" :key="idx" :data-page-idx="idx - 1" :ref="setPageSlot"
       class="pdf-page-slot" :style="pageSlotStyle(idx - 1)">
    <canvas v-show="renderedPages.has(idx - 1)" ... class="pdf-canvas"></canvas>
```
- **建议**：引入虚拟滚动（只渲染可视窗口 ±2 页）；尺寸预取改为 `Promise.all` 分批（每批 20 页）或按需（`getPage` 在进入视口时才调）。

---

# 四、建议修复顺序

**第一批（P0，功能不可用 / 安全）**
1. F1 — WS `connectPromise` 死 Promise（发不出消息，只能刷新）
2. F2 — 删除会话后 Tab 状态泄漏（数据错乱）
3. F3 — `onclick` 白名单（安全，有干净替代方案）

**第二批（P1 高频路径）**
4. F5 / F6 — 输入框 Enter 被面板劫持（最高频的体感问题）
5. F8 / F9 — 两类「永久挂起 / 静默改坏内容」
6. F4 — 微信扫码轮询无超时
7. F7 — 模型 API Key 掩码写回
8. F10 / F12 / F13 — 弹窗校验残留、上传校验、邮箱校验（低成本）

**第三批（P2 体验与性能）**
9. F14 / F15 — 交互细节（IME、右键菜单）
10. F16 / F17 — 性能与渲染（Monaco 乱序、PDF 串行预取）
