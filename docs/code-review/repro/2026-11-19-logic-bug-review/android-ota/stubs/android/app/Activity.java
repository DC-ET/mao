package android.app;
import android.content.Intent;
public class Activity {
    /** 桩里同步执行（真实 Activity 抛到主线程），使 downloadAndInstall 的行为在测试里即时收敛。 */
    public void runOnUiThread(Runnable action) { action.run(); }
    public void startActivity(Intent intent) { /* no-op */ }
}
