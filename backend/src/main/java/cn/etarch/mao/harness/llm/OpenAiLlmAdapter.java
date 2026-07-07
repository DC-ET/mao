package cn.etarch.mao.harness.llm;

import cn.etarch.mao.config.LlmRetryConfig;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import okio.BufferedSource;
import org.springframework.stereotype.Component;

import java.io.IOException;
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
            // Convert image URLs to base64 data URIs for models that don't support URL
            List<ChatRequest.Message> messages = request.getMessages();
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
     * Convert image_url content parts from HTTP URLs to base64 data URIs.
     * Skips URLs that are already base64 data URIs (starting with "data:").
     */
    private void convertImageUrlsToBase64(ChatRequest.Message msg) {
        if (!(msg.getContent() instanceof List<?> list)) {
            return;
        }
        for (Object part : list) {
            String url = extractImageUrl(part);
            if (url == null || url.startsWith("data:")) {
                continue;
            }
            try {
                String base64Uri = downloadAndEncode(url);
                setImageUrl(part, base64Uri);
                log.debug("Converted image URL to base64: {} -> {} chars", url, base64Uri.length());
            } catch (Exception e) {
                log.warn("Failed to convert image URL to base64, keeping original URL: {}", url, e);
            }
        }
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
     * Download an image from URL and encode it as a base64 data URI.
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
            String mimeType = body.contentType() != null
                    ? body.contentType().toString()
                    : "application/octet-stream";
            String encoded = Base64.getEncoder().encodeToString(bytes);
            return "data:" + mimeType + ";base64," + encoded;
        }
    }
}
