# 管理后台会话工作区文件浏览技术方案

- 状态：待实施（2026-10-15 需求共识，7 项决策见 §4；2026-10-16 评审：需求与方案均可行，按 §11 评审记录修订后实施；评审轮不动代码）
- 日期：2026-10-15
- 能力底座：后端 `WorkspaceBrowseService` + `/v1/files/workspace-*` 端点族（[2026-10-09-workspace-file-manager-technical-design.md](2026-10-09-workspace-file-manager-technical-design.md) 已落地）、admin 会话详情页双栏布局（`admin/src/views/session/SessionDetailView.vue`）

## 1. 需求背景

管理后台会话详情页当前展示会话信息与聊天记录：排障时能看到 Agent"说了什么、调了哪些工具、改过哪些文件"（`FileChangePanel`），但看不到"磁盘上最终留下了什么"——工作区目录里现在有哪些文件、某个产物的完整内容、能否把整个工作区取下来分析，都无从入手。会话 VO 其实已透出 `workspace` 绝对路径（`session-vo.ts` L192/L272），但详情页只把它透传给文件变更面板做相对路径展示（`SessionDetailView.vue` L110），没有浏览入口。

能力底座已经齐备，缺口只在"admin 作用域"这一层：

- 后端 `WorkspaceBrowseService`（`backend-ts/src/file/workspace-browse.service.ts`）提供：单层目录列表（上限 500 条、目录优先、带 `mtimeMs`）、递归文件名搜索（跳过 `.git`/`node_modules`，上限 100 条、遍历有界）、文本读取（前 5000 行 / 512KB / UTF-8 严格解码拒二进制）、图片 data_uri（`sharp` 取宽高）、PDF inline 预览、单文件下载、目录 zip 打包（1GB 上限、临时文件流式下发）。所有路径经 `StrictPathResolver` 以会话工作区为唯一根收口，相对穿越、越界绝对路径、符号链接逃逸一律拒绝（service L411-423）。
- 但对外暴露的 `/v1/files/workspace-*`（`file.routes.ts` L113-190）用 `requireOwnedSession` 做严格 DB 属主校验（L50-59：`session.userId !== userId` 即 403）。管理后台查看任意用户会话必然 403；飞书群聊通道会话的工作区按设计由同群多用户共享，但 `session.userId` 固定为建会话者，同群其他用户同样 403。
- admin 域路由（`admin-session.routes.ts`）走权限码鉴权（`session:read` / `session:write`，经 `permissionService.hasPermission`），与文件域的属主校验是两套体系，互不打通。
- 桌面端已有两套完整文件 UI（`FileTree.vue` 侧边懒加载树 + `FileManagerPanel.vue` 面包屑管理器 + `FileViewer.vue` 预览），其信息架构（面包屑 + 名称/大小/修改时间列表 + 递归搜索 + 单文件/zip 下载）已验证好用；但桌面端代码依赖 Electron 与中心 Tab 体系，不能整体搬进 admin，需按 admin 技术栈（Element Plus + 双栏详情页）重写载体。

本方案在管理后台补齐这一缺口：新增一组 admin 作用域的只读文件端点，会话详情页信息卡提供入口，全屏 Dialog 承载文件浏览器。

## 2. 需求描述

### 2.1 目标

1. **看见工作区**：会话详情页左侧信息卡新增"工作区"行，展示工作区绝对路径（超长省略、可复制）；路径为空显示 `-`。
2. **浏览目录**：CLOUD 会话提供"查看文件"入口，打开全屏 Dialog：面包屑导航 + 单层文件列表（名称/大小/修改时间，目录优先），点目录逐层进入，点文件打开预览。
3. **预览文件**：文本（等宽展示 + "仅显示前 N 行"截断提示）、图片（内联展示 + 后端摘要）、PDF（inline）、Markdown（渲染态/源码双态切换）；其余格式明确提示"暂不支持预览，请下载后查看"。
4. **下载取证**：单文件下载；当前目录整包 zip 下载（后端 1GB 上限，超限给明确错误）。
5. **搜索定位**：Dialog 内按文件名递归搜索整个工作区（大小写不敏感子串，上限 100 条），点结果进入该文件所在目录。
6. **聊天记录联动**：聊天记录中文件变更面板（`FileChangePanel`）的文件路径可点击，直接打开该文件预览；已删除（delete）的变更给"文件已删除，无法预览"提示。
7. **安全与留痕**：所有浏览被限制在会话工作区之内（复用 `StrictPathResolver`）；鉴权复用 `session:read` 权限码，不新增权限码；审计由既有全局 `onResponse` 钩子承担（`/v1/admin` 前缀全量自动留痕），本方案零显式审计代码（D7）。

### 2.2 非目标（明确不做）

