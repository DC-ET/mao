# 云端模式文件树与文件预览设计方案

> 版本：v1.0 | 日期：2026-07-01 | 状态：待评审

## 1. 背景与问题

### 1.1 现状

桌面端已实现完整的**工作区文件浏览器**（右侧面板文件树 + 中心区域文件预览 Tab），但**仅支持 LOCAL 模式**：

| 能力 | LOCAL 模式 | CLOUD 模式 |
|------|-----------|-----------|
| 右侧「文件」Tab | ✅ 有 workspace 时显示 | ❌ 刻意隐藏 |
| 目录树懒加载 | Electron `list-directory` IPC | 无 |
| 文件预览 Tab | Electron `localReadFile` IPC | 无 |
| `@` 文件引用 | IPC `listWorkspaceFiles` | ✅ 已有 `GET /files/workspace-list` |
| 文件变更面板点击预览 | ✅ | ❌ 代码中直接 `return` |

关键拦截点：

```124:124:desktop/src/components/task/TaskInspector.vue
const showFileTreeTab = computed(() => !!props.workspace && props.executionMode !== 'CLOUD')
```

```67:75:desktop/src/components/chat/FileChangePanel.vue
function handleFileClick(changePath: string) {
  const workspace = sessionStore.activeSession?.workspace
  const executionMode = sessionStore.activeSession?.executionMode
  if (!workspace || executionMode === 'CLOUD') return
  // ...
}
```

文件 I/O 全部走 Electron 主进程本地文件系统，云端工作区在**服务端磁盘**（如 `/data/workbench/workspace/{userId}/...`），客户端无法直接 `fs.readdir`。

### 1.2 目标

在云端模式下，提供与 LOCAL 模式**一致的用户体验**：

1. 右侧边栏展示文件树 Tab，支持懒加载展开、筛选、刷新
2. 点击文件在中心区域打开预览 Tab（语法高亮、Markdown 渲染、行号、5000 行截断等现有能力复用）
3. 文件变更面板点击可跳转预览
4. 安全：仅能访问当前会话 workspace 沙箱内的文件，且校验会话归属

### 1.3 非目标（V1 不做）

- 管理后台（admin）云端文件浏览
- 文件编辑、创建、删除
- 在 Finder 中打开、复制绝对路径等仅适用于本地的右键菜单项
- 语法高亮 / Markdown 之外的格式升级
- WebSocket 推送文件树实时变更（V1 用手动刷新）

---

## 2. 可行性结论

**可以实现，改动量中等，无需重构 Agent 运行时或工具链。**

| 维度 | 评估 |
|------|------|
| 技术可行性 | ✅ 后端已有 `PathSandbox`、`ReadFileTool`、扁平文件列表 API，补齐「单层目录列表 + 按行读文件」REST 即可 |
| 前端复用度 | ✅ `FileTree`、`FileTreeNode`、`FileViewer`、`useCenterTabs` 等 UI 组件可直接复用，主要改 I/O 层 |
| 架构影响 | 低 — 不改变 `Session.workspace` 语义，不碰 `ToolDispatcher` / WebSocket 流 |
| 预估工作量 | 后端 1～2 人日 + 前端 1.5～2 人日，合计约 **3～4 人日** |

---

## 3. 现状能力盘点

### 3.1 后端（可复用）

```text
Session.workspace（服务端绝对路径）
    ↓
PathSandbox.resolve(relativePath, sessionWorkspace)  — 防路径穿越
ReadFileTool.execute(args, workspace)                — 按行读取，返回 { content, total_lines }
FileService.listWorkspaceFiles(workspace, filter)    — 递归 flat 列表（用于 @ 引用）
FileController GET /v1/files/workspace-list          — 按 sessionId 查 workspace 再列文件
```

| 模块 | 说明 |
|------|------|
| `PathSandbox` | 以 session workspace 为根解析相对路径，阻止 `../` 逃逸 |
| `ReadFileTool` | 与预览需求高度一致（offset/limit/total_lines） |
| `FileService.IGNORED_DIRS` | 与 Electron `list-directory` 排除规则一致 |
| `Session.workspace` | CLOUD 会话创建时已写入（`{userId}/{sessionId}` 或 `projects/{slug}`） |

### 3.2 前端（可复用）

