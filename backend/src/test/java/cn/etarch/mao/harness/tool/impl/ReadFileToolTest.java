package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.safety.PathSandbox;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

import static org.assertj.core.api.Assertions.assertThat;

class ReadFileToolTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @TempDir
    Path tempDir;

    @Test
    void readsWholeFileAndSupportsAliasPathFields() throws Exception {
        Files.writeString(tempDir.resolve("a.txt"), "one\ntwo\nthree");
        ReadFileTool tool = new ReadFileTool(objectMapper, new PathSandbox(tempDir.toString()));

        JsonNode result = execute(tool, Map.of("file_path", "a.txt"));

        assertThat(result.get("content").asText()).isEqualTo("one\ntwo\nthree");
        assertThat(result.get("total_lines").asInt()).isEqualTo(3);
    }

    @Test
    void readsOffsetAndLimitWindow() throws Exception {
        Files.writeString(tempDir.resolve("a.txt"), "one\ntwo\nthree\nfour");
        ReadFileTool tool = new ReadFileTool(objectMapper, new PathSandbox(tempDir.toString()));

        JsonNode result = execute(tool, Map.of("path", "a.txt", "offset", 1, "limit", 2));

        assertThat(result.get("content").asText()).isEqualTo("two\nthree");
        assertThat(result.get("total_lines").asInt()).isEqualTo(4);
    }

    @Test
    void returnsFriendlyErrorsForMissingPathMissingFileAndDirectories() throws Exception {
        Files.createDirectory(tempDir.resolve("dir"));
        ReadFileTool tool = new ReadFileTool(objectMapper, new PathSandbox(tempDir.toString()));

        assertThat(execute(tool, Map.of()).get("content").asText()).contains("缺少必填参数");
        assertThat(execute(tool, Map.of("path", "missing.txt")).get("content").asText()).contains("文件不存在");
        assertThat(execute(tool, Map.of("path", "dir")).get("content").asText()).contains("不是普通文件");
    }

    @Test
    void truncatesVeryLargeOutput() throws Exception {
        String content = IntStream.range(0, 6000)
                .mapToObj(i -> "line-" + i + "-abcdefghijklmnopqrstuvwxyz")
                .collect(Collectors.joining("\n"));
        Files.writeString(tempDir.resolve("large.txt"), content);
        ReadFileTool tool = new ReadFileTool(objectMapper, new PathSandbox(tempDir.toString()));

        JsonNode result = execute(tool, Map.of("path", "large.txt"));

        assertThat(result.get("content").asText()).contains("[output truncated]");
    }

    @Test
    void readsPngImageWithDataUri() throws Exception {
        writePng(tempDir.resolve("shot.png"), 32, 24);
        ReadFileTool tool = new ReadFileTool(objectMapper, new PathSandbox(tempDir.toString()));

        JsonNode result = execute(tool, Map.of("path", "shot.png"));

        assertThat(result.get("media_type").asText()).isEqualTo("image");
        assertThat(result.get("mime").asText()).isEqualTo("image/png");
        assertThat(result.get("data_uri").asText()).startsWith("data:image/png;base64,");
        assertThat(result.get("width").asInt()).isEqualTo(32);
        assertThat(result.get("height").asInt()).isEqualTo(24);
        assertThat(result.get("content").asText()).contains("图片读取成功");
    }

    @Test
    void rejectsFakePngExtensionWithInvalidContent() throws Exception {
        Files.writeString(tempDir.resolve("fake.png"), "not an image");
        ReadFileTool tool = new ReadFileTool(objectMapper, new PathSandbox(tempDir.toString()));

        JsonNode result = execute(tool, Map.of("path", "fake.png"));

        assertThat(result.get("content").asText()).contains("不支持的图片格式");
    }

    @Test
    void readsBmpAsTextBecauseExtensionIsNotSupportedImage() throws Exception {
        Files.writeString(tempDir.resolve("photo.bmp"), "plain-text");
        ReadFileTool tool = new ReadFileTool(objectMapper, new PathSandbox(tempDir.toString()));

        JsonNode result = execute(tool, Map.of("path", "photo.bmp"));

        assertThat(result.get("content").asText()).isEqualTo("plain-text");
        assertThat(result.has("media_type")).isFalse();
    }

    private void writePng(Path path, int width, int height) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        g.setColor(Color.RED);
        g.fillRect(0, 0, width, height);
        g.dispose();
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            ImageIO.write(image, "png", out);
            Files.write(path, out.toByteArray());
        }
    }

    private JsonNode execute(ReadFileTool tool, Map<String, Object> args) throws Exception {
        return objectMapper.readTree(tool.execute(objectMapper.writeValueAsString(args)));
    }
}
