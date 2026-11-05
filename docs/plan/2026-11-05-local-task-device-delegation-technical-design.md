# 本地任务跨设备委托技术方案（桌面端 / CLI 创建，浏览器可接管对话）

- 状态：草案（2026-11-05；§3 决策为拟定口径，评审通过后定案）
- 评审记录：2026-11-05 完成可行性评审，结论「**可行**」（委托链路已通、服务端本就允许浏览器对 LOCAL 会话发消息，主体确为「加设备维度」）。本版已按评审意见补齐若干不完善点（各处标注「**评审补充**」：派生继承第 3 站点、delegate 侧调用点、desktopPrefs 白名单坑、D15-② 平台校验、孤立绑定恢复、契约与类型落点、POST 校验为新增、removeSession 清理、enrichSessions 唯一装配点）。**本轮不进入功能开发。**
- 日期：2026-11-05
- 关联方案：
  - [2026-11-03-session-source-client-form-technical-design.md](./2026-11-03-session-source-client-form-technical-design.md)（客户端形态来源 `desktop / cli / android / web`，本方案依赖其 WS `client` 词表，不修改来源体系）
  - [2026-11-03-file-viewer-and-git-ux-polish-technical-design.md](./2026-11-03-file-viewer-and-git-ux-polish-technical-design.md)（工作区/文件侧近期口径，本方案不涉及文件树/终端/Git 代理）
- 能力底座（撰写时已存在的实现，全部复用、不重写）：
  - 委托通道：`LocalToolSessionRegistry.sendToolRequest()` → `StreamingWsRegistry.sendToLocalClients(userId, tool_execute)`（`backend-ts/src/harness/local/local-tool-session-registry.ts`、`backend-ts/src/session/ws/streaming-ws-registry.ts`）
  - 本地执行端白名单：`LOCAL_CAPABLE_CLIENTS = new Set(['electron', 'cli'])`（`streaming-ws-registry.ts`）
  - 客户端执行：`useStreamWS.ts` 的 `case 'tool_execute'` → `electronAPI.toolExecute` → `tool_result` / `tool_error` 回传（`desktop/src/composables/useStreamWS.ts`）
  - 主进程执行与审批：`main.cjs` 的 `ipcMain.handle('tool-execute')`、`requestToolApproval()`（`desktop/electron/main.cjs:2446` 起）
  - 分发分支：`executionMode === 'LOCAL'` 时全部工具走 `localToolExecutor`（`backend-ts/src/harness/tool/tool-dispatcher.ts:305`）
  - 会话模式落库与校验：`createSession` 按传入值落库（`session.service.ts:137`）；`assertOwnedSessionWorkspace` 对 LOCAL 跳过路径归属校验（`session.routes.ts:666-672`）
  - 浏览器端现状防线（**本方案只放开发送拦截两处（`useChat.ts` / `ChatInput.vue`），创建入口的禁选保持不动**）：`useChat.ts:343`、`ChatInput.vue:1129`、`WorkspaceChip.vue:203`
  - 权限等级：`PATCH /v1/sessions/:id { permissionLevel }` 已存在（`desktop/src/components/chat/ChatPanel.vue:799`）
  - 桌面持久化：`desktopPrefs.cjs`（机器级、不随服务器切换，`userData/desktop-prefs.json`）
- 本方案定位：**不新增执行模式**，保持 LOCAL / CLOUD 两种（D1）。把 LOCAL 任务的「执行端」从「发起端本机」收敛为「会话创建时绑定的执行端设备（桌面 Electron / mao-agent CLI）」，工具调用经服务端**定向**委托给该设备执行。**LOCAL 会话只能由桌面客户端或 CLI 创建**（创建即绑定本机设备，不支持改绑）；浏览器（含移动端）**不能创建 LOCAL 会话，但可以打开已存在的 LOCAL 会话继续对话**（发送消息、切审批等级、看结果），CLI 创建的 LOCAL 会话同样可被浏览器接管对话。权限等级与审批完全沿用会话当前设置。**不做**跨用户防护、审计、denylist、授权开关与配对码（用户已明确，见 §2.2）。

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 执行端 / 设备 | 运行桌面客户端或 mao-agent CLI、已登录当前账号并保持 WS 长连接的机器 |
| 发起端 | 创建会话、发送消息的客户端：Electron、浏览器（web）、安卓、CLI；其中 LOCAL 会话的创建端仅限 Electron / CLI |
| 设备委托 | 服务端把 LOCAL 会话的工具调用通过 WS 下发给指定设备执行、等待结果回传 |
| 定向发送 | `tool_execute` 只发给会话绑定的目标设备连接，而非当前实现的「该用户全部 local 连接」广播 |

## 1. 需求背景

### 1.1 现状

| 设施 | 现状 | 证据 |
|---|---|---|
| 委托通道 | 已完整存在：服务端 Agent 决策 → `tool_execute` 下发 → 客户端执行 → `tool_result` 回传 | `local-tool-session-registry.ts`、`useStreamWS.ts` |
| 下发目标 | **用户级广播**：`sendToLocalClients(userId)` 发给该用户所有 `electron` / `cli` 连接 | `streaming-ws-registry.ts` 的 `deliver()` `LOCAL_ONLY` 分支 |
| 在线判定 | **用户级**：`hasLocalClientConnection(userId)` 只要有一台 local 端在线即通过 | `local-tool-session-registry.ts` 的 `isConnected()` |
| 设备身份 | **不存在**：WS 握手只有 `client=electron\|cli\|browser\|android`，无 deviceId、无设备名、无平台 | `streaming-ws-handler.ts` 的 `auth` 分支、`useStreamWS.ts` 握手帧 |
| 会话绑定 | 无：会话只有 `executionMode`，`workspace` 是创建时写死的绝对路径 | `session.service.ts:137`、`createSession` |
| 浏览器防线 | 仅前端三处拦截（禁选 LOCAL / **禁发，且不区分新建与已有会话** / 切换提示），**服务端无校验**；绕过 UI 直连 API 即可广播执行 | `useChat.ts:343`、`ChatInput.vue:1129`、`WorkspaceChip.vue:203` |
| 多端并存 | 同一账号两台机器同时在线时，一条 `tool_execute` 会在**两台机器上重复执行**（结果取第一个 `tool_result`） | `sendToLocalClients` 广播 + `completeToolRequest` 按 requestId 单次 resolve |
| 技能 / MCP 同步 | 同样走 `sendToLocalClients` 广播（技能包会同步到每台设备） | `streaming-ws-handler.ts:2196`、`:2235` |
| 附件 / 本地技能 | LOCAL 模式的文件是「拷贝到本机 Mao 目录」，本地技能由发送端在自己消息帧里上报；浏览器发送时两者均不可用 | `useChat.ts:435`、`:715`、`collectLocalUnsyncedSkills` |
| 审批口径 | `shouldRequireApproval` 按会话 `permissionLevel` 决定；`FULL` 免审批（`needApproval: false`）；审批卡在**执行设备本地**弹出 | `tool-dispatcher.ts:612`、`main.cjs` 的 `requestToolApproval` |

