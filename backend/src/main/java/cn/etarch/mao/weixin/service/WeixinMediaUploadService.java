package cn.etarch.mao.weixin.service;

import cn.etarch.mao.weixin.config.WeixinBotConfig;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.springframework.stereotype.Service;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;

/**
 * iLink 媒体上传：getuploadurl → AES-128-ECB 加密 → CDN upload。
 * <p>
 * 协议见 docs/weixin-bot-channel-integration-guide.md 与 iLink 协议规范：
 * <ol>
 *   <li>POST /ilink/bot/getuploadurl 申请上传参数（upload_param）</li>
 *   <li>本地用随机 16 字节 key 做 AES-128-ECB + PKCS7 加密</li>
 *   <li>POST CDN /c2c/upload 上传密文，响应头 x-encrypted-param 即 CDNMedia.encrypt_query_param</li>
 * </ol>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WeixinMediaUploadService {

    /** getuploadurl 的媒体类型：3 = FILE，4 = VOICE */
    private static final int MEDIA_TYPE_FILE = 3;
    private static final int MEDIA_TYPE_VOICE = 4;

    private final WeixinBotConfig weixinBotConfig;
    private final WeixinAccountRepository accountRepository;
    private final ObjectMapper objectMapper;

    private final OkHttpClient httpClient = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build();

    private final SecureRandom secureRandom = new SecureRandom();

    /**
     * 上传后的 CDN 媒体引用，用于 sendmessage 的 voice_item/file_item.media。
     *
     * @param rawSize  明文大小（file_item.len）
     * @param rawMd5   明文 MD5（file_item.md5）
     */
    public record CdnMedia(String encryptQueryParam, String aesKey, int encryptType,
                           long size, int rawSize, String rawMd5) {
    }

    /**
     * 上传音频密文到微信 CDN（作为文件消息，media_type=FILE）。
     *
     * @param account   绑定账号（含 baseUrl / botToken）
     * @param toUserId  目标用户 ID
     * @param plaintext 明文音频文件（MP3 等）
     * @return CDN 媒体引用；任一环节失败返回 empty
     */
    public Optional<CdnMedia> uploadAudioFile(WeixinChannelAccount account, String toUserId, byte[] plaintext) {
        return uploadMedia(account, toUserId, MEDIA_TYPE_FILE, plaintext);
    }

    /**
     * 上传语音密文到微信 CDN（语音条，media_type=VOICE）。
     */
    public Optional<CdnMedia> uploadVoice(WeixinChannelAccount account, String toUserId, byte[] plaintext) {
        return uploadMedia(account, toUserId, MEDIA_TYPE_VOICE, plaintext);
    }

    private Optional<CdnMedia> uploadMedia(WeixinChannelAccount account, String toUserId,
                                           int mediaType, byte[] plaintext) {
        try {
            JsonNode payload = objectMapper.readTree(account.getPayloadJson());
            String botToken = payload.get("token").asText();
            String baseUrl = payload.get("baseUrl").asText();

            // 1. 生成 filekey 与 AES key（16 字节 hex）
            String filekey = randomHex(16);
            String aesKeyHex = randomHex(16);

            // 2. 计算 rawsize / rawfilemd5 / filesize（PKCS7 填充后密文大小）
            int rawsize = plaintext.length;
            String rawfilemd5 = md5Hex(plaintext);
            int filesize = (rawsize / 16 + 1) * 16;

            // 3. 申请上传参数（优先 upload_full_url，回退 upload_param）
            String uploadUrl = requestUploadUrl(baseUrl, botToken, toUserId,
                    filekey, aesKeyHex, mediaType, rawsize, rawfilemd5, filesize);
            if (uploadUrl == null || uploadUrl.isBlank()) {
                log.warn("微信媒体上传：getuploadurl 未返回上传地址, accountId={}", account.getAccountId());
                return Optional.empty();
            }

            // 4. AES-128-ECB 加密
            byte[] ciphertext = encryptAesEcb(plaintext, hexToBytes(aesKeyHex));

            // 5. CDN 上传，取 x-encrypted-param
            String encryptedParam = uploadToCdn(uploadUrl, ciphertext);
            if (encryptedParam == null || encryptedParam.isBlank()) {
                log.warn("微信媒体上传：CDN 上传未返回 x-encrypted-param, accountId={}", account.getAccountId());
                return Optional.empty();
            }

            // 6. aes_key 使用协议格式 B：base64(hex string)
            String aesKeyB64 = Base64.getEncoder()
                    .encodeToString(aesKeyHex.getBytes(StandardCharsets.US_ASCII));

            log.info("微信媒体上传成功, accountId={}, mediaType={}, rawsize={}, ciphertext={}",
                    account.getAccountId(), mediaType, rawsize, ciphertext.length);
            return Optional.of(new CdnMedia(encryptedParam, aesKeyB64, 1,
                    ciphertext.length, rawsize, rawfilemd5));
        } catch (Exception e) {
            log.warn("微信媒体上传失败, accountId={}: {}", account.getAccountId(), e.getMessage());
            return Optional.empty();
        }
    }

    /**
     * POST /ilink/bot/getuploadurl 申请上传地址。
     * <p>
     * 实际协议返回 {@code upload_full_url}（完整 CDN 上传 URL，含 encrypted_query_param 与 filekey）；
     * 旧版协议返回 {@code upload_param}（需与 CDN base 拼接）。
     *
     * @return 可直接上传的完整 URL；失败返回 null
     */
    private String requestUploadUrl(String baseUrl, String botToken, String toUserId,
                                    String filekey, String aesKeyHex, int mediaType,
                                    int rawsize, String rawfilemd5, int filesize) throws Exception {
        Map<String, Object> body = Map.of(
                "filekey", filekey,
                "media_type", mediaType,
                "to_user_id", toUserId,
                "rawsize", rawsize,
                "rawfilemd5", rawfilemd5,
                "filesize", filesize,
                "no_need_thumb", true,
                "aeskey", aesKeyHex,
                "base_info", Map.of("channel_version", "mao-server-1.0")
        );
        String json = objectMapper.writeValueAsString(body);

        Request request = new Request.Builder()
                .url(baseUrl + "/ilink/bot/getuploadurl")
                .post(RequestBody.create(json, MediaType.parse("application/json")))
                .addHeader("Content-Type", "application/json")
                .addHeader("AuthorizationType", "ilink_bot_token")
                .addHeader("Authorization", "Bearer " + botToken)
                .addHeader("X-WECHAT-UIN", randomWechatUin())
                .build();

        try (Response response = httpClient.newCall(request).execute()) {
            String responseBody = response.body() != null ? response.body().string() : "";
            if (!response.isSuccessful()) {
                log.warn("微信媒体上传：getuploadurl HTTP {}, body={}", response.code(),
                        responseBody.length() > 500 ? responseBody.substring(0, 500) : responseBody);
                return null;
            }
            JsonNode node = objectMapper.readTree(responseBody);
            JsonNode fullUrl = node.get("upload_full_url");
            if (fullUrl != null && !fullUrl.asText().isBlank()) {
                return fullUrl.asText();
            }
            JsonNode uploadParam = node.get("upload_param");
            if (uploadParam != null && !uploadParam.asText().isBlank()) {
                String cdnBase = weixinBotConfig.getCdnBaseUrl();
                if (cdnBase == null || cdnBase.isBlank()) {
                    cdnBase = "https://novac2c.cdn.weixin.qq.com/c2c";
                }
                if (cdnBase.endsWith("/")) {
                    cdnBase = cdnBase.substring(0, cdnBase.length() - 1);
                }
                return cdnBase + "/upload?encrypted_query_param="
                        + java.net.URLEncoder.encode(uploadParam.asText(), StandardCharsets.UTF_8)
                        + "&filekey=" + filekey;
            }
            log.warn("微信媒体上传：getuploadurl 响应缺少 upload_full_url/upload_param, body={}",
                    responseBody.length() > 500 ? responseBody.substring(0, 500) : responseBody);
            return null;
        }
    }

    /**
     * POST CDN /upload 上传密文，返回 x-encrypted-param。
     */
    private String uploadToCdn(String uploadUrl, byte[] ciphertext) throws Exception {
        Request request = new Request.Builder()
                .url(uploadUrl)
                .post(RequestBody.create(ciphertext, MediaType.parse("application/octet-stream")))
                .build();

        try (Response response = httpClient.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                String errMsg = response.header("x-error-message");
                log.warn("微信媒体上传：CDN upload HTTP {}, x-error-message={}",
                        response.code(), errMsg);
                return null;
            }
            return response.header("x-encrypted-param");
        }
    }

    private byte[] encryptAesEcb(byte[] plaintext, byte[] key) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/ECB/PKCS5Padding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"));
        return cipher.doFinal(plaintext);
    }

    private String md5Hex(byte[] bytes) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("MD5");
        byte[] md5 = digest.digest(bytes);
        StringBuilder sb = new StringBuilder(md5.length * 2);
        for (byte b : md5) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    private String randomHex(int byteLen) {
        byte[] bytes = new byte[byteLen];
        secureRandom.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(byteLen * 2);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    private static byte[] hexToBytes(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    /**
     * X-WECHAT-UIN：随机 uint32 十进制字符串的 base64，每次请求重新生成。
     */
    private String randomWechatUin() {
        int value = ThreadLocalRandom.current().nextInt();
        return Base64.getEncoder()
                .encodeToString(String.valueOf(value & 0xFFFFFFFFL).getBytes(StandardCharsets.UTF_8));
    }
}
