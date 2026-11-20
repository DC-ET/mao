# 代码审查报告：多 Git 仓库工作区支持（后端 + Electron 壳）

- 审查日期：2026-08-08
- 审查范围：`WorkspaceGitService.java`、`FileController.java`、`gitStatus.cjs`、`main.cjs`、`preload.cjs`（本次需求新增/改动部分）
- 审查重点：路径越界/安全校验、repoPath 缺省回归风险、并发统计异常处理、.git 目录/文件兼容、Windows/Linux 路径分隔符

## 结论

核心链路（发现接口 + repoPath 参数化）整体设计正确，**未发现会导致主流程失效的严重 bug**，但存在 2 个高优先级（业务正确性边界）、4 个中优先级（健壮性/一致性/性能）问题，建议修复后合入。

---

## 一、回归确认（本次改动无回归项）

1. **repoPath 缺省行为与改动前一致**：
   - 后端 `resolveRepoDir(workspace, null/blank)` 直接返回 workspace，`getStatus`/`getFileDiff` 中 `runGitOk(repoDir, ...)` 等价于改动前的 `runGitOk(workspace, ...)`；`getFileDiff` 的 `pathSandbox.resolve(absolute, sessionWorkspace)` 校验为存量逻辑，未改动。
   - Electron `resolveRepoDir` 缺省返回 `path.resolve(workspace)`，等价于改动前的 `const cwd = path.resolve(workspace)`。
