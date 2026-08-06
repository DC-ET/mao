package cn.etarch.mao.app;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * 后台保活前台服务（dataSync）：
 * - 生命周期矩阵：普通（前台空闲，登录后启动，保持连接）↔ FGS（tracked 活跃，WakeLock+常驻通知）
 *   ↔ 停止（后台且无活跃任务 / 退出登录）
 * - OkHttp WebSocket 唯一连接（client=android），25s 应用层 ping / 40s pong 超时主动重连
 * - 重连退避 1s→30s；网络切换立即重连；认证失败停止重连（回前台重新登录后恢复）
 * - 事件路由矩阵：tracked 决定后台可靠缓冲与通知；前台按现有行为实时转发；其他忽略
 * - 原生解析 side_session_created / subagent_session_created 自动 track 子会话
 * - STARTING 超时（20s）→ REST 查询会话状态 → 仍 IDLE 回滚 untrack
 * - Android 15 dataSync 累计时长超时：onTimeout → 活跃转 pendingRecovery + 释放资源 + 停止
 *
 * 停止保活 ≠ 删除恢复元数据：pendingRecovery 与磁盘缓冲保留，回前台 recovery 恢复。
 */
public class WsKeepAliveService extends Service {

    private static final String TAG = "MaoKeepAlive";

    private static final long HEARTBEAT_INTERVAL_MS = 25_000;
    private static final long PONG_TIMEOUT_MS = 40_000;
    private static final long RECONNECT_BASE_MS = 1_000;
    private static final long RECONNECT_MAX_MS = 30_000;
    private static final long JS_ALIVE_TIMEOUT_MS = 30_000;
    private static final long STARTING_TIMEOUT_MS = 20_000;
    private static final long REST_TIMEOUT_MS = 8_000;

    private static final String HOST_ALLOWED = "mao.etarch.cn";
    private static final String PATH_PREFIX = "/api/ws/stream";

    public static final String REASON_ALL_TERMINAL = "all_terminal";
    public static final String REASON_BACKGROUND_IDLE = "background_idle";
    public static final String REASON_AUTH_FAILED = "auth_failed";
    public static final String REASON_DATA_SYNC_TIMEOUT = "data_sync_timeout";
    public static final String REASON_LOGOUT = "logout";

    /** JS 事件监听器（由 WsBridgePlugin 注册） */
    public interface EventListener {
        void onWsEvent(long seq, String messageJson);
        void onWsStatus(String status, String detail);
        void onReplayDone();
        void onKeepAliveStopped(String reason);
        void onPendingNavigate(long sessionId);
    }

    private static WsKeepAliveService instance;

    public static WsKeepAliveService getInstance() {
        return instance;
    }

    // ---------------- 组件 ----------------
    private PendingQueue queue;
    private TrackedManager tracked;
    private RecoveryCoordinator recovery;
    private AppNotification notifier;
    private EventListener listener;

    // ---------------- 连接状态 ----------------
    private OkHttpClient okHttpClient;
    private WebSocket webSocket;
    private volatile String token;      // 仅内存持有，不落盘
    private volatile String wsUrl;
    private volatile boolean authFailed;
    private volatile long lastPongAt;
    private volatile boolean wsOpen;
    /** 建连进行中（防并发重复创建 WebSocket） */
    private volatile boolean wsConnecting = false;
    /** 连接代数：旧连接回调据此失效，避免覆盖新连接状态 */
    private volatile int wsGeneration = 0;

    // ---------------- 生命周期状态 ----------------
    private volatile boolean appForeground = true;
    private volatile long lastJsAliveAt = System.currentTimeMillis();
    private volatile boolean fgsActive = false;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable heartbeatTask = new Runnable() {
        @Override
        public void run() {
            if (!isRunning()) return;
            WebSocket ws = webSocket;
            if (wsOpen && ws != null) {
                if (System.currentTimeMillis() - lastPongAt > PONG_TIMEOUT_MS) {
                    Log.w(TAG, "pong timeout, force close and reconnect");
                    ws.cancel();
                } else {
                    ws.send("{\"type\":\"ping\"}");
                }
            }
            handler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
        }
    };

