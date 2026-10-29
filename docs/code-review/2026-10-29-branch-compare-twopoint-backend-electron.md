# 代码审查报告：Git 分支对比「三点 → 两点」语义改造（CLOUD 后端 + Electron/LOCAL 侧）

- 审查对象：worktree `.worktrees/git-branch-compare-twopoint`（分支 `feature/git-branch-compare-twopoint`，基线 `main` = `594a3046`「三点版」）**未提交改动**中的后端与 Electron 侧文件：
  - `backend-ts/src/file/workspace-git.service.ts`（`compareBranches` / `compareBranchFileDiff`）
  - `backend-ts/src/file/workspace-git.service.spec.ts`
  - `desktop/electron/gitStatus.cjs`（`getGitBranchCompare` / `getGitBranchCompareFileDiff`）
  - `desktop/electron/gitStatus.test.cjs`
  - 只读参考：`file.routes.ts`、`main.cjs`、`preload.cjs`、`electron.d.ts`（本轮未改，已核）。
- 审查基准：本次任务给出的 8 条两点语义规格（下文 §三 逐条取证）。
- 审查日期：2026-10-29。
- 修订：**第 1 轮复查（2026-10-29）**——开发者已按「建议 1」为 CLOUD 侧两次 `git show` 补 `timedOut` 守卫（改用模块级 `runGitRaw` + 抛「对比失败，请重试」）。本轮复核：修复正确、真超时不再静默、CREATED/DELETED/rename/二进制/截断等既有语义零回归、与 LOCAL 侧目标一致；结论：**建议 1 已修复并通过复查，无新问题**（详见 §二 复查记录）。另新增 1 条非阻塞「测试覆盖」建议（建议 2）。
- 审查时的文件指纹（md5；复查后 `workspace-git.service.ts` 因修复变更为 `ac50c3fa79719c052d989916df294889`，其余三个文件与首轮一致）：
  - `workspace-git.service.ts` = `a65478795ea38108b5153e98427478ea`（首轮）→ `ac50c3fa79719c052d989916df294889`（第 1 轮复查后）
  - `workspace-git.service.spec.ts` = `3c806bbc26dc5065eac6396834a033d2`
  - `gitStatus.cjs` = `ff38a6f66ca6417baebceb23c7af414f`
  - `gitStatus.test.cjs` = `340db213c494b6b76c258ee77c1740a0`
  - 注：审查期间同一 worktree 有并发写入（`backend-ts/src/file/file.routes.spec.ts` 于 15:28 被他人改为注释同步，与本报告四个文件无关）；上述四个文件指纹全程未变。
- 审查方式：①逐行走读全部新增/删除 hunk；②跑既有回归（后端 `src/file` + `npm run build`、Electron `gitStatus.test.cjs` + 全量 `electron/*.test.cjs`）；③差分对跑探针（真实仓库、独立 `git -z` 真值 vs 双端实现，8 组 ref 对）；④CLOUD↔LOCAL 逐字节对齐；⑤`execFile` 错误形态探针（超时 / maxBuffer 的 `err.killed`/`err.code`）；⑥真超时端到端（假 `git` 挂起）；⑦两点语义新增的「单侧 >2 MiB」组合；临时探针/spec 全部删除，未改动任何已跟踪文件。

## 一、总体结论

**未发现本次改造引入的功能性 bug：0 条阻塞 / 0 条重要。**

- 8 条两点语义规格**逐条实测成立**（含「空格分隔两 sha」「无 merge-base 调用」「before 取 base tip」「先 verify 再 diff」「两段式 ref 解析」「无共同祖先不报错」「>2 MiB 成功+截断」「真超时不静默」），证据见 §三。
- 首轮提出的 **1 条建议级观察（非阻塞、非本次引入）**——CLOUD 侧 `git show` 超时被当作「对象不存在」静默渲染成空 diff ——**已由开发者修复，并经第 1 轮复查确认（修复正确、双端一致、既有语义零回归）→ 已关闭**（见 §二 复查记录）。该条本不是回归（基线三点版同样存在），列出理由是：首轮为 LOCAL 补了守卫使两端不一致，且与规格「其它执行失败 → 对比失败，请重试」不符。
- 复查后新增 **1 条非阻塞建议（建议 2，测试覆盖）**：新守卫目前无既有用例锁定（`workspace-git.service.spec.ts` 未改），删掉守卫套件仍全绿，建议补一条「超时 → 对比失败，请重试」的回归用例。