| 组件 / 模块 | 职责 |
|------------|------|
| `TaskInspector` | 右侧 Tab 容器，已有「任务 / 文件」切换 |
| `FileTree` + `FileTreeNode` | 目录树 UI、筛选、右键菜单 |
| `useFileBrowser` | 懒加载、展开/折叠、刷新逻辑 |
| `FileViewer` | 加载、二进制检测、高亮、Markdown |
| `useCenterTabs` | 多文件 Tab 管理（按 sessionId 隔离） |
| `ChatInput.fetchWorkspaceFiles` | **已演示** CLOUD 模式走 HTTP API 的模式 |

### 3.3 缺口

| 缺口 | 说明 |
|------|------|
| 单层目录列表 REST API | 现有 `workspace-list` 是递归 flat，无目录项，无法驱动树形懒加载 |
| 文件内容读取 REST API | 预览需专用 HTTP 接口（不宜复用 Agent 工具调用链路） |
| 前端 I/O 抽象层 | `useFileBrowser` / `FileViewer` 硬编码 `electronAPI` |
| 会话归属校验 | 现有 `workspace-list` 未校验 `session.userId === 当前用户`（需一并修复） |
| CLOUD 路径语义 | Tab 中 `filePath` 当前存本地绝对路径；云端应使用**相对路径** |

---

## 4. 总体架构

### 4.1 设计原则

1. **UI 复用、I/O 抽象**：树和预览组件不变，通过 `WorkspaceFileProvider` 切换本地 IPC / 云端 HTTP
2. **路径统一用相对路径**：Tab 与事件传递 workspace 内的相对路径（如 `src/main.ts`），由 Provider 结合上下文解析
3. **sessionId 作为云端鉴权锚点**：所有云端文件 API 必须带 `sessionId`，服务端校验归属后取 `session.workspace`
4. **与工具层规则对齐**：排除目录、单目录条目上限、预览大小/行数限制与 LOCAL 保持一致

### 4.2 架构图

```text
┌─────────────────────────────────────────────────────────────────┐
│                        Desktop 客户端                            │
├─────────────────────────────────────────────────────────────────┤
│  TaskInspector ──► FileTree ──► useFileBrowser(provider)        │
│  CenterTabContainer ──► FileViewer(provider)                    │
│  FileChangePanel ──► useCenterTabs.openFileTab(relativePath)    │
├─────────────────────────────────────────────────────────────────┤
│              WorkspaceFileProvider（接口）                         │
│    ┌────────────────────────┬────────────────────────────┐   │
│    │ LocalWorkspaceProvider   │ CloudWorkspaceProvider      │   │
│    │ electronAPI.listDirectory│ GET /files/workspace-dir    │   │
│    │ electronAPI.localReadFile│ GET /files/workspace-read   │   │
│    └────────────────────────┴────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │ HTTP（仅 CLOUD）
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Spring Boot 后端                             │
│  FileController ──► WorkspaceBrowseService                      │
│       │                    ├── listDirectory(session, relDir)   │
│       │                    └── readFile(session, relPath)     │
│       └── SessionService.assertOwned(sessionId, userId)         │
│                    PathSandbox.resolve(path, session.workspace) │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    服务端文件系统（workspace-root）
```

---

## 5. 后端设计

### 5.1 新增服务：`WorkspaceBrowseService`

从 `ReadFileTool` 和 Electron `list-directory` 逻辑抽取，供 REST 与（未来）其他调用方共用。

```java
public class WorkspaceBrowseService {
    // 与 FileService / Electron 保持一致的排除规则
    private static final Set<String> IGNORED_DIRS = Set.of(
        "node_modules", "__pycache__", ".git", "target", "dist", "build",
        ".next", ".nuxt", ".venv", "venv", ".idea", ".vscode");
    private static final int MAX_ENTRIES = 500;

    public DirectoryListingDTO listDirectory(String sessionWorkspace, String relativeDir);
    public FileContentDTO readFile(String sessionWorkspace, String relativePath, int offset, int limit);
}
```

**`listDirectory` 行为**（对齐 `main.cjs` `list-directory`）：

| 规则 | 说明 |
|------|------|
| `relativeDir` 为空或 `.` | 列出 workspace 根目录 |
| 路径解析 | `PathSandbox.resolve(relativeDir, sessionWorkspace)` |
| 排除 | 隐藏文件（`.` 开头）、`IGNORED_DIRS` 中的目录 |
| 符号链接 | 返回 `isSymlink: true`，`isDirectory: false`，前端不可展开 |
| 排序 | 文件夹在前，同类型按名称字母序 |
| 上限 | 单目录最多 500 条，超出返回 `truncated: true` |
| 返回字段 | `name`, `path`（相对 workspace）, `isDirectory`, `size`, `isSymlink` |

