package cn.etarch.mao.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Data
@Component
@ConfigurationProperties(prefix = "app.upload")
public class UploadProperties {

    /** Storage mode: oss (Aliyun OSS) or local (server local filesystem) */
    private String storageMode = "oss";

    /** Public base URL for local-mode file access, e.g. https://mao.etarch.cn */
    private String baseUrl = "";
}
