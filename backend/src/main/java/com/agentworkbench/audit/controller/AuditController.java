package com.agentworkbench.audit.controller;

import com.agentworkbench.audit.entity.ApiCallLog;
import com.agentworkbench.audit.entity.AuditLog;
import com.agentworkbench.audit.service.AuditService;
import com.agentworkbench.common.result.Result;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/v1/audit")
@RequiredArgsConstructor
public class AuditController {

    private final AuditService auditService;

    @GetMapping("/logs")
    public Result<Map<String, Object>> listLogs(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) Long userId,
            @RequestParam(required = false) String action,
            @RequestParam(required = false) String startDate,
            @RequestParam(required = false) String endDate) {
        Page<AuditLog> pageResult = auditService.listAuditLogs(page, size, userId, action, startDate, endDate);
        List<AuditLogVO> voList = pageResult.getRecords().stream()
                .map(this::toVO)
                .collect(Collectors.toList());
        return Result.ok(Map.of(
                "records", voList,
                "total", pageResult.getTotal(),
                "page", pageResult.getCurrent(),
                "size", pageResult.getSize()
        ));
    }

    @GetMapping("/logs/{id}")
    public Result<AuditLogVO> getLog(@PathVariable Long id) {
        AuditLog log = auditService.getAuditLog(id);
        if (log == null) {
            return Result.ok();
        }
        return Result.ok(toVO(log));
    }

    @GetMapping("/logs/export")
    public Result<List<AuditLogVO>> exportLogs(
            @RequestParam(required = false) Long userId,
            @RequestParam(required = false) String action,
            @RequestParam(required = false) String startDate,
            @RequestParam(required = false) String endDate) {
        List<AuditLog> logs = auditService.exportAuditLogs(userId, action, startDate, endDate);
        List<AuditLogVO> voList = logs.stream().map(this::toVO).collect(Collectors.toList());
        return Result.ok(voList);
    }

    @GetMapping("/api-calls")
    public Result<Map<String, Object>> listApiCalls(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) Long userId,
            @RequestParam(required = false) String endpoint,
            @RequestParam(required = false) String startDate,
            @RequestParam(required = false) String endDate) {
        Page<ApiCallLog> pageResult = auditService.listApiCallLogs(page, size, userId, endpoint, startDate, endDate);
        List<ApiCallLogVO> voList = pageResult.getRecords().stream()
                .map(this::toApiCallVO)
                .collect(Collectors.toList());
        return Result.ok(Map.of(
                "records", voList,
                "total", pageResult.getTotal(),
                "page", pageResult.getCurrent(),
                "size", pageResult.getSize()
        ));
    }

    private AuditLogVO toVO(AuditLog log) {
        AuditLogVO vo = new AuditLogVO();
        vo.setId(log.getId());
        vo.setUserId(log.getUserId());
        vo.setUsername(log.getUsername());
        vo.setAction(log.getAction());
        vo.setResourceType(log.getResourceType());
        vo.setResourceId(log.getResourceId());
        vo.setIp(log.getIp());
        vo.setCreatedAt(log.getCreatedAt() != null ? log.getCreatedAt().toString() : null);
        return vo;
    }

    private ApiCallLogVO toApiCallVO(ApiCallLog log) {
        ApiCallLogVO vo = new ApiCallLogVO();
        vo.setId(log.getId());
        vo.setUserId(log.getUserId());
        vo.setEndpoint(log.getEndpoint());
        vo.setMethod(log.getMethod());
        vo.setResponseCode(log.getResponseCode());
        vo.setLatencyMs(log.getLatencyMs());
        vo.setCreatedAt(log.getCreatedAt() != null ? log.getCreatedAt().toString() : null);
        return vo;
    }

    @Data
    public static class AuditLogVO {
        private Long id;
        private Long userId;
        private String username;
        private String action;
        private String resourceType;
        private String resourceId;
        private String ip;
        private String createdAt;
    }

    @Data
    public static class ApiCallLogVO {
        private Long id;
        private Long userId;
        private String endpoint;
        private String method;
        private Integer responseCode;
        private Integer latencyMs;
        private String createdAt;
    }
}
