package com.agentworkbench.session.util;

public class TitleGenerator {

    private static final int MAX_TITLE_LENGTH = 50;

    public static String generate(String userMessage) {
        if (userMessage == null || userMessage.isBlank()) {
            return null;
        }

        String trimmed = userMessage.trim();

        // Shell command detection: starts with common commands
        if (isShellCommand(trimmed)) {
            return generateFromCommand(trimmed);
        }

        // Natural language: use as-is, truncated
        return truncate(trimmed, MAX_TITLE_LENGTH);
    }

    private static boolean isShellCommand(String text) {
        // Single line, starts with a common CLI command, or contains pipes/redirection
        String firstToken = text.split("\\s+")[0].toLowerCase();
        String[] shellCommands = {
            "ls", "cd", "cat", "grep", "find", "rm", "cp", "mv", "mkdir",
            "touch", "chmod", "chown", "echo", "pwd", "whoami", "curl",
            "wget", "git", "npm", "yarn", "pnpm", "node", "python", "pip",
            "java", "mvn", "gradle", "docker", "kubectl", "make", "cargo",
            "go", "rustc", "gcc", "g++", "ssh", "scp", "rsync", "tar",
            "unzip", "zip", "sed", "awk", "sort", "uniq", "wc", "head",
            "tail", "diff", "patch", "ps", "top", "kill", "df", "du",
            "free", "uname", "man", "which", "whereis", "brew", "apt",
            "yum", "systemctl", "journalctl"
        };
        for (String cmd : shellCommands) {
            if (firstToken.equals(cmd)) return true;
        }
        // Contains pipe or redirect
        if (text.matches("^[a-z].*[|>].*")) return true;
        // Very short and looks like a command (no spaces or few, no Chinese)
        if (text.length() < 30 && !text.contains("。") && !text.contains("，")
                && text.matches("^[a-zA-Z/\\.].*")) {
            return true;
        }
        return false;
    }

    private static String generateFromCommand(String command) {
        String firstToken = command.split("\\s+")[0].toLowerCase();
        String target = extractTarget(command);

        return switch (firstToken) {
            case "ls" -> "查看目录" + (target.isEmpty() ? "" : " " + truncatePath(target));
            case "cat", "head", "tail", "less" -> "查看文件 " + truncatePath(target);
            case "grep", "find" -> "搜索 " + truncatePath(target);
            case "cd" -> "切换到 " + truncatePath(target);
            case "rm" -> "删除 " + truncatePath(target);
            case "cp" -> "复制文件";
            case "mv" -> "移动文件";
            case "mkdir" -> "创建目录 " + truncatePath(target);
            case "touch" -> "创建文件 " + truncatePath(target);
            case "git" -> generateGitTitle(command);
            case "npm", "yarn", "pnpm" -> generatePackageManagerTitle(firstToken, command);
            case "docker" -> "Docker: " + (target.isEmpty() ? command : target);
            case "curl", "wget" -> "请求 " + truncatePath(target);
            case "python", "node", "java" -> "运行 " + firstToken + " 脚本";
            case "mvn", "gradle" -> "构建项目";
            default -> "执行命令: " + truncate(firstToken + (target.isEmpty() ? "" : " " + target), MAX_TITLE_LENGTH);
        };
    }

    private static String generateGitTitle(String command) {
        String[] parts = command.split("\\s+");
        if (parts.length < 2) return "Git 操作";
        String sub = parts[1].toLowerCase();
        return switch (sub) {
            case "status" -> "查看 Git 状态";
            case "log" -> "查看 Git 日志";
            case "diff" -> "查看文件变更";
            case "add" -> "暂存文件";
            case "commit" -> "提交变更";
            case "push" -> "推送代码";
            case "pull" -> "拉取代码";
            case "checkout", "switch" -> "切换分支";
            case "branch" -> "查看分支";
            case "merge" -> "合并分支";
            case "clone" -> "克隆仓库";
            case "stash" -> "暂存工作区";
            default -> "Git " + sub;
        };
    }

    private static String generatePackageManagerTitle(String pm, String command) {
        String[] parts = command.split("\\s+");
        if (parts.length < 2) return pm + " 操作";
        String sub = parts[1].toLowerCase();
        return switch (sub) {
            case "install", "i" -> "安装依赖";
            case "run" -> parts.length > 2 ? "运行 " + parts[2] : "运行脚本";
            case "build" -> "构建项目";
            case "test" -> "运行测试";
            case "start" -> "启动服务";
            case "init" -> "初始化项目";
            default -> pm + " " + sub;
        };
    }

    private static String extractTarget(String command) {
        String[] parts = command.split("\\s+");
        // Return first non-flag argument after the command
        for (int i = 1; i < parts.length; i++) {
            if (!parts[i].startsWith("-")) {
                return parts[i];
            }
        }
        return "";
    }

    private static String truncatePath(String path) {
        if (path == null || path.isEmpty()) return "";
        // Show only the last 2 segments for deep paths
        if (path.length() > 30) {
            String[] segments = path.split("/");
            if (segments.length > 2) {
                return ".../" + segments[segments.length - 2] + "/" + segments[segments.length - 1];
            }
        }
        return path;
    }

    private static String truncate(String text, int maxLength) {
        if (text == null) return "";
        if (text.length() <= maxLength) return text;
        return text.substring(0, maxLength) + "...";
    }
}
