# 文件预览与 Git 细节打磨技术方案（换行/下载、并排行内切换、提交正文与筛选、新建本地分支）

- 状态：待实施
- 日期：2026-11-03
- 需求来源：[提案：看代码、看差异、交接仓库不再卡手 —— 工作区文件预览与 Git 细节打磨](../proposals/2026-11-02-file-viewer-and-git-ux-polish.md)（§8 两条评审定案已采纳：Diff 工具条用右上角浮动胶囊、Git 历史支持按提交信息搜索）
- 规模：小~中（约 2~3 人日；**零数据库迁移**；**零新增 npm 依赖**，全部用已加载的 Monaco API 与既有 git 子进程）

## 1. 需求背景

### 1.1 现状核对（代码可查，行号为 2026-11-03 主干）

| 场景 | 现状 | 代码证据 |
|---|---|---|
| Monaco 文本查看器换行 | `wordWrap: 'off'` 硬编码在创建参数里，创建后无任何 `updateOptions` 通路；`useMonacoViewer` 的 options 签名（6 个参数）中没有 wordWrap | `desktop/src/composables/useMonacoViewer.ts:53`、`useMonacoViewer.ts:6-14` |
| `FileViewer` 文本态操作栏 | 只有 Markdown 的「预览/源码」切换（右上角悬浮）+ 左上角悬浮「刷新」；无换行开关、无复制全文、无下载、无引用到对话 | `desktop/src/components/center/FileViewer.vue:88-96` |
| `FileViewer` 图片态操作栏 | 整个分支只有 `img` + meta 文本，**一个操作按钮都没有**（刷新/下载都做不了） | `FileViewer.vue:10-13` |
| 下载能力 | `WorkspaceFileProvider.downloadFile?` 已在契约中：CLOUD（`:525`）与 LOCAL（`:312`）实现，project/无会话 provider 不实现；CSV 预览已用 `v-if="provider?.downloadFile"` 同款守卫 | `workspace-file-provider.ts:104,312,525,364`、`CsvTableView.vue:11` |
| 「添加到对话」通道 | `add-file-to-chat` 事件链已贯通：TaskView `handleAddFileToChat` → `insertFileReference`；CenterTabContainer 已挂在 FileManagerPanel / GitManagerPanel 上并带 `affectsCurrentSession` 守卫；**FileViewer 尚未接入** | `TaskView.vue:347-349`、`CenterTabContainer.vue:47,64,146-149` |
| 「引用到对话」（文本引用） | ChatInputHandle 有 `addReplyQuote(text)`：追加引用 chip 到输入框上方（`capReplyQuote` 截断）；TaskView 已有 `quoteReplyToChat(text)` 封装 | `ChatInput.vue:1262`、`TaskView.vue:314-318,351-353` |
| Diff 查看器视图模式 | `renderSideBySide: true` 硬编码；无并排/行内切换、无变更跳转 | `desktop/src/components/center/FileDiffViewer.vue:132-147` |
| Diff 跳转所需 API | `getLineChanges()` + `revealLineInCenter` 已在 `revealFirstDiffChange` 使用；`onDidUpdateDiff` 监听已有（reveal 首处变更后自毁） | `FileDiffViewer.vue:118-128,161-167` |
| Git 历史·提交正文 | `LOG_FORMAT = '%H%x00%h%x00%s%x00%an%x00%aI%x00%D'` 只取标题 `%s`；`getCommitFiles` 仅执行 `--name-status` / `--numstat` 两次 `git show`，返回 `{hash, files}` 无正文 | `backend-ts/src/file/workspace-git.service.ts:169,399-439`、`desktop/electron/gitStatus.cjs:772-787,796-833` |
| Git 历史·路径过滤 | 后端 `getLog` 与 Electron `getGitLog` **均已支持** `path` 参数，CLOUD 路由也已透传；**前端 `useGitManager.loadLog` 从未传**，界面上也没有输入框 | `workspace-git.service.ts:380-381`、`gitStatus.cjs:777`、`file.routes.ts:329-337`、`useGitManager.ts:119-141` |
| Git 历史·关键词搜索 | 前后端（CLOUD 与 Electron 两侧）**都没有**：`getLog` opts 只有 `{limit, offset, path}` | `workspace-git.service.ts:371-375`、`workspace-git-provider.ts:33`、`electron.d.ts:304` |
| Git 历史·引用到对话 | 历史行只有「复制 hash」（`copyHash`），无添加到对话入口 | `GitHistoryView.vue:97-101` |
| 新建本地分支 | `resolveSwitchTarget` 在 `create && !isRemoteRef` 时直接抛「仅支持从远端分支创建跟踪分支」；CLOUD 与 Electron 两侧同逻辑 | `backend-ts/src/file/git-write-operation.service.ts:732-735`、`desktop/electron/gitOperations.cjs:401-403` |
| 分支名校验 | 前端 `isValidBranchName` 首字符类已排除 `-`；后端写侧 `BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/` **不拒**首字符 `-` | `desktop/src/utils/git-manager.ts:144-150`、`git-write-operation.service.ts:27` |
| 同名分支冲突路径 | `git switch -c` 遇同名分支非零退出，后端 `classify` 兜底产出「切换分支失败：fatal: a branch named … already exists」，Electron `describeGitFailure` 同样裸透传 git 原文 | `git-write-operation.service.ts:285-288,667-679`、`gitOperations.cjs:482-489,61-70` |

### 1.2 要解决的问题

1. **长行内容看不了、带走难**：Agent 产出单行几千字符的 JSON/日志时只能拖横向滚动条；中心 Tab 打开的文本/图片文件想下载，得去右栏文件树里翻出来右键，图片态甚至完全没有操作入口。
2. **窄屏 Diff 没法看**：三栏全开时中间区域仅 600~700px，写死的左右并排把每边挤到 300px；Monaco 原生支持的行内视图与变更跳转没有被暴露。
3. **Git 历史与对话断联、检索缺失**：提交正文看不到、按提交信息搜不了、按文件路径过滤后端支持但前端没接；看到问题提交只能复制 hash 手打说明；也无法基于当前 HEAD 直接建本地分支。

### 1.3 关键事实（设计建立在其上）

