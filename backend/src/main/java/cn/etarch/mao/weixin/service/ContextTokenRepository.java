package cn.etarch.mao.weixin.service;

import cn.etarch.mao.weixin.entity.WeixinChannelContextToken;
import cn.etarch.mao.weixin.mapper.WeixinChannelContextTokenMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

@Slf4j
@Service
@RequiredArgsConstructor
public class ContextTokenRepository {

    private final WeixinChannelContextTokenMapper contextTokenMapper;

    /**
     * 保存或更新context_token
     */
    public void saveOrUpdate(String accountId, String wxUserId, String token) {
        LambdaQueryWrapper<WeixinChannelContextToken> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(WeixinChannelContextToken::getAccountId, accountId)
                .eq(WeixinChannelContextToken::getWxUserId, wxUserId);

        WeixinChannelContextToken existing = contextTokenMapper.selectOne(wrapper);
        if (existing != null) {
            existing.setToken(token);
            contextTokenMapper.updateById(existing);
        } else {
            WeixinChannelContextToken newToken = new WeixinChannelContextToken();
            newToken.setAccountId(accountId);
            newToken.setWxUserId(wxUserId);
            newToken.setToken(token);
            contextTokenMapper.insert(newToken);
        }

        log.debug("保存context_token成功, accountId={}, wxUserId={}", accountId, wxUserId);
    }

    /**
     * 获取最新的context_token
     */
    public String getLatestToken(String accountId, String wxUserId) {
        LambdaQueryWrapper<WeixinChannelContextToken> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(WeixinChannelContextToken::getAccountId, accountId)
                .eq(WeixinChannelContextToken::getWxUserId, wxUserId)
                .last("LIMIT 1");

        WeixinChannelContextToken token = contextTokenMapper.selectOne(wrapper);
        return token != null ? token.getToken() : null;
    }

    /**
     * 删除指定账号的所有context_token
     */
    public void deleteByAccountId(String accountId) {
        LambdaQueryWrapper<WeixinChannelContextToken> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(WeixinChannelContextToken::getAccountId, accountId);
        contextTokenMapper.delete(wrapper);
        log.info("删除账号的所有context_token, accountId={}", accountId);
    }
}