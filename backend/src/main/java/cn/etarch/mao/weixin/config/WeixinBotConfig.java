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

    /** Agent 回复是否附带语音（语音模型合成 → MP3 文件消息），默认关闭 */
    private boolean voiceReply = false;

    /** 入站文件大小上限（MB），超限拒绝保存并回复"文件过大" */
    private int maxInboundFileMb = 100;

    /** SILK 编码器路径（腾讯 silk-v3 encoder，-tencent 模式） */
    private String silkEncoderPath = "/usr/local/bin/silk-encoder";

    /** ffmpeg 可执行文件路径 */
    private String ffmpegPath = "ffmpeg";

    /**
     * 语音最大时长（秒），超长文本在句子边界截断。
     * 微信侧以 MP3 文件消息发送，无语音条 60 秒限制，默认 300 秒以尽量覆盖完整回复。
     */
    private int voiceMaxSeconds = 300;

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