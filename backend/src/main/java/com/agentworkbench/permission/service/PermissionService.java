package com.agentworkbench.permission.service;

import com.agentworkbench.permission.entity.Permission;
import com.agentworkbench.permission.entity.Role;
import com.agentworkbench.permission.entity.RolePermission;
import com.agentworkbench.permission.entity.UserRole;
import com.agentworkbench.permission.mapper.PermissionMapper;
import com.agentworkbench.permission.mapper.RoleMapper;
import com.agentworkbench.permission.mapper.RolePermissionMapper;
import com.agentworkbench.permission.mapper.UserRoleMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

@Service
@RequiredArgsConstructor
public class PermissionService {

    private final RoleMapper roleMapper;
    private final PermissionMapper permissionMapper;
    private final RolePermissionMapper rolePermissionMapper;
    private final UserRoleMapper userRoleMapper;
    private final UserMapper userMapper;

    public List<Role> listRoles() {
        return roleMapper.selectList(null);
    }

    public Role getRole(Long id) {
        return roleMapper.selectById(id);
    }

    public Role createRole(String name, String code, String description) {
        Role role = new Role();
        role.setName(name);
        role.setCode(code);
        role.setDescription(description);
        roleMapper.insert(role);
        return role;
    }

    public Role updateRole(Long id, String name, String description) {
        Role role = roleMapper.selectById(id);
        if (role == null) return null;
        if (name != null) role.setName(name);
        if (description != null) role.setDescription(description);
        roleMapper.updateById(role);
        return role;
    }

    public List<Permission> listPermissions() {
        return permissionMapper.selectList(null);
    }

    public List<Long> getRolePermissionIds(Long roleId) {
        return rolePermissionMapper.selectList(
                        new QueryWrapper<RolePermission>().eq("role_id", roleId))
                .stream()
                .map(RolePermission::getPermissionId)
                .toList();
    }

    public Long countRoleUsers(Long roleId) {
        return userRoleMapper.selectCount(new QueryWrapper<UserRole>().eq("role_id", roleId));
    }

    @Transactional
    public void assignPermissions(Long roleId, List<Long> permissionIds) {
        rolePermissionMapper.delete(
                new QueryWrapper<RolePermission>().eq("role_id", roleId));
        for (Long permId : permissionIds) {
            RolePermission rp = new RolePermission();
            rp.setRoleId(roleId);
            rp.setPermissionId(permId);
            rolePermissionMapper.insert(rp);
        }
    }

