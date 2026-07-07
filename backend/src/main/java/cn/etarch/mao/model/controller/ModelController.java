package cn.etarch.mao.model.controller;

import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.service.ModelService;
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
            @RequestParam(defaultValue = "10") int size,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String provider,
            @RequestParam(required = false) Integer status,
            @RequestParam(required = false) Integer supportsVision,
            @RequestParam(required = false) Integer isDefault) {
        Page<LlmModel> pageResult = modelService.listModels(
                page, size, keyword, provider, status, supportsVision, isDefault);
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

    @GetMapping("/active")
    public Result<List<ModelVO>> listActiveModels() {
        List<ModelVO> list = modelService.listActiveModels().stream()
                .map(this::toVO)
                .collect(Collectors.toList());
        return Result.ok(list);
    }

    @GetMapping("/providers")
    public Result<List<String>> listProviders() {
        return Result.ok(modelService.listProviders());
    }

    @GetMapping("/default")
    public Result<ModelVO> getDefaultModel() {
        LlmModel model = modelService.getDefaultModel();
        return Result.ok(model != null ? toVO(model) : null);
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
                request.getSupportsVision(), request.getIsDefault(),
                request.getContextWindowTokens());
        return Result.ok(toVO(model));
    }

    @PutMapping("/{id}")
    public Result<ModelVO> updateModel(@PathVariable Long id, @RequestBody CreateModelRequest request) {
        LlmModel model = modelService.updateModel(
                id, request.getName(), request.getProvider(), request.getBaseUrl(),
                request.getApiKey(), request.getModelId(),
                request.getSupportsVision(), request.getIsDefault(),
                request.getContextWindowTokens());
        return Result.ok(toVO(model));
    }

    @DeleteMapping("/{id}")
    public Result<Void> deleteModel(@PathVariable Long id) {
        modelService.deleteModel(id);
        return Result.ok();
    }

    @PatchMapping("/{id}/status")
    public Result<Void> updateStatus(@PathVariable Long id, @RequestBody UpdateStatusRequest request) {
        modelService.updateStatus(id, request.getStatus());
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
        vo.setContextWindowTokens(entity.getContextWindowTokens());
        vo.setSupportsVision(entity.getSupportsVision() != null && entity.getSupportsVision() == 1);
        vo.setIsDefault(entity.getIsDefault() != null && entity.getIsDefault() == 1);
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
        private Integer contextWindowTokens;
        private Integer supportsVision;
        private Integer isDefault;
    }

    @Data
    public static class ModelVO {
        private Long id;
        private String name;
        private String provider;
        private String baseUrl;
        private String apiKey;
        private String modelId;
        private Integer contextWindowTokens;
        private Boolean supportsVision;
        private Boolean isDefault;
        private Integer status;
        private String createdAt;
    }

    @Data
    public static class UpdateStatusRequest {
        private Integer status;
    }
}
