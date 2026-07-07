package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.harness.tool.FileChangeDiffUtil;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class EditFileToolTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @TempDir
    Path tempDir;

    @Test
    void replacesAllOccurrencesAndReportsDiffPayload() throws Exception {
        Path file = tempDir.resolve("a.txt");
        Files.writeString(file, "alpha\nold\nbeta\nold\n");
        EditFileTool tool = new EditFileTool(objectMapper, new PathSandbox(tempDir.toString()));

        JsonNode result = execute(tool, Map.of("path", "a.txt", "old_string", "old", "new_string", "new"));

        assertThat(result.get("success").asBoolean()).isTrue();
        assertThat(result.get("replacements").asInt()).isEqualTo(2);
        assertThat(result.get("file_change").get("lines_added").asInt()).isEqualTo(2);
        assertThat(result.has(FileChangeDiffUtil.PRIVATE_DIFF_FIELD)).isTrue();
        assertThat(Files.readString(file)).isEqualTo("alpha\nnew\nbeta\nnew\n");
    }

    @Test
    void returnsErrorsWhenFileMissingOrNeedleMissing() throws Exception {
        Files.writeString(tempDir.resolve("a.txt"), "alpha");
        EditFileTool tool = new EditFileTool(objectMapper, new PathSandbox(tempDir.toString()));

        JsonNode missingFile = execute(tool, Map.of("path", "missing.txt", "old_string", "x", "new_string", "y"));
        JsonNode missingNeedle = execute(tool, Map.of("path", "a.txt", "old_string", "x", "new_string", "y"));

        assertThat(missingFile.get("success").asBoolean()).isFalse();
        assertThat(missingFile.get("error").asText()).contains("文件不存在");
        assertThat(missingNeedle.get("success").asBoolean()).isFalse();
        assertThat(missingNeedle.get("error").asText()).contains("未找到");
    }

    private JsonNode execute(EditFileTool tool, Map<String, Object> args) throws Exception {
        return objectMapper.readTree(tool.execute(objectMapper.writeValueAsString(args)));
    }
}
