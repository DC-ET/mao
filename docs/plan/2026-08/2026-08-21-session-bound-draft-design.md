# 会话输入框草稿绑定（Session-bound Input Draft）技术设计

## 1. 需求背景

用户在某个会话的输入框中输入内容后切换到其他会话，输入框中的内容会"跟着"出现在新会话的输入框里。这导致：

- 误发送：为会话 A 准备的内容被不小心发到会话 B；
- 内容丢失：切回会话 A 时，原来写的草稿已被覆盖；
- 多会话并行工作时无法为不同会话分别准备待发内容。

期望行为：**输入框草稿与会话绑定**——切换到其他会话时不带走内容，切回原会话时恢复原草稿。

## 2. 需求描述

### 2.1 要做的

| # | 行为 | 说明 |
|---|------|------|
| 1 | 主会话输入框按会话绑定草稿 | 切换会话时，当前输入框内容（文本 + 待发图片/文件）存入当前会话的草稿槽位，并从目标会话的草稿槽位恢复 |
| 2 | 「新建任务」模式独立草稿 | 所有入口的新建任务共用一个虚拟键 `new`，其草稿独立于任何会话保存和恢复 |
| 3 | 边路任务输入框显式草稿绑定 | 每个边路任务 tab 的输入框草稿按 tab 键显式管理，覆盖 KeepAlive 缓存被挤出（`max=20`）后重挂载的场景 |
| 4 | 草稿内容完整保存恢复 | 文本（含快捷指令/@文件引用等富文本节点）+ 待发图片/文件列表 + 图片预览 |
| 5 | 发送成功即清空对应草稿 | 消息保存确认后清除该会话的草稿槽位（无论此时用户停留在哪个会话） |
| 6 | 会话删除时清除草稿 | 删除主会话、删除边路任务、边路任务晋升为主会话时，同步清除对应草稿 |
| 7 | 登出时清空全部草稿 | 与 `useSessionStore().reset()` 同步清理，防止账号间串数据 |

### 2.2 明确不做的

| # | 不做的事 | 理由 |
|---|----------|------|
| 1 | 不做 localStorage / 服务端持久化 | 已决策：仅内存缓存。刷新页面/重启应用后草稿丢失，属预期行为 |
| 2 | 不做会话列表「有草稿」角标 | 已决策：保持列表 UI 不变 |
| 3 | 不做光标位置保存恢复 | 收益低，TipTap 光标跨文档恢复易错 |
| 4 | 不改 SubagentChatPanel | 只读面板，无输入框 |
| 5 | 不改后端 | 纯前端功能，无 API / DB 变更 |
| 6 | 不做草稿字数上限、过期时间等策略 | 内存缓存生命周期内无需额外策略 |
| 7 | 不影响 Web / Electron / 安卓任一端差异 | 三端共用同一份 desktop 前端代码，天然一致生效 |

### 2.3 草稿生命周期规则

| 事件 | 行为 |
|------|------|
| 切换会话 / 切换新建任务 / 切换边路 tab | 保存旧键草稿 → 恢复新键草稿 |
| 发送成功（消息保存确认） | 清空本次发送目标键的草稿 |
| 发送失败 / 等待保存超时 | 保留草稿（现状逻辑已保留输入框内容） |
| 关闭边路任务 tab | **保留**草稿，重新打开该 tab 时恢复 |
| 删除会话 / 删除边路任务 / 晋升边路任务 | 清空对应草稿 |
| 登出 | 清空全部草稿 |
| 刷新页面 / 重启应用 | 草稿丢失（内存缓存的预期行为） |

---

## 3. 现状分析

### 3.1 问题根因

主会话聊天面板 `desktop/src/components/chat/ChatPanel.vue` 是**单实例组件**，内部持有一个 `ChatInput` 实例。切换会话时通过 watch `sessionStore.activeSessionId` 触发 `restoreSession()`（ChatPanel.vue:234），该流程只恢复消息区内容，**完全不感知输入框状态**——输入框是同一个 DOM 实例，内容自然"跟着走"。

### 3.2 相关代码现状

