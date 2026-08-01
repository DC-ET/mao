package cn.etarch.mao.harness.llm;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
public class ChatRequest {

    private List<Message> messages;
    private List<ToolDefinition> tools;
    private Double temperature;
    private Boolean stream;
    private Reasoning reasoning;

    /** TTS 等音频模型的请求参数，如 {"format": "wav", "voice": "mimo_default"} */
    private Map<String, Object> audio;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Reasoning {
        private String effort;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Message {
        private String role;      // system, user, assistant, tool
        private Object content;   // String (plain text) or List<ContentPart> (multimodal)
        private String name;
        @JsonProperty("tool_call_id")
        private String toolCallId;
        @JsonProperty("tool_calls")
        private List<ToolCall> toolCalls;
        /** TTS 响应中的音频数据（base64） */
        private Audio audio;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Audio {
        /** base64 编码的音频数据 */
        private String data;
        /** 音频格式：wav / pcm16 等 */
        private String format;
        /** 音频转写文本（部分模型返回） */
        private String transcript;
        /** 音频时长（秒） */
        private Double duration;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ContentPart {
        private String type;              // "text" or "image_url"
        private String text;              // type=text
        @JsonProperty("image_url")
        private ImageUrl imageUrl;        // type=image_url
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ImageUrl {
        private String url;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class ToolDefinition {
        private String type;      // "function"
        private Function function;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Function {
        private String name;
        private String description;
        private Map<String, Object> parameters;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ToolCall {
        private String id;
        private String type;      // "function"
        private FunctionCall function;
        private String summary;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class FunctionCall {
        private String name;
        private String arguments;
    }
}
