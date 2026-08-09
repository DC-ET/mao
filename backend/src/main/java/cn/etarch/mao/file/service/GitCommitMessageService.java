package cn.etarch.mao.file.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.harness.core.HarnessService;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatResponse;
import cn.etarch.mao.harness.llm.ChatUsage;
import cn.etarch.mao.harness.llm.LlmAdapter;
import cn.etarch.mao.harness.llm.LlmModelConfig;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.usage.service.LlmUsageService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

@Service
@RequiredArgsConstructor
public class GitCommitMessageService {
    public static final int MAX_DIFF_BYTES = 200 * 1024;
    public static final int MAX_FILES = 5000;
    private static final int MAX_PATH_LENGTH = 1024;
    private static final int MAX_CHANGE_TYPE_LENGTH = 32;
    private static final long TIMEOUT_SECONDS = 60;
    private static final Pattern TITLE = Pattern.compile(
            "^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\([a-zA-Z0-9._/-]+\\))?!?: .+$");
    private static final Pattern CHINESE = Pattern.compile("[\\u4e00-\\u9fff]");
    private static final String SYSTEM_PROMPT = """
            你只生成 Git 提交信息，不解释。标题必须符合 Conventional Commits：type 和可选 scope 使用英文，冒号后的描述使用简体中文。标题后空一行，正文至少一条且每个非空行都以“- ”开头并使用简体中文。不要臆测元数据或 diff 未体现的改动。敏感、二进制或截断文件只能依据元数据概括。禁止 Markdown 代码围栏。
            """;

    private final LlmAdapter llmAdapter;
    private final HarnessService harnessService;
    private final LlmUsageService usageService;
    private final ObjectMapper objectMapper;
    private final ExecutorService executor = Executors.newCachedThreadPool(r -> {
        Thread thread = new Thread(r, "git-commit-message-llm");
        thread.setDaemon(true);
        return thread;
    });

    @PreDestroy
    void shutdown() {
        executor.shutdownNow();
    }

    public CommitMessage generate(Session session, CommitGenerationInput input) {
        validateInput(input);
        LlmModel model = harnessService.resolveModel(session.getModelId());
        if (model == null) throw new BusinessException(ErrorCode.MODEL_NOT_FOUND);
        LlmModelConfig config = toConfig(model);
        String userPrompt = serialize(input);
        String first = invoke(session, model, config, List.of(
                message("system", SYSTEM_PROMPT), message("user", userPrompt)));
        String error = validateMessage(first);
        if (error == null) return parse(first);

        String second = invoke(session, model, config, List.of(
                message("system", SYSTEM_PROMPT),
                message("user", userPrompt),
                message("assistant", first),
                message("user", "上次输出格式不合规：" + error + "。请仅输出修正后的完整提交信息。")));
        String secondError = validateMessage(second);
        if (secondError != null) {
            throw new BusinessException(ErrorCode.LLM_CALL_FAILED, "提交信息格式连续两次不合规：" + secondError);
        }
        return parse(second);
    }

