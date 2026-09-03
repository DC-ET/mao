# 云端任务远程终端（Cloud Remote Terminal）技术方案 v2.0

> 版本：v2.0 | 日期：2026-09-03 | 状态：**待评审**
> 关联文档：
> - `docs/plan/cloud-terminal-design.md`（v1.0，2026-08-06 已驳回，仅作归档，不再实施）
> - `docs/plan/terminal-design.md`（Electron 本地终端设计，已上线，本期不改）
>
> 本文档完全替代 v1.0。所有实现以本文为准；v1.0 中的接口表、配置项、验收标准均已作废。
>
> 需求来源（用户原话）：「目前客户端有一个终端功能，但是目前只有在 Local 模式下才能使用，云端模式下现在是无法使用的，有没有可能支持？先不考虑安全的问题。」

---

## 1. 对 v1.0 七条驳回意见的逐条回应

| # | v1.0 驳回理由 | v2.0 处理方式 |
|---|--------------|--------------|
| 1 | 缺少操作系统级用户隔离，所有终端以后端进程账号运行，普通用户实际获得服务器 Shell | **不再假装有隔离**。改为「仅管理员可用」权限模型：新增 `terminal:use` 权限点，迁移只授予 role_id=1（ADMIN）。文档第 11 章直白写明「授予 `terminal:use` 等于授予服务器 root shell」。不做容器/系统账号隔离，并在第 3.2 节列为明确不做 |
| 2 | session 归属校验不能替代系统权限隔离 | **承认**。v2 中归属校验只有一个作用：决定终端的 cwd 挂在哪个任务的 workspace、以及 terminalId 能被谁 attach。它不是安全边界，文档不再把它写成安全措施 |
| 3 | Docker 镜像以 root 运行，PTY 获得容器 root 权限 | **事实修正**：当前部署不是 Docker。仓库无 Dockerfile / compose，docker daemon 未运行；实际形态是 `node dist/main.js` + `setsid nohup` 蓝绿双端口（9080 ↔ 9081）+ nginx upstream 切换（`scripts/lib/blue-green.sh`、`backend-ts/restart.sh`）。实测活跃进程 PID 3307722，`/proc/3307722/exe` → fnm 的 node v24.3.0，**owner 为 root，无 systemd 限制**。因此风险比 v1.0 描述的更高而非更低：PTY 直接拿到宿主机 root。第 11 章据实改写 |
| 4 | 权限控制描述不准确：`PermissionInterceptor` 不会因接口在 `/v1/**` 就自动 RBAC | **已核实并修正**：backend-ts 全仓没有 `@RequirePermission` 装饰器，也没有 PermissionInterceptor（CLAUDE.md 该处表述与代码不符）。权限一律靠 routes 内显式 `await requirePermission(permissionService, userId, 'xxx')`（全库 18 处，如 `settings.routes.ts:31/37/45`）。v2 的终端 REST 三个接口逐个显式调用，WS 侧在 attach 时再查一次 |
| 5 | 后端重启恢复承诺不可实现（注册表在进程内存） | **v2 不承诺跨重启恢复**。只承诺网络断线重连。「后端重启（含蓝绿部署）后所有终端丢失」写入第 10 章验收标准，视为预期行为 |
| 6 | WS 设计冲突：单例连接却在握手 URL 绑单个 terminalId；断线期间未消费 PTY 输出会阻塞子进程 | **v2 改为单连接多路复用**：握手 URL 不带 terminalId 也不带 token；连接后首帧 `auth`，再用 `attach` 消息逐个绑定 terminalId，所有帧都带 terminalId 字段。断线后后端**继续消费** PTY 输出写入环形缓冲，重新 attach 时先把缓冲刷给前端 |
| 7 | 高权限通道安全设计不足：任意 Origin、URL 长期携带 JWT | **token 不进 URL**（沿用 `/ws/stream` 的首帧 auth 范式，见 `streaming-ws-handler.ts:157-176`）。**Origin 限制与一次性 attach ticket 本期不做**——用户明确「先不考虑安全的问题」，第 3.2 节列为不做，第 11 章列为已知风险 |

---

## 2. 需求背景

### 2.1 现状缺口