- `useMonacoViewer` 已把 `onEditor` 回调、`isDark` watch 等扩展点留好，加 `wordWrap` 参数与一条 watch 即可，不影响现有唯一调用方 `FileViewer.vue`。
- `FileDiffViewer` 处于 `CenterTabContainer` 的 `KeepAlive(max: 20)` 内（`CenterTabContainer.vue:3,12-18`），组件可长期驻留——inline 偏好读 `localStorage` 一次 + watch 切换即可，不需要响应系统主题式的全局同步。
- `FileDiffViewer` 根元素已是 `position: relative`（`FileDiffViewer.vue:267`），右上角浮动胶囊可直接绝对定位，不新增包裹层。
- `useGitManager.loadLog` 的分页语义是「追加式」：`logOffset` 累加返回条数、`logExhausted = 条数 < LOG_PAGE_SIZE(50)`（`useGitManager.ts:9,119-141`）——加筛选参数后「刷新（reset=true）」天然重置 offset，「加载更多」沿用同参数即可，无需改分页机制。
- `toggleCommit` 已有 `commitFilesSeq` 乱序防护与 `commitFiles` Map 缓存（`useGitManager.ts:153-178`），提交正文用同一次请求带回、按 hash 存进第二个 Map，不新增请求时序。
- 写侧分支校验与切换已收敛在 `resolveSwitchTarget`（CLOUD :712-740 / Electron gitOperations.cjs:384-407 两份同规则实现），`switchBranch` 的 stash 生命周期（dirty → stash → switch → 失败恢复 → 成功恢复）两条链路都已就绪——新建本地分支只需要放开目标解析这一处。
- 后端 `classify`（`git-write-operation.service.ts:667-679`）按 output 关键字归类 git 失败；「分支已存在」目前落进兜底透传 git 原文，需要在 switch 调用点专判。
- 业务错误信封：`BusinessException` 一律 HTTP 200 + `code≠0`，桌面 api 拦截器自动 `ElMessage.error`；Electron 侧 `run` 操作返回 `{success:false, error}` 由 `useGitOperations`/`GitManagerPanel` toast（`GitManagerPanel.vue:416-418` 的 `handleSwitchBranch` 即此通道）。
- `@element-plus/icons-vue` 已是依赖（GitHistoryView 已引 ArrowRight/ArrowDown），新增图标不再加包。
- 本方案**不新增任何内置 Agent 工具、不新增 LLM 调用场景**，不触发 AGENTS.md 中 toolDisplay.ts / no-progress-notice.ts / LlmCallScene 三处同步义务。

## 2. 需求描述

### 2.1 要做的（六项）

1. **`FileViewer` 顶部工具条补完（文本 / Markdown / 图片）**：把散落的左上「刷新」与右上「预览/源码」收敛为一个右上角常驻浮动工具条，从左到右依次为：`[预览|源码]`（仅 Markdown）、`[换行]`（仅源码态，切换 `wordWrap: 'on'|'off'`，偏好写入 `localStorage` 下次沿用）、`[复制]`（复制全文，title=复制全文）、`[引用]`（引用到对话，把当前文件路径插入聊天输入框）、`[下载]`（`provider.downloadFile` 存在时显示）、`[刷新]`。图片态提供 `[引用][下载][刷新]` 三个按钮。
2. **`FileDiffViewer` 右上角浮动胶囊**：胶囊内依次为 `[并排|行内]` 切换、`共 N 处变更` 计数、`↑`/`↓` 上一处/下一处变更跳转（循环、纯删除 hunk 落到 original 编辑器行号）。窄屏首开默认行内、宽屏默认并排，用户切换后以 `localStorage` 为准。
3. **Git 历史展示提交正文**：`getCommitFiles`（CLOUD 与 Electron 两侧）增加第三次 `git show -s --format=%B`，返回 `body`（去除首行标题后的正文，trim，可为空串）；展开提交时正文以 `<pre>` 展示在文件清单上方，空则不渲染。列表接口 `getLog` 不变。
4. **Git 历史双筛选**：历史视图顶部固定筛选条，两个输入框并排——「按文件路径筛选（如 src/app.ts）」与「按提交信息搜索」；任一留空即忽略该条件，输入 300ms 防抖后触发 `loadLog(true)` 并重置分页；「加载更多」沿用当前筛选值。路径过滤接后端**已有**的 `path` 参数；关键词为**新增** `keyword` 参数（`--grep=<kw> --fixed-strings -i`，trim 后截断到 100 字符），CLOUD 路由、Electron IPC、类型声明、provider、useGitManager 五处同步透传。
5. **Git 历史「添加到对话」**：提交行 hover 显示图标按钮，点击把 `提交 abc1234（标题）` 以引用 chip 插入聊天输入框（走 TaskView 既有 `quoteReplyToChat` → `addReplyQuote` 链路，新增 `add-commit-to-chat` 事件透传）；展开后的单文件行 hover 显示同款按钮，把文件路径以 `@file` 引用插入（复用既有 `add-file-to-chat` 链路，与 GitChangeList 同语义）。
6. **基于当前 HEAD 新建本地分支**：「分支」视图本地分支分组头部加「+ 新建分支」按钮，展开行内输入行（输入框 + 实时校验提示 + 创建/取消）；校验用既有 `isValidBranchName`，通过后 `git switch -c <name>`（放开 `resolveSwitchTarget` 对本地 `create=true` 的限制，CLOUD 与 Electron 同步）；同名分支由 git 非零退出天然拦截，专判映射为「分支已存在，请换一个名字」；创建路径显式拒绝首字符 `-` 的分支名。远端「跟踪并切换」行为逐位不变。

### 2.2 明确不做的

