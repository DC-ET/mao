package cn.etarch.mao.notification.task.service;

import cn.etarch.mao.notification.task.model.NotificationChannel;
import cn.etarch.mao.notification.task.sender.WebhookSender;
import org.springframework.stereotype.Component;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;

@Component
public class WebhookSenderRegistry {
    private final Map<NotificationChannel, WebhookSender> senders = new EnumMap<>(NotificationChannel.class);

    public WebhookSenderRegistry(List<WebhookSender> senderList) {
        senderList.forEach(sender -> senders.put(sender.channel(), sender));
    }

    public WebhookSender get(NotificationChannel channel) {
        WebhookSender sender = senders.get(channel);
        if (sender == null) throw new IllegalStateException("Missing webhook sender for " + channel);
        return sender;
    }
}
