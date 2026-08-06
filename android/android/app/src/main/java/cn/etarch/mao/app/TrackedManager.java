package cn.etarch.mao.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * tracked 会话管理（原生裁决层）：
 * - 三集合分离：activeTracked（决定 FGS 与后台可靠缓冲）/ pendingRecovery（终态未清，
 *   保留到 recovery 完成）/ subscriptions（重连后重订阅用，UI 订阅不触发 untrack）
 * - 父子任务映射（side task / subagent 原生自动 track，级联收尾）
 * - 原生内部阶段：STARTING → ACTIVE → TERMINAL；终态且有未 ACK 缓冲 → 移出 activeTracked 进入 pendingRecovery
 * - untrack 原生裁决：仅当会话非 ACTIVE、无活跃子任务，或携带 FORCE（退出登录）
 * - STARTING 超时回滚（由 Service 定时器触发）
 *
 * 持久化：noBackupFilesDir/buffered-events/&lt;userId&gt;/tracked-meta.json
 */
public class TrackedManager {

    private static final String TAG = "MaoTracked";
    private static final String META_FILE = "tracked-meta.json";

    public interface Listener {
        /** activeTracked 集合变空（Service 据此降级普通模式或停止） */
        void onActiveTrackedEmpty();
    }

    public static final String ST_STARTING = "STARTING";
    public static final String ST_ACTIVE = "ACTIVE";

    /** 活跃 phase（服务端 phase 判定，与前端 ACTIVE_PHASES 并集一致） */
    public static final Set<String> ACTIVE_PHASES = Set.of(
            "RUNNING", "RESUMING", "WAITING_APPROVAL", "CANCELLING");
    /** 终态 phase */
    public static final Set<String> TERMINAL_PHASES = Set.of(
            "COMPLETED", "FAILED", "CANCELLED");

    private final File metaFile;

    /** sessionId → 原生内部阶段（STARTING / ACTIVE），决定 FGS 与后台可靠缓冲 */
    private final Map<Long, String> activeTracked = new ConcurrentHashMap<>();
    /** 终态但未清（未 ACK 缓冲 / 需 REST 校准），保留到 recovery 完成 */
    private final Set<Long> pendingRecovery = ConcurrentHashMap.newKeySet();
    /** 重连后重订阅集合（UI 层订阅，与 tracked 无关） */
    private final Set<Long> subscriptions = ConcurrentHashMap.newKeySet();
    /** 父子映射 */
    private final Map<Long, Set<Long>> parentToChildren = new ConcurrentHashMap<>();
    private final Map<Long, Long> childToParent = new ConcurrentHashMap<>();
    /** sessionId → 最近服务端 phase 缓存 */
    private final Map<Long, String> phaseCache = new ConcurrentHashMap<>();

    private final Listener listener;

    public TrackedManager(Context context, long userId, Listener listener) {
        this.listener = listener;
        this.metaFile = new File(new File(new File(context.getNoBackupFilesDir(), "buffered-events"),
                String.valueOf(userId)), META_FILE);
        restore();
    }

    // ---------------- 查询 ----------------

    public Set<Long> getActiveTrackedIds() {
        return new LinkedHashSet<>(activeTracked.keySet());
    }

    public Set<Long> getPendingRecovery() {
        return new LinkedHashSet<>(pendingRecovery);
    }

    public Set<Long> getSubscriptions() {
        return new LinkedHashSet<>(subscriptions);
    }

    public String getState(Long sessionId) {
        return activeTracked.get(sessionId);
    }

    public boolean isTrackedActive(Long sessionId) {
        String st = activeTracked.get(sessionId);
        return ST_ACTIVE.equals(st) || ST_STARTING.equals(st);
    }

    /** 会话是否有任何活跃子任务 */
    public boolean hasActiveChildren(Long sessionId) {
        Set<Long> children = parentToChildren.get(sessionId);
        if (children == null || children.isEmpty()) return false;
        for (Long c : children) {
            if (isTrackedActive(c)) return true;
        }
        return false;
    }

    public Long getParent(Long sessionId) {
        return childToParent.get(sessionId);
    }

