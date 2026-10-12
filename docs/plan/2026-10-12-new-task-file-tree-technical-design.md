# 新建会话预显工作区文件树技术方案（LOCAL + CLOUD 双模式）

- 状态：已实施（2026-10-12 落地，分支 feat/new-task-file-tree）
- 日期：2026-10-12
- 能力底座：[2026-10-12-file-manager-tab-technical-design.md](2026-10-12-file-manager-tab-technical-design.md)（中央 Tab 文件管理器，共享同一 `WorkspaceFileProvider` 抽象）、[2026-10-09-workspace-file-manager-technical-design.md](2026-10-09-workspace-file-manager-technical-design.md)（CLOUD 工作区读写端点族）。本方案主体是侧边栏「文件」Tab 的**提前显形**与 CLOUD 无会话读链路，与上述两份不冲突：管理器 Tab 入口仍要求真实会话（`canWrite` 口径不变），本方案只把「只读浏览 + 添加到聊天」提前到新建态。

## 1. 需求背景

新建会话时用户已选定工作区（LOCAL 选了本地目录 / CLOUD 选了云端项目），但右侧边栏只有「任务」一个 Tab，文件树不显示，无法通过右键「添加到聊天」把工作区里的文件加进输入框——而「添加到聊天」本身只是往编辑器插一个 `@{路径}@` 引用，并不需要会话存在。目标：**选定工作区后，右侧「文件」Tab 与文件树立即可见**，只读浏览、打开文件、添加到聊天可用；写操作仍等会话创建后开放。

现状调查（三道关卡，任何一道不过都看不到树）：

1. **Tab 显示条件**：`TaskInspector.vue` L418–423 `showFileTreeTab`——CLOUD 要求 `sessionId`，非 CLOUD 要求 `workspace`。新建态两者皆空：`TaskView.vue` 的 `workspace`（L818）、`projectKey`（L816）、`executionMode`（L814）只在 `enterNewTaskMode` 入口按路由默认值设一次，之后用户在选择器里改工作区/项目/模式**不会回写**；`ChatPanel` 的 `syncChatState`（L342–351）只带 `workspace`（且新建态下传的是 useChat 的 `''`，直到首发 L703 才赋值），不带 `executionMode`/`projectKey`。截图里右侧边栏连 Tab 栏都没有，即 `showTabBar`（L498）两项皆假。
2. **文件 provider 为空**：`workspace-file-provider.ts` L341–355 的工厂在「CLOUD 无 sessionId」且「无本地 workspace」时返回 null。
3. **CLOUD 浏览接口全部强绑会话**：`file.routes.ts` 的 `workspace-directory/read/search/preview` 都过 `requireOwnedSession`（L50–59），没有会话直接 `PARAM_INVALID`。

关键有利条件（设计建立在其上）：

- **无会话访问云端项目已有先例**：`file.routes.ts` L323–340 `project-list` 按 `projectKey` 解析 `<workspaceRoot>/<userId>/projects/<slug>`（`CloudWorkspaceResolver.normalizeAndValidate` + `isUnder` 越权校验）；`ChatInput.vue` L497–503 新建态文件提及自动补全已经在用它。文件树复刻这条安全路径即可。
- **`WorkspaceBrowseService` 零改动**：`listDirectory/readFile/searchFiles/readPdfFile`（`workspace-browse.service.ts` L74/297/130/220）只收绝对工作区路径，与「这个路径来自会话还是来自项目名」无关。
- **添加到聊天链路无会话依赖**：`FileTree.vue` L291–295 `handleAddToChat` → `TaskView.handleAddFileToChat`（L194–205）→ 当前激活 Tab 的 `ChatInput.insertFileReference`（`ChatInput.vue` L1167–1182）插 `fileReference` 节点，纯文本序列化为 `@{路径}@`（`FileReferenceNode.ts` L58–60）。发送建会话时服务端按会话工作区解析引用；而 `session.service.ts` L207–222 建会话时把同一个 `cloudProjectKey` 解析成**同一个** `projectPath`——路径天然对齐。
- **打开文件链路无会话依赖**：`CenterTabContainer.vue` L5–10 的 `FileViewer` 只收 `filePath` + `fileProvider`，读文件全走 provider；project provider 实现 `readFile/previewFile` 即可打开，不需要 sessionId。
- **写能力门已就绪**：`FileTree.vue` L216 `canWrite = executionMode === 'CLOUD' && numericSessionId > 0`，新建态自动为假，工具栏上传按钮、右键写菜单项、`commitDraft`（L338）全部让路，只读树是现成形态。
- **Git Tab 不会误出**：`workspace-git-provider.ts` L305–313 的工厂同样要求 sessionId（LOCAL 还额外要求），新建态 gitProvider 为 null，`showGitTab` 为假。
- **下载/路径复制有兜底**：`FileTree.vue` L553/L590 对 provider 缺失 `downloadFile/downloadDirectory` 已有 warning 兜底；`getAbsolutePath` 缺失时回退 `resolveWorkspaceFilePath(workspace, path)`（L263–269）。

