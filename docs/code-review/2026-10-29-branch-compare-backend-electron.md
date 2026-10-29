# 代码审查报告：Git 分支对比（CLOUD 后端 + Electron/LOCAL 侧）

- 审查对象：worktree `.worktrees/git-branch-compare`（分支 `feature/git-branch-compare`，基于 main `0f136b32`）未提交改动中的**后端与 Electron 侧**文件：
  - `backend-ts/src/file/workspace-git.service.ts`（`compareBranches` / `compareBranchFileDiff` / `resolveBranchSha` / `isValidBranchRefName` / `firstObjectId`）
  - `backend-ts/src/file/file.routes.ts`（两个新 GET 端点）
  - `backend-ts/src/file/workspace-git.service.spec.ts`、`backend-ts/src/file/file.routes.spec.ts`
  - `desktop/electron/gitStatus.cjs`（`getGitBranchCompare` / `getGitBranchCompareFileDiff` / `isValidBranchName` / `resolveBranchSha`）、`desktop/electron/gitStatus.test.cjs`
  - `desktop/electron/main.cjs`（`git-branch-compare` / `git-branch-compare-file-diff` 两个 IPC 注册）、`desktop/electron/preload.cjs`、`desktop/src/types/electron.d.ts`
- 对照方案：`docs/plan/2026-10-29-git-branch-compare-technical-design.md`（**主检出最新修订版 406 行**，含 D13「单文件 diff 的 before 端取 merge-base」）
- 审查日期：2026-10-29
- 修订：**第 1 轮复查（2026-10-29）**——开发者已按本报告「建议 1」修复 LOCAL >2 MiB 静默空 diff（`gitStatus.cjs` 新增 `overflowed` 字段 + 单文件 diff 判定 + 新用例），本轮复核修复正确性、既有调用方零影响、新用例守卫有效性（含变异验证）；结论：**建议 1 已修复并通过复查，无新问题**（详见 §二 复查记录）。
- 审查方式：①逐行走读上述文件全部新增 hunk；②跑仓库既有回归（后端 `src/file`、Electron `gitStatus.test.cjs`、后端 `npm run build`）；③写临时探针（fuzz 差分对跑、criss-cross 真实仓库、>2MiB 大文件、空文件 / 二进制 / 改名 / 文件↔目录 typechange 等）实测行为，验证后按约定删除；④对 10 条关键不变量逐条取证；⑤第 1 轮复查：修复前后判定对照（在 `/tmp` 副本上还原旧判定做 A/B）、CLOUD↔LOCAL 逐字节对齐、变异验证新用例、全量 Electron 回归。

## 一、总体结论

**无阻塞项，未发现本次需求开发引入的功能性 bug（0 条阻塞 / 0 条重要）。可以合并。**

- 10 条关键不变量（三点语义、before=merge-base、两段式 ref 解析 + 下游全用 sha、错误契约、warning 容忍、空差异 ≠ 失败、新路径契约、分支名校验、路由守卫、LOCAL 契约与 `timedOut`）**逐条实测成立**，证据见 §三。
- 另有 **1 条建议级观察（非阻塞、非本次引入）**：LOCAL 单文件 diff 在文件 > 2 MiB 时静默返回空内容，而 CLOUD 同场景返回截断内容 —— 见 §二。该行为与其模板函数 `getGitCommitFileDiff` 完全一致（属既有执行器 maxBuffer 既有行为），不影响本次功能判定。**该条已由开发者修复，并经第 1 轮复查确认（修复正确、范围最小、既有调用方零回归、新用例经变异验证有效）→ 已关闭。**

---

## 二、建议级（1 条，非阻塞；非本次引入）—— **已修复 · 第 1 轮复查通过**

### 建议 1【已修复】：LOCAL（Electron）分支对比的单文件 diff 在文件 > 2 MiB 时静默返回空内容，与 CLOUD 行为不一致

**位置**：`desktop/electron/gitStatus.cjs`（`getGitBranchCompareFileDiff` 的两次 `git show`；**以下为修复前代码，留作历史**，修复后的判定见本节末尾「复查记录」，现位于 `:1085-1086`）

