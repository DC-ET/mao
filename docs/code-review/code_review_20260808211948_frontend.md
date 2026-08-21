# 代码审查报告：多 Git 仓库性能优化（前端）

- 审查日期：2026-08-08
- 审查范围：未提交改动中的前端部分
  - `desktop/src/components/task/TaskInspector.vue`（摘要行多仓库去 +N/-Y、切 Git Tab 由 refreshAll 改 refreshGit）
  - `desktop/src/types/git.ts`（GitRepoSummary 移除 insertions/deletions）
  - `desktop/src/types/electron.d.ts`（gitRepos 返回类型同步）
  - `desktop/electron/gitStatus.cjs`（getRepos 每仓库收敛为 1 条 `git status --porcelain=v2`，8 路并发 mapLimit）
  - 后端 `WorkspaceGitService.java` 仅作前端兼容性对照（CLOUD 模式响应结构）
- 历史报告：`docs/code_review_20260808175635_frontend.md`、`docs/code_review_20260808180354_frontend.md`、`docs/code_review_20260808180917_frontend.md`
- 验证手段：`vue-tsc --noEmit` 通过；真实 git 仓库实测 porcelain v2 输出（detached / unborn / 变更计数 / 损坏仓库 exit code）

## 结论摘要

- 需求要求的四项核查**大部分正确**：单仓库模式 +N/-Y 不受影响；changedRepos 过滤、全干净文案、点击跳转主流程正常；GitRepoSummary 引用清理完整；类型检查通过。
- 发现 **1 个中等程度的功能缺陷**（方案 5 数据过期窗口下的「点击已删除仓库跳转错位」）与 **1 个中低程度的行为回归**（`git status` 失败/超时的仓库被静默剔除出列表），另有 1 条低优先级提示。

---

## 一、已验证正确（无回归）

### 1.1 单仓库模式（根是 git）摘要行仍显示 +N/-Y — ✅

- `multiRepoMode = !isRootGit && repos.length > 0`，根是 git 仓库时恒为 false，模板落入 `v-else` 分支（TaskInspector.vue:118-127），仍走 `gitStatus.branch` + `gitStatus.insertions/deletions`（`gitStatus` 来自 getStatus，electron `getGitStatus` 仍经 `collectChangedFiles` 统计行数，未删）。CLOUD 侧后端 status DTO 亦保留 insertions/deletions。
- 结论：本轮改动未触碰单仓库链路，+N/-Y 展示不变。✅

### 1.2 多仓库摘要行主流程 — ✅

- `changedRepos = repos.filter(r => r.changedFileCount > 0)`（useGitRepos.ts:23），模板 `v-if="changedRepos.length > 0"` 展示按钮、`v-else-if="reposLoading"` 展示「检测 Git…」、`v-else` 展示「N 个仓库 · 全部干净」——三级条件与旧版结构一致，仅把 +N/-Y 换成 `{{ repo.changedFileCount }} 变更`（需求 2 预期行为）。
- `handleRepoClick` → `selectRepo` + 切到 git tab → watch 触发 refreshGit，主流程正常。

### 1.3 GitRepoSummary 引用清理 — ✅

- 全仓 grep：`repo.insertions` / `repo.deletions` 残留仅存在于 `GitChangedFile` 层（TaskView.vue:490-491、GitChangeTreeNode.vue:34-35、TaskInspector.vue:122-123 的 `gitStatus.*`），均属 getStatus 文件级行数，正确保留。
- `git.ts` / `electron.d.ts` / `useGitRepos.ts` / `workspace-git-provider.ts`（getRepos 透传）已全部同步，`vue-tsc` 通过。✅

### 1.4 porcelain v2 分支与计数语义 — ✅（实测）

- detached HEAD：porcelain `# branch.head (detached)` → 映射 "HEAD"，与旧 `rev-parse --abbrev-ref HEAD` 输出一致（实测一致）。
- unborn（无提交）仓库：实测现代 git 输出 `# branch.head main`（非文档所述 `(initial)`），分支名正常；而旧代码 `rev-parse` 在 unborn 下直接 fatal 返回 null → 显示 'HEAD'，新实现反而更准确。
- 变更文件数 = 非 `#` 行数：tracked（1/2 开头）+ untracked（`?` 开头）与旧 tracked+untrackedCount 语义等价（`--untracked-files=all` 逐文件列出，与 `ls-files --others` 一致）；rename 由 2 计 1 是向 `git status` 语义对齐的改进，非回归。

---

## 二、发现的问题

### [中] 问题 1：方案 5 数据过期窗口下的「点击已删除仓库跳转错位」（可感知交互缺陷）

