package cn.etarch.mao.file.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.harness.safety.PathSandbox;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Read-only Git status / diff for cloud workspaces.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WorkspaceGitService {

    private static final long GIT_TIMEOUT_SECONDS = 10;
    private static final int MAX_STDOUT_BYTES = 2 * 1024 * 1024;
    private static final int MAX_DIFF_LINES = 5000;
    private static final int MAX_DIFF_BYTES = 512 * 1024;

    private final PathSandbox pathSandbox;

    public GitStatusDTO getStatus(String sessionWorkspace) {
        Path workspace = pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace);
        GitStatusDTO dto = new GitStatusDTO();

        String repoRootStr = runGitOk(workspace, "rev-parse", "--show-toplevel");
        if (repoRootStr == null) {
            dto.setIsGit(false);
            return dto;
        }

        Path repoRoot = Path.of(repoRootStr.trim()).toAbsolutePath().normalize();
        dto.setIsGit(true);
        dto.setRepoRoot(repoRoot.toString());

        String branch = runGitOk(repoRoot, "rev-parse", "--abbrev-ref", "HEAD");
        dto.setBranch(branch != null ? branch.trim() : null);

        Map<String, GitChangedFileDTO> files = collectChangedFiles(repoRoot);
        int insertions = 0;
        int deletions = 0;
        for (GitChangedFileDTO file : files.values()) {
            insertions += Math.max(0, file.getInsertions());
            deletions += Math.max(0, file.getDeletions());
        }
        dto.setInsertions(insertions);
        dto.setDeletions(deletions);
        dto.setChangedFileCount(files.size());
        dto.setFiles(new ArrayList<>(files.values()));
        return dto;
    }

    public GitFileDiffDTO getFileDiff(String sessionWorkspace, String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "文件路径不能为空");
        }
        String normalized = relativePath.replace('\\', '/').replaceAll("^\\./", "");
        if (normalized.contains("..")) {
            throw new BusinessException(ErrorCode.FORBIDDEN, "路径访问被拒绝");
        }

        Path workspace = pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace);
        String repoRootStr = runGitOk(workspace, "rev-parse", "--show-toplevel");
        if (repoRootStr == null) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "当前工作区不是 Git 仓库");
        }
        Path repoRoot = Path.of(repoRootStr.trim()).toAbsolutePath().normalize();

        Path absolute = repoRoot.resolve(normalized).normalize();
        if (!absolute.startsWith(repoRoot)) {
            throw new BusinessException(ErrorCode.FORBIDDEN, "路径访问被拒绝");
        }
        try {
            pathSandbox.resolve(absolute.toString(), sessionWorkspace);
        } catch (SecurityException e) {
            throw new BusinessException(ErrorCode.FORBIDDEN, "路径访问被拒绝");
        }

        Map<String, GitChangedFileDTO> files = collectChangedFiles(repoRoot);
        GitChangedFileDTO meta = files.get(normalized);
        if (meta == null) {
            meta = new GitChangedFileDTO();
            meta.setPath(normalized);
            meta.setChangeType(inferChangeType(repoRoot, normalized, absolute));
        }

        GitFileDiffDTO diff = new GitFileDiffDTO();
        diff.setPath(normalized);
        diff.setChangeType(meta.getChangeType());

        String before = showHeadContent(repoRoot, meta.getOldPath() != null ? meta.getOldPath() : normalized);
        String after = "";
        boolean afterMissing = !Files.exists(absolute) || !Files.isRegularFile(absolute);
        if (!afterMissing) {
            ReadResult afterRead = readTextLimited(absolute);
            if (afterRead.binary()) {
                diff.setBinary(true);
                diff.setUnavailableReason("二进制文件，无法预览");
                diff.setBeforeContent("");
                diff.setAfterContent("");
                return diff;
            }
            after = afterRead.content();
            if (afterRead.truncated()) {
                diff.setTruncated(true);
            }
        }

        if (before != null && isBinaryString(before)) {
            diff.setBinary(true);
            diff.setUnavailableReason("二进制文件，无法预览");
            diff.setBeforeContent("");
            diff.setAfterContent("");
            return diff;
        }

        if (before == null) {
            before = "";
        }
        TruncateResult beforeTrunc = truncateText(before);
        TruncateResult afterTrunc = truncateText(after);
        diff.setBeforeContent(beforeTrunc.content());
        diff.setAfterContent(afterTrunc.content());
        if (beforeTrunc.truncated() || afterTrunc.truncated() || Boolean.TRUE.equals(diff.getTruncated())) {
            diff.setTruncated(true);
        }
        return diff;
    }

    private Map<String, GitChangedFileDTO> collectChangedFiles(Path repoRoot) {
        Map<String, GitChangedFileDTO> files = new LinkedHashMap<>();

        String nameStatus = runGitOk(repoRoot, "diff", "--name-status", "HEAD");
        if (nameStatus != null && !nameStatus.isBlank()) {
            for (String line : nameStatus.split("\n")) {
                line = line.trim();
                if (line.isEmpty()) continue;
                GitChangedFileDTO file = parseNameStatusLine(line);
                if (file != null) {
                    files.put(file.getPath(), file);
                }
            }
        }

        String numstat = runGitOk(repoRoot, "diff", "--numstat", "HEAD");
        if (numstat != null && !numstat.isBlank()) {
            for (String line : numstat.split("\n")) {
                line = line.trim();
                if (line.isEmpty()) continue;
                String[] parts = line.split("\t");
                if (parts.length < 3) continue;
                String path = parts[parts.length - 1].replace('\\', '/');
                if (path.contains(" => ")) {
                    path = path.substring(path.lastIndexOf(" => ") + 4).trim();
                }
                GitChangedFileDTO file = files.get(path);
                if (file == null) continue;
                if ("-".equals(parts[0]) || "-".equals(parts[1])) {
                    file.setBinary(true);
                    file.setInsertions(0);
                    file.setDeletions(0);
                } else {
                    file.setInsertions(parseIntSafe(parts[0]));
                    file.setDeletions(parseIntSafe(parts[1]));
                }
            }
        }

        String untracked = runGitOk(repoRoot, "ls-files", "--others", "--exclude-standard");
        if (untracked != null && !untracked.isBlank()) {
            for (String line : untracked.split("\n")) {
                String path = line.trim().replace('\\', '/');
                if (path.isEmpty() || files.containsKey(path)) continue;
                GitChangedFileDTO file = new GitChangedFileDTO();
                file.setPath(path);
                file.setChangeType("CREATED");
                file.setUntracked(true);
                Path abs = repoRoot.resolve(path).normalize();
                if (Files.isRegularFile(abs)) {
                    ReadResult read = readTextLimited(abs);
                    if (read.binary()) {
                        file.setBinary(true);
                        file.setInsertions(0);
                        file.setDeletions(0);
                    } else {
                        file.setInsertions(countLines(read.content()));
                        file.setDeletions(0);
                    }
                }
                files.put(path, file);
            }
        }

        return files;
    }

    private GitChangedFileDTO parseNameStatusLine(String line) {
        String[] parts = line.split("\t");
        if (parts.length < 2) return null;
        String status = parts[0].trim();
        char code = status.isEmpty() ? '?' : status.charAt(0);
        GitChangedFileDTO file = new GitChangedFileDTO();
        switch (code) {
            case 'A' -> {
                file.setChangeType("CREATED");
                file.setPath(parts[1].replace('\\', '/'));
            }
            case 'M' -> {
                file.setChangeType("MODIFIED");
                file.setPath(parts[1].replace('\\', '/'));
            }
            case 'D' -> {
                file.setChangeType("DELETED");
                file.setPath(parts[1].replace('\\', '/'));
            }
            case 'R' -> {
                if (parts.length < 3) return null;
                file.setChangeType("RENAMED");
                file.setOldPath(parts[1].replace('\\', '/'));
                file.setPath(parts[2].replace('\\', '/'));
            }
            case 'C' -> {
                if (parts.length < 3) return null;
                file.setChangeType("COPIED");
                file.setOldPath(parts[1].replace('\\', '/'));
                file.setPath(parts[2].replace('\\', '/'));
            }
            default -> {
                file.setChangeType("MODIFIED");
                file.setPath(parts[parts.length - 1].replace('\\', '/'));
            }
        }
        return file;
    }

    private String inferChangeType(Path repoRoot, String path, Path absolute) {
        boolean inHead = showHeadContent(repoRoot, path) != null;
        boolean inWorktree = Files.isRegularFile(absolute);
        if (!inHead && inWorktree) return "CREATED";
        if (inHead && !inWorktree) return "DELETED";
        return "MODIFIED";
    }

    private String showHeadContent(Path repoRoot, String path) {
        if (path == null || path.isBlank()) return null;
        GitResult result = runGit(repoRoot, "show", "HEAD:" + path);
        if (result.exitCode() != 0) {
            return null;
        }
        return result.stdout();
    }

    private ReadResult readTextLimited(Path file) {
        try {
            byte[] bytes = Files.readAllBytes(file);
            for (byte b : bytes) {
                if (b == 0) {
                    return new ReadResult("", false, true);
                }
            }
            String content = new String(bytes, StandardCharsets.UTF_8);
            TruncateResult trunc = truncateText(content);
            return new ReadResult(trunc.content(), trunc.truncated(), false);
        } catch (IOException e) {
            log.warn("Failed to read file for git diff: {}", file, e);
            return new ReadResult("", false, true);
        }
    }

    private TruncateResult truncateText(String content) {
        if (content == null) {
            return new TruncateResult("", false);
        }
        boolean truncated = false;
        String[] lines = content.split("\n", -1);
        if (lines.length > MAX_DIFF_LINES) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < MAX_DIFF_LINES; i++) {
                if (i > 0) sb.append('\n');
                sb.append(lines[i]);
            }
            content = sb.toString();
            truncated = true;
        }
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_DIFF_BYTES) {
            int end = MAX_DIFF_BYTES;
            while (end > 0 && (bytes[end - 1] & 0xC0) == 0x80) {
                end--;
            }
            content = new String(bytes, 0, end, StandardCharsets.UTF_8);
            truncated = true;
        }
        return new TruncateResult(content, truncated);
    }

    private boolean isBinaryString(String content) {
        for (int i = 0; i < content.length(); i++) {
            if (content.charAt(i) == '\0') return true;
        }
        return false;
    }

    private int countLines(String content) {
        if (content == null || content.isEmpty()) return 0;
        int lines = 1;
        for (int i = 0; i < content.length(); i++) {
            if (content.charAt(i) == '\n') lines++;
        }
        if (content.endsWith("\n") && lines > 1) lines--;
        return Math.max(lines, 1);
    }

    private int parseIntSafe(String s) {
        try {
            return Integer.parseInt(s.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private String runGitOk(Path cwd, String... args) {
        GitResult result = runGit(cwd, args);
        if (result.exitCode() != 0) {
            return null;
        }
        return result.stdout();
    }

    private GitResult runGit(Path cwd, String... args) {
        List<String> command = new ArrayList<>();
        command.add("git");
        command.add("-c");
        command.add("core.quotepath=false");
        for (String arg : args) {
            command.add(arg);
        }

        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(cwd.toFile());
        pb.redirectErrorStream(true);

        try {
            Process process = pb.start();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            try (InputStream in = process.getInputStream()) {
                byte[] chunk = new byte[8192];
                int n;
                while ((n = in.read(chunk)) >= 0) {
                    int allowed = MAX_STDOUT_BYTES - buffer.size();
                    if (allowed <= 0) break;
                    buffer.write(chunk, 0, Math.min(n, allowed));
                }
            }
            boolean finished = process.waitFor(GIT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                log.warn("git timed out: {} in {}", String.join(" ", args), cwd);
                return new GitResult(124, "");
            }
            String stdout = buffer.toString(StandardCharsets.UTF_8);
            return new GitResult(process.exitValue(), stdout);
        } catch (IOException e) {
            log.warn("git not available or failed: {} in {}", String.join(" ", args), cwd, e);
            return new GitResult(127, e.getMessage() != null ? e.getMessage() : "");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new GitResult(130, "");
        }
    }

    private record GitResult(int exitCode, String stdout) {}

    private record TruncateResult(String content, boolean truncated) {}

    private record ReadResult(String content, boolean truncated, boolean binary) {}

    @Data
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static class GitStatusDTO {
        @JsonProperty("isGit")
        private boolean git;
        private String repoRoot;
        private String branch;
        private int insertions;
        private int deletions;
        private int changedFileCount;
        private List<GitChangedFileDTO> files;
        private String error;

        public void setIsGit(boolean isGit) {
            this.git = isGit;
        }

        public boolean getIsGit() {
            return git;
        }
    }

    @Data
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static class GitChangedFileDTO {
        private String path;
        private String oldPath;
        private String changeType;
        private Boolean untracked;
        private int insertions;
        private int deletions;
        private Boolean binary;
    }

    @Data
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static class GitFileDiffDTO {
        private String path;
        private String changeType;
        private String beforeContent;
        private String afterContent;
        private Boolean truncated;
        private Boolean binary;
        private String unavailableReason;
    }
}
