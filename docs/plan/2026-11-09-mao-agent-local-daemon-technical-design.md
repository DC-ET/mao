# mao-agent 常驻本地执行端技术方案（脱离会话常驻，服务本机任意 LOCAL 会话）

- 状态：已定稿（2026-11-09；§3 决策按推荐值定案：D4-A 执行连接 last-writer-wins、D3 单一信任根、D5 远端审批 300s 超时、D7 随 daemon 一起做。均可在实现期回退，改一处即可）。同日评审补充：远端审批必须落在三个调用点上、信任根外的技能/MCP 同步保持静默、`clientType` 要在执行连接交接时重广播并进会话快照、退出时关掉全部 MCP、「总是允许」不得跨会话。二次复核补充：daemon 审批 policy 固定 TTY 位为 false、断线立刻失败等待需两个新钩子、`executorClientType` 要落 `SessionVO` 接口。详见 §4 / §6。
- 日期：2026-11-09
- 关联方案：
  - [2026-11-05-local-task-device-delegation-technical-design.md](./2026-11-05-local-task-device-delegation-technical-design.md)（设备委托：设备身份 / `target_device_id` 绑定 / 定向委托 / D1–D15，本方案全部沿用其结论，不改会话字段与路由主体）
  - 0.0.483（本地执行端离线三连修复）：设备上下线 `device_status` 广播、离线文案中文化——本方案的「在线 ≠ 有人 attach」辨析建立在其上
- 能力底座（撰写时已存在的实现，全部复用、不重写）：
  - 设备身份与定向委托：WS `auth` 帧 `device: { id, name, platform }`（`agent-cli/src/ws/ws-client.ts`、`backend-ts/src/session/ws/streaming-ws-registry.ts` 的 `deviceExecutors`），`sendToDevice(userId, deviceId, event)` 单连接定向（`streaming-ws-registry.ts:447`）
  - 会话绑定设备：`session.target_device_id` + `sessionToDevice` 内存映射 + DB 兜底（`harness/local/local-tool-session-registry.ts`）
  - 设备级在线判定：`hasDeviceConnection(userId, deviceId)`（任意一条带该 deviceId 的连接即在线，**不要求 attach 会话**）
  - CLI 本地执行：`LocalExecutor`（`agent-cli/src/local/executor.ts`）——`handleEvent` 只按 `evt.sessionId` 键分发 `tool_execute` / `skill_sync_required` / `mcp_sync_required` / `tool_approval_resolved`，**本身不依赖 SessionRunner**
  - 工作区信任边界：`isWorkspaceWithin(candidate, localWorkspace)` 收窄（`agent-cli/src/local/sandbox.ts:83`）、`trustedWorkspaces` 持久化（`agent-cli/src/local/trust.ts`）
  - 多端审批中继：`tool_approval_request` / `tool_approval_resolved` 均 `registry.send(userId, …)` **全连接广播**（`backend-ts/src/harness/approval/approval-registry.ts:262`、`:271`），CLI 侧 `takeRemoteChoice` / `approvalRemoteChoices` 消费回声（`executor.ts:244`、`:344`）
  - 工具请求超时 900s（`harness/local/local-tool-executor.ts:30`）
- 本方案定位：**不新增执行模式、不改会话绑定与路由主体**。只解决一个问题——让 mao-agent 有一个**不 attach 任何会话**的常驻入口，凭「设备身份 + 执行连接」替本机所有 LOCAL 会话执行工具。形态上等价于「桌面 Electron 的 CLI 版守护进程」。

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 会话附着（attach） | CLI 当前形态：一个进程 = 一个会话（`SessionRunner` + `acceptEvent` 按 sessionId 过滤 + `LocalExecutor` 随会话创建/销毁） |
| 常驻执行端 / 本地守护（daemon） | 本方案新增形态：`mao-agent local --serve` 启动、**不 attach 任何会话**、长期在线，替本设备全部 LOCAL 会话执行工具的 mao-agent 进程 |
| 执行连接 | 注册表中该设备**最新注册**的那条 WS 连接（`deviceExecutors` last-writer-wins），`sendToDevice` 只投它 |
| 工作区信任根 | daemon 启动时校验并信任的目录；服务端下发的 `workspace` 必须落在其内（`resolveWorkspace` 收窄） |
| 远端审批 | 需审批时 daemon 不自拒、不本地弹窗，等用户在桌面 / 安卓 / Web 任一已连接端投票（`tool_approval_resolved` 回声） |

## 1. 需求背景

### 1.1 现状：为什么「在线」不等于「能执行」

