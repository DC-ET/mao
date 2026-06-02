package com.agentworkbench.model.service;

import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.harness.llm.*;
import com.agentworkbench.model.entity.LlmModel;
import com.agentworkbench.model.mapper.LlmModelMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class ModelService {

    private final LlmModelMapper llmModelMapper;
    private final OpenAiLlmAdapter llmAdapter;

    public List<LlmModel> listModels() {
        return llmModelMapper.selectList(new QueryWrapper<LlmModel>().orderByDesc("created_at"));
    }

    public LlmModel getModel(Long id) {
        LlmModel model = llmModelMapper.selectById(id);
        if (model == null) {
            throw new BusinessException(ErrorCode.MODEL_NOT_FOUND);
        }
        return model;
    }

    public LlmModel createModel(String name, String provider, String baseUrl, String apiKey,
                                 String modelId, Integer supportsVision) {
        LlmModel model = new LlmModel();
        model.setName(name);
        model.setProvider(provider);
        model.setBaseUrl(baseUrl);
        model.setApiKey(apiKey);
        model.setModelId(modelId);
        model.setSupportsVision(supportsVision != null ? supportsVision : 0);
        model.setStatus(1);
        llmModelMapper.insert(model);
        return model;
    }

    public LlmModel updateModel(Long id, String name, String provider, String baseUrl, String apiKey,
                                 String modelId, Integer supportsVision) {
        LlmModel model = getModel(id);
        if (name != null) model.setName(name);
        if (provider != null) model.setProvider(provider);
        if (baseUrl != null) model.setBaseUrl(baseUrl);
        if (apiKey != null) model.setApiKey(apiKey);
        if (modelId != null) model.setModelId(modelId);
        if (supportsVision != null) model.setSupportsVision(supportsVision);
        llmModelMapper.updateById(model);
        return model;
    }

    public void deleteModel(Long id) {
        llmModelMapper.deleteById(id);
    }

    public void testConnectivity(Long id) {
        LlmModel model = getModel(id);
        LlmModelConfig config = LlmModelConfig.builder()
                .id(model.getId())
                .name(model.getName())
                .provider(model.getProvider())
                .baseUrl(model.getBaseUrl())
                .apiKey(model.getApiKey())
                .modelId(model.getModelId())
                .build();

        ChatRequest request = ChatRequest.builder()
                .messages(List.of(
                        ChatRequest.Message.builder()
                                .role("user")
                                .content("Hi")
                                .build()
                ))
                .maxTokens(10)
                .build();

        try {
            llmAdapter.chat(request, config);
        } catch (Exception e) {
            throw new BusinessException(ErrorCode.LLM_CALL_FAILED.getCode(),
                    "模型连通性测试失败: " + e.getMessage());
        }
    }
}
