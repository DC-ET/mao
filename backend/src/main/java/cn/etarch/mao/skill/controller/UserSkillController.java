package cn.etarch.mao.skill.controller;

import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.harness.skill.SkillDocument;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;

/**
 * REST API for user personal Skills management (CRUD).
 * Each user has their own skills directory at /path/to/data/userskills/{userId}/.
 */
@Slf4j
@RestController
@RequestMapping("/v1/user-skills")
@RequiredArgsConstructor
public class UserSkillController {

    @Value("${app.harness.user-skills-dir:$HOME/.mao/data/userskills}")
    private String userSkillsDir;

    @GetMapping
    public Result<List<SkillDocVO>> listUserSkills(@AuthenticationPrincipal Long userId) {
        Path userDir = getUserSkillsDir(userId);
        if (!Files.isDirectory(userDir)) {
            return Result.ok(List.of());
        }

        List<SkillDocVO> voList = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(userDir)) {
            for (Path entry : stream) {
                if (!Files.isDirectory(entry)) continue;
                Path skillMd = entry.resolve("SKILL.md");
                if (!Files.isRegularFile(skillMd)) continue;
                try {
                    SkillDocument doc = parseSkillMd(skillMd);
                    if (doc != null && doc.getName() != null) {
                        voList.add(toVO(doc, entry));
                    }
                } catch (Exception e) {
                    log.warn("Failed to parse user skill at {}: {}", entry, e.getMessage());
                }
            }
        } catch (IOException e) {
            log.warn("Failed to scan user skills directory {}: {}", userDir, e.getMessage());
        }

