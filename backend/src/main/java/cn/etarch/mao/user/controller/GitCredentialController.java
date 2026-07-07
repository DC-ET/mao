package cn.etarch.mao.user.controller;

import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.user.entity.GitCredential;
import cn.etarch.mao.user.service.GitCredentialService;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/v1/user/git-credentials")
@RequiredArgsConstructor
public class GitCredentialController {

    private final GitCredentialService gitCredentialService;

    @GetMapping
    public Result<List<GitCredentialVO>> list(@AuthenticationPrincipal Long userId) {
        List<GitCredential> credentials = gitCredentialService.listByUserId(userId);
        return Result.ok(credentials.stream().map(this::toVO).toList());
    }

    @PostMapping
    public Result<GitCredentialVO> create(@AuthenticationPrincipal Long userId,
                                          @RequestBody CreateGitCredentialRequest request) {
        GitCredential credential = gitCredentialService.create(
                userId, request.getDomain(), request.getAccessToken(), request.getDescription());
        return Result.ok(toVO(credential));
    }

    @PutMapping("/{id}")
    public Result<GitCredentialVO> update(@AuthenticationPrincipal Long userId,
                                            @PathVariable Long id,
                                            @RequestBody UpdateGitCredentialRequest request) {
        GitCredential credential = gitCredentialService.update(
                userId, id, request.getAccessToken(), request.getDescription());
        return Result.ok(toVO(credential));
    }

    @DeleteMapping("/{id}")
    public Result<Void> delete(@AuthenticationPrincipal Long userId, @PathVariable Long id) {
        gitCredentialService.delete(userId, id);
        return Result.ok(null);
    }

    private GitCredentialVO toVO(GitCredential credential) {
        GitCredentialVO vo = new GitCredentialVO();
        vo.setId(credential.getId());
        vo.setDomain(credential.getDomain());
        vo.setAccessToken("****");
        vo.setDescription(credential.getDescription());
        vo.setCreatedAt(credential.getCreatedAt() != null ? credential.getCreatedAt().toString() : null);
        vo.setUpdatedAt(credential.getUpdatedAt() != null ? credential.getUpdatedAt().toString() : null);
        return vo;
    }

    @Data
    public static class GitCredentialVO {
        private Long id;
        private String domain;
        private String accessToken;
        private String description;
        private String createdAt;
        private String updatedAt;
    }

    @Data
    public static class CreateGitCredentialRequest {
        @NotBlank(message = "域名不能为空")
        private String domain;
        @NotBlank(message = "Access Token 不能为空")
        private String accessToken;
        private String description;
    }

    @Data
    public static class UpdateGitCredentialRequest {
        private String accessToken;
        private String description;
    }
}
