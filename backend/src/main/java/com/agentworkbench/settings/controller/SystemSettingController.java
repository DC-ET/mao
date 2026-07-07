package com.agentworkbench.settings.controller;

import com.agentworkbench.common.result.Result;
import com.agentworkbench.settings.entity.SystemSetting;
import com.agentworkbench.settings.service.SystemSettingService;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/v1/system-settings")
@RequiredArgsConstructor
public class SystemSettingController {

    private final SystemSettingService systemSettingService;

    @GetMapping
    public Result<List<SystemSetting>> list(@RequestParam(required = false) String category) {
        return Result.ok(systemSettingService.list(category));
    }

    @PutMapping("/{key}")
    public Result<SystemSetting> update(@PathVariable String key, @RequestBody UpdateSettingRequest request) {
        return Result.ok(systemSettingService.update(key, request.getValue()));
    }

    @Data
    public static class UpdateSettingRequest {
        private String value;
    }
}