```js
const before = await runGit(repoRoot, ['show', `${mergeBaseSha}:${beforePath}`])
const after = await runGit(repoRoot, ['show', `${targetSha}:${normalized}`])
const beforeContent = before.exitCode === 0 ? before.stdout : null
const afterContent = after.exitCode === 0 ? after.stdout : null
```

**问题描述**：`runGit`（同文件 `:16-48`）用 `execFile` + `maxBuffer: MAX_STDOUT_BYTES`（2 MiB，`:8`、`:30`）。文件内容超过 2 MiB 时 Node 以 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 杀掉子进程，`runGit` 把 `err.code`（字符串）折成 `exitCode = 1`（`:37`），于是 `beforeContent` / `afterContent` 双双为 `null`：`changeType` 退化成 `MODIFIED`、`beforeContent` / `afterContent` 均为 `''`、`truncated` 为 `false`、**且不带 `unavailableReason`**（`:1078-1090`）。UI 侧（`diffMode = binary || unavailableReason ? 'UNSUPPORTED' : 'SNAPSHOT'`）会按正常 SNAPSHOT 渲染 → **用户看到「没有任何改动」的空 diff**，而清单里明明列着该文件。

**与方案的契约冲突**：
- 方案 §5.5 对 LOCAL 的失败契约明确写「超限 → `truncated`」，§2.1 要求「LOCAL 与 CLOUD 行为一致（UI 经 provider 无感知）」；
- CLOUD（`runGitRaw` 静默截到 2 MiB 且退出码仍为 0）→ `truncateText` 截到 512 KiB 并置 `truncated: true`，内容非空。实测两端同场景输出不同（见复现证据），即本项不满足「双模式一致」。

**复现证据（真实存在，非推断）**：

1) Electron 侧直接调用（`node`，临时探针，已删）：仓库 `main` 与 `feature` 都改写同名大文件后比对：

```
$ node /tmp/probe-bigfile.cjs
--- LOCAL execFile maxBuffer behavior (raw git show) ---
small.txt: size=102400  execFile errCode=null                          stdoutBytes=102400
mid.txt:   size=1048576 execFile errCode=null                          stdoutBytes=1048576
big.txt:   size=3145728 execFile errCode=ERR_CHILD_PROCESS_STDIO_MAXBUFFER stdoutBytes=2097152
edge2m.txt:size=2097152 execFile errCode=null                          stdoutBytes=2097152
--- getGitBranchCompareFileDiff (NEW) ---
small.txt:   changeType=MODIFIED truncated=false beforeLen=102400 afterLen=102400
mid.txt:     changeType=MODIFIED truncated=true  beforeLen=524288 afterLen=524288
big.txt:     changeType=MODIFIED truncated=false beforeLen=0      afterLen=0        ← 静默空 diff
edge2m.txt:  changeType=MODIFIED truncated=true  beforeLen=524288 afterLen=524288
--- getGitCommitFileDiff (EXISTING, 同款模板) ---
big.txt:     changeType=MODIFIED truncated=false beforeLen=0      afterLen=0        ← 与既有函数完全一致
```

2) CLOUD 同场景（临时 vitest 探针，已删；`MAO_TEST_TMP_DIR=/tmp/rv-big`）：

```
CLOUD >2MiB: {"changeType":"MODIFIED","truncated":true,"beforeLen":524288,"afterLen":524288}   （断言通过）
```

即：**同一仓库、同一文件，CLOUD 显示「已截断的前 512 KiB 内容」，LOCAL 显示空 diff 且无任何提示。**

**修复建议（择一，注意不要引入新语义）**：
- 让 LOCAL 的 `runGit` 在 `err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` 时**保留已收到的 stdout 片段**并标记 `truncated`（`execFile` 回调里 stdout 已有 2 MiB 内容，见上「stdoutBytes=2097152」），使 LOCAL 与 CLOUD 同为「截断内容 + `truncated: true`」；
- 或退一步：该分支显式返回 `unavailableReason: '文件过大，无法预览'`（前端会走 `UNSUPPORTED` 降级），至少不再静默显示空 diff。

