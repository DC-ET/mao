package cn.etarch.mao.session.util;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.harness.safety.CloudWorkspaceResolver;

import java.net.URI;
import java.net.URISyntaxException;

/**
 * Parses and validates Git repository URLs.
 * Only HTTPS ({@code https://host/user/repo.git}) is supported for workspace initialization.
 */
public final class GitUrlParser {

    private GitUrlParser() {
    }

    /**
     * Validate git URL format. Accepts HTTPS only.
     */
    public static void validate(String url) {
        if (url == null || url.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Git URL 不能为空");
        }
        String trimmed = url.trim();
        if (trimmed.startsWith("git@")) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "不支持 SSH 地址，请使用 HTTPS 格式，如 https://git.example.com/xx/xxx.git");
        }
        if (trimmed.startsWith("http://")) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "不支持 HTTP 明文地址，请使用 HTTPS");
        }
        if (!trimmed.startsWith("https://")) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "不支持的协议，仅支持 HTTPS，示例: https://github.com/user/repo.git");
        }
        if (!trimmed.matches("^https://[^\\s/]+(/[^\\s]+)+")) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "Git URL 格式无效，示例: https://github.com/user/repo.git");
        }
    }

    /**
     * Extract repository name from a Git URL.
     * <pre>
     * https://github.com/user/my-repo.git → my-repo
     * https://github.com/user/my-repo      → my-repo
     * </pre>
     */
    public static String extractSlug(String url) {
        validate(url);

        String path;
        try {
            URI uri = new URI(url.trim());
            path = uri.getPath();
        } catch (URISyntaxException e) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Git URL 格式无效");
        }

        if (path == null || path.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "无法从 Git URL 提取仓库名");
        }

        if (path.startsWith("/")) {
            path = path.substring(1);
        }
        if (path.endsWith(".git")) {
            path = path.substring(0, path.length() - 4);
        }

        int lastSlash = path.lastIndexOf('/');
        String name = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;

        if (name.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "无法从 Git URL 提取仓库名");
        }

        return CloudWorkspaceResolver.normalizeAndValidate(name);
    }

    /**
     * Extract host from a Git URL.
     * <pre>
     * https://github.com/user/repo.git → github.com
     * </pre>
     */
    public static String extractHost(String url) {
        validate(url);
        try {
            String host = new URI(url.trim()).getHost();
            if (host == null || host.isBlank()) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "Git URL 格式无效");
            }
            return host;
        } catch (URISyntaxException e) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Git URL 格式无效");
        }
    }
}