## 二、建议级（2 条，非阻塞）

### 建议 1【已修复 · 第 1 轮复查通过】：CLOUD 单文件 diff 的 `git show` 超时被折成「对象不存在」，静默返回空 diff（LOCAL 侧本轮已修，两端不一致）

**位置**
- `backend-ts/src/file/workspace-git.service.ts:646-647`（**修复前**的行号；修复后该处为 `:649-657` 的 `runGitRaw` + `timedOut` 守卫）——两次 `git show` 走 `runGitOk`：
  ```ts
  const beforeRaw = await this.runGitOk(repoRoot, ['show', `${baseSha}:${beforePath}`]);
  const afterRaw  = await this.runGitOk(repoRoot, ['show', `${targetSha}:${normalized}`]);
  ```
- `backend-ts/src/file/workspace-git.service.ts:986-989`——`runGitOk` 对一切非零退出折 `null`，不区分超时；
- `backend-ts/src/file/workspace-git.service.ts:1239-1242`——`runGitRaw` 超时返回 `{ exitCode: 124, stdout: '', timedOut: true }`；
- 对照 `desktop/electron/gitStatus.cjs:1084`（本轮新增守卫）：
  ```js
  if ((before.timedOut && !before.overflowed) || (after.timedOut && !after.overflowed)) {
    return degraded('对比失败，请重试', normalized)
  }
  ```

**问题描述**：CLOUD 侧 `git show` 一旦超时（`GIT_TIMEOUT_SECONDS = 10`，见 `:8`），`runGitOk` 把 `exitCode === 124` 折成 `null`，与「对象在树中缺失（128）」不可区分，于是 `changeType` 退化为 `MODIFIED`、`beforeContent`/`afterContent` 均为 `''`、**且不带 `unavailableReason`**。UI（`diffMode = binary || unavailableReason ? 'UNSUPPORTED' : 'SNAPSHOT'`）会按正常快照渲染 → 用户看到「没有任何改动」的空 diff，而清单里明明列着该文件。LOCAL 侧同一场景返回 `unavailableReason: '对比失败，请重试'`。

这正好是本轮 `gitStatus.cjs:1081-1084` 注释所写「不能静默渲染成空 diff」的同一类问题，只是落在另一侧执行器上。

**复现证据（真实执行，探针已删）**

1）假 `git`（只让 `git show` 挂起，其余命令透传）：

```sh
mkdir -p /tmp/fakegit && cat > /tmp/fakegit/git <<'EOF'
#!/bin/sh
for a in "$@"; do [ "$a" = "show" ] && exec /bin/sleep 90; done
exec /git 真实路径 "$@"
EOF
chmod +x /tmp/fakegit/git
```

2）同一仓库、同一文件（`main` 与 `feat` 都改了 `both.txt`，正常结果 before=`v-main\n` / after=`v-feat\n`）：

CLOUD（临时 vitest 用例，`process.env.PATH = '/tmp/fakegit:' + PATH`，两段各 10s 超时）：

```
{
  "normal":  { "changeType": "MODIFIED", "before": "v-main\n", "after": "v-feat\n" },
  "timeout": { "elapsedMs": 20022, "path": "both.txt", "changeType": "MODIFIED",
               "beforeContent": "", "afterContent": "" }        ← 无 unavailableReason、不抛错
}
```

LOCAL（同一仓库、同一参数，60s × 2 超时）：

```
NORMAL  : {"changeType":"MODIFIED","before":"v-main\n","after":"v-feat\n"}
TIMEOUT : {"elapsedMs":120097,"path":"both.txt","changeType":"MODIFIED","beforeContent":"","afterContent":"","unavailableReason":"对比失败，请重试"}
```

即：**同一失败，CLOUD 静默空 diff，LOCAL 明确降级**。

**影响**：极端但真实（`show` 单次 >10s：冷缓存的大仓库、网络盘、机器高负载）时，CLOUD 用户在清单里点开文件得到「没有改动」的假象，无任何错误提示；同一功能在 LOCAL 模式却能正确提示「对比失败，请重试」——两种执行模式的失败语义不一致。

