package com.agentworkbench.user.service;

import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.permission.entity.Role;
import com.agentworkbench.permission.service.PermissionService;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

@Service
@RequiredArgsConstructor
public class UserService {

    private static final Pattern USERNAME_PATTERN = Pattern.compile("^[a-zA-Z0-9_]{3,64}$");
    private static final Pattern PASSWORD_PATTERN = Pattern.compile("^(?=.*[A-Za-z])(?=.*\\d).{8,64}$");
    private static final long DEFAULT_USER_ROLE_ID = 2L;

    private final UserMapper userMapper;
    private final PermissionService permissionService;
    private final PasswordEncoder passwordEncoder;

    public Page<User> listUsers(int page, int size, String keyword, Integer status) {
        Page<User> pageObj = new Page<>(page, size);
        QueryWrapper<User> qw = new QueryWrapper<>();
        if (StringUtils.hasText(keyword)) {
            String kw = keyword.trim();
            qw.and(w -> w.like("username", kw)
                    .or().like("display_name", kw)
                    .or().like("email", kw));
        }
        if (status != null) {
            qw.eq("status", status);
        }
        qw.orderByDesc("created_at");
        userMapper.selectPage(pageObj, qw);
        return pageObj;
    }

    public User getUser(Long id) {
        User user = userMapper.selectById(id);
        if (user == null) {
            throw new BusinessException(ErrorCode.USER_NOT_FOUND);
        }
        return user;
    }

    @Transactional
    public User createUser(String username, String displayName, String email,
                         String password, List<Long> roleIds, Integer status) {
        validateUsername(username);
        validatePassword(password);
        assertUsernameUnique(username);

        User user = new User();
        user.setUsername(username.trim());
        user.setDisplayName(displayName.trim());
        user.setEmail(StringUtils.hasText(email) ? email.trim() : null);
        user.setPasswordHash(passwordEncoder.encode(password));
        user.setStatus(status != null ? status : 1);
        userMapper.insert(user);

        List<Long> roles = (roleIds != null && !roleIds.isEmpty())
                ? roleIds : List.of(DEFAULT_USER_ROLE_ID);
        permissionService.assignRoles(user.getId(), roles);
        return user;
    }

    @Transactional
    public User updateUser(Long id, String displayName, String email,
                           List<Long> roleIds, Integer status) {
        User user = getUser(id);

        if (StringUtils.hasText(displayName)) {
            user.setDisplayName(displayName.trim());
        }
        if (email != null) {
            user.setEmail(StringUtils.hasText(email) ? email.trim() : null);
        }
        if (status != null) {
            user.setStatus(status);
        }
        userMapper.updateById(user);

        if (roleIds != null) {
            permissionService.assertCanChangeRoles(id, roleIds);
            permissionService.assignRoles(id, roleIds);
        }
        return user;
    }

    public void updateUserStatus(Long id, Integer status, Long currentUserId) {
        User user = getUser(id);
        if (status != null && status == 0) {
            permissionService.assertCanDisableUser(id, currentUserId);
        }
        user.setStatus(status);
        userMapper.updateById(user);
    }

    public void resetPassword(Long id, String newPassword) {
        User user = getUser(id);
        if (!StringUtils.hasText(user.getPasswordHash())) {
            throw new BusinessException(ErrorCode.USER_PASSWORD_MANAGED_BY_LDAP);
        }
        validatePassword(newPassword);
        user.setPasswordHash(passwordEncoder.encode(newPassword));
        userMapper.updateById(user);
    }

    public String resolveAuthSource(User user) {
        return StringUtils.hasText(user.getPasswordHash()) ? "LOCAL" : "LDAP";
    }

    public Map<Long, List<Role>> batchGetUserRoles(List<Long> userIds) {
        return permissionService.batchGetUserRoles(userIds);
    }

    public List<Role> getUserRoles(Long userId) {
        return permissionService.getUserRoles(userId);
    }

    private void validateUsername(String username) {
        if (!StringUtils.hasText(username) || !USERNAME_PATTERN.matcher(username.trim()).matches()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "用户名须为 3-64 位字母、数字或下划线");
        }
    }

    private void validatePassword(String password) {
        if (!StringUtils.hasText(password) || !PASSWORD_PATTERN.matcher(password).matches()) {
            throw new BusinessException(ErrorCode.PASSWORD_INVALID);
        }
    }

    private void assertUsernameUnique(String username) {
        Long count = userMapper.selectCount(
                new QueryWrapper<User>().eq("username", username.trim()));
        if (count > 0) {
            throw new BusinessException(ErrorCode.USERNAME_DUPLICATE);
        }
    }
}
