package cn.etarch.mao.harness.skill;

import cn.etarch.mao.harness.safety.PathSandbox;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SkillLoaderTest {

    @TempDir
    Path tempDir;

    @Test
    void loadsValidSkillFoldersAndBuildsCatalog() throws Exception {
        PathSandbox sandbox = new PathSandbox(tempDir.resolve("workspace").toString());
        SkillLoader loader = new SkillLoader(sandbox);
        ReflectionTestUtils.setField(loader, "skillsDir", tempDir.resolve("skills").toString());
        ReflectionTestUtils.setField(loader, "cacheSeconds", 300);

        writeSkill(tempDir.resolve("skills").resolve("java"), "java", "Java helper", "Use Java.");
        Files.createDirectories(tempDir.resolve("skills").resolve("broken"));
        Files.writeString(tempDir.resolve("skills").resolve("broken").resolve("SKILL.md"), "no frontmatter");
        Files.writeString(tempDir.resolve("skills").resolve("README.md"), "ignored");

        assertThat(loader.getAllNames()).containsExactly("java");
        assertThat(loader.hasSkill("java")).isTrue();
        assertThat(loader.hasSkill("missing")).isFalse();
        assertThat(loader.getSkillFolder("java")).isDirectory();
        assertThat(loader.getCatalogWithPaths(null))
                .contains("**java**")
                .contains("Java helper")
                .contains("SKILL.md");
        assertThat(loader.getCatalogWithPaths(List.of("missing"))).isEmpty();
        assertThat(loader.getAllDocuments()).extracting(SkillDocument::getBody).containsExactly("Use Java.");
        assertThat(loader.getSkillsDir()).isEqualTo(tempDir.resolve("skills").toAbsolutePath().normalize());
    }

    @Test
    void createsMissingDirectoryAsEmptyAndCanInvalidateCache() throws Exception {
        PathSandbox sandbox = new PathSandbox(tempDir.resolve("workspace").toString());
        SkillLoader loader = new SkillLoader(sandbox);
        Path missing = tempDir.resolve("missing");
        ReflectionTestUtils.setField(loader, "skillsDir", missing.toString());
        ReflectionTestUtils.setField(loader, "cacheSeconds", 300);

        assertThat(loader.getCatalogWithPaths(null)).isNull();
        assertThat(loader.getAllNames()).isEmpty();
        assertThat(missing).isDirectory();

        writeSkill(missing.resolve("new"), "new", "New skill", "Body");
        loader.invalidateCache();

        assertThat(loader.getAllNames()).containsExactly("new");
    }

    @Test
    void ensureSkillsDirCreatesDirectoryOnStartup() {
        PathSandbox sandbox = new PathSandbox(tempDir.resolve("workspace").toString());
        SkillLoader loader = new SkillLoader(sandbox);
        Path skills = tempDir.resolve("startup-skills");
        ReflectionTestUtils.setField(loader, "skillsDir", skills.toString());

        loader.ensureSkillsDir();

        assertThat(skills).isDirectory();
    }

    private static void writeSkill(Path folder, String name, String description, String body) throws Exception {
        Files.createDirectories(folder);
        Files.writeString(folder.resolve("SKILL.md"), """
                ---
                name: %s
                description: %s
                ---
                %s
                """.formatted(name, description, body));
    }
}
