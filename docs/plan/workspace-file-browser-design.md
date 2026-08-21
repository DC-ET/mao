# 工作区文件浏览器设计文档

> 版本：v3.0 | 日期：2026-06-25 | 状态：待开发

## 1. 需求概述

### 1.1 功能目标

在桌面客户端中集成工作区文件浏览器，提供目录树浏览和文件内容预览能力。目录树以右侧面板 Tab 形式呈现，文件内容预览以页签形式集成到中心区域，与对话页签并列切换。

### 1.2 核心需求

| 项目 | 描述 |
|------|------|
| 目录树 | 右侧面板新增「文件树」tab，与现有「工作区+进度」tab 并列，懒加载展开 |
| 文件预览 | 中心区域新增页签，支持同时打开多个文件 tab |
| 状态保全 | 对话和各文件 tab 独立保全状态，切换不影响 Agent 输出 |
| 排除规则 | 跳过 `.git`、`node_modules`、`__pycache__` 等，与 `list-workspace-files` 保持一致 |
| 权限 | 所有登录用户可用 |

### 1.3 V1 范围

**包含：**
- 右侧面板改造：现有 TaskInspector 原地改为 Tab 化面板，包含「工作区+进度」和「文件树」两个 tab
- 目录树：懒加载展开、文件图标、点击文件在中心区域打开预览 tab
- 中心区域页签系统：对话 tab（固定）+ 文件 tab（动态，可多个，无数量上限）
- 文件内容只读预览（带行号）
- 文件 tab 可关闭
- 状态保全（Vue keep-alive）
- 右侧面板宽度可拖拽调整（已有能力）

**不含（V2）：**
- 文件搜索（集成 glob/grep）
- 文件创建/编辑/删除
- 右键菜单（在资源管理器中打开、在终端中打开等）
- 文件变更高亮（与 Agent 操作联动）
- 语法高亮（V1 使用纯文本 + 行号）
- CLOUD 模式支持
- 文件 tab 拖拽排序
- 对话 tab 未读消息角标

## 2. 现状分析

### 2.1 已有能力

| 能力 | 位置 | 说明 |
|------|------|------|
| `list-workspace-files` IPC | `main.cjs:328` | 递归遍历返回文件列表（flat，无目录项），用于 `@` 文件引用 |
| `localReadFile` IPC | `preload.cjs` | 读取单个文件内容，支持 offset/limit 分页，返回 `{ content, total_lines }` |
| `resolveWorkspacePath()` | `main.cjs:90` | 相对路径 → 绝对路径解析 |
| `workspace` ref | `useChat.ts:77` | 当前会话的工作区路径，响应式 |
| 右侧面板模式 | `TaskInspector.vue` | 右侧可折叠面板，已有成熟的开关和动画逻辑，需改造为 Tab 化 |
| `usePanelLayout` composable | `composables/usePanelLayout.ts` | 面板折叠状态管理 |

### 2.2 缺失能力

| 缺失项 | 影响 |
|--------|------|
| 目录单层列表 IPC | 现有 `list-workspace-files` 只返回文件，不返回目录项，且是 flat 递归 |
| 文件树组件 | 无任何 Tree 相关组件 |
| 中心区域页签系统 | 当前 TaskView 中心区域是单一聊天视图，无 tab 切换机制 |
| 文件内容预览组件 | 无独立的代码/文本预览组件 |
| TaskInspector Tab 系统 | 现有 TaskInspector 是单一内容面板，无 tab 切换机制 |

## 3. 功能设计

### 3.1 整体布局

