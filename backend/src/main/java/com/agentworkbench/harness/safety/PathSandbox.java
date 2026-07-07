package com.agentworkbench.harness.safety;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Path sandbox - prevents directory escape attacks
 */
@Slf4j
@Component
public class PathSandbox {

    private final Path workspaceRoot;
    private final Set<Path> allowedRoots = ConcurrentHashMap.newKeySet();

    public PathSandbox(@Value("${app.harness.workspace-root:./workspace}") String workspaceRoot) {
        this.workspaceRoot = Paths.get(workspaceRoot).toAbsolutePath().normalize();
        // Ensure the default workspace directory exists for CLOUD mode
        File rootDir = this.workspaceRoot.toFile();
        if (!rootDir.exists()) {
            rootDir.mkdirs();
            log.info("Created default workspace directory: {}", this.workspaceRoot);
        }
    }

    /**
     * Resolve and validate a user-provided path against the workspace root.
     * Throws SecurityException if the path escapes the sandbox.
     */
    public Path resolve(String userPath) {
        return resolve(userPath, null);
    }

    /**
     * Register an additional allowed root directory (e.g. skills classpath dir).
     * Paths under these roots can be read even if outside the workspace.
     */
    public void addAllowedRoot(Path root) {
        allowedRoots.add(root.toAbsolutePath().normalize());
    }

    /**
     * Resolve and validate a user-provided path against a session workspace (or fall back to default root).
     * Throws SecurityException if the path escapes the sandbox.
     */
    public Path resolve(String userPath, String sessionWorkspace) {
        if (userPath == null || userPath.isEmpty()) {
            throw new IllegalArgumentException("Path cannot be empty");
        }

        if (userPath.startsWith("~")) {
            throw new SecurityException("Tilde paths are not supported on server: " + userPath);
        }

        Path input = Paths.get(userPath);
        if (input.isAbsolute()) {
            Path normalized = input.toAbsolutePath().normalize();
            if (isUnderAllowedRoot(normalized)) {
                return normalized;
            }
            log.warn("Absolute path outside sandbox blocked: {}", userPath);
            throw new SecurityException("Path escape attempt: " + userPath);
        }

        Path root = (sessionWorkspace != null && !sessionWorkspace.isEmpty())
                ? Paths.get(sessionWorkspace).toAbsolutePath().normalize()
                : workspaceRoot;

        Path resolved = root.resolve(userPath).normalize();
        if (resolved.startsWith(root)) {
            return resolved;
        }

        if (isUnderAllowedRoot(resolved)) {
            return resolved;
        }

        log.warn("Path escape attempt blocked: {} (resolved to {})", userPath, resolved);
        throw new SecurityException("Path escape attempt: " + userPath);
    }

    private boolean isUnderAllowedRoot(Path resolved) {
        for (Path allowed : allowedRoots) {
            if (resolved.startsWith(allowed)) {
                return true;
            }
        }
        return false;
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
