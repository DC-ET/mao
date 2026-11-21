# Playwright 技能浏览器直播（画中画）技术方案（v2 重新评估）

- 日期：2026-11-21（v2 重新评估；v1 见 git 历史）
- 状态：已评审，随本方案实施
- 一句话：内置技能 `browser-use`（`skills/bundled/browser-use/`）保持 playwright-cli 的命令行用法完全不变，由 wrapper 透明注入 CDP 调试端口并拉起零依赖 sidecar 采集画面帧，桌面客户端以画中画窗口 + 可放大的 CenterTab 实时旁观，LOCAL / CLOUD 双模式支持。
- 关联：`docs/plan/2026-11/2026-11-20-builtin-skills-technical-design.md`（内置技能机制，已落地 commit 74b4f000）

## 0. v1 → v2 重新评估的背景

v1（2026-11-20，已搁置）的核心形态是：常驻 runner 持有浏览器，agent 抛弃 shell 脚本习惯、改写 `connectOverCDP` 脚本接入 runner。

v2 评估时两个前提已变化：

1. **内置技能机制已落地**。新技能放 `skills/bundled/browser-use/`（frontmatter `name: browser-use`）即随发版进入系统 Skills，管理员在 Agent 上勾选即可用。技能分发、视图挂载、会话软链路径全部复用现有机制，本方案不新增技能通道。
2. **实际技能形态是 CLI 工作流**。v1 假设 agent「编写并执行 playwright 脚本」，但实际要封装的技能包（基于 `@playwright/cli`）是 `open / snapshot / click e15 / fill / screenshot` 一类的 ref 驱动 CLI 命令流，浏览器由 playwright-cli 的 daemon 跨命令持有，登录态、页面状态天然延续。v1 要解决的「短命进程浏览器销毁」问题在 CLI 形态下不存在。

因此 v1 的 runner 持有浏览器方案**整体废弃**：它要求 agent 先启 runner、再写 CDP 接入脚本，与「跟直接使用 playwright 技能一样丝滑、不引入使用习惯变化」的要求相反。

v2 的核心思路：**浏览器所有权不动，旁路加一只「摄像头」**。CLI 照常 `launch` 浏览器，我们只通过 CLI 的 `--config` 注入 `--remote-debugging-port`，让一个零依赖 sidecar 进程能以 CDP 旁路接入同一个浏览器做 `Page.startScreencast`。agent 的命令、参数、语义与原 playwright 技能完全一致。

### 0.1 技术前提（2026-11-21 本机 POC 实测，Chrome 158 / @playwright/cli 0.1.25 / Node 22.22）

| # | 验证项 | 结论 |
|---|--------|------|
| P1 | CLI `open --config=<注入 --remote-debugging-port=N 的配置>` | ✅ 端口注入生效，`--remote-debugging-port` 与 playwright 自身的 `--remote-debugging-pipe` 共存，`http://127.0.0.1:N/json/version` 可达 |
| P2 | Node 22 内置 WebSocket 直连 CDP 做 `Page.startScreencast`（flatten attach） | ✅ 采到 1280×720 JPEG（example.com 约 40KB/帧）；须逐帧 `screencastFrameAck`，否则不再出帧 |
| P3 | mao shell 的进程组击杀（`close()` → `process.kill(-pid, 'SIGKILL')`）下 playwright-cli daemon 是否存活 | ✅ 存活。daemon 与 Chrome 由 CLI 以独立进程组 spawn（实测 pgid 自成一组），整组击杀杀不到它，CDP 端口继续可用 |
| P4 | sidecar 用 Node `spawn(detached: true)` 启动（经 wrapper） | ✅ 逃逸进程组击杀存活；对照组：同组内 `nohup ... &` 的进程被整组击杀 |
| P5 | CLI `close` 后浏览器与 CDP 端口 | ✅ Chrome 退出、端口关闭（有 1~2 秒退出延迟，sidecar 判死需连续探测确认） |

### 0.2 mao shell 关键事实（决定 sidecar 的启动方式）

