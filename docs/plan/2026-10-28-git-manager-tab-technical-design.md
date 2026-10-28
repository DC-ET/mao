# 工作区 Git 管理器技术方案：中央 Tab 承载的完整 Git 工作台

- 状态：待实施（2026-10-28 需求共识，13 项决策见 §4；本轮目标仅为方案文档，不动代码）
- 日期：2026-10-28
- 能力底座：
  - [2026-07-21-desktop-git-inspector-design.md](2026-07-21-desktop-git-inspector-design.md)（右侧栏 Git Tab：只读状态 + 变更树 + 中心 Diff Tab）
  - [2026-08-09-git-operations-technical-design.md](2026-08-09-git-operations-technical-design.md)（commit / pull / push + AI 提交信息生成 + 活动记录 + LLM 用量）
  - [2026-10-12-file-manager-tab-technical-design.md](2026-10-12-file-manager-tab-technical-design.md)（中央 Tab 容器形态：`Tab.type: 'file_manager'` 单例 + `CenterTabContainer` 分支，本方案的同构范式）
- 本方案定位：把散在约 300px 侧边栏里的 Git 能力搬进中央大 Tab，并在此容器内迭代更完善的 Git 能力（提交历史、分支切换、stash 管理、远端信息、显式 fetch）。

## 1. 需求背景

### 1.1 现状

Git 能力目前只有一个入口：任务页右侧边栏（`TaskInspector.vue`）的「Git」Tab（`inspectorActiveTab === 'git'` 分支）。它承载：

| 能力 | 实现位置 |
|---|---|
| 多仓库发现与切换 | `useGitRepos.ts` + `TaskInspector.vue` 顶部 `el-select`（多仓库模式） |
| 工作区 Git 摘要 | `TaskInspector.vue` 工作区模块的 `gitSummaryVisible` 行（分支 + `+N/-M`） |
| 变更文件树 | `GitChangeList.vue` + `GitChangeTreeNode.vue` |
| 文件 diff 预览 | 点击变更 → `TaskView.handleOpenGitDiff` → `openDiffTab`（中心 Diff Tab，标题 `文件名 (Git)`） |
| commit（AI 生成提交信息，不可编辑） | `runGitOperation('commit')` → provider → CLOUD `GitWriteOperationService.commit` / LOCAL `gitOperations.commit` |
| pull（自动 stash + 恢复） | `runGitOperation('pull')` |
| push（自动设 upstream，永不强推） | `runGitOperation('push')` |
| 远端 ahead/behind 状态 | `refreshGitRemote` → `refreshStatus`（内含 `fetch --prune`） |
| 变更文件右键 | `GitContextMenu.vue`：复制绝对/相对路径、在文件管理器中打开、添加到聊天、下载（CLOUD） |

双模式抽象已就绪：`WorkspaceGitProvider`（`workspace-git-provider.ts`）统一 `getRepos/getStatus/refreshStatus/getFileDiff/commit/pull/push`，LOCAL 走 Electron IPC（`gitStatus.cjs` / `gitOperations.cjs`），CLOUD 走后端 REST（`WorkspaceGitService` 只读 + `GitWriteOperationService` 写）。

### 1.2 问题

1. **空间瓶颈**：侧边栏宽约 300px，多仓库下拉、仓库状态、变更树全部纵向堆叠；变更树只显示路径 + `+n/-m`，提交历史、分支、stash 这类信息密度高的视图在窄栏里几乎无法承载。
2. **能力缺口**：用户想查看提交历史、切换分支、处理 stash（pull 冲突时保留的 `mao-auto-pull-*` stash 目前只能在外部终端处理），必须离开客户端。尤其在 CLOUD 模式（Web / 安卓 / 云端任务）下没有本机终端可用。
3. **迭代受限于容器**：后续任何 Git 能力增强（如暂存区管理、冲突解决）都要塞进同一个窄 Tab，UI 与技术债双重受限。

### 1.3 机会

- 中央 Tab 容器范式已被文件管理器验证：`Tab.type` union 加一种 type + `CenterTabContainer` 一个渲染分支 + `useCenterTabs` 一个 `openXxxTab()` 函数即可获得：全宽工作区、按会话独立、`<KeepAlive :max="20">` 免费状态保持、刷新不重建（与 file/diff/trace 一致）。
- 双模式 provider 抽象已成型，新增 Git 能力只需在两端各加实现，UI 零感知模式差异。
- 写操作的安全设施（CLOUD 仓库写锁 + askpass 凭证 + 活动记录；LOCAL `withWriteLock` + 本机凭证）已齐备，分支切换可复用 pull 的自动 stash 套路。

关键事实（设计建立在其上）：

- 中央 Tab 渲染链路：`CenterTabContainer.vue` 以 `<KeepAlive :max="20">` + `activeTab.type` 分支渲染；props 已含 `sessionId` 与 `fileProvider`，Tab 数据是按会话存的模块级单例（`useCenterTabs.ts`）。Git Tab 需要新增 `gitProvider` prop 管道（文件管理器没有这道管道，因为文件面板只用 fileProvider）。
- 侧边栏 Git Tab 的展示条件：`showGitTab`（`TaskInspector.vue`）要求 `props.gitProvider` 存在（即 LOCAL 有 Electron IPC 或 CLOUD 有 sessionId）。
- `WorkspaceGitProvider` 的 CLOUD/LOCAL 工厂由 `useWorkspaceGitProvider(executionMode, workspace, sessionId)` 在 `TaskView.vue` L559 构造，已经以 `gitProvider` prop 传给 `TaskInspector`——大 Tab 复用同一实例即可，无第二数据源。
- CLOUD 只读 git 执行器：`workspace-git.service.ts` 的 `runGitOk(cwd, args)`（10s 超时、2 MiB stdout 上限、`core.quotepath=false`）；写执行器：`git-write-operation.service.ts` 的 `run(repo, args, extraEnv)`（60s 超时、仓库级互斥锁 `withRepoLock`、`credentialEnv` askpass）。
- LOCAL 只读执行器：`gitStatus.cjs` 的 `runGit(cwd, args)`（60s 超时、2 MiB 上限）；写执行器：`gitOperations.cjs` 的 `run(cwd, args, options)` + `withWriteLock`（按仓库互斥）。
- 提交 diff 的三段式数据在 LOCAL 侧已有先例：`gitOperations.buildFileDiff(repoRoot, file)` 与后端的 `getFileDiff` 都实现了 before（`git show` / `HEAD:` 版本）+ after（工作区内容）+ 截断/二进制判定，本方案的单提交 diff 是同一模式的参数化（revision 从 `HEAD` 变为任意 `hash`）。
- 文件管理器大 Tab 已确立入口范式：「文件」tab 工具栏按钮 + 摘要行可点击，`openFileManagerTab()` 单例 id `file-manager`。
- `TaskInspector` 已通过 `defineExpose` 暴露 `revealInFileTree` / `refreshFileTree` 给 `TaskView`（`TaskInspectorInstance` 接口），本方案新增 Git 入口事件沿用同一中转模式。
- file 域全部端点（含 Git commit/pull/push）零权限码，只靠 `requireUserId + requireOwnedSession`；本方案新增端点沿用该形态。
- 迁移现状：最大 V141，本方案零 DDL（提交历史/分支/stash 全部是 git 仓库的实时数据，不落库）。

