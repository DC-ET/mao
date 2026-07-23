package cn.etarch.mao.harness.llm;

import cn.etarch.mao.config.LlmRetryConfig;
import cn.etarch.mao.harness.core.MessageHistoryNormalizer;
import cn.etarch.mao.harness.tool.ImageFileSupport;
import cn.etarch.mao.harness.tool.PromptImageResizer;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import okio.BufferedSource;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * OpenAI 兼容协议的 LLM 适配器实现
 */
@Slf4j
@Component
public class OpenAiLlmAdapter implements LlmAdapter {

    private final OkHttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final LlmRetryConfig llmRetryConfig;

    public OpenAiLlmAdapter(ObjectMapper objectMapper, LlmRetryConfig llmRetryConfig) {
        this.objectMapper = objectMapper;
        this.llmRetryConfig = llmRetryConfig;
        this.httpClient = new OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.MINUTES)
                .writeTimeout(30, TimeUnit.SECONDS)
                // 连接池保活时间设置得比常见网关/负载均衡的空闲超时更短，
                // 避免复用一条已被中间设备静默断开、但本地看起来仍然存活的"假活"连接
                // （表现为：进程运行一段时间后偶发卡死在 LLM 请求上，重启即可临时缓解）。
                .connectionPool(new ConnectionPool(5, 20, TimeUnit.SECONDS))
                // 对 HTTP/2 连接主动发送心跳探测，及时发现并淘汰已失效的连接
                .pingInterval(15, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build();
    }

    @Override
    public ChatResponse chat(ChatRequest request, LlmModelConfig config) {
        Request httpRequest = buildRequest(request, config, false);
        int attempt = 0;

        while (true) {
            attempt++;
            try (Response response = httpClient.newCall(httpRequest).execute()) {
                if (response.code() == 429) {
                    if (attempt > llmRetryConfig.getRateLimitMaxRetries()) {
                        throw buildRateLimitException(response);
                    }
                    int delaySeconds = resolveRetryDelaySeconds(response);
                    log.warn("LLM API rate limited (429), retry {}/{} after {}s, model={}",
                            attempt, llmRetryConfig.getRateLimitMaxRetries(), delaySeconds, config.getModelId());
                    sleepSeconds(delaySeconds);
                    continue;
                }

                if (!response.isSuccessful()) {
                    throw buildHttpException(response);
                }

                ResponseBody body = response.body();
                if (body == null) {
                    throw new RuntimeException("LLM API returned empty body");
                }

                String json = body.string();
                return objectMapper.readValue(json, ChatResponse.class);

            } catch (IOException e) {
                throw new RuntimeException("LLM call failed: " + e.getMessage(), e);
            }
        }
    }

    @Override
    public void stream(ChatRequest request, LlmModelConfig config, StreamCallback callback, AtomicBoolean cancelFlag) {
        log.debug("stream: starting, model={}", config.getModelId());
        Request httpRequest = buildRequest(request, config, true);
        int attempt = 0;

        while (true) {
            attempt++;
            if (isCancelled(cancelFlag)) {
                callback.onError(new RuntimeException("Cancelled by user"));
                return;
            }

            Response response = awaitResponse(httpRequest, cancelFlag, callback);
            if (response == null) {
                return;
            }

            try {
                log.debug("stream: response code={}", response.code());
                if (response.code() == 429) {
                    if (attempt > llmRetryConfig.getRateLimitMaxRetries()) {
                        callback.onError(buildRateLimitException(response));
                        return;
                    }
                    int delaySeconds = resolveRetryDelaySeconds(response);
                    log.warn("LLM API rate limited (429), retry {}/{} after {}s, model={}",
                            attempt, llmRetryConfig.getRateLimitMaxRetries(), delaySeconds, config.getModelId());
                    if (!sleepSecondsRespectingCancel(delaySeconds, cancelFlag)) {
                        callback.onError(new RuntimeException("Cancelled by user"));
                        return;
                    }
                    continue;
                }

                if (!response.isSuccessful()) {
                    callback.onError(buildHttpException(response));
                    return;
                }

                ResponseBody body = response.body();
                if (body == null) {
                    callback.onError(new RuntimeException("LLM API returned empty body"));
                    return;
                }

                try {
                    processStreamBody(body, config, callback, cancelFlag);
                } catch (IOException e) {
                    if (isCancelled(cancelFlag)) {
                        log.info("Stream cancelled by user (IO interrupted) for model={}", config.getModelId());
                        callback.onError(new RuntimeException("Cancelled by user"));
                    } else {
                        callback.onError(e);
                    }
                }
                return;

            } finally {
                response.close();
            }
        }
    }

