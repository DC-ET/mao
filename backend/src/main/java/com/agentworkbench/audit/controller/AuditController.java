package com.agentworkbench.audit.controller;

import com.agentworkbench.common.result.Result;
import lombok.Data;
import org.springframework.web.bind.annotation.*;

import java.util.Collections;
import java.util.List;

@RestController
@RequestMapping("/v1/audit")
public class AuditController {

    @GetMapping("/logs")
    public Result<List<AuditLogVO>> listLogs(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        return Result.ok(Collections.emptyList());
    }

    @GetMapping("/logs/{id}")
    public Result<AuditLogVO> getLog(@PathVariable Long id) {
        return Result.ok();
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
}