`ShellSessionManager`（`backend-ts/src/harness/shell/shell-session-manager.ts:751-757`）spawn 持久 bash 且 `detached: true`（独立进程组）；命令完成且默认 `keep_session=false` 时 `close()` 以 **`process.kill(-pid, 'SIGKILL')` 杀整个进程组**（`shell-session-manager.ts:263-283`；LOCAL `localShell.cjs:337-358` 同构，Windows 用 `taskkill /T /F`）。因此：

- `nohup xxx &` 拉起的 sidecar 会被整组击杀，**不可用**；
- wrapper 必须经 `node -e "spawn(..., {detached:true, stdio:'ignore'}).unref()"` 让 sidecar 自成进程组（Node 是本技能既有前置，无新依赖）。

## 1. 名词约定

- **playwright-cli / CLI**：`@playwright/cli` 提供的 `playwright-cli` 命令，agent 经 shell 工具调用；其内置 daemon 跨命令持有浏览器与多命名会话。
- **wrapper**：技能自带的 `scripts/browser_cli.sh`（agent 以 `export PWCLI=<技能目录>/scripts/browser_cli.sh` 使用），行为与原 playwright 技能 wrapper 一致，仅追加「注端口 + 拉 sidecar」两件事。
- **sidecar（browser-live-host）**：技能自带的 `scripts/browser-live-host.mjs`，零 npm 依赖的 Node 脚本（Node 22 内置 WebSocket）。旁路接入 CLI 浏览器的 CDP 端口做 screencast，把帧送出（LOCAL 直连桌面 / CLOUD 经后端）。
- **PiP 窗口**：桌面端 frameless + `alwaysOnTop` 小 BrowserWindow，渲染帧流。
- **直播 Tab**：主窗口 CenterTab 内嵌的同一直播视图组件（对齐文件预览的打开方式），由画中画双击放大而来，可一键还原回画中画。
- **帧事件**：`browser_live_started` / `browser_frame` / `browser_live_stopped`，非工具结果，不进消息体。

## 2. 目标与非目标

### 2.1 目标

1. agent 使用 `browser-use` 技能与使用原 playwright 技能**命令完全一致**（`open/snapshot/click/fill/...`），SKILL.md 不引入新的操作协议，不要求启 runner、不要求改写脚本。
2. agent 操作浏览器期间，桌面客户端用户可实时旁观：默认画中画小窗（置顶、可拖动、位置记忆），**双击放大**为页面内 Tab（对齐文件预览），Tab 内可还原回画中画。
3. LOCAL 与 CLOUD 双模式支持；Web / 安卓端行为不受影响（未知事件忽略，帧不下发安卓）。
4. 生命周期自动收口：任务结束 / 用户停止 / 超时 / 浏览器退出 → 收窗 + 无孤儿 Chrome。
5. 不影响客户端现有功能：不加内置工具、不改 shell 工具语义、PiP 是新增独立窗口。

### 2.2 非目标

- 不做用户接管 / 交互（观看为主，用户要干预直接对 agent 说）。
- 不做多会话多窗格：单一直播视图跟随最新画面，头部显示当前页面 URL 与 CLI 会话名；多命名浏览器会话的帧都采集，展示取最近活跃。
- 不做整机屏幕采集（`desktopCapturer` / TCC 权限一律不碰）；仅采集 CLI 拉起的浏览器页面。
- 不做 VNC / xvfb；CDP screencast 已覆盖。
- 不改 shell 工具、deny-list、审批、path-sandbox 的任何口径（sidecar 启动就是 wrapper 内的一条普通 shell 动作，随命令过既有审批）。
- 观看端矩阵（2026-11-21 收口）：electron（画中画 / Tab）+ browser（Web Tab）+ android（Capacitor WebView 内与 Web 完全同构的 Tab 观看——后端仅把 `BROWSER_LIVE_CLIENT_TYPES` 加入 `'android'`，前端零改动；帧 6fps token bucket，展示端只画最新帧）。Web 入口同日补齐：TopNav「浏览器直播」按钮（`hasAnyLive` 门控）+ store 注入式停止通道（`setStopRequester` → `browser_live_stop` WS 帧）。安卓原生系统级画中画（`enterPictureInPictureMode` + Capacitor 插件桥）不做，另行立项。
- LOCAL Windows：已支持（shell 是 PowerShell，无 bash——技能入口为 `scripts/browser_cli.mjs`，观看链路本方案不动；方案与边界见 `2026-11-21-browser-use-windows-local-technical-design.md`）。