## 2. 需求描述

### 2.1 目标

1. **大 Tab 容器**：任务页中央区域新增「Git」大 Tab（单例 id `git`，标题 `Git`，按会话独立），全宽工作区承载完整 Git 管理界面；两个入口——任务 Tab 工作区模块的 Git 摘要行可点击、侧边栏 Git Tab 工具栏「展开」按钮；KeepAlive 保活，切走再切回状态原样恢复；刷新不重建（与 file/diff/trace 一致）。
2. **能力搬迁（与侧边栏等价）**：多仓库发现与顶部仓库下拉切换、仓库状态（分支/upstream/ahead/behind/detached HEAD/远端状态）、变更文件树、点击文件开中心 Diff Tab、commit（AI 生成提交信息不可编辑）、pull（自动 stash + 恢复）、push（自动设 upstream）、远端状态刷新、变更文件右键菜单（复制路径/在文件管理器中打开/添加到聊天/下载）。
3. **只读增强（本期新增）**：
   - **提交历史**：经典列表（短哈希/标题/作者/时间/refs 装饰），分页加载更多；点击提交展开该次提交的文件变更清单，点击文件在中心 Diff Tab 打开该提交版本的单文件 diff；
   - **分支管理**：本地 + 远端分支列表（当前分支、upstream、ahead/behind 标识），切换分支（自动 stash + 恢复，禁止 detached；可从远端分支创建跟踪分支）；
   - **stash 管理**：stash 列表（索引/消息/时间），应用（apply）/ 弹出（pop）/ 丢弃（drop）；
   - **远端信息**：远端列表与脱敏 URL；
   - **显式 fetch**：独立的「获取远端更新」按钮（`fetch --prune`，不动工作区）。
4. **双模式一致**：LOCAL（Electron）与 CLOUD 行为一致，UI 通过扩展后的 `WorkspaceGitProvider` 统一；LOCAL 拉取/推送/fetch 沿用本机 Git 凭证（credential helper / SSH Agent / 系统钥匙链），CLOUD 沿用用户 HTTPS Access Token + askpass。
5. **安全边界不变**：所有 git 命令参数数组执行，禁止 shell 拼接；CLOUD 端点校验会话归属 + `PathSandbox` + `repoPath` 仅限一级子目录；仓库级写锁互斥；远端 URL 与错误输出脱敏；新增操作（fetch/切换分支/stash）落 `session_activity` 活动记录。
6. **改动面**：desktop 纯前端 + Electron 新 IPC + 后端 8 个新端点 + 两个既有服务扩展；零 DDL、零新依赖、零权限码、不改 admin。

### 2.2 非目标（明确不做）

- **不做暂存区管理**：不提供文件级 stage/unstage 勾选、部分提交、逐文件提交；commit 仍固定 `git add -A` 全量提交（延续 08-09 口径）。
- **不提供提交信息输入/编辑**：提交信息仍由主会话模型生成，格式校验失败重试一次，失败即终止；不提供输入框、不提供近期 Git 历史作为模型上下文（延续 08-09 口径）。
- **不做 detached 提交检出**：历史列表中点击提交哈希只读查看 diff，不切换 HEAD；分支切换禁止切到 detached 状态。
- **不做分支创建/删除/重命名**（从当前 HEAD 新建分支并切换除外，它是切换分支的 `create=true` 参数）：不提供分支重命名、删除分支、设置 upstream 的独立入口；push 时无 upstream 仍按现有 origin 优先规则自动设置（08-09 §3.5）。
- **不做远端管理**：不提供增删远端、修改远端 URL（本期远端列表只读）。
- **不做合并/rebase/cherry-pick**：pull 仍固定 merge 模式（`pull --no-edit`），不提供 rebase pull、fast-forward-only pull、merge/rebase/cherry-pick 命令入口。
- **不做冲突解决 UI**：pull / 切换分支 / stash 恢复产生的冲突，按现有口径保留现场 + 提示 stash 引用；不提供三方合并编辑器、不提供 abort/reset 入口。
- **不做 tag 管理**：tag 仅作为历史列表的 refs 装饰展示，不提供创建/删除/推送 tag。
- **不做子模块 / worktree / LFS 专项处理**：按普通 git 结果展示；异常提示失败。
- **不做 git blame / 文件历史**（单个文件跨提交的修改历史）：本期不做，后续在大 Tab 容器内迭代评估。
- **不做定时轮询 / 文件系统 watch / Agent 工具结束后自动刷新**：刷新时机为手动 + 打开 Tab + 切会话（与侧边栏现行口径一致）。
- **不做右侧边栏 Git Tab 的删除**：两入口并存，侧边栏保持现状（变更树 + commit/pull/push + 刷新），大 Tab 为完整入口；本次不给侧边栏 Git Tab 增加新能力（新能力只进大 Tab）。
- **不做 LEFT/边路任务/子代理视图的 Git**：Git Tab 跟随主会话工作区，不展示子会话的 Git 状态。
- **不做 LOCAL 浏览器纯 Web 模式的 Git**：无 Electron IPC 时不显示入口（与侧边栏 `showGitTab` 同款判断）。
- **不加权限码、不动角色体系、不改 admin、不加数据库迁移**。
- **不做大 Tab 内嵌 diff 面板替代中心 Diff Tab**：所有 diff 预览仍复用中心 Diff Tab（`FileDiffViewer`），大 Tab 不引入第二套 diff 渲染。

## 3. 技术选型

### 3.1 决策结论