| 文件 | 现状 |
|------|------|
| `desktop/src/components/chat/ChatInput.vue` | 输入框组件，基于 TipTap 富文本；内部维护 `pendingFiles`（待发文件）、`filePreviewUrls`（blob 预览）；对外暴露 `focusInput / insertFileReference / clearInput`；无任何草稿概念 |
| `desktop/src/components/chat/ChatPanel.vue` | 主会话面板，单实例；watch `activeSessionId` 切换会话；`isNewTaskMode` 时复用同一输入框展示新建任务配置栏；发送成功后调 `chatInputRef.clearInput()`（有 `sendGeneration` 防陈旧清空机制） |
| `desktop/src/components/chat/SideChatPanel.vue` | 边路任务面板，每个 tab 一个实例，由 CenterTabContainer 的 `<KeepAlive :max="20">` 缓存；`props.tabId` 在 sideSessionId 从占位变为正式 ID 后保持不变（SideChatPanel.vue:157 注释），可作为稳定缓存键 |
| `desktop/src/components/center/CenterTabContainer.vue` | `<KeepAlive :max="20">` 缓存所有面板；超过 20 个时最旧的实例会被销毁重挂载——边路任务草稿因此需要显式保存 |
| `desktop/src/stores/session.ts` | 已有按会话维度的内存缓存模式（`sessionMessages` Map 等），`deleteSession()`（session.ts:992）是删除会话的唯一收口 |
| `desktop/src/views/task/TaskView.vue` | `handleDeleteSideTask` / `handlePromoteSideTask`（TaskView.vue:581-602）关闭边路 tab 并移除边路任务 |
| `desktop/src/stores/auth.ts` | `logout()` 中调用 `useSessionStore().reset()`（auth.ts:87），是登出清理的收口 |
| `desktop/src/composables/useCenterTabs.ts` | tab id 规则：主会话固定 `'chat'`，边路 `'side:{id}'`（占位期 `side:-{timestamp}`，创建后 tab.id 不变） |

---

## 4. 技术选型

| 决策点 | 选型 | 理由 |
|--------|------|------|
| 存储位置 | 新建独立 Pinia store（`stores/draft.ts`） | 与现有 `sessionMessages` 等按会话维度的 store 缓存模式一致；Pinia store 可被任意组件/store 访问，便于在 `sessionStore.deleteSession`、`auth.logout` 等收口处联动清理 |
| 存储介质 | 仅内存（`Map<key, DraftEntry>`） | 已决策。避免 localStorage 序列化 File 对象、容量清理、多端同步等复杂度 |
| 草稿键（key）约定 | 主会话 `s:{sessionId}`；新建任务 `new`；边路任务直接用 `tabId`（`side:{id}`） | 三类键空间互不冲突；边路 tabId 天然稳定且与消息占位缓存键（`placeholderCacheKey`）同源 |
| 文本序列化 | TipTap `getHTML()` 存取 + `setContent()` 恢复 | 完整保留快捷指令节点、@文件引用节点等自定义富文本结构；纯 `getText()` 会丢失节点语义 |
| 待发文件 | 直接持有 `File` 对象引用与既有 blob URL | 内存缓存下 File/blob 无需序列化；恢复时预览图直接复用，不重复 `createObjectURL` |
| 保存时机 | 键变化时 + 组件卸载时（事件驱动，非逐键敲入同步） | 键切换瞬间编辑器内容尚未变动，watcher 的 `(newKey, oldKey)` 参数即可完成"先存旧、再取新"；卸载时兜底覆盖 KeepAlive 淘汰场景；无需在 onUpdate 高频写 Map |
| 测试 | Vitest 单测覆盖 draft store；UI 层靠 vue-tsc + 手工验证 | 与现有 `useChat.test.ts` 模式一致；desktop 单测脚本 `npm run test:unit` 已存在 |

---

## 5. 详细设计

### 5.1 新建 `desktop/src/stores/draft.ts`