- **位置**：TaskInspector.vue:361-367（`watch(inspectorActiveTab)` 改 refreshGit）+ TaskInspector.vue:349-354（`handleRepoClick` / `selectRepo`）
- **背景**：切 Git Tab 只 refreshGit 是需求明确接受的方案 5（仓库列表仅在挂载/手动刷新/阶段结束 refreshAll 时更新）。因此任务运行中 `repos`/`changedRepos` 天然过期——**该窗口本身属预期设计**，新增/删除仓库在下拉与摘要中的展示延迟到阶段结束，此项不视为缺陷。
- **但窗口期内有一个具体缺陷**：任务中途**删除**某仓库后，摘要行仍渲染该仓库按钮（`changedRepos` 来自过期 `repos`）。用户点击该按钮时：
  1. `handleRepoClick(repo.path)` → `selectRepo` 内 `repos.value.some(r => r.path === path)` 为 false，**静默失败，选中项不变**；
  2. 但 `inspectorActiveTab.value = 'git'` 仍执行，tab 切到 Git；
  3. 结果：用户点击「repo-b」，落地 Git Tab 却展示**旧选中仓库 repo-a** 的明细，无任何提示，跳转目标与点击目标不一致。
- 旧行为（refreshAll）下，切 Tab 会重新扫描并移除已删除仓库，不会出现该错位。
- **建议**（仅建议，未改代码）：`handleRepoClick` 内先校验存在性，不存在则不切 tab（或提示仓库已不存在）；或切 Tab 时对 `repos` 做一次轻量校验/刷新。

### [中低] 问题 2：单个仓库 `git status` 失败/超时 → 仓库被静默剔除出列表（行为回归）

- **位置**：`desktop/electron/gitStatus.cjs` `summarizeRepoDir`（`if (result.exitCode !== 0) return null`）+ `listGitRepos` 的 `.filter(Boolean)`；后端 `WorkspaceGitService.summarizeRepo` 同构（CLOUD 模式同样受影响）。
- **表现**：任一子仓库的 `git status --porcelain=v2 --branch -M --untracked-files=all` 非零退出（损坏 index 实测 exit 128、权限错误、`.git` 损坏、或超过 10s `GIT_TIMEOUT_MS` 超时——36 仓库 + 8 路并发下大仓库命中超时的概率不低），该仓库即被 `null` 过滤，**从摘要行、Git Tab 下拉、以及「N 个仓库 · 全部干净」计数中整体消失，且无任何错误提示**。
- **旧行为**：`runGitOk` 单命令失败仅返回 null，仓库仍以 `{branch: undefined, insertions: 0, deletions: 0, changedFileCount: 0}` 保留在列表中（可见、可选，虽然计数为 0 也有误导，但至少可发现）。
- **建议**：将「命令失败」与「非仓库」区分对待——失败时保留仓库占位并在摘要/下拉附错误标记（如沿用 `reposError` 通道），或至少在日志中告警，避免静默丢失仓库导致「全部干净」文案与下拉选项错误。

### [低] 问题 3：点击摘要行仓库存在双重重刷（非新增回归，可顺手优化）

- **位置**：TaskInspector.vue:349-354 + 361-367 + useGitStatus.ts:59-68
- **表现**：`handleRepoClick` 触发两条刷新路径：`selectRepo` 改变 `selectedRepoPath` → `statusProviderRef` 变化 → useGitStatus 内部 watch 发起 refresh；随后 tab 切到 git → `watch(inspectorActiveTab)` 再次 `refreshGit()`。同一选中仓库被并发请求两次（`requestSeq` 保证最后一次生效，无正确性影响，但多消耗一次 git 进程调用——恰是本次性能优化想省的开销）。旧代码（refreshAll + provider watch）同样双重刷新，非本轮引入，可后续在 `handleRepoClick` 中只保留一次刷新。

---

## 三、其他说明（非缺陷）

- 多仓库模式下 `reposError` 不上屏（上一轮报告 P1）在本轮未改动，仍为已知残留；摘要行在刷新失败保留旧数据时无失败提示，属「保留上次成功数据」设计的既有代价，非本轮引入。
- `gitStatus` 摘要行（单仓库）与多仓库分支的渲染条件（`gitSummaryVisible`）无遗漏：多仓库恒显示、单仓库按 isGit/loading/error 三分支，均与改动前一致。

## 四、结论

- 核心性能改造（getRepos 收敛为每仓库 1 条命令 + 8 路并发 + GitRepoSummary 去行数）与类型清理**正确**，单仓库 +N/-Y 与多仓库摘要主流程无回归。
- 建议修复：**问题 1**（点击已删除仓库的跳转错位）与 **问题 2**（失败仓库静默消失）；问题 3 可择机优化。修复后需用户自行重启后端生效（Agent 不代为重启）。