| 决策点 | 选择 | 理由 |
|---|---|---|
| 容器形态 | 中央 Tab：`Tab.type` 加 `'git'`，单例 id `git`，标题「Git」，按会话独立 | 与 file_manager 同构；全宽；KeepAlive 免费状态保持；刷新不重建（D1/D5） |
| 双入口关系 | 侧边栏 Git Tab 保持现状，两入口并存 | 与文件管理器大 Tab 的处理一致；零回归风险；新能力只进大 Tab（D2） |
| 能力边界 | 搬迁 + 只读增强（log/分支/stash/远端/fetch）+ 分支切换写操作 | 需求共识；写操作仅限已有三件套 + 分支切换（D3） |
| 写操作归属 | commit/pull/push 搬进大 Tab，与侧边栏等价（共用同一 provider） | 大 Tab 是完整入口；provider 是 computed 单实例，两处调用互不影响（D4） |
| 内部布局 | 顶部子导航：变更 / 历史 / 分支 / Stash，一次一个视图 + 顶部仓库下拉 | 每屏专注一件事；实现简单；窄栏变宽栏后子导航仍有意义（D6） |
| 多仓库组织 | 顶部仓库下拉，一次只操作一个仓库 | 与侧边栏 `multiRepoMode` 契约一致，后端 `repoPath` 零改动（D7） |
| 提交历史形态 | 经典列表 + 点击展开文件清单 + 点文件开中心 Diff Tab | 三段式按需加载，输出有界；复用现有 Diff Tab 链路（D8） |
| CLOUD 只读实现 | 扩展 `WorkspaceGitService`（log/commit-files/commit-diff/branches/stashes/remotes） | 只读归只读服务；命令白名单在服务内部，不开放通用 exec（D9） |
| CLOUD fetch/切换分支/stash 写实现 | 扩展 `GitWriteOperationService`（fetch/switch-branch/stash 操作） | 复用仓库写锁 + `credentialEnv` askpass + 活动记录；凭证逻辑不复制（D10） |
| 分支切换安全策略 | 自动 stash + 切换后恢复；恢复冲突保留现场；禁止 detached | 与 pull 的 stash 套路一致（复用 `restoreStash`）；用户无感知的顺畅切换（D11） |
| LOCAL 实现 | `gitStatus.cjs` 加只读查询函数；`gitOperations.cjs` 加 fetch/switch-branch/stash 写函数；`main.cjs` 注册 8 个 IPC | 与现有 git-status/git-pull 等 IPC 同模式；LOCAL 凭证沿用本机环境（D12） |
| 测试 | 后端单测（两服务扩展）+ 前端单测（纯函数/composable）+ 手测清单；不新增 Playwright | CI 不跑 Playwright；契约与解析是风险核心（D13） |

### 3.2 备选方案与否决

| 方案 | 否决原因 |
|---|---|
| 通用 git exec 端点（前端传任意 git 参数） | 等于开放任意 git 命令执行通道；白名单维护本身就是新契约面，安全审查不可接受 |
| 前端 isomorphic-git 读 `.git` | CLOUD 无法读服务端磁盘；LOCAL 大仓性能与兼容性差（07-21 已否决，仍成立） |
| 复用 Agent Shell 会话跑 git | 副作用大、权限与会话生命周期耦合，不适合常驻面板（07-21 已否决） |
| 大 Tab 内自绘 diff 渲染器 | `FileDiffViewer`（Monaco 并排）已成熟且双模式在用；自绘等于维护第二套渲染 |
| 提交历史一次返回全部文件 diff | 大提交 diff 体积远超 512 KiB 上限；与现有按需加载模式不一致 |
| 全局单例 Git Tab | 多会话并行时「这是哪个会话的仓库」易混淆；与全部中央 Tab 的按会话独立范式相悖 |
| 删除侧边栏 Git Tab | 改变现有用户习惯；两入口并存与文件管理器先例一致，收敛留待容器稳定后评估 |

### 3.3 Git 命令约定（LOCAL / CLOUD 共用语义）

所有命令在**仓库根**执行，一律 `git -c core.quotepath=false` + 参数数组，禁止 shell 拼接。只读命令沿用 `workspace-git.service.ts` 的 10s 超时 / 2 MiB stdout 上限；写命令沿用 `git-write-operation.service.ts` 的 60s 超时 / 仓库写锁。

| 用途 | 命令 | 解析要点 |
|---|---|---|
| 提交历史 | `git log --format=%H%x00%h%x00%s%x00%an%x00%aI%x00%D -n <limit> [--skip <offset>] [-- <path>]` | `%D` 为 refs 装饰（分支/tag）；NUL 分隔防标题含特殊字符；limit 默认 50、上限 200 |
| 单提交文件清单 | `git show --name-status --format= <hash>` + `git show --numstat --format= <hash>` | 复用现有 `parseNameStatusLine` / `numstatNewPath`（rename 紧凑形态还原） |
| 单提交单文件 diff | `git show <hash>:<path>`（before = `<hash>^:<path>`，根提交时 before 为空）+ 读工作区无意义——after 直接取 `git show <hash>:<path>` | before/after 均来自 git 对象，不读工作区；二进制判定与 `isBinaryString` 一致 |
| 分支列表 | `git branch -vv`（本地）+ `git branch -r`（远端）+ `git rev-parse --abbrev-ref HEAD` | 本地分支解析 upstream 与 ahead/behind（`[ahead N, behind M]` 标记）；当前分支标记 `*` |
| stash 列表 | `git stash list --format=%gd%x00%gs%x00%aI` | `%gd` 为 `stash@{n}` 索引 |
| 远端列表 | `git remote -v` | 取 name/url；**URL 返回前必须过 `CREDENTIAL_URL` 脱敏正则**（与 `sanitize()` 同规则） |
| fetch | `git fetch --prune <remote>` | remote 选择复用 `selectRefreshRemote` 逻辑（upstream 优先 → origin → 唯一 remote）；凭证走 `credentialEnv` |
| 切换分支 | 检测变更 → `git stash push --include-untracked -m mao-auto-switch-<uuid>` → `git switch <branch>`（远端分支：`git switch -c <branch> --track <remote>/<branch>`）→ 成功则 `git stash apply --index <oid>` + drop | 完全复用 pull 的 stash 生命周期（`findStashRef`/`restoreStash`）；恢复冲突保留现场 |
| stash 操作 | `git stash apply --index <ref>` / `git stash pop --index <ref>` / `git stash drop <ref>` | action 服务端白名单枚举 `apply \| pop \| drop`；ref 必须匹配 `^stash@\{\d+\}$` |

## 4. 关键决策（需求共识）

零新依赖、零 DDL、零权限码。十三个塑形决策：

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 容器形态 | 中央 Tab：`Tab.type` 加 `'git'`，单例 id `git`，标题「Git」，按会话独立（`sessionTabsMap` 天然支持）；全宽工作区；刷新不重建（与 file/diff/trace 一致）；不做 overlay |
| D2 | 双入口关系 | 侧边栏 Git Tab 保持现状（变更树 + commit/pull/push + 刷新），两入口并存；新增强能力只进大 Tab，侧边栏不加新能力 |
| D3 | 能力边界 | 搬迁 + 只读增强（log/分支列表与切换/stash/远端列表/显式 fetch）+ commit/pull/push 等价搬迁；不做暂存区管理、冲突解决 UI、合并/rebase、tag 管理、blame |
| D4 | 写操作归属 | commit/pull/push 在大 Tab 内提供，与侧边栏等价，共用同一 `WorkspaceGitProvider` 实例；禁用态判定规则与侧边栏一致（复用 `GitChangeList` 的 `commitDisabledReason` 等 computed 逻辑） |
| D5 | Tab 生命周期 | 按会话独立，每会话一个 Git Tab 实例；KeepAlive 保活（切走再切回仓库选择/子导航/列表滚动原样恢复） |
| D6 | 内部布局 | 顶部仓库下拉（多仓库模式）+ 子导航四视图（变更 / 历史 / 分支 / Stash），一次只显示一个视图；仓库状态条（分支/upstream/ahead/behind/detached/远端状态 + fetch 按钮）常驻子导航下方 |
| D7 | 多仓库组织 | 顶部仓库下拉，一次只操作一个仓库；`repoPath` 契约与侧边栏完全一致（一级子目录名），后端零改动 |
| D8 | 提交历史形态 | 经典列表（短哈希/标题/作者/相对时间/refs）+ 分页（limit 50，滚动加载更多）；点击提交展开文件清单（路径/类型/增删行数）；点文件开中心 Diff Tab（标题 `hash · 文件名 (Git)`） |
| D9 | CLOUD 只读端点 | 扩展 `WorkspaceGitService`：`getLog` / `getCommitFiles` / `getCommitFileDiff` / `getBranches` / `getStashes` / `getRemotes`；命令白名单在服务内部 |
| D10 | CLOUD 写端点 | 扩展 `GitWriteOperationService`：`fetchRemote` / `switchBranch` / `stashOp`；复用 `withRepoLock` + `credentialEnv` + 活动记录 |
| D11 | 分支切换策略 | 自动 stash（`--include-untracked`，标识 `mao-auto-switch-<uuid>`）→ switch → 成功恢复（按对象 ID）；恢复冲突保留现场 + 提示；禁止 detached；远端分支自动建跟踪分支 |
| D12 | LOCAL 实现 | `gitStatus.cjs` 加只读查询（log/branches/stashes/remotes/commitFiles/commitFileDiff）；`gitOperations.cjs` 加写操作（fetch/switchBranch/stashOp，复用 `withWriteLock` 与本机凭证）；`main.cjs` 注册 8 个 IPC；preload + `electron.d.ts` 同步 |
| D13 | 测试 | 后端两服务扩展补单测（临时 git 仓库 fixture）；前端补纯函数/composable 单测；手测清单随 PR；不新增 Playwright |

