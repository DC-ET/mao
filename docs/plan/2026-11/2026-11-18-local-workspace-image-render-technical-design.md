# 本地任务正文图片跨端渲染技术方案（正文工作区相对图片按需委托执行端读取）

- 状态：草案（2026-11-18；§3 决策为拟定口径，评审通过后定案）
- 评审记录：2026-11-18 完成代码级评审，结论「**需修订后可行**」（文档引用的代码事实逐条核实基本准确，无阻断级缺陷）。本版已按评审补齐并核实（各处标注「**评审补充**」）：①修正 §1.1 事实错误——LOCAL 会话 workspace 服务端创建时**不校验**（`assertOwnedSessionWorkspace` 非 CLOUD 直接 return），「任意服务器路径被直读」是现存缺口，本方案的 LOCAL 分流顺带关闭它，并补安全断言与 changelog 明示；②执行端信任 / containment / 白名单 / 读盘失败一律**静默不回包**（对齐 skill/MCP 同步先例 `isOutsideTrust`，防未绑定会话用户级广播下异机多执行端的 error 帧竞争误杀合法分片）；③补两条传输硬约束——mao-agent 出站 900KB 截断（`serializePayload` 键表不含 `data`，超限帧整体替换为无 `data` 存根）与服务端 1MB maxPayload（桌面出站无截断，超限帧**断整条 WS 连接**），512KB 分片序列化后 ≈699KB 同时满足，并固化回归用例；④定死拼装缓冲生命周期（拼装服务自持 active Map + TTL 清扫 + 路由超时 abort）与内存上界口径，D11 由「不做并发上限」改为 **per-user 在途 fetch 软上限 8**。另按建议落字：帧信封双向形态区分、HTTP 200 错误信封断言口径、反斜杠路径拒绝、桌面 containment 信任叙事不对称如实写明、注释同步三处、routeEvent 同步约束、changelog 小节名、新增 4 组测试用例。**本轮不进入功能开发。**
- 日期：2026-11-18
- 关联方案：
  - [2026-11-05-local-task-device-delegation-technical-design.md](./2026-11-05-local-task-device-delegation-technical-design.md)（**前置依赖**：设备身份、创建即绑定、定向委托、浏览器接管 LOCAL 会话对话，全部已落地；本方案复用其委托通道，不新增执行模式、不改绑定语义）
  - [2026-11-17-remote-create-local-task-in-existing-workspace-technical-design.md](./2026-11-17-remote-create-local-task-in-existing-workspace-technical-design.md)（同场景互补：浏览器新建/接管本地任务后，「正文里的工作区截图」目前渲染不出来，正是本方案补齐的缺口）
  - CLOUD 正文图片能力：提交 `f31341ef`（正文工作区相对图片解析为可访问地址）+ `a65c0ade`（等比缩放），changelog `changelog/unreleased/2026-11-17-markdown-workspace-images.md`
- 能力底座（撰写时已存在的实现，全部复用、不重写）：
  - 正文图片改写链路：`decorateMarkdownImages` 把「无协议、非站内绝对路径」的 img src 改写为 `/v1/files/workspace-download?sessionId&path&token`，失败回退「📎 原路径」文本；流式期间同样处理（`desktop/src/utils/markdownImages.ts:79-92`，回退 `:59-72`）
  - **LOCAL 被排除的唯一原因**：`toWorkspaceImageUrl` 对 `executionMode === 'LOCAL'` 早返回 null（`markdownImages.ts:43`，注释「服务端读不到」）——桌面 Electron 客户端同样被这条排除，即**现状两端都不渲染 LOCAL 正文图片**
  - 下载端点：`GET /v1/files/workspace-download` 按 `requireOwnedSession`（`backend-ts/src/file/file.routes.ts:55-64`）校验归属后直读服务器上 `session.workspace`（`:218-226`）。**评审补充（修正）**：LOCAL 会话的 workspace 服务端创建时**不校验**——`assertOwnedSessionWorkspace` 对非 CLOUD 直接 return（`session.routes.ts:721-729`），用户可自建 `workspace=/任意服务器路径` 的 LOCAL 会话，路径若存在于服务器上会被直读成功；这是一个现存的目录读取缺口（受限于后端进程文件权限），本方案的 LOCAL 分流顺带关闭它
  - WS 委托通道：`LocalToolSessionRegistry.sendToolRequest` 下发 `tool_execute`（requestId + future + 投递落空立即报错 + 断线 failAll 收敛，`backend-ts/src/harness/local/local-tool-session-registry.ts:158-226`）；结果回填 `completeToolRequest`（`:228-241`，按 requestId 单次 resolve，重复回包 no-op）；入站路由 `case 'tool_result'` 校验会话归属后回填（`backend-ts/src/session/ws/streaming-ws-handler.ts:1223-1230`）
  - 下发目标：`sendToLocalClients` 仅投 `electron` / `cli` 连接（`LOCAL_CAPABLE_CLIENTS`，`backend-ts/src/session/ws/streaming-ws-registry.ts:27`、`:424-426`），浏览器 / 安卓标签页不会收到委托帧
  - **云端容器同构先例**：`read_bytes` / `read_bytes_result` 请求-结果消息对按字节读容器工作区（base64 + maxBytes + 30MB 帧上限，`backend-ts/src/harness/container/runtime-channel-protocol.ts:11/72/97`，调用方 `docker-tool-router.ts:126`，执行侧 `runtime-agent.ts:245-315`）——本方案是它在 LOCAL 执行端的镜像
  - 桌面本机读取：`localReadBytes` IPC（`desktop/electron/preload.cjs:86` → `main.cjs:2156-2163`）→ `localFileBytes.cjs`（非符号链接 + 普通文件校验 + 64MB 上限，`desktop/electron/localFileBytes.cjs:14-33`，已有单测）；zip / xlsx / docx / 媒体预览已在用（`desktop/src/composables/workspace-file-provider.ts:196-211`）
  - 桌面工具委托入口参考：`ipcMain.handle('tool-execute')` 直接采纳服务端下发的 workspace 作为执行工作区（`desktop/electron/main.cjs:2567-2574`）——注意其 `resolveWorkspacePath` 会放行绝对路径（`main.cjs:1105-1118`），**文件读取不能沿用该口子**（见 D8）
  - mao-agent 执行端：事件分发按 `evt.type`（`agent-cli/src/local/executor.ts:181-191`）；服务端下发的 workspace 经 `resolveWorkspace` 收窄到本地信任工作区（`executor.ts:218-228`）；**信任外不回包的先例**：`isOutsideTrust`（`:230-236`，注释明言「失败回包会让服务端把整轮判负，同机桌面端后到的成功就被丢掉」，skill / MCP 同步已按此修正）；结果经 `ws.sendReliable` 回传（`:296-301`）
  - **评审补充（mao-agent 出站帧截断）**：`sendReliable` 经 `serializePayload`（`agent-cli/src/ws/ws-client.ts:44-76`）：帧 >900KB（`WS_TRUNCATE_AT_BYTES`，`ws/constants.ts:6-7`）先按键截断——键表为 `result / content / error / arguments / preview`，**不含 `data`**；仍超 1MB 则整体替换为 `{ type, truncated: true }` 存根（无 `data` / `requestId` 字段）。分片尺寸必须绕开这条路
  - **评审补充（桌面出站无截断）**：`useStreamWS` 直接 `send` 无任何截断（`desktop/src/composables/useStreamWS.ts:522-549`），超服务端 1MB 入站上限的帧会触发 ws 库 maxPayload 违规、**服务端关闭整条连接**（订阅态与流式全部丢失）——比「发不出」严重
  - WS 帧上限：`/ws/stream` 入站 `maxPayload: 1024 * 1024`（1MB，`backend-ts/src/session/ws/attach-websocket.ts:19`）——**约束结果回传必须分片**（见 D3）
  - 前端上下文齐备：`MessageBubble` 已传 `sessionId` + `sessionExecutionMode`（`desktop/src/components/chat/MessageBubble.vue:441-442`）；`Session` 实体带 `executionMode / workspace`（`desktop/src/stores/session/types.ts:38/50`）；桌面 `resolveWorkspaceFilePath` 做相对 → 绝对拼接（`desktop/src/utils/workspace-path.ts`）
  - mime：后端用 `mime-types` lookup（`file.routes.ts:3`）
