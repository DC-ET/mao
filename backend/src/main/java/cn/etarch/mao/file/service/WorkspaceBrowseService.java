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
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
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
    private static final long DEFAULT_MAX_ZIP_BYTES = 1024L * 1024 * 1024; // 1GB
    private long maxZipBytes = DEFAULT_MAX_ZIP_BYTES;

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

    public DownloadResult downloadFile(String sessionWorkspace, String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "文件路径不能为空");
        }

        Path filePath = resolvePath(relativePath, sessionWorkspace);

        if (!Files.exists(filePath)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "文件不存在：" + relativePath);
        }
        if (!Files.isRegularFile(filePath) || Files.isSymbolicLink(filePath)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "不是普通文件：" + relativePath);
        }

        // 跟随所有符号链接后校验真实路径仍位于真实工作区内，防止中间目录符号链接绕过沙箱
        Path realPath;
        Path realRoot;
        try {
            realPath = filePath.toRealPath();
            realRoot = pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace).toRealPath();
        } catch (IOException e) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "文件不存在：" + relativePath);
        }
        if (!realPath.startsWith(realRoot)) {
            log.warn("Path escape via symlink blocked: {} (real: {})", relativePath, realPath);
            throw new BusinessException(ErrorCode.FORBIDDEN, "路径访问被拒绝");
        }

        long size;
        try {
            size = Files.size(filePath);
        } catch (IOException e) {
            log.warn("Failed to stat file for download: {}", filePath, e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "读取文件失败");
        }

        DownloadResult result = new DownloadResult();
        result.setPath(filePath);
        result.setSize(size);
        result.setFileName(filePath.getFileName().toString());
        return result;
    }

    /**
     * 校验并返回 PDF 文件供客户端预览。与 downloadFile 的沙箱校验一致，
     * 额外要求扩展名为 .pdf 且文件头为 PDF 魔数（%PDF-，兼容 UTF-8 BOM 前缀）。
     */
    public DownloadResult readPdfFile(String sessionWorkspace, String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "文件路径不能为空");
        }

        String lower = relativePath.toLowerCase();
        if (!lower.endsWith(".pdf")) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "仅支持预览 .pdf 文件");
        }

        Path filePath = resolvePath(relativePath, sessionWorkspace);

        if (!Files.exists(filePath)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "文件不存在：" + relativePath);
        }
        if (!Files.isRegularFile(filePath) || Files.isSymbolicLink(filePath)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "不是普通文件：" + relativePath);
        }

        // 跟随所有符号链接后校验真实路径仍位于真实工作区内，防止中间目录符号链接绕过沙箱
        Path realPath;
        Path realRoot;
        try {
            realPath = filePath.toRealPath();
            realRoot = pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace).toRealPath();
        } catch (IOException e) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "文件不存在：" + relativePath);
        }
        if (!realPath.startsWith(realRoot)) {
            log.warn("PDF path escape via symlink blocked: {} (real: {})", relativePath, realPath);
            throw new BusinessException(ErrorCode.FORBIDDEN, "路径访问被拒绝");
        }

        byte[] head = new byte[8];
        int read;
        try (InputStream in = Files.newInputStream(filePath)) {
            read = in.readNBytes(head, 0, head.length);
        } catch (IOException e) {
            log.warn("Failed to read pdf header: {}", filePath, e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "读取文件失败");
        }
        if (!isPdfHeader(head, read)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "不是有效的 PDF 文件或文件已损坏：" + relativePath);
        }

        long size;
        try {
            size = Files.size(filePath);
        } catch (IOException e) {
            log.warn("Failed to stat pdf file: {}", filePath, e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "读取文件失败");
        }

        DownloadResult result = new DownloadResult();
        result.setPath(filePath);
        result.setSize(size);
        result.setFileName(filePath.getFileName().toString());
        return result;
    }

    private static boolean isPdfHeader(byte[] head, int read) {
        int offset = 0;
        // 跳过 UTF-8 BOM (EF BB BF)
        if (read >= 3 && (head[0] & 0xFF) == 0xEF && (head[1] & 0xFF) == 0xBB && (head[2] & 0xFF) == 0xBF) {
            offset = 3;
        }
        if (read - offset < 5) {
            return false;
        }
        return head[offset] == '%' && head[offset + 1] == 'P' && head[offset + 2] == 'D'
                && head[offset + 3] == 'F' && head[offset + 4] == '-';
    }

    public ZipResult zipDirectory(String sessionWorkspace, String relativeDir) {
        Path workspaceRoot = pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace);
        String dir = normalizeRelativeDir(relativeDir);
        Path dirPath = resolvePath(dir, sessionWorkspace);

        if (!Files.exists(dirPath)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "目录不存在");
        }
        if (!Files.isDirectory(dirPath)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "不是目录");
        }

        // 打包前先统计总大小（跳过符号链接），超限直接拒绝，避免浪费磁盘与打包时间
        long totalBytes = 0;
        try (Stream<Path> stream = Files.walk(dirPath)) {
            totalBytes = stream
                    .filter(p -> !Files.isSymbolicLink(p) && Files.isRegularFile(p))
                    .mapToLong(p -> {
                        try {
                            return Files.size(p);
                        } catch (IOException e) {
                            return 0L;
                        }
                    })
                    .sum();
        } catch (IOException | UncheckedIOException e) {
            log.warn("Failed to walk directory for zip: {}", dirPath, e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "读取目录失败");
        }

        if (totalBytes > maxZipBytes) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "目录过大（" + formatSize(totalBytes) + "），请选择子目录下载");
        }

        // zip 内顶层目录名：下载根目录时用工作区目录名，否则用目录自身名
        String rootName = resolveZipRootName(dirPath, workspaceRoot);

        Path zipPath;
        try {
            zipPath = Files.createTempFile("mao-workspace-", ".zip");
        } catch (IOException e) {
            log.warn("Failed to create temp zip file", e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "创建临时文件失败");
        }

        boolean written = false;
        try {
            Path finalDirPath = dirPath;
            try (ZipOutputStream zos = new ZipOutputStream(Files.newOutputStream(zipPath));
                 Stream<Path> stream = Files.walk(finalDirPath)) {
                List<Path> paths = stream
                        .sorted(Comparator.comparing(p -> zipEntryName(finalDirPath, rootName, p)))
                        .toList();
                for (Path p : paths) {
                    // 跳过符号链接，防止链接指向沙箱外导致 zip 膨胀或逃逸
                    if (Files.isSymbolicLink(p)) {
                        continue;
                    }
                    String entryName = zipEntryName(finalDirPath, rootName, p);
                    if (Files.isDirectory(p)) {
                        zos.putNextEntry(new ZipEntry(entryName + "/"));
                        zos.closeEntry();
                    } else if (Files.isRegularFile(p)) {
                        zos.putNextEntry(new ZipEntry(entryName));
                        Files.copy(p, zos);
                        zos.closeEntry();
                    }
                }
            } catch (IOException | UncheckedIOException e) {
                log.warn("Failed to write zip for directory: {}", finalDirPath, e);
                throw new BusinessException(ErrorCode.INTERNAL_ERROR, "打包目录失败");
            }
            written = true;
        } finally {
            if (!written) {
                try {
                    Files.deleteIfExists(zipPath);
                } catch (IOException e) {
                    log.warn("Failed to delete temp zip after error: {}", zipPath, e);
                }
            }
        }

        long zipSize;
        try {
            zipSize = Files.size(zipPath);
        } catch (IOException e) {
            log.warn("Failed to stat zip file: {}", zipPath, e);
            zipSize = 0L;
        }

        ZipResult result = new ZipResult();
        result.setZipPath(zipPath);
        result.setSize(zipSize);
        result.setFileName(rootName + ".zip");
        return result;
    }

    private String zipEntryName(Path baseDir, String rootName, Path file) {
        Path base = baseDir.toAbsolutePath().normalize();
        Path target = file.toAbsolutePath().normalize();
        if (base.equals(target)) {
            return rootName;
        }
        String rel = base.relativize(target).toString().replace('\\', '/');
        return rootName + "/" + rel;
    }

    private String resolveZipRootName(Path dirPath, Path workspaceRoot) {
        try {
            Path normalizedDir = dirPath.toAbsolutePath().normalize();
            Path normalizedRoot = workspaceRoot.toAbsolutePath().normalize();
            return normalizedDir.equals(normalizedRoot)
                    ? normalizedRoot.getFileName().toString()
                    : normalizedDir.getFileName().toString();
        } catch (Exception e) {
            return "workspace";
        }
    }

    private static String formatSize(long bytes) {
        if (bytes >= 1024 * 1024 * 1024) {
            return String.format("%.1f GB", bytes / (1024.0 * 1024 * 1024));
        }
        if (bytes >= 1024 * 1024) {
            return String.format("%.1f MB", bytes / (1024.0 * 1024));
        }
        if (bytes >= 1024) {
            return String.format("%.1f KB", bytes / 1024.0);
        }
        return bytes + " B";
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

    @Data
    public static class DownloadResult {
        private Path path;
        private long size;
        private String fileName;
    }

    @Data
    public static class ZipResult {
        private Path zipPath;
        private long size;
        private String fileName;
    }
}
