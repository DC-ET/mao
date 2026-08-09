package cn.etarch.mao.session.service;

import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.agent.service.AgentService;
import cn.etarch.mao.command.service.UserCommandService;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.harness.core.EnvironmentInfoProvider;
import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.FileChangeMapper;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SessionServiceArchiveTest {

    @BeforeAll
    static void initTableInfo() {
        // LambdaUpdateWrapper 解析列名需要 TableInfo（与 MessageQueueServiceTest 一致）
        TableInfoHelper.initTableInfo(new MapperBuilderAssistant(new MybatisConfiguration(), ""), Session.class);
    }

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
    @Mock private SessionCompactionEventService sessionCompactionEventService;

    @InjectMocks private SessionService sessionService;

    private Session archivedSession(long id) {
        Session s = new Session();
        s.setId(id);
        s.setUserId(7L);
        s.setStatus("ARCHIVED");
        return s;
    }

    @Test
    void unarchiveSessionSetsStatusActive() {
        Session s = archivedSession(10L);
        when(sessionMapper.selectById(10L)).thenReturn(s);

        sessionService.unarchiveSession(10L);

        assertThat(s.getStatus()).isEqualTo("ACTIVE");
        verify(sessionMapper).updateById(s);
    }

    @Test
    void unarchiveSessionThrowsWhenNotFound() {
        when(sessionMapper.selectById(99L)).thenReturn(null);

        assertThatThrownBy(() -> sessionService.unarchiveSession(99L))
                .isInstanceOf(BusinessException.class);
    }

    @Test
    void restoreRunningAfterApprovalIssuesConditionalUpdateAndReturnsTrue() {
        when(sessionMapper.update(isNull(), any(LambdaUpdateWrapper.class))).thenReturn(1);

        boolean restored = sessionService.restoreRunningAfterApproval(10L);

        assertThat(restored).isTrue();
    }

    @Test
    void restoreRunningAfterApprovalReturnsFalseWhenConditionalUpdateMisses() {
        // 条件更新命中 0 行：会话已不是 WAITING_APPROVAL（如已进入终态）→ 不覆盖
        when(sessionMapper.update(isNull(), any(LambdaUpdateWrapper.class))).thenReturn(0);

        boolean restored = sessionService.restoreRunningAfterApproval(10L);

        assertThat(restored).isFalse();
    }

    @Test
    void listSideTasksByParentIdsQueriesValidSideTasks() {
        Session side = new Session();
        side.setId(20L);
        side.setParentSessionId(10L);
        side.setSessionType("SIDE_TASK");
        when(sessionMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(side));

        List<Session> sides = sessionService.listSideTasksByParentIds(List.of(10L, 11L));

        assertThat(sides).hasSize(1);
        assertThat(sides.get(0).getParentSessionId()).isEqualTo(10L);
    }

    @Test
    void listSideTasksByParentIdsReturnsEmptyForNullInput() {
        assertThat(sessionService.listSideTasksByParentIds(null)).isEmpty();
        assertThat(sessionService.listSideTasksByParentIds(List.of())).isEmpty();
    }
}
