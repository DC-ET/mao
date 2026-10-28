# 代码审查报告：工作区 Git 管理器中央 Tab（feat/git-manager-tab）

- 审查对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/git-manager-tab`（分支 `feat/git-manager-tab`）未提交改动（`git status` + `git diff`，已排除 CHANGELOG.md / README.md / skills/mao-cli/** 等文档改动；desktop/package.json 与 package-lock.json 仅版本号相关，未审）
- 技术方案对照：`docs/plan/2026-10-28-git-manager-tab-technical-design.md`（重点 §3.3 命令约定、§5.3/§5.4 服务扩展、§5.7 前端面板、§5.8 刷新时机、§8 测试要点）
- 审查日期：2026-10-28
- 审查方式：全量 diff 走读（后端两服务 + 9 端点、Electron 两个 cjs + IPC、前端 provider/composable/四视图/useCenterTabs/TaskView/TaskInspector）+ 每个确认 bug 均以可运行测试复现（临时测试，验证后已按约定删除，完整代码见附录 A）
- 基线状态：`backend-ts` `src/file` 99 既有用例全绿；`desktop` vitest 1373 用例全绿、`npm run build`（vue-tsc + vite）通过；`desktop/electron` node 测试仅本机已知环境差异（全局 git 身份导致的 `commit stages all changes` / `keep_session`、macOS `/private/var` 符号链接）——**既有单测全绿未能发现下列问题，因为现有用例均未构造对应场景**
- 结论：**确认 4 个 bug（2 个中等问题 + 2 个低-中等问题）**。写操作的现场保护（自动 stash → switch → 恢复、切换失败回滚）、Tab id 隔离与重定向、LOCAL 会话拒绝、hash/分支名/stash ref 注入防护、错误契约两条路径等经核查未发现问题（明细见文末清单）。

---

## 确认的 Bug

### Bug 1（中）：stash apply/pop 冲突时走了「裸 git 错误」早退分支，设计的 `conflict:true` + 「已保留现场」提示不可达（CLOUD / LOCAL 双端）

**位置**

- CLOUD：`backend-ts/src/file/git-write-operation.service.ts:261-270`
  ```ts
  const result = await this.run(repo, args, {});
  if (!result.success) {
    throw new BusinessException(ErrorCode.INTERNAL_ERROR, classify(result, `stash ${action} 失败`));  // ← 冲突时在这里早退
  }
  if (action !== 'drop' && await this.hasConflicts(repo)) {
    const failed = failedResult('stash', `stash ${action === 'apply' ? '应用' : '弹出'}产生冲突，已保留现场，请手动处理（${ref}）`);
    failed.conflict = true; ...                                                                          // ← 不可达
  }
  ```
- LOCAL：`desktop/electron/gitOperations.cjs:504-511`（同构：`if (result.exitCode !== 0) return operationError(...)` 早退，冲突分支不可达）

**问题描述**：`git stash apply --index <ref>` / `git stash pop --index <ref>` 在产生冲突时**退出码为 1**（已实测：输出 `CONFLICT (content)...`、`The stash entry is kept in case you need it again.`，exit 1）。因此冲突场景永远走 `!result.success` / `exitCode !== 0` 早退，`hasConflicts` 之后的专用冲突分支（`success:false + conflict:true + stashRef + 「已保留现场，请手动处理（stash@{n}）」`）对 apply/pop 是不可达代码。

**触发场景**：用户在 Stash 视图对某个 stash 点「应用」或「弹出」，而当前工作区/HEAD 与该 stash 存在同文件冲突（pull 冲突遗留的 `mao-auto-pull-*` stash 正是设计预期的典型场景——用户在大 Tab 里处理它时极易撞上）。

**实际影响**（场景本身不丢数据，但契约与引导全丢）：

1. 用户看到的是拼接着原始 git 输出的裸错误（`stash apply 失败：Auto-merging f.txt CONFLICT (content): Merge conflict in f.txt / Index was not unstashed. / On branch main ...`），而不是设计承诺的「stash 应用产生冲突，已保留现场，请手动处理（stash@{0}）」；
2. 结果对象 `conflict` 不为 true、`stashRef` 缺失 → 前端 toast 拿不到冲突语义；LOCAL 活动记录（`recordLocalActivity` → `session_activity`）的 `conflict` 标记同样丢失，Git 活动列表里这条失败没有任何冲突标识；
3. CLOUD 侧直接抛 `BusinessException`，provider catch 后转 `failedOperation('stash', e)`，与 LOCAL 的错误形态也不一致（LOCAL 至少带 `describeGitFailure` 归类文案）。

现场保留本身是 git 的行为（冲突时 stash 不 drop），所以不算数据丢失；但这是设计与实现之间的功能性偏差，且 `hasConflicts` 冲突分支成了死代码，会误导后续维护。

**验证测试结论**（CLOUD 临时 spec `backend-ts/src/file/zz-review-stash-conflict.spec.ts`；LOCAL 临时 `desktop/electron/zz-review-write.test.cjs`）：

```
✓ ZZ review: stashOp conflict path > apply 冲突时应返回 conflict:true 与保留现场提示，实际退化为裸 git 错误
    （断言 caught 为 BusinessException、message 不含「已保留现场」/「stash@{0}」、git stash list 仍含 wip）