    public void validateInput(CommitGenerationInput input) {
        if (input == null || input.getFiles() == null || input.getFiles().isEmpty()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "变更摘要不能为空");
        }
        if (input.getFiles().size() > MAX_FILES) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "变更文件数量过多");
        }
        int actualDiffBytes = 0;
        for (CommitFile file : input.getFiles()) {
            if (file == null || blank(file.getPath()) || file.getPath().length() > MAX_PATH_LENGTH
                    || blank(file.getChangeType()) || file.getChangeType().length() > MAX_CHANGE_TYPE_LENGTH
                    || file.getInsertions() < 0 || file.getDeletions() < 0) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "变更摘要字段无效");
            }
            if ((file.isSensitive() || file.isBinary()) && !blank(file.getDiff())) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "敏感或二进制文件不得包含 diff");
            }
            if (file.getDiff() != null) actualDiffBytes += file.getDiff().getBytes(StandardCharsets.UTF_8).length;
            if (actualDiffBytes > MAX_DIFF_BYTES) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "diff 超过 200KB 限制");
            }
        }
        if (input.getDiffBytes() < 0 || input.getDiffBytes() > MAX_DIFF_BYTES || input.getDiffBytes() != actualDiffBytes) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "diffBytes 与实际内容不一致");
        }
    }

    static String validateMessage(String raw) {
        if (blank(raw)) return "输出为空";
        String text = normalize(raw);
        if (text.contains("```")) return "不得包含 Markdown 代码围栏";
        String[] lines = text.split("\\n", -1);
        if (!TITLE.matcher(lines[0]).matches()) return "标题不符合 Conventional Commits";
        int colon = lines[0].indexOf(": ");
        if (colon < 0 || !CHINESE.matcher(lines[0].substring(colon + 2)).find()) return "标题描述必须包含简体中文";
        if (lines.length < 3 || !lines[1].isEmpty()) return "标题后必须有一个空行";
        boolean body = false;
        for (int i = 2; i < lines.length; i++) {
            if (lines[i].isEmpty()) continue;
            body = true;
            if (!lines[i].startsWith("- ")) return "正文非空行必须以 - 开头";
            if (!CHINESE.matcher(lines[i].substring(2)).find()) return "正文必须使用简体中文";
        }
        return body ? null : "正文至少需要一条列表";
    }

    private String invoke(Session session, LlmModel model, LlmModelConfig config, List<ChatRequest.Message> messages) {
        ChatRequest request = ChatRequest.builder().messages(messages).tools(List.of()).stream(false).temperature(0.2).build();
        ChatResponse response = null;
        boolean success = false;
        try {
            response = executor.submit(() -> llmAdapter.chat(request, config)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            String content = extractContent(response);
            success = true;
            return content;
        } catch (TimeoutException e) {
            throw new BusinessException(ErrorCode.LLM_TIMEOUT, "提交信息生成超时");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BusinessException(ErrorCode.LLM_CALL_FAILED, "提交信息生成被中断");
        } catch (ExecutionException | RuntimeException e) {
            if (e instanceof BusinessException business) throw business;
            throw new BusinessException(ErrorCode.LLM_CALL_FAILED, "提交信息生成失败");
        } finally {
            ChatUsage usage = response != null ? response.getUsage() : null;
            usageService.record(session.getUserId(), session.getId(), model.getId(),
                    LlmUsageService.SCENE_GIT_COMMIT_MESSAGE, usage, success);
        }
    }

    private static String extractContent(ChatResponse response) {
        if (response == null || response.getChoices() == null || response.getChoices().isEmpty()
                || response.getChoices().get(0).getMessage() == null
                || !(response.getChoices().get(0).getMessage().getContent() instanceof String content)) {
            throw new BusinessException(ErrorCode.LLM_CALL_FAILED, "模型未返回提交信息");
        }
        return content;
    }

    private String serialize(CommitGenerationInput input) {
        try {
            return "请根据以下结构化变更生成提交信息：\n" + objectMapper.writeValueAsString(input);
        } catch (JsonProcessingException e) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "变更摘要无法序列化");
        }
    }

    private static ChatRequest.Message message(String role, String content) {
        return ChatRequest.Message.builder().role(role).content(content).build();
    }

    private static LlmModelConfig toConfig(LlmModel model) {
        return LlmModelConfig.builder().id(model.getId()).name(model.getName()).provider(model.getProvider())
                .baseUrl(model.getBaseUrl()).apiKey(model.getApiKey()).modelId(model.getModelId())
                .contextWindowTokens(model.getContextWindowTokens())
                .supportsVision(model.getSupportsVision() != null && model.getSupportsVision() == 1).build();
    }

    private static CommitMessage parse(String raw) {
        String text = normalize(raw);
        int newline = text.indexOf('\n');
        return new CommitMessage(text.substring(0, newline), text);
    }

    private static String normalize(String text) {
        return text.replace("\r\n", "\n").replace('\r', '\n').trim();
    }

    private static boolean blank(String value) { return value == null || value.isBlank(); }

    public record CommitMessage(String title, String message) {}

    @Data
    public static class CommitGenerationInput {
        private List<CommitFile> files;
        private boolean truncated;
        private int diffBytes;
    }

    @Data
    public static class CommitFile {
        private String path;
        private String changeType;
        private int insertions;
        private int deletions;
        private boolean binary;
        private boolean sensitive;
        private boolean truncated;
        private String diff;
    }
}