- 本方案定位：**让正文 Markdown 里的工作区相对图片（`![标题](screenshots/x.png)`）在所有客户端一致渲染**。做法是：前端改写逻辑去掉 LOCAL 排除，三端统一用既有 `workspace-download` 地址；后端按 `session.executionMode` 分流——CLOUD 直读服务器工作区（现状不动），**LOCAL 经 WS 把「读工作区文件字节」按需委托给绑定执行端**，字节 base64 分片回传、服务端拼装后流给请求方，服务端不落盘不存库。**不做**执行端主动上传（文件出本机的语义变更）、不做执行端离线时的历史图渲染（回退 📎）、不做文件管理器 / 预览远程化（通道可复用，P2）。

## 0. 名词约定

沿用 [2026-11-05 方案 §0](./2026-11-05-local-task-device-delegation-technical-design.md)（执行端 / 设备、发起端、设备委托、定向发送）。新增三个：

| 名词 | 含义 |
|---|---|
| 正文图片 | assistant 消息 Markdown 里的 `![…](相对路径)` 图片；改写判定沿用 `isWorkspaceRelativeImageSrc`（无协议、非 `//`、非 `/` 开头，`markdownImages.ts:21-28`） |
| 按需委托读取 | 浏览器请求图片 URL 时，服务端才经 WS 向执行端读字节并原样回传；不做任务期主动上传、不在服务端持久化 |
| 分片 | `file_fetch_result` 按 ≤512KB 原始字节切片、各片独立 base64 的传输单元；服务端按 seq 拼装 |

## 1. 需求背景

### 1.1 现状

| 设施 | 现状 | 证据 |
|---|---|---|
| CLOUD 正文图片 | 已渲染：改写为带鉴权的 workspace-download 地址，失败回退 📎 | `markdownImages.ts:39-51`、`:79-92` |
| LOCAL 正文图片 | **各端（桌面 / 浏览器 / 安卓）都不渲染**：`toWorkspaceImageUrl` 对 LOCAL 早返回 null → 相对 src 404 → 📎 回退 | `markdownImages.ts:43` |
| workspace-download 对 LOCAL | `requireOwnedSession` 通过（workspace 非空，`file.routes.ts:55-64`）后直读 `session.workspace`。**评审补充（修正）**：LOCAL workspace 创建时服务端不校验（`session.routes.ts:721-729` 非 CLOUD 直接 return），「路径不存在 → 报错」不必然——用户可自建 `workspace=/任意服务器路径` 的 LOCAL 会话，路径存在则直读成功，现状是一个经会话归属校验的服务器目录读取缺口；本方案 LOCAL 分流改为委托执行端后**顺带关闭** | `file.routes.ts:55-64`、`:218-226`、`session.routes.ts:721-729` |
| 按需读执行端文件的通道 | **不存在**；LOCAL 侧只有工具执行委托（`tool_execute`），读文件只能借道工具（会进审批 / 工具卡 / 结果记录，不可接受） | `local-tool-session-registry.ts` |
| 云端容器按需读字节 | 已有同构消息对 `read_bytes` / `read_bytes_result`（base64、maxBytes、30MB 帧上限） | `runtime-channel-protocol.ts:72/97` |
| 桌面本机读字节 | IPC 已有（64MB 上限、防符号链接），但按绝对路径放行、无 workspace containment | `localFileBytes.cjs:14-33`、`main.cjs:1105-1118` |
| mao-agent 本机读文件 | 有（工具实现内），但同样只能借道工具链路；信任收窄已有 `resolveWorkspace` | `executor.ts:218-236` |
| WS 帧上限 | `/ws/stream` 入站 1MB；执行端 → 服务端的 base64 结果超过 ~750KB 就发不出 | `attach-websocket.ts:19` |
| 执行端离线 | 委托通道已有完整兜底：`isConnected` 失败 / 投递落空 / 断线 failAll 均立即报错不悬挂 | `local-tool-session-registry.ts:11/167-177` |
| 执行端在线判定 | 设备级（绑定 `target_device_id`）→ `hasDeviceConnection`；未绑定 → 用户级 | `local-tool-session-registry.ts:110-117` |

### 1.2 问题

