package com.agentworkbench.session.util;

/**
 * Converts raw git / ssh-keyscan output into user-facing Chinese messages.
 */
public final class GitCloneErrorFormatter {

    private GitCloneErrorFormatter() {
    }

    public static String toUserMessage(String rawError) {
        if (rawError == null || rawError.isBlank()) {
            return "Git 仓库克隆失败，请稍后重试";
        }

        String normalized = rawError.replace("\r\n", "\n").trim();
        String lower = normalized.toLowerCase();

        if (lower.startsWith("git clone timeout") || lower.contains("clone timeout")) {
            return "克隆仓库超时，请检查网络连接或稍后重试";
        }
        if (lower.contains("repository not found") || lower.contains("project not found")) {
            return "仓库不存在或无权访问。请确认 HTTPS 地址正确；私有仓库需在「设置 → Git 凭证」配置对应域名的 Token。";
        }
        if (lower.contains("authentication failed")
                || lower.contains("invalid username or password")
                || lower.contains("could not read username")
                || lower.contains("access rights")
                || lower.contains("permission denied (publickey)")
                || lower.contains("permission denied (password")
                || lower.contains("http basic: access denied")) {
            return "Git 认证失败。请在「设置 → Git 凭证」配置对应域名的 Access Token。";
        }
        if (lower.contains("could not resolve host") || lower.contains("name or service not known")) {
            return "无法解析 Git 服务器地址，请检查仓库 URL 是否正确";
        }
        if (lower.contains("remote branch") && lower.contains("not found")
                || lower.contains("could not find remote branch")) {
            return "指定的分支不存在，请检查分支名称或留空使用默认分支";
        }
        if (lower.contains("unable to access") || lower.contains("the requested url returned error: 403")) {
            return "无法访问该仓库，请确认地址正确且已配置访问凭证";
        }
        if (lower.contains("already exists and is not an empty directory")) {
            return "目标工作区目录已存在且非空，请更换仓库名或清理已有工作区后重试";
        }
        if (lower.contains("git clone interrupted")) {
            return "仓库克隆已中断，请重试";
        }
        if (lower.startsWith("git clone error:")) {
            return "克隆仓库时发生错误，请稍后重试";
        }

        String hint = extractHint(normalized);
        if (!hint.isBlank()) {
            return "Git 仓库克隆失败：" + hint;
        }
        return "Git 仓库克隆失败，请检查仓库地址与访问凭证后重试";
    }

    private static String extractHint(String output) {
        String[] lines = output.split("\n");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = sanitizeLine(lines[i].trim());
            if (line.isBlank()) {
                continue;
            }
            String lower = line.toLowerCase();
            if (lower.startsWith("fatal:")
                    || lower.startsWith("error:")
                    || lower.contains("remote:")
                    || lower.startsWith("warning:")) {
                return line;
            }
        }
        return sanitizeLine(output);
    }

    private static String sanitizeLine(String line) {
        if (line.isBlank()) {
            return "";
        }
        String cleaned = line
                .replaceFirst("(?i)^git clone failed:\\s*", "")
                .replaceFirst("(?i)^Cloning into '[^']*'\\.\\.\\.\\s*", "")
                .replaceAll("/data/workbench/workspace/\\d+/projects/[^\\s']+", "工作区")
                .replaceAll("https://oauth2:[^@]+@", "https://oauth2:***@");
        if (cleaned.length() > 160) {
            cleaned = cleaned.substring(0, 157) + "...";
        }
        return cleaned.trim();
    }
}
