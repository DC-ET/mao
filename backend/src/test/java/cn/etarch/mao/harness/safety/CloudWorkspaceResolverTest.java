package cn.etarch.mao.harness.safety;

import cn.etarch.mao.common.exception.BusinessException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class CloudWorkspaceResolverTest {

    @TempDir
    Path tempDir;

    @Test
    void normalizeAndValidate_acceptsValidSlug() {
        assertEquals("my-app", CloudWorkspaceResolver.normalizeAndValidate("my-app"));
        assertEquals("agent_workbench", CloudWorkspaceResolver.normalizeAndValidate("  agent_workbench  "));
    }

    @Test
    void normalizeAndValidate_rejectsInvalidSlug() {
        assertThrows(BusinessException.class, () -> CloudWorkspaceResolver.normalizeAndValidate("../etc"));
        assertThrows(BusinessException.class, () -> CloudWorkspaceResolver.normalizeAndValidate("a/b"));
        assertThrows(BusinessException.class, () -> CloudWorkspaceResolver.normalizeAndValidate("projects"));
        assertThrows(BusinessException.class, () -> CloudWorkspaceResolver.normalizeAndValidate(""));
        assertThrows(BusinessException.class, () -> CloudWorkspaceResolver.normalizeAndValidate("a".repeat(65)));
    }

    @Test
    void resolveProjectWorkspace_staysUnderUserSandbox() {
        PathSandbox sandbox = new PathSandbox(tempDir.toString());
        String path = CloudWorkspaceResolver.resolveProjectWorkspace(sandbox, 42L, "demo");
        assertTrue(path.replace('\\', '/').endsWith("/42/projects/demo"));
    }

    @Test
    void assertUnderUserSandbox_rejectsEscape() {
        PathSandbox sandbox = new PathSandbox(tempDir.toString());
        assertThrows(BusinessException.class, () ->
                CloudWorkspaceResolver.assertUnderUserSandbox(sandbox, 1L, tempDir.resolve("2").toString()));
    }
}
