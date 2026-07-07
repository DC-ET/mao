package cn.etarch.mao.preference.service;

import cn.etarch.mao.preference.entity.UserTaskPanelPreference;
import cn.etarch.mao.preference.mapper.UserTaskPanelPreferenceMapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class UserTaskPanelPreferenceServiceTest {

    private final UserTaskPanelPreferenceMapper mapper = mock(UserTaskPanelPreferenceMapper.class);
    private final UserTaskPanelPreferenceService service = new UserTaskPanelPreferenceService(mapper, new ObjectMapper());

    @Test
    void getReturnsEmptyMissingOrInvalidRowsAndParsesValidRows() {
        when(mapper.selectById(1L)).thenReturn(null);
        assertThat(service.get(1L).groupOrder()).isEmpty();

        UserTaskPanelPreference invalid = new UserTaskPanelPreference();
        invalid.setGroupOrder("not-json");
        invalid.setCollapsedGroups("");
        when(mapper.selectById(2L)).thenReturn(invalid);
        assertThat(service.get(2L).groupOrder()).isEmpty();

        UserTaskPanelPreference row = new UserTaskPanelPreference();
        row.setGroupOrder("[\"a\",\"b\"]");
        row.setCollapsedGroups("[\"x\"]");
        when(mapper.selectById(3L)).thenReturn(row);
        assertThat(service.get(3L).groupOrder()).containsExactly("a", "b");
        assertThat(service.get(3L).collapsedGroups()).containsExactly("x");
    }

    @Test
    void saveNormalizesAndInsertsOrUpdatesRows() {
        UserTaskPanelPreferenceService.TaskPanelPreferenceState state =
                new UserTaskPanelPreferenceService.TaskPanelPreferenceState(
                        java.util.Arrays.asList(" a ", null, "", "a", "b"),
                        java.util.Arrays.asList("x", " x ", "y"));

        UserTaskPanelPreferenceService.TaskPanelPreferenceState inserted = service.save(7L, state);
        assertThat(inserted.groupOrder()).containsExactly("a", "b");
        assertThat(inserted.collapsedGroups()).containsExactly("x", "y");
        verify(mapper).insert(org.mockito.ArgumentMatchers.any(UserTaskPanelPreference.class));

        UserTaskPanelPreference existing = new UserTaskPanelPreference();
        existing.setUserId(7L);
        when(mapper.selectById(7L)).thenReturn(existing);
        UserTaskPanelPreferenceService.TaskPanelPreferenceState updated =
                service.save(7L, new UserTaskPanelPreferenceService.TaskPanelPreferenceState(null, List.of()));
        assertThat(updated.groupOrder()).isEmpty();
        verify(mapper).updateById(existing);
    }
}
