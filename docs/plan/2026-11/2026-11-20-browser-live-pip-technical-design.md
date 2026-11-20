# Playwright 技能浏览器直播（画中画）技术方案

- 日期：2026-11-20
- 状态：搁置（2026-11-20。原方向曾确认：CDP Screencast + 画中画窗口 + D7/D8/D9 三项拍板，见 §3；§9 留存当时决策。等系统预置 Skills 规划并落地后，再回头重新规划本方案；下文仅作搁置前记录，不作为实施依据）
- 关联代码：`backend-ts/src/harness/skill/`、`backend-ts/src/harness/tool/impl/shell-session-tool.ts`、`backend-ts/src/session/ws/streaming-ws-handler.ts`、`desktop/electron/main.cjs`、`desktop/src/composables/useStreamWS.ts`

## 0. 名词约定

- **playwright 技能**：用户所指场景——agent 通过 shell 工具编写并执行 playwright 脚本操作浏览器（区别于内置 `page_*` 嵌入页面工具链路）。
- **runner（本方案核心新增）**：随技能目录分发的常驻 Node 脚本，负责持有浏览器实例、采集画面帧、上报生命周期；agent 的 playwright 脚本不再各自 `launch`，而是 `connectOverCDP` 接到 runner 持有的浏览器。
- **画中画窗口（PiP 窗口）**：桌面端一个 frameless + `alwaysOnTop` 的小 BrowserWindow，渲染帧流，用户可边做别的事边旁观 agent 操作浏览器。
- **帧事件**：`browser_frame` 等 WS 事件类型（§5），非工具结果，不进消息体。

## 1. 需求背景

### 1.1 现状

playwright 技能本质是 agent 经 shell 工具跑脚本，浏览器画面目前对用户完全不可见：

- **LOCAL**：脚本经 `localShell.cjs` 在用户本机跑。`headless: false` 时真窗口弹在桌面（抢焦点、非画中画）；`headless: true` 时无任何可见画面。
- **CLOUD**：脚本在服务端无显示环境跑，用户只能看到文字输出与脚本里偶发的截图文件。

此外还有结构性问题：agent 每条 shell 命令都是短命进程，脚本内 `launch` 的浏览器随进程退出而销毁，多脚本之间浏览器状态（登录态、页面）无法延续；模型每次即兴配置 screencast / headed 也不可靠。

### 1.2 目标

用户在 agent 执行 playwright 浏览器操作期间，可通过桌面画中画窗口实时旁观被控页面；任务结束自动收窗。LOCAL / CLOUD 两模式都支持。

### 1.3 已确认的方向

- **采集用 CDP Screencast**（D1）：headless 可采、只采集被控页面、按重绘出帧空闲零带宽、两模式同一套采集逻辑。
- **浏览器由常驻 runner 持有**（D2）：解决浏览器生命周期与画面采集的单点化。
- **数据面 LOCAL 与 CLOUD 分路，渲染面统一**（D3）：LOCAL 直连本机不绕云端；PiP 窗口组件一套。
- 初版只观看不接管（D6），不做多会话多窗格。

## 2. 需求描述

### 2.1 要做的

| # | 内容 |
|---|------|
| P1-1 | 新增内置技能（暂名 `browser-live`）：SKILL.md + `runner/` 目录（skill-sync 会把整个技能文件夹 symlink 进会话运行时 `skills/<name>/`，runner 随技能可达） |
| P1-2 | runner：启动/接管 Chromium（系统 Chrome channel，不下载浏览器二进制），开 CDP 端点供 agent 脚本 `connectOverCDP`，对全部 page 做 browser 级 screencast 采帧 |
| P1-3 | 帧出口：LOCAL = runner 起仅绑定 `127.0.0.1` 的 WS 出口供 Electron 直连；CLOUD = runner 作为 WS 客户端连后端新接入点，后端鉴权后经 `StreamingWsRegistry.send` 转发为 `browser_frame` 事件 |
| P1-4 | 桌面画中画窗口：frameless、`alwaysOnTop`、可拖动、位置记忆；渲染最新帧；头部显示会话/URL 与「停止浏览器」按钮 |
| P1-5 | 生命周期联动：首帧→弹窗（`browser_live_started`）；任务结束/取消/超时→自动收窗并兜底清理浏览器进程 |
| P1-6 | `useStreamWS` 增加帧/生命周期事件 case；聊天流可选插入一条 activity（「已开启浏览器直播」） |

### 2.2 不做的

