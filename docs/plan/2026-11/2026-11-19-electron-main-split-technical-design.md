# Electron 主进程 `main.cjs` 拆分技术方案

- 日期：2026-11-19
- 状态：待实施（本文档不含实现）
- 需求方：杨佳毅
- 关联代码：`desktop/electron/main.cjs`（约 3157 行）、`desktop/electron/preload.cjs`、`desktop/electron/mainShellHarness.cjs`
- 关联方案：[../2026-10/2026-10-26-electron-shell-completeness-technical-design.md](../2026-10/2026-10-26-electron-shell-completeness-technical-design.md)（托盘 / 通知 / 快捷键已按「纯逻辑进独立模块、IPC 留在入口」落地，本方案沿用该范式）

行号以 2026-11-19 工作区为准，实施时允许漂移，以函数名为准。

## 1. 背景与目标

`desktop/package.json` 的 `main` 是 `electron/main.cjs`。旁边已经抽出 Git、终端、鉴权、服务地址、托盘、附件、字节读取等模块，入口本身仍有约 3157 行。新增 LOCAL 能力持续堆进这个文件：文件 diff、glob/grep、MCP、技能同步都没有独立测试。

目标：

1. 把可单测的领域逻辑移出入口，每批可独立合并。
2. 入口只保留进程生命周期、窗口、菜单与更新、托盘通知快捷键、工具审批，以及 `tool-execute` 分发。
3. IPC 通道名、`preload.cjs`、返回形状、审批策略保持不变。

不做行数竞赛。更新菜单、建窗、托盘通知继续留在入口时，落地后大约 1400–1600 行。这是主进程组装根该有的厚度。再往下拆这些壳逻辑，收益低，`mainShellHarness.cjs` 会变脆。

## 2. 现状

### 2.1 已有拆法

目录内模块都是 CommonJS，纯逻辑用 `node --test`。`desktop/package.json` 的 `test:unit` 是 `vitest run && node --test "electron/*.test.cjs"`，新测试文件会被 glob 收进去，不必改脚本。`electron-builder` 的 `files` 含 `electron/**/*`，新 `.cjs` 会打进安装包，不必改打包配置。

`mainShellHarness.cjs` 在加载前清掉 `electron/*.cjs` 的 `require.cache`，再 `require` 真实的 `main.cjs`。抽出的模块只要仍由入口引入，集成测试就透过 IPC 和 `app` 事件覆盖到它们。harness 不要求逻辑源码留在 `main.cjs` 里。

参照：`localShell.cjs` 用工厂函数接收 `buildEnv` / `refreshToken`；`localFileBytes.cjs` 只做读取，路径解析留在调用方。

### 2.2 入口里还剩什么

| 区块 | 约行号 | 约行数 | 去向 |
|---|---|---|---|
| 单实例、共享状态、终端接线 | 1–93 | 93 | 留 |
| 文件 diff / LCS / 编辑匹配 / `writeEditedFile` | 95–354 | 260 | 第 1 批 |
| `resolveUserPath` / `buildShellEnv` / `refreshMaoTokenInShellSession` | 356–449 | 94 | 留 |
| 自动更新与应用菜单 | 451–740 | 290 | 留 |
| 工具审批与早到决策 | 741–801 | 60 | 留 |
| 服务地址薄封装 | 802–860 | 58 | 留 |
| `~/.mao/runtime` 路径 | 862–902 | 41 | 第 2 批 |
| 技能同步、`~/.agents/skills`、`AGENTS.md` | 904–1115 | 212 | 第 2 批 |
| `resolveWorkspacePath`、环境信息小函数 | 1117–1153 | 37 | 路径函数第 2 批；`detectShell` / `buildOsVersion` / `isGitWorkspace` 留 |
| 建窗、切服务器、服务器选择窗 | 1158–1368 | 211 | 留 |
| 托盘、通知、角标、偏好、快捷键、自启 | 1369–1698 | 330 | 留 |
| 鉴权 IPC | 1700–1754 | 55 | 留 |
| 服务地址 IPC | 1755–1820 | 66 | 留 |
| 窗口按钮、版本、更新 IPC | 1822–1869 | 48 | 留 |
| Git IPC（逻辑已在 `gitStatus.cjs` / `gitOperations.cjs`） | 1871–2014 | 144 | 第 3 批 |
| 外链、飞书登录窗、选目录、系统终端 | 2016–2102 | 87 | 留 |
| 本机终端 IPC | 2103–2139 | 37 | 留 |
| 本地读写、目录列举 | 2141–2366 | 226 | 第 3 批 |
| MCP 客户端 | 2368–2564 | 197 | 第 2 批 |
| `tool-execute` 分发、读图、写文件的 WS 入口 | 2566–2854 | 289 | 分发留；读图与写盘函数随第 3 批 |
| glob / grep | 2856–3157 | 302 | 第 1 批 |