## 2. 需求描述

### 2.1 目标

1. **LOCAL 新建态**：选定本地目录后，右侧「文件」Tab 立即可见；目录展开/折叠、筛选框、双击打开文件（中央 Tab FileViewer）、右键「添加到聊天」「复制相对路径」「在 Finder 中打开」全部可用。纯前端改动。
2. **CLOUD 新建态**：选定云端项目后同样可见；目录/读文件/搜索/PDF 预览走后端新增的 project 只读端点族；打开文件、添加到聊天、复制相对路径可用。
3. **写操作一律不提前**：新建/重命名/删除/剪切/复制/粘贴/上传/下载在无会话态不可用（LOCAL 维持只读现状；CLOUD 维持 `canWrite` 口径）。
4. **切换即同步**：新建态改选工作区/项目/模式，文件树立即切换（`useFileBrowser` 的 provider watch 已处理清树与竞态）；首发建会话后 provider 从 project 版切到 session 版，同一目录内容不闪。
5. **刷新可恢复**：新建态路由（`?newTask=1&cloudProjectKey=...` 等）刷新后 `enterNewTaskMode` 恢复默认值，文件树随恢复后的选择重新出现。

### 2.2 非目标（明确不做）

- **不做无会话写操作**：不新增 project 写端点族（mkdir/write/rename/move/copy/delete/upload），写入锁、活动记录、剪贴板 sessionId 校验都依附于会话，提前没有承载。
- **不做 Git Tab 提前**：gitProvider 维持 sessionId 绑定。
- **不改中央 Tab 文件管理器（10-12 方案）的范围**：管理器入口仍只在真实 CLOUD 会话显示；本方案与其共享 `createProjectProvider`，但管理器不为新建态开口。
- **不做「文件」Tab 默认激活**：新建态仍默认落在「任务」Tab，用户点「文件」查看（与真实会话一致）。
- **不做安卓单独适配**：共用同一份 desktop 响应式 UI，窄栏形态与真实会话一致。
- **不加权限码、不动角色体系、零 DDL、零新依赖。**

## 3. 范围界定

### 3.1 做什么

| 层 | 内容 |
|---|---|
| backend-ts（新） | 4 个 project 只读端点：`project-directory` / `project-read` / `project-search` / `project-preview`（§5.1） |
| backend-ts（改） | `file.routes.spec.ts`：补 4 端点用例（happy path + 不存在项目 + 非法 key + 跨用户不泄漏） |
| desktop（新） | `workspace-file-provider.ts` 内 `createProjectProvider(projectKey)`（§5.2）；`workspace-file-provider.test.ts`（§8） |
| desktop（改） | `useWorkspaceFileProvider` 加第 4 参 `projectKey` 并调整分支序（§5.3）；`TaskView.vue` 新建态回写 watcher + `syncChatState` 守卫 + provider 传参（§5.3）；`TaskInspector.vue` `showFileTreeTab` 放行（§5.4）；`FileTree.vue` + `FileTreeContextMenu.vue` 菜单能力显隐（§5.4） |

### 3.2 不做什么

- 不改 `WorkspaceBrowseService` 任何逻辑（4 端点直接调用现有方法）。
- 不改 `useFileBrowser` / `useCenterTabs` / `CenterTabContainer` / `FileViewer` / `ChatInput` / `FileReferenceNode`——添加到聊天与打开文件链路零改动。
- 不改真实会话的任何现有行为：provider 分支序调整对「CLOUD 有 sessionId」「LOCAL 有 workspace」两个现路径是恒等改写（§5.3 分支序表）。
- 不改 `project-list` 现有行为（可选的内联解析收敛见 §7 开放问题，本方案不做）。

