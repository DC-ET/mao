# 工作区文件直管技术方案：文件树从只读浏览升级为文件管理器

- 状态：待实施（2026-10-09 评审共识，8 项决策见 §4 / §8；同日可行性复核通过，缺口已补入 §12，与前文冲突时以 §12 为准）
- 日期：2026-10-09
- 提案来源：[docs/proposals/2026-10-09-workspace-file-manager.md](../proposals/2026-10-09-workspace-file-manager.md)

## 1. 需求背景

CLOUD 工作区的文件能力是"读 + Git 写"半边天：读侧（list/directory/search/read/preview/download/zip）与桌面文件树齐全，写侧只有 `workspace-git-commit/pull/push`（前提是 Git 仓库）。用户想直接管文件只能派 Agent——人的文件操作是二等公民。本方案把文件树升级为文件管理器：上传、新建、重命名、删除、移动、复制，全部限定 CLOUD 工作区。

评审中发现提案的四处理解与现码不符，设计按现码修正：

1. **没有 `@RequirePermission` 装饰器**。实际是函数式 `requirePermission(permissionService, userId, code)`；file 域全部 20+ 端点（含 Git commit/pull/push 这些写操作）零权限码，只靠 `requireUserId + requireOwnedSession`。本方案沿用该形态（决策 D1）。
2. **`file-write-lock.ts` 没有"查某路径是否在写"的 API**。全文 23 行，只导出 `withFileLock`（模块级 Map 串行化 read-modify-write）。"操作前查锁"需要先扩展它（决策 D4，§5.2）。
3. **`session_activity` 落库后没有独立活动流 UI**。唯一渲染它的是 run 轨迹面板（`GET /v1/sessions/:id/trace` 的 `activityToToolVO`），且 VO 不带来源字段；用户桌面 Git 操作与 Agent 工具活动早已同表同框，只是不区分来源。"与 Agent 变更并列展示"落地为：落库 + 轨迹面板加来源标记（决策 D7，§5.3）。
4. **后端没有 HTTP 409 通道**。`handleError` 把 `BusinessException` 统一映射为 HTTP 200 + `Result.code ≠ 0`（仅 401/403/413 特例），且 `fail(code, message)` 不带 data。所以"409 冲突面板"实际是**业务错误码**：新增 `3043 WORKSPACE_WRITE_CONFLICT`，前端按业务码弹冲突面板（§5.2）。

时钟与路径事实（设计建立在其上）：

- CLOUD 工作区根 = `cfg.app.harness.workspaceRoot`（env `WORKSPACE_ROOT`，生产 `/opt/mao-data/workspace`）；布局 `{root}/{userId}/projects/{slug}`（命名项目，可被多会话共享）或 `{root}/{userId}/{sessionId}`（自动会话）。
- `path-sandbox.ts` 的 `resolve()` 是严格模式（绝对路径也必须在 root 或 allowedRoot 内；runtime 目录被 `addAllowedRoot` 放行），`resolveLenient()` 宽松（读侧在用）。写侧必须用 `resolve()` 之外再叠加 `isUnder(resolved, sessionWorkspace)`，否则 allowedRoot 放行的 runtime 目录会被写成。
- `session_activity`（V010）字段齐备：`type/target/summary/detail_json/status`，`ActivityService.record(sessionId, type, target, summary, detailJson, status, durationMs)` 已支持 detailJson。
- multipart 全局限制：`fileSize = file.maxSizeMb`（默认 1024MB，后台可调）、`files: 500`；无 MIME 白名单。工作区与 runtime 同在 `/opt/mao-data` 下，今天无磁盘配额系统。
- 迁移现状：最大 V141，**本方案零 DDL、不占 V142**（对同批其他提案是利好）。

## 2. 需求描述

### 2.1 目标

1. **完整文件管理操作（CLOUD）**：新建文件/文件夹、重命名、删除、移动、复制、上传（文件/目录）；桌面文件树右键菜单 + 拖拽落点承载。
2. **安全边界**：所有写操作过严格路径沙箱（拒越界、拒符号链接逃逸、拒写入 runtime 目录），删除是物理删除且强确认。
3. **与 Agent 并发写共存**：扩展写锁暴露在途查询；Agent 正在写某文件时用户操作返回冲突（业务码 3043）+ 冲突面板，默认取消、可强制；用户写自身与 Agent 写串行化。
4. **可观测**：每个成功写操作落 `session_activity`（`type=file_user_write`，`detail_json.actor=user`），run 轨迹面板与 Agent 变更同框且带"用户"来源标记。
5. **LOCAL 隔离**：LOCAL 会话文件树菜单保持只读现状不变，写端点对 LOCAL 直接拒绝。

### 2.2 非目标

