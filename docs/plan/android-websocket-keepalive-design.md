# 安卓 APP 后台 WebSocket 保活技术方案（修订版 v4）

> ⚠️ **已废弃（2026-08-08）**：本方案描述的原生保活机制（前台服务 / WakeLock / 磁盘缓冲 / recovery 协议 / 终态通知）已按新方案 `docs/android-stability-heat-optimization-design.md`（简化路线）整体删除，相关代码已从仓库移除。本文档仅留作历史设计参考，不再作为实现依据。
>
> 状态：已完成三轮评审，v4 按第三轮评审意见修订，达到"可进入详细设计"程度
> 关联代码：`android/`（原生壳）、`desktop/`（Vue 3 前端）、`backend/`（Java 后端）
> 适用范围：仅安卓 APP。Web / Electron 桌面端行为保持不变。
> 修订说明：v3 已确立生命周期矩阵、tracked/pendingRecovery/subscriptions 分层、原生自动跟踪子会话、ACK+tombstone、同步屏障等核心。v4 补齐四项实现正确性必要条件：① sequence/ACK/tombstone/恢复元数据持久化与崩溃恢复；② 同步屏障的完整插件协议（beginRecovery/completeRestSync/completeRecovery/abortRecovery）；③ tracked/subscribed/控制事件的完整路由矩阵；④ 原生主导的 untrack 与父子任务级联收尾。并修正三处表述（lastAppliedSeq 作用域、通知 ID 碰撞、Android 15 onTimeout 状态）。

## 1. 需求背景

Mao 安卓 APP（Capacitor 7 WebView 壳，远程加载 `https://mao.etarch.cn`）目前存在以下问题：

1. **WebSocket 连接由 WebView 内 JS 建立**（`desktop/src/composables/useStreamWS.ts`），每 5s 发 `ping`、15s 无 `pong` 则断开重连；
2. **后端 90s 空闲超时**（`WebSocketConfig.java` 的 `setMaxSessionIdleTimeout(90_000L)`），客户端停止发心跳即被服务端关闭；
3. **安卓壳无任何保活机制**：`MainActivity.java` 为标准 Capacitor BridgeActivity，Manifest 仅有 `INTERNET` + `REQUEST_INSTALL_PACKAGES`，无前台服务、无唤醒锁。

结果：用户发起长任务后锁屏或切后台，Android 系统冻结 WebView 的 JS 定时器、挂起网络、甚至回收渲染进程；心跳一停，90s 后服务端断连，流式输出中断，任务进度丢失。

**可行性结论（三轮评审确认）**：
- **"任何锁屏/后台场景都实时、绝不丢事件"不可实现**——在不申请电池豁免、不做进程恢复、不接推送、不做服务端补发、允许系统杀进程的约束下，深度 Doze、厂商后台策略、用户强制停止都可能中断前台服务与连接；
- **"进程存活范围内尽力实时，异常中断后通过重连、缓冲重放与 REST 恢复最终状态"可行**——原生前台服务 + 原生唯一 WebSocket + Capacitor 桥接，方案成立。

## 2. 需求描述

### 2.1 目标

> 在 App 进程存活、前台服务未被系统终止且网络可用时，锁屏或切后台持续接收流式事件；发生 Doze、断网或进程终止时允许中断，回前台后通过重连、缓冲重放与 REST 状态/消息同步恢复最终状态。中间流式事件**尽力保留，不承诺绝对零丢失；正常路径无重复，极端窗口（ACK 丢失叠加 WebView 重载）下允许重复（至少一次语义）**。

具体拆解：

1. 用户发起 Agent 任务后，锁屏/切后台期间前台服务保持连接，持续接收流式事件；
2. 任务执行期间通知栏显示常驻状态；任务完成/失败/取消时发独立系统通知，点击可回到对应会话（含冷启动场景）；
3. 回前台自动恢复：重连 + 缓冲重放 + REST 校准，最终状态完整，正常路径无重复无乱序；
4. App 前台空闲时保持原生连接（与现有 Web 行为一致），后台且无活跃任务时断开省电；
5. 仅安卓 APP 生效，Web / Electron 行为零变化；后端仅两处小改动（均非保活前置条件）。

### 2.2 已确认决策（决策树 + 三轮评审修订）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 核心目标 | **尽力保活**：进程存活范围内实时收流，异常中断后重连 + 缓冲重放 + REST 恢复最终状态 |
| 2 | 连接架构 | 原生 Service 持有**唯一** OkHttp WebSocket，JS 经 Capacitor 插件桥收发，前后台同一条连接 |
| 3 | 连接生命周期矩阵 | 登录后 Service 以**普通模式**运行并保持连接；任务开始提升为前台服务（FGS+WakeLock+常驻通知）；tracked 全部终态且 App 前台时**降级为普通模式**（连接保持）；App 后台且无活跃任务才断开连接、停止 Service；回前台自动重启恢复 |
| 4 | 完成通知 | tracked 会话进入 COMPLETED / FAILED / CANCELLED 时发独立系统通知，点击回对应会话（含冷启动） |
| 5 | 电池白名单引导 | **不做**（不申请 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`，不做国产 ROM 白名单引导） |
| 6 | 事件可靠性 | 待确认队列 + 单调 sequence + tombstone + 批量 ACK + 磁盘持久化 + 溢出标记 REST 校准；**元数据持久化 + 崩溃恢复**（v4 补） |
| 7 | 事件交付语义 | **尽力避免重复**（at-least-once）：前端 lastAppliedSeq 去重 + 串行 routeEvent，正常路径无重复，极端窗口允许重复；lastAppliedSeq 仅当前 WebView 生命周期内有效（v4 修正表述） |
| 8 | 事件路由矩阵（v4 新增） | tracked 决定**后台可靠缓冲与通知**，不决定前台是否允许事件进 JS；前台事件按现有行为实时转发；路由矩阵见 §5.2.2 |
| 9 | 后端改动 | 仅两项：`client=android` 识别（日志/能力区分，非前置）；空闲超时**配置化** `app.ws.idle-timeout-ms` 默认 90s（运维便利，默认行为不变，非前置） |
| 10 | 前端改造 | WebSocket 兼容桥接层（仅 Capacitor 平台）+ 发送前预启动 + 回前台 recovery 协议/REST 校准协调器 |
| 11 | 进程自动恢复 | **不做**（不设 START_STICKY；进程被杀后回前台重连 + REST 恢复） |
| 12 | 唤醒锁 | 仅 FGS 期间持有 `PARTIAL_WAKE_LOCK`；普通模式不持有；服务停止/onTimeout 释放 |
| 13 | 保活开关 | **不提供**总开关，任务执行即自动保活 |
| 14 | 保活会话范围（tracked） | 只为 tracked 会话缓冲/通知/计服务停止；side task / subagent **原生自动纳入** tracked |
| 15 | tracked 与 UI 订阅分离 | `activeTrackedSessions` / `pendingRecoverySessions` / `subscribedSessionIds` 三集合独立；UI `unsubscribe()` 绝不取消 tracked |
| 16 | 活跃/终态集合 | 活跃=RUNNING / RESUMING / WAITING_APPROVAL / CANCELLING（含 STARTING 待确认）；终态=COMPLETED / FAILED / CANCELLED |
| 17 | 原生内部阶段 | STARTING → ACTIVE → TERMINAL → RECOVERY_PENDING；STARTING 超时回滚防泄漏 |
| 18 | **untrack 裁决权**（v4 新增） | 原生状态机主导 untrack（解析 session_status 自动 ACTIVE→TERMINAL）；JS `untrackSessions` 仅用于发送失败回滚 / REST 确认终态 / 取消未启动 STARTING / 退出登录；原生验证后方生效；父子任务级联收尾 |
| 19 | 通知跳转 | `PendingIntent` → MainActivity（extras 带 sessionId），`singleTask` + `onNewIntent`/`getIntent` + pending navigation 消费 |
| 20 | 安全边界 | 仅接受 `wss://` + host/path 白名单；日志不打完整 URL/token；token 不写普通 SharedPreferences；缓冲按用户隔离；缓冲文件放 `noBackupFilesDir` |
| 21 | 心跳 | 25s 应用层 `ping` + pong 超时主动重连 + 网络切换立即重连 + 认证失败停止重连 |
| 22 | Android 15 限制 | `dataSync` 前台服务实现 `onTimeout`：活跃会话转入 pendingRecovery、标记 stopReason、释放资源、不重复提升 FGS、回前台 REST 查询、仅新任务开新 FGS 周期（v4 补充状态定义） |