## 4. 关键决策

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 双模式覆盖策略 | LOCAL 纯前端（状态同步即通）；CLOUD 前端 + 后端 4 个只读端点。不做「先只上 LOCAL」的拆分——需求明确双模式都要，且 CLOUD 是安卓唯一模式 |
| D2 | provider 工厂 | `useWorkspaceFileProvider(executionMode, workspace, sessionId, projectKey)` 加第 4 参；分支序：CLOUD+sessionId → cloud；CLOUD+projectKey → project；LOCAL+workspace → local；其余 null |
| D3 | 新建态状态归属 | TaskView 的 `newTaskMode/newTaskWorkspace/newTaskCloudProjectKey` 三兄弟是新建态 `executionMode/workspace/projectKey` 的唯一事实源（一个 watch 回写）；`syncChatState` 在新建态不写 workspace，杜绝双写抢 |
| D4 | 后端端点命名与安全 | `project-*` 前缀对齐既有 `project-list`；解析统一走 `CloudWorkspaceResolver.normalizeAndValidate` + `resolveProjectWorkspace`（内含 `assertUnderUserSandbox`），userId 一律取自 token（`requireUserId`），不信前端传参 |
| D5 | 不存在项目的口径 | 目录/搜索返回**空列表**（与 `project-list` 对不存在目录返 `files: []` 一致），文件树显示「空目录」而不是错误行；读/预览不单独判存在性，走 service 既有错误路径（FileViewer 展示错误态） |
| D6 | 写能力门 | `FileTree.canWrite` 口径不变（CLOUD && sessionId>0）；新建态只读树，右键只剩复制路径/添加到聊天/打开 Finder/（CLOUD 会话态才有下载） |
| D7 | 下载与复制绝对路径的显隐 | 无会话态 provider 无 `downloadFile/downloadDirectory/getAbsolutePath`：下载菜单项按 provider 能力隐藏（不再走 warning 兜底）；「复制绝对路径」在 provider 无 `getAbsolutePath` 且 workspace 为空时隐藏（避免把相对路径当绝对路径复制） |
| D8 | 打开文件 | FileViewer 只依赖 provider，project provider 实现 `readFile/previewFile` 即可以中央 Tab 打开，无需 sessionId；打开行为与真实会话完全一致 |

## 5. 详细设计

### 5.1 后端：project 只读端点族（`file.routes.ts`）

四个 GET 端点，全部只读，全部复用 `WorkspaceBrowseService` 现有方法：

| 端点 | 参数 | 响应 | service 调用 |
|---|---|---|---|
| `/v1/files/project-directory` | `projectKey`（必填）、`dir`（可选） | `{ entries, truncated }` | `listDirectory(projectPath, dir)` |
| `/v1/files/project-read` | `projectKey`、`path`（必填）、`offset`、`limit` | `FileContentDTO` | `readFile(projectPath, path, offset, limit)` |
| `/v1/files/project-search` | `projectKey`、`pattern`（必填）、`limit` | `{ entries, truncated }` | `searchFiles(projectPath, pattern, limit)` |
| `/v1/files/project-preview` | `projectKey`、`path`（必填） | PDF 字节流（`sendFile` inline） | `readPdfFile(projectPath, path)` |

共享解析helper（放在 `registerFileRoutes` 内部，与 `requireOwnedSession` 并列）：

```ts
function resolveUserProjectWorkspace(userId: number, projectKey: string | null | undefined): string {
  if (projectKey == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
  const slug = CloudWorkspaceResolver.normalizeAndValidate(projectKey);
  return CloudWorkspaceResolver.resolveProjectWorkspace(pathSandbox, userId, slug);
}
```

- **越权防护**：`resolveProjectWorkspace` 内部 `assertUnderUserSandbox`（`cloud-workspace-resolver.ts` L30–43）把解析结果钳制在 `<root>/<userId>` 内；slug 非法（`..`、保留字 `projects/sessions`、超长、非法字符）在 `normalizeAndValidate` 即 400。他人项目自然落在他人用户根下，请求方看到的是「不存在」而非内容——与 `project-list` 现行口径一致。
- **不存在项目（D5）**：`project-directory`/`project-search` 在 `existsSync(projectPath)` 为假时直接返回 `{ entries: [], truncated: false }`（对齐 `project-list` L333–335 的空列表口径）；`project-read`/`project-preview` 不判存在性，`readFile/readPdfFile` 对缺失文件抛既有业务错误，FileViewer 展示错误态即可。
- **参数校验**：`pattern` 空/超长的校验与 `workspace-search`（L129–140）逐字一致；`offset/limit` 默认值同 `workspace-read`（0 / 5000）。
- **权限面**：与现有 `/v1/files/*` 一致——plain fastify 路由 + `requireUserId`，不加权限码、不改拦截器白名单。
- **spec 落点**：扩 `file.routes.spec.ts` 既有 fixture（L24–28 的 `x-test-user` hook、L71–74 的 tmp root + `<root>/7/projects/demo`、L51–55 的 browse service mock），断言见 §8。

