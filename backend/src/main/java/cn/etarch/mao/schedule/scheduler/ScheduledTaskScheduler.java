package cn.etarch.mao.schedule.scheduler;

import cn.etarch.mao.schedule.entity.ScheduledTask;
import cn.etarch.mao.schedule.mapper.ScheduledTaskMapper;
import cn.etarch.mao.schedule.service.ScheduledTaskService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.List;

@Slf4j
@Component
@RequiredArgsConstructor
public class ScheduledTaskScheduler {

    private final ScheduledTaskMapper scheduledTaskMapper;
    private final ScheduledTaskService scheduledTaskService;

    @Scheduled(fixedDelay = 60_000)
    public void scanAndExecute() {
        LocalDateTime now = LocalDateTime.now();

        List<ScheduledTask> dueTasks = scheduledTaskMapper.selectList(
                new LambdaQueryWrapper<ScheduledTask>()
                        .eq(ScheduledTask::getStatus, "ACTIVE")
                        .le(ScheduledTask::getNextFireTime, now)
                        .eq(ScheduledTask::getDeleted, 0));

        if (dueTasks.isEmpty()) {
            return;
        }

        log.info("Found {} due scheduled tasks", dueTasks.size());
        for (ScheduledTask task : dueTasks) {
            try {
                scheduledTaskService.executeTask(task);
            } catch (Exception e) {
                log.error("Failed to execute scheduled task: id={}, name={}", task.getId(), task.getName(), e);
                task.setLastExecutionStatus("FAILED");
                task.setNextFireTime(scheduledTaskService.calculateNextFireTime(task.getCronExpression()));
                scheduledTaskMapper.updateById(task);
            }
        }
    }
}
