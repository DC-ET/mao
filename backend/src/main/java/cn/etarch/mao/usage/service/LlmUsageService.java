package cn.etarch.mao.usage.service;

import cn.etarch.mao.harness.llm.ChatUsage;
import cn.etarch.mao.usage.entity.LlmUsage;
import cn.etarch.mao.usage.mapper.LlmUsageMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class LlmUsageService {
    public static final String SCENE_GIT_COMMIT_MESSAGE = "git_commit_message";

    private final LlmUsageMapper mapper;

    public void record(Long userId, Long sessionId, Long modelId, String scene,
                       ChatUsage usage, boolean success) {
        LlmUsage row = new LlmUsage();
        row.setUserId(userId);
        row.setSessionId(sessionId);
        row.setModelId(modelId);
        row.setScene(scene);
        row.setPromptTokens(usage != null ? usage.getPromptTokens() : 0);
        row.setCompletionTokens(usage != null ? usage.getCompletionTokens() : 0);
        row.setTotalTokens(usage != null ? usage.getTotalTokens() : 0);
        row.setSuccess(success ? 1 : 0);
        mapper.insert(row);
    }
}
