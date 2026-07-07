package cn.etarch.mao.auth.service;

import cn.etarch.mao.auth.controller.AuthController.LoginVO;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.user.entity.User;
import cn.etarch.mao.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SuppressWarnings("unchecked")
class AuthServiceTest {

    private final UserMapper userMapper = mock(UserMapper.class);
    private final JwtService jwtService = mock(JwtService.class);
    private final PasswordEncoder passwordEncoder = mock(PasswordEncoder.class);
    private final StringRedisTemplate redisTemplate = mock(StringRedisTemplate.class);
    private final LdapAuthService ldapAuthService = mock(LdapAuthService.class);
    private final AuthService service = new AuthService(
            userMapper, jwtService, passwordEncoder, redisTemplate, ldapAuthService);

    @Test
    void loginWithLocalPasswordUpdatesLastLoginAndReturnsTokens() {
        User user = user(1L, "alice", "hash", 1);
        when(userMapper.selectOne(any(QueryWrapper.class))).thenReturn(user);
        when(passwordEncoder.matches("secret", "hash")).thenReturn(true);
        when(jwtService.generateToken(1L, "alice")).thenReturn("access");
        when(jwtService.generateRefreshToken(1L, "alice")).thenReturn("refresh");

        LoginVO vo = service.login("alice", "secret");

        assertThat(vo.getAccessToken()).isEqualTo("access");
        assertThat(vo.getRefreshToken()).isEqualTo("refresh");
        assertThat(vo.getExpiresIn()).isEqualTo(86400L);
        assertThat(vo.getUser().getUsername()).isEqualTo("alice");
        assertThat(user.getLastLoginAt()).isNotNull();
        verify(userMapper).updateById(user);
    }

    @Test
    void loginRejectsDisabledAccountAndFallsBackToLdap() {
        User disabled = user(2L, "disabled", "hash", 0);
        when(userMapper.selectOne(any(QueryWrapper.class))).thenReturn(disabled);
        when(passwordEncoder.matches("secret", "hash")).thenReturn(true);

        assertThatThrownBy(() -> service.login("disabled", "secret"))
                .isInstanceOf(BusinessException.class);

        LoginVO ldapVo = new LoginVO();
        ldapVo.setAccessToken("ldap-access");
        when(userMapper.selectOne(any(QueryWrapper.class))).thenReturn(null);
        when(ldapAuthService.isConfigured()).thenReturn(true);
        when(ldapAuthService.authenticate("ldap", "secret")).thenReturn(ldapVo);

        assertThat(service.login("ldap", "secret").getAccessToken()).isEqualTo("ldap-access");

        when(ldapAuthService.authenticate("ldap", "bad")).thenThrow(new RuntimeException("bad"));
        assertThatThrownBy(() -> service.login("ldap", "bad"))
                .isInstanceOf(BusinessException.class);
    }

    @Test
    void refreshTokenValidatesAndReturnsNewTokens() {
        User user = user(3L, "bob", "hash", 1);
        when(jwtService.validateToken("refresh")).thenReturn(true);
        when(jwtService.getUserIdFromToken("refresh")).thenReturn(3L);
        when(jwtService.getUsernameFromToken("refresh")).thenReturn("bob");
        when(userMapper.selectById(3L)).thenReturn(user);
        when(jwtService.generateToken(3L, "bob")).thenReturn("new-access");
        when(jwtService.generateRefreshToken(3L, "bob")).thenReturn("new-refresh");

        LoginVO vo = service.refreshToken("refresh");

        assertThat(vo.getAccessToken()).isEqualTo("new-access");
        assertThat(vo.getRefreshToken()).isEqualTo("new-refresh");
        assertThat(vo.getUser().getId()).isEqualTo(3L);

        when(jwtService.validateToken("bad")).thenReturn(false);
        assertThatThrownBy(() -> service.refreshToken("bad"))
                .isInstanceOf(BusinessException.class);

        user.setStatus(0);
        assertThatThrownBy(() -> service.refreshToken("refresh"))
                .isInstanceOf(BusinessException.class);
    }

    @Test
    void logoutBlacklistsValidTokenAndIgnoresRedisFailures() {
        ValueOperations<String, String> ops = mock(ValueOperations.class);
        when(jwtService.validateToken("token")).thenReturn(true);
        when(redisTemplate.opsForValue()).thenReturn(ops);

        service.logout("token");

        verify(ops).set(eq("token:blacklist:token"), eq("1"), eq(24L), eq(TimeUnit.HOURS));

        doThrow(new RuntimeException("redis")).when(ops)
                .set(eq("token:blacklist:token"), eq("1"), eq(24L), eq(TimeUnit.HOURS));
        service.logout("token");
        service.logout(null);
    }

    @Test
    void blacklistLookupReturnsFalseOnRedisFailure() {
        when(redisTemplate.hasKey("token:blacklist:t1")).thenReturn(true);
        assertThat(service.isTokenBlacklisted("t1")).isTrue();

        when(redisTemplate.hasKey("token:blacklist:t2")).thenThrow(new RuntimeException("redis"));
        assertThat(service.isTokenBlacklisted("t2")).isFalse();
    }

    private static User user(Long id, String username, String passwordHash, Integer status) {
        User user = new User();
        user.setId(id);
        user.setUsername(username);
        user.setDisplayName(username);
        user.setEmail(username + "@example.test");
        user.setAvatarUrl("avatar");
        user.setPasswordHash(passwordHash);
        user.setStatus(status);
        return user;
    }
}
