package com.agentworkbench.harness.skill;

import com.agentworkbench.harness.safety.PathSandbox;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Loads Skill knowledge documents from an external directory.
 * <p>
 * Each Skill is a subdirectory under {@code app.harness.skills-dir} containing
 * a SKILL.md file (with YAML frontmatter) and optionally other resource files.
 * <p>
 * Results are cached for a short duration to avoid scanning the directory on every request.
 * The agent reads full skill content on demand via read_file.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SkillLoader {

    private final PathSandbox pathSandbox;

    @Value("${app.harness.skills-dir:./skills}")
    private String skillsDir;

    @Value("${app.harness.skills-cache-seconds:300}")
    private int cacheSeconds;

    private final Map<String, SkillDocument> cache = new ConcurrentHashMap<>();
    private volatile long cacheTimestamp = 0;

    /**
     * Get skill catalog with file paths for system prompt injection.
     * Only name/description/path are included — the agent reads full content on demand via read_file.
     */
    public String getCatalogWithPaths(List<String> filterNames) {
        Map<String, SkillDocument> skills = loadSkills();
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
            sb.append("\n  Folder: `").append(doc.getFolderPath()).append("`");
            sb.append("\n  File: `").append(doc.getFilePath()).append("`");
            sb.append("\n");
        }
        return sb.toString().trim();
    }

    /**
     * Get all loaded skill documents.
     */
    public List<SkillDocument> getAllDocuments() {
        return List.copyOf(loadSkills().values());
    }

    /**
     * Get all skill names.
     */
    public List<String> getAllNames() {
        return new ArrayList<>(loadSkills().keySet());
    }

    /**
     * Check if a skill exists.
     */
    public boolean hasSkill(String name) {
        return loadSkills().containsKey(name);
    }

    /**
     * Get the folder path for a specific skill.
     * Returns null if the skill does not exist.
     */
    public Path getSkillFolder(String name) {
        SkillDocument doc = loadSkills().get(name);
        if (doc == null || doc.getFolderPath() == null) {
            return null;
        }
        return Paths.get(doc.getFolderPath());
    }

    /**
     * Get the absolute path of the skills root directory.
     */
    public Path getSkillsDir() {
        return Paths.get(skillsDir).toAbsolutePath().normalize();
    }

    /**
     * Invalidate cache so next request triggers a rescan.
     */
    public void invalidateCache() {
        cache.clear();
        cacheTimestamp = 0;
    }

    private Map<String, SkillDocument> loadSkills() {
        if (!isCacheExpired() && !cache.isEmpty()) {
            return cache;
        }
        synchronized (this) {
            if (!isCacheExpired() && !cache.isEmpty()) {
                return cache;
            }
            refreshCache();
            return cache;
        }
    }

    private boolean isCacheExpired() {
        return System.currentTimeMillis() - cacheTimestamp > cacheSeconds * 1000L;
    }

    private void refreshCache() {
        Map<String, SkillDocument> newSkills = new LinkedHashMap<>();
        Path root = Paths.get(skillsDir).toAbsolutePath().normalize();

        if (!Files.isDirectory(root)) {
            log.warn("Skills directory does not exist: {}", root);
            cache.clear();
            cacheTimestamp = System.currentTimeMillis();
            return;
        }

        try (DirectoryStream<Path> stream = Files.newDirectoryStream(root)) {
            for (Path entry : stream) {
                if (!Files.isDirectory(entry)) {
                    continue;
                }
                Path skillMd = entry.resolve("SKILL.md");
                if (!Files.isRegularFile(skillMd)) {
                    continue;
                }
                try {
                    SkillDocument doc = parseSkillFolder(entry, skillMd);
                    if (doc != null && doc.getName() != null) {
                        newSkills.put(doc.getName(), doc);
                        pathSandbox.addAllowedRoot(entry);
                    }
                } catch (Exception e) {
                    log.warn("Failed to parse skill at {}: {}", entry, e.getMessage());
                }
            }
        } catch (IOException e) {
            log.warn("Failed to scan skills directory {}: {}", root, e.getMessage());
        }

        cache.clear();
        cache.putAll(newSkills);
        cacheTimestamp = System.currentTimeMillis();
        log.info("SkillLoader refreshed: {} skills loaded from {}", cache.size(), root);
    }

    private SkillDocument parseSkillFolder(Path folder, Path skillMd) throws IOException {
        String content = Files.readString(skillMd, StandardCharsets.UTF_8);

        if (!content.startsWith("---")) {
            log.warn("Skill file {} does not start with YAML frontmatter", skillMd);
            return null;
        }

        int secondDelimiter = content.indexOf("---", 3);
        if (secondDelimiter == -1) {
            log.warn("Skill file {} has unclosed YAML frontmatter", skillMd);
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
        doc.setFilePath(skillMd.toAbsolutePath().normalize().toString());
        doc.setFolderPath(folder.toAbsolutePath().normalize().toString());

        return doc;
    }
}
