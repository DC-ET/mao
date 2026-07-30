package cn.etarch.mao.session.service;

import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.agent.service.AgentService;
import cn.etarch.mao.command.service.UserCommandService;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.harness.core.EnvironmentInfoProvider;
import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.SessionCompaction;
import cn.etarch.mao.session.mapper.FileChangeMapper;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SessionServiceCompactionTest {

    @Mock private SessionMapper sessionMapper;
    @Mock private MessageMapper messageMapper;
    @Mock private FileChangeMapper fileChangeMapper;
    @Mock private AgentMapper agentMapper;
    @Mock private AgentService agentService;
    @Mock private PathSandbox pathSandbox;
    @Mock private ObjectMapper objectMapper;
    @Mock private EnvironmentInfoProvider environmentInfoProvider;
    @Mock private UserCommandService userCommandService;
    @Mock private GitOperationService gitOperationService;
    @Mock private SessionCompactionService sessionCompactionService;

    @InjectMocks private SessionService sessionService;

    @Test
    void incrementalHistoryDelegatesToStrictBoundaryQuery() {
        Message message = message(101L, 9L, "USER", "new");
        when(messageMapper.selectMessagesAfterId(9L, 100L)).thenReturn(List.of(message));

        assertThat(sessionService.getMessagesAfterId(9L, 100L)).containsExactly(message);
        verify(messageMapper).selectMessagesAfterId(9L, 100L);
        verify(messageMapper, never()).selectList(any());
    }

    @SuppressWarnings("unchecked")
    @Test
    void rejectsEditingCoveredMessageWithoutPartialMutation() {
        Message target = message(90L, 9L, "USER", "original");
        SessionCompaction record = new SessionCompaction();
        record.setLastCompactedMsgId(100L);
        when(messageMapper.selectById(90L)).thenReturn(target);
        when(sessionMapper.lockActiveSessionById(9L)).thenReturn(9L);
        when(sessionCompactionService.loadValidated(9L)).thenReturn(record);
        when(sessionCompactionService.boundaryOf(record)).thenReturn(100L);

        assertThatThrownBy(() -> sessionService.editMessageAndTruncate(90L, "edited", List.of()))
                .isInstanceOfSatisfying(BusinessException.class, error -> {
                    assertThat(error.getCode()).isEqualTo(ErrorCode.MESSAGE_ALREADY_COMPACTED.getCode());
                    assertThat(error.getMessage()).isEqualTo("该消息已进入会话摘要，无法编辑");
                });

        assertThat(target.getContent()).isEqualTo("original");
        verify(messageMapper, never()).updateById(any());
        verify(messageMapper, never()).delete(any(Wrapper.class));
    }

    @SuppressWarnings("unchecked")
    @Test
    void allowsEditingMessageAfterBoundaryAndTruncatesFollowingRows() {
        Message target = message(110L, 9L, "USER", "original");
        SessionCompaction record = new SessionCompaction();
        when(messageMapper.selectById(110L)).thenReturn(target);
        when(sessionMapper.lockActiveSessionById(9L)).thenReturn(9L);
        when(sessionCompactionService.loadValidated(9L)).thenReturn(record);
        when(sessionCompactionService.boundaryOf(record)).thenReturn(100L);

        Message edited = sessionService.editMessageAndTruncate(110L, "edited", List.of());

        assertThat(edited.getContent()).isEqualTo("edited");
        verify(messageMapper).updateById(target);
        verify(messageMapper).delete(any(Wrapper.class));
    }

    @SuppressWarnings("unchecked")
    @Test
    void deletingSessionPhysicallyRemovesCompactionFirst() {
        when(sessionMapper.lockActiveSessionById(9L)).thenReturn(9L);
        sessionService.deleteSession(9L);

        InOrder order = inOrder(sessionCompactionService, messageMapper, sessionMapper);
        order.verify(sessionMapper).lockActiveSessionById(9L);
        order.verify(sessionCompactionService).deleteBySessionId(9L);
        order.verify(messageMapper).delete(any(Wrapper.class));
        order.verify(sessionMapper).deleteById(9L);
    }

    private Message message(long id, long sessionId, String role, String content) {
        Message message = new Message();
        message.setId(id);
        message.setSessionId(sessionId);
        message.setRole(role);
        message.setContent(content);
        return message;
    }
}
