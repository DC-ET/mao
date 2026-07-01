package com.agentworkbench.harness.safety;

import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Validates cloud project slugs and asserts workspace paths stay within the user sandbox.
 */
public final class CloudWorkspaceResolver {

    private static final Pattern SLUG_PATTERN =
            Pattern.compile("^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$");

    private static final Set<String> RESERVED = Set.of("projects", "sessions");

    private CloudWorkspaceResolver() {
    }

    public static String normalizeAndValidate(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "项目名称不能为空");
        }
        String slug = raw.trim();
        if (".".equals(slug) || "..".equals(slug)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "项目名称非法");
        }
        if (!SLUG_PATTERN.matcher(slug).matches()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "项目名称仅允许字母、数字、下划线和连字符，长度 1-64，且必须以字母或数字开头");
        }
        if (RESERVED.contains(slug.toLowerCase())) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "项目名称不能使用保留字: " + slug);
        }
        return slug;
    }

    public static void assertUnderUserSandbox(PathSandbox sandbox, Long userId, String workspace) {
        Path expectedPrefix = sandbox.getWorkspaceRoot().resolve(String.valueOf(userId));
        Path resolved = Paths.get(workspace).toAbsolutePath().normalize();
        if (!resolved.startsWith(expectedPrefix)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "工作区路径非法");
        }
    }

    public static String resolveProjectWorkspace(PathSandbox sandbox, Long userId, String slug) {
        Path path = sandbox.getWorkspaceRoot()
                .resolve(String.valueOf(userId))
                .resolve("projects")
                .resolve(slug);
        assertUnderUserSandbox(sandbox, userId, path.toString());
        return path.toString();
    }
}