**修复建议（择一，注意不要改变既有语义）**
- 把两次 `git show` 改用已导出的 `runGitRaw`（可读 `timedOut`）：`timedOut === true` → `throw new BusinessException(ErrorCode.PARAM_INVALID, '对比失败，请重试')`；`exitCode !== 0` 且非超时仍按「对象缺失」处理（保持 CREATED/DELETED 既有语义不变）；`exitCode === 0` 才取内容。
- 或最小改动：新增一个 `runGitShow` 包装（`runGitRaw` + 上面三条判定），`compareBranchFileDiff` 复用。
- 建议同时补一条用例：假 `git`（或把 `GIT_TIMEOUT_SECONDS` 注入化后用一个 sleep 包装）验证「超时 → `对比失败，请重试`」「对象缺失 → CREATED/DELETED 不变」。

**性质声明（避免误判为本次引入）**：基线三点版 `compareBranchFileDiff` 的两次 show 同样是 `runGitOk`，超时同样被折成 null；本轮只是把 `before` 的 ref 从 merge-base 换成 base tip，**并没有新增或加重**该静默路径。列出的理由是：本轮为 LOCAL 同场景补了守卫（LOCAL 从「静默空 diff」变为「明确报错」），两端因此不一致，且规格 §错误契约要求「其它执行失败 → 对比失败，请重试」。

#### 复查记录（第 1 轮，2026-10-29）：**已修复，复查通过（建议 1 关闭）**

**修复内容**（仅 `backend-ts/src/file/workspace-git.service.ts` 的 `compareBranchFileDiff` 一处；`grep -n merge-base` 复核无回退；`gitStatus.cjs` / 两个 spec 的 md5 与首轮完全一致 → 本地与测试侧未被顺带改动）

```ts
// 真超时必须与「对象缺失」区分：runGitOk 把一切非零退出（含超时 124）折成 null，…
const [beforeRaw, afterRaw] = await Promise.all([
  runGitRaw(repoRoot, ['show', `${baseSha}:${beforePath}`], GIT_TIMEOUT_SECONDS * 1000),
  runGitRaw(repoRoot, ['show', `${targetSha}:${normalized}`], GIT_TIMEOUT_SECONDS * 1000),
]);
if (beforeRaw.timedOut || afterRaw.timedOut) {
  throw new BusinessException(ErrorCode.PARAM_INVALID, '对比失败，请重试');
}
const beforeText = beforeRaw.exitCode === 0 ? beforeRaw.stdout : null;
const afterText = afterRaw.exitCode === 0 ? afterRaw.stdout : null;
```

**复查项 1：真超时不再静默（复跑首轮假 git 探针）**——`/mtt/fakegit/git`（仅精确 token `show` 挂起，`--show-toplevel` 等透传）+ 临时 vitest 用例：

```
C> 超时结果: {"elapsedMs":10084,"threw":true,"isBusinessException":true,"message":"对比失败，请重试","degradedObject":null}
```

对照首轮同场景（`{"elapsedMs":20022,…, "beforeContent":"","afterContent":""}` 静默空 diff）：现已抛 `BusinessException('对比失败，请重试')`；耗时由 ~20s 降到 ~10s，因为两次 show 改为**并行**（`Promise.all`），只等一个超时窗口。✓

**复查项 2：与 LOCAL 侧目标一致（同文案）**——LOCAL 本轮复跑（同仓库同文件，`mod.txt`：base `before\n` / target `after\n`）：

```
LOCAL NORMAL  : {"changeType":"MODIFIED","before":"before\n","after":"after\n"}
LOCAL TIMEOUT : {"elapsedMs":120099,"path":"mod.txt","changeType":"MODIFIED","beforeContent":"","afterContent":"","unavailableReason":"对比失败，请重试"}
```

