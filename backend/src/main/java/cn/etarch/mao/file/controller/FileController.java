package cn.etarch.mao.file.controller;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.file.entity.FileEntity;
import cn.etarch.mao.file.service.FileService;
import cn.etarch.mao.file.service.WorkspaceBrowseService;
import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.config.UploadProperties;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/v1/files")
@RequiredArgsConstructor
public class FileController {

    private final FileService fileService;
    private final SessionService sessionService;
    private final WorkspaceBrowseService workspaceBrowseService;
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