- **不做回收站**（评审决策 D2）：删除即物理删除，不引入 `.mao-trash/`、index.json、恢复/清空语义。误删兜底：Git 工作区走 git 恢复，其余重新上传/让 Agent 重新生成。
- 不做快照/回滚/版本对比（检查点提案已否决，边界不变）。
- 不做内嵌富文本/代码编辑器（只读 `FileViewer` + "加入对话让 Agent 改"维持现状；维持提案开放问题定位，P3 后单独评估）。
- 不做跨工作区传输（剪贴板限同会话同工作区）。
- 不做 Git 暂存/分支等高级操作（现有 commit/pull/push 够用）。
- 不加权限码、不动角色体系（D1）。
- 不做批量操作的完整交互（P3 只做多选删除/移动的最小集，见 §6）。

## 3. 范围界定

### 3.1 做什么

| 层 | 内容 |
|---|---|
| backend-ts | `file-write-lock.ts` 加在途查询；新增 `workspace-write.service.ts`（沙箱/realpath/锁协同/六操作/活动记录）；`file.routes.ts` 加 6 个写端点（P2 加 upload）；`error-code.ts` 加 3043/3044 |
| desktop | `FileTreeContextMenu.vue` 菜单矩阵改造；`FileTree.vue` 行内新建/重命名、删除确认、剪贴板粘贴、冲突面板、写后刷新；新增 `useFileClipboard` 与写操作 API 封装 |
| 文档 | 实施发版时补 CHANGELOG；README / DEPLOY 无部署变化不补；mao-cli desktop 手册补文件管理说明 |

### 3.2 不做什么

- 不加数据库迁移（`session_activity` 表现成足够；`detail_json` 带 actor 即可）。
- 不新增权限码，不改 admin 任何页面。
- 不改读侧任何端点（`resolveLenient` 不收紧，历史行为不变）。
- 文件树不订阅 `file_change` WS 事件自动刷新（见 §7 开放问题）。
- 不改 `write_file`/`edit_file` Agent 工具的锁用法（只在其底层加在途登记）。

## 4. 关键决策（评审共识）

零新依赖、零迁移。八个塑形决策：

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 权限模型 | 不引入权限码。写端点沿用 `requireUserId + requireOwnedSession`，与 file 域现状及 Git 写操作一致："能打开这个会话的人就能改它的工作区" |
| D2 | 回收站 | 不做。删除即物理删除 |
| D3 | 删除语义 | 物理删除 + 强确认：确认框列完整路径清单，目录标注"含其下所有内容"，明示不可恢复 |
| D4 | 锁协同 | 扩展 `file-write-lock` 暴露在途查询；写端点操作前查锁，命中返 3043 + 冲突面板（默认取消、可 `force=true` 强制）；用户写自身包 `withFileLock` |
| D5 | 覆盖语义 | mkdir/rename/move 目标存在一律拒绝（3044）；write/copy/upload 默认拒绝，显式 `overwrite=true` 才覆盖 |
| D6 | 上传形态 | 文件 + 目录（`webkitdirectory` / drop 的 `webkitGetAsEntry` 递归），复用现有 `file.maxSizeMb`（默认 1024MB）与 `files:500`，不落 files 表 |
| D7 | 活动可见面 | 落 `session_activity`（`type=file_user_write`，`detail_json.actor=user`）+ run 轨迹 VO 加 `actor` 字段、面板加"用户"标记；不做新列表 |
| D8 | 分期 | P1 = 写端点族 + 菜单全量 + 冲突面板 + 活动落库；P2 = 上传 + 轨迹来源标记；P3 = 拖拽移动、最小批量、加入对话衔接 |

## 5. 详细设计

### 5.1 后端：workspace-write 端点族

新服务 `backend-ts/src/file/workspace-write.service.ts`，构造注入 `PathSandbox` 与 `ActivityService`（与 `GitWriteOperationService` 注入 `ActivityService` 同模式）；`FileRouteDeps` 加 `workspaceWriteService`，在 `create-app.ts:2470` 的 `registerFileRoutes` 装配处接线。

**端点表**（全部 `requireUserId + requireOwnedSession`；LOCAL 会话一律 `PARAM_INVALID '本地模式不支持服务端文件管理'`，同 `upload-incoming` 的拒绝样式）：

