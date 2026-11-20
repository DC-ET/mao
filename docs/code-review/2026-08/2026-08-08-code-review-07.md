# 代码审查报告：多 Git 仓库工作区（前端）

- 审查日期：2026-08-08
- 审查范围：desktop 前端 Vue/TS（`types/git.ts`、`types/electron.d.ts`、`composables/workspace-git-provider.ts`、`composables/useGitRepos.ts`、`components/task/TaskInspector.vue`、`views/task/TaskView.vue`），并沿调用链核对了 `electron/gitStatus.cjs`、`electron/main.cjs`、`electron/preload.cjs` 与 CLOUD 侧后端接口。
- 结论：发现 3 个中等严重度问题、5 个低严重度问题；单仓库回归与事件链路已确认无回归。`vue-tsc` 类型检查通过。

---

## 中等问题（建议本次修复）

### 1. 切换仓库的窗口期内，旧仓库文件列表 + 新 repoPath 打开 diff → 内容错位

- **位置**：
  - `TaskInspector.vue:398-400` — `handleOpenGitDiff` 在 emit 时读取**实时** `selectedRepoPath.value`；
  - `composables/useGitStatus.ts:51-60` — provider 变化时**不清空** `files`，仅在请求成功回调（第 33 行）才替换。
- **场景**：多仓库模式选中 A → 用户从下拉切到 B → `statusProviderRef` 变化触发 useGitStatus 刷新（B 的状态在途）→ 此时 `gitFiles` 仍是 A 的文件且非空（`GitChangeList` 的 `loading && files.length === 0` 分支不会命中，不显示"加载中"）→ 用户点击 A 的文件 → emit 携带的是**当前** `selectedRepoPath`（B），而 `file.path` 是 A 仓库的相对路径 → `TaskView.handleOpenGitDiff` 用 `getFileDiff(A 的文件路径, B)` → 在 B 仓库中解析到错误文件（同名则显示 B 的内容，不同名则空 diff/推断变更类型）。
- **建议**（任选其一）：
  - a) `useGitStatus` 在 provider 引用变化时立即清空 `files`（或暴露一个"刷新中"态，让列表显示加载占位并禁用点击）；
  - b) `open-git-diff` 的 `repoPath` 与文件列表绑定（列表渲染时捕获的 repoPath），而不是 emit 时读实时值；
  - c) `GitChangeList` 在 `loading` 且仓库刚切换时禁用 open-diff。

### 2. `useGitRepos.refresh` 无请求序号保护，并发刷新可乱序覆盖

- **位置**：`composables/useGitRepos.ts:31-60`
- **场景**：挂载时的 `watch(provider, { immediate: true })`、切 Git Tab 的 `refreshAll`、任务阶段结束 watcher 可能并发调用 `refresh()`。若慢的旧请求后返回，会覆盖新请求的结果（`repos` / `selectedRepoPath` 回退到旧快照），下拉与摘要短暂错乱，并额外触发一次选中仓库的状态刷新。
- **建议**：仿照 `useGitStatus` 的 `requestSeq` 机制，仅采纳最后一次请求的结果。

### 3. `getRepos` 失败时多仓库 UI 静默消失，无任何错误提示

- **位置**：`TaskInspector.vue:280-289`（解构 `useGitRepos` 时未取 `error`）；`useGitRepos.ts:54-58`（失败时 `repos=[]`、`isRootGit=false`）。
- **场景**：CLOUD 网络抖动或后端异常 → `multiRepoMode` 变 false → `showGitTab`/`gitSummaryVisible` 均回落为根目录"非 git"判定 → Git Tab 与摘要行**整体消失**，用户无感知、无重试入口。
- **建议**：解构 `useGitRepos` 的 `error` 并在 Git Tab / 摘要行展示失败态 + 重试（对齐 `GitChangeList` 的 error 态）。

---

## 低严重度问题（可择机处理）

