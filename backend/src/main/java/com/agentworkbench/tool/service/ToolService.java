package com.agentworkbench.tool.service;

import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.harness.tool.Tool;
import com.agentworkbench.harness.tool.ToolRegistry;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class ToolService {

    private final ToolRegistry toolRegistry;

    public List<Tool> listTools() {
        return toolRegistry.getAllTools();
    }

    public Tool getTool(String name) {
        Tool tool = toolRegistry.getTool(name);
        if (tool == null) {
            throw new BusinessException(ErrorCode.SKILL_NOT_FOUND);
        }
        return tool;
    }
}
