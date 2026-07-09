package cn.etarch.mao.agent.service;

import cn.etarch.mao.agent.entity.AgentExperience;
import cn.etarch.mao.agent.mapper.AgentExperienceMapper;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SuppressWarnings("unchecked")
class AgentExperienceServiceTest {

    private final AgentExperienceMapper mapper = mock(AgentExperienceMapper.class);
    private final AgentExperienceService service = new AgentExperienceService(mapper);

    @Test
    void rejectsBlankOrTooLongContent() {
        assertThatThrownBy(() -> service.normalizeAndValidateContent("  "))
                .isInstanceOf(BusinessException.class)
                .extracting(e -> ((BusinessException) e).getCode())
                .isEqualTo(ErrorCode.AGENT_EXPERIENCE_CONTENT_INVALID.getCode());

        String tooLong = "a".repeat(301);
        assertThatThrownBy(() -> service.normalizeAndValidateContent(tooLong))
                .isInstanceOf(BusinessException.class);
    }

    @Test
    void listEnabledContentsReturnsOnlyEnabledInOrder() {
        AgentExperience a = experience(1L, 10L, "first", 0, 1);
        AgentExperience b = experience(2L, 10L, "disabled", 1, 0);
        AgentExperience c = experience(3L, 10L, "second", 2, 1);
        when(mapper.selectList(any(QueryWrapper.class))).thenReturn(List.of(a, c));

        assertThat(service.listEnabledContents(10L)).containsExactly("first", "second");
        assertThat(b.getContent()).isEqualTo("disabled");
    }

    @Test
    void syncExperiencesUpdatesInsertsAndDeletes() {
        AgentExperience existingKeep = experience(1L, 5L, "old", 0, 1);
        AgentExperience existingDrop = experience(2L, 5L, "drop", 1, 1);
        when(mapper.selectList(any(QueryWrapper.class)))
                .thenReturn(new ArrayList<>(List.of(existingKeep, existingDrop)));
        when(mapper.selectById(1L)).thenReturn(existingKeep);
        when(mapper.insert(any(AgentExperience.class))).thenAnswer(invocation -> {
            AgentExperience exp = invocation.getArgument(0);
            exp.setId(99L);
            return 1;
        });

        List<AgentExperienceService.ExperienceInput> inputs = List.of(
                AgentExperienceService.ExperienceInput.of(1L, "updated", 0, true),
                AgentExperienceService.ExperienceInput.of(null, "new one", 1, false)
        );
        service.syncExperiences(5L, inputs);

        assertThat(existingKeep.getContent()).isEqualTo("updated");
        verify(mapper).updateById(existingKeep);
        ArgumentCaptor<AgentExperience> insertCaptor = ArgumentCaptor.forClass(AgentExperience.class);
        verify(mapper).insert(insertCaptor.capture());
        assertThat(insertCaptor.getValue().getContent()).isEqualTo("new one");
        assertThat(insertCaptor.getValue().getEnabled()).isEqualTo(0);
        verify(mapper).deleteById(2L);
    }

    @Test
    void syncExperiencesNullDoesNothing() {
        service.syncExperiences(5L, null);
        verify(mapper, never()).selectList(any());
        verify(mapper, never()).insert(any());
        verify(mapper, never()).deleteById(any(Long.class));
    }

    @Test
    void syncExperiencesEmptyClearsAll() {
        AgentExperience existing = experience(1L, 5L, "old", 0, 1);
        when(mapper.selectList(any(QueryWrapper.class))).thenReturn(List.of(existing));

        service.syncExperiences(5L, List.of());

        verify(mapper, times(1)).deleteById(1L);
        verify(mapper, never()).insert(any());
    }

    @Test
    void createAndUpdateAndDelete() {
        when(mapper.insert(any(AgentExperience.class))).thenAnswer(invocation -> {
            AgentExperience exp = invocation.getArgument(0);
            exp.setId(7L);
            return 1;
        });
        AgentExperience created = service.create(3L, "  tip  ", 2, null);
        assertThat(created.getContent()).isEqualTo("tip");
        assertThat(created.getEnabled()).isEqualTo(1);

        AgentExperience existing = experience(7L, 3L, "tip", 2, 1);
        when(mapper.selectById(7L)).thenReturn(existing);
        AgentExperience updated = service.update(3L, 7L, "new tip", 0, false);
        assertThat(updated.getContent()).isEqualTo("new tip");
        assertThat(updated.getEnabled()).isEqualTo(0);

        service.delete(3L, 7L);
        verify(mapper).deleteById(7L);
    }

    @Test
    void getExperienceThrowsWhenWrongAgent() {
        AgentExperience other = experience(1L, 99L, "x", 0, 1);
        when(mapper.selectById(1L)).thenReturn(other);
        assertThatThrownBy(() -> service.getExperience(3L, 1L))
                .isInstanceOf(BusinessException.class)
                .extracting(e -> ((BusinessException) e).getCode())
                .isEqualTo(ErrorCode.AGENT_EXPERIENCE_NOT_FOUND.getCode());
    }

    private static AgentExperience experience(Long id, Long agentId, String content,
                                               int sortOrder, int enabled) {
        AgentExperience e = new AgentExperience();
        e.setId(id);
        e.setAgentId(agentId);
        e.setContent(content);
        e.setSortOrder(sortOrder);
        e.setEnabled(enabled);
        return e;
    }
}
