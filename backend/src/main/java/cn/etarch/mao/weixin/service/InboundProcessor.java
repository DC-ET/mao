package cn.etarch.mao.weixin.service;

import cn.etarch.mao.weixin.model.WeixinInboundMessageContext;
import cn.etarch.mao.weixin.model.WeixinReply;
import com.fasterxml.jackson.databind.JsonNode;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.concurrent.CompletionStage;

@Slf4j
@Service
@RequiredArgsConstructor
public class InboundProcessor {

    private final WeixinInboundHandler inboundHandler;
    private final ContextTokenRepository contextTokenRepository;
    private final WeixinSendService weixinSendService;

    /**
     * 处理入站消息
     */
    public void processInboundMessage(String accountId, JsonNode message) {
        try {
            // 1. 提取消息信息
            String fromUserId = message.get("from_user_id").asText();
            String contextToken = message.has("context_token") ? message.get("context_token").asText() : null;

            // 2. 保存context_token
            if (contextToken != null && !contextToken.isEmpty()) {
                contextTokenRepository.saveOrUpdate(accountId, fromUserId, contextToken);
            }

            // 3. 提取消息内容
            String body = extractMessageBody(message);

            // 4. 构建入站消息上下文
            WeixinInboundMessageContext context = WeixinInboundMessageContext.builder()
                    .accountId(accountId)
                    .fromUserId(fromUserId)
                    .body(body)
                    .contextToken(contextToken)
                    .rawMessage(message)
                    .build();

            // 5. 调用业务处理器
            CompletionStage<WeixinReply> replyFuture = inboundHandler.onMessage(context);

            // 6. 处理回复
            replyFuture.whenComplete((reply, error) -> {
                if (error != null) {
                    log.error("处理微信消息失败, accountId={}, fromUserId={}", accountId, fromUserId, error);
                    return;
                }

                if (reply != null && reply.getText() != null && !reply.getText().isEmpty()) {
                    // 发送回复消息
                    sendReply(accountId, fromUserId, contextToken, reply);
                }
            });

        } catch (Exception e) {
            log.error("处理入站消息失败", e);
        }
    }

    /**
     * 提取消息正文
     */
    private String extractMessageBody(JsonNode message) {
        try {
            JsonNode itemList = message.get("item_list");
            if (itemList == null || !itemList.isArray() || itemList.isEmpty()) {
                return "";
            }

            // 优先提取文本消息
            for (JsonNode item : itemList) {
                int type = item.get("type").asInt();
                if (type == 1) { // TEXT
                    JsonNode textItem = item.get("text_item");
                    if (textItem != null && textItem.has("text")) {
                        return textItem.get("text").asText();
                    }
                }
            }

            // 如果没有文本消息，尝试提取消息描述
            if (message.has("description")) {
                return message.get("description").asText();
            }

            return "";
        } catch (Exception e) {
            log.warn("提取消息正文失败", e);
            return "";
        }
    }

    /**
     * 发送回复消息
     */
    private void sendReply(String accountId, String toUserId, String contextToken, WeixinReply reply) {
        try {
            if (contextToken == null || contextToken.isEmpty()) {
                log.warn("无法发送回复: 缺少context_token, accountId={}, toUserId={}", accountId, toUserId);
                return;
            }

            boolean success = weixinSendService.sendText(accountId, toUserId, reply.getText());
            if (success) {
                log.debug("发送微信回复成功, accountId={}, toUserId={}", accountId, toUserId);
            } else {
                log.warn("发送微信回复失败, accountId={}, toUserId={}", accountId, toUserId);
            }
        } catch (Exception e) {
            log.error("发送回复消息失败", e);
        }
    }
}