**性质声明（避免误判为本次引入）**：该行为与既有 `getGitCommitFileDiff`（`gitStatus.cjs:845-848`）逐行同构，属既有执行器 + 既有模板行为，**不是本次改动引入、也不是回归**；临时探针实测两者在大文件场景输出完全一致。列出的理由是：新功能新路径同样受影响，且方案 §5.5 对 LOCAL 写明了「超限 → truncated」。是否本轮修复可自行决定。

#### 复查记录（第 1 轮，2026-10-29）：**已修复，复查通过**

**修复内容（`gitStatus.cjs` 三处，均为增量；未改动任何既有字段语义）**

1. `runGit` 回调新增 `overflowed: Boolean(err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')`（`:44`，注释 `:41-43`）；`child.on('error')` 分支补 `overflowed: false`（`:49`）。`exitCode` / `stdout` / `stderr` / `timedOut` 四个既有字段的表达式逐字未变。
2. `getGitBranchCompareFileDiff` 两次 show 的判定改为 `before.exitCode === 0 || before.overflowed ? before.stdout : null`（`:1085`）、after 同（`:1086`，注释 `:1082-1084`）——溢出时保留预算内已收集的 2 MiB → `truncateText` → 512 KiB + `truncated=true`。
3. `gitStatus.test.cjs:738-753` 新增用例「branch compare file diff truncates >2MiB files instead of returning an empty diff」（3 MiB 单行文件；断言 `truncated=true`、两侧内容长度 = 512×1024、首字符 a/b、`unavailableReason === undefined`）。

**A/B 对照实验（真值对齐；PRE = 在 `/tmp` 副本上还原旧判定，POST = 当前工作区代码，同一仓库同一文件）**

| 用例 | PRE（修复前） | POST（修复后） |
|---|---|---|
| `oneside.txt`（base 5 B / target 3 MiB） | `type=DELETED`、after=''（**changeType 判错**） | `type=MODIFIED`、after=524288、`truncated=true` ✓ |
| `bin-big.dat`（两侧均 >2 MiB 二进制，含 NUL） | MODIFIED、空内容、**无 binary 标记** | `binary=true` + 「二进制文件，无法预览」 ✓ |
| `bothbig.txt`（两侧均 3 MiB 文本） | MODIFIED、空内容、`truncated=false` | `truncated=true`、两侧 524288、首字符 A/B ✓ |
| `small.txt`（100 KiB） | 内容逐字节完整、`truncated=false` | 与 PRE 完全一致（未变）✓ |
| `mid.txt`（1 MiB） | `truncated=true`、524288 | 与 PRE 完全一致（未变）✓ |
| `edge2m.txt`（**恰好 2 MiB**；实测 `execFile` 此时 `errCode=null`，不触发溢出） | `truncated=true`、524288 | 与 PRE 完全一致（未变）✓ |

CLOUD↔LOCAL 逐字节对齐（临时 vitest 探针实测，`MAO_TEST_TMP_DIR=/tmp/rv-align`）：

```
CLOUD: {"t":true,"b":524288,"a":524288}      # workspace-git.service.compareBranchFileDiff
LOCAL: {"t":true,"b":524288,"a":524288}      # gitStatus.getGitBranchCompareFileDiff
断言：两侧内容 === 同一 blob 前 512 KiB，且 LOCAL === CLOUD 逐字节成立（test passed）
```

**既有调用方零影响（逐条取证）**

- `overflowed` 全仓仅被 `:1085-1086` 消费（`grep -rn overflowed desktop/electron desktop/src` → 仅 4 处，全部在本次修复内）；未进入任何 IPC 返回值 / DTO / `preload.cjs` / `electron.d.ts`。
- `timedOut` 表达式未改（`:40`）；实测 maxBuffer 溢出时 `err.killed === undefined`（探针 `/tmp/probe-fix-verify.cjs` 观测）→ **`timedOut` 仍为 `false`**，不会污染既有 `timedOut` 消费点（`gitStatus.cjs:503`、`:966`、`:1076`）与 `gitOperations.cjs` 自己的独立 runner（该文件的 `runGit` 实现与本次无关，未改动）。
- `runGitOk`（`:54-57`）仍按 `exitCode !== 0` 折 null（溢出时 exitCode=1）→ 其它读取方法的失败语义不变。
- 既有 `getGitCommitFileDiff`（不消费 `overflowed`）实测行为与修复前完全一致：`big3m.txt` 仍 `truncated=false` + 内容长度 0（按本次修复范围**有意保留**）。
- `gitOperations.cjs` 仅从 gitStatus 取 `resolveRepoDir / collectChangedFiles / selectFetchRemote`，不取 `runGit`。

