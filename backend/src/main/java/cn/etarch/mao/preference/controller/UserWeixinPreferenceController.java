package cn.etarch.mao.preference.controller;

import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.preference.entity.UserWeixinPreference;
import cn.etarch.mao.preference.service.UserWeixinPreferenceService;
import cn.etarch.mao.weixin.config.WeixinBotConfig;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 用户级微信偏好（语音回复开关）。
 */
@RestController
@RequestMapping("/v1/user-preferences/weixin")
@RequiredArgsConstructor
public class UserWeixinPreferenceController {

    private final UserWeixinPreferenceService preferenceService;
    private final WeixinBotConfig weixinBotConfig;

    /**
     * 获取当前用户微信偏好；voiceReply 为空时表示未单独配置，跟随全局默认。
     */
    @GetMapping
    public Result<WeixinPreferenceVO> get(@AuthenticationPrincipal Long userId) {
        UserWeixinPreference row = preferenceService.get(userId);
        WeixinPreferenceVO vo = new WeixinPreferenceVO();
        if (row != null && row.getVoiceReply() != null) {
            vo.setVoiceReply(row.getVoiceReply() == 1);
        } else {
            vo.setVoiceReply(weixinBotConfig.isVoiceReply());
        }
        return Result.ok(vo);
    }

    @PutMapping
    public Result<WeixinPreferenceVO> save(@AuthenticationPrincipal Long userId,
                                           @RequestBody SaveWeixinPreferenceRequest request) {
        boolean voiceReply = Boolean.TRUE.equals(request.getVoiceReply());
        preferenceService.save(userId, voiceReply);
        WeixinPreferenceVO vo = new WeixinPreferenceVO();
        vo.setVoiceReply(voiceReply);
        return Result.ok(vo);
    }

    @Data
    public static class WeixinPreferenceVO {
        private Boolean voiceReply;
    }

    @Data
    public static class SaveWeixinPreferenceRequest {
        private Boolean voiceReply;
    }
}
