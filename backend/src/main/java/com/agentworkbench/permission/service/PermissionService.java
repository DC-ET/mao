package com.agentworkbench.permission.service;

import com.agentworkbench.permission.entity.Permission;
import com.agentworkbench.permission.entity.Role;
import com.agentworkbench.permission.entity.RolePermission;
import com.agentworkbench.permission.entity.UserRole;
import com.agentworkbench.permission.mapper.PermissionMapper;
import com.agentworkbench.permission.mapper.RoleMapper;
import com.agentworkbench.permission.mapper.RolePermissionMapper;
import com.agentworkbench.permission.mapper.UserRoleMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
public class PermissionService {

    private final RoleMapper roleMapper;
    private final PermissionMapper permissionMapper;
    private final RolePermissionMapper rolePermissionMapper;
    private final UserRoleMapper userRoleMapper;

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
        userRoleMapper.delete(
                new QueryWrapper<UserRole>().eq("user_id", userId));
        for (Long roleId : roleIds) {
            UserRole ur = new UserRole();
            ur.setUserId(userId);
            ur.setRoleId(roleId);
            userRoleMapper.insert(ur);
        }
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
