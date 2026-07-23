package cn.etarch.mao.harness.llm;

import cn.etarch.mao.config.LlmRetryConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class OpenAiLlmAdapterTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    /** Minimal bytes that pass ImageFileSupport magic-byte checks (12+ bytes). */
    private static final byte[] PNG_MAGIC = new byte[] {
            (byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0
    };
    private static final byte[] JPEG_MAGIC = new byte[] {
            (byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 0, 0, 0, 0, 0, 0, 0, 0
    };

    @Test
    void chatIncludesEmptyContentForAssistantToolOnlyMessages() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(jsonResponse("{\"id\":\"ok\",\"choices\":[]}"));
            server.start();

            ChatRequest request = ChatRequest.builder()
                    .messages(List.of(ChatRequest.Message.builder()
                            .role("assistant")
                            .toolCalls(List.of(ChatRequest.ToolCall.builder()
                                    .id("call-1")
                                    .type("function")
                                    .function(ChatRequest.FunctionCall.builder()
                                            .name("read_file")
                                            .arguments("{}")
                                            .build())
                                    .build()))
                            .build()))
                    .build();

            adapter(0, 0).chat(request, config(server));

            String body = server.takeRequest().getBody().readUtf8();
            assertThat(body).contains("\"content\":\"\"");
        }
    }

    @Test
    void chatPostsOpenAiRequestAndParsesResponse() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(jsonResponse("""
                    {"id":"chat-1","model":"gpt-test","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}
                    """));
            server.start();

            ChatResponse response = adapter(0, 0).chat(request("hello"), config(server));

            assertThat(response.getId()).isEqualTo("chat-1");
            assertThat(response.getUsage().getTotalTokens()).isEqualTo(3);
            RecordedRequest recorded = server.takeRequest();
            assertThat(recorded.getPath()).isEqualTo("/chat/completions");
            assertThat(recorded.getHeader("Authorization")).isEqualTo("Bearer key");
            assertThat(recorded.getBody().readUtf8()).contains("\"model\":\"gpt-test\"")
                    .contains("\"stream\":false")
                    .contains("\"temperature\":0.2");
        }
    }

    @Test
    void chatRetriesRateLimitAndThrowsHttpErrors() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(new MockResponse().setResponseCode(429).setHeader("Retry-After", "bad").setBody("slow down"));
            server.enqueue(jsonResponse("""
                    {"id":"ok","choices":[]}
                    """));
            server.enqueue(new MockResponse().setResponseCode(500).setBody("server error"));
            server.start();

            OpenAiLlmAdapter adapter = adapter(1, 0);
            assertThat(adapter.chat(request("retry"), config(server)).getId()).isEqualTo("ok");
            assertThat(server.getRequestCount()).isEqualTo(2);
            assertThatThrownBy(() -> adapter.chat(request("fail"), config(server)))
                    .isInstanceOf(RuntimeException.class)
                    .hasMessageContaining("LLM API returned 500");
        }
    }

    @Test
    void chatConvertsImageUrlsToBase64AndKeepsFailedDownloadsAsUrl() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(new MockResponse().setResponseCode(200).setHeader("Content-Type", "image/png")
                    .setBody(new okio.Buffer().write(PNG_MAGIC)));
            server.enqueue(jsonResponse("{\"id\":\"ok\",\"choices\":[]}"));
            server.enqueue(new MockResponse().setResponseCode(404).setBody("no image"));
            server.enqueue(jsonResponse("{\"id\":\"fallback\",\"choices\":[]}"));
            server.start();

            String imageUrl = server.url("/image.png").toString();
            ChatRequest request = ChatRequest.builder()
                    .messages(List.of(ChatRequest.Message.builder()
                            .role("user")
                            .content(List.of(ChatRequest.ContentPart.builder()
                                    .type("image_url")
                                    .imageUrl(ChatRequest.ImageUrl.builder().url(imageUrl).build())
                                    .build()))
                            .build()))
                    .build();
            assertThat(adapter(0, 0).chat(request, visionConfig(server)).getId()).isEqualTo("ok");
            assertThat(((ChatRequest.ContentPart) ((List<?>) request.getMessages().get(0).getContent()).get(0))
                    .getImageUrl().getUrl()).startsWith("data:image/png;base64,");

            Map<String, Object> imageMap = new java.util.LinkedHashMap<>();
            imageMap.put("type", "image_url");
            imageMap.put("image_url", new java.util.LinkedHashMap<>(Map.of("url", server.url("/missing.png").toString())));
            ChatRequest mapRequest = ChatRequest.builder()
                    .messages(List.of(ChatRequest.Message.builder().role("user").content(List.of(imageMap)).build()))
                    .build();
            assertThat(adapter(0, 0).chat(mapRequest, visionConfig(server)).getId()).isEqualTo("fallback");
            assertThat(((Map<?, ?>) imageMap.get("image_url")).get("url").toString()).contains("/missing.png");
        }
    }

    @Test
    void chatCorrectsOctetStreamImageMimeFromMagicBytes() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(new MockResponse().setResponseCode(200)
                    .setHeader("Content-Type", "application/octet-stream")
                    .setBody(new okio.Buffer().write(JPEG_MAGIC)));
            server.enqueue(jsonResponse("{\"id\":\"ok\",\"choices\":[]}"));
            server.start();

            String imageUrl = server.url("/uploads/1784513683408_vsg_output_1784513632639").toString();
            ChatRequest request = ChatRequest.builder()
                    .messages(List.of(ChatRequest.Message.builder()
                            .role("user")
                            .content(List.of(ChatRequest.ContentPart.builder()
                                    .type("image_url")
                                    .imageUrl(ChatRequest.ImageUrl.builder().url(imageUrl).build())
                                    .build()))
                            .build()))
                    .build();

            assertThat(adapter(0, 0).chat(request, visionConfig(server)).getId()).isEqualTo("ok");
            String dataUri = ((ChatRequest.ContentPart) ((List<?>) request.getMessages().get(0).getContent()).get(0))
                    .getImageUrl().getUrl();
            assertThat(dataUri).startsWith("data:image/jpeg;base64,");
        }
    }

    @Test
    void streamParsesSseChunksUsageErrorsAndCancellation() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(new MockResponse()
                    .setHeader("Content-Type", "text/event-stream")
                    .setBody("""
                            data: {"choices":[{"delta":{"content":"hel"}}]}

                            data: bad-json

                            data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}

                            data: [DONE]

                            """));
            server.enqueue(new MockResponse().setResponseCode(500).setBody("bad"));
            server.start();

            CapturingCallback callback = new CapturingCallback();
            adapter(0, 0).stream(request("stream"), config(server), callback, new AtomicBoolean(false));

            assertThat(callback.chunks).hasSize(2);
            assertThat(callback.usage.getTotalTokens()).isEqualTo(7);
            assertThat(callback.error).isNull();

            CapturingCallback errorCallback = new CapturingCallback();
            adapter(0, 0).stream(request("error"), config(server), errorCallback, new AtomicBoolean(false));
            assertThat(errorCallback.error).hasMessageContaining("LLM API returned 500");

            CapturingCallback cancelled = new CapturingCallback();
            adapter(0, 0).stream(request("cancel"), config(server), cancelled, new AtomicBoolean(true));
            assertThat(cancelled.error).hasMessageContaining("Cancelled by user");
        }
    }

    @Test
    void chatSerializesSyntheticUserImageParts() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(jsonResponse("{\"id\":\"ok\",\"choices\":[]}"));
            server.start();

            ChatRequest request = ChatRequest.builder()
                    .messages(List.of(
                            ChatRequest.Message.builder().role("tool").toolCallId("call-1").content("ok").build(),
                            ChatRequest.Message.builder()
                                    .role("user")
                                    .content(List.of(
                                            ChatRequest.ContentPart.builder().type("text")
                                                    .text("Attached media from tool result:").build(),
                                            ChatRequest.ContentPart.builder().type("image_url")
                                                    .imageUrl(ChatRequest.ImageUrl.builder()
                                                            .url("data:image/png;base64,abc").build())
                                                    .build()))
                                    .build()))
                    .build();

            adapter(0, 0).chat(request, visionConfig(server));

            String body = server.takeRequest().getBody().readUtf8();
            assertThat(body).contains("\"type\":\"image_url\"");
            assertThat(body).contains("data:image/png;base64,abc");
        }
    }

    @Test
    void chatResizesDownloadedLargeImageForPrompt() throws Exception {
        byte[] largePng = writePng(2048, 2048);
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(new MockResponse().setResponseCode(200).setHeader("Content-Type", "image/png")
                    .setBody(new okio.Buffer().write(largePng)));
            server.enqueue(jsonResponse("{\"id\":\"ok\",\"choices\":[]}"));
            server.start();

            String imageUrl = server.url("/huge.png").toString();
            ChatRequest request = ChatRequest.builder()
                    .messages(List.of(ChatRequest.Message.builder()
                            .role("user")
                            .content(List.of(ChatRequest.ContentPart.builder()
                                    .type("image_url")
                                    .imageUrl(ChatRequest.ImageUrl.builder().url(imageUrl).build())
                                    .build()))
                            .build()))
                    .build();

            assertThat(adapter(0, 0).chat(request, visionConfig(server)).getId()).isEqualTo("ok");
            String dataUri = ((ChatRequest.ContentPart) ((List<?>) request.getMessages().get(0).getContent()).get(0))
                    .getImageUrl().getUrl();
            assertThat(dataUri).startsWith("data:image/png;base64,");
            byte[] decoded = java.util.Base64.getDecoder().decode(dataUri.substring(dataUri.indexOf(',') + 1));
            BufferedImage image = ImageIO.read(new ByteArrayInputStream(decoded));
            assertThat(image.getWidth()).isEqualTo(1600);
            assertThat(image.getHeight()).isEqualTo(1600);
            assertThat(decoded.length).isLessThan(largePng.length);
        }
    }

    @Test
    void chatResizesExistingDataUriWhenOverBudget() throws Exception {
        byte[] largePng = writePng(2048, 2048);
        String originalUri = "data:image/png;base64," + java.util.Base64.getEncoder().encodeToString(largePng);
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(jsonResponse("{\"id\":\"ok\",\"choices\":[]}"));
            server.start();

            ChatRequest request = ChatRequest.builder()
                    .messages(List.of(ChatRequest.Message.builder()
                            .role("user")
                            .content(List.of(ChatRequest.ContentPart.builder()
                                    .type("image_url")
                                    .imageUrl(ChatRequest.ImageUrl.builder().url(originalUri).build())
                                    .build()))
                            .build()))
                    .build();

            adapter(0, 0).chat(request, visionConfig(server));
            String dataUri = ((ChatRequest.ContentPart) ((List<?>) request.getMessages().get(0).getContent()).get(0))
                    .getImageUrl().getUrl();
            assertThat(dataUri).isNotEqualTo(originalUri);
            byte[] decoded = java.util.Base64.getDecoder().decode(dataUri.substring(dataUri.indexOf(',') + 1));
            BufferedImage image = ImageIO.read(new ByteArrayInputStream(decoded));
            assertThat(image.getWidth()).isEqualTo(1600);
            assertThat(image.getHeight()).isEqualTo(1600);
        }
    }

    private static byte[] writePng(int width, int height) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        g.setColor(Color.RED);
        g.fillRect(0, 0, width, height);
        g.dispose();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private OpenAiLlmAdapter adapter(int maxRetries, int retryDelaySeconds) {
        LlmRetryConfig retryConfig = new LlmRetryConfig();
        retryConfig.setRateLimitMaxRetries(maxRetries);
        retryConfig.setRateLimitRetryDelaySeconds(retryDelaySeconds);
        return new OpenAiLlmAdapter(objectMapper, retryConfig);
    }

    private static LlmModelConfig config(MockWebServer server) {
        return LlmModelConfig.builder()
                .baseUrl(server.url("").toString().replaceAll("/$", ""))
                .apiKey("key")
                .modelId("gpt-test")
                .build();
    }

    private static LlmModelConfig visionConfig(MockWebServer server) {
        return LlmModelConfig.builder()
                .baseUrl(server.url("").toString().replaceAll("/$", ""))
                .apiKey("key")
                .modelId("gpt-test")
                .supportsVision(true)
                .build();
    }

    private static ChatRequest request(String content) {
        return ChatRequest.builder()
                .temperature(0.2)
                .messages(List.of(ChatRequest.Message.builder().role("user").content(content).build()))
                .tools(List.of(ChatRequest.ToolDefinition.builder()
                        .type("function")
                        .function(ChatRequest.Function.builder().name("lookup").description("lookup").parameters(Map.of()).build())
                        .build()))
                .build();
    }

    private static MockResponse jsonResponse(String body) {
        return new MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody(body);
    }

    private static class CapturingCallback implements StreamCallback {
        final List<StreamChunk> chunks = new ArrayList<>();
        ChatUsage usage;
        Throwable error;

        @Override
        public void onChunk(StreamChunk chunk) {
            chunks.add(chunk);
        }

        @Override
        public void onComplete(ChatUsage usage) {
            this.usage = usage;
        }

        @Override
        public void onError(Throwable t) {
            this.error = t;
        }
    }
}
