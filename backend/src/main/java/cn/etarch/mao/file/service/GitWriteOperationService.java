package cn.etarch.mao.file.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.file.service.GitCommitMessageService.CommitFile;
import cn.etarch.mao.file.service.GitCommitMessageService.CommitGenerationInput;
import cn.etarch.mao.file.service.GitCommitMessageService.CommitMessage;
import cn.etarch.mao.harness.runtime.RuntimeDataResolver;
import cn.etarch.mao.session.activity.ActivityService;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.user.service.GitCredentialService;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;

@Slf4j
@Service
@RequiredArgsConstructor
public class GitWriteOperationService {
    private static final long TIMEOUT_SECONDS = 60;
    private static final int MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
    private static final int MAX_ERROR_LENGTH = 500;
    private static final Pattern SENSITIVE_NAME = Pattern.compile(
            "(^|/)(\\.env($|\\.)|id_(rsa|dsa|ecdsa|ed25519)(\\..*)?$)|\\.(pem|key|p12|pfx)$|(^|/)[^/]*(credential|credentials|secret|secrets|token)[^/]*$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern CREDENTIAL_URL = Pattern.compile("(?i)(https?://)([^/@\\s]+@)");
    static final String ASKPASS = """
            #!/bin/bash
            PROMPT="$1"
            if echo "$PROMPT" | grep -qi 'username'; then
              echo "oauth2"
              exit 0
            fi
            URL=$(echo "$PROMPT" | sed -n "s/.*'https:\\/\\/\\([^']*\\)'.*/\\1/p")
            if [ -z "$URL" ]; then
              URL=$(echo "$PROMPT" | sed -n "s/.*'http:\\/\\/\\([^']*\\)'.*/\\1/p")
            fi
            if [ -z "$URL" ]; then
              exit 1
            fi
            HOST="${URL##*@}"
            HOST="${HOST%%/*}"
            VARNAME="GIT_TOKEN_$(echo "$HOST" | tr '.-' '__')"
            VALUE="${!VARNAME}"
            if [ -n "$VALUE" ]; then
              echo "$VALUE"
            fi
            """;

    private final WorkspaceGitService workspaceGitService;
    private final GitCommitMessageService commitMessageService;
    private final GitCredentialService credentialService;
    private final RuntimeDataResolver runtimeDataResolver;
    private final ActivityService activityService;
    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<Path, ReentrantLock> locks = new ConcurrentHashMap<>();

    public GitOperationResult commit(Session session, String repoPath) {
        return locked(session, repoPath, "commit", (repo, started) -> {
            Map<String, WorkspaceGitService.GitChangedFileDTO> changes = workspaceGitService.changedFiles(repo);
            if (changes.isEmpty()) throw new BusinessException(ErrorCode.PARAM_INVALID, "没有待提交的变更");
            CommitMessage generated = commitMessageService.generate(session, buildCommitInput(repo, changes));
            GitResult add = run(repo, List.of("add", "-A"), Map.of());
            requireSuccess(add, "暂存变更失败");

            List<String> args = new ArrayList<>();
            boolean hasName = run(repo, List.of("config", "--get", "user.name"), Map.of()).success();
            boolean hasEmail = run(repo, List.of("config", "--get", "user.email"), Map.of()).success();
            if (!hasName) { args.add("-c"); args.add("user.name=Mao Agent"); }
            if (!hasEmail) { args.add("-c"); args.add("user.email=mao@etarch.cn"); }
            args.addAll(List.of("commit", "--no-verify", "-m", generated.message()));
            GitResult commit = run(repo, args, Map.of());
            requireSuccess(commit, "提交失败");
            String hash = requireOutput(run(repo, List.of("rev-parse", "--short", "HEAD"), Map.of()), "读取提交哈希失败");
            String branch = branch(repo);
            GitOperationResult result = GitOperationResult.success("commit", branch,
                    "提交成功 " + hash + "：" + generated.title());
            result.setCommitHash(hash);
            result.setCommitTitle(generated.title());
            return result;
        });
    }

    /**
     * 手动刷新远端引用。fetch 失败属于可恢复的状态确认失败，因此始终返回最新本地状态，
     * 不将远端网络或认证错误升级为 HTTP 请求失败。
     */
    public WorkspaceGitService.GitStatusDTO refreshRemoteStatus(Session session, String repoPath) {
        Path repo = resolveRepository(session, repoPath);
        ReentrantLock lock = locks.computeIfAbsent(repo, ignored -> new ReentrantLock());
        if (!lock.tryLock()) throw new BusinessException(ErrorCode.PARAM_INVALID, "Git 操作进行中");
        try {
            RemoteState state = remoteState(repo);
            String remote = selectRefreshRemote(repo, state);
            if (remote == null) {
                WorkspaceGitService.GitStatusDTO status = workspaceGitService.getStatus(session.getWorkspace(), repoPath);
                status.setRemoteStatusAvailable(false);
                status.setRemoteStatusError(state.remotes().isEmpty()
                        ? "仓库未配置远端"
                        : "存在多个远端且没有 origin，无法确认远端状态");
                return status;
            }

            GitResult fetch = run(repo, List.of("fetch", "--prune", remote), credentialEnv(session));
            WorkspaceGitService.GitStatusDTO status = workspaceGitService.getStatus(session.getWorkspace(), repoPath);
            if (fetch.success()) {
                status.setRemoteStatusAvailable(true);
                status.setRemoteStatusError(null);
                status.setHasCommitsToPush(hasCommitsToPush(repo, status, remote));
            } else {
                status.setRemoteStatusAvailable(false);
                status.setRemoteStatusError(classify(fetch, "远端状态刷新失败"));
            }
            return status;
        } finally {
            lock.unlock();
        }
    }

    public GitOperationResult pull(Session session, String repoPath) {
        return locked(session, repoPath, "pull", (repo, started) -> {
            RemoteState state = remoteState(repo);
            requirePullPushState(state);
            String operationId = UUID.randomUUID().toString();
            String stashOid = null;
            String stashRef = null;
            if (hasChanges(repo)) {
                GitResult stash = run(repo, List.of("stash", "push", "--include-untracked", "-m", "mao-auto-pull-" + operationId), Map.of());
                requireSuccess(stash, "自动 stash 创建失败");
                stashOid = requireOutput(run(repo, List.of("rev-parse", "stash@{0}"), Map.of()), "读取 stash 失败");
                stashRef = findStashRef(repo, stashOid);
            }
            GitResult pull = run(repo, List.of("pull", "--no-edit"), credentialEnv(session));
            boolean pullConflict = hasConflicts(repo);
            boolean mergeInProgress = run(repo, List.of("rev-parse", "--verify", "-q", "MERGE_HEAD"), Map.of()).success();
            if (!pull.success()) {
                if (pullConflict || mergeInProgress) {
                    throw failure("拉取进入未完成合并状态，已保留合并现场和 " + safeStash(stashRef, stashOid), true, stashRef, pull);
                }
                if (stashOid != null) restoreStash(repo, stashOid, stashRef);
                throw failure(classify(pull, "拉取失败"), false, null, pull);
            }
            if (stashOid != null) restoreStash(repo, stashOid, stashRef);
            return GitOperationResult.success("pull", state.branch(),
                    pull.output().contains("Already up to date") ? "已是最新状态" : "当前分支已更新");
        });
    }

    public GitOperationResult push(Session session, String repoPath) {
        return locked(session, repoPath, "push", (repo, started) -> {
            RemoteState state = remoteState(repo);
            requirePullPushState(state);
            List<String> args;
            if (state.upstream() != null) {
                args = List.of("push");
            } else {
                String remote;
                if (state.remotes().contains("origin")) remote = "origin";
                else if (state.remotes().size() == 1) remote = state.remotes().get(0);
                else throw new BusinessException(ErrorCode.PARAM_INVALID, "存在多个远端且没有 origin，请先配置 upstream");
                args = List.of("push", "--set-upstream", remote, state.branch());
            }
            GitResult push = run(repo, args, credentialEnv(session));
            if (!push.success()) throw new BusinessException(ErrorCode.INTERNAL_ERROR, classify(push, "推送失败"));
            return GitOperationResult.success("push", state.branch(), "当前分支已推送");
        });
    }

    public void recordLocalActivity(Session session, LocalGitActivity request) {
        if (request == null || !List.of("commit", "pull", "push").contains(request.getOperation())) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Git 操作类型无效");
        }
        String type = "GIT_" + request.getOperation().toUpperCase(Locale.ROOT);
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("repoPath", limited(request.getRepoPath(), 256));
        detail.put("branch", limited(request.getBranch(), 256));
        detail.put("commitHash", limited(request.getCommitHash(), 64));
        detail.put("commitTitle", limited(request.getCommitTitle(), 512));
        detail.put("stashRef", limited(request.getStashRef(), 128));
        detail.put("conflict", request.isConflict());
        detail.put("error", sanitize(request.getError()));
        record(session.getId(), type, request.getRepoPath(), request.isSuccess(), request.getDurationMs(), detail);
    }

    CommitGenerationInput buildCommitInput(Path repo, Map<String, WorkspaceGitService.GitChangedFileDTO> changes) {
        List<CommitFile> files = new ArrayList<>();
        List<RawDiff> eligible = new ArrayList<>();
        for (WorkspaceGitService.GitChangedFileDTO changed : changes.values()) {
            CommitFile file = new CommitFile();
            file.setPath(changed.getPath());
            file.setChangeType(changed.getChangeType());
            file.setInsertions(changed.getInsertions());
            file.setDeletions(changed.getDeletions());
            file.setBinary(Boolean.TRUE.equals(changed.getBinary()));
            file.setSensitive(isSensitive(changed.getPath()) || isSensitive(changed.getOldPath()));
            files.add(file);
            if (!file.isBinary() && !file.isSensitive()) eligible.add(new RawDiff(file, readDiff(repo, changed)));
        }
        int quota = eligible.isEmpty() ? 0 : GitCommitMessageService.MAX_DIFF_BYTES / eligible.size();
        int bytes = 0;
        boolean truncated = false;
        for (RawDiff raw : eligible) {
            byte[] source = raw.diff().getBytes(StandardCharsets.UTF_8);
            int allowance = Math.min(quota, GitCommitMessageService.MAX_DIFF_BYTES - bytes);
            String value = utf8Prefix(source, allowance);
            raw.file().setDiff(value);
            int used = value.getBytes(StandardCharsets.UTF_8).length;
            bytes += used;
            if (used < source.length) { raw.file().setTruncated(true); truncated = true; }
        }
        CommitGenerationInput input = new CommitGenerationInput();
        input.setFiles(files);
        input.setDiffBytes(bytes);
        input.setTruncated(truncated);
        return input;
    }

    private String readDiff(Path repo, WorkspaceGitService.GitChangedFileDTO file) {
        if (Boolean.TRUE.equals(file.getUntracked())) {
            Path path = repo.resolve(file.getPath()).normalize();
            if (!path.startsWith(repo) || !Files.isRegularFile(path)) return "";
            try (InputStream input = Files.newInputStream(path)) {
                byte[] bytes = input.readNBytes(GitCommitMessageService.MAX_DIFF_BYTES + 1);
                return "--- /dev/null\n+++ b/" + file.getPath() + "\n" + new String(bytes, StandardCharsets.UTF_8);
            } catch (IOException e) { return ""; }
        }
        GitResult result = run(repo, List.of("diff", "HEAD", "--", file.getPath()), Map.of());
        if (!result.success()) result = run(repo, List.of("diff", "--cached", "--", file.getPath()), Map.of());
        return result.success() ? result.output() : "";
    }

    private GitOperationResult locked(Session session, String repoPath, String operation, LockedOperation action) {
        Path repo = resolveRepository(session, repoPath);
        ReentrantLock lock = locks.computeIfAbsent(repo, ignored -> new ReentrantLock());
        if (!lock.tryLock()) throw new BusinessException(ErrorCode.PARAM_INVALID, "Git 操作进行中");
        Instant started = Instant.now();
        try {
            GitOperationResult result = action.run(repo, started);
            recordOperation(session, repoPath, result, started);
            return result;
        } catch (GitOperationException e) {
            GitOperationResult result = GitOperationResult.failed(operation, e.getMessage());
            result.setConflict(e.conflict);
            result.setStashRef(e.stashRef);
            recordOperation(session, repoPath, result, started);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, e.getMessage());
        } catch (BusinessException e) {
            GitOperationResult result = GitOperationResult.failed(operation, sanitize(e.getMessage()));
            recordOperation(session, repoPath, result, started);
            throw e;
        } finally {
            lock.unlock();
        }
    }