## 5. 详细设计

### 5.1 组件结构与渲染链路

```
TaskView.vue（改：接入口事件、透传 gitProvider）
├─ TaskInspector.vue（改：摘要行可点击 emit('open-git')；Git Tab 工具栏加「展开」按钮 emit('open-git')）
│   └─ GitChangeList.vue（改：工具栏加展开按钮，纯 emit，不改其他行为）
└─ CenterTabContainer.vue（改：加 'git' 渲染分支 + gitProvider prop）
    └─ <GitManagerPanel v-else-if="activeTab?.type === 'git'" :session-id :git-provider />  ← KeepAlive 内
          ├─ 仓库下拉（多仓库模式；单仓库模式显示仓库名徽章）
          ├─ 仓库状态条：分支 / upstream / ahead-behind / detached 提示 / 远端状态 + 「获取远端更新」按钮
          ├─ 子导航：变更 | 历史 | 分支 | Stash
          ├─ <GitChangesView>（变更视图：复用 GitChangeList 同构布局 + commit/pull/push 工具栏 + diff 预览）
          ├─ <GitHistoryView>（历史视图：列表 + 分页 + 点击展开文件清单）
          ├─ <GitBranchesView>（分支视图：本地/远端分组列表 + 切换按钮）
          └─ <GitStashView>（stash 视图：列表 + apply/pop/drop）
```

- **打开**：`openGitTab()`（`useCenterTabs.ts` 新增）：会话内已有该 Tab 则直接激活，否则 push `{ id: 'git', type: 'git', title: 'Git' }` 并激活；按 `notifyTabsChanged` 现有收尾（含激活态落盘）。恢复激活态走 `restoreActiveTab` 现有按 id 匹配逻辑，刷新不重建（与 file/diff/trace 一致，非目标）。
- **依赖获取**：`CenterTabContainer` 新增 `gitProvider` prop（`TaskView` 已有 `gitProvider` computed，L559，直接传）；面板拿 `sessionId` + `gitProvider` 两样。`executionMode` 不收——provider 工厂已按模式产出（LOCAL 无 Electron IPC 时 provider 为 null，入口不显示）。
- **事件出口**（与 `handleOpenGitDiff` 同模式，TaskView 中转）：
  - `open-git-diff`（变更视图，payload 与 `TaskInspector` 的 `open-git-diff` 完全一致：`{ file, repoPath }`）→ 复用 `TaskView.handleOpenGitDiff`；
  - `open-commit-diff`（历史视图，payload `{ hash, file, repoPath }`）→ `TaskView` 调 provider 新方法 `getCommitFileDiff` → 构造 `FileChange` → `openDiffTab(change, 'hash · 文件名 (Git)', { source: 'git' })`；
  - `add-file-to-chat` → composer 插 `@{绝对路径}@`（TaskView 现有链路）。
- **provider 扩展**：`WorkspaceGitProvider` 接口新增 8 个方法（§5.2），LOCAL/CLOUD 两个工厂各自实现；面板不感知模式。

### 5.2 Provider 接口扩展（`desktop/src/types/git.ts` + `workspace-git-provider.ts`）

```ts
export interface GitLogEntry {
  hash: string
  shortHash: string
  title: string
  author: string
  date: string          // ISO 8601
  refs?: string         // 原始 %D 串，如 'HEAD -> main, origin/main, tag: v1.0'
}

export interface GitBranchInfo {
  name: string
  isCurrent: boolean
  isRemote: boolean
  upstream?: string
  ahead?: number
  behind?: number
  lastCommitHash?: string
  lastCommitTitle?: string
}

export interface GitStashEntry {
  ref: string           // stash@{0}
  message: string       // On branch: xxx ... mao-auto-pull-<uuid>
  date: string          // ISO 8601
}

export interface GitRemoteInfo {
  name: string
  fetchUrl: string      // 已脱敏
  pushUrl: string       // 已脱敏
}

export interface GitCommitFilesResult {
  hash: string
  files: GitChangedFile[]
}

export type GitStashAction = 'apply' | 'pop' | 'drop'
```

`WorkspaceGitProvider` 新增（均带 `repoPath?` 尾参，多仓库模式下由面板固定 `selectedRepoPath`，与现有 `getStatus(repoPath)` 同模式）：

```ts
getLog(opts?: { limit?: number; offset?: number; path?: string }): Promise<GitLogEntry[]>
getCommitFiles(hash: string): Promise<GitCommitFilesResult>
getCommitFileDiff(hash: string, relativePath: string): Promise<GitFileDiff>
getBranches(): Promise<GitBranchInfo[]>
getStashes(): Promise<GitStashEntry[]>
getRemotes(): Promise<GitRemoteInfo[]>
fetchRemote(): Promise<GitOperationResult>                       // operation: 'fetch'
switchBranch(branch: string, opts?: { create?: boolean }): Promise<GitOperationResult>  // operation: 'switch'
stashOp(action: GitStashAction, ref: string): Promise<GitOperationResult>               // operation: 'stash'
```

错误契约沿用 `GitOperationResult`（`{ success, operation, message?, error?, ... }`）；CLOUD 侧 BusinessException 由 provider 的 catch 转成 `failedOperation`（同现有 commit/pull/push 的 `failedOperation(operation, e)` 兜底）。`GitOperationType` 扩展为 `'commit' | 'pull' | 'push' | 'fetch' | 'switch' | 'stash'`。

