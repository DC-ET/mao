package com.agentworkbench.model.service;

import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.harness.llm.*;
import com.agentworkbench.model.entity.LlmModel;
import com.agentworkbench.model.mapper.LlmModelMapper;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.mapper.SessionMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class ModelService {

    private final LlmModelMapper llmModelMapper;
    private final SessionMapper sessionMapper;
    private final OpenAiLlmAdapter llmAdapter;

    public Page<LlmModel> listModels(int page, int size) {
        return llmModelMapper.selectPage(
                Page.of(page, size),
                new QueryWrapper<LlmModel>().orderByDesc("created_at")
        );
    }

    public List<LlmModel> listActiveModels() {
        return llmModelMapper.selectList(
                new QueryWrapper<LlmModel>().eq("status", 1).orderByDesc("is_default").orderByAsc("id"));
    }

    public LlmModel getDefaultModel() {
        return llmModelMapper.selectOne(
                new QueryWrapper<LlmModel>().eq("is_default", 1).eq("status", 1));
    }

    public LlmModel getModel(Long id) {
        LlmModel model = llmModelMapper.selectById(id);
        if (model == null) {
            throw new BusinessException(ErrorCode.MODEL_NOT_FOUND);
        }
        return model;
    }

    public LlmModel createModel(String name, String provider, String baseUrl, String apiKey,
                                 String modelId, Integer supportsVision, Integer isDefault) {
        if (isDefault != null && isDefault == 1) {
            clearDefaultFlag();
        }
        LlmModel model = new LlmModel();
        model.setName(name);
        model.setProvider(provider);
        model.setBaseUrl(baseUrl);
        model.setApiKey(apiKey);
        model.setModelId(modelId);
        model.setSupportsVision(supportsVision != null ? supportsVision : 0);
        model.setIsDefault(isDefault != null ? isDefault : 0);
        model.setStatus(1);
        llmModelMapper.insert(model);
        return model;
    }

    public LlmModel updateModel(Long id, String name, String provider, String baseUrl, String apiKey,
                                 String modelId, Integer supportsVision, Integer isDefault) {
        LlmModel model = getModel(id);
        if (name != null) model.setName(name);
        if (provider != null) model.setProvider(provider);
        if (baseUrl != null) model.setBaseUrl(baseUrl);
        if (apiKey != null) model.setApiKey(apiKey);
        if (modelId != null) model.setModelId(modelId);
        if (supportsVision != null) model.setSupportsVision(supportsVision);
        if (isDefault != null) {
            if (isDefault == 1) clearDefaultFlag();
            model.setIsDefault(isDefault);
        }
        llmModelMapper.updateById(model);
        return model;
    }

    public void deleteModel(Long id) {
        LlmModel model = getModel(id);

        // 不允许删除默认模型
        if (model.getIsDefault() != null && model.getIsDefault() == 1) {
            throw new BusinessException(ErrorCode.MODEL_IS_DEFAULT);
        }

        // 将使用该模型的会话切换到默认模型
        LlmModel defaultModel = getDefaultModel();
        Long defaultModelId = defaultModel != null ? defaultModel.getId() : null;
        sessionMapper.update(null,
                new UpdateWrapper<Session>()
                        .eq("model_id", id)
                        .set("model_id", defaultModelId));

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

    private void clearDefaultFlag() {
        LlmModel update = new LlmModel();
        update.setIsDefault(0);
        llmModelMapper.update(update, new QueryWrapper<LlmModel>().eq("is_default", 1));
    }
}
