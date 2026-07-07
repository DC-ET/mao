package cn.etarch.mao.harness.skill;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.harness.runtime.RuntimeDataResolver;
import cn.etarch.mao.harness.safety.PathSandbox;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.ZipInputStream;

import static org.assertj.core.api.Assertions.assertThat;

class SkillSyncServiceTest {

    @TempDir
    Path tempDir;

    @Test
    void syncToSessionCopiesMergedSystemAndUserSkillsAndTracksRemovedSkills() throws Exception {
        Path systemRoot = tempDir.resolve("system-skills");
        Path userRoot = tempDir.resolve("user-skills");
        Path runtimeRoot = tempDir.resolve("runtime");
        writeSkill(systemRoot.resolve("java"), "java", "Java", "system");
        writeSkill(userRoot.resolve("7").resolve("personal"), "personal", "Personal", "user");

        SkillLoader loader = loader(systemRoot);
        SkillSyncService service = service(loader, userRoot, runtimeRoot);
        Agent agent = agent(3L, "[\"java\"]");

        service.syncToSession(agent, 7L, 11L);

        Path skillsDir = runtimeRoot.resolve("7").resolve("11").resolve("skills");
        assertThat(skillsDir.resolve("java").resolve("SKILL.md")).exists();
        assertThat(skillsDir.resolve("personal").resolve("SKILL.md")).exists();
        assertThat(skillsDir.resolve(".sync-manifest.json")).exists();
        assertThat(service.getUserSkillNames(7L)).containsExactly("personal");
        assertThat(service.getUserSkillDocuments(7L)).extracting(SkillDocument::getName).containsExactly("personal");

        Agent changed = agent(3L, "[]");
        assertThat(service.getRemovedSkillNames(changed, null, 11L)).contains("java", "personal");
        service.syncToSession(changed, 7L, 11L);
        assertThat(skillsDir.resolve("java")).doesNotExist();
        assertThat(skillsDir.resolve("personal")).exists();
    }

    @Test
    void writeSyncZipIncludesSkillsAndManifest() throws Exception {
        Path systemRoot = tempDir.resolve("system-skills");
        Path userRoot = tempDir.resolve("user-skills");
        Path runtimeRoot = tempDir.resolve("runtime");
        writeSkill(systemRoot.resolve("java"), "java", "Java", "system");
        Files.createDirectories(systemRoot.resolve("java").resolve(".hidden"));
        Files.writeString(systemRoot.resolve("java").resolve(".hidden").resolve("secret"), "skip");
        Files.writeString(systemRoot.resolve("java").resolve("notes.txt"), "include");

        SkillSyncService service = service(loader(systemRoot), userRoot, runtimeRoot);
        ByteArrayOutputStream out = new ByteArrayOutputStream();

        service.writeSyncZip(agent(3L, "[\"java\"]"), 11L, out, 7L);

        assertThat(zipEntries(out.toByteArray()))
                .contains("java/SKILL.md", "java/notes.txt", ".sync-manifest.json")
                .doesNotContain("java/.hidden/secret");
    }

    @Test
    void nullInputsReturnEmptyRemovedAndSkipCloudSync() {
        SkillSyncService service = service(loader(tempDir.resolve("system")), tempDir.resolve("users"), tempDir.resolve("runtime"));

        service.syncToSession(agent(1L, null), null, 2L);

        assertThat(service.getRemovedSkillNames(null, 1L, 2L)).isEmpty();
        assertThat(service.getRemovedSkillNames(agent(1L, null), 1L, null)).isEmpty();
        assertThat(service.getUserSkillNames(null)).isEmpty();
    }

    private SkillLoader loader(Path skillsRoot) {
        SkillLoader loader = new SkillLoader(new PathSandbox(tempDir.resolve("workspace").toString()));
        ReflectionTestUtils.setField(loader, "skillsDir", skillsRoot.toString());
        ReflectionTestUtils.setField(loader, "cacheSeconds", 0);
        return loader;
    }

    private SkillSyncService service(SkillLoader loader, Path userRoot, Path runtimeRoot) {
        SkillSyncService service = new SkillSyncService(
                loader,
                new PathSandbox(tempDir.resolve("workspace").toString()),
                new RuntimeDataResolver(runtimeRoot.toString()),
                new ObjectMapper());
        ReflectionTestUtils.setField(service, "userSkillsDir", userRoot.toString());
        return service;
    }

    private static Agent agent(Long id, String skillNames) {
        Agent agent = new Agent();
        agent.setId(id);
        agent.setSkillNames(skillNames);
        return agent;
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

    private static List<String> zipEntries(byte[] bytes) throws Exception {
        try (ZipInputStream zis = new ZipInputStream(new java.io.ByteArrayInputStream(bytes))) {
            java.util.ArrayList<String> names = new java.util.ArrayList<>();
            java.util.zip.ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                names.add(entry.getName());
            }
            return names;
        }
    }
}