| 方法 | 路径 | 参数 | 语义 |
|---|---|---|---|
| POST | `/v1/files/workspace-mkdir` | sessionId, path | 建目录，自动补中间父级；已存在 → 3044 |
| POST | `/v1/files/workspace-write` | sessionId, path, content?, overwrite?, force? | 建文件；content 默认空串，上限 10MB（`MAX_WRITE_CONTENT_BYTES`，对齐 `MAX_TEXT_PREVIEW_BYTES`）；已存在默认 3044，`overwrite=true` 覆盖 |
| POST | `/v1/files/workspace-rename` | sessionId, path, newName, force? | 同目录改名；newName 禁空、禁含 `/` 与 `\0`、禁 `.`/`..`、禁首尾空白（允许点开头，`.gitignore` 合法）；目标已存在 → 3044 |
| POST | `/v1/files/workspace-move` | sessionId, from, to, force? | to 为已存在目录则移入其中（保留 basename），否则视为完整目标路径；最终目标已存在 → 3044；to 是 from 的子路径 → `PARAM_INVALID`（不能移进自己） |
| DELETE | `/v1/files/workspace-delete` | sessionId, path, force? | 物理删除：文件 unlink，目录 `rmSync recursive`；symlink 只删链接本身；路径不存在 → `PARAM_INVALID '路径不存在'` |
| POST | `/v1/files/workspace-copy` | sessionId, from, to, overwrite?, force? | 复制，目录递归；目标已存在默认 3044；上限 `MAX_COPY_ENTRIES=10000` / `MAX_COPY_BYTES=2GB`，超出提示改走下载-上传 |
| POST | `/v1/files/workspace-upload` | multipart | P2，§5.5 |

成功统一返回 `sendOk(reply, { path })`（相对工作区路径，move/rename/copy 返回目标路径），前端拿来做树刷新与 tab 校正。

**路径解析（所有写操作共用入口 `resolveWritable`）**：

1. `pathSandbox.resolve(userPath, sessionWorkspace)`——严格沙箱，`SecurityException → 403 FORBIDDEN`，`IllegalArgumentException → PARAM_INVALID`（同 `workspace-browse.service.ts` 的错误映射）。
2. `isUnder(resolved, realpath(sessionWorkspace))` 必须成立——挡掉 `addAllowedRoot` 放行的 runtime 目录与跨用户目录。**这是写侧比读侧多的一道**。
3. realpath 防逃逸：对已存在的最深父目录取 `realpathSync` 后拼剩余段（抄 `git-write-operation.service.ts:306-314` 与 `workspace-git.service.ts` 的 `realPath/isUnderReal` 写法），再跑一次 `isUnderReal`。symlink 指向工作区外 → `FORBIDDEN`。
4. 目标本身是 symlink：write/mkdir/rename/move/copy 的目标存在即拒（3044/PARAM_INVALID），不存在被创建；delete 的 symlink 用 `lstatSync` 判定，`unlinkSync` 删链接不跟踪。

**覆盖与冲突矩阵**：

| 操作 | 目标已存在 | Agent 在写（源或目标路径） |
|---|---|---|
| mkdir / rename / move | 3044，无 overwrite 入参 | 3043，`force=true` 跳过检测 |
| write / copy / upload | 默认 3044；`overwrite=true` 覆盖 | 3043，`force=true` 跳过检测 |
| delete | 不存在才报错；symlink 删链接 | 3043，`force=true` 跳过检测 |

**活动记录**（仅成功操作；失败不记，同 Git 写操作口径）：

```ts
await activityService.record(
  sessionId, 'file_user_write', targetRelPath,
  `用户${opLabel}`,                       // 新建目录/新建文件/重命名/移动/删除/复制/上传
  JSON.stringify({ actor: 'user', op }), // op ∈ mkdir|write|rename|move|delete|copy|upload
  'SUCCESS', null,
);
```

`target`：rename/move/copy 写 `from → to`（相对路径）；其余写目标相对路径。`ActivityService` 现有截断（target 2048 / summary 512）兜底。

### 5.2 与 Agent 写锁协同

`file-write-lock.ts` 现仅 23 行（模块级 `pathLocks: Map<string, Promise<void>>`，`withFileLock(path, fn)`）。扩展在途登记与前缀/目录锁（§12.1），不动 Agent 工具的调用处。下面的片段只说明「入队即在途」，检测与目录锁以 §12.1 为准：

```ts
const inFlight = new Set<string>();
export async function withFileLock<T>(filePath, fn) {
  inFlight.add(filePath);                 // 入队即在途：Agent 工具调用已发起就算
  try { /* 原逻辑不变 */ } finally { inFlight.delete(filePath); /* ... */ }
}
export function isFileWriteInFlight(filePath: string): boolean { return inFlight.has(filePath); }
```

- **在途语义**：`withFileLock` 入口即登记（排队中也算在途）。`write_file`/`edit_file` 已在锁内，零改动即获得查询能力。
- **检测点**：见 §12.1。精确路径 `Set.has` 不够：目录操作必须做前缀匹配，锁键必须与 `write_file`/`edit_file` 传入 `withFileLock` 的字符串一致。覆盖范围只有这两把锁，不含 `shell`。
- **强制**：请求带 `force=true` 跳过检测仍然执行。冲突面板默认"取消"，"强制操作"即带 `force=true` 重放原请求；面板文案明示"Agent 可能随后出错"。
- **串行化**：文件包 `withFileLock`（rename/move 的 from 与 to 按路径字典序加锁）。目录操作走 §12.1 的目录锁，否则删目录不会和目录内的 `write_file` 排队。
- **边界（不解决，写进风险）**：锁只覆盖"Agent 写任务进行中"这一窗口。用户 rename 之后 Agent 的 `write_file` 才落笔，会把文件按原路径重新创建——这不是锁能表达的语义，靠 3043 面板的事前拦截 + 活动流事后追溯缓解。