桌面端顶栏常驻终端按钮（`TopNav.vue:28-34`，快捷键 `` Ctrl+` ``），面板是全局底部面板（挂在 `Layout.vue:7`）。当前四种组合的实际行为：

| 场景 | 现状行为 | 问题 |
|------|---------|------|
| Web 浏览器（任意任务） | 按钮无平台判断，点击后 `isOpen=true`，但 `useTerminal.createTerminal()` 首行 `if (!isElectron()) return null`（`useTerminal.ts:116`）→ 渲染出 0 个 tab 的 300px 空面板 | **Bug**：空面板，无提示 |
| 安卓 Capacitor（任意任务） | 同上 | **Bug**：空面板，无提示 |
| Electron + CLOUD 任务 | 打开**本地** node-pty 终端（`electron/terminalManager.cjs`），cwd 落到本机 home（`TerminalPanel.vue:97-105` 仅 LOCAL 才传 cwd） | 任务在服务器执行，本地终端与任务工作区无关，产生误导 |
| Electron + LOCAL 任务 | 打开本地终端，cwd = 任务 workspace | 正常，保持现状 |

另一个入口 `TaskIndexPanel.vue:844-855` 做了能力探测（`window.electronAPI?.openTerminal` 不存在时 `ElMessage.info('终端仅在桌面客户端可用')`），仅对 LOCAL 分组可见，行为正确，本期不改。

### 2.2 需求动机

CLOUD 模式下 Agent 在服务器上执行任务，用户需要一个直达服务器的交互式终端，用于：

- 查看任务运行现场（进程、端口、日志），不只依赖 Agent 汇报；
- 手动执行命令、清理产物、验证结果，与 Agent 操作**同一份文件**；
- 任务结束后继续在终端排查，不受 Agent 会话生命周期约束。

### 2.3 目标

CLOUD 任务下点击终端按钮，打开**后端服务器上**的交互式伪终端（PTY），体验接近 SSH：支持 vim / top / htop 等全屏程序、Ctrl+C 中断、窗口自适应。Web、Electron、安卓三端一致可用。

---

## 3. 需求描述

本章两张清单是本期范围的唯一依据。不使用「可选」「建议后续」等模糊表述：清单 3.1 全部必做，清单 3.2 全部不做。

### 3.1 本期必做

**执行与环境**

1. 后端进程**同机直开 PTY**：引入 node-pty，`spawn('/bin/bash', ['-i'])` 交互式 bash，`TERM=xterm-256color`，cwd = 该 CLOUD 任务的 workspace（与 Agent 操作同一目录）。不复用 Agent 的 shell 通道伪装终端，不引入独立容器。
2. shell 环境与 Agent 完全一致：`HOME` 指向每用户虚拟家目录 `/opt/mao-data/users/{userId}`（0700），注入 `GIT_TOKEN_{domain}` 与 `GIT_ASKPASS` / `GIT_TERMINAL_PROMPT=0`。
3. 虚拟 HOME 下 `.bashrc` 不存在时，由后端写入一份最小 rc：彩色 PS1 `[mao {任务名}] \w $`、`ls` 系列别名、HISTSIZE。已存在则不覆盖（用户可自行修改）。任务名通过 `MAO_TASK_NAME` 环境变量注入，rc 只做插值。
4. `MAO_TOKEN` 直接进 PTY env（复用 `jwtService.generateShellToken`），不再像 Agent shell 那样通过 writeStdin export。

**使用者与权限**

5. 新增权限点 `terminal:use`，迁移只授予 role_id=1（ADMIN）。REST 三个接口与 WS attach 均显式校验。
6. `terminal:use` **只管云端终端**。Electron 本地终端不校验该权限，行为完全不变。

**终端与任务的关系**

7. 终端绑当前任务：必须先打开一个 CLOUD 任务才能开终端；cwd = 该任务 workspace；生命周期挂在 session 上，任务被删除时关闭其全部终端。
8. 面板 tab 按任务分组：`TerminalTab` 增加 `sessionId` 字段，面板只显示当前任务的远程 tab；xterm 实例常驻内存，切回原任务内容不丢。

**通道与协议**

9. 新增独立 WebSocket `/api/ws/terminal`，与 `/api/ws/stream` 完全解耦。一条连接多路复用多个 terminalId：握手 URL 不带 token、不带 terminalId；连接后首帧 `auth`，再用 `attach` 消息绑定。
10. 新增 REST：`POST` 创建、`GET` 列表、`DELETE` 关闭（`/api/v1/sessions/{sessionId}/terminals[/{terminalId}]`）。

**存活与恢复**

11. 断线保留 PTY + 超时回收；前端自动重连后 attach 同一 terminalId 恢复。
12. 输出环形缓冲：断线期间后端**持续消费** PTY 输出写入环形缓冲（避免子进程被输出缓冲卡死），attach 时先把缓冲刷给前端。
13. 刷新后 tab 恢复：前端打开面板 / 切换任务时先拉 `GET /terminals` 列表，自动重建 tab 并 attach。
14. 输出背压保护：单连接 `bufferedAmount` 超阈值时丢弃输出帧，恢复后向前端插入一行提示（`[输出过快，已丢弃部分内容]`）。

**入口与可用性矩阵**

15. 终端按钮改为「禁用 + tooltip」，不隐藏按钮：

| 条件 | 行为 | tooltip |
|------|------|---------|
| 无活跃任务 | 禁用 | 请先打开一个任务 |
| CLOUD 任务 + 有 `terminal:use` | **云端终端**（Web / Electron / 安卓均可） | 终端 (Ctrl+\`) |
| CLOUD 任务 + 无 `terminal:use` | 禁用 | 没有终端使用权限 |
| CLOUD 任务 + workspace 为空 | 禁用 | 任务工作区不可用 |
| LOCAL 任务 + Electron | 本地终端（现状不变） | 终端 (Ctrl+\`) |
| LOCAL 任务 + Web / 安卓 | 禁用 | 本地任务的终端仅在桌面客户端可用 |

16. **破坏性变更**：Electron + CLOUD 任务下，终端按钮由「打开本地终端」改为「打开远程终端」。
17. 顺带修掉 2.1 表中 Web / 安卓点击弹空面板的 bug（由禁用矩阵覆盖）。

**安卓端**

18. 安卓开启云端终端，并新增虚拟按键条（仅安卓渲染，`isAndroidCapacitor()` 守卫，Web 与 Electron 不渲染）：`Esc` / `Tab` / `Ctrl`（粘滞键）/ `↑` / `↓` / `Ctrl+C` / `←` / `→` / `Ctrl+D` / `粘贴`。
19. 软键盘避让：用 `visualViewport` 的 resize/scroll 事件计算底部遮挡，上推面板并 refit。
20. 安卓原生壳不动：不改 MainActivity / capacitor.config / AndroidManifest，不跑 `build-apk.sh`。发版 = 部署 `desktop/dist` + 重启后端。按键条与键盘避让全部用 Web 技术实现。

**终端内搜索**

21. 引入 `@xterm/addon-search`，支持 `Ctrl+F` 在当前终端内搜索（上一个 / 下一个 / 关闭）。

**参数与运维**

22. 并发与回收参数进 DB 设置项（`system_setting`）并在 admin 系统设置页可调（不是只写 application.yml）：每任务上限 5、全局上限 50、空闲回收 2 小时、最长存活 24 小时、输出缓冲 256KB。
23. 审计只记生命周期：创建 / 关闭 / 超时回收 / 重连 attach。不落盘任何输入输出内容。

**测试**

24. 后端 Vitest 单测：TerminalManager（创建、每任务上限、全局上限、归属校验、环形缓冲截断与刷新、idle 与 maxLifetime 清理、attach 顶替、closeBySession）+ WS handler 消息路由（fake socket）。
25. 前端不写单测，靠 `vue-tsc`（`cd desktop && npm run build`）+ 手工验收。

### 3.2 本期明确不做

**安全边界（用户已确认排除）**

1. 不做路径沙箱：终端里 `cd /`、绝对路径、软链接、`/proc` 均不受限。
2. 不做命令黑白名单（不复用 `harness/shell/command-deny-list.ts`，该模块只服务 Agent 的 shell 工具）。
3. 不做输入输出落盘（不做内容审计、不做回放录制）。
4. 不做容器隔离、不做独立系统账号、不做资源配额 / seccomp / AppArmor。
5. 不做 WS Origin 限制、不做一次性 attach ticket（沿用登录 JWT 首帧 auth）。
6. 不做全局熔断开关（`terminal.enabled` 之类）：`terminal:use` 权限本身就是开关，再加一个开关属于重复控制面。

**功能边界**

7. 不做 tmux / screen / 终端守护进程托管，**不承诺跨后端重启恢复**。后端重启（含蓝绿部署）后全部终端丢失。
8. 不把终端输出发给 Agent、不做「把这段输出交给 Agent 分析」入口；Agent 不感知用户在终端做了什么。
9. 不把 Agent 的 shell 工具（`harness/shell/shell-session-manager.ts`，管道 + marker 模式）改成 PTY，两套并存互不影响。
10. 不做 admin 端终端管理页（不做管理员查看 / 强制关闭他人终端的界面）。
11. 不做多用户共享同一终端 / 广播观战。
12. 不做终端 shell 可配置（硬编码 `/bin/bash`，因为默认 rc 写入逻辑是 bash 专用；做成可配会得到半成品）。
13. 不做二进制输出 base64 传输：PTY 输出按 UTF-8 解码为字符串走 JSON 文本帧，`cat` 二进制文件会出现替换字符，属预期。
14. 不做输出限速 / PTY 流控（不启用 node-pty `handleFlowControl`，避免干扰用户 Ctrl+S）；只做第 3.1.14 条的背压丢帧。
15. 不做分屏、不做终端字体 / 主题配置项、不做可点击链接（addon-web-links）。
16. 不改 Electron 本地终端任何代码：`electron/main.cjs`、`electron/preload.cjs`、`electron/terminalManager.cjs`、`src/types/electron.d.ts` 全部不动。
17. 不改安卓原生壳、不出 APK。

---

## 4. 现状分析（撰写方案时已核实的事实）

本章列出方案依赖的关键事实，均已在当前工作区代码 / 服务器实测中确认，供评审时快速核对。

### 4.1 部署形态

- 线上目录 `/opt/mao`（与会话工作区 `/opt/mao-data/workspace/...` 是两套 git 检出）。
- 非 Docker：`node dist/main.js` + `setsid nohup` 蓝绿双端口（9080 ↔ 9081）+ nginx upstream 切换。实测活跃 PID 3307722，node v24.3.0（fnm），**以 root 运行，无 systemd**。
- 工作区真实根 `/opt/mao-data/workspace`（CLAUDE.md 提到的 `/opt/mao/data/workspace` 不存在）；会话工作区 `{root}/{userId}/{sessionId}`，命名项目 `{root}/{userId}/projects/{slug}`。
- 虚拟 HOME 根 `/opt/mao-data/users`（`app-config.ts:166`，可用 `MAO_USER_HOME_DIR` 覆盖）；实测 `/opt/mao-data/users/{1,2,3}` 存在且为 `drwx------`，**其中没有 .bashrc / .profile**（这是 3.1.3 需要写默认 rc 的原因）。
- runtime 根 `/opt/mao-data/runtime`（`app-config.ts:165`），结构 `{userId}/{sessionId}/{shellOutput,skills,incoming,git-askpass.sh}`。
- 编译工具链齐备：node v24.3.0、python3 3.12.7、gcc 11.4.0、GNU Make 4.3，`~/.cache/node-gyp/24.3.0` 已存在。
- nginx `/etc/nginx/conf.d/mao.conf` 已有 `location /api/ws/`（`proxy_http_version 1.1` + Upgrade/Connection 头 + `proxy_read_timeout 86400s`）。**新路径 `/api/ws/terminal` 自动被覆盖，无需改 nginx**。

### 4.2 WS 层硬约束（实测结论，直接决定实现写法）

`@fastify/websocket` 由 fastify-plugin 包装（skip-override），**不能第二次 register**：

| 写法 | 结果 |
|------|------|
| 同 scope `register(websocket)` 两次 | ❌ `FST_ERR_DEC_ALREADY_PRESENT: The decorator 'ws' has already been added!`，在 `app.register(async api => ...)` 内表现为 **uncaughtException，try/catch 抓不到** |
| 父 scope 注册后子 scope 再注册 | ❌ 同上 |
| 两个 sibling 子 scope 各注册一次 | ⚠️ ready 通过，但运行期 `ERR_HTTP_SOCKET_ASSIGNED` |
| ws 路由声明在 register 之前 | ❌ 握手 HTTP 500（`s.on is not a function`） |
| **register 一次 + 同 scope 多个 `app.get(..., { websocket: true })`** | ✅ 两条路径各自正常 |

因此本方案唯一可行写法：在 `backend-ts/src/session/ws/attach-websocket.ts` 现有 `await app.register(websocket, ...)`（:13-17）**之后**追加第二个 `app.get('/ws/terminal', { websocket: true }, ...)`。

其他相关事实：
- `maxPayload: 1024*1024` 是 wss 全局选项，两条路由共享。
- idle 超时是 per-connection 的 `setInterval(15s)`（`attach-websocket.ts:26-31`），新路由需自带同类逻辑。
- 鉴权不在握手：`auth/jwt-hook.ts:4` 的 `PUBLIC_PREFIXES` 包含 `/ws/`，整条 `/ws/**` 放行，**终端通道必须自行应用层鉴权**。
- `parseUserIdFromToken`（`streaming-ws-handler.ts:1328-1338`）用 `jwtService.validateAccessToken`，接受 `access` / `shell`，拒绝 `refresh`。

### 4.3 可直接复用的后端能力

| 能力 | 位置 | 复用方式 |
|------|------|---------|
| 虚拟 HOME 构造 | `shell-session-manager.ts:541-550 configureUserHome` | 抽同名私有方法到 TerminalManager（逻辑一致：mkdir + chmod 0700 + `env.HOME` + `pathSandbox.addAllowedRoot`） |
| Git 凭据注入 | `shell-session-manager.ts:552-569 configureGitCredentials` | 同上（写 `GIT_TOKEN_*` + `GIT_ASKPASS`（内容 `ASKPASS`，来自 `file/git-write-operation.service.ts:24`）+ `GIT_TERMINAL_PROMPT=0`） |
| token map 查询 | `create-app.ts:364 gitLookup.getTokenMapByUser` | 直接注入 |
| 路径解析 | `harness/runtime/runtime-data-resolver.ts`（`resolveUserHomeDir` :39-42、`resolveGitAskpassScript` :35-37） | 直接注入 |
| workspace 兜底 | `harness/safety/path-sandbox.ts:69-74 getEffectiveWorkspaceRoot` | 直接调用 |
| MAO_TOKEN | `crypto/jwt.service.ts:24-26 generateShellToken`（`shellExpiration` 默认 7200000ms） | 生成后进 env |
| 生命周期清理范式 | `shell-session-manager.ts:480-500`（`startCleanup(60_000)` 幂等 + `cleanupExpiredSessions`） | 同结构实现 |
| 归属校验 | `session.routes.ts:82-89 requireSessionOwner`（`session.userId !== userId` → `BusinessException(FORBIDDEN)`） | 终端 routes 内同写法 |
| 会话删除挂点 | `session.service.ts:404-428 deleteSession` 内 `this.cleanupRuntimeDir?.(...)`（:420，可选回调，装配处 `create-app.ts:456`） | 增加同风格可选回调 `closeSessionTerminals` |
| 审计写入 | `audit/audit.service.ts:8 record(log: AuditLog)` | 定时回收路径显式调用 |

### 4.4 node-pty 在本服务器的实测结果

在服务器 Node v24.3.0 下用 node-pty 1.1.0 实测，全部通过：

- ESM 命名导入可用：`import { spawn } from 'node-pty'`，`typeof spawn === 'function'`。
- `spawn('/bin/bash', ['-i'], { name: 'xterm-256color', cols, rows, cwd, env })` 正常；bash 内 `echo $COLUMNS $LINES $TERM` 得到 `100 30 xterm-256color`；`resize(120,40)` 后 `$COLUMNS=120`；`onData` / `onExit({exitCode,signal})` 回调正常。
- 自定义 `HOME` + 该 HOME 下 `.bashrc` 生效：`bash -i` 自动加载，`PS1` 与 `alias ll` 均生效。
- 彩色 PS1 + 变量插值可行：rc 内 `PS1='\[\e[36m\][mao ${MAO_TASK_NAME:-task}]\[\e[0m\] \w $ '`，env 传 `MAO_TASK_NAME` 即可，**任务名不需要改写 rc 文件**。
- `MAO_TOKEN` 经 env 传入后 bash 内 `echo $MAO_TOKEN` 可读。
- 进程树回收：PTY 内 `sleep 300 &` 后调 `p.kill()`，该后台进程实测已死（`process.kill(pid,0)` 抛错）。**不需要额外 `kill(-pid)`**。
- TypeScript 编译验证：node-pty 的 typings 是 `declare module 'node-pty'` 形式的 ambient 声明；在与 backend-ts 相同的编译选项（target ES2022 / module Node16 / moduleResolution Node16 / strict / esModuleInterop）下 `tsc` 通过，编译产物运行正常。
- 输出含 bracketed paste 序列 `\u001b[?2004h/l`，是交互式 bash 的正常行为，xterm 会正确处理。

### 4.5 前端现状要点

- `useTerminal.ts`（265 行）：模块级单例 `tabs` / `activeTabId` / `isOpen`（:66-68）+ `instances: Map`（:70）；`TerminalTab { id, title, cwd }`（:53-57）；`createTerminal` 首行 `if (!isElectron()) return null`（:116），cols/rows 硬编码 80×24（:119-120）；已含 `FitAddon` + `WebglAddon`（带 `onContextLoss` 回退）。
- `TerminalPanel.vue`（239 行）：无 props / emit，状态全取自 `useTerminal()`；`watch(activeTabId)`（:66-79）负责首次 mount + focus + fit；`watch(tabs.length)`（:82-95）兜底挂载；高度拖拽支持 mouse + touch（:111-146）。
- `TerminalTabs.vue`（157 行）：props `{ tabs, activeId }`，emits `switch / close / create`。
- `TopNav.vue`：按钮模板 :28-34；`useTerminal()` 解构 :120；`toggleTerminal()` :125-131；快捷键 `handleSearchShortcut` :194-204（已处理 Ctrl+K 与 Ctrl+\`）；`isAndroidCapacitor` 已在 :154 解构可用；`useAuthStore()` 已在 :134。按钮当前**无任何平台 / 权限守卫**。
- desktop `stores/auth.ts:10-17` 的 `User` 缺 `permissions` / `isAdmin`，无 `hasPermission`；但后端 `GET /v1/users/me` 已返回二者（`user.routes.ts:114-127 toUserInfoVO`），且路由守卫 `router/index.ts:128-135` 在无 user 时自动拉取。admin 端已有完整实现可照抄（`admin/src/stores/auth.ts:10-25`）。
- `@xterm/xterm ^6.0.0` / `addon-fit ^0.11.0` / `addon-webgl ^0.19.0` 在 desktop **devDependencies**；`@xterm/addon-search` latest = 0.16.0（与 xterm 6.0.0 同批发布），实测与 xterm 6.0.0 共装成功且无 peerDependencies 约束。

### 4.6 设置项与权限落地范式

- 表 `system_setting`（`V048__admin_governance_console.sql:21-30`，`V093` 把 value 改 TEXT 并加 `is_secret`）：一条 INSERT 一行 = 一个设置项；`value=NULL` 语义为「从未设置」→ 消费方回落代码默认值。
- 迁移目录已到 `V099__drop_delegate_timeout_settings.sql`，**新增从 V100 起**。样板见 `V097__settings_harness_tuning.sql`（文件头注释逐项列代码默认值 + 生效时机，然后单条 `INSERT IGNORE ... VALUES (...)`，category 用 `运行参数`）。
- `settings.service.ts` 范式：key 常量 → `getXxxConfig()` 用 `Promise.all(getOpt × N)` + `optPositiveInt(raw, 默认值)` → 校验 Set（`HARNESS_INT_KEYS`）在 `updateSetting` 内生效。接口写在 `settings/types.ts`。
- 启动读一次 vs 每次读：`create-app.ts:307-308` bootstrap 读 `getAgentRuntimeConfig()` / `getHarnessTuningConfig()` 后把值传进构造函数（改配置须重启）；也有传 getter 即时生效的先例（`create-app.ts:676`、`1588`）。
- admin 唯一设置页 `admin/src/views/settings/SystemSettingsView.vue`：key 命中 `INTEGRATION_KEYS`（:139-153）→ 交给 `views/settings/components/IntegrationConfigPanel.vue` 的 `groups` 精细渲染（`harness-shell` 组在 :312-322），否则按 category 自动分组通用卡片；目录锚点数组 `INTEGRATION_TOC`（:156-168）。
- 权限迁移幂等样板见 `V093__settings_integration_config.sql:44-54`（`INSERT ... SELECT ... WHERE NOT EXISTS` + `INSERT IGNORE role_permission`）。role_id 1 = ADMIN，2 = USER（`V001__init_schema.sql:190-192`）。

### 4.7 审计现状

- 无拦截器类：`audit/audit.interceptor.ts` 是纯函数集合，接线在 `create-app.ts:380-392` 的 Fastify `onResponse` hook。
- `AUDITED_PREFIXES`（:6-15）只有 8 个前缀，**不含 `/v1/sessions`**。
- `resolveAction`：POST→CREATE / PUT,PATCH→UPDATE / DELETE→DELETE / GET→READ / 其他→EXECUTE；`resolveObjectType`（:39-51）取 path 第 3 段；`resolveObjectId`（:53-64）取第一个纯数字段。
- ws upgrade 走 `preHandler`，**不走 `onResponse`**（hijack），所以 WS attach 的审计必须手写。
- 定时回收无 HTTP 请求，`onResponse` hook 抓不到，也必须显式调 `AuditLogService.record()`。`audit_log` 表的 `action` / `object_type` / `method` / `path` 均 NOT NULL，需给约定值。
- `session/activity.service.ts` 是会话活动流（强绑 session_id、无 user_id / ip），不是系统审计。v1.0 误用它，v2 改用 `AuditLogService`。

---

## 5. 技术选型

### 5.1 PTY 实现

| 方案 | 说明 | 结论 |
|------|------|------|
| **node-pty 1.1.0** | 微软维护，VS Code 同款；Linux 用 forkpty，支持 resize / 信号 / 进程树回收；desktop 端已在用同版本 | **选用** |
| `child_process.spawn` 管道（现有 Agent shell 方案） | 无 PTY，vim / top / htop 不可用，Ctrl+C 语义不完整 | 否决 |
| `script -qec` 包装 | 零依赖但 resize 不可控、退出码不可靠 | 否决 |
| 独立 ttyd / gotty 进程 + 反代 | 引入第二个服务与第二套鉴权，运维复杂度上升；与任务 workspace 绑定需额外拼装 | 否决 |

node-pty 的落地代价与结论：
- 唯一依赖 `node-addon-api ^7.1.0`（纯头文件），无运行时依赖。
- install 脚本是 `node scripts/prebuild.js || node-gyp rebuild`，随包 prebuilds 只覆盖 darwin / win32，**Linux x64 必须本机 node-gyp 编译**。已确认服务器工具链齐备且实测编译通过（desktop 侧 `/opt/mao/desktop/node_modules/node-pty/build/Release/pty.node` 已是 71736 字节的 ELF x86-64）。
- 版本锁 `1.1.0`（1.2.0 仍是 beta）。
- 影响面：backend-ts 的 `npm ci` 从此需要 python3 / make / g++。CI backend job（Node 22 / ubuntu-latest）自带这套工具链，无需改 workflow；但**部署文档必须补装依赖说明**（`skills/mao-cli/reference/deploy.md:56` 当前只装 `nodejs nginx git`）。

### 5.2 WS 通道

| 方案 | 说明 | 结论 |
|------|------|------|
| **新建 `/api/ws/terminal`，单连接多路复用** | 与 Agent 执行流解耦；终端按钮是全局的；高频字节流不挤占 Agent 事件；可独立心跳与超时策略 | **选用** |
| 复用 `/api/ws/stream` | `StreamingWsRegistry` 按 userId 广播、出站队列容量 10000 且**满则 warn 后直接丢弃**（`app-config.ts:159`），承载终端字节流会互相伤害 | 否决 |
| 每个终端一条 WS 连接 | 连接数随 tab 线性增长，重连风暴时更糟；nginx 连接数与心跳成本翻倍 | 否决 |

### 5.3 前端渲染与搜索

沿用 xterm.js 栈（`@xterm/xterm` + `addon-fit` + `addon-webgl`），新增 `@xterm/addon-search ^0.16.0`（放 devDependencies，与其他 xterm 包一致）。已实测：0.16.0 与 xterm 6.0.0 同批发布、无 peerDependencies 约束（0.17.0-beta 才要求 xterm ^6.1.0-beta），`SearchAddon` 提供 `findNext` / `findPrevious` / `clearDecorations` / `onDidChangeResults`，满足本期需要。

### 5.4 断线恢复策略

| 方案 | 说明 | 结论 |
|------|------|------|
| **进程内注册表 + 环形缓冲 + 前端重连 attach** | 覆盖网络抖动、页面刷新、切任务；实现集中在一个类里 | **选用** |
| tmux / screen 托管 | 能扛后端重启，但引入外部依赖 + 会话名管理 + 输出解析，复杂度远超收益 | 否决（3.2.7） |
| 不做保留，断线即杀 | 手机弱网下几乎不可用 | 否决 |

代价：后端重启（含每次蓝绿部署）会丢掉所有终端。这是明确接受的取舍，写入验收标准。

---

## 6. 架构设计

### 6.1 整体结构

```
┌──────────────── 前端 desktop/（Web + Electron + 安卓 Capacitor 同源） ────────────────┐
│ TopNav 终端按钮 / Ctrl+`  ── 可用性矩阵（禁用 + tooltip）                            │
│   │ 按 activeSession.executionMode + 平台 + hasPermission('terminal:use') 分流       │
│   ├─ LOCAL + Electron → useTerminal 本地分支 → electronAPI.terminal.*（不动）         │
│   └─ CLOUD           → useTerminal 远程分支                                          │
│           │ 1) GET  /api/v1/sessions/{id}/terminals        （打开面板 / 切任务时）    │
│           │ 2) POST /api/v1/sessions/{id}/terminals        （新建 tab）              │
│           ▼                                                                          │
│      useTerminalWS.ts（单例连接 + 多路复用 + 重连退避 + 心跳）                        │
│      ws(s)://{host}/api/ws/terminal                                                  │
│      C→S: auth / attach / detach / input / resize / ping                              │
│      S→C: connected / attached / output / exit / error / pong                          │
│      xterm 渲染（TerminalPanel + TerminalTabs + addon-search + 安卓按键条）            │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                    │ 独立 WS（nginx location /api/ws/ 已覆盖）
┌────────────────────────────────────▼─────────────────────────────────────────────────┐
│ backend-ts（Fastify，:9080/:9081 蓝绿）                                              │
│  attach-websocket.ts                                                                 │
│    register(@fastify/websocket)  ← 唯一一次                                          │
│    app.get('/ws/stream',   { websocket: true }, ...)   现有                           │
│    app.get('/ws/terminal', { websocket: true }, ...)   新增（必须在 register 之后）    │
│                        │                                                             │
│  TerminalWsHandler（harness/terminal/）                                              │
│    首帧 auth → userId；attach 校验 terminal.userId === userId + terminal:use          │
│    input → pty.write / resize → pty.resize / detach → 解绑但不杀                       │
│                        │                                                             │
│  TerminalManager（harness/terminal/）                                                │
│    Map<terminalId, RemoteTerminal>  +  Map<sessionId, Set<terminalId>>                │
│    create（权限/归属/上限）· attach/detach · close · closeBySession                   │
│    startCleanup(60s) → idle 2h / maxLifetime 24h → 回收 + 审计                         │
│                        │                                                             │
│  RemoteTerminal：node-pty IPty + 环形缓冲(256KB) + lastActiveAt/createdAt              │
│    env = { …process.env, TERM, HOME(虚拟), GIT_TOKEN_*, GIT_ASKPASS, MAO_TOKEN,        │
│            MAO_TASK_NAME }，cwd = session.workspace                                   │
│                                                                                      │
│  REST：session/terminal.routes.ts（POST / GET / DELETE，逐个 requirePermission）       │
│  审计：AuditLogService.record（创建 / 关闭 / 回收 / attach）                           │
│  挂点：SessionService.deleteSession → closeSessionTerminals 回调                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 数据流

**创建**：点击 `+` 或首次打开面板（无 tab）→ `POST /v1/sessions/{id}/terminals { cols, rows }` → 后端校验登录 + `terminal:use` + session 归属 + executionMode=CLOUD + workspace 非空 + 每任务上限 + 全局上限 → 构造 env（虚拟 HOME、Git 凭据、MAO_TOKEN、MAO_TASK_NAME）→ 首次写默认 rc → `pty.spawn` → 返回 `{ terminalId, shell, cwd, cols, rows }` → 前端建 xterm 实例与 tab → WS `attach`。

**输入**：xterm `onData` → `{ type:'input', terminalId, data }` → `pty.write(data)`。

**输出**：`pty.onData` → 写环形缓冲 + 若有 attached socket 则 `{ type:'output', terminalId, data }` → `terminal.write(data)`。无 attached socket 时只写缓冲。

**resize**：`fitAddon.fit()` → xterm `onResize` → `{ type:'resize', terminalId, cols, rows }` → `pty.resize(cols, rows)`。

**断线**：socket close → 对该 socket 上所有 attached terminal 执行 detach（**不杀 PTY**）→ PTY 输出继续写缓冲。前端 30s 静默超时或 onclose → 指数退避重连（1s ×2，上限 30s）→ 重新 `auth` → 对所有远程 tab 重新 `attach` → 收到 `attached` 后先写缓冲内容（后端在 `attached` 之后立刻推一帧 `output`），再恢复实时流。

**刷新 / 切任务**：面板打开或 activeSession 变化 → `GET /v1/sessions/{id}/terminals` → 与本地 tab 做差集：缺失的建 tab 并 attach（缓冲回放补历史），本地多出的（后端已回收）移除 tab 并提示。

**关闭**：用户点 tab 关闭 → `DELETE /v1/sessions/{id}/terminals/{terminalId}` → `pty.kill()`（连带回收后代进程）→ 前端移除 tab 与 xterm 实例。

**退出**：用户输入 `exit` → `pty.onExit` → 广播 `{ type:'exit', terminalId, exitCode }` + 从注册表移除 → 前端移除 tab。

**超时回收**：`startCleanup(60s)` 扫描 → idle 超 2h 或存活超 24h → `pty.kill()` + 移除 + 审计一条 → 若仍有 attached socket，先发 `{ type:'error', terminalId, code:'TERMINAL_RECLAIMED' }`。

**任务删除**：`deleteSession` → `closeSessionTerminals(sessionId)` → 该任务全部 PTY kill + 审计。

---

## 7. 后端设计

### 7.1 新增模块 `backend-ts/src/harness/terminal/`

| 文件 | 职责 |
|------|------|
| `remote-terminal.ts` | `RemoteTerminal`：包装 `IPty`；`write` / `resize` / `kill`；环形缓冲写入与读取；`touch()` / `isIdleTimeout(ms)` / `isExpired(ms)`；`attachedSocketId` 单值（同一时刻仅一个 socket）；`onData` / `onExit` 转发注册 |
| `terminal-manager.ts` | `TerminalManager`：`Map<string, RemoteTerminal>` + `Map<number, Set<string>>`（sessionId → terminalIds）；`create()` / `get()` / `list(sessionId)` / `close(id)` / `closeBySession(sessionId)` / `attach(id, socket)` / `detach(socketId)`；`startCleanup(60_000)` / `stopCleanup()`；env 构造（`configureUserHome` / `configureGitCredentials` / `ensureDefaultRc`）；审计回调 |
| `terminal-ws-handler.ts` | `TerminalWsHandler`：`handleTextMessage(socket, text)` / `afterConnectionClosed(socket)`；socket → userId 映射；attach / detach / input / resize / ping 路由 |
| `terminal-manager.spec.ts` | TerminalManager 单测（用可注入的 fake pty factory，不起真实 PTY） |
| `terminal-ws-handler.spec.ts` | WS handler 消息路由单测（fake socket + fake manager） |

`RemoteTerminal` 关键字段：

```ts
interface RemoteTerminalMeta {
  terminalId: string;      // term-{sessionId}-{ts}-{rand8}，与 sh-{conv}-{ts}-{rand8} 风格一致
  sessionId: number;
  userId: number;
  shell: string;           // /bin/bash
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActiveAt: number;
  attached: boolean;
  alive: boolean;
}
```

环形缓冲：单终端固定上限 `outputBufferBytes`（默认 262144）。实现为 `string[]` 分片队列 + 累计字节数，超限时从头部丢弃并置 `truncated=true`；`readBuffer()` 返回拼接结果，若 `truncated` 则在最前面加一行 `\r\n[历史输出过长，已截断前面部分]\r\n`。

进程回收：只调 `pty.kill()`。已实测 node-pty 的 kill 会回收 PTY 会话内的后代进程，不需要 `process.kill(-pid)`。

### 7.2 REST 接口（新增 `backend-ts/src/session/terminal.routes.ts`）

统一 `Result<T>` 包装（`code=0` 成功），错误经 `handleError` 归一。注册位置：`create-app.ts` 的 `app.register(async (api) => {...}, { prefix: apiPrefix })` 内，`registerAdminSessionRoutes`（:1523）之后、`attachWebSocket`（:1581）之前。实测 `/v1/sessions/:id` 与 `/v1/sessions/:sessionId/terminals` 同 scope 并存不冲突（现有先例 `session.routes.ts:424` 的 `/v1/sessions/:sessionId/todos/:todoId`）。

| 方法 | 路径 | 权限 | 入参 | 返回 |
|------|------|------|------|------|
| POST | `/api/v1/sessions/{sessionId}/terminals` | 登录 + `terminal:use` + session 归属 | body `{ cols?: number, rows?: number }`（缺省 80×24，范围 1~500 / 1~200） | `{ terminalId, sessionId, shell, cwd, cols, rows, createdAt }` |
| GET | `/api/v1/sessions/{sessionId}/terminals` | 同上 | — | `[{ terminalId, sessionId, shell, cwd, cols, rows, createdAt, lastActiveAt, attached }]`（按 createdAt 升序） |
| DELETE | `/api/v1/sessions/{sessionId}/terminals/{terminalId}` | 同上 | — | `null`（幂等：不存在也返回 code=0） |

每个 handler 内的固定顺序：

```ts
const userId = requireUserId(request);
await requirePermission(permissionService, userId, 'terminal:use');
const sessionId = pathId(request, 'sessionId');
const session = await requireSessionOwner(userId, sessionId);   // 复用 session.routes.ts:82-89 的同名实现
```

错误码（**不新增业务码**，复用现有 `common/error-code.ts`）：

| 场景 | 错误 | HTTP |
|------|------|------|
| 未登录 | `UNAUTHORIZED 1001` | 401 |
| 无 `terminal:use` | `BusinessException(403, '无权限: terminal:use')` | 403 |
| session 不存在 | `SESSION_NOT_FOUND 3002` | 200 + body.code=3002 |
| session 非本人 | `FORBIDDEN 1002` | 403 |
| 非 CLOUD 任务 | `PARAM_INVALID 2001`「仅云端任务支持远程终端」 | 200 + body.code=2001 |
| workspace 为空 | `PARAM_INVALID 2001`「任务工作区不可用」 | 200 + body.code=2001 |
| 超每任务上限 | `PARAM_INVALID 2001`「该任务的终端数量已达上限 N，请先关闭已有终端」 | 200 + body.code=2001 |
| 超全局上限 | `PARAM_INVALID 2001`「服务器终端总数已达上限 N，请稍后再试」 | 200 + body.code=2001 |
| PTY 启动失败 | `INTERNAL_ERROR 5001` + 原因日志 | 200 + body.code=5001 |
| terminalId 不属于该 session | `FORBIDDEN 1002` | 403 |

选择理由：`error-code.ts` 现有最大业务码为 3027，没有 409 / 503 语义码；仓库既有做法（如 `session.service.ts:409`「会话运行中，无法删除」）就是用 `PARAM_INVALID 2001` 表达状态冲突。为终端单独新增 3028+ 会让前端多一套分支而没有实际收益，因此复用。前端按 message 直接 toast。

### 7.3 WS 通道 `/api/ws/terminal`

注册（`backend-ts/src/session/ws/attach-websocket.ts`，在现有 `app.get('/ws/stream', ...)` 之后追加）：

```ts
export interface AttachWebSocketDeps {
  handler: StreamingWsHandler;
  idleTimeoutMs?: number;
  terminalHandler: TerminalWsHandler;      // 新增
  terminalIdleTimeoutMs?: number;          // 新增，默认 90_000
}
```

`/ws/terminal` 的连接包装与 `/ws/stream` 同构（id / readyState / send / close + 15s 检查 idle + message / close / error / pong 四个监听），但**不复用 `streaming-ws-registry.ts` 的 `WsSocket` 接口**——终端侧需要额外的 `bufferedAmount` 字段做背压判断，因此在 `harness/terminal/terminal-ws-handler.ts` 内定义独立的 `TerminalSocket` 接口。**不新增第二次 `app.register(websocket, ...)`**（原因见 4.2）。

协议（JSON 文本帧，除首帧 `auth` 外所有帧都带 `terminalId`）：

| 方向 | 消息 | 说明 |
|------|------|------|
| C→S | `{ type:'auth', token }` | 首帧。未认证时其他帧一律 `close(1003,'Not authenticated')`；token 无效 `close(1003,'Missing or invalid token')`。校验走 `jwtService.validateAccessToken`（接受 access / shell，拒绝 refresh） |
| C→S | `{ type:'attach', terminalId }` | 绑定。校验 terminal 存在 + `terminal.userId === userId` + `terminal:use`；同一 terminal 已被别的 socket attach 时**顶替**旧连接（向旧连接发 `{type:'error',code:'TERMINAL_TAKEN_OVER'}` 后解绑） |
| C→S | `{ type:'detach', terminalId }` | 解绑但不杀 PTY（切任务时不需要，前端仅在关闭 tab 前用） |
| C→S | `{ type:'input', terminalId, data }` | 键盘输入，原样写入 PTY |
| C→S | `{ type:'resize', terminalId, cols, rows }` | 尺寸变更，参数范围校验后 `pty.resize` |
| C→S | `{ type:'ping' }` | 保活（前端 30s 一次） |
| S→C | `{ type:'connected', userId }` | auth 成功 |
| S→C | `{ type:'attached', terminalId, cols, rows }` | attach 成功；紧随其后立即发一帧 `output` 刷环形缓冲 |
| S→C | `{ type:'output', terminalId, data }` | PTY 输出 |
| S→C | `{ type:'exit', terminalId, exitCode }` | PTY 退出 |
| S→C | `{ type:'pong' }` | ping 响应 |
| S→C | `{ type:'error', terminalId?, code, message }` | `code` ∈ `TERMINAL_NOT_FOUND` / `TERMINAL_FORBIDDEN` / `TERMINAL_RECLAIMED` / `TERMINAL_TAKEN_OVER` / `BAD_REQUEST` |

背压：每次发送 `output` 前检查底层 `bufferedAmount`（由 `TerminalSocket` 包装从原始 ws 透出）；超过 1MB 时丢弃该帧并记 `dropped=true`，下一次可发送时先插一帧 `\r\n[输出过快，已丢弃部分内容]\r\n`。注意 wss 全局 `maxPayload = 1MB`（`attach-websocket.ts:13-17`）是**入站**限制，`input` 帧远小于此，无需额外处理；`output` 帧由后端自行分片发送（PTY 单次 onData 输出通常远小于 1MB，无需强制切分）。

### 7.4 PTY 环境构造

```ts
const env: NodeJS.ProcessEnv = {
  ...process.env,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: process.env.LANG ?? 'en_US.UTF-8',
  MAO_TASK_NAME: session.title ?? `任务 ${sessionId}`,
};
this.configureUserHome(env, userId);                              // HOME=/opt/mao-data/users/{userId}，0700
if (tokenMap 非空) this.configureGitCredentials(env, userId, sessionId, tokenMap);  // GIT_TOKEN_* / GIT_ASKPASS / GIT_TERMINAL_PROMPT=0
env.MAO_TOKEN = jwtService.generateShellToken(userId, username);  // 短效 shell token
this.ensureDefaultRc(env.HOME);                                   // 仅当 .bashrc 不存在
const pty = spawn('/bin/bash', ['-i'], {
  name: 'xterm-256color', cols, rows,
  cwd: pathSandbox.getEffectiveWorkspaceRoot(session.workspace),
  env,
});
```

默认 rc 内容（仅在 `{HOME}/.bashrc` 不存在时写入，之后不再覆盖）：

```bash
# Mao 云端终端默认配置（首次创建终端时自动生成，可自行修改；删除后会重新生成）
PS1='\[\e[36m\][mao ${MAO_TASK_NAME:-task}]\[\e[0m\] \w \$ '
alias ll='ls -alF'
alias la='ls -A'
alias ls='ls --color=auto'
alias grep='grep --color=auto'
export HISTSIZE=5000
export HISTFILESIZE=10000
```

`MAO_TASK_NAME` 走 env 而非改写 rc（已实测插值生效），所以同一用户的多个任务共用一份 rc，提示符仍能显示各自任务名。

### 7.5 DB 设置项（新增迁移 `V100__settings_terminal.sql`）

| setting_key | 默认值 | 校验 | 说明 |
|-------------|--------|------|------|
| `terminal.maxSessionsPerTask` | 5 | 正整数 | 每任务并发终端上限 |
| `terminal.maxSessionsGlobal` | 50 | 正整数 | 全局并发终端上限 |
| `terminal.idleTimeoutMinutes` | 120 | 正整数 | 空闲回收（无输入输出、无 attach） |
| `terminal.maxLifetimeHours` | 24 | 正整数 | 最长存活 |
| `terminal.outputBufferBytes` | 262144 | 正整数 | 单终端环形缓冲上限 |

迁移写法与 `V097` 一致：文件头注释列出代码默认值与生效时机，然后单条 `INSERT IGNORE INTO system_setting (setting_key, value, category, description, editable) VALUES (...)`，`value` 全部为 `NULL`，`category='运行参数'`，`editable=1`。

生效模式：**启动时读一次**（与 `harness.shell.*` 一致，改完需重启后端）。理由是这些参数在 TerminalManager 构造时固化，且终端功能本身在后端重启后就会全部丢失，没有「即时生效」的实际价值。

代码改动点：
1. `settings/types.ts` 新增 `TerminalSettings` 接口（5 个 number 字段）。
2. `settings.service.ts`：5 个 key 常量 + `getTerminalConfig()`（`Promise.all(getOpt × 5)` + `optPositiveInt(raw, 默认值)`）+ 把 5 个 key 加入 `HARNESS_INT_KEYS` 同级的整数校验集合（新增 `TERMINAL_INT_KEYS`，在 `updateSetting` 内校验正整数）。
3. `create-app.ts`：bootstrap 阶段 `const terminalCfg = await bootstrapSettings.getTerminalConfig();`（紧随 :308 的 `harnessTuning`），构造 TerminalManager 时传入。
4. admin：`SystemSettingsView.vue` 的 `INTEGRATION_KEYS` 加 5 个 key、`INTEGRATION_TOC` 加 `{ id:'setting-group-terminal', label:'云端终端' }`；`IntegrationConfigPanel.vue` 的 `groups` 末尾新增 `{ name:'terminal', title:'云端终端', keys:[...], fields:[...] }`，`fields` 全部 `type:'number'` 并带 min/max/hint。

### 7.6 权限迁移（同一个 `V100__settings_terminal.sql` 文件内）

```sql
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '使用云端终端', 'terminal:use', '在云端任务中打开服务器交互式终端（等同服务器 Shell 权限）'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'terminal:use');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` = 'terminal:use'
  AND NOT EXISTS (SELECT 1 FROM `role_permission` WHERE `role_id` = 1 AND `permission_id` = `permission`.`id`);
```

只授 role_id=1（ADMIN），不授 role_id=2（USER）。角色-权限页 `admin/src/views/permission/RolePermissionView.vue` 会自动列出新权限，管理员可手动授予他人——授予行为的风险由第 11 章文档说明承担。

### 7.7 审计接入

**不改 `audit.interceptor.ts`**，四类生命周期事件全部由 TerminalManager 显式调用 `AuditLogService.record()`。

放弃「把 `/v1/sessions` 加入 `AUDITED_PREFIXES`」的原因有两条，都是硬事实：
1. 该前缀一加，全部 session 接口（含前端高频轮询的 GET）都会进审计表，需要再补一条 GET 排除规则，属于为一个功能污染全局审计策略。
2. 即使加了，`resolveObjectType`（`audit.interceptor.ts:39-51`）取 path 第 3 段，`/v1/sessions/12/terminals` 会被记成 `objectType='sessions'`、`objectId='12'`，拿不到 terminalId。达不到「按终端追溯」的目的。

字段约定（`audit_log` 的 action / object_type / method / path 均 NOT NULL）：

| 事件 | action | objectType | objectId | method | path |
|------|--------|-----------|----------|--------|------|
| 创建终端 | `CREATE` | `terminal` | terminalId | `POST` | `/v1/sessions/{sessionId}/terminals` |
| 主动关闭 | `DELETE` | `terminal` | terminalId | `DELETE` | `/v1/sessions/{sessionId}/terminals/{terminalId}` |
| WS attach 成功 | `EXECUTE` | `terminal` | terminalId | `WS` | `/ws/terminal/attach` |
| 空闲 / 超时回收 | `DELETE` | `terminal` | terminalId | `SYSTEM` | `/internal/terminal/reclaim` |
| 任务删除级联关闭 | `DELETE` | `terminal` | terminalId | `SYSTEM` | `/internal/terminal/session-deleted` |

其他约定：
- `status` 填 200，`success=1`；失败时 `success=0` + `errorMessage`（如 PTY 启动失败）。
- `userId` / `username`：REST 与 attach 路径由调用方传入；回收路径从 `RemoteTerminal.userId` 取，`username` 用一次 `userRepo.findById`（失败则留空，不阻塞回收）。
- `ip`：REST 与 attach 路径由调用方传入（`resolveIp(request.headers, request.ip)` 复用现有函数）；`SYSTEM` 路径为空。
- `queryString` 恒为空。**任何情况下不写入终端输入输出内容。**
- 写审计失败只记日志，不影响终端本身（与 `recordAudit` 内部 `try/catch` 吞异常的既有语义一致）。

### 7.8 会话删除时关闭终端

`SessionService` 构造参数末尾追加一个可选回调（与既有 `cleanupRuntimeDir` 同风格）：

```ts
/** 会话删除时关闭其全部云端终端的回调，可选。 */
private readonly closeSessionTerminals?: (sessionId: number) => void,
```

在 `deleteSession` 内 `cleanupRuntimeDir` 调用旁边以同样的 try/catch 包裹调用（关闭失败只记日志，不阻塞删除）。装配处 `create-app.ts` 传 `(sessionId) => terminalManager.closeBySession(sessionId)`。

### 7.9 装配与停机

- `create-app.ts` 中在 `shellManager` 附近构造 `TerminalManager`（依赖：`pathSandbox`、`runtimeResolver`、`gitLookup`、`jwt`、`userRepo`、`auditService`、`terminalCfg`）。
- `shellManager.startCleanup()`（:1609）旁边加 `terminalManager.startCleanup()`。
- `close()` 回调内 `shellManager.stopCleanup()`（:1670）旁边加 `terminalManager.stopCleanup()` + `terminalManager.closeAll()`（进程退出前尽量杀掉 PTY，避免遗留孤儿 bash）。
- 蓝绿部署时旧进程被 kill，`closeAll()` 不一定执行；因此 `RemoteTerminal` 不持有磁盘状态，孤儿 bash 由 PTY 主端关闭时自然收到 SIGHUP 退出。

---

## 8. 前端设计

### 8.1 `stores/auth.ts` 扩权限（照抄 admin 实现）

```ts
interface User {
  id: number
  username: string
  displayName: string
  email: string
  avatarUrl: string
  authSource: 'LOCAL' | 'LDAP' | 'FEISHU' | string
  permissions?: string[]      // 新增，后端 /users/me 已返回
  isAdmin?: boolean           // 新增
}
```

新增 `const permissions = computed(() => user.value?.permissions ?? [])`、`const isAdmin = computed(() => Boolean(user.value?.isAdmin))`、`function hasPermission(code: string)`，并加入 return。

注意：登录接口 `POST /auth/login` 默认不带权限（`auth.service.ts:61-87` 的 `withPerms=false`），但路由守卫（`router/index.ts:127-135`）在无 user 时会调 `fetchUserInfo()` → `GET /users/me`（带 permissions）。为避免登录后首屏 `permissions` 为空导致按钮误禁用，`applyLogin` 之后追加一次 `await fetchUserInfo()`（与 admin 的 `login()` 一致）。

### 8.2 `composables/useTerminalWS.ts`（新增）

单例 WS 管理，参数与 `useStreamWS` 对齐但完全独立：

- URL：`${wsBase}/ws/terminal`，`wsBase` 复用 `useStreamWS.ts:186` 的推导逻辑（`VITE_WS_BASE_URL || VITE_API_BASE_URL.replace(/^http/,'ws').replace(/\/api\/v1$/,'/api')`）。token 不进 URL。
- 模块级状态：`ws` / `connected` / `reconnectDelay`（1s 起 ×2，上限 30s）/ `heartbeatTimer`（30s ping）/ `lastServerMessageAt` + `SERVER_SILENCE_TIMEOUT_MS = 30_000` / `intentionalClose` / `connectPromise`。
- `attachedTerminals: Set<string>`：重连成功后自动对集合内每个 terminalId 重发 `attach`。
- 消息分发：`handlers: Map<terminalId, { onOutput, onExit, onError, onAttached }>`；`registerTerminal(id, handlers)` / `unregisterTerminal(id)`。
- 对外 API：`ensureConnected()` / `attach(id)` / `detach(id)` / `sendInput(id, data)` / `sendResize(id, cols, rows)` / `registerTerminal` / `unregisterTerminal` / `connected`。
- 全部终端 tab 关闭后不主动断连（保持连接，成本低于反复重连）；登出时 `disconnect()`。

### 8.3 `composables/useTerminal.ts` 改造

`TerminalTab` 扩展：

```ts
export interface TerminalTab {
  id: string
  title: string
  cwd: string
  mode: 'local' | 'remote'      // 新增
  sessionId: string | null      // 新增：remote 必填（desktop 侧 Session.id 是 string），local 为 null
}
```

新增导出 `visibleTabs`（computed）：按当前 `activeSession` 过滤——CLOUD 任务只显示 `mode==='remote' && sessionId===当前任务`；LOCAL + Electron 只显示 `mode==='local'`。`instances` Map 不清理，切回任务后 xterm 内容仍在。

`createTerminal` 拆两条分支：
- `createLocalTerminal(cwd?)`：现有实现原样保留（含 `if (!isElectron()) return null`）。
- `createRemoteTerminal(sessionId, cols, rows)`：`POST /sessions/{id}/terminals` → 建 xterm（复用现有 Terminal 构造参数 + `FitAddon` + `WebglAddon` + 新增 `SearchAddon`）→ `terminal.onData` → `terminalWS.sendInput` → `terminal.onResize` → `terminalWS.sendResize` → `registerTerminal(id, { onOutput: d => terminal.write(d), onExit: () => removeTab(id), onError: ... })` → `attach`。
- 对外统一入口 `createTerminal()` 按 `activeSession.executionMode` 分流；cols/rows 不再硬编码，创建前若已有容器则先 `fit()` 取实际值，无容器时用 80×24 兜底（挂载后 `fit()` 会立刻 resize 纠正）。

新增 `restoreRemoteTabs(sessionId)`：`GET /sessions/{id}/terminals` → 后端有、本地无 → 建 tab + attach；本地有、后端无 → `removeTab` + `ElMessage.warning('终端已被回收')`。

`closeTerminal(id)`：local 走 `electronAPI.terminal.kill`；remote 先 `DELETE` 再 `unregisterTerminal` + `removeTab`（DELETE 失败也移除本地 tab，避免僵尸 tab）。

`togglePanel()`：打开时若当前任务无可见 tab → `restoreRemoteTabs()`，仍为空则 `createTerminal()`。

主题切换：现有 `MutationObserver`（`initListeners` 内，:80-113）从 Electron 专属改为通用初始化（本地终端监听与远程终端共用），`if (listenersInitialized || !isElectron()) return`（:81）拆成「主题监听无条件初始化 / Electron IPC 监听仅 Electron 初始化」。

### 8.4 `TopNav.vue` 可用性矩阵

新增 computed：

```ts
const terminalAvailability = computed<{ enabled: boolean; tooltip: string }>(() => {
  const s = sessionStore.activeSession
  if (!s) return { enabled: false, tooltip: '请先打开一个任务' }
  if (s.executionMode === 'CLOUD') {
    if (!authStore.hasPermission('terminal:use')) return { enabled: false, tooltip: '没有终端使用权限' }
    if (!s.workspace) return { enabled: false, tooltip: '任务工作区不可用' }
    return { enabled: true, tooltip: '终端 (Ctrl+`)' }
  }
  // LOCAL：仅 Electron 可用（Web 与安卓 Capacitor 都没有 electronAPI）
  if (!isElectronClient()) return { enabled: false, tooltip: '本地任务的终端仅在桌面客户端可用' }
  return { enabled: true, tooltip: '终端 (Ctrl+`)' }
})
```

模板：`el-tooltip :content="terminalAvailability.tooltip"`；按钮 `:class="{ active: terminalOpen, disabled: !terminalAvailability.enabled }"`；`toggleTerminal()` 首行 `if (!terminalAvailability.enabled) return`。快捷键 `Ctrl+\`` 同样走 `toggleTerminal()`，因此自动继承禁用逻辑。`.terminal-toggle.disabled` 新增样式（`opacity: .4; cursor: not-allowed`）。

