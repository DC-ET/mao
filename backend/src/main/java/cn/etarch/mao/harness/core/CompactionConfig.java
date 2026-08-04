package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.LlmModelConfig;
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

    /** 保留最近已完成的完整 USER 轮次；当前 USER 轮次始终额外保留。
     *  仅对请求开始压缩生效；loop 模式受前缀连续性约束不可用。 */
    private int recentTurns = 6;

    /** 压缩后目标水位（窗口占比）：未达标时继续压缩保留轮次，直到达标或只剩 minRetainedTurns 轮 */
    private double targetRatio = 0.25;

    /** 压缩后至少保留的完整 USER 轮次（保底上下文，防止压掉正在执行的任务上下文）。
     *  仅对请求开始压缩生效。 */
    private int minRetainedTurns = 2;

    /** rolling summary 的 token 上限提示；压缩 prompt 会要求摘要控制在范围内 */
    private int maxSummaryTokens = 12000;

    /** 允许触发压缩的最小可压缩消息数（仅请求开始压缩） */
    private int minCompactMessageCount = 10;

    /** 基于窗口触发时要求的最小新增消息数（仅请求开始压缩） */
    private int minNewMessageCount = 8;

    /** 单批压缩消息数软上限；单个完整 USER 轮次可超过该值 */
    private int maxCompactionBatchMessages = 200;

    /** 单次请求内最多连续压缩轮数（仅请求开始压缩） */
    private int maxRoundsPerRequest = 30;

    // ===== Loop 中途压缩（复用 session 压缩算法与持久化） =====

    /** 是否启用 loop 中途压缩（工具轮后、同请求内同步压缩并继续） */
    private boolean loopMidwayCompact = true;

    /** mid-loop 压缩时当前 turn 尾部保留的原始工具轮数 */
    private int loopRecentToolRounds = 5;

    /** mid-loop 单次压缩最多连续调用压缩 LLM 的次数，避免任务长时间卡住 */
    private int loopMaxCompactionRounds = 5;

    /**
     * 有效上下文窗口：优先模型配置，否则回退 yml 的 context-window-tokens。
     */
    public static int resolveEffectiveContextWindow(LlmModelConfig modelConfig, CompactionConfig config) {
        if (modelConfig != null && modelConfig.getContextWindowTokens() != null
                && modelConfig.getContextWindowTokens() > 0) {
            return modelConfig.getContextWindowTokens();
        }
        return config.getContextWindowTokens();
    }
}
