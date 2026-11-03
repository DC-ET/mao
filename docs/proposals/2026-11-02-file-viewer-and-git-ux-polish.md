# 提案：看代码、看差异、交接仓库不再卡手 —— 工作区文件预览与 Git 细节打磨

> 工作区文件预览（`FileViewer` / `FileDiffViewer`）和中央 Git 管理器（`GitManagerPanel`）是桌面端最核心的「生产力面板」，有三个每天都在绊脚的体验缺口（主体纯前端即可解决，后端仅 3 处极薄 Git 参数扩展）：
> 1. **看长日志或长 JSON 时没有「自动换行（Word Wrap）」开关，也找不到「下载」按钮**：`useMonacoViewer.ts:53` 硬编码了 `wordWrap: 'off'`，Agent 产出一行几千字符的 JSON / 日志 / Markdown 源码时，用户只能不停拖底部横向滚动条；而且在中心 Tab 打开了一个文本/图片文件（`FileViewer.vue`），右上角只有一个「刷新」按钮，想把这个文件下载到本地，还得去右栏文件树里翻出它再右键点下载（反观 CSV / XLSX / DOCX 预览子组件反而都有下载按钮）。
> 2. **Diff 查看器写死「左右并排（Side-by-Side）」，窄屏或三栏全开时代码被挤成两条缝**：`FileDiffViewer.vue:136` 硬编码了 `renderSideBySide: true`——当用户同时开着左栏任务列表和右栏检查器时，中间区域只有 600~700px 宽，左右分栏后每边只剩 300px，稍微长一点的代码行根本没法看；而 Monaco Diff Editor 原生就支持一键切换「并排 / 行内（Inline）」视图与「上一处 / 下一处变更」跳转。
> 3. **Git 历史与对比视图跟「对话」断联**：在 Git 管理器「历史」Tab 里看到某个历史提交改出了 bug，只能点复制 7 位 hash 再切回聊天框手打说明；而且提交展开后**只显示单行标题（`%s`），提交正文的详细说明（`%b`）完全看不到**；想按提交信息里的关键词搜一个「印象中改过」的提交也搜不了（前端从未传过后端已有的 `path` 过滤，关键词搜索则前后端都没有），只能一页页翻；在「分支」Tab 里也只能从已有的远端分支建跟踪分支，不能基于当前 HEAD 新建一个本地分支。

- 状态：已立项（技术方案见 [docs/plan/2026-11-03-file-viewer-and-git-ux-polish-technical-design.md](../plan/2026-11-03-file-viewer-and-git-ux-polish-technical-design.md)；§8 两条评审定案均已采纳落地）
- 日期：2026-11-02
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小~中（三项合计约 2~3 人日；**零数据库迁移**，90% 为前端既有能力暴露，后端 Git 扩展 3 处极薄参数：提交正文 / 关键词搜索 / 新建本地分支）
- 关联：`desktop/src/components/center/FileViewer.vue`、`desktop/src/composables/useMonacoViewer.ts`、`desktop/src/components/center/FileDiffViewer.vue`、`desktop/src/components/git/GitHistoryView.vue`、`desktop/src/components/git/GitBranchesView.vue`、`desktop/src/composables/workspace-git-provider.ts`、`desktop/electron/gitStatus.cjs`、`backend-ts/src/file/workspace-git.service.ts`、`backend-ts/src/file/git-write-operation.service.ts`、`backend-ts/src/file/file.routes.ts`

## 1. 背景与现状

### 1.1 现状逐项核对（代码可查）