    // ---------------- 增删 ----------------

    /** 发送前调用：加入 tracked，进入 STARTING（等待服务端活跃 phase 确认）。 */
    public void trackSessions(Set<Long> sessionIds) {
        for (Long id : sessionIds) {
            if (id == null) continue;
            activeTracked.put(id, ST_STARTING);
            Log.i(TAG, "track session " + id + " -> STARTING");
        }
        persist();
        notifyIfEmpty();
    }

    /**
     * 原生裁决的 untrack：
     * - force=true（退出登录）直接移除；
     * - 否则要求会话非 ACTIVE 且无活跃子任务（STARTING 超时回滚 / 发送失败回滚 / REST 确认终态）。
     */
    public boolean untrackSessions(Set<Long> sessionIds, boolean force) {
        boolean changed = false;
        for (Long id : sessionIds) {
            if (id == null) continue;
            String st = activeTracked.get(id);
            if (st == null) continue;
            if (!force && ST_ACTIVE.equals(st)) {
                Log.w(TAG, "untrack rejected: session " + id + " is ACTIVE");
                continue;
            }
            if (!force && hasActiveChildren(id)) {
                Log.w(TAG, "untrack rejected: session " + id + " has active children");
                continue;
            }
            activeTracked.remove(id);
            phaseCache.remove(id);
            removeFromParent(id);
            Log.i(TAG, "untrack session " + id + (force ? " (FORCE)" : ""));
            changed = true;
        }
        if (changed) {
            persist();
            notifyIfEmpty();
        }
        return changed;
    }

    /** STARTING 超时回滚（建连失败 / 服务端拒绝 / 用户取消）：仅 STARTING 阶段可回滚。 */
    public boolean rollbackStarting(Long sessionId) {
        if (!ST_STARTING.equals(activeTracked.get(sessionId))) {
            Log.w(TAG, "rollbackStarting ignored: session " + sessionId
                    + " state=" + activeTracked.get(sessionId));
            return false;
        }
        return untrackSessions(Set.of(sessionId), false);
    }

    /**
     * 服务端 session_status 驱动状态机。
     *
     * @param hasPending 该会话是否有未 ACK 缓冲（由 PendingQueue 判定）
     */
    public void onSessionStatus(long sessionId, String phase, boolean hasPending) {
        phaseCache.put(sessionId, phase);
        String st = activeTracked.get(sessionId);
        if (st == null) return; // 非 tracked 会话，忽略

        if (ST_STARTING.equals(st)) {
            if (ACTIVE_PHASES.contains(phase)) {
                activeTracked.put(sessionId, ST_ACTIVE);
                Log.i(TAG, "session " + sessionId + " STARTING -> ACTIVE (phase=" + phase + ")");
                persist();
                return;
            }
            if (TERMINAL_PHASES.contains(phase)) {
                // 任务快速完成/失败/取消：未经历 ACTIVE 直接收到终态
                // （或 STARTING 超时 REST 查询返回终态），同样需要退出 tracked
                Log.i(TAG, "session " + sessionId + " STARTING -> TERMINAL (phase=" + phase + ")");
                finalizeSession(sessionId, hasPending);
                return;
            }
            return;
        }

        if (TERMINAL_PHASES.contains(phase) && ST_ACTIVE.equals(st)) {
            finalizeSession(sessionId, hasPending);
        }
    }

    /** 会话进入终态：移出 activeTracked，未 ACK 则进 pendingRecovery，并向上级联。 */
    private void finalizeSession(long sessionId, boolean hasPending) {
        String st = activeTracked.get(sessionId);
        if (st == null) return;
        activeTracked.remove(sessionId);
        phaseCache.remove(sessionId);
        if (hasPending) {
            pendingRecovery.add(sessionId);
            Log.i(TAG, "session " + sessionId + " TERMINAL with pending -> pendingRecovery");
        } else {
            Log.i(TAG, "session " + sessionId + " TERMINAL, no pending");
        }
        persist();
        cascade(sessionId);
        notifyIfEmpty();
    }

