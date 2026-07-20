package cn.etarch.mao.auth.controller;

import cn.etarch.mao.auth.service.AuthService;
import cn.etarch.mao.auth.service.FeishuAuthService;
import cn.etarch.mao.common.result.Result;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/v1/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;
    private final FeishuAuthService feishuAuthService;

    @PostMapping("/login")
    public Result<LoginVO> login(@RequestBody LoginRequest request) {
        LoginVO loginVO = authService.login(request.getUsername(), request.getPassword());
        return Result.ok(loginVO);
    }

    @GetMapping("/features")
    public Result<AuthFeaturesVO> features() {
        AuthFeaturesVO vo = new AuthFeaturesVO();
        vo.setFeishuEnabled(feishuAuthService.isEnabled());
        return Result.ok(vo);
    }

    @GetMapping("/feishu/qrcode")
    public Result<FeishuQrCodeVO> getFeishuQrCode() {
        return Result.ok(feishuAuthService.getQrCodeUrl());
    }

    @PostMapping("/feishu/callback")
    public Result<LoginVO> feishuCallback(@RequestBody FeishuCallbackRequest request) {
        LoginVO loginVO = feishuAuthService.handleCallback(request.getCode());
        return Result.ok(loginVO);
    }

    @GetMapping(value = "/feishu/callback", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> feishuRedirectCallback(
            @RequestParam(required = false) String code,
            @RequestParam(required = false) String state) {
        return ResponseEntity.ok()
                .contentType(MediaType.TEXT_HTML)
                .body(feishuAuthService.renderCallbackPage(state, code));
    }

    @GetMapping("/feishu/status")
    public Result<FeishuLoginStatusVO> getFeishuLoginStatus(@RequestParam String state) {
        return Result.ok(feishuAuthService.getLoginStatus(state));
    }

    @PostMapping("/refresh")
    public Result<LoginVO> refreshToken(@RequestBody RefreshTokenRequest request) {
        LoginVO loginVO = authService.refreshToken(request.getRefreshToken());
        return Result.ok(loginVO);
    }

    @PostMapping("/logout")
    public Result<Void> logout() {
        authService.logout();
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
        /** Permission codes granted to the user via roles. */
        private List<String> permissions;
    }

    @Data
    public static class FeishuQrCodeVO {
        private String authUrl;
        private String qrCodeUrl;
        private String state;
        private Long expiresIn;
        private Long pollInterval;
    }

    @Data
    public static class FeishuLoginStatusVO {
        private String status;
        private String message;
        private LoginVO login;
    }

    @Data
    public static class AuthFeaturesVO {
        private boolean feishuEnabled;
    }
}
