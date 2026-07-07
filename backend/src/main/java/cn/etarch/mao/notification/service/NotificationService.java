package cn.etarch.mao.notification.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.notification.entity.Notification;
import cn.etarch.mao.notification.mapper.NotificationMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

@Service
@RequiredArgsConstructor
public class NotificationService {

    private final NotificationMapper notificationMapper;

    public Page<Notification> list(int page, int size, String type, Integer isRead, Long userId) {
        LambdaQueryWrapper<Notification> qw = new LambdaQueryWrapper<>();
        if (StringUtils.hasText(type)) {
            qw.eq(Notification::getType, type);
        }
        if (isRead != null) {
            qw.eq(Notification::getIsRead, isRead);
        }
        if (userId != null) {
            qw.eq(Notification::getUserId, userId);
        }
        qw.orderByDesc(Notification::getCreatedAt);
        return notificationMapper.selectPage(Page.of(page, size), qw);
    }

    public Notification create(Long userId, String type, String title, String content) {
        if (!StringUtils.hasText(title)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "通知标题不能为空");
        }
        Notification notification = new Notification();
        notification.setUserId(userId);
        notification.setType(StringUtils.hasText(type) ? type : "SYSTEM");
        notification.setTitle(title.trim());
        notification.setContent(content);
        notification.setIsRead(0);
        notificationMapper.insert(notification);
        return notification;
    }

    public void markRead(Long id) {
        Notification notification = notificationMapper.selectById(id);
        if (notification == null) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "通知不存在");
        }
        notification.setIsRead(1);
        notificationMapper.updateById(notification);
    }
}