    /**
     * 级联收尾：子任务终态后，若父任务服务端已终态且无其他活跃子任务，则父任务一并终态化。
     * （父任务自身的 session_status 终态事件必然也会到达；级联用于子任务最后收尾时兜底）
     */
    private void cascade(long sessionId) {
        Long parent = childToParent.get(sessionId);
        removeFromParent(sessionId);
        if (parent == null) return;
        String phase = phaseCache.get(parent);
        if (TERMINAL_PHASES.contains(phase) && !hasActiveChildren(parent)) {
            String st = activeTracked.get(parent);
            if (ST_ACTIVE.equals(st)) {
                boolean hasPending = pendingRecovery.contains(parent);
                finalizeSession(parent, hasPending);
            }
        }
    }

    /** 子会话移除时从父的子集合摘除。 */
    private void removeFromParent(long sessionId) {
        Long parent = childToParent.remove(sessionId);
        if (parent != null) {
            Set<Long> children = parentToChildren.get(parent);
            if (children != null) {
                children.remove(sessionId);
                if (children.isEmpty()) parentToChildren.remove(parent);
            }
        }
    }

    /** 原生解析 side_session_created / subagent_session_created：父 tracked 时自动 track 子会话。 */
    public void registerSubSession(long parentSessionId, long childSessionId) {
        if (!activeTracked.containsKey(parentSessionId)) {
            Log.d(TAG, "sub session ignored: parent " + parentSessionId + " not tracked");
            return;
        }
        childToParent.put(childSessionId, parentSessionId);
        parentToChildren.computeIfAbsent(parentSessionId, k -> ConcurrentHashMap.newKeySet())
                .add(childSessionId);
        activeTracked.put(childSessionId, ST_STARTING);
        Log.i(TAG, "auto-track sub session " + childSessionId + " (parent " + parentSessionId + ")");
        persist();
        notifyIfEmpty();
    }

    /** 全量替换 UI 订阅集合（重连后重订阅用）。 */
    public void syncSubscriptions(Set<Long> sessionIds) {
        subscriptions.clear();
        if (sessionIds != null) {
            subscriptions.addAll(sessionIds);
        }
        persist();
    }

    /** recovery 完成后清除 pendingRecovery（重放 + REST 校准成功）。 */
    public void completePendingRecovery(Set<Long> sessionIds) {
        boolean changed = false;
        for (Long id : sessionIds) {
            if (pendingRecovery.remove(id)) {
                phaseCache.remove(id);
                removeFromParent(id);
                changed = true;
            }
        }
        if (changed) {
            Log.i(TAG, "pendingRecovery completed: " + sessionIds);
            persist();
            notifyIfEmpty();
        }
    }

    /** 会话被标记需 REST 校准 → 加入 pendingRecovery（由 PendingQueue 溢出触发）。 */
    public void markRestSyncRequired(long sessionId) {
        if (pendingRecovery.add(sessionId)) {
            Log.i(TAG, "session " + sessionId + " added to pendingRecovery (REST sync required)");
            persist();
        }
    }

    /** 退出登录：清空全部状态。 */
    public void clearAll() {
        activeTracked.clear();
        pendingRecovery.clear();
        subscriptions.clear();
        parentToChildren.clear();
        childToParent.clear();
        phaseCache.clear();
        if (metaFile.exists()) {
            //noinspection ResultOfMethodCallIgnored
            metaFile.delete();
        }
        Log.i(TAG, "TrackedManager cleared");
        notifyIfEmpty();
    }

    /** 部分清除 pendingRecovery（recovery completeRestSync / completeRecovery 用）。 */
    public void removePendingRecovery(Set<Long> sessionIds) {
        boolean changed = false;
        for (Long id : sessionIds) {
            if (pendingRecovery.remove(id)) {
                phaseCache.remove(id);
                removeFromParent(id);
                changed = true;
            }
        }
        if (changed) {
            Log.i(TAG, "pendingRecovery removed: " + sessionIds);
            persist();
            notifyIfEmpty();
        }
    }

    /** 会话最近服务端 phase 缓存（STARTING 超时 REST 查询、父子级联判定用）。 */
    public String getCachedPhase(long sessionId) {
        return phaseCache.get(sessionId);
    }