### 5.3 活动与来源标记

**P1（落库）**：§5.1 的 `record` 调用即全部。`detail_json = {"actor":"user","op":...}`。历史 `GIT_COMMIT/GIT_PULL/GIT_PUSH` 行 detailJson 为空，本期不补（避免动 Git 写路径）。

**P2（run 轨迹来源标记）**：

- `run-trace.service.ts`：`TraceToolVO` 加 `actor: 'user' | 'agent' | null`（detail 无 actor 的历史行为 null）；`activityToToolVO` 解析 `detail_json.actor`。
- 用户写没有 `tool_call_id`，轨迹按时间窗落进该 run 的 `unplacedTools`（「未挂到轮」），不会进 `round.tools`。徽标要加在三处 `.tool-row`：轮内工具（约 :116）、未挂到轮（约 :128）、未归属（约 :201）。列表 key 用 `target + name`，不能只用 `toolCallId ?? name`（多条「用户删除」会撞 key）。
- `activityToToolVO` 的 `name` 取 `summary ?? type`，用户行 summary 即"用户删除"等文案，直接可读，不改 name 映射。

### 5.4 前端：文件树升级为文件管理器

**菜单矩阵**（`FileTreeContextMenu.vue`，新增 `canWrite` prop = `executionMode === 'CLOUD'`，与现有 `showDownloadActions`/`showOpenInFinder` 同模式；写项全部 `v-if="canWrite"`）：

| 菜单项 | 文件节点 | 目录节点 | 空白处（树根区域） |
|---|---|---|---|
| 新建文件 / 新建文件夹 | ✓（同级） | ✓（子级） | ✓（根） |
| 重命名 | ✓ | ✓ | — |
| 删除 | ✓ | ✓ | — |
| 剪切 / 复制 | ✓ | ✓ | — |
| 粘贴 | ✓（有剪贴板时） | ✓ | ✓ |
| 上传到此处（P2） | — | ✓ | ✓ |
| 下载此文件/目录、复制绝对/相对路径、加入对话 | 现有项不变 | 同左 | — |

LOCAL（`executionMode !== 'CLOUD'`）菜单与今天完全一致（在 Finder 中打开 / 下载 / 复制路径 / 加入对话），一个写项都不出现。

**交互细节**：

- **新建/重命名**：树内行内输入（复用同一 `editingPath` state：`{ mode: 'create' | 'rename', dir, name }`）。Enter 提交、Esc 取消、失焦提交；空名称/含 `/` 前端即拒。新建成功后 `refresh()` 并 `open-file` 新文件（只读 FileViewer）。
- **删除确认**：`ElMessageBox.confirm`（warning）：正文列顶层路径清单（目录项后缀"（目录，将删除其下所有内容）"），明示"删除不可恢复"。路径为 `.git` 或其子路径时追加「将删除 Git 版本库」。确认后调 delete，成功后按 §12.4 校正中心 tab，再 `refresh()`。**不递归展开子项清单**（避免大树卡顿；"递归"由文案表达）。
- **剪贴板**：新增 `desktop/src/composables/useFileClipboard.ts`，module 级 `{ op: 'cut' | 'copy', paths: string[], sessionId: number }`，跨组件共享。粘贴时校验 sessionId 一致，不一致 `ElMessage` 提示"不能跨会话粘贴"（D 非目标：无跨工作区传输）。cut 粘贴成功后清空剪贴板。
- **写冲突面板**：响应 `code === 3043` 时弹 `ElMessageBox`：标题"文件正在被 Agent 写入"，正文列冲突路径 + "强制操作可能导致 Agent 出错"，按钮"取消"（默认焦点）/「强制操作」。强制 = 原请求带 `force=true` 重放。目标已存在（3044）：write/copy/upload 场景弹"目标已存在，是否覆盖？"，确认后带 `overwrite=true` 重放；mkdir/rename/move 场景直接 toast 错误信息。
- **刷新策略**：用户写操作成功后调 `useFileBrowser.ts` 现有 `refresh()`（递增竞态序号 + 重拉 + `restoreExpandedPath` 恢复展开态），不做 WS 广播。发起端本地刷新即满足"写后即时刷新"；文件树不订阅 `file_change`（§7 开放问题）。
- **API 封装**：新增 `desktop/src/composables/workspace-file-write.ts`（或并入 `workspace-file-provider.ts` 同层），沿用现有 `api` + `getToken()` 方式调 `/v1/files/workspace-*`；请求体 JSON（`bodyOf` 对应），DELETE 用 query 传参。全局拦截器对 HTTP 200 + `code ≠ 0` 会先 `ElMessage.error`（`skipErrorToast` 挡不住这条路径）。3043/3044 必须关掉这条 toast，只留冲突/覆盖面板。写请求的 timeout 不能用默认 30s，见 §12.3。

