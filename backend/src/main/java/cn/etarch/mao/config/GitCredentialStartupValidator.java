package cn.etarch.mao.config;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@RequiredArgsConstructor
public class GitCredentialStartupValidator implements ApplicationRunner {

    private final GitCredentialProperties properties;

    @Override
    public void run(ApplicationArguments args) {
        if (properties.getSecretKey() == null || properties.getSecretKey().isBlank()) {
            log.error("============================================================");
            log.error("APP_GIT_CREDENTIAL_SECRET is not configured.");
            log.error("Set environment variable APP_GIT_CREDENTIAL_SECRET to a random");
            log.error("32-byte secret before starting the application.");
            log.error("Example: export APP_GIT_CREDENTIAL_SECRET=$(openssl rand -base64 32)");
            log.error("============================================================");
            throw new IllegalStateException(
                    "app.git-credential.secret-key is not configured. "
                            + "Set environment variable APP_GIT_CREDENTIAL_SECRET.");
        }
    }
}
