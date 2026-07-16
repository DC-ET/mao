package cn.etarch.mao.weixin.handler;

import cn.etarch.mao.harness.core.AgentEventListener;
import cn.etarch.mao.harness.core.HarnessService;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatUsage;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import cn.etarch.mao.weixin.model.WeixinInboundMessageContext;
import cn.etarch.mao.weixin.model.WeixinReply;
import cn.etarch.mao.weixin.service.WeixinAccountRepository;
import cn.etarch.mao.weixin.service.WeixinInboundHandler;
import cn.etarch.mao.weixin.service.WeixinSessionService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicBoolean;

@Slf4j
@Service
@RequiredArgsConstructor
public class AgentWeixinInboundHandler implements WeixinInboundHandler {

    private static final String DEFAULT_IMAGE_PROMPT = "请查看这张图片";

    private final WeixinSessionService weixinSessionService;
    private final HarnessService harnessService;
    private final SessionService sessionService;
    private final WeixinAccountRepository accountRepository;

    @Override
    public boolean authorizeDirectMessage(String accountId, String fromUserId, String text) {
        return true;
    }

    @Override
    public CompletionStage<WeixinReply> onMessage(WeixinInboundMessageContext context) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                Long userId = getUserIdFromAccountId(context.getAccountId());
                if (userId == null) {
                    log.error("无法获取用户ID, accountId={}", context.getAccountId());
                    WeixinReply errorReply = new WeixinReply();
                    errorReply.setText("抱歉，系统处理出现错误，请稍后再试。");
                    return errorReply;
                }

                Session session = weixinSessionService.getOrCreateWeixinSession(userId);

                Object messageContent = buildMessageContent(context);
                sessionService.saveMessage(
                        session.getId(),
                        "USER",
                        messageContent,
                        null, null, null, 0, null
                );

                AtomicBoolean cancelFlag = new AtomicBoolean(false);
                AgentEventListener listener = new AgentEventListener() {
                    @Override
                    public void onContentDelta(String delta) {
                    }

                    @Override
                    public void onToolCallStart(ChatRequest.ToolCall toolCall) {
                    }

                    @Override
                    public void onToolCallResult(String toolCallId, String result) {
                    }

                    @Override
                    public void onMessageEnd(ChatUsage usage) {
                    }

                    @Override
                    public void onError(Throwable error) {
                        log.error("AI Agent处理失败, sessionId={}", session.getId(), error);
                    }
                };

                // 用户消息已落库；execute 从 DB 加载历史（含多模态 content parts）
                harnessService.execute(session.getId(), null, listener, cancelFlag);

                List<Message> messages = sessionService.getMessages(session.getId());
                String assistantReply = getLatestAssistantReply(messages);

                WeixinReply reply = new WeixinReply();
                reply.setText(assistantReply);
                return reply;
            } catch (Exception e) {
                log.error("处理微信消息失败", e);
                WeixinReply errorReply = new WeixinReply();
                errorReply.setText("抱歉，处理您的消息时出现了错误，请稍后再试。");
                return errorReply;
            }
        });
    }

    /**
     * 纯文本 → String；带图片 → ContentPart 列表（与桌面端多模态格式一致）。
     */
    Object buildMessageContent(WeixinInboundMessageContext context) {
        List<String> imageDataUris = context.getImageDataUris();
        boolean hasImages = imageDataUris != null && !imageDataUris.isEmpty();
        String text = context.getBody() != null ? context.getBody().trim() : "";

        if (!hasImages) {
            return text;
        }

        if (text.isEmpty()) {
            text = DEFAULT_IMAGE_PROMPT;
        }

        List<ChatRequest.ContentPart> parts = new ArrayList<>();
        parts.add(ChatRequest.ContentPart.builder()
                .type("text")
                .text(text)
                .build());
        for (String dataUri : imageDataUris) {
            if (dataUri == null || dataUri.isBlank()) {
                continue;
            }
            parts.add(ChatRequest.ContentPart.builder()
                    .type("image_url")
                    .imageUrl(ChatRequest.ImageUrl.builder().url(dataUri).build())
                    .build());
        }
        return parts;
    }

    private Long getUserIdFromAccountId(String accountId) {
        WeixinChannelAccount account = accountRepository.findByAccountId(accountId);
        if (account != null) {
            return account.getUserId();
        }
        return null;
    }

    private String getLatestAssistantReply(List<Message> messages) {
        for (int i = messages.size() - 1; i >= 0; i--) {
            Message message = messages.get(i);
            if ("ASSISTANT".equals(message.getRole())) {
                return message.getContent();
            }
        }
        return "抱歉，暂时无法生成回复。";
    }
}