端到端链路核对（CLOUD）：`BusinessException` → `app-hooks.ts:130-139`（`setErrorHandler`）→ `http-error.ts:68-82` 映射为 **HTTP 200 + `{code: PARAM_INVALID, message:'对比失败，请重试'}`** → desktop `api/index.ts:63-77` 在 `data.code !== 0` 时 `ElMessage.error(message)` 并 reject → `workspace-git-provider.ts:538-552` 捕获后返回 `unavailableReason: e.message` → `TaskView.vue:767-788` 渲染 UNSUPPORTED tab（`diffUnavailableReason` 即该文案）。**两端用户可见文案同为「对比失败，请重试」**；CLOUD 额外多一条 toast，与同端点其它错误（FORBIDDEN / 分支不存在）的既有表现一致，非本次新增差异。✓

**复查项 3：既有语义零回归**——同一临时 spec 一次性覆盖（3/3 通过；真值 = `git show <sha>:<path>` / `git show <sha>:<oldPath>`）：

```
A> mod.txt old=-   => MODIFIED beforeLen=5 afterLen=6        （before/after 逐字节 = cat-file 真值）
A> added.txt old=- => CREATED
A> del.txt old=-   => DELETED
A> ren2.txt old=ren.txt => RENAMED beforeLen=10 afterLen=10  （rename 传 oldPath：before 取 base 侧旧路径）
A> empty.txt old=- => MODIFIED beforeLen=0 afterLen=9        （空文件仍是 ''、不退化成 CREATED/DELETED）
A> bin.dat old=-   => MODIFIED binary=true reason=二进制文件，无法预览
A> ren2.txt old=-  => CREATED                                （不传 oldPath 的既有退化路径不变）
A> no-such.txt old=- => MODIFIED beforeLen=0 afterLen=0      （对象两边都缺失仍不算错误）
A> list = [["added.txt","CREATED","-"],["bin.dat","MODIFIED","-"],["del.txt","DELETED","-"],["empty.txt","MODIFIED","-"],["feat-big.txt","RENAMED","base-big.txt"],["mod.txt","MODIFIED","-"],["ren2.txt","RENAMED","ren.txt"]]
B> both-big: {"t":"MODIFIED","truncated":true,"b":524288,"a":524288,"head":["D","C"]}
B> base-big: {"t":"DELETED","truncated":true,"b":524288,"a":0,"head":"A"}      （仅 base 侧 >2 MiB：两点语义新增组合）
B> feat-big: {"t":"CREATED","truncated":true,"b":0,"a":524288,"head":"B"}      （仅 target 侧 >2 MiB）
B> bin-big:  {"t":"CREATED","binary":true,"reason":"二进制文件，无法预览"}        （>2 MiB 二进制）
```

>`runGitRaw` 的 2 MiB 静默截断特性（exitCode 仍 0）使截断路径与修复前完全一致：`truncated: true` + 512 KiB、不带 `unavailableReason`；`timedOut` 只在真超时（124）出现，两者互不干扰。✓

**复查项 4：回归实跑**

```
backend-ts $ MAO_TEST_TMP_DIR=/mtt npx vitest run src/file
  → Test Files 9 passed (9) / Tests 127 passed (127)   （124 既有 + 本次临时探针 3 条；探针已删）
backend-ts $ npm run build                            → tsc 通过（无错误）
```

**复查项 5：新守卫的测试覆盖（见建议 2）**——变异验证（在 `/mtt` 副本上进行，工作区源码未改）：把 `if (beforeRaw.timedOut || afterRaw.timedOut) { throw … }` 整段删除后，`src/file` 仍 **124/124 全绿**（即既有用例无法发现该回退）；同副本上运行本次探针则 test C 失败，并精确复现旧缺陷：

```
C> 超时结果（变异后）: {"elapsedMs":10009,"threw":false,"isBusinessException":false,"degradedObject":{"path":"mod.txt","changeType":"MODIFIED","beforeContent":"","afterContent":""}}
× C) 真超时…不再静默返回空 diff → expected { path: 'mod.txt', …(3) } to be null
```

**复查结论：修复正确、范围最小（单文件单函数、无附带改动）、双端文案一致、既有语义（CREATED/DELETED/RENAMED/二进制/截断/空文件/对象缺失不报错）零回归 → 建议 1 关闭，无新功能问题。**

### 建议 2（非阻塞，测试覆盖）：为「CLOUD `show` 超时 → 对比失败，请重试」补一条回归用例

