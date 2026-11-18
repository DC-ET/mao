# 本地任务终端跨端开放技术方案（浏览器 / 安卓使用执行端本机终端）

- 状态：已实施（2026-11-19 落地。2026-11-18 可行性评审通过并补充 §4.5-§4.7 缺口；实现与方案一致，§4.4 的 TaskIndexPanel 按钮改造按「目标会话绑定判定」落位，§10 与文件代理方案并行边界保持：终端帧不走 `/ws/stream`、不改 `sendToFileCapableDevice`）
- 日期：2026-11-18
- 关联方案：
  - [2026-11-05-local-task-device-delegation-technical-design.md](./2026-11-05-local-task-device-delegation-technical-design.md)（前置依赖：设备身份、创建即绑定、定向委托、浏览器接管 LOCAL 会话对话。其 §2.2 / §9-3 明确排除「文件树 / 终端 / Git 远程代理」，本方案是其中「终端」的独立方案）
  - [2026-11-17-local-file-tree-remote-proxy-technical-design.md](./2026-11-17-local-file-tree-remote-proxy-technical-design.md)（已落地的文件树代理。本方案复用其「只定向、不广播、CLI 与 Electron 要分开认」的投递口径，**不复用** `file_op_request` 通道）
  - [2026-09-03-cloud-terminal-design-v2.md](./2026-09-03-cloud-terminal-design-v2.md)（已上线的云端终端。观看端协议、xterm 面板、环形缓冲、接管、背压、回放过滤全部复用；服务器 PTY 与 `terminal:use` 的语义不动）
  - [2026-06-08-terminal-design.md](./2026-06-08-terminal-design.md)（Electron 本机终端，已上线。本机按钮仍走这条 IPC 路径）
  - [2026-11-18-agent-cli-file-op-technical-design.md](./2026-11-18-agent-cli-file-op-technical-design.md)（规划中：mao-agent 实现文件代理。与本方案同时开发的边界见 §10，不共用通道）
- 能力底座（撰写时已在当前工作区核实，本方案组装它们，不重写）：
  - 顶栏可用性矩阵：`desktop/src/components/common/TopNav.vue:218-239`。LOCAL 且 `!isElectronClient()` 时禁用，tooltip「本地任务的终端仅在桌面客户端可用」
  - 观看端面板：`desktop/src/composables/useTerminal.ts`。`createTerminal` 按 `executionMode` 分流（`:331-337`）；CLOUD 走 `POST /sessions/:id/terminals` + `/api/ws/terminal`；LOCAL 走 `electronAPI.terminal.create`。`visibleTabs`（`:114-121`）在非 CLOUD 时展示**全部** `mode==='local'` 的 tab，不按会话、也不按绑定设备过滤
  - 云端终端服务端：`TerminalManager`（`backend-ts/src/harness/terminal/terminal-manager.ts`）在服务器上 `node-pty` spawn；REST `backend-ts/src/session/terminal.routes.ts:46-49` 对非 CLOUD 直接拒绝「仅云端任务支持远程终端」；WS `TerminalWsHandler` 在 attach 时校验 `terminal:use`（`terminal-ws-handler.ts:243-246`）。断线只解绑、PTY 与环形缓冲继续（`remote-terminal.ts:129-131`、`terminal-ws-handler.ts:170-172`）。回放前 `sanitizeReplayData`
  - WS 注册约束：`@fastify/websocket` 只能 `register` 一次，新路由必须写在 `attach-websocket.ts` 现有 `register` 之后（`:16-20` 与 `:55-57` 的注释）。`/ws/stream` 与 `/ws/terminal` 共用 `maxPayload: 1MB`（`:19`）
  - 本机 PTY：`desktop/electron/terminalManager.cjs` 用 `node-pty`，shell 取 `SHELL` 否则 macOS `/bin/zsh`、其它 `/bin/bash`（`:111-115`），参数为空数组（`:36`）。环境由 `main.cjs` 的 `buildShellEnv`（`:390-413`）注入用户 PATH、`MAO_TOKEN`、`MAO_BASE_URL`。输出只在 `mainWindow` 仍存在时 `webContents.send`（`main.cjs:2091-2094`）
  - 系统终端 App：`main.cjs:2080-2082` 的 `open-terminal` 在 macOS 上 `open -a Terminal`。任务列表按钮只是用 `electronAPI.openTerminal` 的**存在性**当「是不是桌面客户端」的探针，实际打开的是内嵌终端（`TaskIndexPanel.vue:979-988`）
  - 设备绑定：会话 `targetDeviceId` / `targetDeviceOnline` / `executorClientType`。`executorClientType` 是 `deviceExecutors` 槽里那一条连接的类型（`streaming-ws-handler.ts:530-533`），Electron 与 mao-agent 同机时该槽可能被 CLI 占住。文件代理因此不用它，而扫描该设备全部连接（`streaming-ws-registry.ts:525-548` `sendToFileCapableDevice`）
  - 设备身份文件：桌面端与 mao-agent 共用 `~/.mao/agent-cli/device.json`（`desktop/electron/desktopPrefs.cjs:21-28`）。渲染进程经 `getLocalDeviceInfo()` 读取（`desktop/src/utils/device-info.ts:12-21`）
  - 本机偏好：`desktop-prefs.json`，机器级、不随登出清除，缺字段用默认值（`desktopPrefs.cjs:4-6`、`:48-56`）。关窗默认 hide 到托盘，渲染进程仍在（`main.cjs:1315-1324`）；页面 `loadURL` 刷新会重建渲染进程
  - 配额：`terminal.maxSessionsPerTask` 默认 5、`maxSessionsGlobal` 默认 50、`idleTimeoutMinutes` 默认 120、`maxLifetimeHours` 默认 24、`outputBufferBytes` 默认 262144。启动时读一次，改设置需重启后端（`settings.service.ts:570-586`）
  - 删除会话：`create-app.ts:522` 把 `terminalManager.closeBySession` 接到 `SessionService` 的删除钩子
- 本方案定位：LOCAL 会话在浏览器、安卓、以及另一台电脑上打开内嵌终端。PTY 跑在绑定设备上，主机是这台设备的 Electron 主进程或 mao-agent 进程（`local --serve` 与交互式 LOCAL 都算）；工作目录是该会话在那台设备上的工作区。服务器只登记、转发、回放，不起 shell。观看端就是这台设备上的 Electron 时，顶栏新建仍走现有 IPC。

## 0. 名词约定

沿用 2026-11-05 方案的「执行端 / 设备、定向发送」。本方案新增：

| 名词 | 含义 |
|---|---|
| 本机终端 | 执行端 Electron 主进程里、由本机面板经 IPC 创建的 PTY。不登记到服务器，其它客户端看不到 |
| 中继终端 | 由非执行端（或执行端面板里的「远程标签」）发起、PTY 仍在执行端主进程、字节经服务器转发的终端。按会话隔离 |
| 观看端 | 打开 xterm 面板的那个客户端。协议仍是 `/api/ws/terminal` |
| 主机 | 绑定设备上持有 PTY 的进程。Electron 主进程或 mao-agent 进程，另开 `/api/ws/terminal-host`。同设备同时存在时 Electron 优先。连接在线即可被同账号的其它客户端打开，无单独开关 |

