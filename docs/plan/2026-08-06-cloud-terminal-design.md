# 云端任务远程终端（Cloud Remote Terminal）技术方案

> 版本：v1.0 | 日期：2026-08-05 | 状态：**已驳回**
> 关联文档：`docs/terminal-design.md`（本地终端，Electron node-pty，已上线）

## 0. 评审结论（已驳回）

本方案于 2026-08-06 评审后驳回，当前版本不得进入实现阶段。PTY、xterm.js 与独立 WebSocket 的技术路线本身可行，但方案的权限模型和生命周期承诺存在以下阻断性问题：

1. **缺少操作系统级用户隔离**：所有远程终端都会以后端进程所属的同一个 Linux 账号运行。方案同时允许真实 HOME、加载 `~/.bashrc`、任意命令和任意路径访问，因此普通 Mao 登录用户实际上会获得后端运行账号的服务器 Shell 权限，而不仅是当前任务工作区权限。
2. **现有任务归属校验不能替代系统权限隔离**：session 归属校验只能确认终端由谁创建，无法阻止用户读取其他用户工作区、后端配置、环境变量和日志，或修改共享文件、操作共享进程。现有 `PathSandbox` 是 Java 工具层的路径校验，无法约束交互式 Shell 中的 `cd`、绝对路径、软链接和 `/proc` 访问。
3. **Docker 环境风险不可接受**：当前后端镜像未配置非 root 用户，默认以 root 运行。按本方案创建的 PTY 将获得容器 root 权限，并可修改挂载到 `/opt/mao/data` 的共享数据卷。
4. **权限控制描述不准确**：`PermissionInterceptor` 只检查显式标注 `@RequirePermission` 的接口，并不会因为接口位于 `/v1/**` 就自动执行 RBAC 授权。方案未定义独立的 `terminal:use` 权限及默认授权范围。
5. **后端重启恢复承诺不可实现**：`RemoteTerminalManager` 与 PTY 注册表均位于 JVM 内存中，后端重启后无法通过原 `terminalId` 重新 attach 到原 PTY。当前架构只能支持网络断线后的重连，不能满足“服务重启后现场恢复”的验收标准。
6. **WebSocket 设计存在冲突**：前端描述为单例 WebSocket 管理多个终端，但握手 URL 又绑定单个 `terminalId`，需要明确采用“每终端一条连接”或“单连接多路复用”之一。断线期间还必须持续消费 PTY 输出，否则输出缓冲区填满后可能阻塞子进程。
7. **高权限通道安全设计不足**：终端 WebSocket 不应使用任意 Origin，也不宜在 URL 中长期携带登录 JWT。应改为受限 Origin，并由 REST 签发短效、一次性的 attach ticket。

### 0.1 重新提交评审的前提

后续若重新设计，至少应先明确并满足以下一种权限模型：

- **仅管理员使用**：新增 `terminal:use` 权限，默认仅管理员拥有；后端以专用非 root Linux 用户运行，并明确该能力属于服务器管理 Shell，不提供普通用户隔离保证。
- **普通用户使用**：采用每用户或每任务独立容器/系统账号运行 Agent 与终端，仅挂载对应用户工作区，并配置非 root 用户、资源配额、网络限制、capabilities 与 seccomp/AppArmor 等隔离措施。
- **要求跨后端重启恢复**：引入独立 Terminal Gateway，并使用 tmux、screen 或专用终端守护进程维护 PTY；后端仅负责鉴权和签发短效 attach ticket。

重新提交时还需修正 RBAC、WebSocket 多路复用模型、断线输出处理、审计数据模型、Origin 限制和短效凭证设计。在这些问题解决前，不应按下文 v1.0 方案开发。

## 1. 需求背景

### 1.1 现状问题