### 2.3 不能按剪切处理的共享状态

- `currentWorkspace`：`tool-execute`（约 2613–2620 行）写入，Git IPC、搜索、`resolveWorkspacePath`、`get-environment-info` 读取。抽出的模块只接收 `getCurrentWorkspace`，不持有这份可变状态。写入仍只发生在 `tool-execute`。
- `mainWindow`、`quitting`、`pendingApprovals`、`earlyApprovalDecisions`、更新状态、托盘与快捷键：只服务进程壳，本方案不外移。
- `mcpClients`：`cleanupSiteScopedResources`（约 1189 行）和 `before-quit`（约 1694 行）按 session 关闭连接。MCP 模块导出 `closeMcpSession` 与 `closeAllMcpSessions`，入口不再碰内部 Map。
- `buildShellEnv` 在约 71 行就交给 `TerminalManager.setEnvProvider`，定义在约 401 行。今天能工作是因为 `function` 声明会提升。本方案不移动它。消费方共三处：`TerminalManager.setEnvProvider`（约 71 行）、`TerminalHost` 构造参数 `buildEnv`（约 80 行）、`createLocalShellRuntime`（约 878 行）。若以后要移，`require` 必须放在最早消费方（约 71 行）之前。

### 2.4 两套文件入口不能合并

同一类操作有渲染层 IPC 和 WebSocket `tool-execute` 两条入口，审批和返回形状不同：

| 操作 | IPC | `tool-execute` |
|---|---|---|
| 写文件 | `local-write-file` 每次都 `requestToolApproval`，不带 sessionId / requestId | `handleLocalWriteFile` 仅 `needApproval` 时审批，并带上 sessionId、requestId |
| 编辑 | `local-edit-file` 同样每次审批 | `handleLocalEditFile` 同样只在 `needApproval` 时审批 |
| 读文件 | `local-read-file` 含 PDF data URI；失败返回 `{ error }` | `handleLocalReadFile` 无 PDF 分支；失败返回 `{ content: '错误：…' }` |
| 文本落盘 | `local-write-text-file` 把工具结果改写成 `{ ok, absolutePath }`（同名避重） | `write_local_text_file` 返回 `{ success, path, bytes_written }`（覆盖写） |

第 3 批把「快照、建目录、写入、算 diff」收成一个函数，两条入口都调用它。审批、错误对象、PDF 分支留在各自入口。不把两条协议收成一种。

## 3. 范围

**做**：

- 按下面三批把领域逻辑和薄 IPC 移到同目录的新 `.cjs`，并补 `node --test`。
- 入口改为调用这些模块。通道名字符串保持原样。

**不做**：

- 不把入口改成 TypeScript 或 ESM。harness 靠 `require.cache` 注入假 `electron`，`package.json` 的 `main` 也是这个 CJS 文件。
- 不改 `preload.cjs`，不改渲染层，不改后端。
- 不改任何 IPC 的参数、返回形状、审批是否弹出、路径是否做 workspace containment。`resolveWorkspacePath` 今天对绝对路径原样返回（约 1122–1126 行），本方案不补沙箱。
- 不移动自动更新、应用菜单、建窗、托盘、通知、角标、快捷键、自启、鉴权 IPC、服务地址 IPC、飞书登录窗、本机终端 IPC、`buildShellEnv`。
- 不引入依赖注入容器或类层次。依赖用一个普通对象传入，与 `createLocalShellRuntime` 相同。
- 不写 `changelog/unreleased`。这是内部重构，无用户可见行为。若某批不得不改返回形状，先停，改本方案，而不是用更新说明把行为变化带出去。
- 不同步改 README / DEPLOY。无使用方式变化。

