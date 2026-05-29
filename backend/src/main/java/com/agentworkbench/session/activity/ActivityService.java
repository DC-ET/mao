package com.agentworkbench.session.activity;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class ActivityService {

    private final SessionActivityMapper activityMapper;

    public SessionActivity record(Long sessionId, String type, String target, String summary) {
        return record(sessionId, type, target, summary, null, null, null);
    }

    private static final int MAX_TARGET_LENGTH = 2048;
    private static final int MAX_SUMMARY_LENGTH = 512;

    public SessionActivity record(Long sessionId, String type, String target, String summary,
                                   String detailJson, String status, Integer durationMs) {
        SessionActivity activity = new SessionActivity();
        activity.setSessionId(sessionId);
        activity.setType(type);
        activity.setTarget(truncate(target, MAX_TARGET_LENGTH));
        activity.setSummary(truncate(summary, MAX_SUMMARY_LENGTH));
        activity.setDetailJson(detailJson);
        activity.setStatus(status != null ? status : "SUCCESS");
        activity.setDurationMs(durationMs);
        activityMapper.insert(activity);
        return activity;
    }

    public List<SessionActivity> listBySession(Long sessionId, int limit) {
        return activityMapper.selectList(
                new QueryWrapper<SessionActivity>()
                        .eq("session_id", sessionId)
                        .orderByDesc("created_at")
                        .last("LIMIT " + limit));
    }

    public List<SessionActivity> listBySession(Long sessionId) {
        return listBySession(sessionId, 50);
    }

    private static String truncate(String s, int max) {
        if (s == null) return null;
        return s.length() <= max ? s : s.substring(0, max);
    }
}