- **不做任何写操作**：上传、删除、重命名、移动、复制、新建文件/目录一律不做。admin 定位是排障查看；写能力桌面端已完整覆盖，且 admin 直接改动用户工作区的风险不可接受。
- **不做 Git 面板**：仓库列表、status、diff、commit/pull/push 等 `workspace-git-*` 能力不接入 admin。
- **不做 LOCAL 会话浏览**：LOCAL 会话工作区在用户桌面本机，服务端文件系统上不存在；只展示路径文本、禁用浏览入口（D4）。
- **不做树形侧边栏**：Dialog 内只用面包屑 + 单层列表，不做桌面端 `FileTree.vue` 那种懒加载树——面包屑方案与后端单层 `listDirectory` 能力对齐，避免深递归在大工作区上的性能与复杂度问题。
- **不做文件编辑 / 不引入 Monaco**：预览一律只读，admin 不引入代码编辑器依赖。
- **不做 WebSocket 实时刷新**：Dialog 打开时拉取一次，提供手动刷新按钮；不订阅文件变更事件。
- **不做回收站 / 快照 / 回滚**：本期完全不涉及写路径。
- **不扩展图片格式支持**：沿用后端 `ImageFileSupport` 现有格式判定（含大小上限），不新增 HEIC/EXIF 等处理。
- **不加权限码、不动角色体系、零 DDL、零新依赖**。

## 3. 范围界定

### 3.1 做什么

| 层 | 内容 |
|---|---|
| backend-ts（新） | `src/session/admin-session-files.routes.ts`：6 个只读端点（directory/search/read/preview/download/download-zip），挂 `/v1/admin/sessions/:id/files/` 前缀 |
| backend-ts（改） | `src/create-app.ts`：注册新路由并注入 `workspaceBrowseService`（不注入 `auditService`，D7） |
| backend-ts（新） | `src/session/admin-session-files.routes.spec.ts`：权限/模式/越界/正常路径单测 |
| admin（新） | `src/views/session/composables/useWorkspaceFiles.ts`：6 个端点的请求封装 + 目录导航/搜索/预览状态机 |
| admin（新） | `src/views/session/components/WorkspaceFileDialog.vue`：全屏 Dialog（面包屑 + 列表 + 搜索 + 下载 + 四格式预览） |
| admin（新） | `src/views/session/utils/file-format.ts`：`formatSize` / `formatTime` 纯函数（规则对齐桌面端 `utils/file-manager.ts`） |
| admin（改） | `src/views/session/SessionDetailView.vue`：信息卡"工作区"行（路径 + 复制 + 入口按钮）、Dialog 挂载与状态、接收文件变更面板的预览联动 |
| admin（改） | `src/views/session/components/FileChangePanel.vue` + `MessageGroup.vue`：文件路径可点击，事件透传到详情页 |
| admin（复用，零改） | `api` 实例（`src/api/index.ts`，目录/搜索/读取等 JSON 请求）、`utils/download.ts`（`downloadBlob`）、`utils/workspace-path.ts`（`toRelativeWorkspacePath`）、`views/session/composables/useMarkdown.ts`（Markdown 渲染） |
| 文档 | CHANGELOG.md、skills/mao-cli/SKILL.md（管理后台手册）、README.md（若列 admin 功能清单则补） |

### 3.2 不做什么

- 不改 `file.routes.ts` 任何现有端点与 `requireOwnedSession` 属主校验——用户侧安全模型零变化。
- 不改 `WorkspaceBrowseService`、`StrictPathResolver` 任何逻辑——纯复用。
- 不改桌面端任何文件 UI / provider / Electron 主进程。
- 不新增权限码、错误码、数据库迁移、npm 依赖。
- 不新增 Playwright E2E 用例：文件 Dialog 属重交互组件，以手工验证 + 构建通过覆盖；admin 既有 E2E（`tests/admin.spec.ts`）回归不受影响。

## 4. 关键决策（需求共识）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 后端接入方式 | 新增 admin 作用域只读端点族 `GET /v1/admin/sessions/:id/files/*`，复用 `WorkspaceBrowseService`；鉴权只校验 `session:read` + 会话存在，**不做出属主校验**（admin 查看任意用户会话是本职）；`/v1/files/workspace-*` 现有安全模型不动 |
| D2 | 功能范围 | 只读 + 预览 + 下载 + 搜索；写操作与 Git 面板明确不做 |
| D3 | UI 载体 | 信息卡"工作区"行（路径省略 + 复制）+ "查看文件"按钮 → 全屏 `el-dialog` 承载文件浏览器（面包屑 + 单层列表）；不改双栏布局、不加第三栏、不改 tab 结构 |
| D4 | LOCAL 会话 | 有路径的会话都展示"工作区"行；仅 CLOUD 渲染可点入口，LOCAL 显示禁用态按钮 + 提示"本地执行会话的文件在用户设备上，服务端不可见"；后端对 LOCAL 同样返回明确错误（双保险） |
| D5 | 预览格式 | 文本（`<pre>` 等宽 + 截断提示）、图片（`<img>`）、PDF（`<iframe>` inline）、Markdown（渲染/源码双态）；其余格式统一"暂不支持预览，请下载后查看" |
| D6 | 聊天记录联动 | `FileChangePanel` 路径可点击，直接打开该文件预览；delete 变更提示"文件已删除，无法预览" |
| D7 | 审计范围 | 零显式审计代码：`/v1/admin` 前缀已被全局 `onResponse` 钩子全量审计（action=READ、objectType=admin.sessions、objectId=会话 id、queryString 含 path/dir、操作人/IP/状态码），下载天然留痕；不叠加显式 `record()`（避免重复行、保持平台一致） |

