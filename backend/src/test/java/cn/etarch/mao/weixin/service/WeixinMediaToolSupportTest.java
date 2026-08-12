package cn.etarch.mao.weixin.service;

import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import cn.etarch.mao.weixin.entity.WeixinChannelContextToken;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class WeixinMediaToolSupportTest {

    @Mock
    private WeixinAccountRepository accountRepository;
    @Mock
    private ContextTokenRepository contextTokenRepository;

    private PathSandbox pathSandbox;
    private WeixinMediaToolSupport support;

    @TempDir
    Path tempDir;

    @BeforeEach
    void setUp() {
        pathSandbox = new PathSandbox(tempDir.toString());
        okhttp3.OkHttpClient httpClient = new okhttp3.OkHttpClient.Builder().build();
        support = new WeixinMediaToolSupport(accountRepository, contextTokenRepository,
                pathSandbox, new com.fasterxml.jackson.databind.ObjectMapper(), httpClient);
    }

    private WeixinChannelAccount account(Long userId, String accountId) {
        WeixinChannelAccount a = new WeixinChannelAccount();
        a.setId(1L);
        a.setUserId(userId);
        a.setAccountId(accountId);
        a.setPayloadJson("{\"token\":\"t\",\"baseUrl\":\"https://ilinkai.weixin.qq.com\"}");
        a.setEnabled(1);
        return a;
    }

    @Test
    void resolveTarget_nullUserId() {
        assertThat(support.resolveTarget(null)).isEmpty();
    }

    @Test
    void resolveTarget_noBoundAccount() {
        when(accountRepository.findByUserId(100L)).thenReturn(null);
        assertThat(support.resolveTarget(100L)).isEmpty();
    }

    @Test
    void resolveTarget_noContextToken() {
        when(accountRepository.findByUserId(100L)).thenReturn(account(100L, "acc-1"));
        when(contextTokenRepository.findByAccountId("acc-1")).thenReturn(List.of());
        assertThat(support.resolveTarget(100L)).isEmpty();
    }

    @Test
    void resolveTarget_ok() {
        when(accountRepository.findByUserId(100L)).thenReturn(account(100L, "acc-1"));
        WeixinChannelContextToken token = new WeixinChannelContextToken();
        token.setWxUserId("wx-user-1");
        when(contextTokenRepository.findByAccountId("acc-1")).thenReturn(List.of(token));

        Optional<WeixinMediaToolSupport.WechatTarget> target = support.resolveTarget(100L);
        assertThat(target).isPresent();
        assertThat(target.get().accountId()).isEqualTo("acc-1");
        assertThat(target.get().wxUserId()).isEqualTo("wx-user-1");
        assertThat(target.get().account().getUserId()).isEqualTo(100L);
    }

    @Test
    void loadBytes_localFile() throws Exception {
        Path file = tempDir.resolve("report.pdf");
        Files.write(file, new byte[]{1, 2, 3, 4, 5});

        byte[] bytes = support.loadBytes("report.pdf", tempDir.toString(), 1024);
        assertThat(bytes).containsExactly(1, 2, 3, 4, 5);
    }

    @Test
    void loadBytes_localFileAbsolute() throws Exception {
        Path file = tempDir.resolve("pic.png");
        Files.write(file, new byte[]{0x01});

        byte[] bytes = support.loadBytes(file.toString(), null, 1024);
        assertThat(bytes).containsExactly(0x01);
    }

    @Test
    void loadBytes_fileTooLarge() throws Exception {
        Path file = tempDir.resolve("big.bin");
        Files.write(file, new byte[100]);

        assertThatThrownBy(() -> support.loadBytes("big.bin", tempDir.toString(), 50))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("文件过大");
    }

    @Test
    void loadBytes_missingFile() {
        assertThatThrownBy(() -> support.loadBytes("nope.txt", tempDir.toString(), 1024))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("文件不存在");
    }

    @Test
    void loadBytes_nonHttpSchemeGoesToLocalPath() {
        // ftp:// 不是 http(s)，不得走网络，应作为本地路径解析并报"文件不存在"
        assertThatThrownBy(() -> support.loadBytes("ftp://example.com/a.png", null, 1024))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("文件不存在");
    }

    @Test
    void errorJson_wellFormed() {
        String json = support.errorJson("出错了");
        assertThat(json).isEqualTo("{\"error\":\"出错了\"}");
    }
}
