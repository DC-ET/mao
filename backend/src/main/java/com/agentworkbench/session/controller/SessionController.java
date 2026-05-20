package com.agentworkbench.session.controller;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.common.result.Result;
import com.agentworkbench.harness.core.AgentEventListener;
import com.agentworkbench.harness.core.HarnessService;
import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import com.agentworkbench.session.entity.Message;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.service.SessionService;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.stream.Collectors;

@Slf4j
@RestController
@RequestMapping("/v1/sessions")
@RequiredArgsConstructor
public class SessionController {

    private final SessionService sessionService;
    private final HarnessService harnessService;
    private final AgentMapper agentMapper;
    private final ExecutorService agentExecutor = Executors.newFixedThreadPool(20);

    @PostMapping
    public Result<SessionVO> createSession(
            @AuthenticationPrincipal Long userId,
            @RequestBody CreateSessionRequest request) {
        Session session = sessionService.createSession(userId, request.getAgentId(), request.getTitle());
        return Result.ok(toSessionVO(session));
    }

    @GetMapping
    public Result<List<SessionVO>> listSessions(@AuthenticationPrincipal Long userId) {
        List<Session> sessions = sessionService.listSessions(userId);
        List<SessionVO> voList = sessions.stream().map(this::toSessionVO).collect(Collectors.toList());
        return Result.ok(voList);
    }

    @GetMapping("/{id}")
    public Result<SessionVO> getSession(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        return Result.ok(toSessionVO(sessionService.getSession(id)));
    }

    @DeleteMapping("/{id}")
    public Result<Void> deleteSession(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        sessionService.deleteSession(id);
        return Result.ok();
    }

    @PutMapping("/{id}/pin")
    public Result<Void> togglePin(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        sessionService.togglePin(id);
        return Result.ok();
    }

    @PostMapping("/{id}/messages")
    public Result<SendMessageVO> sendMessage(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestBody SendMessageRequest request) {
        // Validate session exists
        sessionService.getSession(id);

        // Save user message to DB immediately
        sessionService.saveMessage(id, "USER", request.getContent(), null, null, 0, null);

        // Prepare event: store content in Redis for stream to pick up
        String eventId = harnessService.prepareMessage(id, request.getContent());

        SendMessageVO vo = new SendMessageVO();
        vo.setEventId(eventId);
        return Result.ok(vo);
    }

    @GetMapping(value = "/{id}/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestParam String eventId) {

        SseEmitter emitter = new SseEmitter(5 * 60 * 1000L);

        agentExecutor.submit(() -> {
            try {
                harnessService.executeFromEvent(id, eventId, new AgentEventListener() {
                    @Override
                    public void onContentDelta(String delta) {
                        try {
                            emitter.send(SseEmitter.event()
                                    .name("content_delta")
                                    .data(Map.of("delta", delta)));
                        } catch (Exception e) {
                            log.warn("Failed to send SSE event", e);
                        }
                    }

                    @Override
                    public void onToolCallStart(ChatRequest.ToolCall toolCall) {
                        try {
                            emitter.send(SseEmitter.event()
                                    .name("tool_call_start")
                                    .data(Map.of(
                                            "tool_call_id", toolCall.getId(),
                                            "tool_name", toolCall.getFunction().getName(),
                                            "arguments", toolCall.getFunction().getArguments()
                                    )));
                        } catch (Exception e) {
                            log.warn("Failed to send SSE event", e);
                        }
                    }

                    @Override
                    public void onToolCallResult(String toolCallId, String result) {
                        try {
                            emitter.send(SseEmitter.event()
                                    .name("tool_call_result")
                                    .data(Map.of(
                                            "tool_call_id", toolCallId,
                                            "result", result
                                    )));
                        } catch (Exception e) {
                            log.warn("Failed to send SSE event", e);
                        }
                    }

                    @Override
                    public void onMessageEnd(ChatUsage usage) {
                        try {
                            emitter.send(SseEmitter.event()
                                    .name("message_end")
                                    .data(Map.of(
                                            "prompt_tokens", usage.getPromptTokens(),
                                            "completion_tokens", usage.getCompletionTokens(),
                                            "total_tokens", usage.getTotalTokens()
                                    )));
                            emitter.complete();
                        } catch (Exception e) {
                            log.warn("Failed to send SSE event", e);
                        }
                    }

                    @Override
                    public void onError(Throwable t) {
                        try {
                            emitter.send(SseEmitter.event()
                                    .name("error")
                                    .data(Map.of("message", t.getMessage())));
                            emitter.completeWithError(t);
                        } catch (Exception e) {
                            log.warn("Failed to send SSE error event", e);
                        }
                    }
                });

            } catch (Exception e) {
                log.error("Agent execution failed", e);
                emitter.completeWithError(e);
            }
        });

        emitter.onTimeout(() -> {
            log.warn("SSE connection timed out for session: {}", id);
            emitter.complete();
        });

        emitter.onError(e -> log.warn("SSE connection error for session: {}", id, e));

        return emitter;
    }

    @GetMapping("/{id}/messages")
    public Result<List<MessageVO>> getMessages(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        List<Message> messages = sessionService.getMessages(id);
        List<MessageVO> voList = messages.stream().map(this::toMessageVO).collect(Collectors.toList());
        return Result.ok(voList);
    }

    private SessionVO toSessionVO(Session session) {
        SessionVO vo = new SessionVO();
        vo.setId(session.getId());
        vo.setAgentId(session.getAgentId());
        vo.setTitle(session.getTitle());
        vo.setStatus(session.getStatus());
        vo.setIsPinned(session.getIsPinned() != null && session.getIsPinned() == 1);
        vo.setIsFavorite(session.getIsFavorite() != null && session.getIsFavorite() == 1);
        vo.setCreatedAt(session.getCreatedAt() != null ? session.getCreatedAt().toString() : null);
        vo.setUpdatedAt(session.getUpdatedAt() != null ? session.getUpdatedAt().toString() : null);

        // Load agent name
        if (session.getAgentId() != null) {
            Agent agent = agentMapper.selectById(session.getAgentId());
            if (agent != null) {
                vo.setAgentName(agent.getName());
            }
        }
        return vo;
    }

    private MessageVO toMessageVO(Message message) {
        MessageVO vo = new MessageVO();
        vo.setId(message.getId());
        vo.setRole(message.getRole());
        vo.setContent(message.getContent());
        vo.setToolCallId(message.getToolCallId());
        vo.setToolCalls(message.getToolCalls());
        vo.setTokenCount(message.getTokenCount());
        vo.setCreatedAt(message.getCreatedAt() != null ? message.getCreatedAt().toString() : null);
        return vo;
    }

    // DTOs

    @Data
    public static class CreateSessionRequest {
        private Long agentId;
        private String title;
    }

    @Data
    public static class SendMessageRequest {
        private String content;
    }

    @Data
    public static class SendMessageVO {
        private String eventId;
    }

    @Data
    public static class SessionVO {
        private Long id;
        private Long agentId;
        private String agentName;
        private String title;
        private String status;
        private Boolean isPinned;
        private Boolean isFavorite;
        private String createdAt;
        private String updatedAt;
    }

    @Data
    public static class MessageVO {
        private Long id;
        private String role;
        private String content;
        private String toolCallId;
        private Object toolCalls;
        private Integer tokenCount;
        private String createdAt;
    }
}
