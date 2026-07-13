package cn.etarch.mao.notification.task.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.notification.task.model.NotificationChannel;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class WebhookUrlValidatorTest {
    private final WebhookUrlValidator validator = new WebhookUrlValidator();

    @Test
    void acceptsSupportedWebhookUrls() {
        assertEquals("https://oapi.dingtalk.com/robot/send?access_token=abc",
                validator.validate(NotificationChannel.DINGTALK,
                        "https://oapi.dingtalk.com/robot/send?access_token=abc"));
        assertEquals("https://open.feishu.cn/open-apis/bot/v2/hook/abc",
                validator.validate(NotificationChannel.FEISHU,
                        "https://open.feishu.cn/open-apis/bot/v2/hook/abc"));
    }

    @Test
    void rejectsSsrfAndChannelMismatch() {
        assertThrows(BusinessException.class, () -> validator.validate(NotificationChannel.DINGTALK,
                "http://oapi.dingtalk.com/robot/send?access_token=abc"));
        assertThrows(BusinessException.class, () -> validator.validate(NotificationChannel.DINGTALK,
                "https://oapi.dingtalk.com.evil.test/robot/send?access_token=abc"));
        assertThrows(BusinessException.class, () -> validator.validate(NotificationChannel.FEISHU,
                "https://oapi.dingtalk.com/robot/send?access_token=abc"));
        assertThrows(BusinessException.class, () -> validator.validate(NotificationChannel.FEISHU,
                "https://127.0.0.1/open-apis/bot/v2/hook/abc"));
    }
}
