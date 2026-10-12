# 工作区文件管理器技术方案：中央 Tab 承载的双视图文件操作台

- 状态：待实施（2026-10-12 需求共识，12 项决策见 §4；容器形态经追加追问由抽屉改为中央 Tab；本轮目标仅为方案文档，不动代码）
- 日期：2026-10-12
- 能力底座：[2026-10-09-workspace-file-manager-technical-design.md](2026-10-09-workspace-file-manager-technical-design.md)（CLOUD 工作区写操作端点族已落地，commit `4e96fdb6` 等）；本方案主体是其上的 UI 层，后端仅 `listDirectory` 响应 additive 增加一个可选 `mtimeMs` 字段（§5.2）。

## 1. 需求背景

「文件」tab（`TaskInspector.vue` 的 filetree 页 → `FileTree.vue`）把全部文件管理能力挤在约 300px 的侧边栏里，只有列表一种展示模式：上传、新建、删除、复制、粘贴全挤在窄列和右键菜单中，文件一多就操作困难。

10-09 方案落地后，CLOUD 工作区的写能力（`workspace-mkdir/write/rename/move/copy/delete/upload` 六端点 + 上传 + 写锁冲突 3044/3045 + `useFileClipboard` 剪贴板）已经齐备，缺的只是一个宽敞的操作界面。本方案在「文件」tab 工具栏开一个口子，在中央区域开一个**文件管理器 Tab**：图标网格 + 列表双视图、多选、拖拽上传、拖拽移动、面包屑导航、递归搜索，把侧边栏从"能用的列表"升级为"好用的管理器"。

容器选型：文件管理器挂**中央 Tab**（`CenterTabContainer` 的 `type: 'file_manager'` 分支），不挂抽屉/弹层。依据：中央 Tab 本就是"会话内多视图工作区"的既有形态（chat/file/diff/side_task/subagent/trace 六种同构），新增一种零架构风险；全宽工作区比 860px 抽屉更宽敞；`<KeepAlive :max="20">` 白送"切走再切回状态原样恢复"；避开抽屉类 overlay 的全套坑（append-to-body 绕 Electron 拖拽区、宽度手柄、Esc 层级、z-index）。代价是文件管理与聊天不能同屏对照——需求方确认接受。

关键事实（设计建立在其上）：

- 写操作 API 全部就绪：`desktop/src/composables/workspace-file-write.ts` 已封装 mkdir/write/rename/move/copy/delete/upload，且 `withPrompts`（L71–91）已内置 3044（Agent 写入冲突，询问强制）/3045（目标已存在，询问覆盖）的交互重试与全局 toast 抑制（`SKIP_BUSINESS_CODES`，L7）。
- 读/下载 provider 已抽象：`workspace-file-provider.ts` 的 `WorkspaceFileProvider`（L46–61）提供 `listDirectory/readFile/previewFile/searchFiles/getAbsolutePath/downloadFile/downloadDirectory`，CLOUD 走 REST、LOCAL 走 Electron IPC，管理器只依赖这个接口。
- 中央 Tab 渲染链路：`CenterTabContainer.vue` 以 `<KeepAlive :max="20">` + `activeTab.type` 分支渲染（L3–36），props 已含 `sessionId` 与 `fileProvider`（L51–56）——**管理器面板零新增 prop 管道**；Tab 数据是按会话存的模块级单例（`useCenterTabs.ts` L20）。
- 剪贴板已是 module 级单例：`useFileClipboard.ts` 全文件仅 26 行，跨组件共享零成本。
- 侧边栏已有写后联动范式：`FileTree.vue` 写成功后 `emit('paths-changed', ...)`（L392/L424/L450/L501/528），`TaskView.vue` L53 接给 `applyWorkspacePathChange` 校正中央 tab。
- 目录列表上限 500 条/目录、搜索结果上限 100 条（`workspace-browse.service.ts` L74/L130），本方案沿用不放大。
- **修改时间现状**：本地 IPC `list-directory`（`electron/main.cjs` L1724/L1730/L1741）条目已带 `mtime`（mtimeMs）；CLOUD 后端 `listDirectory`（`workspace-browse.service.ts` L99–110）条目只有 name/path/isDirectory/isSymlink/size，**不带 mtime**。为让双模式列表一致且支持按时间排序，本方案给后端 `DirectoryEntryDTO` additive 增加可选 `mtimeMs`（D3/D12），本地侧零改动。
- LOCAL 会话文件树保持只读现状（10-09 方案口径），本方案不新增任何本地写通道。

## 2. 需求描述

### 2.1 目标

