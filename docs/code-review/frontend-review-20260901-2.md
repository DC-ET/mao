# 前端代码 Review（2026-09-01）

审查范围：`admin/src`（管理后台，Vue3 + Element Plus）与 `desktop/src`（桌面/ Web / Android 共用前端，Vue3 + Pinia）。

审查维度：功能模块缺陷、UI 样式、交互逻辑。

本文档共收录 **34 条**问题。所有 `文件:行号` 均已逐条核对。

## 分级统计

| 级别 | 数量 | 编号 |
|---|---|---|
| **P0** | 5 | F1 F2 F3 F4 F5 |
| **P1** | 17 | F6 … F22 |
| **P2** | 12 | F23 … F34 |

| 类别 | 数量 |
|---|---|
| 功能模块 | 20 |
| 交互逻辑 | 8 |
| UI 样式 | 6 |

---

# 一、P0：功能不可用 / 数据错乱 / 安全

## 问题 F1：`disconnect()` 不清 `connectPromise`，后续所有 `connect()` 返回永不 settle 的死 Promise

- **位置**：`desktop/src/composables/useStreamWS.ts:267-277`（`disconnect`）、`:163`（`if (connectPromise) return connectPromise`）、`:231-235`（`onclose` 早退分支）
- **级别**：**P0**
- **类别**：功能模块
- **现象**：WS 处于 `CONNECTING` 时触发 `disconnect()`（登出、401 强制下线都会走 `authStore.clearLocalSession()` → `useStreamWS().disconnect()`），`ws` 被置 `null`，但 `connectPromise` 仍指向旧 socket 的 pending Promise。旧 socket 的 `onclose` 因 `event.target !== ws` 提前 `return`，**既不 resolve 也不 reject**。之后任意 `connect()` 都命中 `if (connectPromise) return connectPromise`，返回这个死 Promise，导致 `await connect()`（sendMessage / restoreSession / enqueueMessage / sendReliable）永久挂起：**输入框锁死在 sending 态、消息发不出去、无任何报错与提示**，只能刷新页面。
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
- **建议**：`disconnect()` 中同步 `connectPromise = null`，并在 `onclose` 的早退分支里对仍持有的 `connectPromise` 做 reject；同时清空 `pendingCallbacks` / `activeExecutionIds` / `cancelledExecutionIds` / `suppressedStreamSessions` / `messageSavedCallbacks` / `pendingSkillSyncDones`，避免换号登录后残留跨用户状态。另给 `connect()` / `sendReliable()` 增加超时 reject 兜底。

---

## 问题 F2：删除会话后 Tab 状态永久残留，`sessionTabsMap` 无界增长

- **位置**：`desktop/src/composables/useCenterTabs.ts:360`（定义）、`desktop/src/components/task/TaskIndexPanel.vue:953`（删除调用处，未清理）
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

## 问题 F3：MCP 编辑态保存会静默清空启动参数，导致 STDIO 服务器保存直接 400 失败

- **位置**：`desktop/src/views/settings/McpServersView.vue:355-382`（`openEdit` + `handleSubmit`）、`desktop/src/views/settings/McpServersView.vue:331`（`parseArgs`）；后端 `backend-ts/src/harness/mcp/service/mcp-server.service.ts:271-275`、`:314`
- **级别**：**P0**
- **类别**：功能模块
- **现象**：UI 提示「编辑时不显示已保存的值，留空则保留原值」，但 `handleSubmit` 中 `args` 恒为 `form.args.map(...)`。当原服务器 `argsJson` 为 `null` 时 `parseArgs` 返回 `[]`，提交 `args: []`；后端 `if (args != null) server.argsJson = JSON.stringify(args)` 会**真的把 argsJson 写成 `'[]'`**（不是保留原值），随后 `validateRequiredFields` 对 STDIO 要求 `argsJson !== '[]'`，直接抛「STDIO 类型必须填写启动参数」。即：**编辑一个 STDIO 服务器、只改描述、不动参数，保存必定失败**，而用户看不到任何明确原因。
- **代码**：
```ts
    args: form.serverType === 'STDIO' ? form.args.map((a) => a.trim()).filter(Boolean) : undefined,
```
```ts
    // 后端 mcp-server.service.ts:271  —— 传 [] 会覆盖，而非"保留原值"
    if (args != null) {
      server.argsJson = JSON.stringify(args);
    }
    // 后端 :314 —— 随后必然失败
    if (!hasText(server.argsJson) || server.argsJson === '[]') {
      throw new BusinessException(ErrorCode.PARAM_MISSING, 'STDIO 类型必须填写启动参数');
    }
```
- **建议**：前端编辑态用「脏标记」——只有用户真正改动过 args/env 才放进 payload（`openEdit` 时存 `originalArgs` 快照做浅比较）。同时把提示文案改为与后端一致：「启动参数为必填，修改后立即生效」。

