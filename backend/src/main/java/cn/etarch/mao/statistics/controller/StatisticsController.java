package cn.etarch.mao.statistics.controller;

import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.statistics.service.StatisticsService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/v1/statistics")
@RequiredArgsConstructor
public class StatisticsController {

    private final StatisticsService statisticsService;

    @GetMapping("/overview")
    public Result<Map<String, Object>> getOverview() {
        return Result.ok(statisticsService.getOverview());
    }

    @GetMapping("/agents")
    public Result<List<Map<String, Object>>> getAgentStats() {
        return Result.ok(statisticsService.getAgentStats());
    }

    @GetMapping("/models")
    public Result<List<Map<String, Object>>> getModelStats() {
        return Result.ok(statisticsService.getModelStats());
    }

    @GetMapping("/users")
    public Result<List<Map<String, Object>>> getUserStats() {
        return Result.ok(statisticsService.getUserStats());
    }
}
