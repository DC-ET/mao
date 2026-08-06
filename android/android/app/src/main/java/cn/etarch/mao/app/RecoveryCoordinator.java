package cn.etarch.mao.app;

import android.util.Log;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.Timer;
import java.util.TimerTask;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 回前台恢复协调器（recovery 原子协议）：
 * - beginRecovery() → { recoveryId, watermark, restSyncSessionIds, pendingRecoverySessionIds }
 * - completeRestSync(recoveryId, sessionIds)  REST 校准成功会话移除（失败保留待下次）
 * - completeRecovery(recoveryId)              整体结束：compact 磁盘、清除已恢复 pendingRecovery
 * - abortRecovery(recoveryId)                 中止并解除 SYNC
 *
 * 约束：
 * - 同一时间只能存在一个 recovery；重复 beginRecovery 幂等返回现有；
 * - complete* / abort 必须校验 recoveryId；
 * - WebView 中途销毁：recovery 保留（磁盘缓冲与水位不动），下次 begin 从原水位续做；
 * - 30s 超时强制解除 SYNC 屏障进入实时转发，未完成会话保留待下次——不能永久停在 SYNC。
 *
 * SYNC 模式期间：事件继续入 PendingQueue 但不实时转发 JS（由 Service 依据 inSync 判断）。
 */
public class RecoveryCoordinator {

    private static final String TAG = "MaoRecovery";
    private static final long TIMEOUT_MS = 30_000;

    private final PendingQueue queue;
    private final TrackedManager tracked;

    private String recoveryId = null;
    private volatile long watermark = 0;
    private final Set<Long> restSyncSessionIds = new LinkedHashSet<>();
    private final Set<Long> pendingRecoverySessionIds = new LinkedHashSet<>();
    private final AtomicBoolean inSync = new AtomicBoolean(false);
    private final Timer timer = new Timer("mao-recovery-timer", true);

    /** SYNC 解除回调（Service 据此恢复实时转发） */
    public interface SyncListener {
        void onSyncReleased(boolean completed);
    }

    /** beginRecovery 返回给 JS 的恢复快照。 */
    public static final class RecoverySnapshot {
        public final String recoveryId;
        public final long watermark;
        public final Set<Long> restSyncSessionIds;
        public final Set<Long> pendingRecoverySessionIds;

        RecoverySnapshot(String recoveryId, long watermark,
                         Set<Long> restSyncSessionIds, Set<Long> pendingRecoverySessionIds) {
            this.recoveryId = recoveryId;
            this.watermark = watermark;
            this.restSyncSessionIds = restSyncSessionIds;
            this.pendingRecoverySessionIds = pendingRecoverySessionIds;
        }
    }

    private final SyncListener syncListener;

    public RecoveryCoordinator(PendingQueue queue, TrackedManager tracked, SyncListener syncListener) {
        this.queue = queue;
        this.tracked = tracked;
        this.syncListener = syncListener;
    }

    public boolean isInSync() {
        return inSync.get();
    }

    public long getWatermark() {
        return watermark;
    }

    public String getRecoveryId() {
        return recoveryId;
    }

    /** 幂等：已有 recovery 则返回现有，否则建立新的 SYNC 屏障。 */
    public synchronized RecoverySnapshot beginRecovery() {
        if (inSync.get()) {
            return snapshot();
        }
        recoveryId = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        watermark = queue.maxPendingSeq();
        restSyncSessionIds.clear();
        restSyncSessionIds.addAll(queue.getRestSyncRequired());
        pendingRecoverySessionIds.clear();
        pendingRecoverySessionIds.addAll(tracked.getPendingRecovery());
        inSync.set(true);
        Log.i(TAG, "beginRecovery id=" + recoveryId + " watermark=" + watermark
                + " restSync=" + restSyncSessionIds + " pending=" + pendingRecoverySessionIds);

        timer.schedule(new TimerTask() {
            @Override
            public void run() {
                Log.w(TAG, "recovery timeout, force release SYNC");
                forceComplete();
            }
        }, TIMEOUT_MS);
        return snapshot();
    }

    public synchronized RecoverySnapshot snapshot() {
        return new RecoverySnapshot(recoveryId, watermark,
                new LinkedHashSet<>(restSyncSessionIds),
                new LinkedHashSet<>(pendingRecoverySessionIds));
    }

    /** REST 校准成功会话移除（含 tracked.pendingRecovery 中该校准项）。失败保留待下次。 */
    public synchronized void completeRestSync(String id, Set<Long> sessionIds) {
        if (!checkId(id)) return;
        Set<Long> done = new LinkedHashSet<>();
        for (Long sid : sessionIds) {
            if (restSyncSessionIds.remove(sid)) {
                done.add(sid);
            }
        }
        if (!done.isEmpty()) {
            queue.removeRestSyncRequired(done);
            tracked.removePendingRecovery(done);
            Log.i(TAG, "completeRestSync done=" + done);
        }
    }

    /** 整体结束：compact 磁盘、清除已恢复 pendingRecovery、解除 SYNC。 */
    public synchronized void completeRecovery(String id) {
        if (!checkId(id)) return;
        Set<Long> remainingPending = new LinkedHashSet<>(tracked.getPendingRecovery());
        remainingPending.removeAll(restSyncSessionIds); // REST 失败保留的会话不清
        tracked.completePendingRecovery(remainingPending);
        queue.compact();
        queue.persistAll();
        finish(true);
    }

    /** 中止：解除 SYNC，保留所有未完成状态（下次 beginRecovery 续做）。 */
    public synchronized void abortRecovery(String id) {
        if (!checkId(id)) return;
        finish(false);
    }

    private boolean checkId(String id) {
        if (!inSync.get() || recoveryId == null) {
            Log.w(TAG, "no active recovery");
            return false;
        }
        if (!recoveryId.equals(id)) {
            Log.w(TAG, "recoveryId mismatch: got " + id + ", expected " + recoveryId);
            return false;
        }
        return true;
    }

    private void forceComplete() {
        synchronized (this) {
            if (!inSync.get()) return;
            finish(true);
        }
    }

    private void finish(boolean completed) {
        Log.i(TAG, "recovery finished completed=" + completed);
        inSync.set(false);
        recoveryId = null;
        syncListener.onSyncReleased(completed);
    }
}
