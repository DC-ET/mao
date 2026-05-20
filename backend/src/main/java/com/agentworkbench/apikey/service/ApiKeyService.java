package com.agentworkbench.apikey.service;

import com.agentworkbench.apikey.entity.ApiKey;
import com.agentworkbench.apikey.mapper.ApiKeyMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;

@Service
@RequiredArgsConstructor
public class ApiKeyService {

    private final ApiKeyMapper apiKeyMapper;

    public ApiKey createApiKey(Long userId, String name, Integer rateLimit) {
        ApiKey apiKey = new ApiKey();
        apiKey.setUserId(userId);
        apiKey.setName(name);
        apiKey.setApiKey("aw_" + UUID.randomUUID().toString().replace("-", ""));
        apiKey.setRateLimit(rateLimit != null ? rateLimit : 100);
        apiKey.setStatus(1);
        apiKeyMapper.insert(apiKey);
        return apiKey;
    }

    public List<ApiKey> listApiKeys(Long userId) {
        return apiKeyMapper.selectList(
                new QueryWrapper<ApiKey>()
                        .eq("user_id", userId)
                        .orderByDesc("created_at"));
    }

    public ApiKey getApiKey(Long id) {
        return apiKeyMapper.selectById(id);
    }

    public ApiKey validateApiKey(String key) {
        ApiKey apiKey = apiKeyMapper.selectOne(
                new QueryWrapper<ApiKey>()
                        .eq("api_key", key)
                        .eq("status", 1));

        if (apiKey == null) {
            return null;
        }

        // Check expiration
        if (apiKey.getExpiresAt() != null && apiKey.getExpiresAt().isBefore(LocalDateTime.now())) {
            return null;
        }

        // Update last used time
        apiKey.setLastUsedAt(LocalDateTime.now());
        apiKeyMapper.updateById(apiKey);

        return apiKey;
    }

    public void revokeApiKey(Long id, Long userId) {
        ApiKey apiKey = apiKeyMapper.selectById(id);
        if (apiKey == null || !apiKey.getUserId().equals(userId)) {
            throw new BusinessException(4040, "API Key 不存在");
        }
        apiKey.setStatus(0);
        apiKeyMapper.updateById(apiKey);
    }

    public void deleteApiKey(Long id, Long userId) {
        ApiKey apiKey = apiKeyMapper.selectById(id);
        if (apiKey == null || !apiKey.getUserId().equals(userId)) {
            throw new BusinessException(4040, "API Key 不存在");
        }
        apiKeyMapper.deleteById(id);
    }
}
