package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.safety.PathSandbox;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class SearchToolsTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @TempDir
    Path tempDir;

    @Test
    void globSearchFindsFilesWithJavaFallbackAndMarksTruncation() throws Exception {
        Files.createDirectories(tempDir.resolve("src/main"));
        Files.writeString(tempDir.resolve("src/main/App.java"), "class App {}");
        Files.writeString(tempDir.resolve("README.md"), "docs");
        GlobSearchTool tool = new GlobSearchTool(objectMapper, new PathSandbox(tempDir.toString()));
        ReflectionTestUtils.setField(tool, "rgAvailable", false);

        JsonNode result = objectMapper.readTree(tool.execute(objectMapper.writeValueAsString(
                Map.of("pattern", "**/*.java", "head_limit", 1)
        )));

        assertThat(result.get("files")).hasSize(1);
        assertThat(result.get("files").get(0).asText()).contains("App.java");
        assertThat(result.get("truncated").asBoolean()).isTrue();
        assertThat(result.get("total_matched").asInt()).isEqualTo(1);
    }

    @Test
    void grepSearchFindsMatchesWithContextAndIgnoreCase() throws Exception {
        Files.createDirectories(tempDir.resolve("src"));
        Files.writeString(tempDir.resolve("src/a.txt"), "before\nNeedle here\nafter\n");
        Files.writeString(tempDir.resolve("src/b.md"), "needle ignored by glob\n");
        GrepSearchTool tool = new GrepSearchTool(objectMapper, new PathSandbox(tempDir.toString()));
        ReflectionTestUtils.setField(tool, "rgAvailable", false);

        JsonNode result = objectMapper.readTree(tool.execute(objectMapper.writeValueAsString(
                Map.of("pattern", "needle", "glob", "*.txt", "ignore_case", true, "context_lines", 1)
        )));

        assertThat(result.get("total_matches").asInt()).isEqualTo(1);
        JsonNode match = result.get("matches").get(0);
        assertThat(match.get("file").asText()).contains("a.txt");
        assertThat(match.get("line").asInt()).isEqualTo(2);
        assertThat(match.get("context_before").get(0).asText()).isEqualTo("before");
        assertThat(match.get("context_after").get(0).asText()).isEqualTo("after");
    }

    @Test
    void grepSearchMarksTruncatedWhenOutputLimitIsExceeded() throws Exception {
        Files.writeString(tempDir.resolve("a.txt"), "needle one\nneedle two\n");
        GrepSearchTool tool = new GrepSearchTool(objectMapper, new PathSandbox(tempDir.toString()));
        ReflectionTestUtils.setField(tool, "rgAvailable", false);

        JsonNode result = objectMapper.readTree(tool.execute(objectMapper.writeValueAsString(
                Map.of("pattern", "needle", "max_output_chars", 1)
        )));

        assertThat(result.get("truncated").asBoolean()).isTrue();
    }
}
