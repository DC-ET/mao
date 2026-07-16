package cn.etarch.mao.weixin.handler;

import cn.etarch.mao.harness.core.AgentLoop;
import cn.etarch.mao.harness.core.HarnessService;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.shell.ShellSessionManager;
import cn.etarch.mao.harness.todo.entity.SessionTodo;
import cn.etarch.mao.harness.todo.mapper.SessionTodoMapper;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.service.ModelService;
import cn.etarch.mao.session.activity.ActivityService;
import cn.etarch.mao.session.activity.SessionActivityHeartbeat;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.session.service.TaskTerminalService;
import cn.etarch.mao.session.ws.StreamingWsRegistry;
import cn.etarch.mao.session.ws.WsEvent;
import cn.etarch.mao.session.ws.WsStreamingEventListener;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import cn.etarch.mao.weixin.model.WeixinInboundMessageContext;
import cn.etarch.mao.weixin.model.WeixinReply;
import cn.etarch.mao.weixin.service.WeixinAccountRepository;
import cn.etarch.mao.weixin.service.WeixinInboundHandler;
import cn.etarch.mao.weixin.service.WeixinSessionService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 微信入站 → Agent 处理。
 * <p>
 * 连续消息策略（对齐桌面端「立即发送」）：
 * 新消息到达时取消同会话上一条未完成的 Agent 执行，再处理最新消息；
 * 仅最新一代执行成功后才向微信回复。
 * <p>
 * 执行过程通过 {@link WsStreamingEventListener} 推送 WebSocket 事件，
 * 使桌面端打开同一会话时可看到流式输出、会话状态与上下文窗口等信息。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AgentWeixinInboundHandler implements WeixinInboundHandler {

    private static final String DEFAULT_IMAGE_PROMPT = "请查看这张图片";

    private final WeixinSessionService weixinSessionService;
    private final HarnessService harnessService;
    private final SessionService sessionService;
    private final WeixinAccountRepository accountRepository;
    private final AgentLoop agentLoop;
    private final ShellSessionManager shellSessionManager;
    private final StreamingWsRegistry registry;
    private final TaskTerminalService taskTerminalService;
    private final ActivityService activityService;
    private final SessionActivityHeartbeat activityHeartbeat;
    private final SessionTodoMapper sessionTodoMapper;
    private final ModelService modelService;

    private final ConcurrentHashMap<Long, AtomicBoolean> cancelFlags = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Long, AtomicLong> generations = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Long, Object> sessionLocks = new ConcurrentHashMap<>();

    private final ExecutorService weixinAgentExecutor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "weixin-agent");
        t.setDaemon(true);
        return t;
    });

    @PreDestroy
    void shutdown() {
        weixinAgentExecutor.shutdownNow();
    }

    @Override
    public boolean authorizeDirectMessage(String accountId, String fromUserId, String text) {
        return true;
    }

    @Override
    public CompletionStage<WeixinReply> onMessage(WeixinInboundMessageContext context) {
        CompletableFuture<WeixinReply> result = new CompletableFuture<>();

        Long userId = getUserIdFromAccountId(context.getAccountId());
        if (userId == null) {
            log.error("无法获取用户ID, accountId={}", context.getAccountId());
            WeixinReply errorReply = new WeixinReply();
            errorReply.setText("抱歉，系统处理出现错误，请稍后再试。");
            result.complete(errorReply);
            return result;
        }

        Session session;
        try {
            session = weixinSessionService.getOrCreateWeixinSession(userId);
        } catch (Exception e) {
            log.error("获取微信会话失败, userId={}", userId, e);
            WeixinReply errorReply = new WeixinReply();
            errorReply.setText("抱歉，处理您的消息时出现了错误，请稍后再试。");
            result.complete(errorReply);
            return result;
        }

        Long sessionId = session.getId();
        long generation = nextGeneration(sessionId);

        // 先取消同会话在途执行（类似桌面端 insert / 新消息接管）
        abortRunningExecution(sessionId, userId);

        Object messageContent = buildMessageContent(context);
        Message savedMessage;
        try {
            savedMessage = sessionService.saveMessage(
                    sessionId,
                    "USER",
                    messageContent,
                    null, null, null, 0, null
            );
        } catch (Exception e) {
            log.error("保存微信用户消息失败, sessionId={}", sessionId, e);
            WeixinReply errorReply = new WeixinReply();
            errorReply.setText("抱歉，处理您的消息时出现了错误，请稍后再试。");
            result.complete(errorReply);
            return result;
        }

        // 通知桌面端：远程用户消息已入库（正在查看该会话时可即时展示）
        registry.send(userId, WsEvent.of("user_message_saved", sessionId,
                buildRemoteUserMessageEvent(savedMessage, messageContent)));

        String executionId = harnessService.prepareMessage(sessionId, messageContent);
        weixinAgentExecutor.execute(() -> runAgent(session, userId, generation, executionId, result));
        return result;
    }

    private void runAgent(Session session, Long userId, long generation, String executionId,
                          CompletableFuture<WeixinReply> result) {
        Long sessionId = session.getId();
        synchronized (sessionLock(sessionId)) {
            if (!isCurrentGeneration(sessionId, generation)) {
                log.info("微信消息已被更新消息取代, sessionId={}, gen={}", sessionId, generation);
                result.complete(null);
                return;
            }

            AtomicBoolean cancelFlag = agentLoop.registerCancelFlag(sessionId);
            cancelFlags.put(sessionId, cancelFlag);

            try {
                sessionService.updatePhase(sessionId, "RUNNING");
                registry.send(userId, WsEvent.of("session_status", sessionId,
                        Map.of("phase", "RUNNING", "executionId", executionId)));
                registry.send(userId, WsEvent.of("session_list_update", sessionId, Map.of("phase", "RUNNING")));

                sessionTodoMapper.delete(
                        new LambdaQueryWrapper<SessionTodo>()
                                .eq(SessionTodo::getSessionId, sessionId));
                registry.send(userId, WsEvent.of("todo_updated", sessionId, Map.of("todos", List.of())));

                WsStreamingEventListener listener = new WsStreamingEventListener(
                        registry, activityService, activityHeartbeat, sessionTodoMapper, sessionService,
                        sessionId, userId, executionId, resolveSupportsVision(session));

                harnessService.execute(sessionId, null, listener, cancelFlag);

                if (cancelFlag.get() || !isCurrentGeneration(sessionId, generation)) {
                    log.info("微信 Agent 执行已取消, sessionId={}, gen={}", sessionId, generation);
                    finishCancelledSession(sessionId, userId, executionId);
                    result.complete(null);
                    return;
                }

                taskTerminalService.finishExecution(sessionId, userId, "COMPLETED", executionId);

                List<Message> messages = sessionService.getMessages(sessionId);
                String assistantReply = getLatestAssistantReply(messages);
                WeixinReply reply = new WeixinReply();
                reply.setText(assistantReply);
                result.complete(reply);
            } catch (Exception e) {
                if (cancelFlag.get() || !isCurrentGeneration(sessionId, generation)) {
                    log.info("微信 Agent 执行异常但已取消, sessionId={}, gen={}", sessionId, generation);
                    try {
                        finishCancelledSession(sessionId, userId, executionId);
                    } catch (Exception ignored) {
                    }
                    result.complete(null);
                    return;
                }
                log.error("处理微信消息失败, sessionId={}", sessionId, e);
                try {
                    registry.send(userId, WsEvent.of("error", sessionId,
                            Map.of("message", e.getMessage() != null ? e.getMessage() : "Agent 执行异常",
                                    "executionId", executionId)));
                } catch (Exception ignored) {
                }
                try {
                    taskTerminalService.finishExecution(sessionId, userId, "FAILED", executionId);
                } catch (Exception ignored) {
                }
                WeixinReply errorReply = new WeixinReply();
                errorReply.setText("抱歉，处理您的消息时出现了错误，请稍后再试。");
                result.complete(errorReply);
            } finally {
                cancelFlags.remove(sessionId, cancelFlag);
            }
        }
    }

    /**
     * 取消同会话当前在途 Agent（对齐 StreamingWsHandler.abortRunningExecution）。
     */
    private void abortRunningExecution(Long sessionId, Long userId) {
        AtomicBoolean flag = cancelFlags.get(sessionId);
        if (flag != null) {
            flag.set(true);
            registry.send(userId, WsEvent.of("session_status", sessionId, Map.of("phase", "CANCELLING")));
        }
        try {
            shellSessionManager.closeByConversation(sessionId);
        } catch (Exception e) {
            log.debug("关闭微信会话 Shell 失败, sessionId={}: {}", sessionId, e.getMessage());
        }
    }

    private void finishCancelledSession(Long sessionId, Long userId, String executionId) {
        int deleted = sessionService.cleanupIncompleteTail(sessionId);
        if (deleted > 0) {
            log.info("微信会话 {}: 取消后清理 {} 条不完整消息", sessionId, deleted);
        }
        taskTerminalService.finishExecution(sessionId, userId, "CANCELLED", executionId);
    }

    private boolean resolveSupportsVision(Session session) {
        if (session.getModelId() == null) {
            return false;
        }
        try {
            LlmModel model = modelService.getModel(session.getModelId());
            return model != null && model.getSupportsVision() != null && model.getSupportsVision() == 1;
        } catch (Exception e) {
            return false;
        }
    }

    private Map<String, Object> buildRemoteUserMessageEvent(Message saved, Object messageContent) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("messageId", saved.getId());
        data.put("source", "weixin");
        data.put("tempEventId", "");

        if (messageContent instanceof String text) {
            data.put("content", text);
            return data;
        }

        if (messageContent instanceof List<?> parts) {
            StringBuilder text = new StringBuilder();
            List<String> images = new ArrayList<>();
            for (Object part : parts) {
                if (part instanceof ChatRequest.ContentPart cp) {
                    if ("text".equals(cp.getType()) && cp.getText() != null) {
                        text.append(cp.getText());
                    } else if ("image_url".equals(cp.getType())
                            && cp.getImageUrl() != null
                            && cp.getImageUrl().getUrl() != null) {
                        images.add(cp.getImageUrl().getUrl());
                    }
                }
            }
            data.put("content", text.toString());
            if (!images.isEmpty()) {
                data.put("images", images);
            }
            return data;
        }

        data.put("content", saved.getContent() != null ? saved.getContent() : "");
        return data;
    }

    private long nextGeneration(Long sessionId) {
        return generations.computeIfAbsent(sessionId, id -> new AtomicLong(0)).incrementAndGet();
    }

    private boolean isCurrentGeneration(Long sessionId, long generation) {
        AtomicLong current = generations.get(sessionId);
        return current != null && current.get() == generation;
    }

    private Object sessionLock(Long sessionId) {
        return sessionLocks.computeIfAbsent(sessionId, id -> new Object());
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
