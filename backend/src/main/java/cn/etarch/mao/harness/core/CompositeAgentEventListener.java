package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatUsage;
import lombok.extern.slf4j.Slf4j;

import java.util.Arrays;
import java.util.List;
import java.util.Objects;

/**
 * 将同一 Agent 事件扇出到多个监听器。单个监听器异常不影响其余监听器。
 */
@Slf4j
public class CompositeAgentEventListener implements AgentEventListener {

    private final List<AgentEventListener> listeners;

    public CompositeAgentEventListener(AgentEventListener... listeners) {
        this.listeners = Arrays.stream(listeners)
                .filter(Objects::nonNull)
                .toList();
    }

    public CompositeAgentEventListener(List<AgentEventListener> listeners) {
        this.listeners = listeners == null
                ? List.of()
                : listeners.stream().filter(Objects::nonNull).toList();
    }

    @Override
    public void onContentDelta(String delta) {
        forEach("onContentDelta", l -> l.onContentDelta(delta));
    }

    @Override
    public void onToolCallStart(ChatRequest.ToolCall toolCall) {
        forEach("onToolCallStart", l -> l.onToolCallStart(toolCall));
    }

    @Override
    public void onToolCallResult(String toolCallId, String result) {
        forEach("onToolCallResult", l -> l.onToolCallResult(toolCallId, result));
    }

    @Override
    public void onMessageEnd(ChatUsage usage) {
        forEach("onMessageEnd", l -> l.onMessageEnd(usage));
    }

    @Override
    public void onError(Throwable t) {
        forEach("onError", l -> l.onError(t));
    }

    @Override
    public void onContextWindow(int estimatedTokens, int actualTokens) {
        forEach("onContextWindow", l -> l.onContextWindow(estimatedTokens, actualTokens));
    }

    @Override
    public void onCompactionStart(String type, int messageCount, int estimatedTokens) {
        forEach("onCompactionStart", l -> l.onCompactionStart(type, messageCount, estimatedTokens));
    }

    @Override
    public void onCompactionEnd(String type, int summaryTokens, int savedTokens, long durationMs) {
        forEach("onCompactionEnd", l -> l.onCompactionEnd(type, summaryTokens, savedTokens, durationMs));
    }

    @Override
    public void onThinkingStart() {
        forEach("onThinkingStart", AgentEventListener::onThinkingStart);
    }

    @Override
    public void onThinkingEnd() {
        forEach("onThinkingEnd", AgentEventListener::onThinkingEnd);
    }

    @Override
    public void onToolCallArgsDelta(String toolCallId, String arguments) {
        forEach("onToolCallArgsDelta", l -> l.onToolCallArgsDelta(toolCallId, arguments));
    }

    @Override
    public void onThinkingDelta(String delta) {
        forEach("onThinkingDelta", l -> l.onThinkingDelta(delta));
    }

    private void forEach(String method, ListenerAction action) {
        for (AgentEventListener listener : listeners) {
            try {
                action.accept(listener);
            } catch (Exception e) {
                log.warn("CompositeAgentEventListener {} failed on {}: {}",
                        listener.getClass().getSimpleName(), method, e.getMessage());
            }
        }
    }

    @FunctionalInterface
    private interface ListenerAction {
        void accept(AgentEventListener listener) throws Exception;
    }
}
