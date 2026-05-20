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
        if (userPath == null || userPath.isEmpty()) {
            throw new IllegalArgumentException("Path cannot be empty");
        }

        Path resolved = workspaceRoot.resolve(userPath).normalize();
        if (!resolved.startsWith(workspaceRoot)) {
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

    public Path getWorkspaceRoot() {
        return workspaceRoot;
    }
}