| 场景 | 现状 | 代码证据 |
|---|---|---|
| `FileViewer` 文本与图片操作栏 | 右上角只有 Markdown 的「预览/源码」切换，左上角只有一个「刷新」图标；**无自动换行切换、无一键复制全文、无下载按钮、无添加到对话按钮** | `FileViewer.vue:88-96`、`useMonacoViewer.ts:53`（`wordWrap: 'off'` 硬编码） |
| `FileDiffViewer` 视图模式 | `renderSideBySide: true` 硬编码；无「并排 / 行内」切换，也无「上一处 / 下一处差异（`↑` / `↓`）」快捷导航 | `FileDiffViewer.vue:131-149` |
| `GitHistoryView` 提交详情与联动 | `LOG_FORMAT = '%H%x00%h%x00%s%x00%an%x00%aI%x00%D'` 只取了标题 `%s`，多行 commit body 丢失；历史行无「引用到对话」入口，历史列表也不支持按文件路径或提交信息关键词过滤（虽然后端 `getLog` 第 380 行**已经实现了 `opts.path` 过滤参数**，前端却从未传过；关键词搜索则后端 `getLog`（`workspace-git.service.ts:368-382`）与 Electron `getGitLog`（`gitStatus.cjs:772`）两处都没有） | `workspace-git.service.ts:169, 368-382`、`gitStatus.cjs:772`、`GitHistoryView.vue:16-53` |
| `GitBranchesView` 新建本地分支 | `resolveSwitchTarget` 写死了 `if (create && !isRemoteRef) throw '仅支持从远端分支创建跟踪分支'`，用户在 Git 管理器里想从当前分支切一个 `feat/xxx` 本地新分支，界面上做不到 | `git-write-operation.service.ts:733-736`、`GitBranchesView.vue:10-39` |

### 1.2 为什么这件事性价比极高

- **Monaco 能力现成**：`editor.updateOptions({ wordWrap: 'on' | 'off' })`、`diffEditor.updateOptions({ renderSideBySide: false })`、`diffEditor.getLineChanges()` 全部是已加载的 Monaco 实例自带 API，**零新增 npm 依赖、零包体积增长**。
- **后端参数现成**：`GET /v1/files/workspace-git-log` 和 Electron IPC `gitLog` 早就接好了 `path` 过滤参数（`file.routes.ts:335`），前端只需要加一个筛选框就能用。

## 2. 目标 / 非目标

**目标**

1. **P1 `FileViewer` 顶部工具条补完**：
   - 将零散悬浮在左上角/右上角的按钮收敛为紧凑的顶部浮动/常驻工具条：
     - **自动换行（Word Wrap）开关**：文本源码模式下可一键切换换行（偏好记入 `localStorage`，下次打开沿用）；
     - **复制全文 / 添加到对话（`@file`） / 下载文件**：文本、Markdown、图片预览均可一键下载（直接复用 `props.provider.downloadFile`）或插入当前聊天输入框。
2. **P1 `FileDiffViewer` 支持「并排 / 行内」切换与变更跳转**：
   - 工具条增加「并排 / 行内（Inline）」切换按钮（窄屏 `< 640px` 默认自动切为行内模式，宽屏默认并排并记入 `localStorage`）；
   - 显示当前文件的变更处数（`共 N 处变更`），并提供 `↑` / `↓` 按钮在各处变更 hunk 之间快速跳转。
3. **P2 Git 管理器体验闭环**：
   - **提交历史看得到正文、搜得到文件与提交信息、引得进对话**：
     - 展开某条提交时，若该提交有正文（body），在文件清单上方展示完整提交说明；
     - 历史视图顶部增加「按文件路径过滤」输入框（直接对接后端已有的 `path` 参数）；
     - 历史视图顶部增加「按提交信息搜索」输入框（后端 `getLog` 增加 `--grep` 关键词参数，CLOUD 与 LOCAL Electron 同步支持，与路径过滤可叠加）；
     - 每条提交行与展开后的单文件行增加「添加到对话」快捷操作（将 `提交 abc1234 (标题)` 或文件路径插入当前聊天输入框，方便直接对 Agent 说「检查一下这个提交为什么改坏了」）。
   - **支持基于当前 HEAD 新建本地分支**：
     - 「分支」视图本地分支分组头部增加「+ 新建分支」按钮，输入合法分支名即基于当前 HEAD 执行 `git switch -c <name>`（放开 `resolveSwitchTarget` 对本地 `create=true` 的限制，CLOUD 与 LOCAL Electron IPC 同步支持）。

**非目标**

