package cn.etarch.mao.schedule.controller;

import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.permission.annotation.RequirePermission;
import cn.etarch.mao.schedule.entity.ScheduledTask;
import cn.etarch.mao.schedule.service.ScheduledTaskService;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/v1/scheduled-tasks")
@RequiredArgsConstructor
public class ScheduledTaskController {

    private final ScheduledTaskService scheduledTaskService;

    @GetMapping
    public Result<List<ScheduledTask>> list(@AuthenticationPrincipal Long userId) {
        return Result.ok(scheduledTaskService.listByUser(userId));
    }

    @GetMapping("/all")
    @RequirePermission("session:read")
    public Result<Page<ScheduledTask>> listAll(
            @RequestParam(defaultValue = "1") int pageNum,
            @RequestParam(defaultValue = "20") int pageSize) {
        return Result.ok(scheduledTaskService.listAll(pageNum, pageSize));
    }

    @GetMapping("/{id}")
    public Result<ScheduledTask> getById(@PathVariable Long id,
                                          @AuthenticationPrincipal Long userId) {
        ScheduledTask task = scheduledTaskService.getById(id);
        if (task == null) {
            return Result.fail(ErrorCode.SCHEDULED_TASK_NOT_FOUND);
        }
        if (!task.getUserId().equals(userId)) {
            return Result.fail(ErrorCode.SCHEDULED_TASK_ACCESS_DENIED);
        }
        return Result.ok(task);
    }

    @PutMapping("/{id}")
    public Result<ScheduledTask> update(@PathVariable Long id,
                                         @AuthenticationPrincipal Long userId,
                                         @RequestBody UpdateRequest request) {
        return Result.ok(scheduledTaskService.updateTask(id, userId,
                request.getName(), request.getPrompt(),
                request.getCronExpression(), request.getStatus()));
    }

    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id, @AuthenticationPrincipal Long userId) {
        scheduledTaskService.deleteTask(id, userId);
        return Result.ok(null);
    }

    @Data
    public static class UpdateRequest {
        private String name;
        private String prompt;
        private String cronExpression;
        private String status;
    }
}
