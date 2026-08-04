package cn.etarch.mao.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 自研 OTA 插件：
 * - getVersionCode()             查询当前 APK 版本（versionCode / versionName）
 * - downloadAndInstall(url)      APP 内下载 APK，完成后拉起系统安装器
 * - 下载进度通过 downloadProgress 事件回传前端
 *
 * 前端通过 window.Capacitor.Plugins.AppUpdate 访问（Capacitor 7 原生注入 runtime，无需额外 npm 依赖）。
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    private volatile boolean downloading = false;

    @PluginMethod
    public void getVersionCode(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("versionCode", BuildConfig.VERSION_CODE);
        ret.put("versionName", BuildConfig.VERSION_NAME);
        call.resolve(ret);
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        if (downloading) {
            call.reject("下载已在进行中");
            return;
        }
        // Android 8+（API 26）需要用户授予"安装未知来源应用"权限
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            JSObject data = new JSObject();
            data.put("needPermission", true);
            call.reject("需要开启未知来源安装权限", "INSTALL_PERMISSION_REQUIRED", data);
            return;
        }

        downloading = true;
        final String apkUrl = url;
        new Thread(() -> {
            try {
                File apk = downloadToFile(apkUrl, (done, total) -> {
                    JSObject data = new JSObject();
                    data.put("downloaded", done);
                    data.put("total", total);
                    data.put("percent", total > 0 ? (int) (done * 100 / total) : 0);
                    notifyListeners("downloadProgress", data);
                });
                downloading = false;
                getActivity().runOnUiThread(() -> {
                    try {
                        installApk(apk);
                        call.resolve(new JSObject().put("ok", true));
                    } catch (Exception e) {
                        call.reject("拉起安装器失败: " + e.getMessage());
                    }
                });
            } catch (Exception e) {
                downloading = false;
                call.reject("下载失败: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
        }
        call.resolve();
    }

    private File downloadToFile(String urlStr, ProgressListener listener) throws IOException {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(30000);
        conn.connect();
        int code = conn.getResponseCode();
        if (code != HttpURLConnection.HTTP_OK) {
            conn.disconnect();
            throw new IOException("HTTP " + code);
        }
        long total = conn.getContentLengthLong();
        File dir = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
                "mao-updates");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("无法创建下载目录");
        }
        // 下载到临时文件，完成后改名，避免残留半成品
        File tmp = new File(dir, "mao-update.apk.tmp");
        File apk = new File(dir, "mao-update.apk");
        try (InputStream in = conn.getInputStream();
             OutputStream out = new FileOutputStream(tmp)) {
            byte[] buf = new byte[8192];
            long done = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
                done += n;
                listener.onProgress(done, total);
            }
            out.flush();
        } finally {
            conn.disconnect();
        }
        if (tmp.exists() && tmp.length() > 0) {
            if (apk.exists()) {
                //noinspection ResultOfMethodCallIgnored
                apk.delete();
            }
            if (!tmp.renameTo(apk)) {
                throw new IOException("下载文件重命名失败");
            }
        }
        return apk;
    }

    private void installApk(File apk) {
        Uri uri = FileProvider.getUriForFile(getContext(),
                getContext().getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().startActivity(intent);
    }

    private interface ProgressListener {
        void onProgress(long done, long total);
    }
}
