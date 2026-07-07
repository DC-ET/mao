package com.agentworkbench.file.service;

import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.file.entity.FileEntity;
import com.agentworkbench.file.mapper.FileEntityMapper;
import com.agentworkbench.harness.safety.PathSandbox;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class FileServicesTest {

    @TempDir
    Path tempDir;

    private final FileEntityMapper mapper = mock(FileEntityMapper.class);

    @Test
    void uploadListGetPathAndDeleteFiles() throws Exception {
        FileService service = fileService();
        MockMultipartFile file = new MockMultipartFile("file", "hello.txt", "text/plain", "hello".getBytes());

        FileEntity saved = service.uploadFile(file, 7L, 11L);

        assertThat(saved.getOriginalName()).isEqualTo("hello.txt");
        assertThat(saved.getStoredName()).endsWith(".txt");
        assertThat(saved.getFileSize()).isEqualTo(5L);
        assertThat(Path.of(saved.getFilePath())).exists();
        verify(mapper).insert(saved);

        when(mapper.selectById(1L)).thenReturn(saved);
        when(mapper.selectList(any(QueryWrapper.class))).thenReturn(List.of(saved));
        assertThat(service.getFile(1L)).isSameAs(saved);
        assertThat(service.getFilePath(1L)).isEqualTo(Path.of(saved.getFilePath()));
        assertThat(service.listFiles(7L, 11L)).containsExactly(saved);

        service.deleteFile(1L);
        assertThat(Path.of(saved.getFilePath())).doesNotExist();
        verify(mapper).deleteById(1L);
    }

    @Test
    void uploadRejectsEmptyOrOversizedAndPathLookupRejectsMissingFile() {
        FileService service = fileService();
        assertThatThrownBy(() -> service.uploadFile(
                new MockMultipartFile("file", "empty.txt", "text/plain", new byte[0]), 1L, null))
                .isInstanceOf(BusinessException.class);

        assertThatThrownBy(() -> service.uploadFile(
                new MockMultipartFile("file", "big.bin", "application/octet-stream", new byte[2 * 1024 * 1024]), 1L, null))
                .isInstanceOf(BusinessException.class);

        when(mapper.selectById(404L)).thenReturn(null);
        assertThatThrownBy(() -> service.getFilePath(404L)).isInstanceOf(BusinessException.class);
        service.deleteFile(404L);
    }

    @Test
    void listWorkspaceFilesFiltersIgnoredDirsAndSortsRecentFirst() throws Exception {
        FileService service = fileService();
        Path workspace = tempDir.resolve("workspace");
        Files.createDirectories(workspace.resolve("src"));
        Files.createDirectories(workspace.resolve(".git"));
        Files.writeString(workspace.resolve("src").resolve("App.java"), "class App {}");
        Files.writeString(workspace.resolve("README.md"), "readme");
        Files.writeString(workspace.resolve(".git").resolve("config"), "ignored");

        List<FileService.WorkspaceFileDTO> all = service.listWorkspaceFiles(workspace.toString(), null, 10);
        List<FileService.WorkspaceFileDTO> filtered = service.listWorkspaceFiles(workspace.toString(), "app", 10);

        assertThat(all).extracting(FileService.WorkspaceFileDTO::getPath)
                .contains("src/App.java", "README.md")
                .doesNotContain(".git/config");
        assertThat(filtered).extracting(FileService.WorkspaceFileDTO::getName).containsExactly("App.java");
        assertThat(service.listWorkspaceFiles(workspace.resolve("missing").toString(), null, 10)).isEmpty();
    }

    @Test
    void workspaceBrowseListsDirectoriesAndReadsFileSlices() throws Exception {
        Path workspace = tempDir.resolve("workspace");
        Files.createDirectories(workspace.resolve("dir"));
        Files.writeString(workspace.resolve("dir").resolve("a.txt"), "line1\nline2\nline3");
        Files.writeString(workspace.resolve("root.txt"), "root");
        WorkspaceBrowseService service = new WorkspaceBrowseService(new PathSandbox(workspace.toString()));

        WorkspaceBrowseService.DirectoryListingDTO listing = service.listDirectory(workspace.toString(), ".");
        assertThat(listing.isTruncated()).isFalse();
        assertThat(listing.getEntries()).extracting(WorkspaceBrowseService.DirectoryEntryDTO::getName)
                .contains("dir", "root.txt");
        assertThat(listing.getEntries().get(0).isDirectory()).isTrue();

        WorkspaceBrowseService.FileContentDTO content = service.readFile(workspace.toString(), "dir/a.txt", 1, 1);
        assertThat(content.getContent()).isEqualTo("line2");
        assertThat(content.getTotal_lines()).isEqualTo(3);

        assertThatThrownBy(() -> service.listDirectory(workspace.toString(), "missing"))
                .isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> service.listDirectory(workspace.toString(), "root.txt"))
                .isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> service.readFile(workspace.toString(), "", 0, 1))
                .isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> service.readFile(workspace.toString(), "missing.txt", 0, 1))
                .isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> service.readFile(workspace.toString(), "dir", 0, 1))
                .isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> service.readFile(workspace.toString(), "../escape.txt", 0, 1))
                .isInstanceOf(BusinessException.class);
    }

    private FileService fileService() {
        FileService service = new FileService(mapper);
        ReflectionTestUtils.setField(service, "uploadDir", tempDir.resolve("uploads").toString());
        ReflectionTestUtils.setField(service, "maxSizeMb", 1);
        return service;
    }
}