### 1.2 问题

1. **浏览器端无法接管已有的本地会话**：服务端其实已允许浏览器对 LOCAL 会话发送消息（`isConnected` 只看 userId 级在线），前端却按「浏览器 = 不能用 LOCAL」一刀切拦截，导致「桌面端建好的本地任务，换到浏览器就发不出消息」。同时因为服务端无校验，绕过 UI 又能广播执行——能力已通、产品不通、边界不清。
2. **没有设备维度，指令找不到人**：无法回答「这条本地任务在哪台电脑上跑」；多设备在线时广播执行会重复副作用（如在两台机器上各自 `git pull`）；用户也无法选择「在我公司那台 Mac 上执行」。
3. **跨设备工作区语义缺失**：`workspace` 是某台机器的绝对路径；浏览器打开 LOCAL 会话时既无法使用也无法修改它，需要明确「只读展示、由创建端决定」的口径（D8），并让用户在 UI 上看得懂这条路径属于哪台设备。
4. **浏览器侧的产品能力不完整**：执行模式、工作区、附件、本地技能、终端/文件树等 UI 全部以「Electron 本机」为前提；其中**审批等级切换**（`PATCH permissionLevel`）服务端已支持、UI 已有组件，但需要放开「浏览器 + 已有 LOCAL 会话」组合并补一致性回归（用户已点名要求支持）。
5. **技能 / MCP 广播副作用**：技能同步包当前会下发到该用户每台设备；设备化后应只同步到目标设备。
6. **历史本地会话没有设备归属**：新版本之前创建的 LOCAL 会话没有 `target_device_id`——既无法定向，也无法说明「在哪台机器上执行」。批量回填没有可靠判据（`platform / shellPath / osVersion` 在同型号机器上完全相同），人工逐条确认成本高且不可持续。

### 1.3 机会

- 委托链路是现成的（下发、执行、审批、回传、超时清理均有），本方案主体是**加设备维度**而非重建通道；改动集中在注册表、会话字段与前端 UI。
- `LOCAL_CAPABLE_CLIENTS` 已纳入 `cli`：桌面客户端与 mao-agent 可共用同一套设备身份与定向逻辑，后续不需要为 CLI 单开通道。
- `desktopPrefs.cjs` 已是机器级持久化（不随服务器切换），deviceId 落在这里零新增基础设施；CLI 侧同理可落 `~/.mao/`。
- 前端只放开「已有 LOCAL 会话的发送」这一条，创建入口的 LOCAL 禁选保持不动；产品面可保持对话形态不变：桌面端 / CLI 照旧新建本地任务并自动绑定本机，浏览器打开同一会话即可继续对话。

## 2. 需求描述

### 2.1 要做的

1. **P1 执行端设备身份**：桌面 Electron 与 mao-agent CLI 在 WS 握手 `auth` 帧上报 `device: { id, name, platform }`；`id` 客户端生成并持久化（桌面：`desktopPrefs.json`；CLI：`~/.mao/` 结构内），`name` 取 `os.hostname()`（不做自定义命名）。服务端注册表记录「连接 → 设备」，设备维度维护「用户 → 设备 → 最新执行连接」。
2. **P1 设备注册表与在线状态**：`StreamingWsRegistry` 新增设备索引与 `sendToDevice(userId, deviceId, event)` / `hasDeviceConnection(userId, deviceId)`；同一 `deviceId` 重复注册时**覆盖为最新连接作为执行连接**（同机多窗口/多实例不重复执行）。
3. **P1 会话创建即绑定目标设备（不可改绑）**：`session` 表新增 `target_device_id` + `target_device_name`（name 为创建时快照）；`POST /v1/sessions` 的 LOCAL 分支接受并落库；会话 VO/详情返回 `targetDeviceId / targetDeviceName / targetDeviceOnline`（online 由服务端实时查注册表）。Electron 与 CLI 创建 LOCAL 会话时带**本机** deviceId；浏览器不创建 LOCAL 会话；`PATCH` 不提供改绑。
4. **P1 定向委托**：`LocalToolSessionRegistry` 增加目标设备绑定；`sendToolRequest` 在会话有绑定设备时 `sendToDevice` 定向发送，无绑定时先尝试惰性认领（D15），认领不了（纯旧端环境）才回退现状广播。LOCAL 在执行前的在线检查（`streaming-ws-handler` 中发送 / 重试 / 边路 / 子代理各处 `isConnected`）统一改为**设备级**：绑定了设备检查该设备，未绑定保持用户级。
5. **P1 技能与 MCP 同步定向**：`skill_sync_required`、`mcp_sync_required` 从 `sendToLocalClients` 广播改为「有绑定设备 → 定向，无绑定 → 广播回退」。
6. **P1 浏览器端产品化（只接管、不新建）**：放开「已有 LOCAL 会话」的发送链路（`ChatInput.vue:1129` 与 `useChat.ts:343` 的拦截改为「仅新建态生效」）；**新建态的 LOCAL 禁选与模式切换拦截保持现状**；会话内展示「本地任务 · 设备名（在线/离线）」标识；浏览器在 LOCAL 会话里可正常切审批等级。不引入设备选择器与目录选择 UI。
7. **P1 设备在线状态随会话返回**：不新增设备列表接口；会话 VO 附带 `targetDeviceOnline`（注册表实时 `hasDeviceConnection(userId, targetDeviceId)`），无绑定时为 null；前端据此展示在线/离线并阻止向离线设备发送。
8. **P1 浏览器侧审批等级切换**：浏览器打开的 LOCAL 会话，`PermissionLevelSwitcher` 可正常切换并 `PATCH /sessions/:id`（服务端已支持，补齐回归与文案）；权限等级与审批口径**完全以会话设置为准**，不因发起端形态变化。
9. **P1 迁移与兼容**：`V186`（`target_device_id` + `target_device_name` 两列）；存量会话不做批量回填，未认领前保持广播回退；旧客户端（无 device 字段）创建 LOCAL 不带宽定（不强制校验、不拒单），其会话保持广播。
10. **P1 历史会话惰性认领**：`target_device_id` 为空的 LOCAL 会话，在**首次执行**时按信号补一次绑定（详见 D15 / §4.1-8）：① 发起连接自身是 local 执行端 → 认领给它；② 浏览器发起且该用户仅有一台带 deviceId 的在线设备 → 认领给该设备；③ 多台在线 → 不认领、拒绝并提示「请在桌面客户端打开一次完成登记」。认领为条件更新（`WHERE target_device_id IS NULL`），幂等且不可逆。
11. **文档同步（随 P1 落地）**：根 `CHANGELOG.md`、`skills/mao-cli/`（桌面客户端 / Web 端使用说明中本地任务段落）。

