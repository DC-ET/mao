package cn.etarch.mao.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Data
@Component
@ConfigurationProperties(prefix = "app.git-credential")
public class GitCredentialProperties {

    /**
     * AES encryption key, injected via APP_GIT_CREDENTIAL_SECRET environment variable.
     */
    private String secretKey = "";
}
