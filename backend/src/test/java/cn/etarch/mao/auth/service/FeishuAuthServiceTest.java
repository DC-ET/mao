package cn.etarch.mao.auth.service;

import cn.etarch.mao.auth.controller.AuthController.FeishuLoginStatusVO;
import cn.etarch.mao.auth.controller.AuthController.FeishuQrCodeVO;
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
import com.fasterxml.jackson.databind.ObjectMapper;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.LocalDateTime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SuppressWarnings("unchecked")
class FeishuAuthServiceTest {

    private final UserMapper userMapper = mock(UserMapper.class);
    private final UserRoleMapper userRoleMapper = mock(UserRoleMapper.class);
    private final FeishuOauthStateMapper stateMapper = mock(FeishuOauthStateMapper.class);
    private final JwtService jwtService = mock(JwtService.class);
    private final FeishuAuthService service = new FeishuAuthService(
            userMapper, userRoleMapper, stateMapper, jwtService, new ObjectMapper());

    @BeforeEach
    void setUp() {
        ReflectionTestUtils.setField(service, "enabled", true);
        ReflectionTestUtils.setField(service, "appId", "app-id");
        ReflectionTestUtils.setField(service, "appSecret", "secret");
    }

    @Test
    void qrcodeRejectsUnconfiguredApp() {
        ReflectionTestUtils.setField(service, "appId", "");

        assertThatThrownBy(service::getQrCodeUrl)
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("飞书应用未配置");
    }

    @Test
    void qrcodeRejectsDisabledLogin() {
        configureFeishu("app-id", "secret", "http://localhost/callback");
        ReflectionTestUtils.setField(service, "enabled", false);

        assertThatThrownBy(service::getQrCodeUrl)
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("飞书登录未启用");
    }

    @Test
    void qrcodeCreatesStateAndReturnsAuthorizeUrl() {
        configureFeishu("app-id", "secret", "http://localhost:9080/api/v1/auth/feishu/callback");
        ReflectionTestUtils.setField(service, "authorizeUrl", "https://open.feishu.test/authorize");

        FeishuQrCodeVO vo = service.getQrCodeUrl();

        ArgumentCaptor<FeishuOauthState> captor = ArgumentCaptor.forClass(FeishuOauthState.class);
        verify(stateMapper).insert(captor.capture());
        assertThat(captor.getValue().getStatus()).isEqualTo("PENDING");
        assertThat(captor.getValue().getExpiresAt()).isAfter(LocalDateTime.now());
        assertThat(vo.getState()).isEqualTo(captor.getValue().getState());
        assertThat(vo.getAuthUrl()).contains("app_id=app-id");
        assertThat(vo.getAuthUrl()).contains("redirect_uri=http%3A%2F%2Flocalhost%3A9080%2Fapi%2Fv1%2Fauth%2Ffeishu%2Fcallback");
        assertThat(vo.getAuthUrl()).contains("state=" + vo.getState());
        assertThat(vo.getQrCodeUrl()).isEqualTo(vo.getAuthUrl());
    }