- **不做用户接管/交互**：初版只观看；用户要干预直接对 agent 说话。
- **不做多会话多窗格**：单 PiP 窗口单会话，多会话并行时跟随最新开播会话，头部可手动切换（M3）。
- **不做整机屏幕采集**：`desktopCapturer` / 系统屏幕录制一律不碰（触发 macOS TCC 权限且越权采集非浏览器内容）。
- **不做 VNC / xvfb / noVNC**：重且平台差异大，CDP screencast 已覆盖需求。
- **不改 shell 工具本身**：runner 启动就是一条普通 shell 命令，仍受 command-deny-list、path-sandbox、审批（LOCAL 既有口径）约束。
- **不内置 playwright 库分发**（D7 拍板）：CLOUD 服务器预装、LOCAL 由 SKILL.md 引导安装。
- 不考虑 Web / 安卓端观看：移动端不做，Web 端后续可选复用 CLOUD 帧通道（自然免费获得）。

### 2.3 用户看到的结果

- agent 开始跑 playwright：几秒内桌面右上角弹出小窗，实时显示被控页面（页面静止时画面定格，无流量）；小窗始终置顶、可拖走。
- 任务完成/取消：小窗自动消失，浏览器进程被清理，不留孤儿 chromium。
- 用户中途关窗：仅停止观看，浏览器与任务继续跑；头部「停止浏览器」按钮显式杀浏览器（agent 后续脚本连接失败，模型读到错误自行收尾）。

## 3. 技术选型与决策点

### D1 采集方式：CDP Screencast

候选对比：

| 方案 | 结论 |
|------|------|
| CDP `Page/Browser.startScreencast`（JPEG base64 帧） | **采用**。headless 可采；仅采集 runner 持有的 browser，边界干净；按重绘出帧、空闲零带宽；LOCAL/CLOUD 采集逻辑一致 |
| headed 窗口直看 / `--window-size` 伪装 | 过渡可用的零开发方案，但抢焦点、CLOUD 不可用，不作为目标态 |
| Electron `desktopCapturer` 抓 headed 窗口 | 排除：触发 macOS 屏幕录制 TCC 权限；依赖 headed；窗口被遮挡/最小化时画面中断 |
| VNC / xvfb + noVNC | 排除：重、平台差异大、多一跳协议 |

参数初值：browser 级 screencast，`maxWidth/maxHeight 1280x720`，JPEG 质量 60，每帧 metadata 带 `pageUrl`。限速 ≤5 fps（采集端 skip + 消费端只画最新帧双重兜底）；动画页峰值约 100–300 KB/帧，静置页面零帧。

### D2 常驻 runner 持有浏览器

- runner 由 agent 经 shell **后台启动**（`node skills/browser-live/runner/browser-live.mjs --session <id>`），SKILL.md 强约定：所有 playwright 脚本必须先确保 runner 在跑，再 `chromium.connectOverCDP(runner 输出的端点)` 操作页面；禁止裸 `launch`。
- runner 职责：
  1. 启动 Chromium（`playwright-core` + `channel: 'chrome'` 用系统 Chrome；无系统 Chrome 时降级 `npx playwright install chromium` 由 SKILL.md 指导）；
  2. CDP 端点写stdout/文件（`127.0.0.1:<动态端口>`），agent 脚本读端点连接；
  3. browser 级 screencast 泵（新 page 自动 attach），帧送出口（D3）；
  4. 心跳 + 退出清理（SIGTERM / 出口断连 / `--stop` 管理命令）。
- 为什么不由后端/桌面自动拉起 runner：后端不知道 LOCAL 的执行环境细节（依赖、Chrome 路径），且 agent 起 runner 是显式可见的一条 shell 记录，符合「工具动作可解释」的既有原则。后端只做兜底清理，不做主动拉起。

### D3 帧出口：LOCAL 直连 / CLOUD 经后端

| | LOCAL | CLOUD |
|--|-------|-------|
| 出口 | runner 起仅绑 `127.0.0.1` 的 WS server | runner 作为 WS 客户端连后端新端点 |
| 认证 | 本机回环 + 端口握手 token（写运行时文件，Electron 读） | 复用 CLOUD shell 已注入的 `MAO_BASE_URL` + `ShellTokenIssuer` 短效 token |
| 转发 | 无转发，Electron 主进程直连 | 后端校验 session 属主后 `StreamingWsRegistry.send(userId, {type:'browser_frame',...})` |
| 依据 | 不绕云端公网，延迟/带宽最优，贴合 LOCAL 文件/工具不经云端的一贯风格 | 无服务端执行环境之外的直连面 |

