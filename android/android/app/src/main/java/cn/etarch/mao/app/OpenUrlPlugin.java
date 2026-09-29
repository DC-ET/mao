package cn.etarch.mao.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 外链打开插件：
 * - openUrl({ url })  用 ACTION_VIEW 交给系统浏览器（或能处理该 scheme 的 App）
 *
 * 为什么需要它：WebView 未开启多窗口支持，页面里 <a target="_blank"> 的
 * window.open 必然失败，点击助手回复中的链接会毫无反应。前端统一在
 * document 级拦截外链点击（desktop/src/utils/externalLink.ts）后走
 * openExternalUrl()，最终落到这里调起系统能力。
 *
 * 本壳未安装 @capacitor/app、@capacitor/browser，故不用官方 App.openUrl /
 * Browser.open，自研一个最小插件（与 AppUpdatePlugin 同模式）。
 */
@CapacitorPlugin(name = "OpenUrl")
public class OpenUrlPlugin extends Plugin {

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("url is required");
            return;
        }
        Uri uri = Uri.parse(url.trim());
        // 只放行 http/https/mailto：其余 scheme（如自定义 intent://）交给系统处理风险过高
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http")
                || scheme.equalsIgnoreCase("https")
                || scheme.equalsIgnoreCase("mailto"))) {
            call.reject("Unsupported URL scheme: " + scheme);
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(new JSObject().put("ok", true));
        } catch (ActivityNotFoundException e) {
            // 设备上没有可处理该链接的应用（如未装浏览器）
            call.reject("没有找到可以打开该链接的应用");
        } catch (Exception e) {
            call.reject("打开链接失败: " + e.getMessage());
        }
    }
}