**新用例守卫有效性（变异验证，全部在 `/tmp` 副本上进行，工作区未被改动）**

```
orig（原样副本）                        → # tests 36 / # pass 36 / # fail 0
变异 A：去掉 `|| before.overflowed`      → not ok 36（新用例失败）→ 守卫有效
变异 B：`overflowed: false`（检测失效）  → not ok 36（新用例失败）→ 守卫有效
变异 C：`overflowed: Boolean(err)`（过宽）→ 既有 2 例失败（created/deleted、rename 用例）
        → 守卫是「窄条件」，不会被悄悄扩成「任何 show 失败都算成功」
```

**回归（本机实跑）**

```
desktop $ node --test electron/gitStatus.test.cjs  → # tests 36 / # pass 36 / # fail 0
desktop $ node --test electron/*.test.cjs          → # tests 171 / # pass 169 / # fail 1
          唯一失败 = `commit stages all changes, skips hooks and injects identity only for the command`
          （gitOperations.test.cjs，已知基线失败：本机全局 git 身份，与本次修复无关）
backend-ts：本轮修复未触及后端，未复跑（第 1 轮基线 src/file 全绿）
```

**残留观察（1 条，不构成 bug，不阻塞）**：`overflowed` 的判定条件是「stdout+stderr **共享预算**耗尽」，严格说不等价于「stdout 被截断」——实测 stderr 超限而 stdout 完整时同样 `overflowed=true`（`stdout='x'` 原样保留，内容不失真）。当前两处消费点都是 `git show`（stderr 实际为空），不会误触发；若未来把该字段用于可能产生大量 stderr 的命令，需按「内容完整性未定」处理。

**复查结论：修复正确、范围最小（仅 2 个文件）、既有行为零回归、新用例经双向变异验证有效；建议 1 关闭，无新增问题。**

---

## 三、关键不变量逐条核对与证据（全部成立）

