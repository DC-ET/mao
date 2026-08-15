package cn.etarch.mao.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Data
@Configuration
@ConfigurationProperties(prefix = "app.harness.delegate")
public class DelegateConfig {
    private int timeoutSeconds = 3600;
    private int cancelGraceSeconds = 30;
}
