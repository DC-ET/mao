package cn.etarch.mao.user.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.config.GitCredentialProperties;
import cn.etarch.mao.user.entity.GitCredential;
import cn.etarch.mao.user.mapper.GitCredentialMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

@Slf4j
@Service
@RequiredArgsConstructor
public class GitCredentialService {

    private static final Pattern DOMAIN_PATTERN =
            Pattern.compile("^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$");

    private static final String AES_TRANSFORMATION = "AES/CBC/PKCS5Padding";
    private static final int IV_LENGTH = 16;

    private final GitCredentialMapper gitCredentialMapper;
    private final GitCredentialProperties properties;
    private final SecureRandom secureRandom = new SecureRandom();

    public List<GitCredential> listByUserId(Long userId) {
        return gitCredentialMapper.selectList(
                new QueryWrapper<GitCredential>()
                        .eq("user_id", userId)
                        .orderByDesc("updated_at"));
    }

    public GitCredential getByIdAndUserId(Long id, Long userId) {
        return gitCredentialMapper.selectOne(
                new QueryWrapper<GitCredential>()
                        .eq("id", id)
                        .eq("user_id", userId));
    }

    public Map<String, String> getTokenMapByUser(Long userId) {
        if (userId == null) {
            return Map.of();
        }
        List<GitCredential> credentials = listByUserId(userId);
        Map<String, String> map = new LinkedHashMap<>();
        for (GitCredential credential : credentials) {
            map.put(credential.getDomain(), decrypt(credential.getAccessToken()));
        }
        return map;
    }

    public GitCredential create(Long userId, String domain, String accessToken, String description) {
        String normalizedDomain = normalizeDomain(domain);
        validateDomain(normalizedDomain);
        if (accessToken == null || accessToken.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Access Token 不能为空");
        }
        if (findByUserAndDomain(userId, normalizedDomain) != null) {
            throw new BusinessException(ErrorCode.GIT_CREDENTIAL_DOMAIN_DUPLICATE);
        }

        GitCredential credential = new GitCredential();
        credential.setUserId(userId);
        credential.setDomain(normalizedDomain);
        credential.setAccessToken(encrypt(accessToken.trim()));
        credential.setDescription(description != null ? description.trim() : null);
        gitCredentialMapper.insert(credential);
        return credential;
    }

    public GitCredential update(Long userId, Long id, String accessToken, String description) {
        GitCredential credential = getByIdAndUserId(id, userId);
        if (credential == null) {
            throw new BusinessException(ErrorCode.GIT_CREDENTIAL_NOT_FOUND);
        }
        if (accessToken != null && !accessToken.isBlank()) {
            credential.setAccessToken(encrypt(accessToken.trim()));
        }
        if (description != null) {
            credential.setDescription(description.trim().isEmpty() ? null : description.trim());
        }
        gitCredentialMapper.updateById(credential);
        return credential;
    }

    public void delete(Long userId, Long id) {
        GitCredential credential = getByIdAndUserId(id, userId);
        if (credential == null) {
            throw new BusinessException(ErrorCode.GIT_CREDENTIAL_NOT_FOUND);
        }
        gitCredentialMapper.deleteById(id);
    }

    public String maskToken(String token) {
        if (token == null || token.isBlank()) {
            return "****";
        }
        if (token.length() <= 8) {
            return "****";
        }
        return token.substring(0, 4) + "****" + token.substring(token.length() - 4);
    }

    public static String envVarNameForDomain(String domain) {
        return "GIT_TOKEN_" + domain.replace('.', '_').replace('-', '_');
    }

    private GitCredential findByUserAndDomain(Long userId, String domain) {
        return gitCredentialMapper.selectOne(
                new QueryWrapper<GitCredential>()
                        .eq("user_id", userId)
                        .eq("domain", domain));
    }

    private String normalizeDomain(String domain) {
        if (domain == null || domain.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "域名不能为空");
        }
        String normalized = domain.trim().toLowerCase();
        if (normalized.startsWith("https://")) {
            normalized = normalized.substring("https://".length());
        }
        if (normalized.startsWith("http://")) {
            normalized = normalized.substring("http://".length());
        }
        int slash = normalized.indexOf('/');
        if (slash >= 0) {
            normalized = normalized.substring(0, slash);
        }
        return normalized;
    }

    private void validateDomain(String domain) {
        if (!DOMAIN_PATTERN.matcher(domain).matches()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "域名格式无效，示例: github.com");
        }
    }

    private String encrypt(String plaintext) {
        try {
            byte[] iv = new byte[IV_LENGTH];
            secureRandom.nextBytes(iv);
            Cipher cipher = Cipher.getInstance(AES_TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, deriveKey(), new IvParameterSpec(iv));
            byte[] encrypted = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(iv) + ":"
                    + Base64.getEncoder().encodeToString(encrypted);
        } catch (Exception e) {
            log.error("Failed to encrypt git credential", e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "凭证加密失败");
        }
    }

    private String decrypt(String ciphertext) {
        try {
            int sep = ciphertext.indexOf(':');
            if (sep <= 0) {
                throw new IllegalArgumentException("Invalid ciphertext format");
            }
            byte[] iv = Base64.getDecoder().decode(ciphertext.substring(0, sep));
            byte[] encrypted = Base64.getDecoder().decode(ciphertext.substring(sep + 1));
            Cipher cipher = Cipher.getInstance(AES_TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, deriveKey(), new IvParameterSpec(iv));
            byte[] decrypted = cipher.doFinal(encrypted);
            return new String(decrypted, StandardCharsets.UTF_8);
        } catch (Exception e) {
            log.error("Failed to decrypt git credential", e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "凭证解密失败");
        }
    }

    private SecretKeySpec deriveKey() throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] keyBytes = digest.digest(properties.getSecretKey().getBytes(StandardCharsets.UTF_8));
        return new SecretKeySpec(keyBytes, "AES");
    }
}
