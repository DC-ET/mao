package com.agentworkbench.auth.service;

import com.agentworkbench.auth.controller.AuthController.*;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.concurrent.TimeUnit;

@Slf4j
@Service
@RequiredArgsConstructor
public class AuthService {

    private final UserMapper userMapper;
    private final JwtService jwtService;
    private final PasswordEncoder passwordEncoder;
    private final StringRedisTemplate redisTemplate;
    private final LdapAuthService ldapAuthService;

    private static final String TOKEN_BLACKLIST_PREFIX = "token:blacklist:";

    public LoginVO login(String username, String password) {
        User user = userMapper.selectOne(
                new QueryWrapper<User>().eq("username", username));

        // 本地密码验证
        if (user != null && user.getPasswordHash() != null
                && passwordEncoder.matches(password, user.getPasswordHash())) {
            return buildLoginResult(user);
        }

        // LDAP 回退验证
        if (ldapAuthService != null && ldapAuthService.isConfigured()) {
            try {
                return ldapAuthService.authenticate(username, password);
            } catch (Exception ignored) {
            }
        }

        throw new BusinessException(ErrorCode.LOGIN_FAILED);
    }

    private LoginVO buildLoginResult(User user) {
        if (user.getStatus() != null && user.getStatus() == 0) {
            throw new BusinessException(ErrorCode.ACCOUNT_DISABLED);
        }

        user.setLastLoginAt(LocalDateTime.now());
        userMapper.updateById(user);

        String accessToken = jwtService.generateToken(user.getId(), user.getUsername());
        String refreshToken = jwtService.generateRefreshToken(user.getId(), user.getUsername());

        LoginVO vo = new LoginVO();
        vo.setAccessToken(accessToken);
        vo.setRefreshToken(refreshToken);
        vo.setExpiresIn(86400L);

        UserInfoVO userInfo = new UserInfoVO();
        userInfo.setId(user.getId());
        userInfo.setUsername(user.getUsername());
        userInfo.setDisplayName(user.getDisplayName());
        userInfo.setEmail(user.getEmail());
        userInfo.setAvatarUrl(user.getAvatarUrl());
        vo.setUser(userInfo);

        return vo;
    }

    public LoginVO refreshToken(String refreshToken) {
        if (!jwtService.validateToken(refreshToken)) {
            throw new BusinessException(ErrorCode.TOKEN_EXPIRED);
        }

        Long userId = jwtService.getUserIdFromToken(refreshToken);
        String username = jwtService.getUsernameFromToken(refreshToken);

        User user = userMapper.selectById(userId);
        if (user == null || (user.getStatus() != null && user.getStatus() == 0)) {
            throw new BusinessException(ErrorCode.ACCOUNT_DISABLED);
        }

        String newAccessToken = jwtService.generateToken(userId, username);
        String newRefreshToken = jwtService.generateRefreshToken(userId, username);

        LoginVO vo = new LoginVO();
        vo.setAccessToken(newAccessToken);
        vo.setRefreshToken(newRefreshToken);
        vo.setExpiresIn(86400L);

        UserInfoVO userInfo = new UserInfoVO();
        userInfo.setId(user.getId());
        userInfo.setUsername(user.getUsername());
        userInfo.setDisplayName(user.getDisplayName());
        userInfo.setEmail(user.getEmail());
        userInfo.setAvatarUrl(user.getAvatarUrl());
        vo.setUser(userInfo);

        return vo;
    }

    public void logout(String accessToken) {
        if (accessToken != null && jwtService.validateToken(accessToken)) {
            // Blacklist the token until its natural expiration
            try {
                redisTemplate.opsForValue().set(
                        TOKEN_BLACKLIST_PREFIX + accessToken, "1",
                        24, TimeUnit.HOURS);
            } catch (Exception e) {
                log.warn("Failed to blacklist token in Redis", e);
            }
        }
    }

    public boolean isTokenBlacklisted(String token) {
        try {
            return Boolean.TRUE.equals(
                    redisTemplate.hasKey(TOKEN_BLACKLIST_PREFIX + token));
        } catch (Exception e) {
            return false;
        }
    }
}
