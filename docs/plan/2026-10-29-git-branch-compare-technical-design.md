# 工作区 Git 分支对比技术方案：中央 Git 面板第五视图「对比」

- 状态：待实施（2026-10-29 需求共识 + 用户确认四项范围决策，13 项决策见 §4；2026-10-29 技术评审修订后版本，本轮目标仅为方案文档，不动代码）
- 修订：2026-10-29 评审修订——merge-base 判定改用 `runGitRaw` 读退出码（§5.2/§5.3）；单文件 diff 失败契约按各端现状复刻（§5.2/§5.3）；LOCAL 失败与空输出区分（§5.5）；rename 返回新路径契约（§5.2）；`useCenterTabs` 前缀链连带更新（§5.6）；分支预填语义统一为「不动 base」（§5.1/§5.6）；测试 mock 前提、`sync-desktop` 用法等落点补强（§5.5/§5.6/§8/§9）
- 修订 2（2026-10-29 实机反馈，语义变更）：对比语义由**三点**改为**两点**（`base → target` 两棵树直接比较，`git diff <base> <target>`）——实机反馈「目标分支完全落后」时三点清单为空、显示「两个分支没有差异」与直觉严重不符；两点在一屏内给出两侧全部差异，方向性与「仅基准分支」标记在 UI 明示。D2/D13 被 **D14** 取代（§2.1/§3.1/§3.2/§3.3/§4/§5.3/§5.5/§5.6/§7/§8/§9 同步更新）
- 修订 3（2026-10-29 实机反馈，默认预选）：对比视图由「两槽均不预选」改为**默认预选「当前分支 upstream → 当前分支」**（目标 = 当前分支、基准 = 其 upstream；无 upstream 时退回 `origin/<当前分支>` 或任一远端同名跟踪分支；仅空槽填充、不覆盖用户选择，进入视图自动开始对比）；D3 口径随之更新（§2/§3/§4/§5.1）
- 日期：2026-10-29
- 能力底座：
  - [2026-10-28-git-manager-tab-technical-design.md](2026-10-28-git-manager-tab-technical-design.md)（中央 Git 大 Tab：容器形态、双模式 provider、`WorkspaceGitService` / `GitWriteOperationService` 分层、中心 Diff Tab 链路与 `openDiffTab` 的 `idPrefix` 隔离，本方案的全部基础）
  - [2026-07-21-desktop-git-inspector-design.md](2026-07-21-desktop-git-inspector-design.md)（中心 Diff Tab / `FileDiffViewer` 三段式数据契约）
- 本方案定位：在中央 Git 面板子导航末尾（Stash 之后）新增「对比」视图，支持用户自选两个分支（本地/远端均可，均不固定）查看它们之间的变更文件清单，并点文件在中心 Diff Tab 打开双 ref 单文件 diff。

## 1. 需求背景

### 1.1 现状

中央 Git 大 Tab（10-28 方案已落地）有四个子导航视图：变更 / 历史 / 分支 / Stash，由 `GitManagerPanel.vue` 的 `views` 数组（L203-208）定义、`useGitManager.ts` 的 `GitManagerView` 联合类型（L6）约束。与「对比」相关的现状：

| 能力 | 现状 |
|---|---|
| 分支列表 | `GitBranchesView.vue`：本地 + 远端分组，含当前标记 / upstream / ahead-behind / 最后提交；ahead/behind 仅是「当前分支 vs 其 upstream」的计数 |
| diff 能力 | 只有两种形态：工作区 vs HEAD（`getFileDiff`）、单提交 `<hash>^:path` vs `<hash>:path`（`getCommitFileDiff`） |
| diff 渲染 | 中心 Diff Tab：`FileDiffViewer`（Monaco 并排）+ `openDiffTab` 的 `idPrefix` 隔离（`git-commit-diff:<hash>:` 已在使用，`useCenterTabs.ts` L270-300） |

后端与 Electron 侧**没有任何两个 ref 之间的 diff 能力**：无 `git diff A..B` / `A...B`、无 merge-base、无双 ref 文件清单接口。

### 1.2 问题

1. **分支间的差异看不到内容**：分支视图的 `↑N ↓M` 只是数字。用户想知道「feature 分支比 main 到底改了什么」「远端分支和本地差在哪」「这个分支上线会带进哪些文件」，必须离开客户端开终端跑 `git diff main...feature`。CLOUD 模式（Web / 安卓 / 云端任务）没有本机终端可用。
2. **对比端点被写死**：现有 ahead/behind 固定以「当前分支 + 其 upstream」为两端，无法任选两个分支互相比。
3. **能力缺口是单向的**：渲染层（中心 Diff Tab）、解析层（name-status / numstat / 二进制 / 截断）、双模式 provider 全部就绪，缺的只是「revision 从 `<hash>` / `<hash>^` 参数化为任意两个分支名」这一层。

### 1.3 机会

- `getCommitFiles` / `getCommitFileDiff` 的模式可直接参数化：文件清单把 `git show <hash>` 换成 `git diff <base> <target>`（两点），单文件 diff 把 `<hash>^:` / `<hash>:` 换成 `<base>:` / `<target>:`，解析函数（`parseNameStatusLine` / `numstatNewPath`）、截断与二进制判定、DTO 契约原样复用。
- 分支下拉的选项数据已在手：`getBranches` 已返回本地 + 远端全部分支（`GitBranchInfo[]`），零额外请求。
- 中心 Diff Tab 的 `idPrefix` 机制已就绪（10-28 P2 落地），分支 diff 只需一个新前缀，不触碰现有 `git-diff:` / `git-commit-diff:` id 规则。
- 全部为只读新增：不碰写操作链路（stash 编排、仓库锁、活动记录），回归面小。

关键事实（设计建立在其上）：

- 子导航加一项是纯增量：`views` 数组（`GitManagerPanel.vue` L203-208）+ 分发分支（L95-168）+ `GitManagerView` 联合（`useGitManager.ts` L6）+ 懒加载钩子（`loadActiveView` L210-214）。
- 多仓库模式下面板用 `statusProviderRef`（`GitManagerPanel.vue` L230-257）按 `selectedRepoPath` 逐个重绑 provider 方法——**新方法必须同步补绑定**，漏绑则对比请求不带 `repoPath`、打到错误仓库（10-28 方案同款易漏点）。
- CLOUD 只读执行器：`workspace-git.service.ts` 的 `runGitOk`（L757，包装 `runGitRaw`：10s 超时、stdout+stderr 共享 2 MiB 上限、`core.quotepath=false`）与可直接读退出码的 `runGitRaw`（L980，返回 `exitCode` / `timedOut`）；仓库根解析 `resolveRepoRoot`（L575，含工作区包含校验）。
- LOCAL 只读执行器：`gitStatus.cjs` 的 `runGit` / `runGitOk`（60s 超时、2 MiB maxBuffer），解析函数与后端同款（`parseNameStatusLine` L110、`numstatNewPath` L663）。
- `getCommitFileDiff` 的双 show 模式（backend L435-436 / electron L845-846）：before/after 均取自 git 对象不读工作区，show 对不存在对象返回非零退出即空内容，据此推导 CREATED/DELETED——双 ref diff 沿用同语义。
- 分支名合法性规则双端已有：后端 `BRANCH_NAME_PATTERN`（`git-write-operation.service.ts` L27）+ `resolveSwitchTarget`（L678），前端 `isValidBranchName`（`desktop/src/utils/git-manager.ts` L141，check-ref-format 子集）。
- 零 DDL、零新依赖、零权限码：分支对比全部是 git 仓库实时数据，不落库。

## 2. 需求描述

### 2.1 目标

1. **新视图**：中央 Git 面板子导航新增第五项「对比」（位于 Stash 之后），懒加载；选择态与结果放 `useGitManager`（随面板实例被中心 Tab 的 KeepAlive 保活），切走再切回原样恢复。
2. **双分支自选**：两个分支选择器（基准 / 目标），选项均为本地 + 远端全部分支；**默认预选「当前分支的 upstream（如 `origin/main`）→ 当前分支」**（修订 3：取代原「不预选、不写死默认」口径），仍可随时改选、互不联动；任一侧变更即重新对比。
3. **对比结果**：汇总条（领先/落后提交数、变更文件数、总增删行数；**显式标注方向 `基准 → 目标`**）+ 变更文件**按目录分组的树形清单**（复用现有 `GitChangeTreeNode` 与抽出的 `buildGitTree`：单链目录压缩为 `a/b/c` 包名样式，rename 行展示旧路径；两点语义下「仅基准分支存在」的文件（`D`）加轻量标记）。
4. **单文件 diff**：点文件在中心 Diff Tab 打开该文件在两个分支间的 diff（before = `<base>:<oldPath ?? path>`，after = `<target>:<path>`）；rename 必须传 oldPath（base 侧旧路径）。**语义为两点 `base..target`（`git diff <base> <target>`）**：展示两个分支当前内容的全部差异，基准分支独有的改动会以「对目标的删除 / 反向修改」形式呈现——这是两点对比的固有方向性，由 UI 承接：方向标注（`base → target`）+「仅基准分支」标记 + 保留交换按钮（实机反馈与决策依据见 §4 D14）。
5. **分支行快捷入口**：分支视图每个分支行尾加「对比」按钮，点击切换到对比视图并把该分支预填到「目标」槽（**基准槽不被自动改动**：原为空则保持空、已有选择则保留），降低入口深度。
6. **双模式一致**：LOCAL（Electron IPC）与 CLOUD（REST）行为一致，UI 经扩展后的 `WorkspaceGitProvider` 无感知。
7. **安全边界不变**：分支名服务端严格校验（check-ref-format 子集，防 `-` 开头 option 注入），路径沿用 `..`/沙箱校验；截断（5000 行 / 512 KiB）与二进制降级同现行口径；命令一律参数数组执行，禁 shell 拼接。
8. **改动面**：desktop 纯前端 + Electron 2 个只读 IPC + 后端 2 个只读端点 + 一个既有服务扩展 + 一处纯函数抽取；零 DDL、零新依赖、零权限码、不改 admin。

