# 本地任务文件树远程代理技术方案（移动端 / 浏览器查看 LOCAL 会话文件）

- 状态：草案（2026-11-17，待评审；2026-11-17 已按代码逐条核实并修订：事实行号校正、P1 门控与 §4.4 统一为恢复 `!!props.workspace`、D8 预检改为最终整帧 UTF-8 字节、preview/download LOCAL 拒绝改非 2xx、新增 D11 CLI 绑定设备投递、`workspace-list` 纳入分流）；**2026-11-18 已实施落地**（P0 与 P1 同一发布交付，TaskInspector 门控为过程态、未单独提交，最终态恢复 `!!props.workspace`；实施评审修复 containment 在 Windows 盘符 / UNC 工作区下头部拼接丢分隔符导致恒拒的缺陷，并补盘符 / UNC / 根目录退化用例；离线判定收敛到 sendToFileCapableDevice 全存活连接扫描）
- 日期：2026-11-17
- 关联方案：
  - [2026-11-05-local-task-device-delegation-technical-design.md](./2026-11-05-local-task-device-delegation-technical-design.md)（已落地：设备身份 / 会话绑定执行端 / 定向委托。本方案是其 §2.2 明确排除、§9-3 留作独立方案的「文件树远程代理」，即该独立方案）
  - [2026-10-12-new-task-file-tree-technical-design.md](./2026-10-12-new-task-file-tree-technical-design.md)（新建态文件树与 provider 工厂分支序，本方案不改变其行为）
  - [2026-10-12-file-manager-tab-technical-design.md](./2026-10-12-file-manager-tab-technical-design.md)（中央 Tab 文件管理器，本方案不改其范围）

## 1. 需求背景与根因定位

### 1.1 现象

移动端（安卓壳 / 手机浏览器）打开一个 LOCAL 会话 → 右侧「文件」Tab 照常出现 → 树区域渲染红色异常文本 `Cannot read properties of undefined (reading 'listDirectory')`。同一会话在执行端桌面客户端内浏览正常。顶部「桌面客户端已连接」提示说明 WS 委托链路本身在线，与文件浏览无关。

### 1.2 结论：功能限制 + 崩溃级 bug 的叠加

**功能限制（设计如此，非缺陷）**：LOCAL 会话的文件浏览实现为 renderer 直连 Electron IPC（文件只在本机读，不出机器），移动端天然没有这条通道。设备委托方案（11-05）落地时明确排除了文件树远程代理（其 §2.2「不做文件树 / 终端 / Git 状态的远程代理」、§9-3「需要新增 WS 请求-响应代理层……建议独立方案」）。

**Bug（未优雅降级）**：这条「不支持」没有在 UI 上设防，移动端不仅进入不了引导态，反而直接抛 JS 异常并把原始英文报错当内容渲染。证据链：

| # | 环节 | 证据 |
|---|---|---|
| 1 | 文件 Tab 显隐对 LOCAL 只判 workspace，不判客户端形态 | `desktop/src/components/task/TaskInspector.vue:506-512` `showFileTreeTab` 的 LOCAL 分支 `return !!props.workspace` |
| 2 | LOCAL provider 直连 IPC，无 electronAPI 环境下访问 `.listDirectory` 即 TypeError | `desktop/src/composables/workspace-file-provider.ts:162-216` `createLocalProvider`；`:168` `window.electronAPI.listDirectory(...)` 无防御（对比 `:137` 搜索路径有 try/catch） |
| 3 | useFileBrowser 把未捕获异常的 `e.message` 当错误节点渲染 | `desktop/src/composables/useFileBrowser.ts:29-31`（`:47-48`、`:139-141` 同款） |
| 4 | 服务端文件端点对 LOCAL 会话读的是**服务端 FS**（潜伏问题） | `backend-ts/src/file/file.routes.ts:184-235` `workspace-directory/search/read/preview/download` 均拿 `session.workspace`（LOCAL 时是设备上的绝对路径）直接喂 `WorkspaceBrowseService`；`:174-182` `workspace-list` 同病 |

其中 #4 值得单独点名：`file.routes.ts` 对 LOCAL 会话没有任何分流或拒绝，若服务端文件系统恰好存在同路径目录，浏览器端调这些端点会返回**错误机器的目录内容**。文件树一侧目前仅因前端 provider 工厂短路（LOCAL 恒走 IPC provider）而未触发；但 `workspace-list` **真实可达**——移动端 LOCAL 会话的「@ 文件引用」面板走 `useEditorTagPanels.ts:236-249` 的非 Electron 分支（LOCAL+IPC 条件不成立 → 直接调 `/files/workspace-list`），同样存在读错机器数据的风险。属潜伏缺陷，本方案顺带修掉。

### 1.3 能力底座（全部已存在，本方案只组装）

