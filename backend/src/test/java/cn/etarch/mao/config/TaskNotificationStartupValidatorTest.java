package cn.etarch.mao.config;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

class TaskNotificationStartupValidatorTest {
    @Test
    void defaultSecretAllowsApplicationStartup() {
        TaskNotificationProperties properties = new TaskNotificationProperties();
        TaskNotificationStartupValidator validator = new TaskNotificationStartupValidator(properties);

        assertDoesNotThrow(() -> validator.run(null));
    }
}
