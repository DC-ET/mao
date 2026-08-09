package cn.etarch.mao.file.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.harness.safety.PathSandbox;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.annotation.PreDestroy;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
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

    /** 多仓库发现时的仓库统计并发上限：避免大量 git 子进程同时启动耗尽服务器资源。 */
    private static final int REPO_SCAN_CONCURRENCY = 8;

    private final PathSandbox pathSandbox;

    /** 仓库统计专用线程池：固定并发，不受公共 ForkJoinPool（CPU 核数-1）钳制。 */
    private final ExecutorService repoScanExecutor = Executors.newFixedThreadPool(REPO_SCAN_CONCURRENCY);

    @PreDestroy
    void shutdownExecutor() {
        repoScanExecutor.shutdownNow();
    }

    /**
     * 多仓库工作区仓库发现：
     * - 工作区本身是 git 仓库时返回 { isRootGit: true, repos: [] }，前端走现有单仓库逻辑；
     * - 否则扫描一级子目录中的 git 仓库（目录含 .git 目录或文件），并发执行轻量统计后按目录名排序。
     */
    public GitReposDTO listRepos(String sessionWorkspace) {
        Path workspace = pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace);
        GitReposDTO dto = new GitReposDTO();

        String repoRootStr = runGitOk(workspace, "rev-parse", "--show-toplevel");
        if (repoRootStr != null) {
            dto.setIsRootGit(true);
            dto.setRepos(List.of());
            return dto;
        }

        dto.setIsRootGit(false);
        List<Path> repoDirs = new ArrayList<>();
        if (Files.isDirectory(workspace)) {
            try (var stream = Files.list(workspace)) {
                stream.filter(Files::isDirectory)
                        .filter(dir -> Files.exists(dir.resolve(".git")))
                        .forEach(repoDirs::add);
            } catch (IOException e) {
                log.warn("Failed to list git repos under workspace {}: {}", workspace, e.getMessage());
            }
        }

        // 有界并发统计：每仓库仅 1 条 git status --porcelain=v2 命令，固定线程池并发
        List<GitRepoSummaryDTO> repos = new ArrayList<>();
        if (!repoDirs.isEmpty()) {
            // Map<repoDir, Future> 关联，避免 RejectedExecutionException 跳过仓库后索引错位
            Map<Path, Future<GitRepoSummaryDTO>> futures = new LinkedHashMap<>();
            for (Path dir : repoDirs) {
                try {
                    futures.put(dir, repoScanExecutor.submit(() -> summarizeRepo(dir)));
                } catch (java.util.concurrent.RejectedExecutionException e) {
                    // 线程池已关闭（应用停机窗口）：记录并跳过该仓库，避免接口 500
                    log.warn("Repo scan executor rejected task for {}, skip: {}", dir, e.getMessage());
                }
            }
            for (Map.Entry<Path, Future<GitRepoSummaryDTO>> entry : futures.entrySet()) {
                Path dir = entry.getKey();
                Future<GitRepoSummaryDTO> future = entry.getValue();
                GitRepoSummaryDTO summary;
                try {
                    // summarizeRepo 内部已有 10s 超时，这里再留 5s 余量兜底，避免请求线程无限阻塞
                    summary = future.get(GIT_TIMEOUT_SECONDS + 5, TimeUnit.SECONDS);
                } catch (java.util.concurrent.TimeoutException e) {
                    // 超时：cancel 该任务，并保留 unavailable 占位（与失败路径一致，仓库不消失）
                    future.cancel(true);
                    summary = unavailableRepo(dir);
                    log.warn("Repo summary timed out for {}, marked unavailable", dir);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    summary = unavailableRepo(dir);
                } catch (java.util.concurrent.ExecutionException e) {
                    summary = unavailableRepo(dir);
                    log.warn("Repo summary failed for {}: {}", dir, e.getMessage());
                }
                if (summary != null) repos.add(summary);
            }
        }
        repos.sort(Comparator.comparing(GitRepoSummaryDTO::getName));
        dto.setRepos(repos);
        return dto;
    }

    /** 统计失败的仓库占位：保留条目并标记 unavailable，避免前端静默丢失。 */
    private static GitRepoSummaryDTO unavailableRepo(Path repoDir) {
        GitRepoSummaryDTO dto = new GitRepoSummaryDTO();
        dto.setName(repoDir.getFileName().toString());
        dto.setPath(repoDir.getFileName().toString());
        dto.setUnavailable(true);
        return dto;
    }

    /**
     * 对单个仓库目录执行轻量统计：分支 + 变更文件数（不含文件明细、不含行数）。
     * 实现要点：
     * - 单条 `git status --porcelain=v2 --branch -M --untracked-files=all` 同时取分支与变更计数，
     *   36 仓库只需 36 次 git 进程（此前每仓库 4 次 = 144 次）；
     * - stdout 由独立 daemon 线程逐行读取统计（内存 O(1)），主线程只做带超时的 waitFor：
     *   即使 git 卡死/输出超限，超时后 destroyForcibly 关闭管道、读线程随之结束，不占线程池；
     * - stderr 直接 DISCARD（不合并、不读取），避免 git 警告混入计数，也避免管道缓冲写满死锁；
     * - 分支取自 `# branch.head`（detached 显示 (detached)，映射为 "HEAD" 与存量 rev-parse 语义一致）；
     * - 变更文件数 = 非 # 注释行数（tracked 行以 1/2 开头、untracked 行以 ? 开头）；
     * - 失败/超时返回 unavailable 占位条目，仓库不静默消失。
     */
    private GitRepoSummaryDTO summarizeRepo(Path repoDir) {
        Process process = null;
        try {
            ProcessBuilder pb = new ProcessBuilder("git", "-c", "core.quotepath=false",
                    "status", "--porcelain=v2", "--branch", "-M", "--untracked-files=all");
            pb.directory(repoDir.toFile());
            pb.redirectError(ProcessBuilder.Redirect.DISCARD);
            process = pb.start();
            final Process proc = process; // lambda 需 effectively final 引用

            final String[] branchHolder = new String[1];
            final int[] countHolder = new int[1];
            final List<String> untrackedPaths = new ArrayList<>();
            Thread reader = new Thread(() -> {
                try (BufferedReader br = new BufferedReader(
                        new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    int count = 0;
                    String branch = null;
                    while ((line = br.readLine()) != null) {
                        if (line.isEmpty()) continue;
                        if (line.charAt(0) == '#') {
                            if (line.startsWith("# branch.head ")) {
                                String name = line.substring("# branch.head ".length()).trim();
                                // detached HEAD 时 porcelain 输出 "(detached)"，映射为 "HEAD"
                                branch = "(detached)".equals(name) ? "HEAD" : name;
                            }
                            continue;
                        }
                        count++;
                        if (line.startsWith("? ")) {
                            untrackedPaths.add(line.substring(2));
                        }
                    }
                    branchHolder[0] = branch;
                    countHolder[0] = count;
                } catch (IOException ignored) {
                    // 进程被超时强杀时管道关闭，忽略
                }
            }, "git-repo-summarize-" + repoDir.getFileName());
            reader.setDaemon(true);
            reader.start();

            boolean finished = process.waitFor(GIT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS); // 等待进程退出、管道关闭，读线程随之结束
                log.warn("git status timed out in {}", repoDir);
                return unavailableRepo(repoDir);
            }
            try {
                reader.join(5000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            if (process.exitValue() != 0) {
                log.warn("git status failed in {} (exit {})", repoDir, process.exitValue());
                return unavailableRepo(repoDir);
            }

            GitRepoSummaryDTO dto = new GitRepoSummaryDTO();
            dto.setName(repoDir.getFileName().toString());
            dto.setPath(repoDir.getFileName().toString());
            dto.setBranch(branchHolder[0]);
            dto.setChangedFileCount(countHolder[0]);
            if (countHolder[0] > 0) {
                int[] lineStats = collectRepoLineStats(repoDir, untrackedPaths);
                dto.setInsertions(lineStats[0]);
                dto.setDeletions(lineStats[1]);
            }
            return dto;
        } catch (IOException e) {
            log.warn("Failed to summarize git repo {}: {}", repoDir, e.getMessage());
            return unavailableRepo(repoDir);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            // 中断时销毁仍在运行的 git 进程，避免孤儿进程/读线程残留
            if (process != null) {
                process.destroyForcibly();
            }
            log.warn("Summarize git repo interrupted: {}", repoDir);
            return unavailableRepo(repoDir);
        }
    }

    private int[] collectRepoLineStats(Path repoDir, List<String> untrackedPaths) {
        int insertions = 0;
        int deletions = 0;
        String numstat = runGitOk(repoDir, "diff", "--numstat", "HEAD");
        if (numstat == null && runGitOk(repoDir, "rev-parse", "--verify", "HEAD") == null) {
            numstat = runGitOk(repoDir, "diff", "--numstat", "--cached");
        }
        if (numstat != null) {
            for (String line : numstat.split("\n")) {
                String[] parts = line.split("\t");
                if (parts.length < 3 || "-".equals(parts[0]) || "-".equals(parts[1])) continue;
                insertions += parseIntSafe(parts[0]);
                deletions += parseIntSafe(parts[1]);
            }
        }
        for (String relativePath : untrackedPaths) {
            Path file = repoDir.resolve(relativePath).normalize();
            if (!file.startsWith(repoDir) || !Files.isRegularFile(file)) continue;
            ReadResult read = readTextLimited(file);
            if (!read.binary()) insertions += countLines(read.content());
        }
        return new int[]{insertions, deletions};
    }

    /**
     * 解析可选 repoPath 为仓库执行目录：
     * - 为空时返回工作区本身（现有单仓库行为）；
     * - 非空时必须为工作区的一级子目录名，拒绝 ..、绝对路径、多级路径，并过 sandbox 校验。
     */
    private Path resolveRepoDir(Path workspace, String repoPath) {
        if (repoPath == null || repoPath.isBlank()) {
            return workspace;
        }
        String normalized = repoPath.replace('\\', '/').replaceAll("^/+", "").replaceAll("/+$", "");
        // 仅允许单段目录名：拒绝空、"."、多级路径与 .. 路径段（按段精确匹配，避免误杀 my..repo 之类合法名）
        if (normalized.isEmpty() || ".".equals(normalized) || normalized.contains("/")
                || java.util.Arrays.stream(normalized.split("/")).anyMatch(".."::equals)) {
            throw new BusinessException(ErrorCode.FORBIDDEN, "路径访问被拒绝");
        }
        Path repoDir;
        try {
            repoDir = workspace.resolve(normalized).normalize();
        } catch (RuntimeException e) {
            // 非法路径字符（如 NUL）统一按拒绝处理，避免 500
            throw new BusinessException(ErrorCode.FORBIDDEN, "路径访问被拒绝");
        }
        if (!repoDir.startsWith(workspace) || !Files.isDirectory(repoDir)) {
            throw new BusinessException(ErrorCode.FORBIDDEN, "路径访问被拒绝");
        }
        try {
            pathSandbox.resolve(repoDir.toString(), workspace.toString());
        } catch (SecurityException e) {
            throw new BusinessException(ErrorCode.FORBIDDEN, "路径访问被拒绝");
        }
        return repoDir;
    }

    public GitStatusDTO getStatus(String sessionWorkspace, String repoPath) {
        Path workspace = pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace);
        Path repoDir = resolveRepoDir(workspace, repoPath);
        GitStatusDTO dto = new GitStatusDTO();

        String repoRootStr = runGitOk(repoDir, "rev-parse", "--show-toplevel");
        if (repoRootStr == null) {
            dto.setIsGit(false);
            return dto;
        }

        Path repoRoot = Path.of(repoRootStr.trim()).toAbsolutePath().normalize();
        dto.setIsGit(true);
        dto.setRepoRoot(repoRoot.toString());

        String branch = runGitOk(repoRoot, "rev-parse", "--abbrev-ref", "HEAD");
        if (branch == null) {
            // 空仓库（无 commit）时 rev-parse 失败，用 symbolic-ref 取 unborn 分支名，与 getRepos 口径一致
            String symbolic = runGitOk(repoRoot, "symbolic-ref", "--short", "HEAD");
            branch = symbolic != null ? symbolic.trim() : null;
        }
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

    public GitFileDiffDTO getFileDiff(String sessionWorkspace, String repoPath, String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "文件路径不能为空");
        }
        String normalized = relativePath.replace('\\', '/').replaceAll("^\\./", "");
        // 按路径段精确匹配 ..，避免误杀含 .. 子串的合法文件路径（如 src/a..b.ts）
        if (java.util.Arrays.stream(normalized.split("/")).anyMatch(".."::equals)) {
            throw new BusinessException(ErrorCode.FORBIDDEN, "路径访问被拒绝");
        }

        Path workspace = pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace);
        Path repoDir = resolveRepoDir(workspace, repoPath);
        String repoRootStr = runGitOk(repoDir, "rev-parse", "--show-toplevel");
        if (repoRootStr == null) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "当前工作区不是 Git 仓库");
        }
        Path repoRoot = Path.of(repoRootStr.trim()).toAbsolutePath().normalize();

        Path absolute;
        try {
            absolute = repoRoot.resolve(normalized).normalize();
        } catch (RuntimeException e) {
            // 非法路径字符（如 NUL）统一按拒绝处理，避免 500
            throw new BusinessException(ErrorCode.FORBIDDEN, "路径访问被拒绝");
        }
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
        if (nameStatus == null && runGitOk(repoRoot, "rev-parse", "--verify", "HEAD") == null) {
            // 空仓库（无 commit，HEAD 不存在）：diff --name-status HEAD 必然失败，
            // 回退到 --cached 统计已 staged 的文件，与 getRepos（porcelain 计入 staged）口径一致
            nameStatus = runGitOk(repoRoot, "diff", "--name-status", "--cached");
        }
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
        if (numstat == null && runGitOk(repoRoot, "rev-parse", "--verify", "HEAD") == null) {
            numstat = runGitOk(repoRoot, "diff", "--numstat", "--cached");
        }
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
    public static class GitReposDTO {
        @JsonProperty("isRootGit")
        private boolean rootGit;
        private List<GitRepoSummaryDTO> repos;

        public void setIsRootGit(boolean isRootGit) {
            this.rootGit = isRootGit;
        }

        public boolean getIsRootGit() {
            return rootGit;
        }
    }

    @Data
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static class GitRepoSummaryDTO {
        private String name;
        private String path;
        private String branch;
        private int changedFileCount;
        private int insertions;
        private int deletions;
        /** 统计失败/超时标记：为 true 时保留占位条目，前端展示「不可用」，避免仓库静默消失。 */
        private Boolean unavailable;
    }

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
