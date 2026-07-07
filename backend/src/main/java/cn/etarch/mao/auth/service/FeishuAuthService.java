package cn.etarch.mao.auth.service;

import cn.etarch.mao.auth.controller.AuthController.*;
import cn.etarch.mao.auth.entity.FeishuOauthState;
import cn.etarch.mao.auth.mapper.FeishuOauthStateMapper;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.permission.entity.UserRole;
import cn.etarch.mao.permission.mapper.UserRoleMapper;
import cn.etarch.mao.user.entity.User;
import cn.etarch.mao.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.net.URLEncoder;
import java.time.LocalDateTime;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

@SuppressWarnings("deprecation")
@Slf4j
@Service
@RequiredArgsConstructor
public class FeishuAuthService {

    private static final String STATUS_PENDING = "PENDING";
    private static final String STATUS_SUCCESS = "SUCCESS";
    private static final String STATUS_FAILED = "FAILED";
    private static final String STATUS_EXPIRED = "EXPIRED";
    private static final long STATE_EXPIRES_SECONDS = 300L;
    private static final long POLL_INTERVAL_SECONDS = 2L;

    private final UserMapper userMapper;
    private final UserRoleMapper userRoleMapper;
    private final FeishuOauthStateMapper feishuOauthStateMapper;
    private final JwtService jwtService;
    private final ObjectMapper objectMapper;

    @Value("${feishu.enabled:false}")
    private boolean enabled;

    @Value("${feishu.app-id:}")
    private String appId;

    @Value("${feishu.app-secret:}")
    private String appSecret;

    @Value("${feishu.redirect-uri:http://localhost:9080/api/v1/auth/feishu/callback}")
    private String redirectUri;

    @Value("${feishu.authorize-url:https://open.feishu.cn/open-apis/authen/v1/authorize}")
    private String authorizeUrl;

    @Value("${feishu.token-url:https://open.feishu.cn/open-apis/authen/v1/oidc/access_token}")
    private String tokenUrl;

    @Value("${feishu.user-info-url:https://open.feishu.cn/open-apis/authen/v1/user_info}")
    private String userInfoUrl;

    @Value("${feishu.app-token-url:https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal}")
    private String appTokenUrl;

    private final OkHttpClient httpClient = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .build();

    public FeishuQrCodeVO getQrCodeUrl() {
        ensureEnabled();
        ensureAppIdConfigured();

        String state = UUID.randomUUID().toString();
        LocalDateTime now = LocalDateTime.now();
        FeishuOauthState oauthState = new FeishuOauthState();
        oauthState.setState(state);
        oauthState.setStatus(STATUS_PENDING);
        oauthState.setExpiresAt(now.plusSeconds(STATE_EXPIRES_SECONDS));
        feishuOauthStateMapper.insert(oauthState);

        String authUrl = buildAuthorizeUrl(state);
        FeishuQrCodeVO vo = new FeishuQrCodeVO();
        vo.setAuthUrl(authUrl);
        vo.setQrCodeUrl(authUrl);
        vo.setState(state);
        vo.setExpiresIn(STATE_EXPIRES_SECONDS);
        vo.setPollInterval(POLL_INTERVAL_SECONDS);
        return vo;
    }

    public LoginVO handleCallback(String code) {
        ensureEnabled();
        ensureFullyConfigured();
        User user = authenticateByCode(code);
        return buildLoginVO(user);
    }

