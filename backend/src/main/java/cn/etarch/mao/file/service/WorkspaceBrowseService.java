package cn.etarch.mao.file.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.harness.tool.ImageFileSupport;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
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

        Optional<String> imageMime = ImageFileSupport.mimeFromPath(relativePath);
        if (imageMime.isPresent()) {
            return readImageFile(filePath, relativePath);
        }

        int effectiveOffset = Math.max(offset, 0);
        int effectiveLimit = limit > 0 ? Math.min(limit, MAX_READ_LIMIT) : DEFAULT_READ_LIMIT;

        List<String> allLines;
        try (Stream<String> lines = Files.lines(filePath)) {
            allLines = lines.collect(Collectors.toList());
        } catch (Exception e) {
            log.warn("Failed to read file as text: {}", filePath, e);
            throw new BusinessException(ErrorCode.PARAM_INVALID, "二进制文件，无法预览");
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

    private FileContentDTO readImageFile(Path filePath, String relativePath) {
        long sizeBytes;
        try {
            sizeBytes = Files.size(filePath);
        } catch (IOException e) {
            log.warn("Failed to stat image file: {}", filePath, e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "读取文件失败");
        }

        if (sizeBytes > ImageFileSupport.MAX_IMAGE_BYTES) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "文件过大（" + ImageFileSupport.formatSize(sizeBytes)
                            + "），图片预览上限为 " + ImageFileSupport.formatSize(ImageFileSupport.MAX_IMAGE_BYTES));
        }

        byte[] bytes;
        try {
            bytes = Files.readAllBytes(filePath);
        } catch (IOException e) {
            log.warn("Failed to read image file: {}", filePath, e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "读取文件失败");
        }

        Optional<String> detectedMime = ImageFileSupport.detectMimeFromBytes(bytes);
        if (detectedMime.isEmpty()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "不支持的图片格式或文件内容无效：" + relativePath);
        }

        String mime = detectedMime.get();
        String dataUri = "data:" + mime + ";base64," + Base64.getEncoder().encodeToString(bytes);

        Integer width = null;
        Integer height = null;
        try {
            BufferedImage image = ImageIO.read(new ByteArrayInputStream(bytes));
            if (image != null) {
                width = image.getWidth();
                height = image.getHeight();
            }
        } catch (Exception e) {
            log.debug("Failed to read image dimensions for {}", relativePath, e);
        }

        StringBuilder summary = new StringBuilder(relativePath)
                .append(" (")
                .append(mime)
                .append(", ")
                .append(ImageFileSupport.formatSize(sizeBytes));
        if (width != null && height != null) {
            summary.append(", ").append(width).append("×").append(height);
        }
        summary.append(")");

        FileContentDTO dto = new FileContentDTO();
        dto.setContent(summary.toString());
        dto.setTotal_lines(0);
        dto.setMedia_type("image");
        dto.setMime(mime);
        dto.setData_uri(dataUri);
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
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static class FileContentDTO {
        private String content;
        private int total_lines;
        private String media_type;
        private String mime;
        private String data_uri;
    }
}