| # | 不变量 | 核对结果与证据 |
|---|---|---|
| 1 | 三点语义 `A...B`（merge-base 基准） | `workspace-git.service.ts:534`（rev-list）、`:551-554`（numstat/name-status），`gitStatus.cjs:965`（rev-list）、`:971,973`（diff）全部使用 `${baseSha}...${targetSha}`；实测分叉仓库 ahead/behind 与 `git rev-list --left-right --count` 真值一致（临时 fuzz，12 + 10 轮随机历史，见 §五） |
| 2 | 单文件 diff before = merge-base 对象内容 | CLOUD `workspace-git.service.ts:646,650-651` / LOCAL `gitStatus.cjs:1075-1077` 取 `mergeBaseHash`；实测「双方分叉且都改同一文件」before=`merge-base` 内容而非 base tip（既有用例 + 临时 fuzz 与 `git cat-file -p <mb>:<path>` 逐字节比对） |
| 3 | 两段式 ref 解析、下游一律用 sha | `workspace-git.service.ts:812-820` / `gitStatus.cjs:915-925`：显式 `refs/heads/` → `refs/remotes/`，解析出 sha 后 merge-base / rev-list / diff / show 全传 sha（实测同名 tag 遮蔽场景仍然命中分支，与既有用例一致；远端跟踪 `origin/x` 实测命中第二段） |
| 4 | 错误契约 | 实测：ref 不存在 / 非法名 → 「分支不存在」；无共同祖先 → 「两个分支没有共同祖先，无法对比」（exitCode==1 判定）；其余失败 → 「对比失败，请重试」。LOCAL 侧非法名先于仓库解析（非 git 目录下仍报「分支不存在」） |
| 5 | 合并流 warning 容忍 | 真实 criss-cross 仓库实测合并流首行为 `warning: a...b: multiple merge bases, using 867b0916…`；计数按 `^\d+\s+\d+$` 取最后一行、name-status/numstat 按行安全跳过 → service 输出 `{"aheadCount":1,"behindCount":1,"files":[{"path":"b.txt","changeType":"CREATED","insertions":1,"deletions":0}]}` 与 `git diff --name-status a...b` 真值一致 |
| 6 | 合法空差异 ≠ 命令失败 | 先 verify 再 diff；空输出返回 `files: []`（target 落后 base / 自比 两场景实测）；失败路径均由 `exitCode !== 0` / `runGitOk === null` 拦下并抛错 |
| 7 | `file.path` 为新路径；`oldPath` 可选 | 实测改名行返回 `path=src/b.txt, oldPath=src/a.txt, changeType=RENAMED`，单文件 diff 的 `path` 恒为新路径 |
| 8 | 只读侧分支名校验（首字符非 `-` 等） | `workspace-git.service.ts:155-162`（CLOUD）/ `gitStatus.cjs:887-897`（LOCAL）同规则；实测 `-x`、`a..b`、`a~b`、`a@{b`、`/a`、`a/`、`a//b`、`.a`、`a.lock`、`@`、201 字符全部拒绝；真实分支 `feature/x-1_2.3` 未被误伤 |
| 9 | 路由 CLOUD + 归属校验 + PARAM_MISSING | `file.routes.ts:322-344` 两端点均走 `requireOwnedCloudGitSession`（LOCAL 会话实测拒绝、message 含「本地模式不支持」）；`base`/`target`/`path` 缺失 → 「缺少必要参数」；`repoPath` 透传位置正确（第 2 参） |
| 10 | Electron 失败 throw / IPC 转换 / `timedOut` 不冒充无共同祖先 | `getGitBranchCompare` 各失败点 throw（`gitStatus.cjs:963-974`，main.cjs 转 `{error}`）；`getGitBranchCompareFileDiff` 输入类失败返回降级对象（含 `unavailableReason`）；两处均在 `exitCode === 1` 判定**之前**拦 `timedOut`（`gitStatus.cjs:962`、`:1072`） |

补充核对（易漏点，均已确认正确）：

- **多仓库 / repoPath**：`getGitBranchCompare(workspace, repoPath, base, target)` 与路由 `compareBranches(workspace, repoPath, base, target)` 参数位正确；临时探针实测 `repoPath='sub'` 时请求打到子仓库且结果正确。
- **IPC 链路**：`main.cjs` 顶部 `require('./gitStatus.cjs')` 解构已加入两个新函数（无遗漏、无重复注册）；`preload.cjs` 与 `electron.d.ts` 方法名、参数顺序与主进程解构一致；`git-branch-compare` → `{error}`、`git-branch-compare-file-diff` → 降级 diff 对象，形状与既有 `git-commit-files` / `git-commit-file-diff` 相同。
- **`firstObjectId`**：只认整行 40/64 位 hex，warning 行（含 `using <sha>` 形态）不会被当对象 id；`compareBranchFileDiff` 的 `mergeBase.exitCode !== 0 || hash == null` 先行判失败。
- **空文件边界**：`git show` 成功但内容为空 → `''`（`!= null`），不会被误判成 `CREATED`/`DELETED`（实测 `to-empty.txt` 改写为空后 `changeType=MODIFIED`、`after=''`）。

基线回归（本机实跑，全绿）：

```
cd backend-ts && MAO_TEST_TMP_DIR=/tmp/rv-a-tmp npx vitest run src/file
  → Test Files 8 passed (8) / Tests 123 passed (123)
cd backend-ts && npm run build
  → tsc -p tsconfig.build.json 通过（无错误）
cd desktop && node --test electron/gitStatus.test.cjs
  → # tests 36 / # pass 36 / # fail 0        （第 1 轮复查后，新增 >2MiB 用例）
```

## 四、已排除的疑点（避免后续重复报告）

