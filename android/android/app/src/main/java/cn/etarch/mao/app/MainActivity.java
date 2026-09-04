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
import android.webkit.WebSettings;
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
 * - 首屏加载走标准 HTTP 缓存（弱网复用已缓存资源），完成判定以「Vue 真正渲染」为准，
 *   8s 未完成显示重试入口（重试绕过缓存重拉入口文档）
 * - 回前台 WebView 无响应 / 页面空白兜底：onStart 延迟探测 evaluateJavascript，
 *   JS 无回调或应用未挂载则自动 reload（后台冻结 / 渲染进程异常 / 资源加载失败时自愈）
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "MaoMain";
    private static final String PREFS = "mao_webview";
    private static final String KEY_ASSET_VERSION = "asset_version_code";

    /** 回前台探测：延迟等待 WebView 恢复后再探测 */
    private static final long RECOVERY_PROBE_DELAY_MS = 2_000;
    /** 探测超时：JS 无回调判定无响应 */
    private static final long RECOVERY_PROBE_TIMEOUT_MS = 3_000;
    /** 挂载验证轮询间隔：progress=100 后每 250ms 探测一次 Vue 是否真正渲染 */
    private static final long MOUNT_VERIFY_INTERVAL_MS = 250;
    /** reload 防抖：10s 内不重复刷新，避免快速前后台切换连环刷新 */
    private static final long RELOAD_DEBOUNCE_MS = 10_000;
    /** 冷启动防护：首屏加载（远程 SPA 弱网可能较慢）期间不探测，避免误判无响应而 reload */
    private static final long COLD_START_GUARD_MS = 10_000;
    /** 冷启动弱网提示：超过该时间仍未加载完成时展示重试入口 */
    private static final long LOADING_TIMEOUT_MS = 8_000;
    /** 重试绕过缓存后恢复默认缓存策略的延迟：需大于主文档请求的发起时机 */
    private static final long RESTORE_CACHE_DELAY_MS = 3_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private long lastReloadAt = 0;
    private long firstStartAt = 0;
    /** 探测进行中：防重复调度 / 重复探测 */
    private boolean probing = false;
    /** 重试时绕过 HTTP 缓存重新拉取入口文档（防止陈旧 index.html 反复失败） */
    private boolean bypassCacheOnce = false;
    /** 缓存绕过进行中：onStop 会清空 Handler，回前台需重新排定恢复任务 */
    private boolean cacheBypassActive = false;
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

    /**
     * 应用挂载探测：Vue mount 成功后 main.ts 会置 window.__MAO_APP_MOUNTED=true；
     * 兜底检查 #app 是否渲染出元素。evaluateJavascript 回调以 "true"/"false" 判定。
     */
    private static final String APP_MOUNTED_PROBE_JS =
            "(function(){try{return (window.__MAO_APP_MOUNTED===true)"
                    + "||!!(document.getElementById('app')&&document.getElementById('app').children.length>0);"
                    + "}catch(e){return false}})()";

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
        if (cacheBypassActive && bridge != null && bridge.getWebView() != null) {
            // onStop 清空了 Handler，重试的缓存恢复任务需重新排定
            scheduleRestoreCacheMode(bridge.getWebView());
        }
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

    /**
     * 探测 WebView 是否响应且页面应用仍挂载：3s 内无 JS 回调判定无响应；有回调但应用未挂载
     * （资源加载失败/空白页）同样视为异常。仅靠 evaluateJavascript 回调无法区分
     * 「引擎活着但页面空白」与「应用健康」，这里统一用应用级探测脚本。
     */
    private void probeWebViewAlive(WebView webView) {
        if (probing || isFinishing() || isDestroyed() || webView == null) return;
        // 页面仍在加载/重载中（progress<100）：跳过本次探测，避免弱网首屏被误判无响应；
        // 冻结/卡死时 progress 保持 100，仍可正常触发 reload
        if (webView.getProgress() < 100) return;
        probing = true;
        final boolean[] appAlive = {false};
        try {
            webView.evaluateJavascript(APP_MOUNTED_PROBE_JS, value -> appAlive[0] = value != null && value.contains("true"));
        } catch (Exception e) {
            // evaluateJavascript 失败（如渲染进程已死）视为无响应，交给下方超时处理
            Log.w(TAG, "probe evaluateJavascript failed: " + e.getMessage());
        }
        handler.postDelayed(() -> {
            probing = false;
            if (!appAlive[0] && !isFinishing() && !isDestroyed() && webView != null) {
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
        reloadWebViewInternal(webView);
    }

    /** 统一重载入口：绕过缓存重拉主文档（仅用户手动重试时）+ 恢复遮罩/监听/注入。 */
    private void reloadWebViewInternal(WebView webView) {        firstPageLoaded = false;
        showLoadingOverlay();
        if (bypassCacheOnce) {
            webView.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
            cacheBypassActive = true;
            scheduleRestoreCacheMode(webView);
            bypassCacheOnce = false;
        }
        webView.reload();
        // reload 后页面重新加载，onCreate 的注入不会再次执行，重新注入顶部导航修复
        Runnable inject = () -> webView.evaluateJavascript(FORCE_TOP_NAV_JS, null);
        webView.post(inject);
        webView.postDelayed(inject, 300);
        webView.postDelayed(inject, 1000);
    }

    /** 恢复默认缓存策略（NO_CACHE 仅作用于重试拉取主文档这一次）。 */
    private void scheduleRestoreCacheMode(WebView webView) {
        handler.postDelayed(() -> {
            if (isFinishing() || isDestroyed()) return;
            webView.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
            cacheBypassActive = false;
        }, RESTORE_CACHE_DELAY_MS);
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
                bypassCacheOnce = true;
                reloadWebViewInternal(webView);
                // showLoadingOverlay 会重置文案，这里覆盖为重试提示
                loadingTitle.setText("正在重新连接 Mao");
                loadingMessage.setText("请保持网络连接，马上回来");
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

    /**
     * 首屏监听：先等 progress 到 100（主文档与资源加载结束），再轮询验证 Vue 真正渲染出内容。
     * progress=100 不代表首屏成功——弱网下 chunk 加载失败也会到 100，页面仍是空白；
     * 只有 #app 有内容（或 __MAO_APP_MOUNTED）才隐藏遮罩，失败由 8s 超时的重试入口兜底。
     */
    private void watchInitialPageLoad(WebView webView, int attempt) {
        handler.postDelayed(() -> {
            if (attempt != loadingAttempt || isFinishing() || isDestroyed() || webView == null) return;
            if (webView.getProgress() < 100) {
                watchInitialPageLoad(webView, attempt);
                return;
            }
            verifyAppMounted(webView, attempt);
        }, 250);
    }

    /** 轮询探测应用是否真正挂载渲染；未挂载则继续等待（遮罩保持，超时后显示重试按钮）。 */
    private void verifyAppMounted(WebView webView, int attempt) {
        handler.postDelayed(() -> {
            if (attempt != loadingAttempt || isFinishing() || isDestroyed() || webView == null) return;
            try {
                webView.evaluateJavascript(APP_MOUNTED_PROBE_JS, value -> {
                    if (attempt != loadingAttempt || isFinishing() || isDestroyed() || webView == null) return;
                    if (value != null && value.contains("true")) {
                        firstPageLoaded = true;
                        hideLoadingOverlay();
                        return;
                    }
                    verifyAppMounted(webView, attempt);
                });
            } catch (Exception e) {
                Log.w(TAG, "mount probe failed: " + e.getMessage());
                verifyAppMounted(webView, attempt);
            }
        }, MOUNT_VERIFY_INTERVAL_MS);
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
        // 标准 HTTP 缓存：弱网冷启动复用已缓存资源（此前 LOAD_NO_CACHE 每次启动全量重下数 MB，
        // 是弱网白屏的根因）；入口与版本一致性由 version.json 比对、APK 升级清缓存、重试绕缓存兜底。
        webView.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
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
