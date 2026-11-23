# Git 管理器「撤销改动」技术方案

- 状态：已实现（评审补充 D5/D7/D8 修订与 D9/D10 一并落地）
- 日期：2026-11-23
- 一句话：中央 Git 管理器的「变更」页补上撤销未提交改动：可撤全部，也可撤单个文件或一个目录下的文件；已跟踪文件回到最近一次提交，未跟踪的新文件被删除。不回退已经提交的历史。
- 关联代码（撰写时已核实，均为当前工作区）：
  - 变更页：`desktop/src/components/git/GitManagerPanel.vue`（两步提交接到 `GitChangeList`）、`desktop/src/components/task/GitChangeList.vue`、`desktop/src/components/task/GitChangeTreeNode.vue`、`desktop/src/components/task/GitContextMenu.vue`
  - 写操作分发：`desktop/src/composables/useGitOperations.ts`、`desktop/src/composables/workspace-git-provider.ts`
  - 变更分类：`backend-ts/src/file/workspace-git.service.ts` 的 `collectChangedFiles`（`git diff --name-status HEAD` + `ls-files --others --exclude-standard`）；Electron 同口径在 `desktop/electron/gitStatus.cjs` 的 `collectChangedFiles`
  - 写操作：`backend-ts/src/file/git-write-operation.service.ts`、`backend-ts/src/file/file.routes.ts`、`desktop/electron/gitOperations.cjs`、`desktop/electron/gitIpc.cjs`
- 关联方案：[2026-10-28 Git 管理器](../2026-10/2026-10-28-git-manager-tab-technical-design.md)。该方案把新能力只放进中央 Tab，并明确不做冲突解决 UI、不做 `abort` / `reset` 入口。本方案沿用这两条。

## 1. 现状与问题

中央 Git 管理器「变更」页现在能做的写操作只有提交、拉取、推送。文件行的右键菜单是复制路径、在 Finder 中打开、添加到聊天、下载（`GitContextMenu.vue`）。没有任何入口把工作区改动退回到 HEAD。

变更清单把未跟踪文件标成 `CREATED`（界面上是 `A`），和已 `git add` 的新文件同一枚徽章（`workspace-git.service.ts` 的 `ls-files --others` 分支带 `untracked: true`）。截图里的 `bilibili-home.png`、`zhihu-home.png` 就是这种新增文件：`git restore --source=HEAD` 恢复不了它们，因为 HEAD 里没有这两条路径，必须从工作区删掉。

写操作白名单目前是 `commit | pull | push | fetch | switch | stash`（`LOCAL_ACTIVITY_OPERATIONS`）。CLOUD 走 `GitWriteOperationService` 的仓库锁，LOCAL 走 `gitOperations.cjs` 的 `withWriteLock`，活动经 `POST /v1/files/workspace-git-activity` 落库。撤销要进同一条链路，不能在前端直接删文件。

Stash 的「丢弃」已经有确认框（`GitStashView.vue` 的 `ElMessageBox.confirm`）。撤销比丢弃 stash 更不可恢复，确认框沿用这个交互。

## 2. 目标与非目标

### 2.1 目标

1. 中央 Git 管理器「变更」页可以撤销全部未提交改动，也可以撤销一个文件，或一个目录下当前列出的全部文件。
2. 已跟踪的修改和删除回到 HEAD 的内容与索引；改名回到旧路径；未跟踪或仅暂存的新文件从工作区删除。
3. CLOUD 与 LOCAL（Electron）语义一致。界面只通过 `WorkspaceGitProvider` 调用。
4. 操作前确认。成功或失败后刷新本面板，并沿用现有 `git-changed` 通知右侧检查器重读摘要。
5. 写入 `session_activity`，操作名 `discard`。

### 2.2 非目标

