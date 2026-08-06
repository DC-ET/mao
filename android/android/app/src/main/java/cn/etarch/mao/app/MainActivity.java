package cn.etarch.mao.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.WebView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.ActionBar;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String PREFS = "mao_webview";
    private static final String KEY_ASSET_VERSION = "asset_version_code";

    /** 通知点击跳转携带的会话 ID（冷启动时 Service 尚不存在，由 Service.ensureKeepAlive 消费） */
    private static volatile long pendingNavigationSessionId = -1;

    /** Android 13+ POST_NOTIFICATIONS 运行时申请 */
    private ActivityResultLauncher<String> notificationPermissionLauncher;

    /**
     * 读取并清零待跳转会话 ID。通知冷启动时 Service 尚未创建，sessionId 暂存于此，
     * 待前端 connect → Service.ensureKeepAlive 时消费（Service 的 registerEventListener 补发机制保证送达）。
     */
    public static long consumePendingNavigationSessionId() {
        long v = pendingNavigationSessionId;
        pendingNavigationSessionId = -1;
        return v;
    }

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
        registerPlugin(WsBridgePlugin.class);
        super.onCreate(savedInstanceState);

        // BridgeActivity 会 setTheme(NoActionBar)；再显式藏掉 ActionBar，杜绝标题「Mao」。
        hideActionBar();
        configureSystemBars();
        configureWebView();
        registerNotificationPermission();
        handleIntent(getIntent());
    }

    /** 通知点击冷启动/热启动：提取 sessionId 存 pending，转发给保活服务消费。 */
    private void handleIntent(Intent intent) {
        if (intent == null || intent.getLongExtra(AppNotification.EXTRA_SESSION_ID, -1) <= 0) {
            return;
        }
        long sessionId = intent.getLongExtra(AppNotification.EXTRA_SESSION_ID, -1);
        pendingNavigationSessionId = sessionId;
        WsKeepAliveService svc = WsKeepAliveService.getInstance();
        if (svc != null) {
            svc.notifyPendingNavigate(sessionId);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /** 前后台状态通知保活服务（后台立即转缓冲模式）。 */
    @Override
    public void onStart() {
        super.onStart();
        WsKeepAliveService.setAppForeground(true);
    }

    @Override
    public void onStop() {
        super.onStop();
        WsKeepAliveService.setAppForeground(false);
    }

    private void registerNotificationPermission() {
        notificationPermissionLauncher = registerForActivityResult(
                new ActivityResultContracts.RequestPermission(),
                granted -> { /* 拒绝则前台服务仍运行，仅通知可见性受限 */ });
        // Android 13+（API 33）首次启动请求一次
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
        }
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
        // Capacitor 默认只避让 systemBars 并消费 Insets。
        // 同时处理 IME，把 WebView 内容区直接收缩到键盘上方。
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets systemBars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams margins = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
            margins.leftMargin = systemBars.left;
            margins.topMargin = systemBars.top;
            margins.rightMargin = systemBars.right;
            margins.bottomMargin = Math.max(systemBars.bottom, ime.bottom);
            view.setLayoutParams(margins);
            return WindowInsetsCompat.CONSUMED;
        });
        webView.post(() -> ViewCompat.requestApplyInsets(webView));

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
            // APK 升级后清缓存并重新加载远程入口
            webView.postDelayed(() -> webView.loadUrl(bridge.getAppUrl()), 50);
        }
    }

    /** APK versionCode 变化时清 WebView 缓存，避免壳升级后仍用旧页面缓存。 */
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
