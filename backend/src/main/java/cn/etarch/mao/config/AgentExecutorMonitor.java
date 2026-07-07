package cn.etarch.mao.config;

import cn.etarch.mao.session.ws.StreamingWsRegistry;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;

/**
 * Periodic observability for agent thread pool and WS outbound queue depth.
 */
@Slf4j
@Component
public class AgentExecutorMonitor {

    private final ExecutorService agentExecutor;
    private final StreamingWsRegistry streamingWsRegistry;

    public AgentExecutorMonitor(@Qualifier("agentExecutor") ExecutorService agentExecutor,
                                StreamingWsRegistry streamingWsRegistry) {
        this.agentExecutor = agentExecutor;
        this.streamingWsRegistry = streamingWsRegistry;
    }

    @Scheduled(fixedRate = 300_000)
    public void logExecutorStats() {
        if (agentExecutor instanceof ThreadPoolExecutor pool) {
            log.info("Agent executor stats: active={}, poolSize={}, core={}, max={}, queue={}, completed={}, wsOutboundQueue={}",
                    pool.getActiveCount(),
                    pool.getPoolSize(),
                    pool.getCorePoolSize(),
                    pool.getMaximumPoolSize(),
                    pool.getQueue().size(),
                    pool.getCompletedTaskCount(),
                    streamingWsRegistry.getOutboundQueueSize());
        } else {
            log.info("WS outbound queue size={}", streamingWsRegistry.getOutboundQueueSize());
        }
    }
}