## 3. 技术选型与决策点

### D1（沿用 v1）采集方式：CDP Screencast

参数：每页 `Page.startScreencast`（JPEG quality 60，`maxWidth/maxHeight 1280×720`），sidecar 侧按页限速 ≤4fps + 消费端只画最新帧；空闲页面零帧；动画页峰值约 100–300KB/帧。逐帧 `screencastFrameAck`（POC P2 确认必须 ack）。多页全部采集，帧带 `pageUrl`，展示层取最近活跃页。

### D2（v2 重定义）浏览器所有权：CLI 持有，sidecar 旁路接入

- v1「runner 持有浏览器 + agent 脚本 connectOverCDP」废弃（§0）。
- v2：浏览器仍由 playwright-cli daemon `open` 启动（headless 为默认，用本机 Chrome channel），生命周期语义（`close` / `close-all` / `kill-all` / 1h headless 空闲退出）与原技能完全一致。
- sidecar 不拥有任何进程，只通过 CDP `Browser/Page` 域读画面；它可执行 `Browser.close`（「停止浏览器」按钮的实现路径，能杀掉 CLI 拉起的 Chrome）。
- 命名会话 `-s=foo`：wrapper 为每个 CLI 会话名独立注端口，sidecar 全部接入；多会话并行时帧以 `cliSession` 标记。

### D3（v2 重定义）sidecar 启动：wrapper 透明拉起，detached 逃逸进程组

- agent 第一条 CLI 命令（通常 `open`）时，wrapper 先确保 sidecar 在跑：检查 `<运行时>/.mao-browser/host.pid`，不在则用 `node spawn(detached)` 拉起（§0.2）。对 agent 不可见、无新增命令。
- wrapper 再为本次 CLI 会话名挑选空闲 CDP 端口，写 `<运行时>/.mao-browser/cdp/<cliSession>.port`，并生成 `<运行时>/.mao-browser/config/<cliSession>.json`（模板 + 端口 + root 时 `--no-sandbox`）。
- wrapper 对 `open` / `attach` 追加 `--config=<生成的配置>`，其余子命令原样透传。agent 传了自定义 `--config` 时尊重之（该次无直播，可接受，SKILL.md 说明勿传）。
- 运行时根定位：技能经会话软链挂载，wrapper 由 `BASH_SOURCE` 上跳两级得会话运行时目录（CLOUD `<runtimeRoot>/<uid>/<sid>/`；LOCAL `~/.mao/runtime/<hostKey>/<sid>/`），`.mao-browser/` 放其下——两模式都在会话 runtime 内，沙箱允许写（skill-sync 已 `addAllowedRoot(runtimeDir)`），且随会话目录生命周期清理。

### D4（沿用 v1）桌面画中画窗口

- `desktop/electron/pipWindow.cjs`：`frame:false`、`alwaysOnTop`、默认 360×240、可拖动（头部 `-webkit-app-region: drag`）、位置/尺寸记忆进 `desktopPrefs`（新增 `pipWindow` 字段，按屏幕工作区校验，超界回默认位——v1 决策记录 4）。
- 窗口加载 `${serverBase}/#/pip`（生产主窗本就 loadURL 服务器 SPA；dev 为 `http://localhost:5201/#/pip`），与主窗共享 partition（localStorage 同源，auth 直接可用，路由 guard 不需 public）。
- 渲染：canvas 2D `drawImage`，仅保留最新帧（seq 乱序/积压直接丢）；头部信息条（页面 URL + CLI 会话名）+「停止浏览器」按钮 + 关闭（×=仅停止观看）。图标按钮一律带 `aria-label`/`title`。
- 关窗不触发退出：PiP close 事件只 hide，需规避 `window-all-closed` 非 darwin 退出语义（PiP 关闭时若主窗尚存不退出；主窗关闭到托盘的既有语义不变）。

