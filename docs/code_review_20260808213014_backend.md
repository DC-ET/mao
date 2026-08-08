# 代码审查报告（第二轮）：多 Git 仓库性能优化修复核查（后端 + Electron 壳）

- 审查日期：2026-08-08
- 上轮报告：`docs/code_review_20260808211948_backend.md`
- 姊妹报告：`docs/code_review_20260808213014_frontend.md`（前端交互部分，本报告不重复，交叉引用）
- 本轮范围：核查 6 项修复的正确性与新引入问题
  - `backend/src/main/java/cn/etarch/mao/file/service/WorkspaceGitService.java`
  - `desktop/electron/gitStatus.cjs`
  - `desktop/src/types/git.ts` / `electron.d.ts`（unavailable 类型链路，对照）
- 验证手段：真实 git 仓库 + Java/Node 实验
  - 15 万 untracked（2.59MB 输出）Java 逐行方案与 Node spawn 方案各实测一次
  - 空仓库（unborn）全部命令行为实测
  - Java 实验证实「只读 stdout 不排空 stderr → stderr>64KB 死锁」与「interrupt 无法打断阻塞的 read」
  - 损坏 index 仓库 git status stderr 输出量实测（87 字节）
  - Node 实测 Electron readline line/close 事件顺序（无竞态）

## 结论摘要

- 6 项修复**主逻辑全部正确**：逐行读取方案彻底解决 2MB 截断回归（实测 15 万 untracked 计数完整、exit 0、无 SIGPIPE）；空仓库口径两端一致（branch=master/1 变更）；`--cached` 回退不误伤正常仓库；cancel(true) 不污染线程池后续任务；unavailable 前端链路完整。
- 发现 **1 个新引入的中等风险**（后端读 stdout 期间 stderr 未排空 → 管道满死锁，已实验证实，含线程泄漏）与 **2 个后端特有的占位链路缺口**（future.get 超时分支丢弃仓库、RejectedExecutionException 注释与实现不符），另有 1 条低优先级提示（getStatus 路径 stderr 合并未覆盖）。

---

## 一、修复核查（全部验证通过）

### 1.1 逐行读取方案（修复 1）— ✅ 实测通过

**后端**（`summarizeRepo` ProcessBuilder + BufferedReader）：
- 实测 150,000 个 untracked 文件、输出 2,588,970 字节（超旧 2MB 限制）→ `finished=true exit=0 branch=master count=150000`，stderr 0 字节。**无 SIGPIPE、计数完整、仓库保留** ✅
- `BufferedReader.readLine()` 无长度上限（readAheadLimit 仅影响 mark/reset），porcelain 行受 PATH_MAX 限制（≤4096），超长行无风险 ✅
- `InputStreamReader(UTF_8)` 流式解码跨 chunk 自动处理，多字节字符不会被切断 ✅
- 无效 UTF-8 文件名 → 替换符（U+FFFD）不抛异常，行计数不受影响 ✅
- 先读完 stdout（EOF）再 `waitFor`：git 写完 stdout 即退出，无竞态 ✅

**Electron**（`summarizeRepoDir` spawn + readline）：
- 实测同场景 150,000 文件 → `close code=0 branch=master count=150000` ✅
- spawn 无 maxBuffer（execFile 才有），超限被杀问题消除 ✅
- 实测 5000 行快速输出：`close` 触发时计数完整（5000/5000）——readline 在 stdout `end` 时同步 flush 剩余行，`line` 事件先于 `child close` 派发，**无竞态** ✅
- `child.stderr.resume()` 同步执行无窗口期；SIGKILL 超时 → close(code=null 或非 0) → unavailable；error/close 双 resolve 幂等 ✅

### 1.2 空仓库口径（修复 5）— ✅ 实测通过，不误伤正常仓库

实测 unborn 仓库（init 后仅 `git add staged.txt` 未 commit）：
- `rev-parse --show-toplevel` **成功**（exit 0）→ getStatus 不会误判 isGit=false ✅
- `rev-parse --abbrev-ref HEAD` 失败（exit 128）→ 兜底 `symbolic-ref --short HEAD` 返回 `master` ✅
- `diff --name-status HEAD` 失败 → `rev-parse --verify HEAD` 失败（exit 128）→ 回退 `diff --name-status --cached` 返回 `A staged.txt`；`--numstat --cached` 返回 `1 0 staged.txt` ✅
- 汇总：getStatus = branch=master / changedFileCount=1 / insertions=1，与 getRepos（porcelain 计数 1、branch master）**口径一致** ✅