    /**
     * Android 15 dataSync 超时挂起：activeTracked 全部转入 pendingRecovery（恢复元数据保留），
     * 清空 activeTracked 触发降级/停止；回前台后由 recovery + REST 查询实际状态。
     */
    public void suspendForTimeout() {
        if (activeTracked.isEmpty()) return;
        pendingRecovery.addAll(activeTracked.keySet());
        Log.w(TAG, "suspendForTimeout: active -> pendingRecovery, count=" + activeTracked.size());
        activeTracked.clear();
        persist();
        notifyIfEmpty();
    }

    private void notifyIfEmpty() {
        if (activeTracked.isEmpty()) {
            listener.onActiveTrackedEmpty();
        }
    }

    // ---------------- 持久化 ----------------

    private void restore() {
        try {
            if (!metaFile.exists()) return;
            FileInputStream in = new FileInputStream(metaFile);
            byte[] buf = new byte[(int) Math.min(metaFile.length(), 4 * 1024 * 1024)];
            int n = in.read(buf);
            in.close();
            JSONObject meta = new JSONObject(new String(buf, 0, Math.max(n, 0), "UTF-8"));

            JSONArray tracked = meta.optJSONArray("activeTracked");
            if (tracked != null) {
                for (int i = 0; i < tracked.length(); i++) {
                    JSONObject o = tracked.getJSONObject(i);
                    activeTracked.put(o.getLong("id"), o.getString("state"));
                }
            }
            readIntoSet(meta.optJSONArray("pendingRecovery"), pendingRecovery);
            readIntoSet(meta.optJSONArray("subscriptions"), subscriptions);

            JSONArray rel = meta.optJSONArray("relations");
            if (rel != null) {
                for (int i = 0; i < rel.length(); i++) {
                    JSONObject o = rel.getJSONObject(i);
                    long parent = o.getLong("parent");
                    long child = o.getLong("child");
                    childToParent.put(child, parent);
                    parentToChildren.computeIfAbsent(parent, k -> ConcurrentHashMap.newKeySet()).add(child);
                }
            }
            Log.i(TAG, "TrackedManager restored: active=" + activeTracked.size()
                    + " pending=" + pendingRecovery.size() + " subs=" + subscriptions.size());
        } catch (Exception e) {
            Log.w(TAG, "restore tracked meta failed, start fresh: " + e.getMessage());
            activeTracked.clear();
            pendingRecovery.clear();
            subscriptions.clear();
        }
    }

    private static void readIntoSet(JSONArray arr, Set<Long> target) throws Exception {
        if (arr == null) return;
        for (int i = 0; i < arr.length(); i++) {
            target.add(arr.getLong(i));
        }
    }

    private void persist() {
        try {
            JSONObject meta = new JSONObject();
            JSONArray tracked = new JSONArray();
            for (Map.Entry<Long, String> e : activeTracked.entrySet()) {
                JSONObject o = new JSONObject();
                o.put("id", e.getKey());
                o.put("state", e.getValue());
                tracked.put(o);
            }
            meta.put("activeTracked", tracked);
            meta.put("pendingRecovery", new JSONArray(new ArrayList<>(pendingRecovery)));
            meta.put("subscriptions", new JSONArray(new ArrayList<>(subscriptions)));
            JSONArray rel = new JSONArray();
            for (Map.Entry<Long, Long> e : childToParent.entrySet()) {
                JSONObject o = new JSONObject();
                o.put("child", e.getKey());
                o.put("parent", e.getValue());
                rel.put(o);
            }
            meta.put("relations", rel);

            File tmp = new File(metaFile.getParentFile(), META_FILE + ".tmp");
            FileOutputStream fos = new FileOutputStream(tmp);
            fos.write(meta.toString().getBytes("UTF-8"));
            fos.getFD().sync();
            fos.close();
            if (!tmp.renameTo(metaFile)) {
                throw new IOException("rename tracked meta failed");
            }
        } catch (Exception e) {
            Log.w(TAG, "persist tracked meta failed: " + e.getMessage());
        }
    }
}
