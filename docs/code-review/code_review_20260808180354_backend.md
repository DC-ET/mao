# 代码审查报告（第二轮增量）：多 Git 仓库工作区支持

- 审查日期：2026-08-08
- 上一轮报告：docs/code_review_20260808175635_backend.md（H1/H2 已按该报告修复）
- 审查范围：`WorkspaceGitService.java`、`gitStatus.cjs`、`main.cjs`、`preload.cjs` 的本次改动 + 上轮修复核查
- 方法：代码比对 + 对 `path.relative` 方案做了多边界实测验证

## 结论

**H1、H2 两项修复正确且完整，未引入新的路径校验漏洞或回归。** 但发现 1 个中优先级问题（H1 修复遗漏了文件路径维度）和 3 个低优先级问题。另有对未修复项 M1 的异议说明。

---

## 一、修复核查（全部通过）

### 1. H1 修复：`..` 精确匹配 ✓
- 后端 `resolveRepoDir`（L114-115）：`normalized.isEmpty() || normalized.contains("/") || Arrays.stream(normalized.split("/")).anyMatch(".."::equals)`。
  - 正确性：因 `contains("/")` 短路先行，`split("/")` 只对单段路径执行，`anyMatch(".."::equals)` 等价于 `normalized.equals("..")`，不误杀 `my..repo`、`v1..2`。
  - 实测：`my..repo`、`...` 均通过，`..`、`a/b`、`../x` 均拒绝 ✓。
- Electron `resolveRepoDir`（L200）：`!normalized || normalized.includes('/') || normalized.split('/').includes('..')`，逻辑等价 ✓。
- 死代码 `contains("\\")`/`includes('\\')` 前后端均已删除 ✓（grep 确认无残留）。

### 2. H2 修复：`path.relative` 方案 ✓
- Electron `resolveRepoDir`（L205-208）：`rel = path.relative(ws, repoDir)`，`path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)` 时拒绝。
- 实测验证：
  - 根目录工作区 `'/'` + `repo` → rel=`repo` → 通过（H2 根因已修复）✓
  - 越界 `..` → rel=`..` → 拒绝 ✓；兄弟/深层越界 → rel=`../x` 或 `../../x` → 拒绝 ✓
  - 前缀陷阱 `/a/b` vs `/a/bc` → rel=`../bc` → 拒绝 ✓
  - 由于 `repoDir` 由 `path.resolve(ws, 单段名)` 生成，必然位于 ws 下，该检查在正常输入下永不误拒，属正确的纵深防御 ✓
- **Windows 说明**：Electron 在 Windows 上运行时 `path` 为 win32 实现，`\` 是分隔符、`path.sep='\\'`，`rel.startsWith('..' + path.sep)` 即 `'..\\'` 前缀判断正确；且 `repoDir` 继承 ws 的盘符大小写，`path.relative` 无跨盘/大小写误判。M4 顺带覆盖 ✓。
- 后端 `Path.startsWith` 为组件级比较，本就无此问题，未改动 ✓。

### 3. 无新增漏洞/回归
- repoPath 校验仍保留多级拒绝（`/` 检查）+ 后端 `PathSandbox` 双重校验；`getFileDiff` 的 `startsWith(repoRoot)` 兜底未改动 ✓。
- 缺省行为（repoPath 为空 → 返回 workspace）与上轮确认的一致，无回归 ✓。

---

## 二、新发现问题

### N1（中优先级）：H1 修复遗漏 relativePath 维度——合法文件路径仍被 `..` 子串误杀
- **位置**：后端 `getFileDiff` L167 `normalized.contains("..")`；Electron `getGitFileDiff` L327 `relativePath.includes('..')`
- **问题**：上轮 H1 只修复了 `resolveRepoDir`（repoPath 维度），但 `getFileDiff` 对**文件相对路径**的 `..` 检查仍是子串匹配。合法的多级文件路径如 `src/a..b.ts`、`docs/..notes.md` 会被拒绝（后端 403「路径访问被拒绝」/ Electron「路径无效」），diff 无法预览。该行是存量代码，但与本轮 H1 同模式，修复时顺带遗漏。
- **说明**：此检查属「保守误杀」而非安全漏洞——子串匹配只会多拒不会放行，且后续 `startsWith(repoRoot)` 兜底仍在，安全无虞；仅影响含 `..` 的合法文件名的 diff 功能。
- **建议**：与 H1 一致改为按段精确匹配：`normalized.split("/").includes("..")`（注意与 `..` 隐藏文件如 `..gitignore` 的差异——`..gitignore` 是合法文件，不应拒绝），保留后续 startsWith 兜底。

### N2（低优先级）：`repoPath="."`（及 `./`）绕过「仅一级子目录名」约束
- **位置**：后端 `resolveRepoDir` L112-117；Electron `resolveRepoDir` L199-202
- **问题**：`.` 不含 `/`、无 `..` 段，通过校验后 `resolve('.')` 返回 workspace 本身（Electron 实测 rel=`''` 通过）。行为等价于 repoPath 缺省，**不产生任何新能力或越权**（`rev-parse` 在 workspace 上执行，与缺省完全一致），仅语义上不符合需求「仅允许一级子目录名」。
- **建议**：校验中显式拒绝 `normalized.equals(".")`（可顺带拒绝空段重复如 `//` 已在 trim 后处理），使契约严格化。非必须。

