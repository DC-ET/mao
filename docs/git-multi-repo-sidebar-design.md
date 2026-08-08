# 多 Git 仓库工作区：右侧边栏 Git 信息与 Git Tab 展示方案

> 状态：已与需求方确认，待评审
> 涉及端：后端（backend/）、桌面端（desktop/）、Electron 壳（desktop/electron/）

## 一、需求背景

客户端任务页右侧边栏当前展示两部分 Git 能力：

- **工作区摘要行**：工作区分支 + 变更统计（`+X -Y` 或「工作区干净」）；
- **Git Tab**：变更文件树（按目录聚合、可展开/点击查看 diff）。

两者的显示前提是 `gitStatus.isGit === true`，即**工作区本身是一个 git 仓库**。但实际使用中存在一类工作区：工作区根目录本身**不是** git 仓库，其**一级子目录**下散落着多个独立 git 仓库（多 git 项目工作区，如「一个目录装多个代码项目」）。此类工作区当前完全不展示任何 Git 信息，右侧边栏的 Git 能力对用户不可见、不可用。

本方案为该场景补齐 Git 展示：多仓库工作区同样展示 Git 摘要与 Git Tab，并通过下拉切换查看特定仓库。

## 二、需求描述

### 2.1 现状（代码事实）

| 层 | 位置 | 现状 |
|----|------|------|
| 前端判定 | `desktop/src/components/task/TaskInspector.vue` | `showGitTab` / `gitSummaryVisible` 仅在 `gitStatus.value?.isGit === true` 时成立 |
| 前端数据 | `desktop/src/composables/workspace-git-provider.ts` | `WorkspaceGitProvider.getStatus()` / `getFileDiff(relativePath)`；CLOUD 走后端 API（sessionId），LOCAL 走 Electron IPC（workspace） |
| 前端状态 | `desktop/src/composables/useGitStatus.ts` | provider 变化 / 任务阶段结束自动刷新 |
| 后端 | `backend/.../file/service/WorkspaceGitService.java` | `getStatus(workspace)`：对工作区根执行 `git rev-parse --show-toplevel`，失败即 `isGit=false`；变更文件路径、diff 均相对该仓库根 |
| 后端接口 | `backend/.../file/controller/FileController.java` | `GET /workspace-git-status`、`GET /workspace-git-diff`（均按 sessionId 取 workspace） |
| Electron | `desktop/electron/gitStatus.cjs` | 与后端同构：`getGitStatus(workspace)` / `getGitFileDiff(workspace, relativePath)`，均以工作区根定位仓库 |

### 2.2 目标（要做的）

1. **工作区本身是 git 仓库**：完全保持现有逻辑与界面，不做任何改变（不出现仓库下拉，不列子仓库）。
2. **工作区本身不是 git 仓库，但一级子目录中存在 ≥1 个 git 仓库**（下称「多仓库模式」）：
   - **Git Tab 出现**，工具栏新增**仓库下拉（单选）**，选项为各仓库**目录名**，选中后显示「目录名 · 分支」；
   - Git Tab 展示**当前选中仓库**的变更文件树、变更数与刷新；
   - **工作区摘要行出现**，以**逐仓库列表**展示**所有有变更**的仓库（目录名 + 分支 + `+X -Y`）；所有仓库都干净时显示「N 个仓库 · 全部干净」；
   - 点击摘要行中的仓库项 → 自动切到 Git Tab 并选中该仓库；
   - 默认选中：按目录名排序后**第一个有变更**的仓库；全部干净则选第一个；**不持久化**记忆（刷新/重新进入会话后重新默认）。
3. **双执行模式都支持**：CLOUD（后端实现）与 LOCAL（Electron 实现）行为一致。
4. **刷新时机**：进入会话 / 切换会话时扫描仓库列表；Git Tab 手动刷新按钮与任务阶段结束（RUNNING → 终态）自动刷新，均**同时刷新仓库列表与选中仓库状态**。
5. 仓库发现只扫**一级子目录**，**不设数量上限**，全部列出。

### 2.3 明确不做（不在本次范围）