1. **产品口径自相矛盾**：正文图片是 Agent 任务的核心产物（截图、生成图、导出图）；CLOUD 会话浏览器能看到，LOCAL 会话换成浏览器（甚至桌面客户端自己）就全是 📎 裂图占位——同一条消息换个端观感断裂。
2. **桌面端同样受害**：LOCAL 排除是「一刀切」，桌面 Electron 本机就有文件（`localReadBytes` IPC 就在手边），也没有渲染。
3. **按需通道是唯一不破坏 LOCAL 语义的路径**：要让浏览器看到执行机文件，字节必然经服务器中转（与 LOCAL 工具结果、审批流中转的信任模型相同）；「主动上传到服务端存储」则把「文件不出本机」变成「默认全部出本机」，语义变更过大（列入 §10 开放问题，本期不做）。

### 1.3 机会（可行性结论）

1. **前端≈一行**：改写逻辑、失败回退、流式处理、点击放大（`markZoomableImages` / `el-image-viewer`）全部现成，去掉 LOCAL 早返回后三端自动生效，图片地址对 CLOUD / LOCAL 完全同构。
2. **委托通道零新基建**：下发 / future / 投递失败 / 断线收敛 / 单次 resolve 全部复用 `LocalToolSessionRegistry`；新增的只是「请求-结果」消息对与分片拼装，且云端容器 `read_bytes` 已给出同构范式。
3. **执行端读取原语现成**：桌面 `localFileBytes.cjs` 的校验与上限可整体复用（补一个带 containment 的入口），mao-agent 的信任收窄 `resolveWorkspace` 可直接套用。
4. **评审补充：顺带修复一个现存安全缺口**——LOCAL 分流后 `workspace-download` 不再直读服务器文件系统；同级 workspace 文件端点族（list / directory / search / read / preview / zip）统一补 `requireCloudWorkspace` 拒绝 LOCAL，「LOCAL 会话 + 任意 workspace」的服务器读取面整族关闭（git 端点为历史遗留，不在本方案范围；测试与 changelog 同步固化，§8-1、§9-2）。

## 2. 需求描述

### 2.1 要做的（P1）

1. **正文图片改写统一**：删除 `toWorkspaceImageUrl` 的 LOCAL 早返回（`markdownImages.ts:43`），CLOUD / LOCAL 走同一 URL 形态；`MarkdownImageContext.executionMode` 字段本期保留（P2 桌面直读快路径的预留开关位，注释更新），消息侧传参不动。
2. **workspace-download LOCAL 分流**：端点内按 `session.executionMode` 分支——CLOUD 现状不动；LOCAL 走「按需委托读取」：校验（归属 + 相对路径 + 图片扩展名白名单）→ 经 WS 下发 `file_fetch` → 等待分片回传拼装 → 以 Buffer 响应（`Content-Disposition: attachment` + mime）。
3. **WS 消息对**：新增服务端→执行端 `file_fetch`（`{ requestId, path, workspace }`）与执行端→服务端 `file_fetch_result`（`{ sessionId, requestId, seq, total, data(base64) }`；可选 error 帧仅「未收到任何分片」前接受，**执行端失败一律静默不回包**）；服务端按 requestId 聚合分片，拼装完成一次性 `completeToolRequest` 回填 future。
4. **桌面执行端**：`useStreamWS` 增 `case 'file_fetch'` → 新 IPC `local-read-workspace-bytes`（**workspace + 相对路径**，主进程内拼装 + containment 校验 + 复用 `readFileBytes` 校验/上限）→ 渲染层按 512KB 分片 base64 回传。
5. **mao-agent 执行端**：`executor.ts` 增 `evt.type === 'file_fetch'` 分支 → `resolveWorkspace` 信任收窄 + containment + 白名单 + 上限 → 分片回传；**失败静默不回包**（评审补充，防异机多执行端 error 帧竞争）；不走审批（只读工作区内文件）。
6. **前端细节**：改写后的正文图片补 `loading="lazy"`（长消息多图时削峰，避免一次性几十个委托请求）；失败回退逻辑不动。
7. **文档同步**：changelog unreleased 碎片（**评审补充**：明示安全修复「LOCAL 图片不再直读服务器路径，顺带关闭任意 workspace 读取缺口」）、`skills/mao-cli/reference/desktop.md` 正文图片段落（CLOUD 之外补 LOCAL 口径与执行端在线前提）、mao-agent 需升级说明。

### 2.2 不做的（本期明确排除）

- **不做执行端主动上传**：不在任务期把工作区图片同步到服务端存储；字节仅在「有人查看」时按需中转（离线历史 / 归档不含图，见 §10-2）。
- **不做执行端离线时的图片渲染**：离线 → 端点报错 → 📎 回退（tooltip 保留原路径）。
- **不做 SVG**：扩展名白名单只收位图（svg 有脚本执行面与直接导航面，排除；见 D5）。
- **不做桌面直读快路径**：桌面 Electron 本可走 IPC blob 直读省一跳服务器往返，本期为三端一致性统一走委托通道（P2，见 §10-1）。
- **不做文件管理器 / 文件预览远程化**：浏览器 LOCAL 文件树 / PDF / xlsx 预览仍不可用；本通道通用化后可复用，P2（§10-3）。
- **不动工具审批链路**：`file_fetch` 是页面工具，不属于 Agent 工具调用，不进 `ToolDispatcher` / 审批 / 工具卡 / 消息记录。
- **不做缓存 / ETag / 断点续传**：与 CLOUD 现状同水位（§10-4）。

## 3. 技术选型（待评审确认后定案）

