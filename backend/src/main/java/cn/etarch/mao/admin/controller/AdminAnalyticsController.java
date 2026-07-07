package cn.etarch.mao.admin.controller;

import cn.etarch.mao.admin.service.AdminAnalyticsService;
import cn.etarch.mao.common.result.Result;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/v1/admin/analytics")
@RequiredArgsConstructor
public class AdminAnalyticsController {

    private final AdminAnalyticsService adminAnalyticsService;

    @GetMapping("/summary")
    public Result<Map<String, Object>> summary(@RequestParam(defaultValue = "30") int days) {
        return Result.ok(adminAnalyticsService.summary(Math.max(1, Math.min(days, 90))));
    }
}
