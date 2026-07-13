package cn.etarch.mao.notification.task.sender;

import cn.etarch.mao.notification.task.model.NotificationChannel;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Component;

import java.util.Map;

@Component
public class DingTalkWebhookSender implements WebhookSender {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private final OkHttpClient client;
    private final ObjectMapper objectMapper;

    public DingTalkWebhookSender(@Qualifier("taskNotificationHttpClient") OkHttpClient client,
                                 ObjectMapper objectMapper) {
        this.client = client;
        this.objectMapper = objectMapper;
    }

    @Override
    public NotificationChannel channel() {
        return NotificationChannel.DINGTALK;
    }

    @Override
    public WebhookSendResult send(String webhookUrl, String content) {
        try {
            String json = objectMapper.writeValueAsString(Map.of(
                    "msgtype", "text", "text", Map.of("content", content)));
            Request request = new Request.Builder().url(webhookUrl)
                    .post(RequestBody.create(json, JSON)).build();
            try (Response response = client.newCall(request).execute()) {
                String body = response.body() != null ? response.body().string() : "";
                JsonNode root = body.isBlank() ? objectMapper.createObjectNode() : objectMapper.readTree(body);
                String code = root.has("errcode") ? root.get("errcode").asText() : null;
                if (response.isSuccessful() && "0".equals(code)) {
                    return WebhookSendResult.success(response.code(), code);
                }
                boolean retryable = response.code() == 429 || response.code() >= 500;
                String message = root.has("errmsg") ? root.get("errmsg").asText() : "钉钉 Webhook 请求失败";
                return WebhookSendResult.failure(retryable, response.code(), code, message);
            }
        } catch (Exception e) {
            return WebhookSendResult.failure(true, null, null, "钉钉 Webhook 网络请求失败");
        }
    }
}
