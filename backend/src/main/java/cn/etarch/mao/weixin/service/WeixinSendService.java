package cn.etarch.mao.weixin.service;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

@Slf4j
@Service
@RequiredArgsConstructor
public class WeixinSendService {

    private final WeixinAccountRepository accountRepository;
    private final ContextTokenRepository contextTokenRepository;
    private final ObjectMapper objectMapper;
    private final OkHttpClient httpClient = new OkHttpClient.Builder()
            .connectTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .build();

    /**
     * 发送文本消息
     */
    public boolean sendText(String accountId, String toUserId, String text) {
        Map<String, Object> textItem = Map.of(
                "type", 1,
                "text_item", Map.of("text", text)
        );
        return sendMessage(accountId, toUserId, List.of(textItem));
    }

    /**
     * 发送语音消息（SILK，encode_type=6）。
     *
     * @param media      上传后拿到的 CDN 媒体引用
     * @param sampleRate 采样率（Hz），通常 24000
     * @param playtimeMs 播放时长（毫秒）
     * @param transcript 语音转写文本（可空，仅作展示）
     */
    public boolean sendVoice(String accountId, String toUserId,
                             WeixinMediaUploadService.CdnMedia media,
                             int sampleRate, long playtimeMs, String transcript) {
        Map<String, Object> mediaMap = Map.of(
                "encrypt_query_param", media.encryptQueryParam(),
                "aes_key", media.aesKey(),
                "encrypt_type", media.encryptType()
        );
        Map<String, Object> voiceItem = Map.of(
                "type", 3,
                "voice_item", Map.of(
                        "media", mediaMap,
                        "encode_type", 6,
                        "bits_per_sample", 16,
                        "sample_rate", sampleRate,
                        "playtime", playtimeMs,
                        "text", transcript != null ? transcript : ""
                )
        );
        return sendMessage(accountId, toUserId, List.of(voiceItem));
    }

    /**
     * 发送图片消息（image_item，type=2）。
     *
     * @param media 上传后拿到的 CDN 媒体引用（size 为密文长度，即 mid_size）
     */
    public boolean sendImage(String accountId, String toUserId,
                             WeixinMediaUploadService.CdnMedia media) {
        Map<String, Object> mediaMap = Map.of(
                "encrypt_query_param", media.encryptQueryParam(),
                "aes_key", media.aesKey(),
                "encrypt_type", media.encryptType()
        );
        Map<String, Object> imageItem = Map.of(
                "type", 2,
                "image_item", Map.of(
                        "media", mediaMap,
                        "mid_size", media.size()
                )
        );
        return sendMessage(accountId, toUserId, List.of(imageItem));
    }

    /**
     * 发送文件消息（file_item，type=4）。
     *
     * @param media    上传后拿到的 CDN 媒体引用（含 rawSize/rawMd5）
     * @param fileName 文件名（如 xxx.mp3）
     */
    public boolean sendFile(String accountId, String toUserId,
                            WeixinMediaUploadService.CdnMedia media, String fileName) {
        Map<String, Object> mediaMap = Map.of(
                "encrypt_query_param", media.encryptQueryParam(),
                "aes_key", media.aesKey(),
                "encrypt_type", media.encryptType()
        );
        Map<String, Object> fileItem = Map.of(
                "type", 4,
                "file_item", Map.of(
                        "media", mediaMap,
                        "file_name", fileName,
                        "md5", media.rawMd5(),
                        "len", String.valueOf(media.rawSize())
                )
        );
        return sendMessage(accountId, toUserId, List.of(fileItem));
    }

    /**
     * 通用消息发送：组装 sendmessage 请求并解析响应。
     */
    public boolean sendMessage(String accountId, String toUserId, List<Map<String, Object>> itemList) {
        // 1. 获取账号信息
        WeixinChannelAccount account = accountRepository.findByAccountId(accountId);
        if (account == null) {
            log.error("发送消息失败: 账号不存在, accountId={}", accountId);
            return false;
        }

        // 2. 解析账号凭据
        String botToken;
        String baseUrl;
        try {
            JsonNode payload = objectMapper.readTree(account.getPayloadJson());
            botToken = payload.get("token").asText();
            baseUrl = payload.get("baseUrl").asText();
        } catch (Exception e) {
            log.error("解析账号凭据失败, accountId={}", accountId, e);
            return false;
        }

        // 3. 获取context_token
        String contextToken = contextTokenRepository.getLatestToken(accountId, toUserId);
        if (contextToken == null || contextToken.isEmpty()) {
            log.error("发送消息失败: 缺少context_token, accountId={}, toUserId={}", accountId, toUserId);
            return false;
        }

        // 4. 构建消息体（message_state=2 FINISH，稳定投递）
        String clientId = UUID.randomUUID().toString();
        Map<String, Object> message = Map.of(
                "msg", Map.of(
                        "from_user_id", "",
                        "to_user_id", toUserId,
                        "client_id", clientId,
                        "message_type", 2,
                        "message_state", 2,
                        "context_token", contextToken,
                        "item_list", itemList
                ),
                "base_info", Map.of(
                        "channel_version", "mao-server-1.0"
                )
        );

        // 5. 发送请求
        try {
            String jsonBody = objectMapper.writeValueAsString(message);
            String url = baseUrl + "/ilink/bot/sendmessage";

            Request request = new Request.Builder()
                    .url(url)
                    .post(RequestBody.create(jsonBody, MediaType.parse("application/json")))
                    .addHeader("Content-Type", "application/json")
                    .addHeader("AuthorizationType", "ilink_bot_token")
                    .addHeader("Authorization", "Bearer " + botToken)
                    .build();

            try (Response response = httpClient.newCall(request).execute()) {
                if (!response.isSuccessful()) {
                    log.error("发送消息失败: HTTP {}, accountId={}, toUserId={}",
                            response.code(), accountId, toUserId);
                    return false;
                }

                String body = response.body() != null ? response.body().string() : "";
                // sendmessage 成功时常返回空对象 {}，无 ret/errcode
                if (body.isBlank() || "{}".equals(body.trim())) {
                    log.debug("发送消息成功, accountId={}, toUserId={}, clientId={}", accountId, toUserId, clientId);
                    return true;
                }

                JsonNode responseJson = objectMapper.readTree(body);
                JsonNode retNode = responseJson.get("ret");
                JsonNode errcodeNode = responseJson.get("errcode");

                // 无业务错误字段且 HTTP 已成功，视为发送成功
                if (retNode == null && errcodeNode == null) {
                    log.debug("发送消息成功, accountId={}, toUserId={}, clientId={}, response={}",
                            accountId, toUserId, clientId, responseJson);
                    return true;
                }

                int ret = retNode != null ? retNode.asInt() : 0;
                int errcode = errcodeNode != null ? errcodeNode.asInt() : 0;

                if (ret == 0 && errcode == 0) {
                    log.debug("发送消息成功, accountId={}, toUserId={}, clientId={}", accountId, toUserId, clientId);
                    return true;
                } else {
                    log.error("发送消息失败: ret={}, errcode={}, response={}, accountId={}, toUserId={}",
                            ret, errcode, responseJson, accountId, toUserId);
                    return false;
                }
            }
        } catch (Exception e) {
            log.error("发送消息异常, accountId={}, toUserId={}", accountId, toUserId, e);
            return false;
        }
    }
}