### 4. 切换仓库后加载期间，列表仍展示旧仓库文件（与 #1 同源）

- `useGitStatus.ts` 在 provider 变化时不立即清空 `files`，且 `GitChangeList` 的"加载中"仅覆盖 `files.length === 0`，导致切换仓库后旧文件树短暂可见（只有刷新图标转圈）。建议切换时清空 `files` 或显示加载占位。

### 5. 单仓库模式下每次 `refreshAll` 都额外调用一次 `getRepos`

- `TaskInspector.vue:334-336`：单仓库 / 非 git 工作区也会执行 `refreshRepos()`（额外一次 `workspace-git-repos` IPC/API + 目录扫描）。功能无碍，可缓存 `isRootGit` 结果后跳过（低优先级）。

### 6. `refreshAll` 与 `useGitStatus` 内部 watch 的重复刷新

- 当 `refreshRepos` 改变了选中仓库（如失效回退），`statusProviderRef` 变化触发 useGitStatus watch 刷新，随后 `refreshAll` 又显式 `refreshGit()` —— 同一 repoPath 请求两次。`requestSeq` 已兜底，结果正确，仅冗余。可在 `refreshAll` 中只依赖 watch 或加简单去抖。

### 7. `canUseLocalGit` 未校验 `gitRepos` 存在性

- `workspace-git-provider.ts:176`：只检查 `electronAPI.gitStatus`。若旧 preload 未暴露 `gitRepos`，多仓库调用会抛错（已被 try/catch 兜底为错误态），影响很小。建议一并校验。

### 8. （附带提示，超出前端范围）后端 `GitReposDTO` 布尔字段 getter 命名混乱

- `WorkspaceGitService.java` `GitReposDTO`：`@Data` 布尔字段 `rootGit` + 手写 `getIsRootGit()/setIsRootGit()` + `@JsonProperty("isRootGit")`，Lombok 还会生成 `isRootGit()`，Jackson 可能同时序列化出 `isRootGit` 与 `rootGit` 两个键。前端只读 `isRootGit` 当前可用，但建议统一字段命名（字段直接命名 `isRootGit` 或删掉手写 getter）。

---

## 已验证无问题（回归确认）

- **单仓库回归**：`multiRepoMode = !isRootGit && repos.length > 0`；根为 git 时 `getRepos` 返回 `isRootGit=true, repos=[]`，下拉/摘要多仓库分支均不渲染，`showGitTab`/`gitSummaryVisible` 在非多仓库路径与旧版逻辑完全等价。
- **默认选中**：`defaultRepoPath` 取第一个有变更的仓库、全干净取第一个；刷新时保留仍有效的用户选中，符合"默认选中 + 不持久化记忆"语义。
- **摘要行与下拉一致性**：两者同源读取 `repos` / `selectedRepoPath`，点击摘要项 `selectRepo + 切 Git Tab`，联动正确。
- **diff tab id 唯一性**：`change.path = repoPath + '/' + diff.path` 前缀保证跨仓库同名文件 tab id 不冲突；`openDiffTab` 以 `git-diff:` + path 为 id，多仓库下唯一。
- **provider 为 null 空态**：`useGitRepos` 清空状态、`useGitStatus` 清空、`refreshAll` 以 `gitEnabled` 守卫，均正确。
- **open-git-diff 事件链**：`TaskInspector` emit(file, repoPath) → `TaskView.handleOpenGitDiff(file, repoPath)` → `provider.getFileDiff(file.path, repoPath)` → CLOUD 携带 repoPath 参数 / LOCAL `electronAPI.gitFileDiff(workspace, repoPath, path)` → `main.cjs` → `gitStatus.cjs getGitFileDiff(workspace, repoPath, relativePath)`，全链路一致。
- **刷新时序**：`refreshAll` 先 `await refreshRepos()` 再 `refreshGit()`，`useGitStatus` 的 `requestSeq` 保证乱序请求以最新为准，默认选中后状态始终使用正确的 repoPath。
