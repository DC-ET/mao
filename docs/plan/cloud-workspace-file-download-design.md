# 云端工作区文件下载 — 技术方案

> 状态：已与需求方逐项确认，待评审后实施
> 版本：0.1（2026-08-05）

## 一、需求背景

客户端右侧任务面板的「文件」Tab（`desktop/src/components/file-browser/FileTree.vue`）展示当前工作区的目录与文件树。目前该 Tab 在**远程云端工作区（CLOUD 模式）**下仅支持目录浏览、文本预览、复制路径、添加到聊天，**无法把工作区文件拿到本地**。用户需要将云端工作区中的文件（如 Agent 生成的项目源码、文档、构建产物）下载到自己的电脑上。

现状相关事实（已核实）：

- 文件树组件：`desktop/src/components/file-browser/FileTree.vue`，挂在 `desktop/src/components/task/TaskInspector.vue` 的「文件」页签下。
- 右键菜单：`desktop/src/components/file-browser/FileTreeContextMenu.vue`，现有菜单项为「复制绝对路径 / 复制相对路径 / 在 Finder 中打开 / 添加到聊天」；其中「复制绝对路径」「在 Finder 中打开」仅在非 CLOUD 模式显示（`showLocalActions = executionMode !== 'CLOUD'`）。
- 云端文件数据通道：CLOUD 模式下 `createCloudProvider`（`desktop/src/composables/workspace-file-provider.ts`）调用后端 `GET /api/v1/files/workspace-directory`（目录列表）与 `GET /api/v1/files/workspace-read`（文本预览，上限 5000 行 / 512KB，不支持二进制）。
- 后端已有安全基建：`FileController.requireOwnedSession`（会话归属校验）+ `PathSandbox.resolve`（路径沙箱，防目录逃逸）。
- 现有 `GET /api/v1/files/{id}/download` 仅针对上传到 OSS 的附件（`FileEntity`），与本需求（工作区任意文件）无关，不可复用。
- 前端无任何下载实现；Electron 无保存对话框 IPC；admin 端无文件树，无需改动。

## 二、需求描述

### 2.1 做

| # | 需求点 | 说明 |
|---|--------|------|
| 1 | CLOUD 模式下，文件节点右键菜单新增「下载此文件」 | 仅 `executionMode === 'CLOUD'` 时显示；LOCAL 模式不显示（本地文件本就可见，无需求） |
| 2 | CLOUD 模式下，目录节点右键菜单新增「下载此目录」 | 服务端打包 zip 后下载 |
| 3 | 单文件下载走原始字节流 | 不受文本预览 5000 行 / 512KB 限制，二进制文件（图片、zip、jar 等）均可下载 |
| 4 | 目录打包为 zip | 递归打包所选目录内**全部内容**（含 `.git`、`node_modules`、`dist`、`target` 等，与文件树可见范围一致） |
| 5 | 目录 zip 大小上限 1GB | 打包前先递归统计总大小，超过 1GB 直接拒绝并提示「目录过大，请选择子目录下载」；单文件无硬性大小限制 |
| 6 | 浏览器式直接下载 | 前端 `fetch`（携带 Bearer token）→ `blob` → `<a download>` 触发浏览器下载；Electron / Web / 安卓三端走同一逻辑 |
| 7 | 下载过程反馈 | 开始下载提示、完成提示、失败提示（ElMessage） |
| 8 | 权限与安全 | 复用 `requireOwnedSession` 会话归属校验 + `PathSandbox` 路径沙箱；目录打包遍历时跳过符号链接，防逃逸与 zip 炸弹 |

### 2.2 不做

