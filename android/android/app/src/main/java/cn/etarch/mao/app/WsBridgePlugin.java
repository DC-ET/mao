package cn.etarch.mao.app;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * 后台保活桥接插件（JS ↔ 原生）：
 * - ensureKeepAlive / stopKeepAlive / trackSessions / untrackSessions / syncSubscriptions
 * - send / ackEvents / jsAlive
 * - beginRecovery / completeRestSync / completeRecovery / abortRecovery（回前台恢复协议）
 *
 * 事件回传（notifyListeners）：
 * - wsEvent：{ seq, message }（message 为服务端消息对象 JSON 字符串）
 * - wsStatus：{ status: open|close|reconnecting|auth_failed, detail }
 * - replayDone / keepAliveStopped({reason}) / pendingNavigate({sessionId})
 *
 * 安全边界：wsUrl 仅接受 wss:// + host=mao.etarch.cn + path 前缀 /api/ws/stream；
 * token 仅内存持有（Service），不写 SharedPreferences；日志不打完整 URL 与 token。
 */
@CapacitorPlugin(name = "MaoWs")
public class WsBridgePlugin extends Plugin implements WsKeepAliveService.EventListener {

    private static final String TAG = "MaoWsBridge";

    /** 插件单例（Service 启动后反向绑定监听器用；Capacitor 每注册只实例化一个） */
    private static WsBridgePlugin instance;

    public static WsBridgePlugin getInstance() {
        return instance;
    }

    @Override
    public void load() {
        super.load();
        instance = this;
        WsKeepAliveService svc = WsKeepAliveService.getInstance();
        if (svc != null) {
            svc.registerEventListener(this);
        }
    }

    // ---------------- 连接控制 ----------------

    @PluginMethod
    public void ensureKeepAlive(PluginCall call) {
        String token = call.getString("token");
        String wsUrl = call.getString("wsUrl");
        if (token == null || token.isEmpty() || wsUrl == null || !isAllowedWsUrl(wsUrl)) {
            call.reject("invalid token or wsUrl");
            return;
        }
        Context ctx = getContext();
        Intent intent = new Intent(ctx, WsKeepAliveService.class);
        intent.putExtra("token", token);
        intent.putExtra("wsUrl", wsUrl);
        try {
            ctx.startService(intent);
        } catch (Exception e) {
            // 后台启动限制等：App 前台调用时通常可启动
            Log.w(TAG, "startService failed: " + e.getMessage());
        }
        // 首次进程启动：Service 由上面启动，onStartCommand → ensureKeepAlive 会经
        // WsBridgePlugin.getInstance() 反向补注册监听器；此处若 Service 已存在则直接注册
        WsKeepAliveService svc = WsKeepAliveService.getInstance();
        if (svc != null) {
            svc.registerEventListener(this);
        }
        // Service onCreate 后通过 onStartCommand 完成 ensureKeepAlive；这里返回成功，
        // 连接状态通过 wsStatus 事件回传。
        call.resolve();
    }

    @PluginMethod
    public void stopKeepAlive(PluginCall call) {
        WsKeepAliveService svc = WsKeepAliveService.getInstance();
        if (svc != null) {
            svc.stopKeepAlive(WsKeepAliveService.REASON_LOGOUT);
        }
        call.resolve();
    }

    @PluginMethod
    public void trackSessions(PluginCall call) {
        WsKeepAliveService svc = requireService(call);
        if (svc == null) return;
        svc.trackSessions(toLongSet(call.getArray("sessionIds")));
        call.resolve();
    }

    @PluginMethod
    public void untrackSessions(PluginCall call) {
        WsKeepAliveService svc = requireService(call);
        if (svc == null) return;
        String reason = call.getString("reason", "");
        boolean force = "logout".equals(reason) || "force".equals(reason);
        svc.untrackSessions(toLongSet(call.getArray("sessionIds")), force);
        call.resolve();
    }

    @PluginMethod
    public void syncSubscriptions(PluginCall call) {
        WsKeepAliveService svc = requireService(call);
        if (svc == null) return;
        svc.syncSubscriptions(toLongSet(call.getArray("sessionIds")));
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        WsKeepAliveService svc = requireService(call);
        if (svc == null) return;
        String message = call.getString("message");
        if (message == null || message.isEmpty()) {
            call.reject("message required");
            return;
        }
        boolean ok = svc.send(message);
        if (ok) {
            call.resolve();
        } else {
            call.reject("ws not open");
        }
    }

