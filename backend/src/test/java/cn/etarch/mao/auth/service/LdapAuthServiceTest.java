package cn.etarch.mao.auth.service;

import cn.etarch.mao.permission.mapper.UserRoleMapper;
import cn.etarch.mao.user.mapper.UserMapper;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class LdapAuthServiceTest {

    private final LdapAuthService service = new LdapAuthService(
            mock(UserMapper.class), mock(UserRoleMapper.class), mock(JwtService.class));

    @Test
    void isConfiguredRequiresEnabledAndUrl() {
        ReflectionTestUtils.setField(service, "ldapEnabled", false);
        ReflectionTestUtils.setField(service, "ldapUrl", "ldap://example.test:389");
        assertThat(service.isConfigured()).isFalse();

        ReflectionTestUtils.setField(service, "ldapEnabled", true);
        ReflectionTestUtils.setField(service, "ldapUrl", "");
        assertThat(service.isConfigured()).isFalse();

        ReflectionTestUtils.setField(service, "ldapUrl", "ldap://example.test:389");
        assertThat(service.isConfigured()).isTrue();
    }
}