```
┌──────────────────────────────────────────────────────────────┐
│ TopNav                                                        │
├──────────────────────────────────────────────────────────────┤
│          │                                         │         │
│  Left    │  ┌───────────────────────────────────┐  │ 右侧面板│
│  Panel   │  │ [对话] [main.ts] [App.vue] [×]    │  │ ┌─────┐ │
│          │  ├───────────────────────────────────┤  │ │工作区│ │
│          │  │                                   │  │ │文件树│ │  ← Tab 切换
│          │  │   当前 tab 对应的内容区域           │  │ ├─────┤ │
│          │  │   （对话 或 文件预览）              │  │ │     │ │
│          │  │                                   │  │ │ 内容 │ │
│          │  │                                   │  │ │ 区域 │ │
│          │  └───────────────────────────────────┘  │ └─────┘ │
├──────────────────────────────────────────────────────────────┤
│ TerminalPanel (底部)                                          │
└──────────────────────────────────────────────────────────────┘
```

**核心变化**：
1. 中心区域（原 TaskView 的聊天区）从单一视图变为 **TabContainer**，包含一个固定「对话」tab 和若干动态「文件」tab。
2. 右侧面板（原 TaskInspector）原地改造为 **Tab 化面板**，包含「工作区+进度」和「文件树」两个 tab。

### 3.2 入口

**切换到文件树 tab**：
- 右侧面板顶部 tab 栏点击「文件树」

**打开文件预览 tab**：
- 在目录树中点击文件节点 → 在中心区域打开或激活对应的文件 tab

### 3.3 Tab 系统

#### 3.3.1 Tab 类型

| 类型 | 标题 | 关闭 | 保全 | 说明 |
|------|------|------|------|------|
| `chat` | 「对话」 | 不可关闭 | 是 | 固定 tab，始终存在 |
| `file` | 文件名 | 可关闭（×） | 是 | 动态 tab，点击目录树文件节点打开 |

#### 3.3.2 Tab 行为

- **打开文件**：点击目录树中的文件节点
  - 若该文件已有 tab → 切换到该 tab（不重复打开）
  - 若该文件无 tab → 新建 tab 并激活
- **关闭文件**：点击 tab 上的 × 按钮
  - 关闭当前激活的 tab → 自动切换到左侧相邻 tab
  - 关闭最后一个文件 tab → 自动切换到「对话」tab
- **切换**：点击 tab 标题切换

### 3.4 右侧面板改造

#### 3.4.1 面板结构

现有 TaskInspector 改造为 Tab 化面板，顶部新增 tab 栏切换不同内容：

```
┌──────────────────────────┐
│ [工作区+进度] [文件树]    │  ← Tab 栏
├──────────────────────────┤
│  📁 src/                 │  ← 文件树 tab 内容
│  📁 components/          │
│    📄 App.vue            │
│    📄 main.ts            │
│  📁 backend/             │
│    📄 pom.xml            │
│  📄 package.json         │
│  📄 README.md            │
│                          │
│          [刷新]          │  ← 底部操作栏
└──────────────────────────┘
```

**面板宽度**：默认 280px，可拖拽调整，范围 240px ~ 480px。

#### 3.4.2 Tab 行为

| Tab | 内容 | 说明 |
|-----|------|------|
| 工作区+进度 | 现有 TaskInspector 的内容 | 保持原有功能不变 |
| 文件树 | 目录树浏览 | 新增功能 |

#### 3.4.3 节点类型与图标

| 类型 | 图标 | 说明 |
|------|------|------|
| 文件夹（折叠） | `Folder` | 点击展开 |
| 文件夹（展开） | `FolderOpened` | 点击折叠 |
| 文件 | 按扩展名区分 | 点击打开预览 tab |

#### 3.4.4 文件图标映射（基于扩展名）

| 扩展名 | 图标 |
|--------|------|
| `.ts` `.js` `.vue` `.jsx` `.tsx` | `Document`（代码类） |
| `.md` `.txt` `.log` | `Document`（文本类） |
| `.json` `.yaml` `.yml` `.toml` | `Document`（配置类） |
| `.png` `.jpg` `.gif` `.svg` | `Picture` |
| 其他 | `Document`（默认） |

#### 3.4.5 展开行为