**位置**：`backend-ts/src/file/workspace-git.service.spec.ts`（本轮未改）。
**问题**（已用变异验证，见复查项 5）：本轮新增的超时守卫 `workspace-git.service.ts:649-657`（判定在 `:653-655`）无任何既有用例覆盖——整段删除后 `src/file` 仍 124/124 全绿，该行为可被静默回退（回退即变回「超时 → 静默空 diff」）。
**影响**：仅测试可维护性，无功能影响（当前实现经探针实测正确）。
**建议**：仿 `gitStatus.test.cjs` 的 `>2 MiB` 用例思路补一条：假 `git`（仅 `show` 挂起）/ 或把 `GIT_TIMEOUT_SECONDS` 与执行器做成可注入，断言 `await expect(...).rejects` 且 message 含「对比失败，请重试」，并保留同仓同文件的正常用例断言（防止把「对象缺失」语义一起改坏）。注意单条用例耗时 ≈ 一个超时窗口（10s），建议配合可注入超时以免拖慢套件；本次探针的 C 段可直接作为该用例的骨架。

## 三、两点语义规格逐条核对与证据（全部成立）

| # | 规格 | 核对结果与证据 |
|---|---|---|
| 1 | 清单 = `git diff --numstat <base> <target>` + `git diff --name-status <base> <target>`（空格分隔，非 `...`） | `workspace-git.service.ts:554-555`、`gitStatus.cjs:979,981` 均为两参数形态；全仓 grep 三处 `...` 只剩 `rev-list`（`:535`、`gitStatus.cjs:972`，计数用）与无关的 `HEAD...@{upstream}` |
| 2 | 计数保留 `rev-list --left-right --count <base>...<target>`，left=behind、right=ahead | 两端命令与字段映射逐字一致（`：535-548`、`gitStatus.cjs:972-977`）；差分对跑 8 组 ref 对（含 target 全落后、unrelated、自比）与 `git rev-list --left-right --count` 真值一致 |
| 3 | before = `git show <base>:<oldPath ?? path>`（base tip），after = `git show <target>:<path>`；无 merge-base | `:649-657`（修复后：`runGitRaw` 两次 show + 守卫 `:653-655`；修复前为 `:646-647`）、`gitStatus.cjs:1079-1084`；两端 `grep -n "merge-base"` 仅剩注释，无调用；对跑探针用 `git show <sha>:<oldPath??path>` / `<target>:<path>` 作真值，**逐字节一致**（含 rename 传 oldPath、二进制、空文件） |
| 4 | 错误契约：ref 不存在/非法名 → 「分支不存在」；其它失败 → 「对比失败，请重试」；空输出=合法空列表；无共同祖先不报错 | 既有用例全绿（含 `-x`/`a..b`/未出生仓库/unrelated/自比）；实测 `git rev-list --left-right --count A...B` 与 `git diff A B` 对 unrelated histories 均成功（三点 `git diff A...B` 才报 `no merge base`），两端不再有「无共同祖先」分支（`grep 「共同祖先」` 仅剩注释）。首轮曾有的唯一例外「CLOUD `show` 超时静默」**已修复并经复查确认**（见 §二 复查记录） |
| 5 | 必须先 `rev-parse --verify` 两个 ref 再 diff | 两端 `resolveBranchSha` 先行，失败即「分支不存在」；空差异（`''`）与失败（`null` / `exitCode!==0`）在代码里天然区分，用例 `compareBranchesRejectsUnbornRepository` 与 `twin` 空列表用例各自锁定一侧 |
| 6 | 两段式 `refs/heads/` → `refs/remotes/`，下游一律用 sha | `:808-820`、`gitStatus.cjs:916-926`；对跑探针含 `origin/feat`（远端跟踪）与同名 tag 遮蔽用例，结果与分支 ref 真值一致 |
| 7 | >2 MiB 仍「成功+截断」；新增真超时守卫不误伤溢出、真超时不静默 | `gitStatus.cjs:1084` 守卫 + `:1090-1091` 溢出分支。①`execFile` 形态探针：maxBuffer 溢出 = `{ errCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', errKilled: undefined }` → `timedOut=false`、`overflowed=true`（守卫不触发）；真超时 = `{ errCode: null, errKilled: true, signal: 'SIGKILL' }` → `timedOut=true`（守卫触发）；②既有 >2 MiB 用例通过（双端都是 512 KiB + `truncated: true`，无 `unavailableReason`）；③两点语义**新增**的「单侧 >2 MiB」组合（仅 base 侧 / 仅 target 侧大文件）实测双端一致：`DELETED`/`CREATED` + `truncated` + 512 KiB；④真超时端到端（上表 §二 的 LOCAL 行）：`unavailableReason='对比失败，请重试'`，未静默 |
| 8 | DTO/返回结构不变；`file.path` 恒为新路径 | DTO 字段未变（仅注释）；对跑探针逐条比对 `path`/`oldPath`/`changeType` 与 `git diff -z` 真值，含 rename 双向（`main→feat` 得 `R ren-keep-feat.txt ← ren-keep-main.txt`，反向得相反方向），`path` 恒为 target 侧路径 |

