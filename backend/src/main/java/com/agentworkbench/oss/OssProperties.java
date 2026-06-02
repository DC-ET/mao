package com.agentworkbench.oss;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import org.springframework.util.unit.DataSize;

@Data
@Component
@ConfigurationProperties(prefix = "oss")
public class OssProperties {

    private String region = "oss-cn-hangzhou";
    private String accessKeyId = "REDACTED_OSS_KEY";
    private String accessKeySecret = "REDACTED_OSS_SECRET";
    private String bucket = "etfs";
    private int maxKeys = 100;

    private Sts sts = new Sts();

    @Data
    public static class Sts {
        private String regionId = "cn-hangzhou";
        private String endpoint = "sts.cn-hangzhou.aliyuncs.com";
        private String accessKeyId = "REDACTED_STS_KEY";
        private String accessKeySecret = "REDACTED_STS_SECRET";
        private String roleArn = "acs:ram::REDACTED_RAM_ACCOUNT:role/ramosstest";
        private String roleSessionName = "OssSession";
        private long expire = 3600;
        private DataSize maxSize = DataSize.ofMegabytes(20);
    }
}
