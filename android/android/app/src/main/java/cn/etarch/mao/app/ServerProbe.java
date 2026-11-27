package cn.etarch.mao.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

import javax.net.ssl.SSLException;

/**
 * 站点探测：health → version.json → 首页。
 *
 * 纯网络工具，后台线程调用；不携带 token/cookie，不修改配置。
 * 只接受站点根；跨 origin 重定向返回 REDIRECT_ORIGIN，由 picker 要求用户改用最终地址。
 */
public final class ServerProbe {

    private static final int CONNECT_TIMEOUT_MS = 5_000;
    private static final int READ_TIMEOUT_MS = 5_000;
    private static final int MAX_REDIRECTS = 5;
    private static final int MAX_BODY_BYTES = 64 * 1024;
    private static final Pattern VERSION_PATTERN = Pattern.compile("\"version\"\\s*:\\s*\"[^\"]+\"");

    private ServerProbe() {}

    public static final class Result {
        public final boolean ok;
        public final String detail;
        public final String errorCode;
        public final String finalBaseUrl;

        private Result(boolean ok, String detail, String errorCode, String finalBaseUrl) {
            this.ok = ok;
            this.detail = detail;
            this.errorCode = errorCode;
            this.finalBaseUrl = finalBaseUrl;
        }

        public static Result ok(String detail) {
            return new Result(true, detail, null, null);
        }

        public static Result error(String errorCode) {
            return new Result(false, null, errorCode, null);
        }

        public static Result redirect(String finalBaseUrl) {
            return new Result(false, null, "REDIRECT_ORIGIN", finalBaseUrl);
        }
    }

    public static Result probe(String baseUrl, String userAgent) {
        if (baseUrl == null || baseUrl.isEmpty()) return Result.error("INVALID_URL");
        String base = stripTrailingSlash(baseUrl);
        String baseOrigin = originOf(base);
        if (baseOrigin == null) return Result.error("INVALID_URL");

        FetchResult health = fetch(base + "/api/v1/health", userAgent);
        Result redirected = redirectResult(health, baseOrigin);
        if (redirected != null) return redirected;
        if (health.errorCode != null) return Result.error(health.errorCode);
        if (health.isSuccess() && isHealthBody(health.body)) {
            return Result.ok("API 可达（health）");
        }

        FetchResult version = fetch(base + "/version.json", userAgent);
        redirected = redirectResult(version, baseOrigin);
        if (redirected != null) return redirected;
        if (version.errorCode != null) return Result.error(version.errorCode);
        if (version.isSuccess() && isVersionBody(version.body)) {
            return Result.ok("站点可达（version.json）");
        }

        FetchResult home = fetch(base + "/", userAgent);
        redirected = redirectResult(home, baseOrigin);
        if (redirected != null) return redirected;
        if (home.errorCode != null) return Result.error(home.errorCode);
        if (home.isSuccess() && isMaoHome(home.body)) {
            return Result.ok("站点可达（首页，未验证 API）");
        }

        int status = 0;
        if (health.status >= 400) status = health.status;
        else if (version.status >= 400) status = version.status;
        else if (home.status >= 400) status = home.status;
        return Result.error(status > 0 ? "HTTP_" + status : "NOT_MAO");
    }

    /** 把内部错误码翻成用户可读文案；未知码原样返回，便于排查。 */
    public static String describeError(String errorCode) {
        if (errorCode == null || errorCode.isEmpty()) return "未知错误";
        if (errorCode.startsWith("HTTP_")) return "站点返回 HTTP " + errorCode.substring("HTTP_".length());
        switch (errorCode) {
            case "INVALID_URL":
                return "地址格式无效";
            case "DNS":
                return "域名解析失败";
            case "TIMEOUT":
                return "连接超时";
            case "TLS":
                return "TLS 证书校验失败";
            case "IO":
                return "网络连接失败";
            case "NOT_MAO":
                return "该地址不是可识别的 Mao 站点";
            case "REDIRECT_LOOP":
                return "重定向次数过多";
            default:
                return errorCode;
        }
    }