- 点击文件夹 → 调用 `listDirectory(path)` → 返回该目录的直接子项
- 子项按字母排序，文件夹在前、文件在后
- 已展开的文件夹再次点击则折叠（保留已加载数据，再次展开无需请求）
- **刷新**：保留已展开的目录状态，遍历 `expandedPaths` 集合，并行请求所有已展开路径的内容并更新对应节点的 children

#### 3.4.6 排除规则

与现有 `list-workspace-files` IPC handler 的排除规则完全一致，包括：
- 隐藏文件/目录（以 `.` 开头）
- `node_modules`、`__pycache__`、`.git`、`target`、`dist`、`build`、`.next`、`.nuxt`、`.venv`、`venv`、`.idea`、`.vscode`

**符号链接**：目录树中展示符号链接节点（带特殊图标标记），但点击无响应，不可展开也不可打开预览。

### 3.5 文件内容预览 Tab

#### 3.5.1 展示

- tab 标题显示文件名（如 `main.ts`）
- 内容区顶部显示：相对路径 + 文件大小
- 带行号的纯文本展示
- 只读，不可编辑

#### 3.5.2 加载与状态

| 状态 | UI 表现 |
|------|---------|
| 加载中 | Element Plus `v-loading` 指令覆盖内容区 |
| 加载成功 | 显示文件内容 |
| 加载失败（`{ error }` 返回） | 居中显示错误信息 + 重试按钮 |
| 文件为空（`total_lines === 0`） | 居中提示「空文件」 |

#### 3.5.3 限制

| 条件 | 检测时机 | 处理 |
|------|----------|------|
| 文件 > 512KB | `list-directory` 阶段（`size` 字段） | 在目录树中文件名旁标记「大文件」，点击后提示「文件过大，无法预览」 |
| 二进制文件 | `read-file` 阶段（读取后检测前 8KB 的 null 字节） | FileViewer 显示「二进制文件，无法预览」 |
| 文件 > 5000 行 | `read-file` 阶段（利用 `offset`/`limit` 参数只请求前 5000 行） | 仅显示前 5000 行，底部提示「仅显示前 5000 行」 |

#### 3.5.4 复用

调用已有的 `localReadFile` IPC（签名见 4.2 节），利用 `limit: 5000` 参数限制传输量，无需新增后端接口。

#### 3.5.5 错误处理

| 场景 | 处理方式 |
|------|----------|
| `list-directory` 失败（权限不足、目录不存在） | 目录树节点显示错误提示，提供重试按钮 |
| `localReadFile` 返回 `{ error }` | FileViewer 显示错误提示：「文件读取失败：{error 字段内容}」 |
| workspace 路径为空（新建 LOCAL 会话未选目录） | 文件树 tab 禁用并提示「请先选择工作区目录」 |
| 文件在预览期间被删除/移动 | tab 保留但显示「文件已不存在」提示 |

### 3.6 状态保全

使用 Vue `<keep-alive>` 包裹 tab 内容区域：

- **对话 tab**：保全聊天消息列表的滚动位置、输入框内容、工具审批队列等
- **文件 tab**：保全文件内容的滚动位置
- **Agent 输出不受影响**：对话 tab 即使被 keep-alive 缓存，WebSocket 消息仍在后台写入 session store，切换回来时自动渲染

#### 3.6.1 useChat 在 keep-alive 下的行为

`useChat` 实例放在 ChatPanel 内部，随 ChatPanel 一起被 keep-alive 缓存。需要确保以下机制在缓存期间正常工作：

| 机制 | 保障方案 |
|------|----------|
| WebSocket 监听 | `useStreamWS` 是全局单例，不依赖组件生命周期，消息持续写入 session store |
| `watch` 副作用 | ChatPanel 内的 watch 通过 `{ detached: true }` 或在 `onActivated` 中重新注册 |
| 定时器（心跳等） | `useChat` 内的定时器在 `onDeactivated` 中暂停，`onActivated` 中恢复 |
| 消息更新 | 通过 `sessionStore` 的响应式数据驱动，`computed` 在组件激活时自动重算 |