**`readFile` 行为**（对齐 `ReadFileTool` + `FileViewer` 限制）：

| 规则 | 说明 |
|------|------|
| 参数 | `path`（相对路径）、`offset`（默认 0）、`limit`（默认 5000） |
| 返回 | `{ content, total_lines }` |
| 文件不存在 | 业务错误码 + 可读 message |
| 非普通文件 | 同上 |
| 服务端保护 | 单次 `content` 字符串上限 512KB（与前端大文件策略一致） |

### 5.2 新增 REST API

#### `GET /api/v1/files/workspace-directory`

列出 workspace 内单层目录内容。

**Query 参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | Long | 是 | 当前会话 ID |
| `dir` | String | 否 | 相对 workspace 的目录路径，默认根目录 |

**响应示例：**

```json
{
  "code": 0,
  "data": {
    "entries": [
      { "name": "src", "path": "src", "isDirectory": true, "size": 0, "isSymlink": false },
      { "name": "README.md", "path": "README.md", "isDirectory": false, "size": 1234, "isSymlink": false }
    ],
    "truncated": false
  }
}
```

#### `GET /api/v1/files/workspace-read`

读取 workspace 内文件内容（预览专用）。

**Query 参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | Long | 是 | 当前会话 ID |
| `path` | String | 是 | 相对 workspace 的文件路径 |
| `offset` | Integer | 否 | 起始行号，默认 0 |
| `limit` | Integer | 否 | 最多行数，默认 5000，最大 5000 |

**响应示例：**

```json
{
  "code": 0,
  "data": {
    "content": "package com.example;\n...",
    "total_lines": 128
  }
}
```

### 5.3 鉴权与校验

在 `FileController` 中统一封装：

```java
private Session requireOwnedSession(Long userId, Long sessionId) {
    Session session = sessionService.getSession(sessionId);
    if (!Objects.equals(session.getUserId(), userId)) {
        throw new BusinessException(ErrorCode.FORBIDDEN, "无权访问该会话");
    }
    if (session.getWorkspace() == null || session.getWorkspace().isBlank()) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, "会话未配置工作区");
    }
    return session;
}
```

**同步修复**：现有 `GET /files/workspace-list` 增加相同的 `userId` 校验（当前仅 `getSession(sessionId)`，存在越权读取风险）。

### 5.4 后端改动清单

| 文件 | 改动 |
|------|------|
| `WorkspaceBrowseService.java`（新增） | 目录列表 + 文件读取核心逻辑 |
| `FileController.java` | 新增 2 个 endpoint；`workspace-list` 补鉴权 |
| `ReadFileTool.java`（可选） | 委托 `WorkspaceBrowseService.readFile`，减少重复 |

**不需要改动**：`ToolDispatcher`、`AgentLoop`、`StreamingWsHandler`、`PathSandbox` 核心逻辑。

---

## 6. 前端设计

### 6.1 `WorkspaceFileProvider` 抽象

```typescript
// desktop/src/composables/workspace-file-provider.ts

export interface DirectoryEntry {
  name: string
  path: string       // 相对 workspace
  isDirectory: boolean
  size: number
  isSymlink: boolean
}

export interface DirectoryResult {
  entries?: DirectoryEntry[]
  truncated?: boolean
  error?: string
}

export interface ReadFileResult {
  content: string
  total_lines: number
  error?: string
}

export interface WorkspaceFileProvider {
  listDirectory(relativeDir: string): Promise<DirectoryResult>
  readFile(relativePath: string, opts?: { offset?: number; limit?: number }): Promise<ReadFileResult>
}

export function createLocalProvider(workspace: string): WorkspaceFileProvider { ... }
export function createCloudProvider(sessionId: string): WorkspaceFileProvider { ... }
```

**`LocalWorkspaceProvider`**：将现有 `electronAPI.listDirectory(absoluteDir, workspace)` / `localReadFile` 包装为相对路径接口（内部做 `workspace + '/' + relativePath` 拼接）。

**`CloudWorkspaceProvider`**：调用新增 REST API，`sessionId` 闭包绑定。

**`useWorkspaceFileProvider` composable**：

```typescript
export function useWorkspaceFileProvider(
  executionMode: Ref<string>,
  workspace: Ref<string>,
  sessionId: Ref<string | null>
) {
  return computed(() => {
    if (executionMode.value === 'CLOUD' && sessionId.value) {
      return createCloudProvider(sessionId.value)
    }
    if (workspace.value) {
      return createLocalProvider(workspace.value)
    }
    return null
  })
}
```

