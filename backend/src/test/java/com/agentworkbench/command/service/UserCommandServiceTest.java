package com.agentworkbench.command.service;

import com.agentworkbench.command.entity.UserCommand;
import com.agentworkbench.command.mapper.UserCommandMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class UserCommandServiceTest {

    private final UserCommandMapper mapper = mock(UserCommandMapper.class);
    private final UserCommandService service = new UserCommandService(mapper);

    @Test
    void listAvailableMergesSystemAndPersonalCommandsByName() {
        UserCommand system = command(1L, 0L, "build", "system");
        UserCommand personalOverride = command(2L, 7L, "build", "personal");
        UserCommand personalOnly = command(3L, 7L, "test", "run");
        when(mapper.selectList(any(QueryWrapper.class)))
                .thenReturn(List.of(system))
                .thenReturn(List.of(personalOverride, personalOnly));

        List<UserCommand> result = service.listAvailableForUser(7L);

        assertThat(result).extracting(UserCommand::getContent).containsExactly("personal", "run");
    }

    @Test
    void lookupMethodsDelegateAndPreferPersonalCommandByName() {
        UserCommand personal = command(10L, 7L, "fix", "personal");
        when(mapper.selectOne(any(QueryWrapper.class))).thenReturn(personal);

        assertThat(service.getByIdAndUserId(10L, 7L)).isSameAs(personal);
        assertThat(service.getByUserIdAndName(7L, "fix")).isSameAs(personal);
        assertThat(service.isSystemCommand(command(1L, 0L, "sys", "c"))).isTrue();
        assertThat(service.isSystemCommand(null)).isFalse();
    }

    @Test
    void createValidatesNameAndRejectsDuplicates() {
        when(mapper.selectOne(any(QueryWrapper.class))).thenReturn(null);
        UserCommand created = service.create(7L, "修复_build-1", "content");

        assertThat(created.getUserId()).isEqualTo(7L);
        assertThat(created.getName()).isEqualTo("修复_build-1");
        verify(mapper).insert(created);

        assertThatThrownBy(() -> service.create(7L, "bad name", "content"))
                .isInstanceOf(BusinessException.class);

        when(mapper.selectOne(any(QueryWrapper.class))).thenReturn(command(1L, 0L, "dup", "system"));
        assertThatThrownBy(() -> service.create(7L, "dup", "content"))
                .isInstanceOf(BusinessException.class);
    }

    @Test
    void updateRejectsMissingSystemOrDuplicateAndUpdatesNormalCommand() {
        when(mapper.selectOne(any(QueryWrapper.class))).thenReturn(null);
        assertThatThrownBy(() -> service.update(7L, 1L, "new", "content"))
                .isInstanceOf(BusinessException.class);

        when(mapper.selectOne(any(QueryWrapper.class))).thenReturn(command(1L, 0L, "sys", "content"));
        assertThatThrownBy(() -> service.update(0L, 1L, "new", "content"))
                .isInstanceOf(BusinessException.class);

        UserCommand current = command(2L, 7L, "old", "old content");
        when(mapper.selectOne(any(QueryWrapper.class)))
                .thenReturn(current)
                .thenReturn(null);
        UserCommand updated = service.update(7L, 2L, "new", "new content");

        assertThat(updated.getName()).isEqualTo("new");
        assertThat(updated.getContent()).isEqualTo("new content");
        verify(mapper).updateById(current);
    }

    @Test
    void deleteRejectsMissingOrSystemAndDeletesNormalCommand() {
        when(mapper.selectOne(any(QueryWrapper.class))).thenReturn(null);
        assertThatThrownBy(() -> service.delete(7L, 1L))
                .isInstanceOf(BusinessException.class);

        when(mapper.selectOne(any(QueryWrapper.class))).thenReturn(command(1L, 0L, "sys", "content"));
        assertThatThrownBy(() -> service.delete(0L, 1L))
                .isInstanceOf(BusinessException.class);

        when(mapper.selectOne(any(QueryWrapper.class))).thenReturn(command(2L, 7L, "own", "content"));
        service.delete(7L, 2L);

        verify(mapper).deleteById(2L);
    }

    private static UserCommand command(Long id, Long userId, String name, String content) {
        UserCommand command = new UserCommand();
        command.setId(id);
        command.setUserId(userId);
        command.setName(name);
        command.setContent(content);
        return command;
    }
}