```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface DraftEntry {
  /** TipTap 编辑器 HTML（含 quickCommand / fileReference 自定义节点） */
  html: string
  /** 纯文本（用于日志排查与空判断） */
  text: string
  /** 待发文件/图片（File 对象引用） */
  files: File[]
  /** 与 files 一一对应的 blob 预览 URL（'' 表示非图片） */
  filePreviewUrls: string[]
}

export const useDraftStore = defineStore('draft', () => {
  const drafts = ref<Map<string, DraftEntry>>(new Map())

  function getDraft(key: string): DraftEntry | undefined {
    return drafts.value.get(key)
  }

  /** 写入草稿；内容为空时改为删除条目，避免空壳堆积 */
  function setDraft(key: string, entry: DraftEntry): void {
    const isEmpty = !entry.text.trim() && entry.files.length === 0
    drafts.value = new Map(drafts.value)
    if (isEmpty) {
      drafts.value.delete(key)
      return
    }
    drafts.value.set(key, entry)
  }

  function hasDraft(key: string): boolean {
    return drafts.value.has(key)
  }

  function clearDraft(key: string): void {
    drafts.value = new Map(drafts.value)
    drafts.value.delete(key)
  }

  /** 登出时全量清空 */
  function reset(): void {
    drafts.value = new Map()
  }

  return { drafts, getDraft, setDraft, hasDraft, clearDraft, reset }
})
```

要点：
- `setDraft` 对空内容执行删除而非存储，保证"空草稿"不留痕；
- 每次 `new Map(...)` 触发响应式更新，与 `sessionEntities` 的写法一致。

### 5.2 `ChatInput.vue` 改造

新增 prop 与草稿读写逻辑：

```ts
const props = withDefaults(defineProps<{ /* ...现有 props... */
  /** 草稿绑定键：主会话 's:{id}' / 新建任务 'new' / 边路任务 tabId；null 表示暂不绑定（加载过渡期） */
  draftKey?: string | null
}>(), { /* ... */ draftKey: null })
```

三个挂载点：

1. **挂载时恢复**：`onMounted` 中调用 `restoreDraft(props.draftKey)`。
2. **键变化时先存后取**：

```ts
watch(() => props.draftKey, (newKey, oldKey) => {
  saveDraft(oldKey)
  restoreDraft(newKey)
})
```

3. **卸载时兜底保存**：`onBeforeUnmount` 中调用 `saveDraft(props.draftKey)`（覆盖 KeepAlive 淘汰、路由离开等场景）。

核心函数：

```ts
function saveDraft(key?: string | null) {
  if (!key || !editor.value) return
  draftStore.setDraft(key, {
    html: editor.value.getHTML(),
    text: editorContent.value,
    files: [...pendingFiles.value],
    filePreviewUrls: [...filePreviewUrls.value],
  })
}

function restoreDraft(key?: string | null) {
  if (!editor.value) return
  const d = key ? draftStore.getDraft(key) : undefined
  if (d) {
    editor.value.commands.setContent(d.html || '')
    editorContent.value = d.text
    pendingFiles.value = d.files
    filePreviewUrls.value = d.filePreviewUrls
    uploadingFiles.value = d.files.map(() => false)
  } else {
    editor.value.commands.clearContent()
    editorContent.value = ''
    pendingFiles.value = []
    filePreviewUrls.value = []
    uploadingFiles.value = []
  }
}
```

注意点：
- 恢复的文件都是本地已完成选择的 `File`，不存在上传中状态，`uploadingFiles` 全部置 `false`；
- blob URL 归属权随草稿转移：保存时**不** revoke，仅在 `clearInput()` 和组件真正销毁且草稿已清空时 revoke（见下）；
- `onBeforeUnmount` 现有逻辑会 revoke 所有预览 URL 并置空数组——需调整顺序：先 `saveDraft`，再判断该键是否仍有草稿条目，**有则跳过 revoke**（URL 所有权已归草稿），无则照旧 revoke。

`clearInput()` 联动清草稿：

```ts
function clearInput() {
  // ...现有清空逻辑不变...
  draftStore.clearDraft(props.draftKey ?? '')
}
```

发送成功路径由父组件调用 `clearInput()`，草稿随之清除，无需父组件额外操作（但父组件仍需处理"发送期间用户已切走"的边界，见 5.3）。

### 5.3 `ChatPanel.vue` 接入

计算当前草稿键并传给 `ChatInput`：

```html
<ChatInput :draft-key="currentDraftKey" ... />
```

```ts
const currentDraftKey = computed<string | null>(() => {
  if (isNewTaskMode.value) return 'new'
  return sessionStore.activeSessionId ? `s:${sessionStore.activeSessionId}` : null
})
```

