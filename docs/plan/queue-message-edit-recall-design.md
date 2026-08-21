# 队列消息撤回编辑 技术方案

## 1. 需求背景

消息队列功能上线后（见 `message-queue-design.md`），Agent 执行中用户发送的消息会进入队列等待自动消费。当前队列消息仅支持上移/下移/删除/立即发送，不支持编辑——用户发现已入队的消息写错了，只能删除后凭记忆重新输入，带图片的消息还要重新上传。

会话内最后一条用户消息的编辑能力已由 `edit_and_resend` 实现（`feature-edit-user-message.md`），但它要求 Agent 空闲，对队列中的消息完全不适用。

## 2. 需求描述

### 2.1 要做的

- 队列面板中每条待发送消息提供「编辑」入口
- 点击编辑后，该消息从队列中删除，文本与图片回填到底部输入框，用户修改后重新发送
- 回填时若输入框已有未发送草稿，弹确认框告知将被覆盖，用户确认后才执行撤回
- 图片以「fetch URL → 转 File」方式回填到附件区，完全复用现有附件预览/删除/重发链路
- 重新发送时走现有 `sendMessageWithQueue` 链路：Agent 忙则排到队尾，Agent 空闲则直接执行
- desktop 端主聊天面板（ChatPanel）与边路任务面板（SideChatPanel）均支持

### 2.2 不做的

- **不做队列内联编辑**（不提供队列条目原位展开 textarea 的编辑态）
- **不做「编辑中」锁定状态**（原条目立即删除，不做置灰锁定、不做多端编辑锁同步）
- **不做插回原位置**（编辑后重发一律排队尾，不新增指定位置入队协议）
- **不改任何后端代码与 WS 协议**（撤回复用 `delete_queue_message`，重发复用 `enqueue_message`）
- **不做 mao-agent CLI 的 `/queue` 编辑**（终端本地内存队列生命周期极短，不纳入范围）
- **不做 admin 端改动**
- **不做切换会话时的草稿保护**（撤回内容与普通草稿同等对待，切会话不清空不提示）

## 3. 现状分析（代码级事实）

### 3.1 队列链路现状

| 环节 | 位置 | 说明 |
|------|------|------|
| 入队 | `backend-ts/src/session/ws/streaming-ws-handler.ts` `handleEnqueueMessage` | 消息持久化到 `message_queue` 表，图片在上传后以 URL 存库 |
| 删除 | `streaming-ws-handler.ts:802` `handleDeleteQueueMessage` | 校验归属后逻辑删除，广播 `queue_updated` |
| 自动消费 | Agent 执行完成回调 dequeue 头部消息 | 发送即移除 |
| 前端面板 | `desktop/src/components/chat/QueuePanel.vue` | 主面板与边路面板共用，emit `insert/delete/reorder` |
| 前端接线 | `ChatPanel.vue:48`、`SideChatPanel.vue:53` | `<QueuePanel @insert @delete @reorder>` |

### 3.2 输入框现状

- `ChatInput.vue:296` 待发附件为本地 `File[]`（`pendingFiles`），预览用 `filePreviewUrls`
- `ChatInput.vue:1111` 已 expose `focusInput / insertFileReference / clearInput`，其中 `clearInput()` 统一清理文本与附件
- 草稿在切换会话时不被清空（无跨会话清空逻辑）

### 3.3 关键差异

队列消息的图片是**已上传的 URL**，输入框附件是**本地 File 对象**。撤回回填必须完成 URL→File 的形态转换，转换后重发会再上传一次（产生一份重复存储副本，可接受）。

## 4. 技术选型与决策记录

| # | 决策项 | 结论 | 理由 |
|---|--------|------|------|
| 1 | 编辑交互 | **撤回到输入框** | 复用输入框全部编辑能力（富文本、@引用、附件管理），实现成本最低 |
| 2 | 原条目去向 | **立即删除** | 实现简单；丢失风险由草稿冲突确认兜底 |
| 3 | 图片回填 | **fetch 转 File** | 完全复用现有附件链路，改动集中一处；代价是重发时重新上传一次 |
| 4 | 重发位置 | **排到队尾** | 零新增协议，复用 `enqueue_message` |
| 5 | 草稿冲突 | **覆盖前弹确认** | 兼顾安全与流畅 |
| 6 | 功能范围 | **仅 desktop** | Web/Electron/安卓三端共用 UI 自然生效 |
| 7 | 切换会话 | **不特殊处理** | 与现有草稿行为一致，零额外逻辑 |