    private void restoreStash(Path repo, String oid, String stashRef) {
        GitResult apply = run(repo, List.of("stash", "apply", "--index", oid), Map.of());
        if (!apply.success() || hasConflicts(repo)) {
            throw failure("stash 恢复产生冲突或失败，已保留 " + safeStash(stashRef, oid), true, stashRef, apply);
        }
        String currentRef = findStashRef(repo, oid);
        if (currentRef != null) {
            GitResult drop = run(repo, List.of("stash", "drop", currentRef), Map.of());
            requireSuccess(drop, "stash 已恢复但清理失败，请手动删除 " + currentRef);
        }
    }

    private Path resolveRepository(Session session, String repoPath) {
        try {
            return workspaceGitService.resolveRepository(session.getWorkspace(), repoPath).toRealPath().normalize();
        } catch (IOException e) {
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "仓库路径解析失败");
        }
    }

    private String selectRefreshRemote(Path repo, RemoteState state) {
        if (state.upstream() != null) {
            String upstreamRemote = output(run(repo,
                    List.of("config", "--get", "branch." + state.branch() + ".remote"), Map.of()));
            if (upstreamRemote != null && state.remotes().contains(upstreamRemote)) return upstreamRemote;
        }
        if (state.remotes().contains("origin")) return "origin";
        return state.remotes().size() == 1 ? state.remotes().get(0) : null;
    }

    private RemoteState remoteState(Path repo) {
        String branch = output(run(repo, List.of("rev-parse", "--abbrev-ref", "HEAD"), Map.of()));
        boolean detached = "HEAD".equals(branch) && !run(repo, List.of("symbolic-ref", "-q", "HEAD"), Map.of()).success();
        String remoteOutput = output(run(repo, List.of("remote"), Map.of()));
        List<String> remotes = remoteOutput == null || remoteOutput.isBlank() ? List.of()
                : Arrays.stream(remoteOutput.split("\\n")).map(String::trim).filter(s -> !s.isEmpty()).sorted().toList();
        String upstream = output(run(repo, List.of("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"), Map.of()));
        return new RemoteState(branch, detached, remotes, upstream);
    }

    private boolean hasCommitsToPush(Path repo, WorkspaceGitService.GitStatusDTO status, String remote) {
        if (!status.isHasHead()) return false;
        if (status.getUpstream() != null) return status.getAheadCount() != null && status.getAheadCount() > 0;
        String branch = status.getBranch();
        if (branch == null || branch.isBlank()) return false;
        GitResult remoteBranch = run(repo, List.of("rev-parse", "--verify", "-q", "refs/remotes/" + remote + "/" + branch), Map.of());
        if (!remoteBranch.success()) return true;
        GitResult counts = run(repo, List.of("rev-list", "--left-right", "--count", "HEAD...refs/remotes/" + remote + "/" + branch), Map.of());
        if (!counts.success()) return false;
        String[] parts = counts.output().trim().split("\\s+");
        return parts.length == 2 && parseInt(parts[0]) > 0;
    }

    private static int parseInt(String value) {
        try { return Integer.parseInt(value); }
        catch (NumberFormatException e) { return 0; }
    }

    private void requirePullPushState(RemoteState state) {
        if (state.detached()) throw new BusinessException(ErrorCode.PARAM_INVALID, "detached HEAD，请先切换分支");
        if (state.remotes().isEmpty()) throw new BusinessException(ErrorCode.PARAM_INVALID, "仓库未配置远端");
    }

    private Map<String, String> credentialEnv(Session session) {
        Map<String, String> tokens = credentialService.getTokenMapByUser(session.getUserId());
        Map<String, String> env = new HashMap<>();
        env.put("GIT_TERMINAL_PROMPT", "0");
        if (tokens.isEmpty()) return env;
        try {
            Path script = runtimeDataResolver.resolveGitAskpassScript(session.getUserId(), session.getId());
            Files.createDirectories(script.getParent());
            Files.writeString(script, ASKPASS, StandardCharsets.UTF_8);
            try { Files.setPosixFilePermissions(script, PosixFilePermissions.fromString("rwx------")); }
            catch (UnsupportedOperationException ignored) { script.toFile().setExecutable(true, true); }
            env.put("GIT_ASKPASS", script.toString());
            tokens.forEach((domain, token) -> env.put(GitCredentialService.envVarNameForDomain(domain), token));
            return env;
        } catch (IOException e) {
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "Git 凭证环境初始化失败");
        }
    }

    private GitResult run(Path repo, List<String> args, Map<String, String> extraEnv) {
        List<String> command = new ArrayList<>();
        command.add("git"); command.add("-c"); command.add("core.quotepath=false"); command.addAll(args);
        Process process = null;
        try {
            ProcessBuilder builder = new ProcessBuilder(command).directory(repo.toFile()).redirectErrorStream(true);
            builder.environment().put("GIT_TERMINAL_PROMPT", "0");
            builder.environment().putAll(extraEnv);
            process = builder.start();
            process.getOutputStream().close();
            Process target = process;
            CompletableFuture<byte[]> reader = CompletableFuture.supplyAsync(() -> readLimited(target.getInputStream()));
            if (!process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly(); process.waitFor(5, TimeUnit.SECONDS);
                return new GitResult(124, "Git 子进程 60 秒超时");
            }
            return new GitResult(process.exitValue(), new String(reader.get(5, TimeUnit.SECONDS), StandardCharsets.UTF_8));
        } catch (Exception e) {
            if (process != null) process.destroyForcibly();
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            return new GitResult(127, "Git 子进程执行失败");
        }
    }

    private static byte[] readLimited(InputStream input) {
        try (input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int n;
            while ((n = input.read(buffer)) >= 0) {
                int allowed = MAX_OUTPUT_BYTES - out.size();
                if (allowed > 0) out.write(buffer, 0, Math.min(n, allowed));
            }
            return out.toByteArray();
        } catch (IOException e) { return new byte[0]; }
    }

    private boolean hasChanges(Path repo) {
        String status = output(run(repo, List.of("status", "--porcelain", "--untracked-files=all"), Map.of()));
        return status != null && !status.isBlank();
    }
    private boolean hasConflicts(Path repo) {
        String output = output(run(repo, List.of("diff", "--name-only", "--diff-filter=U"), Map.of()));
        return output != null && !output.isBlank();
    }
    private String branch(Path repo) { return output(run(repo, List.of("rev-parse", "--abbrev-ref", "HEAD"), Map.of())); }
    private String findStashRef(Path repo, String oid) {
        String list = output(run(repo, List.of("stash", "list", "--format=%H %gd"), Map.of()));
        if (list == null) return null;
        for (String line : list.split("\\n")) if (line.startsWith(oid + " ")) return line.substring(oid.length() + 1).trim();
        return null;
    }

    private void recordOperation(Session session, String repoPath, GitOperationResult result, Instant started) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("repoPath", repoPath == null ? "" : repoPath);
        detail.put("operation", result.getOperation()); detail.put("branch", result.getBranch());
        detail.put("commitHash", result.getCommitHash()); detail.put("commitTitle", result.getCommitTitle());
        detail.put("stashRef", result.getStashRef()); detail.put("conflict", result.isConflict());
        detail.put("error", sanitize(result.getError()));
        record(session.getId(), "GIT_" + result.getOperation().toUpperCase(Locale.ROOT), repoPath,
                result.isSuccess(), (int) Duration.between(started, Instant.now()).toMillis(), detail);
    }
    private void record(Long sessionId, String type, String target, boolean success, Integer duration, Map<String, Object> detail) {
        try {
            activityService.record(sessionId, type, limited(target, 256), success ? "Git 操作成功" : "Git 操作失败",
                    objectMapper.writeValueAsString(detail), success ? "SUCCESS" : "ERROR", duration);
        } catch (Exception e) { log.warn("Failed to record Git activity for session {}: {}", sessionId, e.getMessage()); }
    }

    static boolean isSensitive(String path) { return path != null && SENSITIVE_NAME.matcher(path.replace('\\', '/')).find(); }
    private static String utf8Prefix(byte[] source, int max) {
        int end = Math.min(source.length, Math.max(max, 0));
        while (end > 0 && (source[end - 1] & 0xC0) == 0x80) end--;
        return new String(source, 0, end, StandardCharsets.UTF_8);
    }
    private static String output(GitResult result) { return result.success() ? result.output().trim() : null; }
    private static String requireOutput(GitResult result, String message) { requireSuccess(result, message); return result.output().trim(); }
    private static void requireSuccess(GitResult result, String message) {
        if (!result.success()) throw new BusinessException(ErrorCode.INTERNAL_ERROR, classify(result, message));
    }
    private static String classify(GitResult result, String fallback) {
        String lower = result.output().toLowerCase(Locale.ROOT);
        if (result.exitCode() == 124) return "Git 子进程 60 秒超时";
        if (lower.contains("index.lock")) return "Git index lock 被其他进程占用";
        if (lower.contains("authentication failed") || lower.contains("could not read username") || lower.contains("permission denied")) return "Git 认证失败或凭证缺失";
        if (lower.contains("non-fast-forward") || lower.contains("fetch first")) return "推送被拒绝（non-fast-forward），请先拉取处理";
        if (lower.contains("could not resolve host") || lower.contains("unable to access") || lower.contains("timed out")) return "远端不可达或网络超时";
        return fallback + (result.output().isBlank() ? "" : "：" + sanitize(result.output()));
    }
    private static String sanitize(String value) {
        if (value == null) return null;
        String clean = CREDENTIAL_URL.matcher(value).replaceAll("$1***@").replaceAll("(?i)(token|password|authorization)[=: ]+[^\\s]+", "$1=***").trim();
        return limited(clean, MAX_ERROR_LENGTH);
    }
    private static String limited(String value, int max) { return value == null || value.length() <= max ? value : value.substring(0, max); }
    private static String safeStash(String ref, String oid) {
        if (ref != null) return ref;
        return oid != null ? "stash " + limited(oid, 12) : "当前本地变更";
    }
    private static GitOperationException failure(String message, boolean conflict, String stashRef, GitResult result) {
        return new GitOperationException(message + (result.output().isBlank() ? "" : "：" + sanitize(result.output())), conflict, stashRef);
    }

    private interface LockedOperation { GitOperationResult run(Path repo, Instant started); }
    private record GitResult(int exitCode, String output) { boolean success() { return exitCode == 0; } }
    private record RemoteState(String branch, boolean detached, List<String> remotes, String upstream) {}
    private record RawDiff(CommitFile file, String diff) {}
    private static class GitOperationException extends RuntimeException {
        final boolean conflict; final String stashRef;
        GitOperationException(String message, boolean conflict, String stashRef) { super(message); this.conflict = conflict; this.stashRef = stashRef; }
    }

    @Data
    public static class GitOperationResult {
        private boolean success;
        private String operation;
        private String message;
        private String error;
        private String branch;
        private String commitHash;
        private String commitTitle;
        private String stashRef;
        private boolean conflict;
        static GitOperationResult success(String operation, String branch, String message) {
            GitOperationResult result = new GitOperationResult(); result.success = true; result.operation = operation; result.branch = branch; result.message = message; return result;
        }
        static GitOperationResult failed(String operation, String error) {
            GitOperationResult result = new GitOperationResult(); result.operation = operation; result.error = error; return result;
        }
    }

    @Data
    public static class LocalGitActivity {
        private String operation;
        private String repoPath;
        private boolean success;
        private String branch;
        private String commitHash;
        private String commitTitle;
        private String stashRef;
        private boolean conflict;
        private Integer durationMs;
        private String error;
    }
}