`isElectronClient()` 目前定义在 `useStreamWS.ts:165`（`ChatInput.vue:308` 另有一份内联 const，本期不动）。为避免 TopNav 依赖 WS 模块，在 `utils/capacitor.ts` 旁新增 `utils/platform.ts` 导出 `isElectronClient()`，`useStreamWS` 与 `TopNav` 都从这里 import（`useStreamWS` 内的本地定义删除，不保留重复实现）。

### 8.5 `TerminalPanel.vue`

- `tabs` 改用 `visibleTabs`；`handleCreate()` 按 executionMode 分流。
- 新增 `watch(() => sessionStore.activeSessionId)`：任务切换时若面板打开且当前任务是 CLOUD → `restoreRemoteTabs()`；同时把 `activeTabId` 切到该任务的第一个可见 tab（无可见 tab 时置 null，面板显示空状态提示「当前任务没有终端，点击 + 新建」）。
- 新增 `watch(isOpen)`：打开时对 CLOUD 任务先 `restoreRemoteTabs()`。
- 新增搜索栏（`Ctrl+F` 唤出，仅当面板打开且有活跃 tab）：输入框 + 上一个 / 下一个 / 匹配计数 / 关闭；调 `SearchAddon.findNext(term, opts)` / `findPrevious(term, opts)`，`opts = { incremental: true, decorations: { matchOverviewRuler, activeMatchColorOverviewRuler, matchBackground, activeMatchBackground } }`（注意 `ISearchDecorationOptions` 里 `matchOverviewRuler` 与 `activeMatchColorOverviewRuler` 是**必填**字段，缺一个 vue-tsc 会报错）；匹配计数订阅 `onDidChangeResults`。关闭搜索栏时调 `clearDecorations()`。`Esc` 关闭并把焦点还给 xterm。快捷键在面板组件内注册（`keydown` 捕获，仅当 `isOpen` 且事件目标在面板内时拦截，避免全局劫持浏览器 Ctrl+F）。
- 安卓虚拟按键条：`v-if="isAndroidCapacitor()"`，渲染在 `.terminal-container` 下方（固定高度 40px，参与 flex 布局，`overflow-x: auto` 横向滚动）。按键映射：