```

```
ok 3 - review: stash apply with conflict falls into the raw-git-error branch, not the conflict branch
    （断言 result.conflict === undefined、result.stashRef === undefined、error 不含「已保留现场」、
      stash 条目仍在、工作区留下冲突标记）
```

**修复方向（仅建议，未改代码）**：把冲突判定移到成功判定之前——`apply/pop` 后先 `hasConflicts(repo)`，有冲突直接返回设计的 conflict 结果（此时 git 退出码非 0 是预期内的）；或 `run` 失败时也跑一次 `hasConflicts` 再分流（冲突 → 友好提示，真失败 → `classify`）。两端同改，并各补一条冲突回归用例（现有 `stashOpApplyPopDropRoundTrip` 只覆盖了干净路径）。

**严重程度**：**中**。不影响数据安全（现场保留由 git 保证），但冲突是本设计明确承诺要友好引导的核心场景（pull 冲突遗留 stash 的处理），错误契约与活动记录双重失真。

---

### Bug 2（中）：多仓库模式切换仓库后，若停留在历史/分支/Stash 视图，列表被清空且永不重载，显示误导性空态

**位置**

- `desktop/src/composables/useGitManager.ts:206-215`
  ```ts
  watch(activeView, (view) => {
    if (view === 'history' && !historyLoaded.value && !logLoading.value) void loadLog(true)
    ...
  })
  // provider 代表工作区 / 仓库身份：变化时丢弃全部面板数据，防新旧数据串扰
  watch(provider, () => { resetAll() })
  ```
- `desktop/src/components/git/GitManagerPanel.vue:193-218`（`statusProviderRef` 在 `selectedRepoPath` 变化时产出新 provider 对象，触发上述 reset）+ `:277-279`（`handleRepoSelect` 只调 `selectRepo`，没有任何「重载当前视图」的补偿）

**问题描述**：`resetAll()` 清空 log/branches/stashes 数据并把 `*Loaded` 置 false，但重载的唯一触发是 `watch(activeView)`——仓库切换时 `activeView` 不变，watch 不触发，面板也没有 watch provider 后重载当前视图的逻辑。于是用户切仓库后停留在历史视图看到的是「尚无提交」、分支视图「暂无分支」、Stash 视图「暂无 stash」——不是加载中、不是错误+重试，而是斩钉截错的空态，且 `getLog/getBranches/getStashes` 对新仓库一次都没发。

**触发场景**：多仓库工作区（`multiRepoMode`）→ 打开 Git 大 Tab → 切到「历史」并加载出仓库 A 的提交 → 在顶部仓库下拉切换到仓库 B → 历史列表变空并显示「尚无提交」（仓库 B 明明有提交）。分支/Stash 视图同理。只有切到别的子导航再切回才会加载。这与技术方案 §5.8「切会话……面板的 log/branches/stashes 状态随之清空」的意图（清空是为防串扰，新数据应随之就位）和 §8 手测清单「切会话后面板数据重置（不出现旧仓库文件 + 新 repoPath 组合）」的要求不符——清空做到了，重载没有。

注：切**会话**时面板因 `:key="git-<sessionId>"`（`CenterTabContainer.vue:53`）整体重挂载、`activeView` 回到 'changes'，不受此 bug 影响；受害路径只有同会话内的切仓库。

**验证测试结论**（临时 spec `desktop/src/composables/zz-review-useGitManager.test.ts`，2 用例全过——证明现状即如此）：

```
✓ 切仓库后停在历史视图：列表被清空且不会自动重载（UI 显示错误的「尚无提交」空态）
    providerRef 换成新 provider 后：logEntries=[]、logError=''、logLoading=false、
    新 provider 的 getLog 调用次数 = 0；切到 branches 再切回 history 才拿到新仓库数据
