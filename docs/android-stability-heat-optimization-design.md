# 安卓 APP 稳定性与发热优化技术方案（简化路线）

> 状态：决策已确认，等待实施
> 适用范围：仅安卓 APP（Capacitor 壳，远程加载 `https://mao.etarch.cn`）。Web / Electron 桌面端行为零变化。
> 关联代码：`android/`（原生壳）、`desktop/`（Vue 3 前端）

## 1. 需求背景

Mao 安卓 APP 当前存在两个用户可感知的问题：

1. **退后台后回前台页面卡死**：用户将 APP 退到后台，过一会儿再回来，页面卡死无响应，必须将进程整个退出后重新打开才能恢复。
2. **手机发烫明显**：使用过程中发热较明显，怀疑与后台保活机制有关。

当前代码库已实现一套完整的「后台 WebSocket 保活方案」（`docs/android-websocket-keepalive-design.md` v4）：原生前台服务（FGS + WakeLock）+ OkHttp WebSocket 保活 + 磁盘事件缓冲（逐事件 fsync 落盘）+ ACK/tombstone + 回前台 recovery 协议（同步屏障 + REST 校准）。用户确认：**可以接受回前台时检测到连接已断开、自动刷新页面来恢复**，即不要求后台实时看到流式输出。

据此，本次优化走**简化路线**：彻底删除原生保活机制，回到「纯 JS WebSocket + 回前台自动恢复」，从根上消除卡死与发热问题。

## 2. 需求描述

### 2.1 目标

> 删除安卓原生后台保活机制（前台服务 / WakeLock / 磁盘缓冲 / recovery 协议 / 通知），回退为与 Web 端一致的纯 JS WebSocket 连接；回前台时若检测到连接断开，自动整页刷新恢复；若 WebView 已卡死无响应，由原生层兜底自动 reload。后台无任何常驻原生活动，发热大幅下降；「卡死必须退出重开」的问题被自动刷新兜底彻底绕开。

具体拆解：

1. **删除保活**：后台不再有前台服务、WakeLock、磁盘缓冲写入、recovery 协议、终态通知与通知点击跳转；
2. **回前台自动恢复（JS 层）**：页面存活时，回前台若 WS 非 OPEN，静默整页刷新，刷新后自动回到最后一个会话并拉取最新状态；
3. **回前台自动恢复（原生兜底）**：WebView 主线程卡死 / 渲染进程异常时，MainActivity 探测无响应后自动 reload，无需用户退出重开；
4. **降温**：删除保活服务后后台无原生 I/O 与常驻定时器，配合系统对后台 WebView 的默认冻结，发热显著下降；
5. **前台体验不变**：前台使用与 Web 端一致（5s 心跳 / 15s pong 超时 / 指数退避重连 / 实时流式收流）；
6. **仅安卓 APP 生效**，Web / Electron 行为零变化；后端零改动。

### 2.2 已确认决策（决策树结论）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 整体策略 | **简化路线**：删除原生保活，回退纯 JS WebSocket，回前台自动刷新恢复 |
| 2 | 保活代码去留 | **彻底删除**（项目初版阶段无兼容负担）：原生 5 个保活类 + 通知类、前端桥接层、recovery 协调器全部删除 |
| 3 | 回前台恢复策略 | **断开即刷新**：回前台时 WS 非 OPEN（CLOSED / CLOSING / CONNECTING）直接整页 reload，不等待重连 |
| 4 | 原生兜底 | **做**：MainActivity.onStart 探测 WebView 响应性，超时自动 reload，解决「JS 卡死时也能自动恢复」 |
| 5 | 能力取舍 | **全接受**：取消后台任务实时收流、任务终态系统通知、通知点击跳转会话 |
| 6 | 刷新后路由 | **不做**：`session.ts` 已有 `mao_last_session_id` localStorage 持久化，刷新后自动还原最后会话，无需开发 |
| 7 | WebView 后台降耗 | **依赖系统默认**：不显式调用 webView.onPause()/onResume()，由系统在 Activity 不可见时自动冻结后台 WebView |
| 8 | 后端 | **零改动**：保留 `app.ws.idle-timeout-ms` 配置化与 `client=android` 识别（均无害）；前端回退后安卓仍传 `client=android` |
| 9 | 刷新体验 | **静默刷新 + 防抖**：不提示直接 reload；10s 内只刷新一次，避免快速前后台切换触发连环刷新 |
| 10 | 生效范围 | 仅安卓 Capacitor 平台；Web / Electron 不启用刷新逻辑（其现有 JS 自动重连已足够） |

