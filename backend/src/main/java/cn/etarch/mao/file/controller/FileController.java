package cn.etarch.mao.file.controller;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.file.entity.FileEntity;
import cn.etarch.mao.file.service.FileService;
import cn.etarch.mao.file.service.WorkspaceBrowseService;
import cn.etarch.mao.file.service.WorkspaceGitService;
import cn.etarch.mao.file.service.GitCommitMessageService;
import cn.etarch.mao.file.service.GitWriteOperationService;
import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.config.UploadProperties;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

@Slf4j
@RestController
@RequestMapping("/v1/files")
@RequiredArgsConstructor
public class FileController {

    private final FileService fileService;
    private final SessionService sessionService;
    private final WorkspaceBrowseService workspaceBrowseService;
    private final WorkspaceGitService workspaceGitService;
    private final GitCommitMessageService gitCommitMessageService;
    private final GitWriteOperationService gitWriteOperationService;
    private final PathSandbox pathSandbox;
    private final UploadProperties uploadProperties;

    @PostMapping("/upload")
    public Result<FileVO> uploadFile(
            @AuthenticationPrincipal Long userId,
            @RequestParam("file") MultipartFile file,
            @RequestParam(required = false) Long sessionId) {
        FileEntity fileEntity = fileService.uploadFile(file, userId, sessionId);
        return Result.ok(toVO(fileEntity));
    }