✓ 切仓库后停在分支视图同样不重载
```

**修复方向（仅建议，未改代码）**：在 `useGitManager` 的 `watch(provider)` 里 reset 后按当前 `activeView` 重放懒加载（如 resetAll 末尾 `if (activeView.value === 'history') void loadLog(true)` 等），或在 `GitManagerPanel` watch `statusProviderRef` 后调 `manager.refreshLoadedViews()`/按视图重载。注意 resetAll 与重载都要用 reset 后的新 provider（现有 `loadLog` 读 `provider.value`，时序上安全）。

**严重程度**：**中**。无数据损坏、可自行恢复（切走再切回），但空态是主动的错误信息（「尚无提交」），用户会误以为新仓库没有历史；直接违反审查重点「仓库切换后数据刷新是否完整」。

---

### Bug 3（低-中）：改名提交的单文件 diff 显示为「整个文件新增」（changeType=CREATED、before 为空），与同屏文件清单的「改名」徽章自相矛盾（CLOUD / LOCAL 双端）

**位置**

- CLOUD：`backend-ts/src/file/workspace-git.service.ts:426-430`
  ```ts
  const beforeRaw = await this.runGitOk(repoRoot, ['show', `${normalizedHash}^:${normalized}`]);
  const afterRaw = await this.runGitOk(repoRoot, ['show', `${normalizedHash}:${normalized}`]);
  const changeType = beforeRaw == null && afterRaw != null ? 'CREATED' : ...;
  ```
- LOCAL：`desktop/electron/gitStatus.cjs:812-818`（同构）

**问题描述**：改名提交里文件清单（`getCommitFiles`）能正确识别 `RENAMED` 并带 `oldPath`，但单文件 diff 固定用**新路径**取 `<hash>^:<newPath>`——该路径在父提交中不存在，`git show` 退出码非 0 → before 判空 → changeType 退化为 `CREATED`、beforeContent 为空。用户在历史视图看到「改名」徽章的点开该文件，中心 Diff Tab 里却是「整份文件从无到有」，旧内容完全看不到（若同时有内容修改，连修改都看不出，只剩新增）。

**触发场景**：任何含 rename 的提交（`git mv` / 检出时识别的改名），在历史视图展开文件清单后点击该文件。纯改名（100% similarity）与改名+编辑都中招。

**验证测试结论**（CLOUD 临时 spec `backend-ts/src/file/zz-review-git-manager.spec.ts`；LOCAL 临时 `desktop/electron/zz-review-git.test.cjs`，均按「期望行为」断言故失败，失败即 bug 存在）：

```
× rename commit: getCommitFileDiff reports CREATED with empty before instead of RENAMED old content
  → expected 'CREATED' to be 'RENAMED'   （文件清单侧 files[0].changeType === 'RENAMED' 已通过，diff 侧退化）