### 3.7 workspace 来源

文件浏览器的根目录从 `sessionStore` 的当前 session 中获取：

```typescript
// sessionStore 中已有 workspace 字段
const activeSession = computed(() => sessionStore.activeSession)
const workspace = computed(() => activeSession.value?.workspace ?? '')
```

- LOCAL 模式：`workspace` 为本地文件系统绝对路径
- CLOUD 模式：`workspace` 为空或 undefined，此时文件树 tab 隐藏

### 3.8 会话切换

不同会话可能对应不同工作区，文件 tab 需要**按 sessionId 隔离存储**，与现有 `sessionMessages` / `sessionTodos` 模式一致。

#### 3.8.1 数据模型

在 `useCenterTabs` 中维护一个按 sessionId 索引的 Map：

```typescript
// 每个会话独立的 tab 状态
interface SessionTabState {
  tabs: Tab[]           // 文件 tab 列表（不含对话 tab，对话 tab 始终存在）
  activeTabId: string   // 当前激活的 tab id
}

// 全局状态
const sessionTabsMap = ref<Map<string, SessionTabState>>(new Map())
```

#### 3.8.2 切换行为

| 事件 | 行为 |
|------|------|
| 切换到会话 B | 保存当前会话的 tabs + activeTabId 到 Map；从 Map 恢复会话 B 的状态（首次则初始化为空） |
| 切回会话 A | 从 Map 恢复 A 的 tabs + activeTabId |
| 关闭会话 A | 从 Map 删除 A 的 tab 状态 |
| 会话工作区变更 | 清除该会话的文件 tabs（工作区变了，旧路径失效） |

#### 3.8.3 右侧面板联动

- 切换会话时，文件树重新加载为新会话的工作区根目录
- 若新会话是 CLOUD 模式，文件树 tab 隐藏，仅显示「工作区+进度」tab，已打开的文件 tabs 保留但标记为不可用

#### 3.8.4 与现有 keep-alive 的关系

`<keep-alive>` 的缓存 key 需要包含 sessionId，确保不同会话的 ChatPanel / FileViewer 实例互不干扰：

```vue
<keep-alive :max="20">
  <component :is="activeComponent" :key="`${activeSessionId}-${activeTabId}`" />
</keep-alive>
```

- 使用 `key` 而非 `include` 来区分实例，因为文件 tab 有多个同组件实例
- `max` 设为 20，防止无限缓存导致内存膨胀

## 4. 架构设计

### 4.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Renderer (Vue 3)                      │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Layout.vue                                       │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  TaskView                                   │  │  │
│  │  │  ┌───────────────────────────────────────┐  │  │  │
│  │  │  │  CenterTabBar  ← 新增                  │  │  │  │
│  │  │  │  [对话] [file1.ts] [file2.ts] [×]     │  │  │  │
│  │  │  ├───────────────────────────────────────┤  │  │  │
│  │  │  │  <keep-alive>                         │  │  │  │
│  │  │  │    ChatPanel (对话, 含 useChat)        │  │  │  │
│  │  │  │    FileViewer (文件预览, 每个tab独立)   │  │  │  │
│  │  │  │  </keep-alive>                        │  │  │  │
│  │  │  └───────────────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  TaskInspector (改造为 Tab 化)               │  │  │
│  │  │  ┌───────────────────────────────────────┐  │  │  │
│  │  │  │  [工作区+进度] [文件树]  ← Tab 栏      │  │  │  │
│  │  │  ├───────────────────────────────────────┤  │  │  │
│  │  │  │  原 TaskInspector 内容 (tab 1)         │  │  │  │
│  │  │  │  FileTree (目录树, tab 2)  ← 新增      │  │  │  │
│  │  │  └───────────────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
│                        │ window.electronAPI              │
│                        ▼ IPC                             │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Preload Bridge (contextBridge)                   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    Main Process                          │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  list-directory handler  ← 新增                   │  │
│  │  返回 { name, path, isDirectory, size, mtime }    │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │  read-file handler（已有，复用）                    │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 4.2 IPC 接口