- 加载过渡期（`initialLoading` 且无 activeSessionId）返回 `null`，ChatInput 跳过存取，避免把瞬态空内容误存或误恢复。

发送成功清草稿的边界处理（`handleSend` 内）：

```ts
async function handleSend(text: string, files: File[], pendingUploads?: File[]) {
  // ...
  const draftKeyAtSend = currentDraftKey.value   // 发送前捕获目标键
  // 队列路径
  if (isActive.value) {
    const sent = await sendMessageWithQueue(text, files, pendingUploads)
    if (sent) {
      if (draftKeyAtSend) draftStore.clearDraft(draftKeyAtSend)
      chatInputRef.value?.clearInput()
      nextTick(scrollToBottomSmooth)
    }
    return
  }
  // 首条消息路径
  const generation = ++sendGeneration
  waitingForSave.value = true
  try {
    const saved = await sendMessageAndWaitForSave(text, files, pendingUploads)
    // 无论用户是否已切走，草稿都已发出，必须清掉目标键
    if (saved && draftKeyAtSend) draftStore.clearDraft(draftKeyAtSend)
    if (saved && generation === sendGeneration) {
      chatInputRef.value?.clearInput()
    }
  } finally {
    if (generation === sendGeneration) waitingForSave.value = false
  }
  nextTick(scrollToBottomSmooth)
}
```

关键边界：发送等待保存期间用户切走会话时，`sendGeneration` 机制保证不清错编辑器 UI（现状已有），而新增的 `clearDraft(draftKeyAtSend)` 保证**旧会话的草稿槽位**被正确清除——否则切回旧会话会看到已发出的内容残留在草稿里。

### 5.4 `SideChatPanel.vue` 接入

- 传入 `:draft-key="tabId"`（即 `props.tabId`，与 `placeholderCacheKey` 同源，占位→正式 ID 演变过程中保持稳定）；
- `handleChatSend` 成功路径同样处理：发送前捕获 `props.tabId`，保存确认回调 `finishWaiting(true)` 中除 `chatInputRef.clearInput()` 外，`draftStore.clearDraft(capturedTabId)`（`clearInput` 内部已按当前键清除，此处捕获是为覆盖极端时序，二者幂等）；
- KeepAlive 淘汰重挂载场景由 ChatInput 的 `onMounted` 恢复 + `onBeforeUnmount` 兜底保存覆盖，本组件无需额外代码。

### 5.5 清理钩子

| 触发点 | 文件 | 改动 |
|--------|------|------|
| 删除会话 | `stores/session.ts` `deleteSession()` | 函数末尾追加 `useDraftStore().clearDraft(`s:${id}`)` —— 收口在此处，覆盖所有删除入口 |
| 删除边路任务 | `views/task/TaskView.vue` `handleDeleteSideTask` | 关闭 tab 处追加 `useDraftStore().clearDraft(tab.id)` |
| 边路任务晋升 | `views/task/TaskView.vue` `handlePromoteSideTask` | 同上，关闭 tab 时清除该 tab 草稿 |
| 登出 | `stores/auth.ts` `logout()` | `useSessionStore().reset()` 旁追加 `useDraftStore().reset()` |

> 关闭边路 tab（未删会话）**不**清草稿——已决策保留，重新打开恢复。

### 5.6 各端生效说明

Web 浏览器端、Electron 桌面端、安卓壳（Capacitor 远程加载同一 Web 资源）共用本套前端代码，改动即三端同时生效，无平台分支代码。

---

## 6. 实现步骤

1. **新建 `desktop/src/stores/draft.ts`**：按 5.1 实现 store。
2. **新建 `desktop/src/stores/draft.test.ts`**：单测覆盖 set/get/clear/reset、空内容删除语义、File 引用保留。
3. **改造 `ChatInput.vue`**：新增 `draftKey` prop；实现 `saveDraft/restoreDraft`；接入 `onMounted` / watch / `onBeforeUnmount`；调整预览 URL revoke 顺序；`clearInput` 联动清草稿。
4. **接入 `ChatPanel.vue`**：`currentDraftKey` 计算属性并传 prop；`handleSend` 两条路径按 5.3 清草稿。
5. **接入 `SideChatPanel.vue`**：传 `:draft-key="tabId"`；发送成功清草稿。
6. **接入清理钩子**：`session.ts deleteSession`、`TaskView.vue` 两处、`auth.ts logout`。
7. **验证**：`cd desktop && npm run build`（vue-tsc 类型检查）+ `npm run test:unit`；按第 8 节手工验证。
8. **CHANGELOG**：根 `CHANGELOG.md` 顶部新版本小节的 `前端` 小节记录本改动（用户可见行为变更）。

