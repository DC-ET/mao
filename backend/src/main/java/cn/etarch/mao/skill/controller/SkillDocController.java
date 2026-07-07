package cn.etarch.mao.skill.controller;

import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.harness.skill.SkillDocument;
import cn.etarch.mao.harness.skill.SkillLoader;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * REST API for Skill knowledge documents management (CRUD).
 */
@Slf4j
@RestController
@RequestMapping("/v1/skill-docs")
@RequiredArgsConstructor
public class SkillDocController {

    private final SkillLoader skillLoader;

    @GetMapping
    public Result<List<SkillDocVO>> listSkillDocs() {
        List<SkillDocVO> voList = skillLoader.getAllDocuments().stream()
                .map(this::toVO)
                .collect(Collectors.toList());
        return Result.ok(voList);
    }

    @GetMapping("/{name}")
    public Result<SkillDocDetailVO> getSkillDoc(@PathVariable String name) {
        SkillDocument doc = skillLoader.getAllDocuments().stream()
                .filter(d -> d.getName().equals(name))
                .findFirst()
                .orElse(null);
        if (doc == null) {
            return Result.fail(404, "Skill not found: " + name);
        }
        SkillDocDetailVO vo = new SkillDocDetailVO();
        vo.setName(doc.getName());
        vo.setDescription(doc.getDescription());
        vo.setBody(doc.getBody());
        vo.setFolderPath(doc.getFolderPath());
        vo.setFilePath(doc.getFilePath());
        return Result.ok(vo);
    }

    /**
     * Upload skill folders via multipart files.
     * Each file's original filename is its relative path (e.g. "bigdata-cli/SKILL.md").
     * Files are grouped by the first path component (skill name) and written to the skills directory.
     */
    @PostMapping("/upload")
    public Result<List<String>> uploadSkill(@RequestParam("files") List<MultipartFile> files) {
        if (files == null || files.isEmpty()) {
            return Result.fail(400, "No files provided");
        }

        Path skillsDir = skillLoader.getSkillsDir();
        try {
            Files.createDirectories(skillsDir);
        } catch (IOException e) {
            return Result.fail(500, "Failed to create skills directory: " + e.getMessage());
        }

        // Group files by skill name (first path segment)
        Map<String, List<MultipartFile>> grouped = new LinkedHashMap<>();
        for (MultipartFile file : files) {
            String originalName = file.getOriginalFilename();
            if (originalName == null || originalName.isBlank()) continue;

            String normalized = originalName.replace('\\', '/');
            int slashIdx = normalized.indexOf('/');
            if (slashIdx <= 0) {
                // Root-level file without directory — skip
                continue;
            }

            String skillName = normalized.substring(0, slashIdx);
            if (skillName.startsWith(".")) continue;

            grouped.computeIfAbsent(skillName, k -> new ArrayList<>()).add(file);
        }

        List<String> importedNames = new ArrayList<>();

        for (Map.Entry<String, List<MultipartFile>> entry : grouped.entrySet()) {
            String skillName = entry.getKey();
            for (MultipartFile file : entry.getValue()) {
                String relativePath = file.getOriginalFilename()
                        .replace('\\', '/');
                int slashIdx = relativePath.indexOf('/');
                relativePath = (slashIdx > 0) ? relativePath.substring(slashIdx + 1) : "";

                if (relativePath.isEmpty() || relativePath.contains("/.")) continue;

                Path targetFile = skillsDir.resolve(skillName).resolve(relativePath);
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

        skillLoader.invalidateCache();
        log.info("Uploaded {} skills: {}", importedNames.size(), importedNames);
        return Result.ok(importedNames);
    }

    /**
     * Delete a skill folder by name.
     */
    @DeleteMapping("/{name}")
    public Result<Void> deleteSkill(@PathVariable String name) {
        Path skillFolder = skillLoader.getSkillFolder(name);
        if (skillFolder == null) {
            return Result.fail(404, "Skill not found: " + name);
        }

        try {
            if (Files.isDirectory(skillFolder)) {
                deleteDirectory(skillFolder);
            }
        } catch (IOException e) {
            log.error("Failed to delete skill folder {}: {}", skillFolder, e.getMessage());
            return Result.fail(500, "Failed to delete skill: " + e.getMessage());
        }

        skillLoader.invalidateCache();
        log.info("Deleted skill: {}", name);
        return Result.ok(null);
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

    private SkillDocVO toVO(SkillDocument doc) {
        SkillDocVO vo = new SkillDocVO();
        vo.setName(doc.getName());
        vo.setDescription(doc.getDescription());
        vo.setFolderPath(doc.getFolderPath());
        vo.setFilePath(doc.getFilePath());
        return vo;
    }

    @Data
    public static class SkillDocVO {
        private String name;
        private String description;
        private String folderPath;
        private String filePath;
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