| # | 不做项 | 原因 |
|---|--------|------|
| 1 | LOCAL 模式下提供下载菜单 | 本地文件本就在用户磁盘上，无需求 |
| 2 | Electron 原生保存对话框（`showSaveDialog` IPC） | 浏览器式下载已完整覆盖需求；原生保存对话框属体验增强，留待后续 |
| 3 | 大文件流式落盘下载 | 单文件采用 `fetch + blob` 全量进内存；数百 MB 以上超大文件可能受浏览器内存限制。本期不做 Electron 原生下载器流式落盘 |
| 4 | 下载进度条 | 浏览器原生下载由 Chromium 接管，前端不展示进度 |
| 5 | 目录 zip 排除规则 / 压缩级别配置 | 明确包含全部内容、默认压缩级别，不做可配置项 |
| 6 | 断点续传 / 分片下载 | 无此需求 |
| 7 | 下载历史 / 任务中心 | 无此需求 |
| 8 | 安卓 WebView 下载特化 | 安卓 WebView 对 `blob:` + `<a download>` 支持有限，本期不特化处理；主场景为桌面端（Electron / Web） |
| 9 | 管理后台（admin）改动 | 管理后台无文件树功能 |

## 三、技术选型

| 决策点 | 选型 | 理由 |
|--------|------|------|
| 单文件下载接口 | `GET /api/v1/files/workspace-download`，返回原始字节流 + `Content-Disposition: attachment` | 与现有 `workspace-directory` / `workspace-read` 同风格；直接复用 `requireOwnedSession` + `PathSandbox` |
| 目录下载接口 | `GET /api/v1/files/workspace-download-zip`，服务端临时打包 zip 后流式输出 | 1GB 上限内先落盘临时文件再响应，失败可清理；响应后删除临时文件 |
| zip 大小控制 | 打包前 `Files.walk` 统计字节数，>1GB 直接拒绝 | 避免先打包再超限，浪费磁盘与时间 |
| zip 遍历安全 | `Files.walk` + 跳过符号链接 | 符号链接可能指向沙箱外，跳过可防逃逸与 zip 膨胀 |
| 前端下载方式 | `fetch` + `Response.blob()` + `<a download>` | 认证依赖 `Authorization: Bearer` header，`window.open` / `location.href` 无法携带；`fetch + blob` 是唯一能带 token 且触发浏览器下载的方式 |
| token 获取 | 复用 `utils/auth-storage.ts` 的 `getToken()` | 与 `api/index.ts` 拦截器同一来源 |
| 前端菜单显隐 | `executionMode === 'CLOUD'`（即 `!showLocalActions`） | 与现有菜单显隐逻辑同源，无需新概念 |
| 菜单项文案与图标 | 「下载此文件」（文件）、「下载此目录」（目录），图标 `Download` | Element Plus 内置图标 |
| 前端反馈 | ElMessage：开始 / 成功 / 失败 | 与全站提示风格一致 |
| 目录 zip 命名 | `${目录名}.zip`（相对路径为 `.` 时用工作区目录名） | 直观 |

## 四、实现步骤

### 4.1 后端（`backend/src/main/java/cn/etarch/mao/file/`）

**4.1.1 `WorkspaceBrowseService` 新增两个方法**

1. `DownloadResult downloadFile(String sessionWorkspace, String relativePath)`
   - 复用 `resolvePath`（`PathSandbox.resolve`）校验路径，`sessionWorkspace` 由 controller 从会话取得；
   - 校验存在且为普通文件（`Files.isRegularFile`），否则抛业务异常（404 语义）；
   - 返回 `{ Path path, long size, String fileName }` 供 controller 构造响应。

2. `ZipResult zipDirectory(String sessionWorkspace, String relativeDir)`
   - 解析目录，校验存在且为目录；
   - 递归统计总大小（跳过符号链接），> 1GB（`MAX_ZIP_BYTES = 1024 * 1024 * 1024L`）抛业务异常「目录过大，请选择子目录下载」；
   - 在临时目录（`Files.createTempDirectory` 或工作区外 tmp）生成 zip：
     - `Files.walk` 遍历，跳过符号链接；
     - 相对路径写入 zip 条目（`/` 分隔），根目录名作为 zip 内顶层目录；
     - 压缩级别用默认；
   - 返回 `{ Path zipPath, long size, String fileName }`；controller 响应后必须 `finally` 删除临时文件。