### D5（沿用 v1，细化）生命周期

| 事件 | 行为 |
|------|------|
| sidecar 首帧 | `browser_live_started`（sessionId、宽高）→ 桌面弹 PiP 窗 |
| CLI `close` / 浏览器退出 | sidecar 连续探测 CDP 死亡（1s×3 次）→ 清 port 文件 → `browser_live_stopped{reason:'browser_exit'}` → 退出；桌面收窗 |
| 会话终态 | 后端（CLOUD）/ Electron（LOCAL）向 sidecar 发停止 → sidecar `Browser.close` 杀浏览器 → 退出；宽限 5s 后兜底断连 |
| 用户「停止浏览器」 | LOCAL：Electron 主进程经 sidecar 本地 WS 发 stop；CLOUD：renderer 走 `browser_live_stop` WS 帧经后端转发 → sidecar `Browser.close` |
| 用户关 PiP / 切 Tab | 仅停止观看，浏览器与任务继续 |
| 兜底 | sidecar 硬上限 2h 自杀；从未连上任何 CDP 端口 10min 退出；心跳缺失由消费端超时收窗 |

### D6（沿用 v1）安全与边界

- 帧只发给会话属主；CLOUD 后端校验 runner token（shell JWT）与会话归属后才转发，且不下发安卓连接（electron/browser 客户端可收）。
- 采集范围仅 CLI 拉起的浏览器实例页面；不涉及系统屏幕；不触发 macOS 录制权限。
- 页面内容（登录态、敏感表单）直播给属主本人，属产品语义；SKILL.md 明示「浏览器直播期间页面内容对用户可见」。
- sidecar 是普通 Node 进程：无新特权；wrapper 修改仅追加 config 与拉起动作，仍随每条 shell 命令过既有审批口径。

### D7（v2 修订）依赖分发

- **CLOUD**：预装 `google-chrome-stable` 与全局 `@playwright/cli`（wrapper 命中 PATH 零拉取）；docker 模式在 `scripts/build-runtime-image.sh` 追加两者。缺依赖时 CLI/Chrome 的报错原样可见，部署文档写明预装项。
- **LOCAL**：macOS/Linux 用系统 Chrome（`channel: chrome`）；CLI 未装时 wrapper 经 `npx --yes --package @playwright/cli@latest` 拉取（既有行为）；Node 必须存在（npx 前置检查沿用原 SKILL.md）。直播采集额外要求 Node ≥ 22（全局 WebSocket 直连 CDP）：wrapper 启动 sidecar 前探测 `typeof WebSocket === 'function'`，缺失时直播降级关闭、CLI 照常工作（不阻塞自动化）。
- 不打包浏览器二进制、不在技能目录 `npm install`（技能视图会整目录拷贝，bundled README 已禁 node_modules）。

### D8（v2 废弃 v1 结论）runner 启动方

v1「agent 经 shell 后台启动 runner」与「平台自动拉起」两个选项都废弃：v2 的 sidecar 由 **wrapper 在 CLI 命令内透明拉起**——它不是 agent 可见的一条独立命令，也不是平台魔法行为，而是技能脚本自身的一部分；失败时 CLI 输出与 sidecar 日志都落在 `.mao-browser/` 下可排查。

### D9（沿用 v1，调整）CLOUD 帧通道：复用 /api/ws/stream