### 2.2 不做的（本期明确排除）

- **不新增执行模式**：保持 `LOCAL` / `CLOUD` 两种；「设备委托」是 LOCAL 语义的收敛（执行端从「发起端本机」→「创建时绑定的设备」），不是第三种模式（用户已定）。
- **不做浏览器创建 LOCAL 会话**：浏览器仅能打开已存在的 LOCAL 会话继续对话；新建入口（`ChatNewTaskConfigBar`、`WorkspaceChip` 的模式切换）保持浏览器禁用（用户已定）。
- **不做会话改绑设备**：`target_device_id` 创建即定、不可修改，`PATCH /sessions/:id` 不提供该字段（用户已定）。
- **不做设备列表接口 / 设备选择器 / 设备自定义命名**：设备名取 hostname 并随会话做创建时快照，无改名能力（用户已定）。
- **不做跨用户 / 会话劫持防护**：不做额外设备授权、配对码、远程开关、「允许远程执行」确认（用户已定：默认只有本人能访问自己的会话）。
- **不做强制审批**：审批完全沿用 `shouldRequireApproval` 与会话 `permissionLevel`；`FULL` 免审批的口径不变（用户已定）。
- **不做审计**：不新增审计事件 / 日志字段 / 管理后台视图（用户已定）。
- **不做 denylist / 敏感操作黑名单 / 设备侧开关 / 配对码**（用户已定）。
- **不做文件树 / 终端 / Git 状态的远程代理**（浏览器看不到目标机文件与终端，本期维持现状；P2 另议）。
- **不做浏览器端 LOCAL 会话的非图片附件**（P1 禁用并调整文案；P2 另议服务端暂存 → 目标机下载）。
- **不做浏览器端 LOCAL 会话的本地技能 / AGENTS.md 注入**（P1 降级为空、不阻塞；P2 另议设备能力快照）。
- **不做存量会话的批量回填 / 人工逐条确认**：无可靠判据，批量补等于猜；只做首次执行时的惰性认领（§2.1-10），已绑定值不可修改。

## 3. 技术选型（待评审确认后定案）

| # | 决策点 | 拟定 | 落选项与理由 |
|---|---|---|---|
| D1 | 模式语义 | 保持 LOCAL / CLOUD 两值，功能名「设备委托」 | 用户已定不新增模式；LOCAL 的口径从「发起端本机执行」更新为「在创建时绑定的执行端设备上执行」，库中 `execution_mode` 枚举不变，零迁移成本与 UI 模式位不变 |
| D2 | 设备标识 | `deviceId`（客户端生成 UUID，持久化）+ `name`（hostname）+ `platform`（process.platform） | 不依赖硬件指纹（避免隐私与跨端差异）；UUID 持久化即可稳定识别同一安装；`name`/`platform` 仅展示用；不做自定义命名（用户已定） |
| D3 | 上报通道 | WS `auth` 帧新增 `device` 字段（注册表在内存） | 与 `client` 字段同一帧、同一时机；不新增 HTTP；设备在线状态天然以 WS 长连接为准（与现有注册表同生命周期） |
| D4 | 多连接同设备 | 同一 `deviceId` 保留**最新注册的连接**为执行连接（覆盖） | 同一桌面应用多窗口、快速重连场景下避免重复执行；旧连接仍收流式消息（`send ALL` 不变），只是不再接收 `tool_execute` |
| D5 | 会话字段 | `target_device_id VARCHAR(64) NULL` + `target_device_name VARCHAR(128) NULL`，不改 `execution_mode` | 空值 = 未绑定（历史会话 / 旧客户端），先惰性认领（D15），认领不了才回退广播；name 是创建时快照，离线展示不依赖注册表；创建端（桌面 / CLI）显式带本机设备，创建即绑定 |
| D6 | 发送目标策略 | 有绑定 → `sendToDevice` 定向；无绑定 → `sendToLocalClients` 回退（现状） | 兼容旧会话与旧客户端；新链路逐步收紧为全定向，广播分支只为兜底 |
| D7 | 设备信息随会话返回 | 会话 VO 附 `targetDeviceId / targetDeviceName / targetDeviceOnline`；不新增设备列表接口 | 浏览器不选设备，只需展示与判断在线；快照名保证离线可读；避免为一个非创建流程引入新接口与聚合查询 |
| D8 | 工作目录 | 由创建端决定（Electron `selectDirectory` / CLI 参数），浏览器只读展示 | 浏览器不创建 LOCAL 会话，无需为目标机选目录；已有会话的 `workspace` 是创建时写死的事实，不提供修改入口 |
| D9 | 附件 | 浏览器在 LOCAL 会话中禁用非图片附件；图片正常（走模型多模态，不依赖目标机文件） | 非图片文件在服务端 OSS、目标机读不到，语义不成立；P2 另议「服务端暂存 + 目标机拉取」；图片是给模型的输入，与执行端无关 |
| D10 | 本地技能 / AGENTS.md | P1 降级为空（浏览器发送路径本就不适用），不影响主流程 | 现状由发送端在消息帧上报（`localSkills` / `agentsMdContent`）；浏览器接管时发送端不是执行端，语义不成立；P2 另议「设备快照上报」（复用注册表缓存） |
| D11 | 审批与权限 | 完全沿用现状：`shouldRequireApproval(permissionLevel)` + 设备本地审批卡 + `PATCH /sessions/:id` 切级 | 用户已定「以会话当前设置为准」；浏览器侧只补「能切级」的一致性回归，不改审批引擎 |
| D12 | 状态存储 | 沿用**单实例内存注册表**（设备在线态不落库） | 与现状 LOCAL 依赖同一注册表；蓝绿切换期间连接归属由活跃实例承载（与现状一致，不扩大问题） |
| D13 | CLI 设备 | 与桌面端同等对待：CLI 上报 deviceId，创建 LOCAL 会话时绑定本机设备；该会话可被浏览器接管对话 | 用户已定 CLI 要做（不是可选）；`LOCAL_CAPABLE_CLIENTS` 本就含 `cli`，同一帧加字段即可；CLI 的 workspace 由 `--local` 启动参数 / 当前目录决定，浏览器只读展示 |
| D14 | 创建端绑定策略 | Electron / CLI 创建 LOCAL 会话时自动带本机 `deviceId` + `deviceName`；浏览器无创建入口；服务端不强制校验（兼容旧端） | 用户口径「创建即绑定、不可改绑」；旧端不带绑定时保持广播回退，不校验以免旧客户端 400 |
| D15 | 历史会话补绑 | 惰性认领：首次执行时按「发起连接自身 → 唯一在线设备 → 不认领并提示」三档补一次，条件更新 `WHERE target_device_id IS NULL` | 不猜、不批量回填、零迁移；① 是物理事实（消息从该机器发出、workspace 在该机器上），② 是唯一性证据；③ 保守拒绝，避免多设备广播重复执行；只作用于从未绑定的行，与「不做改绑」自洽 |

