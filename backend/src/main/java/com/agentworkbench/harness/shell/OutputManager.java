package com.agentworkbench.harness.shell;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * 管理 Shell 命令输出：marker 检测 + 截断预览 + 完整落盘
 */
@Slf4j
@Component
public class OutputManager {

    @Value("${app.harness.shell.output.max-preview-lines:100}")
    private int maxPreviewLines;

    @Value("${app.harness.shell.output.max-preview-chars:10000}")
    private int maxPreviewChars;

    /**
     * 逐行读取输出直到遇到 marker 行或超时。
     * marker 行本身不包含在返回的输出中。
     *
     * @param reader    输出流读取器
     * @param marker    结束标记（如 __CMD_DONE_xxx__）
     * @param timeout   最大等待时间
     * @param outputFile 输出文件路径（可为 null，不落盘）
     * @return OutputResult
     */
    public OutputResult readUntilMarker(BufferedReader reader, String marker, Duration timeout, Path outputFile) {
        List<String> allLines = new StringBuilder() != null ? new ArrayList<>() : new ArrayList<>();
        StringBuilder fullOutput = new StringBuilder();
        boolean markerFound = false;
        long deadline = System.currentTimeMillis() + timeout.toMillis();

        try {
            char[] buffer = new char[8192];
            StringBuilder lineBuffer = new StringBuilder();

            while (System.currentTimeMillis() < deadline) {
                // 检查是否有数据可读
                if (!reader.ready()) {
                    // 没有数据，短暂等待后重试
                    Thread.sleep(50);
                    continue;
                }

                int charsRead = reader.read(buffer);
                if (charsRead == -1) break;

                for (int i = 0; i < charsRead; i++) {
                    char c = buffer[i];
                    if (c == '\n') {
                        String line = lineBuffer.toString();
                        lineBuffer.setLength(0);

                        if (line.contains(marker)) {
                            markerFound = true;
                            break;
                        }

                        allLines.add(line);
                        fullOutput.append(line).append("\n");
                    } else if (c != '\r') {
                        lineBuffer.append(c);
                    }
                }

                if (markerFound) break;
            }

            // 处理最后没有换行的残留内容
            if (!markerFound && lineBuffer.length() > 0) {
                String remaining = lineBuffer.toString();
                if (!remaining.contains(marker)) {
                    allLines.add(remaining);
                    fullOutput.append(remaining);
                }
            }

            // 落盘
            if (outputFile != null && !allLines.isEmpty()) {
                writeToFile(outputFile, fullOutput.toString());
            }

            String preview = generatePreview(allLines);
            boolean truncated = !markerFound || allLines.size() > maxPreviewLines
                    || fullOutput.length() > maxPreviewChars;

            return new OutputResult(
                    preview,
                    allLines.size(),
                    fullOutput.length(),
                    truncated,
                    markerFound,
                    outputFile != null ? outputFile.toString() : null
            );

        } catch (IOException e) {
            log.error("Failed to read output", e);
            return new OutputResult("Error reading output: " + e.getMessage(), 0, 0, false, false, null);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new OutputResult("Output reading interrupted", 0, 0, false, false, null);
        }
    }

    /**
     * 格式化工具返回结果
     */
    public String formatToolResult(int exitCode, String sessionId, long elapsedMs,
                                    OutputResult output, String currentWorkdir) {
        StringBuilder sb = new StringBuilder();
        sb.append("exit_code: ").append(exitCode).append("\n");
        sb.append("session_id: ").append(sessionId).append("\n");
        sb.append("elapsed_ms: ").append(elapsedMs).append("\n");

        if (currentWorkdir != null) {
            sb.append("current_workdir: ").append(currentWorkdir).append("\n");
        }

        sb.append("output_lines: ").append(output.totalLines()).append("\n");

        if (output.truncated()) {
            sb.append("truncated: true\n");
            if (output.outputFile() != null) {
                sb.append("output_file: ").append(output.outputFile()).append("\n");
            }
        }

        sb.append("---\n");
        sb.append(output.preview());

        return sb.toString();
    }

    /**
     * 生成预览内容（尾部 N 行 / 最多 M 字符）
     */
    private String generatePreview(List<String> lines) {
        if (lines.isEmpty()) {
            return "";
        }

        int startIdx = Math.max(0, lines.size() - maxPreviewLines);
        List<String> previewLines = lines.subList(startIdx, lines.size());

        StringBuilder preview = new StringBuilder();
        for (String line : previewLines) {
            if (preview.length() + line.length() + 1 > maxPreviewChars) {
                int remaining = maxPreviewChars - preview.length() - 20;
                if (remaining > 0) {
                    preview.append(line, 0, Math.min(remaining, line.length()));
                    preview.append("\n...[truncated]");
                }
                break;
            }
            preview.append(line).append("\n");
        }

        return preview.toString().trim();
    }

    /**
     * 写入输出到文件
     */
    private void writeToFile(Path outputFile, String content) {
        try {
            Files.createDirectories(outputFile.getParent());
            try (Writer writer = Files.newBufferedWriter(outputFile, StandardCharsets.UTF_8,
                    java.nio.file.StandardOpenOption.CREATE,
                    java.nio.file.StandardOpenOption.APPEND)) {
                writer.write(content);
            }
        } catch (IOException e) {
            log.error("Failed to write output to file: {}", outputFile, e);
        }
    }

    /**
     * 输出结果记录
     */
    public record OutputResult(
            String preview,
            int totalLines,
            int totalChars,
            boolean truncated,
            boolean markerFound,
            String outputFile
    ) {}
}