    public void completeStateWithCode(String state, String code) {
        ensureEnabled();
        ensureFullyConfigured();
        if (!StringUtils.hasText(state)) {
            throw new BusinessException(5002, "飞书登录 state 不能为空");
        }
        if (!StringUtils.hasText(code)) {
            markStateFailed(state, "授权码不能为空");
            throw new BusinessException(5002, "授权码不能为空");
        }

        FeishuOauthState oauthState = findState(state);
        if (oauthState == null) {
            throw new BusinessException(5002, "飞书登录二维码不存在");
        }
        if (!STATUS_PENDING.equals(oauthState.getStatus())) {
            throw new BusinessException(5002, "飞书登录二维码状态无效");
        }
        if (isExpired(oauthState)) {
            markStateExpired(state);
            throw new BusinessException(5002, "飞书登录二维码已过期");
        }

        try {
            User user = authenticateByCode(code);
            ensureUserEnabled(user);
            FeishuOauthState update = new FeishuOauthState();
            update.setStatus(STATUS_SUCCESS);
            update.setUserId(user.getId());
            update.setErrorMessage(null);
            feishuOauthStateMapper.update(update,
                    new LambdaUpdateWrapper<FeishuOauthState>()
                            .eq(FeishuOauthState::getState, state)
                            .eq(FeishuOauthState::getStatus, STATUS_PENDING));
        } catch (BusinessException e) {
            markStateFailed(state, e.getMessage());
            throw e;
        } catch (Exception e) {
            log.error("Feishu OAuth state callback failed", e);
            markStateFailed(state, e.getMessage());
            throw new BusinessException(5002, "飞书登录失败: " + e.getMessage());
        }
    }

    public FeishuLoginStatusVO getLoginStatus(String state) {
        FeishuLoginStatusVO vo = new FeishuLoginStatusVO();
        if (!enabled) {
            vo.setStatus(STATUS_FAILED);
            vo.setMessage("飞书登录未启用");
            return vo;
        }
        if (!StringUtils.hasText(state)) {
            vo.setStatus(STATUS_FAILED);
            vo.setMessage("飞书登录 state 不能为空");
            return vo;
        }

        FeishuOauthState oauthState = findState(state);
        if (oauthState == null) {
            vo.setStatus(STATUS_FAILED);
            vo.setMessage("飞书登录二维码不存在");
            return vo;
        }

        if (STATUS_PENDING.equals(oauthState.getStatus()) && isExpired(oauthState)) {
            markStateExpired(state);
            vo.setStatus(STATUS_EXPIRED);
            vo.setMessage("飞书登录二维码已过期");
            return vo;
        }

        if (STATUS_SUCCESS.equals(oauthState.getStatus())) {
            return consumeSuccessState(oauthState);
        }

        vo.setStatus(oauthState.getStatus());
        vo.setMessage(oauthState.getErrorMessage());
        return vo;
    }

    public String renderCallbackPage(String state, String code) {
        try {
            completeStateWithCode(state, code);
            return htmlPage("登录成功", "飞书授权已完成，请回到 Mao 客户端。", true);
        } catch (BusinessException e) {
            return htmlPage("登录失败", e.getMessage(), false);
        }
    }

    public boolean isEnabled() {
        return enabled
                && StringUtils.hasText(appId)
                && !"1234567890".equals(appId);
    }

    private FeishuLoginStatusVO consumeSuccessState(FeishuOauthState oauthState) {
        FeishuLoginStatusVO vo = new FeishuLoginStatusVO();
        LocalDateTime now = LocalDateTime.now();
        FeishuOauthState update = new FeishuOauthState();
        update.setConsumedAt(now);
        int updated = feishuOauthStateMapper.update(update,
                new LambdaUpdateWrapper<FeishuOauthState>()
                        .eq(FeishuOauthState::getState, oauthState.getState())
                        .eq(FeishuOauthState::getStatus, STATUS_SUCCESS)
                        .isNull(FeishuOauthState::getConsumedAt)
                        .gt(FeishuOauthState::getExpiresAt, now));
        if (updated != 1) {
            vo.setStatus(STATUS_EXPIRED);
            vo.setMessage("飞书登录二维码已使用或已过期");
            return vo;
        }

        User user = userMapper.selectById(oauthState.getUserId());
        if (user == null) {
            vo.setStatus(STATUS_FAILED);
            vo.setMessage("登录用户不存在");
            return vo;
        }
        vo.setStatus(STATUS_SUCCESS);
        vo.setLogin(buildLoginVO(user));
        return vo;
    }