| 设施 | 现状 | 证据 |
|---|---|---|
| 设备在线判定 | **连接级**：`hasDeviceConnection(userId, deviceId)` 只要该设备有一条带 deviceId 的 WS 连接即判在线，不关心它 attach 了哪个会话 | `streaming-ws-registry.ts`、`local-tool-session-registry.ts` 的 `isConnected` |
| 工具下发目标 | **设备级单连接**：`sendToDevice` 投给该设备「最新注册的连接」；同设备后连接的进程会顶掉先连接的 | `streaming-ws-registry.ts:447`、D4 |
| CLI 事件过滤 | **会话级**：`acceptEvent` 丢弃 `evt.sessionId !== mySessionId` 的全部事件 | `agent-cli/src/ws/event-filter.ts` |
| LocalExecutor 创建条件 | 仅 `localMode`（`session.executionMode === 'LOCAL'` 或 `--local` 且非 CLOUD）时创建，且随 `SessionRunner` 绑定单会话；切会话（`switchSession`）会重建 | `agent-cli/src/commands/chat.ts:97`、`:110`、`:130-163` |
| 工具事件路由 | `SessionRunner.handleWs` 在 `acceptEvent` **之后**才把 `tool_execute` 等四类事件转交 `localExecutor` | `agent-cli/src/session/session-runner.ts:452-462` |
| 本地执行能力 | `LocalExecutor.handleEvent` 只按 `evt.sessionId` 键处理，MCP / shell / 审批登记均按 sessionId 分桶，**多会话可共存于一个实例** | `agent-cli/src/local/executor.ts:122-150` |
| 工作区收窄 | 服务端下发的 `workspace` 必须等于启动工作区或在其内部，否则抛错（防服务端把路径指到 `/`） | `executor.ts:166-171`、`sandbox.ts:83` |
| 审批 | 请求 / 回声均**全连接广播**（任一端可投票，服务端认领首个）；**执行端本地另有原生审批入口**（桌面 `main.cjs` 的 `requestToolApproval` → 渲染层卡 / CLI 的 Ink 模态或 readline），同 requestId 两条入口去重（本地覆盖广播）；本地非 TTY 时 `evaluateApproval` 直接 `deny` + `exitApproval` | `approval-registry.ts:262`、`:271`、`agent-cli/src/local/approval.ts:167`、`desktop/src/composables/approvalQueue.ts:108-116` |
| 审批待办可见性 | 站内收件箱登记审批待办（有偏好开关）；**3 分钟无人处理**升级外推到用户配置的通知渠道（飞书 / 企微 / 钉钉 / 微信 webhook），用户投票后抑制未发出的提醒 | `inbox/inbox.service.ts:311`、`local-tool-executor.ts:83-90`、`notification/task/delivery.service.ts:22`、`create-app.ts:770` |
| 审批无人应答 | 工具请求 900s 超时后以 `Local tool execution timed out after 900 seconds` 失败回传 | `local-tool-executor.ts:30`、`:109-112` |
| 事件订阅钩子 | `WsClient.on(handler)` 暴露原始 `WsEvent`，runner 即以此接入；daemon 可绕过 runner 直连 | `agent-cli/src/ws/ws-client.ts:113`、`session-runner.ts:124` |

### 1.2 问题

1. **在线判定与执行能力脱节**：设备在线判定是连接级（0.0.483 后横幅还会实时转绿），但真正能执行工具的前提是「该设备上有个进程 attach 了这个会话」。于是出现：daemon（或桌面端）在线 → 服务端放行发送 → `tool_execute` 定向到该设备 → 设备上没有任何进程处理 → 挂到 900s 超时才失败。0.0.483 只修好了「离线提示」，没解决「无人执行」。
2. **N 个 LOCAL 会话 = N 个 mao-agent 进程**：当前形态一个进程服务一个会话；同时跑多个本地任务就得开多个终端，无人值守时则完全不能跑（`-p` 打印模式跑完即退）。
3. **桌面端退出后本地任务停摆**：安卓 / 浏览器侧对话照旧能发，但工具无人执行（正是用户遇到的现象）。
4. **多进程竞争执行连接**：同设备后注册的连接会顶掉先注册的成为执行连接——daemon 一旦启动就会接管桌面端的执行连接，需要明确口径而非留作偶发行为。

### 1.3 机会

- **服务端路由本就是设备级**：`tool_execute` 按 `target_device_id` 找设备、投给该设备执行连接，从不过问「设备上哪个进程、attach 了哪个会话」。daemon 只要拿到本设备执行连接，天然能收到本机所有 LOCAL 会话的工具请求——**后端近乎零改动，主体工作量全在 CLI 新入口**。
- **`LocalExecutor` 天生可多会话**：`handleEvent` 按 `evt.sessionId` 分发、MCP 按 sessionId 键、审批登记按 requestId 键——复用现成类，不需要「按会话 N 个 executor」。
- **多端审批中继已通**：审批请求与回声都是全连接广播，daemon 不弹窗也能让用户在桌面 / 安卓投票后放行——headless 审批不需要新协议。

## 2. 需求描述

### 2.1 要做的

1. **P1 常驻入口**：新增 `mao-agent local --serve`（定稿，见 D1）。只组装 `WsClient` + `LocalExecutor`，**不创建 `SessionRunner`、不订阅任何会话、不过 `acceptEvent`**；进程前台运行，Ctrl-C / SIGTERM 优雅退出。
2. **P1 全会话事件路由**：`ws.on(evt => …)` 中把 `tool_execute` / `skill_sync_required` / `mcp_sync_required` / `tool_approval_resolved` 四类事件**不按 sessionId 过滤**地交给唯一 `LocalExecutor` 实例。
3. **P1 工作区信任根**：启动参数 `--workspace <dir>`（默认 `process.cwd()`）经 `ensureWorkspaceTrusted` 校验 / 登记后作为信任根；所有下发 workspace 走既有 `resolveWorkspace` 收窄（D3）。
4. **P1 headless 审批语义**：新增 `--on-approval=remote`（daemon 默认）：需审批时**不立即拒绝**，进入等待远端投票，超时（默认 300s，可配，见 D5）后拒绝；`--yolo` / `--force` / `--approve-rule` 直通口径不变；`--on-approval=fail` 保留「立即拒绝」。remote 分支**不看 TTY**（见 §4.1-2 / §4.1-4）。等待必须覆盖普通工具、shell 每一步、stdio MCP 拉起三处（见 §4.1）；等待期间不发不带 `approved` 的 `tool_approval`。远端「总是允许」只放行这一次，不写入进程级免审表。
5. **P1 可观测**：启动时打印信任根、审批口径、已连接账号与设备名；每个 `tool_execute` 打印一行（会话 id / 工具名 / 工作区）；退出时打印汇总（服务会话数、工具数）。不进 TUI。
6. **P1 执行连接竞争口径**（D4，定案 A）：明确顺序规则「谁最后连接谁执行；桌面端后启动夺回、关闭时 daemon 接棒」并写入文档与 CHANGELOG；**不做**后端订阅优先（D6-B 留作可选增强）。
7. **P1 device_status 语义细化**（D7，定案）：当前执行连接的 `clientType`（`electron` / `cli`）随上下线广播，并在执行连接交接（后启动顶替、断开回坐）时用同一帧再广播一次；会话详情/列表快照带可选 `executorClientType`。安卓 / 浏览器 / 另一台机器上的横幅据此区分「桌面客户端在执行 / mao-agent 在执行」。附着形态的 `mao-agent --local` 与 daemon 都是 `cli`，横幅不区分二者。
8. **P1 文档同步**：根 `CHANGELOG.md`、`agent-cli/README.md`、`skills/mao-cli/`（新增「常驻本地执行端」章节：命令、信任根、审批口径、与桌面端共存、无人值守注意事项）。

