package cn.etarch.mao.session.service;

import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.SessionCompaction;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionCompactionMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DuplicateKeyException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SessionCompactionServiceTest {

    private final SessionCompactionMapper compactionMapper = mock(SessionCompactionMapper.class);
    private final MessageMapper messageMapper = mock(MessageMapper.class);
    private final SessionMapper sessionMapper = mock(SessionMapper.class);
    private final SessionCompactionService service =
            new SessionCompactionService(compactionMapper, messageMapper, sessionMapper);

    @Test
    void validatesBoundaryOwnershipAndLogicalDeletion() {
        SessionCompaction record = record(7L, 42L, 100L, "summary");
        Message boundary = new Message();
        boundary.setId(100L);
        boundary.setSessionId(42L);
        when(compactionMapper.selectBySessionId(42L)).thenReturn(record);
        when(messageMapper.selectValidBoundaryMessage(42L, 100L)).thenReturn(boundary);

        assertThat(service.loadValidated(42L)).isSameAs(record);
        verify(compactionMapper, never()).deleteIfBoundaryMatches(any(), any(), any());
    }

    @Test
    void clearsMissingDeletedOrForeignBoundaryRecord() {
        SessionCompaction record = record(7L, 42L, 100L, "summary");
        when(compactionMapper.selectBySessionId(42L)).thenReturn(record);
        when(messageMapper.selectValidBoundaryMessage(42L, 100L)).thenReturn(null);
        when(compactionMapper.deleteIfBoundaryMatches(7L, 42L, 100L)).thenReturn(1);

        assertThat(service.loadValidated(42L)).isNull();
        verify(compactionMapper).deleteIfBoundaryMatches(7L, 42L, 100L);
    }

    @Test
    void clearsBoundaryThatHasNoUsableSummary() {
        SessionCompaction record = record(7L, 42L, 100L, " ");
        when(compactionMapper.selectBySessionId(42L)).thenReturn(record);
        when(compactionMapper.deleteIfBoundaryMatches(7L, 42L, 100L)).thenReturn(1);

        assertThat(service.loadValidated(42L)).isNull();
        verify(messageMapper, never()).selectValidBoundaryMessage(any(), any());
    }

    @Test
    void clearsSummaryWithoutAPositiveBoundary() {
        SessionCompaction record = record(7L, 42L, 0L, "orphan summary");
        when(compactionMapper.selectBySessionId(42L)).thenReturn(record);
        when(compactionMapper.deleteIfBoundaryMatches(7L, 42L, 0L)).thenReturn(1);

        assertThat(service.loadValidated(42L)).isNull();
        verify(messageMapper, never()).selectValidBoundaryMessage(any(), any());
    }

    @Test
    void existingRecordUsesBoundaryCasAndReportsConflict() {
        SessionCompaction record = record(7L, 42L, 100L, "old");
        Message boundary = new Message();
        boundary.setContent("candidate");
        when(sessionMapper.lockActiveSessionById(42L)).thenReturn(42L);
        when(messageMapper.selectValidBoundaryMessage(42L, 150L)).thenReturn(boundary);
        when(compactionMapper.updateWithBoundaryCas(
                7L, 42L, 100L, 150L, "new", 12L, 4L, "gpt-test"))
                .thenReturn(1, 0);

        assertThat(service.persist(42L, record, 100L, 150L, "candidate", "new", 12, 4, "gpt-test"))
                .isTrue();
        assertThat(service.persist(42L, record, 100L, 150L, "candidate", "new", 12, 4, "gpt-test"))
                .isFalse();
    }

    @Test
    void firstInsertConflictDoesNotOverwriteWinner() {
        Message boundary = new Message();
        boundary.setContent("candidate");
        when(sessionMapper.lockActiveSessionById(42L)).thenReturn(42L);
        when(messageMapper.selectValidBoundaryMessage(42L, 150L)).thenReturn(boundary);
        when(compactionMapper.insert(any(SessionCompaction.class)))
                .thenThrow(new DuplicateKeyException("uk_session"));

        assertThat(service.persist(42L, null, 0L, 150L, "candidate", "new", 12, 4, "gpt-test"))
                .isFalse();
        verify(compactionMapper, never()).updateWithBoundaryCas(
                any(), any(), any(), any(), any(), any(Long.class), any(Long.class), any());
    }

    @Test
    void refusesToPersistMissingCandidateBoundary() {
        when(sessionMapper.lockActiveSessionById(42L)).thenReturn(42L);
        when(messageMapper.selectValidBoundaryMessage(42L, 150L)).thenReturn(null);

        assertThat(service.persist(42L, null, 0L, 150L, "candidate", "new", 12, 4, "gpt-test"))
                .isFalse();
        verify(compactionMapper, never()).insert(any());
    }

    @Test
    void refusesStaleSummaryWhenBoundaryMessageWasEditedDuringGeneration() {
        SessionCompaction record = record(7L, 42L, 100L, "old");
        Message editedBoundary = new Message();
        editedBoundary.setContent("edited while compacting");
        when(sessionMapper.lockActiveSessionById(42L)).thenReturn(42L);
        when(messageMapper.selectValidBoundaryMessage(42L, 150L)).thenReturn(editedBoundary);

        assertThat(service.persist(
                42L, record, 100L, 150L, "original snapshot", "new", 12, 4, "gpt-test"))
                .isFalse();
        verify(compactionMapper, never()).updateWithBoundaryCas(
                any(), any(), any(), any(), any(), any(Long.class), any(Long.class), any());
        verify(compactionMapper, never()).insert(any());
    }

    private SessionCompaction record(long id, long sessionId, long boundary, String summary) {
        SessionCompaction record = new SessionCompaction();
        record.setId(id);
        record.setSessionId(sessionId);
        record.setLastCompactedMsgId(boundary);
        record.setSummaryText(summary);
        return record;
    }
}