## 5. 整体设计

### 5.1 撤回流程

```
用户点击队列条目「编辑」
  → ChatPanel.handleQueueEdit(msg)
    → ① chatInputRef.hasDraft() 为 true？
        → 是：ElMessageBox.confirm「输入框已有内容，撤回将覆盖，是否继续？」
             取消 → 结束（队列条目不动）
        → 否：继续
    → ② 并发 fetch 全部图片 URL → Blob → File[]
        任一失败 → ElMessage.error 提示，结束（队列条目保留，不丢数据）
    → ③ useChat.deleteQueueMessage(msg.id)   // 现有方法，后端广播 queue_updated
    → ④ chatInputRef.restoreContent(text, files)
        （内部先 clearInput() 再回填 editorContent + pendingFiles）
    → ⑤ chatInputRef.focusInput()
```

### 5.2 重发流程（全部复用现有链路，零改动）

```
用户修改后点击发送
  → ChatInput emit send → sendMessageWithQueue(text, files)
    → Agent 忙碌 → enqueueMessage → 图片重新上传 → WS enqueue_message → 排到队尾
    → Agent 空闲 → sendMessage 直接执行
```

### 5.3 竞态说明（接受，不做防护）

从点击编辑到步骤③删除完成的秒级窗口内，若该消息恰好被自动消费（Agent 完成、轮到它出队），删除请求会落空而输入框仍会回填内容——用户若再点发送会产生重复消息。该窗口极短、后果轻微（多一条消息），**不做加锁或二次校验**，删除固定在回填之前执行以缩小窗口。

## 6. 实现步骤

### 步骤 1：ChatInput 增加 expose 方法

**文件**：`desktop/src/components/chat/ChatInput.vue`

`defineExpose`（当前 1111 行）增加两个方法：

```typescript
/** 输入框是否有未发送内容（文本或附件） */
function hasDraft(): boolean {
  return editorContent.value.trim().length > 0 || pendingFiles.value.length > 0
}

/** 清空当前内容后回填文本与图片附件（图片需已完成 URL→File 转换） */
function restoreContent(text: string, files: File[]) {
  clearInput()
  if (text) {
    editor.value?.commands.setContent(`<p>${escapeHtml(text)}</p>`)
    editorContent.value = text
  }
  for (const file of files) addPendingImageFile(file) // 复用现有粘贴/选择图片的入列逻辑（生成预览 URL）
}
```

`defineExpose({ focusInput, insertFileReference, clearInput, hasDraft, restoreContent })`

注意：富文本回填需对原文做 HTML 转义，防止队列文本中的 `<` `>` 破坏编辑器文档结构。

### 步骤 2：URL→File 工具函数

**文件**：`desktop/src/utils/file.ts`（新建；ChatPanel 与 SideChatPanel 两处使用，不放组件内）

```typescript
/** 将图片 URL 转为 File；任一失败即整体抛错，由调用方决定中止 */
export async function fetchImagesAsFiles(urls: string[]): Promise<File[]> {
  const files: File[] = []
  for (const url of urls) {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`图片获取失败: ${url}`)
    const blob = await resp.blob()
    const name = url.split('/').pop()?.split('?')[0] || `image-${Date.now()}.png`
    files.push(new File([blob], name, { type: blob.type || 'image/png' }))
  }
  return files
}
```

串行 fetch 即可（队列消息图片上限 10 张，量小），避免并发打满连接。

### 步骤 3：QueuePanel 增加编辑按钮

**文件**：`desktop/src/components/chat/QueuePanel.vue`

- 操作区（`queue-item-actions`）在「立即发送」左侧新增编辑按钮（铅笔图标，样式复用 `.action-btn`）
- emits 增加 `edit: [msg: QueueMessage]`（传整条消息，调用方需要 text 与 images 两个字段）

### 步骤 4：ChatPanel 接线

**文件**：`desktop/src/components/chat/ChatPanel.vue`

```typescript
async function handleQueueEdit(msg: QueueMessage) {
  if (chatInputRef.value?.hasDraft()) {
    try {
      await ElMessageBox.confirm('输入框已有未发送内容，撤回将覆盖，是否继续？', '编辑队列消息', {
        confirmButtonText: '覆盖并编辑', cancelButtonText: '取消', type: 'warning',
      })
    } catch { return }
  }
  let files: File[] = []
  try {
    files = msg.images?.length ? await fetchImagesAsFiles(msg.images) : []
  } catch {
    ElMessage.error('图片获取失败，已取消编辑')
    return
  }
  await deleteQueueMessage(msg.id)
  chatInputRef.value?.restoreContent(msg.content, files)
  nextTick(() => chatInputRef.value?.focusInput())
}
```