## 4. 关键决策

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | 模块格式 | 继续 CommonJS，`'use strict'`，具名 `module.exports` | 与同目录模块、harness、打包入口一致 |
| D2 | 谁依赖谁 | 新模块禁止 `require('./main.cjs')`。入口在顶部 `require`，把回调传进去 | 避免循环依赖。`buildShellEnv` 的提升只在留在入口时安全 |
| D3 | 可变工作区 | 模块接收 `getCurrentWorkspace()`，不接收可写绑定 | 写入点保持唯一，避免搜索和 Git 各改一份 |
| D4 | 分批顺序 | 第 1 批 → 第 2 批 → 第 3 批，每批单独合并 | 第 3 批的写文件要调用第 1 批的 diff；技能目录要调用第 2 批的路径函数 |
| D5 | 搜索的路径解析 | 第 1 批的 `localSearch` 接收调用方传入的 `resolveWorkspacePath` | 第 1 批不等待路径函数搬走。第 2 批搬走后只改入口的传参 |
| D6 | 读写协议 | 共享写盘实现，不共享审批和返回形状 | 见 §2.4。合并会改变「渲染层预览写入也要审批」和「工具失败是 `{ error }` 还是 `{ content }`」 |
| D7 | Git IPC | 原样搬进 `registerGitIpc`，不统一错误对象 | 今天 `git-status` 失败是 `{ error }`，`git-file-diff` 失败是带 `unavailableReason` 的 diff 对象，`git-commit` 直接返回操作结果。渲染层按通道区分 |
| D8 | MCP 状态 | Map 留在 `mcpClient.cjs`，入口只调 `closeMcpSession` / `closeAllMcpSessions` | `before-quit` 与切换服务器都要关掉 stdio 子进程 |
| D9 | 验收体积 | 入口落到约 1400–1600 行即停止 | 壳逻辑继续留在入口。不为了再减 400 行去拆菜单和托盘 |
| D10 | 之后的约束 | 新领域逻辑进独立模块并带测试；新 IPC 进对应 `register*`。入口只增加接线 | 避免拆完又堆回去 |

## 5. 模块边界

依赖只允许从上往下：入口 → IPC 注册模块 → 领域模块。领域模块之间不互相 require，路径函数除外（技能与搜索使用入口注入的路径函数，不直接 require 也可以；技能目录解析放在 `localRuntimePaths.cjs`，技能模块接收 `resolveLocalSkillsDir`）。

```
main.cjs
  registerGitIpc(ipcMain, { getWorkspace })
  registerLocalFileIpc(ipcMain, deps)     # 第 3 批
  registerLocalSkillsIpc(ipcMain, deps)   # 第 2 批
  registerMcpIpc(ipcMain, mcp)            # 第 2 批
  createLocalSearch({ resolveWorkspacePath, getCurrentWorkspace })
  fileChangeDiff.cjs                      # 无 Electron
  localRuntimePaths.cjs                   # 无 Electron
```

### 5.1 `fileChangeDiff.cjs`（第 1 批）

移入：`PRIVATE_DIFF_FIELD`、`SNAPSHOT_LIMIT_BYTES`（512 KiB）、`PATCH_LIMIT_CHARS`（256 Ki 字符）、`PATCH_CONTEXT_LINES`、`LCS_CELL_LIMIT`，以及 `utf8Bytes`、`isBinaryContent`、`splitLines`、`lcsLength`、`computeLineDelta`、`appendBounded`、`buildUnifiedPatch`、`buildFileChangeDiff`、`asBoolArg`、`lineAtIndex`、`applyEditMatch`、`writeEditedFile`。

只依赖 `fs`、`path`。`writeEditedFile` 继续同步读写，返回形状含 `file_change` 与 `file_change_diff`。入口的两处写文件、两处编辑改为调用这里，不改审批。