**不误伤核查**：回退触发条件为 `diff HEAD 失败 && rev-parse --verify HEAD 失败`。正常仓库（有 commit）下 `rev-parse --verify HEAD` 恒成功 → 回退不触发 → 行为与改动前完全一致；detached HEAD 时 `rev-parse --abbrev-ref` 返回 `HEAD`（exit 0）→ 不触发 symbolic-ref 兜底 ✅。唯一误伤可能 = HEAD 对象存在但 rev-parse 失败（.git 严重损坏），概率极低且此时 diff HEAD 本就失败，回退 --cached 反而更合理。

### 1.3 future.cancel(true) 对线程池的影响（修复 3 后半）— ✅ 无污染

`cancel(true)` 只对正在运行的任务设中断标志。`ThreadPoolExecutor` worker 在任务结束后进入 `getTask()` 时调用 `Thread.interrupted()`（清除标志）再取下一个任务——**中断标志不会残留到后续任务** ✅。被中断任务（waitFor → InterruptedException / readLine → IOException）均能响应并返回（unavailableRepo），不会卡死 worker（例外见发现 A）。

### 1.4 unavailable 链路（修复 6）— ✅ 主链路完整（缺口见发现 B/C）

- 后端 `unavailableRepo()` 占位（unavailable=true、changedFileCount=0 由 int 默认）→ Jackson NON_NULL 输出 ✅
- Electron 失败/超时 → `{name, path, unavailable:true}` ✅
- 前端 `unavailableRepos` computed + 摘要行「N 个仓库 · M 个不可用」/「M 个仓库状态不可用」文案，四种展示组合正确（frontend 报告已详核）✅

---

## 二、发现的问题

### [中] 发现 A：后端读 stdout 期间 stderr 未排空 → git stderr 输出 >64KB 时死锁 + worker 线程永久泄漏（新引入，已实验证实）

- **位置**：`WorkspaceGitService.summarizeRepo`（ProcessBuilder `redirectErrorStream(false)` 后：readLine 循环读 stdout → 读到 EOF → waitFor → 才 `readAllBytes()` 读 stderr）
- **机制（实验证实）**：
  1. **死锁**：Java 读 stdout 的循环内，stderr 无人读取。git 若向 stderr 写入超过管道缓冲（Linux 默认 64KB），git 阻塞在写 stderr → stdout 不再有数据 → `readLine` 永久阻塞。实验：`sh` 向 stderr 写 200KB、stdout 写 1 行，Java 只读 stdout → 3 秒后 readLine 仍阻塞（无超时保护，`waitFor` 在 readLine 之后永远执行不到）。
  2. **interrupt 无效**：外层 `future.get(15s)` 超时后 `cancel(true)` 中断 worker 线程，但阻塞在 `FileInputStream.read` 的线程**不响应中断**。实验：interrupt 后 2 秒线程仍存活。→ 该 worker 线程**永久卡死**，8 线程池逐步被耗尽，后续 getRepos 任务全部排队 → future.get 超时 → 仓库批量丢弃 → 多仓库 UI 整体消失（frontend 报告发现 2 已述 UI 侧后果）。
- **触发概率评估**：git status 正常输出与常规错误 stderr 都很小（实测损坏 index 仓库 stderr 仅 87 字节）；需要大量对象损坏逐条报错等极端场景才可能 >64KB。**概率低，但后果严重（线程泄漏不可自愈）且修复成本极低**。
- **不对称**：Electron 侧已正确 `child.stderr.resume()`（边读边排空），说明修复者意识到了 stderr 排空问题，但后端只做了「进程结束后读」，漏了「读取 stdout 期间排空」。
- **建议**（未改代码）：
  1. 最简：`pb.redirectError(ProcessBuilder.Redirect.DISCARD)`（stderr 直接丢弃，git 永不阻塞）；失败诊断可另跑短命令或保留一条 stderr 到临时文件的折中方案。
  2. 或将 `waitFor` 提前到 readLine 之前（先等进程结束再读流，配合 stderr 排空线程）。
  3. 超时路径 `destroyForcibly()` 后补一次 `waitFor` 确认回收，避免 fd 泄漏（frontend 报告发现 4 亦提及）。

### [中低] 发现 B：future.get 超时分支将仓库静默丢弃，与「unavailable 占位」修复目标不一致

- **位置**：`WorkspaceGitService.listRepos`：
  ```java
  } catch (TimeoutException e) {
      future.cancel(true);
      summary = null;   // ← 仓库直接消失，无占位
      log.warn("Repo summary timed out, dropped");
  }
  ```
