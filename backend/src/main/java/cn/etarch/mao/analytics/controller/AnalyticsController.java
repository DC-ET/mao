package cn.etarch.mao.analytics.controller;

import cn.etarch.mao.analytics.service.AnalyticsService;
import cn.etarch.mao.common.result.Result;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/v1/analytics")
@RequiredArgsConstructor
public class AnalyticsController {

    private final AnalyticsService analyticsService;

    @GetMapping("/trends")
    public Result<Map<String, Object>> getUsageTrends(
            @RequestParam(defaultValue = "7") int days) {
        return Result.ok(analyticsService.getUsageTrends(days));
    }

    @GetMapping("/tokens")
    public Result<Map<String, Object>> getTokenAnalysis() {
        return Result.ok(analyticsService.getTokenAnalysis());
    }

    @GetMapping("/users")
    public Result<Map<String, Object>> getUserActivity() {
        return Result.ok(analyticsService.getUserActivity());
    }

    @GetMapping("/agents/{id}")
    public Result<Map<String, Object>> getAgentEfficiency(@PathVariable Long id) {
        return Result.ok(analyticsService.getAgentEfficiency(id));
    }
}