### 2.2 不做的（本期明确排除）

- **不改执行模式与会话绑定**：LOCAL / CLOUD 两值不变；`target_device_id` 创建即定、不可改绑；daemon 不引入「会话与 daemon 绑定 / 认领」——它服务本设备全部 LOCAL 会话。
- **不做多设备负载均衡 / 抢占式执行**：一台设备仍只有一个执行连接；不把任务调度到「空闲设备」。
- **不做 daemon 内交互式审批 UI**：headless 靠多端投票；不进 Ink、不读 stdin。
- **不改 `tool_execute` 路由主体**（D6-A 口径下后端零改动；B 为可选增强，仅改「同设备多连接时选哪条」）。
- **不做 MCP / shell 的进程隔离增强**：沿用按 sessionId 分桶的单进程模型（D8），不引入 worker 池。
- **不做服务化安装**：不提供 launchd / systemd 单元安装命令，仅在文档给范例（用户自行 `nohup` / 服务化）。
- **不做远端文件树 / 终端 / Git 代理**（与 2026-11-05 方案边界一致）。
- **不做「设备掉线把已下发未执行的工具重投到 daemon」**：工具请求已投给某连接即绑定该连接，掉线按既有 `failAllForDevice` 失败收敛（开放问题 §9-2）。

## 3. 技术选型（已定稿；D6-B 留作可选增强）

| # | 决策点 | 决策 | 落选项与理由 |
|---|---|---|---|
| D1 | 命令形态 | `mao-agent local --serve`（子命令 + 标志），与 `--local` 同词族——**定稿** | 复用现有 flags 解析与 `local` 分组；`chat.ts` 的 `localMode` 分支已验证 `WsClient + LocalExecutor` 组装可行，新入口只做减法（去 runner / 去渲染 / 去 TUI）。备选 `mao-agent serve` 独立子命令（见 §9-6），不影响其余设计 |
| D2 | 进程模型 | 单进程、单 WS 连接、无 HTTP / 无端口 | 设备身份已由连接承载；多连接只会互相顶执行连接（D4），无收益 |
| D3 | 工作区信任模型 | **单一信任根**（`--workspace`，默认 cwd），下发 workspace 必须落在其内（复用 `resolveWorkspace` / `isWorkspaceWithin`）——**定案** | 信任面最小、复用现成边界校验；per-session 信任需要持久化「会话 → 目录」映射并防服务端伪造（会话可被任意端创建），复杂且无明确收益。多仓库场景用「指向共同父目录并信任它」覆盖；若后续要服务散落目录，再放开 `trustedWorkspaces` 列表模式（`trust.ts` 已有持久化，一个 flag 的距离） |
| D4 | 执行连接竞争 | **接受 last-writer-wins（D6-A）——定案**：谁最后连接谁执行；桌面端后启动会夺回执行权，桌面端关闭时 `releaseDevice` 回坐到 daemon | 与 2026-11-05 D4「同设备多窗口覆盖为最新」完全同构，零后端改动、零新竞态。**关键实证**：`releaseDevice`（`streaming-ws-registry.ts:229-249`）在断开时会回坐到同设备另一条存活且已鉴权的连接——于是「桌面开着 → 桌面执行；桌面退出 → daemon 自动接棒」这一用户原始诉求由现有机制天然满足。**D6-B 留作可选增强**（`sendToDevice` 优先投「已 `subscribe` 该 sessionId 的连接」，`userSubscriptions` 已有数据，需 socket→deviceId 反查）：只在未来要「桌面开着会话就必须桌面执行」时才值得做 |
| D5 | headless 审批 | 新增 `--on-approval=remote`（daemon 默认）：需审批且本地不可交互 → 等远端投票（`takeRemoteChoice` / `approvalRemoteChoices`），**默认 300s 超时后 deny（可配）**——定案 | 复用已跑通的多端中继（请求 / 回声均全连接广播），无新协议；升级外推 180s 即触达用户，再给约 2 分钟反应；300s < 900s 服务端工具超时，保证在服务端判超时前收敛。`fail`（立即拒）与 `ask`（TTY 弹窗）保留 |
| D6 | 审批可见性 | **复用既有升级链，不新增通知**：审批待办进站内收件箱；3 分钟无人处理按用户偏好渠道外推提醒；daemon 侧只加「等回声 + 300s 超时拒绝」 | 设施已存在且已挂到 LOCAL 执行路径（`create-app.ts:770` → `deliveryService.prepareEscalation`，投票后 `handleToolApproval` → `suppressByRequest` 抑制）。daemon 的 300s 超时与之并存：先由升级通知触达人，再超时收敛。唯一缺口：通知与审批卡都不带「当前由哪个端在执行」，可选补（见 §9-3） |
| D7 | device_status 语义 | 保持「有执行端在线」语义（`hasDeviceConnection`）。`device_status` 帧增 `clientType`（`electron` / `cli`），取**当前执行连接**的类型；执行连接在仍在线的前提下发生交接时，再广播一帧 `online: true` + 新 `clientType`。会话 VO 增可选 `executorClientType`（无执行连接则为 null）。前端横幅区分「桌面客户端在执行 / mao-agent 在执行」——定案，随 daemon 同版本发布 | 现有 `broadcastDeviceStatus` 只在「无→有 / 有→无」时发（`streaming-ws-handler.ts:493-495`、`:563-576`、`:472-479`）。后启动顶替和 `releaseDevice` 回坐都不改变在线态，只改 payload 不会让横幅换文案。刷新走的是会话快照（`session.routes.ts` 的 `enrichSessions` 只写 `targetDeviceOnline`），不带这个字段的话安卓/浏览器一打开就退回旧文案。`client` 字符串仍只用 `electron` / `cli`：`normalizeClient` 把未知值收成 `browser`，而 `browser` 不在 `LOCAL_CAPABLE_CLIENTS` 里，新增值会让 daemon 根本登记不上执行端 |
| D8 | 多会话并发 | 单 `LocalExecutor` 服务全部会话：shell / MCP / 审批登记均按 sessionId 或 requestId 分桶，天然隔离 | 现成实现即多会话安全（`executor.ts:122-150`）；工具执行以 IO 等待为主，单事件循环足够；单个请求仍有 900s 服务端超时兜底，不引入 worker 池 |
| D9 | 断线重连 | 复用 `WsClient` 指数退避重连；重连后重新注册 → 重新成为执行连接。`connected` 帧仍要调用 `setApprovalRelaySupported`（daemon 不经过 `SessionRunner`，不会自动接到）。等待远端审批期间连接断开：**立刻**以 `tool_error` 失败该等待，进程不退 | `replayApprovalVotes` 只补发执行端自己上行过的投票。remote 模式 daemon 没有本地投票；`tool_approval_resolved` 是一次性广播，daemon 不 subscribe，重连不会重放已错过的回声。继续干等 300s 再拒绝，会把其他端已经投过的票打成失败 |
| D10 | 技能 / MCP 同步 | 沿用 `sendToDeviceFamily`（同设备全部连接都会收到）。daemon 能处理则回包；**工作区落在信任根外时不回包**（不发 `skill_sync_done: false`，也不发全失败的 `mcp_tools_report`） | 服务端按 `syncId` 取第一份匹配回包（`handleSkillSyncDone` 失败即 reject；`handleMcpToolsReport` 记录后 resolve）。先到的失败会判负整轮，后到的成功被丢掉。信任根外静默，把这一轮留给同机桌面端；仅 daemon 在线时落到既有同步超时 |

