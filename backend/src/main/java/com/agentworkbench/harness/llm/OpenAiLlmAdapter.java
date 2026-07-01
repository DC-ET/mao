package com.agentworkbench.harness.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import okio.BufferedSource;
import org.springframework.stereotype.Component;

import java.io.IOException;
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

    public OpenAiLlmAdapter(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.httpClient = new OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.MINUTES)
                .writeTimeout(30, TimeUnit.SECONDS)
                .build();
    }

    @Override
    public ChatResponse chat(ChatRequest request, LlmModelConfig config) {
        Request httpRequest = buildRequest(request, config, false);

        try (Response response = httpClient.newCall(httpRequest).execute()) {
            if (!response.isSuccessful()) {
                String errorBody = "";
                try {
                    ResponseBody rb = response.body();
                    if (rb != null) errorBody = rb.string();
                } catch (Exception ignored) {}
                String detail = errorBody.length() > 500 ? errorBody.substring(0, 500) : errorBody;
                throw new RuntimeException("LLM API returned " + response.code() + ": " + detail);
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

    @Override
    public void stream(ChatRequest request, LlmModelConfig config, StreamCallback callback, AtomicBoolean cancelFlag) {
        log.debug("stream: starting, model={}", config.getModelId());
        Request httpRequest = buildRequest(request, config, true);
        Call httpCall = httpClient.newCall(httpRequest);

        CompletableFuture<Response> responseFuture = new CompletableFuture<>();
        httpCall.enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                if (cancelFlag != null && cancelFlag.get()) {
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

        Response response;
        try {
            while (true) {
                if (cancelFlag != null && cancelFlag.get()) {
                    httpCall.cancel();
                    callback.onError(new RuntimeException("Cancelled by user"));
                    return;
                }
                try {
                    response = responseFuture.get(100, TimeUnit.MILLISECONDS);
                    break;
                } catch (TimeoutException e) {
                    // poll cancel flag until response arrives
                } catch (ExecutionException e) {
                    Throwable cause = e.getCause() != null ? e.getCause() : e;
                    if (cause instanceof RuntimeException re) {
                        callback.onError(re);
                    } else {
                        callback.onError(cause);
                    }
                    return;
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    httpCall.cancel();
                    callback.onError(new RuntimeException("Cancelled by user"));
                    return;
                }
            }
        } catch (RuntimeException e) {
            callback.onError(e);
            return;
        }

        try {
            log.debug("stream: response code={}", response.code());
            if (!response.isSuccessful()) {
                String errorBody = "";
                try {
                    ResponseBody rb = response.body();
                    if (rb != null) errorBody = rb.string();
                } catch (Exception ignored) {}
                String detail = errorBody.length() > 500 ? errorBody.substring(0, 500) : errorBody;
                callback.onError(new RuntimeException("LLM API returned " + response.code() + ": " + detail));
                return;
            }

            ResponseBody body = response.body();
            if (body == null) {
                callback.onError(new RuntimeException("LLM API returned empty body"));
                return;
            }

            ChatUsage.ChatUsageBuilder usageBuilder = ChatUsage.builder();
            BufferedSource source = body.source();

            while (!source.exhausted()) {
                if (cancelFlag != null && cancelFlag.get()) {
                    log.info("Stream cancelled by user for model={}", config.getModelId());
                    httpCall.cancel();
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

        } catch (IOException e) {
            if (cancelFlag != null && cancelFlag.get()) {
                log.info("Stream cancelled by user (IO interrupted) for model={}", config.getModelId());
                callback.onError(new RuntimeException("Cancelled by user"));
            } else {
                callback.onError(e);
            }
        } finally {
            response.close();
        }
    }

    private Request buildRequest(ChatRequest request, LlmModelConfig config, boolean stream) {
        try {
            // Build OpenAI-compatible request body
            var body = new java.util.HashMap<String, Object>();
            body.put("model", config.getModelId());
            body.put("messages", request.getMessages());
            body.put("stream", stream);

            if (request.getTemperature() != null) {
                body.put("temperature", request.getTemperature());
            }
            if (request.getTools() != null && !request.getTools().isEmpty()) {
                body.put("tools", request.getTools());
            }

            String json = objectMapper.writeValueAsString(body);
            log.info("LLM request to {}: {}", config.getBaseUrl() + "/chat/completions", json);

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
}
