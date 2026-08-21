# 文件引用功能设计文档

## 1. 需求概述

在桌面端聊天输入框中，用户输入 `@` 符号时弹出当前工作区的文件列表面板，支持按文件名过滤，选中后以标签形式插入编辑器。发送消息时，Agent 收到被引用文件的完整绝对路径。

**核心价值**：让用户在对话中快速引用工作区文件，无需手动复制粘贴路径，Agent 可以直接读取被引用的文件内容。

## 2. 现状分析

### 2.1 输入框架构

聊天输入基于 **TipTap 富文本编辑器**（`desktop/src/components/chat/ChatInput.vue`），已支持：
- 自定义 `QuickCommandNode` 内联节点（技能/指令标签）
- 触发机制：输入 `/` 或 `、` 打开 `QuickCommandPanel`
- 键盘导航：方向键选择、Enter 确认、Escape 关闭

### 2.2 工作区

| 执行模式 | 工作区来源 | 文件访问方式 |
|---------|-----------|------------|
| LOCAL | 用户通过目录选择器指定本地路径 | Electron IPC 访问本地文件系统 |
| CLOUD | 后端自动生成：`{workspace-root}/{userId}/{sessionId}` | 后端直接访问服务器文件系统 |

- 云端工作区根目录：`/opt/mao/data/workspace`（配置项 `app.path-sandbox.workspace-root`）
- 工作区路径存储在 `Session.workspace` 字段

### 2.3 消息发送

通过 WebSocket `send_message` 事件，payload 结构：
```json
{
  "type": "send_message",
  "sessionId": 123,
  "data": {
    "content": "用户文本（含 ${skill}$ 和 #{command}# 标记）",
    "eventId": "uuid",
    "images": ["https://oss-url"]
  }
}
```

后端 `StreamingWsHandler.handleSendMessage()` 解析 content 后直接传入 Agent 执行。

## 3. 功能设计

### 3.1 触发方式

在 TipTap 编辑器中输入 `@` 字符触发文件选择面板，规则：

- `@` 前必须是文本开头或空白字符（避免邮箱地址等误触发）
- `@` 与光标之间不能有空格（空格表示放弃选择）
- 触发后面板显示工作区文件列表，随用户继续输入实时过滤

检测逻辑与现有 `detectSlashTrigger()` 平行，在 `editor.onUpdate` 回调中新增 `detectAtTrigger()` 方法。

### 3.2 文件选择面板

新增组件 `FileReferencePanel.vue`，位于 `desktop/src/components/chat/`。

**交互行为**：
- 面板以浮层（popover/dropdown）形式出现在输入框上方
- 展示当前工作区的文件树（仅文件，不展示空目录）
- 支持输入文本按文件名模糊过滤（路径匹配），输入防抖 300ms
- 键盘操作：`↑`/`↓` 移动选中、`Enter` 确认选择、`Escape` 关闭面板
- 鼠标点击亦可选中
- 文件数量上限：单次最多展示 20 条结果
- 默认展示工作区根目录下的文件（递归，但排除隐藏文件和常见忽略目录）
- 排序规则：按文件修改时间倒序（最近修改的优先展示）

**排除规则**：
- 隐藏文件/目录（以 `.` 开头）
- `node_modules`、`__pycache__`、`.git`、`target`、`dist`、`build` 等常见构建产物目录

### 3.3 文件列表获取

需要根据执行模式从不同来源获取文件列表：

**LOCAL 模式**：
- 通过 Electron IPC 调用本地文件系统扫描
- 新增 IPC 通道：`listWorkspaceFiles(workspace, filter)`
- Electron main 进程执行目录遍历，返回文件路径列表（相对于工作区的相对路径）

**CLOUD 模式**：
- 调用后端 REST API 获取文件列表
- 新增接口：`GET /api/v1/files/workspace-list?sessionId={id}&filter={keyword}`
- 工作区路径由后端根据 sessionId 自动推导，不接受客户端传入 workspace 参数
- 后端扫描指定工作区目录，返回文件列表

前端统一封装为 `listWorkspaceFiles(workspace, filter, executionMode)` 工具函数，根据模式分发到对应数据源。

### 3.4 TipTap 节点 — FileReferenceNode

新增 TipTap 扩展 `FileReferenceNode.ts`，位于 `desktop/src/components/chat/tiptap/`。

**设计原则**：与现有 `QuickCommandNode` 保持一致的架构模式。

```
节点类型：inline, atomic, non-draggable, selectable
属性：
  - filePath: string  // 文件相对路径（相对于工作区根目录）
渲染：
  - 编辑器内：蓝色标签，显示文件名（仅最后一段），hover 显示完整相对路径
  - 如：📄 config/app.yml
序列化文本格式：@{config/app.yml}@
```

**序列化格式说明**：

采用 `@{...}@` 标记，与现有 `${...}$`（技能）和 `#{...}#`（指令）风格一致。路径使用相对于工作区的相对路径，避免绝对路径过长。

### 3.5 消息序列化

TipTap 编辑器中 FileReferenceNode 存储的是相对路径，序列化为 `@{相对路径}@` 格式。

发送前，前端在 `useChat.sendMessage()` 中将相对路径替换为绝对路径：
- 拼接规则：`workspace + "/" + 相对路径`
- LOCAL 模式：workspace 为用户选择的本地目录
- CLOUD 模式：workspace 为后端自动生成的隔离目录

采用绝对路径的原因：同一个任务会话内不存在切换工作区的场景，路径在会话生命周期内始终有效。

编辑器内序列化示例：
```
请帮我检查 @{src/config/app.yml}@ 的配置是否正确
```

发送给后端的 content 示例：
```
请帮我检查 @{/opt/mao/data/workspace/1/100/src/config/app.yml}@ 的配置是否正确
```