## 4. 实现步骤

### 4.1 后端（backend-ts）

1. **注册表加设备维度**（`session/ws/streaming-ws-registry.ts`）
   - 新增类型 `WsDeviceInfo { id: string; name: string; platform: string }`，`register(session, userId, clientType, metadata?, pageEnabled?, device?)` 增参（可选，向后兼容）。
   - 新增索引：`connectionDevice: Map<socketId, WsDeviceInfo>`、`deviceExecutors: Map<userId, Map<deviceId, WsSocket>>`（执行连接，同一设备覆盖为最新）；`lastSeenAt` 记录注册时间。
   - `unregister()` 清理：仅当该设备当前执行连接正是本 socket 时才删除，避免旧连接断开把新连接清掉。
   - 新增 `sendToDevice(userId, deviceId, event): WsDeliveryResult`（定向单连接；不存在/非 OPEN → 全零）、`hasDeviceConnection(userId, deviceId)`；不提供设备列表查询（本方案无设备选择流程）。
   - `sendToLocalClients` 保持不动，作为无绑定会话的回退路径。
2. **握手解析设备**（`session/ws/streaming-ws-handler.ts` 的 `auth` 分支）
   - 解析 `root.device`：`id/name/platform` 三者均为非空字符串才生效；缺省或非法 → 按旧客户端处理（只注册连接，不进入设备索引）。
   - `registry.register(...)` 透传设备信息；日志补 `deviceId`。
3. **委托目标绑定**（`harness/local/local-tool-session-registry.ts`）
   - `sessionToUser` 旁新增 `sessionToDevice: Map<sessionId, string | null>`；`setUserForSession(sessionId, userId)` 直接改名为 `setTargetForSession(sessionId, userId, deviceId | null)`。**评审补充**：调用点不止「约 5 处」——`streaming-ws-handler.ts` 内 6 处（订阅 `handleSubscribe` `:566`、发送 `:713`、持久化提示词 `:931`、编辑重发 `:1034`、边路 `:1239`、重试 `:1414`），外加 delegate 侧 3 处（`subagent-execution-recovery.service.ts:79/80`、`background-subagent-manager.ts:570`）与各处 spec；改名后编译期会强制暴露这些点，需一并带 `session.targetDeviceId`。另 `removeSession` 删 `sessionToUser` 时须同步删 `sessionToDevice`，否则设备绑定内存泄漏。
   - `isConnected(sessionId)`：有绑定设备 → `hasDeviceConnection(userId, deviceId)`；无绑定 → `hasLocalClientConnection(userId)`（现状）。
   - 设备解析兜底：内存 `sessionToDevice` 无记录时（服务重启、崩溃恢复、边路 / 子代理新建）从 `session` 表读 `target_device_id`，与 `resolveUserId` 共用一次查询。
   - `sendToolRequest`：有绑定 → `sendToDevice`；无绑定 → `sendToLocalClients`（现状）；目标不存在时返回 `{ error: 'Local client is not connected' }`（保持既有文案，前端按设备名补提示）。
4. **统一 LOCAL 检查点**（`streaming-ws-handler.ts`）
   - `streaming-ws-handler.ts` 内 6 处（订阅 `:566`、发送 `:713`、持久化提示词 `:931`、编辑重发 `:1034`、边路 `:1239`、重试 `:1414`，见 §4.1-3）与 delegate 侧 3 处（`subagent-execution-recovery.service.ts:79/80`、`background-subagent-manager.ts:570`）的 `setUserForSession` 调用，统一改为 `setTargetForSession(..., session.targetDeviceId)`。检查逻辑本身不改——设备级语义已在 `isConnected` 内收敛。
   - **设备断线清理**：`afterConnectionClosed` 若关闭的连接带 `deviceId` 且该设备已无执行连接，调用新增的 `localToolSessionRegistry.failAllForDevice(userId, deviceId)`（失败该设备绑定会话的全部 pending 工具请求）；现有 `!hasLocalClientConnection(userId)` 的 `failAllForUser` 保留给无 deviceId 的旧连接。避免「目标设备掉线、但同用户另一台设备在线」时 pending 永久悬挂。
   - **派生会话继承**：共 **3 处**会话字面量需补 `targetDeviceId`（与 `executionMode` / `workspace` 同源，否则 LOCAL 子会话退回广播）：① 边路任务 `handleCreateSideSession` 的 `sideSession`（`streaming-ws-handler.ts:1213`）；② 子代理 `subagent-invocation.service.ts` 的 `child`（`:26`）；③ **评审补充**：边路提升 `promoteSideTaskToMainSession`（`session.service.ts:684`，原方案遗漏）——它同样复制 `executionMode`/`workspace`，且提升后的会话会再次走 `enrichSessions`（`session.routes.ts:320`）返回 VO，若不继承则设备名 / 在线态丢失。三者都不经过 `createSession`，而是各自 `insert`，故落库要保证 `sessionRepo.insert`（`session.repository.ts:281`）透传两列（见 §4.1-6）。
   - **评审补充**：delegate 侧另有 `isConnected` / `setUserForSession` 调用点**不在** `streaming-ws-handler.ts` 内——`subagent-execution-recovery.service.ts`（`isConnected:153`、`setUserForSession:79/80`、`removeSession:118`）与 `background-subagent-manager.ts`（`setUserForSession:570`、`removeSession:740`）。改名 / 改签名后必须同步改造并按 §7 补测，否则后台子代理恢复路径会退回用户级在线判定。
5. **技能 / MCP 同步定向**（`streaming-ws-handler.ts:2196` / `:2235`）
   - 取 `session.targetDeviceId`：有 → `sendToDevice`；无 → `sendToLocalClients`（现状）。`skill_sync_complete` / `mcp_tools_report` 的回包按 `requestId`/`syncId` 匹配，无来源连接校验（同用户设备间串扰风险由定向发送本身消除）。
