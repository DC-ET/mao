package cn.etarch.mao.file.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.harness.safety.PathSandbox;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceBrowseServicePdfTest {

    @TempDir
    Path tempDir;

    private WorkspaceBrowseService newService() {
        return new WorkspaceBrowseService(new PathSandbox(tempDir.resolve("default").toString()));
    }

    private Path writePdf(Path path, byte[] bytes) throws Exception {
        Files.createDirectories(path.getParent());
        Files.write(path, bytes);
        return path;
    }

    private static final byte[] MINIMAL_PDF = "%PDF-1.4\n%%EOF\n".getBytes(StandardCharsets.UTF_8);

    @Test
    void returnsPdfFileForValidPdf() throws Exception {
        Path sessionWorkspace = Files.createDirectories(tempDir.resolve("sessions/1"));
        Path pdf = writePdf(sessionWorkspace.resolve("docs/manual.pdf"), MINIMAL_PDF);

        WorkspaceBrowseService.DownloadResult result = newService().readPdfFile(sessionWorkspace.toString(), "docs/manual.pdf");

        assertThat(result.getPath()).isEqualTo(pdf.toAbsolutePath().normalize());
        assertThat(result.getSize()).isEqualTo(MINIMAL_PDF.length);
        assertThat(result.getFileName()).isEqualTo("manual.pdf");
    }

    @Test
    void acceptsPdfWithUtf8BomPrefix() throws Exception {
        Path sessionWorkspace = Files.createDirectories(tempDir.resolve("sessions/2"));
        byte[] withBom = new byte[3 + MINIMAL_PDF.length];
        withBom[0] = (byte) 0xEF;
        withBom[1] = (byte) 0xBB;
        withBom[2] = (byte) 0xBF;
        System.arraycopy(MINIMAL_PDF, 0, withBom, 3, MINIMAL_PDF.length);
        writePdf(sessionWorkspace.resolve("bom.pdf"), withBom);

        WorkspaceBrowseService.DownloadResult result = newService().readPdfFile(sessionWorkspace.toString(), "bom.pdf");

        assertThat(result.getFileName()).isEqualTo("bom.pdf");
    }

    @Test
    void rejectsNonPdfExtension() throws Exception {
        Path sessionWorkspace = Files.createDirectories(tempDir.resolve("sessions/3"));
        writePdf(sessionWorkspace.resolve("notes.txt"), MINIMAL_PDF);

        assertThatThrownBy(() -> newService().readPdfFile(sessionWorkspace.toString(), "notes.txt"))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("仅支持预览 .pdf 文件");
    }

    @Test
    void rejectsMissingPdfMagicHeader() throws Exception {
        Path sessionWorkspace = Files.createDirectories(tempDir.resolve("sessions/4"));
        // 扩展名为 .pdf 但内容不是 PDF
        writePdf(sessionWorkspace.resolve("fake.pdf"), "hello world, not a pdf".getBytes(StandardCharsets.UTF_8));

        assertThatThrownBy(() -> newService().readPdfFile(sessionWorkspace.toString(), "fake.pdf"))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("不是有效的 PDF 文件");
    }

    @Test
    void rejectsEmptyPdfFile() throws Exception {
        Path sessionWorkspace = Files.createDirectories(tempDir.resolve("sessions/5"));
        writePdf(sessionWorkspace.resolve("empty.pdf"), new byte[0]);

        assertThatThrownBy(() -> newService().readPdfFile(sessionWorkspace.toString(), "empty.pdf"))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("不是有效的 PDF 文件");
    }

    @Test
    void rejectsMissingFile() throws Exception {
        Path sessionWorkspace = Files.createDirectories(tempDir.resolve("sessions/6"));

        assertThatThrownBy(() -> newService().readPdfFile(sessionWorkspace.toString(), "missing.pdf"))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("文件不存在");
    }

    @Test
    void rejectsPathEscapeAttempt() throws Exception {
        Path sessionWorkspace = Files.createDirectories(tempDir.resolve("sessions/7"));
        // 工作区外的真实 PDF，验证沙箱拦截
        writePdf(tempDir.resolve("outside.pdf"), MINIMAL_PDF);

        assertThatThrownBy(() -> newService().readPdfFile(sessionWorkspace.toString(), "../outside.pdf"))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("路径访问被拒绝");
    }

    @Test
    void rejectsSymlinkPointingOutsideSandbox() throws Exception {
        Path sessionWorkspace = Files.createDirectories(tempDir.resolve("sessions/8"));
        Path outside = writePdf(tempDir.resolve("outside-link-target.pdf"), MINIMAL_PDF);
        Files.createSymbolicLink(sessionWorkspace.resolve("link.pdf"), outside);

        assertThatThrownBy(() -> newService().readPdfFile(sessionWorkspace.toString(), "link.pdf"))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("不是普通文件");
    }

    @Test
    void rejectsIntermediateDirectorySymlinkBypass() throws Exception {
        Path sessionWorkspace = Files.createDirectories(tempDir.resolve("sessions/9"));
        // 工作区内目录符号链接指向沙箱外，经由 sub/manual.pdf 读取外部文件
        Path outside = writePdf(tempDir.resolve("outside-dir/secret.pdf"), MINIMAL_PDF);
        Files.createSymbolicLink(sessionWorkspace.resolve("sub"), outside.getParent());

        assertThatThrownBy(() -> newService().readPdfFile(sessionWorkspace.toString(), "sub/secret.pdf"))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("路径访问被拒绝");
    }

    @Test
    void allowsAbsolutePathUnderSessionWorkspace() throws Exception {
        Path sessionWorkspace = Files.createDirectories(tempDir.resolve("sessions/10"));
        Path pdf = writePdf(sessionWorkspace.resolve("abs.pdf"), MINIMAL_PDF);

        WorkspaceBrowseService.DownloadResult result = newService().readPdfFile(sessionWorkspace.toString(), pdf.toString());

        assertThat(result.getFileName()).isEqualTo("abs.pdf");
    }
}
