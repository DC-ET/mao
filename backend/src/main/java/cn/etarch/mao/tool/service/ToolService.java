package cn.etarch.mao.tool.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.harness.tool.Tool;
import cn.etarch.mao.harness.tool.ToolRegistry;
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
