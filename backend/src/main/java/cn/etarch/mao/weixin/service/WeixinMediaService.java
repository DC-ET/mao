package cn.etarch.mao.weixin.service;

import cn.etarch.mao.harness.tool.ImageFileSupport;
import cn.etarch.mao.harness.tool.PromptImageResizer;
import cn.etarch.mao.weixin.config.WeixinBotConfig;
import cn.etarch.mao.weixin.config.WeixinOkHttpConfig;
import com.fasterxml.jackson.databind.JsonNode;
import lombok.extern.slf4j.Slf4j;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
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
public class WeixinMediaService {

    private final WeixinBotConfig weixinBotConfig;
    private final OkHttpClient httpClient;
    private final OkHttpClient fileHttpClient;

    public WeixinMediaService(WeixinBotConfig weixinBotConfig,
                              @Qualifier("weixinHttpClient") OkHttpClient httpClient,
                              @Qualifier("weixinFileHttpClient") OkHttpClient fileHttpClient) {
        this.weixinBotConfig = weixinBotConfig;
        this.httpClient = httpClient;
        this.fileHttpClient = fileHttpClient;
    }

    public record DownloadedMedia(Path path, String mimeType, String dataUri) {
    }

    public record DownloadedFile(String fileName, byte[] bytes, String mimeType) {
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
            PromptImageResizer.Result resized = PromptImageResizer.tryResizeForPrompt(plaintext, mime)
                    .orElse(null);
            byte[] outBytes = resized != null ? resized.bytes() : plaintext;
            String outMime = resized != null ? resized.mime() : mime;
            String ext = extensionForMime(outMime);
            Path dir = Path.of(System.getProperty("java.io.tmpdir"), "weixin-media");
            Files.createDirectories(dir);
            Path path = dir.resolve(UUID.randomUUID() + ext);
            Files.write(path, outBytes);