2. **preload 签名变更已全链路同步**：`gitFileDiff` 由 `(workspace, filePath)` 改为 `(workspace, repoPath, filePath)` 属破坏性变更，但 `workspace-git-provider.ts`、`electron.d.ts` 均已同步更新，无遗漏调用方。
3. **权限校验**：三个接口（repos/status/diff）均走 `requireOwnedSession`，无越权访问。
4. **.git 目录与 .git 文件兼容**：后端 `Files.exists(dir.resolve(".git"))`、Electron `fs.existsSync(path.join(ws, name, '.git'))` 对两种形态均成立，符合需求。
5. **路径分隔符处理**：前后端均先 `\`→`/` 再校验 `/` 与 `..`，Windows 反斜杠注入路径（如 `..\x`、`C:\abs`）均能被拦截；绝对路径（`/` 开头）经 `resolve` 后由 `startsWith` 前缀检查兜底拦截。
6. **并发统计异常处理**：`summarizeRepo`（后端）/ `listGitRepos` 内联 catch（Electron）均捕获异常返回 null 并过滤，单个仓库统计失败不会拖垮整个发现接口。

---

## 二、高优先级问题（影响业务正确性边界）

### H1. `..` 子串匹配误杀合法目录名/文件名
- **位置**：`WorkspaceGitService.resolveRepoDir` L113-114（`normalized.contains("..")`）；`gitStatus.cjs` `resolveRepoDir` L200、`getGitFileDiff` L325（`includes('..')`）
- **问题**：`contains("..")` 会把目录名中任意包含 `..` 的合法名称全部拒绝，例如 `my..repo`、`v1..2`、`..hidden` 这类合法 git 仓库无法通过 repoPath 访问；同理相对路径中的合法文件名（如 `a..b.txt`）会被拒绝。本次需求是"多仓库"，一级子目录名完全由用户/运维掌控，此类目录名实际可能出现。
- **建议**：改为按路径段精确匹配：`normalized.split('/')` 后仅当**任一段 === ".."** 时才拒绝；repoPath 场景可直接只拒绝 `normalized.equals("..")`。

### H2. 根目录作为工作区时，Electron 端所有 repoPath 被拒
- **位置**：`gitStatus.cjs` `resolveRepoDir` L204：`repoDir.startsWith(ws + path.sep)`
- **问题**：POSIX 下若 workspace 为 `/`，则 `ws + path.sep = '/' + '/' = '//'`，`path.resolve('/', 'repo') = '/repo'`，`'/repo'.startsWith('//')` 为 false，所有合法 repoPath 均抛"路径访问被拒绝"。后端使用 `Path.startsWith`（组件级比较）无此问题，两侧行为不一致。
- **建议**：用 `path.relative(ws, repoDir)` 判断结果是否为空或以 `..` 开头；或先 `path.resolve(ws + path.sep)` 归一化再做前缀比较。

---

## 三、中优先级问题（健壮性 / 一致性 / 性能）

### M1. untracked 文件全量读入内存，无大小上限，多仓库并发放大
- **位置**：`WorkspaceGitService.readTextLimited` L364（`Files.readAllBytes`）；`gitStatus.cjs` L73（`fs.readFileSync`），调用点均在 `collectChangedFiles` 的 untracked 分支
- **问题**：`MAX_STDOUT_BYTES`/`MAX_DIFF_BYTES` 只限制 git 输出与返回内容，但 untracked 文件读取时是全量 `readAllBytes`。存量单仓库逻辑已存在此问题；本次 `listRepos`/`listGitRepos` 会对**每个**子仓库执行 `collectChangedFiles`，工作区含大体积 untracked 文件（日志、安装包等）时，并发统计会显著抬高内存与耗时，"轻量统计"不再轻量。
- **建议**：读取前用 `Files.size()` / `fs.statSync().size` 设上限（如 >512KB 直接按不计行数处理），或改为流式/截断读取。

### M2. 并发统计无上限
- **位置**：`gitStatus.cjs` `listGitRepos` L247（`Promise.all`）；`WorkspaceGitService.listRepos` L69（`parallelStream`）
- **问题**：每个仓库需执行 4 个 git 子进程（`rev-parse` + `diff --name-status` + `diff --numstat` + `ls-files`）。Electron 端对 N 个仓库一次性并发 4N 个进程，仓库数较多（如 50+）时可能资源耗尽或集体 10s 超时；后端 `parallelStream` 占用公共 ForkJoinPool，可能影响其他并行流。
- **建议**：并发限流（Electron 用 p-limit / 自写批次，后端用固定大小线程池，如 4-8），保证大量仓库时行为稳定。

### M3. 符号链接目录发现行为前后端不一致
- **位置**：后端 `listRepos` L61（`Files::isDirectory` 默认**跟随**符号链接）；Electron `listGitRepos` L231（`Dirent.isDirectory()` **不跟随**符号链接）
- **问题**：同一工作区，CLOUD 模式能发现符号链接指向的 git 仓库，LOCAL（Electron）发现不了，两端 sidebar 展示不一致。
- **建议**：统一语义（Electron 侧改用 `fs.statSync` 判断，或两侧均明确不跟随）。

### M4. Electron 路径前缀比较大小写敏感（Windows）
- **位置**：`gitStatus.cjs` `resolveRepoDir` L204
- **问题**：`repoDir.startsWith(ws + path.sep)` 为字符串大小写敏感比较，Windows 下盘符/目录大小写不一致（如 `c:\work` vs `C:\Work`）时可能误拒合法路径。实际由 `path.resolve` 保持传入大小写，触发概率低，但属于隐性隐患。
- **建议**：Windows 平台比较前统一 `toLowerCase()`，或改用 `path.relative` 判定。

---

## 四、低优先级问题

### L1. 死代码（易误导）
- 后端 L114 `normalized.contains("\\")`、Electron L200 `includes('\\')`：`\`→`/` 替换已先行完成，此条件恒为 false，属冗余。建议删除，避免后人误以为存在反斜杠防护而放松检查。

### L2. git 子进程超时后的回收不完整
- **位置**：`WorkspaceGitService.runGit` L466 `process.destroyForcibly()`
- **问题**：destroyForcibly 后未 `waitFor` 确认进程退出；`ProcessBuilder` 默认 stdin 为 PIPE 且父进程从不写入/关闭。极端情况下（大量并发 + 超时）可能残留僵尸进程。Electron 端 `execFile` 带 `timeout` 由 Node 处理，无此问题。
- **建议**：destroyForcibly 后补一次带短超时的 `waitFor`；并显式 `pb.redirectInput(ProcessBuilder.Redirect.INHERIT)` 或启动后关闭 stdin。

### L3. .git 文件指向工作区外仓库的边界行为
- **位置**：`getStatus` L140 / `getFileDiff` L176
- **问题**：当一级子目录的 `.git` 为 worktree/submodule 文件且指向工作区外仓库时：`getStatus` 会把工作区外仓库的绝对路径作为 `repoRoot` 返回给前端（只读字符串，泄露面低）；`getFileDiff` 会被 `pathSandbox.resolve(absolute, sessionWorkspace)` 拒绝返回 403（安全正确，但该仓库 diff 不可用）。属设计取舍，建议确认是否符合预期。

### L4. 存量问题（非本次引入，顺带记录）
- numstat 对含空格路径带引号（`"a b.txt"`），rename 时 `old => new` 截取结果含引号，`files.get(normalized)` 可能不匹配导致 diff 展示异常；
- detached HEAD 时 branch 显示字面量 `HEAD`；
- 无提交的空仓库统计为 0 变更、branch 为 null（前端已做兜底）。

---

## 五、未发现问题项（复核通过）

- `isRootGit` 判定：工作区本身是 git 仓库（含位于仓库子目录）→ `rev-parse --show-toplevel` 非空 → 返回 `isRootGit=true` 且 repos 为空，与需求一致。
- 仓库发现仅限一级子目录、按目录名排序（前后端一致），`name`/`path` 字段一致可供前端回传。
- `resolveRepoDir` 拒绝绝对路径、多级路径、`..`，且后端额外过 `PathSandbox`，Electron 端前缀检查正确（除 H2 根目录边界）。
- `getFileDiff` 相对路径的 `startsWith(repoRoot)` + `PathSandbox` 双重校验完备；Electron 端 `startsWith(repoRoot + path.sep)` 正确。
- 超时（10s）、stdout 上限（2MB）、diff 行数/字节截断逻辑前后端一致。
