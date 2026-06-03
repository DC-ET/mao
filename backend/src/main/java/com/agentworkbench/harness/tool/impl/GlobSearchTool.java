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
import java.util.stream.Stream;

@Slf4j
@Component
public class GlobSearchTool implements Tool {

    private static final int DEFAULT_HEAD_LIMIT = 100;

    private final ObjectMapper objectMapper;
    private final PathSandbox pathSandbox;
    private volatile Boolean rgAvailable;

    public GlobSearchTool(ObjectMapper objectMapper, PathSandbox pathSandbox) {
        this.objectMapper = objectMapper;
        this.pathSandbox = pathSandbox;
    }

    @Override
    public String getName() {
        return "glob_search";
    }

    @Override
    public String getDescription() {
        return "Search files by glob pattern. Returns matching file paths, search root, and whether results are truncated.";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("pattern", Map.of("type", "string", "description", "Glob pattern, e.g. *.java, src/**/*.xml"));
        properties.put("path", Map.of("type", "string", "description", "Search root directory, optional; defaults to session workspace root"));
        properties.put("head_limit", Map.of("type", "integer", "description", "Max files to return, default 100"));
        schema.put("properties", properties);
        schema.put("required", new String[]{"pattern"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("files", Map.of("type", "array", "items", Map.of("type", "string")));
        properties.put("search_root", Map.of("type", "string"));
        properties.put("truncated", Map.of("type", "boolean"));
        properties.put("total_matched", Map.of("type", "integer"));
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
            int headLimit = args.has("head_limit") ? args.get("head_limit").asInt(DEFAULT_HEAD_LIMIT) : DEFAULT_HEAD_LIMIT;

            Path searchRoot;
            if (args.has("path") && !args.get("path").asText().isEmpty()) {
                searchRoot = pathSandbox.resolve(args.get("path").asText(), workspace);
            } else {
                searchRoot = pathSandbox.getEffectiveWorkspaceRoot(workspace);
            }

            List<String> files;
            boolean rgUsed = isRgAvailable();
            if (rgUsed) {
                files = searchWithRg(pattern, searchRoot, headLimit);
            } else {
                files = searchWithJava(pattern, searchRoot, headLimit);
            }

            boolean truncated = files.size() >= headLimit;
            int totalMatched = truncated ? headLimit : files.size();

            return objectMapper.writeValueAsString(Map.of(
                    "files", files,
                    "search_root", searchRoot.toString(),
                    "truncated", truncated,
                    "total_matched", totalMatched
            ));
        } catch (Exception e) {
            log.error("GlobSearchTool execution failed", e);
            try {
                return objectMapper.writeValueAsString(Map.of(
                        "files", List.of(),
                        "error", e.getMessage()
                ));
            } catch (Exception ex) {
                return "{\"files\":[],\"error\":\"" + e.getMessage().replace("\"", "'") + "\"}";
            }
        }
    }

    private List<String> searchWithRg(String pattern, Path searchRoot, int headLimit) throws Exception {
        ProcessBuilder pb = new ProcessBuilder("rg", "--files", "--glob", pattern, searchRoot.toString());
        pb.redirectErrorStream(true);
        Process process = pb.start();

        List<String> files = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null && files.size() < headLimit) {
                Path absolute = Path.of(line).toAbsolutePath().normalize();
                if (absolute.startsWith(searchRoot)) {
                    files.add(searchRoot.relativize(absolute).toString());
                } else {
                    files.add(absolute.toString());
                }
            }
        }

        if (!process.waitFor(30, TimeUnit.SECONDS)) {
            process.destroyForcibly();
        }
        return files;
    }

    private List<String> searchWithJava(String pattern, Path searchRoot, int headLimit) {
        PathMatcher matcher = FileSystems.getDefault().getPathMatcher("glob:" + pattern);
        List<String> files = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(searchRoot)) {
            walk.filter(Files::isRegularFile)
                    .filter(p -> {
                        Path relative = searchRoot.relativize(p);
                        return matcher.matches(relative) || matcher.matches(p.getFileName());
                    })
                    .limit(headLimit)
                    .forEach(p -> {
                        Path relative = searchRoot.relativize(p);
                        files.add(relative.toString());
                    });
        } catch (Exception e) {
            log.warn("Java glob search failed for pattern '{}': {}", pattern, e.getMessage());
        }
        return files;
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
}