    private final Runnable startingTimeoutCheck = new Runnable() {
        @Override
        public void run() {
            // 每个 STARTING 会话的超时检查在 trackSessions 时按会话分别调度
        }
    };

    // ---------------- 重连 ----------------
    private int reconnectAttempts = 0;
    private boolean reconnectScheduled = false;
    private final Runnable reconnectTask = new Runnable() {
        @Override
        public void run() {
            reconnectScheduled = false;
            if (isRunning() && !authFailed) connectWebSocket();
        }
    };

    private ConnectivityManager.NetworkCallback networkCallback;

    // ---------------- WakeLock ----------------
    private PowerManager.WakeLock wakeLock;

    // ---------------- 生命周期 ----------------

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        notifier = new AppNotification(this);
        okHttpClient = new OkHttpClient.Builder()
                .pingInterval(0, TimeUnit.SECONDS) // 应用层心跳由自己控制
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .build();
        registerNetworkCallback();
        Log.i(TAG, "WsKeepAliveService created");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String token = intent.getStringExtra("token");
            String wsUrl = intent.getStringExtra("wsUrl");
            if (token != null && wsUrl != null) {
                ensureKeepAlive(token, wsUrl);
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        instance = null;
        handler.removeCallbacksAndMessages(null);
        unregisterNetworkCallback();
        releaseWakeLock();
        if (webSocket != null) {
            webSocket.close(1000, "service destroyed");
            webSocket = null;
        }
        Log.i(TAG, "WsKeepAliveService destroyed");
    }

    // ---------------- Android 15 dataSync 超时 ----------------

    @Override
    public void onTimeout(int startId, int fgsType) {
        Log.w(TAG, "dataSync FGS timeout (Android 15)");
        // 活跃会话转入 pendingRecovery（恢复元数据与磁盘缓冲保留）
        if (tracked != null) {
            tracked.suspendForTimeout();
        }
        releaseFgs();
        stopKeepAliveInternal(REASON_DATA_SYNC_TIMEOUT, false);
    }

    // ---------------- 对外控制（插件调用） ----------------

    // ---------------- 心跳 / WebView 存活 ----------------
    private boolean heartbeatStarted = false;
    private boolean aliveCheckStarted = false;

    public void ensureKeepAlive(String token, String wsUrl) {
        if (authFailed) {
            Log.i(TAG, "ensureKeepAlive after auth_failed, reset");
            authFailed = false;
        }
        if (this.token == null || !this.token.equals(token)) {
            this.token = token;
            long userId = parseUserIdFromToken(token);
            if (queue == null || !queue.getDir().getName().equals(String.valueOf(userId))) {
                // 换账号：清空旧用户缓冲，按 userId 重建
                if (queue != null) queue.clearAll();
                if (tracked != null) tracked.clearAll();
                queue = new PendingQueue(this, userId);
                tracked = new TrackedManager(this, userId, this::onActiveTrackedEmpty);
                recovery = new RecoveryCoordinator(queue, tracked, this::onSyncReleased);
            }
        }
        this.wsUrl = wsUrl;
        lastJsAliveAt = System.currentTimeMillis();
        // 消费通知点击冷启动跳转：Service 此前不存在时 sessionId 暂存于 MainActivity，
        // 前端 connect → ensureKeepAlive 时补发（Service 内部 pendingNavigate 补发机制保证送达 JS）
        long nav = MainActivity.consumePendingNavigationSessionId();
        if (nav > 0) {
            notifyPendingNavigate(nav);
        }
        // 监听器补注册：首次进程启动时插件 load() 早于 Service 创建，事件回传需在此反向绑定
        if (listener == null) {
            WsBridgePlugin p = WsBridgePlugin.getInstance();
            if (p != null) {
                registerEventListener(p);
            }
        }
        if (!heartbeatStarted) {
            heartbeatStarted = true;
            handler.postDelayed(heartbeatTask, HEARTBEAT_INTERVAL_MS);
        }
        if (!aliveCheckStarted) {
            aliveCheckStarted = true;
            handler.post(this::checkWebViewAlive);
        }
        if (wsOpen) {
            // WebView 刷新/重建后，JS 侧是新桥（readyState=CONNECTING，等待 open 才 resolve connect()），
            // 而原生连接仍保持（后台保活设计，刷新不销毁 Service）。主动补发一次 open，
            // 让新 JS 桥立即感知连接就绪，避免 connect() 一直 pending 到超时、消息加载被阻塞。
            notifyStatus("open", "reused");
        } else {
            connectWebSocket();
        }
    }

