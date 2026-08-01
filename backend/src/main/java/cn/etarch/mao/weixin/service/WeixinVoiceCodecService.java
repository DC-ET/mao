package cn.etarch.mao.weixin.service;

import cn.etarch.mao.weixin.config.WeixinBotConfig;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

/**
 * 微信语音转码：WAV → PCM16 → SILK。
 * <p>
 * 微信语音消息标准编码为 SILK（encode_type=6），需要把 TTS 合成的 WAV
 * 先转为 PCM16，再用腾讯 silk-v3 编码器（-tencent 模式）编码。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WeixinVoiceCodecService {

    /** SILK 采样率，与 TTS 输出一致 */
    private static final int SAMPLE_RATE = 24000;

    private final WeixinBotConfig weixinBotConfig;

    public record SilkVoice(byte[] silkBytes, long playtimeMs) {
    }

    /**
     * 将 WAV 转码为 MP3（文件消息用，微信端可直接播放）。
     *
     * @return MP3 字节；转码失败返回 empty
     */
    public java.util.Optional<byte[]> wavToMp3(byte[] wavBytes) {
        Path workDir = null;
        try {
            workDir = Files.createTempDirectory("mao-weixin-voice");
            Path wavPath = workDir.resolve("in.wav");
            Path mp3Path = workDir.resolve("out.mp3");
            Files.write(wavPath, wavBytes);

            if (!runProcess(weixinBotConfig.getFfmpegPath(),
                    "-y", "-i", wavPath.toString(),
                    "-vn", "-c:a", "libmp3lame", "-b:a", "32k",
                    "-ar", String.valueOf(SAMPLE_RATE), "-ac", "1",
                    mp3Path.toString())) {
                log.warn("微信语音转码：ffmpeg 转 MP3 失败");
                return java.util.Optional.empty();
            }

            byte[] mp3Bytes = Files.readAllBytes(mp3Path);
            if (mp3Bytes.length == 0) {
                return java.util.Optional.empty();
            }
            log.info("微信语音转码：WAV {} bytes → MP3 {} bytes",
                    wavBytes.length, mp3Bytes.length);
            return java.util.Optional.of(mp3Bytes);
        } catch (Exception e) {
            log.warn("微信语音转码（MP3）异常: {}", e.getMessage());
            return java.util.Optional.empty();
        } finally {
            if (workDir != null) {
                try {
                    Files.walk(workDir)
                            .sorted(java.util.Comparator.reverseOrder())
                            .forEach(p -> {
                                try {
                                    Files.deleteIfExists(p);
                                } catch (IOException ignored) {
                                }
                            });
                } catch (IOException ignored) {
                }
            }
        }
    }

    /**
     * 将 WAV 转码为 SILK。
     *
     * @return SILK 字节与播放时长（毫秒）；转码失败返回 empty
     */
    public java.util.Optional<SilkVoice> wavToSilk(byte[] wavBytes) {
        Path workDir = null;
        try {
            workDir = Files.createTempDirectory("mao-weixin-voice");
            Path wavPath = workDir.resolve("in.wav");
            Path pcmPath = workDir.resolve("in.pcm");
            Path silkPath = workDir.resolve("out.silk");
            Files.write(wavPath, wavBytes);

            // 1. WAV → PCM16 (24kHz mono s16le)
            if (!runProcess(weixinBotConfig.getFfmpegPath(),
                    "-y", "-i", wavPath.toString(),
                    "-f", "s16le", "-ar", String.valueOf(SAMPLE_RATE), "-ac", "1",
                    pcmPath.toString())) {
                log.warn("微信语音转码：ffmpeg 转 PCM 失败");
                return java.util.Optional.empty();
            }

            // 2. PCM → SILK (-tencent 兼容微信)
            if (!runProcess(weixinBotConfig.getSilkEncoderPath(),
                    pcmPath.toString(), silkPath.toString(),
                    "-Fs_API", String.valueOf(SAMPLE_RATE), "-tencent")) {
                log.warn("微信语音转码：SILK 编码失败");
                return java.util.Optional.empty();
            }

            byte[] silkBytes = Files.readAllBytes(silkPath);
            if (silkBytes.length == 0) {
                return java.util.Optional.empty();
            }

            long playtimeMs = estimateWavDurationMs(wavBytes);
            log.info("微信语音转码：WAV {} bytes → SILK {} bytes, playtime={}ms",
                    wavBytes.length, silkBytes.length, playtimeMs);
            return java.util.Optional.of(new SilkVoice(silkBytes, playtimeMs));
        } catch (Exception e) {
            log.warn("微信语音转码异常: {}", e.getMessage());
            return java.util.Optional.empty();
        } finally {
            if (workDir != null) {
                try {
                    Files.walk(workDir)
                            .sorted(java.util.Comparator.reverseOrder())
                            .forEach(p -> {
                                try {
                                    Files.deleteIfExists(p);
                                } catch (IOException ignored) {
                                }
                            });
                } catch (IOException ignored) {
                }
            }
        }
    }

    /**
     * 从 WAV 头估算时长（毫秒）。解析失败时按字节大小估算。
     */
    private long estimateWavDurationMs(byte[] wav) {
        try {
            if (wav.length >= 44 && wav[0] == 'R' && wav[1] == 'I' && wav[2] == 'F' && wav[3] == 'F'
                    && wav[8] == 'W' && wav[9] == 'A' && wav[10] == 'V' && wav[11] == 'E') {
                int offset = 12;
                int sampleRate = 0;
                int channels = 1;
                int bits = 16;
                long dataSize = 0;
                while (offset + 8 <= wav.length) {
                    String chunkId = new String(wav, offset, 4, StandardCharsets.US_ASCII);
                    long chunkSize = ((wav[offset + 7] & 0xFFL) << 24)
                            | ((wav[offset + 6] & 0xFFL) << 16)
                            | ((wav[offset + 5] & 0xFFL) << 8)
                            | (wav[offset + 4] & 0xFFL);
                    int body = offset + 8;
                    if ("fmt ".equals(chunkId) && body + 16 <= wav.length) {
                        sampleRate = ((wav[body + 7] & 0xFF) << 24)
                                | ((wav[body + 6] & 0xFF) << 16)
                                | ((wav[body + 5] & 0xFF) << 8)
                                | (wav[body + 4] & 0xFF);
                        channels = ((wav[body + 3] & 0xFF) << 8) | (wav[body + 2] & 0xFF);
                        bits = ((wav[body + 15] & 0xFF) << 8) | (wav[body + 14] & 0xFF);
                    } else if ("data".equals(chunkId)) {
                        dataSize = chunkSize;
                    }
                    offset = body + (int) Math.min(chunkSize, Integer.MAX_VALUE);
                    if ((chunkSize & 1) == 1) {
                        offset += 1;
                    }
                }
                int bytesPerSec = sampleRate > 0
                        ? sampleRate * Math.max(channels, 1) * (bits / 8) : 0;
                if (bytesPerSec > 0 && dataSize > 0) {
                    return dataSize * 1000L / bytesPerSec;
                }
            }
        } catch (Exception ignored) {
        }
        // 兜底：按 24kHz 16bit mono 48KB/s 估算
        return wav.length * 1000L / (SAMPLE_RATE * 2);
    }

    private boolean runProcess(String... command) {
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.redirectErrorStream(true);
        try {
            Process process = pb.start();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            process.getInputStream().transferTo(out);
            if (!process.waitFor(60, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                log.warn("微信语音转码：进程超时, cmd={}", String.join(" ", command));
                return false;
            }
            int exit = process.exitValue();
            if (exit != 0) {
                String output = out.toString(StandardCharsets.UTF_8);
                log.warn("微信语音转码：进程退出码 {}, cmd={}, output={}",
                        exit, String.join(" ", command),
                        output.length() > 500 ? output.substring(0, 500) : output);
                return false;
            }
            return true;
        } catch (Exception e) {
            log.warn("微信语音转码：执行失败, cmd={}: {}", String.join(" ", command), e.getMessage());
            return false;
        }
    }
}
