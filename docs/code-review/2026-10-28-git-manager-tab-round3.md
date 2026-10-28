# 代码审查报告：工作区 Git 管理器中央 Tab 第 3 轮（收尾轮：修复复核 + 全量走查）

- 审查对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/git-manager-tab`（分支 `feat/git-manager-tab`）未提交改动，已排除 CHANGELOG/README/skills 等文档改动与 package.json 版本号
- 技术方案对照：`docs/plan/2026-10-28-git-manager-tab-technical-design.md`
- 审查日期：2026-10-28
- 审查方式：①对第 2 轮新 bug（`resetAll` 漏增 `commitFilesSeq`）与第 2 轮低优先级备注（workspace numstat 简单切片）两个修复逐行走读；②跑仓库内已落地的回归用例复核；③另写 16 个临时探针用例（Electron 10 / 前端 6）专测「修复是否引入新问题」与修复边角，验证后按约定删除（完整代码见附录 A）；④按文件 mtime 比对确认第 2 轮报告之后除两个修复外无新改动，对全部改动文件做最后全量走查
- 基线状态：`desktop` vitest 全量 144 文件 1374 用例全绿（与自查一致）；`desktop/electron` node 全量 152 例 149 过 2 失败，两失败均为本机存量环境差异（全局 git 身份 / macOS `/var`→`/private/var` 符号链接），主工作区同样失败，且分属未改动的 `gitOperations`/`localShell` 链路；`backend-ts` 第 2 轮后未再改动（用户自查全量 5130 passed，唯一失败为 worktree 路径过长导致 runtime-agent unix socket 用例，主工作区正常）
- 结论：**两个修复均确认到位，修复本身未引入功能性新问题；最后全量走查未发现新 bug。无重大 bug，可以收尾。**

---

## 一、本轮两个修复的复核（全部确认修复，无新问题）

### 修复 1（第 2 轮新 Bug 1，低）：`resetAll()` 补 `commitFilesSeq++` —— 已修复

**位置**：`desktop/src/composables/useGitManager.ts:53-80`。`resetAll()` 现对五路序号全部推进：`logSeq`（`:54`）、`commitFilesSeq`（`:57`，附注释说明在途清单迟到会写进新仓库缓存、新旧仓库共享哈希时命中旧清单）、`branchesSeq`（`:67`）、`stashesSeq`（`:72`）、`remotesSeq`（`:77`）；`toggleCommit`（`:116-141`）的迟到丢弃判据 `if (seq !== commitFilesSeq) return`（`:129`）随之生效，错误分支（`:134`）与 `finally`（`:139`）同样受序号保护。

**验证（仓库落地回归用例，本轮实跑）**：

```
✓ 切仓库后在途的提交文件清单迟到被丢弃，不污染新仓库缓存（useGitManager.test.ts:260-288）
  （在途 toggleCommit('shared-hash') → provider 切换 → 迟到 resolve 后 commitFiles.size === 0；
    新仓库展开同一 hash 才真正请求 second.calls.getCommitFiles === 1，清单为新仓库数据）
✓ 前端 useGitManager.test.ts 全文件：Test Files 1 passed / Tests 16 passed
```

**补充探针（临时，已删）确认修复边角不塌**：

- P1（核心复验，独立构造 deferred）：切仓库后旧仓库在途清单**成功态**迟到被丢弃，缓存 size=0，新仓库展开同 hash 正常请求并拿到新数据。
- P2（错误态迟到）：旧仓库请求**reject** 迟到不得把新仓库的展开态收起、不得写 `logError`、不得清 `commitFilesLoading`；新仓库请求随后正常完成、数据落缓存。成功/失败两条迟到路径都被序号挡住。
- P3（常规链路无回归）：拉取→缓存→收起→再展开命中缓存不重复请求，`commitFilesLoading` 正常归位。
- P4（既有防护未被破坏）：同一 provider 下连续展开不同 hash，旧在途仍被新序号丢弃、新的正常落缓存。
- P5（provider → null → 对象往返）：迟到的旧结果不写进恢复后的仓库缓存、不写错误态。
- P6（修复不误杀）：序号只增不减——旧仓库先展开制造过高水位后切仓库，新仓库首次展开照常拿到数据。

**触发场景可达性**：`GitManagerPanel.vue:193-229` 的 `statusProviderRef` 在 `selectedRepoPath` 变化（多仓库模式切仓库下拉）时产出新 provider 对象，`useGitManager`/`useGitOperations` 均挂它，`watch(provider)` 触发链完整；`gitProviderRef = computed(() => props.gitProvider ?? null)`（`:180`）仅在 prop 真变时换身份，无误触发重置。

**修复引入的新问题**：未发现。

### 修复 2（第 2 轮低优先级备注，低）：`collectChangedFiles` 换用 `numstatNewPath` 还原花括号紧凑改名 —— 已修复

**位置**：`desktop/electron/gitStatus.cjs:164-166`。原简单切片 `filePath.slice(filePath.lastIndexOf(' => ') + 4)` 换成 `numstatNewPath(parts[parts.length - 1])`（助手函数在同文件 `:663-673`，`getGitCommitFiles` 的 numstat 合并本就用它）。与后端 `workspace-git.service.ts:708`（`collectChangedFiles` 内同款调用，助手在 `:776-787`）逐行同构，LOCAL/CLOUD 口径自此一致。

**验证（仓库落地回归用例，本轮实跑）**：

```
✓ workspace status merges numstat for a same-directory rename（gitStatus.test.cjs:214-231）
  （git mv src/a.txt src/b.txt + 内容编辑 → RENAMED / oldPath='src/a.txt' / insertions=1 / deletions=0）