1. **宽敞操作面**：「文件」tab 工具栏单一入口，在中央区域打开文件管理器 Tab（标题"文件管理"，随会话独立）；图标网格 + 列表双视图切换，支持名称/大小/修改时间排序，偏好本地记忆；切到其他 Tab 再切回，目录位置、多选、搜索状态原样恢复（KeepAlive）。
2. **完整文件操作**（全部 CLOUD、全部复用现成端点）：上传文件/上传文件夹/拖拽导入、新建文件/新建文件夹、重命名、删除（强确认）、剪切/复制/粘贴（与侧边栏共用剪贴板）、拖拽移动、单文件与批量下载、目录打包 zip、复制绝对路径、添加到聊天、在侧边栏文件树中定位。
3. **高效定位**：面包屑 + 前进/后退历史；递归搜索整个工作区，点击结果跳转到所在目录并选中。
4. **多选批处理**：Ctrl/Cmd+点击、Shift 范围选、Ctrl/Cmd+A 全选，底部状态栏显示已选数量，删除/下载/剪切复制均支持批量。
5. **改动面积极小**：主体为 desktop 纯前端；后端仅 `listDirectory` 响应 additive 加一个可选 `mtimeMs` 字段；不加权限码、零 DDL、零新依赖；LOCAL 会话不显示入口。

### 2.2 非目标（明确不做）

- **不做抽屉/弹层/全屏覆盖容器**：承载形态唯一，即中央 Tab（D1）。
- **不做 LOCAL 写能力**：入口仅在 CLOUD 会话显示；LOCAL 侧边栏维持只读现状，不新增 Electron 主进程写 IPC。
- **不做回收站/快照/回滚**：删除即物理删除，强确认兜底（延续 10-09 D2）。
- **不做内嵌编辑器、不做管理器内预览面板**：双击文件一律走中央 Tab 的只读 `FileViewer`（文本/Markdown/图片/PDF 现成链路）。
- **不做"原地克隆"独立入口**：复制 + 粘贴到当前目录即达成同样效果。
- **不做跨会话/跨工作区剪贴板**：沿用 `useFileClipboard` 的 sessionId 校验，跨会话粘贴给提示。
- **不做框选（marquee）**：多选只做 Ctrl/Cmd+点击、Shift 范围、Ctrl/Cmd+A。
- **不做当前目录名称筛选模式**：查找诉求由递归搜索覆盖（决策 D10）。
- **不做 `file_change` WS 自动刷新**：管理器与侧边栏各自手动刷新；唯一主动联动是"在文件树中显示"和管理器写成功后顺手刷新侧边栏树（§5.8）。
- **不做 Tab 刷新重建**：管理器 Tab 与 file/diff/trace 现行行为一致——刷新页面不重建该 Tab（恢复激活态时匹配不到就留 chat）。
- **不做安卓单独适配**：共用同一套响应式 UI；拖拽与 `webkitdirectory` 在安卓 WebView 不可靠时由工具栏 `input[type=file]` 兜底；不改安卓原生（延续 10-09 §12.5）。
- **不加权限码、不动角色体系、不改 admin**。

## 3. 范围界定

### 3.1 做什么

| 层 | 内容 |
|---|---|
| desktop（新） | `components/file-browser/FileManagerPanel.vue`（Tab 内容面板：头部/第二行/状态栏/进度浮层）、`FileManagerGrid.vue`（图标网格）、`FileManagerList.vue`（列表）、`FileManagerContextMenu.vue`（右键菜单）、`composables/useFileManager.ts`（导航/选择/排序/视图/搜索状态机）、`utils/file-manager.ts`（纯函数：排序/落点预检/父目录） |
| desktop（改） | `composables/useCenterTabs.ts`：加 `openFileManagerTab()`（单例 id `file-manager`，已存在则激活）；`types/file-browser.ts`：`Tab.type` union 加 `'file_manager'`、`FileNode` 加可选 `mtime`、新增 `FileManagerPrefs`；`components/center/CenterTabContainer.vue`：加 `file_manager` 渲染分支 + 三个事件透传；`components/file-browser/FileTree.vue`：工具栏加「文件管理」按钮、`defineExpose` 暴露 `revealInFileTree`/`refreshFileTree`；`components/task/TaskInspector.vue`：`defineExpose` 透传上述两能力；`views/task/TaskView.vue`：接面板三个事件并转发现到侧边栏；`composables/workspace-file-provider.ts`：`DirectoryResult` 条目类型加可选 `mtime` |
| desktop（复用，逻辑零改） | `workspace-file-write.ts`（六写操作 + 上传 + withPrompts）、`useFileClipboard.ts`、`useFileBrowser.ts`（restoreExpandedPath/refresh）、`utils/safe-storage.ts`（偏好落盘）、`utils/clipboard.ts`（copyText） |
| backend-ts | `file/workspace-browse.service.ts`：`DirectoryEntryDTO` 加可选 `mtimeMs`，`listDirectory` 条目赋 `lst.mtimeMs`（additive，现有消费者无感）；补/改对应 spec 断言 |

