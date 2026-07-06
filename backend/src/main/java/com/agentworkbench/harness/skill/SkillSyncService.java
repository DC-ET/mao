package com.agentworkbench.harness.skill;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.harness.safety.PathSandbox;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Skills 工作区同步服务。
 * <p>
 * CLOUD 模式：将 Skills 文件夹拷贝到 &lt;workspace&gt;/.skills/
 * LOCAL 模式：将 Skills 文件夹打包为 zip 流，供客户端下载解压
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SkillSyncService {

    private final SkillLoader skillLoader;
    private final PathSandbox pathSandbox;
    private final ObjectMapper objectMapper;

    @Value("${app.harness.user-skills-dir:$HOME/.mao/data/userskills}")
    private String userSkillsDir;

    private static final String SKILLS_DIR_NAME = ".mao/skills";

    // "agentId:workspace" → (skillName → lastSyncEpochMilli)
    private final Map<String, Map<String, Long>> syncState = new ConcurrentHashMap<>();

    /**
     * CLOUD 模式：同步 Skills 到工作区 .skills/ 目录。
     * 合并系统 Skills + 用户个人 Skills，同名时用户 Skills 优先。
     */
    public void syncToWorkspace(Agent agent, String workspace, Long userId) {
        if (workspace == null || workspace.isBlank()) {
            log.warn("Cannot sync skills: workspace is empty");
            return;
        }

        List<String> systemNames = resolveSkillNames(agent);
        Map<String, Path> userSkillFolders = new LinkedHashMap<>();
        loadUserSkillDocs(userId).forEach((name, doc) -> userSkillFolders.put(name, Paths.get(doc.getFolderPath())));

        // Merge: system skills first, then user skills override on conflict
        Map<String, Path> merged = new LinkedHashMap<>();
        for (String name : systemNames) {
            Path folder = skillLoader.getSkillFolder(name);
            if (folder != null) {
                merged.put(name, folder);
            }
        }
        merged.putAll(userSkillFolders);

        if (merged.isEmpty()) {
            log.debug("No skills to sync for agent {}, userId={}", agent.getId(), userId);
            return;
        }

        Path skillsDir = Paths.get(workspace, SKILLS_DIR_NAME);
        Map<String, Long> state = getSyncState(agent.getId(), workspace);
        Set<String> toRemove = new HashSet<>(state.keySet());

        for (Map.Entry<String, Path> entry : merged.entrySet()) {
            String skillName = entry.getKey();
            Path sourceFolder = entry.getValue();
            toRemove.remove(skillName);

            long sourceModified = getLastModified(sourceFolder);
            Long lastSynced = state.get(skillName);

            if (lastSynced != null && lastSynced >= sourceModified) {
                log.debug("Skill {} unchanged, skipping", skillName);
                continue;
            }

            try {
                Path targetFolder = skillsDir.resolve(skillName);
                copyDirectory(sourceFolder, targetFolder);
                state.put(skillName, sourceModified);
                log.info("Synced skill {} to {}", skillName, targetFolder);
            } catch (IOException e) {
                log.error("Failed to sync skill {} to workspace: {}", skillName, e.getMessage());
            }
        }

        // Remove skills no longer in merged list
        for (String removed : toRemove) {
            try {
                Path removedDir = skillsDir.resolve(removed);
                if (Files.isDirectory(removedDir)) {
                    deleteDirectory(removedDir);
                    log.info("Removed skill {} from workspace", removed);
                }
            } catch (IOException e) {
                log.warn("Failed to remove skill {}: {}", removed, e.getMessage());
            }
            state.remove(removed);
        }

        // Update sync manifest
        writeManifest(skillsDir, agent.getId(), state);
    }

    /**
     * LOCAL 模式：将需要同步的 Skills 打包为 zip 流写入输出流。
     * 合并系统 Skills + 用户个人 Skills，同名时用户 Skills 优先。
     */
    public void writeSyncZip(Agent agent, OutputStream out, Long userId) throws IOException {
        List<String> systemNames = resolveSkillNames(agent);
        Map<String, Path> userSkillFolders = new LinkedHashMap<>();
        loadUserSkillDocs(userId).forEach((name, doc) -> userSkillFolders.put(name, Paths.get(doc.getFolderPath())));

        // Merge: system skills first, then user skills override on conflict
        Map<String, Path> merged = new LinkedHashMap<>();
        for (String name : systemNames) {
            Path folder = skillLoader.getSkillFolder(name);
            if (folder != null) {
                merged.put(name, folder);
            }
        }
        merged.putAll(userSkillFolders);

        Map<String, Long> state = getSyncState(agent.getId(), "zip");

        try (ZipOutputStream zos = new ZipOutputStream(out)) {
            for (Map.Entry<String, Path> entry : merged.entrySet()) {
                String skillName = entry.getKey();
                Path sourceFolder = entry.getValue();

                long sourceModified = getLastModified(sourceFolder);
                state.put(skillName, sourceModified);

                Path rootPath = sourceFolder;
                Files.walkFileTree(sourceFolder, new SimpleFileVisitor<>() {
                    @Override
                    public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                        String relativePath = rootPath.relativize(file).toString().replace('\\', '/');
                        // Skip hidden files and node_modules
                        if (shouldSkip(file)) {
                            return FileVisitResult.CONTINUE;
                        }
                        zos.putNextEntry(new ZipEntry(skillName + "/" + relativePath));
                        Files.copy(file, zos);
                        zos.closeEntry();
                        return FileVisitResult.CONTINUE;
                    }

                    @Override
                    public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                        if (shouldSkip(dir)) {
                            return FileVisitResult.SKIP_SUBTREE;
                        }
                        return FileVisitResult.CONTINUE;
                    }
                });
            }

            // Write manifest
            Map<String, Object> manifest = new LinkedHashMap<>();
            manifest.put("syncedAt", Instant.now().toString());
            manifest.put("agentId", agent.getId());
            List<Map<String, String>> skillList = new ArrayList<>();
            for (String name : merged.keySet()) {
                skillList.add(Map.of("name", name, "version", String.valueOf(state.getOrDefault(name, 0L))));
            }
            manifest.put("skills", skillList);

            zos.putNextEntry(new ZipEntry(".sync-manifest.json"));
            zos.write(objectMapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(manifest));
            zos.closeEntry();
        }
    }

    /**
     * 获取需要删除的 Skill 名称列表（已同步但不在当前 Agent 列表中的）。
     */
    public List<String> getRemovedSkillNames(Long agentId, String workspace) {
        if (workspace == null || workspace.isBlank()) return List.of();

        Map<String, Long> state = syncState.get(buildStateKey(agentId, workspace));
        if (state == null || state.isEmpty()) return List.of();

        Path skillsDir = Paths.get(workspace, SKILLS_DIR_NAME);
        Set<String> onDisk = new HashSet<>();
        if (Files.isDirectory(skillsDir)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(skillsDir)) {
                for (Path entry : stream) {
                    if (Files.isDirectory(entry)) {
                        onDisk.add(entry.getFileName().toString());
                    }
                }
            } catch (IOException ignored) {
            }
        }

        // Skills that are on disk but not in current state
        onDisk.removeAll(state.keySet());
        return new ArrayList<>(onDisk);
    }

    /**
     * 清理工作区的 .skills/ 目录。
     */
    public void cleanWorkspace(String workspace) {
        if (workspace == null || workspace.isBlank()) return;

        Path skillsDir = Paths.get(workspace, SKILLS_DIR_NAME);
        try {
            if (Files.isDirectory(skillsDir)) {
                deleteDirectory(skillsDir);
                log.info("Cleaned .skills directory: {}", skillsDir);
            }
        } catch (IOException e) {
            log.warn("Failed to clean .skills directory: {}", e.getMessage());
        }

        // Clean sync state entries for this workspace
        syncState.entrySet().removeIf(entry -> entry.getKey().endsWith(":" + workspace));
    }

    /**
     * 获取用户个人 Skills 的名称列表。
     */
    public List<String> getUserSkillNames(Long userId) {
        return new ArrayList<>(loadUserSkillDocs(userId).keySet());
    }

    /**
     * 获取用户个人 Skills 的文档列表。
     */
    public List<SkillDocument> getUserSkillDocuments(Long userId) {
        return List.copyOf(loadUserSkillDocs(userId).values());
    }

    /**
     * 加载用户个人 Skills，返回 name → SkillDocument 的映射。
     * 用户 Skills 目录结构：/path/to/data/userskills/{userId}/{skillName}/SKILL.md
     */
    private Map<String, SkillDocument> loadUserSkillDocs(Long userId) {
        Map<String, SkillDocument> result = new LinkedHashMap<>();
        if (userId == null) return result;

        Path userDir = Paths.get(userSkillsDir).toAbsolutePath().normalize().resolve(String.valueOf(userId));
        if (!Files.isDirectory(userDir)) return result;

        try (DirectoryStream<Path> stream = Files.newDirectoryStream(userDir)) {
            for (Path entry : stream) {
                if (!Files.isDirectory(entry)) continue;
                Path skillMd = entry.resolve("SKILL.md");
                if (!Files.isRegularFile(skillMd)) continue;
                try {
                    String content = Files.readString(skillMd, StandardCharsets.UTF_8);
                    if (!content.startsWith("---")) continue;
                    int secondDelimiter = content.indexOf("---", 3);
                    if (secondDelimiter == -1) continue;
                    String frontmatter = content.substring(3, secondDelimiter).trim();
                    String body = content.substring(secondDelimiter + 3).trim();
                    Yaml yaml = new Yaml();
                    Map<String, Object> metadata = yaml.load(frontmatter);
                    if (metadata != null && metadata.get("name") != null) {
                        String name = String.valueOf(metadata.get("name"));
                        SkillDocument doc = new SkillDocument();
                        doc.setName(name);
                        doc.setDescription(metadata.get("description") != null ? String.valueOf(metadata.get("description")) : "");
                        doc.setBody(body);
                        doc.setFilePath(skillMd.toAbsolutePath().normalize().toString());
                        doc.setFolderPath(entry.toAbsolutePath().normalize().toString());
                        result.put(name, doc);
                        // Register to PathSandbox so read_file can access
                        pathSandbox.addAllowedRoot(entry.toAbsolutePath().normalize());
                    }
                } catch (Exception e) {
                    log.warn("Failed to parse user skill at {}: {}", entry, e.getMessage());
                }
            }
        } catch (IOException e) {
            log.debug("Failed to scan user skills directory {}: {}", userDir, e.getMessage());
        }

        if (!result.isEmpty()) {
            log.info("Loaded {} user skills for userId={}", result.size(), userId);
        }
        return result;
    }

    private List<String> resolveSkillNames(Agent agent) {
        if (agent.getSkillNames() != null && !agent.getSkillNames().isBlank()) {
            try {
                return objectMapper.readValue(agent.getSkillNames(),
                        new com.fasterxml.jackson.core.type.TypeReference<List<String>>() {});
            } catch (Exception e) {
                log.warn("Failed to parse skillNames for agent {}: {}", agent.getId(), e.getMessage());
            }
        }
        return skillLoader.getAllNames();
    }

    private Map<String, Long> getSyncState(Long agentId, String workspace) {
        return syncState.computeIfAbsent(buildStateKey(agentId, workspace), k -> new ConcurrentHashMap<>());
    }

    private String buildStateKey(Long agentId, String workspace) {
        return agentId + ":" + workspace;
    }

    private long getLastModified(Path dir) {
        try {
            long max = 0;
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
                for (Path entry : stream) {
                    long lm = Files.getLastModifiedTime(entry).toMillis();
                    if (lm > max) max = lm;
                }
            }
            return max;
        } catch (IOException e) {
            return 0;
        }
    }

    private void copyDirectory(Path source, Path target) throws IOException {
        Files.createDirectories(target);
        Files.walkFileTree(source, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                if (shouldSkip(dir)) return FileVisitResult.SKIP_SUBTREE;
                Path dest = target.resolve(source.relativize(dir));
                Files.createDirectories(dest);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                if (shouldSkip(file)) return FileVisitResult.CONTINUE;
                Path dest = target.resolve(source.relativize(file));
                Files.createDirectories(dest.getParent());
                Files.copy(file, dest, StandardCopyOption.REPLACE_EXISTING);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private void deleteDirectory(Path dir) throws IOException {
        Files.walkFileTree(dir, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path d, IOException exc) throws IOException {
                Files.delete(d);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private boolean shouldSkip(Path path) {
        String name = path.getFileName().toString();
        return name.startsWith(".")
                || name.equals("node_modules")
                || name.equals("__pycache__");
    }

    private void writeManifest(Path skillsDir, Long agentId, Map<String, Long> state) {
        try {
            Map<String, Object> manifest = new LinkedHashMap<>();
            manifest.put("syncedAt", Instant.now().toString());
            manifest.put("agentId", agentId);
            List<Map<String, String>> skillList = new ArrayList<>();
            for (var entry : state.entrySet()) {
                skillList.add(Map.of("name", entry.getKey(), "version", String.valueOf(entry.getValue())));
            }
            manifest.put("skills", skillList);

            Path manifestPath = skillsDir.resolve(".sync-manifest.json");
            Files.createDirectories(skillsDir);
            Files.write(manifestPath, objectMapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(manifest));
        } catch (IOException e) {
            log.warn("Failed to write sync manifest: {}", e.getMessage());
        }
    }
}
