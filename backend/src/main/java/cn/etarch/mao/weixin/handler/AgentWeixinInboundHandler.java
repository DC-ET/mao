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

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicBoolean;

@Slf4j
@Service
@RequiredArgsConstructor
public class AgentWeixinInboundHandler implements WeixinInboundHandler {

    private final WeixinSessionService weixinSessionService;
    private final HarnessService harnessService;
    private final SessionService sessionService;
    private final WeixinAccountRepository accountRepository;

    @Override
    public boolean authorizeDirectMessage(String accountId, String fromUserId, String text) {
        // 检查用户是否有权限使用微信Bot
        return true;
    }

    @Override
    public CompletionStage<WeixinReply> onMessage(WeixinInboundMessageContext context) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                // 1. 获取用户ID
                Long userId = getUserIdFromAccountId(context.getAccountId());
                if (userId == null) {
                    log.error("无法获取用户ID, accountId={}", context.getAccountId());
                    WeixinReply errorReply = new WeixinReply();
                    errorReply.setText("抱歉，系统处理出现错误，请稍后再试。");
                    return errorReply;
                }

                // 2. 获取或创建会话
                Session session = weixinSessionService.getOrCreateWeixinSession(userId);

                // 3. 保存用户消息
                sessionService.saveMessage(
                        session.getId(),
                        "USER",
                        context.getBody(),
                        null, null, null, 0, null
                );

                // 4. 执行AI Agent处理
                AtomicBoolean cancelFlag = new AtomicBoolean(false);
                AgentEventListener listener = new AgentEventListener() {
                    @Override
                    public void onContentDelta(String delta) {
                        // 处理内容增量
                    }

                    @Override
                    public void onToolCallStart(ChatRequest.ToolCall toolCall) {
                        // 处理工具调用开始
                    }

                    @Override
                    public void onToolCallResult(String toolCallId, String result) {
                        // 处理工具调用结果
                    }

                    @Override
                    public void onMessageEnd(ChatUsage usage) {
                        // 处理消息结束
                    }

                    @Override
                    public void onError(Throwable error) {
                        // 处理错误
                        log.error("AI Agent处理失败, sessionId={}", session.getId(), error);
                    }
                };

                harnessService.execute(session.getId(), context.getBody(), listener, cancelFlag);

                // 5. 获取最新的助手回复
                List<Message> messages = sessionService.getMessages(session.getId());
                String assistantReply = getLatestAssistantReply(messages);

                // 6. 构建回复
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
     * 从账号ID获取用户ID
     */
    private Long getUserIdFromAccountId(String accountId) {
        WeixinChannelAccount account = accountRepository.findByAccountId(accountId);
        if (account != null) {
            return account.getUserId();
        }
        return null;
    }

    /**
     * 获取最新的助手回复
     */
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