# 代码审查报告：多 Git 仓库性能优化（后端 + Electron 壳）

- 审查日期：2026-08-08
- 审查范围：未提交改动中的后端与 Electron 壳部分
  - `backend/src/main/java/cn/etarch/mao/file/service/WorkspaceGitService.java`（重点：listRepos 线程池改造、summarizeRepo 单命令 porcelain 解析、GitRepoSummaryDTO 移除 insertions/deletions、@PreDestroy）
  - `desktop/electron/gitStatus.cjs`（重点：listGitRepos 单命令改造、summarizeRepoDir porcelain 解析、mapLimit 实现、runGit 超时/输出上限）
  - 附带核对：`desktop/src/types/git.ts`、`desktop/src/types/electron.d.ts` 类型同步与残留引用
- 历史报告：`docs/code_review_20260808175635_backend.md`、`docs/code_review_20260808180354_backend.md`、`docs/code_review_20260808180917_backend.md`
- 姊妹报告：`docs/code_review_20260808211948_frontend.md`（纯前端交互问题，本报告不重复，仅交叉引用）
- 验证手段：真实 git 仓库逐场景实测 porcelain v2 输出（rename / staged+unstaged 双状态 / submodule / 冲突 unmerged / detached / 空仓库无 commit / 特殊字符路径 / 12万+ untracked 文件触发输出超限）；Node 实测 mapLimit 并发与顺序；Java 侧管道截断行为用 shell 管道模拟验证

## 结论摘要

- 需求四项（命令合并 / 有界并发 / 接口拆分 / 减少触发）在**正常体量仓库下实现正确**：porcelain v2 解析边界全部通过实测、mapLimit 并发与顺序正确、线程池生命周期无死锁、insertions/deletions 移除无残留引用、getRepos 与 getStatus 计数口径在正常仓库下一致。
- 发现 **1 个中等程度的功能缺陷**（porcelain 输出超 2MB 时仓库被整体静默丢弃，属回归，后端/Electron 同构）、**1 个中低程度口径不一致**（空仓库无 commit 时 getRepos 与 getStatus 数字对不上）、以及 3 条低优先级健壮性建议。

---

## 一、已验证正确（无回归）

### 1.1 porcelain v2 解析边界 — ✅（逐场景实测）

| 场景 | 实测输出 | 计数处理 |
|------|---------|---------|
| 普通 tracked 变更（staged+unstaged 双状态） | `1 MM N...` 单行 | 非 `#` 行 +1，双状态只算 1 个文件 ✅（与旧 name-status 单行口径一致） |
| rename | `2 R. N... R100 newpath<TAB>oldpath` 单行 | 非 `#` 行 +1，rename 只算 1 个文件 ✅ |
| untracked（含目录内展开） | `? path` 每文件一行（`--untracked-files=all` 与旧 `ls-files --others` 逐文件口径一致） | +1 ✅ |
| submodule 变更 | `1 .M S.M. ... sub` 单行 | +1，与旧 name-status 一致 ✅ |
| 冲突（merge conflict） | `u UU N...` 行 | 非 `#` 行 +1；旧 `diff --name-status HEAD` 冲突时输出 `M file` 也是 1 ✅ |
| detached HEAD | `# branch.head (detached)` | 映射为 `"HEAD"`，与旧 `rev-parse --abbrev-ref HEAD` 输出一致 ✅ |
| 空仓库无 commit | `# branch.oid (initial)` + `# branch.head master` + `1 A. ...` | 分支取 `master`；staged 文件计入（见问题 2） |
| 特殊字符路径（引号/换行/tab/中文） | `core.quotepath=false` 下：换行/引号/tab 用 C 风格 `"..."` 引用为**单行**、中文不引用 | 均不影响按行计数 ✅ |
| 其他 `#` 行（`branch.oid` / `branch.upstream` / `branch.ab`） | 均以 `#` 开头 | 全部跳过 ✅ |