### 5.5 上传（P2）

- **入口**：FileTree 目录节点与空白处 `@dragover.prevent @drop.prevent`；工具栏"上传"按钮挂隐藏 `input[type=file]`（多选）与 `input[webkitdirectory]`（目录）双入口。
- **drop 取文件**：`DataTransferItem.webkitGetAsEntry()` 递归遍历，目录保留相对路径（`webkitRelativePath` 语义：以 drop 目标目录为根的相对路径）。Electron 与 Capacitor WebView 均为 Chromium 内核，支持；Web 端同。
- **传输**：`XMLHttpRequest` 直发 `/v1/files/workspace-upload`（要 progress 事件，现有 fetch 封装不适用），带 token header。后端 multipart 字段：`sessionId`、`dir`（目标相对目录）、`file`（可多文件，`files: 500` 上限内）、每文件的相对路径随 part 的 filename 或独立字段 `relativePath` 传递。
- **服务端**：落在 `dir` 下（按 relativePath 补建中间目录）。每个 relativePath 都走 `resolveWritable`，拒绝绝对路径、`..` 与 `\0`，不信任 multipart filename。大小/数量限制复用全局 multipart 配置（D6）；**不落 files 表**（文件即在工作区，文件树可见，"文件进工作区 + `@{}` 引用"心智，避免双份真相）；同名默认 3044，`overwrite=true` 只覆盖文件（见 §12.2）；成功记 `file_user_write`/`upload` 活动（多文件合一条，target 列目标目录）。安卓共用这套 UI，但拖拽 / `webkitdirectory` 在安卓 WebView 上不可靠，工具栏 `input` 是兜底，不改安卓原生。
- **进度 UI**：拖拽时目标节点高亮；上传中在树顶部显示 `ElProgress` 小浮层（文件名 + 百分比 + 失败重试提示）。

### 5.6 与既有能力衔接

- "加入对话"语义不变：上传/新建的文件走现有 `@{绝对路径}@` 注入（`prompt-engine.ts:79` 的 `FILE_REF_PATTERN` 只还原路径不读内容），喂料从"附件进 runtime incoming"变为"文件进工作区 + 引用"；`upload-incoming` 端点保持现状不动。
- Git 工作区下用户写自然进入 `git status`，现有 diff 视图可见"人改的 vs Agent 改的"；回收站出局后 `zipDirectory` 无排除项要处理（提案里的 `.mao-trash` 过滤点一并删除）。
- Agent 侧无需任何改动：`write_file`/`edit_file` 经扩展后的 `withFileLock` 自动获得在途登记；`workspace-search` 等读工具不受影响（无 `.mao-trash` 污染问题）。

## 6. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | `file-write-lock` 在途查询 + `workspace-write.service.ts` + 6 个写端点（mkdir/write/rename/move/delete/copy）+ 3043/3044 错误码 + 活动落库；前端菜单矩阵、行内新建/重命名、删除强确认、剪贴板、写冲突/覆盖面板、写后刷新 | 中 |
| P2 | 上传（拖拽 + 目录 + XHR 进度 + overwrite 确认）+ run 轨迹 `actor` 字段与"用户"标记 | 小~中 |
| P3 | 拖拽移动（树内 drag 节点到目录）、最小批量（多选删除/移动）、"加入对话"衔接优化 | 小 |

内嵌编辑器维持非目标，P3 后按提案开放问题单独评估。

## 7. 风险与开放问题

- **rename/写竞态的语义缺口**：锁只覆盖"Agent 写进行中"窗口；用户改名后 Agent 才落笔会在原路径重建文件。缓解：3043 事前拦截 + 活动流追溯；文件级事务不做（成本高于收益）。
- **强制操作的风险**：面板明示"Agent 可能随后出错"，默认取消；是否记录强制操作到 detail_json 留实施时定（推荐记 `force: true`）。
- **大目录 copy/delete**：copy 设 10000 项 / 2GB 上限，超出引导下载-上传。请求路径上用 `fs.promises`，不用 `rmSync`/`cpSync`（会卡住整个 Node 进程）。客户端 timeout 见 §12.3。
- **多会话共享 project 工作区**：会话 B 删了会话 A 的文件——锁是进程级的，能检测到 A 的 Agent 在写；但 A 的用户手动操作与 B 无冲突检测（跨前端客户端，无客户端锁）。接受，活动流可追溯。
- **开放问题：文件树订阅 `file_change`**：Agent 改文件后文件树不自动刷新（今天即如此）。本期只做发起端本地刷新；把"树订阅 file_change 自动刷新"列为后续可选增强（需防抖与展开态保持，独立小提案）。
- **开放问题：上传无磁盘配额**：与 runtime 附件同盘共命（现状），本期不引入配额；工作区上传被现有 `file.maxSizeMb` 兜底。
- **非 Git 工作区轻量版本化**：不做（与检查点提案边界一致，D2 已定调不引入恢复语义）。

