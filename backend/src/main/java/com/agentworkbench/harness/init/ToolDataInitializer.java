package com.agentworkbench.harness.init;

import com.agentworkbench.harness.tool.Tool;
import com.agentworkbench.harness.tool.ToolRegistry;
import com.agentworkbench.tool.entity.ToolEntity;
import com.agentworkbench.tool.mapper.ToolEntityMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import org.springframework.dao.DuplicateKeyException;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Auto-register built-in tools into the database on startup.
 * Skips tools that already exist (by name).
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ToolDataInitializer implements CommandLineRunner {

    private final ToolRegistry toolRegistry;
    private final ToolEntityMapper toolEntityMapper;
    private final ObjectMapper objectMapper;

    @Override
    public void run(String... args) {
        log.info("ToolDataInitializer: starting tool registration...");
        List<Tool> allTools = toolRegistry.getAllTools();
        log.info("ToolDataInitializer: found {} tools in registry", allTools.size());
        int created = 0;

        for (Tool tool : allTools) {
            if (toolEntityMapper.exists(
                    new QueryWrapper<ToolEntity>().eq("name", tool.getName()))) {
                continue;
            }

            try {
                ToolEntity entity = new ToolEntity();
                entity.setName(tool.getName());
                entity.setDescription(tool.getDescription());
                entity.setType("BUILTIN");
                entity.setInputSchema(objectMapper.writeValueAsString(tool.getInputSchema()));
                entity.setOutputSchema(objectMapper.writeValueAsString(tool.getOutputSchema()));
                entity.setImplClass(tool.getClass().getName());
                entity.setCreatorId(1L);
                entity.setStatus("ACTIVE");
                toolEntityMapper.insert(entity);
                created++;
                log.info("Auto-registered built-in tool: {}", tool.getName());
            } catch (DuplicateKeyException e) {
                log.debug("Tool already exists (concurrent insert): {}", tool.getName());
            } catch (Exception e) {
                log.warn("Failed to register tool {}: {}", tool.getName(), e.getMessage());
            }
        }

        if (created > 0) {
            log.info("ToolDataInitializer: created {} new built-in tool records", created);
        }
    }
}