**差分对跑摘要**（真实仓库；独立真值 = `git diff -z --name-status` / `-z --numstat` + `git show <sha>:<path>`；`C/D/M/R` 为 CREATED/DELETED/MODIFIED/RENAMED 缩写）：

```
[main→feat]        ahead=1 behind=1 files=10 :: M:bin-common.dat M:both.txt C:del-common.txt M:empty-common.txt C:feat-only.txt D:main-only.txt R:ren-keep-feat.txt<-ren-keep-main.txt R:rename-b.txt<-rename-b2.txt R:rename-t2.txt<-rename-t.txt C:src/中文 文件.txt
[feat→main]        ahead=1 behind=1 files=10 :: （同集合，方向翻转：D:del-common.txt C:main-only.txt R:ren-keep-main.txt<-ren-keep-feat.txt …）
[main→main]        ahead=0 behind=0 files=0
[main→ancestor]    ahead=0 behind=1 files=6  :: D:main-only.txt R:ren-keep.txt<-ren-keep-main.txt …
[ancestor→feat]    ahead=1 behind=0 files=6
[main→orphan]      ahead=1 behind=2 files=9  :: D:README.md D:bin-common.dat … C:orphan.txt
[orphan→main]      ahead=2 behind=1 files=9  :: C:README.md … D:orphan.txt
[main→origin/feat] ahead=1 behind=1 files=10 :: （与 main→feat 完全一致）
→ 清单集合 / changeType / oldPath / insertions / deletions / binary 与真值 mismatch = 0；单文件 before/after 逐字节与 cat-file 真值一致
```

**CLOUD ↔ LOCAL 对齐**（同一仓库、同一 8 组 ref 对、同一批文件）：`ahead/behind`、清单集合、`changeType`、`oldPath`、`insertions/deletions`、`binary`、`beforeContent`/`afterContent`/`truncated`/`unavailableReason` **全部一致**（0 差异）。

**回归（实跑）**

```
backend-ts $ MAO_TEST_TMP_DIR=/mtt npx vitest run src/file
  → Test Files 8 passed (8) / Tests 124 passed (124)
backend-ts $ npm run build            → tsc 通过（无错误）
desktop     $ node --test electron/gitStatus.test.cjs  → 37 tests / 37 pass / 0 fail
desktop     $ node --test electron/*.test.cjs          → tests 172 / pass 170 / fail 1
              唯一失败 = gitOperations.test.cjs「commit stages all changes…」（已知基线：本机全局 git 身份，与本轮无关）
```

## 四、已排除的疑点（避免后续重复报告）

