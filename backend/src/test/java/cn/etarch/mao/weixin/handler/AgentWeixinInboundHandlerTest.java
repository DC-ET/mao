package cn.etarch.mao.weixin.handler;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.weixin.model.WeixinInboundMessageContext;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AgentWeixinInboundHandlerTest {

    private final AgentWeixinInboundHandler handler = new AgentWeixinInboundHandler(
            null, null, null, null, null, null,
            null, null, null, null, null, null, null);

    @Test
    void buildMessageContent_textOnly() {
        WeixinInboundMessageContext ctx = WeixinInboundMessageContext.builder()
                .body("你好")
                .build();
        Object content = handler.buildMessageContent(ctx, List.of());
        assertEquals("你好", content);
    }

    @Test
    @SuppressWarnings("unchecked")
    void buildMessageContent_imageWithDefaultPrompt() {
        WeixinInboundMessageContext ctx = WeixinInboundMessageContext.builder()
                .body("")
                .imageDataUris(List.of("data:image/png;base64,abc"))
                .build();
        Object content = handler.buildMessageContent(ctx, List.of());
        assertInstanceOf(List.class, content);
        List<ChatRequest.ContentPart> parts = (List<ChatRequest.ContentPart>) content;
        assertEquals(2, parts.size());
        assertEquals("text", parts.get(0).getType());
        assertEquals("请查看这张图片", parts.get(0).getText());
        assertEquals("image_url", parts.get(1).getType());
        assertTrue(parts.get(1).getImageUrl().getUrl().startsWith("data:image/png"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void buildMessageContent_textAndImage() {
        WeixinInboundMessageContext ctx = WeixinInboundMessageContext.builder()
                .body("这是什么")
                .imageDataUris(List.of("data:image/jpeg;base64,xyz"))
                .build();
        Object content = handler.buildMessageContent(ctx, List.of());
        List<ChatRequest.ContentPart> parts = (List<ChatRequest.ContentPart>) content;
        assertEquals("这是什么", parts.get(0).getText());
        assertEquals(2, parts.size());
    }

    @Test
    void buildMessageContent_fileOnly_injectsPathMarker() {
        WeixinInboundMessageContext ctx = WeixinInboundMessageContext.builder()
                .body("")
                .build();
        Object content = handler.buildMessageContent(ctx, List.of("/ws/weixin-files/2026-08-06/a.pdf"));
        assertEquals("@{/ws/weixin-files/2026-08-06/a.pdf}@", content);
    }

    @Test
    void buildMessageContent_textAndFile_injectsPathMarkerAfterText() {
        WeixinInboundMessageContext ctx = WeixinInboundMessageContext.builder()
                .body("帮我看看这个文件")
                .build();
        Object content = handler.buildMessageContent(ctx, List.of("/ws/a.pdf"));
        assertEquals("帮我看看这个文件\n@{/ws/a.pdf}@", content);
    }

    @Test
    void buildMessageContent_multipleFiles_injectsAllMarkers() {
        WeixinInboundMessageContext ctx = WeixinInboundMessageContext.builder()
                .body("")
                .build();
        Object content = handler.buildMessageContent(ctx, List.of("/ws/a.pdf", "/ws/b.docx"));
        assertEquals("@{/ws/a.pdf}@\n@{/ws/b.docx}@", content);
    }

    @Test
    @SuppressWarnings("unchecked")
    void buildMessageContent_fileAndImage_mixedContentPart() {
        WeixinInboundMessageContext ctx = WeixinInboundMessageContext.builder()
                .body("看下文件和图片")
                .imageDataUris(List.of("data:image/png;base64,img"))
                .build();
        Object content = handler.buildMessageContent(ctx, List.of("/ws/a.pdf"));
        List<ChatRequest.ContentPart> parts = (List<ChatRequest.ContentPart>) content;
        assertEquals(2, parts.size());
        assertEquals("看下文件和图片\n/ws/a.pdf", parts.get(0).getText());
        assertEquals("image_url", parts.get(1).getType());
    }

    @Test
    void appendDownloadErrorNotice_withBody() {
        String result = AgentWeixinInboundHandler.appendDownloadErrorNotice("帮我看看", List.of("bad.pdf"));
        assertEquals("帮我看看\n[以下文件接收失败：bad.pdf]", result);
    }

    @Test
    void appendDownloadErrorNotice_emptyBody() {
        String result = AgentWeixinInboundHandler.appendDownloadErrorNotice("", List.of("a.pdf", "b.docx"));
        assertEquals("[以下文件接收失败：a.pdf、b.docx]", result);
    }
}