6. **会话字段与接口**
   - `session.service.ts` 的 `createSession` 增参 `targetDeviceId` + `targetDeviceName`，仅 LOCAL 落库（CLOUD 忽略）；`sessionRepo.insert` 带两列；`session-vo.ts` 输出 `targetDeviceId / targetDeviceName`。
   - `session.routes.ts` 的 POST body 增 `targetDeviceId?: string`（长度 ≤64）与 `targetDeviceName?: string`（长度 ≤128），超长 400；**不强制必填**（兼容旧桌面端 / CLI 版本，缺省走广播回退）；创建时**不硬校验在线**（设备刚断线重连窗口内允许保存），发送时由 `isConnected` 硬校验；`PATCH /v1/sessions/:id` **不提供改绑**（用户已定）。**评审补充**：`bodyOf`（`common/request.ts:7`）是裸转换、POST 现无任何 body schema 校验，故上述长度 400 是**新增**校验而非扩展既有逻辑，需显式实现；并对 `targetDeviceName` 去首尾空白、`targetDeviceId` 限字符集白名单 `^[A-Za-z0-9_-]{1,64}$`（不锁 UUID 形状，防脏值即可，避免约束未来 ID 方案），避免把任意串写进快照列。`createSession` 亦无 `executionMode` 白名单校验（`:137` 仅把空值归一为 `CLOUD`），本功能只依赖字面量 `'LOCAL'`，无需扩大校验面。
7. **设备在线状态**：`enrichSessions` 处按会话计算 `targetDeviceOnline`（有绑定 → `hasDeviceConnection(userId, targetDeviceId)`，无绑定 null）。**评审补充（好事实证）**：`enrichSessions`（`session.routes.ts:138`）是列表 / 详情（`:302`）/ 分组 / 仪表盘 / 分页 / 提升后（`:320`）等约 11 处 VO 的**唯一**装配点，注入一次即全端点一致，无需逐端点补；`toSessionVO`（`session-vo.ts:182`）需增补 `targetDeviceId / targetDeviceName / targetDeviceOnline` 三个输出字段。`SessionRouteDeps`（`session.routes.ts:48`）当前无 registry 依赖——**注入 `hasDeviceConnection?: (userId: number, deviceId: string) => boolean` 可选回调（缺省 `() => false`），而非整个 WS registry**：HTTP 层不依赖 WS 细节，既有 spec 构造也无需大改。`targetDeviceOnline` 是请求时快照（用于展示与发送前提示，权威判定在服务端发送校验），页面停留期间设备上下线不会自动刷新。单列表页约 20 会话即约 20 次 map 查找，可接受。
8. **历史会话惰性认领**（`streaming-ws-handler.ts` + `session.service.ts`）
   - 触发点：**WS 入站处理**的 LOCAL 分支（与现有 `setUserForSession` 同一批调用点：订阅 `:566`、发送 `:713`、持久化提示词 `:931`、编辑重发 `:1034`、边路 `:1239`、重试 `:1414`）。若 `session.targetDeviceId` 为空，先尝试认领。**不得放到 `executePersistedUserPrompt` / 队列消费（autoConsume）/ 定时任务等执行态入口**——那些路径没有 socket，① 会退化成 ②/③；且认领必须在消息入队（busy 场景）之前完成。
     - ① 当前 WS 连接带 deviceId（Electron / CLI）→ 用它（`registry.getDeviceId(socket)`，入站处理里就地取，随 `setTargetForSession` 一起传给 registry）；无 socket 上下文（队列消费 / 定时任务 / 内部入口）不参与。
     - ② 否则取 `registry.getOnlineDeviceIds(userId)`（**去重后的 deviceId 集合**，非 socket 数；仅统计带 deviceId 的连接）：唯一 → 再校验 `device.platform === session.platform`（创建端 `process.platform` 与设备上报一致，`darwin / win32 / linux`；`session.platform` 为空则跳过该校验）——一致才认领，避免把 Mac 会话认领到唯一在线的 Windows 机器。
     - 多台或平台不符 → 返回错误帧、不执行。**文案按 `session.platform` 生成**（`darwin → macOS`、`win32 → Windows`、`linux → Linux`），如「该历史任务创建于 macOS 设备，请在 macOS 桌面客户端打开一次完成登记」；`platform` 为空时回落通用文案「该历史本地任务未登记执行端，请在桌面客户端打开一次完成登记」——避免用户被引到平台不符的机器上反复失败。
     - ③ 一条带 deviceId 的连接都没有（纯旧客户端环境）→ 不认领，保持现状广播（兼容）。
   - 写回：`sessionService.claimTargetDevice(id, deviceId, deviceName)` → `UPDATE session SET target_device_id=?, target_device_name=? WHERE id=? AND target_device_id IS NULL`；影响行数为 0 表示已被其他连接认领，读回现有值并按它定向（不覆盖）。
   - 认领成功后立即 `setTargetForSession(...)` 走定向；前端在发送完成后的现有 `fetchSession` 刷新即可看到设备名，无需新增推送。
   - 不校验 workspace 是否存在于目标设备（服务端无法访问目标机文件系统）；路径不存在由工具层按既有错误回传。

### 4.2 契约（shared/contracts）

- **落点修正（评审补充）**：`shared/contracts/src/session.ts` 目前**没有** `Session` 类型（该文件只导出 `SessionSource` 与消息检索相关类型；前端 `desktop/src/stores/session/types.ts` 亦只从 contracts 引 `WsTaskPhase`）。故三字段应加到：后端 `session/types.ts` 的 `Session`（`:4`）、后端 `session-vo.ts` 的 `SessionVO`（`:24`，wire 实际结构）、前端 `desktop/src/stores/session/types.ts` 的 `Session`（`:38`）。三处均为 `targetDeviceId?: string | null`、`targetDeviceName?: string | null`、`targetDeviceOnline?: boolean | null`。设备字段非枚举，不触发 AGENTS.md 的 contracts 枚举收口规则；不新增 contracts 类型。
- 不新增设备列表类型（无设备列表接口）。

### 4.3 桌面端（desktop，Electron 与浏览器同 dist）