### 5.2 前端：`createProjectProvider`（`workspace-file-provider.ts`）

```ts
export function createProjectProvider(projectKey: string): WorkspaceFileProvider {
  return {
    async listDirectory(relativeDir) {
      try {
        const { data } = await api.get('/files/project-directory', {
          params: { projectKey, dir: relativeDir || undefined },
        })
        return { entries: data?.entries ?? [], truncated: data?.truncated ?? false }
      } catch (e: any) { return { error: e.message || '读取目录失败' } }
    },
    async readFile(relativePath, opts) { /* GET /files/project-read，offset/limit 默认同 cloud */ },
    async searchFiles(pattern, limit = 100) { /* GET /files/project-search */ },
    async previewFile(relativePath) {
      // 复刻 createCloudProvider L233–252：fetch + Bearer token → blob；非 2xx 走 extractDownloadError
    },
    // getAbsolutePath / downloadFile / downloadDirectory 不实现（无会话不支持）
  }
}
```

- 错误形状与 `createCloudProvider` 完全一致（catch 后返回 `{ error }`），`useFileBrowser` 的 error 节点分支（L23–30）直接兼容。
- 不实现 `getAbsolutePath/downloadFile/downloadDirectory`；`FileTree` 侧按 D7 显隐对应菜单项，不留死入口。

### 5.3 前端：provider 工厂与新建态状态同步

**工厂分支序**（`useWorkspaceFileProvider`，L341–355 改写）：

| executionMode | sessionId | projectKey | workspace | 结果 |
|---|---|---|---|---|
| CLOUD | 有 | — | — | `createCloudProvider(sessionId)`（现路径，恒等） |
| CLOUD | 无 | 有 | — | `createProjectProvider(projectKey)`（**新增**） |
| CLOUD | 无 | 无 | — | null（同现状） |
| LOCAL | — | — | 有 | `createLocalProvider(workspace)`（现路径，恒等） |
| LOCAL | — | — | 无 | null（同现状） |

对现有两条路径是恒等改写；唯一行为差异是「CLOUD 且 sessionId 瞬态为空但 workspace 有值」时从 local provider 改为 null——原行为本身就是错的（CLOUD 会话把服务端路径当本地路径读），新顺序顺带修正。

**新建态回写**（`TaskView.vue` 新增，置于 `provide('newTaskWorkspace', ...)` 等声明之后）：

```ts
// 新建态：选择器里的工作区/项目/模式是右侧边栏与文件 provider 的事实源。
// 真实会话的这三个值由 loadSession / enterNewTaskMode / syncChatState 拥有，互不越写。
watch(
  [isNewTaskMode, newTaskMode, newTaskWorkspace, newTaskCloudProjectKey],
  () => {
    if (!isNewTaskMode.value) return
    executionMode.value = newTaskMode.value
    workspace.value = newTaskMode.value === 'LOCAL' ? newTaskWorkspace.value : ''
    projectKey.value = newTaskMode.value === 'CLOUD' ? newTaskCloudProjectKey.value : ''
  },
  { immediate: true },
)
```

配套守卫（`syncChatState`，L154–168）：`if (state.workspace !== undefined && !isNewTaskMode.value) workspace.value = state.workspace`。理由：`ChatPanel.syncToTaskView` 每次把所有字段整体上报，新建态下它携带的 `workspace` 是 useChat 的 `''`（首发前不赋值），不守卫会把用户刚选的工作区擦掉。守卫后双写窗口关闭，归属规则单一。

**切换时序**：