| 设施 | 现状 | 证据 |
|---|---|---|
| 设备定向投递 | `sendToDevice(userId, deviceId, event)` / `hasDeviceConnection` / `deviceExecutors` 索引 | `backend-ts/src/session/ws/streaming-ws-registry.ts:137/:471/:529` |
| 会话执行目标解析 | `resolveTarget`：内存缓存优先，DB `target_device_id` 兜底 | `backend-ts/src/harness/local/local-tool-session-registry.ts:140-156` |
| 会话 VO 设备字段 | `targetDeviceId / targetDeviceName`（映射 `session-vo.ts:201-202`）+ `targetDeviceOnline`（请求时快照 `session.routes.ts:186-188`，离线实时广播 `streaming-ws-handler.ts:478`） | `backend-ts/src/session/session-vo.ts:34-36` |
| 设备端文件原语 | preload 已暴露 `listDirectory / localReadFile / localReadBytes`（`preload.cjs:85-95`）。**仅 `list-directory` 有 workspace containment 校验（`main.cjs:2272`）与 500 条上限（`:2279`）；`local-read-file / local-read-bytes` 走 `resolveWorkspacePath(filePath)` 单参调用（`main.cjs:1105-1118`），绝对路径原样放行、相对路径按全局 `currentWorkspace` 解析，无 containment 校验**；64MB 字节上限在 `localFileBytes.cjs:12` | `desktop/electron/main.cjs:2267/:2124/:2156`、`desktop/electron/localFileBytes.cjs:12` |
| 子会话设备继承 | 子代理 / 边路 / 后台子代理 / fork 创建时均复制父会话 `targetDeviceId`（`subagent-invocation.service.ts:51`、`streaming-ws-handler.ts:1426`、`background-subagent-manager.ts:570`、`session.service.ts:783`） | `resolveTarget` 读会话自身字段即命中，无需回溯父会话 |
| 设备身份（renderer） | `getLocalDeviceInfo()` 仅 Electron 有值；deviceId 与 mao-agent 共享 | `desktop/src/utils/device-info.ts:12-22` |
| 客户端可靠回传 | `sendReliable` 发 `tool_result` 的既有范式 | `desktop/src/composables/useStreamWS.ts:1319-1353` |
| 服务端入站路由 | `case 'tool_result'` → `completeToolRequest(sessionId, requestId, result)` 范式 | `backend-ts/src/session/ws/streaming-ws-handler.ts:644` |
| 设备端搜索 | renderer BFS 有界搜索（排除 .git/node_modules、500 目录 / 10 层上限） | `desktop/src/composables/workspace-file-provider.ts:117-160` `searchLocalWorkspace` |

**硬约束**：WS 服务端入站 `maxPayload: 1MB`（`backend-ts/src/session/ws/attach-websocket.ts:19`，@fastify/websocket 选项，**按 UTF-8 字节计，只约束服务端接收方向**，即设备→服务端的 `file_op_result`）。客户端→服务端单条消息超限会被断连——这直接决定代理通道的载荷上限与二进制传输的取舍（D8）。

## 2. 需求描述

### 2.1 要做的（分两层交付）

**P0 热修（崩溃止血，可独立先行发版）**

1. `TaskInspector.showFileTreeTab` LOCAL 分支加客户端形态门控：非 Electron 客户端不显示「文件」Tab（P1 落地后恢复 `!!props.workspace`：provider 层已无崩溃风险，且未绑定会话需展示登记引导（§4.4），不宜按「有无绑定设备」再收窄）。
2. `createLocalProvider` 各方法加 electronAPI 缺失防御：不抛 TypeError，统一返回 `{ error: '本地任务文件仅在桌面客户端内可浏览' }` 形状（树渲染中文错误行，双保险）。注意 `searchFiles` 不能依赖 `searchLocalWorkspace` 内部的逐目录 try/catch（catch→continue，无 electronAPI 时会**静默返回空结果**而非错误），必须显式返回 `{ error }`。

**P1 主体（LOCAL 会话文件树远程代理）**

3. **服务端分流**：`/v1/files/workspace-directory / workspace-search / workspace-read / workspace-preview / workspace-download / workspace-list` 对 `executionMode === 'LOCAL'` 的会话改为代理到绑定执行端设备，不再读服务端 FS（修 §1.2-#4，含移动端 @ 引用面板真实调用的 `workspace-list`）；CLOUD 会话行为不变。
4. **WS 代理通道**：新增服务端→设备 `file_op_request`、设备→服务端 `file_op_result` 一对事件，定向发送到会话绑定设备，请求-响应 + 超时 + 断线清理，镜像既有工具委托机制。
5. **设备端执行**：`useStreamWS.ts` 新增 `file_op_request` 处理分支，按 op 调既有 preload API（`listDirectory / localReadFile / localReadBytes / listWorkspaceFiles`），回传结果；Electron 主进程 `main.cjs` 零改动。
6. **前端 provider 切换**：LOCAL 会话在「非本机执行端」场景下复用 `createCloudProvider(sessionId)`——代理端点与 CLOUD 端点同 URL 同 DTO，`FileTree / FileViewer / useFileBrowser` 零改动。
7. **双机互看的正确性**：Electron 打开**其它设备**绑定的 LOCAL 会话时同样走代理（现行为是直读本机 IPC，两台 Mac 场景会静默读到错误机器的同名路径文件，顺带修正）。
8. **只读边界维持**：写操作、打包下载（zip）不开放（D7）；`canWrite` 与下载菜单显隐口径不变。

### 2.2 不做的（本期明确排除）

