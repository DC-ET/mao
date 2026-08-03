package cn.etarch.mao.weixin.service;

import cn.etarch.mao.preference.service.UserWeixinPreferenceService;
import cn.etarch.mao.weixin.config.WeixinBotConfig;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Optional;

/**
 * 微信语音回复编排：TTS 合成 → WAV→MP3 转码 → CDN 上传 → 发送文件消息。
 * <p>
 * 说明：iLink 协议的 BOT 出站语音条（voice_item）当前在腾讯侧未稳定开放
 * （见 Tencent/openclaw-weixin issue #91），因此采用文件消息（file_item, type=4）
 * 发送 MP3 音频，微信端以可播放的音频文件形式展示。
 * <p>
 * 开关为用户级偏好（{@code user_weixin_preference.voice_reply}），未配置时回退全局默认；
 * 全链路容错：任一环节失败仅记录日志并返回 false，不影响文本回复；
 * 语音发送始终作为文本发送之后的增强能力（先文本后语音）。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WeixinVoiceReplyService {

    private static final DateTimeFormatter FILE_TS = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    private final WeixinBotConfig weixinBotConfig;
    private final WeixinAccountRepository accountRepository;
    private final UserWeixinPreferenceService userPreferenceService;
    private final WeixinVoiceSynthesisService synthesisService;
    private final WeixinVoiceCodecService codecService;
    private final WeixinMediaUploadService uploadService;
    private final WeixinSendService sendService;

    /**
     * 将回复文本合成为语音并作为文件消息发送。
     *
     * @return 是否成功发送；用户关闭、无语音模型或链路失败时返回 false
     */
    public boolean sendVoiceReply(String accountId, String toUserId, String text) {
        if (!isVoiceReplyEnabled(accountId)) {
            return false;
        }
        if (text == null || text.isBlank()) {
            return false;
        }

        try {
            // 1. TTS 合成 WAV
            Optional<byte[]> wavOpt = synthesisService.synthesizeWav(text);
            if (wavOpt.isEmpty()) {
                return false;
            }
            byte[] wavBytes = wavOpt.get();

            // 2. WAV → MP3（文件消息，微信端可直接播放）
            Optional<byte[]> mp3Opt = codecService.wavToMp3(wavBytes);
            if (mp3Opt.isEmpty()) {
                return false;
            }
            byte[] mp3Bytes = mp3Opt.get();

            // 3. 查询账号并上传 CDN（FILE 类型）
            WeixinChannelAccount account = accountRepository.findByAccountId(accountId);
            if (account == null) {
                log.warn("微信语音回复：账号不存在, accountId={}", accountId);
                return false;
            }
            Optional<WeixinMediaUploadService.CdnMedia> mediaOpt =
                    uploadService.uploadFile(account, toUserId, mp3Bytes);
            if (mediaOpt.isEmpty()) {
                return false;
            }

            // 4. 发送文件消息
            String fileName = "语音回复-" + LocalDateTime.now().format(FILE_TS) + ".mp3";
            boolean sent = sendService.sendFile(accountId, toUserId, mediaOpt.get(), fileName);
            log.info("微信语音回复：{} accountId={}, toUserId={}, fileName={}, mp3Bytes={}",
                    sent ? "发送成功" : "发送失败", accountId, toUserId, fileName, mp3Bytes.length);
            return sent;
        } catch (Exception e) {
            log.warn("微信语音回复异常, accountId={}, toUserId={}: {}", accountId, toUserId, e.getMessage());
            return false;
        }
    }

    /**
     * 判断语音回复是否开启：用户级偏好优先，未配置时回退全局默认。
     */
    private boolean isVoiceReplyEnabled(String accountId) {
        WeixinChannelAccount account = accountRepository.findByAccountId(accountId);
        if (account != null && account.getUserId() != null) {
            Boolean userPreference = userPreferenceService.getVoiceReply(account.getUserId());
            if (userPreference != null) {
                return userPreference;
            }
        }
        return weixinBotConfig.isVoiceReply();
    }
}