## 5. 技术选型与详细设计

### 5.1 技术选型

| 维度 | 选型 | 理由 |
|---|---|---|
| 后端路由归属 | `session` 域新文件 `admin-session-files.routes.ts` | 与 `admin-session.routes.ts` 同族同前缀，共享 `requireRead` 鉴权模式；不放 `file` 域（那边是用户侧属主模型，混入会模糊边界） |
| 浏览能力 | 复用 `WorkspaceBrowseService`，零改动 | 目录/搜索/读取/图片/PDF/zip 全部就绪，`StrictPathResolver` 越界收口已在用户侧上线验证；admin 与用户侧共用同一套安全内核 |
| 鉴权 | `requireRequestPermission(permissionService, request, 'session:read')` | 与详情页现有鉴权一致，不新增权限码 |
| 审计 | 零显式审计代码，依赖既有全局 `onResponse` 钩子 | `/v1/admin` 前缀被钩子全量自动留痕（`audit.interceptor.ts` 的 `AUDITED_PREFIXES`），下载天然有迹；显式 `record()` 只用于钩子之外的场景（如云端终端），为文件端点叠加会产生重复行 |
| 前端载体 | Element Plus `el-dialog`（fullscreen）+ 表格风格列表 | admin 全站 Element Plus，零新依赖；`UserDetailDrawer` / `ScheduledTaskDetailDialog` 已有弹层先例。文件浏览器桌面端也需全屏，故不用 `components/ResponsiveDialog.vue`（其 fullscreen 仅移动端生效，显式 `fullscreen` 会被其内部 prop 覆盖） |
| 前端状态 | 新增 `useWorkspaceFiles.ts` composable | 目录导航、搜索、预览、加载/错误状态集中管理；请求仍走全局 `api` 实例，与 admin 现有风格（页面直调 `api`）兼容 |
| Markdown 渲染 | 复用 `views/session/composables/useMarkdown.ts` | 聊天记录已在用，零新增依赖 |
| 复制路径 | `navigator.clipboard.writeText` + `execCommand` 兜底 | 参照 `utils/codeCopy.ts` 的降级写法，在 composable 内实现小函数 |

### 5.2 后端设计

#### 5.2.1 端点清单

统一前缀 `/v1/admin/sessions/:id/files`，均需 `session:read`：

| 方法 | 路径 | 参数 | 响应 | 对应 service 方法 |
|---|---|---|---|---|
| GET | `/directory` | `dir?`（工作区内相对路径，空 = 根） | `{ entries: DirectoryEntryDTO[], truncated }` | `listDirectory` |
| GET | `/search` | `pattern`（必填，≤100 字符）、`limit?`（默认 100，上限 100） | `{ entries, truncated }` | `searchFiles` |
| GET | `/read` | `path`（必填）、`offset?`（默认 0）、`limit?`（默认 5000，上限 5000） | `FileContentDTO`（文本或图片 data_uri） | `readFile` |
| GET | `/preview` | `path`（必填，须 `.pdf` 结尾） | PDF 字节流（inline） | `readPdfFile` |
| GET | `/download` | `path`（必填） | 文件字节流（attachment） | `downloadFile` |
| GET | `/download-zip` | `path?`（工作区内相对目录，空 = 整个工作区） | zip 流（attachment，上限 1GB） | `zipDirectory` |

参数解析沿用 `file.routes.ts` 同款工具（`queryOptStr` / `queryOptInt` / `pathId`），流式响应沿用其 `sendFile` / `Content-Disposition` 写法。

#### 5.2.2 会话解析与守卫

```ts
async function requireBrowsableSession(sessionId: number): Promise<Session> {
  const session = await sessionService.getSession(sessionId); // 不存在抛 SESSION_NOT_FOUND
  if (session.workspace == null || session.workspace.trim().length === 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '会话未配置工作区');
  }
  if (session.executionMode === 'LOCAL') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '本地执行会话的工作区在用户设备上，服务端不可浏览');
  }
  return session;
}
```