### 2.3 范围界定

#### 要做

| 模块 | 说明 |
|---|---|
| 原生 Service `WsKeepAliveService` | 生命周期矩阵驱动（普通/FGS/停止）；唯一 OkHttp WebSocket；25s 心跳 + pong 超时；重连（退避/网络切换立即）；认证失败停重连；三集合 + 父子任务关系；STARTING→ACTIVE 状态机；原生解析子会话事件自动 track；onTimeout 清理 |
| 原生 WebSocket 连接 | OkHttp，`wss://mao.etarch.cn/api/ws/stream?token=xxx&client=android`，沿用现有 `ping/pong` 与消息格式 |
| Capacitor 插件 `WsBridge` | `ensureKeepAlive` / `stopKeepAlive` / `trackSessions` / `untrackSessions` / `syncSubscriptions` / `send` / `ackEvents` / `jsAlive` / `beginRecovery` / `completeRestSync` / `completeRecovery` / `abortRecovery` + 事件回传 |
| 待确认事件队列 + ACK + tombstone | 全局单调 sequence；批量 ACK；tombstone 解决 ACK 空洞；离线落盘；**元数据持久化 + 崩溃恢复** |
| 事件缓冲（磁盘） | WebView 离线期间事件持久化（JSONL，`noBackupFilesDir`）；重放从最后 ACK+1 按序；溢出标记 REST 校准；崩溃一致性（tmp+fsync+原子 rename） |
| 回前台 recovery 协议 | `beginRecovery` → SYNC 模式 → 重放 → `completeRestSync` → `completeRecovery`；单 recovery 约束、recoveryId 校验、超时兜底、部分失败保留 |
| REST 校准 | 对 restSyncRequired 会话拉取消息/活动/Todo/队列权威快照，覆盖 Pinia 缓存 |
| 发送前预启动 | 用户发送前先 `trackSessions` + 等待原生 WS OPEN（超时 10s），再发 `send_message`；失败不静默丢弃 |
| 常驻通知 | FGS 期间通知栏常驻（LOW channel）；降级普通模式时移除 |
| 终态通知 | tracked 会话终态时发独立通知（HIGH channel），`PendingIntent` 携带 sessionId，支持冷启动跳转 |
| 前端桥接层 `wsBridge.ts` | WebSocket 兼容接口 + lastAppliedSeq 去重 + 串行 routeEvent；Capacitor 平台替换 `new WebSocket(...)`；Web/Electron 走原路径 |
| `useStreamWS` 改造 | 连接建立、心跳、发送前预启动、track/untrack 按平台分流；订阅/路由/业务消息逻辑复用 |
| 回前台协调器 `useAppResumeSync` | 监听 `appStateChange(active=true)`，执行 recovery 协议 + REST 校准 + pendingNavigate 消费 |
| 后端改动 | `client=android` 识别；`app.ws.idle-timeout-ms` 配置化（默认 90s） |
| 权限 | `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC`（Android 14+）+ `WAKE_LOCK` + `POST_NOTIFICATIONS`（Android 13+ 运行时申请） |

#### 不做（明确排除）

| 模块 | 排除原因 |
|---|---|
| 电池优化白名单引导（Doze 豁免） | 已确认不做；Doze 下实时性降级，回前台重连 + REST 校准兜底 |
| 国产 ROM 自启动/白名单引导 | 已确认不做；部分机型保活可能被系统终止 |
| 进程被杀自动恢复（START_STICKY / 双进程守护） | 已确认不做；回前台重连 + REST 恢复 |
| 保活总开关 | 已确认不做 |
| 系统/厂商推送（FCM / 华为 / 小米推送等） | 终态通知为本地通知，依赖连接存活；不引入任何推送 SDK |
| 服务端离线事件补发 / 会话执行增量接口 | 已确认不做；断线期间最终状态靠回前台重连 + REST 拉取 |
| 音频保活 / WorkManager 轮询等非常规手段 | 非正规保活手段，不做 |
| 后台且无活跃任务时的连接常驻 | 后台无活跃任务即断开连接、停止 Service（省电） |
| 缓冲内容通过 REST 全量还原 | `content_delta`/思考增量/工具参数增量等中间过程不承诺还原，仅持久化消息与最终状态 |
| 严格无重复（exactly-once） | ACK 协议天然至少一次；不做服务端幂等 ID + 前端持久化去重 |
| 数据库 / SQLite 承载缓冲元数据 | 用 JSON 文件 + 原子 rename 足够，不引入数据库依赖 |
| Web / Electron 任何行为改动 | 桥接仅在 Capacitor 平台启用 |

## 3. 现状分析（代码探索结论，含三轮评审验证）