1. **超时守卫误伤 maxBuffer 溢出**：本机 Node 22.14 下溢出 `err.killed === undefined` → `timedOut=false`，`!overflowed` 为冗余保险；即便某 Node/Electron 版本溢出时置 `killed=true`，`!overflowed` 仍会排除 → 双向都不会误伤（变异式论证 + 既有 >2 MiB 用例实跑通过）。
2. **两点方向性（D14）**：base 侧独有改动呈现为 `D` / 反向 `M`，与 `git diff <base> <target>` 真值一致，属设计意图，不计为 bug。
3. **rename 退化**：base 侧已无 `oldPath` 时 before 取空 → `CREATED`（清单本身只给 `A` 新路径、不带 oldPath），两端一致，属已声明接受项。
4. **unrelated histories**：两端均可正常对比（清单为两棵树差异），无「无共同祖先」错误；`git rev-list --left-right --count A...B` 实测 stdout 只有 `left\tright`（criss-cross 的 `multiple merge bases` 警告只由三点 `git diff A...B` 发出），因此 LOCAL 的计数解析不受污染。附带：`workspace-git.service.ts:539-542` 注释称 criss-cross 下 `rev-list` 也会打该警告 —— 实测不成立，属注释表述偏差（过滤器本身是防御性的，无功能影响）。
5. **非 ASCII / 含空格路径、二进制、空文件、文件↔目录 typechange、同分支自比、祖先关系、远端跟踪 ref**：对跑均与真值一致；typechange 下 `git show <sha>:<dir>` 返回 tree 列表属 git 语义边界、与既有 `getCommitFileDiff` 同款，非本次引入。
6. **counts 的 warning 容忍 / 空差异 ≠ 失败**：两端分别用「正则取最后一行」与「stdout 独立流」处理，用例覆盖；失败路径（非零退出）两端都映射「对比失败，请重试」。
7. **CLOUD `--numstat/--name-status` 的 2 MiB 静默丢弃** 与 **LOCAL 的 2 MiB maxBuffer 溢出报错**：两端在大 diff 下行为不同，但方案 §5.5 已明确「2 MiB 超限接受、不特殊处理」，不计为本次 bug（两点语义会放大清单体量，属方案已声明的观察项）。
8. **`resolveBranchSha` 自身超时（10s）仍被映射为「分支不存在」**：它走 `runGitOk`（`runGitRaw` 折 null），超时与 ref 不存在不可区分；LOCAL 的 `resolveBranchSha`（`gitStatus.cjs:916-926`，读 `exitCode`）同样把超时当作「未解析」。两端行为一致、属既有执行器口径，且与本轮 show 守卫无关（不在本次修复范围）；如后续要收紧，可让 `resolveBranchSha` 也读 `timedOut`。

## 五、审查方法与临时物清理

- 首轮临时探针（**全部已删除**，未提交、未改动任何已跟踪文件）：
  - `backend-ts/src/file/__review_twopoint_align.spec.ts`（CLOUD↔LOCAL 8 组 ref 对逐字节对齐 + CLOUD vs 真值集合核对）
  - `backend-ts/src/file/__review_timeout_cloud.spec.ts`（CLOUD `show` 真超时行为记录）
  - `/mtt/twopoint-battery.cjs`（真实仓库构造 + LOCAL 与 `git -z` 真值对跑）
  - `/mtt/probe-timeout-local.cjs`（LOCAL 真超时端到端）、`/mtt/probe-one-sided-big{,2}.cjs`（单侧 >2 MiB）
  - `/tmp/probe-errshape.cjs`（`execFile` 的 timeout / maxBuffer 错误形态）
  - `/mtt/fakegit/git`（只让 `git show` 挂起的假 git）
- 第 1 轮复查临时物（**全部已删除**，工作区源码未改）：
  - `backend-ts/src/file/__review_r2_verify.spec.ts`（A 常规语义 vs `cat-file` 真值 / B >2 MiB 与二进制 / C 真超时抛错）
  - `/mtt/probe-r2-local.cjs`（LOCAL 侧同场景复跑，确认文案一致）
  - `/mtt/mut/backend-ts`（变异副本：`src` 从工作区复制、`node_modules` 软链、删除守卫 + 跑本次探针，用于验证「守卫无用例覆盖」与「探针有效」）
  - `/mtt/fakegit/git`（假 git：本轮按同样脚本重建后复用，现已删除；脚本内容见 §二 复现证据）
- 两轮审查结束后 `git status --porcelain` 均与本轮改动一致（15 个 `M` 文件，其中 `backend-ts/src/file/file.routes.spec.ts` 为他人并发修改的注释同步；未跟踪项还包含他人新增的 `desktop/src/components/git/GitCompareView.test.ts` 与既有 `backend-ts/node_modules`），本次仅新增本报告文件；未执行任何 `git add/commit/push`、未切分支、未改源码。
