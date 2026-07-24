package cn.etarch.mao.session.util;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.List;

public class ToolResultSummarizer {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    public static String summarize(String toolName, String arguments, String result) {
        if (toolName == null) return null;
        return switch (toolName.toLowerCase()) {
            case "shell" -> summarizeShell(arguments, result);
            case "read_file" -> summarizeReadFile(arguments, result);
            case "write_file" -> summarizeWriteFile(arguments, result);
            case "edit_file" -> summarizeEditFile(arguments, result);
            case "glob_search" -> summarizeGlobSearch(arguments, result);
            case "grep_search" -> summarizeGrepSearch(arguments, result);
            case "task_create" -> summarizeTaskCreate(result);
            case "task_update" -> summarizeTaskUpdate(result);
            case "task_list" -> summarizeTaskList(result);
            case "task_delete" -> summarizeTaskDelete(result);
            case "ask_user_questions" -> summarizeAskUserQuestions(arguments, result);
            case "delegate" -> summarizeGeneric("委派子代理", result);
            case "web_search" -> summarizeWebSearch(arguments, result);
            case "open_web_page" -> summarizeOpenWebPage(arguments, result);

            default -> summarizeGeneric(toolName, result);
        };
    }

    private static String summarizeShell(String arguments, String result) {
        String command = extractJsonString(arguments, "command");
        String action = extractJsonString(arguments, "action");
        String cmdShort = command != null ? truncate(command, 50) : null;

        if ("write_stdin".equals(action)) {
            String input = extractJsonString(arguments, "input");
            return "写入 stdin" + (input != null ? ": " + truncate(input, 30) : "");
        }
        if ("close".equals(action)) return "关闭 Shell 会话";
        if ("list".equals(action)) return "列出 Shell 会话";

        String label = cmdShort != null ? "执行 " + cmdShort : "Shell 命令";
        if (result == null) return label;

        JsonNode node = parseJson(result);
        if (node == null) return label;

        if (node.has("async") && node.get("async").asBoolean()) {
            return label + " (后台)";
        }

        int exitCode = node.has("exit_code") ? node.get("exit_code").asInt(-1) : -1;
        String output = node.has("output") ? node.get("output").asText("") : "";

        if (exitCode != 0) {
            return label + " (exit " + exitCode + ")";
        }

        int lineCount = output.isEmpty() ? 0 : output.split("\n").length;
        if (lineCount > 1) {
            return label + " (" + lineCount + " 行输出)";
        }
        return label;
    }

    private static String summarizeReadFile(String arguments, String result) {
        String path = extractFilePath(arguments);
        String displayPath = path != null ? truncateFilename(path) : "文件";

        if (result == null) return "读取 " + displayPath;

        JsonNode node = parseJson(result);
        if (node == null) return "读取 " + displayPath;

        int totalLines = node.has("total_lines") ? node.get("total_lines").asInt(0) : 0;
        if ("image".equals(node.path("media_type").asText(null))) {
            int width = node.has("width") ? node.get("width").asInt(0) : 0;
            int height = node.has("height") ? node.get("height").asInt(0) : 0;
            if (width > 0 && height > 0) {
                return "读取 " + displayPath + " (图片, " + width + "×" + height + ")";
            }
            return "读取 " + displayPath + " (图片)";
        }

        // 从 arguments 中提取 offset 和 limit
        Integer offset = extractJsonInteger(arguments, "offset");
        Integer limit = extractJsonInteger(arguments, "limit");

        // 如果指定了 offset 或 limit，显示实际读取的行范围
        if (offset != null || limit != null) {
            int startLine = offset != null ? offset : 0;
            int readCount = limit != null ? limit : totalLines;
            int endLine = startLine + readCount;
            // 不超过文件总行数
            if (totalLines > 0 && endLine > totalLines) {
                endLine = totalLines;
            }
            return "读取 " + displayPath + " (" + startLine + "~" + endLine + "行)";
        }

        if (totalLines > 0) {
            return "读取 " + displayPath + " (" + totalLines + " 行)";
        }
        return "读取 " + displayPath;
    }