### 5.3 后端：`WorkspaceGitService` 只读扩展

`backend-ts/src/file/workspace-git.service.ts` 新增（全部走既有 `runGitOk` + `resolveRepoDir` + `collectChangedFiles` 基础设施，不新增执行器）：

| 方法 | 命令 | 返回 |
|---|---|---|
| `getLog(ws, repoPath, {limit, offset, path})` | `git log --format=… -n limit --skip offset [-- path]` | `GitLogEntryDTO[]`；limit 钳制 [1,200] 默认 50，offset ≥0；空仓库（无 HEAD）返回 `[]` 不报错 |
| `getCommitFiles(ws, repoPath, hash)` | `git show --name-status --format=` + `--numstat --format=` | 复用 `parseNameStatusLine`/`numstatNewPath`/`collectChangedFiles` 同款合并逻辑；hash 服务端校验 `^[0-9a-f]{7,64}$` |
| `getCommitFileDiff(ws, repoPath, hash, path)` | before = `git show <hash>^:<path>`（根提交/首版为空），after = `git show <hash>:<path>` | 复用 `GitFileDiffDTO` 契约与 `truncateText`/`isBinaryString`/`readTextLimited` 同款上限（5000 行 / 512 KiB）；路径沿用 `getFileDiff` 的 `..`/沙箱校验 |
| `getBranches(ws, repoPath)` | `git branch -vv` + `git branch -r` + `rev-parse --abbrev-ref HEAD` | `GitBranchInfoDTO[]`；解析 `*` 当前标记、`[origin/main]` upstream、`[ahead N, behind M]`；远端分支 `isRemote: true`（远端分支不解析 ahead/behind） |
| `getStashes(ws, repoPath)` | `git stash list --format=%gd%x00%gs%x00%aI` | `GitStashEntryDTO[]`；`%gs` 已含 On branch 摘要 |
| `getRemotes(ws, repoPath)` | `git remote -v` | `GitRemoteInfoDTO[]`；fetch/push URL 合并为一条；**URL 过 `CREDENTIAL_URL` 脱敏**（把 `git-write-operation.service.ts` 的脱敏正则导出共享或复制一份等价的，二选一，倾向抽到 `workspace-git.service.ts` 顶部常量） |

空仓库（无 HEAD）语义：`getLog` 返回 `[]`；`getCommitFiles/getCommitFileDiff` 对无效 hash 返回 `PARAM_INVALID`；`getBranches` 只返回未出生分支本身（`git branch -vv` 在空仓库输出分支名无 hash，解析时 `lastCommitHash` 留空）。

### 5.4 后端：`GitWriteOperationService` 写扩展

`backend-ts/src/file/git-write-operation.service.ts` 新增三个方法，全部走 `locked()`/`withRepoLock`（同仓库互斥）+ 活动记录：

- `fetchRemote(session, repoPath)`：`remoteState` → `selectRefreshRemote`（复用现有私有方法，需提升可见性或抽为模块函数）→ 无 remote 返回 `remoteStatusError='仓库未配置远端'` 的 status 语义（与 `refreshRemoteStatus` 的无 remote 分支一致，但**不返回完整 status**，只返回 `GitOperationResult`）→ `run(repo, ['fetch','--prune',remote], await this.credentialEnv(session))` → 成功 `successResult('fetch', branch, '远端已更新')`，失败 `classify()` 脱敏。
- `switchBranch(session, repoPath, branch, create?)`：`remoteState` → `requireNotDetached` → 有变更则 `stash push --include-untracked -m mao-auto-switch-<uuid>` + 记录 oid → 目标为本地分支直接 `git switch <branch>`；目标形如 `<remote>/<branch>` 或 `create=true` 时 `git switch -c <local> --track <remote>/<remote-branch>`（解析 `branch` 串：含 `/` 且前缀是已配置 remote 则视为远端跟踪创建）→ 失败：恢复 stash（复用 `restoreStash`）→ 成功：`restoreStash` 恢复；恢复冲突抛 `GitOperationException`（保留现场，消息含 stash 引用，同 pull 口径）。分支名服务端校验 `^[A-Za-z0-9._/-]+$` 且不含 `..`/`~`/`^`/`:`（git check-ref-format 子集）。
- `stashOp(session, repoPath, action, ref)`：action 白名单 `apply|pop|drop`；ref 校验 `^stash@\{\d+\}$`；`apply` → `git stash apply --index <ref>`，`pop` → `git stash pop --index <ref>`，`drop` → `git stash drop <ref>`；apply/pop 后检测冲突（复用 `hasConflicts`），有冲突返回 `success:false, conflict:true` + 保留现场的提示（不自动 reset）。

活动记录类型：`GIT_FETCH` / `GIT_SWITCH` / `GIT_STASH`（`recordOperation` 的 `GIT_${operation.toUpperCase()}` 现有拼法自动适配）；detail 字段沿用现有结构（branch/stashRef/conflict/error）。

### 5.5 后端：REST 端点（`file.routes.ts`）

全部 `requireUserId + requireOwnedSession`（file 域现行形态，无权限码），LOCAL 会话一律 `PARAM_INVALID '本地模式不支持服务端 Git 管理'`（同 write 端点族对 LOCAL 的拒绝样式），`repoPath` 只接受一级子目录名（`resolveRepoDir` 现有校验）。

| 方法 | 路径 | 参数 | 服务方法 |
|---|---|---|---|
| GET | `/v1/files/workspace-git-log` | sessionId, repoPath?, limit?, offset?, path? | `workspaceGitService.getLog` |
| GET | `/v1/files/workspace-git-commit` | sessionId, repoPath?, hash | `workspaceGitService.getCommitFiles` |
| GET | `/v1/files/workspace-git-commit-file-diff` | sessionId, repoPath?, hash, path | `workspaceGitService.getCommitFileDiff` |
| GET | `/v1/files/workspace-git-branches` | sessionId, repoPath? | `workspaceGitService.getBranches` |
| GET | `/v1/files/workspace-git-stashes` | sessionId, repoPath? | `workspaceGitService.getStashes` |
| GET | `/v1/files/workspace-git-remotes` | sessionId, repoPath? | `workspaceGitService.getRemotes` |
| POST | `/v1/files/workspace-git-fetch` | sessionId, repoPath? | `gitWriteOperationService.fetchRemote` |
| POST | `/v1/files/workspace-git-switch-branch` | sessionId, repoPath?, branch, create? | `gitWriteOperationService.switchBranch` |
| POST | `/v1/files/workspace-git-stash` | sessionId, repoPath?, action, ref | `gitWriteOperationService.stashOp` |

（8 个方法映射为 9 个端点：stash 列表 GET 与 stash 操作 POST 分开。）

### 5.6 Electron：LOCAL 实现

`desktop/electron/gitStatus.cjs` 新增导出（纯只读，走既有 `runGit`）：

