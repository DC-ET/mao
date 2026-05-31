package com.agentworkbench.config;

import com.agentworkbench.auth.service.JwtService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.util.StringUtils;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Collections;

@Slf4j
@RequiredArgsConstructor
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private final JwtService jwtService;

    @Override
    protected boolean shouldNotFilterAsyncDispatch() {
        // Must run during async dispatch (WebSocket) to re-populate SecurityContext
        return false;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        try {
            String token = resolveToken(request);

            if (StringUtils.hasText(token)) {
                boolean valid = jwtService.validateToken(token);
                if (valid) {
                    Long userId = jwtService.getUserIdFromToken(token);

                    UsernamePasswordAuthenticationToken authentication =
                        new UsernamePasswordAuthenticationToken(
                            userId,
                            null,
                            Collections.singletonList(new SimpleGrantedAuthority("ROLE_USER"))
                        );
                    authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
                    SecurityContextHolder.getContext().setAuthentication(authentication);
                    log.debug("JWT authentication set for userId={} uri={}", userId, request.getRequestURI());
                } else {
                    log.warn("JWT token validation failed for request: {} {}", request.getMethod(), request.getRequestURI());
                }
            } else {
                log.debug("No JWT token found for request: {} {}", request.getMethod(), request.getRequestURI());
            }
        } catch (Exception e) {
            log.error("JwtAuthenticationFilter error for {} {}: {}", request.getMethod(), request.getRequestURI(), e.getMessage(), e);
        }

        filterChain.doFilter(request, response);
    }

    private String resolveToken(HttpServletRequest request) {
        // 1. Check Authorization header
        String bearerToken = request.getHeader("Authorization");
        if (StringUtils.hasText(bearerToken) && bearerToken.startsWith("Bearer ")) {
            return bearerToken.substring(7);
        }

        // 2. Fallback: extract token from query string manually
        //    (WebSocket cannot set custom headers)
        String queryString = request.getQueryString();
        if (queryString != null) {
            return extractQueryParam(queryString, "token");
        }
        return null;
    }

    /**
     * Manually extract a query parameter value from the raw query string.
     */
    private String extractQueryParam(String queryString, String paramName) {
        String prefix = paramName + "=";
        for (String param : queryString.split("&")) {
            if (param.startsWith(prefix)) {
                return param.substring(prefix.length());
            }
        }
        return null;
    }
}
