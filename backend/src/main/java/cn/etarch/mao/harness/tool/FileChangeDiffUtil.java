package cn.etarch.mao.harness.tool;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

public final class FileChangeDiffUtil {

    public static final String PRIVATE_DIFF_FIELD = "file_change_diff";
    public static final int SNAPSHOT_LIMIT_BYTES = 512 * 1024;
    public static final int PATCH_LIMIT_CHARS = 256 * 1024;

    private static final int PATCH_CONTEXT_LINES = 3;
    private static final int LCS_CELL_LIMIT = 2_000_000;

    private FileChangeDiffUtil() {
    }

    public static Map<String, Object> buildDiff(String path, String beforeContent, String afterContent) {
        String before = beforeContent != null ? beforeContent : "";
        String after = afterContent != null ? afterContent : "";
        Map<String, Object> diff = new LinkedHashMap<>();

        if (isBinary(before) || isBinary(after)) {
            diff.put("diff_mode", "UNSUPPORTED");
            diff.put("diff_unavailable_reason", "二进制文件无法生成文本 diff");
            diff.put("patch_truncated", false);
            return diff;
        }

        if (utf8Bytes(before) <= SNAPSHOT_LIMIT_BYTES && utf8Bytes(after) <= SNAPSHOT_LIMIT_BYTES) {
            diff.put("diff_mode", "SNAPSHOT");
            diff.put("before_content", before);
            diff.put("after_content", after);
            diff.put("patch_truncated", false);
            return diff;
        }

        PatchResult patch = buildUnifiedPatch(path, before, after);
        diff.put("diff_mode", "PATCH");
        diff.put("patch_content", patch.content());
        diff.put("patch_truncated", patch.truncated());
        return diff;
    }

    public static String stripPrivateDiff(String result, ObjectMapper objectMapper) {
        if (result == null || result.isBlank()) {
            return result;
        }
        try {
            JsonNode node = objectMapper.readTree(result);
            if (node instanceof ObjectNode objectNode && objectNode.has(PRIVATE_DIFF_FIELD)) {
                objectNode.remove(PRIVATE_DIFF_FIELD);
                return objectMapper.writeValueAsString(objectNode);
            }
        } catch (Exception ignored) {
        }
        return result;
    }