- `getGitLog(workspace, repoPath, {limit, offset, path})`
- `getGitCommitFiles(workspace, repoPath, hash)`
- `getGitCommitFileDiff(workspace, repoPath, hash, relativePath)`
- `getGitBranches(workspace, repoPath)`
- `getGitStashes(workspace, repoPath)`
- `getGitRemotes(workspace, repoPath)`（URL 脱敏：复用/复制 `gitOperations.cjs` 的 `sanitizeError` 同款正则）

`desktop/electron/gitOperations.cjs` 新增导出（写，走 `withWriteLock` + 本机凭证 env）：

- `fetch(workspace, repoPath)`：`git fetch --prune <remote>`（remote 选择复用 `gitStatus.cjs` 的 `selectFetchRemote`）
- `switchBranch(workspace, repoPath, branch, create)`：stash → switch → restore，套路与 `pull` 的 stash 生命周期逐行同构（`findStashRef`/`restoreStash`/`hasConflicts`）
- `stashOp(workspace, repoPath, action, ref)`

`main.cjs` 注册 8 个 IPC（`git-log`、`git-commit-files`、`git-commit-file-diff`、`git-branches`、`git-stashes`、`git-remotes`、`git-fetch`、`git-switch-branch`、`git-stash-op`——实际 9 个，与 REST 一一对应）；`preload.cjs` 暴露；`electron.d.ts` 补类型。`desktop/package.json` version +1（仓库规范：Electron 壳改动）。

### 5.7 前端：面板与视图组件

**`components/git/GitManagerPanel.vue`**（新，Tab 内容面板）：

- 顶部仓库区：多仓库模式 `el-select` 下拉（名字 + 分支 + 变更数，`filterable`，抄侧边栏 `git-repo-select`）；单仓库模式显示仓库名徽章。
- 仓库状态条：分支名（detached 时警示色 + 提示）、upstream、`↑N ↓M`、远端状态徽章（可用/不可用 + 原因 tooltip）、右侧「获取远端更新」按钮（调用 `fetchRemote` 后 `refreshAll`）。
- 子导航：`变更 | 历史 | 分支 | Stash` 四按钮，`activeView` ref 驱动；变更视图默认。
- 数据源：面板内组合 `useGitRepos(gitProviderRef)` + `useGitStatus(statusProviderRef)`（与 `TaskInspector` 的多仓库包装 provider 完全相同的代码模式：`statusProviderRef` 按 `selectedRepoPath` 包装），新增能力由面板内的轻量 composable 提供（见下）。
- 事件出口：`open-git-diff` / `open-commit-diff` / `add-file-to-chat`。
- 操作反馈：`ElMessage` 成功/失败 toast，文案与侧边栏 `runGitOperation` 完全一致（提交成功含短哈希与标题等）；所有写操作按钮旋转态 + 禁用态判定复用 `GitChangeList` 的 computed 规则。

**`components/git/GitChangesView.vue`**（新）：变更视图。复用 `GitChangeList.vue` 的现有布局逻辑（变更树 + 工具栏 commit/pull/push/刷新 + 右键菜单）——实现方式二选一，倾向**直接复用 `GitChangeList.vue` 组件本身**（它已是纯 props/emits，无 TaskInspector 依赖），面板只补一个顶部操作栏（commit/pull/push/刷新 + 操作结果 toast）。这样侧边栏与大 Tab 共用同一变更树组件，零分叉。若实测 props 不足（如需要 `operation` 外部可控），最小化补 props，不改其内部逻辑。

**`components/git/GitHistoryView.vue`**（新）：历史视图。

- 列表行：短哈希（mono 字体，点击复制全哈希）、标题（单行省略 + tooltip）、作者、相对时间（`date` 格式化工具）、refs 装饰徽章（`HEAD -> main` / `origin/main` / `tag: v1.0` 分段着色）。
- 分页：`limit=50`，列表底部「加载更多」按钮（或滚动到底自动加载，倾向前者，实现简单无竞态）；`offset` 累加；`path` 筛选本期不做（非目标，只预留参数）。
- 点击行展开文件清单区（行内展开，不用子页面）：文件路径 + 类型徽章 + `+n/-m`；点文件行 emit `open-commit-diff`。
- 空态：空仓库显示「尚无提交」；加载失败显示错误 + 重试。

**`components/git/GitBranchesView.vue`**（新）：分支视图。

- 分组：本地分支 / 远端分支（`origin/xxx`）两组，组头显示数量。
- 行：分支名（当前分支加粗 + `✓`）、upstream、`↑N ↓M`（本地分支）、最后提交（短哈希 + 标题）。
- 操作：行尾「切换」按钮（当前分支禁用）；切换确认逻辑——工作区有变更时不弹确认（自动 stash 是既定策略），但结果 toast 必须说明「已自动暂存并恢复本地变更」；失败 toast 含 stash 引用（如 `mao-auto-switch-<uuid>` 对应的 `stash@{n}`）。
- 远端分支行：「切换」= 创建跟踪分支并切换（`switchBranch('origin/xxx', { create: true })` 或前端解析出 `xxx` + remote 后传 `create`）。

**`components/git/GitStashView.vue`**（新）：stash 视图。

- 列表：`stash@{n}` 索引徽章 + 消息（含 `On branch: xxx` 摘要与 `mao-auto-pull-*` 标识）+ 时间。
- 行操作：应用（apply）/ 弹出（pop）/ 丢弃（drop）；丢弃需二次确认（`ElMessageBox.confirm`，明示不可恢复）。
- apply/pop 冲突：toast 提示「stash 恢复产生冲突，已保留现场」并引导去外部终端处理。

**`composables/useGitManager.ts`**（新）：面板级状态机。

| 状态 | 类型 | 说明 |
|---|---|---|
| `activeView` | `'changes' \| 'history' \| 'branches' \| 'stash'` | 子导航；切视图不清仓库选择 |
| `logEntries` / `logLoading` / `logError` / `logOffset` | — | 历史分页；自增竞态序号（抄 `useGitStatus` L16 模式） |
| `expandedCommit` | `string \| null` | 当前展开的提交 hash；`commitFiles` 缓存 `Map<hash, GitChangedFile[]>` |
| `branches` / `branchesLoading` | — | 分支列表 |
| `stashes` / `stashesLoading` | — | stash 列表 |
| `remotes` | — | 远端列表 |
| `operation` | `'fetch' \| 'switch' \| 'stash' \| 'commit' \| 'pull' \| 'push' \| null` | 写操作进行中（按钮旋转 + 全局防重入） |

纯函数下沉 `utils/git-manager.ts`（可单测）：`parseRefsDecorations(refs: string)`（拆 `HEAD -> main, origin/main, tag: v1.0` 为 `{kind, name}[]`）、`parseBranchLine(line)`（解析 `git branch -vv` 一行的 name/current/upstream/ahead/behind/lastCommit）、`parseStashLine(line)`、`formatRelativeTime(iso)`、`sanitizeRemoteUrl(url)`（CLOUD/LOCAL 双端共用的脱敏正则应用）、`isValidBranchName(name)`（`check-ref-format` 子集，前端预检）、`isValidStashRef(ref)`。

### 5.8 刷新时机与数据一致性

