package cn.etarch.mao.oss;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import org.springframework.util.unit.DataSize;

@Data
@Component
@ConfigurationProperties(prefix = "oss")
public class OssProperties {

    private String region;
    private String accessKeyId;
    private String accessKeySecret;
    private String bucket;
    private int maxKeys;

    private Sts sts = new Sts();

    @Data
    public static class Sts {
        private String regionId;
        private String endpoint;
        private String accessKeyId;
        private String accessKeySecret;
        private String roleArn;
        private String roleSessionName;
        private long expire;
        private DataSize maxSize;
    }
}