**4.1.2 `FileController` 新增两个接口**

```java
@GetMapping("/workspace-download")
public ResponseEntity<Resource> downloadWorkspaceFile(
        @AuthenticationPrincipal Long userId,
        @RequestParam Long sessionId,
        @RequestParam String path)

@GetMapping("/workspace-download-zip")
public ResponseEntity<Resource> downloadWorkspaceDirectory(
        @AuthenticationPrincipal Long userId,
        @RequestParam Long sessionId,
        @RequestParam String path)
```

- 均先 `requireOwnedSession(userId, sessionId)` 取会话工作区；
- 响应头：
  - `Content-Disposition: attachment; filename="..."`（文件名经 RFC 5987 编码处理中文/特殊字符）；
  - `Content-Type: application/octet-stream`（单文件可按扩展名推断，缺失时回退 octet-stream）；
  - zip 接口固定 `application/zip`；
  - 建议 `Content-Length` 直接给出，便于浏览器显示大小；
- 异常路径沿用现有 `BusinessException` + `Result<T>` 全局处理（保持与现有接口一致）。

**4.1.3 单测（`backend/src/test/`）**

- 下载不存在的文件 / 路径逃逸（`../`）→ 报错；
- 目录 zip 含嵌套目录与文件、含 `.git` 等隐藏目录 → zip 条目完整；
- 符号链接被跳过；
- 超 1GB 目录 → 拒绝且不产出 zip；
- 临时 zip 在响应后删除。

### 4.2 前端（`desktop/src/`）

**4.2.1 `composables/workspace-file-provider.ts`**

- `WorkspaceFileProvider` 接口新增可选方法：
  ```ts
  downloadFile?(relativePath: string): Promise<{ ok: boolean; error?: string }>
  downloadDirectory?(relativePath: string): Promise<{ ok: boolean; error?: string }>
  ```
- `createCloudProvider` 中实现（闭包持有 `numericSessionId`）：
  - 用 `getToken()` 取 token，`fetch` 到 `${apiBase}/files/workspace-download?sessionId=&path=`，`Authorization: Bearer`；
  - 响应非 2xx 时尝试解析错误信息（现有后端错误为 JSON `Result`，需兼容 blob 响应解析）；
  - `blob` → 生成 objectURL → 创建 `<a download="文件名">` 点击 → 释放 objectURL；
  - 返回 `{ ok: true }` 或 `{ ok: false, error }`；
  - 文件名从 `Content-Disposition` 解析，失败时用路径末段。
- `createLocalProvider` 不实现这两个方法（`undefined`），菜单显隐由 `executionMode` 控制，本地不调用。

**4.2.2 `components/file-browser/FileTreeContextMenu.vue`**

- 新增 props：`showDownloadActions?: boolean`（= `executionMode === 'CLOUD'`）、`isDirectory?: boolean`（当前节点是否目录）；
- 新增两个菜单项（置于「添加到聊天」之后、分隔线下）：
  - 目录节点：「下载此目录」→ `$emit('download-directory')`；
  - 文件节点：「下载此文件」→ `$emit('download-file')`；
- 图标 `Download`。

**4.2.3 `components/file-browser/FileTree.vue`**

- `ctxMenu` 增加 `isDirectory` 字段（由 `handleNodeContextmenu` 写入）；
- 给 `FileTreeContextMenu` 传 `:show-download-actions="executionMode === 'CLOUD'"` 与 `:is-directory="ctxMenu.node?.isDirectory ?? false"`；
- 新增 `handleDownloadFile()` / `handleDownloadDirectory()`：
  - 从 `ctxMenu.node.path` 取相对路径；
  - 调 `props.provider.downloadFile / downloadDirectory`；
  - 依据返回结果 ElMessage 提示「开始下载…」「下载完成」/「下载失败：{error}」；
  - 下载中置防重复标志（`downloading` ref），菜单项短暂禁用或忽略重复点击；
  - provider 为 null（会话未就绪）时提示「会话未就绪」。