    public static LineDelta computeLineDelta(String beforeContent, String afterContent) {
        String[] oldLines = splitLines(beforeContent);
        String[] newLines = splitLines(afterContent);
        if (oldLines.length == 0) {
            return new LineDelta(newLines.length, 0);
        }
        if (newLines.length == 0) {
            return new LineDelta(0, oldLines.length);
        }

        int prefix = 0;
        while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix].equals(newLines[prefix])) {
            prefix++;
        }

        int oldSuffix = oldLines.length - 1;
        int newSuffix = newLines.length - 1;
        while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix].equals(newLines[newSuffix])) {
            oldSuffix--;
            newSuffix--;
        }

        int oldChanged = oldSuffix - prefix + 1;
        int newChanged = newSuffix - prefix + 1;
        if (oldChanged <= 0) {
            return new LineDelta(Math.max(0, newChanged), 0);
        }
        if (newChanged <= 0) {
            return new LineDelta(0, Math.max(0, oldChanged));
        }

        long cells = (long) oldChanged * (long) newChanged;
        if (cells > LCS_CELL_LIMIT) {
            return new LineDelta(newChanged, oldChanged);
        }

        int lcs = lcsLength(oldLines, prefix, oldSuffix, newLines, prefix, newSuffix);
        return new LineDelta(newChanged - lcs, oldChanged - lcs);
    }

    private static boolean isBinary(String text) {
        int checkLen = Math.min(text.length(), 8192);
        for (int i = 0; i < checkLen; i++) {
            if (text.charAt(i) == 0) {
                return true;
            }
        }
        return false;
    }

    private static int utf8Bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8).length;
    }

    private static PatchResult buildUnifiedPatch(String path, String before, String after) {
        String[] oldLines = splitLines(before);
        String[] newLines = splitLines(after);

        int prefix = 0;
        while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix].equals(newLines[prefix])) {
            prefix++;
        }

        int oldSuffix = oldLines.length - 1;
        int newSuffix = newLines.length - 1;
        while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix].equals(newLines[newSuffix])) {
            oldSuffix--;
            newSuffix--;
        }

        int contextStart = Math.max(0, prefix - PATCH_CONTEXT_LINES);
        int oldContextEnd = Math.min(oldLines.length - 1, oldSuffix + PATCH_CONTEXT_LINES);
        int newContextEnd = Math.min(newLines.length - 1, newSuffix + PATCH_CONTEXT_LINES);

        int oldStartLine = contextStart + 1;
        int newStartLine = contextStart + 1;
        int oldCount = Math.max(0, oldContextEnd - contextStart + 1);
        int newCount = Math.max(0, newContextEnd - contextStart + 1);

        StringBuilder patch = new StringBuilder(Math.min(PATCH_LIMIT_CHARS, 8192));
        boolean truncated = false;
        truncated |= appendBounded(patch, "--- a/" + path + "\n");
        truncated |= appendBounded(patch, "+++ b/" + path + "\n");
        truncated |= appendBounded(patch, "@@ -" + oldStartLine + "," + oldCount
                + " +" + newStartLine + "," + newCount + " @@\n");

        for (int i = contextStart; i < prefix && i < oldLines.length; i++) {
            truncated |= appendBounded(patch, " " + oldLines[i] + "\n");
        }
        for (int i = prefix; i <= oldSuffix && i < oldLines.length; i++) {
            truncated |= appendBounded(patch, "-" + oldLines[i] + "\n");
        }
        for (int i = prefix; i <= newSuffix && i < newLines.length; i++) {
            truncated |= appendBounded(patch, "+" + newLines[i] + "\n");
        }

        int sharedTailStart = Math.max(prefix, Math.max(oldSuffix + 1, newSuffix + 1));
        int sharedTailEnd = Math.min(oldContextEnd, oldLines.length - 1);
        for (int i = sharedTailStart; i <= sharedTailEnd; i++) {
            truncated |= appendBounded(patch, " " + oldLines[i] + "\n");
        }

        if (truncated && !patch.toString().endsWith("\n...[diff truncated]\n")) {
            int maxPrefix = Math.max(0, PATCH_LIMIT_CHARS - "\n...[diff truncated]\n".length());
            patch.setLength(Math.min(patch.length(), maxPrefix));
            patch.append("\n...[diff truncated]\n");
        }
        return new PatchResult(patch.toString(), truncated);
    }

    private static String[] splitLines(String text) {
        if (text == null || text.isEmpty()) {
            return new String[0];
        }
        return text.split("\\R", -1);
    }

    private static boolean appendBounded(StringBuilder builder, String text) {
        if (builder.length() >= PATCH_LIMIT_CHARS) {
            return true;
        }
        int remaining = PATCH_LIMIT_CHARS - builder.length();
        if (text.length() <= remaining) {
            builder.append(text);
            return false;
        }
        builder.append(text, 0, remaining);
        return true;
    }

    private static int lcsLength(String[] oldLines, int oldStart, int oldEnd,
                                 String[] newLines, int newStart, int newEnd) {
        int newLen = newEnd - newStart + 1;
        int[] previous = new int[newLen + 1];
        int[] current = new int[newLen + 1];

        for (int i = oldStart; i <= oldEnd; i++) {
            for (int j = 1; j <= newLen; j++) {
                if (oldLines[i].equals(newLines[newStart + j - 1])) {
                    current[j] = previous[j - 1] + 1;
                } else {
                    current[j] = Math.max(previous[j], current[j - 1]);
                }
            }
            int[] temp = previous;
            previous = current;
            current = temp;
            java.util.Arrays.fill(current, 0);
        }
        return previous[newLen];
    }

    private record PatchResult(String content, boolean truncated) {
    }

    public record LineDelta(int linesAdded, int linesDeleted) {
    }
}