| 键 | 发送 |
|----|------|
| Esc | `\x1b` |
| Tab | `\t` |
| Ctrl | 粘滞：置位后下一个字母键转为对应控制字符（`a`→`\x01` … `z`→`\x1a`），发送后自动复位；再次点击取消 |
| ↑ / ↓ / ← / → | `\x1b[A` / `\x1b[B` / `\x1b[D` / `\x1b[C` |
| Ctrl+C | `\x03` |
| Ctrl+D | `\x04` |
| 粘贴 | `navigator.clipboard.readText()` → 作为 input 发送；读取失败 toast 提示 |

  所有按键统一调 `getActiveInstance()?.terminal.input(data)`（xterm 的 `input()` 会触发 `onData`），因此 local / remote 自动走各自已注册的写入通道，不需要为按键条单独判断模式。
- 软键盘避让（仅安卓）：监听 `window.visualViewport` 的 `resize` 与 `scroll`，计算 `occluded = window.innerHeight - (visualViewport.height + visualViewport.offsetTop)`（负值归零），给面板根元素设 `margin-bottom: {occluded}px`，随后 `fitTerminal(activeTabId)`。选 `margin-bottom` 而不是 `transform: translateY`：面板是 `Layout.vue` 里 `height: 100vh` flex column 的最后一个子元素，margin 会让主区域同步收缩，而 transform 会在原位留下空洞并可能盖住内容。事件在 `onMounted` 注册、`onUnmounted` 移除；非安卓不注册（`window.visualViewport` 在 Electron / 桌面浏览器也存在，必须用 `isAndroidCapacitor()` 守卫，否则桌面缩放会误触发）。