        return Result.ok(voList);
    }

    @GetMapping("/{name}")
    public Result<SkillDocDetailVO> getUserSkill(@AuthenticationPrincipal Long userId, @PathVariable String name) {
        Path skillFolder = getUserSkillsDir(userId).resolve(name);
        Path skillMd = skillFolder.resolve("SKILL.md");

        if (!Files.isRegularFile(skillMd)) {
            return Result.fail(404, "Skill not found: " + name);
        }

        try {
            SkillDocument doc = parseSkillMd(skillMd);
            if (doc == null || doc.getName() == null) {
                return Result.fail(404, "Skill not found: " + name);
            }
            SkillDocDetailVO vo = new SkillDocDetailVO();
            vo.setName(doc.getName());
            vo.setDescription(doc.getDescription());
            vo.setBody(doc.getBody());
            vo.setFolderPath(skillFolder.toAbsolutePath().normalize().toString());
            vo.setFilePath(skillMd.toAbsolutePath().normalize().toString());
            return Result.ok(vo);
        } catch (Exception e) {
            return Result.fail(500, "Failed to read skill: " + e.getMessage());
        }
    }

    @PostMapping("/upload")
    public Result<List<String>> uploadUserSkill(
            @AuthenticationPrincipal Long userId,
            @RequestParam("files") List<MultipartFile> files) {

        if (files == null || files.isEmpty()) {
            return Result.fail(400, "No files provided");
        }

        Path userDir = getUserSkillsDir(userId);
        try {
            Files.createDirectories(userDir);
        } catch (IOException e) {
            return Result.fail(500, "Failed to create user skills directory: " + e.getMessage());
        }

        // Group files by skill name (first path segment)
        Map<String, List<MultipartFile>> grouped = new LinkedHashMap<>();
        for (MultipartFile file : files) {
            String originalName = file.getOriginalFilename();
            if (originalName == null || originalName.isBlank()) continue;

            String normalized = originalName.replace('\\', '/');
            int slashIdx = normalized.indexOf('/');
            if (slashIdx <= 0) continue;

            String skillName = normalized.substring(0, slashIdx);
            if (skillName.startsWith(".")) continue;

            grouped.computeIfAbsent(skillName, k -> new ArrayList<>()).add(file);
        }

        if (grouped.isEmpty()) {
            return Result.fail(400, "No valid skill folders found. Each skill must be in a subdirectory.");
        }

        // Validate each skill has a valid SKILL.md before writing
        for (Map.Entry<String, List<MultipartFile>> entry : grouped.entrySet()) {
            boolean hasSkillMd = entry.getValue().stream().anyMatch(f -> {
                String name = f.getOriginalFilename();
                if (name == null) return false;
                String normalized = name.replace('\\', '/');
                int idx = normalized.indexOf('/');
                String relative = idx > 0 ? normalized.substring(idx + 1) : normalized;
                return "SKILL.md".equals(relative);
            });
            if (!hasSkillMd) {
                return Result.fail(400, "Skill '" + entry.getKey() + "' is missing SKILL.md file");
            }

            // Validate SKILL.md format
            MultipartFile skillMdFile = entry.getValue().stream().filter(f -> {
                String name = f.getOriginalFilename();
                if (name == null) return false;
                String normalized = name.replace('\\', '/');
                int idx = normalized.indexOf('/');
                String relative = idx > 0 ? normalized.substring(idx + 1) : normalized;
                return "SKILL.md".equals(relative);
            }).findFirst().orElse(null);

            if (skillMdFile != null) {
                try {
                    String content = new String(skillMdFile.getBytes(), StandardCharsets.UTF_8);
                    String validationError = validateSkillMd(content, entry.getKey());
                    if (validationError != null) {
                        return Result.fail(400, validationError);
                    }
                } catch (IOException e) {
                    return Result.fail(400, "Failed to read SKILL.md for skill '" + entry.getKey() + "'");
                }
            }
        }

        List<String> importedNames = new ArrayList<>();

        for (Map.Entry<String, List<MultipartFile>> entry : grouped.entrySet()) {
            String skillName = entry.getKey();

            // Delete existing skill folder if overwriting
            Path existingFolder = userDir.resolve(skillName);
            if (Files.isDirectory(existingFolder)) {
                try {
                    deleteDirectory(existingFolder);
                    log.info("Overwriting existing user skill: {}", skillName);
                } catch (IOException e) {
                    return Result.fail(500, "Failed to overwrite skill: " + e.getMessage());
                }
            }

            for (MultipartFile file : entry.getValue()) {
                String relativePath = file.getOriginalFilename().replace('\\', '/');
                int slashIdx = relativePath.indexOf('/');
                relativePath = (slashIdx > 0) ? relativePath.substring(slashIdx + 1) : "";

                if (relativePath.isEmpty() || relativePath.contains("/.")) continue;

                Path targetFile = userDir.resolve(skillName).resolve(relativePath);
                try {
                    Files.createDirectories(targetFile.getParent());
                    file.transferTo(targetFile.toFile());
                } catch (IOException e) {
                    log.error("Failed to write file {}: {}", targetFile, e.getMessage());
                    return Result.fail(500, "Failed to write file: " + e.getMessage());
                }
            }
            if (!importedNames.contains(skillName)) {
                importedNames.add(skillName);
            }
        }

        log.info("User {} uploaded {} skills: {}", userId, importedNames.size(), importedNames);
        return Result.ok(importedNames);
    }

    @DeleteMapping("/{name}")
    public Result<Void> deleteUserSkill(@AuthenticationPrincipal Long userId, @PathVariable String name) {
        Path skillFolder = getUserSkillsDir(userId).resolve(name);
        if (!Files.isDirectory(skillFolder)) {
            return Result.fail(404, "Skill not found: " + name);
        }

        try {
            deleteDirectory(skillFolder);
        } catch (IOException e) {
            log.error("Failed to delete user skill folder {}: {}", skillFolder, e.getMessage());
            return Result.fail(500, "Failed to delete skill: " + e.getMessage());
        }

        log.info("User {} deleted skill: {}", userId, name);
        return Result.ok(null);
    }

    private Path getUserSkillsDir(Long userId) {
        return Paths.get(userSkillsDir).toAbsolutePath().normalize().resolve(String.valueOf(userId));
    }

    private String validateSkillMd(String content, String expectedName) {
        if (!content.startsWith("---")) {
            return "SKILL.md for skill '" + expectedName + "' must start with YAML frontmatter (---)";
        }

        int secondDelimiter = content.indexOf("---", 3);
        if (secondDelimiter == -1) {
            return "SKILL.md for skill '" + expectedName + "' has unclosed YAML frontmatter";
        }

        String frontmatter = content.substring(3, secondDelimiter).trim();
        Yaml yaml = new Yaml();
        Map<String, Object> metadata;
        try {
            metadata = yaml.load(frontmatter);
        } catch (Exception e) {
            return "SKILL.md for skill '" + expectedName + "' has invalid YAML frontmatter: " + e.getMessage();
        }

        if (metadata == null) {
            return "SKILL.md for skill '" + expectedName + "' has empty frontmatter";
        }

        if (metadata.get("name") == null || String.valueOf(metadata.get("name")).isBlank()) {
            return "SKILL.md for skill '" + expectedName + "' is missing required field: name";
        }

        if (metadata.get("description") == null || String.valueOf(metadata.get("description")).isBlank()) {
            return "SKILL.md for skill '" + expectedName + "' is missing required field: description";
        }

        return null;
    }

    private SkillDocument parseSkillMd(Path skillMd) throws IOException {
        String content = Files.readString(skillMd, StandardCharsets.UTF_8);
        if (!content.startsWith("---")) return null;

        int secondDelimiter = content.indexOf("---", 3);
        if (secondDelimiter == -1) return null;

        String frontmatter = content.substring(3, secondDelimiter).trim();
        String body = content.substring(secondDelimiter + 3).trim();

        Yaml yaml = new Yaml();
        Map<String, Object> metadata = yaml.load(frontmatter);
        if (metadata == null) return null;

        SkillDocument doc = new SkillDocument();
        doc.setName((String) metadata.get("name"));
        doc.setDescription((String) metadata.get("description"));
        doc.setBody(body);
        doc.setFilePath(skillMd.toAbsolutePath().normalize().toString());
        doc.setFolderPath(skillMd.getParent().toAbsolutePath().normalize().toString());
        return doc;
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

    private SkillDocVO toVO(SkillDocument doc, Path folderPath) {
        SkillDocVO vo = new SkillDocVO();
        vo.setName(doc.getName());
        vo.setDescription(doc.getDescription());
        vo.setFolderPath(folderPath.toAbsolutePath().normalize().toString());
        return vo;
    }

    @Data
    public static class SkillDocVO {
        private String name;
        private String description;
        private String folderPath;
    }

    @Data
    public static class SkillDocDetailVO {
        private String name;
        private String description;
        private String body;
        private String folderPath;
        private String filePath;
    }
}
