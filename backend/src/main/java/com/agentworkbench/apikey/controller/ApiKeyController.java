package com.agentworkbench.apikey.controller;

import com.agentworkbench.apikey.entity.ApiKey;
import com.agentworkbench.apikey.service.ApiKeyService;
import com.agentworkbench.common.result.Result;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/v1/api-keys")
@RequiredArgsConstructor
public class ApiKeyController {

    private final ApiKeyService apiKeyService;

    @PostMapping
    public Result<ApiKeyVO> createApiKey(
            @AuthenticationPrincipal Long userId,
            @RequestBody CreateApiKeyRequest request) {
        ApiKey apiKey = apiKeyService.createApiKey(userId, request.getName(), request.getRateLimit());
        return Result.ok(toVO(apiKey, true));
    }

    @GetMapping
    public Result<List<ApiKeyVO>> listApiKeys(@AuthenticationPrincipal Long userId) {
        List<ApiKey> keys = apiKeyService.listApiKeys(userId);
        List<ApiKeyVO> voList = keys.stream()
                .map(k -> toVO(k, false))
                .collect(Collectors.toList());
        return Result.ok(voList);
    }

    @DeleteMapping("/{id}")
    public Result<Void> revokeApiKey(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        apiKeyService.deleteApiKey(id, userId);
        return Result.ok();
    }

    private ApiKeyVO toVO(ApiKey apiKey, boolean showKey) {
        ApiKeyVO vo = new ApiKeyVO();
        vo.setId(apiKey.getId());
        vo.setName(apiKey.getName());
        vo.setApiKey(showKey ? apiKey.getApiKey() : maskKey(apiKey.getApiKey()));
        vo.setRateLimit(apiKey.getRateLimit());
        vo.setStatus(apiKey.getStatus());
        vo.setLastUsedAt(apiKey.getLastUsedAt() != null ? apiKey.getLastUsedAt().toString() : null);
        vo.setCreatedAt(apiKey.getCreatedAt() != null ? apiKey.getCreatedAt().toString() : null);
        return vo;
    }

    private String maskKey(String key) {
        if (key == null || key.length() < 8) return "****";
        return key.substring(0, 6) + "****" + key.substring(key.length() - 4);
    }

    @Data
    public static class CreateApiKeyRequest {
        private String name;
        private Integer rateLimit;
    }

    @Data
    public static class ApiKeyVO {
        private Long id;
        private String name;
        private String apiKey;
        private Integer rateLimit;
        private Integer status;
        private String lastUsedAt;
        private String createdAt;
    }
}