### 8.6 不动的前端文件

`electron/main.cjs`、`electron/preload.cjs`、`electron/terminalManager.cjs`、`src/types/electron.d.ts`、`TerminalTabs.vue`（模板 / 样式；仅因 `TerminalTab` 类型新增字段而无需改动）、`TaskIndexPanel.vue`（LOCAL 分组入口逻辑不变）。

---

## 9. 实现步骤

### 阶段一：后端 PTY + REST + WS（无 UI 依赖，可独立验证）

1. `backend-ts/package.json` 加 `"node-pty": "1.1.0"`（精确版本，不带 `^`），`npm install` 确认本机编译通过。
2. 新增 `harness/terminal/remote-terminal.ts`（PTY 包装 + 环形缓冲 + idle/lifetime 判定）。
3. 新增 `harness/terminal/terminal-manager.ts`（注册表 + create/close/closeBySession/attach/detach + env 构造 + 默认 rc + startCleanup + 审计回调）。
4. 新增 `harness/terminal/terminal-ws-handler.ts`（首帧 auth + 消息路由 + 背压丢帧）。
5. 新增 `session/terminal.routes.ts`（POST / GET / DELETE + 权限 + 归属 + 上限）。
6. 改 `session/ws/attach-websocket.ts`：在现有 register 之后追加 `app.get('/ws/terminal', ...)`，扩 `AttachWebSocketDeps`。
7. 改 `create-app.ts`：构造 TerminalManager、注册 terminal routes（:1523 之后）、`attachWebSocket` 传 terminalHandler、`startCleanup` / `stopCleanup` / `closeAll` 接线、`SessionService` 传 `closeSessionTerminals` 回调。
8. 改 `session/session.service.ts`：构造参数加可选回调 + `deleteSession` 内调用。
9. 审计：不改 `audit/audit.interceptor.ts`，四类生命周期事件在 TerminalManager 内显式 `AuditLogService.record()`（见 7.7）。
10. 单测：`terminal-manager.spec.ts` + `terminal-ws-handler.spec.ts`（fake pty factory / fake socket，不起真实 PTY）。
11. `cd backend-ts && npm run build && npm test` 全绿。