    private void processStreamBody(ResponseBody body, LlmModelConfig config,
                                   StreamCallback callback, AtomicBoolean cancelFlag) throws IOException {
        ChatUsage.ChatUsageBuilder usageBuilder = ChatUsage.builder();
        BufferedSource source = body.source();

        while (!source.exhausted()) {
            if (isCancelled(cancelFlag)) {
                log.info("Stream cancelled by user for model={}", config.getModelId());
                callback.onError(new RuntimeException("Cancelled by user"));
                return;
            }

            String line = source.readUtf8Line();
            if (line == null) break;

            if (line.startsWith("data: ")) {
                String data = line.substring(6).trim();
                if ("[DONE]".equals(data)) {
                    break;
                }

                try {
                    StreamChunk chunk = objectMapper.readValue(data, StreamChunk.class);
                    if (log.isTraceEnabled()) {
                        log.trace("SSE chunk parsed: {}", data);
                    }
                    callback.onChunk(chunk);

                    JsonNode node = objectMapper.readTree(data);
                    if (node.has("usage")) {
                        JsonNode usage = node.get("usage");
                        usageBuilder.promptTokens(usage.path("prompt_tokens").asInt(0));
                        usageBuilder.completionTokens(usage.path("completion_tokens").asInt(0));
                        usageBuilder.totalTokens(usage.path("total_tokens").asInt(0));
                    }
                } catch (Exception e) {
                    log.warn("Failed to parse SSE chunk: {}", data, e);
                }
            }
        }

        callback.onComplete(usageBuilder.build());
    }

    /**
     * 异步发起 HTTP 请求并轮询等待响应，支持取消。
     *
     * @return 响应对象；若已取消或连接失败则返回 null（错误已通过 callback 上报）
     */
    private Response awaitResponse(Request httpRequest, AtomicBoolean cancelFlag, StreamCallback callback) {
        Call httpCall = httpClient.newCall(httpRequest);
        CompletableFuture<Response> responseFuture = new CompletableFuture<>();
        httpCall.enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                if (isCancelled(cancelFlag)) {
                    responseFuture.completeExceptionally(new RuntimeException("Cancelled by user"));
                } else {
                    responseFuture.completeExceptionally(e);
                }
            }