### 5.2 `localSearch.cjs`（第 1 批）

移入 glob / grep 全段（约 2856–3157 行），包括 `rg` 可用性缓存、Node 回退、`parseRgLine`。

```js
createLocalSearch({
  resolveWorkspacePath,   // (filePath, workspace, sessionId) => string
  getCurrentWorkspace,    // () => string
})
```

返回 `{ handleGlobSearch, handleGrepSearch }`。`executeToolByName` 的 `glob_search` / `grep_search` 改为调这两个函数。忽略目录、`head_limit`、上下文行数、输出字符上限保持原值。不把 `rg` 是否存在写死：`execFile` 可注入，单测走 Node 回退。`rgAvailable` 探测结果缓存进 `createLocalSearch` 闭包而非模块顶层——留在顶层的话，单测注入假 `execFile` 时第一个用例的探测结果会污染后续用例。

### 5.3 `localRuntimePaths.cjs`（第 2 批）

移入 `resolveLocalRuntimeDir`、`resolveLocalSkillsDir`、`resolveLocalShellOutputDir`、`formatLocalRuntimePath`、`expandHomePath`、`isUnderLocalRuntime`、`resolveWorkspacePath`。

```js
createLocalRuntimePaths({
  getServerHostKey,       // () => string
  getCurrentWorkspace,    // () => string
})
```

根目录仍是 `~/.mao/runtime/<hostKey>/<sessionId>`。`localShell` 的 `resolveOutput`（约 881 行）改为使用这里的函数，显示路径仍是 `~/.mao/runtime/...` 这种带 `~` 的形式，不是展开后的绝对路径。

### 5.4 `mcpClient.cjs`（第 2 批）

移入官方 SDK 的连接、`syncMcpServers`、`callMcpTool`、`parseMcpToolName`、`formatCallToolResult`、`formatMcpContent`，以及 session → server 的 Map。

导出 `createMcpRuntime()`，得到 `{ syncServers, closeSession, closeAll, callTool, parseToolName }`。超时仍是 120 秒，工具名前缀仍是 `mcp__`。`registerMcpIpc` 只注册 `mcp-sync`、`mcp-close`。

`handleMcpToolFromWebSocket` 留在入口：它要先走 `requestToolApproval`。通过后再调 `callTool`。`cleanupSiteScopedResources` 与 `before-quit` 改为 `closeAll()`。

### 5.5 `localSkills.cjs`（第 2 批）

移入 `preferIpv4Loopback`、`resolveSkillSyncBaseUrl`、`parseSkillMd`、`resolveLocalSkillFolder`、`collectSkillFiles`，以及五个 IPC：`skill-sync`、`list-local-skills`、`get-local-skill-detail`、`read-local-skill-files`、`read-agents-md`。

```js
registerLocalSkillsIpc(ipcMain, {
  sendToRenderer,
  getApiBaseUrl,
  resolveLocalSkillsDir,
  getLocalAgentsSkillsDir,   // () => '~/.agents/skills' 绝对路径
})
```

行为保持：

