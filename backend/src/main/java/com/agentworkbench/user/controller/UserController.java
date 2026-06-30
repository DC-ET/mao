package com.agentworkbench.user.controller;

import com.agentworkbench.auth.controller.AuthController.UserInfoVO;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.common.result.Result;
import com.agentworkbench.permission.annotation.RequirePermission;
import com.agentworkbench.permission.entity.Role;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.agentworkbench.user.service.UserService;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/v1/users")
@RequiredArgsConstructor
public class UserController {

    private final UserMapper userMapper;
    private final UserService userService;

    @GetMapping("/me")
    public Result<UserInfoVO> getCurrentUser(@AuthenticationPrincipal Long userId) {
        User user = userMapper.selectById(userId);
        if (user == null) {
            throw new BusinessException(ErrorCode.UNAUTHORIZED);
        }
        UserInfoVO vo = new UserInfoVO();
        vo.setId(user.getId());
        vo.setUsername(user.getUsername());
        vo.setDisplayName(user.getDisplayName());
        vo.setEmail(user.getEmail());
        vo.setAvatarUrl(user.getAvatarUrl());
        return Result.ok(vo);
    }

    @GetMapping
    @RequirePermission("user:read")
    public Result<Map<String, Object>> listUsers(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) Integer status) {
        Page<User> pageResult = userService.listUsers(page, size, keyword, status);
        List<User> records = pageResult.getRecords();
        List<Long> userIds = records.stream().map(User::getId).toList();
        Map<Long, List<Role>> roleMap = userService.batchGetUserRoles(userIds);

        List<UserVO> voList = records.stream()
                .map(user -> toVO(user, roleMap.getOrDefault(user.getId(), List.of())))
                .collect(Collectors.toList());

        Map<String, Object> data = new HashMap<>();
        data.put("records", voList);
        data.put("total", pageResult.getTotal());
        return Result.ok(data);
    }

    @GetMapping("/{id}")
    @RequirePermission("user:read")
    public Result<UserVO> getUser(@PathVariable Long id) {
        User user = userService.getUser(id);
        List<Role> roles = userService.getUserRoles(id);
        return Result.ok(toVO(user, roles));
    }

    @PostMapping
    @RequirePermission("user:write")
    public Result<UserVO> createUser(@RequestBody CreateUserRequest request) {
        User user = userService.createUser(
                request.getUsername(),
                request.getDisplayName(),
                request.getEmail(),
                request.getPassword(),
                request.getRoleIds(),
                request.getStatus());
        List<Role> roles = userService.getUserRoles(user.getId());
        return Result.ok(toVO(user, roles));
    }

    @PutMapping("/{id}")
    @RequirePermission("user:write")
    public Result<UserVO> updateUser(
            @PathVariable Long id,
            @RequestBody UpdateUserRequest request) {
        User user = userService.updateUser(
                id,
                request.getDisplayName(),
                request.getEmail(),
                request.getRoleIds(),
                request.getStatus());
        List<Role> roles = userService.getUserRoles(id);
        return Result.ok(toVO(user, roles));
    }

    @PutMapping("/{id}/password")
    @RequirePermission("user:write")
    public Result<Void> resetPassword(
            @PathVariable Long id,
            @RequestBody ResetPasswordRequest request) {
        if (request.getNewPassword() == null
                || !request.getNewPassword().equals(request.getConfirmPassword())) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "两次输入的密码不一致");
        }
        userService.resetPassword(id, request.getNewPassword());
        return Result.ok();
    }

    @PutMapping("/{id}/status")
    @RequirePermission("user:write")
    public Result<Void> updateUserStatus(
            @AuthenticationPrincipal Long currentUserId,
            @PathVariable Long id,
            @RequestBody UpdateStatusRequest request) {
        userService.updateUserStatus(id, request.getStatus(), currentUserId);
        return Result.ok();
    }

    private UserVO toVO(User user, List<Role> roles) {
        UserVO vo = new UserVO();
        vo.setId(user.getId());
        vo.setUsername(user.getUsername());
        vo.setDisplayName(user.getDisplayName());
        vo.setEmail(user.getEmail());
        vo.setAvatarUrl(user.getAvatarUrl());
        vo.setStatus(user.getStatus());
        vo.setAuthSource(userService.resolveAuthSource(user));
        vo.setRoleIds(roles.stream().map(Role::getId).collect(Collectors.toList()));
        vo.setRoleNames(roles.stream().map(Role::getName).collect(Collectors.toList()));
        vo.setLastLoginAt(user.getLastLoginAt() != null ? user.getLastLoginAt().toString() : null);
        vo.setCreatedAt(user.getCreatedAt() != null ? user.getCreatedAt().toString() : null);
        return vo;
    }

    @Data
    public static class CreateUserRequest {
        private String username;
        private String displayName;
        private String email;
        private String password;
        private List<Long> roleIds;
        private Integer status;
    }

    @Data
    public static class UpdateUserRequest {
        private String displayName;
        private String email;
        private List<Long> roleIds;
        private Integer status;
    }

    @Data
    public static class ResetPasswordRequest {
        private String newPassword;
        private String confirmPassword;
    }

    @Data
    public static class UpdateStatusRequest {
        private Integer status; // 1-启用 0-禁用
    }

    @Data
    public static class UserVO {
        private Long id;
        private String username;
        private String displayName;
        private String email;
        private String avatarUrl;
        private Integer status;
        private String authSource;
        private List<Long> roleIds;
        private List<String> roleNames;
        private String lastLoginAt;
        private String createdAt;
    }
}
