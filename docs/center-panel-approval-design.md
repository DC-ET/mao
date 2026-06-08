# 中间面板审批事项技术方案

## 1. 需求概述

### 1.1 问题

当前待审批事项（工具调用审批）仅展示在右侧面板（TaskInspector）中。当右侧面板收起时，用户无法看到或操作待审批事项，导致 Agent 工具执行被阻塞，用户体验断裂。

### 1.2 目标

将审批事项同时展示在中间面板输入框上方，确保无论右侧面板是否收起，用户都能进行审批操作。

### 1.3 设计要点

- **位置**：中间面板，QueuePanel 与 ChatInput 之间
- **视觉形式**：堆叠卡片，多个审批请求纵向堆叠并带偏移，直观展示待处理数量
- **内容精简**：每个卡片显示标题 + 命令摘要 + 操作按钮（拒绝/执行）
- **命令折叠**：命令较长时默认折叠，可点击展开查看完整内容，可复制
- **右侧面板保留**：TaskInspector 中的审批保持不变，两处同步展示

---

## 2. 现状分析

### 2.1 数据流

```
Electron IPC (onToolApprovalRequest)
  → useChat.pendingApprovals (ref, 模块级)
    → TaskView.activePendingApprovals (computed, 按 sessionId 过滤)
      → TaskInspector.pendingApprovals (prop)
        → ToolApprovalBar (渲染)
```

**关键文件**：
- [useChat.ts](../desktop/src/composables/useChat.ts) — 审批数据管理（第 43 行 `pendingApprovals`，第 53-69 行 IPC 监听，第 486-493 行 `confirmApproval`）
- [TaskView.vue](../desktop/src/views/task/TaskView.vue) — 数据过滤与分发（第 228-230 行 `activePendingApprovals`）
- [TaskInspector.vue](../desktop/src/components/task/TaskInspector.vue) — 右侧面板渲染（第 66-75 行）
- [ToolApprovalBar.vue](../desktop/src/components/chat/ToolApprovalBar.vue) — 现有审批卡片组件

### 2.2 审批数据结构

```typescript
interface ApprovalItem {
  requestId: string      // 唯一标识
  toolName: string       // 'shell' | 'write_file' | 'edit_file'
  description: string    // 命令/文件路径内容
  dangerReason?: string  // 危险原因（可选）
  sessionId?: string     // 所属会话
}
```

### 2.3 中间面板布局（TaskView.vue 第 100-123 行）

```
.task-container (flex: 1, flex-direction: column)
  .messages              ← 消息列表，flex: 1，可滚动
  QueuePanel             ← 待发送队列（可选显示）
  ChatInput              ← 输入框
```

---

## 3. 方案设计

### 3.1 新增组件：ApprovalStack

创建独立组件 `desktop/src/components/chat/ApprovalStack.vue`，与 `ToolApprovalBar` 职责分离。

**Props**：
```typescript
defineProps<{
  items: ApprovalItem[]
}>()

defineEmits<{
  confirm: [requestId: string, approved: boolean]
}>()
```

### 3.2 堆叠卡片交互

**展示逻辑**：
- 只有最顶层（最后一张）卡片可交互（按钮可点击、命令可展开）
- 点击执行/拒绝后，该卡片移除，下一张自动露出
- 卡片移除时带淡出动画

**堆叠样式**：
```css
.stack-container {
  position: relative;
  height: <最顶层卡片高度 + 偏移量>;
}

.stack-card {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  transition: transform 0.3s, opacity 0.3s;
}

/* 后面的卡片向上偏移 + 缩小，逐层递进 */
.stack-card:nth-last-child(2) {
  transform: translateY(-6px) scale(0.97);
  opacity: 0.7;
}
.stack-card:nth-last-child(3) {
  transform: translateY(-12px) scale(0.94);
  opacity: 0.4;
}
/* 第 4 张及以后不单独偏移，统一叠在第 3 层位置 */
.stack-card:nth-last-child(n+4) {
  transform: translateY(-12px) scale(0.94);
  opacity: 0;
}
```