    private static String summarizeWriteFile(String arguments, String result) {
        String path = extractJsonString(arguments, "path");
        String displayPath = path != null ? truncateFilename(path) : "文件";

        if (result == null) return "写入 " + displayPath;

        JsonNode node = parseJson(result);
        if (node == null) return "写入 " + displayPath;

        // 优先显示行数（嵌套在 file_change 对象中）
        JsonNode fileChange = node.path("file_change");
        int totalLines = fileChange.has("total_lines") ? fileChange.get("total_lines").asInt(0) : 0;
        int linesAdded = fileChange.has("lines_added") ? fileChange.get("lines_added").asInt(0) : 0;
        int linesDeleted = fileChange.has("lines_deleted") ? fileChange.get("lines_deleted").asInt(0) : 0;
        // 新建文件：显示总行数；修改文件：显示行增减
        if ("CREATED".equals(fileChange.path("type").asText(null)) && totalLines > 0) {
            return "写入 " + displayPath + " (" + totalLines + " 行)";
        }
        if (linesAdded > 0 || linesDeleted > 0) {
            return "写入 " + displayPath + " (+" + linesAdded + "行 -" + linesDeleted + "行)";
        }
        if (totalLines > 0) {
            return "写入 " + displayPath + " (" + totalLines + " 行)";
        }
        return "写入 " + displayPath;
    }

    private static String summarizeEditFile(String arguments, String result) {
        String path = extractJsonString(arguments, "path");
        String displayPath = path != null ? truncateFilename(path) : "文件";

        if (result == null) return "编辑 " + displayPath;

        JsonNode node = parseJson(result);
        if (node == null) return "编辑 " + displayPath;

        // lines_added/lines_deleted 嵌套在 file_change 对象中
        JsonNode fileChange = node.path("file_change");
        int linesAdded = fileChange.has("lines_added") ? fileChange.get("lines_added").asInt(0) : 0;
        int linesDeleted = fileChange.has("lines_deleted") ? fileChange.get("lines_deleted").asInt(0) : 0;
        if (linesAdded > 0 || linesDeleted > 0) {
            return "编辑 " + displayPath + " (+" + linesAdded + "行 -" + linesDeleted + "行)";
        }
        return "编辑 " + displayPath;
    }

    private static String summarizeGlobSearch(String arguments, String result) {
        if (result == null) return "搜索文件";

        JsonNode node = parseJson(result);
        if (node == null) return "搜索文件";

        int count = node.has("files") && node.get("files").isArray() ? node.get("files").size() : 0;
        boolean truncated = node.has("truncated") && node.get("truncated").asBoolean();
        return "搜索文件 (" + count + " 个文件" + (truncated ? ", 已截断" : "") + ")";
    }

    private static String summarizeGrepSearch(String arguments, String result) {
        if (result == null) return "搜索内容";

        JsonNode node = parseJson(result);
        if (node == null) return "搜索内容";

        int count = node.has("total_matches") ? node.get("total_matches").asInt() : 0;
        boolean truncated = node.has("truncated") && node.get("truncated").asBoolean();
        return "搜索内容 (" + count + " 处匹配" + (truncated ? ", 已截断" : "") + ")";
    }

    private static String summarizeTaskCreate(String result) {
        if (result == null) return "创建任务";

        JsonNode node = parseJson(result);
        if (node == null) return "创建任务";

        if (node.has("message")) {
            return node.get("message").asText("创建任务");
        }
        return "创建任务";
    }

    private static String summarizeTaskUpdate(String result) {
        if (result == null) return "更新任务";

        JsonNode node = parseJson(result);
        if (node == null) return "更新任务";

        if (node.has("summary")) {
            return node.get("summary").asText("更新任务");
        }
        if (node.has("todos") && node.get("todos").isArray()) {
            return "更新任务 (" + node.get("todos").size() + " 项)";
        }
        return "更新任务";
    }