            String dataUri = "data:" + outMime + ";base64," + Base64.getEncoder().encodeToString(outBytes);
            return Optional.of(new DownloadedMedia(path, outMime, dataUri));
        } catch (Exception e) {
            log.error("下载或解密微信图片失败", e);
            return Optional.empty();
        }
    }

    /**
     * 从 file_item 下载并解密文件（PDF、Office、zip 等任意类型）。
     * <p>
     * 与 {@link #downloadImage} 同协议：CDN 下载密文 → AES-128-ECB 解密；
     * 不做图片压缩与图片大小限制，大文件使用放宽超时的专用 client。
     */
    public Optional<DownloadedFile> downloadFile(JsonNode fileItem) {
        if (fileItem == null || fileItem.isNull()) {
            return Optional.empty();
        }

        String encryptQueryParam = resolveEncryptQueryParam(fileItem);
        if (encryptQueryParam == null || encryptQueryParam.isBlank()) {
            log.warn("文件消息缺少 encrypt_query_param");
            return Optional.empty();
        }

        // 下载参数与 AES key 基于同一媒体节点解析（media → thumb_media → null），保证回退时同源
        JsonNode media = resolveMediaNode(fileItem);
        byte[] aesKey = resolveAesKey(fileItem, media);
        try {
            byte[] ciphertext = downloadCiphertext(encryptQueryParam, fileHttpClient);
            if (ciphertext == null || ciphertext.length == 0) {
                return Optional.empty();
            }

            byte[] plaintext;
            if (aesKey != null) {
                plaintext = decryptAes128Ecb(ciphertext, aesKey);
            } else {
                log.warn("文件消息缺少 AES key，尝试按明文处理");
                plaintext = ciphertext;
            }

            String fileName = extractFileName(fileItem);
            String mime = detectFileMime(plaintext, fileName);
            return Optional.of(new DownloadedFile(fileName, plaintext, mime));
        } catch (Exception e) {
            log.error("下载或解密微信文件失败", e);
            return Optional.empty();
        }
    }

    /**
     * 返回持有有效 encrypt_query_param 的媒体节点：media → thumb_media → null。
     * 与 {@link #resolveEncryptQueryParam} 同源，保证 AES key 与下载参数来自同一节点。
     */
    static JsonNode resolveMediaNode(JsonNode fileItem) {
        if (fileItem == null || fileItem.isNull()) {
            return null;
        }
        for (String mediaField : List.of("media", "thumb_media")) {
            JsonNode media = fileItem.get(mediaField);
            if (media != null && !media.isNull()) {
                String param = textOrNull(media.get("encrypt_query_param"));
                if (param != null && !param.isBlank()) {
                    return media;
                }
            }
        }
        return null;
    }

    /**
     * 解析 encrypt_query_param，按字段位置回退：
     * media.encrypt_query_param → thumb_media.encrypt_query_param → file_item.encrypt_query_param。
     */
    static String resolveEncryptQueryParam(JsonNode fileItem) {
        JsonNode media = resolveMediaNode(fileItem);
        if (media != null) {
            return textOrNull(media.get("encrypt_query_param"));
        }
        return textOrNull(fileItem != null ? fileItem.get("encrypt_query_param") : null);
    }

    /**
     * 提取 file_item 中的原始文件名；缺失时生成默认名。
     */
    private String extractFileName(JsonNode fileItem) {
        String name = textOrNull(fileItem.get("file_name"));
        if (name == null || name.isBlank()) {
            JsonNode media = fileItem.get("media");
            String mediaName = media != null ? textOrNull(media.get("file_name")) : null;
            if (mediaName != null && !mediaName.isBlank()) {
                name = mediaName;
            }
        }
        if (name == null || name.isBlank()) {
            return "file-" + UUID.randomUUID() + ".bin";
        }
        return name;
    }

    /**
     * 基于魔数与扩展名探测文件 MIME，用于记录；不影响保存与读取。
     */
    static String detectFileMime(byte[] bytes, String fileName) {
        if (bytes != null && bytes.length >= 4
                && bytes[0] == '%' && bytes[1] == 'P' && bytes[2] == 'D' && bytes[3] == 'F') {
            return "application/pdf";
        }
        String lower = fileName != null ? fileName.toLowerCase(Locale.ROOT) : "";
        int dot = lower.lastIndexOf('.');
        if (dot >= 0 && dot < lower.length() - 1) {
            return switch (lower.substring(dot + 1)) {
                case "pdf" -> "application/pdf";
                case "txt", "md", "markdown" -> "text/plain";
                case "doc" -> "application/msword";
                case "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
                case "xls" -> "application/vnd.ms-excel";
                case "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
                case "ppt" -> "application/vnd.ms-powerpoint";
                case "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation";
                case "png" -> "image/png";
                case "jpg", "jpeg" -> "image/jpeg";
                case "gif" -> "image/gif";
                case "webp" -> "image/webp";
                case "zip" -> "application/zip";
                case "json" -> "application/json";
                case "csv" -> "text/csv";
                default -> "application/octet-stream";
            };
        }
        return "application/octet-stream";
    }

    byte[] downloadCiphertext(String encryptQueryParam) throws Exception {
        return downloadCiphertext(encryptQueryParam, httpClient);
    }

    byte[] downloadCiphertext(String encryptQueryParam, OkHttpClient client) throws Exception {
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
        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                log.error("CDN 下载失败: HTTP {}", response.code());
                return null;
            }
            return response.body().bytes();
        }
    }

    /**
     * 解析 AES key，按字段位置回退：
     * item.aeskey → item.aes_key → media.aes_key。
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

        // 兼容 aes_key 直接位于 item 级（部分 file_item 结构）
        String itemAesKey = textOrNull(imageItem != null ? imageItem.get("aes_key") : null);
        if (itemAesKey != null && !itemAesKey.isBlank()) {
            byte[] decoded = decodeAesKey(itemAesKey.trim());
            if (decoded != null) {
                return decoded;
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