---

## 问题 F4：微信扫码轮询永不超时，且 `catch` 分支在错误时继续排队

- **位置**：`desktop/src/views/settings/WeixinBotView.vue:188-241`
- **级别**：**P0**
- **类别**：功能模块
- **现象**：`pollStatus` 在 `wait` / `scaned` / **以及 `catch`** 三个分支都无限 `setTimeout` 重新排队，**没有任何总时长上限**（对比 `FeishuBotView` 有总超时保护）。网络持续失败时轮询会一直在后台打 `/weixin/qrcode/status`；设置页内组件常驻（切 tab 不卸载），`onUnmounted` 的清理不生效。
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
- **建议**：仿 `FeishuBotView` 增加 `pollStartedAt` + 总超时（如 5 分钟）后 `stopStatusPolling()` 并提示「二维码已过期，请重新获取」；`catch` 中连续失败 N 次后停止；监听 `dialogVisible` 变 false 时立即停止轮询。

---

## 问题 F5：Markdown 渲染白名单放行 `onclick`，用户上传的 SKILL.md 存在注入面

- **位置**：`desktop/src/composables/useMarkdown.ts:62-72`、`admin/src/views/session/composables/useMarkdown.ts:44-46`；消费点 `desktop/src/components/common/MarkdownContent.vue:2`、`admin/src/views/session/components/MessageGroup.vue:41,54`
- **级别**：**P0**
- **类别**：功能模块（安全）
- **现象**：两处 `DOMPurify.sanitize(result, { ADD_ATTR: ['onclick', 'target'] })` 显式把 `onclick` 加进属性白名单，理由只是保留代码块「复制」按钮的内联 `onclick`。`ADD_ATTR` 会合并进 `ALLOWED_ATTR` 白名单并在事件属性过滤前生效，因此 **`onclick` 确实会被保留**。技能包是用户自助上传的不可信输入（SKILL.md → v-html 渲染），这是「为局部便利牺牲全局安全默认值」。缓解因素是 marked 的 `html` renderer 被重写为 `escapeHtml`，直接注入标签已被转义。
- **代码**：
```ts
// onclick 为代码块复制按钮自带，内容侧已全部转义
const SANITIZE_OPTIONS = { ADD_ATTR: ['onclick', 'target'] }
return DOMPurify.sanitize(result, SANITIZE_OPTIONS)
```
- **建议**：改为事件委托——渲染 `<button class="code-copy-btn" data-code="...">`（不带 onclick），在容器上监听 click 用 `e.target.closest('.code-copy-btn')` 读取 `textContent` 复制。这样 DOMPurify 保持默认严格配置，同时能加复制成功/失败反馈（顺带修 F31）。

---

# 二、P1：明显体验缺陷 / 高频路径错误

## 问题 F6：快捷指令面板自动弹出后，Enter 被劫持，用户无法正常发送

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

## 问题 F7：`detectAutoComplete` 未排除 URL / 路径，粘贴链接必定触发面板

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

## 问题 F8：模型编辑弹窗回填明文 API Key，未改动时把服务端值原样 PUT 回去

- **位置**：`admin/src/views/model/ModelFormDialog.vue:169`（`apiKey: props.modelData.apiKey || ''`）、`:201-203`；配合 `backend-ts/src/model/model.routes.ts:34-37`（reveal 判据）
- **级别**：P1（可升级为 P0，见下）
- **类别**：功能模块
- **现象**：后端按 `model:write` 权限决定是否 reveal 明文（`toVO(m, reveal)`），否则返回 `maskApiKey(...)`（`sk-****xxxx`）。前端**无条件回填**服务端返回值。拥有 `model:write` 的用户编辑时不改 Key 直接保存，会把真实值原样 PUT 回去（无害但明文往返）；而一旦 reveal 判据与前端回填不同步（权限刚变更、缓存了旧的列表对象），**掩码串会被当成新密钥写回**，导致该模型调用全部鉴权失败，且界面无任何提示。
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

## 问题 F9：`pendingCallbacks` 注册用错 key，会话切换后 await 永不 resolve

