package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.LlmModelConfig;
import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Data
@Component
@ConfigurationProperties(prefix = "app.harness.compaction")
public class CompactionConfig {

    private boolean enabled = true;
    /** 上下文窗口估算值（token），优先使用 LlmModel.contextWindowTokens。 */
    private int contextWindowTokens = 256000;
    /** 达到有效窗口的 80% 时触发全量交接。 */
    private double triggerRatio = 0.8;
    /** 仅作为交接提示词中的软目标，不作为 API 输出 token 限制。 */
    private int maxSummaryTokens = 12000;
    /** 是否在完整工具轮持久化后执行 mid-loop 压缩。 */
    private boolean loopMidwayCompact = true;

    public static int resolveEffectiveContextWindow(LlmModelConfig modelConfig, CompactionConfig config) {
        if (modelConfig != null && modelConfig.getContextWindowTokens() != null
                && modelConfig.getContextWindowTokens() > 0) {
            return modelConfig.getContextWindowTokens();
        }
        return config.getContextWindowTokens();
    }
}