```

```
not ok 1 - review: rename commit diff shows whole file as created (before lost)
    expected: 'RENAMED'  actual: 'CREATED'
```

**修复方向（仅建议，未改代码）**：`getCommitFileDiff` 增加 oldPath 入参（前端 `open-commit-diff` 的 payload 已带整个 `GitChangedFile`，`oldPath` 现成），before 取 `<hash>^:<oldPath ?? path>`；或在方法内先跑一次 `--name-status` 拿 R 行的 oldPath。changeType 也顺带与文件清单对齐（RENAMED/COPIED）。

**严重程度**：**低-中**。只影响 rename 提交的 diff 正确性（内容不丢、可去外部终端核对），但属于「展示与数据自相矛盾」的功能正确性问题，且技术方案 §3.3 对该命令行的约定本身只覆盖了增/删/根提交，遗漏了改名形态。

---

### Bug 4（低-中，安全一致性）：新增只读方法的 `resolveRepoRoot` 缺少 workspace 包含校验——工作区嵌在外层 git 仓库内时，读方法作用于外层仓库，且 `getCommitFileDiff` 可读到工作区之外的受控文件内容（CLOUD / LOCAL 双端）

**位置**

- CLOUD：`backend-ts/src/file/workspace-git.service.ts:559-567`（新私有方法 `resolveRepoRoot`，只做 `resolveRepoDir` + `rev-parse --show-toplevel`，无 `isUnder(root, workspace)`）
  - 对照 1（写路径有校验）：同文件 `:311-323` `resolveRepository` 末尾 `if (!isUnderReal(root, workspace)) throw FORBIDDEN`
  - 对照 2（姊妹读方法有校验）：同文件 `:263-270` `getFileDiff` 对 absolute 额外做 `this.pathSandbox.resolve(absolute, workspace)`
- LOCAL：`desktop/electron/gitStatus.cjs:626-632`（`resolveRepoRoot` 同样无 workspace 包含校验；`getGitCommitFileDiff` 只校验 `..` 与 repoRoot 前缀）

**问题描述**：`repoPath` 的一级子目录校验（`resolveRepoDir`）只约束「起点」在工作区内，但 `rev-parse --show-toplevel` 的返回值可以跳出工作区——当会话工作区本身位于某个 git 仓库内部时（`<outer>/ws`），六个新只读方法（log/commitFiles/commitFileDiff/branches/stashes/remotes）全部作用到外层仓库上。其中 `getCommitFileDiff` 的路径校验基准是外层 repoRoot，因此可以读取外层仓库中**位于工作区之外**的任意受控文件内容（如 `outside-secret.txt`）。同族的 `getFileDiff` 和所有写路径（commit/pull/push/fetch/switch/stash 经 `resolveRepository`）在这种场景下都是拒绝的——新方法打破了这一口径，形成「读能越界、写被拒绝」的不一致。

**触发场景**：会话工作区目录位于一个 git 仓库之内（例如运维把 `/opt/mao-data/workspace` 或某父目录初始化成了 git 仓库，或工作区路径被安排在受管仓库子目录）。此时调用 6 个新只读端点/ IPC：log/branches/stashes/remotes 泄露外层仓库元数据；commit-file-diff 可读取外层仓库任意路径的文件内容。

**验证测试结论**（CLOUD 临时 spec `backend-ts/src/file/zz-review-git-manager.spec.ts`；LOCAL 临时 `desktop/electron/zz-review-git.test.cjs`，均按「实际行为」断言故通过，通过即越权存在）：

```
✓ nested workspace: read methods operate on the outer repo and can read files outside the workspace
    getLog(ws) 返回外层仓库全部提交；getCommitFileDiff(ws, hash, 'outside-secret.txt')
    afterContent 含 'outer repo file outside workspace'；
    同场景 resolveRepository(ws) 被拒、getFileDiff(ws, …, 'outside-secret.txt') 被拒（口径不一致对照）
