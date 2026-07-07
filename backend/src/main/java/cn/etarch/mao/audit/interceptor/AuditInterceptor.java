package cn.etarch.mao.audit.interceptor;

import cn.etarch.mao.audit.entity.AuditLog;
import cn.etarch.mao.audit.service.AuditLogService;
import cn.etarch.mao.user.entity.User;
import cn.etarch.mao.user.mapper.UserMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.util.Set;

@Component
@RequiredArgsConstructor
public class AuditInterceptor implements HandlerInterceptor {

    private static final int MAX_QUERY_LENGTH = 1024;
    private static final int MAX_ERROR_LENGTH = 1024;
    private static final Set<String> AUDITED_PREFIXES = Set.of(
            "/v1/agents",
            "/v1/models",
            "/v1/users",
            "/v1/roles",
            "/v1/permissions",
            "/v1/skill-docs",
            "/v1/admin",
            "/v1/system-settings",
            "/v1/notifications"
    );

    private final AuditLogService auditLogService;
    private final UserMapper userMapper;

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) {
        String path = request.getRequestURI();
        String contextPath = request.getContextPath();
        if (contextPath != null && !contextPath.isBlank() && path.startsWith(contextPath)) {
            path = path.substring(contextPath.length());
        }
        if (!shouldAudit(path)) {
            return;
        }

        AuditLog log = new AuditLog();
        log.setMethod(request.getMethod());
        log.setPath(path);
        log.setQueryString(truncate(request.getQueryString(), MAX_QUERY_LENGTH));
        log.setIp(resolveIp(request));
        log.setStatus(response.getStatus());
        log.setSuccess(ex == null && response.getStatus() < 400 ? 1 : 0);
        log.setErrorMessage(ex != null ? truncate(ex.getMessage(), MAX_ERROR_LENGTH) : null);
        log.setAction(resolveAction(request.getMethod()));
        log.setObjectType(resolveObjectType(path));
        log.setObjectId(resolveObjectId(path));

        Object principal = SecurityContextHolder.getContext().getAuthentication() != null
                ? SecurityContextHolder.getContext().getAuthentication().getPrincipal()
                : null;
        if (principal instanceof Long userId) {
            log.setUserId(userId);
            User user = userMapper.selectById(userId);
            if (user != null) {
                log.setUsername(user.getUsername());
            }
        }

        try {
            auditLogService.record(log);
        } catch (Exception ignored) {
            // Audit must never break the business request.
        }
    }

    private boolean shouldAudit(String path) {
        if (path == null || path.startsWith("/v1/auth") || path.startsWith("/v1/audit/logs")) {
            return false;
        }
        return AUDITED_PREFIXES.stream().anyMatch(path::startsWith);
    }

    private String resolveAction(String method) {
        return switch (method) {
            case "POST" -> "CREATE";
            case "PUT", "PATCH" -> "UPDATE";
            case "DELETE" -> "DELETE";
            case "GET" -> "READ";
            default -> "EXECUTE";
        };
    }

    private String resolveObjectType(String path) {
        if (path == null) return "unknown";
        String[] parts = path.split("/");
        if (parts.length >= 3) {
            if ("admin".equals(parts[2]) && parts.length >= 4) {
                return "admin." + parts[3];
            }
            return parts[2];
        }
        return "unknown";
    }

    private String resolveObjectId(String path) {
        if (path == null) return null;
        String[] parts = path.split("/");
        for (int i = 3; i < parts.length; i++) {
            if (parts[i].matches("\\d+")) {
                return parts[i];
            }
        }
        return null;
    }

    private String resolveIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        String realIp = request.getHeader("X-Real-IP");
        return realIp != null && !realIp.isBlank() ? realIp : request.getRemoteAddr();
    }

    private String truncate(String value, int max) {
        if (value == null || value.length() <= max) {
            return value;
        }
        return value.substring(0, max);
    }
}
