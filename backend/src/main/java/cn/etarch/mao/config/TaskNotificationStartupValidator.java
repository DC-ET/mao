package cn.etarch.mao.config;

import lombok.RequiredArgsConstructor;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
public class TaskNotificationStartupValidator implements ApplicationRunner {
    private final TaskNotificationProperties properties;

    @Override
    public void run(ApplicationArguments args) {
        if (properties.getSecretKey() == null || properties.getSecretKey().isBlank()) {
            throw new IllegalStateException(
                    "app.task-notification.secret-key is not configured. "
                            + "Set APP_NOTIFICATION_WEBHOOK_SECRET before starting the application.");
        }
    }
}