## 4. 实现步骤

### 4.1 终端 CLI（agent-cli，主体）

1. **新命令文件** `src/commands/local.ts` + `src/main.ts` 的 `case 'local'`；`src/args.ts` 的 `LOCAL 模式` 分组补 `--serve`（boolean），并**沿用既有 `--workspace <dir>`**（chat 里它就是「本地工作区」，daemon 里即「信任根」，同一语义、同一个 flag，不造第二个概念；默认 `process.cwd()`）。
2. **组装**（对照 `commands/chat.ts:97-163` 做减法）：
   - `WsClient`（同参数：baseUrl / getToken / debug / 重连提示）。`getToken` 必须是现成 `createTokenResolver`（临期刷新），不能把启动时的 access token 固化进闭包：`openOnce()` 每次连接都重新 `await getToken()`（`ws-client.ts:194`），固化会让重连永远拿旧票。
   - `ensureWorkspaceTrusted(trustRoot, canPrompt=false)`——非交互启动，未信任直接报错退出（文案引导「先在交互终端 `mao-agent --local` 输入 y，或写入 `trustedWorkspaces`」），**不静默信任**。
   - `LocalExecutor`：`workspace: trustRoot`；`policy` 由 `--on-approval`（默认 `remote`）/ `--yolo` / `--force` / `--approve-rule` / `--strict-danger-check` 组装，并**固定 `stdoutIsTty: false` / `stdinIsTty: false`**——daemon 没有交互式审批面，这两个位一旦跟随真实终端，`canPrompt()`（`approval.ts:101`）在挂终端时为真，remote 分支不触发就会掉到 `ask()` → 没传 `askApproval` → `defaultAsk` 起 readline 读 stdin（`executor.ts:85-93`），与「不进 Ink、不读 stdin」矛盾，且行为随是否挂终端漂移。钉死 false 后 `canPrompt` 恒假，`approveMcpSpawn` 的「无法交互即拒绝」分支（`:562`）也不会误触；**不传 `askApproval`**（无 TUI / 无 readline）；`deliverApproval` 留空或仅日志。
3. **事件路由**：`ws.on` 分两支。
   - `connected`（`sessionId` 为 null）：`executor.setApprovalRelaySupported(data.approvalRelay === true)`。这条在附着形态里由 `SessionRunner` 转给 `chat.ts`；daemon 绕过 runner，不接上则能力位永远是 false。
   - `ROUTED_EVENT_TYPES = { tool_execute, skill_sync_required, mcp_sync_required, tool_approval_resolved }` 交给唯一 `LocalExecutor`。**不调用 `acceptEvent`，也不 subscribe 任何会话。**
   - 技能 / MCP：先 `resolveWorkspace`。落在信任根外就**直接 return，不回包**。`onSkillSync` 今天不看 workspace，这里要补上同一道收窄；`onMcpSync` 已有收窄，但失败时会发全失败的 `mcp_tools_report`，这条路径改成不回包。能处理的照常回 `skill_sync_done` / `mcp_tools_report`。仅 daemon 在线且工作区在根外时，服务端走既有同步超时。
