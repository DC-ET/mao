# 代码审查报告（第二轮）：多 Git 仓库性能优化修复核查（前端）

- 审查日期：2026-08-08
- 上轮报告：`docs/code_review_20260808211948_frontend.md`
- 本轮范围：核查问题 1（selectRepo 返回 boolean）、问题 2（unavailable 占位 + 展示）修复的正确性与新引入问题
- 涉及文件：`desktop/src/composables/useGitRepos.ts`、`desktop/src/components/task/TaskInspector.vue`、`desktop/src/types/git.ts`、`desktop/src/types/electron.d.ts`、`desktop/electron/gitStatus.cjs`、后端 `WorkspaceGitService.java`（对照）
- 验证手段：`vue-tsc --noEmit` 通过、`mvn -q compile` 通过；node 实测 Electron `listGitRepos`/`getGitStatus`（损坏 index 仓库、unborn 空仓库）

## 结论摘要

- 两项修复**方向正确、主逻辑正确**：selectRepo 返回值改造未破坏任何调用方；unavailableRepos 展示覆盖全部组合；单仓库模式 +N/-Y 不受影响；类型检查与后端编译通过。
- 但「点开后 getStatus 显示具体错误」**未真正闭环**（实测确认）：unavailable 仓库点开后 getStatus 静默吞错，Git Tab 显示误导性的「没有待提交的变更」。另有 1 个后端进程管理健壮性隐患（git 挂起时线程泄漏）与 1 个类型契约小瑕疵。

---

## 一、修复核查

### 修复 1：selectRepo 返回 boolean — ✅ 正确完整

`useGitRepos.ts:72-78`：仓库存在才选中并返回 true，否则返回 false。

| 调用方 | 行为 | 核查 |
|---|---|---|
| `handleRepoClick`（摘要行点击，TaskInspector.vue:352-354） | `if (selectRepo(path))` 才切 Git Tab | ✅ 修复了上轮问题 1：已删除仓库点击不再「tab 已切但展示旧仓库」 |
| `handleRepoSelect`（下拉切换，TaskInspector.vue:348） | 忽略返回值 | ✅ 无破坏：下拉选项来自 `repos`，选中值必然存在，恒返回 true |
| 其他调用方 | — | ✅ 全仓 grep 仅以上两处 |

边缘场景：下拉打开期间 refreshAll 使仓库被删，用户选中已删除项 → `selectRepo` false → `selectedRepoPath` 不变 → `el-select` 受控 model-value 自动回弹旧值，UI 自愈。✓

### 修复 2：unavailable 占位 + 展示逻辑 — ✅ 主逻辑正确（含 1 处未闭环，见发现 1）

**展示组合全覆盖核查**（TaskInspector.vue:113-118，v-else-if 顺序 loading 优先）：

| changedRepos | unavailableRepos | reposLoading | 显示 |
|---|---|---|---|
| >0 | 0 | 任意 | 变更按钮列表 |
| >0 | >0 | 任意 | 按钮列表 + 「M 个仓库状态不可用」提示行 |
| 0 | >0 | true | 「检测 Git…」（loading 优先） |
| 0 | >0 | false | 「N 个仓库 · M 个不可用」 |
| 0 | 0 | false | 「N 个仓库 · 全部干净」（unavailable==0 才显示，语义正确） |

- `changedRepos = filter(r => r.changedFileCount > 0)`：unavailable 条目无 changedFileCount（undefined > 0 = false）→ 不会混入变更列表 ✅
- 「N 个仓库 · M 个不可用」中 N=repos.length（含不可用）✅；「全部干净」仅在不可用为 0 时出现 ✅
- 全仓库不可用时 `defaultRepoPath` 回退 `list[0]`（unavailable 条目）→ 仍可选中、Git Tab 正常渲染（显示内容见发现 1）✅
- 单仓库模式（根是 git）：`multiRepoMode=false` 走 v-else 分支，+N/-Y 不变，unavailable 仅作用于多仓库分支 ✅

### 顺带修复：unborn 空仓库兼容（本轮新增，非上轮报告内容）— ✅ 正确

- `collectChangedFiles`：`diff HEAD` 失败 + `rev-parse --verify HEAD` 失败 → 回退 `diff --cached` 统计 staged（与 getRepos porcelain 计入 staged 口径一致）
- `getGitStatus`：`rev-parse --abbrev-ref HEAD` 失败 → 回退 `symbolic-ref --short HEAD`
- **实测**：unborn 仓库 listGitRepos 返回 `branch: master, changedFileCount: 0`，getGitStatus 返回 `branch: master`，两端口径一致 ✅；且修复了旧代码 `rev-parse` fatal 后分支显示 'HEAD' 的问题（改进非回归）

---

## 二、发现的问题

### [中低] 发现 1：unavailable 仓库点开后 getStatus 不显示具体错误，显示误导性「没有待提交的变更」（需求未闭环）

