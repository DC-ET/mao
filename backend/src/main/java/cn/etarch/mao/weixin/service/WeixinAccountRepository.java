package cn.etarch.mao.weixin.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import cn.etarch.mao.weixin.mapper.WeixinChannelAccountMapper;
import cn.etarch.mao.weixin.model.BindingStatus;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

@Slf4j
@Service
@RequiredArgsConstructor
public class WeixinAccountRepository {

    private final WeixinChannelAccountMapper accountMapper;
    private final ObjectMapper objectMapper;

    /**
     * 根据用户ID查找账号
     */
    public WeixinChannelAccount findByUserId(Long userId) {
        LambdaQueryWrapper<WeixinChannelAccount> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(WeixinChannelAccount::getUserId, userId)
                .eq(WeixinChannelAccount::getEnabled, 1)
                .last("LIMIT 1");
        return accountMapper.selectOne(wrapper);
    }

    /**
     * 根据账号ID查找账号
     */
    public WeixinChannelAccount findByAccountId(String accountId) {
        LambdaQueryWrapper<WeixinChannelAccount> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(WeixinChannelAccount::getAccountId, accountId)
                .eq(WeixinChannelAccount::getEnabled, 1)
                .last("LIMIT 1");
        return accountMapper.selectOne(wrapper);
    }

    /**
     * 创建账号
     */
    public void create(WeixinChannelAccount account) {
        accountMapper.insert(account);
    }

    /**
     * 更新账号
     */
    public void update(WeixinChannelAccount account) {
        accountMapper.updateById(account);
    }

    /**
     * 获取绑定状态
     */
    public BindingStatus getBindingStatus(Long userId) {
        WeixinChannelAccount account = findByUserId(userId);
        if (account == null) {
            return BindingStatus.builder()
                    .bound(false)
                    .build();
        }

        try {
            JsonNode payload = objectMapper.readTree(account.getPayloadJson());
            String ilinkUserId = payload.has("userId") ? payload.get("userId").asText() : null;
            String savedAt = payload.has("savedAt") ? payload.get("savedAt").asText() : null;

            LocalDateTime boundAt = null;
            if (savedAt != null) {
                try {
                    boundAt = LocalDateTime.parse(savedAt, DateTimeFormatter.ISO_LOCAL_DATE_TIME);
                } catch (Exception e) {
                    log.warn("解析绑定时间失败: {}", savedAt);
                }
            }

            return BindingStatus.builder()
                    .bound(true)
                    .accountId(ilinkUserId)
                    .boundAt(boundAt)
                    .build();
        } catch (Exception e) {
            log.error("解析账号payload失败", e);
            return BindingStatus.builder()
                    .bound(true)
                    .accountId(account.getAccountId())
                    .build();
        }
    }

    /**
     * 解绑微信Bot
     */
    public void unbind(Long userId) {
        WeixinChannelAccount account = findByUserId(userId);
        if (account == null) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "未找到绑定的微信Bot账号");
        }

        account.setEnabled(0);
        accountMapper.updateById(account);
        log.info("解绑微信Bot成功, userId={}", userId);
    }

    /**
     * 获取所有启用的账号
     */
    public java.util.List<WeixinChannelAccount> findAllEnabled() {
        LambdaQueryWrapper<WeixinChannelAccount> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(WeixinChannelAccount::getEnabled, 1);
        return accountMapper.selectList(wrapper);
    }

    /**
     * 更新get_updates_buf
     */
    public void updateGetUpdatesBuf(Long accountId, String getUpdatesBuf) {
        WeixinChannelAccount account = accountMapper.selectById(accountId);
        if (account != null) {
            account.setGetUpdatesBuf(getUpdatesBuf);
            accountMapper.updateById(account);
        }
    }

    /**
     * 禁用账号
     */
    public void disableAccount(Long accountId) {
        WeixinChannelAccount account = accountMapper.selectById(accountId);
        if (account != null) {
            account.setEnabled(0);
            accountMapper.updateById(account);
            log.info("禁用微信Bot账号, accountId={}", accountId);
        }
    }
}