### 阶段二：设置项与权限迁移 + admin

12. 新增 `backend-ts/db/migration/V100__settings_terminal.sql`（5 个设置项 + `terminal:use` 权限 + 授予 role_id=1）。
13. 改 `settings/types.ts`（`TerminalSettings`）、`settings.service.ts`（key 常量 + `getTerminalConfig()` + 整数校验集合）。
14. 改 `create-app.ts` bootstrap 读取 `getTerminalConfig()` 并传入 TerminalManager。
15. 改 admin：`SystemSettingsView.vue`（`INTEGRATION_KEYS` + `INTEGRATION_TOC`）、`views/settings/components/IntegrationConfigPanel.vue`（新增 `terminal` 组）。
16. `cd backend-ts && npm test`、`cd admin && npm run build` 通过。

### 阶段三：前端远程终端

17. 改 `desktop/src/stores/auth.ts`（permissions / isAdmin / hasPermission + 登录后拉 `/users/me`）。
18. 新增 `desktop/src/utils/platform.ts`（`isElectronClient()`），`useStreamWS.ts` 改为 import 该实现。
19. `desktop/package.json` devDependencies 加 `@xterm/addon-search` `^0.16.0`。
20. 新增 `desktop/src/composables/useTerminalWS.ts`。
21. 改 `desktop/src/composables/useTerminal.ts`（tab 扩字段 + visibleTabs + remote 分支 + restoreRemoteTabs + 主题监听解耦）。
22. 改 `TopNav.vue`（可用性矩阵 + tooltip + disabled 样式）。
23. 改 `TerminalPanel.vue`（visibleTabs + 任务切换 watch + 空状态 + Ctrl+F 搜索栏）。
24. `cd desktop && npm run build`（vue-tsc）通过。

