package cn.etarch.mao.session.activity;

public class ActivityTypeMapper {

    public static String mapToolToType(String toolName) {
        if (toolName == null) return "TOOL";
        return switch (toolName.toLowerCase()) {
            case "read_file" -> "READ";
            case "write_file", "edit_file" -> "EDIT";
            case "shell" -> "RUN";
            case "glob", "list" -> "EXPLORE";
            case "task_create", "task_update", "task_delete", "task_list" -> "TASK";

            default -> "TOOL";
        };
    }
}
