package com.agentworkbench.harness.skill;

import com.agentworkbench.harness.safety.PathSandbox;
import lombok.RequiredArgsConstructor;
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
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Loads Skill knowledge documents from SKILL.md files.
 * Only name/description/paths are injected into the system prompt as a catalog;
 * the agent reads full skill content on demand via read_file.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SkillLoader {

    private final PathSandbox pathSandbox;

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

            // Register skills directories as allowed roots so read_file can access them
            registerAllowedRoots(resources);

            log.info("SkillLoader initialized with {} skills: {}", skills.size(), skills.keySet());
        } catch (Exception e) {
            log.info("No skill files found at {}, starting with empty skill set", skillsDir);
        }
    }

    /**
     * Get skill catalog with file paths for system prompt injection.
     * Only name/description/path are included — the agent reads full content on demand via read_file.
     */
    public String getCatalogWithPaths(List<String> filterNames) {
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
            sb.append("\n  File: `").append(doc.getFilePath()).append("`");
            sb.append("\n");
        }
        return sb.toString().trim();
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

    private void registerAllowedRoots(Resource[] resources) {
        Set<Path> roots = new LinkedHashSet<>();
        for (Resource resource : resources) {
            try {
                // e.g. /.../target/classes/skills/bigdata-cli/SKILL.md → /.../target/classes/skills/bigdata-cli
                Path skillDir = Paths.get(resource.getURL().getPath()).getParent();
                if (skillDir != null) {
                    roots.add(skillDir);
                }
            } catch (Exception ignored) {
            }
        }
        for (Path root : roots) {
            pathSandbox.addAllowedRoot(root);
            log.info("Registered skill allowed root: {}", root);
        }
    }
}
