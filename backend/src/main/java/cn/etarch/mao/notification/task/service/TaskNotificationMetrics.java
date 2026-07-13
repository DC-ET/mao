package cn.etarch.mao.notification.task.service;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicLong;

@Component
public class TaskNotificationMetrics {
    private final MeterRegistry registry;
    private final AtomicLong pending = new AtomicLong();

    public TaskNotificationMetrics(MeterRegistry registry) {
        this.registry = registry;
        Gauge.builder("task_notification_pending", pending, AtomicLong::get)
                .description("Pending task notification deliveries")
                .register(registry);
    }

    public void created(String channel, String phase) {
        registry.counter("task_notification_created_total", "channel", channel, "phase", phase).increment();
    }

    public void suppressedByWebSocket(String channel) {
        registry.counter("task_notification_suppressed_total", "channel", channel,
                "reason", "ws_delivered").increment();
    }

    public void sent(String channel, String result) {
        registry.counter("task_notification_send_total", "channel", channel, "result", result).increment();
    }

    public void retried(String channel) {
        registry.counter("task_notification_retry_total", "channel", channel).increment();
    }

    public void pending(long count) {
        pending.set(count);
    }
}