```

```
ok 2 - review: nested workspace reads outer repo and files outside the workspace
```

**修复方向（仅建议，未改代码）**：`resolveRepoRoot` 解析出 repoRoot 后补 `isUnderReal(root, workspace)` 校验（与 `resolveRepository` 同款，拒绝时抛 `PARAM_INVALID/FORBIDDEN`）；LOCAL 侧同款补齐。注意这会改变「工作区即外层仓库子目录」时 `getStatus` 的既有宽松语义（存量行为），如需保持 getStatus 兼容，可只对新方法收紧。

**严重程度**：**低-中**。需要特定目录布局才会触发，非普通用户可直接构造的路径穿越（`..` 已被两级校验拦住），且读取范围仍限于该外层 git 仓库的受控内容；但作为本次新增的攻击面，与姊妹方法/写路径的口径不一致应当补齐。

---

## 误报已排除（曾怀疑、验证后不构成 bug）

1. **切换分支的 stash 编排（自动 stash → switch → 恢复）**：实测三条路径全部符合设计——恢复冲突保留现场且错误信息含 stash 引用（`zz-review-write.test.cjs` ok 4/ok 5：restore 冲突后仍在 feature、stash 列表含 `mao-auto-switch-`；切到不存在分支时 stash 已恢复、仍在原分支、本地变更不丢、stash 栈无残留）。CLOUD 侧既有 spec `switchBranchStashesAndRestoresLocalChanges` 等亦覆盖。
2. **`git stash pop` 冲突后 stash 条目是否被丢**：实测 git 明确保留（`The stash entry is kept in case you need it again.`），「保留现场」的数据侧成立，仅提示契约坏（见 Bug 1）。
3. **`git branch -vv` 的 `[origin/main: gone]` / ahead-behind / detached / 空仓库 unborn 三端解析口径**：前端 `parseBranchLine`、后端 `parseBranchVvLine`、Electron `parseBranchVvLine` 正则逐字一致；实测 git 输出 `[origin/main: gone]`、`[origin/main: ahead 1, behind 2]`、`* (HEAD detached at …)`、空仓库 `git branch -vv` 无输出（unborn 兜底分支两端都有）均解析正确。
4. **numstat 改名花括号紧凑形态**：`{src => src2}/mod.txt` 实测后端/Electron `numstatNewPath` 均正确还原为 `src2/mod.txt` 并与 name-status 键合并（既有用例 `getCommitFilesMergesNumstatForSameDirectoryRename` 覆盖同目录改名）。
5. **merge 提交文件清单为空**：实测不带 `--first-parent` 时 `git show --name-status` 对干净合并输出为空，两端实现均已带 `--first-parent`，清单非空。
6. **Tab id 隔离**：`git` 单例、`git-commit-diff:<hash>:<path>` 与 `git-diff:<path>` 并存、重复打开只更新不新建、`openDiffTab` 不传 idPrefix 时回归不变、`applyWorkspacePathChange` 对提交 diff 保留 hash 段——`useCenterTabs.test.ts` 6 条新用例全绿，走读未发现问题。
7. **LOCAL 会话拒绝 / 参数缺失 / hash、分支名、stash ref 注入**：9 端点均有 `requireOwnedCloudGitSession`（归属 + LOCAL 拒绝），hash `^[0-9a-f]{7,64}$`、分支名 check-ref-format 子集、stash ref `^stash@\{\d+\}$`、路径 `..` 与沙箱校验、命令全部参数数组无 shell 拼接；`file.routes.spec.ts` 新用例覆盖拒绝路径。
8. **错误契约两条路径**：CLOUD `getCommitFileDiff` 抛错被 cloud provider 转 `unavailableReason`，LOCAL 返回带 `unavailableReason` 的对象，`normalizeDiff` 归一后 UI 行为一致；`getCommitFiles` 无效 hash 双端都抛/转错误（不与空提交混淆）。
9. **`create=true` 只接受远端引用**（`resolveSwitchTarget`：create=true 但名字不是 remote 引用时报「仅支持从远端分支创建跟踪分支」）：设计 §2.2 括注提到 create=true 也可「从当前 HEAD 新建分支并切换」，但前端 `GitBranchesView` 只对远端行传 `create:true`，无用户可见路径，不计 bug。
10. **点「获取远端更新」会发生两次 fetch**（显式 fetch + `handleRefreshAll → refreshStatus` 内部再 fetch）：与侧边栏存量 `refreshAll(remote=true)` 模式一致，非本次引入，仅记录。

## 低优先级备注（不计入 bug）

- `desktop/electron/gitStatus.cjs:163-167` 工作区 numstat 的改名还原仍是简单形态切片（未用同文件新加的 `numstatNewPath`）：当用户 git 配置 `diff.renames=true` 时，LOCAL 变更树的改名文件会丢 +/- 统计（CLOUD `collectChangedFiles` 已用 `numstatNewPath`，双端口径不一致）。该代码为存量逻辑、本次 diff 未改动，且 rename 检测默认关闭，故不计入本次 bug。
- `GitManagerPanel` 的 fetch 禁用原因里 `gitLoading`（状态刷新中）会与「Git 操作进行中」叠加出现，属文案层面的小噪音。

---

## 附录 A：验证用临时测试（已按约定删除，未提交）

- `backend-ts/src/file/zz-review-git-manager.spec.ts`（Bug 3 + Bug 4，3 断言组）
- `backend-ts/src/file/zz-review-stash-conflict.spec.ts`（Bug 1 CLOUD 侧）
- `desktop/electron/zz-review-git.test.cjs`（Bug 3 + Bug 4 LOCAL 侧）
- `desktop/electron/zz-review-write.test.cjs`（Bug 1 LOCAL 侧 + 误报排除 1 的三条切换/stash 编排用例）
- `desktop/src/composables/zz-review-useGitManager.test.ts`（Bug 2）

运行方式：`cd backend-ts && npx vitest run src/file/zz-review-*.spec.ts`；`cd desktop && node --test electron/zz-review-*.test.cjs`；`cd desktop && npx vitest run src/composables/zz-review-useGitManager.test.ts`。

## 附录 B：本次改动核查未发现问题的部分

- 后端 `getLog` 分页钳制 / 空仓库返 `[]` / 未知 hash `PARAM_INVALID`、`getStashes` NUL 解析、`getRemotes` fetch/push 合并与 `CREDENTIAL_URL` 脱敏（https 凭证 URL → `***@`）、`fetchRemote` 的 remote 选择与无 remote 拒绝、`recordLocalActivity` 白名单扩 fetch/switch/stash 且 LOCAL provider 三个写操作成功后有落活动记录（spec 覆盖）。
- Electron 9 个 IPC 与 REST 一一对应、main.cjs catch 契约（数组查询返 `{error}`、commit-file-diff 返 `unavailableReason` 对象）与 provider 解包逻辑自洽。
- 前端 `useGitManager` 竞态序号、分页 offset 累加、`toggleCommit` 缓存与失败收起重试、`loadRemotes` 失败静默降级、`refreshLoadedViews` 只重载已加载视图；`GitManagerPanel` 状态条/fetch 禁用原因、`onActivated` 静默刷状态；`useGitOperations` 抽取消重入与 toast 文案与侧边栏一致（TaskInspector 改接同一 composable）。
- `CenterTabContainer` 的 `:key="git-<sessionId>"`、`TaskView` 的 `open-commit-diff` handler（repoPath 拼接、标题带短哈希、SNAPSHOT/UNSUPPORTED 判定）、`TaskInspector` 摘要行入口与 `@click.stop` 防仓库项冒泡。
