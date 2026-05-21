package com.agentworkbench.harness.safety;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Path sandbox - prevents directory escape attacks
 */
@Slf4j
@Component
public class PathSandbox {

    private final Path workspaceRoot;

    public PathSandbox(@Value("${app.harness.workspace-root:./workspace}") String workspaceRoot) {
        this.workspaceRoot = Paths.get(workspaceRoot).toAbsolutePath().normalize();
    }

    /**
     * Resolve and validate a user-provided path against the workspace root.
     * Throws SecurityException if the path escapes the sandbox.
     */
    public Path resolve(String userPath) {
        return resolve(userPath, null);
    }

    /**
     * Resolve and validate a user-provided path against a session workspace (or fall back to default root).
     * Throws SecurityException if the path escapes the sandbox.
     */
    public Path resolve(String userPath, String sessionWorkspace) {
        if (userPath == null || userPath.isEmpty()) {
            throw new IllegalArgumentException("Path cannot be empty");
        }

        Path root = (sessionWorkspace != null && !sessionWorkspace.isEmpty())
                ? Paths.get(sessionWorkspace).toAbsolutePath().normalize()
                : workspaceRoot;

        Path resolved = root.resolve(userPath).normalize();
        if (!resolved.startsWith(root)) {
            log.warn("Path escape attempt blocked: {} (resolved to {})", userPath, resolved);
            throw new SecurityException("Path escape attempt: " + userPath);
        }
        return resolved;
    }

    /**
     * Resolve path and return as File
     */
    public File resolveAsFile(String userPath) {
        return resolve(userPath).toFile();
    }

    /**
     * Get the effective workspace root for a session, falling back to the default root.
     */
    public Path getEffectiveWorkspaceRoot(String sessionWorkspace) {
        if (sessionWorkspace != null && !sessionWorkspace.isEmpty()) {
            return Paths.get(sessionWorkspace).toAbsolutePath().normalize();
        }
        return workspaceRoot;
    }

    public Path getWorkspaceRoot() {
        return workspaceRoot;
    }
}
