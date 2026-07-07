package com.agentworkbench.permission.service;

import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.permission.entity.Permission;
import com.agentworkbench.permission.entity.Role;
import com.agentworkbench.permission.entity.RolePermission;
import com.agentworkbench.permission.entity.UserRole;
import com.agentworkbench.permission.mapper.PermissionMapper;
import com.agentworkbench.permission.mapper.RoleMapper;
import com.agentworkbench.permission.mapper.RolePermissionMapper;
import com.agentworkbench.permission.mapper.UserRoleMapper;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SuppressWarnings("unchecked")
class PermissionServiceTest {

    private final RoleMapper roleMapper = mock(RoleMapper.class);
    private final PermissionMapper permissionMapper = mock(PermissionMapper.class);
    private final RolePermissionMapper rolePermissionMapper = mock(RolePermissionMapper.class);
    private final UserRoleMapper userRoleMapper = mock(UserRoleMapper.class);
    private final UserMapper userMapper = mock(UserMapper.class);
    private final PermissionService service = new PermissionService(
            roleMapper, permissionMapper, rolePermissionMapper, userRoleMapper, userMapper);

    @Test
    void roleAndPermissionCrudDelegatesToMappers() {
        Role role = role(1L, "Admin", "ADMIN");
        Permission permission = permission(2L, "user:read");
        when(roleMapper.selectList(null)).thenReturn(List.of(role));
        when(roleMapper.selectById(1L)).thenReturn(role);
        when(permissionMapper.selectList(null)).thenReturn(List.of(permission));

        assertThat(service.listRoles()).containsExactly(role);
        assertThat(service.getRole(1L)).isSameAs(role);
        assertThat(service.listPermissions()).containsExactly(permission);

        Role created = service.createRole("Operator", "OP", "desc");
        assertThat(created.getCode()).isEqualTo("OP");
        verify(roleMapper).insert(created);

        Role updated = service.updateRole(1L, "Root", "new");
        assertThat(updated.getName()).isEqualTo("Root");
        assertThat(updated.getDescription()).isEqualTo("new");
        verify(roleMapper).updateById(role);

        when(roleMapper.selectById(99L)).thenReturn(null);
        assertThat(service.updateRole(99L, "x", "x")).isNull();
    }

    @Test
    void assignPermissionsAndRolesReplaceExistingBindings() {
        service.assignPermissions(1L, List.of(10L, 11L));
        verify(rolePermissionMapper).delete(any(QueryWrapper.class));
        verify(rolePermissionMapper, times(2)).insert(any(RolePermission.class));

        service.assignRoles(2L, List.of(1L, 3L));
        verify(userRoleMapper).delete(any(QueryWrapper.class));
        verify(userRoleMapper, times(2)).insert(any(UserRole.class));

        assertThatThrownBy(() -> service.assignRoles(2L, List.of()))
                .isInstanceOf(BusinessException.class);
    }

    @Test
    void userRoleLookupHandlesEmptyAndPopulatedBindings() {
        when(userRoleMapper.selectList(any(QueryWrapper.class)))
                .thenReturn(List.of(userRole(7L, 1L), userRole(7L, 2L)));
        when(roleMapper.selectBatchIds(List.of(1L, 2L))).thenReturn(List.of(role(1L, "Admin", "ADMIN")));

        assertThat(service.getUserRoleIds(7L)).containsExactly(1L, 2L);
        assertThat(service.getUserRoles(7L)).extracting(Role::getName).containsExactly("Admin");

        assertThat(service.batchGetUserRoles(null)).isEmpty();
        assertThat(service.batchGetUserRoles(List.of())).isEmpty();
    }