- **不递归扫描**：深度 ≥2 的子目录中的 git 仓库不发现、不展示。
- **不做嵌套仓库展示**：工作区自身是 git 仓库时，即使一级子目录里还有 git 仓库，也不列出（严格走现有单仓库逻辑）。
- **不做选中记忆持久化**：不按工作区/会话记忆上次选中的仓库。
- **不做 git 写操作**：现有 Git Tab 本就是只读展示（变更列表 + diff 预览），本方案不新增 commit / push / pull / checkout 等写操作。
- **不做 submodule 特殊处理**：子模块目录（含 `.git` 文件）按普通独立仓库列出，不展开其父仓库对子模块指针的变更。
- **不覆盖新建任务模式**：无 session 时 `gitProvider` 为 null，右侧边栏本就无 Git 面板，本方案不改变。
- **不做安卓原生改动**：安卓 APP 复用 desktop 前端且仅 CLOUD 模式，后端 API 生效后自动覆盖；LOCAL 在安卓本就禁用。
- **不改变单仓库模式的任何接口契约**：现有 status / diff 调用（不带 repoPath）行为完全不变。

## 三、技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| 架构 | 沿用现有「CLOUD 后端 + LOCAL Electron」双执行模式 | 与文件浏览、现有 Git 能力同构，体验一致 |
| 后端 git 执行 | 沿用 `WorkspaceGitService` 的 `runGit`（ProcessBuilder，10s 超时） | 不引入 JGit 等新依赖，与现状一致 |
| Electron git 执行 | 沿用 `gitStatus.cjs` 的 `execFile` 封装 | 与现状一致 |
| 前端状态 | 扩展现有 composable（`useGitStatus` + 新增仓库列表状态） | 不引入新状态库 |
| 前端 UI | Element Plus `el-select`（项目已依赖） | 下拉单选、宽度受控，无需自定义组件 |
| 批量摘要并发 | 后端/Electron 对 N 个仓库**并发**执行轻量 git 统计 | 一级目录仓库数通常十几个以内，串行 3N 次调用过慢 |

## 四、总体设计

### 4.1 多仓库模式判定与数据流

新增统一入口 `getRepos()`（一次调用同时给出「根是否 git」与「仓库列表」，避免每次刷新先探测根再扫列表的两段式请求）：

```
refreshAll()
  ├─ provider.getRepos() → { isRootGit, repos[] }
  │    ├─ isRootGit = true  → 单仓库模式（现有逻辑）：repos=[], selectedRepoPath=undefined，
  │    │                     刷新 getStatus()（不带 repoPath），展示现状
  │    └─ isRootGit = false
  │         ├─ repos 为空            → 不显示 Git 摘要与 Git Tab（保持现状）
  │         └─ repos 非空            → 多仓库模式：
  │              · 摘要行渲染 repos（有变更的逐仓库列出 / 全干净显示「N 个仓库 · 全部干净」）
  │              · 确定 selectedRepoPath：默认第一个有变更的，否则第一个；校验存在性
  │              · Git Tab 刷新 getStatus(selectedRepoPath)
  │
  └─ 触发时机：进入会话/切换会话、Git Tab 手动刷新、任务阶段结束自动刷新（复用现有 watch）
```

### 4.2 关键设计约束

- **repoPath 语义**：`repoPath` 为仓库目录**相对工作区根**的路径（如 `project-a`），且必须是**一级子目录**；后端与 Electron 均做 `resolve + normalize + startsWith(workspace)` 与 sandbox 校验，防路径越界。
- **单仓库兼容**：`getStatus` / `getFileDiff` 的 `repoPath` 参数**可选**；缺省时行为与现版本完全一致，现有调用方（含未改动的其他页面）无需迁移。
- **批量摘要轻量统计**：每个仓库仅返回 `name / path / branch / changedFileCount / insertions / deletions`，**不含 files 明细**；Git Tab 的完整变更树由 `getStatus(repoPath)` 按需获取。
- **变更统计口径**：与现有 `collectChangedFiles` 完全一致（tracked diff + untracked 行数），保证单仓库/多仓库数字口径统一。
- **选中状态共享**：摘要行点击、下拉切换、Git Tab 列表共用同一 `selectedRepoPath` 状态。

## 五、接口设计

### 5.1 后端 REST API（CLOUD）

| 接口 | 变更 | 说明 |
|------|------|------|
| `GET /api/v1/files/workspace-git-repos?sessionId=` | **新增** | 返回 `{ isRootGit: boolean, repos: GitRepoSummary[] }`；`repos` 按目录名排序 |
| `GET /api/v1/files/workspace-git-status?sessionId=&repoPath=` | 扩展 | `repoPath` 可选，缺省走现有逻辑；多仓库模式传选中仓库的相对路径 |
| `GET /api/v1/files/workspace-git-diff?sessionId=&repoPath=&path=` | 扩展 | `repoPath` 可选；文件路径相对**指定仓库根** |

