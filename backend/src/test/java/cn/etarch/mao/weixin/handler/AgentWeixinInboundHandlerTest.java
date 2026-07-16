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
            null, null, null, null, null, null);

    @Test
    void buildMessageContent_textOnly() {
        WeixinInboundMessageContext ctx = WeixinInboundMessageContext.builder()
                .body("你好")
                .build();
        Object content = handler.buildMessageContent(ctx);
        assertEquals("你好", content);
    }

    @Test
    @SuppressWarnings("unchecked")
    void buildMessageContent_imageWithDefaultPrompt() {
        WeixinInboundMessageContext ctx = WeixinInboundMessageContext.builder()
                .body("")
                .imageDataUris(List.of("data:image/png;base64,abc"))
                .build();
        Object content = handler.buildMessageContent(ctx);
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
        Object content = handler.buildMessageContent(ctx);
        List<ChatRequest.ContentPart> parts = (List<ChatRequest.ContentPart>) content;
        assertEquals("这是什么", parts.get(0).getText());
        assertEquals(2, parts.size());
    }
}