### 阶段四：安卓适配

25. `TerminalPanel.vue` 内新增虚拟按键条组件（`isAndroidCapacitor()` 守卫）+ `style.css` 补 `html.android-capacitor` 下的终端相关样式。
26. visualViewport 软键盘避让 + refit。
27. `cd desktop && npm run build` 通过。

### 阶段五：联调、文档与发版

28. 手工验收（第 10 章全部条目），Web / Electron / 安卓三端各跑一遍。
29. 更新 `CHANGELOG.md` 顶部新增版本条目（`### 后端` / `### 前端（桌面 / Web / 安卓）` / `### 管理后台` 三个小节）。
30. 更新文档：`skills/mao-cli/reference/desktop.md`（新增「云端终端」小节 + 可用性矩阵）、`settings.md`（新增 `terminal.*` 配置说明）、`deploy.md`（服务器依赖补 `python3 make g++`；`/api/ws/terminal` 说明）、`troubleshooting.md`（新增终端排障小节）、`README.md`（功能列表提一句云端终端）。
31. `./scripts/changelog-extract.sh sync-desktop` 同步 desktop 版本号。
32. 提交并推 origin/main（部署与重启由用户在 `/opt/mao` 执行）。

---

## 10. 验收标准

### 10.1 基础功能

1. Web 浏览器 + CLOUD 任务（管理员账号）：点击终端按钮打开远程终端，`pwd` 输出该任务 workspace 绝对路径；`ls` / `vim` / `top` 正常（vim 可编辑保存，top 可刷新，`Ctrl+C` 能中断 `ping`）。
2. `echo $HOME` = `/opt/mao-data/users/{userId}`；`echo $TERM` = `xterm-256color`；`echo $MAO_TOKEN` 非空；`env | grep GIT_TOKEN_` 能看到已配置域名的 token 变量；提示符显示 `[mao {任务名}]`。
3. 终端内 `touch a.txt` 后，Agent 用 shell 工具 `ls` 能看到同一文件（同一 workspace 验证）。
4. Electron + CLOUD 任务：按钮打开**远程**终端（`pwd` 是服务器路径，不是本机路径）。
5. Electron + LOCAL 任务：与现状完全一致（本地终端，cwd = 本机 workspace）。
6. 拖拽面板高度、缩放窗口后终端自适应（xterm fit → resize → PTY `$COLUMNS` 同步变化，`resize` 命令或 `tput cols` 可验证）。
7. 面板 `+` 可在同一任务下开多个终端，tab 间切换内容互不干扰。
8. `Ctrl+F` 唤出搜索栏，输入关键词可在当前终端历史中定位并高亮，上一个 / 下一个可循环，Esc 关闭并恢复输入焦点。

### 10.2 可用性矩阵

9. 无活跃任务：按钮禁用，tooltip「请先打开一个任务」，`Ctrl+\`` 无反应。
10. Web / 安卓 + LOCAL 任务：按钮禁用，tooltip「本地任务的终端仅在桌面客户端可用」。**不再出现空面板**。
11. 用无 `terminal:use` 权限的普通账号登录：CLOUD 任务下按钮禁用，tooltip「没有终端使用权限」；直接调 `POST /v1/sessions/{id}/terminals` 返回 HTTP 403。
12. 用他人 sessionId 调创建接口 → HTTP 403；用他人 terminalId 发 `attach` → 收到 `{type:'error',code:'TERMINAL_FORBIDDEN'}`。

### 10.3 存活与恢复

13. 断网 10 秒后恢复：前端自动重连并 attach 同一 terminalId，断网期间的输出（如 `while true; do date; sleep 1; done`）作为缓冲回放出现，终端可继续输入。
14. 浏览器刷新（F5）：面板重新打开后自动出现原有 tab（来自 `GET /terminals`），attach 后能看到刷新前的输出尾部，`jobs` / 前台进程仍在。
15. 切到另一个 CLOUD 任务：面板只显示新任务的终端 tab；切回原任务，原 tab 与内容仍在。
16. 断线期间 PTY 输出持续被消费：断网 2 分钟内持续 `yes` 输出，恢复后终端仍可响应输入（进程未被输出缓冲卡死）。
17. **后端重启（含蓝绿部署）后所有终端丢失**：刷新页面 `GET /terminals` 返回空列表，前端不残留 tab，无报错弹窗。这是**预期行为**，不视为缺陷。
18. 同一 terminalId 被第二个浏览器标签 attach：旧标签收到 `TERMINAL_TAKEN_OVER` 提示并停止接收输出，新标签正常接管。

### 10.4 生命周期与限额

19. 同一任务创建第 6 个终端：接口返回 `code=2001` + 消息「该任务的终端数量已达上限 5，请先关闭已有终端」，前端 toast。
20. 关闭 tab：PTY 进程消失（服务器 `ps` 验证），再次 `GET /terminals` 不含该 id。
21. 终端内 `exit`：前端收到 `exit` 帧并自动移除 tab。
22. 删除任务：该任务全部 PTY 消失（`ps` 验证），审计表出现对应 `DELETE / terminal / SYSTEM` 记录。
23. 把 `terminal.idleTimeoutMinutes` 临时改小（如 1）并重启后端，空闲超时后 PTY 被回收，前端收到 `TERMINAL_RECLAIMED` 并移除 tab，审计表出现回收记录。
24. 后端 `close()` 路径（正常停机）执行后无遗留 bash 进程。

### 10.5 安卓

25. 安卓 APP（无需重装，刷新即可）+ CLOUD 任务：可打开云端终端并正常输入输出。
26. 虚拟按键条仅安卓可见：Web 与 Electron 下不渲染（DOM 中不存在）。
27. 按键条 Esc / Tab / ↑↓←→ / Ctrl+C / Ctrl+D 行为正确；Ctrl 粘滞键点亮后按 `c` 等价 Ctrl+C 且自动复位；粘贴能把剪贴板内容送入终端。
28. 软键盘弹出后终端可视区不被遮挡（面板上推），收起后恢复原位，两次切换后 xterm 尺寸正确（无错行）。

### 10.6 设置与审计

29. admin 系统设置页出现「云端终端」分组，5 个参数可编辑保存；填非正整数被拒（提示「配置值必须为正整数」）。
30. 审计日志出现终端创建（`CREATE / terminal`）、关闭（`DELETE / terminal`）、attach（`EXECUTE / terminal`）、回收（`DELETE / terminal / SYSTEM`）记录；**审计表内不含任何终端输入输出内容**。
31. 审计表内终端记录的 `object_type` 恒为 `terminal`、`object_id` 为 terminalId（可按终端追溯）；`/v1/sessions/**` 的其他接口审计行为无变化（仍不进审计表）。

### 10.7 构建与回归

32. `cd backend-ts && npm run build && npm test` 全绿（覆盖率不低于现有 70% 阈值）。
33. `cd admin && npm run build`、`cd desktop && npm run build` 通过。
34. Agent 的 shell 工具（`shell_session`）行为无变化：新建会话、执行命令、后台任务、Git 操作均正常。
35. `/api/ws/stream` 的 Agent 流式功能无回归：新建任务、流式回复、工具调用、LOCAL 委托均正常。

---

## 11. 风险与安全