- **实测**（node 调 Electron `gitStatus.cjs`，损坏 index 仓库）：
  - `listGitRepos` → `{ name: 'repo', path: 'repo', unavailable: true }` ✅ 占位生效
  - `getGitStatus` → `{ isGit: true, branch: 'master', insertions: 0, deletions: 0, changedFileCount: 0, files: [] }` —— **无 error 字段**，diff/numstat/ls-files 失败均被 `runGitOk` 吞掉（返回 null 不区分原因）
- **前端表现**：`useGitStatus` 中 `result.error` 为 undefined → error=''，files=[] → GitChangeList 显示「没有待提交的变更」——用户看到「仓库正常且干净」的**假象**，而非需求宣称的「具体错误」。后端 `WorkspaceGitService.getStatus` 同构（`runGitOk` 吞错），CLOUD 模式同样命中。
- **触发场景**：unavailable 根因为「index/对象损坏」类时必然触发；根因为 timeout 时 getStatus 走另一条命令链（diff/ls-files），可能正常返回真实变更，不触发。
- **建议**：`collectChangedFiles` / `getGitStatus` 在任一 git 子命令失败时携带 `error` 字段（如首条失败命令的 stderr），前端 `normalizeStatus` 已透传 `data.error`，GitChangeList 已有 error 分支，仅需后端/Electron 补错误信息。

### [中低] 发现 2：后端 summarizeRepo 的 waitFor 超时保护无法覆盖 readLine 阻塞（git 挂起 → 线程泄漏 → 多仓库 UI 可能整体消失）

- **位置**：`WorkspaceGitService.summarizeRepo`（Java 侧）。执行顺序为：`readLine` 循环（try-with-resources，读到 stdout EOF）→ `waitFor(10s)` → 读 stderr。
- **问题**：若 git 进程**挂起且不关闭 stdout**（NFS 卡死、进程被 SIGSTOP、极端锁等待——36 仓库 + 8 并发场景概率放大），`readLine` 永久阻塞在 `getInputStream().readLine()`，**永远执行不到 waitFor**，10s 超时保护形同虚设。外层 `future.get(15s)` 超时后 `cancel(true)` 无效（InputStream read 不响应线程中断）→ 该任务线程被**永久占用**。固定 8 线程池连续被占满后，后续 getRepos 请求全部在 `future.get` 15s 超时 → `summary=null` → repos 为空 → 前端 `multiRepoMode=false` → **多仓库 UI 整体消失**。
- **对照**：Electron 侧 `summarizeRepoDir` 用 spawn + SIGKILL timer + 'close' 事件，kill 后 close 必然触发、readline 不阻塞 resolve——**无此问题**，两端实现不对称。
- **建议**：将 `waitFor` 移到 readLine 之前（先 waitFor 确认进程结束，再读 stdout/stderr），或对 stdout 读取本身套超时（如 `CompletableFuture` + `orTimeout`），与 Electron 行为对齐。

### [低] 发现 3：unavailable 占位条目缺 `changedFileCount` 字段，与 TS 必填类型不符

- **实测**：`{ name, path, unavailable: true }` 无 `changedFileCount`；而 `git.ts` 与 `electron.d.ts` 均声明 `changedFileCount: number` 必填。
- **运行时无害**：`undefined > 0 = false` 恰好符合「不可用不计入变更」语义（changedRepos / defaultRepoPath 均正确）。
- **建议**：二选一——unavailable 占位补 `changedFileCount: 0`（Electron `summarizeRepoDir` 与 Java `unavailableRepo` 两处），或将类型改为 `changedFileCount?: number`（git.ts + electron.d.ts 同步），避免未来直接算术消费该字段的代码踩 undefined。

### [低] 发现 4：后端 stderr 未边读边排空（并入发现 2 提示）

- Java `summarizeRepo` 在进程结束后才 `readAllBytes()` stderr；若 git 向 stderr 写入超过管道缓冲（64KB），git 会阻塞写 stderr → waitFor 超时 → 误判 unavailable。git status 正常 stderr 极小，实际触发概率低；Electron 已用 `child.stderr.resume()` 规避，建议 Java 侧同样改为边读边排空（或 `redirectErrorStream(true)` + 过滤 `#` 前缀行时区分注释与警告）。另：waitFor 超时路径 `destroyForcibly()` 后未 waitFor 确认回收，存在极低 fd 泄漏风险。

---

## 三、结论

- 修复 1（selectRepo 返回值）：**正确完整**，无调用方破坏。
- 修复 2（unavailable 占位与展示）：**主逻辑正确**，六种展示组合全覆盖、单仓库模式无回归、类型检查与后端编译通过；但「点开显示具体错误」**未闭环**（发现 1，建议补齐 error 传播）。
- 新引入风险：后端进程管理健壮性（发现 2/4，git 挂起极端场景）与类型契约小瑕疵（发现 3），均不影响常规路径正确性，可择机修复。