**新增：`list-directory`**

```
请求：{ dirPath: string, workspace: string }
      dirPath   — 绝对路径，由 renderer 端基于 workspace 拼接后传入
      workspace — 工作区根目录绝对路径，用于沙箱校验
响应：Array<{
  name: string,
  path: string,        // 相对路径（相对于 workspace 根目录）
  isDirectory: boolean,
  size: number,        // 文件大小（目录为 0）
  mtime: number,       // 最后修改时间戳
  isSymlink: boolean   // 是否为符号链接
}>
```

实现要点：
- 使用 `fs.readdirSync(dirPath, { withFileTypes: true })` 获取直接子项（非递归）
- 通过 `entry.isSymbolicLink()` 检测符号链接
- 应用排除规则（与 `list-workspace-files` 一致）
- 排序：文件夹在前按字母序，文件在后按字母序
- 路径沙箱：`path.resolve(dirPath)` 必须以 `path.resolve(workspace)` 为前缀，防止目录遍历攻击
- 单次返回最多 500 条，超出时返回截断标记

**已有复用：`local-read-file`**

```
请求：{ path: string, offset?: number, limit?: number }
      path   — 绝对路径
      offset — 起始行号（0-based），默认 0
      limit  — 最大行数，默认无限制
成功：{ content: string, total_lines: number }
失败：{ error: string }    // 不抛异常，通过 error 字段返回
```

### 4.3 文件结构

```
desktop/src/
├── components/
│   ├── file-browser/
│   │   ├── FileTree.vue             # 目录树组件
│   │   └── FileTreeNode.vue         # 树节点（递归）
│   ├── center/
│   │   ├── CenterTabBar.vue         # 页签栏（对话 + 文件 tabs）
│   │   ├── CenterTabContainer.vue   # keep-alive 容器，切换 tab 内容
│   │   └── FileViewer.vue           # 文件内容预览
│   └── task/
│       └── TaskInspector.vue        # 改造：新增 Tab 栏，集成文件树
├── composables/
│   ├── useFileBrowser.ts            # 目录树状态
│   └── useCenterTabs.ts             # tab 系统状态管理
└── types/
    └── file-browser.ts              # 类型定义
```

### 4.4 状态管理

#### 4.4.1 `useFileBrowser.ts` — 目录树状态

```typescript
interface FileNode {
  name: string
  path: string          // 相对于工作区的路径
  isDirectory: boolean
  isSymlink?: boolean   // 符号链接标记
  size?: number
  children?: FileNode[] // 懒加载，展开后填充
  expanded?: boolean
}

// workspace 从 TaskInspector props 传入（已通过 useChat → TaskView → props 链路）
export function useFileBrowser(workspace: Ref<string>): UseFileBrowser {
  // ...
}

interface UseFileBrowser {
  treeData: Ref<FileNode[]>
  loading: Ref<boolean>
  expandedPaths: Ref<Set<string>>   // 已展开的目录路径集合，用于刷新时保留状态
  expandDir: (node: FileNode) => Promise<void>
  collapseDir: (node: FileNode) => void
  refresh: () => Promise<void>      // 并行请求 expandedPaths 中所有路径，更新对应节点
}
```

#### 4.4.2 `useCenterTabs.ts` — Tab 系统

```typescript
interface Tab {
  id: string            // chat 固定为 'chat'，文件为相对路径
  type: 'chat' | 'file'
  title: string         // 显示标题
  filePath?: string     // 文件 tab 的绝对路径
}

interface UseCenterTabs {
  tabs: Ref<Tab[]>          // 当前会话的 tabs（从 sessionTabsMap 中读取）
  activeTabId: Ref<string>  // 当前激活的 tab id

  openFileTab: (filePath: string, title: string) => void
  closeTab: (tabId: string) => void
  activateTab: (tabId: string) => void
}
```

