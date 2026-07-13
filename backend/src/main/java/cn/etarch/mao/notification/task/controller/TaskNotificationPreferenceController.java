package cn.etarch.mao.notification.task.controller;

import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.notification.task.service.TaskNotificationPreferenceService;
import cn.etarch.mao.notification.task.service.TaskNotificationPreferenceService.PreferenceView;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/v1/user-preferences/task-notification")
@RequiredArgsConstructor
public class TaskNotificationPreferenceController {
    private final TaskNotificationPreferenceService service;

    @GetMapping
    public Result<PreferenceView> get(@AuthenticationPrincipal Long userId) {
        return Result.ok(service.get(userId));
    }

    @PutMapping
    public Result<PreferenceView> save(@AuthenticationPrincipal Long userId,
                                       @RequestBody SavePreferenceRequest request) {
        return Result.ok(service.save(userId, Boolean.TRUE.equals(request.getEnabled()),
                request.getChannel(), request.getWebhookUrl()));
    }

    @PostMapping("/test")
    public Result<Void> test(@AuthenticationPrincipal Long userId,
                             @RequestBody TestNotificationRequest request) {
        service.sendTest(userId, request.getChannel(), request.getWebhookUrl());
        return Result.ok(null);
    }

    @Data
    public static class SavePreferenceRequest {
        private Boolean enabled;
        private String channel;
        private String webhookUrl;
    }

    @Data
    public static class TestNotificationRequest {
        private String channel;
        private String webhookUrl;
    }
}