- **说明**：任务内超时（waitFor 10s）会返回 `unavailableRepo` 占位；但任务若超过 `GIT_TIMEOUT_SECONDS + 5`（如发现 A 的死锁、git 被外部挂起），走 TimeoutException 分支 → `summary=null` → 仓库从列表**静默消失**，恰好复现本轮要修的「仓库消失」问题（尽管概率低）。注释也明确写了 "dropped"，是主动选择，但与修复 6 的目标（失败/超时 → 占位）不一致。
- **建议**：submit 时保留 `dir → Future` 映射（如 `Map<Path, Future<...>>`），TimeoutException 分支构造 `unavailableRepo(dir)` 占位；InterruptedException/ExecutionException 分支同理可占位。

### [低] 发现 C：RejectedExecutionException 分支注释与实现不符（无占位）

- **位置**：`listRepos` submit 循环：
  ```java
  } catch (RejectedExecutionException e) {
      // 线程池已关闭（应用停机窗口）：降级为占位条目，避免接口 500
      log.warn("Repo scan executor rejected task for {}, skip: {}", dir, e.getMessage());
  }
  ```
- **说明**：注释声称「降级为占位条目」，实际只是 log + 跳过，**没有生成占位**——关闭窗口内该仓库静默消失。窗口极小（应用停机中），影响可忽略，但注释与实现不符易误导后续维护。
- **建议**：补 `repos.add(unavailableRepo(dir))` 或修正注释。

### [低/提示] 发现 E：getStatus 路径（collectChangedFiles）的 runGit 仍 redirectErrorStream(true)，修复 3 只覆盖了 summarizeRepo

- **位置**：`runGit`（L508 `pb.redirectErrorStream(true)`）仍被 `collectChangedFiles` 的 3 条命令（diff --name-status / diff --numstat / ls-files）使用。
- **说明**：stderr 混入 stdout 对这三条命令的影响：`--numstat` 行含 tab 分隔，stderr 行 split 后 parts<3 被跳过（有防御）；`--name-status` 行经 parseNameStatusLine 前缀校验，非法行返回 null（有防御）；**但 `ls-files --others` 输出无前缀校验**——stderr 行被当作 untracked 路径 → `files.put` 多计 1 个变更文件（该路径不存在 → `Files.isRegularFile` false → 不读内容，仅多一个条目）→ changedFileCount 偏差。getStatus 的单仓库链路受影响（多仓库 getRepos 已用新实现不受影响）。
- **现状**：上轮报告问题 3 的定位是 porcelain 计数路径（已修复）；getStatus 路径是存量低风险（git status/diff 类命令正常不输出 stderr），但既然本轮已声明修复问题 3，建议顺带将 `runGit` 的 redirectErrorStream 改为 false + 单独读 stderr（与 summarizeRepo 一致），或至少给 ls-files 解析加「路径存在性校验」。
- **交叉引用**：frontend 报告发现 1（unavailable 仓库点开后 getStatus 不显示具体错误）同属 getStatus 路径的 error 信息缺失，两处建议可一并处理。

---

## 三、其他说明（非缺陷）

- Electron 失败占位 `{name, path, unavailable:true}` 无 `changedFileCount`（undefined），与 TS 必填类型 `changedFileCount: number` 不符；运行时 `undefined > 0 = false` 恰好语义正确，无功能影响（frontend 报告发现 3 已详述，本报告不重复）。
- 后端 `unavailableRepo` 的 `changedFileCount=0`（int 默认）与 Electron 的 undefined 在序列化后一个输出 0、一个缺字段——前后端占位结构不完全一致，但前端过滤逻辑（`>0` 与 `!==undefined`）对两者等价，无需处理。
- `shutdownNow` 后已提交未执行的任务：不会被取消也不执行，`future.get(15s)` 逐个超时（每任务最多等 15s）→ cancel 丢弃。停机窗口内不 500，仅等待稍久，可接受。

## 四、结论

- 上轮 6 项修复**全部有效**：2MB 截断回归彻底解决（实测）、空仓库口径两端一致（实测）、--cached 回退无正常仓库误伤、cancel(true) 无线程池污染、unavailable 主链路完整。
- 建议处理：**发现 A**（stderr 排空，一行 DISCARD 即可消除死锁与线程泄漏隐患，建议优先）、**发现 B/C**（占位链路在极端路径补齐，与 unavailable 目标对齐）、**发现 E**（getStatus 路径 stderr 合并，低优先级）。
- 修复后需用户自行重启后端生效（Agent 不代为重启）。
