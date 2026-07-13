package cn.etarch.mao.notification.task.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.notification.task.entity.UserTaskNotificationPreference;
import cn.etarch.mao.notification.task.mapper.UserTaskNotificationPreferenceMapper;
import cn.etarch.mao.notification.task.model.NotificationChannel;
import cn.etarch.mao.notification.task.sender.WebhookSender.WebhookSendResult;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class TaskNotificationPreferenceService {
    private final UserTaskNotificationPreferenceMapper mapper;
    private final WebhookSecretCipher cipher;
    private final WebhookUrlValidator urlValidator;
    private final WebhookSenderRegistry senderRegistry;

    public PreferenceView get(Long userId) {
        UserTaskNotificationPreference row = find(userId);
        if (row == null) return new PreferenceView(false, null, false, null);
        String masked = null;
        boolean configured = row.getWebhookCiphertext() != null && !row.getWebhookCiphertext().isBlank();
        if (configured) masked = urlValidator.mask(cipher.decrypt(row.getWebhookCiphertext()));
        return new PreferenceView(Integer.valueOf(1).equals(row.getEnabled()), row.getChannel(), configured, masked);
    }

    public PreferenceView save(Long userId, boolean enabled, String channelValue, String webhookUrl) {
        UserTaskNotificationPreference row = find(userId);
        NotificationChannel channel = channelValue != null && !channelValue.isBlank()
                ? NotificationChannel.parse(channelValue)
                : row != null && row.getChannel() != null ? NotificationChannel.parse(row.getChannel()) : null;
        boolean channelChanged = row != null && channel != null && !channel.name().equals(row.getChannel());
        String ciphertext = row != null ? row.getWebhookCiphertext() : null;
        if (webhookUrl != null && !webhookUrl.isBlank()) {
            if (channel == null) throw new BusinessException(ErrorCode.PARAM_INVALID, "请选择通知渠道");
            ciphertext = cipher.encrypt(urlValidator.validate(channel, webhookUrl));
        } else if (channelChanged) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "切换通知渠道时必须填写新的 Webhook 地址");
        }
        if (enabled && (channel == null || ciphertext == null || ciphertext.isBlank())) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "开启通知时必须选择渠道并配置 Webhook 地址");
        }
        if (row == null) {
            row = new UserTaskNotificationPreference();
            row.setUserId(userId);
            row.setEnabled(enabled ? 1 : 0);
            row.setChannel(channel != null ? channel.name() : null);
            row.setWebhookCiphertext(ciphertext);
            mapper.insert(row);
        } else {
            row.setEnabled(enabled ? 1 : 0);
            row.setChannel(channel != null ? channel.name() : row.getChannel());
            row.setWebhookCiphertext(ciphertext);
            mapper.updateById(row);
        }
        return get(userId);
    }

    public void sendTest(Long userId, String channelValue, String webhookUrl) {
        NotificationChannel channel = NotificationChannel.parse(channelValue);
        String resolvedUrl;
        if (webhookUrl != null && !webhookUrl.isBlank()) {
            resolvedUrl = urlValidator.validate(channel, webhookUrl);
        } else {
            UserTaskNotificationPreference row = find(userId);
            if (row == null || !channel.name().equals(row.getChannel()) || row.getWebhookCiphertext() == null) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "请先填写或保存当前渠道的 Webhook 地址");
            }
            resolvedUrl = cipher.decrypt(row.getWebhookCiphertext());
        }
        WebhookSendResult result = senderRegistry.get(channel).send(resolvedUrl,
                "Mao Agent 测试通知\n消息通知配置成功");
        if (!result.success()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    result.error() != null ? result.error() : "测试通知发送失败");
        }
    }

    public UserTaskNotificationPreference findEnabled(Long userId) {
        UserTaskNotificationPreference row = find(userId);
        return row != null && Integer.valueOf(1).equals(row.getEnabled())
                && row.getChannel() != null && row.getWebhookCiphertext() != null ? row : null;
    }

    private UserTaskNotificationPreference find(Long userId) {
        return mapper.selectOne(new LambdaQueryWrapper<UserTaskNotificationPreference>()
                .eq(UserTaskNotificationPreference::getUserId, userId));
    }

    public record PreferenceView(boolean enabled, String channel, boolean webhookConfigured, String maskedWebhook) {}
}
