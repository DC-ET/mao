package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.config.UploadProperties;
import cn.etarch.mao.harness.tool.ImageFileSupport;
import cn.etarch.mao.harness.tool.Tool;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.service.ModelService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * 图片生成工具：基于启用的文生图模型（model_type=image）调用 /images/generations 生成图片。
 * 生成的图片保存到上传目录，并返回可访问的 URL。
 */
@Slf4j
@Component
public class GenerateImageTool implements Tool {

    private static final MediaType JSON_MEDIA_TYPE = MediaType.parse("application/json");
    private static final long MAX_IMAGE_BYTES = 20L * 1024 * 1024;

    private final ObjectMapper objectMapper;
    private final OkHttpClient httpClient;
    private final ModelService modelService;
    private final UploadProperties uploadProperties;

    @Value("${app.file.upload-dir:./uploads}")
    private String uploadDir;

    public GenerateImageTool(ObjectMapper objectMapper, ModelService modelService,
                             UploadProperties uploadProperties) {
        this.objectMapper = objectMapper;
        this.modelService = modelService;
        this.uploadProperties = uploadProperties;
        this.httpClient = new OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(180, TimeUnit.SECONDS)
                .build();
    }

    @Override
    public String getName() {
        return "generate_image";
    }

    @Override
    public String getDescription() {
        return "根据文字描述生成图片（文生图）。基于配置的文生图模型生成符合描述的图片，返回图片的访问 URL 与本地保存路径。帮助 Agent 完成绘图、示意图、配图等图片生成需求。";
    }

    @Override
    public String getToolPrompt() {
        return """
                ## generate_image 工具使用指南

                - generate_image 用于根据文字描述生成图片，底层调用配置的文生图模型（如 GPT Image 2）。
                - prompt 应使用英文或中文描述清楚画面内容、风格、构图等，描述越具体生成效果越好。
                - size 可选值：1024x1024、1024x1536、1536x1024（默认 1024x1024）。
                - 工具执行成功后返回图片的访问 URL（image_url）与本地保存路径（image_path），可直接用于展示或引用。
                - 若没有可用的文生图模型（model_type=image），工具会返回错误，请提示用户先在管理后台配置文生图模型。
                """;
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("prompt", Map.of("type", "string", "description", "图片内容描述，越具体越好（支持中英文）"));
        properties.put("size", Map.of("type", "string", "description", "生成图片尺寸：1024x1024 / 1024x1536 / 1536x1024（默认 1024x1024）"));
        properties.put("n", Map.of("type", "integer", "description", "生成图片数量（默认 1）"));
        schema.put("properties", properties);
        schema.put("required", new String[]{"prompt"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("images", Map.of(
                "type", "array",
                "items", Map.of(
                        "type", "object",
                        "properties", Map.of(
                                "image_url", Map.of("type", "string"),
                                "image_path", Map.of("type", "string"),
                                "size_bytes", Map.of("type", "integer")
                        )
                )
        ));
        properties.put("model", Map.of("type", "string"));
        properties.put("prompt", Map.of("type", "string"));
        schema.put("properties", properties);
        return schema;
    }

    @Override
    public String execute(String arguments) {
        return execute(arguments, null, null);
    }

    @Override
    public String execute(String arguments, String workspace) {
        return execute(arguments, null, workspace);
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        return execute(arguments, sessionId, null, workspace);
    }

    @Override
    public String execute(String arguments, Long sessionId, Long userId, String workspace) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String prompt = args.has("prompt") ? args.get("prompt").asText() : "";
            if (prompt == null || prompt.isBlank()) {
                return errorJson("图片描述（prompt）不能为空");
            }

            LlmModel model = modelService.findFirstActiveImageModel();
            if (model == null) {
                return errorJson("未找到启用的文生图模型（model_type=image），请先在管理后台配置并启用");
            }

            String size = args.has("size") && !args.get("size").asText().isBlank()
                    ? args.get("size").asText().trim() : "1024x1024";
            int n = args.has("n") ? Math.max(1, Math.min(4, args.get("n").asInt(1))) : 1;

            // Build request body per OpenAI images API
            Map<String, Object> requestBody = new HashMap<>();
            requestBody.put("model", model.getModelId());
            requestBody.put("prompt", prompt);
            requestBody.put("size", size);
            requestBody.put("n", n);

            String requestJson = objectMapper.writeValueAsString(requestBody);
            log.info("GenerateImage request: model={}, size={}, n={}, prompt={}",
                    model.getModelId(), size, n, prompt);

            Request request = new Request.Builder()
                    .url(model.getBaseUrl() + "/images/generations")
                    .header("Authorization", "Bearer " + model.getApiKey())
                    .header("Content-Type", "application/json")
                    .post(RequestBody.create(requestJson, JSON_MEDIA_TYPE))
                    .build();

            try (Response response = httpClient.newCall(request).execute()) {
                ResponseBody body = response.body();
                String responseJson = body != null ? body.string() : "";

                if (!response.isSuccessful()) {
                    log.warn("Image generation API returned {}: {}", response.code(), responseJson);
                    return errorJson("图片生成接口返回错误 (HTTP " + response.code() + "): " + extractErrorMessage(responseJson));
                }

                JsonNode root = objectMapper.readTree(responseJson);
                JsonNode data = root.get("data");
                if (data == null || !data.isArray() || data.isEmpty()) {
                    return errorJson("图片生成接口未返回图片数据");
                }

                List<Map<String, Object>> images = new ArrayList<>();
                for (JsonNode item : data) {
                    if (item.has("url") && !item.get("url").asText().isBlank()) {
                        Map<String, Object> result = new HashMap<>();
                        result.put("image_url", item.get("url").asText());
                        result.put("image_path", null);
                        result.put("size_bytes", 0);
                        images.add(result);
                    } else if (item.has("b64_json") && !item.get("b64_json").asText().isBlank()) {
                        String base64 = item.get("b64_json").asText();
                        try {
                            Map<String, Object> saved = saveImage(base64, userId, sessionId);
                            images.add(saved);
                        } catch (Exception e) {
                            log.error("Failed to save generated image", e);
                            return errorJson("图片已生成但保存失败: " + e.getMessage());
                        }
                    } else {
                        return errorJson("图片生成接口返回的数据格式不支持（缺少 url 或 b64_json）");
                    }
                }

                return objectMapper.writeValueAsString(Map.of(
                        "images", images,
                        "model", model.getModelId(),
                        "prompt", prompt
                ));
            }

        } catch (java.net.SocketTimeoutException e) {
            log.error("GenerateImage timed out", e);
            return errorJson("图片生成请求超时，请稍后重试");
        } catch (Exception e) {
            log.error("GenerateImageTool execution failed", e);
            return errorJson("图片生成失败：" + e.getMessage());
        }
    }