内部维护 `sessionTabsMap: Map<string, SessionTabState>`，通过 watch `activeSessionId` 自动切换当前会话的 tab 状态。

## 5. 实现步骤

### Step 1: Main Process — `list-directory` handler

在 `main.cjs` 中新增 IPC handler，约 30 行：
- `fs.readdirSync` + `withFileTypes`
- 排除规则过滤
- 路径沙箱校验
- 排序输出

### Step 2: Preload Bridge

在 `preload.cjs` 中暴露 `listDirectory(dirPath, workspace)` 方法，在 `electron.d.ts` 中补充类型。

### Step 3: Composable — `useFileBrowser.ts`

目录树状态管理：treeData、加载、展开/折叠、刷新。

### Step 4: Composable — `useCenterTabs.ts`

Tab 系统状态管理：tabs 列表、activeTab、openFileTab、closeTab。

### Step 5: 组件 — FileTree + FileTreeNode

- `FileTreeNode.vue`：递归树节点，点击展开/折叠目录或触发 `openFileTab`
- `FileTree.vue`：树容器，接收根节点数据

### Step 6: 组件 — CenterTabBar + CenterTabContainer

- `CenterTabBar.vue`：tab 标题栏，显示 tab 列表、关闭按钮
- `CenterTabContainer.vue`：`<keep-alive>` 容器，根据 activeTabId 切换渲染内容

### Step 7: 组件 — FileViewer

- 文件内容展示（行号 + 内容 + 元信息）
- 每个文件 tab 实例独立，通过 keep-alive 保全滚动位置

### Step 8: 重构 TaskView

**ChatPanel 移入范围**：将以下组件从 TaskView 移入 ChatPanel：
- 消息列表（MessageBubble v-for）
- FileChangePanel
- QueuePanel
- ApprovalStack
- QuestionPanel
- ChatInput

**依赖传递方案**：TaskView 通过 `provide` 注入 `agentId`、`executionMode`、`newTaskModelId`、`permissionLevel` 等 Ref，ChatPanel 和 TaskInspector 通过 `inject` 获取。避免 props 层层传递。

**useChat 归属**：`useChat` 实例在 ChatPanel 内部创建，通过 inject 获取所需的 Ref 参数。

**集成**：在 TaskView 中引入 `CenterTabContainer`，ChatPanel 作为默认 tab。

### Step 9: 改造 TaskInspector

- 在 TaskInspector 内部新增 Tab 栏：「工作区+进度」+「文件树」
- 将现有 TaskInspector 内容归入「工作区+进度」tab
- 集成 `FileTree` 组件为「文件树」tab 内容

## 6. 风险与限制

| 风险 | 说明 | 缓解措施 |
|------|------|----------|
| keep-alive 内存 | 多个文件 tab 同时保活可能占用较多内存 | 文件内容为纯文本，单文件内存占用有限；若出现性能问题，后续可引入 LRU 淘汰策略 |
| 大文件预览 | 单个大文件渲染大量 DOM 行 | 5000 行上限 + 虚拟滚动（V2） |
| 大目录性能 | 某些目录可能包含数千个子项 | 限制单次返回最多 500 条，超出提示用户使用搜索 |
| CLOUD 模式 | 服务端无 `list_directory` 工具 | V1 仅支持 LOCAL 模式，CLOUD 模式下隐藏文件树 tab |
| useChat 缓存副作用 | ChatPanel 被 keep-alive 缓存后 watch/定时器可能异常 | 参见 3.6.1 节保障方案，关键机制与组件生命周期解耦 |
| 右侧面板改造范围 | TaskInspector 改造为 Tab 化涉及现有逻辑迁移 | Step 9 中详细规划迁移边界，确保原有功能不受影响 |
