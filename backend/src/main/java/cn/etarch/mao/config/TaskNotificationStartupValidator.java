package cn.etarch.mao.config;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
@Slf4j
public class TaskNotificationStartupValidator implements ApplicationRunner {
    private final TaskNotificationProperties properties;

    @Override
    public void run(ApplicationArguments args) {
        if (!properties.isSecretConfigured()) {
            log.warn("APP_NOTIFICATION_WEBHOOK_SECRET is not configured. "
                    + "Task Webhook notification settings and delivery are disabled until it is set.");
        }
    }
}
