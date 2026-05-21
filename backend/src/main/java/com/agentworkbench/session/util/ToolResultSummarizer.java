package com.agentworkbench.session.util;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

public class ToolResultSummarizer {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    public static String summarize(String toolName, String arguments, String result) {
        if (toolName == null) return null;
        return switch (toolName.toLowerCase()) {
            case "bash" -> summarizeBash(arguments, result);
            case "read_file" -> summarizeReadFile(arguments, result);
            case "write_file" -> summarizeWriteFile(arguments, result);
            case "edit_file" -> summarizeEditFile(arguments, result);
            case "glob", "list" -> summarizeGlob(result);
            case "todo" -> summarizeTodo(result);
            case "subagent" -> summarizeSubagent(result);
            case "http_request" -> summarizeHttpRequest(result);
            case "load_skill" -> summarizeLoadSkill(arguments);
            default -> summarizeGeneric(toolName, result);
        };
    }

    private static String summarizeBash(String arguments, String result) {
        String command = extractJsonString(arguments, "command");
        String cmdShort = command != null ? truncate(command, 50) : "命令";

        if (result == null) return "执行 " + cmdShort;

        JsonNode node = parseJson(result);
        if (node == null) return "执行 " + cmdShort;

        int exitCode = node.has("exit_code") ? node.get("exit_code").asInt(-1) : -1;
        String output = node.has("output") ? node.get("output").asText("") : "";

        if (exitCode != 0) {
            return "执行 " + cmdShort + " (exit " + exitCode + ")";
        }

        int lineCount = output.isEmpty() ? 0 : output.split("\n").length;
        if (lineCount > 1) {
            return "执行 " + cmdShort + " (" + lineCount + " 行输出)";
        }
        return "执行 " + cmdShort;
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

    private static String summarizeGlob(String result) {
        if (result == null) return "搜索文件";

        JsonNode node = parseJson(result);
        if (node == null) return "搜索文件";

        if (node.isArray()) {
            return "找到 " + node.size() + " 个文件";
        }
        if (node.has("files") && node.get("files").isArray()) {
            return "找到 " + node.get("files").size() + " 个文件";
        }
        return "搜索文件";
    }

    private static String summarizeTodo(String result) {
        if (result == null) return "更新任务列表";

        JsonNode node = parseJson(result);
        if (node == null) return "更新任务列表";

        if (node.has("message")) {
            return node.get("message").asText("更新任务列表");
        }
        if (node.has("todos") && node.get("todos").isArray()) {
            return "任务列表 (" + node.get("todos").size() + " 项)";
        }
        return "更新任务列表";
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

    private static String summarizeHttpRequest(String result) {
        if (result == null) return "HTTP 请求";

        JsonNode node = parseJson(result);
        if (node == null) return "HTTP 请求";

        int status = node.has("status") ? node.get("status").asInt(0) : 0;
        if (status > 0) {
            return "HTTP " + status;
        }
        return "HTTP 请求";
    }

    private static String summarizeLoadSkill(String arguments) {
        String name = extractJsonString(arguments, "name");
        return name != null ? "加载技能: " + name : "加载技能";
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
