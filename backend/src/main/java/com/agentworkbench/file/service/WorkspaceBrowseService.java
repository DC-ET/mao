package com.agentworkbench.file.service;

import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.harness.safety.PathSandbox;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

@Slf4j
@Service
@RequiredArgsConstructor
public class WorkspaceBrowseService {

    private final PathSandbox pathSandbox;

    private static final int MAX_ENTRIES = 500;
    private static final int DEFAULT_READ_LIMIT = 5000;
    private static final int MAX_READ_LIMIT = 5000;
    private static final int MAX_CONTENT_BYTES = 512 * 1024;

    public DirectoryListingDTO listDirectory(String sessionWorkspace, String relativeDir) {
        Path workspaceRoot = pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace);
        String dir = normalizeRelativeDir(relativeDir);
        Path dirPath = resolvePath(dir, sessionWorkspace);

        if (!Files.exists(dirPath)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "目录不存在");
        }
        if (!Files.isDirectory(dirPath)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "不是目录");
        }

        List<DirectoryEntryDTO> entries = new ArrayList<>();
        boolean truncated = false;

        try (Stream<Path> stream = Files.list(dirPath)) {
            List<Path> children = stream.sorted(Comparator.comparing(p -> p.getFileName().toString())).toList();
            if (children.size() > MAX_ENTRIES) {
                truncated = true;
            }
            for (Path child : children) {
                if (entries.size() >= MAX_ENTRIES) {
                    break;
                }
                String name = child.getFileName().toString();

                DirectoryEntryDTO entry = new DirectoryEntryDTO();
                entry.setName(name);
                Path relPath = workspaceRoot.relativize(child.toAbsolutePath().normalize());
                entry.setPath(relPath.toString().replace('\\', '/'));

                boolean isSymlink = Files.isSymbolicLink(child);
                entry.setSymlink(isSymlink);
                entry.setDirectory(Files.isDirectory(child) && !isSymlink);

                try {
                    entry.setSize(Files.size(child));
                } catch (IOException e) {
                    entry.setSize(0L);
                }
                entries.add(entry);
            }
        } catch (IOException e) {
            log.warn("Failed to list directory: {}", dirPath, e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "读取目录失败");
        }

        entries.sort((a, b) -> {
            if (a.directory != b.directory) {
                return a.directory ? -1 : 1;
            }
            return a.name.compareToIgnoreCase(b.name);
        });

        DirectoryListingDTO result = new DirectoryListingDTO();
        result.setEntries(entries);
        result.setTruncated(truncated);
        return result;
    }

    public FileContentDTO readFile(String sessionWorkspace, String relativePath, int offset, int limit) {
        if (relativePath == null || relativePath.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "文件路径不能为空");
        }

        Path filePath = resolvePath(relativePath, sessionWorkspace);

        if (!Files.exists(filePath)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "文件不存在：" + relativePath);
        }
        if (!Files.isRegularFile(filePath)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "不是普通文件：" + relativePath);
        }

        int effectiveOffset = Math.max(offset, 0);
        int effectiveLimit = limit > 0 ? Math.min(limit, MAX_READ_LIMIT) : DEFAULT_READ_LIMIT;

        List<String> allLines;
        try (Stream<String> lines = Files.lines(filePath)) {
            allLines = lines.collect(Collectors.toList());
        } catch (IOException e) {
            log.warn("Failed to read file: {}", filePath, e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "读取文件失败");
        }

        int totalLines = allLines.size();
        int from = Math.min(effectiveOffset, totalLines);
        int to = Math.min(from + effectiveLimit, totalLines);
        String content = String.join("\n", allLines.subList(from, to));

        if (content.getBytes().length > MAX_CONTENT_BYTES) {
            byte[] bytes = content.getBytes();
            int end = MAX_CONTENT_BYTES;
            while (end > 0 && (bytes[end - 1] & 0xC0) == 0x80) {
                end--;
            }
            content = new String(bytes, 0, end);
        }

        FileContentDTO dto = new FileContentDTO();
        dto.setContent(content);
        dto.setTotal_lines(totalLines);
        return dto;
    }

    private String normalizeRelativeDir(String relativeDir) {
        if (relativeDir == null || relativeDir.isBlank() || ".".equals(relativeDir)) {
            return ".";
        }
        return relativeDir;
    }

    private Path resolvePath(String userPath, String sessionWorkspace) {
        try {
            return pathSandbox.resolve(userPath, sessionWorkspace);
        } catch (SecurityException e) {
            throw new BusinessException(ErrorCode.FORBIDDEN, "路径访问被拒绝");
        } catch (IllegalArgumentException e) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, e.getMessage());
        }
    }

    @Data
    public static class DirectoryEntryDTO {
        private String name;
        private String path;
        @JsonProperty("isDirectory")
        private boolean directory;
        private long size;
        @JsonProperty("isSymlink")
        private boolean symlink;
    }

    @Data
    public static class DirectoryListingDTO {
        private List<DirectoryEntryDTO> entries;
        private boolean truncated;
    }

    @Data
    public static class FileContentDTO {
        private String content;
        private int total_lines;
    }
}
