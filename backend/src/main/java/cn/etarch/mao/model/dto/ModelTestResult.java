package cn.etarch.mao.model.dto;

import lombok.Builder;
import lombok.Data;

@Data
@Builder
public class ModelTestResult {
    /**
     * 基本连通性测试是否通过
     */
    private boolean connectivity;

    /**
     * Mid system message 测试是否通过（仅文本模型）
     */
    private boolean midSystemMessage;

    /**
     * 连通性测试的模型实际输出
     */
    private String connectivityOutput;

    /**
     * Mid system message 测试的模型实际输出
     */
    private String midSystemMessageOutput;

    /**
     * 测试过程中的错误信息（如果有）
     */
    private String error;

    /**
     * 测试耗时（毫秒）
     */
    private long durationMs;

    /**
     * 是否为语音模型（TTS）测试结果
     */
    private boolean audioTest;

    /**
     * 合成音频格式（如 wav）
     */
    private String audioFormat;

    /**
     * 合成音频 base64 数据（不含 data: 前缀）
     */
    private String audioData;

    /**
     * 合成音频解码后大小（字节）
     */
    private Integer audioSizeBytes;

    /**
     * 合成音频采样率（Hz）
     */
    private Integer audioSampleRate;

    /**
     * 合成音频时长（毫秒）
     */
    private Long audioDurationMs;

    /**
     * 合成使用的音色（voice）
     */
    private String audioVoice;
}
