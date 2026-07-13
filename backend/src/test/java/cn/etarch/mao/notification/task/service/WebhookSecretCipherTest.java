package cn.etarch.mao.notification.task.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.config.TaskNotificationProperties;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class WebhookSecretCipherTest {
    @Test
    void usesDefaultSecretWhenEnvironmentOverrideIsMissing() {
        WebhookSecretCipher cipher = new WebhookSecretCipher(new TaskNotificationProperties());
        String encrypted = cipher.encrypt("https://example.test");
        assertEquals("https://example.test", cipher.decrypt(encrypted));
    }

    @Test
    void encryptsWithRandomNonceAndDetectsTampering() {
        TaskNotificationProperties properties = new TaskNotificationProperties();
        properties.setSecretKey("unit-test-secret");
        WebhookSecretCipher cipher = new WebhookSecretCipher(properties);
        String plaintext = "https://open.feishu.cn/open-apis/bot/v2/hook/abc";

        String first = cipher.encrypt(plaintext);
        String second = cipher.encrypt(plaintext);
        assertNotEquals(first, second);
        assertEquals(plaintext, cipher.decrypt(first));

        String tampered = first.substring(0, first.length() - 2) + "AA";
        assertThrows(BusinessException.class, () -> cipher.decrypt(tampered));
    }
}