渲染面统一：PiP 窗口组件只吃「帧流抽象」（`onFrame(cb)` / `onLiveStop(cb)`），数据源由 Electron 主进程注入（LOCAL 直连 or 订阅后端事件转发 IPC）。

### D4 桌面画中画窗口

- 新模块 `desktop/electron/pipWindow.cjs`（贴合 main 拆分后的模块模式）：`frame: false`、`alwaysOnTop`、默认 360×240、可拖动（头部 `-webkit-app-region: drag`）、位置/尺寸记忆进 `desktopPrefs.cjs`。
- 窗口加载 renderer 专用路由 `/pip`（Vue 组件：canvas 画帧 + 头部信息条 + 「停止浏览器」按钮；图标按钮一律带 `aria-label`/`title`，符合 AGENTS 规范）。
- 帧渲染策略：`tool_call` 流水线无关；canvas 2D `drawImage`，仅保留最新帧（seq 乱序/积压直接丢）。
- 关闭行为：点 × = 停止观看（窗口隐藏、数据源断开、浏览器继续）；「停止浏览器」按钮 = IPC → 通知 runner 退出 → 杀浏览器进程树。

### D5 生命周期

| 事件 | 行为 |
|------|------|
| runner 起并产出首帧 | `browser_live_started`（sessionId、分辨率）→ 桌面弹 PiP 窗 |
| 会话 running → done/idle/异常 | 桌面/后端给 runner 宽限期（如 10s）后发停止；CLOUD 侧 runner WS 断连即自杀；LOCAL 侧 Electron 会话结束钩子杀 runner 进程树 |
| 兜底超时 | 心跳 30min 无更新 → 后端（CLOUD）/Electron（LOCAL）强制清理，防孤儿 chromium |
| 用户关窗 | 仅停观看（§2.3） |
| runner 被 agent 显式 `--stop` | 正常退出路径，事件 `browser_live_stopped`（reason）→ 收窗 |

### D6 安全与边界

- 帧只发给会话属主：CLOUD 后端校验 token 与 session 归属后才转发；LOCAL 仅绑回环 + 握手 token。
- 采集范围仅 runner 持有的 browser 实例页面，不涉及系统屏幕/其他应用窗口；不触发 macOS 屏幕录制权限（这是排除 desktopCapturer 的原因之一）。
- 页面内容（含登录态、敏感表单）本身会被直播：SKILL.md 明示「浏览器直播期间页面内容对用户可见」，属产品语义而非新增风险（观看者即会话属主本人）。
- runner 是普通 shell 进程：deny-list、path-sandbox、审批口径全部沿用，无新特权。

### D7 依赖分发：服务端预装 + 本地引导（2026-11-20 拍板）

- **CLOUD**：服务器预装全局 `playwright-core`（不下浏览器二进制），浏览器用系统 Chrome（`channel: 'chrome'`）；预装状态纳入部署文档（DEPLOY.md），runner 启动时自检并在缺依赖时给出可解释错误。
- **LOCAL**：SKILL.md 引导 agent 检测依赖（`node -e "require.resolve('playwright-core')"`），缺失时先跑 `npm i playwright-core`（安装进会话工作区 node_modules）再启动 runner；系统无 Chrome 时才提示 `npx playwright install chromium`。
- 桌面打包预置（+150~300MB 包体积）与运行时按需下载（首次慢、CLOUD 每用户首跑都要等）两案否决。

### D8 runner 启动方：agent 按技能约定启动（2026-11-20 拍板）

- SKILL.md 指示 agent 用 shell 后台启动 runner；启动是显式可见的一条 shell 记录，可解释可排查。后端/桌面只做 D5 的兜底清理，不主动拉起。
- 「平台检测到 playwright 动作自动拉起」案否决：隐式魔法行为在 LOCAL 环境差异（Chrome 路径、依赖）下难排查、失败归因模糊。

### D9 CLOUD 帧通道：复用 /api/ws/stream（2026-11-20 拍板）

- runner 以新 `clientType=runner` 接入既有 `/api/ws/stream`，复用 auth/心跳/StreamingWsRegistry；新增事件类型见 §4.1。后端按会话令牌桶限速兜底，防帧流量影响会话流吞吐。
- 若上线后实测帧流量干扰会话流（如大动画页持续推帧时 delta 延迟上升），再评估拆独立端点；不在初版预留双通道。

## 4. 协议设计

### 4.1 WS 事件（后端 → 桌面，经 StreamingWsHandler）

