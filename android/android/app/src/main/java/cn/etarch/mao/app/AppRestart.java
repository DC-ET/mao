package cn.etarch.mao.app;

import android.app.Activity;
import android.content.Intent;

/** 清任务栈重启 MainActivity：切换服务器 / 从快捷方式保存后生效。 */
public final class AppRestart {

    private AppRestart() {}

    public static void restart(Activity activity) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return;
        Intent intent = new Intent(activity, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        activity.startActivity(intent);
        activity.finish();
    }
}