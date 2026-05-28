package com.agentworkbench.harness.core;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Data
@Component
@ConfigurationProperties(prefix = "app.harness.compaction")
public class CompactionConfig {

    // ===== 会话历史压缩 =====

    private boolean enabled = true;

    /** 上下文窗口估算值（token） */
    private int contextWindowTokens = 96000;

    /** 窗口触发比例：整体 token 达到 contextWindowTokens * triggerRatio 时触发 */
    private double triggerRatio = 0.72;

    /** 保留最近原始轮数（1 轮 = 1 user + 1 assistant） */
    private int recentTurns = 6;

    /** 允许触发压缩的最小可压缩消息数 */
    private int minCompactMessageCount = 10;

    /** 基于窗口触发时要求的最小新增消息数 */
    private int minNewMessageCount = 8;

    /** 新增未压缩 token 达标即优先触发压缩 */
    private int minNewTokenCount = 20000;

    /** 单批最多压缩消息数 */
    private int maxCompactionBatchMessages = 200;

    /** 单次请求内最多连续压缩轮数 */
    private int maxRoundsPerRequest = 30;

    // ===== Loop 工作记忆压缩 =====

    private boolean loopEnabled = true;

    /** loop 压缩工具轮次阈值 */
    private int loopTriggerToolRounds = 5;

    /** loop 压缩 token 阈值 */
    private int loopTriggerTokens = 96000;

    /** loop 压缩后保留的最近原始工具轮数 */
    private int loopRecentToolRounds = 5;
}