## 7. 落地清单

| 文件 | 改动类型 | 内容 |
|------|----------|------|
| `desktop/src/stores/draft.ts` | 新增 | 草稿 store（Map + get/set/clear/has/reset） |
| `desktop/src/stores/draft.test.ts` | 新增 | store 单测 |
| `desktop/src/components/chat/ChatInput.vue` | 修改 | `draftKey` prop；save/restore；挂载/键变/卸载三挂载点；revoke 顺序调整；`clearInput` 清草稿 |
| `desktop/src/components/chat/ChatPanel.vue` | 修改 | `currentDraftKey` 计算属性；`handleSend` 成功路径清目标键草稿（两条发送路径） |
| `desktop/src/components/chat/SideChatPanel.vue` | 修改 | 传 `draft-key="tabId"`；发送成功清草稿 |
| `desktop/src/stores/session.ts` | 修改 | `deleteSession()` 追加 `clearDraft('s:'+id)` |
| `desktop/src/views/task/TaskView.vue` | 修改 | `handleDeleteSideTask` / `handlePromoteSideTask` 追加 `clearDraft(tab.id)` |
| `desktop/src/stores/auth.ts` | 修改 | `logout()` 追加 `useDraftStore().reset()` |
| `CHANGELOG.md` | 修改 | 顶部版本小节 `前端` 条目 |

不改动的文件：`CenterTabContainer.vue`、`SubagentChatPanel.vue`、`useCenterTabs.ts`、后端全部、admin 全部。

## 8. 手工验证清单

1. 会话 A 输入文字 + 拖入一张图片 → 切到会话 B：B 输入框为空；切回 A：文字与图片缩略图完整恢复。
2. 会话 A 含 @文件引用 / 快捷指令节点的草稿，切走再切回，节点渲染正常、可正常发送。
3. 新建任务模式输入草稿 → 切到任意会话 → 切回新建任务：草稿恢复；发送成功创建会话后再切回新建任务：输入框为空。
4. 会话 A 发送后立即切到会话 B，等保存确认到达后切回 A：输入框为空（草稿已随发送清除）。
5. Agent 执行中的会话 A 发送队列消息成功 → 草稿清除。
6. 打开 >20 个边路任务 tab 使 KeepAlive 淘汰最早的面板，再重新打开该 tab：草稿恢复。
7. 关闭边路任务 tab（不删任务）→ 重新打开：草稿恢复。
8. 删除边路任务 / 晋升边路任务：对应草稿清除。
9. 删除主会话：草稿清除（重建同名场景无残留）。
10. 登出 → 换账号登录：无任何残留草稿。
11. 刷新页面：草稿全部丢失（预期行为）。
12. 安卓壳 / 浏览器 / Electron 三端行为一致。

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| TipTap `setContent` 触发 `onUpdate` 造成 `editorContent` 不同步 | `restoreDraft` 中显式回写 `editorContent.value = d.text`，且 `setContent` 后 `onUpdate` 本就会以新内容触发一次，两者一致 |
| 恢复草稿与 GIT_SUGGEST_TEXT 自动填充 watcher 冲突 | 该 watcher 仅在 `editor.isEmpty` 时填充，恢复的非空草稿不会被覆盖；恢复的空草稿走正常自动填充逻辑 |
| 发送期间切会话导致清错草稿 | 目标键在发送前捕获（`draftKeyAtSend` / `capturedTabId`），与现有 `sendGeneration` UI 保护机制正交配合 |
| blob URL 泄漏 | 所有权规则单一：URL 随草稿转移，仅在 `clearInput` 或"卸载且无草稿条目"时 revoke |