- 打开 Git Tab（激活时）：拉 `getRepos` + 当前仓库 `getStatus`（本地只读，不 fetch）；历史/分支/stash 视图**懒加载**——首次切到该视图才请求（避免打开 Tab 就四路全打）。
- 切会话：provider 变化触发 `useGitRepos`/`useGitStatus` 的现有 watch 重置（清空旧数据防越界组合），面板的 log/branches/stashes 状态随之清空（watch provider 重置）。
- 写操作后（commit/pull/push/fetch/switch/stash）：统一 `refreshAll()`（刷仓库列表 + 状态）+ 当前视图数据刷新（如切换分支后刷历史与分支列表）；沿用侧边栏 `refreshAll(remote=true)` 的双刷模式。
- 不轮询、不 watch 文件系统、不订阅 `file_change`（与侧边栏口径一致）；缓解：切走 Tab 再切回时 KeepAlive 保活但数据不自动刷新——面板在 Tab 激活时（`onActivated` 钩子）做一次静默 `getStatus` 刷新（只刷状态条，不打断列表滚动）。

### 5.9 快捷键

大 Tab 聚焦时：`Ctrl/Cmd+R` 不劫持（浏览器刷新语义保留，刷新走按钮）；不设自定义快捷键（与文件管理器一致，避免与聊天输入区快捷键冲突）。

## 6. 实现步骤

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 容器骨架 | `Tab.type` union 加 `'git'` + `openGitTab()`；`CenterTabContainer` 分支 + `gitProvider` prop 透传；`TaskInspector` 摘要行与 Git Tab 工具栏两个入口（emit `open-git`）；`GitManagerPanel.vue` 骨架（仓库下拉 + 状态条 + 子导航）+ 变更视图直接内嵌复用 `GitChangeList` + commit/pull/push 接线；`useGitManager.ts` 基础状态 | 中 |
| P2 历史视图 | 后端 `getLog`/`getCommitFiles`/`getCommitFileDiff` + LOCAL 三个 IPC；provider 三方法；`GitHistoryView.vue`（列表 + 分页 + 展开文件清单 + `open-commit-diff` 链路）；`utils/git-manager.ts` 解析函数 + 单测 | 中 |
| P3 分支与 stash | 后端 `getBranches`/`getStashes`/`getRemotes` + `switchBranch`/`stashOp` + LOCAL 对应 IPC；provider 五方法；`GitBranchesView.vue` / `GitStashView.vue`；切换分支的 stash 编排与冲突提示 | 中 |
| P4 fetch 与打磨 | 后端 `fetchRemote` + LOCAL fetch IPC；状态条「获取远端更新」按钮；`onActivated` 静默刷新；远端列表视图入口（放在分支视图的远端分组里或状态条 tooltip，二选一——倾向后者：状态条远端徽章 hover 展示脱敏 URL 列表，不单独开视图）；手测清单 | 小~中 |

P1 完成即可 build 通过并试用（此时大 Tab 与侧边栏等价）；P2–P4 各自可独立提交。

## 7. 风险与开放问题

- **与侧边栏功能重复的心智成本**：两入口并存是既定决策（D2），用户可能困惑「哪里提交」。缓解：大 Tab 标题即「Git」，侧边栏 Tab 名保持「Git」，摘要行/工具栏入口明确指向大 Tab；后续视使用情况评估收敛（本方案不做）。
- **分支切换的 stash 语义**：自动 stash + 恢复与 pull 同款，但切换分支后本地变更被恢复到新分支上——若两分支同文件都有改动，恢复即冲突。缓解：与 pull 完全一致的保留现场 + 明确 toast（含 stash 引用），不自动 reset；用户可按引用自行处理。
- **大仓库 `git log` 性能**：`--format` 轻量输出 + limit 钳制（默认 50/上限 200）+ 10s 超时兜底；不做全量遍历。CLOUD 大仓首次 log 仍可能慢，按钮 loading 态 + 超时错误分类（复用 `classify` 的 124 超时文案）。
- **提交 diff 的 revision 解析安全**：hash 服务端严格校验 `^[0-9a-f]{7,64}$`，path 走 `getFileDiff` 同款 `..`/沙箱校验；`git show <hash>:<path>` 的 path 不经 shell，参数数组传入。
- **远端 URL 脱敏遗漏**：URL 可能含 `user:token@host`。脱敏在服务端完成（CLOUD `getRemotes`、LOCAL `getGitRemotes` 双端实现），前端只消费脱敏结果；单测覆盖带凭证 URL fixture。
- **CLOUD fetch 凭证**：复用 `credentialEnv`（askpass + 域名 Token 环境变量）；Token 不进命令参数/日志/响应（现有机制保证）；本机无对应域名 Token 时 fetch 失败走 `classify` 的「Git 认证失败或凭证缺失」。
- **LOCAL 与 CLOUD 的解析一致性**：`git branch -vv` 的 ahead/behind 与 upstream 格式、`%D` refs 装饰、stash `%gs` 消息在双端用同一解析函数（`utils/git-manager.ts` 纯函数双端共享文本，Electron 侧 `cjs` 复制同款正则），单测用同一组 fixture 文本。
- **KeepAlive 逐出**：`:max="20"` 下极端多 Tab 会丢面板状态（同文件管理器，接受）。
- **历史视图 diff 与工作区 diff 的心智**：中心 Diff Tab 标题带 hash 前缀（`a1b2c3d · 文件 (Git)`）区分于变更视图的 `文件 (Git)`；tab id 用 `git-commit-diff:<hash>:<path>` 隔离，避免与 `git-diff:` 互相覆盖（沿用 07-21 的 id 隔离思路）。
- **开放问题：历史视图的 path 筛选**（只看某文件的提交历史）：参数已预留（`getLog({path})`），交互本期不做；若用户高频需要，在大 Tab 容器内加一个筛选框即可，后端零改动。
- **开放问题：stash 消息的 mao 标识可读性**：`mao-auto-pull-<uuid>` 对用户不友好。本期原样展示（可定位、可回溯），不做消息美化（改了会破坏与终端的对应关系）。

## 8. 测试要点

- **后端单测（vitest，`backend-ts npm test`）**：
  - `workspace-git.service`：临时 git 仓库 fixture——log 解析（多提交/merge 提交/refs 装饰/根提交）、commit files（rename 紧凑形态 numstat 还原，复用既有 bugcheck 样例）、commit file diff（根提交 before 为空、二进制、截断、路径穿越拒绝）、branches（本地/远端/当前标记/upstream/ahead-behind 解析）、stashes 列表、remotes（含带凭证 URL 脱敏）、空仓库各方法不抛异常；
  - `git-write-operation.service`：fetch 的 remote 选择（upstream 优先/origin/唯一 remote/无 remote 失败）、switchBranch（干净工作区直切、脏工作区自动 stash + 恢复、恢复冲突保留现场、远端分支创建跟踪、detached 拒绝、非法分支名拒绝）、stashOp（apply/pop/drop 白名单、ref 格式校验、apply 冲突返回 conflict）；
  - `file.routes` spec：9 个新端点 401/越权会话/非法 repoPath 的拒绝路径（沿用现有 spec 风格）。