与 `file.routes.ts` 的 `requireCloudWorkspace`（L43-48）同口径拒 LOCAL；差异点：不做 `session.userId` 属主校验（D1）。通道会话（飞书/钉钉，工作区在 `{wsRoot}/feishu-chat/{accountId}/{leaf}` 等路径）天然放行——这正好绕开用户侧群共享工作区 403 的限制。

#### 5.2.3 审计（零显式代码，D7）

全局 `onResponse` 钩子（`create-app.ts` L641-654）已覆盖本方案全部端点：`shouldAudit` 对 `/v1/admin` 前缀返回 true（`audit.interceptor.ts` 的 `AUDITED_PREFIXES`，不限请求方法），每次请求自动落一条 `audit_log`：

- `action` = `READ`（GET）；`objectType` = `admin.sessions`；`objectId` = 路径中首个数字段（会话 id）；
- `queryString` 含 `path` / `dir` 参数（上限 1024 字符截断），即"谁、在什么时候、看了哪个会话的哪个文件"完整可查；
- `userId` / `username` / `ip` / `status` / `success` 一并记录。

因此本方案**不注入 `auditService`、不写任何显式 `record()`**：下载动作天然留痕，且列表/预览/搜索与平台其他 admin 接口的审计口径一致；显式叠加只会产生重复行。

#### 5.2.4 错误语义

| 场景 | 错误码 | 消息 |
|---|---|---|
| 无 `session:read` | 403 | 无权限: session:read |
| 会话不存在 | SESSION_NOT_FOUND | （现有消息） |
| workspace 为空 | PARAM_INVALID | 会话未配置工作区 |
| LOCAL 会话 | PARAM_INVALID | 本地执行会话的工作区在用户设备上，服务端不可浏览 |
| 目录不存在 / 不是目录 | PARAM_INVALID | 目录不存在 / 不是目录（service 透传） |
| 路径越界 / 符号链接逃逸 | FORBIDDEN | 路径访问被拒绝（service 透传） |
| 二进制文件预览 | PARAM_INVALID | 二进制文件，无法预览 |
| zip 超 1GB | PARAM_INVALID | 目录过大（x.x GB），请选择子目录下载 |

### 5.3 前端设计

#### 5.3.1 信息卡"工作区"行（`SessionDetailView.vue`）

在"项目"行之后插入（L83 后）：

```
工作区 | /opt/mao-data/workspace/123/929  [复制] [查看文件]
```

- 路径超长省略显示，`title` 属性给全路径；复制按钮调 `navigator.clipboard`（`execCommand` 兜底）。
- "查看文件"按钮：`sessionInfo.executionMode === 'CLOUD' && sessionInfo.workspace` 时可点；否则 `disabled` + `el-tooltip` 说明原因（LOCAL 提示"文件在用户设备上，服务端不可见"；无路径提示"会话未配置工作区"）。
- 无 workspace 时整行显示 `-`，不给按钮。

#### 5.3.2 `WorkspaceFileDialog.vue`（全屏 Dialog）

```
┌──────────────────────────────────────────────────────────────┐
│ 工作区文件 · 会话 #929        [搜索…] [刷新] [下载目录 zip]      │
│ 工作区 / src / components                                    │
├──────────────────────────────────────────────────────────────┤
│ 名称            大小        修改时间                           │
│ 📁 src          —          2026-10-15 17:22                 │
│ 📄 README.md    2.1 KB     2026-10-15 17:22    [预览][下载]   │
│ …（truncated 时底部提示"仅显示前 500 条，请进入子目录查看"）     │
├──────────────────────────────────────────────────────────────┤
│ 预览面板（点文件后展开，可关闭）：                               │
│  文本：<pre> + "仅显示前 N 行 / 共 M 行"                       │
│  图片：<img :src="data_uri"> + 后端摘要（mime/大小/宽高）        │
│  PDF：<iframe :src="blobUrl">                                │
│  .md ：[渲染态 | 源码] 切换（复用 useMarkdown）                 │
│  其他："暂不支持预览，请下载后查看" + [下载] 按钮                 │
└──────────────────────────────────────────────────────────────┘
```