### 11.1 首要风险：`terminal:use` 等于服务器 root shell

**开启 `terminal:use` 等于把服务器的 root shell 交给该用户。** 这不是夸张表述，而是当前部署形态的直接结论：

- 后端进程以 **root** 运行（实测 PID 3307722 owner root，非 Docker、无 systemd 降权）；
- PTY 由后端进程 fork，因此**继承 root**；
- 本方案明确不做路径沙箱、不做命令黑白名单、不做容器 / 系统账号隔离（3.2.1~3.2.4）。

因此持有该权限的用户可以：读写任意用户的工作区与虚拟 HOME、读取 `/opt/mao` 下的配置与日志（含 DB 连接串、JWT secret、各类 API Key）、连接本机 MySQL、修改 nginx 配置、重启或停止 Mao 自身、以及对该服务器执行任何 root 操作。

控制手段只有一条：`terminal:use` 默认只授予 role_id=1（ADMIN）。**授予任何非管理员账号该权限，等同于给对方一个 root SSH 账号。** 管理后台的角色-权限页会列出该权限，运维需明确知晓这一点。

### 11.2 其他风险

| 风险 | 等级 | 现状处理 |
|------|------|---------|
| WS 不限制 Origin，存在跨站发起终端连接的可能（需先拿到有效 token） | 高 | **本期不做限制**（用户明确「先不考虑安全」）。缓解：token 不进 URL、仅首帧传递；后续迭代可加 Origin 白名单 + 一次性 attach ticket |
| node-pty 本机编译失败导致后端起不来（缺 python3 / make / g++ 的新环境） | 中 | 服务器已验证工具链齐备；部署文档补装依赖说明；CI backend job 使用 ubuntu-latest 自带工具链。失败表现为 `npm ci` 阶段报错，不会产生「服务起来但功能坏」的中间态 |
| PTY 进程泄漏（用户开完不关 / 前端崩溃） | 中 | idle 2h + maxLifetime 24h 定时回收 + 每任务 5 / 全局 50 上限 + 任务删除级联关闭 + 正常停机 `closeAll()` |
| 蓝绿部署丢失所有终端，用户正在跑的前台任务被中断 | 中 | 已列为预期行为并写入验收标准；文档提示用户长任务用 `nohup` / 后台方式或交给 Agent 执行 |
| 输出洪流打满 WS / 前端卡死（`cat` 大文件、`yes`） | 中 | 后端 `bufferedAmount` 背压丢帧 + 环形缓冲 256KB 上限；xterm `scrollback` 5000 行封顶 |
| 终端与 Agent 同时写同一 workspace 造成互相干扰（如同时 git 操作） | 中 | 不做锁（用户是同一人，且 Agent 侧已有 deploy-lock 机制）；文档提示避免与运行中的 Agent 并发做 Git 操作 |
| 二进制输出破坏终端显示 | 低 | 输出按 UTF-8 解码，无效字节变替换字符；用户可 `reset` 恢复。不做 base64 通道（3.2.13） |
| 默认 rc 被用户改坏导致新终端异常 | 低 | rc 在虚拟 HOME 下，删掉即自动重建；不做校验 |
| 审计前缀扩到 `/v1/sessions` 导致审计表膨胀 | 低 | 已排除该前缀下的 GET；POST/PUT/DELETE 量级与现有 `/v1/agents` 同级 |
| 多用户同时 attach 同一终端 | 低 | 后端单 attach + 顶替语义，不做共享（3.2.11） |

---

## 12. 落地清单

### 12.1 后端新增

| 文件 | 说明 |
|------|------|
| `backend-ts/src/harness/terminal/remote-terminal.ts` | PTY 包装 + 环形缓冲 + 生命周期判定 |
| `backend-ts/src/harness/terminal/terminal-manager.ts` | 注册表 + 上限 + env 构造 + 默认 rc + 定时回收 + 审计 |
| `backend-ts/src/harness/terminal/terminal-ws-handler.ts` | WS 消息路由 + 首帧 auth + 背压 |
| `backend-ts/src/harness/terminal/terminal-manager.spec.ts` | 单测 |
| `backend-ts/src/harness/terminal/terminal-ws-handler.spec.ts` | 单测 |
| `backend-ts/src/session/terminal.routes.ts` | REST POST / GET / DELETE |
| `backend-ts/db/migration/V100__settings_terminal.sql` | 5 个设置项 + `terminal:use` 权限 + 授予 ADMIN |

### 12.2 后端修改

| 文件 | 改动 |
|------|------|
| `backend-ts/package.json` | 加 `node-pty: 1.1.0`（精确版本） |
| `backend-ts/src/session/ws/attach-websocket.ts` | register 之后追加 `app.get('/ws/terminal')`；扩 Deps |
| `backend-ts/src/create-app.ts` | 构造 TerminalManager、bootstrap 读 `getTerminalConfig()`、注册 terminal routes、attachWebSocket 传 handler、startCleanup/stopCleanup/closeAll、SessionService 传 closeSessionTerminals |
| `backend-ts/src/session/session.service.ts` | 构造参数加可选回调 + `deleteSession` 内调用 |
| `backend-ts/src/settings/types.ts` | 新增 `TerminalSettings` |
| `backend-ts/src/settings/settings.service.ts` | key 常量 + `getTerminalConfig()` + 正整数校验集合 |

### 12.3 管理后台修改

| 文件 | 改动 |
|------|------|
| `admin/src/views/settings/SystemSettingsView.vue` | `INTEGRATION_KEYS` 加 5 个 key；`INTEGRATION_TOC` 加「云端终端」锚点 |
| `admin/src/views/settings/components/IntegrationConfigPanel.vue` | `groups` 新增 `terminal` 组（5 个 number 字段） |

### 12.4 前端新增

| 文件 | 说明 |
|------|------|
| `desktop/src/composables/useTerminalWS.ts` | 独立 WS 单例 + 多路复用 + 重连 + 心跳 |
| `desktop/src/utils/platform.ts` | `isElectronClient()`（从 useStreamWS 抽出） |

### 12.5 前端修改

| 文件 | 改动 |
|------|------|
| `desktop/package.json` | devDependencies 加 `@xterm/addon-search ^0.16.0` |
| `desktop/src/stores/auth.ts` | User 加 permissions/isAdmin；加 permissions/isAdmin computed + hasPermission；登录后拉 `/users/me` |
| `desktop/src/composables/useTerminal.ts` | tab 加 mode/sessionId；visibleTabs；remote 分支；restoreRemoteTabs；SearchAddon；主题监听解耦 |
| `desktop/src/composables/useStreamWS.ts` | 删除本地 `isElectronClient`，改 import `utils/platform` |
| `desktop/src/components/common/TopNav.vue` | 可用性矩阵 computed + tooltip + disabled 样式 + toggleTerminal 守卫 |
| `desktop/src/components/terminal/TerminalPanel.vue` | visibleTabs；任务切换 / 打开时恢复 tab；空状态；Ctrl+F 搜索栏；安卓按键条；visualViewport 避让 |
| `desktop/src/style.css` | `html.android-capacitor` 下终端按键条与面板样式；`.terminal-toggle.disabled` |

### 12.6 明确不动

`desktop/electron/*`（main / preload / terminalManager / localShell）、`desktop/src/types/electron.d.ts`、`desktop/src/components/terminal/TerminalTabs.vue`、`desktop/src/components/task/TaskIndexPanel.vue`、`backend-ts/src/harness/shell/*`、`backend-ts/src/session/ws/streaming-ws-handler.ts`、`streaming-ws-registry.ts`、`android/**`（含 MainActivity / capacitor.config / AndroidManifest）、nginx 配置、`agent-cli/**`。

### 12.7 新增配置项

| key | 默认 | category | 生效 |
|-----|------|----------|------|
| `terminal.maxSessionsPerTask` | 5 | 运行参数 | 重启后端 |
| `terminal.maxSessionsGlobal` | 50 | 运行参数 | 重启后端 |
| `terminal.idleTimeoutMinutes` | 120 | 运行参数 | 重启后端 |
| `terminal.maxLifetimeHours` | 24 | 运行参数 | 重启后端 |
| `terminal.outputBufferBytes` | 262144 | 运行参数 | 重启后端 |

### 12.8 新增接口

- REST：`POST` / `GET` `/api/v1/sessions/{sessionId}/terminals`、`DELETE /api/v1/sessions/{sessionId}/terminals/{terminalId}`
- WS：`/api/ws/terminal`（首帧 auth，多路复用）

### 12.9 新增权限

- `terminal:use`（使用云端终端），默认仅 role_id=1（ADMIN）

### 12.10 依赖变更

| 位置 | 变更 |
|------|------|
| backend-ts dependencies | `+ node-pty 1.1.0`（本机 node-gyp 编译，需 python3 / make / g++） |
| desktop devDependencies | `+ @xterm/addon-search ^0.16.0` |

### 12.11 文档同步（与代码同任务提交）

| 文件 | 内容 |
|------|------|
| `CHANGELOG.md` | 顶部新增版本，含 `### 后端` / `### 前端（桌面 / Web / 安卓）` / `### 管理后台` |
| `skills/mao-cli/reference/desktop.md` | 新增「云端终端」小节：可用性矩阵、权限要求、断线重连语义、后端重启会丢终端、安卓按键条 |
| `skills/mao-cli/reference/settings.md` | 新增 `terminal.*` 五项说明（启动时构建，需重启） |
| `skills/mao-cli/reference/deploy.md` | 服务器依赖补 `python3 make g++`（node-pty 编译）；说明 `/api/ws/terminal` 复用现有 `location /api/ws/` |
| `skills/mao-cli/reference/troubleshooting.md` | 新增终端排障：按钮禁用原因对照、终端打不开、重启后终端消失、安卓键盘遮挡 |
| `README.md` | 功能列表补一句云端终端（含权限门槛提示） |

---

## 13. 后续迭代（本期不做，仅登记）

1. tmux / 终端守护进程托管，实现跨后端重启恢复。
2. 终端输出手动发送给 Agent（选中片段 → 作为消息附加）。
3. 把 Agent 的 shell 工具从管道模式迁到 PTY，统一两套实现。
4. admin 端终端管理页：查看全部活跃终端、强制关闭、按用户统计。
5. 安全加固：WS Origin 白名单、一次性 attach ticket、路径沙箱、命令审计落盘（可开关）。
6. 真正的隔离方案：每用户容器 / 系统账号 + 资源配额，使普通用户也能安全使用。
7. 多用户共享终端（结对排障 / 观战模式）。
8. 终端外观设置项（字体、字号、主题、scrollback 行数）与分屏。



