package cn.etarch.mao.app;

import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.appcompat.app.ActionBar;
import androidx.core.graphics.Insets;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * 主 Activity（Capacitor 壳）：
 * - 远程加载 https://mao.etarch.cn，AppUpdatePlugin OTA 升级
 * - 回前台 WebView 无响应兜底：onStart 延迟探测 evaluateJavascript，超时无回调则自动 reload
 *   （后台冻结 / 渲染进程异常 / 主线程卡死时，JS 层无法自愈，由原生兜底恢复，无需用户退出重开）
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "MaoMain";
    private static final String PREFS = "mao_webview";
    private static final String KEY_ASSET_VERSION = "asset_version_code";

    /** 回前台探测：延迟等待 WebView 恢复后再探测 */
    private static final long RECOVERY_PROBE_DELAY_MS = 2_000;
    /** 探测超时：无回调判定无响应 */
    private static final long RECOVERY_PROBE_TIMEOUT_MS = 3_000;
    /** reload 防抖：10s 内不重复刷新，避免快速前后台切换连环刷新 */
    private static final long RELOAD_DEBOUNCE_MS = 10_000;
    /** 冷启动防护：首屏加载（远程 SPA 弱网可能较慢）期间不探测，避免误判无响应而 reload */
    private static final long COLD_START_GUARD_MS = 10_000;
    /** 冷启动弱网提示：超过该时间仍未加载完成时展示重试入口 */
    private static final long LOADING_TIMEOUT_MS = 8_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private long lastReloadAt = 0;
    private long firstStartAt = 0;
    /** 探测进行中：防重复调度 / 重复探测 */
    private boolean probing = false;
    private FrameLayout loadingOverlay;
    private TextView loadingTitle;
    private TextView loadingMessage;
    private ProgressBar loadingProgress;
    private Button loadingRetryButton;
    private boolean firstPageLoaded = false;
    private int loadingAttempt = 0;

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
        showLoadingOverlay();
        firstStartAt = System.currentTimeMillis();
    }

    /** 回前台：延迟探测 WebView 响应性，无响应则自动 reload（WebView 卡死时无需用户退出重开）。 */
    @Override
    public void onStart() {
        super.onStart();
        if (!firstPageLoaded && bridge != null && bridge.getWebView() != null && loadingOverlay != null) {
            loadingAttempt++;
            scheduleLoadingTimeout(bridge.getWebView(), loadingAttempt);
            watchInitialPageLoad(bridge.getWebView(), loadingAttempt);
        }
        scheduleWebViewRecoveryProbe();
    }

    /** 切后台：取消排定的探测/超时任务并重置探测标志，避免探测在后台触发 reload。 */
    @Override
    public void onStop() {
        super.onStop();
        probing = false;
        handler.removeCallbacksAndMessages(null);
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        handler.removeCallbacksAndMessages(null);
    }

    private void scheduleWebViewRecoveryProbe() {
        if (probing) return; // 已有探测进行中，不重复调度
        if (bridge == null || bridge.getWebView() == null) return;
        // 冷启动防护：首屏加载期间不探测（远程 SPA 加载慢，探测回调可能延迟被误判）
        if (System.currentTimeMillis() - firstStartAt < COLD_START_GUARD_MS) return;
        WebView webView = bridge.getWebView();
        handler.postDelayed(() -> probeWebViewAlive(webView), RECOVERY_PROBE_DELAY_MS);
    }

    /** 探测 WebView 是否响应：evaluateJavascript 3s 内无回调判定无响应。 */
    private void probeWebViewAlive(WebView webView) {
        if (probing || isFinishing() || isDestroyed() || webView == null) return;
        // 页面仍在加载/重载中（progress<100）：跳过本次探测，避免弱网首屏被误判无响应；
        // 冻结/卡死时 progress 保持 100，仍可正常触发 reload
        if (webView.getProgress() < 100) return;
        probing = true;
        final boolean[] responded = {false};
        try {
            webView.evaluateJavascript("1;", value -> responded[0] = true);
        } catch (Exception e) {
            // evaluateJavascript 失败（如渲染进程已死）视为无响应，交给下方超时处理
            Log.w(TAG, "probe evaluateJavascript failed: " + e.getMessage());
        }
        handler.postDelayed(() -> {
            probing = false;
            if (!responded[0] && !isFinishing() && !isDestroyed() && webView != null) {
                reloadWebView(webView);
            }
        }, RECOVERY_PROBE_TIMEOUT_MS);
    }

    private void reloadWebView(WebView webView) {
        if (isFinishing() || isDestroyed() || webView == null) return;
        long now = System.currentTimeMillis();
        if (now - lastReloadAt < RELOAD_DEBOUNCE_MS) return;
        lastReloadAt = now;
        Log.i(TAG, "webview unresponsive, auto reload");
        firstPageLoaded = false;
        showLoadingOverlay();
        webView.reload();
        // reload 后页面重新加载，onCreate 的注入不会再次执行，重新注入顶部导航修复
        Runnable inject = () -> webView.evaluateJavascript(FORCE_TOP_NAV_JS, null);
        webView.post(inject);
        webView.postDelayed(inject, 300);
        webView.postDelayed(inject, 1000);
    }

    private void showLoadingOverlay() {
        if (bridge == null || bridge.getWebView() == null) return;
        WebView webView = bridge.getWebView();
        if (loadingOverlay == null) {
            loadingOverlay = new FrameLayout(this);
            loadingOverlay.setBackgroundColor(Color.parseColor("#f5f5f7"));
            loadingOverlay.setClickable(true);

            LinearLayout content = new LinearLayout(this);
            content.setOrientation(LinearLayout.VERTICAL);
            content.setGravity(Gravity.CENTER);
            int horizontalPadding = dp(32);
            content.setPadding(horizontalPadding, 0, horizontalPadding, 0);

            TextView brand = new TextView(this);
            brand.setText("Mao");
            brand.setTextColor(Color.parseColor("#111827"));
            brand.setTextSize(28);
            brand.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
            brand.setGravity(Gravity.CENTER);
            content.addView(brand, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT));

            loadingTitle = new TextView(this);
            loadingTitle.setText("正在连接 Mao");
            loadingTitle.setTextColor(Color.parseColor("#374151"));
            loadingTitle.setTextSize(16);
            loadingTitle.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT);
            titleParams.topMargin = dp(16);
            content.addView(loadingTitle, titleParams);

            loadingMessage = new TextView(this);
            loadingMessage.setText("网络较慢时可能需要多等一会儿");
            loadingMessage.setTextColor(Color.parseColor("#6b7280"));
            loadingMessage.setTextSize(13);
            loadingMessage.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams messageParams = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT);
            messageParams.topMargin = dp(8);
            content.addView(loadingMessage, messageParams);

            loadingProgress = new ProgressBar(this);
            LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(dp(36), dp(36));
            progressParams.topMargin = dp(24);
            content.addView(loadingProgress, progressParams);

            loadingRetryButton = new Button(this);
            loadingRetryButton.setText("重新连接");
            loadingRetryButton.setAllCaps(false);
            loadingRetryButton.setTextColor(Color.WHITE);
            GradientDrawable retryBg = new GradientDrawable();
            retryBg.setColor(Color.parseColor("#2563eb"));
            retryBg.setCornerRadius(dp(20));
            loadingRetryButton.setBackground(retryBg);
            loadingRetryButton.setPadding(dp(18), 0, dp(18), 0);
            loadingRetryButton.setVisibility(View.GONE);
            loadingRetryButton.setOnClickListener(v -> {
                firstPageLoaded = false;
                loadingTitle.setText("正在重新连接 Mao");
                loadingMessage.setText("请保持网络连接，马上回来");
                loadingProgress.setVisibility(View.VISIBLE);
                loadingRetryButton.setVisibility(View.GONE);
                webView.reload();
                loadingAttempt++;
                scheduleLoadingTimeout(webView, loadingAttempt);
                watchInitialPageLoad(webView, loadingAttempt);
            });
            LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, dp(40));
            retryParams.topMargin = dp(24);
            content.addView(loadingRetryButton, retryParams);

            loadingOverlay.addView(content, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    Gravity.CENTER));
        }

        ViewGroup root = findViewById(android.R.id.content);
        if (root != null && loadingOverlay.getParent() == null) {
            root.addView(loadingOverlay, new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));
        }
        loadingOverlay.bringToFront();
        loadingOverlay.setVisibility(View.VISIBLE);
        loadingTitle.setText("正在连接 Mao");
        loadingMessage.setText("网络较慢时可能需要多等一会儿");
        loadingProgress.setVisibility(View.VISIBLE);
        loadingRetryButton.setVisibility(View.GONE);
        loadingAttempt++;
        scheduleLoadingTimeout(webView, loadingAttempt);
        watchInitialPageLoad(webView, loadingAttempt);
    }

    private void watchInitialPageLoad(WebView webView, int attempt) {
        handler.postDelayed(() -> {
            if (attempt != loadingAttempt || firstPageLoaded || isFinishing() || isDestroyed() || webView == null) return;
            if (webView.getProgress() >= 100) {
                firstPageLoaded = true;
                hideLoadingOverlay();
                return;
            }
            watchInitialPageLoad(webView, attempt);
        }, 250);
    }

    private void scheduleLoadingTimeout(WebView webView, int attempt) {
        handler.postDelayed(() -> {
            if (attempt != loadingAttempt || firstPageLoaded || isFinishing() || isDestroyed() || webView == null) return;
            loadingTitle.setText("连接有点慢");
            loadingMessage.setText("请检查网络后重试，或继续等待页面加载");
            loadingProgress.setVisibility(View.GONE);
            loadingRetryButton.setVisibility(View.VISIBLE);
        }, LOADING_TIMEOUT_MS);
    }

    private void hideLoadingOverlay() {
        if (loadingOverlay != null) {
            loadingOverlay.setVisibility(View.GONE);
        }
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
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
