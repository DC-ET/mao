package cn.etarch.mao.audit.controller;

import cn.etarch.mao.audit.entity.AuditLog;
import cn.etarch.mao.audit.service.AuditLogService;
import cn.etarch.mao.common.result.Result;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.util.Map;

@RestController
@RequestMapping("/v1/audit/logs")
@RequiredArgsConstructor
public class AuditLogController {

    private final AuditLogService auditLogService;

    @GetMapping
    public Result<Map<String, Object>> list(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) Long userId,
            @RequestParam(required = false) String action,
            @RequestParam(required = false) String objectType,
            @RequestParam(required = false) Boolean success,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate startDate,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate endDate) {
        Page<AuditLog> pageResult = auditLogService.list(page, size, userId, action, objectType, success, startDate, endDate);
        return Result.ok(Map.of(
                "records", pageResult.getRecords(),
                "total", pageResult.getTotal(),
                "page", pageResult.getCurrent(),
                "size", pageResult.getSize()));
    }

    @GetMapping("/{id}")
    public Result<AuditLog> get(@PathVariable Long id) {
        return Result.ok(auditLogService.get(id));
    }
}