4. **远端审批语义**（`src/local/approval.ts` + `executor.ts` 三个调用点）：
   - `ApprovalDecision` 增 `{ action: 'await-remote'; timeoutMs: number }`；`ApprovalPolicy.onApproval` 增 `'remote'`。
   - `evaluateApproval`：`needApproval` 且 `onApproval === 'remote'` → `await-remote`。**条件里不写「本地不可交互」**：`canPrompt` 依赖 TTY 位（`approval.ts:101`），daemon 的 policy 已把两位钉成 false（§4.1-2），写上去反而给人「挂终端时会走 ask」的误读。保留既有兜底顺序：denylist / 危险硬门 / `--approve-rule` / 总是允许 / `--yolo` 优先判定，全部不变。
   - 等待不能只写在 `ask()` 里。`onToolExecute` 只在 `decision.action === 'ask'` 时才进 `ask()`；`await-remote` 会掉进后面的 `else if (needApproval && !shellPrompts)`，发出**不带 `approved`** 的 `tool_approval`。服务端 `unregister` 无决策时仍会摘掉 pending、抑制 180s 升级、广播 `approved: null` 并把相位恢复 RUNNING（`approval-registry.ts:151-170`），工具接着就执行了。shell 的 `approveShellText`、MCP 拉起的 `approveMcpSpawn` 同样要接住：后者在 `!askApproval && !canPrompt` 时现在直接拒绝，remote 模式会把 MCP 进程启动打回立即拒绝。
   - 三处统一：先取 `approvalRemoteChoices`（回声可能已到），否则登记等待。收到 `approved` 为布尔的 `tool_approval_resolved` 再放行或拒绝。**等待期间不发 `tool_approval`**；别人已经投票认领过，daemon 也不补发一帧（补发只会走 `resendRecentResolution` 空转）。`approved: null` 不当作远端决策。
   - 超时默认 **300s**（可配）→ `deny` + `tool_error`。`exitApproval` 在 daemon 下只记日志，不退出进程。
   - **等待中断开连接：立刻按同一口径失败该等待**，不等满 300s（D9）。这需要两个新钩子——`WsClient` 现在只有 `onReconnect` / `onConsecutiveReconnectFailures`，**没有断开回调、也没有公开的连接状态访问器**（`ws-client.ts:30-31`）；`LocalExecutorOptions` 也没有任何断开入口（`executor.ts:38-49`）。实现：`WsClient` 增 `setOnDisconnect(fn)`（close / transport error 时触发），`LocalExecutorOptions` 增 `onWsClosed?: () => void` 并配一个 `failRemoteWaits()`（把全部在等回声的请求按 `tool_error` 失败、清定时器）。注意服务端侧其实已经收敛：设备断开时 `failAllForSocket` / `failAllForDevice` 已把该连接的 pending 请求以 `Device disconnected` 失败（`local-tool-session-registry.ts:85/101`）——CLI 侧立刻失败是为了不留孤儿定时器、避免迟到回声触发一次服务端已放弃的执行，不是替代服务端收敛。
   - 远端选择「总是允许」：本轮放行，**不调用 `recordAlwaysAllow`**。该表挂在进程级 `policy` 上，附着形态一个进程一个会话，daemon 共用一个 executor，记进去会让别的会话的相同命令不再等人投票。后续免审只认服务端按会话写下的规则（下一轮 `needApproval=false`）。
   - `args.ts` 的 `on-approval` 枚举加 `remote`；daemon（`--serve`）下默认 `remote` 且**禁止显式 `ask`**（无处弹窗，与既有「打印模式非 TTY 不允许 ask」同口径报错）。
5. **生命周期**：`SIGINT` / `SIGTERM` → 关掉全部 shell 与全部 MCP → `ws.close()` → 打印汇总；异常退出码非零并提示重启方式。现成 `executor.close()` 不带 `sessionId` 时只 `shell.closeAll()`，`mcp.close` 要有 sessionId 才干活，stdio MCP 会留下。给 `McpManager` 补 `closeAll()`（遍历 `sessions`），daemon 退出走它。不落任何状态文件（无状态守护，重连即恢复）。
6. **日志**：`--debug` 走既有 logger；常规一行一工具（会话 id / 工具名 / workspace / 耗时），不打印参数正文。启动 banner 含账号、设备名、信任根、审批口径。
7. **deviceId**：复用 `ws-client.ts` 现有 auth `device` 上报与持久化，**零改动**。

### 4.2 后端（backend-ts）

- **D6-A 口径：零改动。** 设备身份、定向委托、`device_status` 广播（0.0.483）均已就绪。
- **D6-B 可选增强**（若未来需要，本期不做）：`streaming-ws-registry.ts` 的 `sendToDevice` 在选择执行连接时，若存在同设备且已订阅该 `sessionId` 的连接则优先投它（`userSubscriptions: Map<userId, Set<sessionId>>` + `connectionDevice` 反查）；无订阅连接时保持现状。仅影响 `tool_execute` 一类事件（skill / mcp 同步继续 `sendToDeviceFamily`）。
- **D7（定案）**：
  - `broadcastDeviceStatus` payload 增 `clientType`，从**当前执行连接**取（`getDeviceExecutorSocket` + `getClientType`），取值只可能是 `electron` / `cli`。
  - 上下线跃迁照旧广播。另外两处在设备仍在线时也要发一帧 `online: true`：`register` 把同设备执行连接覆盖成另一条、且 `clientType` 变了；`releaseDevice` 回坐到另一条存活连接、且 `clientType` 变了。类型没变（两个桌面窗口互顶、两条 cli 互顶）不发。
  - **取数手法**：`releaseDevice` 是 registry 私有方法，handler 拿不到回坐结果——但 `afterConnectionClosed` 里 unregister 之后直接调 `getDeviceExecutorSocket(userId, deviceId)` 即可拿到回坐后的连接及其 `clientType`（该方法公开，`streaming-ws-registry.ts:501`）；register 路径在 register **之前**取一次旧执行连接（0.0.483 的 `deviceWasOnline` 已是这个写法），注册后比较 `clientType` 是否变化。不要去改 registry 的可见性。
  - `enrichSessions`（列表和详情共用）在写 `targetDeviceOnline` 的同时写可选 `executorClientType`：有执行连接则取其 `clientType`，否则 null。**同时要往 `SessionVO` 接口加同名字段**（`session-vo.ts:36` 一带，与 `targetDeviceOnline` 并列）——enrichSessions 是 `vo.xxx = …` 后写，接口不加字段 tsc 直接报错。注入走**可选回调** `deps.getExecutorClientType?: (userId: number, deviceId: string) => string | null`，仿既有 `deps.hasDeviceConnection`（`session.routes.ts:70` 的先例），缺省回落 null；不要把整个 WS registry 塞进 HTTP 层。不入库、不加迁移。
  - 不新增 `client` 枚举值。附着形态和 daemon 都报 `cli`。