模板 `<QueuePanel>`（48 行处）增加 `@edit="handleQueueEdit"`。

### 步骤 5：SideChatPanel 接线

**文件**：`desktop/src/components/chat/SideChatPanel.vue`

与步骤 4 相同的逻辑接入其自身的 QueuePanel 与 ChatInput ref（边路面板的 QueuePanel 带 `sessionId` prop，其余一致）。

### 步骤 6：构建与回归

- `cd desktop && npx vue-tsc --noEmit && npm run build` 通过
- `cd backend-ts && npm test` 回归（零后端改动，确认无意外破坏）

## 7. 边界情况

| 场景 | 行为 |
|------|------|
| 输入框有草稿时点编辑 | 弹确认框；取消则什么都不发生 |
| 图片 fetch 失败（网络抖动/URL 过期） | toast 提示，中止撤回，队列条目保留 |
| 撤回后 Agent 变空闲再发送 | 直接执行不入队（`sendMessageWithQueue` 现有判断） |
| 撤回后切换会话再发送 | 消息发到新会话，与普通草稿行为一致，不拦截 |
| 撤回瞬间消息被自动消费 | 见 5.3 竞态说明，接受 |
| 带图片消息撤回后重发 | 图片重新上传，产生新的存储副本，原副本成为孤儿（不做清理） |
| 队列只剩这一条消息 | 撤回后面板隐藏（`v-if="queueMessages.length > 0"` 现有逻辑），输入框正常回填 |

## 8. 测试要点

手动验证（桌面端）：

- [ ] Agent 忙碌时入队 A、B 两条 → 点 B 的编辑 → B 从队列消失，输入框回填 B 的文本，附件区出现 B 的图片缩略图
- [ ] 输入框有草稿时点编辑 → 出现覆盖确认框 → 取消无任何变化；确认后草稿被替换
- [ ] 修改内容后发送，Agent 仍忙碌 → 消息出现在队列末尾
- [ ] 修改内容后发送，Agent 已空闲 → 消息直接执行
- [ ] 断网状态下点带图消息的编辑 → toast 报错，队列条目仍在
- [ ] 撤回后刷新页面 → 队列中无该条目（已删除持久化）
- [ ] 边路任务面板重复以上核心路径
- [ ] 含 HTML 特殊字符（如 `<div>`）的队列消息撤回后文本完整显示

自动化：

- backend-ts 单测无需新增（零后端改动），跑全量回归
- 根目录 Playwright 不强制覆盖本功能（队列场景依赖 Agent 运行态，成本高）

## 9. 落地清单

| 文件 | 动作 | 内容 |
|------|------|------|
| `desktop/src/components/chat/ChatInput.vue` | 修改 | 新增 `hasDraft()`、`restoreContent()` 并加入 defineExpose |
| `desktop/src/utils/file.ts` | 新建 | `fetchImagesAsFiles()` |
| `desktop/src/components/chat/QueuePanel.vue` | 修改 | 操作区新增编辑按钮，emits 增加 `edit` |
| `desktop/src/components/chat/ChatPanel.vue` | 修改 | `handleQueueEdit()` + `@edit` 接线 |
| `desktop/src/components/chat/SideChatPanel.vue` | 修改 | 同 ChatPanel 的接线 |
| `backend-ts/**` | **无改动** | — |
| `agent-cli/**` | **无改动** | — |
| `admin/**` | **无改动** | — |
| `CHANGELOG.md` | 实现合入时 | 在当期版本「前端」小节记录：队列消息支持撤回到输入框编辑 |

## 10. 设计决策记录

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 撤回 vs 内联编辑 | 撤回 | 复用输入框能力，避免在窄条队列条目里再做一套编辑态 UI |
| 删除时机 | 回填之前 | 缩小自动消费竞态窗口；删除失败（已被消费）时输入框仍有副本供用户处置 |
| 图片形态转换位置 | 前端 fetch | 后端存 URL 是既定事实，前端转换让附件链路零改造 |
| 协议 | 零新增 | `delete_queue_message` + `enqueue_message` 语义完全匹配，不动后端 |