## 1. 需求背景

### 1.1 现象

浏览器或安卓打开一个 LOCAL 任务，顶栏终端按钮禁用，悬浮文案是「本地任务的终端仅在桌面客户端可用」。同一任务在绑定的那台桌面客户端里可以打开终端，工作目录就是任务工作区。

云端任务没有这个限制：Web、Electron、安卓都能开服务器上的 bash，前提是 `terminal:use`。

### 1.2 原因

本地终端的进程在 Electron 主进程（`node-pty` + IPC）。浏览器和安卓没有 `electronAPI`。这是 2026-11-05 方案写明留到后续的能力，不是按钮漏了判断。

不能把 LOCAL 会话改接到现有云端终端。`terminal.routes.ts:48-49` 拒绝非 CLOUD 是对的：`session.workspace` 在 LOCAL 下是**用户电脑上的绝对路径**，拿到服务器上去 `spawn`，会在服务器文件系统上开一个 shell。路径碰巧存在时，用户进入的是错误的机器。

也不能复用 `file_op_request`。文件代理是短请求、短响应；终端是长时间双向字节流，还要改尺寸、回放、接管、背压。`/ws/stream` 与 Agent 事件共用 1MB 入站上限，超限会拆掉整条会话连接（文件代理方案 D8 已写明这个后果）。云端终端当初单独拆 `/ws/terminal`，就是为了躲开这条流。

### 1.3 顺带要收的现有缺口

Electron 打开**另一台设备**绑定的 LOCAL 会话时，顶栏仍判定「本地终端可用」（`TopNav.vue:227-229` 只看是不是 Electron），`visibleTabs` 会把本机 IPC 终端全部展示出来（`useTerminal.ts:120`）。`toggleTerminal` 把对方会话的 `workspace` 当作 cwd 交给本机 `node-pty`（`TopNav.vue:236-238`）。两台机器上若存在相同路径，用户会在自己电脑上打开一个看似对方工作区的 shell。与文件树方案 D6 收掉的「双机互看读错机器」是同一类问题。本方案在执行端判定上一起收口。

## 2. 需求描述

### 2.1 要做的

1. **中继终端**：LOCAL 会话、观看端不是绑定设备时，`POST /v1/sessions/:id/terminals` 不再拒绝。服务器向该设备的主机发 `open`，主机在本机 `node-pty` 起 shell，`cwd` 固定为 `session.workspace`。观看端沿用现有 xterm 面板、安卓虚拟键、`Ctrl+F` 搜索、断线重连、单窗口接管、回放过滤。
2. **主机连接**：Electron 主进程登录后、以及 mao-agent 的 `local --serve` 与交互式 LOCAL 进程启动后，连接 `/api/ws/terminal-host`。PTY 与这条连接都在该进程里。桌面页面刷新不断开 Electron 上正在跑的中继终端。CLOUD 模式的 mao-agent 不连接。
3. **本机路径保持**：观看端就是绑定设备上的 Electron 时，顶栏新建的仍是 IPC 本机终端，不经服务器。中继终端作为额外标签出现在同一面板里，供「手机上开的那个 shell，回到电脑前接管」。
4. **可用性矩阵**：按钮继续「禁用 + tooltip」，不隐藏。离线、未登记设备、桌面客户端或 mao-agent 版本过旧，各自有固定文案（§5）。任一主机已连接就可用，不再要求本机额外允许。只有 mao-agent 在线时同样可用。
5. **双机收口**：Electron 查看绑定在其它设备上的 LOCAL 会话时，不再创建、也不再展示本机 IPC 终端。
6. **配额、审计、删除级联**：中继终端与云端终端共用 `terminal.*` 上限与空闲 / 最长存活；审计只记生命周期；删除会话时两边一起关。
7. **契约**：新增 `TerminalHostAvailability`，前后端汉化表用 `Record` 穷尽。零 DDL。

### 2.2 不做的

- 不在服务器上按本地路径起 PTY，不把中继终端送进 docker / 容器运行时。
- 不把 Agent 的 Shell 工具改成 PTY，也不借 `tool_execute` 假装终端。
- 不把中继字节放进 `/ws/stream` 或 `file_op_request`。
- 不远程拉起系统「终端」App（`open -a Terminal` 保持桌面专用，任务列表按钮不再用它的存在性当探针）。
- 不把本机 IPC 终端同步给其它客户端。手机上新开的是另一个 shell，不是桌面正在用的那个 PTY 的镜像。
- 不把终端帧放进 `/ws/stream` 的 `capabilities`、`DAEMON_ROUTED_EVENTS` 或 `file_op_request`。文件代理方案（2026-11-18）独占这些入口，边界见 §10。
- 不新增 `terminal:use` 的授予范围。该权限继续只表示「服务器进程账号的 shell」。
- 不增加「允许其他客户端使用本机终端」或任何等价开关、设置项、权限点。主机连接在线即允许同账号的其它客户端打开。
- 不做路径沙箱、命令黑白名单、输入输出落盘。PTY 起来之后与坐在那台电脑前打开本机终端相同，可以 `cd /`。
- 不做 Git 状态远程代理，不做管理后台观看或强制关闭他人的本机终端。
- 不改安卓原生壳，不出 APK。虚拟键与键盘避让已在 `TerminalPanel.vue`，中继终端走同一面板即生效。
- 不修 `terminalManager._detectShell` 在 Windows 上缺少 `SHELL` 时回退 `/bin/bash` 的既有行为。中继 spawn 与本机 `create()` 使用同一函数。
- 零 Flyway。不改 nginx（`/api/ws/` 已覆盖新路径，与云端终端方案 §4.1 的结论相同）。