### 2.2 非目标（明确不做）

- **不做 merge / rebase / cherry-pick 等写操作**：延续 10-28 口径，对比是纯只读能力。
- **不做分支创建 / 删除 / 重命名 / 设 upstream**（延续 10-28 口径）。
- **不做「工作区 vs 某分支」「HEAD vs 某分支」的特殊形态**：本期仅两个已命名分支之间；工作区 diff 已在变更视图提供。
- **不做 commit 级清单**（两个分支间的提交列表）：本期只列文件差异。用户已决策留后续（D11）；后端模式同 `getLog`，后续加是纯增量、零重构。
- **不做任意 ref 输入**：对比端点仅限分支下拉（本地 + 远端），不提供 tag / commit hash / 任意表达式的自由输入。用户已决策：仅分支（D12）；任意 ref 留后续。
- **不做 Tab 内嵌 diff 面板**：所有 diff 预览仍复用中心 Diff Tab（`FileDiffViewer`），不引入第二套渲染（延续 10-28 非目标）。
- **不做对比结果的缓存 / 持久化 / 历史记录**：git 实时数据无缓存价值；选择态由面板级 composable 状态保活（面板实例被中心 Tab 的 KeepAlive 缓存），刷新不重建。
- **不加权限码、不动角色体系、不改 admin、不加数据库迁移**。

## 3. 技术选型

### 3.1 决策结论

| 决策点 | 选择 | 理由 |
|---|---|---|
| 入口形态 | 中央 Git 面板第五个子导航「对比」（Stash 之后） | 与既有四视图同构；信息密度高的视图需要大 Tab 宽度；不动侧边栏（新能力只进大 Tab，D1） |
| 对比语义 | 两点 `<base>..<target>`（`git diff <base> <target>`，两侧当前内容全部差异） | **2026-10-29 实机反馈后变更**：三点在「目标分支完全落后」时清单为空、显示「两个分支没有差异」，与用户直觉严重不符；两点一屏给出两侧全部差异，方向标注 `base → target` 解释「左侧独有改动呈现为反向修改」（D14，取代 D2 的三点语义） |
| 分支选择 | 两个独立下拉，本地 + 远端全量；默认预选「当前分支 upstream → 当前分支」，仅空槽填充、可改选、不联动 | 修订 3（实机反馈）：每次进入都要手点两次不合用，给出常用起点；用户仍可任选（D3） |
| 分支行快捷入口 | 分支视图每行「对比」按钮 → 切到对比视图 + 预填该分支到目标槽 | 入口不深；预填只是可改的起点，不违反「两分支都由用户选」（D10） |
| 对比端点范围 | 仅本地 + 远端分支（下拉选择），不支持 tag / hash / 任意 ref | 零自由输入 = 零注入面、零拼错成本；任意 ref 留后续（D12） |
| 结果呈现 | 汇总条 + 文件**目录分组树**（复用 `GitChangeTreeNode` + 抽出的 `buildGitTree`）+ 点文件开中心 Diff Tab | 大对比下分组扫读优于平铺（用户决策）；树实现已存在，零新渲染代码（D4） |
| CLOUD 只读实现 | 扩展 `WorkspaceGitService`（`compareBranches` + `compareBranchFileDiff`） | 只读归只读服务；命令白名单在服务内部，不开放通用 exec（不新增执行器）（D5） |
| LOCAL 实现 | `gitStatus.cjs` 加两个只读函数；`main.cjs` 注册 2 个 IPC | 与现有 git-commit-files / git-commit-file-diff 同模式；LOCAL 本机凭证不涉及（纯本地对象读取）（D6） |
| diff 渲染 | 复用 `FileDiffViewer`（中心 Diff Tab），新 `idPrefix` `git-branch-diff:<base>-><target>:` | 不维护第二套渲染；id 隔离避免与工作区 diff / 提交 diff 互相覆盖（D7） |
| 测试 | 后端真实 git 夹具 + 路由 mock + Electron 同 fixture 对跑 + 前端 composable 单测；不新增 Playwright | 契约与解析是风险核心；CI 不跑 Playwright（D8） |

### 3.2 备选方案与否决

| 方案 | 否决原因 |
|---|---|
| 三点 `<base>...<target>`（merge-base） | **2026-10-29 由主选降级为否决（D14 取代）**：单侧语义在「目标分支完全落后」时清单为空（实机反馈：「明明差异很大」却显示「两个分支没有差异」），换方向需手动交换、多步操作；作为「只看目标分支引入的变更」的口径保留在决策记录中，后续如需可加「仅看目标分支」开关 |
| 固定基准分支（默认 main / 当前分支） | 需求明确否决：两个分支都由用户选择，不固定任何一个 |
| 文件清单平铺（与历史视图展开态一致） | 已评估并否决：大对比下扫读效率低；用户选择目录分组，且分组可复用现有 `GitChangeTreeNode` + `buildGitTree`，成本可控 |
| 分支名自由输入框 | 任意 ref 是 option 注入面（`-` 开头被 git 当选项）且拼错成本高；下拉选已有分支零风险 |
| 一次返回全部文件的 diff 内容 | 大对比体积远超 512 KiB 上限；与现有按需加载模式不一致 |
| Tab 内自绘 diff 渲染器 | `FileDiffViewer` 已成熟且双模式在用 |
| 通用 git exec 端点 | 等于开放任意 git 命令执行通道，安全审查不可接受 |
| 对比结果落库 / 缓存 | git 实时数据，无缓存价值；KeepAlive 已保活选择态 |
| 删除侧边栏或改造侧边栏 | 新能力只进大 Tab（10-28 D2 口径），侧边栏零改动 |

### 3.3 Git 命令约定（LOCAL / CLOUD 共用语义）

所有命令在**仓库根**执行，一律 `git -c core.quotepath=false` + 参数数组，禁止 shell 拼接。CLOUD 沿用 10s 超时 / 2 MiB 输出上限（`runGitRaw` 把 stdout+stderr 合并进同一预算、超限静默丢弃）；LOCAL 沿用 60s 超时 / 2 MiB `maxBuffer`。命令语义与解析规则双端一致；**「执行失败」与「空差异」必须可区分**：CLOUD 用 `runGitOk` 的 `null` vs `''`、LOCAL 用 `runGit` 的 `exitCode`（详见 §5.2/§5.3/§5.5）。两点语义不再需要 merge-base 判定，也不再有「无共同祖先」错误分支。

| 用途 | 命令 | 解析要点 |
|---|---|---|
| 分支存在性校验 | `git rev-parse --verify <ref>`（base、target **各一次单独调用**；实测 `--verify` 不接受多个 ref，一次传两个报 `fatal: Needed a single revision`） | ref 不存在（含远端跟踪分支已被删除、未出生分支）返回非零 → 映射「分支不存在」。**必须先校验再 diff**：diff 输出为空是「无差异」的合法结果，与「ref 不存在」必须可区分（详见 §5.3） |
| 领先/落后提交数 | `git rev-list --left-right --count <base>...<target>` | 输出 `left\tright`：left = 基准独有（目标落后数），right = 目标独有（目标领先数）。与 `getStatus` 的 `HEAD...@{upstream}` 同源命令（三点语法仅用于算对称差，与文件清单的两点 diff 无关） |
| 对比文件清单 | `git diff --numstat <base> <target>` + `git diff --name-status <base> <target>`（两次调用，与 `getCommitFiles` 同款合并；**两点，空格分隔，不是 `<a>...<b>`**） | 复用 `parseNameStatusLine` / `numstatNewPath`（rename 花括号紧凑形态与无花括号 `old => new` 双形态还原，双端实现均已支持并有单测）；二进制 `-`；输出为空 = 两分支当前内容完全一致（合法空列表）。`base` 有而 `target` 无 → `D`、反之 → `A`，base 侧独有改动以反向形式呈现（两点固有）。**不需要 `--first-parent`** |
| 单文件双 ref diff | before = `git show <base>:<oldPath ?? path>`，after = `git show <target>:<path>` | 均取自 git 对象、不读工作区；base 中不存在 → before 空（CREATED）；target 中不存在 → after 空（DELETED）；rename 必须传 oldPath（即 base 侧旧路径）。before/after 直接对应「左分支 vs 右分支」的当前内容（两点语义，D14） |

## 4. 关键决策（需求共识）