1. **后端 WS 协议已完备**：`StreamingWsHandler` 支持 `ping→pong`、`subscribe/unsubscribe`、`send_message`、`cancel`、`session_snapshot` 等。
2. **客户端标识归一化**：`resolveClientType` / `normalizeClientType` 仅区分 `electron` 与其余（一律 `browser`）。原生连接传 `client=android` 按 `browser` 处理：CLOUD 模式服务端执行工具、不下发 `tool_execute`，与现有安卓行为一致。
3. **后端按 userId 广播，订阅集合不用于发送过滤**：`StreamingWsRegistry.deliver` 遍历 `userSessions.get(userId)`，`ALL` 目标发送给该用户全部连接；`userSubscriptions` 仅登记不过滤。`useChat.ts:909-912` 注释明确此事实。→ 原生连接会收到其他端（Web/微信/并行任务）事件，**必须按路由矩阵过滤/转发**。
4. **活跃阶段定义不一致**：后端 `isSessionActive` = RUNNING/RESUMING/WAITING_APPROVAL；前端 `ACTIVE_PHASES` = RUNNING/RESUMING/WAITING_APPROVAL/CANCELLING。→ 服务活跃集合取并集（含 CANCELLING）。
5. **`session_snapshot` 只含 phase**：仅推送 phase 与 pending ask_user_questions，不补发断线期间内容增量。→ 回前台需 recovery 协议（缓冲重放）+ REST 校准，不能只靠 snapshot。
6. **`useStreamWS.send` 非 OPEN 时静默丢弃**（`useStreamWS.ts:284-290`）。→ 发送前必须预启动并等待 OPEN，失败不静默。
7. **WS 是应用级单例**：`connect()` 在 `useChat.ts` 有 9 处调用，连接保持到退出登录（`auth.ts:79-88`）。→ "无任务即断开"会破坏 connect() 语义，必须用生命周期矩阵解决（前台保持连接）。
8. **`unsubscribe()` 代表关闭会话面板，不代表任务停止**：调用点 `useChat.ts:875/965`、`SideChatPanel.vue:416`、`SubagentChatPanel.vue:253`。→ tracked 必须与 UI 订阅分离，UI unsubscribe 不取消 tracked。
9. **side task/subagent 事件格式**：`side_session_created`（data.sideSessionId）、`subagent_session_created`（data.childSessionId）由服务端下发。→ 原生解析 tracked 父会话产生的这两类事件即可自动 track 子会话。
10. **回前台无恢复流程**：前端仅在切换/加载会话时拉消息（`useChat.ts:910-949`），无 Android resume 级恢复。→ 需新增回前台协调器。
11. **`AndroidManifest.xml` 允许备份**（`allowBackup="true"`）。→ 缓冲写入 `noBackupFilesDir`。
12. **前端有成熟 Capacitor 检测模式**：`useVersionCheck.ts` 用 `window.Capacitor?.isNativePlatform?.()` + `getPlatform() === 'android'`；插件经 `window.Capacitor.Plugins.*` 读取；`MainActivity.registerPlugin` 注册。桥接层完全复用。
13. **Nginx WebSocket 超时非障碍**：已配置 86400s。

## 4. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| 保活载体 | 原生 Service：普通（前台空闲）↔ FGS `dataSync`（任务执行）↔ 停止（后台无任务） | Android 8+ 后台限制下唯一可靠常驻通道；兼顾 connect() 语义与省电 |
| WebSocket 客户端 | OkHttp 4.12.x | 标准、支持 ping 间隔、手动重连，Gradle 拉取 |
| 连接归属 | 原生层唯一连接 | 后台 JS 冻结后连接仍活；前后台无切换断线 |
| JS↔原生桥 | 自研 Capacitor 插件 `WsBridge`（与 `AppUpdatePlugin` 同模式） | 复用现有注册链路，不引入框架 |
| 事件可靠性 | 待确认队列 + 全局单调 sequence + tombstone + 批量 ACK + 磁盘 JSONL（`noBackupFilesDir`） | ACK 后才算送达；离线落盘；重放从最后 ACK+1 按序；tombstone 解决 ACK 空洞 |
| 元数据持久化 | `meta.json`（nextSequence / lastAckSequence / tombstone / restSyncRequired / pendingRecovery / tracked 快照），写入采用 tmp + fsync + 原子 rename | 进程被杀冷启动后 sequence 不冲突、ACK 水位可续推、损坏保守标记 REST 校准 |
| 事件去重 | 前端 `lastAppliedSeq` + 串行 routeEvent（仅当前 WebView 生命周期内有效） | at-least-once 下正常路径无重复 |
| 心跳 | 25s 应用层 `ping`；pong 超时 40s 主动重连；网络切换立即重连；认证失败停止重连 | 覆盖 90s 空闲超时；区分失败类型 |
| 重连 | 指数退避 1s→30s；`ConnectivityManager` 网络恢复立即重连；重连成功自动重订阅 | 断网/切网自动恢复 |
| 唤醒锁 | `PARTIAL_WAKE_LOCK`，仅 FGS 期间持有，降级/onDestroy/onTimeout 释放 | 防止 CPU 深度休眠延迟收包；普通模式不持有 |
| 通知 | 双 channel：`MaoKeepAlive`（LOW 常驻，仅 FGS）+ `MaoTaskResult`（HIGH 终态，PendingIntent 带 sessionId） | 常驻不打扰、终态可提醒、冷启动可跳转 |
| 恢复协议 | 插件原子协议：`beginRecovery` / `completeRestSync` / `completeRecovery` / `abortRecovery` + recoveryId | §5.3 同步屏障可被 API 可靠驱动（v4 补） |
| 前端桥接 | `desktop/src/capacitor/wsBridge.ts`，WebSocket 兼容接口 | `useStreamWS` 改动最小化，业务逻辑复用 |
| 后端 | `client=android` 识别；`app.ws.idle-timeout-ms` 配置化（默认 90s） | 均非保活前置条件；前者日志/能力区分，后者运维便利 |
| 安全 | `wss://` + host/path 白名单；token 内存持有不落盘；缓冲按 userId 隔离；日志脱敏 | 防 XSS 利用插件发令牌、防换账号重放 |

### 4.1 版本与权限矩阵

| 项 | 值 |
|---|---|
| minSdk / targetSdk | 24 / 35（现状，不改） |
| 新增权限 | `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_DATA_SYNC`、`WAKE_LOCK`、`POST_NOTIFICATIONS`（13+ 运行时申请） |
| OkHttp | 4.12.x（Maven Central） |
| 前台服务类型 | `dataSync`（Android 14+ 强制声明；Android 15 有累计时长限制，需 `onTimeout`） |

### 4.2 保活能力边界（如实说明）

| 场景 | 效果 |
|---|---|
| 锁屏 / 切后台（进程存活，有活跃任务） | ✅ FGS + 唤醒锁 + 原生心跳持续收流；WebView 冻结期间事件入待确认队列并落盘 |
| 前台空闲（无任务，进程存活） | ✅ 普通 Service 持有连接，无通知、无 WakeLock；订阅/问答/状态更新正常 |
| 深度 Doze（静置熄屏数分钟以上） | ⚠️ 网络可能被系统挂起（未做白名单引导），实时性降级为间歇窗口；回前台 recovery 重放 + REST 校准 |
| 国产 ROM 杀后台 / 用户强制停止 | ❌ 进程被杀，服务终止（未做 START_STICKY / 白名单引导）；回前台重连 + recovery + REST 校准 |
| 断网 / 切网络 | ✅ 原生重连（退避 / 网络恢复立即重连），恢复后自动重订阅 |
| WebView 渲染进程被回收 | ✅ 原生连接与磁盘缓冲不受影响；回前台重载后 recovery 重放未 ACK 事件 |
| Android 15 dataSync 超时 | ⚠️ 系统限制累计时长 → `onTimeout`：活跃会话转 pendingRecovery、标记 stopReason、回前台 REST 校准，仅新任务开新 FGS |
| 缓冲溢出（5000 条 / 10MB 每会话） | ⚠️ 溢出会话标记"需 REST 全量校准"（丢弃记录入 tombstone），回前台拉取持久化消息与最终状态 |

