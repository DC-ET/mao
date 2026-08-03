package cn.etarch.mao.harness.mcp.crypto;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * MCP 环境变量（env_json）的 AES/GCM 加解密。
 * 实现与 {@code WebhookSecretCipher} 保持一致：AES/GCM/NoPadding，
 * 密钥由 SHA-256(app.mcp.secret-key) 派生，密文格式 {@code nonce:base64(密文)}。
 */
@Slf4j
@Component
public class McpSecretCipher {

    private static final int NONCE_LENGTH = 12;
    private static final int TAG_BITS = 128;

    private final String secretKey;
    private final SecureRandom secureRandom = new SecureRandom();

    public McpSecretCipher(@Value("${app.mcp.secret-key:mao-mcp-default-secret-change-me}") String secretKey) {
        this.secretKey = secretKey;
    }

    public String encrypt(String plaintext) {
        if (plaintext == null || plaintext.isEmpty()) {
            return plaintext;
        }
        try {
            byte[] nonce = new byte[NONCE_LENGTH];
            secureRandom.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, nonce));
            byte[] encrypted = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(nonce) + ":"
                    + Base64.getEncoder().encodeToString(encrypted);
        } catch (Exception e) {
            log.error("Failed to encrypt MCP server env", e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "MCP 环境变量加密失败");
        }
    }

    public String decrypt(String ciphertext) {
        if (ciphertext == null || ciphertext.isEmpty()) {
            return ciphertext;
        }
        try {
            int separator = ciphertext.indexOf(':');
            if (separator <= 0) {
                throw new IllegalArgumentException("Invalid ciphertext");
            }
            byte[] nonce = Base64.getDecoder().decode(ciphertext.substring(0, separator));
            byte[] encrypted = Base64.getDecoder().decode(ciphertext.substring(separator + 1));
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, nonce));
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (Exception e) {
            log.error("Failed to decrypt MCP server env", e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "MCP 环境变量解密失败");
        }
    }

    private SecretKeySpec key() throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256")
                .digest(secretKey.getBytes(StandardCharsets.UTF_8));
        return new SecretKeySpec(bytes, "AES");
    }
}