- sidecar 以**独立握手帧** `runner_auth` 接入既有 `/api/ws/stream`（不占用 `auth` 帧、不进 `WsClientType` 词表、不注册进用户连接表）——避免 `Record<WsClientType,...>` 穷尽表与管理后台统计被波及。
- 后端校验：token 为 shell JWT（`type:'shell'`，sub=userId）+ 会话存在 + `session.userId === sub` + `executionMode === 'CLOUD'`；每会话至多一条 runner 连接，重复接入踢旧。
- 帧转发走 registry 新 `sendToClientTypes(userId, event, ['electron','browser'])`：普通队列（可丢）、排除安卓。`browser_live_started/stopped` 走关键队列（低频、丢失会卡窗态）。
- 后端 per-session 令牌桶限速（默认 6fps、突发 12 帧），超限丢弃计数；单帧 >512KB 丢弃。
- 实测拥塞再评估拆分端点（v1 结论不变）。

### D10（v2 新增）渲染面与状态枢纽

- Electron 主进程 `browserLive.cjs` 是帧枢纽：LOCAL 从 sidecar SSE 收帧；CLOUD 由 renderer 的 useStreamWS 收到帧后经 IPC 回灌主进程。主进程统一扇出给 PiP 窗口与主窗 renderer（各 renderer 内 Pinia `browserLiveStore` 只吃 IPC 一路，CLOUD 在 electron 下 useStreamWS 仅回灌不自吃，避免双份）。
- 非 Electron（Web / 安卓 WebView）下 useStreamWS 直吃 WS 帧喂 store——Tab 观看在三端自然同构（入口与安卓帧下发已于 2026-11-21 补齐，见 §2 / §7 M1.5）。
- 双击 PiP → IPC → 主进程 hide PiP → 通知主窗 `openBrowserLiveTab()`；Tab 内「还原画中画」→ 反向。

## 4. 协议设计

### 4.1 事件（进入 `@mao/contracts` ws.ts；后端 → 桌面）

```jsonc
// 首帧前
{ "type": "browser_live_started", "sessionId": 123, "data": { "width": 1280, "height": 720, "pageUrl": "https://…", "cliSession": "default" } }
// 帧流（≤4fps/页，单帧 ≤512KB，后端超限丢弃）
{ "type": "browser_frame", "sessionId": 123, "data": { "seq": 42, "ts": 1732060000000,
  "jpeg": "<base64>", "width": 1280, "height": 720, "pageUrl": "https://…", "cliSession": "default" } }
// 收窗
{ "type": "browser_live_stopped", "sessionId": 123, "data": { "reason": "browser_exit|session_end|user_stop|timeout|runner_exit" } }
```

### 4.2 runner 接入（sidecar → 后端，复用 /api/ws/stream）

- 握手：连接后首发 `{ "type": "runner_auth", "token": "<shell JWT>", "sessionId": 123 }`；成功回 `{type:'connected', data:{runner:true}}`，失败 1003 关闭。
- 入站帧：`{type:'browser_frame', data}` / `{type:'browser_live_started', data}` / `{type:'browser_live_stopped', data}`；后端限速后转发。
- 下行：`{type:'browser_live_stop'}`（用户停止或会话终态）→ sidecar `Browser.close` → 发 `browser_live_stopped` → 断开退出。
- runner 连接不注册进用户连接表：独立 `runnerSessions Map<sessionId, socket>`，不参与 `send()` 广播、设备在线快照与统计。

### 4.3 LOCAL 本地出口（sidecar → Electron 主进程）

- 选 SSE 而非 WS 的原因：sidecar 内的 CDP 客户端已经依赖 Node 22 全局 WebSocket（缺失时整个直播降级关闭），而 Electron 主进程的 Node 版本随打包而定、不保证有全局 WebSocket——SSE 服务端是纯 `node:http`，主进程消费端用 `http.get` 逐行解析，两段都零依赖、无版本赌博。
- sidecar 起 `http://127.0.0.1:<port>`（随机空闲端口）：`GET /live?token=` 返回 `text/event-stream`，事件名即 `browser_live_started / browser_frame / browser_live_stopped`；`POST /stop?token=` 触发停止。token（启动时生成 32 hex）与端口写 `<运行时>/.mao-browser/live.json`（0600）；Electron 主进程按 `~/.mao/runtime/<hostKey>/<sid>/.mao-browser/live.json` 发现并连接。
- 事件数据形状与 4.1 一致；断线由主进程侧重连（SSE 客户端手写重连循环）。