## 3. 关键决策

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| D1 | PTY 放哪 | 绑定设备上的 Electron 主进程，或该设备上的 mao-agent 进程 | 服务器 spawn 会进入错误机器。桌面渲染进程不持有 PTY（`main.cjs:2091-2094`）。mao-agent 用独立的 `/ws/terminal-host`，不占用它已有的 `/ws/stream` |
| D2 | 观看协议 | 复用 `/api/ws/terminal` 与 `RemoteTerminal` 的 attach / 缓冲 / 接管 / 背压 | 三端面板、安卓键条、回放过滤已经按这套协议写完。中继侧用一个不调用 `node-pty` 的 `PtyLike` 桥接主机帧，注册进同一个目录，WS handler 不用分叉输出路径 |
| D3 | 主机通道 | 新路由 `/api/ws/terminal-host`，主进程持有 | 与 Agent 流隔离，避免 1MB 超限拆掉会话连接。主进程持有后，`deploy-desktop` 触发的页面刷新不会杀掉手机上正在用的 shell |
| D4 | 谁可以新建 | 本机是绑定设备：IPC。其它客户端：中继。未绑定的旧会话：Electron 仍走 IPC，其它端拒绝并引导登记 | 与文件树 D6 对齐。未绑定会话不广播猜测执行端 |
| D5 | 权限 | 中继终端只校验会话主人 + 主机已连接，不校验 `terminal:use`，也不设本机开关。云端终端的权限校验一字不改 | `terminal:use` 的含义是服务器 shell，默认只给管理员。本机终端与它不是同一件事。用户明确要求主机在线即可用，不再加一层允许 |
| D6 | 本机同意 | 不做 | 见 D5。不写 `desktop-prefs.json`，不改「个人信息」页 |
| D7 | 双机 IPC | `targetDeviceId` 非空且不等于本机时，禁止创建和展示 IPC 终端 | 收 §1.3 的错机器 shell |
| D8 | 配额 | 云端 PTY 与中继记录共用 `terminal.*`，含 pending | 中继不占服务器进程，但占环形缓冲和连接。分两套上限会让浏览器把服务器内存打满 |
| D9 | 主机短暂断开 | 同一 `(userId, deviceId)` 60 秒内重连并用 `auth.terminals` 对账，对得上的保留缓冲；超时或列表里没有的关闭 | 笔记本休眠、网络抖动不应把 shell 清掉。主进程真退出时列表为空，服务器关掉登记 |
| D10 | cwd | 只使用服务端保存的 `session.workspace`。请求体里的 cwd 对中继无效 | 观看端不能指定任意目录。目录不存在由主机拒绝，不回退到 home |
| D11 | 环境 | Electron 主机用 `buildShellEnv()`；mao-agent 主机用 CLI 自己的 token 与 `process.env`。两边 shell 探测规则相同。服务器不向 PTY 注入 env | 观看端的 token 不进 shell。CLI 不读 Electron 的 auth store |
| D12 | 同机两个主机 | Electron 的主机连接优先于 mao-agent。CLI 不得顶掉仍在线的 Electron 主机 | PTY 不能迁进程。文件代理可以两边同时读盘，终端不行。`executorClientType` 仍不参与判定 |
| D13 | 发布形态 | 后端与页面可以先发；Electron 主机随安装包 / OTA；mao-agent 主机随 npm 发布 | 旧壳、旧 CLI 都只是「请升级」，不出现空面板。两条发布线互不阻塞，见 §7 与 §10 |

## 4. 详细设计

### 4.1 数据流

观看端新建一个中继终端：

1. 观看端 `POST /v1/sessions/{sessionId}/terminals`，body 只有 `cols` / `rows`（与云端相同）。
2. 服务器校验归属、模式、工作区、主机状态、配额，生成 `terminalId`（沿用 `term-{sessionId}-{timestamp}-{8位}`），向主机发 `open`。
3. 主机 `stat` 工作区目录，通过后 `pty.spawn`，回 `opened`（`shell`、`cwd`）。失败回 `open_failed`。10 秒无应答视为失败，占位释放。
4. 服务器把该终端登记为中继记录（环形缓冲、attach 状态与云端终端相同），REST 返回 `toInfo()`。
5. 观看端 `adoptRemoteTerminal`（现有函数）后 `attach`。之后按键 → 观看 WS `input` → 服务器 → 主机 `input` → `pty.write`。PTY 输出反向走回，服务器同时写入环形缓冲。
6. 观看端断线只 `detach`。主机上的 PTY 继续跑，输出继续进缓冲。再次打开面板走现有 `GET /terminals` + `attach` 回放。

本机就是绑定设备时，顶栏「新建」不走以上路径，仍调用 `electronAPI.terminal.create`。已经存在的中继终端在本机面板里以远程标签显示，接管走观看协议。

### 4.2 可用性矩阵

`terminalAvailability` 改为下表。命令面板的 `canUseTerminal` 已读这个 computed（`TopNav.vue:189`），跟着变。

先判定「本机是不是这条会话的执行端」：

- Electron，且 `getLocalDeviceInfo().id === session.targetDeviceId`：是。
- Electron，且 `targetDeviceId` 为空：按执行端处理（存量未登记会话，保持今天的 IPC）。
- 其余：不是。