- **不把 `FileViewer` 变成在线编辑器**：`readOnly: true` / `domReadOnly: true` 不动，改文件走 Agent 或文件管理器上传/重命名。
- **不做 Agent 结构化 Git 工具链**（2026-10-19 已否决）：不碰 `ToolRegistry`、不加内置工具、不给 Agent 暴露任何 git 能力；本方案全部是给人类用户的 Git 管理器面板与预览器。
- **不做 rebase / cherry-pick / merge / 分支重命名 / 分支删除**：只加「新建本地分支」一种写操作。
- **不做提交列表接口的正文返回**：`getLog` 的 LOG_FORMAT 与返回结构不变，正文只在展开单条提交的 `getCommitFiles` 里取（保证列表载荷轻量）。
- **不做 diff 视图模式的会话级/全局状态同步**：偏好只存 `localStorage`，多开 Tab 各自读取，不做 Pinia 共享、不做跨 Tab 广播。
- **不做历史列表虚拟滚动 / 无限流优化**：维持「加载更多」分页现状。
- **不做 CSV/XLSX/ZIP/DOCX/媒体预览组件的改动**：那批组件工具栏已完备（0.0.354 交付），本方案只补文本/图片/Diff 三类老预览器。
- **不做 mao-cli / admin / mao-agent / 安卓壳改动**：Git 管理器与中心预览器均为桌面端专属；admin 无对应页面。
- **不改 LOCAL 的远程跟踪语义**：`create=true + <remote>/<branch>` 仍走 `git switch -c <local> --track <remote>/<branch>`，该分支代码逐行保留。
- **零数据库迁移**、不动 `DEPLOY.md`、不加 Playwright 用例（见 §7.5）。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | FileViewer 工具条形态 | **右上角单一常驻浮动条**，左上刷新按钮取消、并入工具条；按钮为文字小按钮（沿用 `.mode-btn` 视觉），text 短标签 + title 全称 | 提案 §2.1 定案「收敛为紧凑工具条」；两个悬浮点（左上/右上）合并为一个视觉锚点，图片态复用同一容器与样式；不占文档流，Markdown 渲染区不受推挤 |
| D2 | localStorage 键名 | `aw-file-word-wrap`（'1'/'0'）、`aw-diff-inline`（'1'/'0'） | 修正提案的 `mao:diff-inline` 命名：仓内既有键均为 `aw-` 前缀（`aw-theme-mode`），保持一致 |
| D3 | Diff inline 初始值 | `stored != null ? stored === '1' : window.innerWidth < 640`——**无存储时按视口宽窄给默认值，有过切换后永久以存储为准** | 提案公式（`innerWidth < 640 || stored === '1'`）会让窄屏用户永远切不回并排；「存储优先、视口兜底」语义正确 |
| D4 | 变更计数与跳转实现 | 把现有 `onDidUpdateDiff` **一次性自毁监听改为常驻监听**：每次回调刷新 `hunkCount`，首处 reveal 用 `revealedFirst` 布尔只做一次；跳转游标 `hunkIndex` 为模块内变量不入响应式，`(i+Δ+n)%n` 循环，`modifiedStartLineNumber > 0` 走 modified 编辑器、否则走 original | 一次监听同时供计数与 reveal，比双监听少一处生命周期；getLineChanges 返回顺序即文档顺序，循环跳转无需排序 |
| D5 | 提交正文契约 | `getCommitFiles` 返回增加 **`body: string`（必有字段，去除首行标题后 trim，空串表示无正文）**；执行 `git show -s --format=%B <hash>` 第三次调用 | 展开时才请求、列表接口不动；「必有字段 + 空串」比 `body?: string` 少一层 undefined 分叉，前后端与 Electron 三侧判空口径统一 |
| D6 | 筛选状态归属 | `logPathFilter` / `logKeyword` 两个 ref 放 `useGitManager`，暴露 `setLogFilters(patch)`（内部 300ms 防抖 trailing + `loadLog(true)`）；GitHistoryView 保持纯展示组件，props 进、update 事件出；仓库切换重置块内清空两筛选与正文缓存 | 与现有 `logEntries/logOffset/logExhausted` 同居一处的既有归属；`onScopeDispose` 清防抖定时器 |
| D7 | keyword 搜索参数 | `getLog` opts 增 `keyword?: string | null`：trim → `slice(0, 100)` → 非空时在 `--` 之前追加 `--grep=<kw> --fixed-strings -i`；空值不产生参数（行为与现状逐字节一致）；`--grep` 与 `-- <path>` 天然 AND | `--fixed-strings` 让 `fix.*(` 等元字符按字面匹配不炸命令，`-i` 大小写不敏感；与提案 §8 定案 2 一致；截断而非报错——搜索框 maxlength=100 前端已拦，后端截断是纵深防御 |
| D8 | 新建分支冲突与注入防护 | **不做同名预检**：依赖 `git switch -c` 非零退出，在 switch 失败分支专判 `already exists`（不区分大小写）→ 抛 `PARAM_INVALID「分支已存在，请换一个名字」`（Electron 同文案 operationError），优先于 classify/describeGitFailure 兜底；`create && !isRemoteRef` 路径显式拒绝首字符 `-`（PARAM_INVALID「分支名无效」），**普通切换路径校验逐字节不动** | 少一次 `show-ref` 往返且与提案 §6 风险表一致；`git switch -c -x` 的名字落在 git option 解析位上语义不可控，且前端 `isValidBranchName` 首字符本就拒 `-`，后端 create 路径补齐同规则堵注入面 |
| D9 | 历史「添加到对话」链路 | 提交行 → 新增 `add-commit-to-chat: [text]` 事件（GitHistoryView → GitManagerPanel → CenterTabContainer → TaskView）→ 既有 `quoteReplyToChat`（addReplyQuote 引用 chip）；文件行 → 复用既有 `add-file-to-chat: [path]` 链路（GitManagerPanel 已声明该 emit，CenterTabContainer 已转发） | ChatInputHandle 没有「插入纯文本」方法，只有 `insertFileReference` / `addReplyQuote` / `insertFileRangeQuote`（`TaskView.vue:314-318`）——提交说明用引用 chip 语义准确、零新 handle 方法；文件行与 GitChangeList 的「添加到聊天」完全同构 |
| D10 | 新建分支前端交互 | 分组头部「+ 新建分支」点击展开行内输入行（非 ElMessageBox）；`isValidBranchName` 不通过或为空时禁用「创建」并显示校验文案；点击「创建」emit `create-branch` 后立即收起输入行，结果提示走既有 `run('switch', name, {create:true})` 错误通道，成功后 `handleRefreshAll()` | 仓内面板交互惯例是行内元素 + popconfirm/toast，不引弹窗；失败提示与「跟踪并切换」同通道，成功后分支列表/状态自动刷新 |

## 4. 实现步骤

### 4.1 后端 `backend-ts/src/file/workspace-git.service.ts`

#### 4.1.1 `getLog` 增加 keyword（:371-391）

```ts
async getLog(
  sessionWorkspace: string,
  repoPath?: string | null,
  opts?: { limit?: number; offset?: number; path?: string | null; keyword?: string | null },
): Promise<GitLogEntryDTO[]> {
  const repoRoot = await this.resolveRepoRoot(sessionWorkspace, repoPath);
  const limit = clampInt(opts?.limit, LOG_DEFAULT_LIMIT, 1, LOG_MAX_LIMIT);
  const offset = clampInt(opts?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const args = ['log', `--format=${LOG_FORMAT}`, '-n', String(limit), '--skip', String(offset)];
  // 提交信息关键词：--fixed-strings 字面匹配（正则元字符不解释）、-i 大小写不敏感；
  // 必须插在 `--` 之前；空值不产生参数，行为与无 keyword 逐字节一致。
  const keyword = opts?.keyword?.trim().slice(0, 100);
  if (keyword) args.push(`--grep=${keyword}`, '--fixed-strings', '-i');
  const pathFilter = opts?.path?.trim();
  if (pathFilter) args.push('--', pathFilter);
  // …其余不变
}
```

同步更新方法 JSDoc：`keyword 可选（--grep 字面匹配，截断 100 字符）`。

#### 4.1.2 `GitCommitFilesDTO` 增加 `body`（:111）

```ts
export interface GitCommitFilesDTO {
  hash: string;
  files: GitChangedFileDTO[];
  /** 提交正文：`git show -s --format=%B` 去除首行标题后的剩余部分（trim，空串表示无正文）。 */
  body: string;
}
```

#### 4.1.3 `getCommitFiles` 返回正文（:399-439）

在 numstat 处理之后、return 之前加：

```ts
const message = await this.runGitOk(repoRoot, ['show', '-s', '--format=%B', normalizedHash]);
const body = message == null ? '' : message.split('\n').slice(1).join('\n').trim();
return { hash: normalizedHash, files: [...files.values()], body };
```

`%B` 是完整原始消息（含结尾换行）；单行标题的提交 slice(1) 为空数组、trim 后为空串，天然满足「无正文不展示」。

### 4.2 后端 `backend-ts/src/file/git-write-operation.service.ts`

#### 4.2.1 `resolveSwitchTarget` 放开本地新建（:712-740）

`if (create || isRemoteRef)` 块重构为三分支（远端跟踪行为逐位等价）：

