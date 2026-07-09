package cn.etarch.mao.harness.core;

import cn.etarch.mao.command.entity.UserCommand;
import cn.etarch.mao.command.service.UserCommandService;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.runtime.RuntimeDataResolver;
import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.harness.skill.LocalSkillRef;
import cn.etarch.mao.harness.skill.SkillDocument;
import cn.etarch.mao.harness.skill.SkillLoader;
import cn.etarch.mao.harness.skill.SkillSyncService;
import cn.etarch.mao.harness.tool.Tool;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class PromptEngineTest {

    private final SkillLoader skillLoader = mock(SkillLoader.class);
    private final PathSandbox pathSandbox = mock(PathSandbox.class);
    private final RuntimeDataResolver runtimeDataResolver = mock(RuntimeDataResolver.class);
    private final UserCommandService userCommandService = mock(UserCommandService.class);
    private final SkillSyncService skillSyncService = mock(SkillSyncService.class);
    private final ToolMediaInjector toolMediaInjector = new ToolMediaInjector();
    private final PromptEngine promptEngine = new PromptEngine(
            skillLoader, pathSandbox, runtimeDataResolver, userCommandService, skillSyncService, toolMediaInjector);

    @Test
    void buildRequestExpandsMarkersAndAddsCloudPromptSkillsAndTools() {
        when(pathSandbox.getWorkspaceRoot()).thenReturn(Path.of("/workspace-root"));
        when(skillLoader.hasSkill("java")).thenReturn(true);
        when(skillSyncService.getUserSkillDocuments(7L)).thenReturn(List.of());
        UserCommand command = new UserCommand();
        command.setContent("run mvn test");
        when(userCommandService.getByUserIdAndName(7L, "test")).thenReturn(command);
        when(runtimeDataResolver.formatCloudSkillsDir(7L, 9L, "java")).thenReturn("/runtime/java");
        when(runtimeDataResolver.formatCloudSkillsPath(7L, 9L, "java")).thenReturn("/runtime/java/SKILL.md");

        AgentExecutionContext context = new AgentExecutionContext();
        context.setSessionId(9L);
        context.setUserId(7L);
        context.setSystemPrompt("You are careful.");
        context.setWorkspace("/repo");
        context.setExecutionMode("CLOUD");
        context.setIsGit(true);
        context.setPlatform("macOS");
        context.setShellPath("/bin/zsh");
        context.setOsVersion("15");
        context.setCurrentTimestamp("2026-07-07T10:00:00+08:00");
        context.setAvailableSkillNames(List.of("java"));
        context.setAvailableSkillDocs(Map.of("java", skillDoc("java", "Java dev", "/skills/java/SKILL.md")));
        context.setTools(List.of(tool("task_create"), tool("delegate"), tool("read_file")));
        context.addUserMessage("Use ${java}$, #{test}#, and @{src/main/App.java}@");

        ChatRequest request = promptEngine.buildRequest(context);

        assertThat(request.getStream()).isTrue();
        assertThat(request.getTools()).extracting(td -> td.getFunction().getName())
                .containsExactly("task_create", "delegate", "read_file");
        assertThat(request.getMessages()).hasSize(2);
        String systemPrompt = request.getMessages().get(0).getContent().toString();
        assertThat(systemPrompt)
                .contains("You are careful.", "/repo", "CLOUD", "java", "/runtime/java/SKILL.md",
                        "任务管理", "子代理委派", "不支持以 `~` 开头",
                        "# 使用你的工具", "ask_user_questions", "最大化并行工具调用");
        assertThat(systemPrompt.indexOf("# 使用你的工具"))
                .isLessThan(systemPrompt.indexOf("## 可用技能"));
        assertThat(request.getMessages().get(1).getContent())
                .isEqualTo("Use /java, run mvn test, and src/main/App.java");
    }

    @Test
    void buildRequestUsesFallbackWorkspaceAndLocalSkillPaths() {
        when(pathSandbox.getWorkspaceRoot()).thenReturn(Path.of("/fallback"));
        when(skillLoader.getAllNames()).thenReturn(List.of("local-skill"));
        when(skillLoader.getAllDocuments()).thenReturn(List.of(
                skillDoc("local-skill", "Local skill", "/skills/local/SKILL.md")));
        when(runtimeDataResolver.formatLocalSkillsDir(5L, "local-skill")).thenReturn("/local/skills/local-skill");
        when(runtimeDataResolver.formatLocalSkillsPath(5L, "local-skill")).thenReturn("/local/skills/local-skill/SKILL.md");

        AgentExecutionContext context = new AgentExecutionContext();
        context.setSessionId(5L);
        context.setExecutionMode("LOCAL");
        context.setAvailableSkillNames(List.of("local-skill"));
        context.setTools(List.of());
        context.addUserMessage("plain");

        ChatRequest request = promptEngine.buildRequest(context);

        assertThat(request.getTools()).isNull();
        assertThat(request.getMessages().get(0).getContent().toString())
                .contains("/fallback", "LOCAL", "未知", "/local/skills/local-skill/SKILL.md")
                .doesNotContain("不支持以 `~` 开头");
    }

    @Test
    void buildRequestUsesLocalUnsyncedSkillPathAndAllowsMarkerReplacement() {
        when(pathSandbox.getWorkspaceRoot()).thenReturn(Path.of("/fallback"));
        when(skillSyncService.getUserSkillDocuments(7L)).thenReturn(List.of());
        when(runtimeDataResolver.formatLocalUnsyncedSkillsDir("local-only-folder"))
                .thenReturn("~/.agents/skills/local-only-folder");
        when(runtimeDataResolver.formatLocalUnsyncedSkillsPath("local-only-folder"))
                .thenReturn("~/.agents/skills/local-only-folder/SKILL.md");

        AgentExecutionContext context = new AgentExecutionContext();
        context.setSessionId(5L);
        context.setUserId(7L);
        context.setExecutionMode("LOCAL");
        context.setAvailableSkillNames(List.of("local-only"));
        LocalSkillRef ref = new LocalSkillRef();
        ref.setName("local-only");
        ref.setDescription("Not yet uploaded");
        ref.setFolderName("local-only-folder");
        context.setLocalUnsyncedSkills(List.of(ref));
        context.setTools(List.of());
        context.addUserMessage("Use ${local-only}$ now");

        ChatRequest request = promptEngine.buildRequest(context);

        assertThat(request.getMessages().get(0).getContent().toString())
                .contains("~/.agents/skills/local-only-folder/SKILL.md",
                        "~/.agents/skills/local-only-folder",
                        "本地未同步");
        assertThat(request.getMessages().get(1).getContent()).isEqualTo("Use /local-only now");
    }

    private Tool tool(String name) {
        Tool tool = mock(Tool.class);
        when(tool.getName()).thenReturn(name);
        when(tool.getDescription()).thenReturn(name + " description");
        when(tool.getInputSchema()).thenReturn(Map.of("type", "object"));
        return tool;
    }

    private SkillDocument skillDoc(String name, String description, String path) {
        SkillDocument doc = new SkillDocument();
        doc.setName(name);
        doc.setDescription(description);
        doc.setFilePath(path);
        doc.setFolderPath(path.substring(0, path.lastIndexOf('/')));
        doc.setBody("body");
        return doc;
    }
}