- **不做写操作远程化**：移动端上传 / 新建 / 重命名 / 删除 LOCAL 会话文件——文件需要从服务端落到目标机，语义复杂，P2 另议。
- **不做二进制大文件远程预览 / 下载**：图片 data_uri、PDF、zip/xlsx 超过 WS 1MB 入站上限的传输需要分块或设备侧 HTTP 上报，P1 先用设备端尺寸护栏拒绝并提示（D8），P2 另议传输方案。
- **不做 zip 打包下载**：设备端无 zip 原语（`list-directory` 只有逐条列举），`workspace-download-zip / download-multi-zip` 对 LOCAL 分支直接拒绝并提示不支持。
- **不做未绑定会话的广播代理**：`target_device_id` 为空的存量会话，文件浏览返回明确引导文案（「请在桌面客户端打开一次完成登记」），不广播猜测执行端——文件浏览是展示性操作，读到错误机器的数据比报错更有害（与工具执行的广播回退语义刻意不同，D4）。
- **不做 Git / 终端远程代理**：与 11-05 §9-3 同源，另行立项。git 端点的既有口径分两档、均维持不动：新端点族经 `requireOwnedCloudGitSession` 显式拒绝 LOCAL（`file.routes.ts:114-120`），早期 git 端点（git-repos/status/diff/refresh/commit/pull/push/activity，`:281-350`）无 LOCAL 防御（既有缺口，与本方案无关，不扩范围）。
- **不做管理后台侧的 LOCAL 文件浏览**（`2026-10-15-admin-session-workspace-file-browser.md` 的 LOCAL 扩展），P2 另议。admin 现状安全：`admin-session-files.routes.ts` 的 `requireBrowsableSession`（`:40-42`）已显式拒绝 LOCAL（「本地执行会话的工作区在用户设备上，服务端不可浏览」），本方案不需要也不应触碰 admin 端点。
- **零 DDL、零契约枚举变更**：不加表不加列（设备绑定 V186 已就绪），不改 `@mao/contracts`（新 WS 事件载荷为普通接口，非跨端枚举）。

## 3. 关键决策

| # | 决策点 | 结论 | 落选项与理由 |
|---|---|---|---|
| D1 | 交付分层 | P0 热修与 P1 代理分离，P0 可先行发版 | 崩溃是当下线上体验问题，两行门控 + 防御文案当天可发；代理是完整功能，节奏独立 |
| D2 | 端点策略 | 复用既有 `/v1/files/workspace-*` URL，服务端按 `executionMode` 分流 | 前端代理 provider 即 `createCloudProvider(sessionId)` 原样复用（同 URL 同 DTO），`FileTree / FileViewer / useFileBrowser` 零改动；新端点族则要复制一整套 provider 与 DTO 映射 |
| D3 | WS 通道 | 新增专用 `file_op_request / file_op_result`，不复用 `tool_execute` | 文件浏览无审批语义（只读）、无工具卡片 / result-summarizer / no-progress-notice 纠缠、需要远短于 900s 的超时；不注册进 ToolRegistry，因此不触发 AGENTS.md 内置工具三件套同步义务；避免污染 main.cjs 的 `executeToolByName` 分发 |
| D4 | 定向策略 | 只定向，不广播；未绑定会话直接拒绝并引导登记 | 工具执行广播取首个结果属「多执行一份副作用」问题；文件浏览广播取首个结果是「随机展示某台机器的数据」，静默错误不可接受 |
| D5 | 设备端执行位置 | renderer（`useStreamWS.ts`）调既有 preload API，`main.cjs` 零改动 | preload 已暴露四个文件原语（`listDirectory` 自带 containment 校验与 500 条上限，read / bytes 类无校验、由 WS 分支前置补齐，见 §4.2-2）；WS 客户端本就在 renderer；复用 IPC 等于零新增设备端逻辑 |
| D6 | 「本机即执行端」判定 | renderer 比对 `getLocalDeviceInfo().id === session.targetDeviceId`：一致走直连 IPC（现状），不一致走代理 | 修双机互看读错机器的隐患；会话未绑定时 Electron 维持直连（兼容存量行为） |
| D7 | 只读边界 | 代理 P1 只放行 list / read / search / files；preview / 单文件下载明确拒绝（中文文案，非 2xx），P2 `bytes` op 后放行；写与 zip 不开 | `canWrite` 门控（LOCAL 恒只读）与下载菜单 CLOUD-only 显隐均不动；移动端能力与桌面端 LOCAL 现状对齐；preview/download 依赖 bytes 传输（超 1MB 入站上限），先拒绝不给死入口 |
| D8 | 载荷与二进制 | 单条回传 ≤ 700KB **UTF-8 字节**（maxPayload 1MB 减信封余量）；超限设备端直接返回友好错误；二进制传输（分块 / HTTP 上报）P2 | 1MB 入站上限按字节计、超限断连（影响整个会话流），预检是**主防线**而非护栏：目录列表（500 条 × 短字段）通常在限内，但文本 read 无保证（5000 行长行 / 中文内容 UTF-8 3 字节每字符轻松过 MB；图片走 `readLocalImage` 的 5MB 读取上限，base64 后 ~6.8MB 必超）——预检必须按最终整帧字节估算（§4.2-4） |
| D9 | 超时 | list / read / files 15s，search 30s（设备端 BFS 有界但大目录可能秒级；preview / download 的 `bytes` op P2 引入时沿用同一档） | 远短于工具委托 900s；超时返回中文错误供树错误节点展示 |
| D10 | 传输编码 | 结果 JSON 文本直传；bytes 类以 base64 计入 700KB 预检 | 与 `tool_result` 同为 JSON 文本通道，无需二进制帧改造 |
| D11 | CLI 绑定设备的投递 | `file_op_request` 只投给执行端设备上的 **Electron renderer 连接**；设备无任何连接 → 离线文案，仅有 CLI 连接 → 专用文案「该任务由终端 CLI（mao-agent）执行，暂不支持远程浏览本地文件」 | 11-05 D13 下 CLI 创建的 LOCAL 会话绑定 CLI 设备是正式产品流；`deviceExecutors` 每设备只存一条执行连接（同 deviceId 最新覆盖，`streaming-ws-registry.ts:206-208`），Electron 与 CLI 并存时该槽可能被 CLI 占住——直接 `sendToDevice` 会把请求发给 CLI 被静默忽略、白等 15s 超时。注册表加一个小 helper 做 client-type 感知投递（§4.1-8）；agent-cli 实现 file op 列入 §9 开放问题 |