- 新建态改选项目 → `newTaskCloudProjectKey` 变 → watcher 回写 `projectKey` → provider computed 重建 → `useFileBrowser` 的 `watch(provider)`（L204–210）自增竞态序号、清展开态、清树、重拉根目录——切工作区不闪旧内容，现成机制。
- 首发建会话 → `router.replace('/tasks/{sid}')` → `sessionIdParam` 落地 → `isNewTaskMode` 转假 → watcher 停写 → `loadSession`（L858+）从会话快照写 `executionMode/workspace/projectKey` → `activeSessionIdRef` 落地 → provider 切 `createCloudProvider(sid)`。新旧 provider 指向同一目录，根列表重拉一次；展开态被 provider watch 清空（已知代价，§7）。
- LOCAL 首发同理：`workspace` 从本地路径切到同一本地路径（L703 发送时 useChat 侧也赋同一值），provider 恒为 local，仅 watch 触发一次重拉。

**provider 传参**（TaskView L425）：`useWorkspaceFileProvider(executionMode, workspace, activeSessionIdRef, projectKey)`；gitProvider（L426）不动。

### 5.4 TaskInspector 与 FileTree 的显形

**Tab 放行**（`TaskInspector.vue` L418–423）：

```ts
const showFileTreeTab = computed(() => {
  if (props.executionMode === 'CLOUD') {
    // 无会话的新建态：已选云端项目也能提前看树（project provider，只读）
    return !!props.sessionId || !!props.projectKey
  }
  return !!props.workspace
})
```

`props.projectKey` 是 TaskInspector 现有 prop（供 `workspaceLabel` 用），零新增 prop。真实 CLOUD 会话 `sessionId` 恒非空，行为不变；新建态 CLOUD 由 `projectKey` 放行。放行后 `showTabBar`（L498）为真，Tab 栏出现「任务/文件」两项，`inspectorActiveTab` 默认仍为 `workspace`，用户点「文件」看树。

**FileTree 就绪判断**（L235–240）：CLOUD 分支 `isReady = !!props.provider`——project provider 非空即就绪；空项目目录走到「空目录」空态（L79），不报错。`emptyMessage` 的「请先开始对话」仅在 provider 为 null 时出现，而该情形下 Tab 根本不显示，文案不用改。

**菜单能力显隐**（D7，`FileTree.vue` L137–141 + `FileTreeContextMenu.vue`）：

- `show-download-actions` 从 `executionMode === 'CLOUD'` 改为 computed `canDownload = props.executionMode === 'CLOUD' && !!props.provider?.downloadFile`；无会话态隐藏下载项，替代 L553 的 warning 兜底（兜底代码保留）。
- 「复制绝对路径」增加显隐条件：`!!props.provider?.getAbsolutePath || !!props.workspace`。无会话 CLOUD 两者皆空时隐藏（此时复制出来的必然是相对路径，与「复制相对路径」重复且名不副实）；LOCAL 新建态有 workspace、真实 CLOUD 会话有 workspace（服务端路径），均保持显示。

### 5.5 无会话下的两条关键链路

- **添加到聊天**：`handleAddToChat` → `emit('add-file-to-chat', path)` → `TaskView.handleAddFileToChat`（L194–205）取 `activeTabId`（新建态为 `'chat'`）→ `chatInputHandles['chat']`（ChatPanel 的 ChatInput 默认 `registerKey: 'chat'`，`ChatInput.vue` L210）→ `insertFileReference` 插 `@{path}@`。发送时 `getPlainText` 序列化（L1184–1186）进消息体；后端建会话落 `workspace = projectPath`（`session.service.ts` L213），`FILE_REF_PATTERN` 按会话工作区还原路径——与文件树展示的是同一目录，引用必然可达。
- **打开文件**：`open-file` → `openFileTab(path, title)`（`useCenterTabs.ts` L217）→ 中央 Tab `FileViewer(filePath, provider)`；project provider 的 `readFile/previewFile` 供数（`FileViewer.vue` L223/L183）。新建态无 sessionId，`getSessionState` 对空 key 回落固定占位键 `__new_task__` 承载 Tab 状态（原实现返回一次性对象，`openFileTab` 的写入被静默丢弃、中央区无任何反应）；占位状态不写 localStorage，会话落地后 `currentSessionId` 切到真实 id 即让位。

### 5.6 边界与降级