    public synchronized void stopKeepAlive(String reason) {
        stopKeepAliveInternal(reason, true);
    }

    private void stopKeepAliveInternal(String reason, boolean clearAll) {
        if (clearAll) {
            if (queue != null) queue.clearAll();
            if (tracked != null) tracked.clearAll();
        }
        releaseFgs();
        closeWebSocket();
        handler.removeCallbacksAndMessages(null);
        if (listener != null) {
            listener.onKeepAliveStopped(reason);
        }
        stopSelf();
    }

    /** MainActivity onStart/onStop 通知前后台。 */
    public static void setAppForeground(boolean foreground) {
        WsKeepAliveService svc = instance;
        if (svc != null) svc.onAppForegroundChanged(foreground);
    }

    private void onAppForegroundChanged(boolean foreground) {
        appForeground = foreground;
        Log.i(TAG, "appForeground=" + foreground);
        if (foreground) {
            lastJsAliveAt = System.currentTimeMillis();
        } else {
            // 进入后台：立即进入持久化缓冲模式（不等 jsAlive 超时）
            if (queue != null) queue.setPersistMode(true);
        }
        evaluateServiceMode();
    }

    /** JS 前台心跳（每 10s）。 */
    public void jsAlive() {
        lastJsAliveAt = System.currentTimeMillis();
        if (queue != null) queue.setPersistMode(false);
    }

    /** JS 判定 WebView 冻结：持续收事件但写盘（由内部定时扫描触发）。 */
    private void checkWebViewAlive() {
        boolean alive = System.currentTimeMillis() - lastJsAliveAt < JS_ALIVE_TIMEOUT_MS;
        if (queue != null) {
            queue.setPersistMode(!alive);
        }
        handler.postDelayed(this::checkWebViewAlive, JS_ALIVE_TIMEOUT_MS);
    }

    // ---------------- tracked 控制 ----------------

    public void trackSessions(Set<Long> sessionIds) {
        if (tracked == null) return;
        tracked.trackSessions(sessionIds);
        evaluateServiceMode();
        // STARTING 超时回滚检查
        for (Long id : sessionIds) {
            handler.postDelayed(() -> {
                if (tracked != null && tracked.getState(id) != null) {
                    checkStartingTimeout(id);
                }
            }, STARTING_TIMEOUT_MS);
        }
    }

    public void untrackSessions(Set<Long> sessionIds, boolean force) {
        if (tracked == null) return;
        tracked.untrackSessions(sessionIds, force);
        evaluateServiceMode();
    }

    public void syncSubscriptions(Set<Long> sessionIds) {
        if (tracked == null) return;
        tracked.syncSubscriptions(sessionIds);
    }

    private void onActiveTrackedEmpty() {
        evaluateServiceMode();
    }

    /** tracked 集合变空或前后台变化时的模式评估。 */
    private void evaluateServiceMode() {
        if (tracked == null) return;
        boolean hasActive = !tracked.getActiveTrackedIds().isEmpty();
        if (hasActive) {
            requestFgs();
        } else {
            if (appForeground) {
                releaseFgs(); // 前台空闲：降级普通模式，保持连接
            } else {
                // 后台且无活跃任务：停止服务（pendingRecovery 元数据与磁盘缓冲保留）
                stopKeepAliveInternal(REASON_BACKGROUND_IDLE, false);
            }
        }
    }