## 4. 详细设计

### 4.1 服务端（backend-ts）

**新增 `backend-ts/src/file/remote-file-proxy.service.ts`**（挂 harness/local 或 file 域均可，建议 file 域、依赖注入 local-tool-session-registry 同款形态）：

```ts
export type RemoteFileOp = 'list' | 'read' | 'search' | 'files';
// preview / download 在 routes 层直接拒绝（非 2xx，见 §4.1-4）；bytes op P2 引入

interface PendingFileOp {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  socket: { id: string } | null;
  timer: NodeJS.Timeout;
}

class RemoteFileProxyService {
  private readonly pending = new Map<string, PendingFileOp>(); // key: requestId

  async execute(session: Session, op: RemoteFileOp, params: Record<string, unknown>): Promise<unknown> {
    const target = await this.localToolSessionRegistry.resolveTarget(session.id!);
    // 未绑定 → 拒绝引导登记；绑定设备离线 → 拒绝（含设备名快照文案）
    // sendToFileCapableDevice 投递（D11）→ 等待 future（D9 超时）→ 结果归一化返回
  }

  complete(requestId: string, ok: boolean, data: unknown): void;   // file_op_result 入口
  failAllForSocket(socket: { id: string } | null): void;           // 连接断开清理，镜像 failAllForSocket
}
```

要点：

1. **目标解析复用** `LocalToolSessionRegistry.resolveTarget`（缓存 + DB 兜底），不新建第二份会话→设备映射。
2. **未绑定拒绝文案**（对齐 11-05 D15 文案体系）：「该本地任务未登记执行端设备，请在桌面客户端打开一次完成登记」。
3. **离线文案**：「执行端设备「{targetDeviceName}」已离线，无法浏览本地文件」（快照名离线可读，来源 session VO 同源字段）。
4. **op 集合 P1 有四个**：`list`（映射 preload `listDirectory`）、`read`（映射 `localReadFile`，offset/limit 透传）、`search`（映射 renderer `searchLocalWorkspace`）、`files`（映射 preload `listWorkspaceFiles`，服务 `workspace-list` 端点——该端点由移动端 @ 引用面板调用（§1.2-#4），preload 已暴露（`preload.cjs:91`）且返回 `{path,name,size}` 数组与 CLOUD DTO 完全同形，零归一化）。`workspace-preview` 与 `workspace-download` 在 P1 对 LOCAL 分支返回「移动端暂不支持预览 / 下载本地文件」（D7/D8），P2 引入 `bytes` op 后再放行。
5. **结果归一化**：设备端 `list-directory` 返回条目带 `mtime`（epoch ms），CLOUD DTO 字段名是 `mtimeMs`——代理层统一 `{ ...entry, mtimeMs: entry.mtime }` 并给结果补 `workspaceRoot: session.workspace`（`createCloudProvider.getAbsolutePath` 依赖它）。
6. **超时**：`setTimeout` 按 D9，超时 reject `BusinessException` 同款中文文案；pending 表按 requestId 清理。
7. **投递零成功 / 连接归属**（镜像 `local-tool-session-registry.ts:206-224` 的半死连接处理）：`sendToDevice.successCount === 0` 立即返回离线错误，不空等超时；pending 记录实际投递连接（镜像 `sendToolRequest` 的 `dispatchedSocket`，`getDeviceExecutorSocket`），断线 `failAllForSocket` 只失败该连接的请求，同设备连接交接不误杀。
8. **CLI 绑定设备投递（D11）**：注册表新增 helper（如 `sendToFileCapableDevice(userId, deviceId, event)`）：扫描该设备的全部存活连接（`userSessions` × `connectionDevice`，同 `releaseDevice` 的 fallback 扫描口径），优先投给 `clientType === 'electron'` 的连接；返回三态——已投递 / 设备无连接（离线文案）/ 仅有 CLI 连接（D11 专用文案）。禁止直接 `sendToDevice`（执行连接槽可能被 CLI 占住）。

**改造 `file.routes.ts`**：

