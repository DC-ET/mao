package com.agentworkbench.user.controller;

import com.agentworkbench.common.result.Result;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/v1/users")
@RequiredArgsConstructor
public class UserController {

    @GetMapping("/me")
    public Result<UserVO> getCurrentUser(@AuthenticationPrincipal Long userId) {
        // TODO: Get current user info
        return Result.ok();
    }

    @GetMapping
    public Result<List<UserVO>> listUsers(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        // TODO: List users with pagination (admin only)
        return Result.ok();
    }

    @PutMapping("/{id}/status")
    public Result<Void> updateUserStatus(
            @PathVariable Long id,
            @RequestBody UpdateStatusRequest request) {
        // TODO: Enable/disable user (admin only)
        return Result.ok();
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
        private String authType;
        private Integer status;
        private String lastLoginAt;
    }
}
