package cn.etarch.mao.weixin.config;

import okhttp3.ConnectionSpec;
import okhttp3.Dns;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.security.KeyStore;
import java.security.Security;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * 微信模块公共 OkHttp 配置。
 * <ul>
 *   <li>强制使用 IPv4，避免服务器无 IPv6 出站路由时连接失败</li>
 *   <li>启用 TLS_RSA_WITH_AES_256_GCM_SHA384 cipher，兼容微信 CDN（Java 21 默认禁用纯 RSA 密钥交换）</li>
 * </ul>
 */
@Configuration
public class WeixinOkHttpConfig {

    /** 强制使用 IPv4 的 DNS 解析器 */
    public static final Dns IPV4_ONLY = hostname -> {
        List<InetAddress> addresses = Dns.SYSTEM.lookup(hostname);
        List<InetAddress> ipv4 = addresses.stream()
                .filter(addr -> addr instanceof Inet4Address)
                .collect(Collectors.toList());
        return ipv4.isEmpty() ? addresses : ipv4;
    };

    static {
        // Java 21 默认禁用 TLS_RSA_* cipher（无前向保密），但微信 CDN 仅支持此类 cipher
        // 移除此限制以允许连接微信 CDN
        enableWeixinCiphers();
    }

    /**
     * 移除 Java 21 对 TLS_RSA_* cipher 的禁用限制。
     * 微信 CDN (novac2c.cdn.weixin.qq.com) 仅支持 TLS_RSA_WITH_AES_256_GCM_SHA384，
     * 而 Java 21 的 jdk.tls.disabledAlgorithms 默认包含 "TLS_RSA_*"。
     */
    private static void enableWeixinCiphers() {
        try {
            String disabledAlgorithms = Security.getProperty("jdk.tls.disabledAlgorithms");
            if (disabledAlgorithms != null && disabledAlgorithms.contains("TLS_RSA_*")) {
                String modified = disabledAlgorithms
                        .replace("TLS_RSA_*", "")
                        .replaceAll(",\\s*,", ",")
                        .replaceAll("^,|,$", "")
                        .trim();
                Security.setProperty("jdk.tls.disabledAlgorithms", modified);
            }
        } catch (Exception e) {
            // 忽略安全限制修改失败，降级使用默认配置
        }
    }

    /**
     * 获取兼容微信 CDN 的 SSLSocketFactory。
     * 用于需要自定义超时配置的 OkHttpClient。
     */
    public static javax.net.ssl.SSLSocketFactory createSslSocketFactory() {
        try {
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new javax.net.ssl.TrustManager[]{getDefaultTrustManager()}, null);
            return context.getSocketFactory();
        } catch (Exception e) {
            throw new RuntimeException("Failed to create SSLSocketFactory", e);
        }
    }

    /**
     * 获取系统默认的 TrustManager，保持证书验证。
     */
    public static X509TrustManager getDefaultTrustManager() {
        try {
            TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            factory.init((KeyStore) null);
            for (javax.net.ssl.TrustManager tm : factory.getTrustManagers()) {
                if (tm instanceof X509TrustManager) {
                    return (X509TrustManager) tm;
                }
            }
            throw new IllegalStateException("No X509TrustManager found");
        } catch (Exception e) {
            throw new RuntimeException("Failed to get default TrustManager", e);
        }
    }

    @Bean("weixinHttpClient")
    public okhttp3.OkHttpClient weixinHttpClient() {
        X509TrustManager trustManager = getDefaultTrustManager();
        try {
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new javax.net.ssl.TrustManager[]{trustManager}, null);

            return new okhttp3.OkHttpClient.Builder()
                    .connectTimeout(10, TimeUnit.SECONDS)
                    .readTimeout(60, TimeUnit.SECONDS)
                    .dns(IPV4_ONLY)
                    .sslSocketFactory(context.getSocketFactory(), trustManager)
                    .connectionSpecs(List.of(
                            ConnectionSpec.MODERN_TLS,
                            ConnectionSpec.COMPATIBLE_TLS,
                            ConnectionSpec.CLEARTEXT))
                    .build();
        } catch (Exception e) {
            throw new RuntimeException("Failed to create weixinHttpClient", e);
        }
    }

    /** 文件下载专用 client：大文件（≤100MB）读取超时放宽到 180s */
    @Bean("weixinFileHttpClient")
    public okhttp3.OkHttpClient weixinFileHttpClient() {
        X509TrustManager trustManager = getDefaultTrustManager();
        try {
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new javax.net.ssl.TrustManager[]{trustManager}, null);

            return new okhttp3.OkHttpClient.Builder()
                    .connectTimeout(10, TimeUnit.SECONDS)
                    .readTimeout(180, TimeUnit.SECONDS)
                    .dns(IPV4_ONLY)
                    .sslSocketFactory(context.getSocketFactory(), trustManager)
                    .connectionSpecs(List.of(
                            ConnectionSpec.MODERN_TLS,
                            ConnectionSpec.COMPATIBLE_TLS,
                            ConnectionSpec.CLEARTEXT))
                    .build();
        } catch (Exception e) {
            throw new RuntimeException("Failed to create weixinFileHttpClient", e);
        }
    }
}