> 偏移量和缩放比例需实际调试确认，以上为初始值。

**数量指示**：当 items.length > 1 时，在卡片右上角显示数量 badge（如 `3`）。

### 3.3 单张卡片内容

```
┌──────────────────────────────────────────────────┐
│ [!] 命令执行待审批                          [x3] │
│                                                  │
│  $ rm -rf /tmp/old_cache                         │
│  [展开] [复制]                                    │
│                                                  │
│  [ 拒绝 ]                    [ 执行 ]            │
└──────────────────────────────────────────────────┘
```

- **标题**：复用 `ToolApprovalBar` 的 `titleMap`（shell → "命令执行待审批"，write_file → "文件写入待审批"）
- **命令区域**：
  - `description` 长度 ≤ 120 字符：直接显示，单行截断 + 省略号
  - `description` 长度 > 120 字符：默认折叠，显示前 120 字符 + "..."，下方显示 [展开] 按钮
  - 点击展开后显示完整内容，按钮变为 [收起]
  - [复制] 按钮始终可见
- **dangerReason**：不在此处展示（保持精简，完整信息查看右侧面板）
- **操作按钮**：横向排列，左侧拒绝（灰色），右侧执行（主色）

### 3.4 位置插入

在 `TaskView.vue` 的 `.task-container` 中，QueuePanel 与 ChatInput 之间插入 ApprovalStack：

```html
<!-- TaskView.vue 模板 -->
<div class="task-container">
  <div class="messages">...</div>

  <QueuePanel ... />

  <!-- 新增：输入框上方审批 -->
  <ApprovalStack
    v-if="activePendingApprovals.length > 0"
    :items="activePendingApprovals"
    @confirm="confirmApproval"
  />

  <ChatInput ... />
</div>
```

### 3.5 数据流（无变化）

```
useChat.pendingApprovals
  → TaskView.activePendingApprovals  ← 已有 computed，无需修改
    ├→ TaskInspector.pendingApprovals  ← 保持不变
    └→ ApprovalStack.items            ← 新增传入
```

`confirmApproval` 方法已存在（useChat.ts 第 486-493 行），直接复用。

---

## 4. 样式规范

### 4.1 容器

```css
.approval-stack {
  flex-shrink: 0;
  margin-bottom: 8px;
  position: relative;
  /* 高度由最顶层卡片 + 偏移量动态计算 */
}
```

### 4.2 单张卡片

```css
.stack-card {
  background: var(--aw-surface-pearl);
  border: 1px solid var(--aw-warning);
  border-radius: var(--aw-radius-lg);
  padding: 12px 14px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}
```

### 4.3 与 QueuePanel 的视觉区分

| 元素 | QueuePanel | ApprovalStack |
|------|-----------|---------------|
| 背景 | `var(--aw-canvas-parchment)` | `var(--aw-surface-pearl)` |
| 边框 | `var(--aw-hairline)` | `var(--aw-warning)` |
| 圆角 | `12px` | `var(--aw-radius-lg)` |
| 视觉语义 | 信息/队列 | 警告/待操作 |

---

## 5. 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `desktop/src/components/chat/ApprovalStack.vue` | **新建** | 堆叠审批卡片组件 |
| `desktop/src/views/task/TaskView.vue` | **修改** | 导入 ApprovalStack，插入到 QueuePanel 与 ChatInput 之间 |

共涉及 1 个新文件、1 个修改文件。不改动 useChat、TaskInspector、ToolApprovalBar。

---

## 6. 验证要点

1. **基础功能**：右侧面板收起时，在中间面板可正常审批（执行/拒绝）
2. **堆叠效果**：2-3 个审批请求时，卡片堆叠偏移可见，仅顶层可交互
3. **命令折叠**：长命令默认折叠，点击展开/收起，复制功能正常
4. **动画**：审批通过/拒绝后卡片淡出，下一张平滑露出
5. **同步一致性**：中间面板操作后，右侧面板（若展开）同步移除对应项
6. **无审批时**：没有待审批事项时，ApprovalStack 不占空间
7. **右侧面板**：原有审批功能不受影响
