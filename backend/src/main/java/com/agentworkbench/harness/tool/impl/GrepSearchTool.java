package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.safety.PathSandbox;
import com.agentworkbench.harness.tool.Tool;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.stream.Stream;

@Slf4j
@Component
public class GrepSearchTool implements Tool {

    private static final int DEFAULT_MAX_OUTPUT_CHARS = 10000;

    private final ObjectMapper objectMapper;
    private final PathSandbox pathSandbox;
    private volatile Boolean rgAvailable;

    public GrepSearchTool(ObjectMapper objectMapper, PathSandbox pathSandbox) {
        this.objectMapper = objectMapper;
        this.pathSandbox = pathSandbox;
    }

    @Override
    public String getName() {
        return "grep_search";
    }

    @Override
    public String getDescription() {
        return "按文本或正则表达式搜索文件内容。返回匹配行及其文件路径和行号。";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("pattern", Map.of("type", "string", "description", "要搜索的文本或正则表达式"));
        properties.put("path", Map.of("type", "string", "description", "搜索目录或文件，可选；默认使用当前会话的工作区根目录"));
        properties.put("glob", Map.of("type", "string", "description", "文件过滤 glob，例如 *.java、*.md"));
        properties.put("ignore_case", Map.of("type", "boolean", "description", "是否忽略大小写，默认 false"));
        properties.put("context_lines", Map.of("type", "integer", "description", "上下文行数，默认 0"));
        properties.put("max_output_chars", Map.of("type", "integer", "description", "最多输出字符数，默认 10000"));
        schema.put("properties", properties);
        schema.put("required", new String[]{"pattern"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("matches", Map.of("type", "array"));
        properties.put("truncated", Map.of("type", "boolean"));
        properties.put("total_matches", Map.of("type", "integer"));
        schema.put("properties", properties);
        return schema;
    }

    @Override
    public String execute(String arguments) {
        return execute(arguments, null);
    }

    @Override
    public String execute(String arguments, String workspace) {
        try {
            var args = objectMapper.readTree(arguments);
            String pattern = args.get("pattern").asText();
            String glob = args.has("glob") ? args.get("glob").asText(null) : null;
            boolean ignoreCase = args.has("ignore_case") && args.get("ignore_case").asBoolean(false);
            int contextLines = args.has("context_lines") ? args.get("context_lines").asInt(0) : 0;
            int maxOutputChars = args.has("max_output_chars") ? args.get("max_output_chars").asInt(DEFAULT_MAX_OUTPUT_CHARS) : DEFAULT_MAX_OUTPUT_CHARS;

            Path searchRoot;
            if (args.has("path") && !args.get("path").asText().isEmpty()) {
                searchRoot = pathSandbox.resolve(args.get("path").asText(), workspace);
            } else {
                searchRoot = pathSandbox.getEffectiveWorkspaceRoot(workspace);
            }

            List<Map<String, Object>> matches;
            int totalMatches;
            boolean truncated;

            if (isRgAvailable()) {
                var result = searchWithRg(pattern, searchRoot, glob, ignoreCase, contextLines, maxOutputChars);
                matches = result.matches;
                totalMatches = result.totalMatches;
                truncated = result.truncated;
            } else {
                var result = searchWithJava(pattern, searchRoot, glob, ignoreCase, contextLines, maxOutputChars);
                matches = result.matches;
                totalMatches = result.totalMatches;
                truncated = result.truncated;
            }

            return objectMapper.writeValueAsString(Map.of(
                    "matches", matches,
                    "truncated", truncated,
                    "total_matches", totalMatches
            ));
        } catch (Exception e) {
            log.error("GrepSearchTool execution failed", e);
            try {
                return objectMapper.writeValueAsString(Map.of(
                        "matches", List.of(),
                        "error", e.getMessage()
                ));
            } catch (Exception ex) {
                return "{\"matches\":[],\"error\":\"" + e.getMessage().replace("\"", "'") + "\"}";
            }
        }
    }

    private SearchResult searchWithRg(String pattern, Path searchRoot, String glob, boolean ignoreCase,
                                       int contextLines, int maxOutputChars) throws Exception {
        List<String> cmd = new ArrayList<>(List.of("rg", "--line-number", "--no-heading"));
        if (ignoreCase) cmd.add("--ignore-case");
        if (contextLines > 0) {
            cmd.add("--context");
            cmd.add(String.valueOf(contextLines));
        }
        if (glob != null && !glob.isEmpty()) {
            cmd.add("--glob");
            cmd.add(glob);
        }
        cmd.add(pattern);
        cmd.add(searchRoot.toString());

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        Process process = pb.start();

        List<Map<String, Object>> matches = new ArrayList<>();
        int totalMatches = 0;
        int charsUsed = 0;
        boolean truncated = false;

        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (charsUsed + line.length() + 1 > maxOutputChars) {
                    truncated = true;
                    break;
                }
                Map<String, Object> match = parseRgLine(line, searchRoot);
                if (match != null) {
                    matches.add(match);
                    totalMatches++;
                    charsUsed += line.length() + 1;
                }
            }
        }

        if (!process.waitFor(30, TimeUnit.SECONDS)) {
            process.destroyForcibly();
        }

        if (!truncated) {
            truncated = totalMatches > 0 && charsUsed >= maxOutputChars;
        }

        return new SearchResult(matches, totalMatches, truncated);
    }