            @Override
            public void onResponse(Call call, Response response) {
                responseFuture.complete(response);
            }
        });

        try {
            while (true) {
                if (isCancelled(cancelFlag)) {
                    httpCall.cancel();
                    callback.onError(new RuntimeException("Cancelled by user"));
                    return null;
                }
                try {
                    return responseFuture.get(100, TimeUnit.MILLISECONDS);
                } catch (TimeoutException e) {
                    // poll cancel flag until response arrives
                } catch (ExecutionException e) {
                    Throwable cause = e.getCause() != null ? e.getCause() : e;
                    if (cause instanceof RuntimeException re) {
                        callback.onError(re);
                    } else {
                        callback.onError(cause);
                    }
                    return null;
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    httpCall.cancel();
                    callback.onError(new RuntimeException("Cancelled by user"));
                    return null;
                }
            }
        } catch (RuntimeException e) {
            callback.onError(e);
            return null;
        }
    }

    private int resolveRetryDelaySeconds(Response response) {
        String retryAfter = response.header("Retry-After");
        if (retryAfter != null && !retryAfter.isBlank()) {
            try {
                int seconds = Integer.parseInt(retryAfter.trim());
                if (seconds > 0) {
                    return seconds;
                }
            } catch (NumberFormatException ignored) {
                // Retry-After 可能是 HTTP 日期格式，回退到默认等待时间
            }
        }
        return llmRetryConfig.getRateLimitRetryDelaySeconds();
    }

    private void sleepSeconds(int seconds) {
        try {
            Thread.sleep(seconds * 1000L);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("Interrupted while waiting for LLM rate limit retry", e);
        }
    }

    /**
     * 分段睡眠以便及时响应取消请求。
     *
     * @return false 表示等待期间被取消
     */
    private boolean sleepSecondsRespectingCancel(int seconds, AtomicBoolean cancelFlag) {
        long deadline = System.currentTimeMillis() + seconds * 1000L;
        while (System.currentTimeMillis() < deadline) {
            if (isCancelled(cancelFlag)) {
                return false;
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return true;
    }

    private boolean isCancelled(AtomicBoolean cancelFlag) {
        return cancelFlag != null && cancelFlag.get();
    }

    private RuntimeException buildRateLimitException(Response response) {
        String detail = readErrorBody(response);
        return new RuntimeException("LLM API rate limited (429) after "
                + llmRetryConfig.getRateLimitMaxRetries() + " retries: " + detail);
    }

    private RuntimeException buildHttpException(Response response) {
        String detail = readErrorBody(response);
        return new RuntimeException("LLM API returned " + response.code() + ": " + detail);
    }

    private String readErrorBody(Response response) {
        String errorBody = "";
        try {
            ResponseBody rb = response.body();
            if (rb != null) {
                errorBody = rb.string();
            }
        } catch (Exception ignored) {
        }
        return errorBody.length() > 500 ? errorBody.substring(0, 500) : errorBody;
    }

    private Request buildRequest(ChatRequest request, LlmModelConfig config, boolean stream) {
        try {
            // Copy so placeholder replacement can rewrite entries even when caller passed List.of(...)
            List<ChatRequest.Message> messages = request.getMessages() != null
                    ? new ArrayList<>(request.getMessages())
                    : null;
            MessageHistoryNormalizer.ensureContentPresent(messages);

            // 模型不支持视觉时，将图片替换为占位文案
            boolean supportsVision = config.getSupportsVision() != null && config.getSupportsVision();
            if (!supportsVision && messages != null) {
                replaceImagesWithPlaceholder(messages);
            }

            // Convert image URLs to base64 data URIs for models that don't support URL
            if (messages != null) {
                for (ChatRequest.Message msg : messages) {
                    convertImageUrlsToBase64(msg);
                }
            }

            // Build OpenAI-compatible request body
            var body = new java.util.HashMap<String, Object>();
            body.put("model", config.getModelId());
            body.put("messages", messages);
            body.put("stream", stream);

            if (request.getTemperature() != null) {
                body.put("temperature", request.getTemperature());
            }
            if (request.getTools() != null && !request.getTools().isEmpty()) {
                body.put("tools", request.getTools());
            }

            String json = objectMapper.writeValueAsString(body);
            log.debug("LLM request to {}: {}", config.getBaseUrl() + "/chat/completions", json);

            return new Request.Builder()
                    .url(config.getBaseUrl() + "/chat/completions")
                    .header("Authorization", "Bearer " + config.getApiKey())
                    .header("Content-Type", "application/json")
                    .post(RequestBody.create(json, MediaType.parse("application/json")))
                    .build();

        } catch (Exception e) {
            throw new RuntimeException("Failed to build LLM request", e);
        }
    }

    /**
     * Convert image_url content parts to resized base64 data URIs.
     * HTTP(S) URLs are downloaded; existing data: URIs are decoded and resized if needed.
     */
    private void convertImageUrlsToBase64(ChatRequest.Message msg) {
        if (!(msg.getContent() instanceof List<?> list)) {
            return;
        }
        for (Object part : list) {
            String url = extractImageUrl(part);
            if (url == null || url.isBlank()) {
                continue;
            }
            try {
                String base64Uri;
                if (url.startsWith("data:")) {
                    base64Uri = resizeDataUri(url);
                } else {
                    base64Uri = downloadAndEncode(url);
                }
                if (base64Uri != null) {
                    setImageUrl(part, base64Uri);
                    if (!base64Uri.equals(url)) {
                        log.debug("Prepared image for prompt: {} -> {} chars",
                                url.startsWith("data:") ? "data-uri" : url, base64Uri.length());
                    }
                }
            } catch (Exception e) {
                log.warn("Failed to prepare image for prompt, keeping original URL: {}",
                        url.startsWith("data:") ? "data-uri" : url, e);
            }
        }
    }

    /**
     * Decode a data URI, apply prompt resize, and re-encode.
     */
    private String resizeDataUri(String dataUri) throws IOException {
        int comma = dataUri.indexOf(',');
        if (comma < 0) {
            throw new IOException("Invalid data URI");
        }
        String meta = dataUri.substring(5, comma); // after "data:"
        String payload = dataUri.substring(comma + 1);
        String mimeHint = null;
        int semi = meta.indexOf(';');
        if (semi > 0) {
            mimeHint = meta.substring(0, semi);
        } else if (!meta.isBlank() && !meta.contains("base64")) {
            mimeHint = meta;
        }
        if (!meta.contains("base64")) {
            throw new IOException("Only base64 data URIs are supported");
        }
        byte[] bytes = Base64.getDecoder().decode(payload);
        return PromptImageResizer.tryResizeForPrompt(bytes, mimeHint)
                .map(PromptImageResizer.Result::toDataUri)
                .orElse(dataUri);
    }

    private String extractImageUrl(Object part) {
        if (part instanceof ChatRequest.ContentPart cp) {
            return "image_url".equals(cp.getType()) && cp.getImageUrl() != null
                    ? cp.getImageUrl().getUrl() : null;
        }
        if (part instanceof Map<?, ?> map) {
            if (!"image_url".equals(map.get("type"))) return null;
            Object imageUrlObj = map.get("image_url");
            if (imageUrlObj instanceof Map<?, ?> imgMap) {
                Object url = imgMap.get("url");
                return url instanceof String s ? s : null;
            }
        }
        return null;
    }

    private void setImageUrl(Object part, String base64Uri) {
        if (part instanceof ChatRequest.ContentPart cp && cp.getImageUrl() != null) {
            cp.getImageUrl().setUrl(base64Uri);
        } else if (part instanceof Map<?, ?> map) {
            Object imageUrlObj = map.get("image_url");
            if (imageUrlObj instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> imgMap = (Map<String, Object>) imageUrlObj;
                imgMap.put("url", base64Uri);
            }
        }
    }

    /**
     * 当模型不支持视觉输入时，将消息中的 image_url ContentPart 替换为文本占位文案。
     * 混合消息（文字+图片）：保留文字，移除所有 image_url part，末尾追加占位文案。
     * 纯图片消息（无文字）：整条 content 替换为占位文案。
     */
    private void replaceImagesWithPlaceholder(List<ChatRequest.Message> messages) {
        if (messages == null) return;
        for (int i = 0; i < messages.size(); i++) {
            ChatRequest.Message msg = messages.get(i);
            if (!(msg.getContent() instanceof List<?> list)) continue;

            List<Object> textParts = new ArrayList<>();
            boolean hasImage = false;

            for (Object part : list) {
                String type = extractPartType(part);
                if ("image_url".equals(type)) {
                    hasImage = true;
                } else {
                    textParts.add(part);
                }
            }

            if (!hasImage) continue;

            String textContent = buildTextFromParts(textParts);
            if (!textContent.isEmpty()) {
                textContent += "\n\u300C\u6B64\u5904\u7528\u6237\u4E0A\u4F20\u4E86\u56FE\u7247\u300D";
            } else {
                textContent = "\u300C\u6B64\u5904\u7528\u6237\u4E0A\u4F20\u4E86\u56FE\u7247\u300D";
            }

            messages.set(i, ChatRequest.Message.builder()
                    .role(msg.getRole())
                    .content(textContent)
                    .name(msg.getName())
                    .toolCallId(msg.getToolCallId())
                    .toolCalls(msg.getToolCalls())
                    .build());
        }
    }

    private String extractPartType(Object part) {
        if (part instanceof ChatRequest.ContentPart cp) return cp.getType();
        if (part instanceof Map<?, ?> map) {
            Object type = map.get("type");
            return type instanceof String s ? s : null;
        }
        return null;
    }

    private String buildTextFromParts(List<Object> textParts) {
        StringBuilder sb = new StringBuilder();
        for (Object part : textParts) {
            String text = extractPartText(part);
            if (text != null) sb.append(text);
        }
        return sb.toString().trim();
    }

    private String extractPartText(Object part) {
        if (part instanceof ChatRequest.ContentPart cp) return cp.getText();
        if (part instanceof Map<?, ?> map) {
            Object text = map.get("text");
            return text instanceof String s ? s : null;
        }
        return null;
    }

    /**
     * Download an image from URL, resize for prompt, and encode as a base64 data URI.
     * Resolves MIME from magic bytes when the server returns application/octet-stream
     * or another non-image Content-Type (common for extensionless OSS objects).
     */
    private String downloadAndEncode(String imageUrl) throws IOException {
        Request req = new Request.Builder().url(imageUrl).build();
        try (Response res = httpClient.newCall(req).execute()) {
            if (!res.isSuccessful()) {
                throw new IOException("HTTP " + res.code() + " when downloading image: " + imageUrl);
            }
            ResponseBody body = res.body();
            if (body == null) {
                throw new IOException("Empty body when downloading image: " + imageUrl);
            }
            byte[] bytes = body.bytes();
            MediaType contentType = body.contentType();
            String declaredMime = contentType != null
                    ? contentType.type() + "/" + contentType.subtype()
                    : null;
            String mimeType = ImageFileSupport.resolveImageMime(bytes, declaredMime, imageUrl)
                    .orElseThrow(() -> new IOException(
                            "Downloaded content is not a supported image type: " + imageUrl
                                    + " (Content-Type=" + declaredMime + ")"));
            if (declaredMime != null && !ImageFileSupport.isImageMime(declaredMime)) {
                log.info("Corrected image MIME for {}: {} -> {}", imageUrl, declaredMime, mimeType);
            }
            return PromptImageResizer.tryResizeForPrompt(bytes, mimeType)
                    .map(PromptImageResizer.Result::toDataUri)
                    .orElseGet(() -> "data:" + mimeType + ";base64,"
                            + Base64.getEncoder().encodeToString(bytes));
        }
    }
}