- 6 个 GET 端点（directory / search / read / preview / download / list）在 `requireOwnedSession` 之后加分支：`session.executionMode === 'LOCAL'` → 走 `remoteFileProxyService`，否则维持 `WorkspaceBrowseService`（CLOUD 恒等）。`workspace-download-zip / download-multi-zip` 的 LOCAL 分支返回「本地任务暂不支持打包下载」。分支收敛为一个 helper（如 `resolveBrowseBackend(session): 'server' | 'proxy' | 'reject'`），避免 6 处复制。
- **preview / download / zip 的 LOCAL 拒绝必须以非 2xx 状态返回**（如 `sendJson(reply, 400, fail(...))`）：前端 `previewFile / readFileBytes` 走 fetch 且仅在 `!resp.ok` 时读取错误 JSON（`workspace-file-provider.ts:333/:352`），而 `BusinessException(PARAM_INVALID)` 经 `handleError` 默认映射为 **HTTP 200 + code 信封**（`common/http-error.ts:69-83`）——HTTP 200 会被 `resp.ok` 放行、把 JSON 当 blob 渲染失败，中文文案不可达。list / read / search 走 axios，拦截器按 `code !== 0` 抛错并携带中文 message（`desktop/src/api/index.ts:64-78`），BusinessException 即可。（CLOUD 的 workspace-preview 现状即有此「200 信封被当 blob」的历史坑，本方案不修，仅保证新增拒绝路径可读。）
- 该分支同时消除 §1.2-#4 潜伏问题：LOCAL 会话的 `session.workspace`（设备路径）永远不再喂给服务端 FS。
- `experienceDirOf(session)` 仅 CLOUD 分支使用（团队经验挂载是服务端概念），代理分支不传。
- 权限面零变化：仍是 `requireUserId` + `requireOwnedSession`，代理不扩大暴露面。

**改造 `streaming-ws-handler.ts`**：

- 入站新增 `case 'file_op_result': this.handleFileOpResult(userId, root); break;`（`:644` 邻位）：校验会话归属（消息自带 sessionId，与 `tool_result` 同款校验）后调 `proxy.complete(requestId, ok, data)`。
- `afterConnectionClosed` 增加 `remoteFileProxyService.failAllForSocket(socket)`（与 `localToolSessionRegistry.failAllForSocket` 并列），避免目标设备断线后文件请求悬挂到超时。

**WS 事件载荷**（普通 JSON，不进 contracts）：

```
服务端→设备  file_op_request  { requestId, op: 'list'|'read'|'search'|'files', params: { dir? | path?, offset?, limit?, pattern?, filter? }, workspace: <session.workspace 绝对路径> }
设备→服务端  file_op_result   { sessionId, requestId, ok: true, data: <op 对应 DTO> } | { sessionId, requestId, ok: false, error: '<中文错误>' }
```

### 4.2 设备端（desktop，Electron 与 Web 同 dist）

**`useStreamWS.ts` 新增 `case 'file_op_request'`**：

1. 仅 `isElectronClient()` 且 `electronAPI` 可用时处理，否则回 `ok:false, error:'当前客户端不支持执行文件操作'`（D11 下浏览器 tab 正常不会被投递——只有 electron 类型连接接收；保守回错优于静默）。
2. 相对路径解析：`resolveWorkspaceFilePath(workspace, path/dir)` 后做 containment 校验 `resolved.startsWith(workspace + sep) || resolved === workspace`（镜像 `main.cjs:2272` 口径，防 `..` 逃逸；`listDirectory` 的 IPC handler 自带校验，`localReadFile/Bytes` 不带，因此统一在 WS 分支前置校验。`resolveWorkspaceFilePath` 对绝对路径原样放行（`utils/workspace-path.ts`），逃逸防护只能靠这一步）。
3. op 分发：`list → electronAPI.listDirectory(abs, workspace)`；`read → electronAPI.localReadFile({ path, offset, limit })`；`search → searchLocalWorkspace(workspace, pattern, limit)`（从 `workspace-file-provider.ts` 导出复用，不复制）；`files → electronAPI.listWorkspaceFiles(workspace, filter, limit)`（preload.cjs:91，响应数组与 `workspace-list` DTO 同形）。
4. **尺寸预检（D8 硬要求）**：对**最终整帧**（含 `file_op_result` 信封与 JSON 转义）按 UTF-8 字节估算：`new TextEncoder().encode(JSON.stringify(frame)).length > 700 * 1024` → 回 `{ ok:false, error:'文件过大，移动端暂不支持查看该文件' }`。不能用 `JSON.stringify(result).length`——那是 UTF-16 code unit 数，maxPayload 按 UTF-8 字节计，中文内容 3 字节/字符、换行引号转义再膨胀，字符串长度预检会系统性低估。宁可拒绝不可超限——超限消息会导致 WS 断连，影响整个会话流。
5. 回传走 `sendReliable({ type: 'file_op_result', ... })`（与 `tool_result` 同通道同可靠性）。
6. 无审批弹窗、无 main.cjs 改动、无 preload 改动。

### 4.3 前端 provider 与 Tab 显隐

**`workspace-file-provider.ts` 工厂**（`useWorkspaceFileProvider`，`:693-715`）加第 5 参 `localProxySessionId: Ref<string | null>`，分支序：

| executionMode | workspace | localProxySessionId | 结果 |
|---|---|---|---|
| CLOUD | — | — | 现状不变（sessionId → cloud；新建态 projectKey → project） |
| LOCAL | 有 | 非空 | `createCloudProvider(localProxySessionId)`（**新增**：代理，同 CLOUD URL/DTO） |
| LOCAL | 有 | 空 | `createLocalProvider(workspace)`（现状直连，恒等） |
| LOCAL | 无 | — | null（现状） |