零新依赖、零 DDL、零权限码。十四个塑形决策（D2/D13 被 D14 取代，原条目保留以记录决策演进）：

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 入口形态 | 中央 Git 面板第五个子导航「对比」，位于 Stash 之后；懒加载；侧边栏不加入口（新能力只进大 Tab） |
| D2 | 对比语义 | ~~三点 `<base>...<target>`（merge-base），含义「目标分支相对基准独有的变更」~~ **被 D14 取代**：改为两点 `<base>..<target>`（`git diff <base> <target>`，展示两侧当前内容全部差异）；汇总条仍用「领先 N / 落后 M 个提交」表述（保留） |
| D3 | 分支选择 | 两个独立下拉（基准 / 目标），选项 = 本地 + 远端全部分支；**修订 3：默认预选「当前分支 upstream → 当前分支」**（无 upstream 时退回 `origin/<当前分支>` / 任一远端同名跟踪分支；仅空槽填充、不覆盖用户选择；原「不预选、不联动、无默认基准」被取代）；任一侧变更即重新对比；UI 拦截「两侧选同一分支」（不发请求） |
| D4 | 结果呈现 | 汇总条（领先/落后提交数 + 文件数 + 总增删行 + 方向标注 `base → target`）+ 文件**目录分组树**（复用 `GitChangeTreeNode`，`buildGitTree` / `collectDirPaths` 从 `GitChangeList.vue` 抽至 `utils/git-manager.ts` 双处共用；单链目录压缩 `a/b/c`；rename 行展示旧路径；「仅基准分支」文件加轻标记）；点文件开中心 Diff Tab（标题 `base → target · 文件名 (Git)`，id 前缀 `git-branch-diff:<base>-><target>:`） |
| D5 | CLOUD 只读端点 | 扩展 `WorkspaceGitService`：`compareBranches`（文件清单 + 计数，一次返回）/ `compareBranchFileDiff`（单文件）；命令白名单在服务内部（不新增执行器）；两点语义下无 merge-base 步骤 |
| D6 | LOCAL 实现 | `gitStatus.cjs` 加两个只读函数；`main.cjs` 注册 2 个 IPC（`git-branch-compare` / `git-branch-compare-file-diff`）；preload + `electron.d.ts` 同步 |
| D7 | diff 渲染 | 复用中心 Diff Tab；`openDiffTab` 的 `idPrefix` 机制已就绪（10-28 P2 落地），**不改其签名**；新 id 规则不影响现有 `git-diff:` / `git-commit-diff:` |
| D8 | 测试 | 后端真实 git 夹具（分叉/rename/增删/二进制/无差异/ref 不存在/非法分支名/空仓库/无共同祖先可对比/两点方向性）+ 路由 mock 拒绝路径 + Electron 同 fixture 对跑 + 前端 composable 单测；不新增 Playwright |
| D9 | 多仓库 | 对比跟随面板当前选中仓库：`statusProviderRef` 包装补两个方法绑定；切仓库清空对比选择与结果（防新旧仓库同名分支串扰） |
| D10 | 分支行快捷入口 | 分支视图本地/远端每行加「对比」按钮 → 切到对比视图并预填该分支到**目标**槽，基准槽不被自动改动（不清空、不填入）；预填是可改起点，两槽均不固定 |
| D11 | commit 级清单 | 本期不做（两个分支间的提交列表）；后端模式同 `getLog`（`rev-list base..target` 分页），后续纯增量追加 |
| D12 | 对比端点范围 | 仅本地 + 远端分支（下拉选自 `getBranches`）；不提供 tag / commit hash / 任意 ref 的自由输入 |
| D13 | 单文件 diff 的 before 端（**已被 D14 取代，保留作记录**） | 取 `git merge-base <base> <target>` 的 sha，而非 `<base>` 本身（注：该决策基于三点清单语义，已随 D14 失效）。理由：清单是三点 diff（merge-base → target），before 取 `<base>` 时内容变成「base tip → target tip」两点 diff。实测：main 与 feature 分叉且双方都改 `f.txt` 时，`git diff main...feature -- f.txt` 只有 `+c`，而 `diff <(git show main:f.txt) <(git show feature:f.txt)` 是 `-b +c`——基准分支的独有改动被显示成删除，与汇总条/清单自相矛盾，§8 手测项「与 `git diff A...B -- file` 内容一致」必然失败。取 merge-base 后单文件内容与 `git diff A...B -- <path>` 完全一致，rename 的 oldPath 也必然存在于 merge-base 树（退化路径更少）。附带收益：无共同祖先的判定从 diff 失败前移到 merge-base 退出码，错误文案更准（§5.3） |
| D14 | 对比语义改两点（2026-10-29 二次决策，实机反馈） | 语义 = `base..target`（`git diff <base> <target>`），展示两侧当前内容全部差异。触发：实机对比 `main` 与「完全落后 315 个提交」的远端分支时，三点清单为空、显示「两个分支没有差异」，与直觉严重不符（实测 `↑0 ↓315`、0 个文件）。两点下该场景直接列出领先侧全部变更；双向分叉时两侧变更同屏（实测：base 改 m.txt、target 改 f.txt + 加 n.txt → 三个文件都在清单）。固有方向性（base 侧改动呈现为对 target 的反向修改 / 删除，如 `-m1 +m0`）由 UI 承接：汇总条与标题标注 `base → target`、清单对「仅基准分支」文件（`D`）加标记、保留领先/落后计数与交换按钮。单文件 before 取 `<base>:<oldPath ?? path>`（D13 的 merge-base 取值失效）；无共同祖先不再报错（两点可直接比较两棵树） |

## 5. 详细设计

### 5.1 组件结构与渲染链路

```
TaskView.vue（改：接 'open-branch-diff' 事件，新 handler）
└─ CenterTabContainer.vue（改：'open-branch-diff' 透传一行 + emits 声明）
    └─ <GitManagerPanel>（改：子导航加一项 + 分发分支 + 多仓库包装补绑定 + diff 出口 + 分支行预填）
          ├─ 仓库下拉 / 仓库徽章（现状）
          ├─ 仓库状态条（现状）
          ├─ 子导航：变更 | 历史 | 分支 | Stash | 对比   ← 新增「对比」
          ├─ <GitCompareView>（新：双分支下拉 + 汇总条 + 目录分组文件树）
          │     └─ 点文件 → emit('open-branch-diff', { base, target, file })
          ├─ <GitBranchesView>（改：每行加「对比」按钮 → emit('compare', name)）
          └─ 其余三视图（现状）
```

- **打开**：无新 Tab 类型、无新 `openXxxTab()`——「对比」是 Git 面板内部子导航的一项，复用现有 Git 大 Tab（单例 id `git`）。
- **懒加载**：`useGitManager.loadActiveView`（L210-214）增加 `compare` 分支；对比视图的分支下拉选项来自 `branches`，故该分支同时触发 `loadBranches()`（用户可能从未进过分支视图）——**调用点需自己带 `!branchesLoaded && !branchesLoading` 守卫**（`loadBranches` 自身无守卫，详见 §5.6）。
- **分支行快捷入口**（D10）：`GitBranchesView` 每行（本地与远端均加）「对比」按钮 emit `compare(name)` → `GitManagerPanel.handleCompareBranch(name)`：`activeView = 'compare'` 且 `compareTarget = name`（`compareBase` **不动**：不自动填入、也不清空已有值）→ `watch(activeView)`（L216-218）触发懒加载。基准为空时用户再选基准即自动对比；此前已选过基准则沿用旧基准立即出结果。预填只是起点，两槽均可改。
- **事件出口**（与 `open-commit-diff` 同模式，两级透传）：面板 emit `open-branch-diff`（payload `{ base, target, file, repoPath? }`）→ `CenterTabContainer` 加一行透传（L60 同款）+ emits 声明（L99-100）→ `TaskView.handleOpenBranchDiff` 调 provider 新方法 → 构造 `FileChange` → `openDiffTab(change, title, { source: 'git', idPrefix })`。
- **多仓库**：`repoPath` 由面板按 `multiRepoMode ? selectedRepoPath : undefined` 填入 payload（同 `handleOpenCommitDiff` L401-407）。

### 5.2 Provider 接口扩展（`desktop/src/types/git.ts` + `workspace-git-provider.ts`）

```ts
/** 分支对比结果：`base → target` 两点差异的文件清单 + 两侧独有提交数。 */
export interface GitBranchCompareResult {
  base: string
  target: string
  /** 目标分支独有的提交数（rev-list --left-right --count base...target 的 right 段） */
  aheadCount: number
  /** 基准分支独有的提交数（同命令 left 段；等价于 rev-list --count target..base） */
  behindCount: number
  files: GitChangedFile[]
}
```

`WorkspaceGitProvider` 新增（均带 `repoPath?` 尾参，与现有方法同模式）：

```ts
/** 两个分支的当前内容差异清单（两点 base → target）+ 领先/落后提交数。ref 不存在时抛错（不可与「无差异」的空列表混淆）。 */
compareBranches(base: string, target: string, repoPath?: string): Promise<GitBranchCompareResult>
/**
 * 分支对比单文件 diff（before/after 均取自 git 对象，两点语义）。
 * oldPath 传文件清单里的旧路径（rename 行）：before 取 <base>:<oldPath>（oldPath 即 base 侧旧路径）。
 * 不传会把改名显示成「整份新增」；两点语义下 before/after 直接对应「左分支 vs 右分支」的当前内容（D14）。
 * 返回的 GitFileDiff.path 恒为入参 relativePath（新路径）——TaskView 用其生成 tab id / 标题
 * （change.path 同款，L739/L753），返回旧路径会让对比 tab 指向旧文件。
 */
compareBranchFileDiff(base: string, target: string, relativePath: string, repoPath?: string, oldPath?: string): Promise<GitFileDiff>
```