- `localhost` 改写为 `127.0.0.1`，避免 undici 先走 `::1` 而后端只听 IPv4。
- 技能目录仍是 `~/.agents/skills`。文件夹名拒绝 `/`、`\`、以 `.` 开头，并用 `path.relative` 语义拒绝逃出根目录（实现继续用 `path.resolve` + `path.sep` 前缀判断）。
- `skill-sync` 仍 POST 下载 zip，用 `adm-zip` 覆盖解压到会话技能目录，并用 `skill-sync-complete` 通知渲染层。
- `read-agents-md` 仍只读调用方给出的 `workspace` 下的 `AGENTS.md`，不存在返回 `{ content: null }`。
- `~/.agents/skills` 根目录（今天的模块级常量 `LOCAL_SKILLS_DIR`，约 950 行）经 `getLocalAgentsSkillsDir` 注入，模块内不硬编码：`resolveLocalSkillFolder`、`list-local-skills` 都用它，返回形状里的 `skillsDir` 继续是注入值（生产即 `~/.agents/skills` 绝对路径），单测才能指向临时目录。
- `skill-sync` 的「下载 zip」与「解压到技能目录」拆开：解压导出为可独立调用的函数（如 `extractSkillZip(zipBuffer, skillsDir)`），handler 只管下载、落盘与通知渲染层。§8 的 zip 用例依赖这条缝，不发 HTTP。

### 5.6 `gitIpc.cjs`（第 3 批）

`registerGitIpc(ipcMain, { getWorkspace })`。`getWorkspace` 返回 `currentWorkspace`。每个 handler 仍是 `参数.workspace || getWorkspace()`。

通道（名称与失败形状都不改）：

- 失败返回 `{ error }`：`git-repos`、`git-status`、`git-status-refresh`、`git-log`、`git-commit-files`、`git-branch-compare`、`git-branches`、`git-stashes`、`git-remotes`
- 失败返回降级 diff 对象：`git-file-diff`、`git-commit-file-diff`、`git-branch-compare-file-diff`
- 原样返回操作模块的结果：`git-commit-input`、`git-commit`、`git-pull`、`git-push`、`git-fetch`、`git-switch-branch`、`git-stash-op`

`get-environment-info` 留在入口。它只用 `isGitWorkspace`、`detectShell`、`buildOsVersion`，不经过 Git 模块。

### 5.7 `localFileIpc.cjs`（第 3 批）

注册：`local-read-file`、`local-read-bytes`、`local-read-workspace-bytes`、`local-delivery-read-bytes`、`local-write-file`、`local-edit-file`、`list-workspace-files`、`list-directory`。

同时导出供 `executeToolByName` 调用的 `handleLocalReadFile`、`handleLocalWriteFile`、`handleLocalEditFile`。依赖统一从入口注入：

```js
registerLocalFileIpc(ipcMain, {
  resolveWorkspacePath,     // 第 3 批时已来自 localRuntimePaths（闭包含 getCurrentWorkspace）
  requestToolApproval,      // 审批留在入口（§7）；D2 禁止反向 require，没有这条缝写文件通道无法落地
  nativeImage,              // 读图缩放用
})
```

读图（`mimeFromPath`、`detectMimeFromBytes`、`formatImageSize`、`readLocalImage`，及图片扩展名表与 5MB 上限常量）跟读文件走，`nativeImage` 由入口传入，模块本身不 `require('electron')`，单测不必起 Electron。

新增一个内部函数，例如 `writeFileWithDiff(resolvedPath, filePathArg, content)`，只做：存在则读原文、建目录、写入、`computeLineDelta`、`buildFileChangeDiff`。`local-write-file` 与 `handleLocalWriteFile` 各自先审批，再调用它。编辑继续调用第 1 批的 `writeEditedFile`。

`list-directory` 的 containment（必须落在传入的 workspace 之内，上限 500 条）原样保留。`list-workspace-files` 的忽略目录集合与「先文件后目录、再按 mtime 截断」原样保留。

`local-read-bytes`、`local-read-workspace-bytes`、`local-delivery-read-bytes` 继续委托已经存在的 `localFileBytes.cjs` / `localWorkspaceRead.cjs`，只是注册位置换到这个文件。

## 6. 分批实施

每批的做法：先按原函数搬家，再改入口的调用。不顺手重排无关代码，不改日志文案。

### 第 1 批

1. 新增 `fileChangeDiff.cjs`、`localSearch.cjs` 及对应 `*.test.cjs`。
2. `main.cjs` 删除已搬走的函数，改为调用新模块。
3. `executeToolByName` 的 glob/grep 分支改为调 `createLocalSearch` 的返回值。`resolveWorkspacePath` 此批仍留在入口，作为回调传入。

本批结束后入口大约少 560 行。

### 第 2 批

1. 新增 `localRuntimePaths.cjs`、`mcpClient.cjs`、`localSkills.cjs` 及测试。
2. `localShell` 的输出路径、技能同步、`resolveWorkspacePath` 的调用点改为使用路径模块。第 1 批搜索的回调改为路径模块的 `resolveWorkspacePath`。
3. `mcp-sync` / `mcp-close` 改由 `registerMcpIpc` 注册。入口的退出与切服务器改为 `closeAll()`。
4. 五个技能通道改由 `registerLocalSkillsIpc` 注册。

本批结束后入口再少约 450 行。

### 第 3 批

1. 新增 `gitIpc.cjs`、`localFileIpc.cjs`。
2. Git 通道与本地文件通道改为两个 `register*`。
3. 抽出 `writeFileWithDiff`，两处写文件改为调用它。两处编辑仍各自审批后调用 `writeEditedFile`。
4. `executeToolByName` 的 read/write/edit 改为调 `localFileIpc.cjs` 导出的三个 handle。`shell`、`write_local_text_file`、MCP 分支留在入口。

本批结束后入口应落在约 1400–1600 行。若明显低于 1400，说明壳逻辑被一起搬走了，把那部分移回入口。

## 7. 留在入口的接线

实施后 `main.cjs` 仍负责：

- `requestSingleInstanceLock`、`second-instance`、`whenReady`、`window-all-closed`、`activate`、`before-quit`
- `createWindow`、`loadMainContent`、`applyServerConfig`、服务器选择窗
- 应用菜单、`electron-updater`、托盘、通知、角标、全局快捷键、开机自启
- 鉴权与服务地址的 IPC（逻辑已在 `authStore.cjs`、`serverConfig.cjs`）
- `buildShellEnv`，以及把它交给 `TerminalManager`、`TerminalHost`、`localShell`
- `requestToolApproval` / `ensureShellApproval` / `tool-approval-remote-response`
- `tool-execute`：解析参数、必要时写入 `currentWorkspace`、按工具名分发
- 外链、飞书登录窗、选目录、在文件夹中显示、打开系统终端
- 本机终端 IPC（`terminal:create` / `data` / `resize` / `kill` / `list`），因为输出要发给 `mainWindow`

这些块互相通过 `mainWindow` 和退出标志协作，集成测试也是对着整份入口写的。本方案不再拆它们。

## 8. 测试

现有 `cd desktop && npm run test:unit` 必须保持通过。它已经包含 `electron/*.test.cjs` 与 `mainShell.test.cjs`。不新增 Playwright 用例：通道名与返回形状不变，渲染层没有新分支。

新增单测只断言行为，不断言私有实现：

**`fileChangeDiff.test.cjs`**

- 含 NUL 的内容（前 8192 字符内）→ `diff_mode: 'UNSUPPORTED'`，原因含「二进制」。
- 两侧都小于 512 KiB 的文本 → `SNAPSHOT`，带 `before_content` / `after_content`。
- 任一侧超过 512 KiB → `PATCH`，补丁含 `--- a/` 与 `+++ b/`，上下文 3 行；超过 256 Ki 字符时 `patch_truncated: true` 且正文以 `...[diff truncated]` 结尾。
- `applyEditMatch`：空 `old_string` 失败；找不到失败；默认只替换第一处；`replace_all` 替换全部。
- `asBoolArg`：`true` / `1` / `'yes'` 为真，`false` / `0` / `'no'` / `''` 为假，其它走 fallback。
- `writeEditedFile` 在临时目录写入后，返回的 `lines_added` / `lines_deleted` 与 `file_change_diff` 一致。

**`localSearch.test.cjs`**

- `parseRgLine`、单文件行解析：冒号分隔的匹配行、破折号分隔的上下文行、非法行返回 null。
- 临时目录上的 Node 回退：glob 命中、跳过 `node_modules` 与 `.git`、`head_limit` 截断。
- grep：大小写、上下文行、`max_output_chars` 截断后 `truncated: true`，非法正则返回 `error`。
- 路径不存在时返回错误，不抛出。
- 不要求运行环境安装 `rg`。

**`localRuntimePaths.test.cjs`**

- hostKey 与 sessionId 进入 `~/.mao/runtime` 路径；`formatLocalRuntimePath` 以 `~/.mao/runtime` 开头，不展开 home。
- `~/a` 展开到 homedir 下；相对路径拼到 workspace；无 workspace 时相对路径保持展开结果。
- 绝对路径原样返回，包括不在 workspace 内的路径（锁定「本方案不新增沙箱」）。
- `isUnderLocalRuntime` 只在路径等于该会话 runtime 目录或其子路径时为真。

**`mcpClient.test.cjs`**

- `parseMcpToolName`：`mcp__server__tool` 成功；缺少前缀、缺少分隔、空段返回 null。
- `formatCallToolResult`：有 `structuredContent` 时输出其 JSON；否则拼接 text / image 占位 / resource。
- 注入会失败的 `connect`：`syncServers` 返回该项 `connected: false` 且带 `error`，不抛出。
- 不连真实 MCP 服务器，不拉起 stdio 子进程。

**`localSkills.test.cjs`**

- `parseSkillMd`：合法 frontmatter 取出 name、description、body；无 frontmatter 或无 name 返回 null。
- `resolveLocalSkillFolder`：拒绝 `../`、绝对逃逸、以 `.` 开头；临时目录内的真实文件夹可通过（skills 根目录走 `getLocalAgentsSkillsDir` 注入，不摸真实 `~/.agents/skills`）。
- `preferIpv4Loopback` 把 `://localhost` 换成 `://127.0.0.1`；`resolveSkillSyncBaseUrl` 去掉末尾 `/v1`。
- `read-agents-md`：无文件返回 `{ content: null }`，有文件返回正文。
- 不在单测里访问网络。zip 解压用例直接调 §5.5 导出的解压函数，传临时目录与本地 buffer，不走 `skill-sync` 的下载段。

**`gitIpc.test.cjs` 与 `localFileIpc.test.cjs`**

- 用假的 `ipcMain` 断言通道名集合与今天一致（第 3 批通道见 §5.6、§5.7）。
- Git：workspace 省略时使用 `getWorkspace()`；让底层函数抛错，抽查一条 `{ error }` 通道和一条 `unavailableReason` 通道。Git 本身的行为仍由 `gitStatus.test.cjs`、`gitOperations.test.cjs` 负责。
- 文件：`list-directory` 拒绝 workspace 之外的路径；`writeFileWithDiff` 对已存在文件给出 `MODIFIED` 与非空 diff，对新文件给出 `CREATED`。不把 IPC 的「每次审批」和 WS 的「按 needApproval 审批」合成一个用例来互相替代，两条都要有。

每批合并前在 `desktop` 下跑 `npm run test:unit`，日志先落盘再看 `Test Files` / `tests` / `FAIL` 摘要。另外用检索确认：本批声称移走的通道在 `preload.cjs` 中的字符串没有改动，`main.cjs` 里不再定义已搬走的函数。

## 9. 风险

| 风险 | 处理 |
|---|---|
| 搬家时改了返回字段名或把两条写文件合成一种审批 | 第 3 批以 §2.4 为对照。单测分别覆盖 IPC 必审批与 WS 条件审批 |
| `closeAll` 漏接，切服务器或退出后 MCP 子进程残留 | 第 2 批改 `cleanupSiteScopedResources` 与 `before-quit` 两处，并在评审时对这两处做检索 |
| 搜索模块自己读一份 `currentWorkspace` 副本 | 只注入 getter。写入仍只在 `tool-execute` |
| 新模块反向 require 入口，和 harness 清缓存的顺序打架 | D2。harness 先清缓存再加载入口，入口再加载子模块，这个顺序可以保持 |
| 实施时顺手给绝对路径加 containment，LOCAL 读 runtime 之外的附件或绝对路径失败 | D 的「不做」写明。路径单测锁定绝对路径原样返回 |
| 把菜单、托盘一起拆掉，集成测试要重写 harness | D9。低于约 1400 行就检查是不是壳逻辑被搬走了 |

## 10. 落地后的约束

从第 1 批合并起：

- 新的文件、搜索、MCP、技能、Git 行为改在对应模块，并补该模块的测试。
- 新的 IPC 通道加在对应 `register*` 里，入口只增加一行注册。通道名同时出现在 `preload.cjs`。
- `main.cjs` 新增的只应是进程生命周期、窗口、菜单、更新、托盘通知快捷键、审批和工具分发。
- 若某次改动必须改变 IPC 返回形状，先改本方案的 §2.4 或 §5，再动代码。
