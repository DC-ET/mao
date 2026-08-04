package cn.etarch.mao.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.WebView;

import androidx.appcompat.app.ActionBar;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String PREFS = "mao_webview";
    private static final String KEY_ASSET_VERSION = "asset_version_code";

    /** 强制显示 TopNav、移除 HTML splash，覆盖升级后可能残留的旧 CSS 缓存。 */
    private static final String FORCE_TOP_NAV_JS =
            "(function(){"
                    + "document.documentElement.classList.add('android-capacitor');"
                    + "var s=document.getElementById('mao-android-topnav-fix');"
                    + "if(!s){s=document.createElement('style');s.id='mao-android-topnav-fix';"
                    + "s.textContent="
                    + "'html.android-capacitor #splash{display:none!important}"
                    + "html.android-capacitor .top-nav{"
                    + "display:flex!important;visibility:visible!important;opacity:1!important;"
                    + "height:44px!important;min-height:44px!important;max-height:none!important;"
                    + "padding:0 8px!important;overflow:visible!important;-webkit-app-region:no-drag}"
                    + "html.android-capacitor .nav-left{padding-left:0!important;gap:4px}"
                    + "html.android-capacitor .nav-right{gap:2px;min-width:0}"
                    + "html.android-capacitor .theme-toggle{flex-shrink:0;width:32px;height:32px}"
                    + "html.android-capacitor .nav-username,html.android-capacitor .nav-user>.el-icon{display:none}';"
                    + "document.documentElement.appendChild(s)}"
                    + "var splash=document.getElementById('splash');if(splash)splash.remove();"
                    + "})();";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate() 之前调用：正确关闭 Android 12+ SplashScreen。
        SplashScreen.installSplashScreen(this);

        registerPlugin(AppUpdatePlugin.class);
        super.onCreate(savedInstanceState);

        // BridgeActivity 会 setTheme(NoActionBar)；再显式藏掉 ActionBar，杜绝标题「Mao」。
        hideActionBar();
        configureSystemBars();
        configureWebView();
    }

    private void hideActionBar() {
        ActionBar bar = getSupportActionBar();
        if (bar != null) {
            bar.hide();
        }
    }

    private void configureWebView() {
        if (bridge == null || bridge.getWebView() == null) {
            return;
        }
        WebView webView = bridge.getWebView();
        // 不替换 Capacitor 自己的 WebViewClient（否则会打断 bridge / 路由）。
        webView.getSettings().setCacheMode(android.webkit.WebSettings.LOAD_NO_CACHE);
        webView.setBackgroundColor(Color.parseColor("#f5f5f7"));

        // 系统栏避让交给 Capacitor 的 adjustMarginsForEdgeToEdge=force（用 margin，WebView.setPadding 无效）。
        // 父布局背景与状态栏同色，margin 露出来的区域不会发黑。
        View parent = (View) webView.getParent();
        if (parent != null) {
            parent.setBackgroundColor(Color.parseColor("#f5f5f7"));
        }
        View root = findViewById(android.R.id.content);
        if (root instanceof ViewGroup) {
            ((ViewGroup) root).setBackgroundColor(Color.parseColor("#f5f5f7"));
        }
        // decorFits 在 configureSystemBars 里刚关掉，强制再派发一次 insets，让 Capacitor margin 生效。
        webView.post(() -> androidx.core.view.ViewCompat.requestApplyInsets(webView));

        boolean versionChanged = shouldClearCacheForNewVersion();
        if (versionChanged) {
            webView.clearCache(true);
            webView.clearHistory();
        }

        // 多次注入：覆盖首屏渲染与 Vue mount 之后的时序。
        Runnable inject = () -> webView.evaluateJavascript(FORCE_TOP_NAV_JS, null);
        webView.post(inject);
        webView.postDelayed(inject, 300);
        webView.postDelayed(inject, 1000);
        webView.postDelayed(inject, 2500);

        if (versionChanged) {
            // 必须回到应用根路径再加载：相对 base(./) 下若停留在 /tasks/:id，
            // reload 会使 ./assets 解析到错误目录，JS 无法启动。
            webView.postDelayed(() -> webView.loadUrl(bridge.getAppUrl()), 50);
        }
    }

    /** APK versionCode 变化时清 WebView 缓存，避免旧 CSS 继续隐藏 .top-nav。 */
    private boolean shouldClearCacheForNewVersion() {
        int current = BuildConfig.VERSION_CODE;
        android.content.SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        int previous = prefs.getInt(KEY_ASSET_VERSION, -1);
        if (previous != current) {
            prefs.edit().putInt(KEY_ASSET_VERSION, current).apply();
            return true;
        }
        return false;
    }

    private void configureSystemBars() {
        Window window = getWindow();
        // edge-to-edge：由 Capacitor margin 避让系统栏；decorFits=true 时 insets 常为 0。
        WindowCompat.setDecorFitsSystemWindows(window, false);

        window.setStatusBarColor(Color.parseColor("#f5f5f7"));
        window.setNavigationBarColor(Color.parseColor("#f5f5f7"));

        WindowInsetsControllerCompat controller = new WindowInsetsControllerCompat(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(true);

        window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
    }
}
