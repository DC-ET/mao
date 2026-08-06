package cn.etarch.mao.weixin.service;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatResponse;
import cn.etarch.mao.harness.llm.LlmModelConfig;
import cn.etarch.mao.harness.llm.OpenAiLlmAdapter;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.service.ModelService;
import cn.etarch.mao.weixin.config.WeixinBotConfig;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 微信语音回复：TTS 合成（文本 → WAV）。
 * <p>
 * 合成文本放在 {@code role=assistant} 消息中（MiMo TTS 调用规范），
 * 音频参数指定 wav 格式。返回解码后的 WAV 字节。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WeixinVoiceSynthesisService {

    private final ModelService modelService;
    private final OpenAiLlmAdapter llmAdapter;
    private final WeixinBotConfig weixinBotConfig;
    private final WeixinVoiceTextSanitizer textSanitizer;

    /** 中文按 4 字/秒估算，60 秒上限对应的安全字符数（含标点） */
    private static final int DEFAULT_MAX_CHARS = 240;

    /**
     * 将文本合成为 WAV 语音。
     * <p>
     * 合成前先经 {@link WeixinVoiceTextSanitizer} 剥去 Markdown 语法：
     * 语音模型对表格等结构鲁棒性差，直接喂 Markdown 往往只合成表格之前的内容。
     *
     * @return 解码后的 WAV 字节；无可用语音模型或合成失败时返回 empty
     */
    public Optional<byte[]> synthesizeWav(String text) {
        if (text == null || text.isBlank()) {
            return Optional.empty();
        }

        LlmModel model = modelService.findFirstActiveAudioModel();
        if (model == null) {
            log.warn("微信语音回复：未找到启用的语音模型（model_type=audio），跳过语音合成");
            return Optional.empty();
        }

        String plain = textSanitizer.toSpeechText(text);
        if (plain.isBlank()) {
            log.warn("微信语音回复：剥离 Markdown 后无可朗读文本，跳过语音合成");
            return Optional.empty();
        }

        String clipped = clipText(plain);

        LlmModelConfig config = LlmModelConfig.builder()
                .id(model.getId())
                .name(model.getName())
                .provider(model.getProvider())
                .baseUrl(model.getBaseUrl())
                .apiKey(model.getApiKey())
                .modelId(model.getModelId())
                .build();

        try {
            ChatRequest request = ChatRequest.builder()
                    .messages(List.of(
                            ChatRequest.Message.builder()
                                    .role("assistant")
                                    .content(clipped)
                                    .build()
                    ))
                    .audio(Map.of("format", "wav"))
                    .build();

            ChatResponse response = llmAdapter.chat(request, config);
            if (response == null || response.getChoices() == null || response.getChoices().isEmpty()
                    || response.getChoices().get(0).getMessage() == null) {
                log.warn("微信语音回复：语音模型未返回结果, model={}", model.getModelId());
                return Optional.empty();
            }

            ChatRequest.Audio audio = response.getChoices().get(0).getMessage().getAudio();
            if (audio == null || audio.getData() == null || audio.getData().isBlank()) {
                log.warn("微信语音回复：语音模型未返回音频数据, model={}", model.getModelId());
                return Optional.empty();
            }

            byte[] wavBytes = Base64.getDecoder().decode(audio.getData());
            if (wavBytes.length == 0) {
                return Optional.empty();
            }
            log.info("微信语音回复：TTS 合成成功, textLength={}, audioBytes={}, model={}",
                    clipped.length(), wavBytes.length, model.getModelId());
            return Optional.of(wavBytes);
        } catch (Exception e) {
            log.warn("微信语音回复：TTS 合成失败, model={}: {}", model.getModelId(), e.getMessage());
            return Optional.empty();
        }
    }

    /**
     * 按语音最大时长截断文本，避免合成音频超出语音条时长限制。
     * <p>
     * 截断优先落在句子边界（句号/叹号/问号/换行），避免硬切切断完整语义；
     * 仅在边界点过于靠前（不足一半）时才回退到字符硬截断。
     */
    private String clipText(String text) {
        int maxSeconds = weixinBotConfig.getVoiceMaxSeconds() > 0
                ? weixinBotConfig.getVoiceMaxSeconds() : 60;
        int maxChars = Math.max(40, DEFAULT_MAX_CHARS * maxSeconds / 60);
        if (text.length() <= maxChars) {
            return text;
        }
        String prefix = text.substring(0, maxChars);
        int boundary = Math.max(prefix.lastIndexOf('。'),
                Math.max(prefix.lastIndexOf('！'),
                Math.max(prefix.lastIndexOf('？'), prefix.lastIndexOf('\n'))));
        if (boundary > maxChars / 2) {
            // 包含分句符，语音在完整句读处结束
            return text.substring(0, boundary + 1);
        }
        return prefix;
    }
}
