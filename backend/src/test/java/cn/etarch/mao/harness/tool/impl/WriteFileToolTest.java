package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.safety.PathSandbox;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

import static org.assertj.core.api.Assertions.assertThat;

class WriteFileToolTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @TempDir
    Path tempDir;

    @Test
    void reportsLineDeltasWhenOverwritingExistingFile() throws Exception {
        Path file = tempDir.resolve("sample.txt");
        String original = lines(1, 100);
        String updated = lines(1, 150);
        Files.writeString(file, original);

        WriteFileTool tool = new WriteFileTool(objectMapper, new PathSandbox(tempDir.toString()));
        String result = tool.execute(objectMapper.writeValueAsString(
                java.util.Map.of("path", "sample.txt", "content", updated)
        ));

        JsonNode change = objectMapper.readTree(result).get("file_change");
        assertThat(change.get("lines_added").asInt()).isEqualTo(50);
        assertThat(change.get("lines_deleted").asInt()).isZero();
    }

    @Test
    void reportsTotalLinesWhenCreatingFile() throws Exception {
        WriteFileTool tool = new WriteFileTool(objectMapper, new PathSandbox(tempDir.toString()));
        String result = tool.execute(objectMapper.writeValueAsString(
                java.util.Map.of("path", "created.txt", "content", lines(1, 3))
        ));

        JsonNode change = objectMapper.readTree(result).get("file_change");
        assertThat(change.get("lines_added").asInt()).isEqualTo(3);
        assertThat(change.get("lines_deleted").asInt()).isZero();
    }

    private String lines(int startInclusive, int endInclusive) {
        return IntStream.rangeClosed(startInclusive, endInclusive)
                .mapToObj(i -> "line " + i)
                .collect(Collectors.joining("\n"));
    }
}