## 3. 现状分析与根因

### 3.1 卡死问题候选根因（基于代码分析）

| # | 候选根因 | 说明 |
|---|---|---|
| 1 | WebView 后台冻结 / 渲染进程被回收后恢复失败 | WebView 远程加载 SPA，后台长时间冻结或低内存下渲染进程被系统回收；回前台时页面可能白屏或状态错乱，表现为卡死 |
| 2 | recovery 协议卡在 SYNC 屏障 | `RecoveryCoordinator` 的 SYNC 模式最长 30s 兜底释放，但前端 `waitUntilApplied` 10s 超时退出后，原生可能仍处于屏障内，实时事件被挡住，页面看似「不更新/卡死」 |
| 3 | `wsBridge.drain()` 同步重放阻塞主线程 | 后台积压事件在回前台时由 while 循环同步逐个 `routeEvent`，大批量重放时阻塞 JS 主线程，UI 无响应 |
| 4 | 原生桥与 JS 桥状态不一致 | WebView 重建后 JS 侧新桥 CONNECTING，原生连接复用补发 open 的时序若出错，`connect()` 可能永久 pending 直至 15s 超时销毁，期间功能不可用 |

### 3.2 发热问题候选根因（基于代码分析）

| # | 候选根因 | 说明 |
|---|---|---|
| 1 | 逐事件 fsync 落盘 | `PendingQueue` 在 persistMode 下对每个事件执行 tmp + fsync + 原子 rename；后台任务流式输出时事件密集，闪存写入开销极大 |
| 2 | FGS + WakeLock 常驻 | 任务执行期间 `PARTIAL_WAKE_LOCK` 阻止 CPU 休眠，配合 25s 心跳与 30s 存活扫描等 Handler 定时器持续唤醒 |
| 3 | 重连退避循环 | 弱网 / 服务端断连场景下 1s→30s 指数退避持续重连，TLS 握手开销反复发生 |
| 4 | 后台 WebView 未彻底冻结时的 JS 定时器 | 若系统未及时冻结 WebView，前端心跳 / 版本轮询等定时器仍会周期唤醒 CPU |

### 3.3 结论

上述候选根因全部位于保活机制本身（原生服务、桥、缓冲、recovery）。删除保活后：后台无原生活动、WebView 由系统冻结、无磁盘 I/O，发热源全部消除；回前台无论页面存活（JS 层检测刷新）还是已死（原生兜底 reload）都能自动恢复。卡死问题无需再逐个修根因，被「自动刷新兜底」整体绕开。

## 4. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| 连接方式 | 回退为 WebView 内 JS WebSocket（`useStreamWS` 原生逻辑），`wss://mao.etarch.cn/api/ws/stream?token=xxx&client=android` | 与 Web 端一致，无原生连接，后台冻结即断，零常驻开销 |
| 心跳与重连 | 沿用现有 JS 逻辑：5s `ping` / 15s pong 超时 / 指数退避 1s→30s / 断线自动重连 | 已是 Web 端成熟行为，无需改动 |
| JS 层恢复 | 新增轻量 composable：`visibilitychange`（hidden→visible）+ WS 非 OPEN → `window.location.reload()`，10s 防抖，仅安卓生效 | 实现最小，满足「断开即刷新」决策 |
| 原生兜底 | `MainActivity.onStart()` 延迟探测 `webView.evaluateJavascript` 响应性（3s 无回调判定无响应）→ `webView.reload()`，10s 防抖 | 不依赖 JS 存活，兜住「卡死必须退出重开」 |
| 冷启动恢复 | 全新 WebView 加载页面 → `useChat` 自动 `connect()` → 会话经 `mao_last_session_id` 还原 | 现有逻辑，无新增开发 |
| 后端 | 零改动 | `client=android` 识别与空闲超时配置化均无害，无需发版 |
| 新依赖 | 无 | 不引入任何新库 |

