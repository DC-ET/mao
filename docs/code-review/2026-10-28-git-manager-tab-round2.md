# 代码审查报告：工作区 Git 管理器中央 Tab 第 2 轮（修复复核 + 全量复查）

- 审查对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/git-manager-tab`（分支 `feat/git-manager-tab`）未提交改动（相对第 1 轮报告 `2026-10-28-git-manager-tab-round1.md` 的修复提交），已排除 CHANGELOG/README/skills 等文档改动与 package.json 版本号
- 技术方案对照：`docs/plan/2026-10-28-git-manager-tab-technical-design.md`
- 审查日期：2026-10-28
- 审查方式：①对第 1 轮 4 个 bug 的修复逐行走读（后端两服务、file.routes、Electron 两 cjs + main/preload、provider 两实现、useGitManager、TaskView 全链路）；②跑仓库内已落地的回归用例复核修复生效；③另写 18 个临时探针用例（后端 7 / Electron 6 / 前端 5）专测「修复是否引入新问题」与修复边角，验证后按约定删除（完整代码见附录 A）
- 基线状态：`backend-ts` `src/file` 8 文件 101 用例全绿；`desktop` vitest 全量 144 文件 1373 用例全绿；`desktop/electron` node 测试 42/43（唯一失败为本机全局 git 身份导致的存量用例 `commit stages all changes`，主工作区同样失败，已知环境差异）
- 结论：**第 1 轮 4 个 bug 全部确认修复，修复本身未引入功能性新问题**；本轮新发现 **1 个低severity 新 bug**（`resetAll` 漏增 `commitFilesSeq`，切仓库后在途的提交文件清单请求迟到会污染新仓库缓存——属第 1 轮 Bug 2 同类问题的遗漏角落）；另对第 1 轮「低优先级备注」的 workspace numstat 花括号形态统计丢失补充了实证（默认 git 配置下确实发生，LOCAL/CLOUD 口径不一致），按约定维持不计入 bug 数、单独说明。

---

## 一、第 1 轮 4 个 bug 的修复复核（全部确认修复）

### 修复 1（原 Bug 1，中）：stash apply/pop 冲突走专用契约 —— 已修复

**位置**：`backend-ts/src/file/git-write-operation.service.ts:261-273`；`desktop/electron/gitOperations.cjs:504-513`。两端都把 `hasConflicts` 判定移到 git 退出码判定之前，冲突时返回 `success:false + conflict:true + stashRef + 「已保留现场，请手动处理（stash@{n}）」`，退出码非 0 且无冲突才走 `classify`/`describeGitFailure` 裸错误分支。

**验证（仓库落地回归用例，本轮实跑）**：

```
✓ stashOpApplyConflictReportsConflictAndKeepsTheScene（后端 git-write-operation.service.spec.ts）
✓ stash op apply conflict reports conflict and keeps the scene（Electron gitOperations.test.cjs）
后端 file 域 3 个相关 spec：Test Files 3 passed / Tests 39 passed
Electron：node --test gitStatus.test.cjs gitOperations.test.cjs → # tests 43 # pass 42 # fail 1（唯一失败为已知环境差异）
```

**补充探针（临时，已删）确认修复的边角不塌**：

- P1/E1：仓库已存在未解决冲突（pull 冲突遗留场景）时再 apply stash → 仍走冲突契约（`conflict:true`、`stashRef`、错误含「已保留现场」），stash 条目保留、既有冲突现场不被破坏。消息未区分「冲突由本次 apply 引起还是现场原有」，但引导（保留现场 + 手动处理）在该场景下依然正确，不计 bug。
- `drop` 动作仍跳过冲突判定（`action !== 'drop'` 守卫在位）；干净 apply/pop、非法 action/ref、格式合法但不存在（`stash@{99}` → `stash apply 失败`）均被回归用例覆盖。

**修复引入的新问题**：未发现。LOCAL 活动记录（`recordLocalActivity` → `session_activity`）现在能带上 `conflict:true`，第 1 轮指出的「活动记录冲突标记丢失」随之解决。

### 修复 2（原 Bug 2，中）：切仓库后按当前视图重载 —— 已修复

**位置**：`desktop/src/composables/useGitManager.ts:206-225`。抽出 `loadActiveView()` 供 `watch(activeView)` 与 `watch(provider)` 共用；provider 变化时 `resetAll()` 后立即 `loadActiveView()` 并按需 `loadRemotes(true)`（状态条徽标常驻，切仓库后一并重取）。

**验证（仓库落地回归用例，本轮实跑）**：

```
✓ provider 变化后按当前视图自动重载，不再显示误导性空态（history/branches/stash 三视图各一遍）
✓ provider 变化后停在变更视图时不预打历史/分支/stash 请求
✓ provider 变化（切会话 / 切仓库）时全部状态清空
前端 4 个相关 spec：Test Files 4 passed / Tests 83 passed
```

**补充探针（临时，已删）确认重载链路竞态安全**：F1（旧 provider 在途 log 请求迟到被序号丢弃，不覆盖新仓库数据）、F3（provider → null → 对象往返后按当前视图恢复）、F4（切仓库后停留在加载失败的历史视图：错误态被清掉并按新仓库重载成功）、F5（A→B→A 连续切换最终展示 A 的数据，每个 provider 各请求一次、无重复无遗漏）——全部通过。面板侧 `statusProviderRef` 仍按 `selectedRepoPath` 变化产出新 provider 对象（`GitManagerPanel.vue:193-218`），watch 触发链完整。

**修复引入的新问题**：发现 1 处遗漏角落，见下文「新 Bug 1」（`commitFilesSeq` 未纳入 reset 防护）。

### 修复 3（原 Bug 3，低-中）：改名提交 diff 读旧路径 —— 已修复

**位置与链路**：`backend-ts/src/file/workspace-git.service.ts:406-441`（`oldPath` 入参 + `beforePath` + RENAMED 分支）；`file.routes.ts:286-294`（`oldPath` 可选查询参数）；`desktop/electron/gitStatus.cjs:821-854`（同构）；`main.cjs` IPC 透传、`preload.cjs` 签名、`electron.d.ts` 类型；provider 两实现透传（`workspace-git-provider.ts` LOCAL `gitCommitFileDiff(workspace, repoPath, hash, relativePath, oldPath)` / CLOUD `params.oldPath`）；`TaskView.vue:725-737` 只对 `changeType === 'RENAMED'` 传 `oldPath`。

**验证（仓库落地回归用例，本轮实跑）**：

```
✓ getCommitFileDiffReadsRenamedFileFromItsOldPath（后端）：不传 oldPath 退化为 CREATED（旧缺陷钉死）、传了 before 取旧内容且 changeType=RENAMED
✓ commit file diff reads renamed file from its old path（Electron）：beforeContent='old content\n'、afterContent='new content\n'
✓ provider 测试 oldPath 透传断言（LOCAL IPC 第五参 / CLOUD 查询参数）
✓ 路由测试 oldPath 查询参数断言（getCommitFileDiff.mock.calls.at(-1) 含 'a.txt'）
```

**补充探针（临时，已删）**：P2/E2（`oldPath` 传 `../../etc/passwd` 被拒、传 `/etc/passwd` 时 before 为空且不泄宿主文件内容——git show 只读对象命名空间）；P3（复制文件不传 oldPath → CREATED，与 TaskView 口径一致）；P4（根提交 `^` 不存在 → CREATED，不误报）；P6/E5（嵌套目录花括号紧凑改名 `src/{a => b}/x.txt` 的文件清单统计正确合并）。全部通过。

**修复引入的新问题**：未发现。`beforePath` 与 `normalized` 均做 `..` 段校验；COPIED 行本就 before 为空，语义正确。

### 修复 4（原 Bug 4，低-中）：只读方法补 workspace 包含校验 —— 已修复

**位置**：`backend-ts/src/file/workspace-git.service.ts:575-587`（`resolveRepoRoot` 末尾 `isUnderReal(root, workspace)`，与写路径 `resolveRepository:319` 同款）；`desktop/electron/gitStatus.cjs:646-657`（`isUnderDir(realPathOrSelf(repoRoot), realPathOrSelf(ws))`，realpath 两侧比对兼容 macOS `/var → /private/var`）。

**验证（仓库落地回归用例，本轮实跑）**：

```
✓ readMethodsRejectWorkspacesNestedInsideAnOuterRepository（后端）：getLog/getBranches/getStashes/getRemotes/getCommitFiles 全部拒绝，getCommitFileDiff 读不到工作区之外的受控文件
✓ read methods reject workspaces nested inside an outer repository（Electron）：getGitCommitFileDiff 返回 unavailableReason='路径访问被拒绝' 且 afterContent 为空
```

**补充探针（临时，已删）**：P5a/E3a（workspace 本身是指向仓库的符号链接时只读方法照常工作——realpath 两侧比对不漏杀正常场景）；P5b/E3b（workspace 一级子目录是指向外部仓库的符号链接时，读方法拒绝且与写路径 `resolveRepository` 口径一致——修复没有把符号链接逃逸口子开回来）。全部通过。

**修复引入的新问题**：未发现数据面新问题。一处已知取舍（观察项，不计 bug）：嵌套工作区下 `listRepos`/`getStatus`（存量链路，本次未加校验）仍作用于外层仓库，而六个新只读方法拒绝——同一会话里「变更」视图能看外层仓库变更、「历史/分支/Stash」报「路径访问被拒绝」，界面呈撕裂态。但写路径（commit/pull/push）本就拒绝该场景，修复实际拉齐了读写口径；若要彻底一致需同步收紧 `getStatus`，那会改动存量行为，超出本轮范围。

---

## 二、确认的新 Bug

### 新 Bug 1（低）：`resetAll` 漏增 `commitFilesSeq`——切仓库 / 切会话后，在途的「提交文件清单」请求迟到会写进新仓库缓存，且缓存命中会让新仓库展示旧仓库的文件清单

**位置**：`desktop/src/composables/useGitManager.ts`

- `resetAll()`（`:53-77`）对 `logSeq`（`:54`）、`branchesSeq`（`:64`）、`stashesSeq`（`:69`）、`remotesSeq`（`:74`）都做了 `++` 使在途请求失效，**唯独没有 `commitFilesSeq++`**（该变量声明在 `:32`，只在 `toggleCommit` 的 `:122` 自增）；
- `toggleCommit`（`:113-138`）的迟到丢弃判据是 `if (seq !== commitFilesSeq) return`（`:126`）——reset 不推进这个序号，旧请求的 seq 依然「最新」，迟到结果照常写入。

**问题描述**：provider 变化（切仓库 / 切会话）时 `resetAll()` 把 `commitFiles` 换成空 Map，但在途的 `getCommitFiles` 请求（旧仓库）之后完成时，序号防护失效，其结果被写进**新仓库**的 `commitFiles` 缓存。这是第 1 轮 Bug 2（切仓库数据串扰）同一类问题在本 composable 里的遗漏角落——本轮修复给 log/branches/stashes/remotes 四路都补了防护，唯独漏了展开提交的文件清单这一路。

**触发场景**：多仓库模式（或切会话）下，用户在历史视图展开某个提交（文件清单请求在途），此时切换仓库下拉；旧请求返回后污染新仓库缓存。若新旧仓库共享同一提交哈希（例如同一远端的两个 clone、或 fork 仓库），用户在新仓库展开该哈希提交时命中被污染的缓存（`commitFiles.value.has(hash)` 直接返回、不再请求新 provider），**展示的是旧仓库的文件清单**。

**实际影响**：污染条目本身不可见（reset 后 `expandedCommit` 已收起，且不同仓库的 40 位哈希通常不同）；用户可见后果仅限「共享提交哈希 + 命中缓存」这一较窄组合（展示错文件清单，不丢数据、可收起重展开……但重展开仍命中缓存，只能靠切走再切回或刷新恢复）。定**低**severity：不影响数据安全、触发条件窄，但属于第 1 轮已修复问题的同类残留，且修复成本是一行。

**验证测试结论**（临时 spec `desktop/src/composables/zz-r2-probe.test.ts`，按「期望行为」断言故失败，失败即 bug 存在；仓库自带的 `provider 变化（切会话 / 切仓库）时全部状态清空` 只断言了切换当刻 size=0，没覆盖在途请求迟到，所以漏网）：

```
× F2: 切仓库时旧 provider 的在途 commitFiles 请求迟到不得污染新仓库缓存
    AssertionError: expected 1 to be +0   （releaseOld() 后 commitFiles.size 从 0 变 1——旧仓库结果写进了新仓库缓存）