- 面包屑段可点击回跳；组件内维护 `currentDir` 相对路径（`''` = 工作区根）。
- 目录行点击进入子目录；文件行点击打开预览面板。
- 大小/时间格式化用 `views/session/utils/file-format.ts`（规则对齐桌面端：B/KB/MB/GB，≥100 取整；`YYYY-MM-DD HH:mm`）。
- 下载：单文件与 zip 一律走带 `Authorization: Bearer` header 的裸 `fetch`，拿到 blob 后交 `utils/download.ts` 的 `downloadBlob` 落地。不走 axios：`api` 默认 30s 超时会掐断大 zip（先全量打包再吐字节，nginx `/api/` 的 `proxy_read_timeout` 为 300s，桌面端同样用裸 fetch）；且 axios `responseType:'blob'` 的错误体是 Blob，拦截器只能弹通用"请求失败"，§5.5 承诺的明确错误会丢失——裸 fetch 下按桌面端 `extractDownloadError` 模式解析（blob→JSON→message）。zip 文件名优先解析 `Content-Disposition` 的 `filename*=UTF-8''`（对齐桌面端 `parseDownloadFileName`），失败退回当前目录名；单文件退回条目名。
- 搜索：输入防抖 300ms 调 `/files/search`，空 pattern 前端短路不发请求（避免后端 400 的 toast 噪音）；结果行显示完整相对路径，点击进入该文件所在目录（不做选中高亮）。
- 空态：`/directory` 返回"目录不存在"时展示"工作区目录不存在或已被清理"。

#### 5.3.3 `useWorkspaceFiles.ts` 状态机

```ts
interface WorkspaceFilesState {
  sessionId: number
  currentDir: string                                        // 相对路径，'' = 工作区根
  entries: DirectoryEntryDTO[]                              // 类型在 admin 侧复刻声明（DTO 暂不在 @mao/contracts，与 admin 现状一致；后续桌面/admin 共用可下沉，见 §11）
  truncated: boolean
  loading: boolean
  search: { pattern: string; entries: DirectoryEntryDTO[]; truncated: boolean } | null
  preview: {
    path: string
    loading: boolean
    error: string | null
    data: FileContentDTO | null                             // 文本/图片
    pdfUrl: string | null                                   // PDF blob URL（关闭时 revoke）
  } | null
}
```

方法：`open(sessionId)` / `enterDir(rel)` / `navigateTo(rel)` / `search(pattern)` / `previewFile(rel)` / `closePreview()` / `downloadFile(rel)` / `downloadZip(rel)` / `refresh()`。PDF 预览与文件下载统一走带 `Authorization: Bearer` header 的裸 `fetch` 取 blob（axios 的 30s 默认超时与 blob 错误体不可读两个原因都不适用字节流，做法参照桌面端 `workspace-file-provider.ts` L254-272/L364-393）；错误响应按 `extractDownloadError` 模式解析出后端 message；PDF blob URL 在 `closePreview`/ Dialog 关闭时 `revokeObjectURL`。

#### 5.3.4 聊天记录联动（D6）

- `FileChangePanel.vue`：文件路径从纯文本改为可点击元素（点击样式 + `role="button"`），点击 `emit('preview', relativePath)`；`relativePath` 用组件内已有的 `toRelativeWorkspacePath(workspace, change.path)` 计算，workspace 缺失或路径不在会话工作区内（函数原样返回绝对路径）时该行不可点。
- 变更类型为 delete 时同样发事件、不拦截：DELETED 只代表该轮结束时的状态，文件可能在后轮被重建（前轮 DELETED 行仍会在面板里），一律提示"已删除，无法预览"会误报；放行后由后端"文件不存在"错误决定文案（如"文件当前不存在（该轮记录为删除）"）。
- `MessageGroup.vue`：透传 `preview` 事件到 `SessionDetailView.vue`。
- `SessionDetailView.vue`：收到事件后先守卫生成条件——`executionMode === 'CLOUD' && workspace` 非空才打开 `WorkspaceFileDialog` 并直接进入该文件预览态（`previewFile(relativePath)`），用户无需手动导航；LOCAL / 无 workspace 会话的变更路径在用户设备上，toast"本地执行会话的文件在用户设备上，服务端不可见"。

### 5.4 安全设计

1. **根收口**：所有文件操作经 `WorkspaceBrowseService.resolvePath` → `StrictPathResolver(sessionWorkspace)`：相对穿越（`../`）、越界绝对路径、符号链接逃逸一律 `FORBIDDEN`（service L411-423；用户侧已上线，admin 复用同内核）。
2. **鉴权**：`session:read` 权限码 + JWT 身份，与详情页一致。不做出属主校验是有意设计（admin 跨用户查看是本职），门槛由权限码把守。
3. **敏感文件**：admin 可下载 `.env`、密钥等敏感文件——接受：admin 本是平台最高权限角色，且下载有审计留迹；接口层不做文件类型黑名单。
4. **资源上限**：目录 500 条/层、搜索 100 条（遍历 ≤2000 目录 / 12 层深）、文本 5000 行 / 512KB、图片 5MB（`ImageFileSupport.MAX_IMAGE_BYTES`）、zip 1GB——全部沿用 service 现有上限，admin 侧不放大。
5. **审计**：全部动作（含下载）由全局 `onResponse` 钩子留痕（§5.2.3）；审计页可按 `objectType=admin.sessions` 过滤，`path` 列/详情可核对 `files/*` 具体路径与 `path`/`dir` 参数（`/v1/audit/logs` 与审计页暂不支持按 path 过滤，见 §11）。