## 5. 整体方案设计

### 5.1 分层恢复机制

```
回前台（onStart / visibilitychange visible）
│
├─ 原生层（MainActivity，JS 死时的兜底）
│    onStart → 延迟 2s（等 WebView 恢复）→ evaluateJavascript 探测
│    ├─ 3s 内无回调 → 判定无响应 → webView.reload()（10s 防抖）
│    └─ 有回调 → 正常，不干预
│
└─ JS 层（页面存活时的首选）
     visibilitychange visible → 检查 WS readyState
     ├─ OPEN → 不做处理（假死由 15s pong 超时自动重连兜底）
     └─ 非 OPEN（CLOSED/CLOSING/CONNECTING）→ 静默 reload（10s 防抖）
```

- **冷启动 / 进程被杀重开**：WebView 全新加载页面，页面初始即 visible，`visibilitychange` 不会触发，不会误判为「断开」而刷新；`useChat` 首次 `connect()` 建连，会话列表与最后会话由现有逻辑恢复。
- **前台使用中**：无 visibilitychange，不触发刷新。
- **后台任务执行中**：WebView 被系统冻结，JS 定时器停摆，心跳停止；服务端 90s 空闲超时断开连接；回前台时 WS 已 CLOSED → JS 层静默刷新恢复，刷新后 `restoreSession` 从 REST 拉取任务最新状态，若任务仍在运行则继续收到流式事件。

### 5.2 刷新防抖规则

- JS 层与原生层各自独立防抖：记录 `lastReloadAt`，10s 内不重复 reload。
- 两层同时生效时（页面半死：JS 触发刷新但主线程卡住），原生探测兜底同样在 10s 防抖内，最多触发一次 reload。

### 5.3 前端连接生命周期（回退后）

- `useStreamWS` 恢复纯 JS WebSocket：`connect()` 建连、`onopen` 重订阅、`onclose` 调度重连、5s 心跳、15s pong 超时；删除所有 `nativeBridge` 分支（`createWsBridge` / `waitForOpen` / `sendAsync` / `trackSessions` / `untrackSessions` / `syncSubscriptions` / `stopKeepAlive` / `BRIDGE_CONNECT_TIMEOUT_MS`）。
- `send` / `sendReliable` / `subscribe` / `unsubscribe` / 消息路由逻辑保持不变。
- 退出登录 `disconnect()` 保持现状。

## 6. 实现步骤

### 6.1 前端（`desktop/`，仅安卓生效的刷新逻辑；Web / Electron 零变化）

1. **新增 `desktop/src/composables/useForegroundRecovery.ts`**（新 composable，替代原 `useAppResumeSync`）：
   - 仅 `isAndroidCapacitor()` 时启用（复用 `useVersionCheck.ts` 中的平台检测模式，不依赖 `@capacitor/core` npm 包）；
   - 监听 `document.visibilitychange`：`document.visibilityState === 'visible'` 时执行检测；
   - 检测逻辑：读取 `useStreamWS` 当前 WS `readyState`，非 `WebSocket.OPEN` → 静默 `window.location.reload()`；
   - 防抖：模块级 `lastReloadAt`，10s 内不重复刷新；
   - 冷启动防护：页面加载后 3s 内不触发（保险，防初始建连窗口误判）。