- 不把 `FileViewer` 变成在线代码编辑器（保持 `readOnly: true` 只读定位，改文件走 Agent 或文件管理器的上传/重命名）。
- 不做 Agent 结构化 Git 工具链（2026-10-19 已否决，不给 Agent 加 git tool，只打磨人类用户使用的 Git 管理器面板）。
- 不做 Git rebase / cherry-pick / merge 等复杂冲突操作。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| Agent 结构化 Git 工具链（2026-10-19 否决） | 不新增任何 Agent 内置工具，不碰 `ToolRegistry`；仅完善中央 Git 管理器 UI 与用户手动新建本地分支。 |
| 工作区文件预览完整度（0.0.354 已实施） | 0.0.354 解决的是新格式（CSV/ZIP/XLSX/DOCX/音视频），而那批新格式组件都带了完善的工具栏（复制/下载/刷新）；本提案是把老资格的文本/图片/Diff 预览器的工具条补齐到同一水准。 |

## 4. 方案设计

### 4.1 `FileViewer.vue` & `useMonacoViewer.ts`

- `useMonacoViewer` 增加可选参数 `wordWrap?: Ref<'on' | 'off'>`，watch 变化时调用 `editor?.updateOptions({ wordWrap: options.wordWrap.value })`。
- `FileViewer.vue` 在 `state === 'ready'` 或 `state === 'image'` 时，右上角工具组统一提供：
  - `[预览 | 源码]`（仅 Markdown）
  - `[自动换行]`（仅源码态）
  - `[复制全文]`（仅文本态）
  - `[引用到对话]`（调 `add-file-to-chat` 通道）
  - `[下载]`（`provider.downloadFile` 可用时显示）
  - `[刷新]`

### 4.2 `FileDiffViewer.vue`

- 工具条采用**右上角浮动胶囊**（2026-11-02 定案，见 §8）：与现有 Markdown 预览切换同位置，紧凑半透明（默认 `opacity: .85`、hover 恢复 1），绝对定位内嵌于编辑器右上角（距顶约 8px、右侧留约 12px，避开 Monaco 垂直滚动条轨道）；悬浮不占文档流，不推挤首行代码。胶囊内依次为 `[并排 | 行内]` 切换、`共 N 处变更` 计数、`↑` / `↓` 跳转。
- 增加 `inlineMode = ref(window.innerWidth < 640 || localStorage.getItem('mao:diff-inline') === '1')`；
- 监听切换调用 `diffEditor?.updateOptions({ renderSideBySide: !inlineMode.value })`；
- 利用 `diffEditor.getLineChanges()` 计算 `hunkCount`，点 `↑` / `↓` 时定位到对应 `modifiedStartLineNumber` 并 `revealLineInCenter`。

### 4.3 Git 历史详情、路径过滤与新建本地分支

