package com.agentworkbench.harness.skill;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Component;
import org.yaml.snakeyaml.Yaml;

import jakarta.annotation.PostConstruct;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Loads Anthropic-style Skill knowledge documents from SKILL.md files.
 * Implements two-layer loading:
 *   Layer 1: name + description in system prompt (~100 token/skill)
 *   Layer 2: full body loaded on demand via load_skill tool (~2000 token)
 */
@Slf4j
@Component
public class SkillLoader {

    private final Map<String, SkillDocument> skills = new LinkedHashMap<>();

    @Value("${app.harness.skills-dir:classpath:skills/}")
    private String skillsDir;

    @PostConstruct
    public void init() {
        try {
            PathMatchingResourcePatternResolver resolver = new PathMatchingResourcePatternResolver();
            Resource[] resources = resolver.getResources(skillsDir + "*/SKILL.md");

            for (Resource resource : resources) {
                try {
                    SkillDocument doc = parseSkillFile(resource);
                    if (doc != null && doc.getName() != null) {
                        skills.put(doc.getName(), doc);
                        log.info("Loaded skill: {} from {}", doc.getName(), doc.getFilePath());
                    }
                } catch (Exception e) {
                    log.warn("Failed to parse skill file {}: {}", resource.getFilename(), e.getMessage());
                }
            }

            log.info("SkillLoader initialized with {} skills: {}", skills.size(), skills.keySet());
        } catch (Exception e) {
            log.info("No skill files found at {}, starting with empty skill set", skillsDir);
        }
    }

    /**
     * Layer 1: Get all skill descriptions for system prompt injection.
     * Returns formatted markdown list: "- name: description"
     */
    public String getDescriptions() {
        return getDescriptions(null);
    }

    /**
     * Layer 1 (filtered): Get descriptions for specified skill names only.
     */
    public String getDescriptions(List<String> filterNames) {
        if (skills.isEmpty()) {
            return null;
        }

        StringBuilder sb = new StringBuilder();
        for (SkillDocument doc : skills.values()) {
            if (filterNames != null && !filterNames.isEmpty() && !filterNames.contains(doc.getName())) {
                continue;
            }
            sb.append("- **").append(doc.getName()).append("**: ");
            sb.append(doc.getDescription() != null ? doc.getDescription() : "");
            sb.append("\n");
        }
        return sb.toString().trim();
    }

    /**
     * Layer 2: Get full skill content for on-demand loading via load_skill tool.
     */
    public String getContent(String name) {
        SkillDocument doc = skills.get(name);
        return doc != null ? doc.getBody() : null;
    }

    /**
     * Get all loaded skill documents.
     */
    public List<SkillDocument> getAllDocuments() {
        return List.copyOf(skills.values());
    }

    /**
     * Get all skill names.
     */
    public List<String> getAllNames() {
        return new ArrayList<>(skills.keySet());
    }

    /**
     * Check if a skill exists.
     */
    public boolean hasSkill(String name) {
        return skills.containsKey(name);
    }

    private SkillDocument parseSkillFile(Resource resource) throws Exception {
        String content;
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(resource.getInputStream(), StandardCharsets.UTF_8))) {
            content = reader.lines().collect(Collectors.joining("\n"));
        }

        // Parse YAML frontmatter between --- delimiters
        if (!content.startsWith("---")) {
            log.warn("Skill file {} does not start with YAML frontmatter", resource.getFilename());
            return null;
        }

        int secondDelimiter = content.indexOf("---", 3);
        if (secondDelimiter == -1) {
            log.warn("Skill file {} has unclosed YAML frontmatter", resource.getFilename());
            return null;
        }

        String frontmatter = content.substring(3, secondDelimiter).trim();
        String body = content.substring(secondDelimiter + 3).trim();

        Yaml yaml = new Yaml();
        Map<String, Object> metadata = yaml.load(frontmatter);
        if (metadata == null) {
            return null;
        }

        SkillDocument doc = new SkillDocument();
        doc.setName((String) metadata.get("name"));
        doc.setDescription((String) metadata.get("description"));
        doc.setBody(body);
        doc.setFilePath(resource.getURL().getPath());

        return doc;
    }
}