`GitRepoSummary` 结构：

```json
{
  "name": "project-a",
  "path": "project-a",
  "branch": "main",
  "insertions": 120,
  "deletions": 45,
  "changedFileCount": 8
}
```

### 5.2 Electron IPC（LOCAL）

| IPC | 变更 | 说明 |
|-----|------|------|
| `git-repos(workspace)` | **新增** | 返回 `{ isRootGit, repos }`，与后端结构一致 |
| `git-status(workspace, repoPath)` | 扩展 | `repoPath` 可选，缺省走现有逻辑 |
| `git-file-diff(workspace, repoPath, path)` | 扩展 | `repoPath` 可选 |

`desktop/electron/preload.cjs` 同步暴露 `gitRepos`，并扩展 `gitStatus` / `gitFileDiff` 参数；`desktop/src/types/electron.d.ts` 更新类型定义。

## 六、实现步骤

### 6.1 后端（backend/）

1. `WorkspaceGitService`：
   - 新增 `GitRepoSummaryDTO`（`name/path/branch/insertions/deletions/changedFileCount`）与 `GitReposDTO`（`isRootGit + List<GitRepoSummaryDTO>`）；
   - 新增 `listRepos(String sessionWorkspace)`：
     - 工作区根 `git rev-parse --show-toplevel` 成功 → `{ isRootGit: true, repos: [] }`；
     - 失败 → `Files.list(workspace)` 过滤一级目录，检查 `.git`（目录或文件）存在；对命中的仓库**并发**执行轻量统计（branch + `collectChangedFiles` 的增删统计），结果按 `name` 排序返回；
   - `getStatus(String sessionWorkspace, String repoPath)`：`repoPath` 非空时以 `workspace.resolve(repoPath)` 为 git 执行目录定位仓库根，其余逻辑复用现有实现；
   - `getFileDiff(String sessionWorkspace, String repoPath, String relativePath)`：同上。
2. `FileController`：新增 `GET /workspace-git-repos`；`workspaceGitStatus` / `workspaceGitDiff` 增加 `@RequestParam(required = false) String repoPath` 并透传。
3. 安全校验：`repoPath` 解析后必须 `startsWith(workspace)`，并过 `PathSandbox.resolve`；拒绝 `..`、绝对路径、非一级子目录（由 resolve 后相对路径不含 `/` 校验）。

### 6.2 Electron（desktop/electron/）

1. `gitStatus.cjs`：
   - 新增 `listGitRepos(workspace)`：与后端同构（根 rev-parse 判定 + 一级目录 `.git` 检查 + 并发轻量统计）；
   - `getGitStatus(workspace, repoPath)` / `getGitFileDiff(workspace, repoPath, relativePath)`：`repoPath` 存在时以 `workspace/repoPath` 为执行目录（resolve 校验在 workspace 内），复用现有收集逻辑。
2. `main.cjs`：新增 `ipcMain.handle('git-repos', ...)`；`git-status` / `git-file-diff` handler 透传 `repoPath`。
3. `preload.cjs`：暴露 `gitRepos(workspace)`；扩展 `gitStatus` / `gitFileDiff`。

### 6.3 前端（desktop/src/）

1. `types/git.ts`：新增 `GitRepoSummary`、`GitReposResult { isRootGit: boolean; repos: GitRepoSummary[] }`。
2. `composables/workspace-git-provider.ts`：
   - `WorkspaceGitProvider` 接口新增 `getRepos(): Promise<GitReposResult>`；`getStatus(repoPath?)` / `getFileDiff(relativePath, repoPath?)` 参数化；
   - CLOUD 实现：`getRepos` → `GET /files/workspace-git-repos`；status/diff 带 `repoPath` 参数；
   - LOCAL 实现：`getRepos` → `electronAPI.gitRepos`；status/diff 透传 `repoPath`。
3. 新增/扩展 composable（`useGitRepos` 或并入 `useGitStatus`）：
   - 状态：`repos`、`selectedRepoPath`、`multiRepoMode`（= 非 isRootGit 且 repos 非空）；
   - `refreshAll()`：按 4.1 数据流执行；默认选中「第一个有变更的仓库」；校验选中项存在性（仓库被删则回退默认）；
   - 与 `useGitStatus` 联动：`refresh` 时携带当前 `selectedRepoPath`。