### 3.2 不做什么

- 不新增任何后端端点、错误码、迁移、权限码；后端唯一改动是 `listDirectory` 响应 additive 加 `mtimeMs`（现有消费者忽略新字段，行为不变）。
- 不改侧边栏 `FileTree.vue` 现有行为（工具栏按钮与 expose 除外）。
- 不改 `WorkspaceFileProvider` 的两种实现逻辑（仅类型加字段）。
- 不改中央 Tab 现有六种 type 的任何行为；`openFileManagerTab` 为纯新增函数。
- 不做单元测试之外的 UI 自动化（不新增 Playwright 用例；root 测试不依赖固定用例数）。

## 4. 关键决策（需求共识）

零新依赖、零迁移、零新端点。十二个塑形决策：

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 容器形态 | 中央 Tab：`Tab.type` 加 `'file_manager'`，单例 id `file-manager`，标题"文件管理"，按会话独立（`sessionTabsMap` 天然支持）；全宽工作区；刷新不重建（与 file/diff/trace 一致）；不做任何 overlay |
| D2 | 模式范围 | 入口仅在 CLOUD 会话显示（复用 `canWrite` 同款判断：`executionMode === 'CLOUD' && sessionId > 0`）；LOCAL 不显示入口，侧边栏只读现状不变 |
| D3 | 视图与排序 | 图标网格 + 列表双视图，面板头部切换；排序支持 name/size/mtime × asc/desc，目录优先（与后端 `listDirectory` 一致）；视图与排序存 localStorage（key `mao.file-manager.prefs`）。mtime 依赖 D12 的后端加字段 |
| D4 | 选择模型 | 完整多选：Ctrl/Cmd+点击、Shift 范围选、Ctrl/Cmd+A 全选、点空白取消；底部状态栏显示"共 N 项 / 已选 N 项"；切换目录或进入搜索即清空选择 |
| D5 | 操作集 | 上传（按钮 + 拖拽 + 进度）、新建文件/文件夹、重命名、删除（强确认）、剪切/复制/粘贴、拖拽移动、下载（单文件 + 多选批量）、目录 zip、复制绝对路径、添加到聊天、在文件树中显示——全做 |
| D6 | 剪贴板 | 复用 `useFileClipboard` module 单例，管理器与侧边栏右键菜单互通；限同会话同工作区；cut 粘贴成功后清空 |
| D7 | 打开行为 | 双击/Enter 文件 → `openFileTab` 在中央 Tab 打开（FileViewer，与侧边栏一致）；管理器 Tab 留在 Tab 条，切回即恢复全部状态（KeepAlive），可反复对照 |
| D8 | 导航 | 面包屑（可点任意一级）+ 前进/后退历史按钮；根 = 会话工作区根，任何操作不越出根 |
| D9 | 冲突处理 | 沿用现有询问式交互：3045 弹"目标已存在，是否覆盖"（仅 write/copy/upload 可覆盖）、3044 弹"Agent 正在写入，取消/强制"；`workspace-file-write.ts` 的 `withPrompts` 零改动复用 |
| D10 | 搜索 | 递归搜索整个工作区（`provider.searchFiles`，防抖 300ms，limit 100 与侧边栏一致）；结果平铺显示相对路径，点击跳转到所在目录并选中；不做当前目录筛选模式 |
| D11 | 入口 | 「文件」tab 工具栏单一按钮（`<el-icon><Files /></el-icon> 文件管理`，small 尺寸，放在筛选框之后、上传按钮之前），点击调 `openFileManagerTab()` |
| D12 | 后端 | 唯一改动：`workspace-browse.service.ts` 的 `DirectoryEntryDTO` additive 增加可选 `mtimeMs`（条目赋 `lst.mtimeMs`，本地 IPC 侧已带 `mtime` 无需改）。其余能力全部复用 10-09 已落地端点；不加权限码、零 DDL、零新依赖 |

## 5. 详细设计

### 5.1 组件结构与渲染链路