## 8. 决策记录

| # | 决策点 | 结论 | 论证摘要 |
|---|---|---|---|
| 1 | 权限模型 | 不引入权限码，`requireOwnedSession` 即可 | 提案假设的 `@RequirePermission` 不存在；file 域含 Git 写操作今天零权限码，保持一致最简 |
| 2 | 回收站 | 不做，物理删除 | 回收站的 Agent 可见性、生命周期、恢复语义成本 > 收益；与"不做快照/回滚"边界一致 |
| 3 | 删除确认 | 强确认：列顶层路径 + 目录标注递归 + 明示不可恢复 | 物理删除无兜底，确认框是唯一防线；不递归展开子项防卡顿 |
| 4 | 锁协同 | 扩展在途查询 + 业务码 3043 + force 重放；用户写包 withFileLock | 现锁无可查询 API；入队即在途的语义覆盖排队中的 Agent 写 |
| 5 | 冲突响应形态 | 业务码 3043/3044，非 HTTP 409 | `handleError` 统一 HTTP 200 + Result.code；`fail` 无 data，冲突路径放 message |
| 6 | 覆盖语义 | mkdir/rename/move 一律拒；write/copy/upload 可 overwrite | 上传同名是高频场景；改名撞名默认保守 |
| 7 | 上传范围 | 文件+目录，复用现有限制，不落 files 表 | 喂料常是整个目录；files 表是会话附件口径，与工作区文件双份真相 |
| 8 | 活动可见面 | 落库 + run trace actor 标记，不做新列表 | run trace 是今天唯一渲染 activity 的面板；GIT_* 历史行不补 actor |
| 9 | 写侧沙箱 | `resolve()` 严格 + `isUnder(workspace)` 双保险 + realpath | allowedRoot 放行 runtime，只靠 resolve 不够 |
| 10 | symlink | 写目标存在即拒；delete 只删链接 | 与读侧 lstat 拒链接的口径对齐 |
| 11 | 分期 | 上传整体后移 P2 | 删除/改名/移动 + 冲突面板可独立闭环"任务后收拾"；上传是独立大块 |
| 12 | 迁移 | 零 DDL，不占 V142 | session_activity 与 detail_json 现成 |

## 9. 测试要点

- **沙箱**：`../` 逃逸、绝对路径越界、指向 runtime 目录的合法 allowedRoot 路径（写侧必须拒）、symlink 指向工作区外、目标本身是 symlink——全部拒绝且无任何写副作用（目标文件字节不变）。
- **覆盖语义**：mkdir/write/rename/move/copy 目标存在默认 3044；write/copy 带 `overwrite=true` 成功且内容替换；rename/move 传 overwrite 无效仍拒；move 到 from 的子路径拒。
- **删除**：文件删后不存在；目录递归删净；symlink 删除后链接没了、目标文件还在；不存在路径报 `路径不存在`。
- **复制**：文件与目录递归复制内容一致；超 10000 项 / 2GB 拒绝；cut 粘贴后源消失、copy 粘贴后源还在。
- **锁协同**：Agent 持锁（`withFileLock` 内挂起）时用户 delete/rename/move/write 返 3043 且 message 含冲突路径；删除目录时，锁在该目录之内的文件也算冲突（§12.1）；`force=true` 放行；锁释放后同操作成功；同一绝对路径上用户写与 `write_file`/`edit_file` 串行，内容为后执行的一方。`shell` 不在此列。
- **活动**：每个成功写操作一条 `file_user_write`，target 为相对路径（move/rename/copy 为 `from → to`），`detail_json.actor=user` 且 op 正确；失败操作不落行。
- **LOCAL**：六个写端点对 LOCAL 会话全部 `PARAM_INVALID`；前端 LOCAL 会话右键菜单无任何写项（回归现有菜单四项）。
- **回归**：读端点（directory/read/search/download/zip）行为不变；`resolveLenient` 未收紧；git 端点不受影响；`upload-incoming` 不变。
- **P2 上传**：拖文件到目录节点落该目录；拖目录保留相对结构；超 `file.maxSizeMb` 拒绝；同名 overwrite 确认流；progress 事件到达前端；不产生 files 表记录。
- **P2 来源标记**：用户写活动的轨迹行 `actor=user` 且出现在「未挂到轮」（不是轮内工具行），面板出"用户"徽标；Agent 工具行无徽标；历史 GIT_* 行 actor=null 不徽标。
- **补遗用例**（§12）：工作区根删除/改名/移走拒绝；目录复制进自己的子路径拒绝；文件与目录类型互斥，`overwrite` 不能把目录换成文件；仅大小写变化的重命名在精确文件名比对下成功；复制中途失败不留下半成品目录；上传 `relativePath=../` 拒绝且无写副作用。

