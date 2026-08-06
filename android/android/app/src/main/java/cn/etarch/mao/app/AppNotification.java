package cn.etarch.mao.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationCompat;

/**
 * 通知管理：
 * - MaoKeepAlive（LOW）：前台服务常驻通知，仅 FGS 期间展示，降级普通模式即移除
 * - MaoTaskResult（HIGH）：tracked 会话终态通知（完成/失败/取消），PendingIntent 带 sessionId
 *   支持冷启动跳转（MainActivity 消费 getIntent/onNewIntent → pendingNavigate）
 *
 * 通知 ID 用 sessionId.hashCode()：会话级稳定；不同 sessionId 存在极低概率碰撞，
 * 碰撞时可能覆盖另一会话通知——当前接受该风险，不建立持久化映射。
 */
public class AppNotification {

    public static final String CHANNEL_KEEPALIVE = "MaoKeepAlive";
    public static final String CHANNEL_TASK_RESULT = "MaoTaskResult";
    public static final String EXTRA_SESSION_ID = "mao_session_id";
    public static final String EXTRA_TITLE = "mao_notif_title";
    public static final String EXTRA_BODY = "mao_notif_body";

    public static final int NOTIF_ID_KEEPALIVE = 1001;
    private final Context context;
    private final NotificationManager nm;

    public AppNotification(Context context) {
        this.context = context.getApplicationContext();
        this.nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        createChannels();
    }

    private void createChannels() {
        NotificationChannel keepAlive = new NotificationChannel(
                CHANNEL_KEEPALIVE, "后台保活", NotificationManager.IMPORTANCE_LOW);
        keepAlive.setDescription("Agent 任务执行期间的常驻状态");
        keepAlive.setShowBadge(false);
        nm.createNotificationChannel(keepAlive);

        NotificationChannel result = new NotificationChannel(
                CHANNEL_TASK_RESULT, "任务结果", NotificationManager.IMPORTANCE_HIGH);
        result.setDescription("Agent 任务完成/失败/取消提醒");
        nm.createNotificationChannel(result);
    }

    /** 常驻通知（仅 FGS 使用）。 */
    public Notification buildKeepAlive(String title, String text) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(context, CHANNEL_KEEPALIVE)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle(title != null ? title : "Agent 任务执行中")
                .setContentText(text != null ? text : "后台正在实时接收流式输出")
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE);
        return b.build();
    }

    /** 终态通知：点击 PendingIntent → MainActivity（extras 带 sessionId）。 */
    public void notifyTaskResult(long sessionId, String title, String text) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra(EXTRA_SESSION_ID, sessionId);
        intent.putExtra(EXTRA_TITLE, title);
        intent.putExtra(EXTRA_BODY, text);

        PendingIntent pi = PendingIntent.getActivity(
                context,
                (int) sessionId, // requestCode 会话级稳定
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification notif = new NotificationCompat.Builder(context, CHANNEL_TASK_RESULT)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setContentIntent(pi)
                .build();
        try {
            nm.notify((int) sessionId, notif);
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS 被拒：静默（服务照常运行）
            android.util.Log.w("MaoNotification", "notify blocked: " + e.getMessage());
        }
    }

    public void cancelKeepAlive() {
        nm.cancel(NOTIF_ID_KEEPALIVE);
    }

    public void cancelTaskResult(long sessionId) {
        nm.cancel((int) sessionId);
    }
}