✓ Electron gitStatus + gitOperations：node --test → # tests 44 # pass 43 # fail 1（唯一失败为已知环境差异）
```

**补充探针（临时，已删）确认修复边角不塌**：

- R1/R2（核心复验）：未 staged / `git add -A` 后两种状态下，同目录改名（git 输出 `1\t0\tsrc/{a.txt => b.txt}`）统计均正确合并为 +1/-0。
- R3（仅共同后缀）：`{src => lib}/a.txt` 形态合并为 +1/-0。
- R4（回归）：跨目录普通形态 `src/a.txt => lib/b.txt` 仍合并正确。
- R5（回归）：普通 MODIFIED / DELETED / CREATED / untracked 条目与统计完全不受影响。
- R6：二进制改名（git 检出为改名时）不崩、条目正确。
- R7（病理场景）：文件名本身含 `" => "` 时条目不丢、统计丢失行为与修复前**完全一致**（新旧实现都切出 `name.txt`，匹配不上键仅丢统计）——无回归。
- R8（回归）：空仓库 `--cached` 回退路径不受影响。
- R9/R10（差分验证，严格改进证明）：对 12 种路径形态逐条比对旧切片与新实现输出——全部非花括号形态输出逐字符一致（无回归）；全部花括号形态旧实现产出错键（`b.txt}`、`lib}/a.txt`、`b}/x.txt`、`b}.txt`、`b.txt}/y.txt`）而新实现还原出真实新路径（`src/b.txt`、`lib/a.txt`、`src/b/x.txt`、`b.txt`、`x/b.txt/y.txt`）。

**修复引入的新问题**：未发现。`parseNameStatusLine` 走的是 name-status 的 R 行（始终输出完整 old/new 两个制表符字段，无紧凑形态），键生产侧不受影响，无需同步改动。

---

## 二、确认的新 Bug

无。

---

## 三、低优先级备注

无新增。第 2 轮备注的 workspace numstat 花括号形态统计丢失已由本轮修复 2 解决（LOCAL/CLOUD 口径一致，探针 R1-R4 + 差分 R10 实证）。

一个观察项（不计 bug、零用户影响）：纯二进制改名（无内容变化）时 git 报 `0\t0` 而非 `-\t-`，`binary` 标记不落（探针 R6 实证）。但该字段（`GitChangedFile.binary`）无任何 UI 消费方，且 `+0/-0` 对纯改名本就正确，两端逻辑同构，属修复前既有行为、本次未触及。

---

## 四、误报已排除（本轮探针 + 走查验证后不构成 bug）

1. **electron 全量跑出的第 2 个失败 `keep_session reuses cwd after cd and refreshes current_workdir`**（`localShell.test.cjs`）：macOS 临时目录 `/var`→`/private/var` 符号链接导致 `pwd` 返回真实路径与期望不符；主工作区（未改动）同样失败，且 `localShell.cjs` 不在本次改动清单内——本机存量环境差异，非本 feature bug。（用户自查的 44 例口径为 gitStatus+gitOperations 两文件，故只见 1 个失败。）
2. **二进制改名统计**（R6）：小二进制改字节 git 根本不检出改名（输出 DELETED+CREATED 两条 `-\t-`）；大块二进制纯 mv 检出 R100 时报 `0\t0`——均为 git 自身行为，代码侧条目、类型、崩溃防护均正确。
3. **文件名含 `" => "` 的病理场景**（R7）：新旧实现输出一致，仅丢统计不丢条目，无回归。
4. **探针 P2 首跑失败**：探针自身时序错误（第二个 provider 的请求已同步 resolve，`loading` 自然归 false），改为双 deferred 后通过——非产品问题。
5. **第 1/2 轮已排除的 10 项误报**：本轮走查未发现推翻性证据，维持原判定（stash 预存在冲突、oldPath 逃逸、复制/根提交 changeType、符号链接场景、嵌套花括号改名提交清单、log 竞态与 provider 往返、错误契约、restoreActiveTab 对 git 的处理、双 fetch、getLog path 参数未校验）。
6. **第 1/2 轮 4+1 个修复点完好性**：本轮逐一复读当前代码确认无回退——stash 冲突优先判定（后端 `git-write-operation.service.ts:266-273` / Electron `gitOperations.cjs:505-513`）、切仓库按视图重载（`useGitManager.ts:210-228`）、`oldPath` 全链路（后端 `workspace-git.service.ts` + `file.routes.ts:293` + Electron `gitStatus.cjs` getGitCommitFileDiff + main/preload/electron.d.ts + provider 两实现 + `TaskView.vue:725-737`）、只读方法 workspace 包含校验（两端 `resolveRepoRoot`）。

---

## 五、全量走查范围与结论

按文件 mtime 比对：第 2 轮报告落盘（12:48）之后被改动的仅有 `useGitManager.ts`(+test)、`gitStatus.cjs`(+test) 两个修复及其回归用例，与用户陈述一致；其余改动文件均止于第 2 轮修复集（12:21-12:47），已在第 1/2 轮逐文件审查。本轮对以下范围完成最后走查，未发现新 bug：

- 后端：`file.routes.ts`、`git-write-operation.service.ts`、`workspace-git.service.ts` 及三个 spec（后端本轮未再改动，第 2 轮全量 5130 passed）
- Electron：`gitStatus.cjs`（全 diff 重读，含 `resolveRepoRoot`/`numstatNewPath`/`getGitCommitFileDiff` 越界防护）、`gitOperations.cjs`、`main.cjs`/`preload.cjs`/`electron.d.ts` 链路
- 前端：`useGitManager.ts`（全文）、`useGitOperations.ts`、`workspace-git-provider.ts`、`useCenterTabs.ts`（openGitTab、idPrefix 隔离、applyWorkspacePathChange 提交 diff 重定向）、`utils/git-manager.ts`、`TaskView.vue`（handleOpenCommitDiff 全 diff）、`GitManagerPanel.vue`（statusProviderRef 与 useGitManager/useGitOperations 挂载）、`GitHistoryView/GitBranchesView/GitStashView.vue`、`GitChangeList.vue`、`CenterTabContainer.vue`、`types/*`

**收尾结论：两个修复到位且无新问题，全量走查无新 bug，无重大 bug，可以收尾。**

---

## 附录 A：本轮临时验证测试（已按约定删除，未提交）

- `desktop/electron/zz-r3-probe.test.cjs`（R1/R2 同目录改名统计合并未 staged/staged / R3 仅共同后缀改名 / R4 跨目录普通改名回归 / R5 普通条目回归 / R6 二进制改名 / R7 病理文件名无回归 / R8 空仓库 --cached 回退 / R9 纯函数 / R10 新旧实现差分验证）
- `desktop/src/composables/zz-r3-probe.test.ts`（P1 成功态迟到丢弃 / P2 错误态迟到丢弃 / P3 常规链路回归 / P4 连续展开序号防护 / P5 provider null 往返 / P6 修复不误杀）

运行方式：`cd desktop && node --test electron/zz-r3-probe.test.cjs`；`cd desktop && npx vitest run src/composables/zz-r3-probe.test.ts`。两文件均在验证通过后删除，`git status` 已无残留。

## 附录 B：修复复核与全量回归的命令与输出

```
cd desktop && npx vitest run src/composables/useGitManager.test.ts
  → Test Files 1 passed (1) / Tests 16 passed (16)
cd desktop && node --test electron/gitStatus.test.cjs electron/gitOperations.test.cjs
  → # tests 44 / # pass 43 / # fail 1（已知环境差异：本机全局 git 身份，主工作区同样失败）
cd desktop && node --test electron/zz-r3-probe.test.cjs
  → # tests 10 / # pass 10 / # fail 0
cd desktop && npx vitest run src/composables/zz-r3-probe.test.ts
  → Test Files 1 passed (1) / Tests 6 passed (6)
cd desktop && npx vitest run
  → Test Files 144 passed (144) / Tests 1374 passed (1374)
cd desktop && node --test electron/*.test.cjs
  → # tests 152 / # pass 149 / # fail 2（均为本机存量环境差异，主工作区同样失败：
     gitOperations「commit stages all changes」= 全局 git 身份；localShell「keep_session」= macOS /var→/private/var）
对照主工作区（未改动）复跑两个失败文件 → 同样各失败 1 例，确认环境差异而非本 feature 引入
```