- **提交正文**：`getCommitFiles`（展开单条提交时才调用，列表接口 `getLog` 不改，保证列表载荷轻量！）顺带执行一次 `git show -s --format=%B <hash>` 返回 `messageBody?: string`，展开区若有除首行外的正文则以 `<pre>` 展示。
- **历史按路径过滤**：`GitHistoryView.vue` 顶部筛选区加紧凑输入框 `按文件路径筛选（如 src/app.ts）`，防抖后传给 `getLog({ limit: 50, offset: 0, path })`（后端 `workspace-git.service.ts:380` 与 Electron `gitStatus.cjs:772` 的 `getGitLog` 已支持 `path` 参数）。
- **历史按提交信息搜索**（2026-11-02 定案，见 §8）：后端 `getLog` 的 opts 增加可选 `keyword?: string`，trim 后非空时在 `--` 之前追加 `--grep=<keyword> --fixed-strings -i`——字面匹配、大小写不敏感，关键词里的正则元字符（如 `fix.*(`）不会导致 git 报错；`--grep` 与 `-- <path>` 天然 AND 组合，空 keyword 不产生该组参数、行为与现状逐字节一致。三处透传同步补：CLOUD 路由 `file.routes.ts:335` 的 `workspace-git-log` 增加 `keyword` query；Electron `gitStatus.cjs:772` 的 `getGitLog` 同款加参（与后端同命令同解析）；桌面 `electron.d.ts:304` 的 `gitLog` options 类型与 `workspace-git-provider.ts:257` 的 `getLog` opts 扩 `keyword`。前端路径与关键词两个输入框并排、各带 placeholder，任一留空即忽略该条件，防抖约 300ms 后统一触发查询并重置分页 `offset = 0`。
- **新建本地分支**：`resolveSwitchTarget(branch, create, remotes)`：当 `create === true` 且 `branch` 不是 `<remote>/...` 时，校验本地同名分支不存在后返回 `{ args: ['switch', '-c', name], localBranch: name }`；Electron `gitOperations.cjs` 同步该 5 行分支逻辑。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | `FileViewer.vue` / `useMonacoViewer.ts`（换行/复制/下载/加对话）；`FileDiffViewer.vue`（右上角浮动胶囊：并排/行内切换 + 变更计数 + 上下处跳转）；`GitHistoryView.vue` / `GitBranchesView.vue`（提交正文、路径与提交信息双筛选、新建分支按钮）；`workspace-git-provider.ts` / `electron.d.ts`（getLog opts 扩 `keyword`） |
| desktop/electron | `gitOperations.cjs` 的 `switchBranch` 放开本地 `create=true`（`git switch -c <name>`）；`gitStatus.cjs` 的 `getGitLog` 增加 `keyword` 透传（`--grep=<kw> --fixed-strings -i`） |
| backend-ts | `workspace-git.service.ts` 的 `getCommitFiles` 增加返回 `body?: string`、`getLog` 增加 `keyword` 搜索参数（`--grep`）并经 `file.routes.ts` 的 `workspace-git-log` 路由透传；`git-write-operation.service.ts` 的 `resolveSwitchTarget` 支持本地新建分支 |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 新建本地分支时与已有本地分支重名 | `git switch -c` 遇同名分支天然非零退出，classify 返回明确「分支已存在」提示，不覆盖已有分支 |
| 新建本地分支名以 `-` 开头造成 git option 注入 | 复用 `isValidBranchRefName`（首字符禁 `-`、禁 `..` / `@{` / 空白等），前后端同规则校验 |
| `FileDiffViewer` 浮动胶囊可能遮挡右上角代码或滚动条 | 2026-11-02 已定案用胶囊（见 §8）：紧凑半透明（hover 恢复不透明）、内嵌定位避开 Monaco 垂直滚动条轨道，不占文档流不推挤首行；仅覆盖极小阅读区，可接受 |
| 提交信息关键词含正则元字符导致 `git log` 报错 | `--grep` 配 `--fixed-strings` 字面匹配，元字符原样匹配不解释；关键词 trim 后加长度上限（如 100 字符），空值不加参数 |

## 7. 测试要点

1. `useMonacoViewer`：切换 `wordWrap` 时正确调用 `editor.updateOptions({ wordWrap })`。
2. `FileDiffViewer`：切换并排 / 行内模式时调用 `diffEditor.updateOptions({ renderSideBySide })`；上下变更跳转按 `getLineChanges()` 顺序循环定位。
3. `getCommitFiles`：带多行 commit message 的提交返回完整 `body`。
4. `resolveSwitchTarget`：`create=true` + 普通分支名 `feat/demo` → 生成 `['switch', '-c', 'feat/demo']`；`create=true` + `origin/main` → 保持原 `['switch', '-c', 'main', '--track', 'origin/main']` 行为不变。
5. `getLog` / `getGitLog`：`keyword` 非空时命令含 `--grep=<kw> --fixed-strings -i`，与 `path` 同时传入时两组过滤并存；空 `keyword` 不产生 `--grep` 参数；含正则元字符的关键词（`fix.*(`）按字面匹配且 git 不报错。

## 8. 决策记录

2026-11-02 评审定案（原两条待确认决策已闭环）：

1. **`FileDiffViewer` 工具条采用右上角浮动胶囊**（不做 28px 常驻薄条）：与现有 Markdown 预览切换同位置，紧凑半透明，用户视线不用离开代码区；悬浮不占文档流，不推挤首行代码。遮挡风险用「半透明 + 内嵌定位避开滚动条」消化，见 §6 风险表。
2. **Git 历史筛选支持按提交信息搜索**：后端 `getLog` 增加 `--grep=<keyword>` 关键词参数（`--fixed-strings -i`，字面、大小写不敏感），CLOUD 与 LOCAL Electron 同步支持；前端与路径过滤并列为两个输入框、可组合使用。仅约 3 行命令参数 + 三处透传，换取「印象中的改动直接搜得到」。