### 5.5 边界与降级

| 边界 | 行为 |
|---|---|
| workspace 为 null | 信息卡显示 `-`，无入口按钮 |
| LOCAL 会话 | 入口禁用 + tooltip；后端双保险返回明确错误 |
| 工作区目录已被清理 | `/directory` 返回"目录不存在"，Dialog 空态提示"工作区目录不存在或已被清理" |
| 目录超 500 条 | `truncated=true`，列表底部提示进入子目录查看 |
| 二进制 / 超大文件 | 预览区展示后端错误消息 + 下载按钮兜底 |
| 符号链接条目 | `listDirectory` 对 symlink-to-dir 返回 `isDirectory=false, isSymlink=true`；列表标注链接标识并禁用进入/预览（service 对 symlink 一律拒绝），对齐桌面端 `iconKindOf` 的 link 态 |
| 变更路径不在工作区内 / 会话无 workspace | 变更行不可点或提示"文件不在会话工作区内"；LOCAL 会话 toast"文件在用户设备上，服务端不可见"（§5.3.4） |
| zip 超 1GB | 明确错误"目录过大（x.x GB），请选择子目录下载" |
| 通道会话（飞书/钉钉群） | 正常浏览（admin 不做出属主校验，绕开用户侧群共享 403） |
| 移动端（≤768px） | Dialog fullscreen 天然适配；"工作区"行随信息卡折叠态隐藏（与现有 `infoExpanded` 逻辑一致） |

## 6. 实现步骤

1. **后端端点**：新建 `admin-session-files.routes.ts`（6 端点 + `requireBrowsableSession`）；`create-app.ts` L2819 附近注册，注入已构造的 `workspaceBrowse`（L812）；**不注入 `auditService`**（D7，全局钩子已留痕）。
2. **后端单测**：`admin-session-files.routes.spec.ts`（用例见 §8）。
3. **后端验证**：`cd backend-ts && npm run build`，`npm test > /tmp/x.log 2>&1` 后 grep 摘要。
4. **前端 composable**：`useWorkspaceFiles.ts`（请求封装 + 状态机）。
5. **前端 Dialog**：`WorkspaceFileDialog.vue`（面包屑/列表/搜索/下载/四格式预览）+ `utils/file-format.ts`。
6. **详情页入口**：`SessionDetailView.vue` 信息卡"工作区"行 + 入口按钮 + Dialog 挂载。
7. **联动**：`FileChangePanel.vue` + `MessageGroup.vue` 路径点击透传。
8. **前端验证**：`cd admin && npm run build`（`vue-tsc -b && vite build`；禁止用 `npx vue-tsc --noEmit` 假通过）。
9. **手工验证**：CLOUD 会话浏览/预览（四格式）/下载/搜索；LOCAL 禁用态；空 workspace；`../` 越界参数；大目录 zip 下载（验证裸 fetch 无 30s 掐断、"目录过大"明确错误可读）；审计页按 `objectType=admin.sessions` 过滤可见 `/v1/admin/sessions/:id/files/*` 的 READ 记录（path 列与详情含 path/dir 参数；审计页不支持按 path 过滤）。
10. **文档**：CHANGELOG（admin 小节）、skills/mao-cli、README（如需）。
11. **部署**：后端 `/opt/mao` pull + `restart-backend.sh`；admin `bash scripts/deploy-admin.sh`（rsync 静态资源，无需重启）。

## 7. 风险与开放问题

1. **admin 越权查看的合规边界**：不出属主校验意味着任何持 `session:read` 的运营账号可下载任意用户工作区文件（含密钥）。缓解：权限码门槛 + 全局审计钩子对所有 admin 文件请求留痕（§5.2.3）。若后续要更细粒度（按用户/项目授权），另立方案，本期不做。
2. **大工作区 zip 的资源占用**：`zipDirectory` 先落临时 zip 再流式下发（1GB 上限），依赖 tmpdir 空间；沿用桌面端现有行为，不新增处理。
3. **搜索性能**：有界遍历（2000 目录 / 12 层深），超大 monorepo 可能 `truncated`——结果中给"结果过多已截断"提示即可，不优化。
4. **会话删除后**：删会话不删用户项目工作区文件（`deleteSession` 只清 runtime 残留），但 admin 按会话 id 访问，会话不存在即 404，无孤儿入口问题。
5. **PDF inline 的响应头**：复用 `readPdfFile` + `sendFile(inline)`，与用户侧 `workspace-preview` 完全一致，无新风险。

## 8. 测试要点

后端单测（Vitest，`admin-session-files.routes.spec.ts`，参照 `file.routes.spec.ts` 模式）：