    @PluginMethod
    public void ackEvents(PluginCall call) {
        WsKeepAliveService svc = requireService(call);
        if (svc == null) return;
        Double seq = call.getDouble("seq");
        if (seq != null) {
            svc.ackEvents(seq.longValue());
        }
        call.resolve();
    }

    @PluginMethod
    public void jsAlive(PluginCall call) {
        WsKeepAliveService svc = WsKeepAliveService.getInstance();
        if (svc != null) {
            svc.jsAlive();
        }
        call.resolve();
    }

    // ---------------- recovery 协议 ----------------

    @PluginMethod
    public void beginRecovery(PluginCall call) {
        WsKeepAliveService svc = requireService(call);
        if (svc == null) return;
        RecoveryCoordinator.RecoverySnapshot snap = svc.beginRecovery();
        if (snap == null) {
            call.resolve(new JSObject().put("active", false));
            return;
        }
        JSObject ret = new JSObject();
        ret.put("active", true);
        ret.put("recoveryId", snap.recoveryId);
        ret.put("watermark", snap.watermark);
        ret.put("restSyncSessionIds", toJsArray(snap.restSyncSessionIds));
        ret.put("pendingRecoverySessionIds", toJsArray(snap.pendingRecoverySessionIds));
        call.resolve(ret);
    }

    @PluginMethod
    public void completeRestSync(PluginCall call) {
        WsKeepAliveService svc = requireService(call);
        if (svc == null) return;
        svc.completeRestSync(call.getString("recoveryId"),
                toLongSet(call.getArray("sessionIds")));
        call.resolve();
    }

    @PluginMethod
    public void completeRecovery(PluginCall call) {
        WsKeepAliveService svc = requireService(call);
        if (svc == null) return;
        svc.completeRecovery(call.getString("recoveryId"));
        call.resolve();
    }

    @PluginMethod
    public void abortRecovery(PluginCall call) {
        WsKeepAliveService svc = requireService(call);
        if (svc == null) return;
        svc.abortRecovery(call.getString("recoveryId"));
        call.resolve();
    }

    // ---------------- 事件转发 ----------------

    @Override
    public void onWsEvent(long seq, String messageJson) {
        JSObject data = new JSObject();
        data.put("seq", seq);
        data.put("message", messageJson);
        notifyListeners("wsEvent", data);
    }

    @Override
    public void onWsStatus(String status, String detail) {
        JSObject data = new JSObject();
        data.put("status", status);
        data.put("detail", detail == null ? "" : detail);
        notifyListeners("wsStatus", data);
    }

    @Override
    public void onReplayDone() {
        notifyListeners("replayDone", new JSObject());
    }

    @Override
    public void onKeepAliveStopped(String reason) {
        JSObject data = new JSObject();
        data.put("reason", reason);
        notifyListeners("keepAliveStopped", data);
    }

    @Override
    public void onPendingNavigate(long sessionId) {
        JSObject data = new JSObject();
        data.put("sessionId", sessionId);
        notifyListeners("pendingNavigate", data);
    }

    // ---------------- 工具 ----------------

    private WsKeepAliveService requireService(PluginCall call) {
        WsKeepAliveService svc = WsKeepAliveService.getInstance();
        if (svc == null) {
            call.reject("keepalive service not started, call ensureKeepAlive first");
            return null;
        }
        return svc;
    }

    private boolean isAllowedWsUrl(String url) {
        try {
            java.net.URI uri = java.net.URI.create(url);
            if (!"wss".equalsIgnoreCase(uri.getScheme())) return false;
            if (!"mao.etarch.cn".equalsIgnoreCase(uri.getHost())) return false;
            String path = uri.getPath() != null ? uri.getPath() : "";
            return path.startsWith("/api/ws/stream");
        } catch (Exception e) {
            return false;
        }
    }

    private static Set<Long> toLongSet(JSArray arr) {
        Set<Long> out = new LinkedHashSet<>();
        if (arr == null) return out;
        try {
            for (Object o : arr.toList()) {
                if (o instanceof Number) {
                    out.add(((Number) o).longValue());
                }
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private static JSArray toJsArray(Set<Long> set) {
        JSArray arr = new JSArray();
        for (Long v : set) {
            arr.put(v);
        }
        return arr;
    }
}
