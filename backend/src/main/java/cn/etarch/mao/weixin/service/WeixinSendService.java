package cn.etarch.mao.weixin.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.weixin.config.WeixinBotConfig;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.Map;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class WeixinSendService {

    private final WeixinBotConfig config;
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
        // 1. 获取账号信息
        WeixinChannelAccount account = accountRepository.findByAccountId(accountId);
        if (account == null) {
            log.error("发送消息失败: 账号不存在, accountId={}", accountId);
            return false;
        }

        // 2. 解析账号凭据
        String botToken = null;
        String baseUrl = null;
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

        // 4. 构建消息体
        String clientId = UUID.randomUUID().toString();
        Map<String, Object> message = Map.of(
                "msg", Map.of(
                        "from_user_id", "",
                        "to_user_id", toUserId,
                        "client_id", clientId,
                        "message_type", 2,
                        "message_state", 1,
                        "context_token", contextToken,
                        "item_list", new Object[]{
                                Map.of(
                                        "type", 1,
                                        "text_item", Map.of("text", text)
                                )
                        }
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

                JsonNode responseJson = objectMapper.readTree(response.body().string());
                int ret = responseJson.get("ret").asInt();
                int errcode = responseJson.get("errcode").asInt();

                if (ret == 0 && errcode == 0) {
                    log.debug("发送消息成功, accountId={}, toUserId={}, clientId={}", accountId, toUserId, clientId);
                    return true;
                } else {
                    log.error("发送消息失败: ret={}, errcode={}, accountId={}, toUserId={}", 
                            ret, errcode, accountId, toUserId);
                    return false;
                }
            }
        } catch (Exception e) {
            log.error("发送消息异常, accountId={}, toUserId={}", accountId, toUserId, e);
            return false;
        }
    }
}