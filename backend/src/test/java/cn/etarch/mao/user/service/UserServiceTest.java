package cn.etarch.mao.user.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.permission.entity.Role;
import cn.etarch.mao.permission.service.PermissionService;
import cn.etarch.mao.user.entity.User;
import cn.etarch.mao.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SuppressWarnings("unchecked")
class UserServiceTest {

    private final UserMapper userMapper = mock(UserMapper.class);
    private final PermissionService permissionService = mock(PermissionService.class);
    private final PasswordEncoder passwordEncoder = mock(PasswordEncoder.class);
    private final UserService service = new UserService(userMapper, permissionService, passwordEncoder);

    @Test
    void listUsersBuildsPagedQuery() {
        when(userMapper.selectPage(any(Page.class), any(QueryWrapper.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        Page<User> result = service.listUsers(1, 10, " alice ", 1);

        assertThat(result.getCurrent()).isEqualTo(1);
        assertThat(result.getSize()).isEqualTo(10);
        verify(userMapper).selectPage(any(Page.class), any(QueryWrapper.class));
    }

    @Test
    void getUserThrowsWhenMissing() {
        when(userMapper.selectById(99L)).thenReturn(null);

        assertThatThrownBy(() -> service.getUser(99L))
                .isInstanceOf(BusinessException.class);
    }

    @Test
    void createUserValidatesEncodesAndAssignsDefaultRole() {
        when(userMapper.selectCount(any(QueryWrapper.class))).thenReturn(0L);
        when(passwordEncoder.encode("Passw0rd!")).thenReturn("hash");

        User created = service.createUser("  alice_1  ", " Alice ", " a@example.test ", "Passw0rd!", null, null);

        assertThat(created.getUsername()).isEqualTo("alice_1");
        assertThat(created.getDisplayName()).isEqualTo("Alice");
        assertThat(created.getEmail()).isEqualTo("a@example.test");
        assertThat(created.getPasswordHash()).isEqualTo("hash");
        assertThat(created.getStatus()).isEqualTo(1);
        verify(userMapper).insert(created);
        verify(permissionService).assignRoles(created.getId(), List.of(2L));
    }

    @Test
    void createUserRejectsInvalidDuplicateOrWeakCredentials() {
        assertThatThrownBy(() -> service.createUser("x", "X", null, "Passw0rd!", null, null))
                .isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> service.createUser("alice", "X", null, "password", null, null))
                .isInstanceOf(BusinessException.class);

        when(userMapper.selectCount(any(QueryWrapper.class))).thenReturn(1L);
        assertThatThrownBy(() -> service.createUser("alice", "X", null, "Passw0rd!", null, null))
                .isInstanceOf(BusinessException.class);
    }

    @Test
    void updateUserAppliesOptionalFieldsAndRoles() {
        User existing = user(7L, "alice", "Alice", "old@example.test", "hash", 1);
        when(userMapper.selectById(7L)).thenReturn(existing);

        User updated = service.updateUser(7L, " New Name ", "", List.of(1L, 2L), 0);

        assertThat(updated.getDisplayName()).isEqualTo("New Name");
        assertThat(updated.getEmail()).isNull();
        assertThat(updated.getStatus()).isZero();
        verify(permissionService).assertCanChangeRoles(7L, List.of(1L, 2L));
        verify(permissionService).assignRoles(7L, List.of(1L, 2L));
        verify(userMapper).updateById(existing);
    }

    @Test
    void updateUserStatusChecksDisableRules() {
        User existing = user(8L, "bob", "Bob", null, "hash", 1);
        when(userMapper.selectById(8L)).thenReturn(existing);

        service.updateUserStatus(8L, 0, 1L);

        assertThat(existing.getStatus()).isZero();
        verify(permissionService).assertCanDisableUser(8L, 1L);
        verify(userMapper).updateById(existing);
    }

    @Test
    void resetPasswordRejectsLdapUserAndUpdatesLocalUser() {
        User ldap = user(9L, "ldap", "Ldap", null, null, 1);
        when(userMapper.selectById(9L)).thenReturn(ldap);
        assertThatThrownBy(() -> service.resetPassword(9L, "Newpass1"))
                .isInstanceOf(BusinessException.class);

        User local = user(10L, "local", "Local", null, "old", 1);
        when(userMapper.selectById(10L)).thenReturn(local);
        when(passwordEncoder.encode("Newpass1")).thenReturn("new-hash");
        service.resetPassword(10L, "Newpass1");

        assertThat(local.getPasswordHash()).isEqualTo("new-hash");
        verify(userMapper).updateById(local);
    }

    @Test
    void roleLookupMethodsDelegateAndAuthSourceIsDerivedFromPasswordHash() {
        User local = user(1L, "local", "Local", null, "hash", 1);
        User ldap = user(2L, "ldap", "Ldap", null, null, 1);
        Role role = new Role();
        role.setId(1L);
        role.setName("Admin");
        when(permissionService.batchGetUserRoles(List.of(1L))).thenReturn(Map.of(1L, List.of(role)));
        when(permissionService.getUserRoles(1L)).thenReturn(List.of(role));

        assertThat(service.resolveAuthSource(local)).isEqualTo("LOCAL");
        assertThat(service.resolveAuthSource(ldap)).isEqualTo("LDAP");
        assertThat(service.batchGetUserRoles(List.of(1L))).containsKey(1L);
        assertThat(service.getUserRoles(1L)).containsExactly(role);
    }

    @Test
    void createUserWithExplicitRolesUsesProvidedRoles() {
        when(userMapper.selectCount(any(QueryWrapper.class))).thenReturn(0L);
        when(passwordEncoder.encode("Passw0rd!")).thenReturn("hash");

        User created = service.createUser("bob", "Bob", null, "Passw0rd!", List.of(5L), 0);

        assertThat(created.getStatus()).isZero();
        verify(permissionService).assignRoles(created.getId(), List.of(5L));
        verify(userMapper, never()).selectById(any());
    }

    private static User user(Long id, String username, String displayName, String email, String hash, Integer status) {
        User user = new User();
        user.setId(id);
        user.setUsername(username);
        user.setDisplayName(displayName);
        user.setEmail(email);
        user.setPasswordHash(hash);
        user.setStatus(status);
        return user;
    }
}