- **项目目录不存在**（新项目名 / 留空临时区）：directory/search 返空 → 「空目录」空态；读文件报错由 FileViewer 承接。临时区（cloudProjectKey 为空）根本不显示 Tab（`projectKey` 为空串）。
- **通道会话带入的 projectKey**（飞书群 `oc_*` / 钉钉 / 微信 `weixin-bot`）：`cloudProjectKeyForNewTask` 只排除「独立 CLOUD 会话」（projectKey=会话 id），通道 key 会带进新建态。此时「文件」Tab 放行且目录不存在、恒显「空目录」——这是有意的：新建态带该 key 发送时后端 `initializeCloudWorkspace` 会建出 `<root>/<uid>/projects/<key>` 并作为会话工作区（`session.service.ts` L216–222），空树是该未来工作区的真实预览；若改为隐藏 Tab，反而会出现「发送前没有、发送后才出现」的不一致。
- **非法 projectKey**（手改 URL/状态）：`normalizeAndValidate` 400 → provider 返回 error 节点，树显示错误行，不白屏。
- **越权**：slug 钳制在请求者用户根内，他人项目表现为「不存在」。
- **目录 500 条 / 搜索 100 条上限**：`WorkspaceBrowseService` 现有边界，沿用不放大。
- **非 Electron 的 Web 端开 LOCAL**：新建态 config bar 的 LOCAL 单选受 `isElectronClient` 门控（`ChatNewTaskConfigBar.vue` L17），Web 端选不到 LOCAL，不涉及。
- **移动端窄栏**：与真实会话的侧边栏文件树同一组件同一形态，无新适配。

## 6. 实现步骤

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 后端 | `file.routes.ts` 4 端点 + `resolveUserProjectWorkspace` helper；`file.routes.spec.ts` 补例 | 小~中 |
| P2 provider | `createProjectProvider` + `useWorkspaceFileProvider` 第 4 参与分支序改写；`workspace-file-provider.test.ts` | 小 |
| P3 状态同步 | TaskView 新建态回写 watch + `syncChatState` 守卫 + provider 传参；`TaskInspector.showFileTreeTab` 放行 | 小 |
| P4 显隐打磨 | FileTree/FileTreeContextMenu 下载与复制绝对路径的能力显隐（D7）；CLOUD 空态文案核对 | 小 |

P1 完成即可 `backend-ts` 独立构建测试通过；P2–P4 是一个前端提交单元，前后端可并行。P4 可与 P3 合并提交。

## 7. 风险与开放问题

- **双写抢（已规避）**：`syncChatState` 与新建态 watch 都可能写 `workspace`。归属规则（D3）+ 守卫后只有一位写者；残留窗口仅存在于「首发跳转后、loadSession 完成前」，此时 ChatPanel 上报的 workspace 与会话值相同（L703 同源），无实际冲突。
- **首发后展开态清空**：provider 切换触发 `useFileBrowser` 的 watch 清 `expandedPaths`，用户展开的目录在会话创建后折叠。接受（根列表重拉一次的代价）；若后续要保，可在 provider watch 里对「新旧 provider 指向同一工作区」做展开态保留，属优化不在本方案。
- **空态与错误态的心智**：不存在项目显示「空目录」而非「项目不存在」，用户可能误以为项目为空。缓解：CLOUD 新建态的项目选择器只列已存在的项目（`newTaskCloudProjects` 来自 `fetchCloudProjects`），手输新项目名是少数路径，且该场景下会话创建时才会 `ensureWorkspaceDirectory`——「空目录」语义上成立。
- **`project-list` 与本方案 helper 的解析重复**：`project-list`（L327–329）内联了一份解析逻辑。本方案不顺手收敛（避免扩大 diff），留作开放问题：后续可将 `project-list` 也切到 `resolveUserProjectWorkspace`，两处行为自动对齐。
- **开放问题：新建态是否默认落「文件」Tab**：当前不默认（与真实会话一致）。若用户反馈「选了工作区还是找不到文件树」，可评估在新建态把 `inspectorActiveTab` 初始为 `filetree`——一行改动，留后续。
- **开放问题：无会话搜索**：project provider 实现了 `searchFiles`（树顶筛选框可用），但筛选框是「当前已加载层级内过滤」还是「递归搜索」取决于 FileTree 现行实现（`filterText` 行为），本方案不改其语义，仅保证 provider 就绪。

## 8. 测试要点

