package com.agentworkbench.notification.controller;

import com.agentworkbench.common.result.Result;
import com.agentworkbench.notification.entity.Notification;
import com.agentworkbench.notification.service.NotificationService;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/v1/notifications")
@RequiredArgsConstructor
public class NotificationController {

    private final NotificationService notificationService;

    @GetMapping
    public Result<Map<String, Object>> listNotifications(
            @AuthenticationPrincipal Long userId,
            @RequestParam(required = false) Boolean unreadOnly,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        Page<Notification> pageResult = notificationService.listNotifications(userId, unreadOnly, page, size);
        List<NotificationVO> voList = pageResult.getRecords().stream()
                .map(this::toVO)
                .collect(Collectors.toList());
        return Result.ok(Map.of(
                "records", voList,
                "total", pageResult.getTotal(),
                "unreadCount", notificationService.getUnreadCount(userId)
        ));
    }

    @PutMapping("/{id}/read")
    public Result<Void> markAsRead(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        notificationService.markAsRead(id, userId);
        return Result.ok();
    }

    @PutMapping("/read-all")
    public Result<Void> markAllAsRead(@AuthenticationPrincipal Long userId) {
        notificationService.markAllAsRead(userId);
        return Result.ok();
    }

    @GetMapping("/unread-count")
    public Result<Map<String, Object>> getUnreadCount(@AuthenticationPrincipal Long userId) {
        return Result.ok(Map.of("count", notificationService.getUnreadCount(userId)));
    }

    private NotificationVO toVO(Notification notification) {
        NotificationVO vo = new NotificationVO();
        vo.setId(notification.getId());
        vo.setType(notification.getType());
        vo.setTitle(notification.getTitle());
        vo.setContent(notification.getContent());
        vo.setIsRead(notification.getIsRead() != null && notification.getIsRead() == 1);
        vo.setRelatedType(notification.getRelatedType());
        vo.setRelatedId(notification.getRelatedId());
        vo.setCreatedAt(notification.getCreatedAt() != null ? notification.getCreatedAt().toString() : null);
        return vo;
    }

    @Data
    public static class NotificationVO {
        private Long id;
        private String type;
        private String title;
        private String content;
        private Boolean isRead;
        private String relatedType;
        private Long relatedId;
        private String createdAt;
    }
}
