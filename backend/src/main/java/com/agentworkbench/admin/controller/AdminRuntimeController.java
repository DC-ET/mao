package com.agentworkbench.admin.controller;

import com.agentworkbench.common.result.Result;
import com.agentworkbench.session.controller.AdminSessionController;
import com.agentworkbench.session.service.SessionService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/v1/admin/runtime")
@RequiredArgsConstructor
public class AdminRuntimeController {

    private final AdminSessionController adminSessionController;

    @GetMapping("/sessions")
    public Result<Map<String, Object>> listRuntimeSessions(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) Long userId,
            @RequestParam(required = false) Long agentId,
            @RequestParam(required = false) String executionMode,
            @RequestParam(required = false) String phase,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String status) {
        String runtimePhase = (phase == null || phase.isBlank())
                ? "RUNNING,RESUMING,WAITING_APPROVAL,FAILED,CANCELLED"
                : phase;
        return adminSessionController.listSessions(
                page, size, userId, agentId, executionMode, runtimePhase, keyword, status);
    }

    @GetMapping("/stale-threshold")
    public Result<Map<String, Object>> staleThreshold() {
        return Result.ok(Map.of("staleMinutes", SessionService.getStaleMinutes()));
    }
}