1. **设备身份持久化**（`electron/desktopPrefs.cjs`）：`normalizeDesktopPrefs` 增 `deviceId` 字段——已有非空字符串沿用，缺失时在读取路径用 `crypto.randomUUID()` 生成一次并随偏好原子写回（不在默认值函数里生成，避免每次读取都变）。**评审补充（坑）**：`normalizeDesktopPrefs`（`desktopPrefs.cjs:35`）是白名单式归一、**不透传未知字段**，且 `writeDesktopPrefs`（`:84`）写盘前会再跑一次归一——因此 `deviceId` 必须同时进 `defaultDesktopPrefs()` 与 `normalizeDesktopPrefs` 的返回对象，否则「读取时生成并写回」会在下一次写盘被静默清掉；务必补「生成→写盘→重读仍为非空」的单测（§7-11）。另：`deviceId` 属机器身份字段，**不接受 renderer 写入**——`writeDesktopPrefs` 合并 patch 时忽略 `patch.deviceId`，只保留「缺失时生成」这一条写入路径，避免被 `desktopPrefsSet` 误改或清空；单测覆盖「patch.deviceId 被忽略」。
2. **设备信息 IPC**（`electron/main.cjs` + `electron/preload.cjs`）：新增 `ipcMain.handle('device-info-get')` 返回 `{ id, name: os.hostname(), platform: process.platform }`；preload 暴露 `getDeviceInfo()`。
3. **握手上报**（`composables/useStreamWS.ts`）：`auth` 帧追加 `device: await electronAPI.getDeviceInfo()`（仅 Electron；浏览器无 `electronAPI`，不上报）。
4. **浏览器端交互边界**（`components/chat/WorkspaceChip.vue`、`ChatNewTaskConfigBar.vue`）
   - 新建态：LOCAL 选项保持 `disabled`（浏览器）、模式切换保留 warning 提示——**不放开创建**；不引入设备选择器与目录输入。
   - 已有 LOCAL 会话：正常发送；工作区只读展示创建时路径；输入区展示「本地任务 · 设备名（在线/离线）」，**未绑定时展示「本地任务 · 未登记执行端」**；设备离线时禁用发送并提示；未登记 + 多设备在线时提示「请在桌面客户端打开一次完成登记」。
5. **发送链路放行（仅已有会话）**（`components/chat/ChatInput.vue`、`composables/useChat.ts`）
   - `ChatInput.handleSend`（`:1129`）：拦截条件从 `executionMode === 'LOCAL' && !isElectronClient` 改为 `executionMode === 'LOCAL' && !isElectronClient && props.isNewTask`——新建态仍拦（浏览器不能建本地任务），已有会话放行。
   - `useChat.prepareAndSendMessage`（`:343`）：拦截条件改为「LOCAL 且无 `sessionId`（需新建）且非 Electron」；已有 sessionId 放行，交给服务端 `isConnected` 设备级校验兜底。
   - `handleModeChange`（`ChatInput.vue:1177`）与 `WorkspaceChip.switchMode`（`:203`）：浏览器端切 LOCAL 的拦截**保持现状**（浏览器不能新建本地任务）。
   - 浏览器在 LOCAL 会话中的非图片附件：`addPendingFile` 拦截文案改为「本地任务暂不支持上传文件（图片除外）」；图片保持可用。Electron 本机的附件拷贝行为不变。
   - 创建会话时 `createSession(..., targetDeviceId, targetDeviceName)`：仅 Electron 生效（取 `getDeviceInfo()`）；浏览器不走该分支。
6. **会话展示**（`views/task/TaskView.vue`、`WorkspaceChip.vue`）：`loadSession` 记录 `targetDeviceId / targetDeviceName / targetDeviceOnline`；本地任务标识展示「本地任务 · 设备名」+ 离线标记（快照名来自会话数据，不依赖设备列表接口）。
7. **审批等级**（`ChatPanel.vue` / `PermissionLevelSwitcher.vue`）：不改逻辑，补浏览器 + 已有 LOCAL 会话的回归用例（切级 → `PATCH /sessions/:id` → 成功/失败回滚）。

### 4.4 终端 CLI（agent-cli，P1）

- `src/ws/` 握手帧带 `device: { id, name, platform }`；`id` 持久化在 `~/.mao/`（与 `auth.json` 同目录，独立文件或 auth 内字段均可），首次生成 UUID。
- CLI 创建 LOCAL 会话（`--local`）时，建会话请求带本机 `deviceId` + `deviceName`（与 Electron 同字段）；该会话可被浏览器打开接管对话，工具仍委托给该 CLI 执行。
- 不改 LOCAL 执行逻辑（`src/local/`）与 `client='cli'` 词表。

### 4.5 数据库迁移

`backend-ts/db/migration/V186__add_session_target_device_binding.sql`（新增，取落地时空着的下一个迁移号；撰写本方案时最新为 V185）：

```sql
-- V186: LOCAL 会话创建时绑定执行端设备（同表存设备名快照，供离线展示）。空值 = 未绑定（历史会话 / 旧客户端），首次执行时惰性认领，认领不了才回退广播。
ALTER TABLE `session`
  ADD COLUMN `target_device_id` VARCHAR(64) NULL COMMENT 'LOCAL 会话的执行端设备 id（创建时绑定，空=未绑定）' AFTER `execution_mode`,
  ADD COLUMN `target_device_name` VARCHAR(128) NULL COMMENT '执行端设备名快照（hostname，创建时写入）' AFTER `target_device_id`;
```

- 存量行保持 NULL，**不回填**（无判据；回填等于猜设备）。
- 列长度：`target_device_id` 64（UUID 36 字符留余量）、`target_device_name` 128；不做外键（设备是内存态，无实体表）；不加索引（无按设备聚合/筛选查询）。

## 5. 落地清单

| 端 / 文档 | 项 |
|---|---|
| backend-ts | `session/ws/streaming-ws-registry.ts`（设备索引 / `sendToDevice` / `hasDeviceConnection` / `getDeviceId` / `getOnlineDeviceIds`）、`session/ws/streaming-ws-handler.ts`（auth 解析 device、LOCAL 检查点带 targetDeviceId、设备断线清理、边路继承、技能/MCP 同步定向、历史会话惰性认领触发）、`harness/local/local-tool-session-registry.ts`（目标绑定 / 定向 / 回退 / 按设备清理 / removeSession 清理 sessionToDevice）、`harness/delegate/subagent-invocation.service.ts`（子代理继承 targetDeviceId）、**评审补充**：`harness/delegate/subagent-execution-recovery.service.ts` + `harness/delegate/background-subagent-manager.ts`（isConnected / setUserForSession 设备化 + removeSession 清理）、`harness/tool/tool-dispatcher.ts`（不改，仅验证 LOCAL 分支）、`session/session.service.ts`（createSession 落两列 + `claimTargetDevice` 条件更新 + **评审补充**：`promoteSideTaskToMainSession` 继承两列）、`session/session.repository.ts`（insert 透传两列）、`session/session.routes.ts`（POST 字段校验 + enrichSessions 注入 `hasDeviceConnection` 回调 + VO 在线态）、`session/session-vo.ts`（VO 三字段）、`session/types.ts`（Session 三字段） |
| contracts | **无变更**（设备字段非枚举、不新增类型；三字段落点见 §4.2 修正：后端 `session/types.ts` + `session-vo.ts` + 前端 `desktop/src/stores/session/types.ts`） |
| desktop | `electron/desktopPrefs.cjs`（deviceId + normalize 白名单）、`electron/main.cjs` + `preload.cjs`（getDeviceInfo）、`composables/useStreamWS.ts`（握手上报）、`components/chat/WorkspaceChip.vue`（已有会话设备标识 / 边界展示）、`ChatInput.vue`（既有会话放行、附件提示）、`useChat.ts`（guard 按新建态区分、创建会话带设备）、`stores/session/list.ts`（payload）、`stores/session/types.ts`（Session 增三字段）、`views/task/TaskView.vue`（读设备字段 + 展示） |
| agent-cli | `src/ws/` 握手带 device、`~/.mao/` 持久化 deviceId、LOCAL 建会话带 `deviceId` + `deviceName` |
| 迁移 | `V186__add_session_target_device_binding.sql`（`target_device_id` + `target_device_name`，存量不回填） |
| 测试 | 见 §7 |
| 文档 | 根 `CHANGELOG.md`（后端 / 前端（桌面 / Web））；`skills/mao-cli/` 桌面与 Web 使用说明的本地任务段落 |

