package com.agentworkbench.preference.controller;

import com.agentworkbench.common.result.Result;
import com.agentworkbench.preference.service.UserTaskPanelPreferenceService;
import com.agentworkbench.preference.service.UserTaskPanelPreferenceService.TaskPanelPreferenceState;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/v1/user-preferences/task-panel")
@RequiredArgsConstructor
public class UserTaskPanelPreferenceController {

    private final UserTaskPanelPreferenceService preferenceService;

    @GetMapping
    public Result<TaskPanelPreferenceVO> get(@AuthenticationPrincipal Long userId) {
        return Result.ok(toVO(preferenceService.get(userId)));
    }

    @PutMapping
    public Result<TaskPanelPreferenceVO> save(@AuthenticationPrincipal Long userId,
                                              @RequestBody TaskPanelPreferenceRequest request) {
        TaskPanelPreferenceState state = new TaskPanelPreferenceState(
                request.getGroupOrder(),
                request.getCollapsedGroups()
        );
        return Result.ok(toVO(preferenceService.save(userId, state)));
    }

    private TaskPanelPreferenceVO toVO(TaskPanelPreferenceState state) {
        TaskPanelPreferenceVO vo = new TaskPanelPreferenceVO();
        vo.setGroupOrder(state.groupOrder());
        vo.setCollapsedGroups(state.collapsedGroups());
        return vo;
    }

    @Data
    public static class TaskPanelPreferenceVO {
        private List<String> groupOrder;
        private List<String> collapsedGroups;
    }

    @Data
    public static class TaskPanelPreferenceRequest {
        private List<String> groupOrder;
        private List<String> collapsedGroups;
    }
}