## 5. 整体架构与数据流

### 5.1 组件架构

```
┌────────────────────────── WebView（远程 SPA） ─────────────────────────┐
│  useStreamWS.ts ──(Capacitor 平台)──> wsBridge.ts（WebSocket 兼容接口）  │
│    │ send()/onmessage/onclose   │ ackEvents/jsAlive/beginRecovery/…   │
└────┼────────────────────────────┼─────────────────────────────────────┘
     │ 插件调用                    │ 插件事件（wsEvent/wsStatus/…）
┌────▼────────────────────────────▼─────────────────────────────────────┐
│                      WsBridgePlugin（Capacitor 插件）                    │
│   ┌─────────────────────────────────────────────────────────────────┐ │
│   │  WsKeepAliveService                                          │ │
│   │   模式：普通（前台空闲）↔ FGS dataSync（任务执行）↔ 停止（后台无任务） │ │
│   │   ├─ OkHttp WebSocket（唯一连接）                             │ │
│   │   │    25s ping / 40s pong 超时 / 1s→30s 退避 / 网络切换立即     │ │
│   │   │    认证失败→停重连（回前台重新登录后恢复）                    │ │
│   │   ├─ TrackedManager：三集合 + 父子任务关系                     │ │
│   │   │    activeTracked（决定 FGS）                              │ │
│   │   │    pendingRecovery（终态未清，保留到恢复完成）               │ │
│   │   │    subscriptions（重连后重订阅用）                         │ │
│   │   │    parent→children 映射（级联收尾）                        │ │
│   │   │    原生解析子会话事件自动 track；STARTING 超时回滚          │ │
│   │   │    untrack 原生裁决（JS 仅四种情况可请求）                   │ │
│   │   ├─ PendingQueue：sequence + ACK + tombstone + 磁盘 JSONL     │ │
│   │   │    + meta.json 持久化（nextSequence/lastAck/tombstone/…）   │ │
│   │   ├─ RecoveryCoordinator：beginRecovery/completeRestSync/…    │ │
│   │   ├─ WakeLock（仅 FGS 持有）                                   │ │
│   │   ├─ 通知：常驻（仅 FGS）/ 终态（PendingIntent 带 sessionId）   │ │
│   │   └─ onTimeout：活跃→pendingRecovery / stopReason / 释放资源    │ │
│   └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                              │ wss://mao.etarch.cn/api/ws/stream
                              ▼
                    后端 StreamingWsHandler（空闲超时配置化, 默认 90s）
```

### 5.2 事件可靠性协议

#### 5.2.1 队列、ACK 与 tombstone

**事件写入**：服务端事件 → 原生分配全局单调 `sequence` → 按路由矩阵（§5.2.2）决定入可靠队列与否 → 按 WebView 在线状态实时推送 JS 或落盘（后台模式）。

**ACK 语义**：JS 将事件成功路由进 Pinia store 后，发送**累计 ACK**（最大连续 sequence）。原生只清除「已 ACK ∪ tombstone（skipped）」的记录；ACK 水位 = 最大连续「ACK ∪ skipped」，允许空洞前移。

**tombstone**：某会话缓冲溢出丢弃最旧未 ACK 记录时，将该 sequence 记入 skipped 集合（tombstone）并标记该会话"需 REST 全量校准"。防止单会话溢出导致全局队列永远无法 compact。

**前端去重（at-least-once）**：
- `wsBridge.ts` 维护 `lastAppliedSeq`，**仅当前 WebView 生命周期内有效**（WebView 重载后重置）；
- 收到 `seq <= lastAppliedSeq` 的事件：只 ACK、不路由；
- 事件**按 sequence 串行**调用 `routeEvent`，成功返回后再更新 `lastAppliedSeq` 并发送 ACK；
- 若事件已应用 Pinia 但 ACK 未达原生时 WebView 重载，该事件可能再次应用——这是方案接受的 at-least-once 极端窗口；REST 权威覆盖可修复持久化消息重复，未持久化的临时 UI 活动不保证完全修复。**`lastAppliedSeq` 不构成跨 WebView 重建的强去重保证**。

#### 5.2.2 事件路由矩阵（v4 新增）

核心原则：**tracked 决定后台可靠缓冲与通知，不决定前台是否允许事件进入 JS**。前台事件一律按现有行为实时转发，保持"前台行为与 Web 一致"。

| 事件类别 | 场景 | 行为 |
|---|---|---|
| 控制事件（`connected` / `pong`） | 任意 | 原生内部处理，**不进可靠队列** |
| 无 sessionId 用户级事件（`session_list_update` 等） | 前台 | **实时转发 JS**（保持会话列表等状态更新） |
| 无 sessionId 用户级事件 | 后台 | 忽略，回前台 REST 校准会话列表 |
| tracked 会话事件 | 前台 | 进可靠队列（sequence + ACK）+ 实时转发 |
| tracked 会话事件 | 后台 | 进可靠队列 + 磁盘持久化（WebView 冻结） |
| subscribed 但未 tracked 会话事件 | 前台 | **实时转发 JS，不进可靠队列**（UI 当前可见，无需 ACK） |
| subscribed 但未 tracked 会话事件 | 后台 | 忽略（UI 不可见，非保活任务；回前台 REST 校准） |
| 非 tracked 且非 subscribed 会话事件 | 任意 | 忽略（其他端/其他会话产生） |

> 说明：subscribed 未 tracked 的会话在前台是用户正打开的会话（如侧边未跟踪面板），实时转发即可；tracked 会话（后台保活任务）才需要可靠队列 + ACK + 持久化。

#### 5.2.3 元数据持久化与崩溃恢复（v4 新增）

**持久化元数据**（`noBackupFilesDir/buffered-events/meta.json`）：

```json
{
  "nextSequence": 10000,
  "lastAckSequence": 9950,
  "tombstoneRanges": [{ "start": 9951, "end": 9952 }],
  "restSyncRequiredSessionIds": [101],
  "pendingRecoverySessions": [100, 101],
  "activeTrackedSnapshot": { "100": "ACTIVE", "102": "STARTING" },
  "stopReason": null
}
```

**冷启动恢复算法**：
1. 读取 `meta.json`；不存在 → 全新开始（`nextSequence=1`）；
2. 扫描 `events.jsonl` 最大 sequence（损坏行跳过，并标记该文件所属会话 REST 校准）；
3. `nextSequence = max(持久化 nextSequence, 文件最大 seq + 1)`——**防止新旧 sequence 冲突**；
4. 恢复 `lastAckSequence` 与 tombstone；
5. 检测不一致（如 `lastAck > 文件最大 seq`、tombstone 与文件内容冲突、meta 缺失会话）→ 相关会话**保守标记 REST 校准**，而不是错误重放；
6. 清理无 meta 记录的孤儿缓冲文件（>24h）。