- **位置**：`desktop/src/composables/useChat.ts:718`（`restoreSession` 内）
- **级别**：P1
- **类别**：功能模块
- **现象**：该函数用 `sessionId.value!` 注册回调。若注册与终态到达之间用户切走会话，终态 `session_status` 到达时 `pendingCallbacks.get(sid)` 为 undefined，回调永不 resolve → UI 卡在「执行中」。对比同文件 `:425`、`:512`、`:650`、`:869` 均已改为先捕获 `const sid` 再用 `sid`，此处是唯一遗漏。
- **代码**：
```ts
        if (sessionId.value && !pendingCallbacks.has(sessionId.value)) {
          new Promise<void>((resolve, reject) => {
            pendingCallbacks.set(sessionId.value!, { resolve, reject })   // 未捕获快照
          })
```
- **建议**：改为先 `const sid = sessionId.value!` 再统一用 `sid`；并给该 Promise 加超时/中止兜底，避免任何单条路径能让 UI 永久卡死。

---

## 问题 F10：401 刷新 token 的 `finally` 时机错误，晚到的 401 请求永久挂起

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

## 问题 F11：`sendMessageWithQueue` 无条件 `return true`，取消/失败时清空输入导致内容丢失

- **位置**：`desktop/src/composables/useChat.ts`（`sendMessageWithQueue`）、消费点 `desktop/src/components/chat/ChatPanel.vue`
- **级别**：P1
- **类别**：交互逻辑
- **现象**：`sendMessage` 有多条「静默 return」路径（LOCAL 模式用户取消目录选择、会话切换时 `requireCurrentSession` 失败、校验失败），都**不返回 false**，`sendMessageWithQueue` 仍返回 true。ChatPanel 据此清草稿 + 清空输入框 → 用户刚输入的长文本与附件被清空，而消息其实根本没发出去。
- **代码**：
```ts
async function sendMessageWithQueue(text, files, pendingUploads?): Promise<boolean> {
  if (isActive.value) { return enqueueMessage(text, files, pendingUploads) }
  await sendMessage(text, files, pendingUploads)
  return true          // ← 内部早退也返回 true
}
```
- **建议**：`sendMessage` 改为返回 boolean，所有早退路径返回 false；`sendMessageWithQueue` 返回 `await sendMessage(...)`；调用方仅在 `sent === true` 时清草稿与输入框。

---

## 问题 F12：`editAndResend` 早退不回滚已执行的乐观截断/改写

- **位置**：`desktop/src/composables/useChat.ts:611-621`（截断/改写）、`:636-639`（早退）
- **级别**：P1
- **类别**：功能模块
- **现象**：乐观截断与内容改写发生在 `await collectLocalUnsyncedSkills()` / `await collectAgentsMdContent()` **之前**；若这两段 await 期间会话被切走，函数在 `:637` 直接 `return`：既不发消息、也不回滚 → 该会话后续消息被永久截断、原消息内容已被改成新内容。用户看到历史「少了一截」，且无提示（回滚逻辑只写在 catch 里）。
- **代码**：
```ts
      sessionStore.truncateMessagesAfter(sid, messageId)
      sessionStore.updateMessageContent(sid, messageId, newContent, ...)
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

## 问题 F13：`retryExecution` 用不可靠 `send()`，失败静默丢弃但 `sending` 已置 true

- **位置**：`desktop/src/composables/useChat.ts:698-708`、`desktop/src/composables/useStreamWS.ts`（`retryExecution`）
- **级别**：P1
- **类别**：功能模块
- **现象**：`wsRetryExecution` 底层是不可靠的 `send()`，WS 未 OPEN 时只 `console.warn` 后丢弃。此时前端已把 `sending` 置 true，UI 显示转圈与「停止」按钮，但服务端从未收到重试请求；由于没注册 pendingCallback、也没有 toast，转圈可能一直持续，用户完全无感知。
- **代码**：
```ts
    sending.value = true
    sessionStore.clearExecutionError(sid)
    wsRetryExecution(sid)                    // 返回值被丢弃
```
- **建议**：`retryExecution` / `cancel` 改用 `sendReliable` 并返回 boolean；`useChat.retryExecution` 在 `sent === false` 时复位 `sending` 并提示「重试失败，网络连接不可用」。

---

## 问题 F14：`sortGroups` 把未排序的新分组顶到列表最前

- **位置**：`desktop/src/composables/useTaskPanelPrefs.ts:142`（两处独立实现，TaskIndexPanel 侧同逻辑）
- **级别**：P1
- **类别**：功能模块
- **现象**：用户拖过一次顺序后，当时存在的所有 key 都进了 `groupOrder`。之后新增的分组（新工作区 / 新 CLOUD 项目）不在 `groupOrder` 里 → 落入 `unknown` 且被拼在 `known` **之前**，直接顶到列表最上方，把用户排好的顺序整体压下去，必须再拖一次才稳定。
- **代码**：
```ts
    return [...unknown, ...known]     // 未知分组反而排在用户排好序的分组之前
