package com.agentworkbench.file.service;

import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.file.entity.FileEntity;
import com.agentworkbench.file.mapper.FileEntityMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import java.util.stream.Stream;

@Slf4j
@Service
@RequiredArgsConstructor
public class FileService {

    private final FileEntityMapper fileEntityMapper;

    @Value("${app.file.upload-dir:./uploads}")
    private String uploadDir;

    @Value("${app.file.max-size-mb:50}")
    private int maxSizeMb;

    public FileEntity uploadFile(MultipartFile file, Long userId, Long sessionId) {
        if (file.isEmpty()) {
            throw new BusinessException(4000, "文件不能为空");
        }

        long maxSizeBytes = (long) maxSizeMb * 1024 * 1024;
        if (file.getSize() > maxSizeBytes) {
            throw new BusinessException(4001, "文件大小超过限制: " + maxSizeMb + "MB");
        }

        String originalName = file.getOriginalFilename();
        String extension = "";
        if (originalName != null && originalName.contains(".")) {
            extension = originalName.substring(originalName.lastIndexOf("."));
        }
        String storedName = UUID.randomUUID().toString() + extension;

        try {
            Path uploadPath = Paths.get(uploadDir);
            if (!Files.exists(uploadPath)) {
                Files.createDirectories(uploadPath);
            }
            Path filePath = uploadPath.resolve(storedName);
            file.transferTo(filePath.toFile());

            FileEntity fileEntity = new FileEntity();
            fileEntity.setOriginalName(originalName);
            fileEntity.setStoredName(storedName);
            fileEntity.setFilePath(filePath.toString());
            fileEntity.setFileSize(file.getSize());
            fileEntity.setMimeType(file.getContentType());
            fileEntity.setUploaderId(userId);
            fileEntity.setSessionId(sessionId);
            fileEntityMapper.insert(fileEntity);

            return fileEntity;
        } catch (IOException e) {
            log.error("Failed to save file", e);
            throw new BusinessException(5000, "文件保存失败");
        }
    }

    public FileEntity getFile(Long id) {
        return fileEntityMapper.selectById(id);
    }

    public List<FileEntity> listFiles(Long userId, Long sessionId) {
        QueryWrapper<FileEntity> qw = new QueryWrapper<>();
        if (userId != null) {
            qw.eq("uploader_id", userId);
        }
        if (sessionId != null) {
            qw.eq("session_id", sessionId);
        }
        qw.orderByDesc("created_at");
        return fileEntityMapper.selectList(qw);
    }

    public void deleteFile(Long id) {
        FileEntity file = fileEntityMapper.selectById(id);
        if (file != null) {
            try {
                Path filePath = Paths.get(file.getFilePath());
                Files.deleteIfExists(filePath);
            } catch (IOException e) {
                log.warn("Failed to delete file from disk: {}", file.getFilePath(), e);
            }
            fileEntityMapper.deleteById(id);
        }
    }

    public Path getFilePath(Long id) {
        FileEntity file = fileEntityMapper.selectById(id);
        if (file == null) {
            throw new BusinessException(4040, "文件不存在");
        }
        return Paths.get(file.getFilePath());
    }

    private static final Set<String> IGNORED_DIRS = Set.of(
            "node_modules", "__pycache__", ".git", "target", "dist", "build",
            ".next", ".nuxt", ".venv", "venv", ".idea", ".vscode");

    public List<WorkspaceFileDTO> listWorkspaceFiles(String workspace, String filter, int limit) {
        Path root = Paths.get(workspace);
        if (!Files.exists(root) || !Files.isDirectory(root)) {
            return List.of();
        }
        String lowerFilter = filter != null ? filter.toLowerCase() : null;
        try (Stream<Path> walk = Files.walk(root)) {
            return walk
                    .filter(Files::isRegularFile)
                    .filter(p -> {
                        // Exclude hidden files and ignored directories
                        Path rel = root.relativize(p);
                        for (Path part : rel) {
                            String name = part.toString();
                            if (name.startsWith(".")) return false;
                            if (IGNORED_DIRS.contains(name)) return false;
                        }
                        return true;
                    })
                    .filter(p -> {
                        if (lowerFilter == null || lowerFilter.isEmpty()) return true;
                        Path rel = root.relativize(p);
                        return rel.toString().toLowerCase().contains(lowerFilter)
                                || p.getFileName().toString().toLowerCase().contains(lowerFilter);
                    })
                    .sorted(Comparator.comparingLong((Path p) -> {
                        try { return Files.getLastModifiedTime(p).toMillis(); }
                        catch (IOException e) { return 0L; }
                    }).reversed())
                    .limit(limit)
                    .map(p -> {
                        Path rel = root.relativize(p);
                        WorkspaceFileDTO dto = new WorkspaceFileDTO();
                        dto.setPath(rel.toString().replace('\\', '/'));
                        dto.setName(p.getFileName().toString());
                        try { dto.setSize(Files.size(p)); }
                        catch (IOException e) { dto.setSize(0L); }
                        return dto;
                    })
                    .collect(Collectors.toList());
        } catch (IOException e) {
            log.warn("Failed to walk workspace directory: {}", workspace, e);
            return List.of();
        }
    }

    @lombok.Data
    public static class WorkspaceFileDTO {
        private String path;
        private String name;
        private Long size;
    }
}
