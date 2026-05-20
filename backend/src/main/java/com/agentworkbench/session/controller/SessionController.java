package com.agentworkbench.session.controller;

import com.agentworkbench.common.result.Result;
import com.agentworkbench.harness.core.AgentEventListener;
import com.agentworkbench.harness.core.AgentExecutionContext;
import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import com.agentworkbench.harness.core.AgentLoop;
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

@Slf4j
@RestController
@RequestMapping("/v1/sessions")
@RequiredArgsConstructor
public class SessionController {

    private final AgentLoop agentLoop;
    private final ExecutorService agentExecutor = Executors.newFixedThreadPool(20);

    @PostMapping
    public Result<SessionVO> createSession(
            @AuthenticationPrincipal Long userId,
            @RequestBody CreateSessionRequest request) {
        // TODO: Create new session
        return Result.ok();
    }

    @GetMapping
    public Result<List<SessionVO>> listSessions(@AuthenticationPrincipal Long userId) {
        // TODO: List user's sessions
        return Result.ok();
    }

    @GetMapping("/{id}")
    public Result<SessionVO> getSession(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        // TODO: Get session detail
        return Result.ok();
    }

    @DeleteMapping("/{id}")
    public Result<Void> deleteSession(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        // TODO: Delete session
        return Result.ok();
    }

    @PutMapping("/{id}/pin")
    public Result<Void> togglePin(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        // TODO: Toggle pin status
        return Result.ok();
    }

    @GetMapping(value = "/{id}/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestParam String eventId) {

        SseEmitter emitter = new SseEmitter(5 * 60 * 1000L); // 5 min timeout

        agentExecutor.submit(() -> {
            try {
                // TODO: Load session, agent config, and build context
                AgentExecutionContext context = new AgentExecutionContext();
                context.setSessionId(id);
                context.setUserId(userId);
                context.setMaxRounds(10);

                agentLoop.execute(context, new AgentEventListener() {
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
        // TODO: Get session messages
        return Result.ok();
    }

    // DTOs

    @Data
    public static class CreateSessionRequest {
        private Long agentId;
        private String title;
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
