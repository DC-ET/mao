package cn.etarch.mao.harness.skill;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class LocalSkillRegistryTest {

    private final LocalSkillRegistry registry = new LocalSkillRegistry();

    @Test
    void reportAndGetRoundTrips() {
        LocalSkillRef ref = new LocalSkillRef();
        ref.setName("my-skill");
        ref.setDescription("desc");
        ref.setFolderName("my-skill-folder");

        registry.report(11L, List.of(ref));

        List<LocalSkillRef> result = registry.get(11L);
        assertThat(result).hasSize(1);
        assertThat(result.get(0).getName()).isEqualTo("my-skill");
        assertThat(result.get(0).getFolderName()).isEqualTo("my-skill-folder");
    }

    @Test
    void getReturnsEmptyForUnknownSession() {
        assertThat(registry.get(999L)).isEmpty();
        assertThat(registry.get(null)).isEmpty();
    }

    @Test
    void reportIgnoresUnsafeFolderNames() {
        LocalSkillRef traversal = new LocalSkillRef();
        traversal.setName("evil");
        traversal.setFolderName("../../etc");

        LocalSkillRef hidden = new LocalSkillRef();
        hidden.setName("hidden");
        hidden.setFolderName(".git");

        LocalSkillRef valid = new LocalSkillRef();
        valid.setName("ok");
        valid.setFolderName("ok-folder");

        registry.report(1L, List.of(traversal, hidden, valid));

        List<LocalSkillRef> result = registry.get(1L);
        assertThat(result).extracting(LocalSkillRef::getName).containsExactly("ok");
    }

    @Test
    void reportEmptyListClearsPreviousReport() {
        LocalSkillRef ref = new LocalSkillRef();
        ref.setName("a");
        ref.setFolderName("a");
        registry.report(5L, List.of(ref));
        assertThat(registry.get(5L)).hasSize(1);

        registry.report(5L, List.of());
        assertThat(registry.get(5L)).isEmpty();
    }

    @Test
    void clearRemovesReportedSkills() {
        LocalSkillRef ref = new LocalSkillRef();
        ref.setName("a");
        ref.setFolderName("a");
        registry.report(5L, List.of(ref));

        registry.clear(5L);

        assertThat(registry.get(5L)).isEmpty();
    }
}
