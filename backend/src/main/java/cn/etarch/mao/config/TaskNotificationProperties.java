package cn.etarch.mao.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Data
@Component
@ConfigurationProperties(prefix = "app.task-notification")
public class TaskNotificationProperties {
    public static final String DEFAULT_SECRET_KEY = "mao-task-notification-default-key-v1-20260713";

    private String secretKey = DEFAULT_SECRET_KEY;
    private long workerDelayMs = 30_000;
    private int batchSize = 100;
    private int maxAttempts = 4;

    public boolean isSecretConfigured() {
        return secretKey != null && !secretKey.isBlank();
    }

    public void setSecretKey(String secretKey) {
        this.secretKey = secretKey == null || secretKey.isBlank() ? DEFAULT_SECRET_KEY : secretKey;
    }
}