- 无 `session:read` → 403
- 会话不存在 → SESSION_NOT_FOUND
- workspace 空 / LOCAL 会话 → PARAM_INVALID 且消息明确
- directory：根目录、子目录、不存在目录、`../` 越界 → FORBIDDEN
- read：文本文件（content/total_lines）、图片（media_type=image + data_uri）、二进制 → 明确错误
- search：命中、空 pattern 拒绝、limit 夹取到 100
- download / download-zip：正常流 + 越界拒绝；**download-zip 的 `path` 缺省 = 整个工作区**（service `normalizeRelativeDir` 将 null 归一为 `.`）；审计由全局钩子承担，本方案零显式 `record()`，不新增审计断言（全局钩子为既有行为，`file.routes.spec.ts` 模式同样不覆盖 `onResponse`）
- **属主是他人时正常返回**（验证 D1：不做出属主校验）
- read：图片超 `ImageFileSupport.MAX_IMAGE_BYTES`（5MB）→ 明确"文件过大"错误（订正原文"10MB"表述，见 §11）

前端：

- 不新增单测（admin 现有 session 视图无 spec 先例）；`npm run build` 必须通过。
- 不新增 Playwright 用例；既有 admin E2E 回归不受影响。

## 9. 变更落点清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `backend-ts/src/session/admin-session-files.routes.ts` | 新增 | 6 只读端点 + 会话守卫 |
| `backend-ts/src/session/admin-session-files.routes.spec.ts` | 新增 | 单测（§8） |
| `backend-ts/src/create-app.ts` | 改 | L2819 附近注册新路由，注入 `workspaceBrowse`（L812 已构造）；不注入 `auditService` |
| `admin/src/views/session/composables/useWorkspaceFiles.ts` | 新增 | 请求封装 + 状态机 |
| `admin/src/views/session/components/WorkspaceFileDialog.vue` | 新增 | 全屏 Dialog 文件浏览器 |
| `admin/src/views/session/utils/file-format.ts` | 新增 | formatSize / formatTime 纯函数 |
| `admin/src/views/session/components/FileChangePanel.vue` | 改 | 路径可点击，emit preview |
| `admin/src/views/session/components/MessageGroup.vue` | 改 | 透传 preview 事件 |
| `admin/src/views/session/SessionDetailView.vue` | 改 | 信息卡"工作区"行 + 入口按钮 + Dialog 状态 + 联动处理 |
| `CHANGELOG.md` | 改 | 顶部新版本条目，admin 小节 |
| `skills/mao-cli/SKILL.md` | 改 | 管理后台手册同步新功能 |
| `README.md` | 改（如需） | 若列有 admin 功能清单则补充 |

## 10. 发版前检查

- [ ] CHANGELOG 顶部 `## x.y.z (日期)` 已写（admin 小节：会话详情支持查看工作区目录与文件）
- [ ] `skills/mao-cli/SKILL.md` 管理后台部分已同步
- [ ] README / DEPLOY 如有 admin 功能描述已同步
- [ ] `backend-ts` build + test 通过（输出落盘，grep Test Files/Tests/FAIL 摘要）
- [ ] `admin` `npm run build` 通过（`vue-tsc -b && vite build`）
- [ ] 后端 `/opt/mao` pull + `restart-backend.sh`；admin `bash scripts/deploy-admin.sh`

## 11. 评审记录（2026-10-16）

**评审结论：需求与方案均可行**，可进入实施；实施前先落本记录中的修订（已就地并入上述章节）。

### 11.1 已逐项核对通过的关键事实（评审依据）

- 后端能力底座：`WorkspaceBrowseService` 六方法签名与上限（500 条/层、搜索 100 条/2000 目录/12 层、文本 5000 行/512KB、图片 5MB、zip 1GB）与 `resolvePath` → `StrictPathResolver` 越界收口（`workspace-browse.service.ts` L16-26、L411-423）；`zipDirectory(null)` 归一为整个工作区，admin `download-zip` 的 `path` 可选成立。
- 用户侧安全模型：`file.routes.ts` L43-48（`requireCloudWorkspace`）、L50-59（`requireOwnedSession`）、L113-190（`/v1/files/workspace-*`）与方案描述一致，本方案零改动。
- admin 接入模式：`admin-session.routes.ts` 的 `requireRead` = `requireRequestPermission(permissionService, request, 'session:read')`；注册点 `create-app.ts` L2820、`workspaceBrowse` 构造点 L812 均如方案所述。
- 审计：全局 `onResponse` 钩子（`create-app.ts` L641-653）中 `AUDITED_PREFIXES` 含 `/v1/admin` 且不限请求方法；`objectType` 推导为 `admin.sessions`、`objectId` 取路径首个数字段、`queryString` 入库且仅脱敏 token 类参数（`path`/`dir` 原样保留）——D7 零显式审计代码成立。
- 前端可复用件：`api` 实例、`downloadBlob`、`toRelativeWorkspacePath`、`useMarkdown`、`codeCopy` 降级写法均存在且如描述；`MessageGroup` 仅 `SessionDetailView` 使用（事件链简单）；`FileChangePanel` 已收 `workspace` prop；compact 模式摘要查询带 `file_path`（D6 在详情页 `compact=true` 下成立）。
- 桌面端参照物：`formatSize`/`formatTime` 规则、fetch + Authorization、`extractDownloadError`、`parseDownloadFileName`、`FileTree.vue`/`FileManagerPanel.vue`/`FileViewer.vue` 均存在。
- 需求侧：只读排障定位与 admin 角色匹配、不动用户侧安全模型、无新权限码/DDL/依赖，工作量与风险可控；LOCAL 不可浏览有服务端双保险。

