package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.LlmModelConfig;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ToolMediaInjectorTest {

    private final ToolMediaInjector injector = new ToolMediaInjector();

    @Test
    void injectsSyntheticUserMessageAfterToolWithImageAttachment() {
        List<ChatRequest.Message> messages = List.of(
                ChatRequest.Message.builder().role("assistant").content("").toolCalls(List.of(
                        ChatRequest.ToolCall.builder().id("call-1").build())).build(),
                ChatRequest.Message.builder().role("tool").toolCallId("call-1").content("{\"content\":\"ok\"}").build()
        );
        Map<String, ToolAttachment> attachments = Map.of(
                "call-1", ToolAttachment.builder()
                        .mime("image/png")
                        .path("a.png")
                        .dataUri("data:image/png;base64,abc")
                        .build()
        );
        LlmModelConfig config = LlmModelConfig.builder().supportsVision(true).build();

        List<ChatRequest.Message> injected = injector.inject(messages, attachments, config);

        assertThat(injected).hasSize(3);
        assertThat(injected.get(2).getRole()).isEqualTo("user");
        assertThat(injected.get(2).getContent()).isInstanceOf(List.class);
        @SuppressWarnings("unchecked")
        List<ChatRequest.ContentPart> parts = (List<ChatRequest.ContentPart>) injected.get(2).getContent();
        assertThat(parts).hasSize(2);
        assertThat(parts.get(0).getText()).isEqualTo(ToolMediaInjector.SYNTHETIC_ATTACHMENT_PROMPT);
        assertThat(parts.get(1).getType()).isEqualTo("image_url");
        assertThat(parts.get(1).getImageUrl().getUrl()).isEqualTo("data:image/png;base64,abc");
    }

    @Test
    void skipsInjectionWhenVisionUnsupported() {
        List<ChatRequest.Message> messages = List.of(
                ChatRequest.Message.builder().role("tool").toolCallId("call-1").content("{\"content\":\"ok\"}").build()
        );
        Map<String, ToolAttachment> attachments = Map.of(
                "call-1", ToolAttachment.builder()
                        .mime("image/png")
                        .path("a.png")
                        .dataUri("data:image/png;base64,abc")
                        .build()
        );
        LlmModelConfig config = LlmModelConfig.builder().supportsVision(false).build();

        List<ChatRequest.Message> injected = injector.inject(messages, attachments, config);

        assertThat(injected).hasSize(1);
    }

    @Test
    void leavesNonToolMessagesUntouched() {
        List<ChatRequest.Message> messages = List.of(
                ChatRequest.Message.builder().role("user").content("hello").build()
        );

        List<ChatRequest.Message> injected = injector.inject(messages, new LinkedHashMap<>(),
                LlmModelConfig.builder().supportsVision(true).build());

        assertThat(injected).hasSize(1);
        assertThat(injected.get(0).getContent()).isEqualTo("hello");
    }
}
