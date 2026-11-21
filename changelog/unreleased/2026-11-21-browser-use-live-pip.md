### 后端

- **内置技能 `browser-use`（`skills/bundled/browser-use/`）随发版进入系统 Skills**：基于 playwright-cli 的浏览器自动化技能，Agent 用法与原 playwright 技能命令完全一致（`open / snapshot / click / fill / …`），wrapper 透明注入调试端口并拉起零依赖采集进程，画面实时直播给桌面客户端画中画；管理员在 Agent 上勾选后生效
- **WS 流通道新增浏览器直播 runner 接入**：`/api/ws/stream` 支持 `runner_auth` 独立握手（shell 短效 JWT + 会话属主 + CLOUD 模式校验，每会话至多一条、新连踢旧），`browser_frame` 帧经 per-session 令牌桶限速（6fps / 突发 12）后只转发会话属主的 electron/browser 连接（安卓不收）；会话终态自动下发 `browser_live_stop`，runner 非正常断开时合成 `browser_live_stopped` 兜底收窗；新增契约类型 `BrowserLiveStartedData / BrowserFrameData / BrowserLiveStoppedData` 等（`@mao/contracts`）

### 前端（桌面 / Web / 安卓）

- **浏览器直播 Tab**：主窗 CenterTab 新增「浏览器直播」页签（对齐文件预览的打开方式），实时画面 + 当前页面 URL + 停止浏览器 / 还原画中画；Web 端观看随 WS 事件自然可用；安卓不收帧、行为不变

### 桌面 Electron

- **画中画窗口**：frameless 置顶小窗（默认 384×252，可拖动、位置/尺寸记忆进 desktop-prefs，超界回默认位），Agent 操作浏览器期间实时旁观；**双击放大**为页面内直播 Tab，Tab 内一键还原回画中画；任务结束 / 用户停止 / 超时 / 浏览器退出自动收窗并清理浏览器进程，无孤儿 Chrome
- **LOCAL 直连帧通道**：shell 工具执行时自动发现会话运行时 `.mao-browser/live.json`，SSE 直连本机采集进程（不绕云端）；CLOUD 帧经后端 WS 转发后由渲染层回灌主进程枢纽统一扇出
