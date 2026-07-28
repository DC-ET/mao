package cn.etarch.mao.session.service;

import cn.etarch.mao.session.entity.SessionCompaction;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionCompactionMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Objects;

@Slf4j
@Service
@RequiredArgsConstructor
public class SessionCompactionService {

    private final SessionCompactionMapper compactionMapper;
    private final MessageMapper messageMapper;
    private final SessionMapper sessionMapper;

    public SessionCompaction findBySessionId(Long sessionId) {
        return compactionMapper.selectBySessionId(sessionId);
    }

    /**
     * Returns the current record only when its physical message boundary is valid.
     * Invalid records are removed with a conditional delete so a concurrent update is not erased.
     */
    public SessionCompaction loadValidated(Long sessionId) {
        for (int attempt = 0; attempt < 2; attempt++) {
            SessionCompaction record = findBySessionId(sessionId);
            if (record == null) {
                return null;
            }
            long boundary = boundaryOf(record);
            boolean hasSummary = record.getSummaryText() != null && !record.getSummaryText().isBlank();
            boolean valid = boundary == 0
                    ? !hasSummary
                    : hasSummary && messageMapper.selectValidBoundaryMessage(sessionId, boundary) != null;
            if (valid) {
                return record;
            }

            log.warn("Invalid session compaction boundary: sessionId={}, compactionId={}, boundary={}; deleting record",
                    sessionId, record.getId(), boundary);
            if (compactionMapper.deleteIfBoundaryMatches(record.getId(), sessionId, boundary) > 0) {
                return null;
            }
        }

        log.warn("Session compaction boundary changed repeatedly during validation: sessionId={}", sessionId);
        return null;
    }

    @Transactional
    public boolean persist(Long sessionId,
                           SessionCompaction expectedRecord,
                           long expectedOldBoundary,
                           long newBoundary,
                           String boundaryContentSnapshot,
                           String summaryText,
                           long inputTokens,
                           long outputTokens,
                           String compactModel) {
        if (newBoundary <= expectedOldBoundary) {
            throw new IllegalArgumentException("Compaction boundary must advance");
        }
        if (sessionMapper.lockActiveSessionById(sessionId) == null) {
            return false;
        }
        var currentBoundaryMessage = messageMapper.selectValidBoundaryMessage(sessionId, newBoundary);
        if (summaryText == null || summaryText.isBlank() || currentBoundaryMessage == null) {
            return false;
        }
        if (!Objects.equals(currentBoundaryMessage.getContent(), boundaryContentSnapshot)) {
            log.info("Session compaction candidate changed before persistence: sessionId={}, candidateBoundary={}",
                    sessionId, newBoundary);
            return false;
        }

        if (expectedRecord != null) {
            if (expectedRecord.getId() == null) {
                return false;
            }
            return compactionMapper.updateWithBoundaryCas(
                    expectedRecord.getId(), sessionId, expectedOldBoundary, newBoundary, summaryText,
                    inputTokens, outputTokens, compactModel) == 1;
        }

        SessionCompaction record = new SessionCompaction();
        record.setSessionId(sessionId);
        record.setSummaryText(summaryText);
        record.setLastCompactedMsgId(newBoundary);
        record.setCompactCount(1);
        record.setInputTokens(inputTokens);
        record.setOutputTokens(outputTokens);
        record.setCompactModel(compactModel);
        try {
            return compactionMapper.insert(record) == 1;
        } catch (DuplicateKeyException e) {
            log.info("Session compaction insert conflict: sessionId={}, candidateBoundary={}",
                    sessionId, newBoundary);
            return false;
        }
    }

    public int deleteBySessionId(Long sessionId) {
        return compactionMapper.deleteBySessionId(sessionId);
    }

    public long boundaryOf(SessionCompaction record) {
        return record == null || record.getLastCompactedMsgId() == null
                ? 0L : record.getLastCompactedMsgId();
    }
}
