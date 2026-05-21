package com.agentworkbench.harness.tool;

import com.agentworkbench.harness.skill.SkillLoader;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Special tool that bridges the Tool and Skill systems.
 * When LLM calls load_skill(name), returns the full SKILL.md content
 * for the requested Skill knowledge document.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class LoadSkillTool implements Tool {

    private final SkillLoader skillLoader;
    private final ObjectMapper objectMapper;

    @Override
    public String getName() {
        return "load_skill";
    }

    @Override
    public String getDescription() {
        return "Load the full knowledge content of a specified Skill. Call this when you need domain-specific guidance for a particular task area.";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("name", Map.of("type", "string", "description", "The Skill name to load"));
        schema.put("properties", properties);
        schema.put("required", List.of("name"));
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("content", Map.of("type", "string"));
        properties.put("error", Map.of("type", "string"));
        schema.put("properties", properties);
        return schema;
    }

    @Override
    public String execute(String arguments) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String name = args.get("name").asText();

            String content = skillLoader.getContent(name);
            if (content == null) {
                List<String> available = skillLoader.getAllNames();
                return objectMapper.writeValueAsString(Map.of(
                        "error", "Unknown skill: " + name + ". Available skills: " + String.join(", ", available)
                ));
            }

            log.debug("Loaded skill content: {} ({} chars)", name, content.length());
            return objectMapper.writeValueAsString(Map.of("content", content));
        } catch (Exception e) {
            log.error("LoadSkillTool execution failed", e);
            return "{\"error\":\"" + e.getMessage().replace("\"", "'") + "\"}";
        }
    }
}