- **后端（`cd backend-ts && npm test`，扩 `file.routes.spec.ts`）**：
  - `project-directory?projectKey=demo` → code 0，entries 来自 browse service mock；缺 `projectKey` → code ≠ 0；`projectKey=..`（或保留字）→ code ≠ 0；`projectKey=ghost`（不存在）→ `entries` 为空数组。
  - `project-read?projectKey=demo&path=a.txt` → content 命中 mock；缺 `path` → code ≠ 0。
  - `project-search?projectKey=demo&pattern=a` → entries 命中；空 pattern → code ≠ 0。
  - 跨用户不泄漏：`x-test-user: 8` + `projectKey=demo` → `entries` 为空（demo 在用户 7 根下）。
- **前端单测（`cd desktop && npm run test:unit`，vitest + `vi.mock('../../api')`，仿 `task-inspector-context-race.test.ts` L33 的 mock 式）**：
  - 新增 `workspace-file-provider.test.ts`：分支序四格（CLOUD+sessionId / CLOUD+projectKey / LOCAL+workspace / 全空）；project provider 的 `listDirectory/readFile/searchFiles` 请求 URL 与 params 正确（`projectKey` 透传）；`listDirectory` 抛错时返回 `{ error }` 形状。
  - `useFileBrowser` 既有竞态用例回归（provider 快速切换丢过期响应）不破。
- **手测清单（随 PR 描述）**：
  - LOCAL（Electron）：新建态选本地目录 → 「文件」Tab 出现 → 展开目录/筛选/双击打开（中央 Tab）/右键添加到聊天（输入框出现引用芯片）/复制相对路径/在 Finder 中打开；写菜单项不出现；改选目录树立即切换。
  - CLOUD（桌面 + 安卓各一遍）：新建态选已有项目 → Tab 出现 → 同上只读操作；打开文本文件与 PDF；下载菜单项不出现。
  - CLOUD 不存在项目（手输新项目名）→ 「空目录」空态，无错误行。
  - 首发发送：建会话后「文件」Tab 仍在、内容与新建态一致（根重拉一次）；`@{路径}@` 引用被 Agent 正确读取。
  - 刷新页面（路由带 `newTask=1&cloudProjectKey=...`）→ 选择恢复 → 树重现。
  - 真实会话回归：文件 Tab、Git Tab、管理器入口（10-12 方案落地后）行为不变。

## 9. 变更落点清单

**backend-ts**

- `src/file/file.routes.ts`：新增 `project-directory` / `project-read` / `project-search` / `project-preview` 四端点 + `resolveUserProjectWorkspace` helper（D4/D5）
- `src/file/file.routes.spec.ts`：补四端点用例（§8）

**desktop（改）**

- `src/composables/workspace-file-provider.ts`：新增 `createProjectProvider(projectKey)`；`useWorkspaceFileProvider` 加第 4 参 `projectKey: Ref<string>` 并按 §5.3 分支序表改写（D2）
- `src/views/task/TaskView.vue`：新建态回写 watch + `syncChatState` 守卫（D3）；L425 provider 传 `projectKey`
- `src/components/task/TaskInspector.vue`：`showFileTreeTab` 放行 `sessionId || projectKey`（§5.4）
- `src/components/file-browser/FileTree.vue`：`show-download-actions` 改 computed `canDownload`；复制绝对路径显隐条件（D7）
- `src/components/file-browser/FileTreeContextMenu.vue`：随上（props 不变，仅显隐来源变化；如需显式传 `canDownload` 则加一个可选 prop）

**desktop（新）**

- `src/composables/workspace-file-provider.test.ts`（§8）

**文档**

- 根 `CHANGELOG.md`：后端小节（project 只读端点族）+ 前端小节（新建态文件树提前可见，LOCAL/CLOUD）；`desktop/package.json` 版本用 `scripts/changelog-extract.sh ... sync-desktop`，勿手改
- `skills/mao-cli/SKILL.md`：新建会话/文件浏览器段落补「选定工作区后即可提前浏览文件并添加到聊天」
- README / DEPLOY：无部署与配置变化，不补

## 10. 发版前检查

- `cd backend-ts && npm run build && npm test` 绿（四端点 spec）
- `cd desktop && npm run build` 通过（vue-tsc 零错误；`useWorkspaceFileProvider` 仅 TaskView 一个调用点，签名改动不漏）
- `cd desktop && npm run test:unit` 相关用例绿（新增 provider spec + useFileBrowser 回归）
- 手测清单（§8）逐条过，LOCAL 与 CLOUD 各一遍，安卓至少过一遍 CLOUD 只读链路
- CHANGELOG 两小节齐；mao-cli SKILL.md 同步后再打包发版
