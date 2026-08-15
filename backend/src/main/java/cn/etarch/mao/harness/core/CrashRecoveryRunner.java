package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.delegate.SubagentRecoveryCoordinator;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/** Startup entry point for dependency-aware session and subagent recovery. */
@Component
@RequiredArgsConstructor
public class CrashRecoveryRunner implements ApplicationRunner {

    private final SubagentRecoveryCoordinator recoveryCoordinator;

    @Override
    public void run(ApplicationArguments args) {
        recoveryCoordinator.recoverAtStartup();
    }
}
