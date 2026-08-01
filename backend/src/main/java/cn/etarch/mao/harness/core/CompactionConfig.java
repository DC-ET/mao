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

    /** 窗口触发比例：整体 token 达到 contextWindowTokens * triggerRatio 时触发。
     *  大模型输入命中缓存时费用很低，只要在上下文窗口内尽量不主动压缩，故阈值设得较高。 */
    private double triggerRatio = 0.8;

    /** 保留最近已完成的完整 USER 轮次；当前 USER 轮次始终额外保留 */
    private int recentTurns = 6;

    /** 压缩后目标水位（窗口占比）：未达标时继续压缩保留轮次，直到达标或只剩 minRetainedTurns 轮 */
    private double targetRatio = 0.25;

    /** 压缩后至少保留的完整 USER 轮次（保底上下文，防止压掉正在执行的任务上下文） */
    private int minRetainedTurns = 2;

    /** rolling summary 的 token 上限提示；压缩 prompt 会要求摘要控制在范围内 */
    private int maxSummaryTokens = 12000;

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

    /** loop 压缩 token 阈值（约窗口 80%：与 triggerRatio 一致，缓存命中费用低，窗口内尽量不压） */
    private int loopTriggerTokens = 204800;

    /** loop 压缩后保留的最近原始工具轮数 */
    private int loopRecentToolRounds = 5;
}