    @Test
    void batchGetUserRolesGroupsKnownRolesByUser() {
        when(userRoleMapper.selectList(any(QueryWrapper.class)))
                .thenReturn(List.of(userRole(7L, 1L), userRole(8L, 2L)));
        when(roleMapper.selectBatchIds(List.of(1L, 2L)))
                .thenReturn(List.of(role(1L, "Admin", "ADMIN"), role(2L, "User", "USER")));

        Map<Long, List<Role>> roles = service.batchGetUserRoles(List.of(7L, 8L));

        assertThat(roles).containsKeys(7L, 8L);
        assertThat(roles.get(7L)).extracting(Role::getCode).containsExactly("ADMIN");
        assertThat(roles.get(8L)).extracting(Role::getCode).containsExactly("USER");
    }

    @Test
    void disableAndRoleChangeRulesProtectLastAdmin() {
        Role admin = role(1L, "Admin", "ADMIN");
        User activeAdmin = new User();
        activeAdmin.setId(20L);
        activeAdmin.setStatus(1);
        when(roleMapper.selectOne(any(QueryWrapper.class))).thenReturn(admin);
        when(userRoleMapper.selectCount(any(QueryWrapper.class))).thenReturn(1L);
        when(userRoleMapper.selectList(any(QueryWrapper.class))).thenReturn(List.of(userRole(10L, 1L)));

        assertThatThrownBy(() -> service.assertCanDisableUser(10L, 10L))
                .isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> service.assertCanDisableUser(10L, 99L))
                .isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> service.assertCanChangeRoles(10L, List.of(2L)))
                .isInstanceOf(BusinessException.class);

        when(userRoleMapper.selectList(any(QueryWrapper.class))).thenReturn(List.of(userRole(10L, 1L), userRole(20L, 1L)));
        when(userMapper.selectById(20L)).thenReturn(activeAdmin);
        service.assertCanDisableUser(10L, 99L);
        service.assertCanChangeRoles(10L, List.of(2L));
    }

    @Test
    void permissionChecksReturnFalseForMissingBindingsAndTrueForMatchingCode() {
        when(userRoleMapper.selectList(any(QueryWrapper.class))).thenReturn(List.of());
        assertThat(service.hasPermission(1L, "user:read")).isFalse();
        assertThat(service.getUserPermissionCodes(1L)).isEmpty();

        when(userRoleMapper.selectList(any(QueryWrapper.class))).thenReturn(List.of(userRole(1L, 2L)));
        when(rolePermissionMapper.selectList(any(QueryWrapper.class))).thenReturn(List.of(rolePermission(2L, 10L)));
        when(permissionMapper.selectCount(any(QueryWrapper.class))).thenReturn(1L);
        when(permissionMapper.selectBatchIds(List.of(10L))).thenReturn(List.of(permission(10L, "user:read")));

        assertThat(service.hasPermission(1L, "user:read")).isTrue();
        assertThat(service.getUserPermissionCodes(1L)).containsExactly("user:read");
    }

    @Test
    void noAdminRoleMeansProtectionChecksAreNoops() {
        when(roleMapper.selectOne(any(QueryWrapper.class))).thenReturn(null);
        service.assertCanDisableUser(1L, 2L);
        service.assertCanChangeRoles(1L, List.of());
        verify(userRoleMapper, never()).selectCount(any());
    }

    private static Role role(Long id, String name, String code) {
        Role role = new Role();
        role.setId(id);
        role.setName(name);
        role.setCode(code);
        return role;
    }

    private static Permission permission(Long id, String code) {
        Permission permission = new Permission();
        permission.setId(id);
        permission.setCode(code);
        return permission;
    }

    private static UserRole userRole(Long userId, Long roleId) {
        UserRole userRole = new UserRole();
        userRole.setUserId(userId);
        userRole.setRoleId(roleId);
        return userRole;
    }

    private static RolePermission rolePermission(Long roleId, Long permissionId) {
        RolePermission rolePermission = new RolePermission();
        rolePermission.setRoleId(roleId);
        rolePermission.setPermissionId(permissionId);
        return rolePermission;
    }
}