    private User authenticateByCode(String code) {
        if (!StringUtils.hasText(code)) {
            throw new BusinessException(5002, "授权码不能为空");
        }
        try {
            String appAccessToken = getAppAccessToken();
            String userAccessToken = getUserAccessToken(code, appAccessToken);
            JsonNode userInfo = getUserInfo(userAccessToken);
            return findOrCreateUser(userInfo);
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            log.error("Feishu OAuth callback failed", e);
            throw new BusinessException(5002, "飞书登录失败: " + e.getMessage());
        }
    }

    private User findOrCreateUser(JsonNode userInfo) {
        String name = text(userInfo, "name");
        String email = text(userInfo, "email");
        String feishuUserId = resolveFeishuUserId(userInfo, email);
        String avatarUrl = userInfo.path("avatar_url").asText();
        LocalDateTime now = LocalDateTime.now();

        User user = userMapper.selectOne(
                new QueryWrapper<User>().eq("feishu_user_id", feishuUserId));

        if (user == null) {
            user = findUserByEmail(email);
        }

        if (user == null) {
            user = new User();
            user.setUsername(buildUniqueUsername(email, feishuUserId));
            user.setDisplayName(StringUtils.hasText(name) ? name : "飞书用户");
            user.setEmail(email);
            user.setAvatarUrl(avatarUrl);
            user.setFeishuUserId(feishuUserId);
            user.setStatus(1);
            user.setLastLoginAt(now);
            userMapper.insert(user);

            UserRole userRole = new UserRole();
            userRole.setUserId(user.getId());
            userRole.setRoleId(2L);
            userRoleMapper.insert(userRole);
        } else {
            ensureUserEnabled(user);
            user.setFeishuUserId(feishuUserId);
            user.setDisplayName(StringUtils.hasText(name) ? name : user.getDisplayName());
            user.setEmail(email);
            user.setAvatarUrl(avatarUrl);
            user.setLastLoginAt(now);
            userMapper.updateById(user);
        }
        return user;
    }

    private String buildUniqueUsername(String email, String fallbackId) {
        String username = buildUsernameFromEmail(email, fallbackId);
        User existing = userMapper.selectOne(new QueryWrapper<User>().eq("username", username));
        if (existing == null) {
            return username;
        }
        String suffix = "_" + UUID.nameUUIDFromBytes((email + fallbackId).getBytes(StandardCharsets.UTF_8))
                .toString()
                .replace("-", "")
                .substring(0, 8);
        int maxPrefixLength = Math.max(1, 64 - suffix.length());
        String prefix = username.length() > maxPrefixLength ? username.substring(0, maxPrefixLength) : username;
        return prefix + suffix;
    }

    private User findUserByEmail(String email) {
        if (!StringUtils.hasText(email)) {
            return null;
        }
        return userMapper.selectOne(new QueryWrapper<User>().eq("email", email));
    }

    private String resolveFeishuUserId(JsonNode userInfo, String email) {
        String id = firstText(userInfo, "user_id", "union_id", "open_id");
        if (StringUtils.hasText(id)) {
            return id;
        }
        if (StringUtils.hasText(email)) {
            return "email_" + UUID.nameUUIDFromBytes(email.toLowerCase(Locale.ROOT).getBytes(StandardCharsets.UTF_8));
        }
        throw new BusinessException(5002, "飞书用户 ID 和邮箱均为空");
    }

