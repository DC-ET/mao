package com.agentworkbench.session.util;

import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.harness.safety.CloudWorkspaceResolver;

import java.net.URI;
import java.net.URISyntaxException;

/**
 * Parses and validates Git repository URLs.
 * Supports both HTTPS (https://host/user/repo.git) and SSH (git@host:user/repo.git) protocols.
 */
public final class GitUrlParser {

    private GitUrlParser() {
    }

    /**
     * Validate git URL format. Accepts HTTPS and SSH only.
     */
    public static void validate(String url) {
        if (url == null || url.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Git URL 不能为空");
        }
        if (url.startsWith("https://")) {
            if (!url.matches("^https://[^\\s/]+(/[^\\s]+)+")) {
                throw new BusinessException(ErrorCode.PARAM_INVALID,
                        "Git URL 格式无效，示例: https://github.com/user/repo.git");
            }
        } else if (url.startsWith("git@")) {
            if (!url.matches("^git@[^\\s:]+:[^\\s]+")) {
                throw new BusinessException(ErrorCode.PARAM_INVALID,
                        "SSH Git 地址格式无效，示例: git@github.com:user/repo.git");
            }
        } else {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "不支持的协议，仅支持 HTTPS 和 SSH");
        }
    }

    /**
     * Extract repository name from a Git URL.
     * <pre>
     * https://github.com/user/my-repo.git → my-repo
     * git@github.com:user/my-repo.git      → my-repo
     * https://github.com/user/my-repo      → my-repo
     * </pre>
     */
    public static String extractSlug(String url) {
        validate(url);

        String path;
        if (url.startsWith("https://")) {
            try {
                URI uri = new URI(url);
                path = uri.getPath();
            } catch (URISyntaxException e) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "Git URL 格式无效");
            }
        } else {
            // SSH format: git@host:path → extract path after ':'
            int colonIdx = url.indexOf(':');
            path = url.substring(colonIdx + 1);
        }

        if (path == null || path.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "无法从 Git URL 提取仓库名");
        }

        // Strip leading / and trailing .git
        if (path.startsWith("/")) {
            path = path.substring(1);
        }
        if (path.endsWith(".git")) {
            path = path.substring(0, path.length() - 4);
        }

        // Take last segment as repo name
        int lastSlash = path.lastIndexOf('/');
        String name = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;

        if (name.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "无法从 Git URL 提取仓库名");
        }

        return CloudWorkspaceResolver.normalizeAndValidate(name);
    }
}