```
- **建议**：改为 `[...known, ...unknown]`（未知分组追加在末尾，保持用户既有顺序）；`unknown` 内部沿用已有的默认排序逻辑。

---

## 问题 F15：Git 凭证列表把 Token 渲染成无意义的 `Token: ****`

- **位置**：`desktop/src/views/settings/GitCredentialsView.vue:47`；后端 `backend-ts/src/user/git-credential.routes.ts:38`
- **级别**：P1
- **类别**：功能模块
- **现象**：后端 VO 已把 `accessToken` **固定返回** `'****'`，前端又原样渲染 `Token: ****`。用户看到「有一个 token 字段，值是四个星号」，既无法确认是否已配置，也无法区分「已设置」与「未设置」——纯噪音字段。（注：`git-credential.service.ts` 已实现 `maskToken()` 可返回有意义的掩码，但未在 VO 使用。）
- **代码**：
```vue
          <span class="credential-token">Token: {{ item.accessToken }}</span>
```
```ts
    accessToken: '****',   // 后端 git-credential.routes.ts:38
```
- **建议**：后端返回 `hasToken: boolean` 与 `maskedToken`（复用 `maskToken()`），前端渲染 `Token: ghp_****abcd` 或「未设置」，删除这个假字段。

---

## 问题 F16：MCP 编辑弹窗不重置校验状态，上一次的红色错误残留到下次打开

- **位置**：`desktop/src/views/settings/McpServersView.vue:100-107`（`el-dialog`）、`:355-369`（`openEdit`）
- **级别**：P1
- **类别**：交互逻辑
- **现象**：`el-dialog` 无 `destroy-on-close`，`formRef` 的校验状态在关闭后保留。操作路径：打开新增 → 名称留空点保存 → 出现「请输入名称」→ 关闭 → 再点「编辑」某服务器 → **弹窗一打开就带着上一次的红色错误**。`openEdit` 也未调用 `clearValidate()`。
- **代码**：
```vue
    <el-dialog
      v-model="formVisible"
      :title="isEdit ? `编辑服务器：${form.name}` : '新增 MCP 服务器'`
      width="640px" class="mcp-server-dialog" :close-on-click-modal="false"
    >
```
- **建议**：加 `@closed="onFormClosed"`，在其中 `formRef.value?.clearValidate()` 并重置 `form`；`openCreate/openEdit` 里也先 `nextTick(() => formRef.value?.clearValidate())`。

---

## 问题 F17：SkillDrawer 上传无任何文件类型/大小/数量校验，失败后静默

- **位置**：`desktop/src/components/skill/SkillDrawer.vue:563-590`
- **级别**：P1
- **类别**：功能模块
- **现象**：`uploadFiles` 直接把所有 `File` 塞进 `FormData`，没有单文件大小上限、总大小上限、数量上限、扩展名过滤。用户拖入含 `node_modules` 的技能目录会构造出几十上百 MB 的请求；后端限流返回 413/400 时前端 `catch` 是空的，用户只看到一条泛化错误 toast，不知道是文件太大。
- **代码**：
```ts
  const formData = new FormData()
  for (const file of files) {
    const relativePath = (file as any).webkitRelativePath || file.name
    formData.append('files', file, relativePath)
  }
