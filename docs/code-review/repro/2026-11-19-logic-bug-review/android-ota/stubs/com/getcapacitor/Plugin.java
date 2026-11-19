package com.getcapacitor;
import android.app.Activity;
import android.content.Context;
import java.io.File;
public abstract class Plugin {
    private final Context context = new Context();
    private final Activity activity = new Activity();
    public Context getContext() { return context; }
    public Activity getActivity() { return activity; }
    /** 测试辅助：重定向「外部下载目录」到指定路径（真实 Plugin 无此方法，仅桩提供）。 */
    public void setExternalFilesDir(File dir) { context.setExternalFilesDir(dir); }
    protected void notifyListeners(String event, JSObject data) { /* no-op */ }
}
