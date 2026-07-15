package cn.etarch.mao.weixin.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import cn.etarch.mao.weixin.mapper.WeixinChannelAccountMapper;
import cn.etarch.mao.weixin.model.BindingStatus;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.LocalDateTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class WeixinAccountRepositoryTest {

    @Mock
    private WeixinChannelAccountMapper accountMapper;

    private WeixinAccountRepository accountRepository;
    private ObjectMapper objectMapper;

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper();
        accountRepository = new WeixinAccountRepository(accountMapper, objectMapper);
    }

    @Test
    void findByUserIdReturnsAccount() {
        WeixinChannelAccount account = createAccount(1L, 1L, "user_1");
        when(accountMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(account);

        WeixinChannelAccount result = accountRepository.findByUserId(1L);

        assertThat(result).isNotNull();
        assertThat(result.getUserId()).isEqualTo(1L);
    }

    @Test
    void findByUserIdReturnsNullWhenNotFound() {
        when(accountMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(null);

        WeixinChannelAccount result = accountRepository.findByUserId(1L);

        assertThat(result).isNull();
    }

    @Test
    void findByAccountIdReturnsAccount() {
        WeixinChannelAccount account = createAccount(1L, 1L, "user_1");
        when(accountMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(account);

        WeixinChannelAccount result = accountRepository.findByAccountId("user_1");

        assertThat(result).isNotNull();
        assertThat(result.getAccountId()).isEqualTo("user_1");
    }

    @Test
    void createInsertsAccount() {
        WeixinChannelAccount account = createAccount(null, 1L, "user_1");
        when(accountMapper.insert(any(WeixinChannelAccount.class))).thenReturn(1);

        accountRepository.create(account);

        verify(accountMapper).insert(account);
    }

    @Test
    void updateUpdatesAccount() {
        WeixinChannelAccount account = createAccount(1L, 1L, "user_1");
        when(accountMapper.updateById(any(WeixinChannelAccount.class))).thenReturn(1);

        accountRepository.update(account);

        verify(accountMapper).updateById(account);
    }

    @Test
    void getBindingStatusReturnsBoundWhenAccountExists() {
        WeixinChannelAccount account = createAccount(1L, 1L, "user_1");
        account.setPayloadJson("{\"token\":\"test\",\"baseUrl\":\"https://test.com\",\"userId\":\"wx123\",\"savedAt\":\"2026-07-15T10:00:00\"}");
        when(accountMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(account);

        BindingStatus status = accountRepository.getBindingStatus(1L);

        assertThat(status.isBound()).isTrue();
        assertThat(status.getAccountId()).isEqualTo("wx123");
    }

    @Test
    void getBindingStatusReturnsNotBoundWhenAccountNotFound() {
        when(accountMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(null);

        BindingStatus status = accountRepository.getBindingStatus(1L);

        assertThat(status.isBound()).isFalse();
    }

    @Test
    void unbindDisablesAccount() {
        WeixinChannelAccount account = createAccount(1L, 1L, "user_1");
        when(accountMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(account);
        when(accountMapper.updateById(any(WeixinChannelAccount.class))).thenReturn(1);

        accountRepository.unbind(1L);

        assertThat(account.getEnabled()).isEqualTo(0);
        verify(accountMapper).updateById(account);
    }

    @Test
    void unbindThrowsWhenAccountNotFound() {
        when(accountMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(null);

        assertThatThrownBy(() -> accountRepository.unbind(1L))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("未找到绑定的微信Bot账号");
    }

    @Test
    void findAllEnabledReturnsAccounts() {
        List<WeixinChannelAccount> accounts = List.of(
                createAccount(1L, 1L, "user_1"),
                createAccount(2L, 2L, "user_2")
        );
        when(accountMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(accounts);

        List<WeixinChannelAccount> result = accountRepository.findAllEnabled();

        assertThat(result).hasSize(2);
    }

    @Test
    void updateGetUpdatesBufUpdatesAccount() {
        WeixinChannelAccount account = createAccount(1L, 1L, "user_1");
        when(accountMapper.selectById(1L)).thenReturn(account);
        when(accountMapper.updateById(any(WeixinChannelAccount.class))).thenReturn(1);

        accountRepository.updateGetUpdatesBuf(1L, "new-buf");

        assertThat(account.getGetUpdatesBuf()).isEqualTo("new-buf");
        verify(accountMapper).updateById(account);
    }

    @Test
    void disableAccountDisablesAccount() {
        WeixinChannelAccount account = createAccount(1L, 1L, "user_1");
        when(accountMapper.selectById(1L)).thenReturn(account);
        when(accountMapper.updateById(any(WeixinChannelAccount.class))).thenReturn(1);

        accountRepository.disableAccount(1L);

        assertThat(account.getEnabled()).isEqualTo(0);
        verify(accountMapper).updateById(account);
    }

    private WeixinChannelAccount createAccount(Long id, Long userId, String accountId) {
        WeixinChannelAccount account = new WeixinChannelAccount();
        account.setId(id);
        account.setUserId(userId);
        account.setAccountId(accountId);
        account.setPayloadJson("{\"token\":\"test\",\"baseUrl\":\"https://test.com\",\"userId\":\"wx123\"}");
        account.setEnabled(1);
        account.setDeleted(0);
        account.setCreatedAt(LocalDateTime.now());
        account.setUpdatedAt(LocalDateTime.now());
        return account;
    }
}