## 10. 变更落点清单

**backend-ts**

- `src/harness/tool/impl/file-write-lock.ts`：`inFlight` 集合、前缀冲突查询、目录锁；`withFileLock` 入口登记并等待祖先目录锁（§12.1）。
- `src/common/error-code.ts`：`WORKSPACE_WRITE_CONFLICT`（建议 3043，当前最大 3042，实施时顺延）、`WORKSPACE_TARGET_EXISTS`（建议 3044）。
- `src/file/workspace-write.service.ts`（新）：`resolveWritable`、六操作执行、锁检测、活动记录；配套 `workspace-write.service.spec.ts`。
- `src/file/file.routes.ts`：6 个端点 + LOCAL 拒绝 + `workspaceWriteService` 接线；`file.routes.spec.ts` 补端点级用例。
- `src/create-app.ts`：`registerFileRoutes` deps 加 `workspaceWriteService`（装配在 `GitWriteOperationService` 附近，同样注入 `activityService`）。
- `src/session/run-trace.service.ts`（P2）：`TraceToolVO.actor` + `activityToToolVO` 解析。

**desktop**

- `src/components/file-browser/FileTreeContextMenu.vue`：菜单矩阵 + `canWrite`/`canPaste` props。
- `src/components/file-browser/FileTree.vue`：菜单装配、行内新建/重命名、删除确认、粘贴、冲突/覆盖面板、写后 refresh 与 tab 校正、P2 drop 区。
- `src/composables/useFileClipboard.ts`（新）：剪贴板 module 状态。
- `src/composables/workspace-file-write.ts`（新）：写操作 API 封装（P2 含 XHR 上传）。
- `src/components/center/RunTracePanel.vue`（P2）：工具行"用户"徽标。

**文档**

- 根 `CHANGELOG.md`：发版时记（小节：后端 + 前端）；`desktop/package.json` 版本用 `scripts/changelog-extract.sh ... sync-desktop`，勿手改。
- `skills/mao-cli/SKILL.md`：desktop 手册的文件浏览器段落补写操作说明。
- README/DEPLOY 无部署与配置变化，不补。

## 11. 发版前检查

- `cd backend-ts && npm run build && npm test`；`cd desktop && npm run build`（vue-tsc）。
- 新端点补 `file.routes.spec.ts` 回归；锁扩展后 `write-file-tool`/`edit-file-tool` 既有单测全绿。
- CHANGELOG 小节齐（后端：文件写端点族与锁协同；前端：文件树文件管理器化）。
- mao-cli SKILL.md 同步后再打包发版。

## 12. 可行性复核补遗（2026-10-09）

需求可行，方案主干可行：写操作是会话工作区内的本地文件 IO，沙箱、`requireOwnedSession`、`session_activity`、文件树菜单都有现成落点，零迁移、零新依赖成立。下面这些是对照现码后原文没写清、写了会做错的部分。实施以本节为准。

### 12.1 锁：前缀、键、目录，以及覆盖不到的写

`write_file` / `edit_file` 的锁键是 `pathSandbox.resolveLenient` 的结果，也就是 `path.resolve` 之后的绝对路径，**不**做 realpath。用户侧若只拿 realpath 去 `Set.has`，工作区路径上有符号链接时会对不上。

检测与加锁都收进锁模块，检查和登记在同一次同步段里完成（中间不能 `await`），避免「查的时候没有、登记之前 Agent 已经进锁」：

- 查询键同时用逻辑绝对路径（与 Agent 相同的 `path.resolve` 结果）和 realpath。任一命中即冲突。
- 命中规则是路径相等，或互为祖先/子孙。用户删除 `src/` 时，Agent 正在写的 `src/a.ts` 必须返回 3043。只比完整路径会漏掉「任务后收拾」的主场景。
- 文件操作仍包 `withFileLock`。目录的删除/改名/移动另走目录锁：登记该目录为持有中的前缀；`withFileLock` 在执行前若发现任一持有中的目录是自己的祖先，就排队。这样目录删除进行中，新的 `write_file` 不会把文件写回去。`force=true` 只跳过 3043，仍然要拿这把目录锁。
- message 固定为 `Agent 正在写入：<path>；<path>`。`fail()` 不带 data，面板正文直接用这条 message，不再拆字段。
- 判定顺序：先 3043（`force=true` 跳过），再 3044（`overwrite=true` 跳过）。前端重放时保留已经同意的 `force` / `overwrite`，避免强制之后再弹一次覆盖，或覆盖之后再弹一次冲突。