### 4.3 桌面端（desktop，Web / 安卓同源生效）

- **D7**：`stores/session/list.ts` 的 `applyDeviceStatus` 增加可选 `clientType`，比较时连同在线态和设备名一起看（只改类型也要写入）。`useStreamWS` 从 `device_status` 取出该字段；`SideChatPanel` 写回边路 meta 时带上。会话实体与 REST 快照增加可选 `executorClientType`，打开会话时用快照填上，避免刷新后要等下一次上下线才有文案。
- 文案只改 `LocalTargetBanner`：在线且 `executorClientType === 'electron'` 为「桌面客户端在执行」，`cli` 为「mao-agent 在执行」，字段缺失回落到现文案「该任务在 {设备名} 上执行」。这条横幅在「当前设备就是绑定设备」时不渲染，所以区分只出现在安卓、浏览器和另一台机器上；执行机自己的 Electron 窗口看不到，联调不要只看那一个窗口。`ChatInput.vue` 的离线拦截文案与逻辑不变。
- **D6-B**：本期不做；若未来落地，无前端改动（路由在服务端）。

### 4.4 契约（shared/contracts）

- 无新增枚举。`device_status.clientType` 与会话 VO 的 `executorClientType` 都是可选字符串（`electron` / `cli` / 缺失），旧端忽略未知 JSON 字段。不把它们收成 `@mao/contracts` 联合：两端字面量各自解析，缺省有明确回落。若以后要穷尽检查，另立小改，不要顺手加一个新的 `client` 值。

## 5. 落地清单

| 端 / 文档 | 项 |
|---|---|
| agent-cli | `src/commands/local.ts`（新入口：WsClient + 刷新中的 getToken + `connected` → `setApprovalRelaySupported` + 断开 → `onWsClosed` + 四类事件路由 + 生命周期 + 日志）、`src/main.ts`（`case 'local'`）、`src/args.ts`（`--serve` / 沿用 `--workspace` / `on-approval=remote`）、`src/local/approval.ts`（`await-remote`，条件不看 TTY）、`src/local/executor.ts`（`onToolExecute` / `approveShellText` / `approveMcpSpawn` 三处等待；`onWsClosed` + `failRemoteWaits`；信任根外的技能与 MCP 同步不回包；不把「总是允许」写入进程级表）、`src/local/tools/mcp.ts`（`closeAll`）、`src/ws/ws-client.ts`（`setOnDisconnect`） |
| backend-ts | D6-A 的工具路由：无。D7：`streaming-ws-handler.ts`（上下线与执行连接交接都带当前执行连接的 `clientType`，取数用 `getDeviceExecutorSocket`）、`session.routes.ts` 的 `enrichSessions`（可选 `executorClientType`，按可选回调 `getExecutorClientType` 注入，缺省 null）、`session-vo.ts`（`SessionVO` 增同名字段）。D6-B 本期不做 |
| desktop | D7：`applyDeviceStatus` / `useStreamWS` / `SideChatPanel` 传递 `clientType`；会话实体保存 `executorClientType`；`LocalTargetBanner` 在线文案三分。离线拦截不动 |
| contracts | 无 |
| 测试 | 见 §7 |
| 文档 | 根 `CHANGELOG.md`（终端 CLI 小节）；`agent-cli/README.md` 与 `agent-cli/local-executor/README.md`（常驻形态章节）；`skills/mao-cli/`（常驻本地执行端：命令、信任根、审批口径、与桌面端共存、无人值守注意事项） |

## 6. 风险与回归护栏

