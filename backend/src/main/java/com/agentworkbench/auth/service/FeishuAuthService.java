package com.agentworkbench.auth.service;

import com.agentworkbench.auth.controller.AuthController.*;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.agentworkbench.permission.mapper.UserRoleMapper;
import com.agentworkbench.permission.entity.UserRole;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.LocalDateTime;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

@Slf4j
@Service
@RequiredArgsConstructor
public class FeishuAuthService {

    private final UserMapper userMapper;
    private final UserRoleMapper userRoleMapper;
    private final JwtService jwtService;
    private final ObjectMapper objectMapper;

    @Value("${feishu.app-id:}")
    private String appId;

    @Value("${feishu.app-secret:}")
    private String appSecret;

    @Value("${feishu.redirect-uri:http://localhost:5200/auth/feishu/callback}")
    private String redirectUri;

    private static final String FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v1/oidc/access_token";
    private static final String FEISHU_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
    private static final String FEISHU_APP_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal";

    private final OkHttpClient httpClient = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .build();

    public FeishuQrCodeVO getQrCodeUrl() {
        if (appId == null || appId.isEmpty()) {
            throw new BusinessException(5001, "飞书应用未配置");
        }
        String state = UUID.randomUUID().toString();
        String qrCodeUrl = String.format(
                "https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=%s&redirect_uri=%s&state=%s",
                appId, redirectUri, state);
        FeishuQrCodeVO vo = new FeishuQrCodeVO();
        vo.setQrCodeUrl(qrCodeUrl);
        vo.setState(state);
        return vo;
    }

    public LoginVO handleCallback(String code) {
        if (appId == null || appId.isEmpty() || appSecret == null || appSecret.isEmpty()) {
            throw new BusinessException(5001, "飞书应用未配置");
        }

        try {
            // Step 1: Get app access token
            String appAccessToken = getAppAccessToken();

            // Step 2: Exchange code for user access token
            String userAccessToken = getUserAccessToken(code, appAccessToken);

            // Step 3: Get user info
            JsonNode userInfo = getUserInfo(userAccessToken);

            String feishuUserId = userInfo.path("user_id").asText();
            String name = userInfo.path("name").asText();
            String email = userInfo.path("email").asText();
            String avatarUrl = userInfo.path("avatar_url").asText();

            // Step 4: Find or create local user
            User user = userMapper.selectOne(
                    new QueryWrapper<User>().eq("feishu_user_id", feishuUserId));

            if (user == null) {
                user = new User();
                user.setUsername("feishu_" + feishuUserId);
                user.setDisplayName(name);
                user.setEmail(email);
                user.setAvatarUrl(avatarUrl);
                user.setAuthType("FEISHU");
                user.setFeishuUserId(feishuUserId);
                user.setStatus(1);
                userMapper.insert(user);

                // Assign default USER role
                UserRole ur = new UserRole();
                ur.setUserId(user.getId());
                ur.setRoleId(2L);
                userRoleMapper.insert(ur);
            } else {
                // Update user info
                user.setDisplayName(name);
                user.setEmail(email);
                user.setAvatarUrl(avatarUrl);
                user.setLastLoginAt(LocalDateTime.now());
                userMapper.updateById(user);
            }

            // Step 5: Generate JWT tokens
            String accessToken = jwtService.generateToken(user.getId(), user.getUsername());
            String refreshToken = jwtService.generateRefreshToken(user.getId(), user.getUsername());

            LoginVO vo = new LoginVO();
            vo.setAccessToken(accessToken);
            vo.setRefreshToken(refreshToken);
            vo.setExpiresIn(86400L);

            UserInfoVO userInfoVO = new UserInfoVO();
            userInfoVO.setId(user.getId());
            userInfoVO.setUsername(user.getUsername());
            userInfoVO.setDisplayName(user.getDisplayName());
            userInfoVO.setEmail(user.getEmail());
            userInfoVO.setAvatarUrl(user.getAvatarUrl());
            vo.setUser(userInfoVO);

            return vo;

        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            log.error("Feishu OAuth callback failed", e);
            throw new BusinessException(5002, "飞书登录失败: " + e.getMessage());
        }
    }

    private String getAppAccessToken() throws IOException {
        RequestBody body = RequestBody.create(
                MediaType.parse("application/json"),
                String.format("{\"app_id\":\"%s\",\"app_secret\":\"%s\"}", appId, appSecret));

        Request request = new Request.Builder()
                .url(FEISHU_APP_TOKEN_URL)
                .post(body)
                .build();

        try (Response response = httpClient.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                throw new BusinessException(5002, "获取飞书应用 Token 失败");
            }
            JsonNode json = objectMapper.readTree(response.body().string());
            if (json.path("code").asInt() != 0) {
                throw new BusinessException(5002, "飞书 API 错误: " + json.path("msg").asText());
            }
            return json.path("app_access_token").asText();
        }
    }

    private String getUserAccessToken(String code, String appAccessToken) throws IOException {
        RequestBody body = RequestBody.create(
                MediaType.parse("application/json"),
                String.format("{\"grant_type\":\"authorization_code\",\"code\":\"%s\"}", code));

        Request request = new Request.Builder()
                .url(FEISHU_TOKEN_URL)
                .post(body)
                .addHeader("Authorization", "Bearer " + appAccessToken)
                .build();

        try (Response response = httpClient.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                throw new BusinessException(5002, "获取用户 Token 失败");
            }
            JsonNode json = objectMapper.readTree(response.body().string());
            if (json.path("code").asInt() != 0) {
                throw new BusinessException(5002, "飞书 API 错误: " + json.path("msg").asText());
            }
            return json.path("data").path("access_token").asText();
        }
    }

    private JsonNode getUserInfo(String userAccessToken) throws IOException {
        Request request = new Request.Builder()
                .url(FEISHU_USER_INFO_URL)
                .get()
                .addHeader("Authorization", "Bearer " + userAccessToken)
                .build();

        try (Response response = httpClient.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                throw new BusinessException(5002, "获取用户信息失败");
            }
            JsonNode json = objectMapper.readTree(response.body().string());
            if (json.path("code").asInt() != 0) {
                throw new BusinessException(5002, "飞书 API 错误: " + json.path("msg").asText());
            }
            return json.path("data");
        }
    }
}
