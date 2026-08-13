package cn.etarch.mao.session.service;

import cn.etarch.mao.session.entity.SessionCompactionEvent;
import cn.etarch.mao.session.mapper.SessionCompactionEventMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class SessionCompactionEventService {

    private final SessionCompactionEventMapper eventMapper;

    public SessionCompactionEvent record(Long sessionId,
                                         String triggerMode,
                                         long prevBoundaryMsgId,
                                         long boundaryMsgId,
                                         int compactedMessageCount,
                                         Integer promptTokens,
                                         Integer cachedTokens,
                                         Integer completionTokens,
                                         int summaryTokens,
                                         int savedTokens,
                                         long durationMs,
                                         String compactModel) {
        SessionCompactionEvent event = new SessionCompactionEvent();
        event.setSessionId(sessionId);
        event.setTriggerMode(triggerMode);
        event.setPrevBoundaryMsgId(prevBoundaryMsgId);
        event.setBoundaryMsgId(boundaryMsgId);
        event.setCompactedMessageCount(compactedMessageCount);
        event.setPromptTokens(promptTokens);
        event.setCachedTokens(cachedTokens);
        event.setCompletionTokens(completionTokens);
        event.setSummaryTokens(summaryTokens);
        event.setSavedTokens(savedTokens);
        event.setDurationMs(durationMs);
        event.setCompactModel(compactModel);
        eventMapper.insert(event);
        return event;
    }

    public List<SessionCompactionEvent> listBySessionId(Long sessionId) {
        return eventMapper.selectBySessionId(sessionId);
    }

    public int deleteBySessionId(Long sessionId) {
        return eventMapper.deleteBySessionId(sessionId);
    }
}