| 风险 | 护栏 |
|---|---|
| **daemon 启动即接管执行连接**（D6-A）：桌面端正开着的会话，其 `tool_execute` 改由 daemon 执行；结果一致，但**桌面端「执行机器自动弹出的原生审批卡」不再出现**（改为广播卡——桌面 / 安卓 / Web 任一端都能投票，见 §1.1 审批行） | 顺序规则写进文档：**谁最后连接谁执行；桌面端后启动会夺回，桌面端关闭时 `releaseDevice` 回坐到 daemon**（`streaming-ws-registry.ts:229-249`）；启动 banner 明示「已接管本机 LOCAL 执行连接」；CHANGELOG 与 mao-cli 文档同步。若未来要「桌面开着会话就必须桌面执行」再走 D6-B |
| daemon 退出后桌面端不自动恢复执行 | `releaseDevice` 已有 fallback（同设备仍有连接则回坐），与桌面多窗口互顶同语义；文档提示退出 daemon 后确认桌面端仍在 |
| **无人值守时审批无人投票** → 最长挂起 | 300s 超时后 deny（< 900s 服务端工具超时，先收敛）；超时值可配。期间并非完全无声：收件箱有审批待办、180s 无人处理会按用户偏好渠道外推提醒（既有设施）。文档仍建议无人值守场景配 `--yolo` 或会话等级设 `FULL` |
| 信任根外的工作区被拒 | 工具请求：启动时打印信任根；`resolveWorkspace` 抛错的文案已含「不在本地工作区内」，经 `tool_error` 回传，对用户可见。技能 / MCP 同步：信任根外不回包，避免失败回包抢先判负整轮（D10）；不静默扩大信任面 |
| 仅 daemon 在线且工作区在信任根外：静默不回包的两种后果不对称 | 技能同步静默 → 60s 后报「客户端 60 秒内未回报技能同步结果」，**整个执行失败**（`streaming-ws-handler.ts:2440`、`:940-946`）；MCP 同步静默 → 超时后 `clearLocalSession`，仅该轮 MCP 工具不可用、执行继续（`:2490-2493`）。此场景下工具同样被 `resolveWorkspace` 拒，执行本来也活不了，故不回包策略不变；症状写进文档与 CHANGELOG，避免实现期被当成 daemon bug 排查 |
| 用户手滑起两个 daemon（或 daemon + `mao-agent --local` 附着形态） | 与同设备多窗口同语义（后注册者顶替），文档明示「一个设备一个常驻执行端」；被顶替方空跑但不报错（保持现状行为，不新增互斥锁） |
| 重连竞态：重连成功到重新注册之间 `tool_execute` 落到旧连接 | 与桌面端重连同语义（现状既有），900s 超时兜底；不新增约束 |
| 等待远端审批时连接断开，回声已经广播过 | 立刻 `tool_error` 失败该等待（D9）。不把「干等 300s」当成断线恢复 |
| **安全面扩大**：daemon 长期在线等价于「本账号的远端会话可随时在本机执行 shell」 | 信任根收窄 + 非 TTY 默认远端审批（无本地确认不放行）；文档明确提示「守护进程 = 把本机 shell 开放给自己账号的会话，请在可信机器上运行」；不上 root、不进登录项 |
| skill / mcp 同步双回包（daemon + 桌面都执行同步） | 成功的双回包：先到者生效，后到者 pending 已清。失败回包会判负整轮，所以信任根外必须不回包（D10）。两边都能处理时仍可能各起一份 MCP，见下一行 |
| MCP 双实例（daemon 与桌面各起一份）资源占用 | 与「桌面 + CLI 附着形态并存」现状相同；文档提示避免长期双开 |
| 长命令占住单进程 | 每个请求有 900s 服务端超时；shell 按 sessionId 分桶互不阻塞；不引入 worker 池（D8）。用户停止执行只让服务端 `failAllForSession`，没有发到执行端的取消帧（桌面端相同），daemon 上已经启动的 shell / MCP 会自己跑完 |
| 「总是允许」跨会话泄漏 | daemon 不把该选择写入进程级 `alwaysAllow`；本轮放行，之后只认服务端会话规则 |
| Windows / 平台差异 | shell 走 `vendor/localShell.cjs`（与桌面 `electron/localShell.cjs` 同源），现状已覆盖 |
| 回归：chat 附着形态被误伤 | 新入口为独立文件，`chat.ts` / `SessionRunner` / `acceptEvent` / `approval.ts` 既有分支保持字节级行为（仅新增枚举成员与 `await-remote` 分支），既有 spec 不回退 |

## 7. 测试要点

**agent-cli（`cd agent-cli && npm run build && npm test`）**

1. **新入口 smoke**（mock `WsClient`，沿用 `test/local-executor.spec.ts` 的既有范式，不起真服务）：`--serve` 启动 → auth 带 device → 收到**未附着会话**的 `tool_execute` → 本地执行 → `tool_result` 回传（断言不过 `acceptEvent`、不 subscribe 任何会话）。
2. **事件路由**：`connected` 调用 `setApprovalRelaySupported`。`tool_execute` / `skill_sync_required` / `mcp_sync_required` / `tool_approval_resolved` 对任意 sessionId 均被 `LocalExecutor` 接收。其余事件类型被忽略（不崩、不路由），且不 subscribe。
3. **远端审批**：需审批 → 不立即 deny、不发 `tool_error`、**也不发 `tool_approval`**。普通工具、shell 一步、stdio MCP 拉起三处都等 `approved` 为布尔的回声再放行或拒绝；`approved: null` 不放行。超时（测试用小值）→ deny + `tool_error`，进程不退。等待中 WS 断开 → 立刻 `tool_error`，不等满超时（`setOnDisconnect` → `onWsClosed` → `failRemoteWaits`）。**在真终端里跑 `--serve`（stdin/stdout 都是 TTY）也不得出现 readline 提问**（policy 的 TTY 位被钉死）。远端「总是允许」只放行这一次，下一次相同命令的另一个 sessionId 仍等待。
4. **审批优先级不回退**：denylist 命中 / `--strict-danger-check` 非 TTY / `--approve-rule` 命中 / `--yolo` / `--force` / 总是允许 —— 在 remote 模式下判定顺序与现一致（既有 `approval.spec` 扩表，不重写）。
5. **信任根**：启动目录不存在 → 报错退出；未信任且非交互 → 报错退出并给引导文案；已信任 → 放行；下发 workspace 在根内 → 收窄通过、在根外 → 工具 `tool_error`（中文可读）。同一根外路径的 `skill_sync_required` / `mcp_sync_required` **零回包**。
6. **参数校验**：`--serve` + `--on-approval=ask` → 报错（同打印模式口径）；`--on-approval` 枚举含 `remote`；`--workspace` 相对路径按 cwd 解析。
7. **生命周期**：SIGTERM → shell 与全部 session 的 MCP 都关闭（`closeAll`，不依赖 sessionId）、WS 断开、退出码 0、打印汇总。
8. **重连**：断线 → 重连 → auth 重新注册（device 不变）→ 再次收到 `connected` 时刷新审批中继能力位。remote 等待不依赖 `replayApprovalVotes`。
9. **回归**：`chat` 附着形态全量既有 spec 不回退（会话过滤、切会话重建 executor、`-p` 模式等）。

**后端（D7 落地，`cd backend-ts && npm test`）**

