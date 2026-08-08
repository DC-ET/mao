# 代码审查报告（第三轮）：多 Git 仓库性能优化修复核查（后端 + Electron 壳）

- 审查日期：2026-08-08
- 前两轮报告：`docs/code_review_20260808211948_backend.md`、`docs/code_review_20260808213014_backend.md`
- 本轮范围：核查 5 项修复的正确性与新引入问题
  - `backend/src/main/java/cn/etarch/mao/file/service/WorkspaceGitService.java`（summarizeRepo daemon 读线程重构、listRepos 按索引占位）
  - `desktop/electron/gitStatus.cjs`（占位补 changedFileCount: 0）
  - `desktop/src/components/task/TaskInspector.vue` / `useGitRepos.ts`（unavailable 提示分支，交叉核查）
- 验证手段：`mvn compile` / `vue-tsc --noEmit` 通过；Java 实验实测三条路径（正常大输出 / 超时强杀 / 中断）；Electron 端上轮已实测 spawn 方案，本轮仅补字段无逻辑改动

## 结论摘要

- 5 项修复**全部正确**：daemon 读线程方案在正常/超时/异常三条路径下均无线程泄漏（实验证实）；destroyForcibly 后读线程可靠退出；DISCARD 消除死锁；future 超时占位在正常路径索引对齐；Electron 契约补齐；前端 unavailable 提示分支结构正确。
- 发现 **1 个索引错位缺陷**（RejectedExecutionException 停机窗口，低优先级）与 **3 条健壮性提示**（中断路径未销毁 git、DISCARD 丢失诊断、wrapper 子进程场景）。

---

## 一、修复核查（全部验证通过）

### 1.1 daemon 读线程方案（发现 A 修复）— ✅ 三条路径实测通过

**正常路径**（15 万 untracked / 2.59MB 输出）：
- 实测：`waitFor` 202ms 返回（读线程并行消费 stdout，git 不被管道阻塞）、`reader.join(5000)` 后读线程结束（alive=false）、count=150000 完整、exit=0。**读线程先消费 → git 不阻塞 → 无 SIGPIPE，数据完整** ✅
- 时序正确：git 退出（写完 stdout）→ waitFor 返回 → join 等读线程把管道剩余数据读完 → holder 就绪后才消费 ✅

**超时路径**（git 卡死）：
- 实测：`waitFor(10s)` 超时 → `destroyForcibly()` → `waitFor(5s)` 回收成功 → 读线程因管道关闭读到 EOF **自然结束**（1 秒后 alive=false，无泄漏）✅
- `destroyForcibly` 杀 git 主进程 → stdout 管道写端关闭 → 读线程 readLine 返回 null（EOF）→ 正常退出，**不依赖 interrupt** ✅
- 超时路径直接 return unavailable，不 join 读线程——读线程是 daemon 且管道已关闭必然 EOF，无泄漏 ✅

**异常路径**（spawn 失败 / 主线程被中断）：
- `pb.start()` 抛 IOException → 读线程尚未创建，直接 unavailable ✅
- `waitFor` 抛 InterruptedException → interrupt 恢复 + unavailable ✅
- `reader.join` 抛 InterruptedException → interrupt 恢复 + 继续 exitValue 检查（不放弃已读结果）✅

### 1.2 Redirect.DISCARD（发现 A 修复）— ✅ 死锁根治

- stderr 直接重定向 /dev/null，**无管道、无缓冲、git 永不阻塞写 stderr**——上一轮发现的「stderr>64KB 管道满死锁」从根上消除 ✅
- 成功路径 git stderr 为空，DISCARD 无任何影响 ✅

### 1.3 future 超时占位（发现 B 修复）— ✅ 正常路径正确（极端路径见发现 1）

- 收集循环 `for (int i = 0; i < futures.size(); i++)` 按索引取 `repoDirs.get(i)` 做占位。**submit 全部成功时 futures.size()==repoDirs.size()，索引一一对应** ✅
- TimeoutException → `cancel(true)` + `unavailableRepo(repoDirs.get(i))` 占位，仓库不消失 ✅
- InterruptedException → interrupt 恢复 + 占位 ✅；ExecutionException → 占位 ✅

