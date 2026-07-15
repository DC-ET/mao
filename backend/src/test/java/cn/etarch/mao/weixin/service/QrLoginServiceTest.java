package cn.etarch.mao.weixin.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.weixin.config.WeixinBotConfig;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import cn.etarch.mao.weixin.model.QrcodeResponse;
import cn.etarch.mao.weixin.model.QrcodeStatusResponse;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class QrLoginServiceTest {

    @Mock
    private WeixinAccountRepository accountRepository;

    @Mock
    private WeixinMonitorService monitorService;

    private QrLoginService qrLoginService;
    private WeixinBotConfig config;
    private ObjectMapper objectMapper;

    @BeforeEach
    void setUp() {
        config = new WeixinBotConfig();
        config.setEnabled(true);
        objectMapper = new ObjectMapper();
        qrLoginService = new QrLoginService(config, accountRepository, monitorService, objectMapper);
    }

    @Test
    void getQrcodeThrowsWhenDisabled() {
        config.setEnabled(false);
        assertThatThrownBy(() -> qrLoginService.getQrcode(1L))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("微信Bot功能未启用");
    }

    @Test
    void getQrcodeStatusThrowsWhenInvalidSessionKey() {
        assertThatThrownBy(() -> qrLoginService.getQrcodeStatus("invalid-key"))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("无效的会话Key");
    }

    @Test
    void saveBindingCredentialsCreatesNewAccount() {
        when(accountRepository.findByUserId(1L)).thenReturn(null);

        qrLoginService.saveBindingCredentials(1L, "test-token", "https://test.com", "user123");

        verify(accountRepository).create(any(WeixinChannelAccount.class));
    }

    @Test
    void saveBindingCredentialsUpdatesExistingAccount() {
        WeixinChannelAccount existingAccount = new WeixinChannelAccount();
        existingAccount.setId(1L);
        existingAccount.setUserId(1L);
        existingAccount.setAccountId("user_1");
        existingAccount.setPayloadJson("{}");

        when(accountRepository.findByUserId(1L)).thenReturn(existingAccount);

        qrLoginService.saveBindingCredentials(1L, "test-token", "https://test.com", "user123");

        verify(accountRepository).update(any(WeixinChannelAccount.class));
    }
}