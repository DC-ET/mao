package cn.etarch.mao.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.ExecutorService;

@Configuration
public class AgentExecutorConfig {

    @Bean("agentExecutor")
    public ExecutorService agentExecutor(
            @Value("${app.harness.agent-thread-pool-size:20}") int poolSize,
            @Value("${app.harness.agent-thread-pool-max:100}") int maxPoolSize,
            @Value("${app.harness.agent-thread-pool-queue:200}") int queueCapacity) {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(poolSize);
        executor.setMaxPoolSize(maxPoolSize);
        executor.setQueueCapacity(queueCapacity);
        executor.setThreadNamePrefix("ws-agent-");
        executor.initialize();
        return executor.getThreadPoolExecutor();
    }
}