10. `device_status` 带当前执行连接的 `clientType`。单独上线：electron → `'electron'`，cli → `'cli'`。设备已经在线时，cli 再连上且成为执行连接 → 再发一帧 `online: true, clientType: 'cli'`；该 cli 断开、回坐到仍在的 electron → 再发一帧 `clientType: 'electron'`。两条同类型连接互顶不发。设备从有到无才发 `online: false`。`SessionVO` 增 `executorClientType`；`enrichSessions` 在线时与执行连接一致，离线 / 未绑定 / **未注入 `getExecutorClientType` 回调**（HTTP 层单测场景）为 null 或缺省。无新表、无迁移。

**前端（D7 落地，`cd desktop && npm run test:unit && npm run build`）**

11. `applyDeviceStatus` 在在线态没变、只有 `clientType` 变了时仍写入。`LocalTargetBanner`：`electron` / `cli` / 字段缺失三条在线文案；离线文案不变。当前设备等于绑定设备时横幅仍不渲染。`ChatInput` 离线拦截不改。

**手工联调（必须）**

12. 起 daemon（`mao-agent local --serve --workspace ~/proj`）→ 退出桌面客户端 → 安卓 / 浏览器向该设备的 LOCAL 会话发消息 → 工具由 daemon 执行、结果回传；需审批的工具在桌面 / 安卓弹出卡片，投票后 daemon 放行；无人投票 300s 后失败且文案可读。
13. 桌面客户端在线 + daemon 后启动 → 工具改由 daemon 执行（D6-A）；安卓或浏览器横幅从「桌面客户端在执行」变为「mao-agent 在执行」，刷新后仍是后者。退出 daemon → 桌面端恢复接收，横幅回到「桌面客户端在执行」。执行机自己的 Electron 窗口不显示这条横幅，不要拿它当断言对象。
14. 两个 LOCAL 会话同时对话 → daemon 并发执行、互不串扰（MCP / shell 分桶）。
15. `mao-agent --local` 附着形态 + `--serve` 并存 → subscribe 不改变 `tool_execute` 去向，后启动者接管执行；被顶替的进程仍能收到审批广播，但工具只在执行连接上跑。另注意 daemon **不 subscribe**，因此不会触发 `handleSubscribe` 里的惰性认领（`streaming-ws-handler.ts:637-647`）——会话的 `target_device_id` 登记仍由桌面端 / 附着端打开该会话时发生，daemon 只消费已登记的定向。与文档口径一致，人工确认即可。

**回归（不新增 E2E，手工覆盖）**

16. 桌面本机 LOCAL 任务全链路（无 daemon）与改动前一致；CLOUD 会话完全不受影响。

## 8. 发布与文档

1. **发布顺序（硬约束）**：先后端（`device_status.clientType` 与会话 VO 的 `executorClientType` 都是可选字段，旧桌面端忽略未知字段），再 `bash scripts/deploy-desktop.sh`（横幅展示分支），最后发 `mao-agent`（CLI）。反向顺序下 CLI 先发也安全（后端旧版不回这两个字段，前端回落现文案），但横幅要等 desktop 部署后才区分类型。
2. **CHANGELOG**（根 `CHANGELOG.md` 顶部新建版本小节，版本号取落地时下一个）：终端 CLI 小节——新增 `mao-agent local --serve` 常驻本地执行端：不加入会话即可替本机全部 LOCAL 会话执行工具；`--workspace` 指定信任根；需审批时默认等待桌面 / 安卓 / Web 任一端投票（超时拒绝），`--yolo` 可全自动；与桌面客户端同时在线时后启动者接管执行。
3. **mao-cli 文档**（`skills/mao-cli/`）：新增「常驻本地执行端」——适用场景（桌面不开机也要跑本地任务 / 多本地任务一个进程）、命令与参数、信任根与 `trustedWorkspaces`、审批口径与无人值守建议（`--yolo` / `FULL` 等级）、与桌面客户端共存的顶替语义、安全提示。
4. **agent-cli 文档**：`README.md` 命令表补 `local --serve`；`local-executor/README.md` 补「常驻形态与附着形态的差别」（事件过滤、审批、执行连接顶替）。
5. **回滚**：CLI 回退到旧版即可（无服务端状态、无 DB 变更）；后端 `clientType` 字段与前端展示分支可随下次发布回退——旧端忽略未知字段、新端缺省回落现文案，双向兼容。

## 9. 开放问题（待讨论，不阻塞主链路）

1. **引导起 daemon**：会话绑定设备在线但执行连接是「桌面端」而用户其实希望无人值守——服务端 / 前端要不要在检测到「桌面端执行 + 无人在场」时提示起 daemon？（需要新的在场信号，成本高，倾向不做）
2. **执行中桌面退出（daemon 在线）**：已投给桌面的 pending 工具按 `failAllForDevice` 失败；要不要「同设备 daemon 在线时自动重投」？会让执行语义复杂化（重复副作用风险），倾向不做、由 AgentLoop 现有失败路径收敛。
3. **daemon 执行时的审批体验**：升级外推已存在（180s），但通知与审批卡都不带「当前由哪个端在执行」。横幅侧的 `clientType` 只有 `electron` / `cli`，没有单独的 daemon 值。若以后要写进审批卡，复用这两个值即可，不要新加 client 类型。
4. **多 daemon / 多设备的可观测**：要不要 `mao-agent local --status`（本机 daemon 是否在跑、正服务哪些会话）或管理后台设备视图？与 2026-11-05 方案「不做设备列表接口」的边界需一并讨论。
5. **与 chat 附着形态的统一**：长期看 `mao-agent --local`（附着）与 `local --serve`（守护）是否合并为「同一进程、按需附着」的单一形态？本方案保持双入口最小改动，统一留待形态稳定后另议。
6. **命令名最终形态**：本方案定稿 `mao-agent local --serve`；若实现时认为「local 是模式、serve 是形态」应分层，可改独立子命令 `mao-agent serve`——不影响其余任何设计。