```
TaskView.vue（改：接事件、转发现到侧边栏）
├─ CenterTabContainer.vue（改：加分支 + 事件透传；props 已有 sessionId/fileProvider，零新增）
│   └─ <FileManagerPanel v-else-if="activeTab?.type === 'file_manager'" :session-id :file-provider
│         @open-file @add-file-to-chat @paths-changed @tree-refresh />   ← KeepAlive 内，切走再切回状态保留
│       ├─ 头部：标题 + 视图切换（网格/列表）+ 排序菜单 + 刷新
│       ├─ 第二行：后退/前进 + 面包屑 + 搜索框
│       ├─ 内容区：<FileManagerGrid> 或 <FileManagerList>（v-if viewMode）
│       ├─ 底部状态栏：计数 + 主操作（上传文件/上传文件夹/新建文件/新建文件夹/删除/下载）
│       ├─ 上传进度浮层（label + percent + error）
│       └─ <FileManagerContextMenu>（Teleport 自研，抄 FileTreeContextMenu 边界防溢出）
└─ TaskInspector.vue（改：defineExpose revealInFileTree / refreshFileTree）
    └─ FileTree.vue（改：工具栏按钮；defineExpose reveal/refresh）
```

- **打开**：`openFileManagerTab()`（`useCenterTabs.ts` 新增）：会话内已有该 Tab 则直接激活，否则 push `{ id: 'file-manager', type: 'file_manager', title: '文件管理' }` 并激活；按 `notifyTabsChanged` 现有收尾（含激活态落盘）。恢复激活态走 `restoreActiveTab` 现有按 id 匹配逻辑，刷新不重建（非目标，与 file/diff/trace 一致）。
- **依赖获取**：面板只拿 `sessionId` + `fileProvider`——`CenterTabContainer` props 已有（L51–56），**零新增管道**。会话的 executionMode 是会话级不变属性，能建出该 Tab 的会话必是 CLOUD（入口 D2 卡死），面板不再收 executionMode。
- **事件出口**（与 TaskInspector 同模式，TaskView 中转）：
  - `open-file` → `openFileTab(path, title)`（TaskView L517 现有 handler 同款）；
  - `add-file-to-chat` → composer 插 `@{绝对路径}@`（TaskView 现有链路）；
  - `paths-changed` → `applyWorkspacePathChange`（TaskView L53 现成）；
  - `tree-refresh` → TaskView 调 `TaskInspector` expose 的 `refreshFileTree()` → `FileTree.refresh()`；
  - `locate-in-tree` → TaskView 调 `revealInFileTree(relPath)` → `FileTree` expose 的 `reveal(relPath)`（§5.8）。
- **写能力判断**：面板内 `canWrite = numericSessionId > 0`（CLOUD 由入口保证，D2）；所有写操作按钮/菜单项在该口径下才出现。

### 5.2 `useFileManager.ts` 状态机

composable 实例住在面板组件内，由 KeepAlive 保活——切到文件 Tab 看内容再切回，`currentDir`、选择集、搜索词全部原样（D7 的免费状态保持）。模块内 ref：

| 状态 | 类型 | 说明 |
|---|---|---|
| `currentDir` | `string` | 工作区相对路径，`''` = 根 |
| `history` / `future` | `string[]` | 后退/前进栈；进入新目录 push 并清空 future |
| `entries` / `loading` / `error` | — | 当前目录列表；`provider.listDirectory(currentDir)`，带自增竞态序号（抄 `useFileBrowser.ts` L9–10 的 `rootRequestSeq` 模式） |
| `selectedPaths` | `Set<string>` | 多选集合（D4） |
| `viewMode` / `sortBy` / `sortOrder` | 持久化 | 读：localStorage `mao.file-manager.prefs`（try/catch 兜底）；写：`safeSetItem`（`utils/safe-storage.ts` L6）。跨会话/跨刷新保留 |
| `searchQuery` / `searchResults` / `searching` | — | 防抖 300ms → `provider.searchFiles(pattern)`；结果超 100 条时与侧边栏同样式提示"匹配较多" |

纯函数下沉 `utils/file-manager.ts`（可单测）：

- `sortEntries(entries, sortBy, sortOrder)`：目录优先，再按名称（localeCompare）/大小/mtime。mtime 来自列表条目：CLOUD 由 D12 的后端 `mtimeMs` 提供，本地 IPC 已带 `mtime`（`main.cjs` L1741），`FileNode` 加可选 `mtime` 字段贯通到 composable。
- `canDropTarget(sourcePaths, targetPath, entries)`：目标是目录、不是源自身、不是任何源的子孙——前端预检，失败不放行；后端 `PARAM_INVALID` 兜底。
- `parentDirOf(relPath)`：搜索结果点击跳转用。

### 5.3 视图渲染