### 6.2 `useFileBrowser` 改造

- 入参从 `workspace: Ref<string>` 改为 `provider: Ref<WorkspaceFileProvider | null>`
- 所有 `window.electronAPI.listDirectory(...)` 替换为 `provider.value.listDirectory(relativeDir)`
- `getAbsolutePath` 可保留给 LOCAL 右键菜单，或下沉到 Provider

### 6.3 `FileTree` 改造

| 项 | 改动 |
|----|------|
| Props | 新增 `executionMode`、`sessionId`；或接收 `provider` |
| 空状态 | CLOUD 无 sessionId 时提示「请先开始对话」；LOCAL 无 workspace 时保持「请先选择工作区」 |
| 右键菜单 | CLOUD 模式隐藏「复制绝对路径」「在 Finder 中打开」；保留「复制相对路径」「添加到聊天」 |
| `open-file` 事件 | 改为传递**相对路径**：`{ path: string, title: string }` |

### 6.4 `FileViewer` 改造

- Props 新增 `provider: WorkspaceFileProvider`（或 `executionMode` + `sessionId` + `workspace` 内部创建）
- `filePath` 语义改为 **相对 workspace 的路径**（LOCAL 同步调整）
- `loadFile()` 调用 `provider.readFile(props.filePath, { limit: 5000 })`
- Markdown 内部链接解析继续使用相对路径逻辑（`resolveMarkdownLink` 已基于相对路径）

### 6.5 `TaskInspector` 改造

```typescript
// 改造前
const showFileTreeTab = computed(() => !!props.workspace && props.executionMode !== 'CLOUD')

// 改造后
const showFileTreeTab = computed(() => {
  if (props.executionMode === 'CLOUD') {
    return !!sessionId  // 有活跃会话即可（workspace 由服务端持有）
  }
  return !!props.workspace
})
```

`FileTree` 传入 `provider` 而非裸 `workspace` 字符串。

### 6.6 `FileChangePanel` 改造

```typescript
function handleFileClick(changePath: string) {
  const session = sessionStore.activeSession
  if (!session?.workspace && session?.executionMode !== 'CLOUD') return
  const title = changePath.split(/[/\\]/).pop() || changePath
  openFileTab(changePath, title)  // changePath 本身已是相对路径
}
```

### 6.7 `useCenterTabs` / Tab 类型

```typescript
export interface Tab {
  id: string
  type: 'chat' | 'file'
  title: string
  filePath?: string   // 改为：相对 workspace 的路径（两种模式统一）
}
```

`openFileTab` 的 `id` 生成保持 `'file:' + filePath`。

**LOCAL 模式迁移**：`FileTree` 打开文件时传 `node.path`（已是相对路径），不再拼接绝对路径。`FileViewer` 通过 Provider 读取，无需感知绝对/相对差异。

### 6.8 前端改动清单

| 文件 | 改动量 | 说明 |
|------|--------|------|
| `workspace-file-provider.ts`（新增） | 中 | 双实现 + 工厂 |
| `useFileBrowser.ts` | 中 | 替换 IPC 调用 |
| `FileTree.vue` | 小 | provider 注入、事件路径、右键菜单条件 |
| `FileViewer.vue` | 小 | provider 读取 |
| `TaskInspector.vue` | 小 | 显示条件、传参 |
| `FileChangePanel.vue` | 极小 | 去掉 CLOUD 拦截 |
| `CenterTabContainer.vue` | 小 | 向 FileViewer 传递 provider |
| `TaskView.vue` | 小 | 组装 provider、调整 open-file 处理 |

---

## 7. 交互与限制（与 LOCAL 对齐）

| 场景 | 行为 |
|------|------|
| 文件 > 512KB | 树节点标记「大文件」，点击提示无法预览 |
| 二进制文件 | 读取后前端检测 null 字节，显示「二进制文件，无法预览」 |
| 文件 > 5000 行 | 仅加载前 5000 行，底部提示截断 |
| 目录不存在 / 权限错误 | 节点或预览区显示错误 + 重试 |
| Agent 执行中切换 Tab | 不影响（现有 keep-alive + session store 机制） |
| 刷新文件树 | 重新请求已展开目录（与 LOCAL 一致） |

---

## 8. 安全考量