对现有两条路径是恒等改写。`createCloudProvider` 的下载方法在 LOCAL 会话下被 FileTree 的 `canDownload`（CLOUD-only）门控隐藏，不产生死入口；其错误形状（catch → `{ error }`）与代理端点返回的中文 BusinessException 文案天然衔接，树错误节点直接展示。

**`TaskView.vue`**：新增 computed `localProxySessionId`——`executionMode === 'LOCAL' && sessionId && session.targetDeviceId && deviceId !== session.targetDeviceId` 时取 `sessionId`，否则 null（`session.targetDeviceId` 从 sessionStore 会话 VO 读，`stores/session/types.ts:58` 已有该字段）。本机 deviceId 复用既有 `useCurrentDevice()` composable（ChatPanel / SideChatPanel 同款：挂载时 `getLocalDeviceInfo()` 取一次存 ref，`device-info.ts` 每次调用都是一次 IPC，勿在 computed 里直接调）。

**`TaskInspector.vue` 显隐门控**（P0 先行、P1 恢复同一处）：

```ts
// P0：return !!props.workspace && isElectronClient()（isElectronClient 来自 ../../utils/platform）
// P1：恢复 return !!props.workspace（provider 已无崩溃风险）
```

P1 无需给 TaskInspector 新增 `targetDeviceId` prop：门控恢复既有判据后，未绑定会话也要显示 Tab（树区域出「登记引导」中文错误行，见 §4.4——按「有无绑定设备」收窄会把这些会话的引导藏掉，自相矛盾）；离线设备场景同理不隐藏 Tab——树区域显示服务端返回的「设备已离线」中文错误行，比隐藏更可解释。P0 引入的 `isElectronClient` import 在 P1 一并撤掉。

既有先例：Git Tab 的 LOCAL provider 工厂已用 `canUseLocalGit()`（`workspace-git-provider.ts:618-620`，工厂 `:631`）做同款客户端形态门控——移动端 Git Tab 不出现也不崩，文件 Tab 的 P0 门控与它对齐（这也解释了为什么本崩溃只发生在文件 Tab）。

### 4.4 语义对照（改动前后）

| 场景 | 现状 | P0 后 | P1 后 |
|---|---|---|---|
| 移动端 / 浏览器打开 LOCAL 会话文件 Tab | Tab 出现 → 红色英文 TypeError | Tab 隐藏 | Tab 出现 → 树展示绑定设备上的真实文件（在线）；离线显示中文错误；未绑定显示登记引导 |
| 桌面 Electron 打开本机绑定的 LOCAL 会话 | 直连 IPC | 不变 | 不变（D6 判定走直连） |
| 桌面 Electron 打开**其它设备**绑定的 LOCAL 会话 | 直连 IPC 读**本机**同路径（静默错误） | 不变（P0 不扩范围） | 走代理，展示目标设备真实文件 |
| 存量未绑定会话（旧版本创建） | Electron 直连 IPC；浏览器崩溃 | Electron 直连；浏览器 Tab 隐藏 | Electron 直连（兼容）；浏览器 Tab 出现但显示登记引导文案 |
| CLOUD 会话各端 | 正常 | 不变 | 不变（恒等分流） |

## 5. 落地清单

| 端 / 文档 | 项 |
|---|---|
| backend-ts（新增） | `src/file/remote-file-proxy.service.ts`（pending 表 / client-type 感知定向投递 / 超时 / 归一化 / failAllForSocket）+ spec |
| backend-ts（改造） | `src/file/file.routes.ts`（6 端点 LOCAL 分流 + zip 端点拒绝，preview/download/zip 拒绝走非 2xx）、`src/session/ws/streaming-ws-handler.ts`（`file_op_result` 入站 + 断线清理）、`src/session/ws/streaming-ws-registry.ts`（`sendToFileCapableDevice` helper）+ spec |
| desktop（改造） | `src/composables/useStreamWS.ts`（`file_op_request` 分支：containment 校验 / op 分发含 files / UTF-8 字节预检 / sendReliable 回传）、`src/composables/workspace-file-provider.ts`（工厂第 5 参 + 分支序；导出 `searchLocalWorkspace`；**同步改 `workspace-file-provider.test.ts` 现有 8 处 4 参调用**——`src/**/*.ts` 在 `vue-tsc -b` include 内，漏改即构建失败）、`src/views/task/TaskView.vue`（`localProxySessionId` computed，复用 `useCurrentDevice`）、`src/components/task/TaskInspector.vue`（显隐门控，P0 引 `isElectronClient`、P1 撤） |
| P0 热修（独立提交） | `TaskInspector.vue` 门控 + `workspace-file-provider.ts` electronAPI 缺失防御文案 + 单测 |
| contracts | 无变更 |
| 迁移 | 无 DDL |
| 测试 | 见 §7 |
| 文档 | `changelog/unreleased/2026-11-17-local-file-remote-proxy.md`（P0、P1 各一条或合并）；`skills/mao-cli/` 桌面 / Web 使用说明补 LOCAL 会话文件浏览的多端口径 |