**图标网格（`FileManagerGrid.vue`）**：CSS grid，`repeat(auto-fill, minmax(110px, 1fr))`（全宽下约 6–9 列）；每格 = 图标 + 名称（单行省略，hover 出 `el-tooltip` 显示全名/大小/时间）+ 次要行（大小·时间，小字灰色）。图标沿用 `FileTreeNode.vue` L21–27 的四类映射（Folder/FolderOpened/Link/Picture/Document + `IMAGE_EXTENSIONS`），**不引图标库**。选中态 = 主色边框 + 淡底色 + 左上角对勾角标（纯 CSS）。拖拽落点 = 文件夹格整体高亮。

**列表（`FileManagerList.vue`）**：名称 / 大小 / 修改时间三列；表头点击排序（循环 asc→desc，与 D3 状态联动）；行单击选中、双击打开；行内支持拖拽与右键。

两视图共享同一 props/emits 契约（entries、selectedPaths、loading、renamingPath、dropTargetPath + open/contextmenu/toggle-select/range-select/drop/external-drop/commit-name/cancel-edit），差异只在模板。空目录：图标 + "空目录" + "拖拽文件到此处上传，或右键新建"；加载中内容区 `v-loading`。

### 5.4 操作矩阵

| 操作 | 入口 | 单选 | 多选 | 落点 |
|---|---|---|---|---|
| 打开 | 双击 / 右键"打开" / Enter | ✓ | —（双击总是打开被点那个，不影响其他选中） | `openFileTab` → 中央 Tab FileViewer；管理器 Tab 保留，切回即恢复（D7） |
| 上传文件 | 状态栏按钮 → 隐藏 `input[type=file] multiple` | — | — | `uploadWorkspace(sessionId, currentDir, items, onProgress)` |
| 上传文件夹 | 状态栏按钮 → 隐藏 `input[webkitdirectory]` | — | — | 同上（保留相对目录结构） |
| 拖拽导入 | 外部文件 drop 到内容区 | — | — | `filesFromDataTransfer` → `uploadWorkspace(dir=currentDir)`；drop 到文件夹格则 `dir=该文件夹` |
| 新建文件/文件夹 | 状态栏"新建文件 / 新建文件夹"、面板头部、右键（含空白处） | — | — | 行内输入名称（Enter 提交/Esc 取消/失焦提交；空名/含 `/` 前端即拒，同 FileTree `commitDraft` 规则）→ `mkdirWorkspace` / `writeWorkspaceFile`；新建文件成功后 `openFileTab` 打开（与侧边栏 `commitDraft` L396–397 一致），新建文件夹不打开 |
| 重命名 | 右键 / F2 | ✓ | — | 行内输入 → `renameWorkspacePath` |
| 删除 | 右键 / Delete / 状态栏 | ✓ | ✓ | 强确认（§5.5）→ `deleteWorkspacePath` 逐条 |
| 剪切/复制 | 右键 / Ctrl+X / Ctrl+C | ✓ | ✓ | `useFileClipboard.set(op, sessionId, paths)` |
| 粘贴 | 右键 / Ctrl+V / 空白处右键 | — | — | `copyWorkspacePath` 或 `moveWorkspacePath` 逐条到 `currentDir`；跨会话 `matches()` 失败 → ElMessage 提示；cut 成功后 `clear()` |
| 拖拽移动 | 拖文件/文件夹到文件夹格 | ✓（拖拽即带动整个选中集） | ✓ | 前端 `canDropTarget` 预检 → `moveWorkspacePath` 逐条 |
| 下载 | 右键 / 状态栏 | ✓ | ✓（逐个触发，>3 个时提示"将逐个下载"） | `downloadWorkspaceResource`（provider L268，微信/安卓环境走 `DownloadLinkDialog` 现成逻辑） |
| 目录打包 | 右键目录项 | ✓ | — | `provider.downloadDirectory` |
| 复制绝对路径 | 右键 / 状态栏 | ✓ | ✓（多行拼接） | `provider.getAbsolutePath` → `copyText` |
| 添加到聊天 | 右键 | ✓ | ✓（逐条） | emit `add-file-to-chat` → composer 插 `@{绝对路径}@`；用户自行切回 chat Tab 即见 |
| 在文件树中显示 | 右键 | ✓ | — | emit `locate-in-tree` → §5.8；管理器 Tab 不关 |

### 5.5 删除强确认

复用 FileTree 现有确认范式（`ElMessageBox.confirm`，warning）：正文列顶层路径清单，目录项后缀"（目录，将删除其下所有内容）"，明示"删除不可恢复"；路径为 `.git` 或其子路径时追加"将删除 Git 版本库"（与侧边栏 L414 一带一致）。**不递归展开子项清单**（防大树卡顿）。确认后逐条 `deleteWorkspacePath`，成功后 reload 当前目录 + emit `paths-changed({kind:'delete', paths})` + emit `tree-refresh`。

