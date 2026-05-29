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
 * 管理 Shell 命令输出：截断预览 + 完整落盘
 */
@Slf4j
@Component
public class OutputManager {

    @Value("${app.harness.shell.output.max-preview-lines:100}")
    private int maxPreviewLines;

    @Value("${app.harness.shell.output.max-preview-chars:10000}")
    private int maxPreviewChars;

    @Value("${app.harness.shell.output.default-yield-time-ms:10000}")
    private int defaultYieldTimeMs;

    /**
     * 读取进程输出，返回截断预览 + 完整落盘
     *
     * @param reader     输出流读取器
     * @param outputFile 输出文件路径
     * @param yieldTime  初始等待时间
     * @return OutputResult
     */
    public OutputResult readOutput(BufferedReader reader, Path outputFile, Duration yieldTime) {
        List<String> allLines = new ArrayList<>();
        StringBuilder fullOutput = new StringBuilder();

        try {
            // 等待 yieldTime，让命令有时间产生输出
            if (yieldTime != null && yieldTime.toMillis() > 0) {
                Thread.sleep(yieldTime.toMillis());
            }

            // 非阻塞读取所有可用输出
            char[] buffer = new char[8192];
            int charsRead;
            while (reader.ready() && (charsRead = reader.read(buffer)) != -1) {
                fullOutput.append(buffer, 0, charsRead);
            }

            // 按行分割
            String[] lines = fullOutput.toString().split("\n", -1);
            for (String line : lines) {
                allLines.add(line);
            }

            // 完整输出写入文件
            writeToFile(outputFile, fullOutput.toString());

            // 生成预览
            String preview = generatePreview(allLines);
            boolean truncated = allLines.size() > maxPreviewLines ||
                    fullOutput.length() > maxPreviewChars;

            return new OutputResult(
                    preview,
                    allLines.size(),
                    fullOutput.length(),
                    truncated,
                    outputFile.toString()
            );

        } catch (IOException e) {
            log.error("Failed to read output", e);
            return new OutputResult(
                    "Error reading output: " + e.getMessage(),
                    0, 0, false, null
            );
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new OutputResult(
                    "Output reading interrupted",
                    0, 0, false, null
            );
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
            sb.append("output_file: ").append(output.outputFile()).append("\n");
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

        // 取尾部 maxPreviewLines 行
        int startIdx = Math.max(0, lines.size() - maxPreviewLines);
        List<String> previewLines = lines.subList(startIdx, lines.size());

        StringBuilder preview = new StringBuilder();
        for (String line : previewLines) {
            if (preview.length() + line.length() + 1 > maxPreviewChars) {
                // 超过字符限制，截断
                int remaining = maxPreviewChars - preview.length() - 20; // 留出 "...[truncated]" 的空间
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
            // 确保父目录存在
            Files.createDirectories(outputFile.getParent());

            // 追加写入
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
            String outputFile
    ) {}
}