    private Map<String, Object> parseRgLine(String line, Path searchRoot) {
        // rg output format: file:line:content or file-line-content (context)
        int firstColon = line.indexOf(':');
        if (firstColon < 0) return null;

        int secondColon = line.indexOf(':', firstColon + 1);
        if (secondColon < 0) return null;

        String filePath = line.substring(0, firstColon);
        String lineNumStr = line.substring(firstColon + 1, secondColon);
        String content = line.substring(secondColon + 1);

        int lineNum;
        try {
            lineNum = Integer.parseInt(lineNumStr);
        } catch (NumberFormatException e) {
            // context line with dash separator
            int firstDash = line.indexOf('-');
            if (firstDash < 0) return null;
            int secondDash = line.indexOf('-', firstDash + 1);
            if (secondDash < 0) return null;
            filePath = line.substring(0, firstDash);
            lineNumStr = line.substring(firstDash + 1, secondDash);
            content = line.substring(secondDash + 1);
            try {
                lineNum = Integer.parseInt(lineNumStr);
            } catch (NumberFormatException ex) {
                return null;
            }
        }

        Path absolute = Path.of(filePath).toAbsolutePath().normalize();
        String relativePath;
        if (absolute.startsWith(searchRoot)) {
            relativePath = searchRoot.relativize(absolute).toString();
        } else {
            relativePath = absolute.toString();
        }

        Map<String, Object> match = new HashMap<>();
        match.put("file", relativePath);
        match.put("line", lineNum);
        match.put("content", content);
        return match;
    }

    private SearchResult searchWithJava(String pattern, Path searchRoot, String glob, boolean ignoreCase,
                                         int contextLines, int maxOutputChars) {
        int flags = Pattern.MULTILINE;
        if (ignoreCase) flags |= Pattern.CASE_INSENSITIVE;
        Pattern compiled = Pattern.compile(pattern, flags);

        final PathMatcher globMatcher = (glob != null && !glob.isEmpty())
                ? FileSystems.getDefault().getPathMatcher("glob:" + glob)
                : null;

        List<Map<String, Object>> matches = new ArrayList<>();
        int totalMatches = 0;
        int charsUsed = 0;
        boolean truncated = false;

        try (Stream<Path> walk = Files.walk(searchRoot)) {
            List<Path> files = walk.filter(Files::isRegularFile)
                    .filter(p -> globMatcher == null || globMatcher.matches(p.getFileName()))
                    .toList();

            for (Path file : files) {
                if (truncated) break;

                String relativePath;
                Path absolute = file.toAbsolutePath().normalize();
                if (absolute.startsWith(searchRoot)) {
                    relativePath = searchRoot.relativize(absolute).toString();
                } else {
                    relativePath = absolute.toString();
                }

                List<String> lines;
                try {
                    lines = Files.readAllLines(file);
                } catch (Exception e) {
                    continue;
                }

                for (int i = 0; i < lines.size(); i++) {
                    String line = lines.get(i);
                    if (compiled.matcher(line).find()) {
                        StringBuilder matchContent = new StringBuilder(line);
                        List<String> contextBefore = new ArrayList<>();
                        List<String> contextAfter = new ArrayList<>();

                        if (contextLines > 0) {
                            for (int c = Math.max(0, i - contextLines); c < i; c++) {
                                contextBefore.add(lines.get(c));
                            }
                            for (int c = i + 1; c <= Math.min(lines.size() - 1, i + contextLines); c++) {
                                contextAfter.add(lines.get(c));
                            }
                        }

                        Map<String, Object> match = new HashMap<>();
                        match.put("file", relativePath);
                        match.put("line", i + 1);
                        match.put("content", matchContent.toString());
                        if (!contextBefore.isEmpty()) match.put("context_before", contextBefore);
                        if (!contextAfter.isEmpty()) match.put("context_after", contextAfter);

                        int entrySize = match.toString().length();
                        if (charsUsed + entrySize > maxOutputChars) {
                            truncated = true;
                            break;
                        }

                        matches.add(match);
                        totalMatches++;
                        charsUsed += entrySize;
                    }
                }
            }
        } catch (Exception e) {
            log.warn("Java grep search failed for pattern '{}': {}", pattern, e.getMessage());
        }

        return new SearchResult(matches, totalMatches, truncated);
    }

    private boolean isRgAvailable() {
        if (rgAvailable != null) return rgAvailable;
        try {
            Process p = new ProcessBuilder("rg", "--version").redirectErrorStream(true).start();
            boolean ok = p.waitFor(5, TimeUnit.SECONDS) && p.exitValue() == 0;
            rgAvailable = ok;
        } catch (Exception e) {
            rgAvailable = false;
        }
        return rgAvailable;
    }

    private record SearchResult(List<Map<String, Object>> matches, int totalMatches, boolean truncated) {}
}