- 后端 `line.charAt(0)` 与 Electron `line.startsWith('#')` 均有 `isEmpty`/`!line` 前置判空，无越界风险。
- 路径含 tab 的 rename 行（`2 R. ... new\told`）只数行数不解析路径，不受影响。
- 结论：**「变更文件数 = 非 # 行数」的口径在所有实测场景下与旧「name-status + ls-files」语义等价**。

### 1.2 mapLimit 实现 — ✅（Node 实测）

- 实测：10 个任务 limit=3，峰值并发=3，结果按输入顺序返回；空数组、limit > length 边界均正常。
- 实现要点核查：`const idx = next++` 在 JS 单线程事件循环内是原子的；`results[idx]` 按下标赋值保证顺序；worker 数 = min(limit, len) 保证有界并发；`fn` 内部异常（summarizeRepoDir 已 catch 返回 null）不会导致 Promise.all 提前 reject。**无 bug**。

### 1.3 后端线程池生命周期 — ✅（正常路径）

- `listRepos`：submit 36 任务 → 按提交顺序 `future.get()` 收集。任务间无共享状态，先提交任务慢不会阻塞后提交任务执行（池线程自取队列任务），收集顺序与结果顺序无关，无死锁。
- 单任务最坏耗时受 `runGit` 10s 超时钳制，`future.get()` 无超时但不会无限阻塞。
- `summarizeRepo` 内部 catch Exception 返回 null，`future.get()` 不会抛 ExecutionException；外层又 catch Exception，双重兜底。
- `@PreDestroy shutdownNow()` 正常路径无泄漏。
- 结论：**正常请求/关闭路径无问题**（细节见问题 4、5）。

### 1.4 insertions/deletions 移除 — ✅ 无残留

- 后端：`GitRepoSummaryDTO` 移除两字段后，`WorkspaceGitService.java` 内剩余 `getInsertions/getDeletions/setInsertions/setDeletions` 全部属于 `getStatus`（Git Tab 明细）与 `collectChangedFiles`（文件级），正确保留。
- admin 前端：grep `insertions/deletions/changedFileCount/gitRepos/workspace-git-repos` 零引用，不受影响。
- desktop：`GitRepoSummary`（getRepos）已移除、`GitStatusSummary`（getStatus）保留，`electron.d.ts` 同步，与 `workspace-git-provider.ts` 透传一致。✅

### 1.5 getRepos 与 getStatus 计数口径一致性 — ✅（正常仓库）

- 逐场景对照：rename（各计 1）、staged+unstaged 双状态（各计 1）、untracked 目录展开（`all` 与 `ls-files --others` 逐文件一致）、submodule（各计 1）、冲突（各计 1）、.gitignore 排除（porcelain 默认排除与 `--exclude-standard` 一致）。**正常仓库下 getRepos（porcelain 非 # 行）与 getStatus（name-status + ls-files 去重）数字一致**。
- 例外：空仓库无 commit 场景，见问题 2。

---

## 二、发现的问题

### [中] 问题 1：porcelain 输出超过 MAX_STDOUT_BYTES（2MB）时，仓库被整体静默丢弃（回归）

- **位置**：
  - 后端 `WorkspaceGitService.java`：`runGit` L517-518（`int allowed = MAX_STDOUT_BYTES - buffer.size(); if (allowed <= 0) break;`）→ `summarizeRepo` L116-118（`exitCode() != 0` → return null）
  - Electron `gitStatus.cjs`：`runGit` L15-18（`maxBuffer: MAX_STDOUT_BYTES`，超限被杀后 `err.code` 非数字 → `exitCode: 1`）→ `summarizeRepoDir` L272-274（`exitCode !== 0` → return null）
