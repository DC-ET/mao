package cn.etarch.mao.harness.core;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Data
@Component
@ConfigurationProperties(prefix = "app.harness.compaction")
public class CompactionConfig {

    // ===== 会话历史压缩 =====

    private boolean enabled = true;

    /** 上下文窗口估算值（token），优先使用 LlmModel.contextWindowTokens */
    private int contextWindowTokens = 256000;

    /** 窗口触发比例：整体 token 达到 contextWindowTokens * triggerRatio 时触发 */
    private double triggerRatio = 0.72;

    /** 保留最近已完成的完整 USER 轮次；当前 USER 轮次始终额外保留 */
    private int recentTurns = 6;

    /** 允许触发压缩的最小可压缩消息数 */
    private int minCompactMessageCount = 10;

    /** 基于窗口触发时要求的最小新增消息数 */
    private int minNewMessageCount = 8;

    /** 单批压缩消息数软上限；单个完整 USER 轮次可超过该值 */
    private int maxCompactionBatchMessages = 200;

    /** 单次请求内最多连续压缩轮数 */
    private int maxRoundsPerRequest = 30;

    // ===== Loop 工作记忆压缩 =====

    private boolean loopEnabled = true;

    /** loop 压缩 token 阈值 */
    private int loopTriggerTokens = 96000;

    /** loop 压缩后保留的最近原始工具轮数 */
    private int loopRecentToolRounds = 5;
}
