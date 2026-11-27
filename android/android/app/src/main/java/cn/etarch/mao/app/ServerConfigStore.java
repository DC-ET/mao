package cn.etarch.mao.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * 安卓壳服务器配置：SharedPreferences + 生效地址解析。
 *
 * 优先级：已保存 → BuildConfig.MAO_DEFAULT_SERVER_URL → assets capacitor.config.json → 官方常量。
 * 构建期默认地址按可信值放行（允许 HTTP）；allow_http 只约束用户输入。
 */
public final class ServerConfigStore {

    private static final String PREFS = "mao_server_config";
    private static final String KEY_URL = "server_base_url";
    private static final String KEY_ALLOW_HTTP = "allow_http";
    private static final String KEY_HISTORY = "history";
    private static final String DEFAULT_URL = "https://mao.etarch.cn";

    private static volatile String cachedAssetServerUrl;
    private static volatile boolean assetServerUrlLoaded;

    private ServerConfigStore() {}

    public static String getEffectiveBaseUrl(Context context) {
        SharedPreferences prefs = prefs(context);
        String saved = prefs.getString(KEY_URL, null);
        boolean savedAllowHttp = prefs.getBoolean(KEY_ALLOW_HTTP, false);
        return resolveEffectiveBaseUrl(
                saved,
                savedAllowHttp,
                BuildConfig.MAO_DEFAULT_SERVER_URL,
                readAssetServerUrl(context)
        );
    }

    /** 纯函数：便于 JVM 单测覆盖优先级与损坏配置回落。 */
    public static String resolveEffectiveBaseUrl(
            String saved,
            boolean savedAllowHttp,
            String buildDefault,
            String assetDefault
    ) {
        ServerUrlNormalizer.Result result = ServerUrlNormalizer.normalize(saved, savedAllowHttp);
        if (result.ok) return result.baseUrl;

        result = ServerUrlNormalizer.normalize(buildDefault, true);
        if (result.ok) return result.baseUrl;

        result = ServerUrlNormalizer.normalize(assetDefault, true);
        if (result.ok) return result.baseUrl;

        return DEFAULT_URL;
    }

    public static boolean save(Context context, String url, boolean allowHttp) {
        ServerUrlNormalizer.Result normalized = ServerUrlNormalizer.normalize(url, allowHttp);
        if (!normalized.ok) return false;
        SharedPreferences prefs = prefs(context);
        String now = nowIso();
        String history = ServerHistory.merge(
                prefs.getString(KEY_HISTORY, "[]"),
                normalized.baseUrl,
                allowHttp,
                now
        );
        return prefs.edit()
                .putString(KEY_URL, normalized.baseUrl)
                .putBoolean(KEY_ALLOW_HTTP, allowHttp)
                .putString(KEY_HISTORY, history)
                .commit();
    }

    public static boolean getAllowHttp(Context context) {
        return prefs(context).getBoolean(KEY_ALLOW_HTTP, false);
    }

    public static List<ServerHistory.Entry> getHistory(Context context) {
        return ServerHistory.parse(prefs(context).getString(KEY_HISTORY, "[]"));
    }

    public static boolean removeHistory(Context context, String serverBaseUrl) {
        SharedPreferences prefs = prefs(context);
        String history = ServerHistory.remove(prefs.getString(KEY_HISTORY, "[]"), serverBaseUrl);
        return prefs.edit().putString(KEY_HISTORY, history).commit();
    }

    public static String readAssetServerUrl(Context context) {
        if (assetServerUrlLoaded) return cachedAssetServerUrl;
        synchronized (ServerConfigStore.class) {
            if (!assetServerUrlLoaded) {
                cachedAssetServerUrl = loadAssetServerUrl(context);
                assetServerUrlLoaded = true;
            }
            return cachedAssetServerUrl;
        }
    }

    private static String loadAssetServerUrl(Context context) {
        try (InputStream input = context.getAssets().open("capacitor.config.json")) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            JSONObject config = new JSONObject(output.toString("UTF-8"));
            JSONObject server = config.optJSONObject("server");
            if (server == null) return null;
            String url = server.optString("url", null);
            return url == null || url.isEmpty() ? null : url;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String nowIso() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }
}