**崩溃一致性**（无需数据库，文件级保证）：
- 事件追加：写临时文件 → `fsync` → **原子 rename** 到 `events.jsonl`；
- meta 更新：同样 tmp + fsync + 原子 rename；
- compact（重放完成后重写）：先写新 tmp → fsync → rename 替换；**失败保留原文件**，下次重试；
- 元数据与数据文件不要求强事务（接受极小不一致窗口），不一致时保守标记 REST 校准。

### 5.3 回前台恢复（recovery 协议 + 同步屏障）

**插件原子协议（v4 新增）**：

```text
beginRecovery() → { recoveryId, watermark, restSyncSessionIds, pendingRecoverySessionIds }
completeRestSync(recoveryId, sessionIds)
completeRecovery(recoveryId)
abortRecovery(recoveryId)
```

**协议约束**：
- 同一时间**只能存在一个** recovery；重复 `beginRecovery()` 返回现有 recovery（幂等），不建立第二个屏障；
- `completeRecovery` / `completeRestSync` / `abortRecovery` 必须校验 `recoveryId`，不匹配则拒绝；
- WebView 中途销毁：当前 recovery **保留**（磁盘缓冲与水位不动），下次 `beginRecovery` 从原水位续做；
- **超时兜底**：recovery 启动 30s 未 `completeRecovery` → 原生强制解除 SYNC 屏障进入实时转发，未完成会话保留在 `restSyncRequired`/`pendingRecovery`，下次恢复重试——**不能永久停在 SYNC**；
- **REST 部分失败**：`completeRestSync` 只清除成功的会话；失败的保留 `pendingRecovery` 与 `restSyncRequired`，下次 `beginRecovery` 重试。

**流程**（收到 `appStateChange(active=true)`）：
1. JS 恢复 WebView 后 `connect()`（原生连接在则复用）；
2. `beginRecovery()` → 进入 **SYNC 模式**：原生继续收事件但**不实时转发 JS**，事件按 sequence 入队；返回 `watermark` / `restSyncSessionIds` / `pendingRecoverySessionIds`；
3. **REPLAY 阶段**：对非校准会话，按序重放缓冲（`lastAck+1` → watermark），JS 应用 + ACK；对校准会话，水位前未确认的流式记录全部 tombstone 丢弃（避免与 REST 快照重复叠加）；
4. **REST 校准阶段**：对 `restSyncSessionIds`，JS 拉取消息/活动/Todo/队列权威快照，**覆盖**该会话 Pinia 缓存，完成后 `completeRestSync(recoveryId, doneSessionIds)`；
5. **补放阶段**：按序应用 watermark 之后的新事件（在快照之上）；
6. `completeRecovery(recoveryId)` → 解除屏障，切换实时转发；原生 compact 磁盘文件；
7. 根据最终 phase 清理 `activeTracked`；集合为空 → 前台保持普通模式（不停止连接）；仅后台且无 pendingRecovery 才停止 Service。

> 屏障必要性：`connect()` 后实时事件可能先于 REST 到达，若直接应用再被 REST 旧数据覆盖会丢增量。屏障保证"先权威快照、后增量重放"的顺序。

### 5.4 服务状态机（生命周期矩阵 + 三集合 + 原生阶段 + 级联收尾）

**生命周期矩阵**：

| App 状态 | 活跃任务 | Service 模式 | 连接 | WakeLock | 常驻通知 |
|---|---|---|---|---|---|
| 前台 | 否 | 普通（登录后启动） | 保持 | 无 | 无 |
| 前台 | 是 | FGS（dataSync） | 保持 | 持有 | 有 |
| 后台 | 是 | FGS | 保持 | 持有 | 有 |
| 后台 | 否 | 停止 | 断开 | — | — |

**三集合分离**：

| 集合 | 用途 | 增 | 删 |
|---|---|---|---|
| `activeTrackedSessions` | 决定 FGS 运行与后台可靠缓冲 | `trackSessions`（发送前）；原生解析 tracked 父会话的 `side_session_created`/`subagent_session_created` 自动加入 | **仅原生状态机**：可信终态（含父子级联）/ REST 确认终态 / STARTING 超时回滚 / 退出登录 |
| `pendingRecoverySessions` | 终态但未 ACK 缓冲 / 需 REST 校准 | 会话进入终态且有未清缓冲 / 被标记校准 / onTimeout | recovery 完成（重放 + REST 校准成功）后清除 |
| `subscribedSessionIds`（JS 层） | 当前 UI 关注/展示 | `subscribe()` | `unsubscribe()`（关闭面板/切换会话）——**绝不触发 untrack** |

**父子任务关系**（v4 新增，原生维护）：
- `parentSessionId → Set<childSessionId>`；`childSessionId → parentSessionId`；
- 原生解析 `side_session_created`（data.sideSessionId）/ `subagent_session_created`（data.childSessionId），父 ∈ activeTracked 时自动加入父子映射与 activeTracked。

**级联收尾算法**（子任务终态后）：
```
子任务 C 进入终态（原生解析 session_status）：
  1. C 从 activeTracked 移除（未 ACK 缓冲 → 转入 pendingRecovery）；
  2. 从父 P 的子集合移除；
  3. 若 P 已终态 且 P 无其他活跃子任务：
       P 从 activeTracked 移除（未 ACK 缓冲 → pendingRecovery）；
       递归向上（P 的父任务）重复；
  4. activeTracked 为空：
       App 前台 → 降级普通模式（连接保持）
       App 后台 → 持久化未 ACK 缓冲 → 断开 WS → 释放 WakeLock → 停止 Service
       （pendingRecovery 元数据与磁盘缓冲保留，回前台恢复）
```

**untrack 最终裁决权在原生**（v4 新增）：
- 原生解析 `session_status` **自动**完成正常 ACTIVE → TERMINAL 转换；JS 不因普通 WS 终态直接强制 untrack；
- JS `untrackSessions(sessionIds, reason)` 仅用于：① 发送失败回滚；② REST 确认终态；③ 明确取消尚未启动的 STARTING；④ 退出登录（FORCE）；
- 原生校验后才生效：会话非 ACTIVE、无活跃子任务、无待恢复事件，或携带 FORCE（仅退出登录）；
- 即使 JS 调用 untrack，原生也按上述条件验证，不满足则拒绝并记录日志。

**原生内部阶段**（TrackedManager 维护，由原生解析 `session_status` 驱动）：

```
STARTING（trackSessions 后）
  │ 收到 session_status ∈ {RUNNING, RESUMING, WAITING_APPROVAL, CANCELLING}
  ▼
ACTIVE ──收到终态（含级联判定）──▶ TERMINAL ──未 ACK 缓冲未清──▶ RECOVERY_PENDING
  │                                                                │
  └──STARTING 超时（20s）仍无活跃 phase──┐                        └──recovery 完成──▶ 移除
                                          ▼
                     REST 查询会话状态 ──仍 IDLE──▶ 回滚 untrack + 集合空则降级/停止
```