    @GetMapping("/{id}/download")
    public ResponseEntity<Resource> downloadFile(@PathVariable Long id) {
        FileEntity fileEntity = fileService.getFile(id);
        if (fileEntity == null) {
            return ResponseEntity.notFound().build();
        }
        Path filePath = fileService.getFilePath(id);
        Resource resource = new FileSystemResource(filePath);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=\"" + fileEntity.getOriginalName() + "\"")
                .contentType(MediaType.parseMediaType(
                        fileEntity.getMimeType() != null ? fileEntity.getMimeType() : "application/octet-stream"))
                .body(resource);
    }

    @GetMapping("/{id}/preview")
    public ResponseEntity<Resource> previewFile(@PathVariable Long id) {
        FileEntity fileEntity = fileService.getFile(id);
        if (fileEntity == null) {
            return ResponseEntity.notFound().build();
        }
        Path filePath = fileService.getFilePath(id);
        Resource resource = new FileSystemResource(filePath);
        String contentType = fileEntity.getMimeType() != null ? fileEntity.getMimeType() : "application/octet-stream";
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(contentType))
                .body(resource);
    }

    @GetMapping
    public Result<List<FileVO>> listFiles(
            @AuthenticationPrincipal Long userId,
            @RequestParam(required = false) Long sessionId) {
        List<FileEntity> files = fileService.listFiles(userId, sessionId);
        return Result.ok(files.stream().map(this::toVO).collect(Collectors.toList()));
    }

    @GetMapping("/workspace-list")
    public Result<Map<String, Object>> listWorkspaceFiles(
            @AuthenticationPrincipal Long userId,
            @RequestParam Long sessionId,
            @RequestParam(required = false) String filter,
            @RequestParam(required = false, defaultValue = "20") Integer limit) {
        Session session = requireOwnedSession(userId, sessionId);
        List<FileService.WorkspaceFileDTO> files = fileService.listWorkspaceFiles(
                session.getWorkspace(), filter, limit != null ? limit : 20);
        return Result.ok(Map.of("files", files));
    }

    @GetMapping("/workspace-directory")
    public Result<WorkspaceBrowseService.DirectoryListingDTO> listWorkspaceDirectory(
            @AuthenticationPrincipal Long userId,
            @RequestParam Long sessionId,
            @RequestParam(required = false) String dir) {
        Session session = requireOwnedSession(userId, sessionId);
        return Result.ok(workspaceBrowseService.listDirectory(session.getWorkspace(), dir));
    }

    @GetMapping("/workspace-read")
    public Result<WorkspaceBrowseService.FileContentDTO> readWorkspaceFile(
            @AuthenticationPrincipal Long userId,
            @RequestParam Long sessionId,
            @RequestParam String path,
            @RequestParam(required = false, defaultValue = "0") Integer offset,
            @RequestParam(required = false, defaultValue = "5000") Integer limit) {
        Session session = requireOwnedSession(userId, sessionId);
        return Result.ok(workspaceBrowseService.readFile(
                session.getWorkspace(), path, offset != null ? offset : 0, limit != null ? limit : 5000));
    }

    @GetMapping("/workspace-download")
    public ResponseEntity<Resource> downloadWorkspaceFile(
            @AuthenticationPrincipal Long userId,
            @RequestParam Long sessionId,
            @RequestParam String path) {
        Session session = requireOwnedSession(userId, sessionId);
        WorkspaceBrowseService.DownloadResult result = workspaceBrowseService.downloadFile(session.getWorkspace(), path);

        MediaType mediaType = MediaType.APPLICATION_OCTET_STREAM;
        try {
            String probe = Files.probeContentType(result.getPath());
            if (probe != null && !probe.isBlank()) {
                mediaType = MediaType.parseMediaType(probe);
            }
        } catch (IOException ignored) {
            // 无法探测时回退 octet-stream
        }

        Resource resource = new FileSystemResource(result.getPath());
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, attachmentHeader(result.getFileName()))
                .contentType(mediaType)
                .contentLength(result.getSize())
                .body(resource);
    }

    @GetMapping("/workspace-preview")
    public ResponseEntity<Resource> previewWorkspacePdf(
            @AuthenticationPrincipal Long userId,
            @RequestParam Long sessionId,
            @RequestParam String path) {
        Session session = requireOwnedSession(userId, sessionId);
        WorkspaceBrowseService.DownloadResult result = workspaceBrowseService.readPdfFile(session.getWorkspace(), path);

        Resource resource = new FileSystemResource(result.getPath());
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, inlinePdfHeader(result.getFileName()))
                .contentType(MediaType.parseMediaType("application/pdf"))
                .contentLength(result.getSize())
                .body(resource);
    }

    @GetMapping("/workspace-download-zip")
    public ResponseEntity<StreamingResponseBody> downloadWorkspaceDirectory(
            @AuthenticationPrincipal Long userId,
            @RequestParam Long sessionId,
            @RequestParam String path) {
        Session session = requireOwnedSession(userId, sessionId);
        WorkspaceBrowseService.ZipResult result = workspaceBrowseService.zipDirectory(session.getWorkspace(), path);

        // StreamingResponseBody 在响应写完后执行 finally，确保临时 zip 在传输完成后被清理
        StreamingResponseBody body = outputStream -> {
            try (InputStream in = Files.newInputStream(result.getZipPath())) {
                in.transferTo(outputStream);
            } finally {
                try {
                    Files.deleteIfExists(result.getZipPath());
                } catch (IOException e) {
                    log.warn("Failed to delete temp zip after download: {}", result.getZipPath(), e);
                }
            }
        };

        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, attachmentHeader(result.getFileName()))
                .contentType(MediaType.parseMediaType("application/zip"))
                .contentLength(result.getSize())
                .body(body);
    }

    private static String attachmentHeader(String fileName) {
        return ContentDisposition.attachment()
                .filename(fileName, StandardCharsets.UTF_8)
                .build()
                .toString();
    }

    private static String inlinePdfHeader(String fileName) {
        return ContentDisposition.inline()
                .filename(fileName, StandardCharsets.UTF_8)
                .build()
                .toString();
    }

    @GetMapping("/workspace-git-repos")
    public Result<WorkspaceGitService.GitReposDTO> workspaceGitRepos(
            @AuthenticationPrincipal Long userId,
            @RequestParam Long sessionId) {
        Session session = requireOwnedSession(userId, sessionId);
        return Result.ok(workspaceGitService.listRepos(session.getWorkspace()));
    }

    @GetMapping("/workspace-git-status")
    public Result<WorkspaceGitService.GitStatusDTO> workspaceGitStatus(
            @AuthenticationPrincipal Long userId,
            @RequestParam Long sessionId,
            @RequestParam(required = false) String repoPath) {
        Session session = requireOwnedSession(userId, sessionId);
        return Result.ok(workspaceGitService.getStatus(session.getWorkspace(), repoPath));
    }

    @GetMapping("/workspace-git-diff")
    public Result<WorkspaceGitService.GitFileDiffDTO> workspaceGitDiff(
            @AuthenticationPrincipal Long userId,
            @RequestParam Long sessionId,
            @RequestParam(required = false) String repoPath,
            @RequestParam String path) {
        Session session = requireOwnedSession(userId, sessionId);
        return Result.ok(workspaceGitService.getFileDiff(session.getWorkspace(), repoPath, path));
    }

    @PostMapping("/workspace-git-refresh")
    public Result<WorkspaceGitService.GitStatusDTO> workspaceGitRefresh(
            @AuthenticationPrincipal Long userId, @RequestBody GitOperationRequest request) {
        Session session = requireOwnedSession(userId, request.getSessionId());
        return Result.ok(gitWriteOperationService.refreshRemoteStatus(session, request.getRepoPath()));
    }

    @PostMapping("/workspace-git-commit")
    public Result<GitWriteOperationService.GitOperationResult> workspaceGitCommit(
            @AuthenticationPrincipal Long userId, @RequestBody GitOperationRequest request) {
        Session session = requireOwnedSession(userId, request.getSessionId());
        return Result.ok(gitWriteOperationService.commit(session, request.getRepoPath()));
    }

    @PostMapping("/workspace-git-pull")
    public Result<GitWriteOperationService.GitOperationResult> workspaceGitPull(
            @AuthenticationPrincipal Long userId, @RequestBody GitOperationRequest request) {
        Session session = requireOwnedSession(userId, request.getSessionId());
        return Result.ok(gitWriteOperationService.pull(session, request.getRepoPath()));
    }

    @PostMapping("/workspace-git-push")
    public Result<GitWriteOperationService.GitOperationResult> workspaceGitPush(
            @AuthenticationPrincipal Long userId, @RequestBody GitOperationRequest request) {
        Session session = requireOwnedSession(userId, request.getSessionId());
        return Result.ok(gitWriteOperationService.push(session, request.getRepoPath()));
    }

    @PostMapping("/git-commit-message")
    public Result<GitCommitMessageService.CommitMessage> gitCommitMessage(
            @AuthenticationPrincipal Long userId, @RequestBody GitCommitMessageRequest request) {
        Session session = requireOwnedSession(userId, request.getSessionId());
        return Result.ok(gitCommitMessageService.generate(session, request.getChanges()));
    }

    @PostMapping("/workspace-git-activity")
    public Result<Void> workspaceGitActivity(
            @AuthenticationPrincipal Long userId, @RequestBody LocalActivityRequest request) {
        Session session = requireOwnedSession(userId, request.getSessionId());
        gitWriteOperationService.recordLocalActivity(session, request.getResult());
        return Result.ok();
    }

    @GetMapping("/project-list")
    public Result<Map<String, Object>> listProjectFiles(
            @AuthenticationPrincipal Long userId,
            @RequestParam String projectKey,
            @RequestParam(required = false) String filter,
            @RequestParam(required = false, defaultValue = "20") Integer limit) {
        Path userRoot = pathSandbox.getWorkspaceRoot().resolve(String.valueOf(userId));
        Path projectPath = userRoot.resolve("projects").resolve(projectKey).normalize();

        // Security: ensure the resolved path is still under the user's projects directory
        if (!projectPath.startsWith(userRoot)) {
            return Result.fail(403, "无权访问该项目");
        }
        if (!Files.exists(projectPath) || !Files.isDirectory(projectPath)) {
            return Result.ok(Map.of("files", List.of()));
        }

        List<FileService.WorkspaceFileDTO> files = fileService.listWorkspaceFiles(
                projectPath.toString(), filter, limit != null ? limit : 20);
        return Result.ok(Map.of("files", files));
    }

    private Session requireOwnedSession(Long userId, Long sessionId) {
        Session session = sessionService.getSession(sessionId);
        if (!Objects.equals(session.getUserId(), userId)) {
            throw new BusinessException(ErrorCode.FORBIDDEN, "无权访问该会话");
        }
        if (session.getWorkspace() == null || session.getWorkspace().isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "会话未配置工作区");
        }
        return session;
    }

    @DeleteMapping("/{id}")
    public Result<Void> deleteFile(@PathVariable Long id) {
        fileService.deleteFile(id);
        return Result.ok();
    }

    private FileVO toVO(FileEntity file) {
        FileVO vo = new FileVO();
        vo.setId(file.getId());
        vo.setOriginalName(file.getOriginalName());
        vo.setFileSize(file.getFileSize());
        vo.setMimeType(file.getMimeType());
        vo.setSessionId(file.getSessionId());
        vo.setCreatedAt(file.getCreatedAt() != null ? file.getCreatedAt().toString() : null);
        // Nginx serves /path/to/data/uploads/ as virtual path /uploads/
        String baseUrl = uploadProperties.getBaseUrl();
        if (baseUrl != null && !baseUrl.isEmpty()) {
            vo.setUrl(baseUrl + "/uploads/" + file.getStoredName());
        } else {
            vo.setUrl("/uploads/" + file.getStoredName());
        }
        return vo;
    }

    @Data
    public static class GitOperationRequest {
        private Long sessionId;
        private String repoPath;
    }

    @Data
    public static class GitCommitMessageRequest {
        private Long sessionId;
        private GitCommitMessageService.CommitGenerationInput changes;
    }

    @Data
    public static class LocalActivityRequest {
        private Long sessionId;
        private GitWriteOperationService.LocalGitActivity result;
    }

    @Data
    public static class FileVO {
        private Long id;
        private String originalName;
        private Long fileSize;
        private String mimeType;
        private Long sessionId;
        private String createdAt;
        private String url;
    }
}
