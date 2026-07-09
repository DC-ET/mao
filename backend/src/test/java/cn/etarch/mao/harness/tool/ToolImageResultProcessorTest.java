package cn.etarch.mao.harness.tool;

import cn.etarch.mao.harness.core.ToolAttachmentLoader;
import cn.etarch.mao.session.entity.Message;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ToolImageResultProcessorTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void stripsDataUriAndBuildsMetadataWhenVisionSupported() throws Exception {
        String raw = """
                {"content":"图片读取成功","total_lines":0,"media_type":"image","mime":"image/png",\
                "path":"a.png","data_uri":"data:image/png;base64,abc"}""";

        var processed = ToolImageResultProcessor.process(raw, true, objectMapper);

        assertThat(processed.sanitizedContent()).doesNotContain("data_uri");
        assertThat(processed.attachment().getDataUri()).startsWith("data:image/png;base64,");
        assertThat(processed.metadataJson()).contains("attachments");
        assertThat(processed.preview()).containsEntry("media_type", "image");
    }

    @Test
    void returnsVisionErrorWithoutAttachmentWhenUnsupported() throws Exception {
        String raw = """
                {"content":"图片读取成功","total_lines":0,"media_type":"image","mime":"image/png",\
                "path":"a.png","data_uri":"data:image/png;base64,abc"}""";

        var processed = ToolImageResultProcessor.process(raw, false, objectMapper);

        assertThat(processed.sanitizedContent()).contains("不支持图片输入");
        assertThat(processed.attachment()).isNull();
        assertThat(processed.metadataJson()).isNull();
    }

    @Test
    void returnsPlainTextToolResultUnchangedWithoutWarningPath() {
        String raw = "exit_code: 0\nstdout:\nok\n";

        var processed = ToolImageResultProcessor.process(raw, true, objectMapper);

        assertThat(processed.sanitizedContent()).isEqualTo(raw);
        assertThat(processed.attachment()).isNull();
        assertThat(processed.metadataJson()).isNull();
        assertThat(processed.preview()).isNull();
    }

    @Test
    void loadsAttachmentFromMessageMetadata() throws Exception {
        Message message = new Message();
        message.setRole("TOOL");
        message.setToolCallId("call-1");
        message.setMetadata("""
                {"attachments":[{"mime":"image/png","path":"a.png","data_uri":"data:image/png;base64,xyz"}]}""");

        Map<String, cn.etarch.mao.harness.core.ToolAttachment> loaded =
                ToolAttachmentLoader.loadAllFromMessages(java.util.List.of(message), objectMapper);

        assertThat(loaded).containsKey("call-1");
        assertThat(loaded.get("call-1").getDataUri()).contains("xyz");
    }
}