- **Electron 单测（node test，`desktop/electron/*.test.cjs` 现模式）**：`gitOperations` 的 switchBranch/stashOp（stash 编排与冲突保留）；`gitStatus` 的 log/branches/stashes/remotes 解析（同一 fixture 文本与后端对跑）。
- **前端单测（vitest，`desktop npm run test:unit`）**：
  - `utils/git-manager.ts`：`parseRefsDecorations`（HEAD -> /tag:/多段）、`parseBranchLine`（当前/upstream/ahead-behind/ detached）、`parseStashLine`、`sanitizeRemoteUrl`（带凭证/普通/ssh 三种）、`isValidBranchName`（合法/含 `..`/`~`/空格/首字符 `.`）、`isValidStashRef`；
  - `useGitManager`：视图切换、log 分页 offset 累加、竞态序号丢弃过期响应、展开提交缓存、provider 变化重置；
  - `useCenterTabs` 既有用例回归：`openGitTab` 不破坏现有 open*/close*/restore*（同会话重复打开只激活不新建；关 Tab 后 activeTabId 回落规则不变）。
- **手测清单（随 PR 描述）**：
  - LOCAL Electron git 项目：两入口打开大 Tab；仓库下拉（多仓库工作区）；变更视图与侧边栏一致（树/diff/commit/pull/push/右键菜单）；
  - 历史视图：列表/分页/展开文件清单/点文件开中心 Diff Tab（标题带 hash）；merge 提交与根提交的 diff 正确性（before 为空）；
  - 分支视图：切换本地分支（干净/脏工作区两种）；从远端分支创建跟踪分支；切换后历史与分支列表刷新；
  - stash 视图：apply/pop/drop；pull 冲突产生的 `mao-auto-pull-*` stash 可见且可处理；drop 二次确认；
  - 远端徽章 hover 显示脱敏 URL（含一个带凭证 remote 的 fixture）；
  - fetch 按钮：CLOUD 有/无 Token 两种；LOCAL 本机凭证；
  - CLOUD git 项目全链路复跑；非 Git 会话两入口均不显示；纯浏览器 LOCAL 会话不显示；
  - 切会话后面板数据重置（不出现旧仓库文件 + 新 repoPath 组合）；
  - 切走 Tab 再切回：视图/滚动/仓库选择恢复，状态条静默刷新；
  - detached HEAD 工作区：状态条警示、切换分支入口拒绝并提示；
  - 安卓 WebView 窄宽下工具栏不溢出（按钮收进 `el-dropdown` 或图标化，与 `GitChangeList` 移动端口径一致）。

## 9. 变更落点清单

**backend-ts（改）**

- `src/file/workspace-git.service.ts`：新增 `getLog` / `getCommitFiles` / `getCommitFileDiff` / `getBranches` / `getStashes` / `getRemotes`（+ 对应 DTO 接口）+ 脱敏常量；`workspace-git.service.spec.ts` 补解析与边界用例
- `src/file/git-write-operation.service.ts`：新增 `fetchRemote` / `switchBranch` / `stashOp`（+ `selectRefreshRemote` 可见性调整）；`git-write-operation.service.spec.ts` 补用例
- `src/file/file.routes.ts`：注册 9 个端点；`file.routes.spec.ts` 补拒绝路径用例

**desktop/electron（改）**

- `electron/gitStatus.cjs`：新增 `getGitLog` / `getGitCommitFiles` / `getGitCommitFileDiff` / `getGitBranches` / `getGitStashes` / `getGitRemotes` 导出；`gitStatus.test.cjs`（如无则新建）补解析用例
- `electron/gitOperations.cjs`：新增 `fetch` / `switchBranch` / `stashOp` 导出；`gitOperations.test.cjs` 补用例
- `electron/main.cjs`：注册 9 个 IPC handler
- `electron/preload.cjs`：暴露 9 个方法
- `src/types/electron.d.ts`：补 9 个方法类型声明
- `package.json`：version +1

**desktop/src（新）**

- `components/git/GitManagerPanel.vue`：Tab 内容面板（仓库区/状态条/子导航/事件出口）
- `components/git/GitHistoryView.vue`：历史视图
- `components/git/GitBranchesView.vue`：分支视图
- `components/git/GitStashView.vue`：stash 视图
- `composables/useGitManager.ts` + `useGitManager.test.ts`
- `utils/git-manager.ts` + `git-manager.test.ts`

**desktop/src（改）**

- `types/git.ts`：新增 `GitLogEntry` / `GitBranchInfo` / `GitStashEntry` / `GitRemoteInfo` / `GitCommitFilesResult` / `GitStashAction`；`GitOperationType` 扩展为六成员
- `composables/workspace-git-provider.ts`：`WorkspaceGitProvider` 接口加 8 方法；两个工厂实现（CLOUD 调 REST、LOCAL 调 IPC）
- `types/file-browser.ts`：`Tab.type` union 加 `'git'`
- `composables/useCenterTabs.ts`：新增 `openGitTab()`（单例 id `git`，已存在则激活）
- `components/center/CenterTabContainer.vue`：`git` 渲染分支 + `gitProvider` prop
- `views/task/TaskView.vue`：接 TaskInspector 的 `open-git` 事件 → `openGitTab()`；`CenterTabContainer` 传 `gitProvider`；接面板 `open-git-diff`（复用 `handleOpenGitDiff`）/ `open-commit-diff`（新 handler）/ `add-file-to-chat`
- `components/task/TaskInspector.vue`：工作区模块 Git 摘要行可点击（emit `open-git`，cursor + title 提示）；Git Tab 内容区顶部加「展开」按钮（emit `open-git`）；emits 声明加 `'open-git'`
- `components/task/GitChangeList.vue`：工具栏加「展开」按钮（props 加 `showExpand?: boolean` + emit `expand`，侧边栏不传即不显示；仅此一处改动，内部逻辑零改）

**文档**

- 根 `CHANGELOG.md`：发版时记后端小节（Git 历史/分支/stash/远端/fetch 端点）+ 前端小节（中央 Git 大 Tab）+ 桌面 Electron 小节（新 IPC）；`desktop/package.json` 版本用 `scripts/changelog-extract.sh ... sync-desktop`，勿手改
- `skills/mao-cli/SKILL.md`：desktop 手册补中央 Git 大 Tab 说明（入口/能力/与侧边栏关系）
- README / DEPLOY：无部署与配置变化，不补

## 10. 发版前检查

- `cd backend-ts && npm run build && npm test` 绿（两服务扩展 + 路由 spec）
- `cd desktop && npm run test:unit` 绿（新增 spec + useCenterTabs 回归）
- `cd desktop && npm run build` 通过（vue-tsc 零错误）
- `desktop/electron` Node 测试绿（gitStatus/gitOperations 新增用例）
- 手测清单（§8）逐条过
- CHANGELOG 三小节齐；mao-cli SKILL.md 同步后再打包发版
