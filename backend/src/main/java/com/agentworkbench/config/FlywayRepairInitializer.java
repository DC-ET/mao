package com.agentworkbench.config;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.flyway.FlywayMigrationInitializer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.Statement;

/**
 * 清理 flyway_schema_history 中的失败记录，确保 Flyway 可以正常迁移。
 * 在 FlywayInitializer 之前执行。
 */
@Slf4j
@Configuration
@RequiredArgsConstructor
@ConditionalOnBean(org.flywaydb.core.Flyway.class)
public class FlywayRepairInitializer {

    private final DataSource dataSource;

    @Bean
    public FlywayMigrationInitializer flywayInitializer(org.flywaydb.core.Flyway flyway) {
        // 先清理失败记录
        repair();
        // 再执行正常的 Flyway 迁移
        return new FlywayMigrationInitializer(flyway, null);
    }

    private void repair() {
        try (Connection conn = dataSource.getConnection();
             Statement stmt = conn.createStatement()) {
            // 删除所有失败的迁移记录
            int deleted = stmt.executeUpdate("DELETE FROM flyway_schema_history WHERE success = 0");
            if (deleted > 0) {
                log.info("Cleaned {} failed Flyway migration records", deleted);
            }
        } catch (Exception e) {
            // flyway_schema_history 表可能还不存在，忽略错误
            log.debug("Could not clean flyway_schema_history: {}", e.getMessage());
        }
    }
}
