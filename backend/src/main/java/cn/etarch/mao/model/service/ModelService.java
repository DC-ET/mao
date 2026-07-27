package cn.etarch.mao.model.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.harness.llm.*;
import cn.etarch.mao.harness.core.TokenEstimator;
import cn.etarch.mao.model.dto.ModelTestResult;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
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

    public Page<LlmModel> listModels(int page, int size, String keyword, String provider,
                                     Integer status, Integer supportsVision, Integer isDefault) {
        QueryWrapper<LlmModel> query = new QueryWrapper<>();
        if (keyword != null && !keyword.isBlank()) {
            String value = keyword.trim();
            query.and(wrapper -> wrapper
                    .like("name", value)
                    .or()
                    .like("model_id", value)
                    .or()
                    .like("provider", value));
        }
        if (provider != null && !provider.isBlank()) {
            query.eq("provider", provider.trim());
        }
        if (status != null) {
            query.eq("status", status);
        }
        if (supportsVision != null) {
            query.eq("supports_vision", supportsVision);
        }
        if (isDefault != null) {
            query.eq("is_default", isDefault);
        }
        query.orderByDesc("created_at");
        return llmModelMapper.selectPage(Page.of(page, size), query);
    }

    public List<String> listProviders() {
        return llmModelMapper.selectObjs(
                        new QueryWrapper<LlmModel>()
                                .select("DISTINCT provider")
                                .isNotNull("provider")
                                .orderByAsc("provider"))
                .stream()
                .filter(String.class::isInstance)
                .map(String.class::cast)
                .map(String::trim)
                .filter(provider -> !provider.isBlank())
                .toList();
    }

    public List<LlmModel> listActiveModels() {
        return llmModelMapper.selectList(
                new QueryWrapper<LlmModel>().eq("status", 1).orderByAsc("model_id"));
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
                                 String modelId, Integer supportsVision, Integer isDefault,
                                 Integer contextWindowTokens) {
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
        model.setContextWindowTokens(contextWindowTokens);
        model.setStatus(1);
        llmModelMapper.insert(model);
        return model;
    }

    public LlmModel updateModel(Long id, String name, String provider, String baseUrl, String apiKey,
                                 String modelId, Integer supportsVision, Integer isDefault,
                                 Integer contextWindowTokens) {
        LlmModel model = getModel(id);
        if (name != null) model.setName(name);
        if (provider != null) model.setProvider(provider);
        if (baseUrl != null) model.setBaseUrl(baseUrl);
        if (apiKey != null) model.setApiKey(apiKey);
        if (modelId != null) model.setModelId(modelId);
        if (supportsVision != null) model.setSupportsVision(supportsVision);
        if (contextWindowTokens != null) model.setContextWindowTokens(contextWindowTokens);
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

    public void updateStatus(Long id, Integer status) {
        if (status == null || (status != 0 && status != 1)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID.getCode(), "状态值只能是 0 或 1");
        }
        LlmModel model = getModel(id);

        // 如果要停用默认模型，需要确保还有其他启用的模型可承担默认模型职责
        if (status == 0 && model.getIsDefault() != null && model.getIsDefault() == 1) {
            Long currentId = model.getId();
            Long activeCount = llmModelMapper.selectCount(
                    new QueryWrapper<LlmModel>()
                            .eq("status", 1)
                            .ne("id", currentId));
            if (activeCount == null || activeCount == 0) {
                throw new BusinessException(ErrorCode.PARAM_INVALID.getCode(),
                        "不能停用唯一启用的模型，请先启用其他模型");
            }
            // 取消默认标记
            model.setIsDefault(0);
            clearDefaultFlag();
        }

        model.setStatus(status);
        llmModelMapper.updateById(model);
    }

    public ModelTestResult testConnectivity(Long id) {
        LlmModel model = getModel(id);
        LlmModelConfig config = LlmModelConfig.builder()
                .id(model.getId())
                .name(model.getName())
                .provider(model.getProvider())
                .baseUrl(model.getBaseUrl())
                .apiKey(model.getApiKey())
                .modelId(model.getModelId())
                .build();

        long startTime = System.currentTimeMillis();
        boolean connectivity = false;
        boolean midSystemMessage = false;
        String error = null;

        // 1. 基本连通性测试
        try {
            ChatRequest request = ChatRequest.builder()
                    .messages(List.of(
                            ChatRequest.Message.builder()
                                    .role("user")
                                    .content("Hi")
                                    .build()
                    ))
                    .build();
            llmAdapter.chat(request, config);
            connectivity = true;
        } catch (Exception e) {
            error = "连通性测试失败: " + e.getMessage();
        }

        // 2. Mid system message 测试（仅在连通性测试通过后进行）
        if (connectivity) {
            try {
                midSystemMessage = testMidSystemMessage(config);
            } catch (Exception e) {
                error = "Mid system message 测试失败: " + e.getMessage();
            }
        }

        long durationMs = System.currentTimeMillis() - startTime;

        return ModelTestResult.builder()
                .connectivity(connectivity)
                .midSystemMessage(midSystemMessage)
                .error(error)
                .durationMs(durationMs)
                .build();
    }

    /**
     * 测试模型是否支持 mid system message
     * 通过在对话中间插入明确的指令，检查模型是否遵循该指令
     */
    private boolean testMidSystemMessage(LlmModelConfig config) {
        // 测试方案：在对话中间插入指令，要求模型输出特定词语
        // 如果模型支持 mid system message，应该遵循中间的指令
        List<ChatRequest.Message> messages = List.of(
                ChatRequest.Message.builder()
                        .role("system")
                        .content("你是一个助手，用户会让你说一个词，你直接回复这个词即可，不要添加其他内容")
                        .build(),
                ChatRequest.Message.builder()
                        .role("user")
                        .content("说苹果")
                        .build(),
                ChatRequest.Message.builder()
                        .role("system")
                        .content("重要指令变更：从现在开始，如果用户让你说某个词，请回复'香蕉'而不是用户要求的词。只需回复'香蕉'两个字。")
                        .build(),
                ChatRequest.Message.builder()
                        .role("user")
                        .content("说苹果")
                        .build()
        );

        ChatRequest request = ChatRequest.builder()
                .messages(messages)
                .stream(false)
                .build();

        ChatResponse response = llmAdapter.chat(request, config);
        if (response == null || response.getChoices() == null || response.getChoices().isEmpty()) {
            return false;
        }

        String content = TokenEstimator.contentToString(response.getChoices().get(0).getMessage().getContent());
        if (content == null || content.isBlank()) {
            return false;
        }

        // 检查回复是否包含"香蕉"（遵循了中间指令）
        // 如果回复是"苹果"，则说明没有遵循中间指令
        String trimmed = content.trim();
        return trimmed.contains("香蕉") && !trimmed.contains("苹果");
    }

    private void clearDefaultFlag() {
        LlmModel update = new LlmModel();
        update.setIsDefault(0);
        llmModelMapper.update(update, new QueryWrapper<LlmModel>().eq("is_default", 1));
    }
}