### 1.4 Electron 占位补 changedFileCount: 0（修复 4）— ✅

- `summarizeRepoDir` 的 error/close 失败分支均 `resolve({ name, path: name, changedFileCount: 0, unavailable: true })`，与 TS 必填类型 `changedFileCount: number` 契约一致 ✅
- 后端 `unavailableRepo` 的 `changedFileCount` 为 int 默认 0 → Jackson 输出 0，**两侧占位结构一致**（上轮前端报告发现 3 已解决）✅

### 1.5 前端 unavailable 提示分支（修复 5）— ✅ 结构正确

- Git Tab：`v-if="selectedRepo?.unavailable"` 显示「该仓库 Git 状态不可用 + 重试」→ `v-else` GitChangeList。`selectedRepo` 已从 useGitRepos 导出（computed，随 repos/selectedRepoPath 自动更新）✅
- 单仓库模式（multiRepoMode=false）：repos=[] → selectedRepo=null → `?.unavailable` undefined → 走 v-else → GitChangeList 正常，**不影响单仓库** ✅
- 下拉可选中 unavailable 仓库 → 提示区正确显示；重试 → `refreshAll`（refreshRepos + refreshGit）→ 仓库恢复则自动切回 GitChangeList ✅
- `vue-tsc --noEmit` 通过 ✅

---

## 二、发现的问题

### [低] 发现 1：listRepos 索引对齐缺陷——RejectedExecutionException 触发时占位错位

- **位置**：`WorkspaceGitService.listRepos`：
  ```java
  for (Path dir : repoDirs) {
      try { futures.add(repoScanExecutor.submit(...)); }
      catch (RejectedExecutionException e) { /* 记录并跳过 */ }   // ← 被拒绝的 dir 不进 futures
  }
  for (int i = 0; i < futures.size(); i++) {
      ...
      summary = unavailableRepo(repoDirs.get(i));  // ← 索引错位
  }
  ```
- **机制**：当某个 dir 的 submit 被拒绝（停机窗口）时，`futures.size() < repoDirs.size()`，`futures.get(i)` 实际对应 repoDirs 中第 i 个**成功提交**的 dir，而占位取 `repoDirs.get(i)`（第 i 个**所有** dir）→ 占位的 name/path 可能指向**被拒绝的那个仓库**，而真正超时的仓库消失。
  - 例：repoDirs=[A,B,C]，B 被拒绝 → futures=[A,C]。i=1 时 futures.get(1)=C 超时 → 占位 `unavailableRepo(B)` → **B 以「不可用」出现（实际 B 从未执行），C 丢失**。
- **触发条件**：仅 `RejectedExecutionException`（`@PreDestroy shutdownNow` 之后的应用停机窗口）→ 概率极低；正常路径索引完全对齐。但逻辑缺陷客观存在。
- **建议**：submit 时用 `Map<Path, Future<GitRepoSummaryDTO>>`（或平行数组）记录 dir→future 对应关系，超时/中断/异常分支用该 Map 反查真实 dir 做占位；同时被拒绝的 dir 也应补 `unavailableRepo(dir)` 占位（与注释「记录并跳过」对齐——当前跳过即丢失该仓库，与修复 6「仓库不消失」目标仍不一致）。

### [低] 发现 2：InterruptedException 分支未销毁 git 进程（防御性缺口，实际时序无泄漏）

