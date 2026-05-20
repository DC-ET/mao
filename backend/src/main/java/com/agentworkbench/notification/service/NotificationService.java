package com.agentworkbench.notification.service;

import com.agentworkbench.notification.entity.Notification;
import com.agentworkbench.notification.mapper.NotificationMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class NotificationService {

    private final NotificationMapper notificationMapper;

    public Notification createNotification(Long userId, String type, String title,
                                           String content, String relatedType, Long relatedId) {
        Notification notification = new Notification();
        notification.setUserId(userId);
        notification.setType(type);
        notification.setTitle(title);
        notification.setContent(content);
        notification.setIsRead(0);
        notification.setRelatedType(relatedType);
        notification.setRelatedId(relatedId);
        notificationMapper.insert(notification);
        return notification;
    }

    public Page<Notification> listNotifications(Long userId, Boolean unreadOnly, int page, int size) {
        QueryWrapper<Notification> qw = new QueryWrapper<>();
        qw.eq("user_id", userId);
        if (Boolean.TRUE.equals(unreadOnly)) {
            qw.eq("is_read", 0);
        }
        qw.orderByDesc("created_at");
        return notificationMapper.selectPage(new Page<>(page, size), qw);
    }

    public void markAsRead(Long id, Long userId) {
        Notification notification = notificationMapper.selectById(id);
        if (notification != null && notification.getUserId().equals(userId)) {
            notification.setIsRead(1);
            notificationMapper.updateById(notification);
        }
    }

    public void markAllAsRead(Long userId) {
        Notification update = new Notification();
        update.setIsRead(1);
        notificationMapper.update(update,
                new QueryWrapper<Notification>()
                        .eq("user_id", userId)
                        .eq("is_read", 0));
    }

    public long getUnreadCount(Long userId) {
        return notificationMapper.selectCount(
                new QueryWrapper<Notification>()
                        .eq("user_id", userId)
                        .eq("is_read", 0));
    }
}