| # | 决策点 | 拟定 | 落选项与理由 |
|---|---|---|---|
| D1 | 端点形态 | **复用 `GET /v1/files/workspace-download`，端点内按 executionMode 分流** | 备选「新端点 `/files/local-workspace-download`」被否：前端要按模式分叉 URL，而复用方案前端只删一个早返回、图片 URL 三端同构，且鉴权 / 错误口径天然一致。路径参数语义同为「会话工作区相对路径」，分流是服务端实现细节 |
| D2 | 委托协议 | **新消息对 `file_fetch` / `file_fetch_result`** | 备选「复用 `tool_execute` + 内部保留工具名」被否：会误入审批评估（mao-agent `evaluateApproval`）、结果被 `persistToolResult` 持久化、污染工具时间线的风险，且「工具」语义不成立（页面发起的读取，非模型调用）。既有协议已有非工具帧先例（`skill_sync_required` / `mcp_sync_required`），新消息对符合惯例 |
| D3 | 结果传输 | **512KB 原始字节分片，各片独立 base64；服务端拼装** | `/ws/stream` 入站 1MB 上限（`attach-websocket.ts:19`）放不下 >750KB 的 base64 整帧，而 Agent 截图常超此值。备选「调大 maxPayload 至 ~24MB」被否：放宽的是**所有**入站帧的暴露面，为单一特性改全局安全姿态不值；分片只影响新特性。上限 10MB（20 片），与容器通道 30MB 上限同风格但更紧。**评审补充（两条传输硬约束，须写入常量注释与回归用例）**：分片帧**序列化后**必须同时满足 ① mao-agent `< 900KB`（`WS_TRUNCATE_AT_BYTES`，`ws-client.ts:44-76`——`data` 不在截断键表，超 1MB 会整体替换为无 `data` 的 `{type, truncated:true}` 存根，拼装侧按 requestId 未命中 / 缺 `data` 静默忽略）；② 服务端 `< 1MB`（`attach-websocket.ts:19`；桌面出站无截断，超限帧会**关闭整条 WS 连接**、丢失订阅态与流式）。512KB 原始字节 → base64 ≈699KB，同时满足两者；桌面发送侧加单片序列化长度断言，防未来调大分片重蹈覆辙（§8-8） |
| D4 | 超时与清理 | **15s 总窗口**；投递落空立即报错；断线清理复用 registry `failAllForSocket/Device/User` 全套 | fetch 是单文件读，不需要工具的 900s / ack 双窗口；15s 覆盖读盘 + 20 片回传（可靠队列每片一个 RTT）。超时由路由侧 race 后调 `completeToolRequestError` 收敛（同 `LocalToolExecutor.failPending` 模式） |
| D5 | 安全校验 | **服务端前置校验 + 执行端二次校验**：①相对路径（拒绝绝对 / `..` / 盘符 / 反斜杠）；②图片扩展名白名单（`png/jpg/jpeg/gif/webp/bmp/avif`，**排除 svg**）；③执行端拼装后 containment（解析结果必须在会话 workspace 内）+ 普通文件 + 非符号链接 + 10MB 上限 | 服务端校验挡掉明显恶意请求（不浪费 WS 往返）；执行端校验防「服务端数据被污染 / 请求被重放」的纵深（页面 origin 是远程服务器，执行端不能无条件信任下发的路径）。白名单双端同表：落 `shared/contracts` 或双端各自常量 + 同步用例（实现时定，倾向 contracts）。**评审补充**：①path 一律以 `/` 分隔，含 `\` 直接拒绝——前端 `SCHEME_OR_ROOT_RE` 不拒反斜杠（`markdownImages.ts:22`），UNC（`\\host\share\x.png`）与 `dir\file.png` 都会漏进 URL；②Windows containment 已验证可行（`path.win32.relative` 大小写不敏感，`..` 逃逸产出 `..\\` 前缀可拒），§8-6 盘符大小写用例可通过；③错误响应口径：除 1001 / 1002 走 401 / 403 外，业务失败一律 **HTTP 200 + 错误信封**（`common/http-error.ts:76-84`），ErrorCode 选用——参数缺失 `PARAM_MISSING`、校验类（相对路径 / 白名单）`PARAM_INVALID`，离线 / 超时 / 超限沿用 file.routes 现行惯例以 `PARAM_INVALID` 承载独立中文文案 |
| D6 | 响应头 | `Content-Disposition: attachment` + `mime-types` lookup（白名单扩展名必有 mime） | 与 CLOUD 下载同口径：attachment 防直接导航渲染（svg 之外的面）；`<img>` 内嵌渲染不受 disposition 影响 |
| D7 | 前端改动面 | **删 LOCAL 早返回 + 图片补 `loading="lazy"`**；`executionMode` 字段保留；回退逻辑不动 | URL 统一后**不存在方案期担心的异步竞态**（blob 方案才有「相对 src 先 404、blob 后到」的时序问题）：img src 一次到位，请求失败就是终态 → 既有 once error 回退语义不变。lazy 用 HTML 属性，不碰 `el-image-viewer`（zoom 用 `currentSrc`，兼容） |
| D8 | 桌面读取 IPC | **新增 `local-read-workspace-bytes`（参数 workspace + 相对路径，主进程拼装 + containment）** | 不放宽既有 `local-read-bytes`：它按绝对路径直通（`resolveWorkspacePath` 放行绝对路径，`main.cjs:1110-1115`），沿用等于给远程页面开任意文件读。新入口在主进程内 `path.resolve` 拼装并校验结果仍在 workspace 内，复用 `readFileBytes` 的普通文件 / 符号链接 / 上限校验（`localFileBytes.cjs` 拆分范式继续：containment 逻辑放可单测模块）。**不采纳 `currentWorkspace` 侧写**（`tool-execute` 会把下发 workspace 设为 currentWorkspace，`main.cjs:2571-2574`——fetch 是只读操作，不得产生状态副作用）。**评审补充（信任叙事不对称，如实写明）**：桌面 containment 以服务端下发的 workspace 为根——防「越出给定目录」（realpath 口径，含父级目录 symlink 逃逸），不防「给定目录任意」（mao-agent 侧有启动时信任根收窄 `resolveWorkspace`，桌面无对等物）。增量风险有限：既有 `tool-execute` 已授予服务端在桌面执行任意 shell 的能力（`main.cjs:2567+`）；差异写入方案而非掩盖 |
| D9 | mao-agent 实现 | `file_fetch` 分支：`resolveWorkspace` 收窄 + containment + 白名单 + `fs.readFile` + 分片回传；**一切失败静默不回包**；不走 `evaluateApproval` | 与桌面同语义。不进审批的理由：读取范围已被「会话 workspace + 图片白名单」约束，且审批弹窗会让每张图都需要人确认，产品上不成立（同理由服务端 `needApproval` 概念不适用于页面 fetch）。信任模型与 11-05 一致：请求只发给本人 WS 连接，结果只回本人。**评审补充（失败改静默）**：信任外 workspace / containment / 白名单 / 读盘失败（含回传中途失败）一律**静默不回包**（仅本地日志），对齐 `isOutsideTrust` 既有语义（`executor.ts:230-236`）——未绑定会话走用户级广播（`sendToLocalClients` 发给该用户全部 electron+cli 连接），异机多执行端都会收到 `file_fetch`，信任外端点回 error 帧会与合法执行端的分片竞争且先到先中止拼装；服务端 15s 超时自然收敛。服务端对 error 帧的兼容口径见 §4（仅未收到分片前接受，防历史 / 第三方实现） |
| D10 | 兼容与发布顺序 | **backend 先行 → desktop dist → agent-cli 发版**；旧执行端不识 `file_fetch` 静默忽略（`dispatch` default 分支）→ 服务端 15s 超时报错 → 前端 📎 | 旧桌面 dist / 旧 CLI 连新后端：功能降级为现状（📎），无坏状态；新 dist / 新 CLI 连旧后端：不会收到 `file_fetch`，零影响。mao-cli 文档注明「LOCAL 正文图片需桌面 / mao-agent 升级到对应版本」 |
| D11 | 并发与削峰 | 前端 `loading="lazy"`；**per-user 在途 fetch 软上限 8**，超出立即报错 | **评审补充（修订原「不做上限」结论）**：每个在途请求的拼装缓冲 ≤10MB、完成瞬间还有 ≈13.3MB 的 base64 字符串过 registry future（单请求瞬时峰值 ≈3 倍原始大小），不做上限时自伤型并发可放大服务器内存；软上限 8 配合浏览器对同源 ≈6 并发请求的天然限流，正常浏览不会触顶，触顶图片 📎 回退。硬上限换内存安全，值得。执行端读取仍靠 lazy + 毫秒级同步读兜住 |
| D12 | 安卓 | 零原生改动：Capacitor 远程加载同一 web dist，自动获得同能力 | 与 11-17 方案 D9 同口径 |

## 4. 帧协议与常量

| 项 | 值 | 说明 |
|---|---|---|
| `file_fetch`（服务端→执行端，`wsEvent` 信封） | `{ type: 'file_fetch', sessionId, data: { requestId, path, workspace } }` | **评审补充（信封形态区分）**：服务端下发行经 `wsEvent` 是 `{type, sessionId, data:{…}}` 嵌套（桌面 `routeEvent` 读 `msg.data`、mao-agent 读 `evt.data`）；执行端→服务端帧按仓库惯例顶层平铺（同 `handleToolResult` 读 `root.requestId`）。`path` 为工作区相对路径（服务端已过白名单，`/` 分隔）；`workspace` 为会话工作区绝对路径（执行端 containment 基准） |
| `file_fetch_result`（执行端→服务端，顶层平铺） | `{ type, sessionId, requestId, seq, total, data }` | `seq` 从 1 起；每帧 `data` 为该片独立 base64。重复 / 迟到帧按拼装服务 active Map 未命中静默忽略（对齐 `completeToolRequest` 单次 resolve）。**评审补充（失败帧口径）**：执行端一切失败**静默不回包**（D9）；协议保留可选 error 帧 `{ type, sessionId, requestId, error }` 但服务端仅在该 requestId **尚未收到任何分片**时接受——防异机多执行端竞争误杀合法分片；mao-agent 超限存根帧（无 `data`、`truncated: true`）同样静默忽略 |
| 常量 | `FILE_FETCH_CHUNK_BYTES = 512 * 1024`（原始字节/片）、`FILE_FETCH_MAX_BYTES = 10 * 1024 * 1024`、`FILE_FETCH_TIMEOUT_SECONDS = 15`、图片扩展名白名单 `png/jpg/jpeg/gif/webp/bmp/avif` | 512KB → base64 ≈683KB，**序列化后 ≈699KB < mao-agent 900KB 截断线、< 服务端 1MB maxPayload**（D3 两条硬约束）；总量 10MB = 20 片 |
| 拼装校验 | `total ≤ 20`、`seq` 连续且不重复、单片 base64 解码 ≤ 512KB（留余量）、可选 error 帧仅在未收到分片前接受、**首片锁定来源连接（socketId）**——异源分片静默丢弃，防未绑定会话广播下多执行端交织拼坏图 | 拼装缓冲由 `LocalFileFetchService` **自持 active Map 判定活跃**（**评审补充**：判定主体是拼装服务自身的 requestId Map 而非 registry——registry 无「requestId 是否活跃」查询 API，只依赖它会让迟到分片在已收敛请求上继续累积缓冲）；任何缺口立即失败该 requestId |

**评审补充（拼装缓冲生命周期与内存上界）**：active Map 条目带 TTL 清扫（>30s 未完成即丢弃并 `completeToolRequestError` 收敛 registry future）；路由 15s race 超时路径显式 abort（删 Map 条目 + `completeToolRequestError`）；完成 / 失败即删条目。单在途请求瞬时峰值 ≈10MB 缓冲 + ≈13.3MB base64 字符串（registry future 完成瞬间，路由侧解码为 Buffer 后即可释放），per-user 在途软上限 8（D11）兜内存上界。

## 5. 实现步骤

### 5.1 后端（backend-ts）

1. **注册表扩展**（`backend-ts/src/harness/local/local-tool-session-registry.ts`）
   - 新增 `sendFileRequest(sessionId, relativePath, workspace): Promise<PendingLocalToolRequest>`：复用 `sendToolRequest` 的目标解析 / 可达性判定 / dispatchedSocket 记录 / 投递落空立即报错全套，仅帧类型与 payload 不同（无 `needApproval / dangerReason`）；`pendingRequests` / `completeToolRequest(Error)` / `failAllFor*` 原样复用。实现上抽公共私有方法，`sendToolRequest` 行为不变（回归保障）。
2. **分片拼装服务**（新文件 `backend-ts/src/harness/local/local-file-fetch.service.ts`，`localFileBytes.cjs` 同款「可单测模块」范式）
   - `fetch(sessionId, relativePath, workspace): Promise<{ bytes: Buffer, fileName: string, mime: string } | { error: string }>`：前置校验（白名单 / 相对路径 / **per-user 在途软上限 8**，D11）→ `registry.sendFileRequest` → future race 15s → 返回拼装结果。
   - `handleChunk(sessionId, requestId, frame)`：**以自持 active Map 判定活跃**（未命中静默丢弃——覆盖迟到帧、超时后分片、mao-agent 截断存根帧）；校验 `total/seq/data` 合法性与连续性；拼装完成后 `registry.completeToolRequest(sessionId, requestId, JSON.stringify({ base64 }))`。**完整字节只在此模块内存缓冲，registry future 只见最终字符串**——registry 语义零变化。
   - **评审补充（生命周期定死）**：Map 条目在「完成 / 可选 error 帧 / TTL 清扫（>30s）」时删除；路由 15s race 超时路径显式调 `service.abort(requestId)`（删条目）+ `registry.completeToolRequestError`（对齐 `LocalToolExecutor.failPending`）；registry `failAllForSocket/Device/User` 断线收敛 resolve future（错误 JSON）后，残留缓冲条目由 TTL 清扫兜底回收。内存上界口径见 §4。
   - 离线错误文案独立常量：`LOCAL_EXECUTOR_OFFLINE_FILE_ERROR = '本地执行端未连接，无法读取本地文件'`（不混用工具文案）。
3. **路由分流**（`backend-ts/src/file/file.routes.ts:218-226`）
   - `workspace-download` 内：`session.executionMode === 'LOCAL'` → `localFileFetchService.fetch(...)`；成功 → 新增 `sendBuffer(reply, buffer, fileName, mime)` 助手（`Content-Disposition: attachment` + `Content-Length` + `reply.send(buffer)`，`sendFile` 的 Buffer 变体）；失败 → `BusinessException`（离线 / 超时 / 不存在 / 超限，各自文案）。
   - CLOUD 分支与 `experienceDirOf` 逻辑不动；LOCAL 分支不涉及经验挂载。
   - 依赖注入：`FileRouteDeps` 增 `localFileFetchService`，装配点在 `create-app.ts`（与 `localToolSessionRegistry` 同处）。
4. **WS 入站路由**（`backend-ts/src/session/ws/streaming-ws-handler.ts:644-655`）
   - `case 'file_fetch_result': await this.handleFileFetchResult(session, userId, root)`：校验会话归属（同 `handleToolResult` 的 `requireOwnedSession` 口径，`:1223-1230`）→ `localFileFetchService.handleChunk(..., session.id)`（首片锁定来源连接）。未知 requestId / 迟到帧 / mao-agent 截断存根帧（缺 `data`）静默忽略。
5. **测试**：routes LOCAL 分支（成功 / 离线 / 超时 / 超限 / 非白名单 / `..` 与反斜杠路径拒绝 / CLOUD 回归；**评审补充**：断言 LOCAL 分支**不触碰服务器文件系统**——mock `workspaceBrowseService.downloadFile` 不得被调用，固化安全缺口关闭）、拼装服务（分片连续性 / 重复片 / 缺口 / total 超限 / 存根帧与迟到帧忽略 / **error 帧仅未收到分片前接受** / TTL 清扫）、registry `sendFileRequest`（投递落空 / 断线 failAll）、端到端 WS 用例、**评审补充**：异机双执行端竞争（信任端静默失败不影响合法端拼装成功）。

### 5.2 桌面执行端（desktop，Electron 壳 + 渲染层同 dist）

1. **主进程**（`desktop/electron/main.cjs` + 新模块）
   - 新 IPC `local-read-workspace-bytes`（参数 `{ workspace, path }`）：主进程内 `path.resolve(workspace, relative)` 拼装 + containment 校验（**realpath 口径**：root 与目标都 `fs.realpathSync` 归一后 `path.relative` 比对——workspace 内父级目录 symlink 指向外部时穿出词法校验，realpath 后即拒，对齐 agent-cli `isWorkspaceWithin`；校验函数放可单测模块 `localWorkspaceRead.cjs`，遵循 `localFileBytes.cjs` 拆分范式）→ 复用 `readFileBytes`（普通文件 / 符号链接 / 上限校验，默认收紧为 10MB 功能上限）→ 返回 `{ bytes: Uint8Array, size }`。绝对路径 / `..` / 越界一律拒绝。
   - `preload.cjs` 增 `localReadWorkspaceBytes`；`electron.d.ts` 同步类型。
2. **渲染层 WS 分支**（`desktop/src/composables/useStreamWS.ts`，紧邻 `case 'tool_execute'` `:1319`）
   - `case 'file_fetch'`：仅 Electron 分支处理（浏览器 / 安卓标签页不会收到该帧，`LOCAL_ONLY` 投递保证；仍保留 `electronAPI` 存在性守卫）→ `localReadWorkspaceBytes` → 成功：切片（512KB 原始字节）逐片 `sendReliable({ type: 'file_fetch_result', sessionId, requestId, seq, total, data })`；失败：静默不回包（对齐 D9 口径，服务端超时收敛）。
   - **评审补充（实现约束）**：`routeEvent` 是同步函数（`useStreamWS.ts:739`），`file_fetch` case 内 fire-and-forget promise 链（同 `tool_execute` `:1322-1350` 范式），20 片发送循环不得阻塞同连接后续帧；发送前断言单片序列化长度 < 900KB（防未来调大分片踩 mao-agent 截断坑，§8-8）；回传中途断线时 sendReliable 的 15s 重连窗口 > 服务端 15s 总窗口，表现为该次 fetch 失败（可接受）。
   - **不写 `currentWorkspace`**、不走 `toolExecute` IPC / 审批。
3. **前端改写**（`desktop/src/utils/markdownImages.ts` + 测试）
   - 删 `:43` 的 LOCAL 早返回，注释改为「LOCAL 会话经 workspace-download 由后端按需委托执行端读取」。**评审补充（注释同步三处）**：`markdownImages.ts:17`（接口字段注释「LOCAL 会话的工作区在本机，服务端读不到，不做改写」）、`MarkdownContent.vue:43`（`sessionExecutionMode` prop 注释）与 `:40-41`（`sessionId` prop 注释里的 LOCAL 表述）一并更新，否则注释与行为矛盾；`executionMode` 字段保留（P2 桌面快路径开关位）。
   - `decorateMarkdownImages` 内对成功改写的 img 补 `loading="lazy"`。
   - `markdownImages.dom.test.ts`：LOCAL 会话改写成功用例（原「LOCAL 不改写」用例反转，`:57-58`、`:85-87`）；失败回退用例沿用。
4. **测试**：containment 模块单测（正常 / `..` / 绝对路径 / 盘符 / workspace 尾分隔符）、`useStreamWS` 分支单测（mock electronAPI：成功分片序列、读失败断言不发送任何帧、无 electronAPI 忽略）、`npm run build`。

### 5.3 mao-agent（agent-cli）

1. **执行分支**（`agent-cli/src/local/executor.ts`，事件分发 `:181-191` 增 `file_fetch`）
   - `resolveWorkspace(d.workspace)` 收窄（复用 `:218-228`）→ containment（resolve 结果在信任工作区内）→ 扩展名白名单 → `fs.readFile`（10MB 上限前置）→ 分片 `ws.sendReliable`（**单片序列化后 < 900KB**，绕开 `serializePayload` 截断 / 存根路径，`ws-client.ts:44-76`）。
   - **评审补充（失败静默不回包）**：信任外 workspace / containment / 白名单 / 读盘失败 / 回传中途失败一律**静默不回包**（仅本地日志），对齐 `isOutsideTrust` 既有语义（`:230-236`）；`persistToolResult` 不涉及（该函数仅在 `tool_execute` 分支调用，`file_fetch` 是独立分支，不会被误持久化）。
   - 不进 `evaluateApproval`（D9）；`finally` 清理与工具分支无关（无 approvalSessions 登记）。
2. **测试**：信任边界外 workspace / `..` / 绝对路径 / 非白名单 / 超限 → 断言**不发送任何帧**（静默）；正常分片序列（片数、seq、序列化尺寸 < 900KB 回归）；`npm test`。

### 5.4 数据库

- **无迁移**：不新增列 / 表；复用 `session.workspace / execution_mode`。

### 5.5 安卓（android）

- 零改动：远程加载 web dist 自动获得（D12）；不涉及 `MainActivity.java` / OTA / `capacitor.config.json`。

## 6. 落地清单

| 端 / 文档 | 项 |
|---|---|
| backend-ts | `harness/local/local-tool-session-registry.ts`（`sendFileRequest`）、`harness/local/local-file-fetch.service.ts`（新）、`session/ws/streaming-ws-handler.ts`（`file_fetch_result` case）、`file/file.routes.ts`（LOCAL 分流 + `sendBuffer`）、`create-app.ts`（装配） |
| contracts | 图片扩展名白名单常量（双端共用；落点实现时定，倾向 `shared/contracts`） |
| desktop | `electron/main.cjs`（新 IPC）+ `electron/localWorkspaceRead.cjs`（containment，可单测）+ `electron/preload.cjs` + `src/types/electron.d.ts`、`src/composables/useStreamWS.ts`（`file_fetch` 分支 + 分片回传）、`src/utils/markdownImages.ts`（删 LOCAL 早返回 + lazy）、`markdownImages.dom.test.ts` 更新 |
| agent-cli | `src/local/executor.ts`（`file_fetch` 分支）+ 单测 |
| android / 迁移 | 无改动 / 无迁移 |
| 测试 | 见 §8 |
| 文档 | `changelog/unreleased/2026-11-18-local-workspace-images-cross-client.md`（后端 + 前端（桌面 / Web / 安卓）小节）；`skills/mao-cli/reference/desktop.md` 正文图片段落；mao-agent 升级要求说明 |

## 7. 风险与回归护栏

| 风险 | 护栏 |
|---|---|
| 执行端离线（看历史 / 关机） | `sendFileRequest` 投递落空 / `isConnected` 失败立即报错（不悬挂）；端点返回错误 JSON → img error → 📎 回退，tooltip 保留原路径。用户感知：离线时与现状一致 |
| 旧执行端不识 `file_fetch` | 静默忽略（dispatch default）→ 服务端 15s 超时 → 📎。发布顺序 backend→dist→agent-cli（D10）；无坏状态 |
| **评审补充**：未绑定会话用户级广播下异机多执行端竞争 | 信任 / containment / 白名单 / 读盘失败一律**静默不回包**（D9，对齐 skill/MCP 先例）；合法执行端的分片先到先得完成拼装，信任外端点不会以 error 帧误杀；服务端 error 帧仅在未收到分片前接受（§4 兜底） |
| **评审补充**：mao-agent 超限帧被 `serializePayload` 替换为无 `data` 存根 | 分片常量以「序列化后 < 900KB」为硬约束（D3）+ 双端回归用例固化；拼装服务对缺 `data` 帧静默忽略，不会误拼 |
| **评审补充**：桌面超限帧断整条 WS 连接（订阅态 / 流式全丢） | 同上——分片尺寸硬约束 + 桌面发送前单片序列化长度断言（§5.2-2） |
| 大图 / 慢网超 15s | 执行端失败静默 → 服务端超时 → 📎 回退；不重试（与 CLOUD 流式期间文件未写完同水位）。§10-4 记超时自适应 |
| 分片拼装异常（重复 / 缺口 / 超限 / 存根 / 迟到） | 拼装服务严格校验 total/seq/片大小，任何缺口立即失败该请求；active Map 未命中静默丢弃；TTL 清扫兜底回收（§4 生命周期） |
| **评审补充**：拼装缓冲内存放大（单请求瞬时 ≈3 倍原始大小） | per-user 在途软上限 8（D11 修订）；TTL + abort 双清理路径；字节缓冲完成瞬间转 Buffer 释放字符串引用 |
| 恶意相对路径（`..` / 绝对 / 盘符 / 反斜杠 / UNC） | 服务端前置拒绝（含 `\` 一律拒）+ 执行端 containment 双校验（D5/D8/D9）；桌面新 IPC 不放宽既有 `local-read-bytes` 的绝对路径口子 |
| **评审补充**：现存缺口——LOCAL 会话 + 任意 workspace 被服务端直读 | 本方案 LOCAL 分流后 `workspace-download` 不再触碰服务器文件系统，缺口顺带关闭；测试断言 `downloadFile` 在 LOCAL 分支不得被调用（§8-1），changelog 明示（§9-2） |
| svg / 非位图绕过 | 扩展名白名单排除 svg（D5）；响应 `attachment` disposition 兜直接导航面（D6） |
| 字节经服务器中转的隐私观感 | 与 LOCAL 工具结果 / 审批流 / 云端 `read_bytes` 同信任模型（本人 WS 通道、服务端不落盘不存库）；changelog 明示「查看本地图片时文件内容会经服务器中转、不存储」 |
| 多端同看同一会话 | 各端各自请求、各自委托一次；同 requestId 重复回包由单次 resolve 兜底（现状语义） |
| 长消息多图并发请求 | `loading="lazy"` 削峰；**per-user 在途软上限 8**（D11 评审修订，兜拼装缓冲内存上界），触顶图片 📎 回退；委托 future 轻量；执行端同步读毫秒级 |
| 流式期间图片先于文件写入 | 请求失败即终态（once error 回退不重试；LOCAL 失败静默需等 15s 超时才回退）——与 CLOUD 现状同水位，非回归 |
| CLOUD 回归 | CLOUD 分支代码路径不动；routes 测试含 CLOUD 回归用例 |
| 执行端主进程被大图拖慢 | 10MB 上限 + 毫秒级同步读；P2 可改异步读（§10-6） |

## 8. 测试要点

**后端（`cd backend-ts && npm test`）**

1. `workspace-download` LOCAL 分支：执行端在线且返回分片 → 200 + 正确 mime / disposition / 字节；执行端离线 → **评审补充（断言口径修正）**：业务失败是 **HTTP 200 + 错误信封 code≠0**（`common/http-error.ts:76-84` 仅 1001/1002 → 401/403），文案为独立离线常量；超时 / 超限同口径；`..` / 绝对 / 反斜杠路径 / 非白名单扩展名 → 200 + `PARAM_MISSING/PARAM_INVALID` 信封且**不下发 WS 帧**；**评审补充**：LOCAL 分支断言 `workspaceBrowseService.downloadFile` **不得被调用**（固化安全缺口关闭）；CLOUD 会话走原路径回归；未登录 401。
2. `LocalFileFetchService`：分片顺序拼装；重复片忽略；缺口立即失败；`total` 超限失败；**评审补充**：mao-agent 截断存根帧（缺 `data`）与迟到帧（requestId 已收敛）静默忽略；error 帧仅在未收到分片前接受；**TTL 清扫**（>30s 条目回收并收敛 future）；per-user 在途软上限 8（第 9 个立即报错）。
3. registry `sendFileRequest`：投递落空立即错 future；`failAllForSocket/Device/User` 收敛在途 fetch；`completeToolRequest` 单次 resolve。
4. WS 路由：`file_fetch_result` 未登录 / 非归属会话拒绝；未知 requestId 静默。

**桌面（desktop 单测 + `cd desktop && npm run build`）**

5. containment 模块：正常相对路径解析；`..` 逃逸拒绝；绝对路径拒绝；workspace 带尾分隔符 / Windows 盘符大小写。
6. `useStreamWS` `file_fetch`：成功 → 分片序列（片数、大小、seq 正确，单片序列化 < 900KB）；读失败 → 断言不发送任何帧（静默）；无 `electronAPI` → 忽略。
7. `markdownImages`：LOCAL 会话改写成功（含 token / lazy 属性）；失败回退沿用既有用例；CLOUD 用例回归。

**mao-agent（`cd agent-cli && npm test`）**

8. `file_fetch`：信任内正常读取与分片（**评审补充**：断言每片序列化后 < 900KB，固化分片尺寸与 `serializePayload` 的兼容回归）；信任外 workspace / containment / 白名单 / 超限 / 读盘失败 → 断言**不发送任何帧**（静默，对齐 `isOutsideTrust` 先例）。

**手工联调（必须）**

9. 桌面端建 LOCAL 任务让 Agent 截图 → 浏览器打开同一会话：正文图片渲染、点击放大可用；桌面端同会话同样渲染（此前也不渲染，属修复）。
10. mao-agent 为执行端的 LOCAL 任务：浏览器看图同链路。
11. 执行端离线后打开会话：图片为 📎 回退（非裂图，等 15s 超时）；设备上线后刷新恢复渲染。
12. 安卓 WebView 同链路；CLOUD 会话图片回归（桌面 / 浏览器 / 安卓）。
13. 旧版本桌面 dist + 新后端：图片 📎（兼容降级），升级 dist 后恢复。
14. **评审补充**：异机场景——桌面（A 机）与 mao-agent（B 机）同账号在线、未绑定会话广播：信任外的一端静默、信任内的一端正常出图；两端同 workspace 同图时先到者完成拼装。

## 9. 发布与文档

1. **发布顺序**：部署 backend-ts（新消息对 + 端点分流）→ `bash scripts/deploy-desktop.sh`（web / Electron / 安卓共用 dist）→ mao-agent 发版（`npm` 包 / `npm link` 用户自更新）。中间态均降级为现状 📎，无坏状态（D10）。
2. **CHANGELOG**：`changelog/unreleased/2026-11-18-local-workspace-images-cross-client.md`——后端：workspace-download 支持 LOCAL 会话按需委托执行端读取（`file_fetch` 委托帧），**并明示安全修复「LOCAL 图片不再直读服务器路径，顺带关闭『LOCAL 会话 + 任意 workspace』的服务器目录读取缺口」**（评审发现）；前端（桌面 / Web / 安卓）：本地任务正文图片在所有客户端渲染（需执行端在线；离线显示占位文本）；终端 CLI（mao-agent）：支持 `file_fetch` 委托帧（需升级）。明示「查看时文件内容经服务器中转、不存储」。
3. **mao-cli 文档**：`skills/mao-cli/reference/desktop.md` 正文图片段落补 LOCAL 口径（执行端在线前提、mao-agent 版本要求）。
4. **回滚**：代码回滚即可，无数据副作用（服务端不落盘不存库；无迁移）。

## 10. 开放问题（不阻塞主链路）

1. **桌面直读快路径**：Electron 渲染层本可 `localReadBytes` → blob URL 直读本机文件省一跳服务器往返；URL 统一后以 `executionMode` 字段作开关位，P2 评估。
2. **执行端主动上传**：任务期把回复引用的图片同步到服务端（离线历史 / 归档 / 分享可看图），但改变「文件不出本机」语义且需上传时机 / 去重 / 清理设计，独立方案。
3. **通道通用化**：去掉图片白名单后同一消息对可支撑浏览器端 LOCAL 文件管理 / 预览（FileViewer `readFileBytes` 的 LOCAL provider 在浏览器是空实现）；需重新评估滥用面与尺寸上限，P2。
4. **缓存与重试**：同一 URL 重复查看重复委托；任务中改图后的浏览器缓存陈旧；流式期间失败不重试。可考虑 ETag / 版本参数 / 失败短重试，按实际反馈排期。
5. **并发上限**：已按评审加 per-user 在途软上限 8（D11 修订）；执行端侧的按设备并发限制 / 队列化需实际数据支撑，P2。
6. **执行端异步读**：桌面 `readFileBytes` 是 `readFileSync`（阻塞主进程），大图并发时可能卡 UI；10MB 上限下影响有限，P2 改 `fs.promises`。
