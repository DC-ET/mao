package cn.etarch.mao.weixin.service;

import cn.etarch.mao.harness.llm.OpenAiLlmAdapter;
import cn.etarch.mao.model.service.ModelService;
import cn.etarch.mao.weixin.config.WeixinBotConfig;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * {@link WeixinVoiceSynthesisService#clipText} 单元测试：
 * 验证超长文本在句子边界截断，避免硬切切断语义。
 */
class WeixinVoiceSynthesisServiceTest {

    private WeixinVoiceSynthesisService service;

    @BeforeEach
    void setUp() {
        WeixinBotConfig config = new WeixinBotConfig();
        config.setVoiceMaxSeconds(60); // maxChars = 240
        service = new WeixinVoiceSynthesisService(
                mock(ModelService.class),
                mock(OpenAiLlmAdapter.class),
                config,
                new WeixinVoiceTextSanitizer());
    }

    private String clip(String text) {
        return ReflectionTestUtils.invokeMethod(service, "clipText", text);
    }

    @Test
    void shortTextNotClipped() {
        String text = "你好，这是一段较短的文本。";
        assertThat(clip(text)).isEqualTo(text);
    }

    @Test
    void clippedAtSentenceBoundary() {
        // 句号位于 150 处（> maxChars/2=120），应在句号后截断，保留完整句子
        String text = "甲".repeat(150) + "。" + "乙".repeat(149);
        String clipped = clip(text);
        assertThat(clipped).hasSize(151).endsWith("。");
    }

    @Test
    void clippedAtNewlineBoundary() {
        String text = "甲".repeat(200) + "\n" + "乙".repeat(99);
        String clipped = clip(text);
        assertThat(clipped).hasSize(201).endsWith("\n");
    }

    @Test
    void clippedHardWhenNoBoundary() {
        // 无句号/换行，回退到字符硬截断（240）
        String text = "甲".repeat(300);
        assertThat(clip(text)).hasSize(240);
    }
}