## 6. 风险与回归护栏

| 风险 | 护栏 |
|---|---|
| **发布顺序敏感**：新桌面端先于后端上线时，`targetDeviceId` 被旧后端忽略 → 会话未绑定、实际走广播，用户以为已定向 | §8 规定「先部署 backend-ts，再部署 desktop/dist」；后端先上线时旧客户端无 device 字段，走回退分支，双方安全；错过的会话在后端上线后首次执行时会按 D15 补登记 |
| 旧桌面端 / CLI 创建 LOCAL 不带绑定 | 服务端不强制校验（避免旧端 400）；未认领前保持广播；新端创建即绑定，UI 对未绑定会话不展示在线态 |
| 同一账号两台机器在线时误在错机器执行 | 新会话一律绑定创建端 `deviceId`；历史会话按 D15 惰性认领（① / ② 有唯一性判据，③ 拒绝不猜）；执行前按 `targetDeviceOnline` 校验 |
| 历史会话认领到错误的唯一设备（另一台机器在线、workspace 不匹配） | ② 只在「带 deviceId 的在线设备唯一」时触发（唯一性证据）+ **评审补充**平台一致性校验（§4.1-8）压低误判；路径不存在由工具层报错，且不可改绑（用户已定）——风险已明示、接受；后续如需要可另议「解除认领」 |
| **评审补充**：② 同平台仍可能误判（如两台 Mac、workspace 不匹配），以及**设备身份变化**后 deviceId 变（换机、清理 / 丢失 `userData`、手动删除 `desktop-prefs.json`，或 CLI 删除 `~/.mao/`；普通重装一般保留 userData、id 不变），旧 `target_device_id` 永久失配、又不可改绑 | 上述两种都会留下**孤立绑定**（会话显示离线、浏览器无法接管）。因「不可改绑 / 不做解除认领」为用户既定，恢复路径明确为**重建会话**；需在 UI（未登记/离线态旁）与 CHANGELOG 写清「本地任务绑定创建它的那台设备，换机或设备身份丢失后旧任务需重新创建」，避免用户误判为 bug |
| 多设备 + 未绑定历史会话在浏览器发起被拒 | 错误文案明确引导：多台 → 通用文案；平台不符 → 按 `session.platform` 点名 macOS / Windows / Linux。桌面端打开并发送一次即完成认领，后续不再触发 |
| 纯旧客户端环境被认领逻辑误拦 | ③ 明确：无任何带 deviceId 的连接时保持现状广播，不触发拒绝 |
| 同一 deviceId 多窗口/多实例重复执行 | D4：执行连接覆盖为最新一条；`sendToDevice` 只投一个 socket；同设备旧窗口仍收流式消息但不收 `tool_execute` |
| 浏览器误以为可以新建本地任务 | 前端保持新建态 LOCAL 禁用与切换提示（`ChatNewTaskConfigBar` / `WorkspaceChip` 现有防御不动）；补回归用例断言「浏览器新建 LOCAL 被拦」 |
| 浏览器在 LOCAL 会话中找不到目录 / 看不到文件 | 工作区只读展示创建时路径；文件树 / 终端维持「仅桌面端可用」的既有行为，CHANGELOG 写清边界 |
| 浏览器在 LOCAL 会话中附件 / 本地技能能力缺失被误认为 bug | UI 明示：非图片附件提示「本地任务暂不支持上传文件（图片除外）」；本地技能不做展示（P2 再增强） |
| 设备离线时发送报错文案含糊（现有英文 `Local client is not connected.`） | 前端按会话 VO 的 `targetDeviceOnline` 在发送前拦截并提示「设备「XXX」已离线」；服务端保留兜底文案不变（避免影响既有测试断言） |
| 技能 / MCP 同步从广播改定向后，旧会话仍广播导致多设备同步 | 与现状一致，仅新会话定向；技能同步失败按既有 60s 超时与降级路径处理（`streaming-ws-handler.ts:2204`） |
| 蓝绿切换期间设备连接落在旧实例 | 与现状 LOCAL 完全一致（注册表本就是活跃实例内存态）；切换后客户端自动重连即恢复，不新增约束 |
| 审批等级在浏览器侧被误以为受限于 LOCAL | 服务端 `PATCH /v1/sessions/:id` 已支持 `permissionLevel`（`session.routes.ts:371`）；本次仅补浏览器 + 已有 LOCAL 会话回归用例，不改审批引擎 |
| 迁移加列影响旧代码 | 旧代码显式列名查询不受影响；两列可空、无默认值，回滚代码后保留列无副作用 |

## 7. 测试要点

**后端（`cd backend-ts && npm test`）**

