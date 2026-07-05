package com.agentworkbench.config;

import com.agentworkbench.common.result.Result;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/v1/upload")
@RequiredArgsConstructor
public class UploadController {

    private final UploadProperties uploadProperties;

    @GetMapping("/config")
    public Result<UploadConfigVO> getUploadConfig() {
        UploadConfigVO vo = new UploadConfigVO();
        vo.setStorageMode(uploadProperties.getStorageMode());
        vo.setBaseUrl(uploadProperties.getBaseUrl());
        return Result.ok(vo);
    }

    @Data
    public static class UploadConfigVO {
        private String storageMode;
        private String baseUrl;
    }
}
