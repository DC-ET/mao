package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.safety.PathSandbox;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

import static org.assertj.core.api.Assertions.assertThat;

class ReadFileToolTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @TempDir
    Path tempDir;

    @Test
    void readsWholeFileAndSupportsAliasPathFields() throws Exception {
        Files.writeString(tempDir.resolve("a.txt"), "one\ntwo\nthree");
        ReadFileTool tool = new ReadFileTool(objectMapper, new PathSandbox(tempDir.toString()));

        JsonNode result = execute(tool, Map.of("file_path", "a.txt"));

        assertThat(result.get("content").asText()).isEqualTo("one\ntwo\nthree");
        assertThat(result.get("total_lines").asInt()).isEqualTo(3);
    }

    @Test
    void readsOffsetAndLimitWindow() throws Exception {
        Files.writeString(tempDir.resolve("a.txt"), "one\ntwo\nthree\nfour");
        ReadFileTool tool = new ReadFileTool(objectMapper, new PathSandbox(tempDir.toString()));

        JsonNode result = execute(tool, Map.of("path", "a.txt", "offset", 1, "limit", 2));

        assertThat(result.get("content").asText()).isEqualTo("two\nthree");
        assertThat(result.get("total_lines").asInt()).isEqualTo(4);
    }

    @Test
    void returnsFriendlyErrorsForMissingPathMissingFileAndDirectories() throws Exception {
        Files.createDirectory(tempDir.resolve("dir"));
        ReadFileTool tool = new ReadFileTool(objectMapper, new PathSandbox(tempDir.toString()));

        assertThat(execute(tool, Map.of()).get("content").asText()).contains("缺少必填参数");
        assertThat(execute(tool, Map.of("path", "missing.txt")).get("content").asText()).contains("文件不存在");
        assertThat(execute(tool, Map.of("path", "dir")).get("content").asText()).contains("不是普通文件");
    }

    @Test
    void truncatesVeryLargeOutput() throws Exception {
        String content = IntStream.range(0, 6000)
                .mapToObj(i -> "line-" + i + "-abcdefghijklmnopqrstuvwxyz")
                .collect(Collectors.joining("\n"));
        Files.writeString(tempDir.resolve("large.txt"), content);
        ReadFileTool tool = new ReadFileTool(objectMapper, new PathSandbox(tempDir.toString()));

        JsonNode result = execute(tool, Map.of("path", "large.txt"));

        assertThat(result.get("content").asText()).contains("[output truncated]");
    }

    private JsonNode execute(ReadFileTool tool, Map<String, Object> args) throws Exception {
        return objectMapper.readTree(tool.execute(objectMapper.writeValueAsString(args)));
    }
}
