package com.agentworkbench.system.controller;

import com.agentworkbench.common.result.Result;
import com.agentworkbench.system.entity.SystemConfig;
import com.agentworkbench.system.service.SystemConfigService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/v1/system")
@RequiredArgsConstructor
public class SystemConfigController {

    private final SystemConfigService systemConfigService;

    @GetMapping("/config")
    public Result<Map<String, String>> getAllConfigs() {
        return Result.ok(systemConfigService.getAllConfigs());
    }

    @GetMapping("/config/{key}")
    public Result<String> getConfig(@PathVariable String key) {
        String value = systemConfigService.getConfig(key);
        return Result.ok(value);
    }

    @PutMapping("/config")
    public Result<Void> updateConfigs(@RequestBody Map<String, String> configs) {
        systemConfigService.updateConfigs(configs);
        return Result.ok();
    }

    @GetMapping("/config/list")
    public Result<List<SystemConfig>> listConfigs() {
        return Result.ok(systemConfigService.listConfigs());
    }
}
