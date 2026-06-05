package com.agentworkbench.user.controller;

import com.agentworkbench.auth.controller.AuthController.UserInfoVO;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.common.result.Result;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.agentworkbench.user.service.UserService;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
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
    public Result<List<UserVO>> listUsers(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        List<User> users = userService.listUsers(page, size);
        List<UserVO> voList = users.stream().map(this::toVO).collect(Collectors.toList());
        return Result.ok(voList);
    }

    @PutMapping("/{id}/status")
    public Result<Void> updateUserStatus(
            @PathVariable Long id,
            @RequestBody UpdateStatusRequest request) {
        userService.updateUserStatus(id, request.getStatus());
        return Result.ok();
    }

    private UserVO toVO(User user) {
        UserVO vo = new UserVO();
        vo.setId(user.getId());
        vo.setUsername(user.getUsername());
        vo.setDisplayName(user.getDisplayName());
        vo.setEmail(user.getEmail());
        vo.setAvatarUrl(user.getAvatarUrl());
        vo.setStatus(user.getStatus());
        vo.setLastLoginAt(user.getLastLoginAt() != null ? user.getLastLoginAt().toString() : null);
        return vo;
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
        private String lastLoginAt;
    }
}