错误契约：`compareBranches` 读取失败抛错（同 `getLog` / `getCommitFiles`，由视图展示错误 + 重试）。CLOUD 侧 `BusinessException` 随现状直接冒泡（现有只读方法不 catch，message 透出）；LOCAL 侧对象形态结果的内联解包已有先例：`getCommitFiles`（provider L252-259）在拿到 IPC 返回后判 `'error' in data` 即抛、否则取字段——`compareBranches` 照此办理（`unwrapIpcArray` 只覆盖数组形态，不适用也无需改动）。

`compareBranchFileDiff` 的失败语义按各端现状复刻，**不要笼统写成「失败返回带 unavailableReason 的 GitFileDiff」**：

- CLOUD（对齐后端 `getCommitFileDiff` L406-459）：输入 / 沙箱错误（路径 `..`、越界等）→ `BusinessException`（PARAM_INVALID / FORBIDDEN）；对象缺失不算错误——before 缺失按空内容处理、由 CREATED/DELETED 推导表达；二进制 → `binary: true` + `unavailableReason: '二进制文件，无法预览'`；超限 → `truncated`（不设 unavailableReason）。
- LOCAL（对齐 `getGitCommitFileDiff` L820-869）：输入类失败（路径 `..`、越界等）返回带 `unavailableReason` 的降级对象（不 throw）；对象缺失 → 空内容 + CREATED/DELETED 推导；二进制 → `unavailableReason`；超限 → `truncated`。

TaskView handler 保持 try/catch 兜底（同 `handleOpenCommitDiff`：catch 时 ElMessage.error 且不打开 Tab）。

另注意 CLOUD 执行器细节：`runGitOk`（L757-761）对一切非零退出统一返 null——两点语义下无需细分退出码：「执行失败」用 `null` 与「空差异」的 `''` 天然区分（失败原因 124 / 127 / 128 统一映射中性文案「对比失败，请重试」）；`resolveBranchSha` 用模块导出的 `runGitRaw`（L980-1009）取 sha。`runGitRaw` 特性需知情：stdout 是 **stdout+stderr 合并流**（numstat / name-status 解析对无制表符行安全跳过）、2 MiB 为 stdout+stderr **合计**预算、超限静默丢弃且 exitCode 仍为 0、无截断标志。

### 5.3 后端：`WorkspaceGitService` 只读扩展

`backend-ts/src/file/workspace-git.service.ts` 新增两个方法（走既有 `runGitRaw` / `runGitOk` + `resolveRepoRoot`，不新增执行器；两点语义无需 merge-base；**「执行失败」与「空差异」必须区分**——`runGitOk`（L757-761）对非零统一折 null（124 / 127 / 128 不细分，统一映射「对比失败，请重试」），成功且无输出才是空列表；`resolveBranchSha` 走已导出的 `runGitRaw`（L980-1009）取 sha）：

| 方法 | 命令序列 | 返回 / 边界 |
|---|---|---|
| `compareBranches(ws, repoPath, base, target)` | ① `rev-parse --verify <base>` ② `rev-parse --verify <target>` ③ `rev-list --left-right --count <base>...<target>`（计数，保留三点语法算对称差） ④ `diff --numstat <base> <target>` ⑤ `diff --name-status <base> <target>`（**两点**） | `GitBranchCompareDTO`；base/target 服务端校验分支名规则（见下），不合法或 verify 失败 → `PARAM_INVALID '分支不存在'`；④⑤ 空输出 → `files: []`（合法：两分支当前内容完全一致），执行失败 → 中性「对比失败，请重试」（**无「无共同祖先」错误分支**：两点可直接比较两棵树）；numstat 与 name-status 合并逻辑复用 `getCommitFiles` 同款（`parseNameStatusLine` + `numstatNewPath` + 二进制 `-` 判定）；`base` 有而 `target` 无 → `D`、反之 → `A`（两点方向性，D14） |
| `compareBranchFileDiff(ws, repoPath, base, target, path, oldPath?)` | ① 两个 ref verify ② `show <baseSha>:<beforePath>` ③ `show <targetSha>:<path>`（**两点，无 merge-base 步骤**） | 复用 `GitFileDiffDTO` 契约，**失败语义按 `getCommitFileDiff`（L406-459）现状精确对齐**：输入 / 沙箱错误（路径 `..`、越界等）→ `BusinessException`（PARAM_INVALID / FORBIDDEN）；对象缺失不是错误——show 非零退出 → 空内容、由 CREATED/DELETED 推导表达；二进制 → `binary: true` + `unavailableReason: '二进制文件，无法预览'`；超限 → `truncated`（不设 unavailableReason）。`..` 校验 + `isUnder(absolute, repoRoot)` 沙箱（注意只抄这一层，`getFileDiff` 多出的 `pathSandbox.resolve` 不在 `getCommitFileDiff` 里）、`isBinaryString`、`truncateText`（5000 行 / 512 KiB）。**before 端取 base tip（D14）**：与 `git diff <base> <target> -- <path>` 的对应侧一致；**返回的 `path` 必须是新路径**（§5.2） |

分支名校验（安全边界）：字符类 `^[A-Za-z0-9._/][A-Za-z0-9._/-]*$`（**首字符排除 `-`**，杜绝 option 注入——spawn 参数数组不过 shell，但挡不住 `-` 开头被 git 当选项）+ 结构性规则（不含 `..` / `@{`、不为 `@`、不以 `/` 开头或结尾、不含 `//`、不以 `.` 结尾、每个 `/` 组件非空且不以 `.` 开头、不以 `.lock` 结尾、长度 ≤ 200）。

**与现有 switch 侧校验的关系（务必按此实现，勿照抄现状）**：write 服务 `BRANCH_NAME_PATTERN`（`git-write-operation.service.ts` L27）与前端 `isValidBranchName`（`utils/git-manager.ts` L141）的字符类是 `^[A-Za-z0-9._/-]+$`，`-` 位于类尾是字面量，**首字符并不拒绝 `-`**（已实测 `-x` 可通过两端现有正则）。git 自身 `check-ref-format --branch` 拒绝 `-x` 开头，故本方案只读侧的新正则严于现状但不误伤任何真实分支（`-x` 经 porcelain 无法创建，属可忽略极端）；switch 侧的同一漏洞不在本方案范围修复，但不得宣称「与现状同规则」。另注意字符类仍窄于 check-ref-format（如 `+` 合法但被拒）——与 switch 侧同款的已知限制，下拉选分支时极端情况可能选到类外字符名，接受（与现有口径一致）。

注意 `BRANCH_NAME_PATTERN` 常量现居 write 服务且未导出，只读侧在 `workspace-git.service.ts` 定义上述正则并注释互指（只读侧不依赖写服务的导出面）；electron 侧 `.cjs` 无法 import TS 工具模块，按仓库既有「解析函数双端各一份 + fixture 对跑」模式在 `gitStatus.cjs` 写同规则实现（§5.5）。

**「空列表」语义（易错点，务必实现与测试）**：`getCommitFiles` 的「两次 show 均非零退出 = 提交不存在」不适用于本方案——`git diff <base> <target>` 无差异（两分支当前内容完全一致）时输出为空且退出码 0。因此必须先 `rev-parse --verify` 两个 ref（不存在 → 报错），再跑 diff（空输出 → 空列表）。二者顺序不可颠倒，也不可用 diff 的退出码推断 ref 存在性。

空仓库（无提交）：`rev-parse --verify <任何分支>` 失败 → `PARAM_INVALID '分支不存在'`，UI 展示错误 + 重试，不白屏。无共同祖先（unrelated histories）：两点语义下**可正常对比**（`git diff <base> <target>` 直接比较两棵树），不再抛错；`rev-list --left-right --count` 同样可用。

### 5.4 后端：REST 端点（`file.routes.ts`）

沿用 git 端点族现行守卫（`requireOwnedCloudGitSession`：属主 + 工作区非空 + 拒绝 `executionMode === 'LOCAL'` 会话，LOCAL 走 IPC），`repoPath` 只接受一级子目录名：

| 方法 | 路径 | 参数 | 服务方法 |
|---|---|---|---|
| GET | `/v1/files/workspace-git-branch-compare` | sessionId, repoPath?, **base**, **target** | `workspaceGitService.compareBranches` |
| GET | `/v1/files/workspace-git-branch-compare-file-diff` | sessionId, repoPath?, **base**, **target**, **path**, oldPath? | `workspaceGitService.compareBranchFileDiff` |

base/target 必填（缺失 → `PARAM_MISSING '缺少必要参数'`，同 `workspace-git-commit` 端点的 hash 校验样式）；路径参数与 `oldPath` 的必填/可选规则同 `workspace-git-commit-file-diff`（L294-302）。

### 5.5 Electron：LOCAL 实现

`desktop/electron/gitStatus.cjs` 新增导出（纯只读，走既有 `runGit` / `runGitOk` / `resolveRepoRoot`，与后端同命令同解析）：