## 6. 风险与回归护栏

| 风险 | 护栏 |
|---|---|
| WS 回传超 1MB maxPayload 导致**断连**（影响整个会话流，最严重） | 设备端 700KB 序列化预检，超限一律回友好错误（D8）；单测覆盖临界尺寸；P1 不做任何「先传了再说」的路径 |
| 设备端把代理请求当攻击面（任意路径读） | WS 分支前置 containment 校验（镜像 main.cjs:2272 口径，`localReadFile/Bytes` 的 IPC handler 自身**没有**校验，防逃逸只能靠这一步）；信任模型与 shell 工具一致（本人设备 + 本人服务端） |
| 双机互看行为变化引起困惑（原来看的是本机文件） | 原行为本身是静默错误数据；CHANGELOG 与 UI 设备标识（11-05 已有「本地任务 · 设备名」）共同说明数据来自执行端设备 |
| 代理超时后树节点悬挂 | pending 表 + 定时器双向清理；断线 `failAllForSocket`；投递零成功立即失败不进 pending |
| 服务重启丢 pending | 内存态与工具委托同寿命；用户刷新页面重拉目录即可，无需恢复语义 |
| `mtime → mtimeMs` 归一化遗漏导致排序 / 展示异常 | 归一化收敛在 proxy service 单点；spec 断言字段名 |
| 移动端频繁展开目录造成请求风暴 | 目录列表本就有 500 条上限 + 用户交互驱动；不加节流（与 CLOUD 端行为对齐） |
| 预检单位错误（字符串长度 ≠ UTF-8 字节）导致中文内容漏检、整连接被断 | 预检按最终整帧 `TextEncoder` 字节数（§4.2-4）；单测覆盖中文长文本与 base64 临界尺寸 |
| preview / download 的 LOCAL 拒绝走 HTTP 200 + code 信封，前端把 JSON 当 blob 渲染失败 | 拒绝路径一律非 2xx（§4.1）；file.routes.spec 断言状态码与可读 message |
| CLI 绑定的 LOCAL 会话（11-05 D13 正式产品流）：`file_op_request` 落到 CLI 连接被静默忽略 → 白等超时，误导为设备故障 | `sendToFileCapableDevice` client-type 感知投递（D11）：仅 CLI 连接时立即回专用文案；Electron+CLI 并存时投给 electron 连接。agent-cli 实现 file op 列入 §9 |
| 旧后端 + 新客户端 / 新后端 + 旧客户端 | 新客户端多一个 WS case 对旧后端无害；新后端 `file_op_request` 发给旧客户端被静默忽略 → 服务端超时回「设备无响应」类文案，发布顺序仍先 backend-ts 后 desktop（与 11-05 §8 同约束） |
| P0 门控误伤 Electron 新建态 | `isElectronClient()` 在 Electron 内恒真，新建态 LOCAL 行为不变；单测覆盖 |

## 7. 测试要点

**后端（`cd backend-ts && npm test`）**

1. `remote-file-proxy.service.spec.ts`：正常往返（resolveTarget → 投递 → complete）；绑定设备离线 → 中文错误；未绑定 → 登记引导文案；投递零成功 → 立即失败不进 pending；设备仅 CLI 连接 → D11 专用文案；Electron+CLI 并存 → 投给 electron 连接（mock `sendToFileCapableDevice`）；list 15s / search 30s 超时；`failAllForSocket` 只失败该连接的请求（连接交接不误杀）；`mtime → mtimeMs` + `workspaceRoot` 归一化；`files` op 透传 `listWorkspaceFiles` 结果零归一化。
2. `file.routes.spec.ts` LOCAL 分支：LOCAL 会话 directory/search/read/list 走代理（mock proxy service，断言不触达 WorkspaceBrowseService）；CLOUD 会话恒等走原实现；LOCAL 的 preview/download 拒绝断言**非 2xx 状态码 + 可读中文 message**（防 HTTP 200 信封回归）；zip 两端点 LOCAL 拒绝；跨用户 403 不变；未配置工作区 PARAM_INVALID 不变。既有 spec 的 LOCAL 用例集中在写端点与 git 端点（`file.routes.spec.ts:289/:384/:416`），browse 端点无 LOCAL 用例——分流不破坏既有测试，但需补齐上述新用例。
3. `streaming-ws-handler` spec：`file_op_result` 归属校验（非本人会话忽略）、`complete` 命中 pending、断线触发 `failAllForSocket`。

**前端（`cd desktop && npm run build` + 单测）**

4. `useStreamWS` file_op 分支：list/read/search/files 正确调 preload API 并回传；containment 校验拒绝 `../` 逃逸与绝对路径越界；预检按 UTF-8 字节——中文长文本（如 5000 行中文日志）与 base64 临界样例回「文件过大」且回帧本身远小于 700KB；非 Electron 回不支持；`sendReliable` 载荷形状。
5. `workspace-file-provider.test.ts`：工厂分支序四格（LOCAL+proxy / LOCAL 直连 / CLOUD / 无 workspace）；P0 防御——无 electronAPI 环境下 `createLocalProvider` 各方法返回 `{ error }` 不抛异常，**含 `searchFiles` 显式返回 error**（不能靠 searchLocalWorkspace 内部 catch 静默返回空结果）；工厂现有 8 处 4 参调用同步补第 5 参。
6. `TaskInspector` 显隐：P0 非 Electron 隐藏、Electron 新建态/真实会话不受影响；P1 恢复 `!!props.workspace`（含未绑定会话显示 Tab）。
7. `vue-tsc -b` 全量构建（勿用 `npx vue-tsc --noEmit` 假通过）。