| 风险 | 应对 |
|------|------|
| 越权访问他人会话 workspace | `requireOwnedSession(userId, sessionId)` |
| 路径穿越 | `PathSandbox.resolve`（已有） |
| 读取 workspace 外技能文件 | 浏览 API 仅允许 session workspace，不含 `allowedRoots` |
| 大文件 DoS | 目录 500 条上限、读取 5000 行 + 512KB 内容上限 |
| 只读权限会话 | 预览为读操作，READ_ONLY 权限不受影响 |

---

## 9. 实施计划

### Phase 1 — 后端 API（可独立联调）

1. 新增 `WorkspaceBrowseService`
2. 新增 `workspace-directory`、`workspace-read` 两个 endpoint
3. 修复 `workspace-list` 鉴权
4. 用 Swagger / curl 验证：创建 CLOUD 会话 → Shell 写文件 → API 列表/读取

### Phase 2 — 前端 I/O 抽象

1. 实现 `WorkspaceFileProvider` 双实现
2. 改造 `useFileBrowser`、`FileViewer`
3. LOCAL 模式回归测试（确保路径语义迁移后行为不变）

### Phase 3 — 打通 UI

1. `TaskInspector` 放开 CLOUD 文件 Tab
2. `FileChangePanel` 支持 CLOUD 点击预览
3. 右键菜单按模式裁剪

### Phase 4 — 验收

见 §10。

---

## 10. 验收标准

1. CLOUD 会话右侧出现「文件」Tab，可展开目录树、筛选、刷新
2. 点击文本文件打开中心预览 Tab，语法高亮 / Markdown 正常
3. Agent 修改文件后，文件变更面板点击可跳转预览
4. 二进制文件、超大文件、空文件展示与 LOCAL 一致
5. LOCAL 模式文件树与预览功能无回归
6. 使用他人 `sessionId` 调用新 API 返回 403
7. `../etc/passwd` 类路径被 `PathSandbox` 拒绝
8. 共享云端项目（`projects/{slug}`）多会话下，各会话文件树均指向同一 workspace 内容

---

## 11. 改动量评估

### 11.1 代码量（估算）

| 层级 | 新增 | 修改 | 删除 |
|------|------|------|------|
| 后端 Java | ~200 行 | ~50 行 | 0 |
| 前端 TS/Vue | ~150 行 | ~120 行 | ~30 行 |

### 11.2 风险等级

| 风险 | 等级 | 说明 |
|------|------|------|
| LOCAL 模式回归 | 中 | 路径从绝对改相对，需完整走查文件树、预览、@ 引用 |
| 性能（大仓库） | 低 | 懒加载 + 500 条上限，与 LOCAL 相同 |
| 安全 | 低 | 复用成熟 PathSandbox，补齐鉴权即可 |
| 架构债务 | 低 | Provider 抽象反而降低后续 admin / Web 端复用成本 |

### 11.3 与现有文档关系

| 文档 | 关系 |
|------|------|
| `workspace-file-browser-design.md` | LOCAL 实现规格；本方案是其 CLOUD 扩展 |
| `cloud-workspace-project-design.md` | 共享项目 workspace 已落地；本方案直接受益（多会话看到同一文件树） |
| `file-reference-design.md` | `@` 引用已支持 CLOUD API；本方案与其 I/O 模式一致 |

---

## 12. 可选后续（V2）

| 项 | 说明 |
|----|------|
| WebSocket `workspace_changed` 事件 | Agent 写文件后推送，文件树自动刷新 |
| 文件变更高亮 | 树节点标记 Agent 最近修改的文件 |
| Admin 会话详情页预览 | 复用同一套 `WorkspaceBrowseService` |
| 预览 API 合并 | 将 `workspace-list` 扁平搜索也迁入 `WorkspaceBrowseService` |

---

## 13. 总结

云端模式**不支持**文件树/预览的根本原因，不是 UI 缺失，而是**文件 I/O 层只实现了 Electron 本地通道**。后端对云端 workspace 的读写能力（`PathSandbox` + `ReadFileTool` + `Session.workspace`）已经完备，仅缺少面向客户端的**浏览专用 REST API** 和前端的 **Provider 抽象**。

按本方案实施：

- **不需要**改动 Agent 循环、工具分发、WebSocket 协议
- **可以复用**现有文件树、预览、Tab 系统 UI
- **改动集中**在 `FileController` + 一个新 Service + 前端一个 composable 及少量组件传参调整

整体属于**中等规模、低风险**的功能扩展，建议在云端共享项目（`cloudProjectKey`）能力稳定后一并交付，用户体验更完整。