```
- **建议**：上传前校验单文件 ≤ 5MB、总数 ≤ 200、总大小 ≤ 50MB，排除二进制与 `node_modules/`、`.git/`；超限用 `ElMessage.error` 明确提示并中断。

---

## 问题 F18：CommandDrawer 预填内容会强行覆盖用户正在编辑的表单

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

## 问题 F19：SessionSearchPopover 边路任务跳转缺少父会话时静默失败

- **位置**：`desktop/src/components/search/SessionSearchPopover.vue:193-197`
- **级别**：P1
- **类别**：交互逻辑
- **现象**：`handleJump` 对 `SIDE_TASK` 取 `parentId`，`if (!parentId) return` —— 但**函数开头已经执行了 `isOpen.value = false`**。用户点了结果、弹窗关了、什么都没发生，也没有任何提示。契约里 `parentSessionId` 可空，历史/脏数据下会命中此分支。
- **代码**：
```ts
async function handleJump(item: SessionSearchItem) {
  isOpen.value = false                 // ← 先关了
  if (item.sessionType === 'SIDE_TASK') {
    const parentId = String(item.parentSessionId ?? '')
    if (!parentId) return              // ← 静默失败
```
- **建议**：把 `isOpen.value = false` 移到校验通过之后；`!parentId` 时提示「该边路任务缺少父会话信息，无法跳转」并保留现场。

---

## 问题 F20：`types/electron.d.ts` 声明 `electronAPI` 为非可选，掩盖所有 Web 端崩溃点

- **位置**：`desktop/src/types/electron.d.ts:254-255`
- **级别**：P1
- **类别**：功能模块
- **现象**：`electronAPI: ElectronAPI` 声明为**必存在**，与运行时事实（Web / Android 无此对象）矛盾。后果：TypeScript 不强制调用方做存在性检查，代码里大量**无守卫的直接调用**在 Web 端会直接 `TypeError`，而 `vue-tsc` 也不会报错（类型说它一定存在）。这是「Web 端点按钮无反应」类问题的类型层根源。
- **代码**：
```ts
declare interface Window {
  electronAPI: ElectronAPI
}
```
- **建议**：改为 `electronAPI?: ElectronAPI`，让 `vue-tsc` 一次性暴露所有缺失守卫的调用点，再统一加 `if (!window.electronAPI) return` 降级。

---

## 问题 F21：ProfileView 邮箱字段完全没有校验

- **位置**：`desktop/src/views/settings/ProfileView.vue:62-65`
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

## 问题 F22：加载失败静默，用户看到「暂无数据」而非错误态（贯穿性问题）

- **位置**：`desktop/src/views/settings/McpServersView.vue:285-299`、`desktop/src/components/skill/SkillDrawer.vue:306-346`、`desktop/src/components/chat/...` 等 20+ 处
- **级别**：P1
- **类别**：功能模块
- **现象**：`load()` / `fetchSkills()` 只有 `try { ... } finally { loading = false }`，**没有 `catch`**。请求失败后列表保持空数组，模板渲染「暂无自定义服务器」「暂无已上传技能」——用户以为自己没有数据，实际是加载失败。错误 toast 由拦截器兜底，但页面仍停在误导性的空态，也没有重试入口。（同文件的 `fetchLocalSkills` 有 `localError` 做了正确示范，三个列表错误处理不一致。）
- **代码**：
```ts
async function load() {
  loading.value = true
  try {
    const [prefs, mine] = await Promise.all([getMcpServerPreferences(), getMyMcpServers()])
    ...
  } finally {
    loading.value = false     // ← 无 catch，失败后渲染"暂无数据"
  }
}
```
- **建议**：加 `loadError` ref，模板增加 `v-if="loadError"` 的错误态 + 「重试」按钮，与空态区分开。建议抽统一的 `useAsyncList` composable 收敛 loading / error / 竞态 / 重试逻辑，避免每处手写且行为不一致。

---

# 三、P2：一般优化

## 问题 F23：`ChatPanel` 加载历史的程序化滚动未被保护，导致自动滚动失效

- **位置**：`desktop/src/components/chat/ChatPanel.vue:534-556`
- **级别**：P2
- **类别**：交互逻辑
- **现象**：`loadOlderMessages()` 后恢复 `scrollTop = scrollHeight - oldScrollHeight`，这次**程序化跳跃没有被 `isProgrammaticScroll` 保护**（该标志只在 `scrollToBottom()` 里置位）。若恢复后的位置离底 >80px，`userScrolledUp` 被误置 true，**之后整个会话的流式输出都不再自动滚到底**，用户以为卡住了。
- **代码**：
```ts
    loadOlderMessages().then(() => {
      nextTick(() => {
        const el2 = messagesContainer.value
        if (el2) el2.scrollTop = el2.scrollHeight - oldScrollHeight  // ← 无保护
      })
    })
  }
  if (isProgrammaticScroll.value) return
  userScrolledUp.value = !isNearBottom()   // ← 这次滚动被误判为用户上滑
```
- **建议**：给恢复滚动包上 `isProgrammaticScroll = true/false`，并在加载更多刚完成的窗口期内直接 `return`。

---

## 问题 F24：MessageBubble 编辑态未做 IME 判断，中文确认候选词即提交

- **位置**：`desktop/src/components/chat/MessageBubble.vue:48-50`
- **级别**：P2（中文用户体感 P1）
- **类别**：交互逻辑
- **现象**：`@keydown.enter.ctrl/meta="handleConfirm"` 未做 `event.isComposing` 检查——用户在输入法组合态按 Ctrl+Enter 上屏候选词时会**误触发提交**。同理 Esc 在组合态（取消候选）也会直接退出编辑态，未保存的内容丢失。同项目 `ChatInput.vue:670` 已有正确的 IME 处理，此处是遗漏。
- **代码**：
```vue
      <textarea ref="editInput" v-model="editContent" class="edit-textarea"
        @keydown.escape="$emit('cancelEdit')"
        @keydown.enter.ctrl="handleConfirm"
        @keydown.enter.meta="handleConfirm"
```
- **建议**：三个 handler 首行均加 `if (event.isComposing || event.keyCode === 229) return`；Esc 取消编辑前判断内容是否已修改。

---

## 问题 F25：Rename 输入框用 `document.querySelector` 定位，聚焦到错误行

- **位置**：`desktop/src/components/task/TaskIndexPanel.vue:964-970`、`desktop/src/components/task/SideTaskList.vue:157-163`
- **级别**：P2
- **类别**：交互逻辑
- **现象**：`startEdit` 用 `document.querySelector('.session-title-input')` 取**文档中第一个**匹配元素。聚焦模式下主列表、历史区、已归档区三段共用同一 class。用户在靠后条目点「重命名」，焦点跳到最靠前的输入框并 `select()` 选中了**别的任务**的标题——接着输入就把别的任务标题改掉了。
- **代码**：
```ts
  nextTick(() => {
    const input = document.querySelector('.session-title-input') as HTMLInputElement
    if (input) { input.focus(); input.select() }
  })
```
- **建议**：改用模板 ref 数组，在 `v-for` 内绑定 `:ref="el => titleInputs[session.id] = el"`，`startEdit` 里按 id 取。

---

## 问题 F26：右键菜单不随面板滚动关闭，坐标残留在旧位置

- **位置**：`desktop/src/components/task/TaskIndexPanel.vue:674-686`（只监听 `click` / `keydown`）
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
- **建议**：补充 `window.addEventListener('scroll', closeContextMenu, true)`（capture 捕获内部滚动）与 `resize`。`CenterTabBar.vue:78` 的 tab 右键菜单同样缺失。

---

## 问题 F27：FileDiffViewer 的 Monaco model 在并发 watch 下泄漏

- **位置**：`desktop/src/components/center/FileDiffViewer.vue`（watch 配置 + `syncViewer` 内 `createModel`）
- **级别**：P2
- **类别**：功能模块
- **现象**：watch 源 `[() => props.change, isDark]` 且 `deep: true`。`props.change` 每次文件变更都替换对象引用触发 watch，而 `syncViewer` 是 async（含 `await loadMonaco()`，首次数百毫秒）。期间再触发一次就两次并发执行 `createModel`，**第一次创建的 model 引用被覆盖、永远没有 dispose**。Monaco model 全局注册，泄漏后直到页面刷新才释放。
- **代码**：
```ts
  watch(
    [() => props.change, isDark],
    () => { viewMode.value = 'preview'; void syncViewer() },   // 无并发保护
    { deep: true, flush: 'post', immediate: true },
  )
```
- **建议**：加 `let syncSeq = 0`，`syncViewer` 开头 `const seq = ++syncSeq`，每个 `await` 之后 `if (seq !== syncSeq) return`；或在 `createModel` 前无条件先 `disposeDiffEditor()`。

---

## 问题 F28：PdfViewer 串行 `getPage` 预取 + 全量 DOM slot，大 PDF 卡死

- **位置**：`desktop/src/components/center/PdfViewer.vue:25-33`（`v-for idx in numPages`）、加载循环
- **级别**：P2
- **类别**：UI样式 / 性能
- **现象**：为**每一页**创建 slot div + canvas。500 页 PDF 瞬间创建 1000 个 DOM 节点；加载期还有一个 `for (let i = 1; i <= doc.numPages; i++) await doc.getPage(i)` 的**串行**预取，500 次要串行 await，加载期间页面完全无响应，进度条停在 99%。
- **代码**：
```vue
  <div v-for="idx in numPages" :key="idx" :data-page-idx="idx - 1" :ref="setPageSlot"
       class="pdf-page-slot" :style="pageSlotStyle(idx - 1)">
    <canvas v-show="renderedPages.has(idx - 1)" ... class="pdf-canvas"></canvas>
```
- **建议**：引入虚拟滚动（只渲染可视窗口 ±2 页）；尺寸预取改为 `Promise.all` 分批（每批 20 页）或按需（`getPage` 在进入视口时才调）。

---

## 问题 F29：FileTree 筛选无防抖 + 深度 6 全量展开，大仓库卡死

- **位置**：`desktop/src/components/file-browser/FileTree.vue:207-215`
- **级别**：P2
- **类别**：交互逻辑 / 性能
- **现象**：`watch(filterText)` 每输入一个字符就触发 `loadAllDirectories(treeData.value, 0, 6)`，对整棵树递归 6 层、对**每个未加载目录**并发发起 `listDirectory`。在 `node_modules` 上，一次输入产生数百个并发目录请求，页面假死数秒；输入 "package" 会触发 7 轮完整遍历。
- **代码**：
```ts
  watch(filterText, async (val) => {
    const keyword = val.trim()
    if (!keyword) return
    const seq = ++filterSeq
    await loadAllDirectories(treeData.value, 0, 6)   // 无防抖，全树 6 层并发展开
    if (seq !== filterSeq) return
    filterVersion.value++
  })
```
- **建议**：加 300ms 防抖；`loadAllDirectories` 限制并发数（如每批 8 个）；对 `node_modules`、`.git`、`.svn` 做黑名单跳过。

---

## 问题 F30：聚焦模式排序做 O(n²) 全表 `find`，大列表卡顿

- **位置**：`desktop/src/components/task/TaskIndexPanel.vue:481-485`（`SideTaskList.vue:88-92` 同款）
- **级别**：P2
- **类别**：功能模块 / 性能
- **现象**：排序后对**每一项**都做一次 `sessionStore.focusedSessions.find(...)`，整体 O(n²)。n=500 时约 12.5 万次字符串比较，而该 computed 在 WS 每推一次 phase 变更就重算，造成明显掉帧。
- **代码**：
```ts
  const focusedSessions = computed<Session[]>(() =>
    sortByFocusPriority(sessionStore.focusedSessions.map(sessionToFocusCandidate))
      .map(c => sessionStore.focusedSessions.find(s => String(s.id) === String(c.id)))
      .filter((s): s is Session => !!s)
  )
```
- **建议**：先建 `Map<string, Session>` 再按 id 取，降为 O(n)。

---

## 问题 F31：代码块复制按钮 `opacity: 0` 仅 hover 显示，触屏/键盘不可达且无反馈

- **位置**：`admin/src/views/session/components/ToolCallCard.vue:131-133` 及对应 CSS
- **级别**：P2
- **类别**：交互逻辑
- **现象**：`copyText` 只调 `navigator.clipboard.writeText(text)`，无成功/失败反馈——非 HTTPS 环境下 `navigator.clipboard` 为 `undefined`，会直接抛 `TypeError` 静默失败。另外 `.copy-btn` 默认 `opacity: 0`，只有 `:hover` 才显示：触屏设备没有 hover，按钮永远不可见也点不到；键盘 Tab 能聚焦但 `opacity: 0` 在部分浏览器仍不可见，且无 `:focus-visible` 规则。
- **代码**：
```ts
  function copyText(text: string) {
    navigator.clipboard.writeText(text)     // 无反馈、无降级
  }
```
```css
  .copy-btn { opacity: 0; transition: opacity 0.15s, color 0.15s; }
  .code-block-wrapper:hover .copy-btn { opacity: 1; }
```
- **建议**：加反馈与降级（`navigator.clipboard?.writeText(...).then(success).catch(fallback execCommand)`）；加 `.copy-btn:focus-visible { opacity: 1 }`，并在 `@media (hover: none)` 下常驻显示。

---

## 问题 F32：硬编码颜色绕开主题变量，暗色主题下失效（贯穿性问题）

- **位置**：典型代表 —— `desktop/src/components/task/SubagentList.vue:106-107`（相位圆点 `#3a8f5c` / `#c44` / `#d4a017`，整个组件无 `[data-theme="dark"]` 块）、`desktop/src/components/ScheduledTaskPanel.vue:167-221`（`#67c23a` / `#909399` / `#c0c4cc`）、`desktop/src/components/common/TopNav.vue:466-469`（`.theme-toggle.active` 硬编码 `rgba(0,102,204,0.1)`，同文件其它 hover 都有 dark 覆盖，唯独 active 遗漏）、`desktop/src/components/task/GitChangeTreeNode.vue:169-206`、`desktop/src/views/settings/WeixinBotView.vue:429-433`、`admin/src/components/TabBar.vue:155`
- **级别**：P2
- **类别**：UI样式
- **现象**：项目已建立完整的 CSS 变量体系（`desktop/src/style.css` 定义了 `--aw-*` 与 `[data-theme="dark"]` 覆盖块），但仍有若干组件直接写死颜色。暗色背景下这些硬编码值与深色卡片对比度极低（如 `#909399` 灰点在 `#1a1a22` 上几乎不可辨识），或出现突兀的浅色块（TopNav 的 active 态浅蓝底）。同为右侧栏的 `SideTaskList.vue` 对同类圆点用的是 `var(--aw-success)` 并配了完整暗色块，两处风格不一致。
- **代码**：
```css
.subagent-phase-dot.waiting { background: #d4a017; }
.subagent-phase-dot.completed { background: #3a8f5c; }
.subagent-phase-dot.failed { background: #c44; }
```
```css
.theme-toggle.active {
  color: var(--aw-primary);
  background: rgba(0, 102, 204, 0.1);   /* 无 dark 覆盖 */
}
```
- **建议**：统一改用语义化变量 `var(--aw-warning/success/danger)`、`var(--aw-accent-bg)`、`var(--aw-primary-lighter)`，并补齐缺失的 `[data-theme="dark"]` 覆盖块。可用 `grep -rn '#[0-9a-fA-F]\{6\}' desktop/src admin/src --include=*.vue` 全量排查。

---

## 问题 F33：`.nav-left` 无条件为 macOS 红绿灯预留 78px

- **位置**：`desktop/src/components/common/TopNav.vue:342`
- **级别**：P2
- **类别**：UI样式
- **现象**：该缩进只为 macOS（`titleBarStyle:'hiddenInset'` + `trafficLightPosition`）服务，但 Windows / Linux Electron、普通浏览器都会多出 78px 空白（`style.css` 仅对 `html.android-capacitor` 覆盖为 0）。表现为 Windows/Linux 客户端左侧图标组离窗口边缘很远、Web 端导航整体右偏，窄窗口下还会挤压右侧图标区。
- **代码**：
```css
  padding-left: 78px; /* space for macOS traffic lights */
```
- **建议**：参照 `markAndroidCapacitor()`（`main.ts:14-28`）的做法，bootstrap 时按 macOS+Electron 给 `<html>` 打 `mac-electron` 类，仅该类下保留 78px。

---

## 问题 F34：终端 Tab 标题按 `/` 切分，Windows 路径失效

- **位置**：`desktop/src/components/terminal/TerminalTabs.vue`（`formatTabTitle`）；`desktop/src/composables/useTerminal.ts` 内同类 `split('/').pop()`
- **级别**：P2
- **类别**：UI样式
- **现象**：Windows 上 cwd 形如 `C:\Users\me\repo`，`split('/')` 得到单元素数组，`pop()` 返回整条路径 → Tab 标题变成完整路径。Tab 栏是 `overflow-x:auto` 且隐藏滚动条，宽 Tab 会把 `+` 新建按钮挤出可视区。
- **代码**：
```ts
  if (tab.cwd && tab.cwd !== '~') {
    const folderName = tab.cwd.split('/').filter(Boolean).pop()
    if (folderName) parts.push(folderName)
  }
```
- **建议**：统一用 `/[\\/]/` 正则切分，并对超长目录名加 `max-width + text-overflow: ellipsis` 截断。

---

# 四、跨模块共性问题小结

除了上面 34 条具体问题，审查中还发现几类**贯穿性**问题，建议单独立项治理：

1. **静默吞异常**：`catch { /* 拦截器已提示失败 */ }` 模式出现 20+ 次，导致所有列表页在请求失败时既无错误态也无重试入口，用户只能看到「暂无数据」（见 F22）。建议抽 `useAsyncList` composable 统一收敛 loading / error / 竞态 / 重试。

2. **删除二次确认靠行内 ✓/✗**：`GitCredentialsView`、`SkillDrawer` 等处点删除只切成行内确认态，无对话框说明危险；且 `catch` 空吞导致失败时确认态不复位（F15 相关）。建议统一改用 `ElMessageBox.confirm`，并把状态复位移到 `finally`。

3. **提交按钮无 in-flight 守卫**：`McpServersView`（部分）、`CommandDrawer`、`GitCredentialsView` 的保存按钮 `:disabled` 只校验表单合法性，请求期间仍可点击，连点会并发创建。建议统一加 `submitting` ref。

4. **硬编码颜色绕开主题变量**（F32）：建议加一条 CI 检查或在 `style.css` 中补齐缺失的语义化变量。

5. **Electron-only 能力缺少运行时守卫**（F20 相关）：`window.electronAPI` 在 Web / Android 不存在，但类型声明为必存在，掩盖了大量无守卫调用。先把类型改为可选，让 `vue-tsc` 暴露全部缺失点，再逐个加降级。

---

# 五、建议修复顺序

**第一批（P0，功能不可用 / 安全）**
1. F1 — WS `connectPromise` 死 Promise（发不出消息，只能刷新）
2. F2 — 删除会话后 Tab 状态泄漏（数据错乱）
3. F3 — MCP 编辑保存必定失败（STDIO 场景）
4. F4 — 微信扫码轮询无超时
5. F5 — `onclick` 白名单（安全，有干净替代方案）

**第二批（P1 高频路径）**
6. F6 / F7 — 输入框 Enter 被面板劫持（最高频的体感问题）
7. F9 / F10 / F11 — 三类「永久挂起 / 静默丢内容」
8. F8 — 模型 API Key 掩码写回
9. F14 / F25 — 排序与焦点错位（会改错数据）
10. F22 — 加载失败静默（影响面最广）

**第三批（P2 体验与性能）**
11. F23 / F24 / F26 / F31 — 交互细节
12. F27 / F28 / F29 / F30 — 性能与内存
13. F32 / F33 / F34 — 主题与平台适配