**IDLE 泄漏防护**：`trackSessions` 进入 STARTING 即启动 20s 定时器；超时未收到活跃 phase → 原生 REST 查询 → 仍 IDLE（或任务启动失败）→ 回滚 untrack；集合为空 → 降级普通模式/停止。已处于 ACTIVE 的会话不因偶发 IDLE 事件直接清理（仅终态可清）。

**发送前预启动**（用户点击发送，前台）：
1. `trackSessions([sessionId])` → STARTING，Service 提升 FGS + WakeLock + 常驻通知；
2. 等待原生 WS OPEN（JS 侧超时 10s）；
3. 发送 `send_message`；失败不静默（`sendReliable` 语义）；失败 → JS 请求 untrack（reason=SEND_FAILED）；
4. 服务端回 `user_message_saved` + `session_status(RUNNING)` → 原生转 ACTIVE。

**服务停止判定**：`activeTrackedSessions` 为空 且 App 在后台 → 持久化未 ACK 缓冲 → 断开 WS → 释放 WakeLock → 停止 Service（pendingRecovery 元数据与磁盘缓冲保留）；App 在前台 → 仅降级普通模式，连接保持。退出登录 → 清订阅/缓冲/认证状态 → 立即停止。

### 5.5 通知点击跳转

- 终态通知 `PendingIntent.getActivity(MainActivity)`，`FLAG_IMMUTABLE | FLAG_UPDATE_CURRENT`，extras 携带 `sessionId`；
- 通知 ID 用 `sessionId.hashCode()`：会话级稳定，但**存在极低概率碰撞**——碰撞时可能覆盖另一会话的通知并使点击跳转指向后更新的会话，当前接受该风险（不声称"互不覆盖"，不引入持久化映射）；
- `MainActivity` 为 `singleTask`：冷启动 `getIntent()` / 热启动 `onNewIntent()` 提取 `sessionId` 存入 pending navigation（内存变量）；
- WebView/插件初始化完成后 `WsBridgePlugin` 发 `pendingNavigate` 事件，JS 消费后跳转对应会话并清除 pending。

### 5.6 Android 15 dataSync 超时（onTimeout）状态定义（v4 补充）

`Service.onTimeout(...)` 触发时：
1. `activeTracked` 中活跃会话**转入 `pendingRecovery`**（恢复元数据与磁盘缓冲保留）；
2. 持久化 `stopReason = DATA_SYNC_TIMEOUT`；
3. 释放 WakeLock、关闭 WebSocket、持久化未 ACK 缓冲、移除常驻通知；
4. **不再尝试把 Service 提升回同一类 FGS**；
5. 回前台：REST 查询各会话实际状态；若任务仍在运行，App 前台时用**普通连接继续收流**；
6. 仅**之后新的、明确由用户触发的任务**才开启新的 FGS 周期。

## 6. 实现步骤

### 6.1 后端（2 项，最小，均非保活前置条件）

1. `WebSocketConfig.java`：`setMaxSessionIdleTimeout` 改为 `@Value("${app.ws.idle-timeout-ms:90000}")`（application.yml 默认 90000，保持现状行为）。
2. `StreamingWsHandler.resolveClientType` 与 `StreamingWsRegistry.normalizeClientType`：识别 `"android"`（日志与能力区分）；非 electron 行为不变（仍 CLOUD 模式，无 `tool_execute` 下发）。

> 后端改动需发版生效，重启动作由用户执行（遵循 CLAUDE.md 禁令）。

### 6.2 安卓原生层（`android/android/app/src/main/java/cn/etarch/mao/app/`）

1. **`WsKeepAliveService.java`**（`onStartCommand` 返回 `START_NOT_STICKY`）：
   - 生命周期矩阵：普通 ↔ FGS（`startForeground(id, notif, FOREGROUND_SERVICE_TYPE_DATA_SYNC)`）↔ 停止；降级/停止时释放 WakeLock、移除常驻通知；
   - OkHttp 建连；25s 应用层 `{"type":"ping"}`；记录 `pong` 时间，40s 无 pong 主动 close 重连；
   - 重连退避 1s→30s；`ConnectivityManager` 网络恢复立即重连；认证失败停止重连并标记"需重新登录"；
   - 重连成功自动重订阅（subscriptions 集合持久化）；
   - 事件分发：按路由矩阵（§5.2.2）→ `PendingQueue` / 实时转发 / 忽略；
   - 原生解析 `side_session_created` / `subagent_session_created` 自动 track 子会话并维护父子映射；
   - `onTimeout`（Android 15）：按 §5.6 处理。
2. **`WsBridgePlugin.java`**（`@CapacitorPlugin`）：
   - 方法：`ensureKeepAlive({token, wsUrl})`、`stopKeepAlive()`、`trackSessions({sessionIds})`、`untrackSessions({sessionIds, reason})`、`syncSubscriptions({sessionIds})`、`send({message})`、`ackEvents({seq})`、`jsAlive()`、`beginRecovery()`、`completeRestSync({recoveryId, sessionIds})`、`completeRecovery({recoveryId})`、`abortRecovery({recoveryId})`；
   - 事件：`wsEvent`（消息 + sequence）、`wsStatus`（open/close/reconnecting/auth_failed）、`replayDone`、`pendingNavigate`（sessionId）、`keepAliveStopped`（reason）；
   - `ensureKeepAlive` 校验 `wsUrl`：仅 `wss://` 且 host=`mao.etarch.cn`、path 前缀 `/api/ws/stream`，否则拒绝并记日志；
   - 日志脱敏：不打完整 URL 与 token；token 仅内存持有（不写普通 SharedPreferences）；
   - 退出登录 `stopKeepAlive` 时清除订阅、缓冲文件与内存 token；缓冲目录 `noBackupFilesDir/buffered-events/<userId>/` 按用户隔离，换账号清空旧用户缓冲。
3. **`PendingQueue.java`**（待确认队列 + ACK + tombstone + 磁盘 + 元数据持久化）：
   - 全局 sequence（冷启动从 `max(meta.nextSequence, 文件最大 seq + 1)` 恢复）；
   - 内存 `ConcurrentLinkedQueue<EventRecord(seq, sessionId, json)>`；后台模式追加写 `events.jsonl`（tmp + fsync + 原子 rename）；
   - `ackEvents(seq)` 后移除已 ACK 记录；skipped 集合记录 tombstone；ACK 水位 = 最大连续「ACK ∪ skipped」；
   - `meta.json` 持久化：nextSequence / lastAckSequence / tombstoneRanges / restSyncRequiredSessionIds / pendingRecoverySessions / activeTrackedSnapshot / stopReason（tmp + fsync + 原子 rename）；
   - 冷启动恢复算法 + 不一致检测（§5.2.3）；
   - 每会话未 ACK 上限 5000 条 / 10MB，溢出丢最旧并记 tombstone + 标记该会话 REST 校准；
   - 磁盘文件在 `completeRecovery` 时 compact（失败保留原文件，下次重试）；冷启动清理 >24h 孤儿缓冲文件。