### N3（低优先级）：repoPath 含 NUL/非法字符时后端返回 500 而非 403
- **位置**：后端 `resolveRepoDir` L118 `workspace.resolve(normalized).normalize()`
- **问题**：Java NIO 对含 `\u0000` 的路径抛 `InvalidPathException`（RuntimeException），`resolveRepoDir` 仅 catch `SecurityException`（L124），异常向上抛 → 全局异常处理器返回 500。恶意/畸形输入仅导致状态码不优雅，**无数据泄露或越权**。Electron 端 `fs.statSync` 抛错被 `getGitStatus`/`getGitFileDiff` 的 try-catch 捕获，返回正常错误对象，无此问题。
- **建议**：`resolveRepoDir` 中补充 catch `InvalidPathException`（或提前过滤控制字符），统一返回 FORBIDDEN。

### N4（轻微）：仓库排序两端不一致
- **位置**：后端 `listRepos` L70 `Comparator.comparing(GitRepoSummaryDTO::getName)`（Unicode 码点序）；Electron `listGitRepos` L245 `localeCompare`（系统 locale 序）
- **问题**：含中文/特殊字符的目录名在 CLOUD 与 LOCAL 模式下排序可能不同，仅影响展示顺序，无功能影响。
- **建议**：如追求两端一致，Electron 改用码点比较（`a < b ? -1 : a > b ? 1 : 0`）。

---

## 三、对「本轮未修复项」的异议说明

### M1（untracked 全量读取）——建议排期修复
上轮归类为「存量逻辑」，但**本次需求实际放大了该风险**：新增的 `summarizeRepo`（后端）/ `listGitRepos`（Electron）会对**每一个**子仓库执行 `collectChangedFiles`，其中 untracked 分支对每个未跟踪文件 `Files.readAllBytes`/`readFileSync` 全量读入。若某子仓库含大体积 untracked 文件（日志、构建产物、模型权重），且工作区含多个子仓库并发统计，内存与耗时会被显著放大，「轻量统计」名不副实。建议至少给 untracked 读取加字节上限（如 >512KB 跳过行数统计，仅计文件数），改动小、收益明确。

### M2（并发无上限）——可接受，建议后续限流
仓库数较多时 Electron 一次性并发 4N 个 git 子进程、后端 `parallelStream` 占用公共 ForkJoinPool，确有资源风险，但触发条件（数十个仓库）在当前使用场景少见。同意暂不修复，建议后续用固定大小线程池/限流器。

### M3（symlink 行为不一致）——同意不修复
CLOUD（`Files::isDirectory` 跟随）与 LOCAL（`Dirent.isDirectory()` 不跟随）对符号链接目录的发现行为不同，仅影响 symlink 仓库，可接受。若产品对两端一致性有要求再统一。

### L2/L3/L4——同意按存量/低影响处理，无异议。

---

## 四、复核通过项

- `getStatus`/`getFileDiff` 的 repoPath 参数化链路（controller → service → git 执行目录）正确，缺省行为与改动前一致。
- Electron IPC（main.cjs `git-repos`/`git-status`/`git-file-diff`）与 preload 暴露、前端 provider 调用参数顺序一致。
- 修复未触碰 `collectChangedFiles`、diff 截断、超时等存量逻辑，无连带回归。
- 后端编译语法正确（`Arrays.stream` 全限定名，无需新增 import）。
