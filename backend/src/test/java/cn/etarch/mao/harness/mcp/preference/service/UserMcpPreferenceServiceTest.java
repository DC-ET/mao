package cn.etarch.mao.harness.mcp.preference.service;

import cn.etarch.mao.harness.mcp.preference.entity.UserMcpPreference;
import cn.etarch.mao.harness.mcp.preference.mapper.UserMcpPreferenceMapper;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SuppressWarnings("unchecked")
class UserMcpPreferenceServiceTest {

    private final UserMcpPreferenceMapper mapper = mock(UserMcpPreferenceMapper.class);
    private final UserMcpPreferenceService service = new UserMcpPreferenceService(mapper);

    private UserMcpPreference pref(Long id, Long userId, Long serverId, int enabled) {
        UserMcpPreference row = new UserMcpPreference();
        row.setId(id);
        row.setUserId(userId);
        row.setServerId(serverId);
        row.setEnabled(enabled);
        return row;
    }

    @Test
    void getDisabledServerIdsReturnsOnlyDisabledRows() {
        when(mapper.selectList(any(Wrapper.class))).thenReturn(List.of(
                pref(1L, 9L, 2L, 0),
                pref(2L, 9L, 3L, 0)));
        assertThat(service.getDisabledServerIds(9L)).containsExactly(2L, 3L);
        assertThat(service.getDisabledServerIds(null)).isEmpty();
    }

    @Test
    void saveDisableInsertsNewRowWhenNoneExists() {
        when(mapper.selectOne(any(Wrapper.class))).thenReturn(null);
        service.save(9L, 5L, false);
        verify(mapper).insert(any(UserMcpPreference.class));
    }

    @Test
    void saveDisableUpdatesExistingRow() {
        UserMcpPreference existing = pref(1L, 9L, 5L, 1);
        when(mapper.selectOne(any(Wrapper.class))).thenReturn(existing);
        service.save(9L, 5L, false);
        verify(mapper).updateById(existing);
        assertThat(existing.getEnabled()).isEqualTo(0);
    }

    @Test
    void saveEnableDeletesRowToFollowGlobal() {
        UserMcpPreference existing = pref(1L, 9L, 5L, 0);
        when(mapper.selectOne(any(Wrapper.class))).thenReturn(existing);
        service.save(9L, 5L, true);
        verify(mapper).deleteById(existing);
    }

    @Test
    void saveEnableWithNoRowIsNoop() {
        when(mapper.selectOne(any(Wrapper.class))).thenReturn(null);
        service.save(9L, 5L, true);
        verify(mapper, never()).insert(any());
        verify(mapper, never()).updateById(any());
    }

    @Test
    void saveIgnoresNullArgs() {
        service.save(null, 5L, false);
        service.save(9L, null, false);
        verify(mapper, never()).insert(any());
        verify(mapper, never()).updateById(any());
    }
}
