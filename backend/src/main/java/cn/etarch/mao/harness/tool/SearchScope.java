package cn.etarch.mao.harness.tool;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Normalizes a resolved search path (directory or file) into rg-compatible cwd + target.
 */
public final class SearchScope {

    private final Path cwd;
    private final String rgTarget;
    private final Path singleFile;

    private SearchScope(Path cwd, String rgTarget, Path singleFile) {
        this.cwd = cwd;
        this.rgTarget = rgTarget;
        this.singleFile = singleFile;
    }

    public static SearchScope from(Path resolved) throws IOException {
        if (Files.isRegularFile(resolved)) {
            Path parent = resolved.getParent();
            if (parent == null) {
                throw new IOException("Cannot search in file without parent directory: " + resolved);
            }
            return new SearchScope(parent, parent.relativize(resolved).toString(), resolved);
        }
        if (Files.isDirectory(resolved)) {
            return new SearchScope(resolved, ".", null);
        }
        throw new IOException("Search path does not exist or is not accessible: " + resolved);
    }

    public Path cwd() {
        return cwd;
    }

    public String rgTarget() {
        return rgTarget;
    }

    public boolean isSingleFile() {
        return singleFile != null;
    }

    public Path singleFile() {
        return singleFile;
    }

    public String outputFilePath(String rgFilePath, Path workspaceRoot) {
        if (singleFile != null) {
            Path normalized = singleFile.normalize();
            if (workspaceRoot != null && normalized.startsWith(workspaceRoot.normalize())) {
                return workspaceRoot.relativize(normalized).toString();
            }
            return normalized.getFileName().toString();
        }
        return relativizeRgPath(rgFilePath, cwd);
    }

    public static String relativizeRgPath(String pathStr, Path searchRoot) {
        String trimmed = pathStr.startsWith("./") ? pathStr.substring(2) : pathStr;
        Path path = Path.of(trimmed);
        if (path.isAbsolute()) {
            Path normalized = path.normalize();
            return normalized.startsWith(searchRoot)
                    ? searchRoot.relativize(normalized).toString()
                    : normalized.toString();
        }
        return path.normalize().toString();
    }
}