1. **文件被目录替换（typechange）时 `git show <sha>:<dir>` 退出码 0、返回 tree 列表**：实测 `D a` 行的单文件 diff 会显示 `"tree work:a\n\nb.txt\n"` 而非空内容 —— 属 git 语义边界（`git show` 对 tree 的行为），且既有 `getGitCommitFileDiff` 同款，非本次引入；同理含「10s/60s 超时把 show 折成 null → changeType 退化」一类，均为既有模板行为。
2. **criss-cross 多 merge base 的 warning 混入合并流**：CLOUD 合并流（`runGitRaw` 合 stdout+stderr）实测首行为 `warning: a...b: multiple merge bases, using <sha>`，解析全部正确跳过；`git merge-base`（默认）与 `git diff A...B` 选择的 base 实测为同一 sha，清单与单文件 diff 自洽。
3. **非 ASCII / 含空格文件名**：两端均带 `-c core.quotepath=false`，实测 `src/中文 文件.txt`、`src/新 名字.txt`、`f1 3.txt` 路径键与统计均正确对齐（注意：外部真值对比时若未带该参数，git 会输出 `\344\270\255` 引号形态，属对比方式差异，非代码问题）。
4. **类外字符分支名**（`feat+plus`、`中文分支`、`feat@x`、`feat%z` 等 git 允许的名字）被拒为「分支不存在」：方案 §5.3 已明确声明为「与 switch 侧同款的已知限制，接受」，不计为 bug。
5. **改名统计（花括号紧凑形态 `src/{a.txt => b.txt}`）**：临时 fuzz 以 `git diff --numstat -z A...B`（NUL 分隔、无紧凑形态）为独立真值，12 + 10 轮随机历史（改 / 删 / 改名 / 跨目录改名 / 改名后编辑 / 空文件 / 二进制 / 含空格与非 ASCII 名）逐条比对 path、insertions、deletions **全部一致**。
6. **单文件 before/after 独立性**：临时 fuzz 对每一行用 `git cat-file -p <mb>:<oldPath ?? path>` / `<target>:<path>` 作真值逐字节比对，含 rename（传 oldPath）、空文件、二进制（正确走 `binary` 降级）**全部一致**。

## 五、审查方法与临时物清理

- 临时探针（均已删除，未提交、未改动任何已跟踪文件）：
  - `backend-ts/src/file/__review_probe.spec.ts`（criss-cross 端到端、30 文件混合状态、空文件/二进制/模式变更、文件↔目录 typechange、非法分支名与 `check-ref-format` 对照）
  - `backend-ts/src/file/__review_fuzz.spec.ts`、`__review_fuzz2.spec.ts`（随机历史差分对跑：`--numstat -z` 真值 + `cat-file` 真值）
  - `backend-ts/src/file/__review_big.spec.ts`（CLOUD > 2 MiB 截断行为）
  - `/tmp/probe-bigfile.cjs`、`/tmp/probe-remote.cjs`（Electron 侧真实仓库探针：remote-tracking 端点、repoPath、> 2 MiB、坏 repoPath 抛错）
- 第 1 轮复查新增临时物（均已删除）：
  - `/tmp/probe-fix-verify.cjs`（修复后 >2 MiB / 单侧超限 / 超大二进制 / 既有 commit-diff 回归 / 与 CLOUD 前缀一致性）
  - `/tmp/probe-prepost.cjs` + `/tmp/mut-orig|mut-a|mut-b|mut-c`（`/tmp` 副本上还原旧判定做 PRE/POST 对照；变异 A/B/C 验证新用例守卫；工作区源码与测试未被改动）
  - `backend-ts/src/file/__review_align.spec.ts`（CLOUD↔LOCAL >2 MiB 内容逐字节对齐）
- 审查结束后 `git status --porcelain` 与审查前一致（仅原有 26 个 `M` 文件 + 既有未跟踪项；本次仅新增本报告文件），无残留探针文件。注：`desktop/src/composables/__reviewtmp_precheck.test.ts`、`desktop/src/components/git/__reviewtmp_compare_error.test.ts` 为**另一位 reviewer（前端侧）**的临时文件，不在本报告审查/清理范围内。