    @Test
    void statusExpiresPendingState() {
        FeishuOauthState state = state("state-1", "PENDING");
        state.setExpiresAt(LocalDateTime.now().minusSeconds(1));
        when(stateMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(state);

        FeishuLoginStatusVO vo = service.getLoginStatus("state-1");

        assertThat(vo.getStatus()).isEqualTo("EXPIRED");
        verify(stateMapper).update(any(FeishuOauthState.class), any(LambdaUpdateWrapper.class));
    }

    @Test
    void statusConsumesSuccessStateOnceAndReturnsLogin() {
        FeishuOauthState state = state("state-2", "SUCCESS");
        state.setUserId(7L);
        when(stateMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(state);
        when(stateMapper.update(any(FeishuOauthState.class), any(LambdaUpdateWrapper.class))).thenReturn(1);
        when(userMapper.selectById(7L)).thenReturn(user(7L, "feishu_u"));
        when(jwtService.generateToken(7L, "feishu_u")).thenReturn("access");
        when(jwtService.generateRefreshToken(7L, "feishu_u")).thenReturn("refresh");

        FeishuLoginStatusVO vo = service.getLoginStatus("state-2");

        assertThat(vo.getStatus()).isEqualTo("SUCCESS");
        assertThat(vo.getLogin().getAccessToken()).isEqualTo("access");
        assertThat(vo.getLogin().getRefreshToken()).isEqualTo("refresh");
    }

    @Test
    void callbackCompletesStateWithMockedFeishuApis() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(json("{\"code\":0,\"app_access_token\":\"app-token\"}"));
            server.enqueue(json("{\"code\":0,\"data\":{\"access_token\":\"user-token\"}}"));
            server.enqueue(json("{\"code\":0,\"data\":{\"user_id\":\"ou_1\",\"name\":\"Alice\",\"email\":\"a@example.test\",\"avatar_url\":\"avatar\"}}"));
            server.start();

            configureFeishu("app-id", "secret", "http://localhost/callback");
            ReflectionTestUtils.setField(service, "appTokenUrl", server.url("/app-token").toString());
            ReflectionTestUtils.setField(service, "tokenUrl", server.url("/user-token").toString());
            ReflectionTestUtils.setField(service, "userInfoUrl", server.url("/user-info").toString());

            FeishuOauthState state = state("state-3", "PENDING");
            when(stateMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(state);
            when(userMapper.selectOne(any(QueryWrapper.class))).thenReturn(null);
            doAnswer(invocation -> {
                User user = invocation.getArgument(0);
                user.setId(9L);
                return 1;
            }).when(userMapper).insert(any(User.class));

            service.completeStateWithCode("state-3", "code");

            ArgumentCaptor<User> userCaptor = ArgumentCaptor.forClass(User.class);
            verify(userMapper).insert(userCaptor.capture());
            assertThat(userCaptor.getValue().getFeishuUserId()).isEqualTo("ou_1");
            assertThat(userCaptor.getValue().getUsername()).isEqualTo("a");
            verify(userRoleMapper).insert(any(UserRole.class));

            ArgumentCaptor<FeishuOauthState> stateCaptor = ArgumentCaptor.forClass(FeishuOauthState.class);
            verify(stateMapper).update(stateCaptor.capture(), any(LambdaUpdateWrapper.class));
            assertThat(stateCaptor.getValue().getStatus()).isEqualTo("SUCCESS");
            assertThat(stateCaptor.getValue().getUserId()).isEqualTo(9L);
        }
    }

    @Test
    void callbackUsesOpenIdAndEmailPrefixWhenUserIdIsMissing() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(json("{\"code\":0,\"app_access_token\":\"app-token\"}"));
            server.enqueue(json("{\"code\":0,\"data\":{\"access_token\":\"user-token\"}}"));
            server.enqueue(json("{\"code\":0,\"data\":{\"open_id\":\"ou_open\",\"name\":\"Alice\",\"email\":\"alice.smith@example.test\",\"avatar_url\":\"avatar\"}}"));
            server.start();

            configureFeishu("app-id", "secret", "http://localhost/callback");
            ReflectionTestUtils.setField(service, "appTokenUrl", server.url("/app-token").toString());
            ReflectionTestUtils.setField(service, "tokenUrl", server.url("/user-token").toString());
            ReflectionTestUtils.setField(service, "userInfoUrl", server.url("/user-info").toString());

            FeishuOauthState state = state("state-4", "PENDING");
            when(stateMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(state);
            when(userMapper.selectOne(any(QueryWrapper.class))).thenReturn(null);
            doAnswer(invocation -> {
                User user = invocation.getArgument(0);
                user.setId(10L);
                return 1;
            }).when(userMapper).insert(any(User.class));

            service.completeStateWithCode("state-4", "code");

            ArgumentCaptor<User> userCaptor = ArgumentCaptor.forClass(User.class);
            verify(userMapper).insert(userCaptor.capture());
            assertThat(userCaptor.getValue().getFeishuUserId()).isEqualTo("ou_open");
            assertThat(userCaptor.getValue().getUsername()).isEqualTo("alice_smith");
            assertThat(userCaptor.getValue().getEmail()).isEqualTo("alice.smith@example.test");
        }
    }

    private void configureFeishu(String appId, String appSecret, String redirectUri) {
        ReflectionTestUtils.setField(service, "enabled", true);
        ReflectionTestUtils.setField(service, "appId", appId);
        ReflectionTestUtils.setField(service, "appSecret", appSecret);
        ReflectionTestUtils.setField(service, "redirectUri", redirectUri);
    }

    private static FeishuOauthState state(String state, String status) {
        FeishuOauthState oauthState = new FeishuOauthState();
        oauthState.setState(state);
        oauthState.setStatus(status);
        oauthState.setExpiresAt(LocalDateTime.now().plusMinutes(5));
        return oauthState;
    }

    private static User user(Long id, String username) {
        User user = new User();
        user.setId(id);
        user.setUsername(username);
        user.setDisplayName(username);
        user.setEmail(username + "@example.test");
        user.setStatus(1);
        return user;
    }

    private static MockResponse json(String body) {
        return new MockResponse()
                .setHeader("Content-Type", "application/json")
                .setBody(body);
    }
}