覆盖范围只有走 `withFileLock` 的 `write_file` / `edit_file`（含子代理、共享同一 project 工作区的其他会话，只要在同一进程）。`shell` 可以任意改工作区，执行前不知道会碰哪些路径，本期不纳入锁，也不会返回 3043。`generate_image` 写的是上传目录，`open_web_page` 写的是 runtime 网页缓存，都不在会话工作区里，不进这套冲突。面板文案写「Agent 正在写入」，不要写成「所有 Agent 写操作」。

锁是进程内 Map。当前部署是单进程，够用；不为此引入跨进程锁。以后若多进程，3043 只在本进程有效。

### 12.2 路径与复制语义

- **工作区根**：`delete` / `rename` / `move` 的源解析后等于工作区根 → `PARAM_INVALID`。不允许删掉或搬走整个工作区。
- **复制进自身**：目录 `copy` 的最终目标位于源之内（含源本身）→ `PARAM_INVALID`，与 move 同一条。
- **类型互斥**：最终目标已存在且与源类型不同（文件 vs 目录）一律拒绝。`overwrite=true` 只允许文件覆盖文件，不能把目录换成文件，也不能把文件换成目录。`to` 已是目录时，copy 与 move 一样是移入该目录并保留 basename，再对最终路径做存在性判断。
- **存在性**：用父目录 `readdir` 的文件名精确比对，不用单独的 `existsSync`。darwin 开发机大小写不敏感，`Foo` → `foo` 会被 `existsSync` 误判成 3044；生产 Linux 大小写敏感。两种环境都允许只改大小写。
- **复制失败**：先 `lstat` 遍历统计条目数与字节（不跟随符号链接），超 10000 项或 2GB 则拒绝且不开始写。通过后用 `fs.promises.cp`，`verbatimSymlinks: true`（复制链接本身）。中途失败则删掉已写出的目标，不留半成品；做不到跨进程原子。
- **`workspace-write` 只接受 UTF-8 文本**。上限按 `Buffer.byteLength(content, 'utf8')` 计 10MB，不按 JS 字符数。二进制走 P2 上传。
- **删除符号链接**仍只删链接。复制出去的链接若指向工作区外，读侧现有 `lstat` 拒绝逻辑继续生效，不在复制时跟随。

### 12.3 不要卡住进程，也不要让客户端先超时

`rm` / `cp` / `writeFile` / `mkdir` / `rename` 用 `fs.promises`。一次用户点击不等于没有并发：同步 IO 会停掉同进程里其他用户的请求和 Agent 循环。

桌面 `api` 默认 timeout 30 秒。复制、删除、写入单独把 timeout 放到 0（不超时），由服务端上限兜底。否则大目录会在客户端先失败、服务端仍在写，用户重试再撞上 3044 或「路径不存在」。上传走 XHR，同样不设 30 秒上限，只受 `file.maxSizeMb` 约束。

`desktop/src/api/index.ts` 在 HTTP 200 且 `code ≠ 0` 时无条件 `ElMessage.error`。`skipErrorToast` 只作用在 HTTP 错误分支，挡不住这条。写封装对 3043/3044 必须抑制这条全局 toast（给拦截器加按请求跳过业务码 toast 的开关，或这条调用不走该拦截器），冲突面板和覆盖确认是唯一界面。其它错误仍走全局 toast。

### 12.4 中心 tab 与活动落在哪个会话

文件 tab 的 `filePath` 是工作区相对路径（`useCenterTabs.openFileTab`）。校正规则：

- 删除：关掉 `filePath` 等于该路径、或位于该目录之下的 file tab 与 diff tab。
- 重命名/移动：这些 tab 的 `filePath`、`id`（`file:` / `diff:` / `git-diff:` 前缀）、`title` 改到新相对路径。file tab 的 `version` 加一，让查看器按新路径重载。

活动记在**发起操作的** `sessionId` 上。共享同一 project 工作区的另一个会话，轨迹里看不到这次操作。那一侧的文件树也不自动刷新（与 §7「不订阅 file_change」同一边界）。

### 12.5 安卓

文件树在 desktop 共用 UI 里，安卓是 CLOUD，写菜单会出现。不改安卓原生，也不为安卓单独做一套文件管理。P2 的拖拽和 `webkitdirectory` 在安卓 WebView 上不可靠；工具栏的 `input[type=file]` 是可用入口。