    /**
     * 将 b64_json 解码为图片字节并保存到上传目录，返回 URL 与路径。
     */
    private Map<String, Object> saveImage(String base64, Long userId, Long sessionId) throws Exception {
        byte[] bytes = java.util.Base64.getDecoder().decode(base64);
        if (bytes.length == 0) {
            throw new IllegalStateException("图片数据为空");
        }
        if (bytes.length > MAX_IMAGE_BYTES) {
            throw new IllegalStateException("图片超过大小限制 (" + (MAX_IMAGE_BYTES / 1024 / 1024) + "MB)");
        }

        String mime = ImageFileSupport.detectMimeFromBytes(bytes)
                .orElse("image/png");
        String extension = ImageFileSupport.extensionForMime(mime).orElse(".png");
        String storedName = UUID.randomUUID() + extension;

        Path uploadPath = Paths.get(uploadDir);
        if (!Files.exists(uploadPath)) {
            Files.createDirectories(uploadPath);
        }
        Path filePath = uploadPath.resolve(storedName);
        Files.write(filePath, bytes);

        String baseUrl = uploadProperties.getBaseUrl();
        String url = (baseUrl != null && !baseUrl.isEmpty() ? baseUrl : "")
                + "/uploads/" + storedName;

        Map<String, Object> result = new HashMap<>();
        result.put("image_url", url);
        result.put("image_path", filePath.toString());
        result.put("size_bytes", bytes.length);
        return result;
    }

    private String extractErrorMessage(String responseJson) {
        try {
            JsonNode node = objectMapper.readTree(responseJson);
            JsonNode message = node.get("error");
            if (message != null && message.has("message")) {
                return message.get("message").asText();
            }
        } catch (Exception ignored) {
            // fall through
        }
        return responseJson;
    }

    private String errorJson(String message) {
        try {
            return objectMapper.writeValueAsString(Map.of("error", message));
        } catch (Exception e) {
            return "{\"error\":\"" + message.replace("\"", "'") + "\"}";
        }
    }
}