4. **`TrackedManager.java`**：三集合 + 父子映射（SharedPreferences/meta.json 持久化含 phase 缓存）；原生解析 `session_status` 维护阶段（STARTING→ACTIVE→TERMINAL→RECOVERY_PENDING）；STARTING 20s 超时 → REST 查询回滚；子会话自动 track 与级联收尾（§5.4）；untrack 原生裁决（校验非 ACTIVE / 无活跃子任务 / 无待恢复 / FORCE）。
5. **`RecoveryCoordinator.java`**（v4 新增）：recovery 原子协议（单 recovery 约束、recoveryId 生成与校验、SYNC 模式开关、水位记录、30s 超时兜底、REST 部分失败保留）。
6. **`AppNotification.java`**：双 channel；常驻通知（仅 FGS）；终态通知（完成/失败/取消 + 摘要，PendingIntent 带 sessionId）。
7. **`MainActivity.java`**：注册 `WsBridgePlugin`；`onNewIntent`/`getIntent` 的 sessionId → pending navigation；首次任务时请求 `POST_NOTIFICATIONS`。
8. **`AndroidManifest.xml`**：声明 `WsKeepAliveService`（`android:foregroundServiceType="dataSync"`）+ 4 个权限。
9. **`build.gradle`**：`implementation("com.squareup.okhttp3:okhttp:4.12.0")`。

### 6.3 前端（`desktop/`，仅 Capacitor 平台生效）

1. **`desktop/src/capacitor/wsBridge.ts`**：
   - WebSocket 兼容接口：`readyState`、`send(data)`、`close()`、`onopen/onmessage/onclose/onerror`；
   - 内部调 `window.Capacitor.Plugins.MaoWs`：`ensureKeepAlive/trackSessions/untrackSessions/syncSubscriptions/send/ackEvents/jsAlive/beginRecovery/completeRestSync/completeRecovery/abortRecovery`；监听 `wsEvent→onmessage`、`wsStatus→onopen/onclose/auth_failed`、`pendingNavigate`；
   - 去重：维护 `lastAppliedSeq`（WebView 生命周期内）；`seq <= lastAppliedSeq` 只 ACK 不路由；事件按 sequence 串行交给 `routeEvent`，成功后更新 `lastAppliedSeq` 并累计 ACK；
   - 非 Capacitor 平台返回 `null`。
2. **`useStreamWS.ts` 改造**：
   - 连接建立：Capacitor 平台用 `createWsBridge(token, wsUrl)` 替代 `new WebSocket(url)`（`isAndroidCapacitor()` 判定）；
   - 心跳：Capacitor 平台停用 JS 侧 5s 心跳/15s pong 超时（原生负责）；
   - 发送前预启动：Capacitor 平台发送前确保 `trackSessions` 已调用且 `readyState===OPEN`，否则等待（超时 10s 报错，不静默丢弃）；`sendReliable` 语义保持；
   - `subscribe/unsubscribe` 保持 UI 订阅语义（不触发 untrack）；`trackSessions` 在发送时调用；**不因普通 WS 终态主动 untrack**（由原生状态机处理），仅发送失败回滚 / REST 确认终态 / 取消 STARTING 时携带 reason 调用；
   - `jsAlive()`：前台每 10s 调用一次；
   - `close()` 语义：Capacitor 平台仅解绑 WebView 层（不停止原生 Service）；真正停止仅由退出登录 / activeTracked 全部终态且 App 后台触发（`stopKeepAlive`）；
   - 收到 `keepAliveStopped`/`auth_failed` 时按场景提示或引导重新登录。
3. **回前台协调器 `useAppResumeSync.ts`**（新增，Capacitor 平台）：
   - 监听 Capacitor App `appStateChange(active=true)`；
   - 执行 §5.3 recovery 协议：`connect()` → `beginRecovery()` → 重放（ACK）→ 对 restSync 会话 REST 权威快照覆盖 → `completeRestSync` → 补放水位后新事件 → `completeRecovery`；
   - recovery 异常（超时/abort）时保留未完成会话待下次；
   - 清理 `activeTracked`/`pendingRecovery` 后按生命周期矩阵收尾；
   - 消费 `pendingNavigate` 跳转对应会话。

### 6.4 构建与验证

1. 更新根 `CHANGELOG.md`（`### 安卓原生` / `### 前端（桌面 / Web / 安卓）` / `### 后端`）；
2. `cd android && bash build-apk.sh` 构建发布（沿用现有 OTA 链路）；
3. 真机验证（见落地清单第 14 条）。

## 7. 落地清单

| # | 任务 | 产出 | 依赖 |
|---|---|---|---|
| 1 | 后端：`app.ws.idle-timeout-ms` 配置化（默认 90s）；client=android 识别 | WebSocketConfig / StreamingWsHandler / StreamingWsRegistry | 用户执行重启生效 |
| 2 | 原生：`WsKeepAliveService`（生命周期矩阵/连接/心跳+pong/重连/网络切换/认证失败/唤醒锁/订阅恢复/onTimeout） | Service 类 | — |
| 3 | 原生：`PendingQueue`（sequence + ACK + tombstone + 磁盘 JSONL + meta.json 持久化 + 崩溃恢复 + 溢出标记 + compact） | 队列类 | #2 |
| 4 | 原生：`TrackedManager`（三集合分离 + 父子映射 + 级联收尾 + 原生阶段状态机 + STARTING 超时回滚 + untrack 裁决） | 管理器类 | #2 |
| 5 | 原生：`RecoveryCoordinator`（beginRecovery/completeRestSync/completeRecovery/abortRecovery + 单 recovery + recoveryId 校验 + 超时兜底） | 协调器类 | #2~#4 |
| 6 | 原生：`WsBridgePlugin` + MainActivity 注册（pending navigation、POST_NOTIFICATIONS 请求） | 插件类 + 注册 | #2~#5 |
| 7 | 原生：通知双 channel + 终态通知 + PendingIntent 跳转 | AppNotification 类 | #2 |
| 8 | Manifest 权限与 Service 声明（dataSync）+ build.gradle 引入 OkHttp | Manifest / gradle | #2~#7 |
| 9 | 前端：`wsBridge.ts`（兼容接口 + lastAppliedSeq 去重 + 串行 routeEvent + recovery 方法封装） | 前端改动 | #6 |
| 10 | 前端：`useStreamWS` 平台分流（预启动 + track/untrack 语义 + 心跳停用 + close 语义） | 前端改动 | #9 |
| 11 | 前端：`useAppResumeSync`（recovery 协议 + REST 校准 + pendingNavigate 消费） | 前端改动 | #10 |
| 12 | CHANGELOG + `build-apk.sh` 构建发布 | APK + OTA | #1~#11 |
| 13 | 单元/集成测试：PendingQueue 冷启动恢复（sequence 续推/损坏检测）、tombstone ACK 水位、RecoveryCoordinator 单 recovery/超时/部分失败、TrackedManager 级联收尾 | 测试报告 | #3~#5 |
| 14 | 真机验收：前台空闲连接保持（无通知）；发起任务→FGS 常驻通知+锁屏收流；终态通知+冷启动/热启动跳转；限后台进程→回前台 recovery 重放+REST 校准；断网/切网重连；后台无任务断开；多端同时在线路由矩阵；UI 关闭面板不停服务；后台创建 side task/subagent 原生自动 track；STARTING 超时回滚；杀进程冷启动后缓冲续放不冲突；换账号不重放旧缓冲；Android 15 onTimeout 后状态与恢复 | 验收记录 | #12 |

