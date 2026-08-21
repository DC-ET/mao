# 代码审查报告（第三轮增量）：多 Git 仓库工作区支持

- 审查日期：2026-08-08
- 历史报告：docs/code_review_20260808175635_backend.md、docs/code_review_20260808180354_backend.md
- 审查范围：N1/N2/N3/M1 四项修复核查 + 轻量统计口径核对 + 新问题排查
- 方法：代码比对 + 边界实测（node 模拟 path 行为）

## 结论

**本轮四项修复（N1/N2/N3/M1）全部正确、完整，未引入新的路径校验漏洞或回归。** 轻量统计口径与存量 `collectChangedFiles` 核对一致（除用户明示的 untracked 行数口径变更）。新发现 2 个低优先级问题，无中/高优先级问题。

---

## 一、修复核查（全部通过）

### 1. N1（relativePath `..` 按段匹配）✓
- 后端 `getFileDiff`：`Arrays.stream(normalized.split("/")).anyMatch(".."::equals)`，normalized 已去 `./` 前缀。
- Electron `getGitFileDiff`：`relativePath.replace(/\\/g, '/').split('/').includes('..')`（在去 `./` 前检查，与后端等价——`./` 不影响 `..` 段检测）。
- 实测：`src/a..b.ts`、`..hidden`、`a/.../x`、`././x` 放行（合法）；`a/../b`、`../x`、`./a/../b` 拒绝 ✓。
- **安全无弱化**：按段匹配只会比子串匹配更严格地匹配真实 `..` 段；即使段匹配有遗漏，`startsWith(repoRoot)` + 后端 `PathSandbox` 兜底仍在，无越界可能 ✓。

### 2. N2（repoPath="." 显式拒绝）✓
- 后端 `".".equals(normalized)`、Electron `normalized === '.'`。
- 实测：`"."`、`"./"`（尾斜杠归一化后变 `"."`）均拒绝 ✓；`"..."`、`"my..repo"`、`".. "`（尾随空格）放行但会被后续 `isDirectory`/`existsSync` 检查拦截（目录不存在 → 403）✓。
- 前端调用方（`selectedRepoPath` 来自 repos[].path 目录名）不会传 `.`，无回归 ✓。

### 3. N3（repoPath 含 NUL → 403）✓
- 后端 `resolveRepoDir` 中 `workspace.resolve(normalized).normalize()` 包 try-catch RuntimeException → 统一 FORBIDDEN。catch 范围合理（resolve 阶段的 RuntimeException 实际只有 InvalidPathException；normalized/workspace 均已判非空，无 NPE 误吞风险）。
- Electron 端 NUL repoPath：`fs.existsSync` 抛 TypeError，但 `resolveRepoDir` 调用点均在 `getGitStatus`/`getGitFileDiff` 的 try-catch 内，返回正常错误对象，无崩溃 ✓。

### 4. M1（轻量统计）✓ —— 口径核对
与存量 `collectChangedFiles` 逐项对比：

| 口径项 | 存量 collectChangedFiles | 轻量 summarizeRepo | 一致性 |
|--------|------------------------|-------------------|--------|
| changedFileCount | tracked entries + untracked entries（不重复） | `tracked.size() + untrackedCount` | ✓ 无重复计数（`git diff --name-status` 不含 untracked，staged 新文件在 name-status 中且不再出现在 `ls-files --others`，两集合无交集） |
| rename | name-status R 行 key=newPath；numstat 取 ` => ` 后匹配 newPath | 同左 | ✓ 一致（含空格路径带引号不匹配为存量已知问题，两端同有） |
| binary numstat `-` | 置 binary、insertions/deletions=0 | 跳过累加（贡献 0） | ✓ 数值一致 |
| untracked insertions | 读文件内容统计行数 | 不读内容、不计行数 | ⚠️ 用户明示的设计变更（见下方 B 提示） |
| untracked 计数 | 每行一个文件路径 | 输出非空行数（后端 `lines().filter(!isBlank)` / Electron `split('\n').filter(trim)`） | ✓ 一致（`\r\n`、尾换行均正确处理） |
| binary tracked 文件计数 | 计入 changedFileCount | 计入 tracked.size() | ✓ 一致 |

- **性能目标达成**：untracked 不再 `readAllBytes`/`readFileSync`，多仓库并发不再放大内存 ✓。
- 前后端轻量算法结构完全一致（仅排序差异 N4 未修，影响仅展示顺序）。
- `getStatus`/`getFileDiff`（L193/L235）确认仍走存量 `collectChangedFiles`，与用户说明一致，无回归 ✓。

---

## 二、新发现问题（均低优先级）

### A（低）：getFileDiff 的 relativePath 含 NUL 后端仍 500（N3 只覆盖 repoPath 维度）
- **位置**：后端 `getFileDiff` L222 `repoRoot.resolve(normalized).normalize()` 无 try-catch
- **问题**：N3 修复只包住了 `resolveRepoDir`（repoPath 维度）；`getFileDiff` 中 relativePath 经校验后直接 `repoRoot.resolve(normalized)`，若 relativePath 含 `\u0000` 会抛 InvalidPathException → 500。Electron 端无此问题（`fs.existsSync` 异常被上层 catch 返回错误对象）。
- **缓解因素**：relativePath 由前端从 git 输出文件列表传入（非直接用户输入），且 Tomcat 对含 `%00` 的 URL 默认 400 拒绝，实际极难触发。属存量问题（改动前已存在）。
- **建议**：`repoRoot.resolve(normalized)` 同样包 try-catch RuntimeException → FORBIDDEN，与 resolveRepoDir 对齐（一行改动）。

### B（低/建议）：sidebar 轻量口径 vs Git Tab 存量口径的 insertions/deletions 不一致
- **现象**：同一仓库、同一时刻，当存在 untracked 文件时——sidebar（轻量，untracked 不计行数）与 Git Tab 明细（`getStatus` 存量，untracked 计行数）显示的 `+N/-N` 数值不同。
- **性质**：用户已明示这是设计口径（「insertions/deletions 仅计 tracked」），不算 bug，但前端若在同一界面同时展示两处数字可能造成困惑。
- **建议**：确认前端展示上下文是否会造成误解；如追求一致，可让 `getStatus` 也采用轻量口径，或在 UI 上区分「已跟踪变更」与「含未跟踪」的说明。

---

## 三、无回归确认

- N1/N2/N3 均为校验收紧或等价改写，实测未放行任何越界路径；`startsWith`/`PathSandbox` 兜底层未改动。
- M1 只影响 `listRepos` 摘要输出，`getStatus`/`getFileDiff`/`collectChangedFiles` 存量逻辑未触碰。
- repoPath 缺省行为、IPC 参数透传、前端 provider 调用链均与第二轮核查一致，无回归。
- 后端新代码语法正确（`Arrays.stream`、`untracked.lines()` 均无需新增 import）。

---

## 四、遗留跟踪（前两轮已报、本轮确认未修的存量项）

| 编号 | 问题 | 状态 |
|------|------|------|
| M2 | 并发统计无上限（`Promise.all` / `parallelStream`） | 同意暂缓，建议后续限流 |
| M3 | symlink 目录发现前后端不一致 | 同意暂缓 |
| N4 | 仓库排序两端不一致（码点序 vs localeCompare） | 未修，仅影响展示顺序 |
| L2/L3/L4 | 超时进程回收、worktree 越界 repoRoot、numstat 引号路径等 | 存量，同意按低影响处理 |