```ts
if (isRemoteRef) {
  // 形如 <remote>/<branch>：建跟踪分支（create 与否均同，原行为）
  const local = name.slice(slashIdx + 1);
  return { args: ['switch', '-c', local, '--track', name], localBranch: local };
}
if (create) {
  // 基于当前 HEAD 新建本地分支：名字直接拼进 argv，首字符 `-` 会被 git 当 option 解析，显式拒绝
  if (name.startsWith('-')) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '分支名无效');
  }
  return { args: ['switch', '-c', name], localBranch: name };
}
return { args: ['switch', name], localBranch: name };
```

行为对照：`isRemoteRef`（无论 create）→ 跟踪分支（原样）；`!isRemoteRef && create` → 原 throw「仅支持从远端分支创建跟踪分支」，改为本地新建；其余 → 纯切换（原样）。同步更新函数 JSDoc。

#### 4.2.2 `switchBranch` 专判同名分支（:285-288）

```ts
if (!switched.success) {
  if (stashOid != null) await this.restoreStash(repo, stashOid, stashRef);
  if (/already exists/i.test(switched.output)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '分支已存在，请换一个名字');
  }
  throw new BusinessException(ErrorCode.INTERNAL_ERROR, classify(switched, '切换分支失败'));
}
```

专判放在 stash 恢复**之后**（现场恢复不受影响）、classify 之前；`PARAM_INVALID` 语义为用户输入问题（HTTP 200 业务信封，前端 toast 直显）。

### 4.3 后端 `backend-ts/src/file/file.routes.ts`

`GET /v1/files/workspace-git-log`（:329-337）opts 增加一行：`keyword: queryOptStr(request, 'keyword')`。路由其余不动。

### 4.4 桌面 `desktop/src/composables/useMonacoViewer.ts`

options 增加 `wordWrap?: Ref<'on' | 'off'>`：

- 创建参数 `wordWrap: 'off'`（:53）改为 `wordWrap: options.wordWrap?.value ?? 'off'`；
- 新增 watch：

```ts
watch(options.wordWrap, (v) => {
  editor?.updateOptions({ wordWrap: v })
})
```

现有唯一调用方 FileViewer 不传该参数时行为不变（undefined watch 不触发）。

### 4.5 桌面 `desktop/src/components/center/FileViewer.vue`

#### 4.5.1 模板

`state === 'ready'` 分支（:88-109）：删除左上角 `.refresh-btn`（:93-95），右上角 `.view-mode-toggle`（:89-92）改为统一的 `.viewer-toolbar`：

```vue
<div class="viewer-toolbar">
  <template v-if="isMarkdown">
    <button :class="['tool-btn', { active: viewMode === 'rendered' }]" @click="viewMode = 'rendered'">预览</button>
    <button :class="['tool-btn', { active: viewMode === 'source' }]" @click="viewMode = 'source'">源码</button>
  </template>
  <button v-if="showSource" :class="['tool-btn', { active: wordWrapOn }]" title="自动换行" @click="toggleWordWrap">换行</button>
  <button class="tool-btn" title="复制全文" @click="copyAll">复制</button>
  <button class="tool-btn" title="引用到对话" @click="emit('add-file-to-chat', props.filePath)">引用</button>
  <button v-if="provider?.downloadFile" class="tool-btn" title="下载文件" @click="downloadFile">下载</button>
  <button class="tool-btn" title="刷新" @click="loadFile">刷新</button>
</div>
```

`state === 'image'` 分支（:10-13）顶部插入同容器三按钮：`[引用][下载][刷新]`（无换行/复制）。`.viewer-toolbar` 样式：`position: absolute; top: 8px; right: 8px; display: flex; gap: 2px; z-index: 10;`，`.tool-btn` 复用现 `.mode-btn` 全套视觉（改名或共用类均可，实施时二选一、不留重复 CSS）。

#### 4.5.2 脚本

```ts
const emit = defineEmits<{ 'add-file-to-chat': [filePath: string] }>()

const wordWrapOn = ref(localStorage.getItem('aw-file-word-wrap') === '1')
const wordWrapRef = computed(() => (wordWrapOn.value ? 'on' : 'off') as 'on' | 'off')
function toggleWordWrap() {
  wordWrapOn.value = !wordWrapOn.value
  localStorage.setItem('aw-file-word-wrap', wordWrapOn.value ? '1' : '0')
}

useMonacoViewer({ /* …现有参数 */ wordWrap: wordWrapRef })

async function copyAll() {
  const ok = await copyText(content.value)
  if (ok) ElMessage.success('已复制全文')
  else ElMessage.error('复制失败，请手动选择复制')
}

async function downloadFile() {
  const name = props.filePath.split(/[/\\]/).pop() || props.filePath
  await props.provider?.downloadFile?.(props.filePath, name)
}
```

新增 import：`copyText`（`../../utils/clipboard`，GitHistoryView 同款）、`ElMessage`。

#### 4.5.3 事件接线（`CenterTabContainer.vue`）

`FileViewer` 标签（:5-11）加 `@add-file-to-chat="onAddFileToChat"`——复用现有 `onAddFileToChat`（:146-149，含 `affectsCurrentSession` 守卫：从「我的工作区」打开的非本会话目录文件不会插进当前会话输入框）。TaskView 侧零改动（`@add-file-to-chat="handleAddFileToChat"` 已在 :33/:69 绑好）。

### 4.6 桌面 `desktop/src/components/center/FileDiffViewer.vue`

#### 4.6.1 纯函数抽离（新增 `desktop/src/utils/diff-view-mode.ts`）

```ts
/** Diff 行内模式初始值：有过切换以 localStorage 为准（'1'=行内），否则按视口宽窄兜底。 */
export function resolveInitialDiffInlineMode(stored: string | null, viewportWidth: number): boolean {
  return stored != null ? stored === '1' : viewportWidth < 640
}

/** 变更跳转游标：循环步进（Δ=±1），总数为 0 时原样返回 -1。 */
export function nextHunkIndex(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1
  return (current + delta + total) % total
}
```

抽成纯函数是为了 jsdom 单测不加载 Monaco（对齐仓内 `unified-patch.ts` 等纯工具先例）。

#### 4.6.2 组件状态

```ts
const inlineMode = ref(resolveInitialDiffInlineMode(localStorage.getItem('aw-diff-inline'), window.innerWidth))
const hunkCount = ref(0)
let hunkIndex = -1 // 跳转游标，不渲染，不入响应式

function toggleInline(inline: boolean) {
  inlineMode.value = inline
  localStorage.setItem('aw-diff-inline', inline ? '1' : '0')
  diffEditor?.updateOptions({ renderSideBySide: !inline })
}

function jumpHunk(delta: 1 | -1) {
  if (!diffEditor) return
  const changes = diffEditor.getLineChanges()
  if (!changes?.length) return
  hunkIndex = nextHunkIndex(hunkIndex, changes.length, delta)
  const target = changes[hunkIndex]
  if (target.modifiedStartLineNumber > 0) {
    diffEditor.getModifiedEditor().revealLineInCenter(target.modifiedStartLineNumber)
  } else if (target.originalStartLineNumber > 0) {
    diffEditor.getOriginalEditor().revealLineInCenter(target.originalStartLineNumber)
  }
}
```

