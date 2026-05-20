package com.agentworkbench.audit.service;

import com.agentworkbench.audit.entity.ApiCallLog;
import com.agentworkbench.audit.entity.AuditLog;
import com.agentworkbench.audit.mapper.ApiCallLogMapper;
import com.agentworkbench.audit.mapper.AuditLogMapper;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;

@Service
@RequiredArgsConstructor
public class AuditService {

    private final AuditLogMapper auditLogMapper;
    private final ApiCallLogMapper apiCallLogMapper;
    private final UserMapper userMapper;

    public void saveAuditLog(Long userId, String action, String resourceType,
                             String resourceId, String detail, String ip, String userAgent) {
        AuditLog log = new AuditLog();
        log.setUserId(userId);
        if (userId != null) {
            User user = userMapper.selectById(userId);
            if (user != null) {
                log.setUsername(user.getUsername());
            }
        }
        log.setAction(action);
        log.setResourceType(resourceType);
        log.setResourceId(resourceId);
        log.setDetail(detail);
        log.setIp(ip);
        log.setUserAgent(userAgent);
        auditLogMapper.insert(log);
    }

    public void saveApiCallLog(Long userId, Long sessionId, Long agentId,
                               String endpoint, String method, String requestBody,
                               Integer responseCode, Integer latencyMs) {
        ApiCallLog log = new ApiCallLog();
        log.setUserId(userId);
        log.setSessionId(sessionId);
        log.setAgentId(agentId);
        log.setEndpoint(endpoint);
        log.setMethod(method);
        log.setRequestBody(requestBody);
        log.setResponseCode(responseCode);
        log.setLatencyMs(latencyMs);
        apiCallLogMapper.insert(log);
    }

    public Page<AuditLog> listAuditLogs(int page, int size, Long userId,
                                         String action, String startDate, String endDate) {
        QueryWrapper<AuditLog> qw = new QueryWrapper<>();
        if (userId != null) {
            qw.eq("user_id", userId);
        }
        if (action != null && !action.isEmpty()) {
            qw.eq("action", action);
        }
        if (startDate != null && !startDate.isEmpty()) {
            qw.ge("created_at", startDate);
        }
        if (endDate != null && !endDate.isEmpty()) {
            qw.le("created_at", endDate);
        }
        qw.orderByDesc("created_at");
        return auditLogMapper.selectPage(new Page<>(page, size), qw);
    }

    public AuditLog getAuditLog(Long id) {
        return auditLogMapper.selectById(id);
    }

    public Page<ApiCallLog> listApiCallLogs(int page, int size, Long userId,
                                             String endpoint, String startDate, String endDate) {
        QueryWrapper<ApiCallLog> qw = new QueryWrapper<>();
        if (userId != null) {
            qw.eq("user_id", userId);
        }
        if (endpoint != null && !endpoint.isEmpty()) {
            qw.like("endpoint", endpoint);
        }
        if (startDate != null && !startDate.isEmpty()) {
            qw.ge("created_at", startDate);
        }
        if (endDate != null && !endDate.isEmpty()) {
            qw.le("created_at", endDate);
        }
        qw.orderByDesc("created_at");
        return apiCallLogMapper.selectPage(new Page<>(page, size), qw);
    }

    public List<AuditLog> exportAuditLogs(Long userId, String action,
                                           String startDate, String endDate) {
        QueryWrapper<AuditLog> qw = new QueryWrapper<>();
        if (userId != null) {
            qw.eq("user_id", userId);
        }
        if (action != null && !action.isEmpty()) {
            qw.eq("action", action);
        }
        if (startDate != null && !startDate.isEmpty()) {
            qw.ge("created_at", startDate);
        }
        if (endDate != null && !endDate.isEmpty()) {
            qw.le("created_at", endDate);
        }
        qw.orderByDesc("created_at");
        return auditLogMapper.selectList(qw);
    }
}