## 5. 改动面清单

| 端 | 路径 | 改动 |
|----|------|------|
| 技能 | `skills/bundled/browser-use/SKILL.md` | 基于 playwright 技能包改写：PWCLI 指向新 wrapper；直播语义与清理约定；页面内容可见声明 |
| 技能 | `skills/bundled/browser-use/scripts/browser_cli.sh` | wrapper：定位运行时根、确保 sidecar、按 CLI 会话名挑端口生成 config、`open/attach` 追加 `--config`、root 注入 `--no-sandbox` |
| 技能 | `skills/bundled/browser-use/scripts/browser-live-host.mjs` | 零依赖 sidecar：CDP 接入 + screencast 泵 + 出口（local WS server / cloud WS client）+ 生命周期 |
| 技能 | `skills/bundled/browser-use/scripts/cli.config.json` | 模板（channel chrome） |
| 技能 | `skills/bundled/browser-use/references/*.md` | 沿用 playwright 技能包文档，改 wrapper 指向与本环境口径 |
| 契约 | `shared/contracts/src/ws.ts` | `BrowserLiveStartedData / BrowserFrameData / BrowserLiveStoppedData` + runner 帧类型 |
| 后端 | `backend-ts/src/session/ws/streaming-ws-handler.ts` | `runner_auth` 分支（shell JWT + 属主 + CLOUD 校验、踢旧）、runner 入站转发、`browser_live_stop` 下行、会话终态通知 runner |
| 后端 | `backend-ts/src/session/ws/streaming-ws-registry.ts` | `sendToClientTypes(userId, event, types)`（普通队列，排除安卓） |
| 后端 | `backend-ts/src/session/ws/ws-rate-limiter.ts`（新） | per-session 令牌桶 + 单测 |
| 桌面 Electron | `desktop/electron/pipWindow.cjs`（新） | PiP 窗口模块 + 位置记忆 |
| 桌面 Electron | `desktop/electron/browserLive.cjs`（新） | 帧枢纽：LOCAL sidecar 客户端 + live.json 发现 + CLOUD 回灌 + 扇出 + 停止 |
| 桌面 Electron | `desktop/electron/desktopPrefs.cjs` / `preload.cjs` / `main.cjs` | `pipWindow` 偏好字段；`browserLive` IPC 命名空间；接线 |
| 桌面 renderer | `desktop/src/stores/browserLive.ts`（新） | 各 renderer 的直播状态（帧、页 URL、live/stopped、当前 sessionId） |
| 桌面 renderer | `desktop/src/components/browser/BrowserLiveView.vue`（新） | 直播视图（canvas + 信息条 + 停止/还原按钮），PiP 与 Tab 复用 |
| 桌面 renderer | `desktop/src/views/PipBrowserLiveView.vue` + router `/pip` | PiP 窗口页（双击放大 → IPC） |
| 桌面 renderer | `useCenterTabs.ts` / `types/file-browser.ts` / `CenterTabContainer.vue` / `CenterTabBar.vue` | Tab type `browser_live` + `openBrowserLiveTab()` + 渲染分支 + 图标 |
| 桌面 renderer | `useStreamWS.ts` | 3 个事件 case：electron 下回灌主进程，Web 下喂 store |
| 桌面 renderer | `types/electron.d.ts` | `browserLive` API 声明 |
| 文档 | `skills/mao-cli/reference/deploy.md`、`DEPLOY.md` | CLOUD 预装 chrome + @playwright/cli；docker 镜像说明 |
| 文档 | `skills/bundled/README.md` | browser-use 已落地 |
| 文档 | `changelog/unreleased/2026-11-21-browser-use-live-pip.md` | 后端 / 前端（桌面）/ 桌面 Electron |

不改 Flyway；不加内置工具（`no-progress-notice` / `toolDisplay` 无涉）；不改 Agent 保存接口与技能挂载机制。

## 6. 测试

