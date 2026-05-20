package com.agentworkbench.auth.controller;

import com.agentworkbench.auth.service.JwtService;
import com.agentworkbench.common.result.Result;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/v1/auth")
@RequiredArgsConstructor
public class AuthController {

    private final JwtService jwtService;

    @PostMapping("/login")
    public Result<LoginVO> login(@RequestBody LoginRequest request) {
        // TODO: Implement LDAP authentication
        // 1. Validate credentials against LDAP
        // 2. Find or create user in local DB
        // 3. Generate JWT token
        return Result.ok();
    }

    @PostMapping("/feishu/qrcode")
    public Result<FeishuQrCodeVO> getFeishuQrCode() {
        // TODO: Generate Feishu OAuth QR code URL
        return Result.ok();
    }

    @PostMapping("/feishu/callback")
    public Result<LoginVO> feishuCallback(@RequestBody FeishuCallbackRequest request) {
        // TODO: Handle Feishu OAuth callback
        return Result.ok();
    }

    @PostMapping("/refresh")
    public Result<LoginVO> refreshToken(@RequestBody RefreshTokenRequest request) {
        // TODO: Refresh JWT token
        return Result.ok();
    }

    @PostMapping("/logout")
    public Result<Void> logout() {
        // TODO: Invalidate token (add to Redis blacklist)
        return Result.ok();
    }

    // Request/Response DTOs

    @Data
    public static class LoginRequest {
        @NotBlank(message = "用户名不能为空")
        private String username;
        @NotBlank(message = "密码不能为空")
        private String password;
    }

    @Data
    public static class FeishuCallbackRequest {
        @NotBlank(message = "授权码不能为空")
        private String code;
    }

    @Data
    public static class RefreshTokenRequest {
        @NotBlank(message = "Refresh Token 不能为空")
        private String refreshToken;
    }

    @Data
    public static class LoginVO {
        private String accessToken;
        private String refreshToken;
        private Long expiresIn;
        private UserInfoVO user;
    }

    @Data
    public static class UserInfoVO {
        private Long id;
        private String username;
        private String displayName;
        private String email;
        private String avatarUrl;
    }

    @Data
    public static class FeishuQrCodeVO {
        private String qrCodeUrl;
        private String state;
    }
}