- **分支名校验（新增，LOCAL 侧安全边界的着落）**：gitStatus.cjs 现状零 ref 名校验（仅有 hash 十六进制正则与路径 `..` 检查），且 `.cjs` 无法 import 前端 TS 工具模块，故按仓库「解析函数双端各一份 + fixture 对跑」先例新增同规则 `isValidBranchName` 实现（正则与结构性规则同 §5.3，注释互指），两个新函数入口先校验再执行。
- `getGitBranchCompare(workspace, repoPath, base, target)`：校验 base/target → verify 两个 ref → `rev-list --left-right --count` → `diff --numstat` + `--name-status` 合并（逐行复刻 `getGitCommitFiles` L770-806 的合并逻辑，把 `show` 换成两点 `diff <base> <target>`）；**失败与空输出必须可区分**：rev-list / diff 均走 `runGit`（能拿 `exitCode`），非零一律 throw「对比失败，请重试」；ref 不存在 → 「分支不存在」（main.cjs 转 `{ error }`，与 `git-commit-files` 的 catch 形状一致）。**不要用把非零统一折成 null 的 `runGitOk` 判空**，否则超时 / maxBuffer 溢出会被误报为「没有差异」；只有 `exitCode === 0` 且 stdout 为空才是空列表
- `getGitBranchCompareFileDiff(workspace, repoPath, base, target, relativePath, oldPath)`：校验 base/target → verify 两个 ref → 双 show `<base>:<beforePath>` / `<target>:<path>`（复刻 `getGitCommitFileDiff` L820-869 结构，把 `<hash>^:` / `<hash>:` 换成 `<base>:` / `<target>:`，两点，无 merge-base 步骤）；二进制 / 截断 / 路径校验原样；**失败语义对齐现状**：输入类失败返回带 `unavailableReason` 的降级对象、对象缺失按空内容 + CREATED/DELETED 推导（均与 `getGitCommitFileDiff` 一致；返回的 `path` 为新路径，§5.2）。注意两个 handler 的 catch 形状不同：`git-commit-files` 回 `{ error }`、`git-commit-file-diff` 回降级 diff 对象（D6 合并表述易误导，实现时按各自先例）

`main.cjs` 注册 2 个 IPC（`git-branch-compare` / `git-branch-compare-file-diff`，错误契约同 `git-commit-files` / `git-commit-file-diff` 的 catch 形态）；**顶部 L1081 的 `require('./gitStatus.cjs')` 解构列表必须同步加入两个新函数**（漏加会以 TypeError 被 catch 成 `{ error: 'xxx is not a function' }` 怪文案）。`preload.cjs` 暴露 2 个方法；`electron.d.ts` 补类型（内联对象风格同现有声明）。版本不手改 `desktop/package.json`——发版时按 AGENTS.md 用 `./scripts/changelog-extract.sh sync-desktop` 同步（**该子命令不接版本参数**，版本取自 CHANGELOG 首个 `## ` 行）。

### 5.6 前端：面板与视图组件

**`components/git/GitCompareView.vue`**（新）：

```
┌────────────────────────────────────────────────────┐
│ [基准分支        ▾]  [⇄]  [目标分支        ▾]      │  选择行（两个 el-select，filterable，size small）
│ main → feature · ↑3 领先 · ↓1 落后 · 5 个文件 +120/-40 │  汇总条（含方向标注，选满两个分支后显示）
│ ──────────────────────────────────────────────────  │
│ ▾ 📁 src/                                          │  目录分组树（复用 GitChangeTreeNode，
│    ▾ 📁 components/git/                            │   目录行仅图标+名，统计只出现在文件行）
│         R  new.ts  ~~old.ts~~          +30/-12     │
│    ▸ 📁 utils/                                     │
│ 📄 README.md                               +2     │
└────────────────────────────────────────────────────┘
```

- 选择行：两个 `el-select`（本地 / 远端两个 `el-option-group`，当前分支加 `✓` 标记）；中间一个交换按钮（⇄，互换 base/target 后重新对比）。**默认预选「当前分支 upstream → 当前分支」**（修订 3；无可预选值时为空，placeholder「选择分支」），仅空槽填充、可改选、不联动（D3）；从分支行「对比」按钮进来时目标槽已预填（D10），基准取默认预选值。
- 状态机：未选满 → 提示「请选择两个分支开始对比」；分支列表加载中（`branchesLoading`）→ 加载态，**不闪「没有可用分支」**、确认加载完成且为空（空仓库）才提示「没有可用分支」；两侧相同 → 提示「两个分支相同，没有差异可对比」且**不发请求**；对比请求加载中 → 加载态，错误 → 错误文案 + 「重试」，结果为空 → 「两个分支当前内容完全一致」（两点语义下这才是真正的无差异，含「提交历史不同但内容相同」的情形）。
- 汇总条：`{base} → {target} · ↑{aheadCount} 领先 · ↓{behindCount} 落后 · {files.length} 个文件 · +{总增}/-{总删}`（增删为清单各行求和；**方向标注 `base → target` 必显示**，用于解释两点语义「左侧独有改动呈现为反向修改」）。
- 文件树：直接复用 `components/task/GitChangeTreeNode.vue`（纯 props/emits 递归组件：入参 `node` / `depth` / `collapsed`，emit `toggle` / `open-diff` / `contextmenu`）；两点语义下 `changeType === 'DELETED'` 的文件（仅基准分支存在）在文件行加轻量「仅基准分支」标记，避免被误读为目标分支主动删除；目录折叠态由本组件自持（`reactive(new Set<string>)`，默认全展开；右键菜单本期不接——compare 视图的上下文菜单留后续）。注意面板内子视图是 v-if/v-else-if 链、**没有 KeepAlive**，折叠态在切子导航时随之复位（默认全展开，与其它视图同口径，接受）；rename 行的旧路径删除线展示由该组件内置（`git-file-old`）。目录聚合与单链压缩（`a/b/c` 包名样式）复用抽出的 `buildGitTree`。
- 错误态：provider 抛错的 message 原样展示 + 「重试」按钮（同 `GitHistoryView` 的 error 态样式）。

**`components/git/GitBranchesView.vue`**（改）：本地与远端每行按钮区在现有按钮后加「对比」按钮（本地行现有按钮为「切换」；**当前分支行按钮文案是「当前」且禁用**；远端行现有按钮文案是「跟踪并切换」——「对比」加在这些按钮之后；当前分支行也加，对比当前分支与任意分支是合法诉求），emit `compare(name)`；按钮样式复用 `git-branch-switch`（次级样式）。

**`composables/useGitManager.ts`**（改）：`GitManagerView` 联合加 `'compare'`（L6）；新增状态——

| 状态 | 类型 | 说明 |
|---|---|---|
| `compareBase` / `compareTarget` | `string`（空串 = 未选） | 两个分支选择；切仓库 / 切会话清空 |
| `compareResult` | `GitBranchCompareResult \| null` | 最近一次成功结果 |
| `compareLoading` / `compareError` / `compareLoaded` | — | 同 history/branches 同款三件套 |
| `compareSeq` | composable 闭包内 `let` 序号（同 `branchesSeq`，**非模块级**） | 竞态防护：在途请求迟到不得写进新选择的结果（抄 `branchesSeq` 模式；误建成模块级共享变量会让多面板实例互相干扰） |

`loadCompare()`：base/target 均非空且不相同才请求（相同由 UI 拦截，这里双保险）；**必须内部 try/catch、把错误写进 `compareError`，不允许抛**——`refreshLoadedViews` 挂在 `handleRefreshAll`（无 catch）的 `await Promise.all(tasks)` 上，抛错会变成未处理 rejection 并打断写操作后的刷新链。`watch([compareBase, compareTarget])` 触发重算；`resetAll()`（L53-80）扩展清空 compare 四件套与两个选择；`loadActiveView()` 增加 `compare` 分支（同时按需 `loadBranches()` 供下拉）——**该调用点必须显式复用 `!branchesLoaded.value && !branchesLoading.value` 双守卫**（`loadBranches` 自身无守卫，裸调会重发请求并 `++branchesSeq` 作废在途结果）。分支行快捷入口只需外部写 `compareTarget = name` + `activeView = 'compare'`（面板 handler 两行赋值，`compareBase` 不动），无需新增 composable API。

**`GitManagerPanel.vue`**（改）：`views` 数组（L203-208）加 `{ id: 'compare', label: '对比' }`；分发区（L95-168）插入 `v-else-if="activeView === 'compare'"` 渲染 `GitCompareView`——**必须插在 `GitStashView`（现为 `v-else`，L159-160）之前，并把 stash 分支改成 `v-else-if="activeView === 'stash'"`**，否则 compare 分支是永不渲染的死代码；`GitBranchesView` 接 `@compare="handleCompareBranch"`（赋 `compareTarget` + 切视图）；`statusProviderRef` 多仓库包装（L230-257）补 `compareBranches` / `compareBranchFileDiff` 两个方法绑定（**易漏，漏则对比不带 repoPath**；注意新方法签名 `repoPath` 在**第 4 位**，现有 `getCommitFileDiff` 在第 3 位，照抄 L247 的写法会传错位）；新增 `handleOpenBranchDiff(payload)`，按 `handleOpenCommitDiff`（L401-407）同款补 `repoPath` 后 emit（入参不含 repoPath、由面板按 `multiRepoMode ? selectedRepoPath : undefined` 补，同现状约定）。

