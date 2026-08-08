package cn.etarch.mao.harness.shell;

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
import java.util.function.BooleanSupplier;

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
     * marker 之后的残留输出（异步/后台任务输出）不会丢弃：落入当前缓冲的部分会一并返回，
     * 并追加到会话累积输出文件（outputFile）。
     *
     * @param reader     输出流读取器
     * @param marker     结束标记（如 __CMD_DONE_xxx__）
     * @param timeout    最大等待时间
     * @param outputFile 会话累积输出文件（可为 null；非 null 时全量输出追加写入，支持事后回查）
     * @return OutputResult
     */
    public OutputResult readUntilMarker(BufferedReader reader, String marker, Duration timeout,
                                        Path outputFile) {
        return readUntilMarker(reader, marker, timeout, outputFile, null);
    }

    /**
     * 逐行读取输出直到遇到 marker 行、超时，或底层进程已死亡。
     * <p>
     * 修复：之前空闲轮询（{@code !reader.ready()}）从不真正 {@code read()}，
     * 无法感知 EOF（read 返回 -1），导致 bash 进程已退出时仍空转到 timeout。
     * 通过 {@code alive} 回调检测进程存活：进程死亡即转为快速读模式，
     * 读尽管道残留数据并感知 EOF，立即返回，避免干等长超时。
     *
     * @param reader     输出流读取器
     * @param marker     结束标记（如 __CMD_DONE_xxx__）
     * @param timeout    最大等待时间
     * @param outputFile 会话累积输出文件（可为 null；非 null 时全量输出追加写入，支持事后回查）
     * @param alive      进程存活检测（可为 null；null 时保持旧的纯超时行为）
     * @return OutputResult
     */
    public OutputResult readUntilMarker(BufferedReader reader, String marker, Duration timeout,
                                        Path outputFile,
                                        BooleanSupplier alive) {
        List<String> allLines = new StringBuilder() != null ? new ArrayList<>() : new ArrayList<>();
        StringBuilder fullOutput = new StringBuilder();
        boolean markerFound = false;
        long deadline = System.currentTimeMillis() + timeout.toMillis();
        long startTime = System.currentTimeMillis();
        int idleCount = 0;
        int totalReadChars = 0;
        int readCalls = 0;

        log.debug("readUntilMarker start: marker={}, timeoutMs={}", marker, timeout.toMillis());

        try {
            char[] buffer = new char[8192];
            StringBuilder lineBuffer = new StringBuilder();

            while (System.currentTimeMillis() < deadline) {
                // 进程已死亡：管道写端已关闭，read() 不会阻塞（返回残留数据或 -1）。
                // 快速读完残留并感知 EOF，避免一直空转到 timeout。
                boolean processDead = alive != null && !alive.getAsBoolean();
                if (!processDead && !reader.ready()) {
                    idleCount++;
                    if (idleCount % 100 == 0) {
                        long elapsed = System.currentTimeMillis() - startTime;
                        log.warn("readUntilMarker idle loop: idleCount={}, elapsedMs={}, linesCollected={}, charsCollected={}, lineBufferLen={}",
                                idleCount, elapsed, allLines.size(), fullOutput.length(), lineBuffer.length());
                    }
                    // 没有数据，短暂等待后重试
                    Thread.sleep(50);
                    continue;
                }

                int charsRead = reader.read(buffer);
                readCalls++;
                if (charsRead == -1) {
                    log.warn("readUntilMarker EOF: readCalls={}, totalReadChars={}, linesCollected={}, elapsedMs={}",
                            readCalls, totalReadChars, allLines.size(), System.currentTimeMillis() - startTime);
                    break;
                }

                totalReadChars += charsRead;
                if (readCalls <= 3 || readCalls % 100 == 0) {
                    log.debug("readUntilMarker read: readCalls={}, charsRead={}, totalReadChars={}, elapsedMs={}",
                            readCalls, charsRead, totalReadChars, System.currentTimeMillis() - startTime);
                }

                // 重置 idle 计数，因为有新数据到达
                idleCount = 0;

                for (int i = 0; i < charsRead; i++) {
                    char c = buffer[i];
                    if (c == '\n') {
                        String line = lineBuffer.toString();
                        lineBuffer.setLength(0);

                        if (line.contains(marker)) {
                            markerFound = true;
                            log.info("readUntilMarker marker found: readCalls={}, totalReadChars={}, linesCollected={}, elapsedMs={}",
                                    readCalls, totalReadChars, allLines.size(), System.currentTimeMillis() - startTime);
                            // 不 break：继续处理当前缓冲中 marker 之后的残留字符（异步输出），避免数据被丢弃
                            continue;
                        }

                        allLines.add(line);
                        fullOutput.append(line).append("\n");
                    } else if (c != '\r') {
                        lineBuffer.append(c);
                    }
                }

                if (markerFound) break;
            }

            // 处理最后没有换行的残留内容（无论是否命中 marker，marker 之后的半行也不应丢失）
            if (lineBuffer.length() > 0) {
                String remaining = lineBuffer.toString();
                if (!remaining.contains(marker)) {
                    allLines.add(remaining);
                    fullOutput.append(remaining);
                }
            }

            // 落盘：会话累积输出文件（每次调用追加，供事后回查完整输出）
            if (outputFile != null && !fullOutput.isEmpty()) {
                writeToFile(outputFile, fullOutput.toString());
            }

            String preview = generatePreview(allLines);
            boolean truncated = !markerFound || allLines.size() > maxPreviewLines
                    || fullOutput.length() > maxPreviewChars;

            if (!markerFound) {
                log.warn("readUntilMarker completed WITHOUT marker: reason={}, readCalls={}, totalReadChars={}, linesCollected={}, elapsedMs={}, idleCount={}",
                        System.currentTimeMillis() >= deadline ? "TIMEOUT" : "EOF",
                        readCalls, totalReadChars, allLines.size(), System.currentTimeMillis() - startTime, idleCount);
            }

            return new OutputResult(
                    preview,
                    allLines.size(),
                    fullOutput.length(),
                    truncated,
                    markerFound
            );

        } catch (IOException e) {
            // 会话被并发关闭（cleanup 清理 / close 动作 / 超时回收）时，ShellSession.close()
            // 会关闭 stdout，正在 read() 的线程抛 "Stream closed"。此时已读到的输出不应丢弃：
            // 返回部分结果，让 LLM 能基于已执行的输出继续，而不是把成功命令误判为失败。
            boolean streamClosed = isStreamClosed(e);
            if (streamClosed) {
                log.warn("Output stream closed while reading (session likely closed): linesCollected={}, charsCollected={}",
                        allLines.size(), fullOutput.length());
            } else {
                log.error("Failed to read output", e);
            }
            return buildPartialResult(allLines, fullOutput, outputFile, streamClosed, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new OutputResult("Output reading interrupted", 0, 0, false, false);
        }
    }

    private boolean isStreamClosed(IOException e) {
        String message = e.getMessage();
        return message != null && message.contains("Stream closed");
    }

    /**
     * 读取中断时尽量保留已收集到的输出：落盘会话累积文件并生成预览，
     * 避免并发关闭会话等竞态导致已执行命令的输出全部丢失。
     */
    private OutputResult buildPartialResult(List<String> allLines, StringBuilder fullOutput,
                                            Path outputFile,
                                            boolean streamClosed, IOException cause) {
        if (outputFile != null && !fullOutput.isEmpty()) {
            writeToFile(outputFile, fullOutput.toString());
        }

        String preview = generatePreview(allLines);
        String note = streamClosed
                ? "[注意: 输出流已关闭（会话被清理或关闭），输出可能不完整]"
                : "[注意: 读取输出失败: " + cause.getMessage() + "]";
        if (preview.isEmpty()) {
            preview = note;
        } else {
            preview = preview + "\n" + note;
        }

        return new OutputResult(preview, allLines.size(), fullOutput.length(), true, false);
    }

    /**
     * 格式化工具返回结果
     */
    public String formatToolResult(int exitCode, String sessionId, long elapsedMs,
                                    OutputResult output, String currentWorkdir, Path outputFile) {
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
        }

        if (outputFile != null) {
            sb.append("output_file: ").append(outputFile).append("\n");
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
            boolean markerFound
    ) {}
}
