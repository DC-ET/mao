package com.agentworkbench.model.controller;

import com.agentworkbench.common.result.Result;
import com.agentworkbench.model.entity.LlmModel;
import com.agentworkbench.model.service.ModelService;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/v1/models")
@RequiredArgsConstructor
public class ModelController {

    private final ModelService modelService;

    @GetMapping
    public Result<Map<String, Object>> listModels(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int size) {
        Page<LlmModel> pageResult = modelService.listModels(page, size);
        List<ModelVO> list = pageResult.getRecords().stream()
                .map(this::toVO)
                .collect(Collectors.toList());
        return Result.ok(Map.of(
                "records", list,
                "total", pageResult.getTotal(),
                "page", pageResult.getCurrent(),
                "size", pageResult.getSize()
        ));
    }

    @GetMapping("/{id}")
    public Result<ModelVO> getModel(@PathVariable Long id) {
        return Result.ok(toVO(modelService.getModel(id)));
    }

    @PostMapping
    public Result<ModelVO> createModel(@RequestBody CreateModelRequest request) {
        LlmModel model = modelService.createModel(
                request.getName(), request.getProvider(), request.getBaseUrl(),
                request.getApiKey(), request.getModelId(),
                request.getSupportsVision());
        return Result.ok(toVO(model));
    }

    @PutMapping("/{id}")
    public Result<ModelVO> updateModel(@PathVariable Long id, @RequestBody CreateModelRequest request) {
        LlmModel model = modelService.updateModel(
                id, request.getName(), request.getProvider(), request.getBaseUrl(),
                request.getApiKey(), request.getModelId(),
                request.getSupportsVision());
        return Result.ok(toVO(model));
    }

    @DeleteMapping("/{id}")
    public Result<Void> deleteModel(@PathVariable Long id) {
        modelService.deleteModel(id);
        return Result.ok();
    }

    @PostMapping("/{id}/test")
    public Result<Void> testConnectivity(@PathVariable Long id) {
        modelService.testConnectivity(id);
        return Result.ok();
    }

    private ModelVO toVO(LlmModel entity) {
        ModelVO vo = new ModelVO();
        vo.setId(entity.getId());
        vo.setName(entity.getName());
        vo.setProvider(entity.getProvider());
        vo.setBaseUrl(entity.getBaseUrl());
        vo.setApiKey(entity.getApiKey());
        vo.setModelId(entity.getModelId());
        vo.setSupportsVision(entity.getSupportsVision() != null && entity.getSupportsVision() == 1);
        vo.setStatus(entity.getStatus());
        vo.setCreatedAt(entity.getCreatedAt() != null ? entity.getCreatedAt().toString() : null);
        return vo;
    }

    @Data
    public static class CreateModelRequest {
        private String name;
        private String provider;
        private String baseUrl;
        private String apiKey;
        private String modelId;
        private Integer supportsVision;
    }

    @Data
    public static class ModelVO {
        private Long id;
        private String name;
        private String provider;
        private String baseUrl;
        private String apiKey;
        private String modelId;
        private Boolean supportsVision;
        private Integer status;
        private String createdAt;
    }
}
