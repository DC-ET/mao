package com.agentworkbench.audit.interceptor;

import com.agentworkbench.audit.service.AuditService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

@Slf4j
@Component
@RequiredArgsConstructor
public class AuditInterceptor implements HandlerInterceptor {

    private static final ThreadLocal<Long> START_TIME = new ThreadLocal<>();

    private final AuditService auditService;

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return true;
        }
        START_TIME.set(System.currentTimeMillis());
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                Object handler, Exception ex) {
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return;
        }
        try {
            long latency = System.currentTimeMillis() - START_TIME.get();
            Authentication auth = SecurityContextHolder.getContext().getAuthentication();
            Long userId = null;
            if (auth != null && auth.getPrincipal() instanceof Long) {
                userId = (Long) auth.getPrincipal();
            }

            String uri = request.getRequestURI();
            auditService.saveApiCallLog(
                    userId, null, null,
                    uri, request.getMethod(), null,
                    response.getStatus(), (int) latency);

            log.debug("API Audit: userId={}, method={}, uri={}, status={}, latency={}ms",
                    userId, request.getMethod(), uri, response.getStatus(), latency);
        } catch (Exception e) {
            log.warn("Failed to persist audit log", e);
        } finally {
            START_TIME.remove();
        }
    }
}