    private static String summarizeTaskList(String result) {
        if (result == null) return "查看任务列表";

        JsonNode node = parseJson(result);
        if (node == null) return "查看任务列表";

        if (node.has("progress")) {
            return "任务列表: " + node.get("progress").asText();
        }
        if (node.has("todos") && node.get("todos").isArray()) {
            return "任务列表 (" + node.get("todos").size() + " 项)";
        }
        return "查看任务列表";
    }

    private static String summarizeTaskDelete(String result) {
        if (result == null) return "删除任务";

        JsonNode node = parseJson(result);
        if (node == null) return "删除任务";

        if (node.has("message")) {
            return node.get("message").asText("删除任务");
        }
        return "删除任务";
    }


    private static String summarizeAskUserQuestions(String arguments, String result) {
        if (result == null) return "向用户提问";

        JsonNode node = parseJson(result);
        if (node == null) return "向用户提问";

        if (node.has("error")) {
            return "向用户提问 (超时或取消)";
        }
        if (node.has("answers") && node.get("answers").isArray()) {
            int count = node.get("answers").size();
            return "向用户提问 (" + count + " 个问题已回答)";
        }
        return "向用户提问";
    }

    private static String summarizeWebSearch(String arguments, String result) {
        String query = extractJsonString(arguments, "query");
        JsonNode node = parseJson(result);
        if (node == null) return "搜索 " + (query != null ? truncate(query, 30) : "");
        int count = node.has("total_results") ? node.get("total_results").asInt() : 0;
        return "搜索 " + truncate(query, 30) + " (" + count + " 条结果)";
    }

    private static String summarizeOpenWebPage(String arguments, String result) {
        String url = extractJsonString(arguments, "url");
        JsonNode node = parseJson(result);
        if (node == null) return "打开网页 " + (url != null ? formatUrl(url) : "");
        String title = node.has("title") ? node.get("title").asText("") : "";
        boolean truncated = node.has("truncated") && node.get("truncated").asBoolean();
        return "打开网页" + (!title.isEmpty() ? " " + truncate(title, 30) : "") +
               (truncated ? " (内容已截断)" : "");
    }

    private static String summarizeGeneric(String toolName, String result) {
        if (result == null) return toolName;

        JsonNode node = parseJson(result);
        if (node == null) return toolName;

        if (node.has("error")) {
            return toolName + " (错误)";
        }
        if (node.has("success") && node.get("success").asBoolean()) {
            return toolName + " (成功)";
        }
        return toolName;
    }

    // --- helpers ---

    private static String extractJsonString(String json, String field) {
        if (json == null) return null;
        try {
            JsonNode node = OBJECT_MAPPER.readTree(json);
            if (node.has(field)) {
                return node.get(field).asText(null);
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static Integer extractJsonInteger(String json, String field) {
        if (json == null) return null;
        try {
            JsonNode node = OBJECT_MAPPER.readTree(json);
            if (node.has(field) && node.get(field).canConvertToInt()) {
                return node.get(field).asInt();
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static String extractFilePath(String json) {
        if (json == null) return null;
        try {
            JsonNode node = OBJECT_MAPPER.readTree(json);
            for (String key : List.of("path", "file", "filePath", "file_path", "target_file")) {
                if (node.has(key)) {
                    String value = node.get(key).asText(null);
                    if (value != null && !value.isBlank()) {
                        return value;
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static JsonNode parseJson(String json) {
        if (json == null) return null;
        try {
            return OBJECT_MAPPER.readTree(json);
        } catch (Exception e) {
            return null;
        }
    }

    private static String truncateFilename(String path) {
        if (path == null) return "";
        String[] parts = path.replace("\\", "/").split("/");
        if (parts.length >= 2) {
            return parts[parts.length - 2] + "/" + parts[parts.length - 1];
        }
        return parts.length > 0 ? parts[parts.length - 1] : path;
    }

    private static String truncate(String text, int max) {
        if (text == null) return "";
        if (text.length() <= max) return text;
        return text.substring(0, max) + "...";
    }

    private static String formatUrl(String url) {
        if (url == null) return "";
        // Strip protocol and truncate
        String shortUrl = url.replaceFirst("^https?://", "");
        return truncate(shortUrl, 40);
    }
}
