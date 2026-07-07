package cn.etarch.mao.harness.runtime;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 会话运行时数据目录路径解析（skills 副本、shell 输出、git-askpass 等）。
 * <p>
 * CLOUD: {runtime-dir}/{userId}/{sessionId}/
 * LOCAL Prompt 路径使用 {@link #formatLocalSkillsPath} 等 ~ 前缀形式。
 */
@Component
public final class RuntimeDataResolver {

    private static final String LOCAL_RUNTIME_PREFIX = "~/.mao/runtime";

    private final Path runtimeRoot;

    public RuntimeDataResolver(
            @Value("${app.harness.runtime-dir:${app.root-dir}/data/runtime}") String runtimeDir) {
        this.runtimeRoot = Paths.get(runtimeDir).toAbsolutePath().normalize();
    }

    /** CLOUD: {runtime-dir}/{userId}/{sessionId} */
    public Path resolveSessionRuntimeDir(Long userId, Long sessionId) {
        return runtimeRoot.resolve(String.valueOf(userId)).resolve(String.valueOf(sessionId));
    }

    public Path resolveSkillsDir(Long userId, Long sessionId) {
        return resolveSessionRuntimeDir(userId, sessionId).resolve("skills");
    }

    public Path resolveShellOutputDir(Long userId, Long sessionId) {
        return resolveSessionRuntimeDir(userId, sessionId).resolve("shellOutput");
    }

    public Path resolveGitAskpassScript(Long userId, Long sessionId) {
        return resolveSessionRuntimeDir(userId, sessionId).resolve("git-askpass.sh");
    }

    /** LOCAL Prompt 用：~/.mao/runtime/{sessionId}/skills/{skillName}/SKILL.md */
    public String formatLocalSkillsPath(Long sessionId, String skillName) {
        return LOCAL_RUNTIME_PREFIX + "/" + sessionId + "/skills/" + skillName + "/SKILL.md";
    }

    /** LOCAL Prompt 用：~/.mao/runtime/{sessionId}/skills/{skillName} */
    public String formatLocalSkillsDir(Long sessionId, String skillName) {
        return LOCAL_RUNTIME_PREFIX + "/" + sessionId + "/skills/" + skillName;
    }

    /** CLOUD Prompt 用：绝对路径 */
    public String formatCloudSkillsPath(Long userId, Long sessionId, String skillName) {
        return resolveSkillsDir(userId, sessionId).resolve(skillName).resolve("SKILL.md").toString();
    }

    /** CLOUD Prompt 用：绝对路径 */
    public String formatCloudSkillsDir(Long userId, Long sessionId, String skillName) {
        return resolveSkillsDir(userId, sessionId).resolve(skillName).toString();
    }

    public Path getRuntimeRoot() {
        return runtimeRoot;
    }
}
