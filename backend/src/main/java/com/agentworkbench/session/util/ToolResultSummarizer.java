package com.agentworkbench.session.util;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

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
            case "subagent" -> summarizeSubagent(result);
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
        String path = extractJsonString(arguments, "path");
        String displayPath = path != null ? truncateFilename(path) : "文件";

        if (result == null) return "读取 " + displayPath;

        JsonNode node = parseJson(result);
        if (node == null) return "读取 " + displayPath;

        int totalLines = node.has("total_lines") ? node.get("total_lines").asInt(0) : 0;
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

        int bytes = node.has("bytes_written") ? node.get("bytes_written").asInt(0) : 0;
        if (bytes > 0) {
            return "写入 " + displayPath + " (" + formatBytes(bytes) + ")";
        }
        return "写入 " + displayPath;
    }

    private static String summarizeEditFile(String arguments, String result) {
        String path = extractJsonString(arguments, "path");
        String displayPath = path != null ? truncateFilename(path) : "文件";

        if (result == null) return "编辑 " + displayPath;

        JsonNode node = parseJson(result);
        if (node == null) return "编辑 " + displayPath;

        int replacements = node.has("replacements") ? node.get("replacements").asInt(0) : 0;
        if (replacements > 0) {
            return "编辑 " + displayPath + " (" + replacements + " 处替换)";
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

    private static String summarizeSubagent(String result) {
        if (result == null) return "运行子任务";

        JsonNode node = parseJson(result);
        if (node == null) return "运行子任务";

        int rounds = node.has("rounds_used") ? node.get("rounds_used").asInt(0) : 0;
        if (rounds > 0) {
            return "子任务完成 (" + rounds + " 轮)";
        }
        return "子任务完成";
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

    private static String formatBytes(int bytes) {
        if (bytes < 1024) return bytes + "B";
        if (bytes < 1024 * 1024) return (bytes / 1024) + "KB";
        return String.format("%.1fMB", bytes / (1024.0 * 1024.0));
    }
}
