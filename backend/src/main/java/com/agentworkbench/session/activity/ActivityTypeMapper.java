package com.agentworkbench.session.activity;

public class ActivityTypeMapper {

    public static String mapToolToType(String toolName) {
        if (toolName == null) return "TOOL";
        return switch (toolName.toLowerCase()) {
            case "read_file" -> "READ";
            case "write_file", "edit_file" -> "EDIT";
            case "bash" -> "RUN";
            case "glob", "list" -> "EXPLORE";
            case "todo" -> "TOOL";
            case "subagent" -> "TOOL";
            default -> "TOOL";
        };
    }
}