桌面端（`desktop/`）顶栏始终有终端按钮（`TopNav.vue`，快捷键 `` Ctrl+` ``），但当前行为存在明显缺口：

| 场景 | 现状行为 | 问题 |
|------|---------|------|
| 浏览器 / 安卓（CLOUD 任务） | `useTerminal.createTerminal()` 因 `isElectron()` 为 false 直接返回 null，点击无反应 | 完全不可用 |
| Electron 桌面端 + CLOUD 任务 | 顶栏按钮打开**本地** node-pty 终端（`terminalManager.cjs`） | 任务实际在服务器执行，本地终端与任务工作区无关，产生误导 |
| Electron 桌面端 + LOCAL 任务 | 打开本地终端，默认 cwd 为任务工作区 | 正常，保持现状 |

### 1.2 需求动机

CLOUD 模式下，Agent 在服务器上执行任务。用户需要一个**直达服务器的交互式终端**，用于：

- 查看任务运行时现场（进程、日志、端口等），而不仅依赖 Agent 汇报；
- 手动执行命令、清理产物、验证结果，与 Agent 操作同一工作区；
- 任务结束后在终端中继续排查，不受 Agent 会话结束影响。

### 1.3 目标

CLOUD 模式下点击顶栏终端按钮，打开**后端服务器上**的交互式伪终端（PTY），体验等同 SSH 到服务器，支持 vim/top/htop 等全屏交互程序。

## 2. 需求描述

### 2.1 做（本期范围）

1. **后端新增交互式 PTY 能力**：引入 pty4j，`/bin/bash` 交互式进程（真实用户环境：真实 HOME、加载 `~/.bashrc`，**不**使用 Agent 的虚拟 HOME、**不**注入 Git 凭据），`TERM=xterm-256color`，默认 cwd 为任务 workspace（服务器路径，不存在则回退服务器真实 HOME）。
2. **新增 REST 接口**（受现有鉴权链覆盖）：
   - `POST /api/v1/sessions/{sessionId}/terminals` —— 创建终端，返回 `terminalId`
   - `DELETE /api/v1/sessions/{sessionId}/terminals/{terminalId}` —— 关闭终端
   - 创建时校验：登录用户 + 该 session 归属当前用户；session 不存在/非本人 → 403/404。
3. **新增独立 WebSocket 通道** `/api/ws/terminal`（`TerminalWsHandler`），承载终端 I/O，与 `/api/ws/stream`（Agent 执行流）完全解耦。
4. **前端终端远程模式**：`useTerminal.ts` 增加 remote 分支，创建走 REST、I/O 走独立 WS，xterm 渲染复用；Electron LOCAL 模式的本地终端能力原样保留。
5. **入口分流**（`TopNav.vue` / `TaskView.vue` / `TerminalPanel.vue`）：
   - CLOUD 任务 → 远程终端；
   - LOCAL 任务 → 本地终端（现状）；
   - 浏览器 / Electron 均按任务模式分流；
   - **无活跃任务时终端按钮禁用**（tooltip 提示"请先打开一个任务"）；
   - 安卓（`html.android-capacitor`）隐藏终端按钮。
6. **断线保留会话**：WS 断开不杀 pty；空闲超时内重连（同 `terminalId`）恢复原会话。
7. **生命周期管理**：空闲回收 / 最长存活 / 每任务并发上限，定时清理（复用 `ShellSessionManager.cleanupExpiredSessions` 的模式）。
8. **生命周期审计**：终端创建 / 关闭 / 超时回收记入审计（复用 `ActivityService`，记录用户、任务、terminalId、起止时间）。
9. 全局熔断开关 `app.terminal.enabled`（默认开）。

### 2.2 不做（明确排除）

1. **不做输入输出落盘审计**：终端内敲入的内容（可能含敏感信息）不落盘；仅记录生命周期事件。
2. **不做路径沙箱 / 命令黑白名单**：终端是用户直接操作，等同授予用户 SSH 权限；归属校验只保证"是谁开的终端"，不限制命令与 cd 范围。
3. **不做终端内容回放**：页面刷新后 xterm 内容不恢复（服务器 pty 仍在，但前端看不到历史输出）；不提供"历史终端列表"恢复入口。
4. **不做终端内搜索 / 可点击链接 / 分屏 / 字体主题配置**（沿用本地终端现状，属后续迭代）。
5. **不做安卓端**：安卓 WebView 顶栏隐藏终端按钮。
6. **不把 Agent 的 shell 工具迁移到 PTY**：`harness/shell/ShellSessionManager`（非交互、marker 模式）保持不动，两者完全独立。
7. **终端不参与 Agent 上下文**：终端输入输出不注入 Agent 对话，Agent 不知道用户在终端里做了什么。
8. **不注入 Agent Git 凭据**：真实用户环境，git 使用服务器系统级凭据配置或交互式输入。
9. **不改动 Electron 本地终端能力**（`terminalManager.cjs` / IPC / preload 不变）。
10. **不做多用户实时共享终端**（同一终端仅一个用户可 attach）。

## 3. 技术选型

### 3.1 后端 PTY 方案

| 方案 | 说明 | 结论 |
|------|------|------|
| **pty4j**（`org.pty4j:pty4j:0.12.x`） | Java 主流 PTY 库，基于 JNA + 原生 fork-pty，Linux x86_64 原生支持；支持 `resize`、进程树清理、输出回调 | **选用** |
| `script -qec` 包装 | 零依赖，但 resize/信号处理不完整，全屏程序兼容性差 | 否决 |
| 普通 `ProcessBuilder` 管道 | 无 PTY，vim/top 等全屏程序无法正常使用 | 否决 |

pty4j 说明：运行期自动从 jar 提取平台原生库（Linux x86_64 已验证）；Java 17 兼容；不引入新的系统级安装步骤。选型时锁定 Maven Central 最新稳定版。

### 3.2 WS 通道方案

| 方案 | 说明 | 结论 |
|------|------|------|
| **新建 `/api/ws/terminal`** | 终端与 Agent 执行解耦；顶栏终端按钮是全局的（非任务页也可点）；I/O 高频不污染 Agent 流；可独立心跳/超时策略 | **选用** |
| 复用 `/api/ws/stream` | 任务级连接（切任务重连）、事件需扩展类型、与 Agent 执行流耦合 | 否决 |

### 3.3 前端渲染

复用现有 xterm.js 栈（`@xterm/xterm` + `@xterm/addon-fit` + WebGL 渲染），不改动 UI 层（`TerminalPanel.vue` / `TerminalTabs.vue` 的模板与样式基本不动）。

## 4. 架构设计

### 4.1 整体架构

```
┌────────────────────────── 前端（desktop/，Web + Electron） ──────────────────────────┐
│  TopNav 终端按钮 / Ctrl+`                                                        │
│    │ 按 session.executionMode 分流                                                 │
│    ├─ LOCAL  → useTerminal.local 分支 → electronAPI.terminal.*（现状，不动）         │
│    └─ CLOUD  → useTerminal.remote 分支                                             │
│                  │  POST /api/v1/sessions/{id}/terminals → { terminalId }         │
│                  ▼                                                                 │
│              独立 WS（新 composable useTerminalWS，单例+重连+心跳）                 │
│              /api/ws/terminal?token=&terminalId=                                   │
│              input / resize / ping ⇄ output / exit / pong / error                  │
│  xterm.js 渲染（复用现有 TerminalPanel / TerminalTabs）                             │
└────────────────────────────────────────────────────────────────────────────────────┘
                                     │ WS（独立通道）
┌─────────────────────────────────────▼──────────────────────────────────────────────┐
│ 后端（9080）                                                                       │
│  ┌────────────────────────────────────────────────────────────────────────────┐   │
│  │ TerminalWsHandler（/api/ws/terminal）                                       │   │
│  │  · JWT(query token) + terminalId 归属校验 → attach/detach                   │   │
│  │  · input→pty.write() / pty.onOutput→output / resize→pty.resize()            │   │
│  └────────────────────────────────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────────────────────────────────┐   │
│  │ RemoteTerminalManager（harness/terminal/）                                  │   │
│  │  · terminalId → RemoteTerminal（包装 PtyProcess）                            │   │
│  │  · 索引：taskId → Set<terminalId>（归属与并发上限）                           │   │
│  │  · 生命周期：idle 超时 / 最长存活 / 定时清理（@Scheduled）                    │   │
│  │  · closeByTask / 断线保留（detached 状态）                                    │   │
│  └────────────────────────────────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────────────────────────────────┐   │
│  │ TerminalController（REST，受 AuditInterceptor + PermissionInterceptor 覆盖） │   │
│  │  POST/DELETE /api/v1/sessions/{id}/terminals...                            │   │
│  └────────────────────────────────────────────────────────────────────────────┘   │
│  ActivityService：终端生命周期审计                                                │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 数据流

**创建终端**：前端点击（CLOUD 任务）→ REST 创建（鉴权 + 归属校验）→ 后端 spawn bash PTY（cwd=任务 workspace）→ 返回 `terminalId` → 前端建立 WS → attach。

**键盘输入**：xterm `onData` → WS `{"type":"input"}` → `pty.write(data)` → pty 输出 → `pty.onOutput` → WS `{"type":"output"}` → `terminal.write(data)` → xterm 渲染。

**resize**：`fitAddon.fit()` → `onResize` → WS `{"type":"resize"}` → `pty.resize(cols, rows)`。

**断线 / 重连**：WS 断开 → 服务端标记 detached（**不杀 pty**）→ 前端心跳失败后自动重连（携带同一 `terminalId`）→ 重新 attach 继续输出。若重连时终端已被空闲回收 → 服务端返回 `{"type":"error","code":"TERMINAL_NOT_FOUND"}` → 前端移除该 tab 并提示。

**关闭**：用户关闭 tab → REST DELETE → 杀 pty 进程树 → 前端移除 tab；或超时回收（定时任务）→ 同清理路径。

## 5. 后端设计

### 5.1 新增模块 `harness/terminal/`

| 类 | 职责 |
|----|------|
| `RemoteTerminal` | 封装 pty4j `PtyProcess`：write / resize / onOutput 回调 / close（destroyForcibly 进程树）/ idle 与 maxLifetime 判定 / touch |
| `RemoteTerminalManager` | 注册表：`terminalId → RemoteTerminal`、`taskId → Set<terminalId>`；getOrCreate（含并发上限校验）、close、closeByTask、detach/attach 状态、`@Scheduled` 定时清理 |
| `TerminalController` | REST：创建 / 关闭终端；归属与用户校验 |

### 5.2 REST 接口

统一响应 `Result<T>`（`code=0` 成功），经 `AuditInterceptor` / `PermissionInterceptor` 链路（作用于 `/v1/**`，自动生效）：

```
POST   /api/v1/sessions/{sessionId}/terminals
       body: { "cols": 80, "rows": 24 }        # 可选，缺省 80x24
       200: { "code": 0, "data": { "terminalId": "term-{taskId}-{ts}", "shell": "/bin/bash", "cwd": "/path/to/workspace" } }
       403: 非本人任务      404: 任务不存在      409: 超出每任务并发上限      503: app.terminal.enabled=false

DELETE /api/v1/sessions/{sessionId}/terminals/{terminalId}
       200: { "code": 0 }                       # 幂等；不存在也返回成功
```

- `terminalId` 生成：`term-{taskId}-{System.currentTimeMillis()}`（与 `ShellSession` 的 `sh-{conv}-{ts}` 风格一致）。
- 并发上限：`app.terminal.max-sessions-per-task=5`，超出返回 409。
- workspace 校验：`session.getWorkspace()` 为服务器绝对路径；目录不存在时回退 `System.getProperty("user.home")`，并在返回的 `cwd` 字段如实告知。

### 5.3 WS 通道 `/api/ws/terminal`

`WebSocketConfig` 注册：`registry.addHandler(terminalWsHandler, "/ws/terminal").setAllowedOrigins("*")`。

**握手认证**：`?token=JWT&terminalId=xxx`。服务端校验：
1. JWT 有效（复用 `JwtService`，与 `StreamingWsHandler.parseUserIdFromToken` 同路径）；
2. `terminalId` 存在且 `terminal.ownerId == jwt.userId`，否则 `CloseStatus.NOT_ACCEPTABLE`。

**协议**（JSON 文本帧）：

| 方向 | 消息 | 说明 |
|------|------|------|
| C→S | `{"type":"input","data":"..."}` | 键盘输入字节流 |
| C→S | `{"type":"resize","cols":80,"rows":24}` | 终端尺寸 |
| C→S | `{"type":"ping"}` | 保活（前端每 30s） |
| S→C | `{"type":"output","data":"..."}` | pty 输出 |
| S→C | `{"type":"exit","code":0}` | pty 退出 |
| S→C | `{"type":"pong"}` | ping 响应 |
| S→C | `{"type":"error","code":"TERMINAL_NOT_FOUND"}` | 终端已被回收 / 不存在 |

**心跳与容器超时**：`WebSocketConfig` 容器 `maxSessionIdleTimeout=90s`（全局配置）。前端每 30s 发 `ping` 保活；服务端回 `pong`。空闲回收由 `RemoteTerminalManager` 的 30min idle 策略控制，与容器超时不冲突。

**断线语义**：`afterConnectionClosed` → 仅 detach（移除 WS→pty 的转发），**不关闭 pty**；`afterConnectionEstablished` → attach。同一时刻仅允许一个 WS 连接（重复 attach 时拒绝新连接或踢掉旧连接，取拒绝新连接，见"不做"第 10 条）。

### 5.4 进程与环境

```
PtyProcessBuilder
  .setCommand("/bin/bash")            # 可配置 app.terminal.shell
  .setEnvironment(继承服务器进程 env；覆盖 TERM=xterm-256color；不设虚拟 HOME、不注入 GIT_TOKEN_*)
  .setDirectory(任务 workspace 或回退真实 HOME)
  .setInitialColumns/InitialRows(cols, rows)
```

- 交互式 bash 自动加载 `~/.bashrc`（真实 HOME），提供正常 PS1 / 别名；
- 不做任何命令级限制（见"不做"第 2 条）。

### 5.5 配置项（`application.yml` 新增 `app.terminal.*`）

```yaml
app:
  terminal:
    enabled: true              # 全局熔断开关，false 时创建接口返回 503、前端按钮禁用
    shell: /bin/bash           # 终端 shell
    idle-timeout-minutes: 30   # 无 I/O 且无 WS attach 时回收
    max-lifetime-hours: 2      # 最长存活
    max-sessions-per-task: 5   # 每任务并发终端上限
```

## 6. 前端设计

### 6.1 `useTerminal.ts` 改造（`desktop/src/composables/useTerminal.ts`）

- 新增 `mode: 'local' | 'remote'` 概念，`createTerminal(cwd?, mode?)`：
  - `local`：现有 `window.electronAPI.terminal.*` 分支（Electron LOCAL，不动）；
  - `remote`：`POST /api/v1/sessions/{sessionId}/terminals` → 建立独立 WS → 数据转发。
- 新增 composable `useTerminalWS.ts`：单例 WS 管理（连接 / 自动重连（指数退避）/ 30s 心跳 / 事件路由到对应 `terminalId` 的 xterm 实例），独立于 `useStreamWS`，不与其共享连接。
- tab 生命周期：remote tab 的 `closeTerminal` 先 REST DELETE（成功后再移除 tab）；收到 `exit` / `TERMINAL_NOT_FOUND` 时移除 tab 并 `ElMessage` 提示。
- **不做** xterm 内容回放（刷新后 tab 不复原；重新创建新终端）。

### 6.2 入口分流

`TopNav.vue` / `TaskView.vue` / `TerminalPanel.vue` 三处调用统一收敛为 `useTerminal.togglePanel(cwd, mode)`：

```
mode = activeSession?.executionMode === 'CLOUD' ? 'remote' : 'local'
无 activeSession → 按钮 disabled（tooltip：请先打开一个任务）
安卓（html.android-capacitor）→ 隐藏按钮
```

- `TerminalPanel.vue` 的 `+` 新建同样按当前任务模式分流。
- Electron 的 LOCAL 分支行为、`TaskIndexPanel.vue` 的"在终端中打开"（LOCAL 分组）均不变。

### 6.3 不动的文件

`electron/main.cjs`、`electron/preload.cjs`、`electron/terminalManager.cjs`、`types/electron.d.ts`、`TerminalTabs.vue`（模板/样式）不动。

## 7. 实现步骤

### 阶段一：后端 PTY 与 REST（前置，无 UI 依赖）

1. `backend/pom.xml` 增加 `org.pty4j:pty4j:0.12.x`（锁定 Maven Central 最新稳定版）。
2. 新增 `harness/terminal/RemoteTerminal.java`、`RemoteTerminalManager.java`：pty 生命周期、taskId 索引、detach/attach、idle/maxLifetime 判定、`@Scheduled` 清理（参考 `harness/shell/ShellSessionManager`）。
3. 新增 `TerminalController`：创建 / 关闭接口 + 归属校验 + `app.terminal.enabled` 熔断。
4. 新增 `session/ws/TerminalWsHandler.java` + `WebSocketConfig` 注册 `/ws/terminal`。
5. 生命周期审计接入 `ActivityService`。
6. `application.yml` 增加 `app.terminal.*` 配置。
7. 单测：`RemoteTerminalManagerTest`（创建/上限/清理/归属），`mvn test` 通过。

### 阶段二：前端远程模式

8. 新增 `desktop/src/composables/useTerminalWS.ts`（独立 WS + 重连 + 心跳）。
9. 改造 `useTerminal.ts`：remote 分支（REST 创建 + WS I/O 转发 + exit/error 处理）。
10. 改造 `TopNav.vue` / `TaskView.vue` / `TerminalPanel.vue` 入口分流；无任务禁用；安卓隐藏。
11. `cd desktop && npm run build` 通过（`vue-tsc` 类型检查）。

### 阶段三：联调与收尾

12. 后端 `mvn package -DskipTests` 打包（**不重启服务，重启由用户执行**）。
13. 手工验收（见第 9 节）；通过后更新根 `CHANGELOG.md`（`### 后端` + `### 前端（桌面 / Web / 安卓）`）。

## 8. 落地清单

### 8.1 文件变更

| 文件 | 动作 | 说明 |
|------|------|------|
| `backend/pom.xml` | 修改 | 增加 pty4j 依赖 |
| `backend/src/main/java/cn/etarch/mao/harness/terminal/RemoteTerminal.java` | 新增 | PTY 封装 |
| `backend/src/main/java/cn/etarch/mao/harness/terminal/RemoteTerminalManager.java` | 新增 | 会话注册表 + 生命周期清理 |
| `backend/src/main/java/cn/etarch/mao/session/controller/TerminalController.java` | 新增 | REST 创建/关闭 |
| `backend/src/main/java/cn/etarch/mao/session/ws/TerminalWsHandler.java` | 新增 | WS I/O 通道 |
| `backend/src/main/java/cn/etarch/mao/config/WebSocketConfig.java` | 修改 | 注册 `/ws/terminal` |
| `backend/src/main/resources/application.yml` | 修改 | `app.terminal.*` 配置 |
| `backend/src/test/java/.../RemoteTerminalManagerTest.java` | 新增 | 单元测试 |
| `desktop/src/composables/useTerminalWS.ts` | 新增 | 独立 WS + 重连 + 心跳 |
| `desktop/src/composables/useTerminal.ts` | 修改 | remote 分支 |
| `desktop/src/components/common/TopNav.vue` | 修改 | 分流 + 无任务禁用 + 安卓隐藏 |
| `desktop/src/views/task/TaskView.vue` | 修改 | 快捷键/入口分流同步 |
| `desktop/src/components/terminal/TerminalPanel.vue` | 修改 | `+` 新建分流 |
| `CHANGELOG.md` | 修改 | 后端 + 前端小节 |

**不动**：`electron/*`（main/preload/terminalManager）、`types/electron.d.ts`、`harness/shell/*`、`StreamingWsHandler`、`useStreamWS`、`TerminalTabs.vue`。

### 8.2 新增配置项

见 5.5 节（`app.terminal.*`，共 5 项）。

### 8.3 新增接口

- REST：`POST /api/v1/sessions/{sessionId}/terminals`、`DELETE /api/v1/sessions/{sessionId}/terminals/{terminalId}`
- WS：`/api/ws/terminal?token=&terminalId=`

## 9. 验收标准

1. 浏览器 + CLOUD 任务：点击顶栏终端按钮打开远程终端，`pwd` 为任务 workspace；`ls` / `vim` / `top` 正常（vim 可编辑、top 可刷新、Ctrl+C 中断正常）。
2. Electron + CLOUD 任务：顶栏按钮打开**远程**终端（不再是本地终端）。
3. Electron + LOCAL 任务：行为与现状完全一致（本地终端）。
4. 窗口/面板拖拽 resize 后终端自适应（xterm fit → resize 消息 → pty resize）。
5. 断网/服务重启后前端自动重连：同一 `terminalId` 重连成功，终端现场恢复（进程仍在跑）。
6. 空闲超过 `idle-timeout-minutes`（或达到 `max-lifetime-hours`）后终端被回收，重连收到 `TERMINAL_NOT_FOUND`，前端移除 tab 并提示。
7. 同一任务并发创建第 6 个终端返回 409；前端提示。
8. 非本人任务：REST 创建返回 403；WS 用他人 `terminalId` 连接被拒。
9. 无活跃任务时终端按钮禁用；安卓端按钮隐藏。
10. 任务结束后已开终端仍可继续使用（保留语义）。
11. 审计日志记录每次终端创建/关闭/回收（用户、任务、terminalId、时间）。
12. `app.terminal.enabled=false` 时：REST 创建返回 503，前端按钮禁用提示。

## 10. 风险与安全

| 风险 | 等级 | 应对 |
|------|------|------|
| 远程 shell 可执行任意命令，等同服务器控制权 | 高 | 仅登录用户可用 + 任务归属校验 + 全局熔断开关；文档明示权限边界（不做路径沙箱，信任已授权用户） |
| pty4j 原生库加载失败（架构不匹配） | 中 | 锁 Linux x86_64；启动时 catch 加载异常，创建接口返回明确错误；单测覆盖创建流程 |
| 长生命周期 pty 进程泄漏 | 中 | idle/maxLifetime 定时清理 + 任务删除时 `closeByTask` 兜底 + 服务停机钩子关闭全部 |
| 断线保留导致僵尸终端 | 低 | idle 30min 回收 + 每任务 5 个上限 |
| 心跳缺失被容器 90s 掐断 | 低 | 前端 30s ping 保活 |
| 输入含敏感信息 | 低 | 明确不做输入落盘（仅生命周期审计） |

## 11. 后续迭代（不做，仅记录）

- 终端输入输出审计落盘（可配置开关）；
- 终端内搜索 / 可点击链接 / 分屏 / 字体主题设置；
- 历史终端列表恢复入口（含 xterm 内容回放）；
- 安卓端终端支持（虚拟键）；
- 多用户实时共享 / 广播终端。