    private void requestFgs() {
        if (fgsActive) return;
        try {
            Notification n = notifier.buildKeepAlive("Agent 任务执行中", "后台实时接收流式输出");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(AppNotification.NOTIF_ID_KEEPALIVE, n,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(AppNotification.NOTIF_ID_KEEPALIVE, n,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(AppNotification.NOTIF_ID_KEEPALIVE, n);
            }
            fgsActive = true;
            acquireWakeLock();
            Log.i(TAG, "FGS started");
        } catch (Exception e) {
            Log.w(TAG, "startForeground failed: " + e.getMessage());
        }
    }

    private void releaseFgs() {
        if (!fgsActive) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (Exception e) {
            Log.w(TAG, "stopForeground failed: " + e.getMessage());
        }
        fgsActive = false;
        releaseWakeLock();
        notifier.cancelKeepAlive();
        Log.i(TAG, "FGS released (normal mode)");
    }

    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (wakeLock == null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mao:ws_keepalive");
            }
            wakeLock.acquire();
        } catch (Exception e) {
            Log.w(TAG, "acquireWakeLock failed: " + e.getMessage());
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
    }

    // ---------------- WebSocket ----------------

    private void connectWebSocket() {
        if (token == null || wsUrl == null || authFailed) return;
        if (!validateWsUrl(wsUrl)) {
            Log.w(TAG, "wsUrl rejected by whitelist");
            authFailed = true;
            notifyStatus("auth_failed", "invalid ws url");
            return;
        }
        // 防并发建连：正常重连任务与网络可用回调可能同时触发，重复创建会双连接重复收事件
        if (wsConnecting || wsOpen) {
            Log.d(TAG, "connectWebSocket skipped (connecting=" + wsConnecting + " open=" + wsOpen + ")");
            return;
        }
        wsConnecting = true;
        final int gen = ++wsGeneration;
        String url = wsUrl + "?token=" + token + "&client=android";
        Request request = new Request.Builder().url(url).build();
        Log.i(TAG, "connecting ws (url masked)");
        webSocket = okHttpClient.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                if (gen != wsGeneration) return; // 旧连接回调，忽略
                Log.i(TAG, "ws open");
                wsConnecting = false;
                wsOpen = true;
                reconnectAttempts = 0;
                lastPongAt = System.currentTimeMillis();
                handler.post(() -> {
                    notifyStatus("open", null);
                    // 重连后自动重订阅
                    if (tracked != null) {
                        for (Long sid : tracked.getSubscriptions()) {
                            ws.send("{\"type\":\"subscribe\",\"sessionId\":" + sid + "}");
                        }
                    }
                    if (queue != null) queue.setPersistMode(!appForeground);
                });
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                if (ws != webSocket) return; // 旧连接消息，忽略
                handler.post(() -> handleServerMessage(text));
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                if (gen != wsGeneration) return; // 旧连接回调，忽略
                Log.i(TAG, "ws closed code=" + code + " reason=" + reason);
                wsConnecting = false;
                wsOpen = false;
                if (code == 1008) { // POLICY_VIOLATION → 认证/权限失败
                    authFailed = true;
                    notifyStatus("auth_failed", "server closed " + code);
                    return;
                }
                if (code == 1000 || code == 1001) {
                    notifyStatus("close", reason);
                    return;
                }
                scheduleReconnect();
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                if (gen != wsGeneration) return; // 旧连接回调，忽略
                Log.w(TAG, "ws failure: " + t.getMessage()
                        + (response != null ? " http=" + response.code() : ""));
                wsConnecting = false;
                wsOpen = false;
                if (response != null && (response.code() == 401 || response.code() == 403)) {
                    authFailed = true;
                    notifyStatus("auth_failed", "http " + response.code());
                    return;
                }
                scheduleReconnect();
            }
        });
        reconnectScheduled = false;
        notifyStatus("reconnecting", "connecting");
    }

    private boolean validateWsUrl(String url) {
        try {
            java.net.URI uri = java.net.URI.create(url);
            if (!"wss".equalsIgnoreCase(uri.getScheme())) return false;
            if (!HOST_ALLOWED.equalsIgnoreCase(uri.getHost())) return false;
            String path = uri.getPath() != null ? uri.getPath() : "";
            return path.startsWith(PATH_PREFIX);
        } catch (Exception e) {
            return false;
        }
    }

    private void scheduleReconnect() {
        if (authFailed || !isRunning()) return;
        if (reconnectScheduled) return;
        reconnectScheduled = true;
        long delay = Math.min(RECONNECT_BASE_MS * (1L << Math.min(reconnectAttempts, 5)), RECONNECT_MAX_MS);
        reconnectAttempts++;
        notifyStatus("reconnecting", "delay=" + delay);
        handler.postDelayed(reconnectTask, delay);
    }

    private void notifyStatus(String status, String detail) {
        if (listener != null) listener.onWsStatus(status, detail);
    }

    private boolean isRunning() {
        return instance == this;
    }

    private void closeWebSocket() {
        wsOpen = false;
        wsConnecting = false;
        wsGeneration++; // 使旧连接回调失效，防止其覆盖新连接状态
        if (webSocket != null) {
            try {
                webSocket.close(1000, "stopped");
            } catch (Exception ignored) {
            }
            webSocket = null;
        }
    }

    // ---------------- 消息处理（路由矩阵） ----------------

    private void handleServerMessage(String text) {
        if (queue == null || tracked == null || recovery == null) return;
        try {
            JSONObject msg = new JSONObject(text);
            String type = msg.optString("type", "");
            long sessionId = msg.has("sessionId") ? msg.getLong("sessionId") : -1;

            // 控制事件：原生内部处理，不进队列
            if ("connected".equals(type) || "pong".equals(type)) {
                if ("pong".equals(type)) lastPongAt = System.currentTimeMillis();
                return;
            }

            // 子会话自动 track：side_session_created / subagent_session_created
            if (("side_session_created".equals(type) || "subagent_session_created".equals(type)) && sessionId > 0) {
                long child = "side_session_created".equals(type)
                        ? msg.getJSONObject("data").optLong("sideSessionId", -1)
                        : msg.getJSONObject("data").optLong("childSessionId", -1);
                if (child > 0) {
                    tracked.registerSubSession(sessionId, child);
                }
            }

            // 路由判定快照：必须在状态机更新之前记录——终态事件会将会话移出 activeTracked，
            // 若之后才判定则终态事件既不进队列也不转发（后台丢失）
            boolean trackedSid = sessionId > 0 && tracked.isTrackedActive(sessionId);
            boolean subscribedSid = sessionId > 0 && tracked.getSubscriptions().contains(sessionId);

            // session_status：驱动状态机 + 终态通知
            // 注意：终态事件必须先入队、后驱动状态机——onSessionStatus 会把会话移出
            // activeTracked，若先移出再判定路由，终态事件既不进可靠队列也不转发（后台丢失）。
            if ("session_status".equals(type) && sessionId > 0) {
                String phase = msg.optJSONObject("data") != null
                        ? msg.optJSONObject("data").optString("phase", "") : "";
                long seq = -1;
                if (trackedSid) {
                    seq = queue.append(sessionId, text);
                }
                boolean isTracked = trackedSid || tracked.getPendingRecovery().contains(sessionId);
                tracked.onSessionStatus(sessionId, phase, queue.hasPending(sessionId));
                if (isTracked && TrackedManager.TERMINAL_PHASES.contains(phase)) {
                    notifyTaskTerminal(sessionId, phase);
                }
                if (seq >= 0) {
                    routeForward(seq, text);
                } else if (subscribedSid && appForeground) {
                    // subscribed 未 tracked 会话：保持前台实时转发
                    dispatchToJs(-1, text);
                }
                return;
            }

            // 通用路由矩阵（tracked → 可靠队列；subscribed 未 tracked → 前台实时转发）
            if (sessionId > 0) {
                if (trackedSid) {
                    long seq = queue.append(sessionId, text);
                    routeForward(seq, text);
                } else if (subscribedSid && appForeground) {
                    dispatchToJs(-1, text);
                }
                // 非 tracked 非 subscribed（后台）：忽略
            } else {
                // 无 sessionId 用户级事件：前台实时转发
                if (appForeground) {
                    dispatchToJs(-1, text);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "handle message error: " + e.getMessage());
        }
    }

    /** 前台实时转发（SYNC 期间水位内事件由重放统一处理，这里跳过避免重复）。 */
    private void routeForward(long seq, String text) {
        if (seq < 0) return;
        boolean webViewAlive = System.currentTimeMillis() - lastJsAliveAt < JS_ALIVE_TIMEOUT_MS;
        boolean inSync = recovery.isInSync();
        if (webViewAlive && !inSync) {
            dispatchToJs(seq, text);
        } else if (webViewAlive && inSync && seq <= recovery.getWatermark()) {
            // SYNC 期间水位内事件：由 beginRecovery 重放逻辑统一处理
        }
    }

    private void dispatchToJs(long seq, String messageJson) {
        if (listener != null) listener.onWsEvent(seq, messageJson);
    }

    private void notifyTaskTerminal(long sessionId, String phase) {
        String title;
        switch (phase) {
            case "COMPLETED": title = "任务已完成"; break;
            case "FAILED": title = "任务失败"; break;
            case "CANCELLED": title = "任务已取消"; break;
            default: return;
        }
        notifier.notifyTaskResult(sessionId, title, "会话 #" + sessionId + " 已结束，点击查看");
    }

    // ---------------- ACK / JS 心跳 ----------------

    public void ackEvents(long seq) {
        if (queue != null) queue.ackUpTo(seq);
    }

    /** 插件发送业务消息（send_message / cancel / subscribe 等）。非 OPEN 返回 false。 */
    public boolean send(String messageJson) {
        if (webSocket != null && wsOpen) {
            try {
                return webSocket.send(messageJson);
            } catch (Exception e) {
                Log.w(TAG, "ws send failed: " + e.getMessage());
                return false;
            }
        }
        Log.w(TAG, "ws send dropped (not open)");
        return false;
    }

    public boolean isWsOpen() {
        return wsOpen;
    }

    // ---------------- recovery 协议 ----------------

    public RecoveryCoordinator.RecoverySnapshot beginRecovery() {
        if (queue == null || tracked == null || recovery == null) return null;
        RecoveryCoordinator.RecoverySnapshot snap = recovery.beginRecovery();
        // 重放水位内事件（本次 recovery 固定起点 → watermark）。重复 beginRecovery
        // 必须使用同一起点，不能受异步 ACK 推进影响，否则 WebView 重建后会缺少未应用事件。
        long from = recovery.getReplayFrom();
        long watermark = snap.watermark;
        for (PendingQueue.EventRecord r : queue.replayFrom(from)) {
            if (r.seq > watermark) break;
            dispatchToJs(r.seq, r.json);
        }
        return snap;
    }

    public void completeRestSync(String recoveryId, Set<Long> sessionIds) {
        if (recovery != null) recovery.completeRestSync(recoveryId, sessionIds);
    }

    public void completeRecovery(String recoveryId) {
        if (recovery != null) recovery.completeRecovery(recoveryId);
    }

    public void abortRecovery(String recoveryId) {
        if (recovery != null) recovery.abortRecovery(recoveryId);
    }

    /** SYNC 解除：只补放本次 watermark 之后的新事件，发 replayDone，恢复实时。 */
    private void onSyncReleased(boolean completed) {
        if (queue == null || recovery == null) return;
        // ACK 经 Capacitor 异步返回，completeRecovery 到达时 queue.lastAck 可能尚未追上
        // 首轮重放水位。若从 lastAck+1 补放，会把整段 content_delta 再应用一次。
        long from = recovery.getWatermark() + 1;
        for (PendingQueue.EventRecord r : queue.replayFrom(from)) {
            dispatchToJs(r.seq, r.json);
        }
        if (listener != null) listener.onReplayDone();
        Log.i(TAG, "sync released, realtime resumed from seq=" + from);
    }

    // ---------------- STARTING 超时回滚 ----------------

    private void checkStartingTimeout(long sessionId) {
        if (tracked == null) return;
        if (!TrackedManager.ST_STARTING.equals(tracked.getState(sessionId))) return;
        Log.w(TAG, "STARTING timeout for session " + sessionId + ", query REST");
        String phase = querySessionPhase(sessionId);
        if ("IDLE".equals(phase)) {
            // 服务端明确确认 IDLE：才回滚 untrack
            Log.w(TAG, "session " + sessionId + " confirmed IDLE, rollback untrack");
            tracked.rollbackStarting(sessionId);
            evaluateServiceMode();
        } else if (phase != null) {
            // 服务端确认活跃/终态：交给状态机（终态进入 pendingRecovery / 级联收尾）
            tracked.onSessionStatus(sessionId, phase, queue != null && queue.hasPending(sessionId));
        } else {
            // 查询失败（断网 / 超时 / 非 200 / 解析失败）：状态未知，不擅自回滚。
            // 保持 STARTING，由后续 session_status 事件或回前台 recovery 确认；
            // 否则实际运行中的任务会被移出 tracked，后台 Service 可能因此停止。
            Log.w(TAG, "session " + sessionId + " phase unknown (query failed), keep STARTING");
        }
    }

    /** REST 查询会话 phase（STARTING 超时确认用）。失败返回 null（状态未知）。 */
    private String querySessionPhase(long sessionId) {
        if (token == null || wsUrl == null) return null;
        try {
            java.net.URI uri = java.net.URI.create(wsUrl);
            String base = "https://" + uri.getHost() + (uri.getPort() > 0 ? ":" + uri.getPort() : "");
            URL url = new URL(base + "/api/v1/sessions/" + sessionId);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout((int) REST_TIMEOUT_MS);
            conn.setReadTimeout((int) REST_TIMEOUT_MS);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code != 200) {
                Log.w(TAG, "REST query session " + sessionId + " http=" + code);
                return null;
            }
            java.io.InputStream in = conn.getInputStream();
            byte[] buf = new byte[8192];
            int n = in.read(buf);
            in.close();
            JSONObject body = new JSONObject(new String(buf, 0, Math.max(n, 0), "UTF-8"));
            JSONObject data = body.optJSONObject("data");
            if (data == null) {
                Log.w(TAG, "REST query session " + sessionId + " missing data, treat unknown");
                return null;
            }
            String phase = data.optString("phase", "");
            if (phase.isEmpty()) {
                Log.w(TAG, "REST query session " + sessionId + " missing phase, treat unknown");
                return null;
            }
            // 只有服务端明确返回 phase（含 IDLE / RUNNING / 终态）才算确认；
            // 缺失视为未知（返回 null），由调用方保持 STARTING，避免误停后台保活
            return phase;
        } catch (Exception e) {
            Log.w(TAG, "REST query session failed: " + e.getMessage());
            return null;
        }
    }

    // ---------------- 网络监听 ----------------

    private void registerNetworkCallback() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    Log.i(TAG, "network available, immediate reconnect");
                    reconnectAttempts = 0;
                    if (!wsOpen && !authFailed && isRunning()) {
                        handler.post(reconnectTask);
                    }
                }
            };
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                cm.registerDefaultNetworkCallback(networkCallback);
            }
        } catch (Exception e) {
            Log.w(TAG, "register network callback failed: " + e.getMessage());
        }
    }

    private void unregisterNetworkCallback() {
        try {
            if (networkCallback != null) {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                cm.unregisterNetworkCallback(networkCallback);
                networkCallback = null;
            }
        } catch (Exception ignored) {
        }
    }

    // ---------------- 事件监听器 ----------------

    public void setEventListener(EventListener l) {
        this.listener = l;
    }

    /** MainActivity 通知点击冷启动/热启动携带 sessionId 时调用。 */
    public void notifyPendingNavigate(long sessionId) {
        if (listener != null) {
            listener.onPendingNavigate(sessionId);
        } else {
            pendingNavigate = sessionId; // 监听器未注册：保留，注册后补发
        }
    }

    private volatile long pendingNavigate = -1;

    public void registerEventListener(EventListener l) {
        this.listener = l;
        if (pendingNavigate > 0) {
            l.onPendingNavigate(pendingNavigate);
            pendingNavigate = -1;
        }
    }

    // ---------------- 工具 ----------------

    /** 解析 JWT subject（userId）用于缓冲按用户隔离；仅 base64 解码不验证签名。 */
    private static long parseUserIdFromToken(String token) {
        try {
            String[] parts = token.split("\\.");
            if (parts.length >= 2) {
                byte[] dec = Base64.decode(parts[1], Base64.URL_SAFE);
                JSONObject payload = new JSONObject(new String(dec, StandardCharsets.UTF_8));
                String sub = payload.optString("sub", "0");
                return Long.parseLong(sub);
            }
        } catch (Exception e) {
            Log.w(TAG, "parse userId from token failed: " + e.getMessage());
        }
        return 0;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