4. `components/task/TaskInspector.vue`：
   - 摘要行：`multiRepoMode` 时渲染逐仓库列表（点击 → `inspectorActiveTab = 'git'` 并更新 `selectedRepoPath`）；全干净显示「N 个仓库 · 全部干净」；否则维持现有分支摘要行；
   - `showGitTab` / `showTabBar`：在现有条件上叠加 `multiRepoMode`；
   - Git Tab：工具栏（`GitChangeList` 上方）插入 `el-select` 下拉，选项 = repos 目录名，选中态 = 「目录名 · 分支」；切换 → 刷新选中仓库状态；
   - 刷新触发：现有 watch（provider、阶段结束、边路任务结束）统一改为调 `refreshAll()`。
5. `components/task/GitChangeList.vue`：工具栏支持插入下拉（由 TaskInspector 传入），其余不变。
6. 类型与构建：更新 `types/electron.d.ts`，`vue-tsc` 类型检查通过。

### 6.4 测试与验证

- 后端 `mvn compile` / `mvn test`（如新增单测覆盖 `listRepos` 的一级目录发现与 repoPath 越界校验）。
- 前端 `vue-tsc` 类型检查；根目录 `npm test`（Playwright）如现有用例覆盖 Git Tab 则同步补充多仓库场景断言（本地构造「非 git 根 + 两个一级 git 子仓库」工作区）。
- 手工验证矩阵：单仓库工作区（回归）、多仓库工作区（下拉/摘要/默认选中/点击跳转/刷新）、全干净多仓库、非 git 且无子仓库（不显示）、嵌套仓库（只显示根）、repoPath 越界（403）。

## 七、落地清单

### 7.1 交付物

- [ ] `docs/git-multi-repo-sidebar-design.md`（本文档，评审通过）
- [ ] 后端：`WorkspaceGitService` 新增 `listRepos`、`getStatus`/`getFileDiff` 支持 `repoPath`；`FileController` 新增 `workspace-git-repos` 并扩展两个接口
- [ ] Electron：`gitStatus.cjs` 新增 `listGitRepos`、支持 `repoPath`；`main.cjs` / `preload.cjs` 新增 `git-repos` IPC 并扩展参数
- [ ] 前端：`types/git.ts`、`workspace-git-provider.ts`、`useGitStatus`（或新 composable）、`TaskInspector.vue`、`GitChangeList.vue`、`types/electron.d.ts`
- [ ] CHANGELOG.md：实现完成后在顶部版本下追加 `### 前端（桌面 / Web / 安卓）` 与 `### 后端`、`### 桌面 Electron` 条目（本方案为对用户可见行为改动，必须记录）

### 7.2 验收标准

1. 工作区自身是 git 仓库：界面与行为与本次改动前**完全一致**（无下拉、无子仓库）。
2. 工作区非 git 且一级子目录含 ≥1 个 git 仓库：右侧边栏出现 Git 摘要行与 Git Tab；Git Tab 下拉可切换仓库，列表/数量/diff 随切换更新；摘要行逐仓库展示有变更仓库（目录名 + 分支 + `+X -Y`），全干净显示「N 个仓库 · 全部干净」；点击摘要行仓库项跳到 Git Tab 并选中。
3. 默认选中第一个有变更的仓库；刷新页面后不记忆上次选择。
4. CLOUD 与 LOCAL 模式行为一致。
5. 仓库列表扫描只到一级子目录；不设数量上限；repoPath 越界请求被拒绝。
6. 手动刷新与任务阶段结束自动刷新同时更新仓库列表与选中仓库状态。

## 八、风险与注意事项

- **性能**：多仓库批量摘要对每个仓库并发跑 git 命令；仓库数极大时首屏略慢，可接受（一级目录数量有限，且仅轻量统计、不含 files）。
- **口径一致性**：摘要行与 Git Tab 的变更统计必须同源（复用 `collectChangedFiles`），避免两处数字不一致。
- **路径安全**：`repoPath` 是新增的越界入口，后端（`PathSandbox`）与 Electron（resolve + startsWith 校验）必须双侧校验。
- **回归面**：`getStatus`/`getFileDiff` 是扩展而非重写，缺省参数行为不变；前端 `showGitTab` 需保留现有「探测中显示 / 确认非 git 隐藏」的时序逻辑，防止闪动。
- **部署**：本方案不改数据库、无迁移脚本；后端需重启后生效（重启由用户执行，Agent 不代劳）；desktop 前端经 `scripts/deploy-desktop.sh` 部署，Electron 壳改动需用户自行打包分发。
