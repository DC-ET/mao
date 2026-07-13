package cn.etarch.mao.notification.task.sender;

import cn.etarch.mao.notification.task.model.NotificationChannel;

public interface WebhookSender {
    NotificationChannel channel();
    WebhookSendResult send(String webhookUrl, String content);

    record WebhookSendResult(boolean success, boolean retryable, Integer httpStatus,
                             String providerCode, String error) {
        public static WebhookSendResult success(int httpStatus, String providerCode) {
            return new WebhookSendResult(true, false, httpStatus, providerCode, null);
        }

        public static WebhookSendResult failure(boolean retryable, Integer httpStatus,
                                                String providerCode, String error) {
            return new WebhookSendResult(false, retryable, httpStatus, providerCode, error);
        }
    }
}