2. **改造 `desktop/src/composables/useStreamWS.ts`**：
   - 删除 `nativeBridge` 全部分支与 `import`（`createWsBridge`、`shouldUseNativeBridge`、`WS_OPEN` 等仅桥用常量）；
   - 恢复为纯 `new WebSocket(url)` 路径，`client` 取值：安卓 `isAndroidCapacitor()` 时为 `'android'`，其余维持现有 `electron` / `browser` 判定；
   - 保留：心跳、重连、订阅、路由、`sendReliable`、`onMessageSaved`、executionId 去重等全部现有逻辑。
3. **删除**：
   - `desktop/src/capacitor/wsBridge.ts`（`capacitor/` 目录若无其他文件一并删除）；
   - `desktop/src/composables/useAppResumeSync.ts`；
   - `desktop/src/main.ts` 中 `useAppResumeSync` 的 import 与 `useAppResumeSync().init()` 调用，替换为 `useForegroundRecovery().init()`。

### 6.2 安卓原生（`android/`）

1. **`MainActivity.java`**：
   - 删除：`registerPlugin(WsBridgePlugin.class)`、`handleIntent` / `onNewIntent` / `pendingNavigationSessionId`、`notificationPermissionLauncher` 及 `POST_NOTIFICATIONS` 运行时申请、`onStart/onStop` 中的 `WsKeepAliveService.setAppForeground` 调用；
   - 新增原生兜底：`onStart()` 中 `postDelayed` 2s 后执行 `evaluateJavascript("1;", callback)`，回调 3s 超时（`postDelayed` 检查标志位）或 `onReceiveValue` 未触发 → `webView.reload()`；用 `lastReloadAt` 做 10s 防抖；
   - 保留：`configureWebView`（`LOAD_NO_CACHE`、APK 升级清缓存、`FORCE_TOP_NAV_JS` 注入、系统栏避让）、`configureSystemBars`、`hideActionBar`、SplashScreen 处理。
2. **删除以下 Java 类**（整个文件）：
   - `WsKeepAliveService.java`、`PendingQueue.java`、`TrackedManager.java`、`RecoveryCoordinator.java`、`WsBridgePlugin.java`、`AppNotification.java`。
3. **`AndroidManifest.xml`**：
   - 删除 `<service android:name=".WsKeepAliveService" ... />` 声明；
   - 删除权限：`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_DATA_SYNC`、`WAKE_LOCK`、`POST_NOTIFICATIONS`。
4. **`android/app/build.gradle`**：删除 `implementation "com.squareup.okhttp3:okhttp:4.12.0"`（OkHttp 仅被 `WsKeepAliveService` 使用，已核实 `AppUpdatePlugin` 用标准库 `HttpURLConnection`）。

### 6.3 后端

**零改动。** 保留 `app.ws.idle-timeout-ms` 配置化（默认 90s）与 `client=android` 识别（日志/能力区分，CLOUD 模式行为与 browser 一致）。

### 6.4 构建与验证

1. 更新根目录 `CHANGELOG.md`：`### 安卓原生`（删除保活、原生兜底 reload）、`### 前端（桌面 / Web / 安卓）`（回退纯 JS WS + 回前台自动刷新）；
2. 前端类型检查：`desktop` 构建（vue-tsc）；
3. `cd android && bash build-apk.sh` 构建发布（沿用现有 OTA 链路）；
4. 真机验收（见落地清单 #8）。

## 7. 落地清单

