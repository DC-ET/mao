package cn.etarch.mao.oss;

import lombok.Data;

@Data
public class StsTokenVO {
    private String accessKeyId;
    private String accessKeySecret;
    private String securityToken;
    private String expiration;
    private String bucket;
    private String region;
    private String uploadDir;
}