| 条件 | 按钮 | tooltip |
|---|---|---|
| 无活跃会话 | 禁用 | 请先打开一个任务 |
| CLOUD，无 `terminal:use` | 禁用 | 没有终端使用权限 |
| CLOUD，工作区为空 | 禁用 | 任务工作区不可用 |
| CLOUD，其余 | 启用 | 终端 (Ctrl+\`) |
| LOCAL，本机是执行端 | 启用，新建走 IPC | 终端 (Ctrl+\`) |
| LOCAL，工作区为空 | 禁用 | 任务工作区不可用 |
| LOCAL，`targetDeviceId` 为空 | 禁用 | 请先在桌面客户端打开一次该任务，完成执行端登记 |
| LOCAL，设备离线（`targetDeviceOnline !== true`） | 禁用 | 执行端设备离线 |
| LOCAL，`terminalHost === 'unsupported'` | 禁用 | 当前桌面客户端版本不支持远程终端，请升级桌面客户端 |
| LOCAL，`terminalHost === 'upgrade-cli'` | 禁用 | 当前 mao-agent 版本不支持远程终端，请升级后重试 |
| LOCAL，`terminalHost === 'upgrade-either'` | 禁用 | 请升级桌面客户端或 mao-agent 后使用远程终端 |
| LOCAL，`terminalHost === 'enabled'` | 启用，新建走中继 | 终端 (Ctrl+\`) |
| LOCAL，设备在线但还没有 `terminalHost` 快照 | 启用，点击后由 REST 返回 §5 的具体原因 | 终端 (Ctrl+\`) |

最后一行是后端尚未升级、或快照还没推到的过渡态。按钮可点，失败文案由接口给出，避免旧数据把按钮永久禁用。

`terminalHost` 缺省不表示版本过旧。桌面壳过旧、mao-agent 过旧、两者都过旧，要等主机注册表和 `/ws/stream` 上的客户端类型一起看，见 §4.5。

### 4.3 服务端登记与 REST

新增 `backend-ts/src/harness/terminal/local-terminal-relay.ts`。

中继记录复用 `RemoteTerminal`。构造时传入桥接 `PtyLike`：

- `write` / `resize` / `kill` 变成发往主机的帧；
- 主机的 `output` / `exit` 由 `TerminalHostHandler` 调回桥上登记的回调；
- `pid` 记 0。日志里以 `terminalId` 标识，不假装服务器上有这个进程。

`AttachableTerminal` 增加 `skipTerminalUsePermission: boolean`。`RemoteTerminal` 为 `false`。中继实例为 `true`。`TerminalWsHandler.handleAttach` 仅在该字段为 false 时检查 `terminal:use`（`terminal-ws-handler.ts:243-246`）。归属校验（`:255-258`）两种终端都做。**实现顺序注记（评审补充）**：现实现先查权限再 `terminalManager.get()`；skip 标志挂在终端记录上，必须把 get 提到权限检查之前（经 §4.4 目录门面），按记录字段决定是否跳过——spec 需断言「中继终端 + 无 `terminal:use` → attach 成功」与「云端终端 + 无权限 → 仍拒」两条路径各自成立。

`TerminalManager` 增加两个只读方法，供配额使用，不把 `pendingCreates` 暴露出去：

- `occupiedCount(): number`：已登记 + pending；
- `countForSession(sessionId: number): number`：该会话已登记 + pending。

中继服务持有自己的 map 与 pending。创建前：

```
perTask = terminalManager.countForSession(sessionId) + relay.countForSession(sessionId)
global  = terminalManager.occupiedCount() + relay.occupiedCount()
```

达到 `maxSessionsPerTask` 或 `maxSessionsGlobal` 时抛现有 `TerminalLimitError`，文案不变。

REST（`terminal.routes.ts`）在 `prepare()` 之后按模式分支：

- CLOUD：现有 `terminalManager.create`，仍先要 `terminal:use`。
- LOCAL：`prepare()` **不再**先调用 `requirePermission(terminal:use)`。抽一个只做登录与会话归属的 `prepareOwned()`，CLOUD 分支在其内部继续检查权限，LOCAL 分支不检查。
- LOCAL 且 `workspace` 空白：400「任务工作区不可用」。
- LOCAL 且 `targetDeviceId` 空白：400「请先在桌面客户端打开一次该任务，完成执行端登记」。
- 没有处于 `enabled` 的主机连接：400，文案按 §5（离线、桌面或 mao-agent 版本过旧、宽限中）。
- 其它执行模式：保持「仅云端任务支持远程终端」。

`GET` 列表与 `DELETE` 对两种终端都生效。删除云端终端的归属校验保持；删除中继终端同样要求 `terminal.sessionId` 与 `terminal.userId` 匹配。关中继时桥的 `kill` 通知主机。

`toInfo()` 增加可选字段 `kind?: 'local-relay'`。云端不写这个字段。观看端用它区分标签，旧客户端忽略未知字段。

会话删除：`create-app.ts:522` 的回调在 `closeBySession` 之后再调 `relay.closeBySession`。某一边抛错不影响另一边，错误分别记日志。

审计复用 `TerminalAuditRecorder`。新增关闭原因 `HOST_LOST`，`TERMINAL_AUDIT_META` 增加一条：`action=DELETE`、`method=SYSTEM`、`path=/internal/terminal/host-lost`。不记录输入输出。

配置仍是启动时固化的那一份 `getTerminalConfig()`。中继与云端读同一对象。不新增设置项。

### 4.4 观看通道

`/api/ws/terminal` 的帧集合不增加。`TerminalWsHandler` 的 `terminalManager` 依赖换成目录门面：

```
get(id)      = cloud.get(id) ?? relay.get(id)
onClosed(cb) = 两边都订阅，回调仍是 (info, reason)
```

接管、背压丢帧、`sanitizeReplayData`、退出帧、`TERMINAL_RECLAIMED` 因此对中继终端同样生效。空闲判定保持「有人 attach 就不算空闲」（`remote-terminal.ts:237-240`），避免 `tail -f` 被回收。

观看端 `useTerminalWS.ts` 不改协议。`createRemoteTerminal` 已经 POST 当前会话；LOCAL 分支复用它，不再传 cwd。

`visibleTabs`（`useTerminal.ts:114-121`）改为：

- CLOUD：`mode==='remote'` 且 `sessionId` 匹配且 `kind !== 'local-relay'`。
- LOCAL，本机是执行端：全部 IPC 标签（`mode==='local'`）加上该会话的中继标签。
- LOCAL，本机不是执行端：只显示该会话的中继标签。

IPC 标签继续不带 `sessionId`（现状）。它们只在「本机是执行端」时出现，从而收掉 §1.3。

打开面板 / 切换会话时，LOCAL 且本机不是执行端，调用现有 `restoreRemoteTabs`。本机是执行端时同样拉一次列表，把中继标签补上，同时保留 IPC 标签。CLOUD 行为不变。

任务列表 LOCAL 分组的按钮（`TaskIndexPanel.vue:979-988`）：

- 本机是执行端：保持 `createLocalTerminal(分组工作区)`。
- 其它客户端：若活跃会话属于该分组，对它建中继终端；不属于，则把该分组里最近更新的一条会话设为活跃再创建。面板只显示当前会话的标签，不先切换的话新标签会被滤掉。
- 不再读取 `electronAPI.openTerminal`。

### 4.5 主机通道

`attach-websocket.ts` 在 `/ws/terminal` 之后增加 `GET /ws/terminal-host`。仍是同一次 `register(websocket)`。空闲 90 秒、15 秒检查一次，与另外两条路由相同。主机每 10 秒发 `ping`，有输出时同样刷新空闲计时。

帧都是 JSON 文本。单帧 UTF-8 不超过 256KB，低于 1MB 入站上限，留出信封余量。超限的帧服务器直接丢掉该连接并按主机断开处理（§4.9），避免一个异常帧拆掉连接后状态不清。客户端在发送前自行切片。

**主机 → 服务器**

| type | 字段 | 说明 |
|---|---|---|
| `auth` | `token`、`deviceId`、`client`、`terminals` | 首帧。`client` 为 `electron` 或 `cli`。`terminals` 为 `{ terminalId, shell, cwd, cols, rows }[]`，首次连接是空数组 |
| `ping` | | |
| `opened` | `terminalId`、`shell`、`cwd` | 对应一次 `open` |
| `open_failed` | `terminalId`、`code` | `CWD_MISSING` 或 `SPAWN_FAILED` |
| `output` | `terminalId`、`data` | 已按 256KB 切片的 UTF-8 文本 |
| `exit` | `terminalId`、`exitCode` | PTY 退出 |

**服务器 → 主机**

| type | 字段 | 说明 |
|---|---|---|
| `connected` | `userId`、`role` | `role` 为 `active` 或 `standby`。待命端不接收 `open` |
| `open` | `terminalId`、`sessionId`、`cwd`、`cols`、`rows` | cwd 来自会话记录，主机不采用其它路径 |
| `input` | `terminalId`、`data` | 服务器已切成 ≤256KB |
| `resize` | `terminalId`、`cols`、`rows` | 列 1..500，行 1..200，与云端夹取相同 |
| `kill` | `terminalId`、`reason` | `CLOSE` / `RECLAIM` / `SESSION_DELETED` / `HOST_LOST` |
| `pong` | | |

auth：`validateAccessToken`，`deviceId` 必须匹配 `^[A-Za-z0-9_-]{1,64}$`。失败关闭，code 1003。**服务端只在 auth 时校验一次 token，连接存活期内不再复查**（与 `/ws/stream` 现状一致；不搬 company_sso 的到期复查）。帧上增加 `client: 'electron' | 'cli'`，与 `/ws/stream` 的 client 取值一致，供同机优先级使用——client 由连接自报，只影响同账号同设备上「新 shell 落在哪个进程」，自报错误无越权面，接受。

**主机连接的 token 生命周期（评审补充）**：access token 是短时效的，`/ws/stream` 靠 `auth_refresh` 在连接内换票；主机连接**本期不加 auth_refresh**，改为「断线重连时必取最新 token」：

- 服务端认可连接后 token 过期不影响在途连接（同上，连接内不复查）。
- 桌面：token 轮换（`auth-set-tokens` 写盘）后**不主动断开重连**（避免无谓抖动），只把主机连接标记为「下次重连用新 token」；因网络断开重连时从 `readAuthStore()` 取最新值。若 1003 被拒（token 真过期），指数退避等待下一次 `auth-set-tokens` 或渲染进程刷新，重试循环内不写死循环日志。
- mao-agent：重连时调现成 `getToken()`（2026-11-18 token 重登方案保证过期后能续/重登），复用其指数退避。
- **账号切换**（评审补充的缺口）：`auth-set-tokens` 写入的是**另一个账号**的 token 时，重连后 userId 已变——主机必须在重连前按「userId 变化」杀掉本进程全部中继 PTY（与登出同一语义），否则旧账号的 shell 成为孤儿且缓冲/注册错位。桌面以 `readAuthStore()` 解出的 userId 与当前主机连接的 userId 比对。

同一 `(userId, deviceId)` 只留一条**活跃**主机，规则如下，不能照搬「后连的顶掉先连的」：

- 活跃主机已是 `electron` 时，新的 `cli` 连接接受为待命：回 `connected` 且 `role: 'standby'`，不向它发 `open`。它不替换 Electron，因此不会把桌面进程里的 PTY 拆掉。
- 活跃主机是 `cli` 或空位时，新的 `electron` 成为活跃主机。原 CLI 收到 close `4000 replaced`，CLI 杀掉自己 map 里的中继 PTY。这些 id 不在 Electron 的 `terminals` 里，对账后观看端收到 `HOST_LOST`。PTY 不能迁到另一个进程。
- 同级替换（electron 换 electron，或 cli 换 cli）：新连接成为活跃主机，旧连接 `4000 replaced`，走 §4.9 的对账。
- Electron 断开时若已有待命 CLI：立刻升为活跃，Electron 上的旧 id 当时就 `HOST_LOST`（不等 60 秒，也不能迁到 CLI）。之后的新建发到 CLI。Electron 再连上时重新成为活跃主机，CLI 退回待命，CLI 在这段时间里新建的 shell 同样 `HOST_LOST`。没有待命 CLI 时才走 60 秒宽限，等 Electron 自己带原 id 回来。

`deviceId` 由主进程读 `~/.mao/agent-cli/device.json`，与渲染进程 `getDeviceInfo` 同一文件。不接受连接自己编一个 id：id 必须与会话上的 `targetDeviceId` 相同，否则 `open` 投不到。服务器不另建「设备归属表」；id 能对上会话绑定，且 token 的 userId 等于会话主人，即视为这台已绑定设备。攻击者拿着别人的 token 用自己的 deviceId 去连，只能在自己机器上起 shell。

主机状态机（内存，按 `userId + deviceId`）：

| 状态 | 条件 |
|---|---|
| 无记录 | 没有主机连接，也没有宽限 |
| `enabled` | 有活跃主机（electron 或 cli）。同账号的其它客户端可以新建 |
| `grace` | 活跃主机刚断，60 秒内，且没有可升位的待命 CLI |
| `unsupported` | 该设备有 Electron 的 `/ws/stream` 连接，没有 CLI 的流连接，也没有主机 |
| `upgrade-cli` | 该设备只有 CLI 的 `/ws/stream` 连接，没有主机 |
| `upgrade-either` | Electron 与 CLI 的流连接都在，两个都没有主机 |

扫描只用现成的连接表与 `clientType`（`streaming-ws-registry.ts` 已有），**不读**文件代理方案即将写入的 `connectionCapabilities`，也**不改** `sendToFileCapableDevice`。没有流连接、也没有主机时，状态是「无记录」，文案用离线。

状态变化时，向该用户广播现有 `device_status`（`streaming-ws-handler.ts:518-527`），`data` 增加可选字段 `terminalHost`。离线帧不带。会话详情与列表的快照同样填这个字段（与 `executorClientType` 的填法相同，`session.routes.ts` 现有快照处）。无 DDL。

契约放在 `shared/contracts/src/session.ts`（或同目录新文件 `terminal.ts` 并由 `index.ts` 导出）：

```ts
export type TerminalHostAvailability = 'enabled' | 'unsupported' | 'upgrade-cli' | 'upgrade-either'
```

后端用 `as const satisfies readonly TerminalHostAvailability[]` 收口允许值。桌面 tooltip 用 `Record<TerminalHostAvailability, string>`，漏一项 `vue-tsc` 失败。`device_status` 的信封仍是 `WsServerEvent` 的宽 `type: string`（`ws.ts:270-275`），不把整个流事件改成判别联合。

### 4.6 Electron 主进程

新增 `desktop/electron/terminalHost.cjs`，由 `main.cjs` 在 `app.ready` 且已有 token 之后启动。职责：

- 用 `readAuthStore()`（`main.cjs:1690-1696`）取 access token，用 `~/.mao/agent-cli/device.json` 取 `deviceId`（与 `desktopPrefs` 读的是同一个文件）。登录成功即连接，不读取任何「是否允许远程」的偏好。
- **依赖（评审补充）**：桌面当前无 `ws` 依赖（Electron ^28 = Node 20 主进程，无全局 WebSocket；MCP 用的 SDK 传输不算数）。`desktop/package.json` 需新增 `"ws"`——纯 JS 包，不进 `electron-rebuild`，与 `node-pty` 的原生重建互不影响。
- 连接 `${apiBase}/ws/terminal-host`。地址与渲染进程的终端 WS 同源，从现有服务器配置读取，不写死域名。token 生命周期与账号切换见 §4.5（auth-set-tokens 只标 dirty + userId 变化杀 PTY，不主动断连）。
- 维护 `Map<terminalId, pty>`，与 IPC 用的 `terminalManager.sessions` **分开**。两套 map 互不转发输出，避免手机上的 shell 把字节灌进桌面正在看的本机标签。
- `open`：`cwd` 必须是已存在的目录，否则 `open_failed` / `CWD_MISSING`。spawn 参数与 `TerminalManager.create` 相同（检测到的 shell、空参数、`buildShellEnv()`、`TERM=xterm-256color`）。**注意覆盖顺序（评审补充）**：`buildShellEnv()` 把 `TERM` 固定为 `'dumb'`（`main.cjs:397`），必须在 spread 之后覆盖回 `xterm-256color`，否则 vim / 颜色全部退化。成功后 `opened`。`pty.onData` 按 256KB UTF-8 边界切片上送；发送前若主机 socket `bufferedAmount > 1MB`，丢掉本片并记一笔，下一次能发时先送一行 `\r\n[输出过快，已丢弃部分内容]\r\n`。不暂停读取，避免 PTY 把主进程堵住。
- `input` / `resize` / `kill` 只作用于这张 map。未知 id 忽略。
- 退出、`before-quit`：`kill` 全部中继 PTY，关闭 socket。与现有 `terminalManager.killAll()` 并列调用。
- 重连：指数退避，上限 30 秒。auth 的 `terminals` 带上仍活着的 id。服务器没回 `connected` 之前不接受新的 `open`。
- token：在现有 `auth-set-tokens` 成功写盘之后通知主机重连；登出清空 token 时关闭 socket 并杀掉中继 PTY。

不新增设置页 IPC，不改 `desktopPrefs.cjs` 的字段。`client` 固定为 `electron`。收到 `role: 'standby'` 时不 spawn（桌面端正常情况下不会待命；协议上仍按此处理）。

### 4.7 mao-agent 主机

新增 `agent-cli/src/local/terminal-host.ts`，由 `local --serve`（`commands/local.ts` 在流连接建立之后）和交互式 LOCAL 进程（`session-runner` 创建本地执行器时）各启动一次。CLOUD 模式不启动。

- 自己用 `ws` 连 `/api/ws/terminal-host`，不复用 `WsClient`（那个类绑定 `/ws/stream`、订阅和 `capabilities`）。token 与 deviceId 用 CLI 现成的配置和 `resolveDeviceIdentity()`（`device-identity.ts`）。`client: 'cli'`。
- `node-pty` 版本与桌面相同（`^1.1.0`），**只在 spawn 时 `require`**，测试注入工厂。禁止在 `executor.ts`、`file-ops.ts`、`ws-client.ts` 顶层引入。桌面测试注释已写明：该包在 ubuntu + `npm ci --ignore-scripts` 下没有预编译，顶层 import 会让 `agent-cli` 的 `npm test` 直接失败，文件代理的用例会一起被拖垮。
- spawn 前用现成的 `resolveWorkspace`（`executor.ts` 已有）收窄 cwd。信任根之外回 `CWD_MISSING`，不 spawn。通过之后不再做路径沙箱，与桌面主机一致，可以 `cd /`。
- shell 探测与 `terminalManager._detectShell` 相同（`SHELL`，否则 macOS `/bin/zsh`、其它 `/bin/bash`），参数为空数组。环境用 CLI 进程的 `process.env`，加上 CLI 自己的 `MAO_TOKEN`、`MAO_BASE_URL`、`TERM=xterm-256color`。不读 Electron 的 `buildShellEnv()`。
- 切片、背压、重连、`terminals` 对账与 §4.6 相同。`role: 'standby'` 期间不 spawn；升为 `active` 后才接受 `open`。被 `4000 replaced` 时杀掉本进程 map 里的中继 PTY。
- 进程退出时同样杀掉。交互式 REPL 退出等于主机退出，正在看的中继终端按 §4.9 进入宽限。
- 不加入 `DAEMON_ROUTED_EVENTS`，不改 `acceptEvent`。终端是进程级的，不按当前订阅会话过滤。这与文件代理 D7（REPL 只处理当前会话的 `file_op_request`）故意不同：手机要开的是这台机器上的 shell，不是 REPL 正坐着的那一个会话的文件请求。

`package.json` 增加依赖 `node-pty`。`npm test` 不安装、不加载它。

**安装可行性（评审补充的发布风险）**：`node-pty` 放**正式 dependencies** 会让 `npm install -g mao-agent` 在 Linux 上跑 node-gyp（需 python3 / make / g++），编译失败会**波及不用终端的存量用户——整个 mao-agent 安装失败**。因此 node-pty 必须放 **`optionalDependencies`**：安装失败被 npm 容忍，运行时 `require('node-pty')` 失败 → 主机连接照常建立但 `open` 一律回 `open_failed` / `SPAWN_FAILED`，能力降级而不是装不上。§9-3 的预编译备选（fork 带 linux 预编译 / prebuilt 包）按此口径评估。

### 4.8 前端会话快照

`desktop/src/stores/session/types.ts` 的 `Session` 增加可选 `terminalHost?: TerminalHostAvailability | null`。

`list.ts` 里处理 `device_status` 的分支（现有逻辑按 `deviceId` 更新 `targetDeviceOnline` 与 `executorClientType`）同时写入 `terminalHost`。帧里没有该字段时保持原值；`online: false` 时把 `terminalHost` 置为 `null`。

会话详情 / 列表 JSON 带上同一字段，刷新后不必等下一次状态广播。

### 4.9 生命周期

| 事件 | 中继 PTY | 服务器登记 | 观看端 |
|---|---|---|---|
| 观看端断线、切会话、收起面板 | 继续 | detach，开始计空闲 | 再次进入时 attach 并回放 |
| 观看端 DELETE 或关掉最后一个标签 | 收到 kill 后结束 | 移除 | 面板收起（现有行为） |
| 空闲达到 `idleTimeoutMinutes` 且无人 attach，或超过 `maxLifetimeHours` | kill | 移除，原因 `RECLAIM` | `TERMINAL_RECLAIMED` |
| 删除会话 | kill，原因 `SESSION_DELETED` | 移除 | 现有「任务已删除」 |
| 主机 socket 断开 | 主进程里仍在 | 进入 60 秒 `grace`，不删缓冲 | 暂不报死。宽限内重连成功则无感 |
| 宽限内同设备重连，`terminals` 含该 id | 继续 | 重新绑到新 socket | 后续输出恢复；已 attach 的观看端不用重开 |
| 宽限内重连但列表没有该 id，或 60 秒到期 | 已不在则忽略 | 移除，原因 `HOST_LOST` | 「执行端已断开，终端已关闭」 |
| 后端重启 | 主进程里变成孤儿 | 内存登记全部消失 | 与云端终端相同：不恢复。主机在下一次 auth 收到对账结果后杀掉本地孤儿（服务器不认识的 id，回 `kill`） |
| 桌面客户端退出，且没有待命 CLI | `before-quit` 全部 kill | 进入宽限，到期 `HOST_LOST` | 同上 |
| 桌面客户端退出，已有待命 CLI | Electron 侧 kill | 待命 CLI 升为活跃；Electron 上的旧 id 关闭 | 旧 shell 收到「执行端已断开」；之后新建落在 mao-agent 上 |
| mao-agent 退出，Electron 主机仍在 | CLI 侧 kill；若它本来就是待命则无 PTY | 活跃主机不变 | 无感 |
| mao-agent 退出，它是唯一主机 | 进程退出时 kill | 进入宽限，到期 `HOST_LOST` | 「执行端已断开，终端已关闭」 |

宽限定时器按设备一个。新的断开重置 60 秒。`grace` 期间拒绝新建（文案与离线相同：「执行端设备离线」），避免把 `open` 发给一个已经不在的 socket。

### 4.10 背压

三层，每一层都只丢字节并补一行提示，不停止读取：

1. 主机 → 服务器：Electron 与 mao-agent 都按 §4.6 在 `bufferedAmount > 1MB` 时丢片。
2. 服务器 → 观看端：沿用 `OUTPUT_BACKPRESSURE_BYTES`（`terminal-ws-handler.ts:17-20`）。
3. 观看端粘贴：服务器把 `input.data` 切片后再转发。单次粘贴超过 1MB 时由 `/ws/terminal` 的 1MB 传输上限直接断帧（与云端终端同一行为）——实现注记（2026-11-19）：「输入过长」BAD_REQUEST 分支在该前提下不可达，未单独实现；数据切片按 32KB 预算（JSON 信封 + 转义后仍低于 256KB 帧上限，直接按 256KB 切 data 会让序列化帧超限被两端拆连接）。

PTY 输出按 UTF-8 字符串转发。`cat` 二进制文件会出现替换字符，与云端终端的既定行为一致。

回放仍走 `sanitizeReplayData`。缓冲上限用 `outputBufferBytes`（默认 256KB），截断提示沿用 `OutputRingBuffer` 的现有文案。

### 4.11 安全边界

写在这里，避免实现时再被收成「已经有会话归属所以是安全的」。

- 中继终端的门槛只有会话主人、绑定设备、以及这台设备上有活跃主机（桌面客户端或 mao-agent）。不另设开关。主机进程开着时，该账号在浏览器或手机上的登录态可以在这台电脑上打开 shell，不走工具审批。
- 工具审批等级（只读 / 读写 / 完全权限）管不到这条通道。命令拒绝列表也不经过。
- 服务器进程内存里会短暂持有输出环形缓冲和在途帧，不写数据库、不写审计内容。
- 主机只接受「cwd 等于本次 `open` 给出的路径且该路径是目录」。mao-agent 还要求该路径通过 `resolveWorkspace`。spawn 之后不再限制。
- 观看端 token 不进入 PTY 环境。Electron 主机的 `MAO_TOKEN` 来自 `buildShellEnv()`；mao-agent 主机的来自 CLI 自己的登录态。
- 不提供管理后台入口。管理员不能借这个通道打开用户的电脑。

## 5. 错误文案

REST 与按钮 tooltip 使用同一句，避免点击后看到另一套说法。

| 场景 | 文案 |
|---|---|
| 未登记执行端 | 请先在桌面客户端打开一次该任务，完成执行端登记 |
| 设备离线或处于宽限 | 执行端设备离线 |
| 只有 CLI 流，没有主机 | 当前 mao-agent 版本不支持远程终端，请升级后重试 |
| 只有 Electron 流，没有主机 | 当前桌面客户端版本不支持远程终端，请升级桌面客户端 |
| Electron 与 CLI 的流都在，都没有主机 | 请升级桌面客户端或 mao-agent 后使用远程终端 |
| 工作区字段为空 | 任务工作区不可用 |
| 主机 `CWD_MISSING` | 工作区目录不存在或无法访问 |
| 主机 `SPAWN_FAILED` 或其它异常 | 终端启动失败 |
| 10 秒无 `opened` / `open_failed` | 执行端未在时限内响应 |
| 达到上限 | 沿用 `TerminalLimitError` 现有两句 |
| 主机宽限失败 | 执行端已断开，终端已关闭 |

主机异常的原始消息（含路径细节、堆栈）不回给观看端，只进服务器日志。

## 6. 测试

后端 Vitest：

- 中继创建：主机已连接并立即 `opened` → 返回的 `kind === 'local-relay'`，`skipTerminalUsePermission === true`，随后不带 `terminal:use` 的 attach 成功。不存在「未允许」这一拒绝分支。
- 云端回归：无 `terminal:use` 的 attach 仍是 `TERMINAL_FORBIDDEN`；非 CLOUD 以外的拒绝文案不变。
- 配额：云端 pending + 中继 pending 一起计入每任务与全局上限。
- 主机拒绝：无连接、仅旧 CLI 流、仅旧 Electron 流、两者都在但都无主机、`CWD_MISSING`、10 秒超时，文案与 §5 一致，且 pending 被释放。
- 优先级：Electron 活跃时 CLI auth 得到 `standby`，不收到 `open`；CLI 活跃时 Electron 连上后成为活跃主机，CLI 被 `4000 replaced`，原 id 对观看端是 `HOST_LOST`。
- 对账：断开后 60 秒内重连并带上原 id → 缓冲还在，观看端不收到 `HOST_LOST`；列表缺少该 id → `HOST_LOST`；到期同样关闭。待命 CLI 在 Electron 断开后升位，只承接新建。
- 观看端背压与回放过滤走现有用例，补一条「桥接 PtyLike 的输出会进 `OutputRingBuffer`」。
- 删除会话：云端与中继各有一条时两边都被 `closeBySession`。

桌面主进程（沿用 `mainShellHarness.cjs` 的假 `node-pty`）：

- `open` 在目录不存在时回 `CWD_MISSING`，不 spawn。
- 输出切片不超过 256KB；`bufferedAmount` 超限时丢片并在下一片前插入提示。
- `auth-set-tokens` 清空后，中继 map 被 kill。

mao-agent（`cd agent-cli && npm test`，不加载真实 `node-pty`）：

- 工厂注入的 spawn：信任根外的 cwd 回 `CWD_MISSING` 且不调用工厂；目录存在则 `opened`。
- `role: 'standby'` 时忽略 `open`；收到 `4000` 时 map 被清空。
- `executor.ts` / `file-ops.ts` / `ws-client.ts` 的模块图里没有 `node-pty`（用对源码的静态检查或现有测试仍能在无预编译的环境跑完）。

前端：

- 把 `terminalAvailability` 的判定抽成纯函数，覆盖 §4.2 每一行。`TopNav` 继续只调用它。
- `visibleTabs`：本机执行端同时看到 IPC 与中继；其它设备的 Electron 看不到 IPC 标签。

不新增 Playwright。手工验收见 §8。

## 7. 发布与文档

发布顺序：

1. 后端。旧页面不调用 LOCAL 的创建接口；新字段旧页面忽略。
2. `bash scripts/deploy-desktop.sh`。浏览器、安卓、已装的 Electron 渲染层开始显示新矩阵。旧壳的主机不存在，按钮停在「请升级桌面客户端」。
3. Electron 安装包（`desktop` 的 `npm run dist`，用户自行打）经现有 OTA，以及 mao-agent 的 npm 发布，两条各自进行。任一端升级并连上主机后，其它客户端即可打开，无需在本机再允许一次。只升级其中一个也可以用。

只做 1 和 2 时，功能是「明确不可用」，不是半个 shell。

落地时同步（本文件是方案，不在本次改产品行为，因此现在不写 changelog）：

- `changelog/unreleased/YYYY-MM-DD-local-terminal-remote.md`：后端一条（LOCAL 会话可经执行端的桌面客户端或 mao-agent 打开远程终端，不另设本机开关）；前端一条（浏览器 / 安卓 / 其它电脑在任一主机在线时可用；本机按钮行为不变；旧版本提示升级）；终端 CLI（mao-agent）一条（`local --serve` 与交互式 LOCAL 可作为远程终端主机）。
- `skills/mao-cli/reference/desktop.md` 终端表：LOCAL + Web / 安卓改为「执行端的桌面客户端或 mao-agent 在线时可用」。写明旧版本需升级、后端重启与主机进程退出后不保留。`reference/mao-agent.md` 写明主机是进程级的，与文件浏览的「REPL 只处理当前会话」不是同一条规则。
- `skills/mao-cli/reference/android.md` 与 `troubleshooting.md` 里「终端按钮置灰」一行，补上新的 tooltip。

回滚：前后端一起退回即可。无表结构变更，无本机偏好字段。已打开的中继终端随进程退出消失。

## 8. 验收

1. 绑定设备的 Electron 上，LOCAL 任务打开终端：仍是本机 shell，cwd 为工作区，断网也能输入。服务器上无对应 PTY。
2. 桌面客户端在线且已是含主机连接的版本时，浏览器与安卓无需任何开关即可开终端。`vim`、`Ctrl+C`、窗口变化生效；安卓虚拟键可用。cwd 是那台电脑上的工作区，不是服务器路径。
3. 浏览器断线再开面板：回到同一个 shell，回放最近输出，不把历史查询应答成命令。
4. 手机与另一台电脑同时看同一个中继终端：后 attach 的接管，先打开的出现「重新接管」。
5. 执行端 Electron 的面板里能看到手机创建的中继标签，并可以接管；本机 IPC 标签仍在，两边输出不串。
6. Electron A 打开绑定在 Electron B 上的 LOCAL 会话：不出现 A 的本机终端。B 的桌面客户端在线时，A 上打开的 shell 在 B 上。
7. 只开着新版 `mao-agent local --serve`、桌面客户端没开：浏览器能开终端，shell 在 CLI 那台机器上。交互式 LOCAL 同样可以。旧版 mao-agent：按钮禁用，文案是「请升级后重试」，不是「暂不支持」。
8. 旧 Electron（无主机连接）在线、没有新版 CLI：文案是「请升级桌面客户端」。升级完成后其它客户端即可用，本机没有额外的允许步骤。
9. 同一台机器上新版 Electron 与新版 mao-agent 都在：新建落在 Electron。先在只有 CLI 时开出一个 shell，再打开 Electron：该 shell 结束，之后新建落在 Electron。CLI 不会把桌面正在用的中继终端顶掉。
10. 拔掉执行端网络约 30 秒再恢复：shell 还在。退出唯一的主机进程：观看端在约 60 秒后看到「执行端已断开」。Electron 退出但 mao-agent 仍在待命：旧 shell 结束，再新建落在 mao-agent。
11. 删除任务：中继 PTY 退出。空闲超过设置的分钟数且无人 attach：被回收。
12. CLOUD 任务三端行为与权限与改动前一致。mao-agent 的 CLOUD 模式不监听主机端口。
13. 达到每任务 / 全局上限时，云端与中继互相占名额，文案与今天的云端上限一致。

## 9. 开放问题

1. **本机 IPC 终端是否也要能被手机接管**。本期新开一个 shell。若以后要共享桌面正在看的那个 PTY，需要把 IPC 会话登记进主机 map，并定义「桌面正在输入时手机是否抢焦点」。
2. **宽限是否做成设置项**。本期固定 60 秒。与 `terminal.*` 一样要重启才生效的话，不值得单独做设置。
3. **Linux 上的 `node-pty` 预编译**。1.1.0 的 npm 包带 darwin / win32 预编译，Linux 安装时要本地编译。主机在编译失败时回 `SPAWN_FAILED`，不把加载失败扩散到文件代理和工具执行。是否改用带 linux 预编译的版本，另议。

## 10. 与文件代理方案同时开发

对照 [2026-11-18-agent-cli-file-op-technical-design.md](./2026-11-18-agent-cli-file-op-technical-design.md)。两套可以并行，协议不共用，合并冲突集中在 CLI 的少数入口。按下面的分工改，就不会互相拆掉。

**不冲突的部分**

- 通道：文件代理继续走 `/ws/stream` 的 `file_op_request` / `file_op_result`（700KB、一问一答）。终端走 `/ws/terminal`（观看）和 `/ws/terminal-host`（主机，256KB 切片、长连接）。字节不进同一条帧。
- 服务端文件投递：`sendToFileCapableDevice`、`connectionCapabilities`、`parseCapabilities` 只属于文件代理。本方案不改这三个。
- 桌面 `useStreamWS.ts` 的 auth 只由文件代理追加 `capabilities: ['file_op']`。终端主机在 Electron 主进程，不改这个文件。
- 观看端 xterm、云端终端配额、环形缓冲，与文件树 DTO 无关。
- `device_status` 增加 `terminalHost` 是本方案独有。文件代理不广播这个字段。

**必须错开的部分**

| 位置 | 文件代理方案 | 本方案 | 一起改会怎样 |
|---|---|---|---|
| `agent-cli/src/ws/ws-client.ts` 的 stream auth | 追加 `capabilities: ['file_op']` | 不改这个对象 | 终端若把 `terminal` 塞进同一数组，文件代理的「消费方只有文件投递」和档序测试会被带偏；主机在不在也不是这一个标志能表示的 |
| `commands/local.ts` 的 `DAEMON_ROUTED_EVENTS` | 加入 `file_op_request` | 不加入任何终端事件 | 终端帧若走这条 Set，会和工具执行挤在 1MB 的流上，超限会拆掉整条会话连接 |
| `session-runner.ts` 的 `acceptEvent` | `file_op_request` 只处理当前订阅会话 | 主机在进程启动时连接，不按会话过滤 | 若把终端做成和文件代理一样的会话过滤，REPL 正坐着会话 A 时，手机打不开会话 B 的终端 |
| `executor.ts` | 增加 `file_op_request` 分支 | 不 import `node-pty`，不在这里 spawn | 顶层引入 `node-pty` 后，ubuntu 上文件代理的 `npm test` 会在加载阶段失败 |
| `streaming-ws-registry.ts` 的 `register` | 增加可选的能力集参数 | 只读现成的 `clientType` 与连接表 | 本方案不去改 `register` 的形参，文件代理的第 7 参保持可选即可并存 |

**同机同时在线时的行为差（不是代码冲突，实现时不要对齐成一样）**

- 文件代理：同一 deviceId 上 Electron 与 CLI 可以同时应答，投递档序是「声明了 `file_op` 的 electron → 声明了的 cli → 未声明的旧桌面」。读盘没有进程绑定。
- 终端：同一 deviceId 只有一条活跃主机，Electron 优先，CLI 待命。后启动的 CLI 不能替换正在服务的 Electron。文件代理那种「多连接都可服务」不能抄到主机槽上。

**发布**

两边都是先后端、再客户端。后端改的函数没有交集，可以合进同一次后端发布，也可以分两次。mao-agent 的 npm 包里，文件代理是纯 JavaScript，终端多一个 `node-pty` 依赖；按 §4.7 隔离之后，只升级了文件代理、还没带上终端模块的旧包，在新后端上得到的是「请升级 mao-agent」，不会去执行 `open`。

**文档**

`skills/mao-cli/reference/desktop.md` 的 LOCAL 段两边都会加句子：文件浏览一句，终端一句，各写各的，不要并成一段条件。