#### 4.6.3 创建参数与监听改造

- `ensureDiffEditor`（:132-147）：`renderSideBySide: true` → `renderSideBySide: !inlineMode.value`。
- `setDiffModels`（:161-167）监听改造（一次性自毁 → 常驻计数 + 单次 reveal）：

```ts
diffUpdateDisposable?.dispose()
revealedFirst = false
hunkIndex = -1
diffUpdateDisposable = editor.onDidUpdateDiff(() => {
  hunkCount.value = editor.getLineChanges()?.length ?? 0
  if (!revealedFirst) {
    revealedFirst = true
    revealFirstDiffChange()
  }
})
// Diff may already be ready synchronously for small files
hunkCount.value = editor.getLineChanges()?.length ?? 0
revealFirstDiffChange()
```

`revealedFirst` 为模块内布尔（每次 setDiffModels 重置）；disposeDiffEditor 不变（监听随其销毁）。

#### 4.6.4 胶囊模板与样式

放在 `<template v-else-if="mode !== 'UNSUPPORTED'">` 内、`.monaco-diff-container` 之前，`v-show="showSource"`（Markdown 预览态隐藏；SNAPSHOT 与 PATCH 两种 diff 模式都显示）：

```vue
<div v-show="showSource" class="diff-capsule">
  <button :class="['capsule-btn', { active: !inlineMode }]" @click="toggleInline(false)">并排</button>
  <button :class="['capsule-btn', { active: inlineMode }]" @click="toggleInline(true)">行内</button>
  <span class="capsule-count">共 {{ hunkCount }} 处变更</span>
  <button class="capsule-btn" :disabled="hunkCount === 0" title="上一处变更" @click="jumpHunk(-1)">↑</button>
  <button class="capsule-btn" :disabled="hunkCount === 0" title="下一处变更" @click="jumpHunk(1)">↓</button>
</div>
```

样式（对齐提案 §4.2 定案）：`position: absolute; top: 8px; right: 12px; z-index: 10; display: flex; align-items: center; gap: 2px; opacity: .85;`，`:hover { opacity: 1 }`，`background: var(--aw-surface); border: 1px solid var(--aw-divider-soft); border-radius: var(--aw-radius-xs); backdrop-filter: blur(8px); padding: 2px;`。根元素已是 `position: relative`，距右侧 12px 避开 Monaco 垂直滚动条轨道；不占文档流，不推挤首行。

### 4.7 桌面契约与 provider（三个文件）

1. **`desktop/src/types/git.ts:122-125`**：`GitCommitFilesResult` 增加 `body: string`（注释同 4.1.2；`electron.d.ts:305` 的 gitCommitFiles 返回类型引用该接口，自动生效）。
2. **`desktop/src/types/electron.d.ts:304`**：`gitLog` options 增 `keyword?: string`：
   ```ts
   gitLog(workspace: string | undefined, repoPath: string | undefined, options?: { limit?: number; offset?: number; path?: string; keyword?: string }): Promise<GitLogEntry[] | { error: string }>
   ```
3. **`desktop/src/composables/workspace-git-provider.ts`**：
   - 接口 `getLog` opts（:33）增 `keyword?: string`；
   - LOCAL 实现（:257-260）opts 原样透传给 `window.electronAPI.gitLog`，无需改；
   - CLOUD 实现（:500-505）params 增 `keyword: opts?.keyword`；
   - CLOUD `getCommitFiles`（:506-509）返回增 `body: typeof data?.body === 'string' ? data.body : ''`；LOCAL 实现（:261-263）解包后透传 `body`（缺省 `''`）。

### 4.8 桌面 Electron（两个文件）

#### 4.8.1 `desktop/electron/gitStatus.cjs`

- `getGitLog`（:772-787）与后端 4.1.1 同命令同解析：

```js
const keyword = options.keyword ? String(options.keyword).trim().slice(0, 100) : ''
if (keyword) args.push(`--grep=${keyword}`, '--fixed-strings', '-i')
if (options.path && String(options.path).trim()) args.push('--', String(options.path).trim())
```

JSDoc 的 options 注释同步补 `keyword`。

- `getGitCommitFiles`（:796-833）在 return（:832）前加正文提取，返回 `{ hash, files, body }`：

```js
const message = await runGitOk(repoRoot, ['show', '-s', '--format=%B', normalizedHash])
const body = message == null ? '' : message.split('\n').slice(1).join('\n').trim()
return { hash: normalizedHash, files: Array.from(files.values()), body }
```

#### 4.8.2 `desktop/electron/gitOperations.cjs`

- `resolveSwitchTarget`（:384-407）：按 4.2.1 同构改三分支；首字符 `-` 抛 `new Error('分支名无效')`；JSDoc 同步。
- `switchBranch` 失败分支（:482-489）：stash 恢复之后、`describeGitFailure` 之前专判：

```js
if (/already exists/i.test(String(switched.stderr || switched.stdout || ''))) {
  return operationError('switch', '分支已存在，请换一个名字', { branch: state.branch, stashRef: stashId })
}
```

（取值口径与 `describeGitFailure` 的 `result.stderr || result.stdout` 一致，`gitOperations.cjs:63`。）

### 4.9 桌面 `desktop/src/composables/useGitManager.ts`

```ts
const logPathFilter = ref('')
const logKeyword = ref('')
const commitBodies = ref(new Map<string, string>())
let filterDebounce: ReturnType<typeof setTimeout> | null = null

/** 历史筛选：立即同步输入值，300ms 防抖后重置分页查询。 */
function setLogFilters(patch: { path?: string; keyword?: string }) {
  if (patch.path != null) logPathFilter.value = patch.path
  if (patch.keyword != null) logKeyword.value = patch.keyword
  if (filterDebounce) clearTimeout(filterDebounce)
  filterDebounce = setTimeout(() => {
    filterDebounce = null
    void loadLog(true)
  }, 300)
}
onScopeDispose(() => { if (filterDebounce) clearTimeout(filterDebounce) })
```

- `loadLog`（:126-129）opts 扩为：

```ts
const entries = await p.getLog({
  limit: LOG_PAGE_SIZE,
  offset: reset ? 0 : logOffset.value,
  path: logPathFilter.value.trim() || undefined,
  keyword: logKeyword.value.trim() || undefined,
})
```

「加载更多」走同一函数（`loadLog(false)`），筛选值自动沿用。

- `toggleCommit`（:167-169）在写 `commitFiles` 的同时写正文缓存：

```ts
const nextBodies = new Map(commitBodies.value)
nextBodies.set(hash, result.body ?? '')
commitBodies.value = nextBodies
```

- 仓库重置块（:66-77，清理 `expandedCommit`/`commitFiles` 处）追加：`logPathFilter.value = ''`、`logKeyword.value = ''`、`commitBodies.value = new Map()`。
- 返回对象（:322 附近）增 `logPathFilter, logKeyword, commitBodies, setLogFilters`。

### 4.10 桌面 `desktop/src/components/git/GitHistoryView.vue` + `GitManagerPanel.vue`