1. `streaming-ws-registry.spec.ts`：设备注册 → `hasDeviceConnection`；同 deviceId 二次注册覆盖执行连接；旧连接 `unregister` 不清掉新连接；`sendToDevice` 只命中目标 socket；无设备时返回全零；browser 连接不进入设备索引。
2. `streaming-ws-handler` 鉴权 spec：auth 帧带合法 `device` → `register` 收到设备；`device` 缺字段/非字符串 → 按无设备注册（连接仍可用）；非法 token 仍 1003。
3. `local-tool-session-registry.spec.ts`：有绑定设备 → `sendToolRequest` 走 `sendToDevice`；无绑定 → 走 `sendToLocalClients`；目标设备离线 → 返回 `Local client is not connected`；`isConnected` 设备级 vs 用户级两种口径。
4. `streaming-ws-handler` LOCAL 发送/重试/边路 spec：带 `targetDeviceId` 的会话在目标设备离线时被拒，错误帧与现有 `Local client is not connected` 口径一致。**评审补充**：补 delegate 侧恢复路径（`subagent-execution-recovery.service.ts` / `background-subagent-manager.ts`）的 `isConnected` 设备级用例。
5. **断线清理**：绑定设备掉线、同用户另一台设备仍在线 → 该设备 pending 工具请求全部失败（`failAllForDevice`），另一台设备不受影响；无 deviceId 旧连接的 `failAllForUser` 既有行为不回退。
6. **派生继承**：边路任务 / 子代理 / **边路提升**（`promoteSideTaskToMainSession`，共 3 处）会话的 `targetDeviceId` 等于父（源）会话，且 workspace / executionMode 不串位。
7. 技能 / MCP 同步：有绑定设备 → 只发目标设备；无绑定 → 广播（既有断言不回退）。
8. 路由：POST `targetDeviceId` / `targetDeviceName` 合法落库、超长或非法字符集 400、CLOUD 会话忽略、缺省（旧端）不报错；会话 VO 的 `targetDeviceOnline`：有设备连接 true、无连接 false、未绑定 null（请求时快照）。
9. Flyway：`V186` 走既有良构校验（文件名/非空/checksum）。
10. **惰性认领**：未绑定会话 + Electron 发起 → 认领给发起设备；浏览器发起 + 唯一带 deviceId 设备且**平台一致** → 认领给该设备；浏览器 + 多台、或唯一但平台不符 → 拒绝并按 `session.platform` 返回对应平台文案（darwin→macOS 等）、不执行；**认领只在 WS 入站路径触发，队列消费（autoConsume）路径不触发**（无 socket）；`getOnlineDeviceIds` 按去重 deviceId 判定；条件更新幂等（并发二次认领不覆盖、读回先到值）；纯旧客户端环境 → 保持广播不拒单；认领后 `targetDeviceName` 快照正确。

**前端 / CLI**

11. desktop 单测：`desktopPrefs` 首次生成 deviceId 且持久化、坏文件回落、**`writeDesktopPrefs` 忽略 patch 中的 `deviceId`**；`useStreamWS` Electron 握手帧含 `device`、浏览器不含；Electron 创建 LOCAL 会话 payload 带 `targetDeviceId / targetDeviceName`；浏览器打开已有 LOCAL 会话可发送、**浏览器新建 LOCAL 仍被拦截**；浏览器 LOCAL 会话中非图片附件被拦截、图片可用。
12. `cd desktop && npm run build`（vue-tsc 验证新增类型/组件）；`cd agent-cli && npm run build && npm test`（CLI 建会话带 deviceId、握手帧含 device）。
13. 手工联调（必须）：
    - 桌面客户端创建 LOCAL 任务并执行 → 浏览器（另一台机器或隐身窗口）打开同一会话 → 发送消息 → 工具调用仍在原桌面执行、结果回传、审批卡按会话等级弹出；
    - CLI 创建 LOCAL 会话 → 浏览器打开接管对话 → 工具委托给该 CLI 执行；
    - 历史 LOCAL 会话（未绑定）→ 桌面端打开并发送 → 自动认领给该设备，之后浏览器打开同一会话即定向执行；
    - 历史 LOCAL 会话（未绑定）→ 浏览器 + 唯一在线设备 → 自动认领；多台在线 → 发送被拒并提示去桌面端登记；
    - 浏览器打开 LOCAL 会话 → 切换审批等级（只读 → 读写 / 完全权限）→ `PATCH` 成功、刷新后保持；
    - 浏览器新建态确认无法选 LOCAL / 无法切 LOCAL（回归）；
    - 双执行端（桌面 + CLI，或两台桌面）同时在线 → 新会话只在其创建端执行，另一台无动作；
    - 目标设备退出 → 浏览器发送前提示设备离线；执行中退出 → 工具调用失败、会话收敛（不悬挂）。

**回归（不新增 E2E 亦可，手工覆盖）**

14. 桌面本机 LOCAL 任务全链路与改动前一致（创建、执行、审批、技能同步、文件拷贝）。
15. CLOUD 会话（桌面 / 浏览器）完全不受影响。

## 8. 发布与文档

1. **发布顺序（硬约束）**：先 `backend-ts`（加列迁移随启动执行、注册表与接口先就绪），再 `bash scripts/deploy-desktop.sh`（Electron 与浏览器共用同一 dist），最后发 `mao-agent`（CLI）。
2. **CHANGELOG**（根 `CHANGELOG.md` 顶部新建版本小节，版本号取落地时的下一个）：
   - 后端：本地任务创建时绑定执行端设备，工具调用按会话定向委托；历史本地任务首次执行时自动补登记执行端（桌面端 / CLI 打开发起，或同平台唯一在线设备），多设备场景下提示去桌面端完成登记；`session` 表新增 `target_device_id / target_device_name`（不做批量回填）。
   - 前端（桌面 / Web）：浏览器端可打开并继续本地任务对话（不能新建）；本地任务展示设备名与在线状态；浏览器侧可切换本地任务审批等级；终端 CLI 创建本地任务时绑定本机设备。
3. **mao-cli 文档**：桌面 / Web 使用说明的「本地任务」段落更新——本地任务由桌面端 / CLI 创建并绑定本机，浏览器可接管对话但不可新建；浏览器端能力边界（不支持远程文件树/终端、非图片附件、本地未上传技能）。
4. **回滚**：代码回滚即可；`target_device_id / target_device_name` 两列保留（可空、旧代码不读），无需数据逆运算。

## 9. 开放问题（待讨论，不阻塞主链路）

1. **设备能力快照**：为让浏览器接管的 LOCAL 会话也能注入目标机「本地未上传技能 / AGENTS.md」，可在设备连接后上报一次快照（或服务端按需请求），注册表按 deviceId 缓存。P2。
2. **附件远程化**：服务端暂存 + 目标机按需拉取（或直接写入目标机 workspace），用于浏览器在 LOCAL 会话中的非图片附件。P2。
3. **文件树 / 终端 / Git 远程代理**：浏览器查看目标机文件与终端需要新增 WS 请求-响应代理层，工作量显著大于本方案主体，建议独立方案。
4. **模式语义文案**：会话内已有的 LOCAL 任务在服务端模式固定、不可改（`PATCH` 不支持 `executionMode`）；浏览器打开时只读展示「本地任务 · 设备名」，切换模式仅对新建任务生效——需在 UI 上明确，避免用户误以为会话已转到云端。
