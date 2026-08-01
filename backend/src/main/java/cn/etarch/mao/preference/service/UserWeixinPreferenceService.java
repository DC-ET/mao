package cn.etarch.mao.preference.service;

import cn.etarch.mao.preference.entity.UserWeixinPreference;
import cn.etarch.mao.preference.mapper.UserWeixinPreferenceMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * 用户微信通道偏好。voiceReply 为空时表示跟随全局默认配置。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class UserWeixinPreferenceService {

    private final UserWeixinPreferenceMapper preferenceMapper;

    public UserWeixinPreference get(Long userId) {
        return preferenceMapper.selectById(userId);
    }

    /**
     * 查询用户是否开启语音回复；未配置（null）返回 null，由调用方回退全局默认。
     */
    public Boolean getVoiceReply(Long userId) {
        UserWeixinPreference row = preferenceMapper.selectById(userId);
        return row != null && row.getVoiceReply() != null
                ? row.getVoiceReply() == 1 : null;
    }

    public UserWeixinPreference save(Long userId, boolean voiceReply) {
        UserWeixinPreference row = preferenceMapper.selectById(userId);
        if (row == null) {
            row = new UserWeixinPreference();
            row.setUserId(userId);
            row.setVoiceReply(voiceReply ? 1 : 0);
            preferenceMapper.insert(row);
        } else {
            row.setVoiceReply(voiceReply ? 1 : 0);
            preferenceMapper.updateById(row);
        }
        return row;
    }
}
