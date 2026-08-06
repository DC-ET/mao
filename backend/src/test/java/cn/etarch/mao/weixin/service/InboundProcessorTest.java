package cn.etarch.mao.weixin.service;

import cn.etarch.mao.weixin.model.WeixinInboundMessageContext;
import cn.etarch.mao.weixin.model.WeixinReply;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.Optional;
import java.util.concurrent.CompletableFuture;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class InboundProcessorTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    private WeixinInboundHandler inboundHandler;
    private WeixinMediaService weixinMediaService;
    private InboundProcessor processor;

    @BeforeEach
    void setUp() {
        inboundHandler = mock(WeixinInboundHandler.class);
        weixinMediaService = mock(WeixinMediaService.class);
        processor = new InboundProcessor(
                inboundHandler,
                mock(ContextTokenRepository.class),
                mock(WeixinSendService.class),
                weixinMediaService,
                mock(WeixinVoiceReplyService.class));
        when(inboundHandler.onMessage(any())).thenReturn(CompletableFuture.completedFuture(new WeixinReply()));
    }

    private ObjectNode baseMessage() {
        ObjectNode message = objectMapper.createObjectNode();
        message.put("from_user_id", "wx-user-1");
        message.put("context_token", "token-1");
        message.putArray("item_list");
        return message;
    }

    private ObjectNode addFileItem(ObjectNode message, String fileName) {
        ArrayNode itemList = (ArrayNode) message.get("item_list");
        ObjectNode item = itemList.addObject();
        item.put("type", 4);
        ObjectNode fileItem = item.putObject("file_item");
        fileItem.put("file_name", fileName);
        fileItem.putObject("media").put("encrypt_query_param", "enc-param");
        return item;
    }

    @Test
    void fileMessage_triggersHandlerWithDownloadedFile() {
        ObjectNode message = baseMessage();
        addFileItem(message, "报告.pdf");

        when(weixinMediaService.downloadFile(any(com.fasterxml.jackson.databind.JsonNode.class)))
                .thenReturn(Optional.of(new WeixinMediaService.DownloadedFile(
                        "报告.pdf", "pdf-content".getBytes(), "application/pdf")));

        processor.processInboundMessage("acc-1", message);

        ArgumentCaptor<WeixinInboundMessageContext> captor =
                ArgumentCaptor.forClass(WeixinInboundMessageContext.class);
        verify(inboundHandler).onMessage(captor.capture());
        WeixinInboundMessageContext ctx = captor.getValue();
        assertEquals(1, ctx.getFiles().size());
        assertEquals("报告.pdf", ctx.getFiles().get(0).fileName());
        assertEquals("pdf-content", new String(ctx.getFiles().get(0).bytes()));
    }

    @Test
    void textAndFileMessage_triggersHandlerWithFileAndBody() {
        ObjectNode message = baseMessage();
        ArrayNode itemList = (ArrayNode) message.get("item_list");
        ObjectNode textItem = itemList.addObject();
        textItem.put("type", 1);
        textItem.putObject("text_item").put("text", "帮我看看");
        addFileItem(message, "a.pdf");

        when(weixinMediaService.downloadFile(any(com.fasterxml.jackson.databind.JsonNode.class)))
                .thenReturn(Optional.of(new WeixinMediaService.DownloadedFile(
                        "a.pdf", "bytes".getBytes(), "application/pdf")));

        processor.processInboundMessage("acc-1", message);

        ArgumentCaptor<WeixinInboundMessageContext> captor =
                ArgumentCaptor.forClass(WeixinInboundMessageContext.class);
        verify(inboundHandler).onMessage(captor.capture());
        WeixinInboundMessageContext ctx = captor.getValue();
        assertEquals("帮我看看", ctx.getBody());
        assertEquals(1, ctx.getFiles().size());
    }

    @Test
    void emptyMessage_ignoredWithoutHandler() {
        ObjectNode message = baseMessage();
        processor.processInboundMessage("acc-1", message);
        verify(inboundHandler, never()).onMessage(any());
    }

    @Test
    void fileDownloadFailure_notTreatedAsEmpty() {
        ObjectNode message = baseMessage();
        addFileItem(message, "broken.pdf");
        when(weixinMediaService.downloadFile(any(com.fasterxml.jackson.databind.JsonNode.class)))
                .thenReturn(Optional.empty());

        processor.processInboundMessage("acc-1", message);

        // 下载失败不再静默丢弃：handler 被调用，失败文件名传入 context
        ArgumentCaptor<WeixinInboundMessageContext> captor =
                ArgumentCaptor.forClass(WeixinInboundMessageContext.class);
        verify(inboundHandler).onMessage(captor.capture());
        WeixinInboundMessageContext ctx = captor.getValue();
        assertTrue(ctx.getFiles().isEmpty());
        assertEquals(1, ctx.getFileDownloadErrors().size());
        assertEquals("broken.pdf", ctx.getFileDownloadErrors().get(0));
    }

    @Test
    void partialFileDownloadFailure_successAndFailedBothPassed() {
        ObjectNode message = baseMessage();
        addFileItem(message, "ok.pdf");
        addFileItem(message, "bad.pdf");
        when(weixinMediaService.downloadFile(any(com.fasterxml.jackson.databind.JsonNode.class)))
                .thenAnswer(inv -> {
                    JsonNode fileItem = inv.getArgument(0);
                    String name = fileItem.get("file_name").asText();
                    if ("bad.pdf".equals(name)) {
                        return Optional.empty();
                    }
                    return Optional.of(new WeixinMediaService.DownloadedFile(
                            name, "bytes".getBytes(), "application/pdf"));
                });

        processor.processInboundMessage("acc-1", message);

        ArgumentCaptor<WeixinInboundMessageContext> captor =
                ArgumentCaptor.forClass(WeixinInboundMessageContext.class);
        verify(inboundHandler).onMessage(captor.capture());
        WeixinInboundMessageContext ctx = captor.getValue();
        assertEquals(1, ctx.getFiles().size());
        assertEquals("ok.pdf", ctx.getFiles().get(0).fileName());
        assertEquals(1, ctx.getFileDownloadErrors().size());
        assertEquals("bad.pdf", ctx.getFileDownloadErrors().get(0));
    }

    @Test
    void fileOnlyMessage_notTreatedAsEmpty() {
        ObjectNode message = baseMessage();
        addFileItem(message, "only.pdf");
        when(weixinMediaService.downloadFile(any(com.fasterxml.jackson.databind.JsonNode.class)))
                .thenReturn(Optional.of(new WeixinMediaService.DownloadedFile(
                        "only.pdf", "x".getBytes(), "application/pdf")));

        processor.processInboundMessage("acc-1", message);
        verify(inboundHandler).onMessage(any());
    }
}