#### 4.10.1 GitHistoryView

props 增 `pathFilter: string`、`keyword: string`、`commitBodies?: Map<string, string>`；emits 增：

```ts
'update:pathFilter': [value: string]
'update:keyword': [value: string]
'add-file-to-chat': [path: string]
'add-commit-to-chat': [text: string]
```

1. **筛选条**：组件根部、状态分支之外新增固定容器（在 error/loading 空态之下、列表之上）：

```vue
<div v-if="entries.length > 0 || pathFilter || keyword" class="git-history-filters">
  <input
    class="git-filter-input"
    :value="pathFilter"
    maxlength="200"
    placeholder="按文件路径筛选（如 src/app.ts）"
    @input="$emit('update:pathFilter', ($event.target as HTMLInputElement).value)"
  />
  <input
    class="git-filter-input"
    :value="keyword"
    maxlength="100"
    placeholder="按提交信息搜索"
    @input="$emit('update:keyword', ($event.target as HTMLInputElement).value)"
  />
</div>
```

样式：`display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--aw-divider-soft);`，`.git-filter-input` 为紧凑单行输入（flex:1、caption 字号、surface 背景）。空仓库（尚无提交且无筛选）不渲染筛选条。

2. **提交正文**：展开区（:35-53）文件清单上方：

```vue
<pre v-if="commitBodies?.get(entry.hash)" class="git-commit-body">{{ commitBodies.get(entry.hash) }}</pre>
```

样式 `white-space: pre-wrap; word-break: break-word; margin: 6px 0; padding: 8px 10px; border-radius: var(--aw-radius-xs); background: var(--aw-surface); font-size: var(--aw-text-fine); color: var(--aw-ink-muted-80);`。

3. **添加到对话按钮**：提交行 `.git-log-main`（:16-34）行尾（meta 之后）与文件行 `.git-commit-file`（:38-50）行尾各加：

```vue
<button class="git-log-quote" title="添加到对话" @click.stop="emit('add-commit-to-chat', `提交 ${entry.shortHash}（${entry.title || '无标题'}）`)">
  <el-icon :size="12"><ChatDotRound /></el-icon>
</button>
```

文件行为 `<el-icon … @click.stop="emit('add-file-to-chat', file.path)" />` 同款容器。样式：`opacity: 0;` `.git-log-main:hover & { opacity: 1; }`、`flex-shrink: 0; cursor: pointer; color: var(--aw-ink-muted-48);` hover 变主色；不改变行高。新增 import：`ChatDotRound`。

#### 4.10.2 GitManagerPanel 接线

`<GitHistoryView>`（:135-148）新增绑定：

```vue
:path-filter="logPathFilter"
:keyword="logKeyword"
:commit-bodies="commitBodies"
@update:path-filter="setLogFilters({ path: $event })"
@update:keyword="setLogFilters({ keyword: $event })"
@add-file-to-chat="(p) => $emit('add-file-to-chat', p)"
@add-commit-to-chat="(t) => $emit('add-commit-to-chat', t)"
```

emits 增 `'add-commit-to-chat': [text: string]`（`add-file-to-chat` 已声明于 :219）；脚本从 `useGitManager` 解构新返回成员。`GitChangeList` 与 CenterTabContainer 的既有 `add-file-to-chat` 转发链零改动。

### 4.11 桌面 `desktop/src/components/git/GitBranchesView.vue` + GitManagerPanel.vue

#### 4.11.1 GitBranchesView

本地分组头部（:11）改为标题 + 按钮一行，头部下方插输入行：

```vue
<div class="git-branch-group-head">
  <span>本地分支 · {{ localBranches.length }}</span>
  <button class="git-branch-create-btn" @click="createOpen = !createOpen">+ 新建分支</button>
</div>
<div v-if="createOpen" class="git-branch-create-row">
  <input v-model="createName" class="git-branch-create-input" placeholder="新分支名（基于当前 HEAD，如 feat/demo）" @keyup.enter="confirmCreate" />
  <button class="git-branch-switch" :disabled="!canCreate || switching" @click="confirmCreate">创建</button>
  <button class="git-branch-switch" @click="createOpen = false">取消</button>
  <span v-if="createName && !isValidBranchName(createName)" class="git-branch-create-error">分支名无效</span>
</div>
```

```ts
const createOpen = ref(false)
const createName = ref('')
const canCreate = computed(() => isValidBranchName(createName.value.trim()))
function confirmCreate() {
  if (!canCreate.value) return
  emit('create-branch', createName.value.trim())
  createOpen.value = false
  createName.value = ''
}
```

emits 增 `'create-branch': [name: string]`；import `isValidBranchName`（`utils/git-manager.ts:144`，首字符 `-` 已被其正则排除）与 `ref/computed`。校验不通过时「创建」禁用 + 文案提示；点击创建即收起输入行（失败提示由既有操作 toast 承担，与「跟踪并切换」同通道）。

#### 4.11.2 GitManagerPanel

`<GitBranchesView>`（:150-158）加 `@create-branch="handleCreateBranch"`；脚本新增（与 `handleSwitchBranch` :416-418 同构）：

```ts
function handleCreateBranch(name: string) {
  void run('switch', name, { create: true }).then(() => handleRefreshAll())
}
```

`useGitOperations` 的 switch 通道（`useGitOperations.ts:17,62`）与两端 provider `switchBranch(branch, {create:true}, repoPath)` 零改动。

### 4.12 桌面 `CenterTabContainer.vue` + `TaskView.vue`

1. `CenterTabContainer.vue`：
   - GitManagerPanel 标签（:53-65）加 `@add-commit-to-chat="emit('add-commit-to-chat', $event)"`；
   - emits 声明（:105-116）增 `'add-commit-to-chat': [text: string]`。
2. `TaskView.vue`：两处 `<CenterTabContainer>`（:33、:69）各加 `@add-commit-to-chat="quoteReplyToChat"`——`quoteReplyToChat`（:351-353）→ `handle.addReplyQuote(text)`，引用 chip 在输入框上方展示（`capReplyQuote` 自动截断超长），用户随后补一句「检查一下这个提交为什么改坏了」即可发送。

## 5. 落地变更清单