### 5.6 上传

- 传输完全复用 `uploadWorkspace`（`workspace-file-write.ts` L145–206）：裸 XHR + FormData（`sessionId/dir/relativePath[]/file[]/force/overwrite`）+ progress 回调；面板顶部挂进度浮层（label + `el-progress` + 失败重试提示，形态同 FileTree.vue L38–41）。
- 取文件复用 `filesFromDataTransfer`（L208，`webkitGetAsEntry` 递归保目录结构）与 `filesFromInput`（L261）；Electron / Capacitor WebView 均为 Chromium 内核，支持（安卓可靠性问题由 §2.2 的兜底口径覆盖）。
- 冲突：`withPrompts('upload', ...)` 已内置 3045 覆盖询问；无需新代码。
- 上限沿用全局 multipart（`file.maxSizeMb` 默认 1024MB、`files: 500`），不放大。

### 5.7 冲突与确认（零新代码）

`workspace-file-write.ts` 的 `withPrompts` 已实现：3044 → "文件正在被 Agent 写入"面板（默认取消、可强制，重放带 `force=true`）；3045 → "目标已存在，是否覆盖"（仅 write/copy/upload 可 `overwrite=true`；mkdir/rename/move 直接 toast 错误）；且 `writeConfig()` 已带 `timeout: 0` 与 `skipBusinessCodes` 抑制全局 toast。面板直接调用上述导出函数即可，**不改一行**。

### 5.8 与既有能力衔接

- **中央 Tab 校正**：删除/重命名/移动成功后 emit `paths-changed`（形状与 FileTree.vue L392/L424/L450/L501/528 完全一致：`{kind:'move', from, to}` / `{kind:'delete', paths}`），`TaskView.vue` L53 → `applyWorkspacePathChange` 现成处理。
- **侧边栏树刷新**：管理器任何写操作成功后 emit `tree-refresh` → TaskView → `TaskInspector.refreshFileTree()` → `FileTree.refresh()`（`useFileBrowser` L120，自带竞态与展开态恢复）。避免"管理器里删了、侧边栏还在"的双入口不一致。这是除"树中定位"外唯一的主动联动；不引入 `file_change` WS 订阅（非目标）。
- **在文件树中显示**：emit `locate-in-tree(relPath)` → TaskView → `TaskInspector.revealInFileTree(relPath)` → `FileTree` expose 的 `reveal(relPath)`：`restoreExpandedPath`（`useFileBrowser.ts` L153–181，逐级展开 + 压缩目录兼容）+ 把 `selectedPaths` 置为 `[relPath]` 做视觉高亮。管理器 Tab 保持打开，用户可切回继续。
- **添加到聊天**：语义不变，文件已在工作区，插入 `@{绝对路径}@` 引用（`prompt-engine.ts` 的 `FILE_REF_PATTERN` 只还原路径不读内容）。
- **Git 衔接**：用户写自然进入 `git status`，Git tab 的 diff 视图可见；无额外处理。

### 5.9 快捷键

| 键 | 行为 | 约束 |
|---|---|---|
| Enter | 打开选中项（文件→中央 Tab；目录→进入） | 输入框聚焦时不劫持 |
| Delete | 删除选中集（强确认） | 同上 |
| F2 | 重命名 | 仅单选 |
| Ctrl/Cmd+C / X / V | 复制 / 剪切 / 粘贴 | V 在输入框聚焦时不劫持 |
| Ctrl/Cmd+A | 全选当前目录 | `preventDefault` 防选中页面文本 |
| Esc | 取消重命名编辑 / 清空搜索；**不关 Tab**（Tab 关闭走 × 或中键，与其他 Tab 一致） | 重命名输入框中 Esc 只取消编辑（输入框 `keydown` `stopPropagation`） |
| Backspace | 不使用（浏览器后退冲突） | — |

### 5.10 持久化

prefs 对象 `{ viewMode, sortBy, sortOrder }` → localStorage key `mao.file-manager.prefs`；读 try/catch（隐私模式静默失败，仅本次会话生效，同 `useTaskPanelPrefs.ts` 的 `writeLegacyAliases` 兜底写法），写走 `safeSetItem`。目录位置/选择集/搜索词不持久化（KeepAlive 保活已覆盖会话内连续切换；刷新不重建 Tab，无从恢复）。

### 5.11 边界与降级

