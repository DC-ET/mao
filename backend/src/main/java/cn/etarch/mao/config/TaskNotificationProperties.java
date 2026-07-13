package cn.etarch.mao.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Data
@Component
@ConfigurationProperties(prefix = "app.task-notification")
public class TaskNotificationProperties {
    private String secretKey = "";
    private long workerDelayMs = 30_000;
    private int batchSize = 100;
    private int maxAttempts = 4;
}