**手工联调矩阵（必须）**

8. 桌面本机 LOCAL 会话：文件 Tab 直连浏览 / 打开文件 / 添加到聊天，全链路与改动前一致（回归）。
9. 移动端 + 设备在线：树展示执行端真实文件；展开 / 筛选 / 打开文本文件（≤ 上限）正常；添加到聊天在移动端输入框生效。
10. 移动端 + 设备离线：中文「设备已离线」错误行；设备重连后刷新恢复。
11. 移动端 + 未绑定存量会话：登记引导文案。
12. 双 Mac：A 建会话，B 的 Electron 打开 → 展示 A 机器文件（代理）；A 本机打开 → 直连不变。
13. CLOUD 会话移动端文件浏览回归不变。
14. 大文件（>700KB 文本 / 大图）：友好错误，会话 WS 不断连。
15. CLI 创建的 LOCAL 会话（mao-agent）：移动端 / 浏览器打开文件 Tab → 立即出「该任务由终端 CLI 执行，暂不支持远程浏览本地文件」专用文案（不白等超时）；同机随后打开 Electron 客户端 → 刷新后树可正常代理浏览（D11 投给 electron 连接）。
16. 移动端 LOCAL 会话输入「@」拉文件引用面板：P1 后展示执行端真实文件（`workspace-list` 走代理）；设备离线时呈现既有「文件列表加载失败 · 重试」态，不再读服务端 FS。

## 8. 发布与文档

1. **P0**：独立 commit，`bash scripts/deploy-desktop.sh` 即可发（纯前端），CHANGELOG unreleased 前端小节一条。
2. **P1**：先 `backend-ts`（构建 + 迁移无 + 测试绿）再 `deploy-desktop.sh`；桌面 Electron 用户自行 `npm run dist`。CHANGELOG unreleased 后端 + 前端两条；`skills/mao-cli/` 使用说明补「LOCAL 会话文件树在移动端 / 浏览器可远程浏览（只读，依赖执行端设备在线）」。
3. **回滚**：代码回滚即可，无数据、无 DDL、无契约变更；旧 dist 回滚后移动端回到 P0 前的崩溃态（需连 P0 一起回滚或接受）。

## 9. 开放问题（不阻塞主链路）

1. **二进制远程传输**（P2）：`bytes` op 分块回传（~700KB 分片 + seq/total 重组）或设备端 HTTP 直报服务端（临时 OSS / 本地缓存 + 下载端点转发），放行移动端图片 / PDF / zip 预览与单文件下载。两条路线工作量相近，分块少一套 HTTP 鉴权、HTTP 上报少占 WS 带宽，届时按实测带宽定。
2. **写操作远程化**（P2）：移动端向 LOCAL 工作区上传 / 编辑，需「服务端暂存 → 设备拉取写入」+ 设备端审批复用，另立方案。
3. **Git / 终端远程代理**：与文件代理同构（op 泛化为设备 RPC 后可复用 pending 机制），建议等文件代理稳定后评估。
4. **移动端浏览体验**：大目录虚拟滚动、图片网格视图等，属文件树组件增强，与本方案解耦。
5. **agent-cli 实现 file op**（P2）：CLI 绑定的 LOCAL 会话目前只能拿到 D11 拒绝文案；`agent-cli/src/local/executor.ts` 已有 `tool_execute` 分发骨架，补 `file_op_request` 处理（node fs + 同款 containment 校验）后，纯 CLI 设备的会话也能被远程浏览。前置依赖：containment 口径在 agent-cli 复刻一份或下沉共享，勿让两端漂移。→ 已立项：[2026-11-18-agent-cli-file-op-technical-design.md](./2026-11-18-agent-cli-file-op-technical-design.md)（含能力声明与分层投递）
6. **fetch 类方法对 HTTP 200 + code 信封的历史坑**：CLOUD 现状的 `workspace-preview` 报错（如「文件不存在」）同样经 `handleError` 映射为 HTTP 200，`previewFile` 会把 JSON 当 blob 渲染失败（`readPdfFile` 的 BusinessException，`workspace-browse.service.ts:261-269`）。与本方案无关但同根，可另开小修（previewFile 补 downloadWorkspaceResource 式的 JSON 信封检查）。
7. **双机互看时 @ 引用面板的 LOCAL 直连缺口**（P2）：`useEditorTagPanels.ts` 的 LOCAL+Electron 分支仍直调 `electronAPI.listWorkspaceFiles(ctx.workspace)`——目标设备路径在本机不存在时静默返回空列表，与文件树的代理分流不同步。移动端路径已由服务端 `workspace-list` 分流修复，仅 Electron 跨设备场景残留。
8. **files op 的 DTO 为 CLOUD 超集**：设备端 `list-workspace-files` 条目带 `mtime` 字段（CLOUD `WorkspaceFileDTO` 为 `{path,name,size}`），代理零归一化透传多出该字段，现无消费方使用、无行为影响；如求严格同形可在归一化层剥离。