- **机制（已实测复现）**：
  - 后端：Java 读满 2MB 后 break 并关闭管道读端 → git 仍阻塞在写管道 → 收到 SIGPIPE 退出。实测：150,000 个 untracked 文件 → porcelain 输出 2,589,114 字节，用 `head -c 2097152` 模拟 Java 提前关闭管道，git 退出码 **141**（SIGPIPE）→ `exitCode() != 0` → `summarizeRepo` 返回 null → **该仓库从列表整体消失（分支名 + 计数全部丢失）**。
  - Electron：execFile `maxBuffer` 超限时 Node 直接杀掉子进程并回调 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`（`err.code` 为字符串非数字）→ `exitCode: 1` → 返回 null → **同样静默消失**。
  - 触发量级（估算）：tracked 变更行约 115 字节/行 → 约 **1.8 万个**变更文件；untracked 行约 17 字节/行 → 约 **12 万个** untracked 文件（实测 120k 文件输出 2.05MB 已逼近阈值）。
- **为什么是回归**：旧代码每仓库 4 条命令，`ls-files` 输出超限只导致 untracked 计数缺失（`runGitOk` 返回 null → untrackedCount=0），仓库仍保留在列表（计数偏低但不消失）；新代码单命令合并后，**输出超限 = 整仓消失**，且前端「N 个仓库 · 全部干净」文案与 Git Tab 下拉选项都会跟着错。同源问题：单命令 10s 超时同样导致整仓消失（前端报告问题 2 已述及失败/超时路径，本问题补充 2MB 截断这一具体机制与量级）。
- **建议**（未改代码）：
  1. 后端：buffer 满后**不要 break**，改为继续读并丢弃剩余字节直到 EOF，让 git 正常退出 0，再用已保留的 2MB 解析（计数略低于真实值但仓库不消失、分支名保留）；解析时注意最后一行可能被截断（UTF-8 多字节字符被切断），可忽略不完整末行。
  2. 或：对 status 命令单独放宽 `MAX_STDOUT_BYTES`（如 16MB），并在文档注明内存上限。
  3. 至少：截断/超时导致的仓库缺失应通过 `error`/告警通道对前端可见（如问题仓库带失败标记），避免静默丢失。

### [中低] 问题 2：空仓库（无 commit）下 getRepos 与 getStatus 计数/分支口径不一致

- **位置**：`summarizeRepo` L121-133（porcelain 解析）vs `getStatus`/`collectChangedFiles` L189-209、L293-311（`diff --name-status HEAD` + `ls-files --others`）
- **表现（实测 repo-empty：init 后仅 `git add f.txt` 未 commit）**：
  - getRepos：porcelain 输出 `# branch.head master` + `1 A. ... f.txt` → `branch = "master"`、`changedFileCount = 1`
  - getStatus：`rev-parse --abbrev-ref HEAD` 在无 commit 仓库 fatal（exit 128）→ `branch = null`；`diff --name-status HEAD` 同样失败 → tracked=0；`ls-files --others` 不含已 staged 文件 → untracked=0 → `changedFileCount = 0`
  - 结果：侧边栏显示「1 变更 / master」，点进 Git Tab 明细显示「0 变更 / 无分支」，数字对不上。
- **说明**：旧 getRepos（rev-parse + name-status）在空仓库下也是 branch=null/count=0，新实现反而更接近真实状态，但**与 getStatus 明细脱节**，且空仓库（如 Agent 刚 `git init` 的仓库）在 Agent 工作流中并不罕见。
- **建议**：getStatus 的 branch 用 `git symbolic-ref --short HEAD` 兜底（空仓库可正常返回分支名）；计数口径统一——空仓库下 staged 文件也应计入（或 getStatus 也改用 porcelain v2 计数）。

### [低] 问题 3：后端 `runGit` 的 `redirectErrorStream(true)` 使 git stderr 混入 porcelain 解析（潜在计数污染）

- **位置**：`WorkspaceGitService.java` L508（`pb.redirectErrorStream(true)`）+ `summarizeRepo` L124（非 `#` 行一律计数）
- **说明**：git 的 stderr 输出（如权限警告 `warning: unable to access ...`、坏对象警告等）会作为普通行进入 `stdout` 解析，一旦不以 `#` 开头就会被误计为 +1 变更文件。Electron 侧 `execFile` 的 stderr 是独立通道，不混入（前后端行为不一致）。
- **现状评估**：实测 porcelain v2 模式下 git 连「untracked 枚举耗时」警告都不输出（被抑制），正常场景无污染；仅异常场景（坏文件/权限/环境变量）可能触发，属隐患而非现网 bug。
- **建议**：解析时只认 `1`/`2`/`u`/`?` 开头的行为变更行（对其他前缀行跳过或告警），或对 status 命令单独关闭 stderr 合并。