✓ F2b: 迟到污染后的缓存命中会让新仓库展示旧仓库的文件清单（用户可见后果）
    （污染发生后在新仓库展开同一哈希：second.calls.getCommitFiles === 0——根本没请求新 provider；
      commitFiles.get('shared-hash') 等于旧仓库的 staleFiles——展示的是旧仓库文件清单）
```

**修复方向（仅建议，未改代码）**：`resetAll()` 里补一行 `commitFilesSeq++`（与其余四路对齐）；回归用例可在既有「provider 变化时全部状态清空」用例里追加「在途 toggleCommit 迟到后 size 仍为 0」断言，或直接把 F2 落为仓库用例。

**严重程度**：**低**。无数据损坏、触发窗口窄；但它是第 1 轮 Bug 2 修复的同类残留（防串扰承诺差一路），建议同任务补上。

---

## 三、低优先级备注（存量问题，本轮补充实证；按约定不计入 bug 数、单独说明）

### LOCAL 工作区变更列表：同级目录改名时 numstat 花括号紧凑形态还原失败，+/- 统计静默丢失（与 CLOUD 口径不一致）

**位置**：`desktop/electron/gitStatus.cjs:164-167`（`collectChangedFiles` 的 numstat 路径还原仍是简单切片 `filePath.slice(filePath.lastIndexOf(' => ') + 4)`），而同文件 `:664-674` 新增的 `numstatNewPath` 已能正确还原花括号形态——本次 diff 未改这四行（第 1 轮已备注「维持不改」），但本轮实测确认它在默认 git 配置下真实发生，且与新增助手函数口径不一致，故单独说明。

**实测证据**（临时探针 E4 + 后端对照 P7，已删）：

```
E4 raw numstat: "1\t0\tsrc/{a.txt => b.txt}"        ← git 2.50 默认 diff.renames 开启，同级目录改名即输出花括号紧凑形态
E4 LOCAL changed entry: {"insertions":0,"deletions":0,"path":"src/b.txt","oldPath":"src/a.txt","changeType":"RENAMED"}
E4 numstatNewPath would restore: src/b.txt          ← 用同文件新助手即可正确还原
P7（后端对照）raw numstat: "1\t0\tsrc/{a.txt => b.txt}" → CLOUD changed entry insertions:1 deletions:0（正确）
```

即：LOCAL 模式下工作区发生同级目录改名（`git mv src/a.txt src/b.txt`）时，变更树该文件显示「改名」徽章但 **+0/-0**；CLOUD 模式同一场景显示 +1/-0。新增的提交文件清单路径（`getGitCommitFiles` / `getCommitFiles`）两端都已用 `numstatNewPath`，不受影响。

**影响与建议**：仅 LOCAL 工作区变更列表的统计数字失真（文件本身、改名徽章、可提交性均正常），定**低**。修复为一处替换：`collectChangedFiles` 里改用同文件的 `numstatNewPath(parts[parts.length - 1])`。因属存量逻辑且本次 diff 未触及该行，未计入本轮新 bug 数。

---

## 四、误报已排除（本轮探针 + 走查验证后不构成 bug）

1. **预存在冲突场景的 stash apply**（P1/E1）：走冲突契约、stash 保留、既有冲突现场不被破坏；消息未区分冲突来源但引导正确。
2. **`oldPath` 逃逸**（P2/E2）：`..` 段两端拒绝；绝对路径 before 为空、不泄宿主文件内容（`git show` 只读 git 对象）。
3. **复制文件 / 根提交的 changeType**（P3/P4）：COPIED 不传 oldPath → CREATED（before 本就是空，语义正确）；根提交 `^` 不存在 → CREATED。
4. **符号链接场景**（P5/E3）：workspace 符号链接不漏杀；repoPath 符号链接指向外部仓库时读写两端一致拒绝。
5. **嵌套花括号改名的提交清单统计**（P6/E5）：`src/{a => b}/x.txt` 两端均正确合并 numstat。
6. **log 请求竞态**（F1）与 **provider null 往返 / 错误态重载 / A→B→A 连切**（F3/F4/F5）：序号防护与重载链路均正确。
7. **非 git 工作区 / 越界 repoPath 的错误契约**（E6）：`当前工作区不是 Git 仓库` / `路径访问被拒绝`，与第 1 轮口径一致。
8. **`restoreActiveTab` 对 `git` 类型的处理**：持久化 `{type:'git', tabId:'git'}` 在冷启动后按 tabId 找不到目标（git Tab 不重建）→ 回落 chat，无异常、无错建（与 file/diff/trace 一致）。
9. **点「获取远端更新」双 fetch**（显式 fetch + `handleRefreshAll → refreshGitRemote` 内部再 fetch）：与侧边栏存量 `refreshAll(remote=true)` 模式一致，第 1 轮已判定非 bug，本轮维持。
10. **`getLog` 的 `path` 过滤参数未做格式校验**：git 自身拒绝仓库外 pathspec（退出码非 0 → 返 `[]`），无越权读取；前端未使用该参数。

## 附录 A：本轮临时验证测试（已按约定删除，未提交）

- `backend-ts/src/file/zz-r2-probe.spec.ts`（P1 预存在冲突 stash apply / P2 oldPath 逃逸 / P3 复制文件 / P4 根提交 / P5 符号链接 / P6 嵌套花括号改名 / P7 CLOUD 工作区改名统计对照）
- `desktop/electron/zz-r2-probe.test.cjs`（E1 预存在冲突 stash apply / E2 oldPath 逃逸 / E3 符号链接 / E4 LOCAL 花括号统计丢失实证 / E5 嵌套改名提交清单 / E6 错误契约）
- `desktop/src/composables/zz-r2-probe.test.ts`（F1 log 竞态 / F2+F2b commitFilesSeq 污染与新 bug 实证 / F3 provider null 往返 / F4 错误态重载 / F5 A→B→A 连切）

运行方式：`cd backend-ts && npx vitest run src/file/zz-r2-probe.spec.ts`；`cd desktop && node --test electron/zz-r2-probe.test.cjs`；`cd desktop && npx vitest run src/composables/zz-r2-probe.test.ts`。

## 附录 B：修复复核的命令与输出

```
cd backend-ts && npx vitest run src/file/workspace-git.service.spec.ts src/file/git-write-operation.service.spec.ts src/file/file.routes.spec.ts
  → Test Files 3 passed (3) / Tests 39 passed (39)
cd backend-ts && npx vitest run src/file
  → Test Files 8 passed (8) / Tests 101 passed (101)
cd desktop && node --test electron/gitStatus.test.cjs electron/gitOperations.test.cjs
  → # tests 43 / # pass 42 / # fail 1（已知环境差异：本机全局 git 身份，主工作区同样失败）
cd desktop && npx vitest run src/composables/useGitManager.test.ts src/composables/workspace-git-provider.test.ts src/composables/useCenterTabs.test.ts src/utils/git-manager.test.ts
  → Test Files 4 passed (4) / Tests 83 passed (83)
cd desktop && npx vitest run
  → Test Files 144 passed (144) / Tests 1373 passed (1373)
```