- 不回退已有提交（不做 `revert`、`reset HEAD~N`）。
- 不提供暂存区勾选、部分暂存、按 hunk 撤销。提交仍是 `git add -A` 全量提交。
- 不在合并、变基、拣选、revert 进行中撤销，也不提供 `merge --abort` / `rebase --abort`。现场保持原样，提示用户先处理完。
- 不删除被忽略的文件（不用 `git clean -x`）。
- 不加到右侧边栏的 Git 页。新能力只进中央 Tab，与 2026-10-28 方案一致。
- 不给 Agent 加内置工具，不加 mao-cli 命令（管理器的提交 / 拉取 / 推送今天也没有对应 CLI）。
- 不自动关掉已经打开的 diff 页。变更清单会刷新；那份 diff 仍是打开时的快照。
- 零数据库迁移、零新依赖、不加权限码、不改 admin、不改安卓壳。

## 3. 决策

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 撤销的对象 | 只撤销**未提交**的工作区和索引改动 | 用户缺的是变更页上那些还没提交的文件。回退历史提交是另一件事 |
| D2 | 入口 | 只加在中央 Git 管理器。`GitChangeList` 用 `allowDiscard` 打开，侧边栏不传 | 侧边栏保持现状；破坏性操作放在宽面板里，和两步提交的范围一致 |
| D3 | 粒度 | 全部、单文件、目录。目录由前端把该节点下的文件路径收齐后提交，服务端只认文件路径 | 变更树的目录节点本身不在 `changedFiles` 里 |
| D4 | 确认 | 每次都 `ElMessageBox.confirm`，确认按钮文案是「撤销」 | 与 Stash「丢弃」同一模式。未跟踪文件删了没有 reflog |
| D5 | 命令 | 按文件类型分别 `git restore` / `git rm -f` / 删除工作区文件。删掉未跟踪文件后，自下而上删除因此变空的父目录（止于仓库根）。**不跑任何形式的 `git clean`** | `git reset --hard` 会在合并中途顺便清掉合并状态，也删不掉未跟踪文件。不带路径的 `git clean -fd` 作用于执行那一刻的全部未跟踪文件：CLOUD / LOCAL 的写锁只挡 Git 操作，挡不住同会话 Agent 的文件工具，确认后才写出的文件会被一起删掉。`git restore` 与现有 `git switch` 一样要求 Git 2.23+ |
| D6 | 谁判定类型 | 服务端 / Electron 用当前 `changedFiles` 重算，不采用前端传来的 `changeType` | 确认框弹出到执行之间，工作区可能已经变了 |
| D7 | 进行中的合并与冲突 | 以下任一成立就拒绝：`MERGE_HEAD`、`REBASE_HEAD`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`、`rebase-merge`、`rebase-apply`、`sequencer` 存在；或者索引里有未合并条目（复用两端现有的 `hasConflicts`，即 `git diff --name-only --diff-filter=U`）。标记路径一律用 `git rev-parse --git-path <name>` 取，不拼 `.git/<name>` | 沿用「不做 abort / reset」。已实测 `stash apply/pop` 冲突后**没有** `MERGE_HEAD`，冲突文件在 `diff --name-status HEAD` 里显示为 `M`，`git restore --source=HEAD --staged --worktree` 会静默成功、抹掉冲突现场，只查标记文件挡不住。本产品的 stash 页本身就会产生这种现场（「已保留现场，请手动处理」）。worktree 或 `--separate-git-dir` 仓库里 `.git` 是文件，拼路径会漏判 |
| D8 | 路径 | 省略或 `null` = 全部；空数组拒绝；显式列表上限 1000，且每一条都必须在当前变更集里。「全部」必须附带 `expectedDigest`，与执行时重算的变更集不一致就拒绝 | 空数组不能被当成「全部」，避免前端漏传路径时删光工作区。确认框里的 N 是用户看到的清单，确认之后 Agent 新写的文件不应被「全部」带走 |
| D9 | 不可按文件撤销的条目 | 未跟踪的**目录项**（嵌套仓库）与子模块（gitlink）都不处理。只撤这一条时拒绝；「全部」或目录批量里遇到就跳过，并在结果文案里列出跳过数 | 已实测：根仓库内未被忽略的嵌套仓库在 `ls-files --others` 里输出为 `sub/` 一条目录项，按「删除这个文件」走递归删除会删光一个带自己提交历史的仓库。子模块在 `diff HEAD` 里显示 `M`，`git restore` 只改 gitlink，子模块检出不变，执行后这一条照旧在清单上 |
| D10 | 执行粒度 | 同类动作按批调用 git（每批不超过 200 条路径，放在 `--` 之后），未跟踪文件逐个用 `fs` 删除 | 每个文件起一个 git 子进程，1000 个文件就是上千次调用，CLOUD 全程占着仓库锁。分批后单次调用仍受现有 60s 超时约束 |

## 4. 行为契约

执行前先拿仓库写锁（CLOUD `locked`，LOCAL `withWriteLock`），再按 §3 D7 检查进行中标记和未合并条目，然后读当前变更集。没有可撤的改动时返回「没有可撤销的改动」，不跑删除。

「全部」时先校验 `expectedDigest`：对当前变更集的 `path` 排序后用 `\n` 连接，取 SHA-256 十六进制，与请求值不同就返回「改动已变化，请刷新后重新确认」，什么都不动。前端用同一算法对 `GitChangeList` 收到的 `files` 计算（`crypto.subtle`，Electron 渲染进程与 HTTPS 页面都可用）。两端 `collectChangedFiles` 同口径，不需要额外对齐。

路径只接受仓库内的相对路径：去首部 `./`，反斜杠换成 `/`，拒绝绝对路径、空段、`.`、`..`、NUL 和换行。传给 git 时放在 `--` 之后，并带 `GIT_LITERAL_PATHSPECS=1`，避免文件名被当成 pathspec。删除前对父目录做 `realpath`，父目录必须落在仓库根内；最终组件是符号链接时只卸掉链接本身，不跟随到链接目标。

| 当前变更 | 动作 |
|---|---|
| `untracked` 且 `lstat` 是普通文件或符号链接 | `unlink` 这一个路径，再自下而上删除变空的父目录（止于仓库根，`rmdir` 非空即停）。不调用 `git clean` 带路径，避免误删同目录的其他未跟踪文件 |
| `untracked` 且是目录（路径以 `/` 结尾或 `lstat` 为目录，典型是嵌套仓库） | 不处理（§3 D9）。严禁 `rm -r` / `rmSync({ recursive: true })` |
| 子模块（HEAD 或索引中该路径模式为 `160000`，用 `git ls-files -s -- <path>` / `git ls-tree HEAD -- <path>` 判定） | 不处理（§3 D9） |
| `CREATED` 且已进索引（HEAD 中没有） | `git rm -f --ignore-unmatch -- <path>`，若工作区仍在则再删文件 |
| `MODIFIED` / `DELETED` | 有 HEAD 时 `git restore --source=HEAD --worktree --staged -- <path>`。没有 HEAD 时拒绝这一条（空仓库没有可恢复的内容） |
| `RENAMED` | 有 HEAD 且有 `oldPath` 时，对旧路径做上面的 `restore`，再去掉新路径（`git rm -f --ignore-unmatch`，残留文件再删） |
| `COPIED` | 只去掉新路径。旧路径本来还在，不恢复成 HEAD，避免把旧文件上的其他修改一起清掉 |

撤销全部与撤销部分走同一套逐条规则，区别只是路径集合。被 `.gitignore` 忽略的文件不在变更集里，自然留着；父目录里还有被忽略的文件时 `rmdir` 失败即停，目录保留。

一批失败就停（D10 分批后，失败粒度是一批；git 报错里通常带出具体路径）。已经撤销的文件不回滚（git 没有跨文件事务）。用户刷新后再点一次即可继续撤剩下的。

成功文案：全部为「已撤销全部未提交改动」；一个文件为「已撤销 `<path>` 的改动」；多个为「已撤销 N 个文件的改动」。有 D9 跳过项时追加「，跳过 M 项（嵌套仓库或子模块，需手动处理）」，此时「全部」的文案改为「已撤销 N 个文件的改动」，不说「全部」。

确认文案：

- 全部：`将撤销全部 N 个文件的未提交改动。已跟踪文件回到最近一次提交，未跟踪的新文件会被删除。此操作无法恢复。`
- 一个文件：`将撤销「<path>」的未提交改动。此操作无法恢复。`
- 目录：`将撤销该目录下 N 个文件的未提交改动。此操作无法恢复。`

用户取消确认时不发请求。

## 5. 接口与改动面

### 5.1 CLOUD

`POST /v1/files/workspace-git-discard`

```json
{ "sessionId": 1, "repoPath": "可选，一级子目录", "paths": null, "expectedDigest": "sha256-hex" }
```

`paths` 省略或 `null` 表示全部，此时 `expectedDigest` 必填（§4）。数组则只撤这些文件，`expectedDigest` 忽略。会话归属、CLOUD 限制、`repoPath` 只允许一级子目录，与 `workspace-git-stash` 相同。`GitWriteOperationService.discard` 走现有 `locked`，活动类型 `GIT_DISCARD`。`LOCAL_ACTIVITY_OPERATIONS` 加入 `discard`。

### 5.2 LOCAL

`gitOperations.cjs` 增加 `discard(workspace, repoPath, paths, expectedDigest)`，规则与 §4 逐条相同。注意 LOCAL 的 `withWriteLock` 遇锁直接返回「Git 操作进行中」，不像 CLOUD 那样排队，前端按普通失败处理即可（两边各写一份，与现有 commit / switch 一样，不抽公共包）。IPC 通道 `git-discard`，preload 与 `electron.d.ts` 同步。成功后 `createLocalGitProvider` 照旧打 `workspace-git-activity`。

### 5.3 前端

- `GitOperationType` / `useGitOperations` 增加 `discard`。参数是 `paths: string[] | null`。
- `WorkspaceGitProvider.discard(paths, expectedDigest, repoPath?)`，在接口里声明为必填方法。CLOUD 调上面的 POST；会话未就绪的占位实现返回失败。多仓库包装（`GitManagerPanel.vue` 里包一层 `repoPath` 的那个对象）必须显式覆盖 `discard`，否则会撤到工作区根仓库。该包装以 `...p` 展开原 provider，漏写时类型检查**不会**报错（展开出的原方法满足接口），所以靠 `GitManagerPanel.test.ts` 的多仓库用例兜底。
- 目录节点收齐的路径超过 1000 条时不发请求，提示「该目录改动过多，请使用撤销全部」。
- `GitChangeList` 增加 `allowDiscard`、`discarding`。只有 Git 管理器传入。
- 成功或失败后都 `handleRefreshAll`（与切换分支、提交相同），避免清单停在旧状态。

不改 `workspace-git.service.ts` 的只读解析。类型判定复用它已经返回的 `changeType` / `untracked` / `oldPath`。

## 6. 界面

只在「变更」视图、且有文件时出现。

1. 提交按钮左侧加次按钮「撤销全部」。主按钮仍是蓝色「提交」。撤销按钮用描边和删除色，避免和提交抢主操作。进行中图标旋转，文案按钮带 `title`。
2. 文件行在增删行数后面加一个撤销图标按钮（`aria-label` 为「撤销 `<文件名>` 的改动」）。对比视图复用 `GitChangeTreeNode`，不传 `showDiscard`，那里不出现这个按钮。
3. 右键菜单顶部增加一项：文件是「撤销此改动」，目录是「撤销此目录的改动」。用删除色，下面接一条分隔线。`GitContextMenu` 的这项由 `showDiscard` 控制，文件变更面板和侧边栏不传，菜单保持今天的四项。

撤销进行中，提交、生成提交信息、撤销按钮都禁用，原因写在按钮的 `title` 上（与现有「Git 操作进行中」一致）。

当前会话的 Agent 正在运行时不禁用撤销，但确认框文案末尾追加一句「Agent 正在运行，可能仍在修改这些文件。」。Agent 在撤销之后写回的改动会重新出现在清单上，这是预期行为。

## 7. 安全

- 参数数组执行 git，不拼 shell。
- 只删除「当前变更集里的路径」。干净的已跟踪文件、忽略文件、变更集之外的路径都拒绝。
- 删除只用 `unlink` 和空目录 `rmdir`，整条链路不出现递归删除，嵌套仓库与子模块按 §3 D9 跳过。
- 父目录 `realpath` 必须在仓库根内，挡掉经符号链接目录写出仓库。
- 仓库级写锁与现有提交 / 拉取互斥。
- 错误文案走现有 `classify` / `sanitize`，不回传凭证 URL。
- 活动只记操作名、成败、仓库路径、耗时。不把文件内容写入活动详情。

## 8. 测试与文档

后端 `git-write-operation.service.spec.ts`（真实临时仓库）：

- 只撤一个已修改文件，旁边的未跟踪文件还在。
- 撤销全部：已修改文件回到 HEAD，未跟踪文件消失，被忽略文件还在。
- 已暂存的新文件（含二进制）撤掉后工作区不再有它。
- 改名撤掉后旧路径回来、新路径消失。
- `../` 与不在变更集里的路径被拒绝，仓库外的文件不动。
- 指向仓库外的符号链接只卸掉链接，目标文件还在。
- 合并冲突进行中拒绝，`MERGE_HEAD` 仍在。
- `stash pop` 冲突（无 `MERGE_HEAD`）拒绝，冲突文件与 stash 都还在。
- 根仓库内未忽略的嵌套仓库：撤销全部后嵌套仓库目录与其 `.git` 完好，结果文案带跳过数；单独撤这一条被拒绝。
- 子模块指针变化：被跳过，子模块检出不动。
- 未跟踪文件 `a/b/c.txt` 撤掉后 `a/b`、`a` 变空即被删除；`a` 下另有被忽略文件时 `a` 保留。
- 「全部」时 `expectedDigest` 与当前变更集不一致（模拟确认后新增文件）被拒绝，工作区不动；缺省 `expectedDigest` 被拒绝。
- 超过一批（>200 条）的已修改文件全部回到 HEAD。
- 还没有任何提交的仓库可以撤掉未跟踪文件。
- 活动类型为 `GIT_DISCARD`；`recordLocalActivity` 接受 `discard`。

Electron `gitOperations.test.cjs` 覆盖同一组里的：单文件保留邻居、全部但保留忽略文件、路径穿越、改名、合并中拒绝、stash 冲突拒绝、嵌套仓库跳过、`expectedDigest` 不一致拒绝。`gitIpc.test.cjs` 的通道表加上 `git-discard`。

前端：

- `GitChangeList`：不传 `allowDiscard` 时没有撤销按钮；传入后「撤销全部」点下去会先确认，确认才发出 `discard(null)`，取消不发。
- `GitChangeList`：目录撤销超过 1000 条时提示且不发请求。
- `useGitOperations` 把 `null` 和路径数组原样交给 `provider.discard`；「全部」时带上按 §4 算出的 `expectedDigest`。
- `workspace-git-provider`：CLOUD 打到 `/files/workspace-git-discard`；LOCAL 走 `gitDiscard` 并记活动。
- `file.routes.spec.ts`：LOCAL 会话拒绝；CLOUD 把 `paths` 透传。

文档：同任务补 `changelog/unreleased/2026-11-23-git-discard-changes.md`（后端、前端、桌面 Electron 三节），并改 `skills/mao-cli/reference/desktop.md` 里 Git 管理器「变更」那一条。不改 `README.md` / `DEPLOY.md`。不加 Playwright。
