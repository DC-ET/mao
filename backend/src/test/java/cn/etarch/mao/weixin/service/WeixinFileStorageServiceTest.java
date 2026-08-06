package cn.etarch.mao.weixin.service;

import cn.etarch.mao.weixin.config.WeixinBotConfig;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WeixinFileStorageServiceTest {

    @TempDir
    Path tempDir;

    private WeixinFileStorageService service;

    @BeforeEach
    void setUp() {
        WeixinBotConfig config = new WeixinBotConfig();
        config.setMaxInboundFileMb(1); // 1MB 便于测试超限
        service = new WeixinFileStorageService(config);
    }

    @Test
    void sanitizeFileName_stripsPathTraversalUnix() {
        assertEquals("evil.pdf", WeixinFileStorageService.sanitizeFileName("../../evil.pdf"));
    }

    @Test
    void sanitizeFileName_replacesWindowsIllegalChars() {
        assertEquals("a_b_c_.pdf", WeixinFileStorageService.sanitizeFileName("a:b*c?.pdf"));
    }

    @Test
    void sanitizeFileName_stripsFileRefReservedChars() {
        assertEquals("报告_最终版.pdf", WeixinFileStorageService.sanitizeFileName("报告}最终版.pdf"));
        assertEquals("a_b_c.pdf", WeixinFileStorageService.sanitizeFileName("a{b@c.pdf"));
        // 花括号被替换后，@{路径}@ 引用标记可被 PromptEngine 正常解析
        String cleaned = WeixinFileStorageService.sanitizeFileName("报告}最终版.pdf");
        assertFalse(cleaned.contains("}"));
        assertFalse(cleaned.contains("{"));
        assertFalse(cleaned.contains("@"));
    }

    @Test
    void sanitizeFileName_replacesWindowsSeparator() {
        assertFalse(WeixinFileStorageService.sanitizeFileName("..\\..\\evil.pdf").contains("\\"));
        assertEquals(".._.._evil.pdf", WeixinFileStorageService.sanitizeFileName("..\\..\\evil.pdf"));
    }

    @Test
    void sanitizeFileName_blankFallsBackToDefault() {
        String name = WeixinFileStorageService.sanitizeFileName("   ");
        assertTrue(name.startsWith("file-"));
        assertTrue(name.endsWith(".bin"));
    }

    @Test
    void sanitizeFileName_truncatesAndKeepsExtension() {
        String longName = "a".repeat(200) + ".pdf";
        String cleaned = WeixinFileStorageService.sanitizeFileName(longName);
        assertTrue(cleaned.length() <= 120, "截断后长度应不超过 120: " + cleaned.length());
        assertTrue(cleaned.endsWith(".pdf"));
    }

    @Test
    void saveFile_writesToDateSubdir() throws IOException {
        byte[] bytes = "hello pdf".getBytes();
        Path saved = service.saveFile(tempDir.toString(), "报告.pdf", bytes);

        assertTrue(saved.toString().contains("weixin-files"));
        assertTrue(Files.exists(saved));
        assertEquals("报告.pdf", saved.getFileName().toString());
        assertArrayEquals(bytes, Files.readAllBytes(saved));
    }

    @Test
    void saveFile_duplicateName_appendsTimestampNotOverwrite() throws IOException {
        byte[] first = "first".getBytes();
        byte[] second = "second".getBytes();
        Path saved1 = service.saveFile(tempDir.toString(), "a.pdf", first);
        Path saved2 = service.saveFile(tempDir.toString(), "a.pdf", second);

        assertNotEquals(saved1, saved2);
        assertTrue(Files.exists(saved1));
        assertTrue(Files.exists(saved2));
        assertArrayEquals(first, Files.readAllBytes(saved1));
        assertArrayEquals(second, Files.readAllBytes(saved2));
    }

    @Test
    void saveFile_oversize_throwsStorageException() {
        byte[] bytes = new byte[1024 * 1024 + 1];
        WeixinFileStorageService.StorageException ex = assertThrows(
                WeixinFileStorageService.StorageException.class,
                () -> service.saveFile(tempDir.toString(), "big.pdf", bytes));
        assertTrue(ex.getMessage().contains("大小限制"));
    }

    @Test
    void saveFile_emptyBytes_throwsStorageException() {
        assertThrows(WeixinFileStorageService.StorageException.class,
                () -> service.saveFile(tempDir.toString(), "empty.pdf", new byte[0]));
    }

    @Test
    void saveFile_returnsAbsolutePath() {
        Path saved = service.saveFile(tempDir.toString(), "x.txt", new byte[]{1});
        assertTrue(saved.isAbsolute());
    }

    private static void assertArrayEquals(byte[] expected, byte[] actual) {
        assertEquals(expected.length, actual.length);
        for (int i = 0; i < expected.length; i++) {
            assertEquals(expected[i], actual[i], "byte index " + i);
        }
    }
}
