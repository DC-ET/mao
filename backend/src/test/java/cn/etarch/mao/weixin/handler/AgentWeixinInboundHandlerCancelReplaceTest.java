package cn.etarch.mao.weixin.handler;

import cn.etarch.mao.harness.core.AgentLoop;
import cn.etarch.mao.harness.core.HarnessService;
import cn.etarch.mao.harness.shell.ShellSessionManager;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import cn.etarch.mao.weixin.model.WeixinInboundMessageContext;
import cn.etarch.mao.weixin.model.WeixinReply;
import cn.etarch.mao.weixin.service.WeixinAccountRepository;
import cn.etarch.mao.weixin.service.WeixinSessionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.mockito.stubbing.Answer;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class AgentWeixinInboundHandlerCancelReplaceTest {

    @Mock WeixinSessionService weixinSessionService;
    @Mock HarnessService harnessService;
    @Mock SessionService sessionService;
    @Mock WeixinAccountRepository accountRepository;
    @Mock AgentLoop agentLoop;
    @Mock ShellSessionManager shellSessionManager;

    private AgentWeixinInboundHandler handler;

    @BeforeEach
    void setUp() {
        handler = new AgentWeixinInboundHandler(
                weixinSessionService, harnessService, sessionService,
                accountRepository, agentLoop, shellSessionManager);
    }

    @AfterEach
    void tearDown() {
        handler.shutdown();
    }

    @Test
    void newerMessageCancelsPreviousAndOnlyLatestReplies() throws Exception {
        WeixinChannelAccount account = new WeixinChannelAccount();
        account.setUserId(1L);
        when(accountRepository.findByAccountId("acc-1")).thenReturn(account);

        Session session = new Session();
        session.setId(100L);
        when(weixinSessionService.getOrCreateWeixinSession(1L)).thenReturn(session);
        when(sessionService.saveMessage(anyLong(), any(), any(), any(), any(), any(), any(), any()))
                .thenReturn(new Message());

        AtomicBoolean firstFlag = new AtomicBoolean(false);
        AtomicBoolean secondFlag = new AtomicBoolean(false);
        AtomicReference<AtomicBoolean> nextFlag = new AtomicReference<>(firstFlag);
        when(agentLoop.registerCancelFlag(anyLong())).thenAnswer(inv -> nextFlag.get());

        CountDownLatch firstStarted = new CountDownLatch(1);
        CountDownLatch allowFirstFinish = new CountDownLatch(1);

        doAnswer((Answer<Void>) inv -> {
            AtomicBoolean flag = inv.getArgument(3);
            if (flag == firstFlag) {
                firstStarted.countDown();
                assertTrue(allowFirstFinish.await(5, TimeUnit.SECONDS));
                return null;
            }
            Message assistant = new Message();
            assistant.setRole("ASSISTANT");
            assistant.setContent("latest-reply");
            when(sessionService.getMessages(100L)).thenReturn(List.of(assistant));
            return null;
        }).when(harnessService).execute(anyLong(), any(), any(), any());

        var first = handler.onMessage(WeixinInboundMessageContext.builder()
                .accountId("acc-1")
                .body("msg-1")
                .build());

        assertTrue(firstStarted.await(5, TimeUnit.SECONDS), "first agent execute should start");

        // 下一条消息注册时改用 secondFlag
        nextFlag.set(secondFlag);
        var second = handler.onMessage(WeixinInboundMessageContext.builder()
                .accountId("acc-1")
                .body("msg-2")
                .build());

        assertTrue(firstFlag.get(), "first execution should be cancelled");
        allowFirstFinish.countDown();

        WeixinReply firstReply = first.toCompletableFuture().get(10, TimeUnit.SECONDS);
        WeixinReply secondReply = second.toCompletableFuture().get(10, TimeUnit.SECONDS);

        assertNull(firstReply);
        assertEquals("latest-reply", secondReply.getText());
    }
}