```jsonc
// 首帧前
{ "type": "browser_live_started", "sessionId": 123, "width": 1280, "height": 720 }
// 帧流（≤5fps，单帧 ≤300KB，超限后端丢弃并计数）
{ "type": "browser_frame", "sessionId": 123, "seq": 42, "ts": 1732060000000,
  "jpegBase64": "…", "width": 1280, "height": 720, "pageUrl": "https://…" }
// 收窗
{ "type": "browser_live_stopped", "sessionId": 123, "reason": "session_done|runner_exit|timeout|user_stop" }
```

### 4.2 CLOUD runner 接入点（runner → 后端）

- 新 WS 端点（复用 `/api/ws/stream` 通道加 `runner` clientType，或独立 `/api/ws/browser-live`；倾向前者，复用 auth/心跳）：runner 连上后发 `{type:'runner_auth', token, sessionId}`，后端校验短效 token + 会话属主，绑定该会话的 runner 连接（每会话至多一个，重复连接踢旧）。
- 限速在后端做（per-session 令牌桶），防 runner 失控刷爆 WS。

### 4.3 runner 本地出口（LOCAL）

- `ws://127.0.0.1:<port>/live?token=<握手token>`；token 与端口写 `runtime/sessions/<id>/browser-live.json`（仅属主可读），Electron 读取后直连。
- 与 CLOUD 同一套帧消息格式，只是方向反转（server=runner）。

## 5. 改动面清单

| 端 | 改动 |
|----|------|
| 技能（`harness/skill/` 新增目录或按外部技能发布） | `browser-live/SKILL.md`（约定 + 安装引导）、`browser-live/runner/browser-live.mjs` 及 `--stop` 辅助 |
| 后端 | 帧事件转发与限速、runner 接入鉴权（`session/ws/`）、生命周期兜底清理（`harness/` 新域 `browser-live/` 或挂 harness-service）、`no-progress-notice` / `tool-result-summarizer` 不涉及（帧非工具结果；若加 activity 文案则同步两处） |
| 桌面 Electron | `pipWindow.cjs` 新窗口模块、LOCAL 直连客户端、会话结束清理钩子、`desktopPrefs` 记忆 |
| 桌面 renderer | `/pip` 路由 + PiP 组件、`useStreamWS` 加 3 个 case、聊天流 activity 条（可选） |
| 契约 | 事件类型进 `@mao/contracts`（跨端枚举收口规范），无需新 `LlmCallScene` |

## 6. 测试

- 后端单测：runner 接入鉴权（token 过期/非属主/重复连接）、限速丢帧、会话结束兜底清理、`browser_frame` 事件只达属主。
- 桌面：`vue-tsc -b` + PiP 组件单测（帧渲染/乱序丢弃/按钮 aria-label）；`pipWindow.cjs` 逻辑测试沿 main 拆分模块的既有 test 模式。
- E2E（可选，M2 后）：LOCAL 起 mock runner 产帧 → 断言 PiP 窗出现与收窗（Playwright 不依赖固定用例数）。
- 手工验收：CLOUD 无显示环境真跑一次「打开 GitHub 搜索仓库」全流程。

## 7. 分期

- **M1（LOCAL 闭环）**：技能 + runner + 本地出口 + PiP 窗口 + 生命周期联动。不经后端，价值最直接，可先验证「用户要不要看」。
- **M2（CLOUD 通道）**：runner 接入点 + 鉴权 + 限速 + 兜底清理；Web 端观看顺带可用。
- **M3（打磨）**：多会话切换、帧率/分辨率自适应、activity 文案、PiP 窗「跳转会话」。

## 8. 与内置 page_* 工具链路的关系

互不影响：`page_*` 走 EmbedPageToolRegistry → 宿主页面 SDK，画面天然在用户眼前；本方案只服务 playwright 技能的 shell 脚本链路。二者不共享浏览器实例，SKILL.md 不引导两者混用同一页面任务。

## 9. 决策记录

2026-11-20 与产品负责人确认，原未决事项全部闭合（落点见 §3 D7–D9）：

| # | 事项 | 结论 |
|---|------|------|
| 1 | playwright 依赖分发 | 服务端预装 `playwright-core` + 系统 Chrome；LOCAL 由 SKILL.md 引导安装（D7） |
| 2 | runner 启动方 | agent 按技能约定经 shell 后台启动，平台不自动拉起（D8） |
| 3 | CLOUD 帧通道 | 复用 `/api/ws/stream`，新 `clientType=runner` + 事件类型；实测拥塞再评估拆分（D9） |
| 4 | PiP 窗口多显示器兜底 | 按常规默认：窗口位置记忆按屏幕工作区校验，显示器变更/坐标超界时回默认位，不弹独立确认（实现细节，随 M1 落地） |
