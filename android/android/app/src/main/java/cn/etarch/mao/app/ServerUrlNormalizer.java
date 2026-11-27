package cn.etarch.mao.app;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * 服务器地址归一化：只接受站点根（origin + port），不接受子路径。
 *
 * 用户可输入站点根 / /api / /api/v1；无 scheme 默认 https。
 * 构建期默认地址（BuildConfig / assets）由调用方以 allowHttp=true 调用。
 */
public final class ServerUrlNormalizer {

    private ServerUrlNormalizer() {}

    public static final class Result {
        public final boolean ok;
        public final String baseUrl;
        public final String error;

        private Result(boolean ok, String baseUrl, String error) {
            this.ok = ok;
            this.baseUrl = baseUrl;
            this.error = error;
        }

        public static Result ok(String baseUrl) {
            return new Result(true, baseUrl, null);
        }

        public static Result error(String error) {
            return new Result(false, null, error);
        }
    }

    public static Result normalize(String input, boolean allowHttp) {
        if (input == null) return Result.error("请填写服务器地址");
        String raw = input.trim();
        if (raw.isEmpty()) return Result.error("请填写服务器地址");

        String lower = raw.toLowerCase(Locale.ROOT);
        String candidate;
        if (lower.startsWith("https://")) {
            candidate = "https://" + raw.substring("https://".length());
        } else if (lower.startsWith("http://")) {
            candidate = "http://" + raw.substring("http://".length());
        } else if (lower.matches("^[a-z][a-z0-9+.-]*://.*")) {
            return Result.error("不支持的协议：" + schemeOf(raw));
        } else if (lower.matches("^[a-z][a-z0-9+.-]*:.*")) {
            // host:port（如 mao.example.com:8443 / localhost:9080）允许；已知非 http(s) scheme 拒绝。
            String scheme = schemeOf(raw);
            if (scheme.equals("http") || scheme.equals("https")) {
                return Result.error("地址格式无效，请补全 " + scheme + "://");
            }
            if (isKnownScheme(scheme)) return Result.error("不支持的协议：" + scheme);
            candidate = "https://" + raw;
        } else {
            candidate = "https://" + raw;
        }

        URI uri;
        try {
            uri = new URI(candidate);
        } catch (URISyntaxException e) {
            return Result.error("服务器地址格式无效");
        }

        String scheme = uri.getScheme();
        if (scheme == null) return Result.error("服务器地址格式无效");
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) {
            return Result.error("不支持的协议：" + scheme);
        }
        if (scheme.equals("http") && !allowHttp) {
            return Result.error("默认仅支持 HTTPS；内网 HTTP 请确认后开启允许");
        }
        if (uri.getRawUserInfo() != null) return Result.error("服务器地址不能包含账号密码");
        if (uri.getRawQuery() != null || uri.getRawFragment() != null) {
            return Result.error("服务器地址不能包含查询参数或片段");
        }

        String host = uri.getHost();
        if (host == null || host.isEmpty()) return Result.error("服务器地址缺少主机名");
        for (int i = 0; i < host.length(); i++) {
            if (host.charAt(i) > 127) return Result.error("主机名请使用 punycode（xn--）形式");
        }

        String path = uri.getRawPath();
        if (path == null) path = "";
        path = stripTrailingSlashes(path);
        String pathLower = path.toLowerCase(Locale.ROOT);
        if (pathLower.endsWith("/api/v1")) {
            path = path.substring(0, path.length() - "/api/v1".length());
        } else if (pathLower.endsWith("/api")) {
            path = path.substring(0, path.length() - "/api".length());
        }
        path = stripTrailingSlashes(path);
        if (!path.isEmpty() && !path.equals("/")) {
            return Result.error("仅支持站点根；子路径部署请使用独立域名");
        }

        String authority = host.toLowerCase(Locale.ROOT);
        if (authority.contains(":") && !authority.startsWith("[")) {
            authority = "[" + authority + "]";
        }
        int port = uri.getPort();
        if (port != -1 && (port < 1 || port > 65535)) {
            return Result.error("端口号无效（1-65535）");
        }
        // 默认端口不写入，保证与 location.origin / URL.origin 的规范形式一致。
        if ((scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80)) {
            port = -1;
        }
        if (port != -1) authority += ":" + port;

        return Result.ok(scheme + "://" + authority);
    }

    private static String stripTrailingSlashes(String path) {
        String result = path;
        while (result.endsWith("/")) result = result.substring(0, result.length() - 1);
        return result;
    }

    private static String schemeOf(String raw) {
        int index = raw.indexOf(':');
        return index > 0 ? raw.substring(0, index).toLowerCase(Locale.ROOT) : raw;
    }

    private static boolean isKnownScheme(String scheme) {
        return scheme.equals("http")
                || scheme.equals("https")
                || scheme.equals("ftp")
                || scheme.equals("ftps")
                || scheme.equals("ws")
                || scheme.equals("wss")
                || scheme.equals("file")
                || scheme.equals("javascript")
                || scheme.equals("data")
                || scheme.equals("about")
                || scheme.equals("blob");
    }
}