| # | 任务 | 产出 | 依赖 |
|---|---|---|---|
| 1 | 前端：新增 `useForegroundRecovery.ts`（visibilitychange + WS 非 OPEN → 静默 reload + 10s 防抖 + 冷启动防护 + 仅安卓） | 新 composable | — |
| 2 | 前端：`useStreamWS.ts` 清理 nativeBridge 分支，恢复纯 JS WebSocket（`client=android` 保留） | 前端改动 | — |
| 3 | 前端：删除 `capacitor/wsBridge.ts`、`useAppResumeSync.ts`，更新 `main.ts` 接入新 composable | 删除 + 接入 | #1 #2 |
| 4 | 安卓：`MainActivity` 新增原生兜底探测（evaluateJavascript 3s 超时 → reload，10s 防抖） | MainActivity 改动 | — |
| 5 | 安卓：删除 6 个保活类；MainActivity 清理插件注册/通知/pendingNavigate；Manifest 删除 Service 声明与 4 个权限；build.gradle 移除 okhttp | 删除 + 清理 | #4 |
| 6 | 更新根 `CHANGELOG.md`（安卓原生 / 前端小节） | 文档 | #1~#5 |
| 7 | 构建验证：desktop 类型检查 + `build-apk.sh` 构建发布 | 构建产物 + OTA | #1~#6 |
| 8 | 真机验收：① 退后台 5 分钟回前台自动刷新恢复（不卡死）；② WebView 无响应场景（开发者选项模拟）原生兜底 reload；③ 后台挂机 30 分钟无明显发热；④ 前台使用实时收流正常；⑤ 冷启动 / 进程被杀重开正常连上；⑥ 任务运行中切后台再回前台，会话状态与消息完整；⑦ 退出登录断开连接正常 | 验收记录 | #7 |

## 8. 明确不做（防止范围蔓延）

1. **不做**任何原生后台保活机制：前台服务（FGS）、WakeLock、后台 WebSocket 保活、磁盘事件缓冲、ACK/tombstone、recovery 协议；
2. **不做**任务终态系统通知与通知点击跳转；
3. **不做**电池优化白名单引导、START_STICKY、双进程守护、系统/厂商推送等非常规保活手段；
4. **不做** WebView `onPause()/onResume()` 显式控制（依赖系统对后台 WebView 的默认冻结）；
5. **不做**回前台「先重连后刷新」的等待策略（已确认断开即刷新）；
6. **不改**后端（保留现有两项无害改动，不发版）；
7. **不改** Web / Electron 任何行为（刷新逻辑仅安卓 Capacitor 平台启用）；
8. **不引入**任何新依赖（前端与原生均无新库）；
9. **不保留**任何保活死代码（彻底删除，不留开关）。

## 9. 风险与注意事项

| 风险 | 影响 | 应对 |
|---|---|---|
| 回前台瞬间 WS 显示 OPEN 但服务端已断（假死窗口） | 页面短暂不更新 | 现有 15s pong 超时检测自动 close + 重连兜底；用户已确认可接受短时无实时更新 |
| 刷新丢失内存 UI 状态（流式增量等未持久化内容） | 界面回到 REST 权威快照 | 已有 `restoreSession` + `mao_last_session_id` 恢复；任务运行中状态由后续 `session_status` 事件补全 |
| 快速前后台切换触发连环刷新 | 体验差 | JS 层与原生层各自 10s 防抖 |
| 原生探测误判（WebView 恢复慢被当无响应） | 多余刷新一次 | 探测延迟 2s + 超时 3s + 10s 防抖；即使误判也只是多刷新一次，可自愈 |
| JS 层与原生层同时触发刷新 | 双重刷新 | 防抖独立但时间窗口重叠，最多触发一次 reload |
| 后台任务结束无通知提醒 | 用户不知任务何时完成 | 已确认接受；回前台自动刷新后可见任务结果 |
| 深度后台（>90s）期间连接被服务端断开 | 回前台需刷新恢复 | 这正是目标行为：断开即刷新 |
| 冷启动 / 首次建连被误判为「断开」触发刷新 | 刷新循环 | 冷启动不触发 visibilitychange；另加页面加载后 3s 冷启动防护 |
| `client=android` 识别保留 | 无 | 后端 CLOUD 模式行为与 browser 一致，仅日志/能力区分，已验证无害 |