    public static boolean isHealthBody(String body) {
        if (body == null || body.isEmpty()) return false;
        String compact = body.replaceAll("\\s+", "");
        // 只认后端 /api/v1/health 的 status=UP；单独的 code=0 任何 Result 信封都有，不能作为判据。
        return compact.contains("\"status\":\"UP\"");
    }

    public static boolean isVersionBody(String body) {
        return body != null && VERSION_PATTERN.matcher(body).find();
    }

    public static boolean isMaoHome(String body) {
        if (body == null || body.isEmpty()) return false;
        String lower = body.toLowerCase(Locale.ROOT);
        return lower.contains("<title>mao") || lower.contains("id=\"app\"") || lower.contains("id='app'");
    }

    private static Result redirectResult(FetchResult result, String baseOrigin) {
        if (result.errorCode != null || result.finalUrl == null) return null;
        String finalOrigin = originOf(result.finalUrl);
        if (finalOrigin != null && !finalOrigin.equalsIgnoreCase(baseOrigin)) {
            return Result.redirect(finalOrigin);
        }
        return null;
    }

    private static FetchResult fetch(String url, String userAgent) {
        String current = url;
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(current).openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setRequestProperty("User-Agent", userAgent == null ? "MaoAndroid" : userAgent);
                connection.setRequestProperty("Accept", "application/json, text/html, */*");
                connection.setRequestProperty("Cache-Control", "no-cache");

                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || location.isEmpty()) {
                        return FetchResult.error("HTTP_" + status);
                    }
                    current = new URL(new URL(current), location).toString();
                    continue;
                }

                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                String body = readBody(stream);
                return new FetchResult(status, body, current, null);
            } catch (MalformedURLException e) {
                return FetchResult.error("INVALID_URL");
            } catch (UnknownHostException e) {
                return FetchResult.error("DNS");
            } catch (SocketTimeoutException e) {
                return FetchResult.error("TIMEOUT");
            } catch (SSLException e) {
                return FetchResult.error("TLS");
            } catch (IOException e) {
                return FetchResult.error("IO");
            } catch (RuntimeException e) {
                // 例如端口超出 1-65535 时 HttpURLConnection 抛 IllegalArgumentException。
                return FetchResult.error("INVALID_URL");
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
        return FetchResult.error("REDIRECT_LOOP");
    }

    private static String readBody(InputStream stream) {
        if (stream == null) return "";
        try (InputStream input = stream) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                int allowed = Math.min(read, MAX_BODY_BYTES - total);
                if (allowed > 0) output.write(buffer, 0, allowed);
                total += allowed;
                if (total >= MAX_BODY_BYTES) break;
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException ignored) {
            return "";
        }
    }

    private static String originOf(String url) {
        try {
            URL parsed = new URL(url);
            String scheme = parsed.getProtocol().toLowerCase(Locale.ROOT);
            String host = parsed.getHost();
            if (host == null || host.isEmpty()) return null;
            host = host.toLowerCase(Locale.ROOT);
            if (host.contains(":") && !host.startsWith("[")) host = "[" + host + "]";
            int port = parsed.getPort();
            boolean defaultPort = (scheme.equals("http") && port == 80)
                    || (scheme.equals("https") && port == 443);
            return scheme + "://" + host + (port == -1 || defaultPort ? "" : ":" + port);
        } catch (MalformedURLException e) {
            return null;
        }
    }

    private static String stripTrailingSlash(String value) {
        String result = value;
        while (result.endsWith("/")) result = result.substring(0, result.length() - 1);
        return result;
    }

    private static final class FetchResult {
        final int status;
        final String body;
        final String finalUrl;
        final String errorCode;

        FetchResult(int status, String body, String finalUrl, String errorCode) {
            this.status = status;
            this.body = body;
            this.finalUrl = finalUrl;
            this.errorCode = errorCode;
        }

        static FetchResult error(String errorCode) {
            return new FetchResult(0, "", null, errorCode);
        }

        boolean isSuccess() {
            return status >= 200 && status < 300;
        }
    }
}