### [低] 问题 4：`Future.get()` 无超时 + InterruptedException 中断标志被吞

- **位置**：`WorkspaceGitService.java` L91-97
- **说明**：请求线程阻塞在 `future.get()` 时若被中断，`InterruptedException` 落入 `catch (Exception e)` 仅记日志，**未恢复 `Thread.currentThread().interrupt()`**，中断状态丢失（Tomcat 线程可能被复用继续处理请求）。此外 `future.get()` 无显式超时，最坏等待时间 = 单任务 git 超时（10s）× 批次数（36 仓库/8 并发 ≈ 5 批 ≈ 50s）钳制请求线程。
- **建议**：catch 中区分 `InterruptedException` 并 `Thread.currentThread().interrupt()`；给 `future.get()` 加超时（如 GIT_TIMEOUT_SECONDS + 余量），超时任务 `cancel(true)` 并在结果中降级（保留仓库占位）。

### [低] 问题 5：线程池关闭时序——shutdownNow 时在跑 git 子进程不被销毁；关闭窗口内 listRepos 可能 500

- **位置**：L53-56（`@PreDestroy shutdownNow()`）+ L89（`submit`）
- **说明**：
  1. `shutdownNow()` 中断 worker 线程 → `runGit` 的 `process.waitFor(10s)` 抛 `InterruptedException` → 返回 GitResult(130)，但**正在运行的 git 子进程没有被 destroyForcibly**（超时分支才销毁），关机时可能残留孤儿 git 进程（量小，仅关机路径）。
  2. 关闭窗口内若有并发请求调 `listRepos`，`submit` 抛 `RejectedExecutionException` → 未被捕获 → 接口 500。
- **建议**：`runGit` 的 InterruptedException 分支补 `process.destroyForcibly()`；`listRepos` 捕获 `RejectedExecutionException` 降级为串行执行或返回空列表。

### [提示] 与前端报告的交叉引用

- 前端报告问题 2（git status 失败/超时 → 仓库被静默剔除）与本报告问题 1 同源同构（单命令合并的脆弱性放大），建议一并修复：失败/超时/截断时保留仓库占位并在 UI 标记错误，而不是静默消失。
- 前端报告问题 1（点击已删除仓库跳转错位）、问题 3（双重重刷）为纯前端交互问题，本报告不展开。

---

## 三、其他说明（非缺陷）

- 前后端排序差异：后端 `Comparator.comparing(getName)`（Java 默认序）vs Electron `localeCompare`（locale 序），仅影响多仓库展示顺序细节，非缺陷。
- 后端 runGit 截断的时序分析：git 输出 > 2MB 时，git 因管道满阻塞在写，Java 停止读取必然导致 git 死于 SIGPIPE（exit 141），**不存在「git 已写完但 stdout 被截断且 exit 0」的中间态**（已实测确认），因此行为是确定性的「整仓丢弃」，可放心按问题 1 建议修复。
- 线程池为 Spring 单例字段，`@RequiredArgsConstructor` 与内联初始化无冲突；未调用过 listRepos 时 8 个核心线程懒启动，无资源浪费。

## 四、结论

- 性能优化核心目标（36 仓库发现从 144 次进程降到 36 次、8 路有界并发、getRepos 轻量化）**实现正确**，porcelain 解析、mapLimit、线程池正常路径、类型清理均无问题。
- 建议优先修复：**问题 1**（>2MB 输出整仓静默消失，回归）与 **问题 2**（空仓库口径不一致）；问题 3/4/5 为健壮性建议，可择机处理。
- 修复后需用户自行重启后端生效（Agent 不代为重启）。
