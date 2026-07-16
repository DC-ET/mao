package cn.etarch.mao.weixin.service;

import cn.etarch.mao.harness.tool.ImageFileSupport;
import cn.etarch.mao.weixin.config.WeixinBotConfig;
import com.fasterxml.jackson.databind.JsonNode;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.springframework.stereotype.Service;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * 微信入站媒体下载与 AES-128-ECB 解密。
 * 协议见 docs/weixin-bot-channel-integration-guide.md 与 ilink CDN 规范。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WeixinMediaService {

    private final WeixinBotConfig weixinBotConfig;

    private final OkHttpClient httpClient = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build();

    public record DownloadedMedia(Path path, String mimeType, String dataUri) {
    }

    /**
     * 从 image_item 下载并解密图片。
     */
    public Optional<DownloadedMedia> downloadImage(JsonNode imageItem) {
        if (imageItem == null || imageItem.isNull()) {
            return Optional.empty();
        }

        JsonNode media = imageItem.get("media");
        if (media == null || media.isNull()) {
            media = imageItem.get("thumb_media");
        }
        if (media == null || media.isNull()) {
            log.warn("图片消息缺少 media/thumb_media");
            return Optional.empty();
        }

        String encryptQueryParam = textOrNull(media.get("encrypt_query_param"));
        if (encryptQueryParam == null || encryptQueryParam.isBlank()) {
            log.warn("图片消息缺少 encrypt_query_param");
            return Optional.empty();
        }

        byte[] aesKey = resolveAesKey(imageItem, media);
        try {
            byte[] ciphertext = downloadCiphertext(encryptQueryParam);
            if (ciphertext == null || ciphertext.length == 0) {
                return Optional.empty();
            }

            byte[] plaintext;
            if (aesKey != null) {
                plaintext = decryptAes128Ecb(ciphertext, aesKey);
            } else {
                log.warn("图片消息缺少 AES key，尝试按明文处理");
                plaintext = ciphertext;
            }

            if (plaintext.length > ImageFileSupport.MAX_IMAGE_BYTES) {
                log.warn("图片过大: {} > {}", ImageFileSupport.formatSize(plaintext.length),
                        ImageFileSupport.formatSize(ImageFileSupport.MAX_IMAGE_BYTES));
                return Optional.empty();
            }

            String mime = ImageFileSupport.detectMimeFromBytes(plaintext).orElse("image/jpeg");
            String ext = extensionForMime(mime);
            Path dir = Path.of(System.getProperty("java.io.tmpdir"), "weixin-media");
            Files.createDirectories(dir);
            Path path = dir.resolve(UUID.randomUUID() + ext);
            Files.write(path, plaintext);

            String dataUri = "data:" + mime + ";base64," + Base64.getEncoder().encodeToString(plaintext);
            return Optional.of(new DownloadedMedia(path, mime, dataUri));
        } catch (Exception e) {
            log.error("下载或解密微信图片失败", e);
            return Optional.empty();
        }
    }

    byte[] downloadCiphertext(String encryptQueryParam) throws Exception {
        String cdnBase = weixinBotConfig.getCdnBaseUrl();
        if (cdnBase == null || cdnBase.isBlank()) {
            cdnBase = "https://novac2c.cdn.weixin.qq.com/c2c";
        }
        if (cdnBase.endsWith("/")) {
            cdnBase = cdnBase.substring(0, cdnBase.length() - 1);
        }

        HttpUrl url = HttpUrl.parse(cdnBase + "/download");
        if (url == null) {
            throw new IllegalArgumentException("非法 CDN baseUrl: " + cdnBase);
        }
        HttpUrl fullUrl = url.newBuilder()
                .addQueryParameter("encrypted_query_param", encryptQueryParam)
                .build();

        Request request = new Request.Builder().url(fullUrl).get().build();
        try (Response response = httpClient.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                log.error("CDN 下载失败: HTTP {}", response.code());
                return null;
            }
            return response.body().bytes();
        }
    }

    /**
     * 解析 AES key：优先 image_item.aeskey（32 位 hex），否则解析 media.aes_key。
     */
    static byte[] resolveAesKey(JsonNode imageItem, JsonNode media) {
        String imageAesKey = textOrNull(imageItem != null ? imageItem.get("aeskey") : null);
        if (imageAesKey != null && !imageAesKey.isBlank()) {
            byte[] fromHex = tryHexDecode(imageAesKey.trim());
            if (fromHex != null && fromHex.length == 16) {
                return fromHex;
            }
            byte[] fromBase64 = decodeAesKey(imageAesKey.trim());
            if (fromBase64 != null) {
                return fromBase64;
            }
        }

        String mediaAesKey = textOrNull(media != null ? media.get("aes_key") : null);
        if (mediaAesKey != null && !mediaAesKey.isBlank()) {
            return decodeAesKey(mediaAesKey.trim());
        }
        return null;
    }

    /**
     * 兼容两种 aes_key 编码：
     * 1) base64(raw 16 bytes)
     * 2) base64(hex 32 chars ASCII) → 再 hex decode 成 16 bytes
     * 另支持直接 32 位 hex 字符串。
     */
    static byte[] decodeAesKey(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String trimmed = raw.trim();
        byte[] directHex = tryHexDecode(trimmed);
        if (directHex != null && directHex.length == 16) {
            return directHex;
        }

        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(trimmed);
        } catch (IllegalArgumentException e) {
            return null;
        }

        if (decoded.length == 16) {
            return decoded;
        }
        if (decoded.length == 32) {
            String asAscii = new String(decoded, StandardCharsets.US_ASCII);
            byte[] hexDecoded = tryHexDecode(asAscii);
            if (hexDecoded != null && hexDecoded.length == 16) {
                return hexDecoded;
            }
        }
        return null;
    }

    static byte[] decryptAes128Ecb(byte[] ciphertext, byte[] key) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/ECB/PKCS5Padding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"));
        return cipher.doFinal(ciphertext);
    }

    private static byte[] tryHexDecode(String hex) {
        if (hex == null) {
            return null;
        }
        String s = hex.trim();
        if (s.length() % 2 != 0) {
            return null;
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean ok = (c >= '0' && c <= '9')
                    || (c >= 'a' && c <= 'f')
                    || (c >= 'A' && c <= 'F');
            if (!ok) {
                return null;
            }
        }
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    private static String extensionForMime(String mime) {
        if (mime == null) {
            return ".jpg";
        }
        return switch (mime.toLowerCase(Locale.ROOT)) {
            case "image/png" -> ".png";
            case "image/gif" -> ".gif";
            case "image/webp" -> ".webp";
            default -> ".jpg";
        };
    }

    private static String textOrNull(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        return node.asText(null);
    }
}
