### 后端

- **浏览器直播帧下发扩大到安卓端**：WS 事件接收端在 electron / browser 之外加入 android（Capacitor WebView 复用 Web Tab 观看链路），限速口径不变（6fps token bucket）。

### 前端（桌面 / Web / 安卓）

- **安卓 App 支持观看浏览器直播**：Agent 操作浏览器时，安卓端顶栏出现「浏览器直播」入口，点开以中央 Tab 实时观看（与 Web 端同构），Tab 内可停止浏览器；纯 Web 层复用，无需重打 APK。
