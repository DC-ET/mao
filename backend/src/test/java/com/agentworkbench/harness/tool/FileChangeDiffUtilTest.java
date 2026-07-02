package com.agentworkbench.harness.tool;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class FileChangeDiffUtilTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void buildsSnapshotForSmallTextFiles() {
        Map<String, Object> diff = FileChangeDiffUtil.buildDiff("a.txt", "old\n", "new\n");

        assertThat(diff).containsEntry("diff_mode", "SNAPSHOT");
        assertThat(diff).containsEntry("before_content", "old\n");
        assertThat(diff).containsEntry("after_content", "new\n");
    }

    @Test
    void degradesBinaryContentToUnsupported() {
        Map<String, Object> diff = FileChangeDiffUtil.buildDiff("a.bin", "abc\u0000def", "xyz");

        assertThat(diff).containsEntry("diff_mode", "UNSUPPORTED");
        assertThat(diff).containsKey("diff_unavailable_reason");
    }

    @Test
    void storesPatchForLargeTextFiles() {
        String largeBefore = "a\n".repeat((FileChangeDiffUtil.SNAPSHOT_LIMIT_BYTES / 2) + 1);
        String largeAfter = largeBefore + "tail\n";

        Map<String, Object> diff = FileChangeDiffUtil.buildDiff("large.txt", largeBefore, largeAfter);

        assertThat(diff).containsEntry("diff_mode", "PATCH");
        assertThat((String) diff.get("patch_content")).contains("--- a/large.txt", "+++ b/large.txt", "+tail");
    }

    @Test
    void stripsPrivateDiffPayloadFromToolResult() throws Exception {
        String raw = """
                {"success":true,"file_change":{"path":"a.txt"},"file_change_diff":{"diff_mode":"SNAPSHOT","before_content":"a","after_content":"b"}}
                """;

        String stripped = FileChangeDiffUtil.stripPrivateDiff(raw, objectMapper);
        JsonNode node = objectMapper.readTree(stripped);

        assertThat(node.has(FileChangeDiffUtil.PRIVATE_DIFF_FIELD)).isFalse();
        assertThat(node.get("file_change").get("path").asText()).isEqualTo("a.txt");
    }

    @Test
    void computesLineDeltaForAppendAndReplacement() {
        FileChangeDiffUtil.LineDelta append = FileChangeDiffUtil.computeLineDelta(
                "a\nb\nc",
                "a\nb\nc\nd\ne");
        FileChangeDiffUtil.LineDelta replace = FileChangeDiffUtil.computeLineDelta(
                "a\nold\nc",
                "a\nnew\nc");

        assertThat(append.linesAdded()).isEqualTo(2);
        assertThat(append.linesDeleted()).isZero();
        assertThat(replace.linesAdded()).isEqualTo(1);
        assertThat(replace.linesDeleted()).isEqualTo(1);
    }
}
