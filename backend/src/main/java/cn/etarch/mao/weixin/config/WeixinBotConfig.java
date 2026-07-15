package cn.etarch.mao.weixin.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Data
@Component
@ConfigurationProperties(prefix = "weixin.bot")
public class WeixinBotConfig {

    private boolean enabled = true;

    private String ilinkBaseUrl = "https://ilinkai.weixin.qq.com";

    private String cdnBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c";

    private MonitorConfig monitor = new MonitorConfig();

    private LeaseConfig lease = new LeaseConfig();

    @Data
    public static class MonitorConfig {
        private boolean enabled = true;
        private long reconcileIntervalMs = 5000;
        private long longPollTimeoutMs = 35000;
        private int maxConsecutiveFailures = 3;
    }

    @Data
    public static class LeaseConfig {
        private boolean enabled = true;
        private long ttlMs = 15000;
    }
}