    private String buildUsernameFromEmail(String email, String fallbackId) {
        if (StringUtils.hasText(email)) {
            int at = email.indexOf('@');
            String prefix = at > 0 ? email.substring(0, at) : email;
            String normalized = prefix.trim().toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9_]", "_");
            normalized = normalized.replaceAll("_+", "_").replaceAll("^_+|_+$", "");
            if (StringUtils.hasText(normalized)) {
                return normalized.length() > 64 ? normalized.substring(0, 64) : normalized;
            }
        }
        String username = "feishu_" + fallbackId.replaceAll("[^A-Za-z0-9_]", "_");
        return username.length() > 64 ? username.substring(0, 64) : username;
    }

    private String firstText(JsonNode node, String... fields) {
        for (String field : fields) {
            String value = text(node, field);
            if (StringUtils.hasText(value)) {
                return value;
            }
        }
        return "";
    }

    private String text(JsonNode node, String field) {
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull()) {
            return "";
        }
        return value.asText("").trim();
    }

    private LoginVO buildLoginVO(User user) {
        ensureUserEnabled(user);

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
    }

    private void ensureUserEnabled(User user) {
        if (user.getStatus() != null && user.getStatus() == 0) {
            throw new BusinessException(5002, "账号已禁用");
        }
    }

    private String buildAuthorizeUrl(String state) {
        return authorizeUrl
                + "?app_id=" + urlEncode(appId)
                + "&redirect_uri=" + urlEncode(redirectUri)
                + "&state=" + urlEncode(state);
    }

    private String getAppAccessToken() throws IOException {
        RequestBody body = RequestBody.create(
                MediaType.parse("application/json"),
                String.format("{\"app_id\":\"%s\",\"app_secret\":\"%s\"}", appId, appSecret));

        Request request = new Request.Builder()
                .url(appTokenUrl)
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
                .url(tokenUrl)
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
                .url(userInfoUrl)
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

    private FeishuOauthState findState(String state) {
        return feishuOauthStateMapper.selectOne(
                new LambdaQueryWrapper<FeishuOauthState>()
                        .eq(FeishuOauthState::getState, state));
    }

    private boolean isExpired(FeishuOauthState oauthState) {
        return oauthState.getExpiresAt() == null || !oauthState.getExpiresAt().isAfter(LocalDateTime.now());
    }

    private void markStateExpired(String state) {
        FeishuOauthState update = new FeishuOauthState();
        update.setStatus(STATUS_EXPIRED);
        update.setErrorMessage("飞书登录二维码已过期");
        feishuOauthStateMapper.update(update,
                new LambdaUpdateWrapper<FeishuOauthState>()
                        .eq(FeishuOauthState::getState, state)
                        .eq(FeishuOauthState::getStatus, STATUS_PENDING));
    }

    private void markStateFailed(String state, String message) {
        FeishuOauthState update = new FeishuOauthState();
        update.setStatus(STATUS_FAILED);
        update.setErrorMessage(StringUtils.hasText(message) ? message : "飞书登录失败");
        feishuOauthStateMapper.update(update,
                new LambdaUpdateWrapper<FeishuOauthState>()
                        .eq(FeishuOauthState::getState, state)
                        .eq(FeishuOauthState::getStatus, STATUS_PENDING));
    }

    private void ensureAppIdConfigured() {
        if (!StringUtils.hasText(appId) || "1234567890".equals(appId)) {
            throw new BusinessException(5001, "飞书应用未配置");
        }
    }

    private void ensureEnabled() {
        if (!enabled) {
            throw new BusinessException(5001, "飞书登录未启用");
        }
    }

    private void ensureFullyConfigured() {
        ensureAppIdConfigured();
        if (!StringUtils.hasText(appSecret) || "1234567890".equals(appSecret)) {
            throw new BusinessException(5001, "飞书应用未配置");
        }
    }

    private String htmlPage(String title, String message, boolean success) {
        String color = success ? "#16a34a" : "#dc2626";
        return """
                <!doctype html>
                <html lang="zh-CN">
                <head>
                  <meta charset="utf-8">
                  <meta name="viewport" content="width=device-width, initial-scale=1">
                  <title>%s</title>
                  <style>
                    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f7f9; color: #1f2937; }
                    main { width: min(420px, calc(100vw - 40px)); padding: 32px; border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; text-align: center; box-shadow: 0 10px 30px rgba(15, 23, 42, .08); }
                    h1 { margin: 0 0 12px; color: %s; font-size: 24px; }
                    p { margin: 0; line-height: 1.7; }
                  </style>
                </head>
                <body><main><h1>%s</h1><p>%s</p></main></body>
                </html>
                """.formatted(escapeHtml(title), color, escapeHtml(title), escapeHtml(message));
    }

    private String escapeHtml(String value) {
        if (value == null) {
            return "";
        }
        return value
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&#39;");
    }

    private String urlEncode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
