package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.skill.LocalSkillRef;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class HarnessServiceLocalSkillMergeTest {

    @Test
    void localOnlySkillIsMarkedUnsyncedEvenWhenNameWasInAgentConfigList() {
        // agent.skillNames 含 bigdata-cli，但服务端 skillLoader 无文件 → 不在 syncableNames
        List<String> merged = new ArrayList<>();
        Set<String> syncable = new HashSet<>(); // empty: not deliverable via sync zip
        LocalSkillRef local = ref("bigdata-cli", "BigData CLI", "bigdata-cli");
        AgentExecutionContext context = new AgentExecutionContext();

        HarnessService.mergeLocalUnsyncedSkills(merged, syncable, List.of(local), context);

        assertThat(merged).containsExactly("bigdata-cli");
        assertThat(context.getLocalUnsyncedSkills()).extracting(LocalSkillRef::getName)
                .containsExactly("bigdata-cli");
    }

    @Test
    void syncableSkillKeepsRuntimePathAndIsNotMarkedUnsynced() {
        List<String> merged = new ArrayList<>(List.of("bigdata-cli"));
        Set<String> syncable = new HashSet<>(List.of("bigdata-cli"));
        LocalSkillRef local = ref("bigdata-cli", "local copy", "bigdata-cli");
        AgentExecutionContext context = new AgentExecutionContext();

        HarnessService.mergeLocalUnsyncedSkills(merged, syncable, List.of(local), context);

        assertThat(merged).containsExactly("bigdata-cli");
        assertThat(context.getLocalUnsyncedSkills()).isEmpty();
    }

    @Test
    void pureLocalSkillIsAddedAndMarkedUnsynced() {
        List<String> merged = new ArrayList<>(List.of("xlsx"));
        Set<String> syncable = new HashSet<>(List.of("xlsx"));
        LocalSkillRef local = ref("my-local", "only on desktop", "my-local-folder");
        AgentExecutionContext context = new AgentExecutionContext();

        HarnessService.mergeLocalUnsyncedSkills(merged, syncable, List.of(local), context);

        assertThat(merged).containsExactly("xlsx", "my-local");
        assertThat(context.getLocalUnsyncedSkills()).extracting(LocalSkillRef::getFolderName)
                .containsExactly("my-local-folder");
    }

    private static LocalSkillRef ref(String name, String description, String folderName) {
        LocalSkillRef ref = new LocalSkillRef();
        ref.setName(name);
        ref.setDescription(description);
        ref.setFolderName(folderName);
        return ref;
    }
}