**`TaskView.vue`**（改）：新增 `handleOpenBranchDiff(payload: { base, target, file, repoPath? })`——逐段复刻 `handleOpenCommitDiff`（L725-758）：rename 行传 oldPath（oldPath 是 base 侧旧路径，由 provider 内部用于 `<base>:<oldPath>`，TaskView 只透传不解释）、`FileChange` 构造（`diffMode = binary || unavailableReason ? 'UNSUPPORTED' : 'SNAPSHOT'`；`truncated` 不降级、只进 `diffUnavailableReason` 文案）、标题 `base → target · [repoPath ·] 文件名 (Git)`、`idPrefix = git-branch-diff:${base}->${target}:`、repoPath 时 `change.path` 拼前缀（`change.path` 取自 provider 返回的 `diff.path`——即新路径，见 §5.2 返回契约）。`openDiffTab` 签名不变（`idPrefix` 已支持）。

**`useCenterTabs.ts`**（改，原稿遗漏的相邻机制）：`openDiffTab` 的 `idPrefix` 之外，`applyWorkspacePathChange`（L468-511）在工作区路径变化时重定向 diff tab，其前缀识别是三元链 + 兜底（L482-485）：`git-commit-diff:<hex>:` / `git-diff:` / `diff:`，**其余一律落 `file:`**——后果不止标题退化：新 `git-branch-diff:` 前缀的 tab 会被改写成 `file:<newpath>` 而 `type` 仍为 `'diff'`（id↔type 契约破坏），base/target 段整体丢失、无法重建标题。需**前缀链与 title 分支一并扩展**：新增匹配 `/^git-branch-diff:([^:]+)->([^:]+):/`（branch 名不允许 `:` 与 `>`，按 `->` 解析无歧义），分支位置与 `commitDiffMatch` 并列——id 保留 `git-branch-diff:<base>-><target>:` 前缀，标题重组为 `<base> → <target> · <fileName> (Git)`，并同步 `fileChange.path` 与 `quoteRevision`（同 commit-diff 分支写法）。注意重组标题会丢 repoPath（与 `git-commit-diff` 现状一致，接受）。补回归用例（参考 `useCenterTabs.test.ts` L663-711 现有 git-diff / git-commit-diff 并存与重定向用例；新用例为净新增，断言只打 id / filePath / title——测试里 `quoteRevision` 被 mock 恒 0）。

**纯函数下沉（本次唯一的既有代码搬迁）**：`buildGitTree` / `collectDirPaths`（含嵌套的 `compressChildren` 单链压缩与 `finalize`）从 `components/task/GitChangeList.vue` 抽到 `utils/git-manager.ts`（git 纯函数既有归属，现 200 行），`GitChangeList` 改为 import——**行为零变**，抽取的动机是对比视图的目录分组树与变更视图共用同一实现，避免第二套树逻辑漂移。**搬迁范围精确化**：只搬 `collectDirPaths`（L331-338）与 `buildGitTree`（L340-436，含内部 `finalize` / `compressChildren`）两个纯函数；同区段的 `treeRoots` computed（L313）、collapsed 清理 watch（L315-324）、`toggleDir`（L326-329）是组件状态胶水，留在 `GitChangeList`。该函数目前零自动化覆盖（现有两个 GitChangeList 相关 spec 只测提交交互与工具栏），**先补 `utils/git-manager.test.ts` 树用例再搬迁**（§8 列为 P4 前置）。`utils/git-manager.ts` 另有的 `isValidBranchName`（L141）将用于前端预检双保险（服务端校验才是安全边界；**注意它现状零生产调用点、仅单测覆盖**，前端预检是本方案新增调用）；其正则同样不拒 `-` 开头（单字符 `-` 也能通过），本方案只读侧按 §5.3 更严正则执行，前端预检同步收紧。

### 5.7 刷新时机与数据一致性

- 打开 Git Tab / 切到「对比」视图：按需 `getBranches`（供下拉；多仓库模式下 `loadBranches` 经 `statusProviderRef` 注入 repoPath，拿到的是选中仓库的分支，与对比请求同仓库）+ 首次选满两个分支时 `compareBranches`；不预请求。
- 切仓库 / 切会话：`resetAll()` 清空 base/target/result（防新旧仓库同名分支串扰——同 10-28 的 `commitFiles` 缓存串扰风险同源），再按当前视图重载。
- 写操作后（commit/pull/push/fetch/switch/stash）：`refreshLoadedViews()` 已覆盖 branches；若对比视图已加载过（`compareLoaded`），一并重算当前对比（分支内容可能因切分支 / fetch 变化）——按其现有 `tasks.push(...)` + `await Promise.all` 模式（L200-207）加一行 `if (compareLoaded.value) tasks.push(loadCompare())`（勿用 fire-and-forget 的 `void loadCompare()`，否则刷新流程不等对比重算完成；前提是 `loadCompare` 内部吞错不抛，§5.6）。
- 不轮询、不 watch 文件系统（与面板现行口径一致）；切走中心 Tab 再切回：面板实例被中心 Tab 的 KeepAlive 保活，选择态与结果（在 composable 中）原样恢复、不自动重算——注意面板内子导航是 v-if 链、无 KeepAlive，`GitCompareView` 内部的折叠态切子导航即复位（默认全展开，接受）。

### 5.8 快捷键

无（与文件管理器 / Git 大 Tab 现行口径一致，避免与聊天输入区冲突）。

## 6. 实现步骤

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 后端能力 | `workspace-git.service.ts` 两方法（+ 导出的 `GitBranchCompareDTO` + 分支名校验**更严正则** + 两点 diff、失败与空差异区分）+ `file.routes.ts` 两端点；`workspace-git.service.spec.ts` 真实 git 夹具用例 + `file.routes.spec.ts` 拒绝路径 | 中 |
| P2 LOCAL 能力 | `gitStatus.cjs` 两函数（失败 ≠ 空差异：`runGit` 读 exitCode）+ `main.cjs` 两 IPC（含 L1081 解构）+ preload + `electron.d.ts`；`gitStatus.test.cjs` 同 fixture 对跑 | 中 |
| P3 provider 与类型 | `types/git.ts` 新类型；`workspace-git-provider.ts` 接口 + LOCAL/CLOUD 双工厂 + 「会话未就绪」stub；对象形态 IPC 错误解包 | 小 |
| P4 前端视图 | `GitCompareView.vue`（双分支下拉 + 汇总条 + 目录分组树）；`buildGitTree` / `collectDirPaths` 从 `GitChangeList.vue` 抽至 `utils/git-manager.ts`（**先补树测试再搬迁**，GitChangeList 改 import，行为零变 + 回归）；`useGitManager.ts` compare 状态机（含分支行预填）；`GitBranchesView.vue` 每行「对比」按钮；`GitManagerPanel.vue` 子导航 + 分发（注意 stash 的 `v-else` 改造）+ 多仓库绑定 + diff 出口 + 预填 handler；`TaskView.vue` `handleOpenBranchDiff`；`useCenterTabs.ts` 前缀链扩展；`GitManagerPanel.test.ts` 基座 mock 更新（activeView 改 ref + GitCompareView mock） | 中 |
| P5 打磨与文档 | 交换按钮 / 汇总条 / 空态文案；手测清单；CHANGELOG 三小节 + mao-cli SKILL.md 同步 | 小 |

P1–P3 完成即可在只读层面联调（provider 双端齐）；P4 完成即可用；P5 随发版。各阶段可独立提交。

## 7. 风险与开放问题

