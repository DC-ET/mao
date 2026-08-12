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

import java.io.EOFException;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.ConnectException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * OpenAI 兼容协议的 LLM 适配器实现
 */
@Slf4j
@Component
public class OpenAiLlmAdapter implements LlmAdapter {

    private final OkHttpClient httpClient;
    private final OkHttpClient streamHttpClient;
    private final ObjectMapper objectMapper;
    private final LlmRetryConfig llmRetryConfig;

    /**
     * 用于异步取消 OkHttp Call 的守护线程池。
     * 不在业务线程同步 cancel()：SSL 写阻塞时 Socket.close() 会等待同一把 SSL 写锁
     * （Okio Watchdog 被锁卡住即由此引起），同步取消会把业务线程一并卡死。
     */
    private final ExecutorService cancellerExecutor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "llm-http-canceller");
        t.setDaemon(true);
        return t;
    });

    public OpenAiLlmAdapter(ObjectMapper objectMapper, LlmRetryConfig llmRetryConfig) {
        this.objectMapper = objectMapper;
        this.llmRetryConfig = llmRetryConfig;
        this.httpClient = new OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(llmRetryConfig.getStreamIdleTimeoutSeconds(), TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .callTimeout(llmRetryConfig.getHttpCallTimeoutSeconds(), TimeUnit.SECONDS)
                // 连接池保活时间设置得比常见网关/负载均衡的空闲超时更短，
                // 避免复用一条已被中间设备静默断开、但本地看起来仍然存活的"假活"连接
                // （表现为：进程运行一段时间后偶发卡死在 LLM 请求上，重启即可临时缓解）。
                .connectionPool(new ConnectionPool(5, 20, TimeUnit.SECONDS))
                // 对 HTTP/2 连接主动发送心跳探测，及时发现并淘汰已失效的连接
                .pingInterval(15, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build();
        // SSE 生命周期不设总调用期限：响应头由应用层 callTimeoutSeconds 约束，
        // 响应体仅由 readTimeout 的连续空闲期限约束。
        this.streamHttpClient = httpClient.newBuilder()
                .callTimeout(0, TimeUnit.SECONDS)
                .build();
    }

    @Override
    public ChatResponse chat(ChatRequest request, LlmModelConfig config) {
        Request httpRequest = buildRequest(request, config, false);
        long totalStarted = System.nanoTime();
        for (int attempt = 1; ; attempt++) {
            long attemptStarted = System.nanoTime();
            try (Response response = awaitResponse(httpRequest, false, null, null,
                    config.getModelId(), attempt).response()) {
                log.info("LLM response headers model={} phase=response_headers attempt={} firstByteMs={} totalMs={}",
                        config.getModelId(), attempt, elapsedMillis(attemptStarted), elapsedMillis(totalStarted));
                if (isRetryableStatus(response.code())) {
                    if (attempt > llmRetryConfig.getRateLimitMaxRetries()) {
                        throw buildRetryExhaustedException(response);
                    }
                    int delaySeconds = resolveRetryDelaySeconds(response, attempt);
                    logRetry(config.getModelId(), "http_status", response.code(), attempt, delaySeconds,
                            attemptStarted, totalStarted);
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
                ChatResponse result = objectMapper.readValue(body.string(), ChatResponse.class);
                log.info("LLM call complete model={} phase=complete attempt={} firstByteMs={} totalMs={}",
                        config.getModelId(), attempt, elapsedMillis(attemptStarted), elapsedMillis(totalStarted));
                return result;
            } catch (IOException | TimeoutException e) {
                if (!isRetryableNetworkFailure(e) || attempt > llmRetryConfig.getRateLimitMaxRetries()) {
                    throw new RuntimeException("LLM call failed: " + networkReason(e), e);
                }
                int delaySeconds = resolveRetryDelaySeconds(null, attempt);
                logRetry(config.getModelId(), networkReason(e), null, attempt, delaySeconds,
                        attemptStarted, totalStarted);
                sleepSeconds(delaySeconds);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("LLM call interrupted", e);
            }
        }
    }

    @Override
    public void stream(ChatRequest request, LlmModelConfig config, StreamCallback callback, AtomicBoolean cancelFlag) {
        Request httpRequest = buildRequest(request, config, true);
        long totalStarted = System.nanoTime();
        for (int attempt = 1; ; attempt++) {
            if (isCancelled(cancelFlag)) {
                callback.onError(cancelledException());
                return;
            }
            long attemptStarted = System.nanoTime();
            ResponseAwaitResult awaited;
            try {
                awaited = awaitResponse(httpRequest, true, cancelFlag, callback,
                        config.getModelId(), attempt);
            } catch (RuntimeException e) {
                callback.onError(isCancelled(cancelFlag) ? cancelledException() : e);
                return;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                callback.onError(cancelledException());
                return;
            } catch (IOException | TimeoutException e) {
                if (isCancelled(cancelFlag)) {
                    callback.onError(cancelledException());
                    return;
                }
                if (!isRetryableNetworkFailure(e) || attempt > llmRetryConfig.getRateLimitMaxRetries()) {
                    callback.onError(e);
                    return;
                }
                int delaySeconds = resolveRetryDelaySeconds(null, attempt);
                if (!notifyAndWaitForRetry(callback, cancelFlag, config.getModelId(), networkReason(e),
                        null, attempt, delaySeconds, attemptStarted, totalStarted)) {
                    callback.onError(cancelledException());
                    return;
                }
                continue;
            }
            try (Response response = awaited.response()) {
                log.info("LLM response headers model={} phase=response_headers attempt={} firstByteMs={} totalMs={}",
                        config.getModelId(), attempt, elapsedMillis(attemptStarted), elapsedMillis(totalStarted));
                if (isRetryableStatus(response.code())) {
                    if (attempt > llmRetryConfig.getRateLimitMaxRetries()) {
                        callback.onError(buildRetryExhaustedException(response));
                        return;
                    }
                    int delaySeconds = resolveRetryDelaySeconds(response, attempt);
                    if (!notifyAndWaitForRetry(callback, cancelFlag, config.getModelId(), "http_status",
                            response.code(), attempt, delaySeconds, attemptStarted, totalStarted)) {
                        callback.onError(cancelledException());
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
                processStreamBody(body, config, callback, cancelFlag, awaited.call());
                log.info("LLM stream complete model={} phase=complete attempt={} firstByteMs={} totalMs={}",
                        config.getModelId(), attempt, elapsedMillis(attemptStarted), elapsedMillis(totalStarted));
                return;
            } catch (IOException e) {
                if (isCancelled(cancelFlag)) {
                    callback.onError(cancelledException());
                    return;
                }
                boolean interruptedAfterOutput = e instanceof StreamInterruptedAfterOutputException;
                if (!isRetryableNetworkFailure(e) || attempt > llmRetryConfig.getRateLimitMaxRetries()) {
                    callback.onError(interruptedAfterOutput
                            ? new RuntimeException("模型流式响应已中断，自动重试已耗尽", e)
                            : e);
                    return;
                }
                if (interruptedAfterOutput) {
                    callback.onStreamReset();
                }
                int delaySeconds = resolveRetryDelaySeconds(null, attempt);
                if (!notifyAndWaitForRetry(callback, cancelFlag, config.getModelId(), networkReason(e),
                        null, attempt, delaySeconds, attemptStarted, totalStarted)) {
                    callback.onError(cancelledException());
                    return;
                }
            }
        }
    }

    private void processStreamBody(ResponseBody body, LlmModelConfig config,
                                   StreamCallback callback, AtomicBoolean cancelFlag,
                                   Call call) throws IOException {
        ChatUsage.ChatUsageBuilder usageBuilder = ChatUsage.builder();
        BufferedSource source = body.source();
        AtomicBoolean readingDone = new AtomicBoolean(false);
        AtomicLong lastDataNanos = new AtomicLong(System.nanoTime());
        CompletableFuture.runAsync(() -> {
            long nextWaiting = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (!readingDone.get()) {
                if (isCancelled(cancelFlag)) {
                    cancelInBackground(call);
                    return;
                }
                long now = System.nanoTime();
                if (now >= nextWaiting) {
                    callback.onWaiting("stream_data", elapsedSeconds(lastDataNanos.get()));
                    nextWaiting = now + TimeUnit.SECONDS.toNanos(2);
                }
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }, cancellerExecutor);

        AtomicBoolean emitted = new AtomicBoolean(false);
        boolean done = false;
        try {
            while (!source.exhausted()) {
                if (isCancelled(cancelFlag)) {
                    cancelInBackground(call);
                    throw new IOException("Cancelled by user");
                }

                String line = source.readUtf8Line();
                if (line == null) break;

                if (line.startsWith("data: ")) {
                    lastDataNanos.set(System.nanoTime());
                    String data = line.substring(6).trim();
                    if ("[DONE]".equals(data)) {
                        done = true;
                        break;
                    }

                    try {
                        StreamChunk chunk = objectMapper.readValue(data, StreamChunk.class);
                        if (log.isTraceEnabled()) {
                            log.trace("SSE chunk parsed: {}", data);
                        }
                        callback.onChunk(chunk);
                        if (hasAccumulatedOutput(chunk)) {
                            emitted.set(true);
                        }

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
            if (!done) {
                EOFException eof = new EOFException("stream ended before [DONE]");
                if (emitted.get()) {
                    throw new StreamInterruptedAfterOutputException(eof);
                }
                throw eof;
            }
            callback.onComplete(usageBuilder.build());
        } catch (IOException e) {
            if (e instanceof StreamInterruptedAfterOutputException) {
                throw e;
            }
            if (emitted.get()) {
                throw new StreamInterruptedAfterOutputException(e);
            }
            throw e;
        } finally {
            readingDone.set(true);
        }
    }

    private boolean hasAccumulatedOutput(StreamChunk chunk) {
        if (chunk.getChoices() == null) return false;
        for (StreamChunk.DeltaChoice choice : chunk.getChoices()) {
            StreamChunk.Delta delta = choice.getDelta();
            if (delta == null) continue;
            if (delta.getContent() != null && !delta.getContent().isEmpty()) return true;
            if (delta.getReasoningContent() != null && !delta.getReasoningContent().isEmpty()) return true;
            if (delta.getToolCalls() != null && !delta.getToolCalls().isEmpty()) return true;
        }
        return false;
    }

    /** 等待响应头；应用层期限仅覆盖首包阶段。 */
    private ResponseAwaitResult awaitResponse(Request httpRequest, boolean streaming,
                                               AtomicBoolean cancelFlag, StreamCallback callback,
                                               String model, int attempt)
            throws IOException, TimeoutException, InterruptedException {
        Call httpCall = (streaming ? streamHttpClient : httpClient).newCall(httpRequest);
        CompletableFuture<Response> responseFuture = new CompletableFuture<>();
        long started = System.nanoTime();
        long deadline = started + TimeUnit.SECONDS.toNanos(llmRetryConfig.getCallTimeoutSeconds());
        long nextWaiting = started + TimeUnit.SECONDS.toNanos(1);
        httpCall.enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                responseFuture.completeExceptionally(e);
            }

            @Override
            public void onResponse(Call call, Response response) {
                responseFuture.complete(response);
            }
        });

        while (true) {
            if (isCancelled(cancelFlag)) {
                cancelInBackground(httpCall);
                throw cancelledException();
            }
            long now = System.nanoTime();
            if (now >= deadline) {
                cancelInBackground(httpCall);
                log.warn("LLM timeout model={} phase=response_headers attempt={} firstByteMs={} totalMs={}",
                        model, attempt, elapsedMillis(started), elapsedMillis(started));
                throw new TimeoutException("response headers timed out after "
                        + llmRetryConfig.getCallTimeoutSeconds() + "s");
            }
            if (callback != null && now >= nextWaiting) {
                callback.onWaiting("response_headers", elapsedSeconds(started));
                nextWaiting = now + TimeUnit.SECONDS.toNanos(2);
            }
            try {
                return new ResponseAwaitResult(responseFuture.get(100, TimeUnit.MILLISECONDS), httpCall);
            } catch (TimeoutException ignored) {
                // Poll cancellation, first-byte deadline and waiting events.
            } catch (ExecutionException e) {
                Throwable cause = e.getCause() != null ? e.getCause() : e;
                if (cause instanceof IOException io) throw io;
                if (cause instanceof RuntimeException re) throw re;
                throw new IOException(cause);
            }
        }
    }

    private record ResponseAwaitResult(Response response, Call call) {
    }

    private static final class StreamInterruptedAfterOutputException extends IOException {
        private StreamInterruptedAfterOutputException(IOException cause) {
            super("LLM stream interrupted after output started; automatic retry disabled", cause);
        }
    }

    /**
     * 在独立守护线程中取消 OkHttp Call。
     * 不在业务线程同步 cancel()：SSL 写阻塞时 Socket.close() 会等待同一把 SSL 写锁，
     * 同步取消会把业务线程一并卡死（Okio Watchdog 被锁卡住即由此引起）。
     */
    private void cancelInBackground(Call call) {
        cancellerExecutor.execute(() -> {
            try {
                call.cancel();
            } catch (Throwable t) {
                log.debug("Failed to cancel LLM HTTP call in background: {}", t.getMessage());
            }
        });
    }

    /**
     * 指数退避计算本次重试等待秒数：delay = min(base * 2^(attempt-1), max)。
     * 服务端返回 Retry-After 响应头时优先采用，但仍受单次间隔上限约束。
     */
    private int resolveRetryDelaySeconds(Response response, int attempt) {
        int maxDelay = llmRetryConfig.getRateLimitMaxRetryDelaySeconds();
        if (response != null) {
            String retryAfter = response.header("Retry-After");
            if (retryAfter != null && !retryAfter.isBlank()) {
                try {
                    int seconds = Integer.parseInt(retryAfter.trim());
                    if (seconds > 0) {
                        return Math.min(seconds, maxDelay);
                    }
                } catch (NumberFormatException ignored) {
                    // Retry-After 可能是 HTTP 日期格式，回退到指数退避
                }
            }
        }
        int baseDelay = llmRetryConfig.getRateLimitRetryDelaySeconds();
        if (baseDelay <= 0 || maxDelay <= 0) return 0;
        int shift = Math.min(Math.max(attempt - 1, 0), 30);
        long backoff = Math.min((long) baseDelay * (1L << shift), maxDelay);
        // 0.5x~1.0x full jitter；delay=0 时不随机，确保测试稳定。
        long lower = Math.max(1, (backoff + 1) / 2);
        return (int) ThreadLocalRandom.current().nextLong(lower, backoff + 1);
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

    private boolean notifyAndWaitForRetry(StreamCallback callback, AtomicBoolean cancelFlag,
                                          String model, String reason, Integer statusCode,
                                          int attempt, int delaySeconds,
                                          long attemptStarted, long totalStarted) {
        if (isCancelled(cancelFlag)) return false;
        logRetry(model, reason, statusCode, attempt, delaySeconds, attemptStarted, totalStarted);
        callback.onRetry(reason, statusCode, attempt,
                llmRetryConfig.getRateLimitMaxRetries(), delaySeconds);
        return sleepSecondsRespectingCancel(delaySeconds, cancelFlag);
    }

    private void logRetry(String model, String reason, Integer statusCode, int attempt,
                          int delaySeconds, long attemptStarted, long totalStarted) {
        log.warn("LLM retry model={} phase=retry reason={} statusCode={} attempt={} maxRetries={} "
                        + "delaySeconds={} firstByteMs={} totalMs={}",
                model, reason, statusCode, attempt, llmRetryConfig.getRateLimitMaxRetries(),
                delaySeconds, elapsedMillis(attemptStarted), elapsedMillis(totalStarted));
    }

    private boolean isRetryableNetworkFailure(Throwable failure) {
        Throwable cause = failure;
        while (cause != null) {
            if (cause instanceof TimeoutException || cause instanceof SocketTimeoutException
                    || cause instanceof ConnectException || cause instanceof EOFException
                    || cause instanceof SocketException || cause instanceof IOException) {
                return true;
            }
            cause = cause.getCause();
        }
        return false;
    }

    private String networkReason(Throwable failure) {
        Throwable cause = failure;
        while (cause != null) {
            if (cause instanceof TimeoutException) return "response_header_timeout";
            if (cause instanceof SocketTimeoutException) return "stream_idle_timeout";
            if (cause instanceof InterruptedIOException
                    && "timeout".equalsIgnoreCase(cause.getMessage())) return "http_call_timeout";
            if (cause instanceof ConnectException) return "connect_failure";
            if (cause instanceof EOFException) return "unexpected_eof";
            if (cause.getCause() == null) break;
            cause = cause.getCause();
        }
        String message = cause.getMessage();
        if (message != null && message.toLowerCase(Locale.ROOT).contains("reset")) {
            return "connection_reset";
        }
        return "io_failure";
    }

    private long elapsedMillis(long startedNanos) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos);
    }

    private long elapsedSeconds(long startedNanos) {
        return TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - startedNanos);
    }

    private RuntimeException cancelledException() {
        return new RuntimeException("Cancelled by user");
    }

    private boolean isCancelled(AtomicBoolean cancelFlag) {
        return cancelFlag != null && cancelFlag.get();
    }

    private RuntimeException buildRetryExhaustedException(Response response) {
        String detail = readErrorBody(response);
        return new RuntimeException("LLM API returned " + response.code() + " after "
                + llmRetryConfig.getRateLimitMaxRetries() + " retries: " + detail);
    }

    /**
     * 可重试状态：404、429 限流、5xx 服务端错误（含 524 网关超时等）。
     */
    private boolean isRetryableStatus(int code) {
        return code == 404 || code == 429 || (code >= 500 && code < 600);
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
            if (request.getReasoning() != null) {
                body.put("reasoning", request.getReasoning());
            }
            if (request.getAudio() != null && !request.getAudio().isEmpty()) {
                body.put("audio", request.getAudio());
            }

            String json = objectMapper.writeValueAsString(body);
            log.debug("LLM request to {}: {}", config.getBaseUrl() + "/chat/completions", json);

            Request.Builder requestBuilder = new Request.Builder()
                    .url(config.getBaseUrl() + "/chat/completions")
                    .header("Authorization", "Bearer " + config.getApiKey())
                    .header("Content-Type", "application/json")
                    .post(RequestBody.create(json, MediaType.parse("application/json")));

            // 模型以 gpt 开头时附加 codex 相关请求头（用于识别调用方）
            if (config.getModelId() != null
                    && config.getModelId().toLowerCase(Locale.ROOT).startsWith("gpt")) {
                requestBuilder
                        .header("User-Agent", "codex_cli_rs/0.146.0 (Linux 6.1.0; x86_64) xterm-256color")
                        .header("originator", "codex_cli_rs")
                        .header("x-codex-window-id", "019e9e6a-e81e-7442-bac0-d3bc42cc1b45");
            }

            return requestBuilder.build();

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
