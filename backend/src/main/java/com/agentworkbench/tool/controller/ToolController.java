package com.agentworkbench.tool.controller;

import com.agentworkbench.common.result.Result;
import com.agentworkbench.harness.tool.Tool;
import com.agentworkbench.tool.service.ToolService;
import lombok.Data;
import lombok.RequiredArgsConstructor;
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

    @GetMapping("/{name}")
    public Result<ToolVO> getTool(@PathVariable String name) {
        return Result.ok(toVO(toolService.getTool(name)));
    }

    private ToolVO toVO(Tool tool) {
        ToolVO vo = new ToolVO();
        vo.setName(tool.getName());
        vo.setDescription(tool.getDescription());
        return vo;
    }

    @Data
    public static class ToolVO {
        private String name;
        private String description;
    }
}