    @Transactional
    public void assignRoles(Long userId, List<Long> roleIds) {
        if (roleIds == null || roleIds.isEmpty()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "至少分配一个角色");
        }
        userRoleMapper.delete(
                new QueryWrapper<UserRole>().eq("user_id", userId));
        for (Long roleId : roleIds) {
            UserRole ur = new UserRole();
            ur.setUserId(userId);
            ur.setRoleId(roleId);
            userRoleMapper.insert(ur);
        }
    }

    public List<Long> getUserRoleIds(Long userId) {
        return userRoleMapper.selectList(
                        new QueryWrapper<UserRole>().eq("user_id", userId))
                .stream()
                .map(UserRole::getRoleId)
                .toList();
    }

    public List<Role> getUserRoles(Long userId) {
        List<Long> roleIds = getUserRoleIds(userId);
        if (roleIds.isEmpty()) {
            return List.of();
        }
        return roleMapper.selectBatchIds(roleIds);
    }

    public Map<Long, List<Role>> batchGetUserRoles(List<Long> userIds) {
        if (userIds == null || userIds.isEmpty()) {
            return Map.of();
        }
        List<UserRole> userRoles = userRoleMapper.selectList(
                new QueryWrapper<UserRole>().in("user_id", userIds));
        if (userRoles.isEmpty()) {
            return Map.of();
        }

        List<Long> roleIds = userRoles.stream().map(UserRole::getRoleId).distinct().toList();
        Map<Long, Role> roleMap = new HashMap<>();
        for (Role role : roleMapper.selectBatchIds(roleIds)) {
            roleMap.put(role.getId(), role);
        }

        Map<Long, List<Role>> result = new HashMap<>();
        for (UserRole userRole : userRoles) {
            Role role = roleMap.get(userRole.getRoleId());
            if (role != null) {
                result.computeIfAbsent(userRole.getUserId(), ignored -> new ArrayList<>()).add(role);
            }
        }
        return result;
    }

    public void assertCanDisableUser(Long targetUserId, Long currentUserId) {
        if (Objects.equals(targetUserId, currentUserId)) {
            throw new BusinessException(ErrorCode.CANNOT_DISABLE_SELF);
        }
        Role adminRole = getAdminRole();
        if (adminRole == null || !userHasRole(targetUserId, adminRole.getId())) {
            return;
        }
        if (countOtherActiveAdmins(adminRole.getId(), targetUserId) == 0) {
            throw new BusinessException(ErrorCode.CANNOT_REMOVE_LAST_ADMIN);
        }
    }

    public void assertCanChangeRoles(Long userId, List<Long> newRoleIds) {
        Role adminRole = getAdminRole();
        if (adminRole == null) {
            return;
        }
        boolean hadAdmin = userHasRole(userId, adminRole.getId());
        boolean willHaveAdmin = newRoleIds.contains(adminRole.getId());
        if (hadAdmin && !willHaveAdmin && countOtherActiveAdmins(adminRole.getId(), userId) == 0) {
            throw new BusinessException(ErrorCode.CANNOT_REMOVE_LAST_ADMIN);
        }
    }

    private Role getAdminRole() {
        return roleMapper.selectOne(new QueryWrapper<Role>().eq("code", "ADMIN"));
    }

    private boolean userHasRole(Long userId, Long roleId) {
        Long count = userRoleMapper.selectCount(
                new QueryWrapper<UserRole>()
                        .eq("user_id", userId)
                        .eq("role_id", roleId));
        return count > 0;
    }

    private long countOtherActiveAdmins(Long adminRoleId, Long excludeUserId) {
        List<UserRole> adminBindings = userRoleMapper.selectList(
                new QueryWrapper<UserRole>().eq("role_id", adminRoleId));
        return adminBindings.stream()
                .map(UserRole::getUserId)
                .filter(userId -> !Objects.equals(userId, excludeUserId))
                .map(userMapper::selectById)
                .filter(user -> user != null && user.getStatus() != null && user.getStatus() == 1)
                .count();
    }

    /**
     * Check if a user has a specific permission
     */
    public boolean hasPermission(Long userId, String permissionCode) {
        // Get user's roles
        List<UserRole> userRoles = userRoleMapper.selectList(
                new QueryWrapper<UserRole>().eq("user_id", userId));
        if (userRoles.isEmpty()) return false;

        List<Long> roleIds = userRoles.stream().map(UserRole::getRoleId).toList();

        // Get permissions for those roles
        List<RolePermission> rolePerms = rolePermissionMapper.selectList(
                new QueryWrapper<RolePermission>().in("role_id", roleIds));
        if (rolePerms.isEmpty()) return false;

        List<Long> permIds = rolePerms.stream().map(RolePermission::getPermissionId).toList();

        // Check if the permission code exists
        Long count = permissionMapper.selectCount(
                new QueryWrapper<Permission>()
                        .in("id", permIds)
                        .eq("code", permissionCode));
        return count > 0;
    }

    /**
     * Get all permission codes for a user
     */
    public List<String> getUserPermissionCodes(Long userId) {
        List<UserRole> userRoles = userRoleMapper.selectList(
                new QueryWrapper<UserRole>().eq("user_id", userId));
        if (userRoles.isEmpty()) return List.of();

        List<Long> roleIds = userRoles.stream().map(UserRole::getRoleId).toList();

        List<RolePermission> rolePerms = rolePermissionMapper.selectList(
                new QueryWrapper<RolePermission>().in("role_id", roleIds));
        if (rolePerms.isEmpty()) return List.of();

        List<Long> permIds = rolePerms.stream().map(RolePermission::getPermissionId).toList();

        List<Permission> permissions = permissionMapper.selectBatchIds(permIds);
        return permissions.stream().map(Permission::getCode).toList();
    }
}