- 后端（`cd backend-ts && npm test`，新增 spec）：runner_auth 校验矩阵（token 非法 / 非 shell 类型 / 非属主 / 非 CLOUD / 重复接入踢旧）；帧转发只达属主且排除安卓；限速丢帧与单帧超限；会话终态下行 stop + runner 断开合成 `browser_live_stopped`；`sendToClientTypes` 过滤。
- 桌面主进程（`node --test electron/*.test.cjs`）：browserLive hub 状态机（fake ws：发现 live.json → 连接 → 帧扇出 → stop → 清理）、pipWindow 位置记忆按工作区校验。
- 桌面 renderer（vitest，沿 compile-SFC 模式）：BrowserLiveView 帧渲染 / 乱序丢弃 / 按钮 aria-label；browserLive store 单测。
- 技能：`bash -n` wrapper、`node --check` sidecar；本机 smoke（真实 Chrome 走完 open→帧→close 全流程，POC 脚本复用）。
- E2E 不新增（CI 不跑 Playwright）；手工验收清单：LOCAL 双击放大 / 还原、CLOUD 真跑「打开 GitHub 搜索仓库」、会话取消收窗无孤儿 Chrome。

## 7. 分期

- **M1（本方案一次性落地）**：技能 + sidecar + 后端 runner 通道 + PiP 窗口 + Tab 放大 + 生命周期。LOCAL / CLOUD 同批（生产桌面用户以 CLOUD 为主，只做 LOCAL 等于不可见）。
- **M1.5（2026-11-21 追加，随 M1 分支落地）**：Web 端观看入口——TopNav「浏览器直播」按钮 + Web 停止通道；同日安卓 Tab 观看——后端 `BROWSER_LIVE_CLIENT_TYPES` 加入 `'android'`，前端零改动（§2 边界已更新），提前消化 M2 中的「Web 端观看验收」。
- **M2（打磨，另行立项）**：多 CLI 会话切换、帧率/分辨率自适应、PiP「跳转会话」、页面切换动画优化。

## 8. 与内置 page_* 工具链路的关系

互不影响：`page_*` 走 EmbedPageToolRegistry，画面天然在用户眼前；本方案只服务 `browser-use` 技能的 shell CLI 链路。二者不共享浏览器实例，SKILL.md 不引导混用。

## 9. 决策沿革（v1 → v2）

| # | v1 结论 | v2 结论 | 原因 |
|---|---------|---------|------|
| D1 | CDP Screencast | **沿用** | POC P1/P2 通过，headless 可采、按重绘出帧 |
| D2 | 常驻 runner 持有浏览器 | **废弃**：CLI 持有 + sidecar 旁路 | CLI 形态下浏览器已由 daemon 持有；runner 方案要求 agent 改写接入脚本，违背「丝滑」要求（§0） |
| D3 | LOCAL runner WS server / CLOUD runner→后端 | **沿用分路**，出口从 runner 换成 sidecar | 同 D2 |
| D4 | frameless PiP BrowserWindow | **沿用**，新增双击放大为 CenterTab | 新需求 |
| D5 | 生命周期联动 | **沿用**，细化 sidecar 判死与兜底 | POC P5 确认 close 有退出延迟 |
| D6 | 安全边界 | **沿用**，帧排除安卓 | 带宽保护 |
| D7 | 服务端预装 playwright-core + 系统 Chrome | **修订**：预装 `@playwright/cli`（CLI 本体）+ Chrome；docker 镜像同步 | 技能形态从脚本变为 CLI |
| D8 | agent 按 SKILL.md 启动 runner | **废弃**：wrapper 透明拉起 sidecar | 同 D2；「平台自动拉起」与「agent 显式启动」之外的第三条路 |
| D9 | 复用 /api/ws/stream，clientType=runner | **沿用复用**，改为独立 runner_auth 握手帧，不进 WsClientType 词表 | 避免穷尽表与管理统计波及 |
| — | — | **新增 D10**：主进程帧枢纽 + Pinia store + Tab/PiP 双渲染面 | 双击放大需求 |
