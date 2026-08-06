package cn.etarch.mao.weixin.handler;

import cn.etarch.mao.harness.core.AgentLoop;
import cn.etarch.mao.harness.core.HarnessService;
import cn.etarch.mao.harness.shell.ShellSessionManager;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.session.ws.StreamingWsRegistry;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import cn.etarch.mao.weixin.model.WeixinInboundMessageContext;
import cn.etarch.mao.weixin.model.WeixinReply;
import cn.etarch.mao.weixin.service.WeixinAccountRepository;
import cn.etarch.mao.weixin.service.WeixinFileStorageService;
import cn.etarch.mao.weixin.service.WeixinSessionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 微信入站文件处理失败场景：
 * - 全部失败且无其他内容：回复错误、不触发 Agent
 * - 失败消息同样执行"新消息接管"：取消同会话在途执行
 * - 全部失败但带文字/图片：不短路，继续处理有效内容
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class AgentWeixinInboundHandlerFileErrorTest {

    @Mock WeixinSessionService weixinSessionService;
    @Mock HarnessService harnessService;
    @Mock SessionService sessionService;
    @Mock WeixinAccountRepository accountRepository;
    @Mock AgentLoop agentLoop;
    @Mock ShellSessionManager shellSessionManager;
    @Mock StreamingWsRegistry registry;
    @Mock WeixinFileStorageService weixinFileStorageService;

    private AgentWeixinInboundHandler handler;

    @BeforeEach
    void setUp() {
        handler = new AgentWeixinInboundHandler(
                weixinSessionService, harnessService, sessionService,
                accountRepository, agentLoop, shellSessionManager,
                registry, null, null, null,
                null, null, weixinFileStorageService);
        when(harnessService.prepareMessage(anyLong(), any())).thenReturn("exec-1");
        when(agentLoop.registerCancelFlag(anyLong())).thenReturn(new AtomicBoolean(false));

        Message saved = new Message();
        saved.setId(1L);
        doReturn(saved).when(sessionService).saveMessage(
                anyLong(), anyString(), anyString(), any(), any(), any(), any(), any());
        doReturn(saved).when(sessionService).saveMessage(
                anyLong(), anyString(), any(Object.class), any(), any(), any(), any(), any());
    }

    @AfterEach
    void tearDown() {
        handler.shutdown();
    }

    private Session prepareSession() {
        WeixinChannelAccount account = new WeixinChannelAccount();
        account.setUserId(1L);
        when(accountRepository.findByAccountId("acc-1")).thenReturn(account);

        Session session = new Session();
        session.setId(100L);
        session.setUserId(1L);
        session.setWorkspace("/ws");
        when(weixinSessionService.getOrCreateWeixinSession(1L)).thenReturn(session);
        return session;
    }

    @Test
    void allFilesDownloadFailed_withoutOtherContent_repliesErrorWithoutTriggeringAgent() {
        prepareSession();

        WeixinInboundMessageContext ctx = WeixinInboundMessageContext.builder()
                .accountId("acc-1")
                .fromUserId("wx-1")
                .body("")
                .fileDownloadErrors(List.of("broken.pdf"))
                .build();

        WeixinReply reply = handler.onMessage(ctx).toCompletableFuture().join();

        assertNotNull(reply);
        assertTrue(reply.getText().contains("文件接收失败"));
        assertTrue(reply.getText().contains("broken.pdf"));
        verify(harnessService, never()).prepareMessage(anyLong(), any());
    }

    @Test
    void fileFailure_cancelsInFlightExecution() {
        Session session = prepareSession();

        WeixinInboundMessageContext ctx = WeixinInboundMessageContext.builder()
                .accountId("acc-1")
                .fromUserId("wx-1")
                .body("")
                .fileDownloadErrors(List.of("broken.pdf"))
                .build();

        handler.onMessage(ctx).toCompletableFuture().join();

        // 失败消息也作为新一代消息，取消同会话在途执行（Shell 会话被关闭）
        verify(shellSessionManager).closeByConversation(session.getId());
    }

    @Test
    void allFilesDownloadFailed_withText_continuesProcessingText() {
        prepareSession();

        WeixinInboundMessageContext ctx = WeixinInboundMessageContext.builder()
                .accountId("acc-1")
                .fromUserId("wx-1")
                .body("帮我分析这个")
                .fileDownloadErrors(List.of("broken.pdf"))
                .build();

        WeixinReply reply = handler.onMessage(ctx).toCompletableFuture().join();

        // 有有效正文：不短路，触发 Agent 处理，且回复不是"文件接收失败"
        verify(harnessService).prepareMessage(anyLong(), any());
        assertNotNull(reply);
        assertFalse(reply.getText().contains("文件接收失败"));
    }
}
