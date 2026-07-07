package cn.etarch.mao.notification.controller;

import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.notification.entity.Notification;
import cn.etarch.mao.notification.service.NotificationService;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/v1/notifications")
@RequiredArgsConstructor
public class NotificationController {

    private final NotificationService notificationService;

    @GetMapping
    public Result<Map<String, Object>> list(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String type,
            @RequestParam(required = false) Integer isRead,
            @RequestParam(required = false) Long userId) {
        Page<Notification> pageResult = notificationService.list(page, size, type, isRead, userId);
        return Result.ok(Map.of(
                "records", pageResult.getRecords(),
                "total", pageResult.getTotal(),
                "page", pageResult.getCurrent(),
                "size", pageResult.getSize()));
    }

    @PostMapping
    public Result<Notification> create(@RequestBody CreateNotificationRequest request) {
        return Result.ok(notificationService.create(request.getUserId(), request.getType(), request.getTitle(), request.getContent()));
    }

    @PatchMapping("/{id}/read")
    public Result<Void> markRead(@PathVariable Long id) {
        notificationService.markRead(id);
        return Result.ok();
    }

    @Data
    public static class CreateNotificationRequest {
        private Long userId;
        private String type;
        private String title;
        private String content;
    }
}