- 目录条目 >500（后端上限）：与侧边栏同边界，超出不可见；递归搜索可兜底定位。
- 搜索结果 >100：提示"匹配较多，仅显示前 N 条"。
- 无写权限会话（LOCAL 或 sessionId≤0）：入口不渲染（D2）。
- KeepAlive `:max="20"`：一个会话同时缓存超 20 个 Tab 时最早的可能被逐出，管理器状态丢失需重开——20 个未关 Tab 是极端场景，接受（与 ChatPanel 同命运）。
- Tab 条 `overflow-x: auto` + 单 Tab 限宽 120px 省略号，多 Tab 可横向滚，加一个不撑爆布局。
- 安卓（Capacitor 远程加载同一份 desktop dist）：UI 自然可用；拖拽/`webkitdirectory` 不可靠时状态栏 `input` 是兜底入口；不做专门移动端布局，不改原生（延续 10-09 §12.5）。
- 多选批量下载：浏览器可能拦截多次下载，>3 个时 ElMessage 提示"将逐个下载"。

## 6. 实现步骤

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 骨架 | 后端 `listDirectory` 加 `mtimeMs`（D12）；`Tab.type` union + `openFileManagerTab()` + `CenterTabContainer` 分支与事件透传；`useFileManager.ts`（导航/历史/选择/竞态）+ `utils/file-manager.ts` 纯函数 + `FileManagerPanel.vue`（头部/第二行/状态栏/持久化）+ 入口按钮；先接列表视图 | 中 |
| P2 双视图 | `FileManagerGrid.vue` + `FileManagerList.vue` + 排序 + 视图切换持久化 | 中 |
| P3 操作 | 新建/重命名/删除/剪贴板互通/拖拽移动 + 快捷键 + `FileManagerContextMenu.vue` + `paths-changed`/`tree-refresh`/`locate-in-tree` 三链路（含 TaskInspector/FileTree expose） | 中 |
| P4 上传获取 | 上传（按钮+拖拽+进度）+ 下载/zip + 复制路径 + 添加到聊天 + 递归搜索跳转 | 小~中 |

P1 完成即可 build 通过并试用；P3/P4 内部各自可独立提交。

## 7. 风险与开放问题

- **后端 additive 字段的兼容面**：`mtimeMs` 为可选新字段，现有消费者（侧边栏 `FileTree`/`useFileBrowser` 的 `entryToNode`、run 轨迹、agent 读工具）忽略它；本地 IPC 早已返回同名语义的 `mtime`，两侧对齐后无分叉。后端改动仅一处赋值 + spec，随 `npm run build && npm test` 一并验证。
- **不能与聊天同屏**：Tab 形态的既定代价（需求方确认）。缓解：管理器内"添加到聊天"、双击打开文件都是单次点击级切换；真正需要对照时开抽屉的口子保留为后续可能（本方案不做）。
- **KeepAlive 逐出**：`:max="20"` 下极端多 Tab 会丢管理器状态（§5.11），接受，不为此调大 max。
- **大目录渲染**：单目录 500 条目全量渲染 DOM（网格 + 多选监听）在低端机可能卡顿；缓解：虚拟滚动本期不做（500 量级实测优先），真卡顿再评估。
- **拖拽移动误操作**：前端 `canDropTarget` 预检 + 后端 `PARAM_INVALID`/3045 兜底；move 到已存在文件直接报错（`withPrompts` 对 move 的 3045 不走覆盖询问，符合"改名撞名默认保守"口径）。
- **剪贴板跨入口的心智**：侧边栏复制 → 管理器粘贴（或反向）成立且是本方案卖点，但用户可能遗忘剪贴板内容；状态栏在剪贴板非空且匹配当前会话时常驻"剪贴板 N 项"提示。
- **双入口状态独立**：管理器不订阅 `file_change`，Agent 改文件后不自动刷新（与侧边栏同边界）；管理器写成功后主动刷侧边栏树是单向的，反向（侧边栏写后管理器刷新）不承诺——管理器每次打开重新拉根目录，天然缓解。
- **多选 + 搜索清空间互**：进入搜索即清空选择（D4），批量操作与搜索结果不混用。
- **开放问题：管理器是否最终取代侧边栏列表**：本期明确不取代，两者并存（侧边栏保留快速浏览/右键树操作）；待 Tab 形态稳定使用一段时间后再评估收敛，不在本方案范围。

## 8. 测试要点

- **单测（vitest，`desktop npm run test:unit`）**：
  - `utils/file-manager.ts`：`sortEntries` 目录优先 + 三种排序字段 × 升降序；`canDropTarget` 拒自身/拒子孙/拒文件目标/放行合法目录；`parentDirOf` 根目录与多级路径。
  - `useFileManager.test.ts`：进入目录 push 历史、后退/前进栈行为、竞态序号丢弃过期响应、选择集增删与 Shift 范围逻辑、Ctrl+A 全选、切目录/搜索清空选择、prefs 读写与损坏 JSON 兜底。
  - `useCenterTabs` 既有用例回归：新增 `openFileManagerTab` 不破坏现有 open*/close*/restore* 行为（同会话重复打开只激活不新建；关 Tab 后 activeTabId 回落规则不变）。
