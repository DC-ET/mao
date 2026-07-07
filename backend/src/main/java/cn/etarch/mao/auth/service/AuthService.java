package cn.etarch.mao.auth.service;

import cn.etarch.mao.auth.controller.AuthController.*;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.user.entity.User;
import cn.etarch.mao.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;

@Service
@RequiredArgsConstructor
public class AuthService {

    private final UserMapper userMapper;
    private final JwtService jwtService;
    private final PasswordEncoder passwordEncoder;
    private final LdapAuthService ldapAuthService;

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

    public void logout() {
        // Stateless JWT logout is handled client-side by discarding the token.
    }
}