### 11.2 事实更正（原文有误，已就地改正）

1. **图片预览上限为 5MB**（`ImageFileSupport.MAX_IMAGE_BYTES`），§5.4.4 原写"10MB"已订正。
2. **审计页不支持按 path 检索**：`/v1/audit/logs` 仅接受 userId/action/objectType/success/起止日期，`AuditLogView` 过滤器相同；`path` 只在列表列与详情可见。§5.4.5 已改为"按 objectType 过滤 + path 列核对"；按 path 过滤需扩展 audit 查询与前端过滤器，列后续增强，本期不做。
3. §1"详情页没有消费 workspace"已过时：详情页已将其传给 `FileChangePanel` 做相对路径展示（L110），缺的只是浏览入口，已订正。

### 11.3 补充完善（已并入对应章节）

1. **字节流请求一律裸 fetch、不走 axios**（§5.3.2/§5.3.3）：`api` 默认 timeout 30s（`api/index.ts` L16），小于 nginx `/api/` 的 `proxy_read_timeout 300s`，大 zip（先全量打包再吐字节）必被 axios 掐断；且 axios `responseType:'blob'` 的错误体是 Blob，拦截器只能弹"请求失败"，§5.5 承诺的"目录过大（x.x GB）"等明确错误会丢失。桌面端对这两个端点都用裸 fetch + `extractDownloadError`，admin 对齐；JSON 请求仍走 `api`。
2. **D6 联动护栏**（§5.3.4/§5.5）：delete 变更不一律拒预览（DELETED 只是该轮状态、后轮可能重建，拒预览会误报）；LOCAL/无 workspace 会话需先判 `CLOUD + workspace` 再开 Dialog；相对化失败（路径不在工作区内）时该行不可点或明确提示。
3. **符号链接条目**（§5.5）：symlink-to-dir 在列表里 `isDirectory=false`，点它会当文件预览并被 service 拒绝，需标识并禁用进入/预览。
4. **zip 下载文件名**（§5.3.2）：从 `Content-Disposition` 的 `filename*=UTF-8''` 解析（对齐桌面端 `parseDownloadFileName`），失败退回当前目录名，避免中文/特殊字符目录名乱码。
5. **弹层选型说明**（§5.1）：桌面端也需全屏，故用裸 `el-dialog(fullscreen)` 而非 `ResponsiveDialog`（其 fullscreen 仅移动端生效）。
6. **前端小节流**（§5.3.2）：搜索框空 pattern 不发请求，避免后端 400 toast。
7. **DTO 声明**（§5.3.3）：`DirectoryEntryDTO` 等暂不在 `@mao/contracts`，admin 侧复刻与现状一致；后续桌面/admin 共用时可下沉。
8. **测试补充**（§8/§6）：download-zip `path` 缺省用例；图片超 5MB 错误用例；手工验证的审计确认改为"按 objectType 过滤可见 READ 记录"。

### 11.4 实施后修订（2026-10-16，与上述章节不一致处以本节为准）

1. **Dialog 不再全屏**：按产品反馈改为常规弹窗（宽 1080px、`top: 6vh`、最高 88vh，≤768px 拉满视口宽度）。§5.1/§5.3.2/§5.5/D3 中"全屏 `el-dialog`"的表述作废；表格与预览区改为各自滚动、面包屑固定，图片/PDF 高度随弹窗收敛。
2. **JSON 与字节流端点的 base 归属**（§5.3.3）：`api` 实例自带 `baseURL`，且 axios 只豁免 `http(s)://` 绝对 URL、`/` 开头路径一样会被拼 base——JSON 端点必须传**不含** base 的相对路径，仅裸 fetch 的字节流端点自带完整 base。最初两者都拼 base，导致请求 `/api/v1/api/v1/...` 404 并被误报为"工作区目录不存在或已被清理"。
3. **预览状态机的身份比较**（§5.3.3）：普通对象赋进 reactive 的 `state.preview` 后是代理，`state.preview === preview` 恒 false；判断"预览目标是否已切换"必须用 `toRaw`，否则请求结果被一律丢弃、预览永远停在"加载中…"。