- **后端（`backend-ts npm test`）**：`listDirectory` 响应条目含 `mtimeMs`（文件 > 0，目录亦有）；回归现有行为（500 上限、目录优先、`truncated` 语义、symlink 判定）不变。
- **回归（手测清单，随 PR 描述）**：入口仅 CLOUD 显示、LOCAL 不显示；打开管理器 Tab 后切到文件 Tab 再切回，目录/选择/搜索原样恢复；上传文件/文件夹/拖拽导入（含拖到文件夹格）；拖拽移动（含移进自己子孙被拒）；批量删除强确认；侧边栏复制 → 管理器粘贴、反向亦成立、跨会话粘贴提示；Agent 写入中触发 3044 面板与强制重放；重名上传 3045 覆盖询问；搜索点击跳转 + 选中；树中定位展开高亮且管理器 Tab 不关；双击打开中央 Tab；删除/重命名后中央 Tab 自动校正（关/改路径）；视图/排序刷新页面后保持；Delete/F2/Ctrl+A 在输入框聚焦时不劫持；空目录空状态；微信/安卓环境下载走 DownloadLinkDialog。

## 9. 变更落点清单

**backend-ts**

- `src/file/workspace-browse.service.ts`：`DirectoryEntryDTO` 加可选 `mtimeMs?: number`，`listDirectory` 条目赋 `lst.mtimeMs`；对应 spec 补断言（D12）

**desktop（新）**

- `src/components/file-browser/FileManagerPanel.vue`：Tab 内容面板、头部/第二行/状态栏、进度浮层、prefs 持久化
- `src/components/file-browser/FileManagerGrid.vue`：图标网格
- `src/components/file-browser/FileManagerList.vue`：列表
- `src/components/file-browser/FileManagerContextMenu.vue`：自研 Teleport 右键菜单（单选/多选两套菜单）
- `src/composables/useFileManager.ts` + `src/composables/useFileManager.test.ts`
- `src/utils/file-manager.ts` + `src/utils/file-manager.test.ts`

**desktop（改）**

- `src/types/file-browser.ts`：`Tab.type` union 加 `'file_manager'`；`FileNode` 加可选 `mtime?: number`；新增 `FileManagerPrefs` 类型
- `src/composables/useCenterTabs.ts`：新增 `openFileManagerTab()`（单例 id `file-manager`，已存在则激活）
- `src/components/center/CenterTabContainer.vue`：`file_manager` 渲染分支；`open-file`/`add-file-to-chat`/`paths-changed`/`tree-refresh`/`locate-in-tree` 五事件透传
- `src/components/file-browser/FileTree.vue`：工具栏「文件管理」按钮（D11）→ `openFileManagerTab()`；`defineExpose` 暴露 `reveal(relPath)`（restoreExpandedPath + selectedPaths 高亮）与 `refresh()` 转发
- `src/components/task/TaskInspector.vue`：`defineExpose` 透传 `revealInFileTree` / `refreshFileTree`
- `src/views/task/TaskView.vue`：接面板五事件——`openFileTab` / composer 注入 / `applyWorkspacePathChange` / TaskInspector 两 expose
- `src/composables/workspace-file-provider.ts`：`DirectoryResult` 条目类型加可选 `mtime?: number`（本地实现已有，无需改逻辑；cloud 类型对齐）

**文档**

- 根 `CHANGELOG.md`：发版时记前端小节（「文件」tab 新增文件管理器 Tab：双视图/多选/拖拽上传/拖拽移动/递归搜索）；`desktop/package.json` 版本用 `scripts/changelog-extract.sh ... sync-desktop`，勿手改
- `skills/mao-cli/SKILL.md`：desktop 手册文件浏览器段落补文件管理器 Tab 说明
- README / DEPLOY：无部署与配置变化，不补

## 10. 发版前检查

- `cd desktop && npm run build` 通过（vue-tsc 零错误）
- `cd desktop && npm run test:unit` 相关用例绿（新增两个 spec 文件 + useCenterTabs 回归）
- `cd backend-ts && npm run build && npm test` 绿（`mtimeMs` spec）；`git diff --stat backend-ts` 仅 `workspace-browse.service.ts` 及其 spec 两个文件
- 手测清单（§8 回归项）逐条过
- CHANGELOG 前端小节齐；mao-cli SKILL.md 同步后再打包发版
