package com.agentworkbench.file.controller;

import com.agentworkbench.common.result.Result;
import com.agentworkbench.file.entity.FileEntity;
import com.agentworkbench.file.service.FileService;
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

import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/v1/files")
@RequiredArgsConstructor
public class FileController {

    private final FileService fileService;

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
    }
}
