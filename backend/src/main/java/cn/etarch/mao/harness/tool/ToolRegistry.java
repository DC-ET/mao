package cn.etarch.mao.harness.tool;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Component
public class ToolRegistry {

    private final Map<String, Tool> tools = new ConcurrentHashMap<>();

    public ToolRegistry(List<Tool> toolBeans) {
        for (Tool tool : toolBeans) {
            register(tool);
        }
        log.info("ToolRegistry initialized with {} built-in tools: {}", tools.size(), tools.keySet());
    }

    public void register(Tool tool) {
        tools.put(tool.getName(), tool);
        log.info("Registered tool: {}", tool.getName());
    }

    public Tool getTool(String name) {
        return tools.get(name);
    }

    public List<Tool> getAllTools() {
        return List.copyOf(tools.values());
    }

    /**
     * Get tools by names (for per-agent filtering)
     */
    public List<Tool> getToolsByNames(List<String> names) {
        List<Tool> result = new ArrayList<>();
        for (String name : names) {
            Tool tool = tools.get(name);
            if (tool != null) {
                result.add(tool);
            }
        }
        return result;
    }
}