**4.2.4 类型**

- `types/electron.d.ts` 无改动（未引入 IPC）。

### 4.3 CHANGELOG

- 根 `CHANGELOG.md` 顶部新增版本条目，分节写：
  - `### 后端`：新增工作区文件下载与目录打包 zip 下载接口；
  - `### 前端（桌面 / Web / 安卓）`：CLOUD 模式文件树右键菜单新增「下载此文件 / 下载此目录」。

## 五、落地清单

### 5.1 交付物

| 端 | 文件 | 改动 |
|----|------|------|
| 后端 | `file/service/WorkspaceBrowseService.java` | 新增 `downloadFile` / `zipDirectory`（含 1GB 上限、跳过符号链接、临时 zip 清理） |
| 后端 | `file/controller/FileController.java` | 新增 `/workspace-download`、`/workspace-download-zip` 两个 GET 接口 |
| 后端 | `src/test/` | 新增下载与 zip 单测 |
| 前端 | `composables/workspace-file-provider.ts` | provider 接口 + CLOUD 实现（fetch blob 下载） |
| 前端 | `components/file-browser/FileTreeContextMenu.vue` | 新增两个下载菜单项（CLOUD 显示） |
| 前端 | `components/file-browser/FileTree.vue` | 下载事件处理与反馈 |
| 根目录 | `CHANGELOG.md` | 新增版本条目（后端 + 前端分节） |

### 5.2 验收标准

1. CLOUD 模式会话：文件节点右键显示「下载此文件」，点击后浏览器下载对应文件，内容与服务器一致（含二进制文件）；
2. CLOUD 模式会话：目录节点右键显示「下载此目录」，点击后下载 zip，zip 内含该目录全部内容（含 `.git`、`node_modules`），zip 内顶层为目录名；
3. 目录总大小 > 1GB：提示「目录过大，请选择子目录下载」，不产出 zip；
4. LOCAL 模式会话：右键菜单不出现任何下载项；
5. 未开始对话（无有效 sessionId）：提示「会话未就绪」；
6. 越权访问他人会话 / 路径逃逸（`../`、绝对路径逃出工作区）：返回错误提示，无文件落盘；
7. 下载过程中会话被关闭/服务端异常：前端提示失败，不残留半成品文件；
8. `cd backend && mvn test` 通过；`cd desktop && npm run build` 通过；
9. CHANGELOG 已按分节更新。

### 5.3 部署方式

- 后端：用户重启 Mao 后端服务后生效（**Agent 不执行重启**，重启由用户完成）；
- 前端：`cd desktop && npm run build && cd /opt/mao/desktop && npm run build`，部署 Nginx 后 Web / Electron / 安卓刷新即生效。

## 六、风险与边界

| 风险 | 影响 | 应对 |
|------|------|------|
| 超大单文件（数百 MB+）| `fetch + blob` 全量进内存，浏览器可能卡顿/崩溃 | 本期不做流式落盘（见 2.2 #3）；zip 有 1GB 上限，单文件依赖浏览器能力 |
| 目录打包耗时长（接近 1GB 时）| 接口长时间占用连接，前端 axios 30s 超时 | 下载接口不使用 axios（原生 fetch，无超时限制）；后端打包在请求线程内完成，可接受 |
| zip 内符号链接逃逸 | 可借链接读取沙箱外文件打进 zip | 遍历时跳过符号链接（已列为必须） |
| 文件名中文/特殊字符 | `Content-Disposition` 解析失败、浏览器乱码 | 服务端 RFC 5987 编码；前端解析失败回退路径末段 |
| 安卓 WebView blob 下载不可用 | 安卓端点下载可能无响应 | 本期不特化（2.2 #8）；如反馈强烈，后续在安卓原生侧加下载处理 |
| 临时 zip 残留 | 磁盘占用 | controller `finally` 删除；异常路径同样清理 |