- **两点语义的方向感（D14）**：`base → target` 中基准侧独有的改动会呈现为「对目标的删除 / 反向修改」（实测：base 将文件改成 m1、target 仍是分叉点 m0 时，diff 显示 `-m1 +m0`）。缓解：汇总条 / 标题标注方向 `base → target`、清单对「仅基准分支」文件加标记、保留交换按钮一键换向。
- **清单与单文件内容的语义一致性（D14）**：两点语义下清单（`git diff base target`）与单文件（before=`<base>:path`、after=`<target>:path`）同源同向，不再有漂移面；回归用例锁「与终端 `git diff A B -- <file>` 内容一致」。
- **「空列表」与「ref 不存在」不可混淆（已实测风险）**：`git diff <base> <target>` 无差异时输出为空、退出码 0；若用 diff 退出码推断存在性，分支被删后会显示「没有差异」的假象。缓解：先 `rev-parse --verify` 两个 ref 再 diff（§5.3），单测覆盖。
- **分支名校验是安全边界**：ref 以 `-` 开头会被 git 当选项（option 注入）。spawn 参数数组不过 shell 挡不住这一层。缓解：服务端字符类首字符排除 `-` + 结构性校验（§5.3；注意现有 write 侧正则首字符并不拒 `-`，本方案只读侧用更严正则、勿照抄现状），LOCAL 侧同规则实现，回归用例含 `-x` / `..` / `~` / `@{` 等非法名。
- **LOCAL 侧分支名校验缺位（§5.5 已补着落）**：gitStatus.cjs 现状零 ref 名校验，且 `.cjs` 无法复用前端 TS 校验；不补则「双端同规则」落空、任意字符串直进 git 参数数组。缓解：§5.5 新增同规则实现 + 与后端 fixture 对跑。
- **CLOUD 执行器退出码歧义**：`runGitOk` 对非零统一返 null（124 / 127 / 报错不可区分）。缓解：两点语义下无需细分退出码——失败一律中性文案「对比失败，请重试」，与空差异（`''`）天然区分；`resolveBranchSha` 走导出的 `runGitRaw` 取 sha。另 `runGitRaw` 的 stdout 是 stdout+stderr 合并流、2 MiB 为合计预算超限静默丢弃。
- **rename 的 oldPath 传递**：不传会把改名显示成「整份新增」（before 取新路径在 base 中不存在 → CREATED）。缓解：TaskView handler 只对 `RENAMED` 传 oldPath（同 `handleOpenCommitDiff`），单测 + 手测覆盖。**两点语义下的已知边界**：若 base 侧已不存在 oldPath（base 删除该文件、仅 target 侧存在新路径），before 端为空、按 CREATED 呈现——这是两点语义的合理降级，接受。另 `compareBranchFileDiff` 返回的 `path` 必须是新路径（TaskView 用其生成 tab id / 标题，§5.2）。
- **无共同祖先（unrelated histories）**：两点语义下可正常对比（`git diff <base> <target>` 直接比较两棵树；`rev-list --left-right --count` 同样成功），不再需要特殊判定与错误文案；单测覆盖「unrelated 可对比」场景（§8）。
- **多仓库包装漏绑定**：`statusProviderRef` 逐个重绑方法，漏绑 `compareBranches` / `compareBranchFileDiff` 则对比请求不带 `repoPath`、打到工作区根仓库。缓解：§9 落点清单显式列出；手测含多仓库工作区。
- **`buildGitTree` 抽取的回归面**：该函数（含 `compressChildren` 单链压缩、`finalize`）现居 `GitChangeList.vue` 内部且**目前零自动化覆盖**，抽取后变更视图的树渲染必须零变化。缓解：先补 `utils/git-manager.test.ts` 树用例再搬迁（P4 前置）；纯函数原样搬家不改逻辑（只搬 L331-436 两个纯函数，组件胶水留下）；手测清单含变更视图树回归。
- **LOCAL 侧「失败」与「无差异」的混淆（方案补充）**：`gitStatus.cjs` 的 `runGitOk` 同样把非零 / 超时 / maxBuffer 溢出折成 null。缓解：compare 的 rev-list / diff 一律用 `runGit` 读 `exitCode`（§5.5），先 verify 再 diff 的顺序不可颠倒。
- **`applyWorkspacePathChange` 前缀链（§5.6 补充项）**：`git-branch-diff:` 不进前缀链则对应 tab 在工作区路径变化时被改写成 `file:` 前缀——id 变 `file:` 而 `type` 仍 `'diff'`（id↔type 契约破坏）、base/target 语义丢失、标题退化成 `文件名 (变更)`。缓解：前缀链与 title 分支一并扩展（并同步 `fileChange.path` / `quoteRevision`）+ 回归用例。
- **分支行预填与「不固定分支」的口径**：预填目标槽是可改起点；基准槽不被自动改动（原为空保持空、已有值保留）；UI 文案不得暗示基准被固定（如不写「与 main 对比」）。缓解：预填仅写 `compareTarget`，`compareBase` 不动（D3/D10）。
- **2 MiB 输出上限的静默丢弃**：CLOUD `runGitRaw` 对 stdout+stderr **合计** 2 MiB 超限即丢弃、不报错、无标志位。numstat 一行约 40-100 字节，2 MiB ≈ 2 万+ 文件才触顶，正常对比不可能；接受，不特殊处理（超大 monorepo 全量对比留作观察）。
- **LOCAL/CLOUD 解析一致性**：numstat/name-status 合并、left-right 计数、二进制判定双端同规则同 fixture 对跑（§8）。
- **远端分支作端点的时效**：下拉里的 `origin/x` 是本地跟踪引用，未 fetch 时可能是旧状态。缓解：顶部刷新按钮已含 `fetch --prune`；对比视图不自动 fetch（只读、免副作用），文案不承诺实时。
- **开放问题：commit 级清单**（两个分支间的提交列表，GitHub PR 的 Commits 页）：用户已决策本期不做（D11）；若后续需要，新增 `rev-list base..target` 分页接口（模式同 `getLog`）+ 对比视图内第二个列表即可，零重构。
- **开放问题：任意 ref 对比**（tag / hash / `HEAD~3`）：用户已决策本期仅分支下拉（D12）；后端校验已按 ref 规则写，未来放开只需加可输入下拉并保持校验。
- **开放问题：compare 视图的右键菜单**（复制路径 / 添加到聊天，变更视图已有）：本期不接；`GitChangeTreeNode` 的 `contextmenu` emit 已具备，接上即得。

## 8. 测试要点

- **后端单测（vitest，`backend-ts npm test`，`workspace-git.service.spec.ts` 真实 git 夹具风格）**：
  - `compareBranches`：**两分支分叉（清单同时含两侧变更：`M`/`A`/`D` 混合，left-right 计数正确）**、**target 完全落后于 base 时清单列出 base 侧全部变更（不再为空——本次改造核心动机）**、两分支内容一致 / 同一提交 → **合法空列表，不报错**、rename（numstat 花括号紧凑形态与无花括号 `old => new` 双形态还原 insertions/deletions，复用既有 bugcheck 样例）、新增/删除/二进制文件（`-` → binary）、base 或 target 不存在 → `PARAM_INVALID '分支不存在'`、非法分支名（`-x`、`a..b`、`a~b`、`a@{b`、`/a`、`a/`、`a//b`、`.a`、`a.lock`）→ `PARAM_INVALID`（**`-x` 用例只有采用 §5.3 更严正则才成立**，照抄现有 write 侧正则会失败）、空仓库（无提交）→ 报错不抛异常、**无共同祖先 → 可正常对比（清单列出两棵树差异，不抛错）**、路径穿越拒绝（`..`）；
  - `compareBranchFileDiff`：修改 / 新增（before 空）/ 删除（after 空）/ **rename 传 oldPath（before 取 base 侧旧路径，不传则退化成 CREATED 的回归）**、**双方分叉且都改同一文件时内容 = `git diff A B -- <file>`（before 取 base tip 的该文件内容）**、二进制、截断（5000 行 / 512 KiB）、ref 不存在报错；
  - `file.routes` spec：两端点 LOCAL 会话拒绝、缺 base/target 报 `PARAM_MISSING`、非法分支名拒绝、参数透传断言、401 / 越权会话（沿用现有 spec 风格）。
- **Electron 单测（node test，`desktop/electron/gitStatus.test.cjs` 现模式；随 `desktop npm run test:unit` 一并运行）**：`getGitBranchCompare` / `getGitBranchCompareFileDiff` 与后端**同一组 fixture 文本对跑**（分叉/rename/增删/无差异/ref 不存在/无共同祖先可对比/双方同文件/两点方向性）+ electron 侧分支名校验（`-x` 等非法名拒绝）+ **「失败 ≠ 空差异」回归**（diff / rev-list 步骤 exitCode 非零必须报错，不得渲染成「没有差异」）。
- **前端单测（vitest，`desktop npm run test:unit`）**：
  - `utils/git-manager.ts`：`buildGitTree`（单层目录、嵌套目录、**单链目录压缩为 `a/b/c`**、rename 行按新路径建树且 oldPath 不参与路径、空清单返 `[]`）、`collectDirPaths`（折叠态集合清理）、`isValidBranchName` 既有用例回归；
  - `useGitManager`：compare 状态机——两边选满才请求、相同分支不请求、切换选择重算、竞态序号丢弃过期响应、切 provider（切仓库/会话）清空 base/target/result、`refreshLoadedViews` 对已加载对比的重算、**分支行预填（外部写 `compareTarget` + 切 `activeView`）后 `compareBase` 不被改动（原为空保持空）且不自动请求**；
  - `useCenterTabs` 既有用例回归：`openDiffTab` 现有 `git-diff:` / `git-commit-diff:` id 与查重逻辑不变（新 idPrefix 由调用方传入，不改签名——确认无破坏）；**新增 `git-branch-diff:`（`base->target` 形态）与既有前缀并存不覆盖 + `applyWorkspacePathChange` 重定向后前缀与标题不退化成 `file:` / `文件名 (变更)`（§5.6 补充项）**；
  - `GitManagerPanel.test.ts`（改基座后再加用例）：先把 `useGitManager` mock 的 `activeView` 由裸字符串改为 ref、补 compare 字段（`compareBase/Target/Result/Loading/Error/Loaded/loadCompare` 等），并补 `GitCompareView` 的 `vi.mock`（现有 mock 的 element-plus 不含 el-select，新视图走真实组件会连累现有用例）；
  - **P4 前置**：`utils/git-manager.test.ts` 的 `buildGitTree` / `collectDirPaths` 树用例先于搬迁落地（单层目录、嵌套目录、单链目录压缩为 `a/b/c`、rename 行按新路径建树且 oldPath 不参与、空清单返 `[]`），再动 `GitChangeList.vue`；
