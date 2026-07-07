package cn.etarch.mao.skill.controller;

import cn.etarch.mao.common.result.Result;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class UserSkillControllerTest {

    @TempDir
    Path tempDir;

    @Test
    void listsReadsUploadsAndDeletesUserSkills() throws Exception {
        UserSkillController controller = controller();
        writeSkill(tempDir.resolve("7").resolve("existing"), "existing", "Existing", "Body");

        Result<List<UserSkillController.SkillDocVO>> list = controller.listUserSkills(7L);
        assertThat(list.getCode()).isZero();
        assertThat(list.getData()).extracting(UserSkillController.SkillDocVO::getName).containsExactly("existing");

        Result<UserSkillController.SkillDocDetailVO> detail = controller.getUserSkill(7L, "existing");
        assertThat(detail.getCode()).isZero();
        assertThat(detail.getData().getBody()).isEqualTo("Body");

        MockMultipartFile skillMd = new MockMultipartFile("files", "new/SKILL.md", "text/markdown",
                skill("new", "New", "New body").getBytes(StandardCharsets.UTF_8));
        MockMultipartFile extra = new MockMultipartFile("files", "new/ref/info.txt", "text/plain", "info".getBytes());
        MockMultipartFile hidden = new MockMultipartFile("files", "new/.secret", "text/plain", "skip".getBytes());
        MockMultipartFile nestedHidden = new MockMultipartFile("files", "new/ref/.secret", "text/plain", "skip".getBytes());
        Result<List<String>> uploaded = controller.uploadUserSkill(7L, List.of(skillMd, extra, hidden, nestedHidden));

        assertThat(uploaded.getCode()).isZero();
        assertThat(uploaded.getData()).containsExactly("new");
        assertThat(tempDir.resolve("7").resolve("new").resolve("SKILL.md")).exists();
        assertThat(tempDir.resolve("7").resolve("new").resolve("ref").resolve("info.txt")).exists();
        assertThat(tempDir.resolve("7").resolve("new").resolve(".secret")).exists();
        assertThat(tempDir.resolve("7").resolve("new").resolve("ref").resolve(".secret")).doesNotExist();

        Result<Void> deleted = controller.deleteUserSkill(7L, "new");
        assertThat(deleted.getCode()).isZero();
        assertThat(tempDir.resolve("7").resolve("new")).doesNotExist();
    }

    @Test
    void returnsFailuresForInvalidUploadReadAndDeleteRequests() throws Exception {
        UserSkillController controller = controller();

        assertThat(controller.listUserSkills(7L).getData()).isEmpty();
        assertThat(controller.getUserSkill(7L, "missing").getCode()).isEqualTo(404);
        assertThat(controller.deleteUserSkill(7L, "missing").getCode()).isEqualTo(404);
        assertThat(controller.uploadUserSkill(7L, null).getCode()).isEqualTo(400);
        assertThat(controller.uploadUserSkill(7L, List.of()).getCode()).isEqualTo(400);

        MockMultipartFile rootFile = new MockMultipartFile("files", "SKILL.md", "text/markdown", "x".getBytes());
        assertThat(controller.uploadUserSkill(7L, List.of(rootFile)).getCode()).isEqualTo(400);

        MockMultipartFile noSkillMd = new MockMultipartFile("files", "bad/readme.md", "text/markdown", "x".getBytes());
        assertThat(controller.uploadUserSkill(7L, List.of(noSkillMd)).getMessage()).contains("missing SKILL.md");

        MockMultipartFile invalidMd = new MockMultipartFile("files", "bad/SKILL.md", "text/markdown", "no yaml".getBytes());
        assertThat(controller.uploadUserSkill(7L, List.of(invalidMd)).getMessage()).contains("frontmatter");

        MockMultipartFile missingDescription = new MockMultipartFile("files", "bad/SKILL.md", "text/markdown",
                """
                ---
                name: bad
                ---
                body
                """.getBytes(StandardCharsets.UTF_8));
        assertThat(controller.uploadUserSkill(7L, List.of(missingDescription)).getMessage()).contains("description");
    }

    private UserSkillController controller() {
        UserSkillController controller = new UserSkillController();
        ReflectionTestUtils.setField(controller, "userSkillsDir", tempDir.toString());
        return controller;
    }

    private static void writeSkill(Path folder, String name, String description, String body) throws Exception {
        Files.createDirectories(folder);
        Files.writeString(folder.resolve("SKILL.md"), skill(name, description, body));
    }

    private static String skill(String name, String description, String body) {
        return """
                ---
                name: %s
                description: %s
                ---
                %s
                """.formatted(name, description, body);
    }
}
