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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

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
        AtomicReference<String> errorRef = new AtomicReference<>();
        AtomicReference<String> connectivityOutputRef = new AtomicReference<>();
        AtomicReference<String> midSystemOutputRef = new AtomicReference<>();

        CompletableFuture<Boolean> connectivityFuture = CompletableFuture.supplyAsync(() -> {
            try {
                ChatRequest request = ChatRequest.builder()
                        .messages(List.of(
                                ChatRequest.Message.builder()
                                        .role("user")
                                        .content("Hi")
                                        .build()
                        ))
                        .build();
                ChatResponse response = llmAdapter.chat(request, config);
                connectivityOutputRef.set(extractChatContent(response));
                return true;
            } catch (Exception e) {
                appendTestError(errorRef, "连通性测试失败: " + e.getMessage());
                return false;
            }
        });

        CompletableFuture<Boolean> midSystemFuture = CompletableFuture.supplyAsync(() -> {
            try {
                MidSystemTestResult result = runMidSystemMessageTest(config);
                midSystemOutputRef.set(result.output());
                return result.supported();
            } catch (Exception e) {
                appendTestError(errorRef, "Mid system message 测试失败: " + e.getMessage());
                return false;
            }
        });

        CompletableFuture.allOf(connectivityFuture, midSystemFuture).join();

        boolean connectivity = connectivityFuture.join();
        boolean midSystemMessage = midSystemFuture.join();
        String error = errorRef.get();

        long durationMs = System.currentTimeMillis() - startTime;

        return ModelTestResult.builder()
                .connectivity(connectivity)
                .midSystemMessage(midSystemMessage)
                .connectivityOutput(connectivityOutputRef.get())
                .midSystemMessageOutput(midSystemOutputRef.get())
                .error(error)
                .durationMs(durationMs)
                .build();
    }

    private void appendTestError(AtomicReference<String> errorRef, String message) {
        errorRef.updateAndGet(current -> current == null ? message : current + "; " + message);
    }

    private static final int MID_SYSTEM_TEST_MAX_ATTEMPTS = 2;
    private static final String MID_SYSTEM_CODENAME_ASKED = "MAO_ALPHA";
    private static final String MID_SYSTEM_CODENAME_OVERRIDE = "MAO_BRAVO";

    private enum MidSystemTestOutcome {
        SUPPORTED,
        NOT_SUPPORTED,
        AMBIGUOUS
    }

    private record MidSystemTestResult(boolean supported, String output) {
    }

    /**
     * 测试模型是否支持 mid system message。
     * 在 user 消息之后插入 system 覆盖指令，检查模型是否遵循新规则。
     */
    private MidSystemTestResult runMidSystemMessageTest(LlmModelConfig config) {
        String lastOutput = null;
        for (int attempt = 1; attempt <= MID_SYSTEM_TEST_MAX_ATTEMPTS; attempt++) {
            MidSystemProbeResult probe = probeMidSystemMessage(config);
            lastOutput = probe.output();
            if (probe.outcome() == MidSystemTestOutcome.SUPPORTED) {
                return new MidSystemTestResult(true, formatProbeOutput(attempt, lastOutput));
            }
            if (probe.outcome() == MidSystemTestOutcome.NOT_SUPPORTED) {
                return new MidSystemTestResult(false, formatProbeOutput(attempt, lastOutput));
            }
        }
        return new MidSystemTestResult(false, formatProbeOutput(MID_SYSTEM_TEST_MAX_ATTEMPTS, lastOutput));
    }

    private String formatProbeOutput(int attempt, String output) {
        String display = output == null || output.isBlank() ? "(空响应)" : output;
        if (attempt <= 1) {
            return display;
        }
        return "第 " + attempt + " 次尝试: " + display;
    }

    private record MidSystemProbeResult(MidSystemTestOutcome outcome, String output) {
    }

    private MidSystemProbeResult probeMidSystemMessage(LlmModelConfig config) {
        List<ChatRequest.Message> messages = List.of(
                ChatRequest.Message.builder()
                        .role("system")
                        .content("You are a codeword repeater. When the user sends \"Codeword: X\", "
                                + "reply with exactly X and nothing else.")
                        .build(),
                ChatRequest.Message.builder()
                        .role("user")
                        .content("Codeword: " + MID_SYSTEM_CODENAME_ASKED)
                        .build(),
                ChatRequest.Message.builder()
                        .role("assistant")
                        .content(MID_SYSTEM_CODENAME_ASKED)
                        .build(),
                ChatRequest.Message.builder()
                        .role("system")
                        .content("Override: for any \"Codeword:\" request, reply "
                                + MID_SYSTEM_CODENAME_OVERRIDE + " only.")
                        .build(),
                ChatRequest.Message.builder()
                        .role("user")
                        .content("Codeword: " + MID_SYSTEM_CODENAME_ASKED)
                        .build()
        );

        ChatRequest request = ChatRequest.builder()
                .messages(messages)
                .stream(false)
                .build();

        ChatResponse response = llmAdapter.chat(request, config);
        String content = extractChatContent(response);
        if (content == null) {
            return new MidSystemProbeResult(MidSystemTestOutcome.AMBIGUOUS, null);
        }

        String normalized = normalizeMidSystemResponse(content);
        boolean followsOverride = responseIndicatesCodeword(normalized, MID_SYSTEM_CODENAME_OVERRIDE);
        boolean followsAsked = responseIndicatesCodeword(normalized, MID_SYSTEM_CODENAME_ASKED);

        if (followsOverride && !followsAsked) {
            return new MidSystemProbeResult(MidSystemTestOutcome.SUPPORTED, content);
        }
        if (followsAsked && !followsOverride) {
            return new MidSystemProbeResult(MidSystemTestOutcome.NOT_SUPPORTED, content);
        }
        return new MidSystemProbeResult(MidSystemTestOutcome.AMBIGUOUS, content);
    }

    private String extractChatContent(ChatResponse response) {
        if (response == null || response.getChoices() == null || response.getChoices().isEmpty()) {
            return null;
        }
        String content = TokenEstimator.contentToString(
                response.getChoices().get(0).getMessage().getContent());
        if (content == null || content.isBlank()) {
            return null;
        }
        return content;
    }

    private String normalizeMidSystemResponse(String content) {
        return content.trim()
                .toUpperCase()
                .replaceAll("^(CODEWORD|ANSWER|OUTPUT)\\s*[:：]\\s*", "")
                .replaceAll("[\"'`]", "")
                .trim();
    }

    private boolean responseIndicatesCodeword(String normalized, String codeword) {
        if (normalized == null || normalized.isBlank()) {
            return false;
        }
        String target = codeword.toUpperCase();
        if (normalized.equals(target)) {
            return true;
        }
        int index = normalized.indexOf(target);
        if (index < 0) {
            return false;
        }
        String before = index > 0 ? normalized.substring(0, index) : "";
        String after = index + target.length() < normalized.length()
                ? normalized.substring(index + target.length())
                : "";
        return (before.isEmpty() || before.endsWith(" ") || before.endsWith(":"))
                && (after.isEmpty() || after.startsWith(" ") || after.startsWith("."));
    }

    private void clearDefaultFlag() {
        LlmModel update = new LlmModel();
        update.setIsDefault(0);
        llmModelMapper.update(update, new QueryWrapper<LlmModel>().eq("is_default", 1));
    }
}