| 端 | 文件 | 变更 | 新增/修改 |
|---|---|---|---|
| backend-ts | `src/file/workspace-git.service.ts` | `getLog` 增 `keyword`（`--grep --fixed-strings -i`，trim+100 截断）；`getCommitFiles` 增 `git show -s --format=%B` 返回 `body`；`GitCommitFilesDTO` 增 `body: string` | 修改 |
| backend-ts | `src/file/git-write-operation.service.ts` | `resolveSwitchTarget` 放开本地新建（含首字符 `-` 拒绝）；`switchBranch` 专判 `already exists` →「分支已存在，请换一个名字」 | 修改 |
| backend-ts | `src/file/file.routes.ts` | `workspace-git-log` 路由透传 `keyword` query | 修改 |
| desktop | `src/composables/useMonacoViewer.ts` | options 增 `wordWrap?: Ref<'on'\|'off'>`（创建取值 + watch updateOptions） | 修改 |
| desktop | `src/components/center/FileViewer.vue` | 右上常驻工具条（换行/复制/引用/下载/刷新 + md 切换收敛）；图片态工具条；`add-file-to-chat` emit；`aw-file-word-wrap` 偏好 | 修改 |
| desktop | `src/utils/diff-view-mode.ts` | `resolveInitialDiffInlineMode` / `nextHunkIndex` 纯函数 | 新增 |
| desktop | `src/components/center/FileDiffViewer.vue` | 右上浮动胶囊（并排/行内、共 N 处变更、↑↓ 跳转）；`renderSideBySide` 动态化；onDidUpdateDiff 常驻计数 | 修改 |
| desktop | `src/types/git.ts` | `GitCommitFilesResult` 增 `body: string` | 修改 |
| desktop | `src/types/electron.d.ts` | `gitLog` options 增 `keyword?: string` | 修改 |
| desktop | `src/composables/workspace-git-provider.ts` | 接口/LOCAL/CLOUD 的 `getLog` keyword 透传；两侧 `getCommitFiles` body 透传 | 修改 |
| desktop | `electron/gitStatus.cjs` | `getGitLog` 增 keyword；`getGitCommitFiles` 增 body | 修改 |
| desktop | `electron/gitOperations.cjs` | `resolveSwitchTarget` 本地新建 + `-` 拒绝；`switchBranch` 专判 already exists | 修改 |
| desktop | `src/composables/useGitManager.ts` | `logPathFilter`/`logKeyword`/`commitBodies` + `setLogFilters`（300ms 防抖）；loadLog 传参；重置块清理 | 修改 |
| desktop | `src/components/git/GitHistoryView.vue` | 筛选条、提交正文 `<pre>`、行级「添加到对话」按钮 | 修改 |
| desktop | `src/components/git/GitBranchesView.vue` | 「+ 新建分支」+ 行内输入行 + `isValidBranchName` 校验 | 修改 |
| desktop | `src/components/git/GitManagerPanel.vue` | 历史筛选/正文/添加到对话接线；`handleCreateBranch` | 修改 |
| desktop | `src/components/center/CenterTabContainer.vue` | FileViewer 接 `add-file-to-chat`；GitManagerPanel 接 `add-commit-to-chat` | 修改 |
| desktop | `src/views/task/TaskView.vue` | 两处 CenterTabContainer 绑 `@add-commit-to-chat="quoteReplyToChat"` | 修改 |
| 测试 | `backend-ts/src/file/workspace-git.service.spec.ts` | keyword 过滤/组合/截断、getCommitFiles body 用例 | 修改 |
| 测试 | `backend-ts/src/file/git-write-operation.service.spec.ts` | resolveSwitchTarget 5 例 + switchBranch 本地新建/同名冲突真实仓库用例 | 修改 |
| 测试 | `desktop/src/utils/diff-view-mode.test.ts` | 纯函数用例 | 新增 |
| 测试 | `desktop/src/composables/useGitManager.test.ts` | 筛选防抖/透传/重置、commitBodies 缓存用例 | 修改 |
| 测试 | `desktop/src/components/git/GitManagerPanel.test.ts` | create-branch → switch(create) 事件断言 | 修改 |
| 文档 | `CHANGELOG.md`、提案状态行、`docs/proposals/README.md` | 同步 | 修改 |
| — | 数据库迁移 / admin / mao-cli / mao-agent / android / DEPLOY.md | **无改动** | — |

## 6. 影响面与回归护栏

| 风险 | 护栏 |
|---|---|
| 关键词含正则元字符（`fix.*(`）导致 `git log` 报错或语义漂移 | `--fixed-strings` 字面匹配 + `-i`；trim + 100 截断；空值不加参数（§7.1 用例 4 专门锁死「空 keyword 行为与现状逐字节一致」） |
| 分支名以 `-` 开头注入 git option | create 路径显式 `startsWith('-')` 拒绝（CLOUD PARAM_INVALID / Electron Error）；前端 `isValidBranchName` 首字符类本就排除 `-`，输入行实时拦截；普通切换路径校验逐字节不动 |
| 新建分支与已有本地分支重名 | `git switch -c` 天然非零退出；switch 失败分支专判 `already exists` 返回「分支已存在，请换一个名字」，不覆盖、不 force；stash 现场恢复先于报错（两侧同序） |
| 远端跟踪分支回归 | `resolveSwitchTarget` 重构后 `isRemoteRef`（无论 create）走原 `--track` 分支逐行保留；§7.1 用例 6 + 既有 `switchBranchCreatesTrackingBranchFromRemoteRef` 用例零断言改动即护栏 |
| Monaco 换行/inline 切换影响其他 Monaco 实例 | 两个查看器各自持独立 editor 实例；`wordWrap` 参数为可选，`useMonacoViewer` 其他（潜在）调用方不传时行为不变 |
| 胶囊遮挡右上角代码或滚动条 | 定案为半透明胶囊（opacity .85、hover 1）、right:12px 避开垂直滚动条轨道、不占文档流；PATCH 截断提示条共存时仅可能在极窄宽度与提示条文字尾部轻微重叠（提示文本短，可接受） |
| 筛选状态串仓库 | 仓库切换重置块清空 `logPathFilter`/`logKeyword`/`commitBodies`；`loadLog` 已有 `logSeq` 乱序防护，防抖迟到响应被序号丢弃 |
| 防抖定时器泄漏 | `onScopeDispose` 清理；面板随 KeepAlive 驻留时不重建，无重复定时器 |
| 提交正文请求改变展开时序 | body 与 files 同一次 `getCommitFiles` 带回，无新增请求；`commitFilesSeq` 乱序防护同样覆盖 body 写入 |
| FileViewer 工具条在非会话工作区误插对话 | CenterTabContainer 复用 `onAddFileToChat` 的 `affectsCurrentSession` 守卫，从「我的工作区」打开的目录文件不进当前会话输入框 |
| CLOUD/LOCAL 行为不对称 | keyword 三处透传、body 两侧同命令同解析；不对称点仅存量一处（readFile 嗅探二进制，与本方案无关，维持原状） |

## 7. 测试要点

### 7.1 后端单测

`workspace-git.service.spec.ts`（沿用既有真实临时仓库夹具，同 `getLogReturnsParsedEntriesWithRefs` :167 模式）：

1. **keyword 过滤**：三个提交（`fix: alpha` / `feat: beta` / `fix: gamma`），`keyword: 'fix'` → 2 条；`keyword: 'FIX'` → 2 条（`-i`）。
2. **keyword + path 叠加**：`keyword: 'fix'` 且 path 指向仅 alpha 提交触碰的文件 → 1 条（AND 语义）。
3. **元字符字面匹配**：`keyword: 'fix:.*a'` → 按字面匹配返回 0 条且不抛错（证明非正则解释）。
4. **空 keyword 行为不变**：`keyword: '  '`（纯空白）→ 与不传 keyword 的结果逐条一致。
5. **100 字符截断**：提交信息含 120 个 `a`，`keyword: 'a'.repeat(150)` → 命中 1 条（未截断的 150 字符字面串不可能命中 120 字符消息，命中即证明截断生效）。
6. **getCommitFiles body**：`git commit -m 'subject' -m 'body line'` → `body === 'body line'`；单 `-m` 提交 → `body === ''`。

