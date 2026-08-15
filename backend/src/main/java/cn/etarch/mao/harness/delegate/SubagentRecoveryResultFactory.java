package cn.etarch.mao.harness.delegate;

import cn.etarch.mao.harness.delegate.entity.SubagentExecution;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;

@Component
@RequiredArgsConstructor
public class SubagentRecoveryResultFactory {

    private final ObjectMapper objectMapper;

    public String create(SubagentExecution execution) {
        boolean completed = "COMPLETED".equals(execution.getStatus());
        boolean cancelled = "CANCELLED".equals(execution.getStatus());
        String result = execution.getResult();
        if (result == null || result.isBlank()) {
            result = completed ? "(子代理未产生文本输出)" : "子代理恢复失败：执行未产生结果";
        }

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("success", completed);
        response.put("cancelled", cancelled);
        response.put("agent_type", execution.getAgentType());
        response.put("child_session_id", execution.getChildSessionId());
        response.put("result", result);
        if (!completed) {
            response.put("error", result);
        }
        response.put("rounds", valueOrZero(execution.getTotalRounds()));
        response.put("tool_calls", valueOrZero(execution.getTotalToolCalls()));
        response.put("usage", Map.of(
                "prompt_tokens", valueOrZero(execution.getTotalPromptTokens()),
                "completion_tokens", valueOrZero(execution.getTotalCompletionTokens()),
                "total_tokens", valueOrZero(execution.getTotalPromptTokens())
                        + valueOrZero(execution.getTotalCompletionTokens())));
        if ("FOLLOWUP".equals(execution.getInvocationType())) {
            response.put("follow_up", true);
        }
        try {
            return objectMapper.writeValueAsString(response);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize recovered subagent result", e);
        }
    }

    private int valueOrZero(Integer value) {
        return value != null ? value : 0;
    }
}
