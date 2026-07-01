package com.agentworkbench.preference.service;

import com.agentworkbench.preference.entity.UserTaskPanelPreference;
import com.agentworkbench.preference.mapper.UserTaskPanelPreferenceMapper;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
public class UserTaskPanelPreferenceService {

    private static final TypeReference<List<String>> STRING_LIST = new TypeReference<>() {};

    private final UserTaskPanelPreferenceMapper preferenceMapper;
    private final ObjectMapper objectMapper;

    public TaskPanelPreferenceState get(Long userId) {
        UserTaskPanelPreference row = preferenceMapper.selectById(userId);
        if (row == null) {
            return TaskPanelPreferenceState.empty();
        }
        return new TaskPanelPreferenceState(
                parseStringList(row.getGroupOrder()),
                parseStringList(row.getCollapsedGroups())
        );
    }

    public TaskPanelPreferenceState save(Long userId, TaskPanelPreferenceState state) {
        TaskPanelPreferenceState normalized = normalize(state);
        UserTaskPanelPreference row = preferenceMapper.selectById(userId);
        if (row == null) {
            row = new UserTaskPanelPreference();
            row.setUserId(userId);
            row.setGroupOrder(writeStringList(normalized.groupOrder()));
            row.setCollapsedGroups(writeStringList(normalized.collapsedGroups()));
            preferenceMapper.insert(row);
        } else {
            row.setGroupOrder(writeStringList(normalized.groupOrder()));
            row.setCollapsedGroups(writeStringList(normalized.collapsedGroups()));
            preferenceMapper.updateById(row);
        }
        return normalized;
    }

    private TaskPanelPreferenceState normalize(TaskPanelPreferenceState state) {
        List<String> groupOrder = dedupe(state.groupOrder());
        List<String> collapsedGroups = dedupe(state.collapsedGroups());
        return new TaskPanelPreferenceState(groupOrder, collapsedGroups);
    }

    private List<String> dedupe(List<String> values) {
        if (values == null || values.isEmpty()) {
            return List.of();
        }
        List<String> result = new ArrayList<>();
        for (String value : values) {
            if (value == null) {
                continue;
            }
            String trimmed = value.trim();
            if (trimmed.isEmpty() || result.contains(trimmed)) {
                continue;
            }
            result.add(trimmed);
        }
        return result;
    }

    private List<String> parseStringList(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            List<String> values = objectMapper.readValue(json, STRING_LIST);
            return values != null ? values : List.of();
        } catch (JsonProcessingException e) {
            log.warn("Failed to parse task panel preference JSON: {}", json, e);
            return List.of();
        }
    }

    private String writeStringList(List<String> values) {
        try {
            return objectMapper.writeValueAsString(values != null ? values : List.of());
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize task panel preference", e);
        }
    }

    public record TaskPanelPreferenceState(List<String> groupOrder, List<String> collapsedGroups) {
        public static TaskPanelPreferenceState empty() {
            return new TaskPanelPreferenceState(List.of(), List.of());
        }
    }
}