`git-write-operation.service.spec.ts`（既有真实仓库夹具 `newService(dir, repo)` 模式）：

7. **resolveSwitchTarget 纯函数 5 例**：`('feat/demo', true, [])` → `['switch','-c','feat/demo']`；`('origin/main', true, ['origin'])` → `['switch','-c','main','--track','origin/main']`（原样）；`('origin/main', false, ['origin'])` → 同上（原样）；`('main', false, [])` → `['switch','main']`（原样）；`('-x', true, [])` → reject `PARAM_INVALID「分支名无效」`。
8. **switchBranch 本地新建**：真实仓库 `switchBranch(session, null, 'feat/demo', true)` → `success:true`、message「已切换到分支 feat/demo」、`rev-parse --verify refs/heads/feat/demo` 成功且为当前分支。
9. **同名冲突**：再次 `switchBranch(…, 'feat/demo', true)` → reject 且 message 为「分支已存在，请换一个名字」；原分支内容不被覆盖。
10. **周期回归**：既有全部用例（含 :635 跟踪分支、:658 detached、:667 非法名）零断言改动全绿。

### 7.2 桌面单测

1. **`utils/diff-view-mode.test.ts`（新增）**：`resolveInitialDiffInlineMode`：stored '1'→true、'0'→false、null+375px→true、null+1280px→false；`nextHunkIndex`：(-1,3,+1)→0、(2,3,+1)→0（循环）、(0,3,-1)→2、(任意,0,±1)→-1。
2. **`useGitManager.test.ts`**：`setLogFilters({keyword:'fix'})` 防抖后 getLog 收到 `{limit:50, offset:0, keyword:'fix'}` 且列表重置；300ms 内两次 setLogFilters 只触发一次 getLog；`loadMoreLog` 请求沿用 path/keyword；`toggleCommit` 后 `commitBodies` 收到 fake 返回的 body；切换仓库后筛选值与 commitBodies 清空。
3. **`GitManagerPanel.test.ts`**：GitBranchesView `create-branch` 事件 → provider.switchBranch 收到 `(name, {create:true})`；GitHistoryView `add-commit-to-chat` → 面板同名 emit 透传。
4. **FileViewer / FileDiffViewer 组件行为**：不新增挂载 Monaco 的组件测试（jsdom 无法承载 loadMonaco），由 §7.2.1 纯函数 + §7.3 手工验收覆盖。

### 7.3 手工验收

1. **FileViewer 文本**：打开一个单行超长 JSON → 点「换行」→ 立即换行、再点恢复；关闭 Tab 重开偏好保留；「复制」粘贴得到全文；「引用」输入框出现 `@path` 文件引用；「下载」落盘文件名正确。
2. **FileViewer Markdown/图片**：Markdown 渲染态无「换行」按钮、源码态有；图片 Tab 有引用/下载/刷新且均可用。
3. **FileDiffViewer**：窄窗口（<640px）首开默认行内、宽窗口默认并排；切换胶囊按钮即时生效且重开 Tab 记忆；「共 N 处变更」数字与肉眼可数一致；↑↓ 循环跳转、纯删除 hunk 落点正确；Markdown 新文件预览态胶囊隐藏。
4. **Git 历史**：展开多行 message 的提交可见正文、单行提交不出现空块；路径筛选输入 `src/app.ts` 后列表只余触达该文件的提交，「加载更多」沿用筛选；关键词搜「fix」大小写不敏感命中、清空恢复全量；两输入框叠加为 AND。
5. **添加到对话**：hover 提交行点引用 → 输入框上方出现「提交 abc1234（标题）」引用 chip；hover 文件行点引用 → 输入框出现 `@path`；当前活跃 Tab 是边路任务时插入该边路输入框。
6. **新建分支**：分支视图点「+ 新建分支」→ 输 `feat/demo` → 创建成功列表出现且当前分支切换、ahead/behind 正确；再建同名 → toast「分支已存在，请换一个名字」；输 `-x` 创建按钮禁用；带未提交改动时创建 → 自动 stash 并恢复（改动不丢）。
7. **CLOUD 与 LOCAL 双模式**各过一遍 4/5/6（Electron IPC 与 REST 两条链路）。

### 7.4 构建验证

- `cd backend-ts && npm run build && npm test > /tmp/mao-git-ux.log 2>&1; echo exit=$?`，grep `Test Files|Tests|FAIL` 提取摘要；
- `cd desktop && npm run build`（`vue-tsc -b && vite build`；禁止 `npx vue-tsc --noEmit` 假通过路径）。

### 7.5 Playwright

不新增用例：中心 Tab 的 Monaco / Git 面板交互依赖真实 Monaco 与仓库夹性，E2E 无对应种子；由单测 + 手工验收覆盖（与定时任务「立即执行」方案同口径）。

## 8. 实施顺序与验收清单

实施顺序：后端（getLog keyword → getCommitFiles body → resolveSwitchTarget/switchBranch → routes）→ 后端单测全绿 → 桌面契约三件套（types/electron.d.ts/provider）→ Electron 两侧 → useMonacoViewer/FileViewer → diff-view-mode/FileDiffViewer → useGitManager/GitHistoryView/GitBranchesView/GitManagerPanel → CenterTabContainer/TaskView → 桌面单测与构建 → CHANGELOG/提案状态 → 手工验收。

- [ ] 后端 `getLog` keyword（trim/截断/`--fixed-strings -i`/空值零差异）+ 路由透传
- [ ] 后端 `getCommitFiles` body + `GitCommitFilesDTO.body`
- [ ] 后端 `resolveSwitchTarget` 本地新建 + `-` 拒绝；`switchBranch` already-exists 专判
- [ ] `useMonacoViewer.wordWrap` 参数 + FileViewer 工具条（含图片态、`aw-file-word-wrap`、add-file-to-chat 接线）
- [ ] `diff-view-mode.ts` + FileDiffViewer 胶囊（并排/行内、计数、↑↓ 循环跳转、`aw-diff-inline`）
- [ ] Electron `getGitLog` keyword / `getGitCommitFiles` body / `resolveSwitchTarget` / already-exists
- [ ] provider + types + electron.d.ts 契约三件套
- [ ] useGitManager 筛选与 commitBodies；GitHistoryView 筛选条/正文/行级添加到对话；GitBranchesView 新建分支；GitManagerPanel/CenterTabContainer/TaskView 接线
- [ ] §7.1 用例 1-10 全绿（既有用例零断言改动）、§7.2 桌面单测全绿
- [ ] backend build+test、desktop `npm run build` 全绿
- [ ] CHANGELOG.md 新版本小节（后端 + 前端各一条）、提案状态行与 proposals/README.md 置为已立项
- [ ] 手工验收 §7.3 七项全过（CLOUD/LOCAL 双模式）