- **位置**：`summarizeRepo` 的 `catch (InterruptedException e)`——return unavailable 前**未 destroyForcibly**。
- **实测**：模拟 worker 在 `waitFor` 中被 `cancel(true)` 中断 → git 进程仍存活（未被销毁）。
- **实际时序分析**：`future.get` 超时 15s > worker 的 `waitFor(10s)`，中断只可能命中**destroyForcibly 之后**的 `waitFor(5s)`（10~15s 窗口）→ 此时 git 已销毁，**实际无泄漏**。但若未来调整超时参数（如 GIT_TIMEOUT_SECONDS 调大或 future.get 余量调小）使 15s < 10s 不成立，该缺口会变成真实泄漏。
- **建议**：InterruptedException catch 中补 `process.destroyForcibly()` + `process.waitFor(5, SECONDS)`（幂等，正常路径不受影响），彻底消除隐患。

### [低] 发现 3：Redirect.DISCARD 丢失失败诊断（可观测性退化）

- **位置**：`summarizeRepo` `pb.redirectError(ProcessBuilder.Redirect.DISCARD)` + 失败时 `log.warn("git status failed in {} (exit {})")`。
- **说明**：上轮实现会 `readAllBytes()` stderr 并 log 具体失败原因（如 "fatal: index file corrupt"）；本轮 DISCARD 后**只剩 exit code**，无法区分 index 损坏 / 权限错误 / git 内部异常，排障需手动到服务器复现。功能正确性不受影响，但可观测性明显退化。
- **建议**：`Redirect.to(临时文件)` 替代 DISCARD（git 写文件不阻塞、无管道死锁风险），失败时读回文件尾部（如后 1KB）记日志；或至少记录 exit code + 仓库路径以便人工排查。

### [提示] 发现 4：git 经 wrapper/子进程运行时 destroyForcibly 无法关闭管道（读线程阻塞）

- **实测（模拟局限暴露）**：用 `sh -c "…; sleep 1000"` 模拟 git 卡死时，`destroyForcibly` 只杀 sh 主进程，**sleep 子进程继承 stdout 管道写端** → 读线程 readLine 不 EOF、永久阻塞（1 秒后 alive=true）；无子进程的进程（直接 sleep）则正常 EOF 结束（alive=false）。
- **真实场景评估**：git status 默认不 spawn 子进程（无外部 diff/filter 驱动时），`destroyForcibly` 杀 git 后管道必然关闭，**无此问题**。但若运行环境给 git 配了 wrapper（alias 脚本）、`GIT_EXTERNAL_DIFF`、filter 驱动，或 git 本身被包一层，理论上会命中。读线程是 daemon（不阻止 JVM 退出、不占线程池），但会累积少量泄漏。
- **建议**：可接受现状（概率极低）；若想彻底防御，读线程可对 `readLine` 套超时（如 `FutureTask` + `get(超时)`，超时后中断读线程——但 InputStream read 不响应中断，需在超时路径关闭 `process.getInputStream()` 强制解除阻塞）。

---

## 三、其他说明（非缺陷）

- 上一轮发现的「Electron 侧 stderr.resume 早已正确」本轮确认无改动，前后端不对称性已消除（后端 DISCARD 等效于 Electron 的 resume）✅
- `reader.join(5000)` 被中断时可能返回部分结果（count=0/branch=null 误报）：概率极低（需 cancel 命中 join 窗口且读线程 >5s 未读完），且此时 exitValue 检查会兜底失败路径，不列为缺陷，仅在发现 2 建议中一并覆盖。
- Electron 端本轮仅补 `changedFileCount: 0`，spawn + SIGKILL + close 方案前两轮已实测无竞态、无泄漏，无新改动无需复测。

## 四、结论

- 本轮 5 项修复**全部有效**：daemon 读线程方案三条路径实测无泄漏、DISCARD 根治 stderr 死锁、future 超时占位正常路径正确、Electron 契约补齐、前端 unavailable 提示闭环。
- 建议处理：**发现 1**（Map 关联索引，消除停机窗口占位错位 + 补齐被拒仓库占位）、**发现 2**（中断分支补 destroyForcibly，防御性一行）、**发现 3**（失败诊断可观测性，DISCARD 换 Redirect.to 临时文件）；发现 4 可接受现状。
- 修复后需用户自行重启后端生效（Agent 不代为重启）。
