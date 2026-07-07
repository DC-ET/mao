package com.agentworkbench.audit.service;

import com.agentworkbench.audit.entity.AuditLog;
import com.agentworkbench.audit.mapper.AuditLogMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.LocalDate;
import java.time.LocalTime;

@Service
@RequiredArgsConstructor
public class AuditLogService {

    private final AuditLogMapper auditLogMapper;

    public void record(AuditLog log) {
        auditLogMapper.insert(log);
    }

    public Page<AuditLog> list(int page, int size, Long userId, String action, String objectType,
                               Boolean success, LocalDate startDate, LocalDate endDate) {
        LambdaQueryWrapper<AuditLog> qw = new LambdaQueryWrapper<>();
        if (userId != null) {
            qw.eq(AuditLog::getUserId, userId);
        }
        if (StringUtils.hasText(action)) {
            qw.eq(AuditLog::getAction, action);
        }
        if (StringUtils.hasText(objectType)) {
            qw.eq(AuditLog::getObjectType, objectType);
        }
        if (success != null) {
            qw.eq(AuditLog::getSuccess, success ? 1 : 0);
        }
        if (startDate != null) {
            qw.ge(AuditLog::getCreatedAt, startDate.atStartOfDay());
        }
        if (endDate != null) {
            qw.le(AuditLog::getCreatedAt, endDate.atTime(LocalTime.MAX));
        }
        qw.orderByDesc(AuditLog::getCreatedAt);
        return auditLogMapper.selectPage(Page.of(page, size), qw);
    }

    public AuditLog get(Long id) {
        AuditLog log = auditLogMapper.selectById(id);
        if (log == null) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "审计日志不存在");
        }
        return log;
    }
}
