package cn.etarch.mao.notification.task.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.config.TaskNotificationProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

@Slf4j
@Component
@RequiredArgsConstructor
public class WebhookSecretCipher {
    private static final int NONCE_LENGTH = 12;
    private static final int TAG_BITS = 128;
    private final TaskNotificationProperties properties;
    private final SecureRandom secureRandom = new SecureRandom();

    public String encrypt(String plaintext) {
        try {
            byte[] nonce = new byte[NONCE_LENGTH];
            secureRandom.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, nonce));
            byte[] encrypted = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(nonce) + ":"
                    + Base64.getEncoder().encodeToString(encrypted);
        } catch (Exception e) {
            log.error("Failed to encrypt task notification webhook", e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "Webhook 加密失败");
        }
    }

    public String decrypt(String ciphertext) {
        try {
            int separator = ciphertext.indexOf(':');
            if (separator <= 0) throw new IllegalArgumentException("Invalid ciphertext");
            byte[] nonce = Base64.getDecoder().decode(ciphertext.substring(0, separator));
            byte[] encrypted = Base64.getDecoder().decode(ciphertext.substring(separator + 1));
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, nonce));
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (Exception e) {
            log.error("Failed to decrypt task notification webhook");
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "Webhook 解密失败");
        }
    }

    private SecretKeySpec key() throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256")
                .digest(properties.getSecretKey().getBytes(StandardCharsets.UTF_8));
        return new SecretKeySpec(bytes, "AES");
    }
}
