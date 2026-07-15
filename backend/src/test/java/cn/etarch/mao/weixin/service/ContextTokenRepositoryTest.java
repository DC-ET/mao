package cn.etarch.mao.weixin.service;

import cn.etarch.mao.weixin.entity.WeixinChannelContextToken;
import cn.etarch.mao.weixin.mapper.WeixinChannelContextTokenMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ContextTokenRepositoryTest {

    @Mock
    private WeixinChannelContextTokenMapper contextTokenMapper;

    private ContextTokenRepository contextTokenRepository;

    @BeforeEach
    void setUp() {
        contextTokenRepository = new ContextTokenRepository(contextTokenMapper);
    }

    @Test
    void saveOrUpdateCreatesNewToken() {
        when(contextTokenMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(null);
        when(contextTokenMapper.insert(any(WeixinChannelContextToken.class))).thenReturn(1);

        contextTokenRepository.saveOrUpdate("account1", "wxUser1", "token123");

        verify(contextTokenMapper).insert(any(WeixinChannelContextToken.class));
    }

    @Test
    void saveOrUpdateUpdatesExistingToken() {
        WeixinChannelContextToken existing = new WeixinChannelContextToken();
        existing.setId(1L);
        existing.setAccountId("account1");
        existing.setWxUserId("wxUser1");
        existing.setToken("old-token");

        when(contextTokenMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(existing);
        when(contextTokenMapper.updateById(any(WeixinChannelContextToken.class))).thenReturn(1);

        contextTokenRepository.saveOrUpdate("account1", "wxUser1", "new-token");

        assertThat(existing.getToken()).isEqualTo("new-token");
        verify(contextTokenMapper).updateById(existing);
    }

    @Test
    void getLatestTokenReturnsToken() {
        WeixinChannelContextToken token = new WeixinChannelContextToken();
        token.setToken("token123");

        when(contextTokenMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(token);

        String result = contextTokenRepository.getLatestToken("account1", "wxUser1");

        assertThat(result).isEqualTo("token123");
    }

    @Test
    void getLatestTokenReturnsNullWhenNotFound() {
        when(contextTokenMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(null);

        String result = contextTokenRepository.getLatestToken("account1", "wxUser1");

        assertThat(result).isNull();
    }

    @Test
    void deleteByAccountIdDeletesTokens() {
        when(contextTokenMapper.delete(any(LambdaQueryWrapper.class))).thenReturn(1);

        contextTokenRepository.deleteByAccountId("account1");

        verify(contextTokenMapper).delete(any(LambdaQueryWrapper.class));
    }
}