- **手测清单（随 PR 描述）**：
  - LOCAL Electron git 项目：切到「对比」；两个下拉各选一个分支（本地 × 本地、本地 × 远端、远端 × 远端三种组合）；首次进入对比视图（分支尚未加载完）显示加载态、不闪「没有可用分支」；
  - 汇总条领先/落后计数与终端 `git rev-list --left-right --count A...B` 一致；方向标注 `base → target` 显示；只存在于基准分支的文件带「仅基准分支」标记；
  - **构造「目标分支完全落后」的分支对（本次改造核心场景）：清单列出基准侧全部变更，不再显示空；**
  - 构造双方分叉且都改同一文件的分支对：Diff Tab 内容与终端 `git diff A B -- <file>` 完全一致（before = 左分支内容）；
  - 点文件开中心 Diff Tab：与终端 `git diff A B -- <file>` 内容一致；rename 文件 before 为 base 侧旧路径内容（非「整份新增」）；
  - 文件树：目录展开/折叠；**单链目录压缩成 `a/b/c` 包名样式**（如 `src/components/git/` 只含一个子目录时不层层展开）；rename 行旧路径删除线展示；
  - 分支视图每行「对比」按钮（本地与远端均验证；含当前分支行）：点击跳到对比视图且目标槽已预填该分支；基准槽未被自动改动（首次进入为空；此前已选过基准则保留并立即出结果）；
  - 交换按钮：互换后汇总与清单方向正确；
  - 两侧选同一分支：提示且不请求；只选一侧：提示请选择两个分支；
  - 与工作区 diff / 提交 diff 并存：同会话先开工作区某文件 diff、再开提交 diff、再开分支对比 diff，三个 tab 不互相覆盖（idPrefix 隔离）；
  - 变更视图回归（`buildGitTree` 抽取后）：树形态、单链压缩、折叠态、点文件开 diff 与抽取前一致；
  - 多仓库工作区：切换顶部仓库后对比选择清空、请求打到选中仓库（验证 `statusProviderRef` 绑定）；
  - CLOUD git 项目全链路复跑；LOCAL 会话下 CLOUD 端点拒绝（provider 走 IPC，不出现 500）；
  - 两分支内容完全一致（含「提交历史不同但内容相同」）：显示「两个分支当前内容完全一致」；
  - 构造 unrelated histories 仓库：正常列出两棵树差异（不再报错）；
  - 空仓库 / 未出生分支：错误态 + 重试，不白屏；
  - 切走 Tab 再切回：两个下拉的选择与结果原样恢复；
  - 写操作（切换分支 / fetch）后回到对比视图：结果已重算；
  - 安卓 WebView 窄宽下选择行不溢出（两个下拉 + 交换按钮，必要时 `el-select` 宽度自适应或换行——`GitCompareView` 为全新组件，无现成移动端口径，本次直接按窄宽可用设计）。

## 9. 变更落点清单

**backend-ts（改）**

- `src/file/workspace-git.service.ts`：新增 `compareBranches` / `compareBranchFileDiff`（+ 导出的 `GitBranchCompareDTO`，与 `GitChangedFileDTO` / `GitFileDiffDTO` 同处定义；**两点 diff**：`diff <base> <target>`、before 取 base tip；失败与空差异区分）+ 分支名校验正则（**首字符排除 `-`，严于 write 服务 `BRANCH_NAME_PATTERN` 与前端 `isValidBranchName` 现状**，注释互指，勿照抄现状正则）；`workspace-git.service.spec.ts` 补 §8 用例
- `src/file/file.routes.ts`：注册 2 个 GET 端点（`workspace-git-branch-compare` / `workspace-git-branch-compare-file-diff`，沿用 `requireOwnedCloudGitSession`）；`file.routes.spec.ts` 补拒绝路径与参数透传用例

**desktop/electron（改）**

- `electron/gitStatus.cjs`：新增分支名校验函数（`.cjs` 无法 import TS，按「解析函数双端各一份」先例，规则同 §5.3）+ `getGitBranchCompare` / `getGitBranchCompareFileDiff` 导出（复刻 `getGitCommitFiles` L770 / `getGitCommitFileDiff` L820 结构，`show` → 两点 `diff <base> <target>` / 双 ref show，before 端取 base tip；**diff / rev-list 走 `runGit` 读 `exitCode`，失败 ≠ 空差异**）；`gitStatus.test.cjs` 补与后端同 fixture 对跑用例
- `electron/main.cjs`：注册 2 个 IPC handler（错误契约同 `git-commit-files` / `git-commit-file-diff`）+ **L1081 顶部 `require('./gitStatus.cjs')` 解构列表同步加入两个新函数**
- `electron/preload.cjs`：暴露 2 个方法
- `src/types/electron.d.ts`：补 2 个方法类型声明
- `package.json`：版本不手改；发版时用 `./scripts/changelog-extract.sh sync-desktop` 同步（不接版本参数，版本取 CHANGELOG 首个 `## ` 行；AGENTS.md 规范）

**desktop/src（新）**

- `components/git/GitCompareView.vue`：对比视图（双分支下拉 + 交换 + 汇总条 + 目录分组文件树 + 空/错态；含方向标注 `base → target`、空态「当前内容完全一致」文案、「仅基准分支」标记）

**desktop/src（改）**

- `types/git.ts`：新增 `GitBranchCompareResult`（后端对应 `GitBranchCompareDTO` 定义并导出在 `workspace-git.service.ts`）
- `composables/workspace-git-provider.ts`：`WorkspaceGitProvider` 接口加 2 方法；LOCAL/CLOUD 两个工厂实现；「会话未就绪」stub 补 2 方法（`compareBranches` 同其它读取方法 throw；`compareBranchFileDiff` 返回带 `unavailableReason: '会话未就绪'` 的降级对象，与 stub 分类一致）；对象形态 IPC 错误解包（compare 结果非数组，`unwrapIpcArray` 不适用）
- `composables/useGitManager.ts`：`GitManagerView` 加 `'compare'`；compare 状态机 + `loadCompare`（**内部吞错不抛**）+ `resetAll` / `loadActiveView`（**复用 branchesLoaded/branchesLoading 守卫**）/ `refreshLoadedViews` 扩展；`useGitManager.test.ts` 补用例
- `utils/git-manager.ts`：新增 `buildGitTree` / `collectDirPaths`（自 `GitChangeList.vue` 抽出：仅 `collectDirPaths` L331-338 与 `buildGitTree` L340-436（含内部 `compressChildren` / `finalize`），组件状态胶水留下；逻辑原样不改）+ `git-manager.test.ts`（已存在，追加）树用例——**先落测试再搬迁**
- `components/task/GitChangeList.vue`：删除内部两个树纯函数（L331-436，保留 `treeRoots` / collapsed 清理 watch / `toggleDir` 胶水），改为从 `utils/git-manager.ts` import（**行为零变**，手测含变更视图树回归）
- `components/git/GitBranchesView.vue`：本地/远端每行在现有按钮（本地「切换」、当前分支行禁用态「当前」、远端「跟踪并切换」）后加「对比」按钮，emit `compare(name)`（当前分支行也加）
- `components/git/GitManagerPanel.vue`：`views` 数组加「对比」；分发区在 `GitStashView`（现 `v-else`）**之前**插 compare 分支并把 stash 改为 `v-else-if`（首层 `selectedRepo?.unavailable` 守卫不动）；`GitBranchesView` 接 `@compare` → `handleCompareBranch`（写 `compareTarget` + 切 `activeView`，`compareBase` 不动）；`statusProviderRef` 多仓库包装补 2 方法绑定（**新方法 `repoPath` 在参数第 4 位**）；`handleOpenBranchDiff` 出口 + emits 声明；`GitManagerPanel.test.ts` 先改基座 mock（`activeView` 改 ref、补 compare 字段与 `GitCompareView` mock）再加用例
- `components/center/CenterTabContainer.vue`：`@open-branch-diff` 透传一行（L60 同款）+ emits 声明加一项（L99-100 同款）
- `views/task/TaskView.vue`：`CenterTabContainer` 处接 `@open-branch-diff="handleOpenBranchDiff"`（与 `@open-commit-diff` 并列）；新增 `handleOpenBranchDiff`（复刻 L725-758，标题 `base → target · 文件名 (Git)`、idPrefix `git-branch-diff:<base>-><target>:`）
- `composables/useCenterTabs.ts`：`applyWorkspacePathChange` 前缀链（L482-485）加 `^git-branch-diff:([^:]+)->([^:]+):` 分支 + 并列 title 分支（id 保留前缀、标题重组为 `base → target · 文件名 (Git)`，并同步 `fileChange.path` / `quoteRevision`，不退化成 `file:` / `文件名 (变更)`）；`useCenterTabs.test.ts`（已存在，追加）补前缀并存与重定向回归

**文档**

- 根 `CHANGELOG.md`：发版时记后端小节（两个只读端点）+ 前端小节（Git 面板「对比」视图 + 分支行对比入口）+ 桌面 Electron 小节（新 IPC）；`desktop/package.json` 版本用 `scripts/changelog-extract.sh ... sync-desktop`，勿手改
- `skills/mao-cli/reference/desktop.md`：desktop 手册的 Git 面板「对比」条目同步为两点语义（`base → target` 方向标注、「仅基准分支」标记、空态文案；与分支视图 ahead-behind 的区别）
- README / DEPLOY：无部署与配置变化，不补

## 10. 发版前检查

- `cd backend-ts && npm run build && npm test` 绿（service 两方法 + 路由 spec）
- `cd desktop && npm run test:unit` 绿（vitest：useGitManager compare 用例 + useCenterTabs 回归 + git-manager 树用例；node --test：electron gitStatus 新增用例与后端同 fixture 对跑——electron 测试内嵌在该 script，无需单独跑）
- `cd desktop && npm run build` 通过（vue-tsc 零错误）
- 手测清单（§8）逐条过
- CHANGELOG 三小节齐；mao-cli SKILL.md 同步后再打包发版
