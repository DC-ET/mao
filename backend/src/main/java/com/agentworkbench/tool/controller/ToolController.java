package com.agentworkbench.tool.controller;

import com.agentworkbench.common.result.Result;
import com.agentworkbench.tool.entity.ToolEntity;
import com.agentworkbench.tool.service.ToolService;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/v1/tools")
@RequiredArgsConstructor
public class ToolController {

    private final ToolService toolService;

    @GetMapping
    public Result<List<ToolVO>> listTools() {
        List<ToolVO> voList = toolService.listTools().stream()
                .map(this::toVO)
                .collect(Collectors.toList());
        return Result.ok(voList);
    }

    @GetMapping("/{id}")
    public Result<ToolVO> getTool(@PathVariable Long id) {
        return Result.ok(toVO(toolService.getTool(id)));
    }

    @PostMapping
    public Result<ToolVO> createTool(
            @AuthenticationPrincipal Long userId,
            @RequestBody CreateToolRequest request) {
        return Result.ok(toVO(toolService.createTool(request, userId)));
    }

    @PutMapping("/{id}")
    public Result<ToolVO> updateTool(@PathVariable Long id, @RequestBody CreateToolRequest request) {
        return Result.ok(toVO(toolService.updateTool(id, request)));
    }

    @DeleteMapping("/{id}")
    public Result<Void> deleteTool(@PathVariable Long id) {
        toolService.deleteTool(id);
        return Result.ok();
    }

    private ToolVO toVO(ToolEntity entity) {
        ToolVO vo = new ToolVO();
        vo.setId(entity.getId());
        vo.setName(entity.getName());
        vo.setDescription(entity.getDescription());
        vo.setType(entity.getType());
        vo.setStatus(entity.getStatus());
        vo.setCreatedAt(entity.getCreatedAt() != null ? entity.getCreatedAt().toString() : null);
        return vo;
    }

    @Data
    public static class CreateToolRequest {
        private String name;
        private String description;
        private String type;
        private String inputSchema;
        private String outputSchema;
        private String implClass;
    }

    @Data
    public static class ToolVO {
        private Long id;
        private String name;
        private String description;
        private String type;
        private String status;
        private String createdAt;
    }
}