## 8. 风险与注意事项

| 风险 | 影响 | 应对（已确认） |
|---|---|---|
| 深度 Doze 网络挂起 | 实时性降级为间歇窗口 | 已确认不做白名单引导；FGS + 唤醒锁尽量推迟 Doze；回前台 recovery + REST 校准，最终状态不丢 |
| 国产 ROM 杀后台 / 用户强制停止 | 保活中断 | 已确认不做白名单引导与 START_STICKY；回前台重连 + recovery + REST 校准 |
| 前台空闲普通 Service 被系统回收（内存压力） | 前台浏览时连接中断 | 回前台/回应用自动重建连接；前台进程被回收用户可见，可接受 |
| **进程被杀冷启动后 sequence 冲突 / ACK 水位丢失** | 缓冲重放错乱 | meta.json 持久化 + 冷启动恢复算法：`nextSequence = max(meta, 文件最大 seq + 1)`；不一致保守标记 REST 校准（§5.2.3） |
| **崩溃时数据文件/元数据不一致** | 缓冲损坏 | tmp + fsync + 原子 rename；compact 失败保留原文件；不一致时 REST 校准兜底 |
| ACK 丢失 + WebView 重载（at-least-once） | 极端窗口重复应用事件 | 前端 lastAppliedSeq 去重（WebView 生命周期内）+ 串行 routeEvent；REST 权威覆盖修复持久化消息；临时 UI 活动不保证完全修复（已确认接受） |
| 缓冲溢出 | 中间流式事件丢失 | tombstone + 标记 REST 校准，回前台拉取持久化消息与最终状态；中间过程不承诺还原 |
| 单会话溢出导致全局 ACK 空洞 | 全局队列无法 compact | tombstone/skipped 集合，ACK 水位允许空洞前移（§5.2.1） |
| STARTING 后收不到 RUNNING（建连失败/服务端拒绝/用户取消） | 前台服务泄漏 | STARTING 20s 超时 → REST 查询 → 回滚 untrack + 集合空降级/停止（§5.4） |
| JS 按父会话终态误 untrack，子任务仍活跃 | 子任务进度丢失 / 保活提前结束 | untrack 裁决权在原生：校验非 ACTIVE / 无活跃子任务 / 无待恢复 / FORCE；父子级联收尾（§5.4） |
| 后台创建的 side task/subagent 未被 track | 子任务进度丢失 | 原生解析 `side_session_created`/`subagent_session_created` 自动 track + 父子映射（§5.4） |
| UI 关闭会话面板误停服务 | 运行中任务停止缓冲 | tracked 与 UI 订阅分离，`unsubscribe()` 不触发 untrack（§5.4） |
| recovery 永久停在 SYNC（JS 异常） | 事件不实时 | 30s 超时强制解除屏障；未完成会话保留待下次（§5.3） |
| REST 部分会话失败 | 该会话状态未校准 | `completeRestSync` 只清成功会话；失败保留 pendingRecovery 待下次（§5.3） |
| 断线期间任务完成 | 无终态通知（本地通知依赖连接） | 接受；回前台查看会话终态 + REST 校准 |
| token 过期 / 认证失败 | 原生重连被拒绝 | 原生停止重连并标记 auth_failed；回前台 JS 重新登录后重新 ensureKeepAlive |
| 电量消耗 | 任务执行时段 FGS + 唤醒锁 + 常驻通知 | 仅任务执行时段；降级/停止即释放；前台空闲普通模式无 WakeLock 无常驻通知 |
| 多端同时在线 | 服务端按 userId 广播，安卓收到其他端事件 | 路由矩阵：tracked 决定后台缓冲/通知；前台按现有行为转发；其他端非 tracked 非 subscribed 忽略（§5.2.2） |
| Android 15 dataSync 累计时长限制 | 长任务后台被系统终止 | `onTimeout`：活跃→pendingRecovery + stopReason + 释放资源 + 不重复提升 FGS + 回前台 REST 查询 + 仅新任务开新 FGS（§5.6） |
| `POST_NOTIFICATIONS` 被拒（Android 13+） | 通知展示受限 | 首次任务请求一次；被拒后前台服务**仍需创建通知**（系统要求），其展示位置与可见性受权限影响（不同版本表现不同），服务照常运行 |
| 通知 ID hashCode 碰撞（不同 sessionId） | 通知互相覆盖 / 跳转指向后更新会话 | 极低概率，当前接受该风险（不引入持久化映射）（§5.5） |
| 通知点击跳转丢失（冷启动/监听未注册） | 用户点击无反应 | pending navigation 机制：getIntent/onNewIntent 保存，JS 就绪后消费 |
| XSS 利用插件发令牌 | token 被发往任意地址 | `wss://` + host/path 白名单；token 内存持有不落盘；日志脱敏 |
| 换账号重放旧缓冲 | 隐私泄漏 | 缓冲按 userId 隔离；退出登录清除缓冲 |
| 系统备份恢复缓冲文件 | 隐私泄漏 | 缓冲放 `noBackupFilesDir`，不进系统备份 |
| 后端发版重启 | 改动需生效 | 遵循 CLAUDE.md，重启动作由用户执行 |

## 9. 明确不做事项（防止范围蔓延）

1. 不做电池优化白名单引导（Doze 豁免）与国产 ROM 自启动/白名单引导；
2. 不做进程被杀自动恢复（START_STICKY）、双进程守护、音频保活、WorkManager 轮询等非常规保活手段；
3. 不做保活总开关；
4. 不做系统/厂商推送（FCM / 华为 / 小米等），终态通知为本地通知；
5. 不做服务端离线事件补发 / 会话执行增量接口；
6. 不承诺中间流式事件（content_delta/思考增量/工具参数增量）绝对零丢失——尽力保留，溢出/断线后仅保证持久化消息与最终状态经重放 + REST 恢复；
7. 不承诺严格无重复（exactly-once）——至少一次语义 + 前端去重（WebView 生命周期内），正常路径无重复；
8. 不做后台且无活跃任务时的连接常驻（后台无任务即断开省电）；
9. 不做 Web / Electron 的任何行为改动（桥接仅在 Capacitor 平台启用）；
10. 后端不全局放宽空闲超时（仅配置化，默认值不变）；`client=android` 识别仅作日志/能力区分，非保活前置；
11. 不改动 minSdk/targetSdk、不引入除 OkHttp 外的第三方库；
12. 缓冲元数据不用数据库/SQLite（JSON 文件 + 原子 rename 足够）；
13. 不为通知 ID 建立持久化去碰撞映射（接受 hashCode 极低概率碰撞）。
