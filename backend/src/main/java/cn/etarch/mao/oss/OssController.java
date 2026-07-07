package cn.etarch.mao.oss;

import cn.etarch.mao.common.result.Result;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/v1/oss")
@RequiredArgsConstructor
public class OssController {

    private final OssStsService ossStsService;

    @PostMapping("/sts-token")
    public Result<StsTokenVO> generateStsToken(
            @AuthenticationPrincipal Long userId,
            @RequestBody StsTokenRequest request) {
        return Result.ok(ossStsService.generateStsToken(userId, request.getSessionId()));
    }

    @Data
    public static class StsTokenRequest {
        private Long sessionId;
    }
}