### 3.6 后端处理

后端 `StreamingWsHandler` 收到消息后，将 content 中的 `@{...}@` 标记**原地替换为文件绝对路径的纯文本**（去除 `@{` 和 `}@` 标记符号），与 `${skill_name}$` 的处理方式类似。

替换前：
```
请帮我检查 @{/opt/mao/data/workspace/1/100/src/config/app.yml}@ 的配置是否正确
```

替换后（传给 LLM 的实际内容）：
```
请帮我检查 /opt/mao/data/workspace/1/100/src/config/app.yml 的配置是否正确
```

Agent 收到的是普通文件路径文本，可直接通过 ReadFile 等工具读取，无需理解特殊标记语法。

### 3.7 消息展示

消息气泡中渲染文件引用标签，复用现有 `QuickCommandTag.vue` 的模式，新增 `FileReferenceTag.vue`：
- 显示文件名图标 + 文件名
- hover 提示完整路径
- 可点击：LOCAL 模式下用系统文件管理器打开所在目录

解析逻辑更新 `quick-command-parser.ts`，在 `parseQuickCommandSegments()` 中新增 `@{...}@` 模式识别，segment type 为 `'file'`。

## 4. 前端改动清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `desktop/src/components/chat/FileReferencePanel.vue` | 文件选择浮层面板 |
| `desktop/src/components/chat/tiptap/FileReferenceNode.ts` | TipTap 内联节点扩展 |
| `desktop/src/components/chat/FileReferenceTag.vue` | 消息气泡中的文件引用标签 |

### 修改文件

| 文件 | 改动内容 |
|------|---------|
| `desktop/src/components/chat/ChatInput.vue` | 新增 `detectAtTrigger()` 检测逻辑；注册 FileReferenceNode 扩展；集成 FileReferencePanel；处理文件选中事件 |
| `desktop/src/composables/useChat.ts` | 发送消息前将文件引用的相对路径解析为绝对路径 |
| `desktop/src/utils/quick-command-parser.ts` | 新增 `@{...}@` 模式解析，支持 `file` segment type |
| `desktop/src/utils/chatMessage.ts` | 消息 segment 构建逻辑中处理 `file` 类型 |
| `desktop/electron/preload.cjs` | 新增 `listWorkspaceFiles` IPC 桥接 |
| `desktop/electron/main.cjs` | 实现 `listWorkspaceFiles` 的本地文件扫描逻辑 |
| `desktop/src/types/electron.d.ts` | ElectronAPI 类型声明中新增 `listWorkspaceFiles` |

### 后端新增

| 文件 | 改动内容 |
|------|---------|
| `backend/.../file/controller/FileController.java` | 新增 `GET /v1/files/workspace-list` 接口 |
| `backend/.../file/service/FileService.java` | 实现工作区文件扫描逻辑 |

## 5. API 设计

### 5.1 获取工作区文件列表（云端模式）

```
GET /api/v1/files/workspace-list?sessionId={id}&filter={keyword}&limit=20
```

**Query 参数**：
- `sessionId`（必填）：会话 ID，后端根据此 ID 自动推导工作区路径
- `filter`（可选）：文件名过滤关键词
- `limit`（可选，默认 20）：最大返回数量

**响应**：
```json
{
  "code": 0,
  "data": {
    "files": [
      { "path": "src/config/app.yml", "name": "app.yml", "size": 1024 },
      { "path": "src/main/java/App.java", "name": "App.java", "size": 2048 }
    ]
  }
}
```

- `path` 为相对于工作区根目录的路径
- `name` 为文件名
- `size` 为文件字节数

**安全约束**：
- 工作区路径由后端根据 sessionId 自动推导，不接受客户端传入（防止路径穿越）
- 仅返回文件，不返回目录条目
- 排除隐藏文件和常见忽略目录

### 5.2 Electron IPC 通道

```typescript
// preload.cjs 新增
listWorkspaceFiles: (workspace: string, filter?: string, limit?: number) => Promise<WorkspaceFile[]>

interface WorkspaceFile {
  path: string   // 相对路径
  name: string   // 文件名
  size: number   // 字节数
}
```

## 6. 面板交互细节

### 6.1 触发与关闭

| 操作 | 行为 |
|------|------|
| 输入 `@`（满足触发条件） | 打开面板，展示工作区文件列表 |
| 继续输入字符 | 实时过滤文件列表 |
| `Enter` | 选中当前高亮文件，插入标签 |
| `Escape` | 关闭面板，保留已输入的 `@` 及过滤文本 |
| `Backspace` 删除 `@` | 关闭面板 |
| 点击面板外区域 | 关闭面板，保留已输入文本 |
| 选中文件后 | 插入 FileReferenceNode 标签 + 尾部空格，光标移至空格后 |

### 6.2 面板定位

复用 `QuickCommandPanel` 的定位策略：基于 TipTap 编辑器光标位置计算浮层坐标。

### 6.3 空状态

- 工作区为空时：提示"工作区内暂无文件"
- 过滤无结果时：提示"未找到匹配的文件"

## 7. 与快捷指令的共存

文件引用（`@`）与快捷指令（`/`、`、`）互不冲突：
- 触发字符不同，检测逻辑独立
- 同一条消息中可以同时包含文件引用和快捷指令
- TipTap 编辑器中两种节点各自独立，互不干扰

## 8. 不在本期范围内

以下能力不在本次需求范围内：
- 多文件同时引用（一次 `@` 只选一个文件）
- 文件夹引用（仅引用具体文件）
- 文件内容预览（面板中不展示文件内容）
- 引用文件时自动读取并注入上下文（由 Agent 自行决定是否读取）
- 管理后台（admin）的文件引用支持（admin 为只读会话查看，无输入框）
